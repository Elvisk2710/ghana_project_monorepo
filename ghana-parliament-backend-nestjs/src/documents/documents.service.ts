import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DocumentLifecycle as L, DocumentType, Prisma, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { RepositoryClient } from '../alfresco/alfresco.client';
import type { Principal } from '../auth/principal';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { TextExtractor } from './extractor';
import { assertTransition } from './lifecycle';
import { assessQuality, chunkText, Embedder, MetadataFields, sha256, validateMetadata } from './pipeline';

export const JOB_PROCESS = 'document.process';
export const JOB_INDEX = 'document.index';

export interface IngestInput {
  data: Buffer;
  filename: string;
  mimeType: string;
  /** Existing repository node (sync) - when absent the file is uploaded to the repository first. */
  nodeId?: string;
  metadata?: Partial<{
    title: string;
    type: DocumentType;
    documentDate: Date;
    language: string;
    sittingId: string;
    billId: string;
    sensitivity: string;
  }>;
}

const PREFIX: Record<DocumentType, string> = { HANSARD: 'HAN', ORDER_PAPER: 'ORD', BILL_TEXT: 'BIL', COMMITTEE_REPORT: 'COM', OTHER: 'DOC' };

@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RepositoryClient,
    private readonly extractor: TextExtractor,
    private readonly embedder: Embedder,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(JOB_PROCESS, (p, job) => this.processDocument(p.documentId, job.attempts >= job.maxAttempts));
    this.jobs.register(JOB_INDEX, (p) => this.indexDocument(p.documentId));
  }

  // ---------- Ingest (Journey E steps 1-2) ----------

  async ingest(input: IngestInput, actor: Principal, correlationId?: string) {
    const checksum = sha256(input.data);
    const dup = await this.prisma.parliamentaryDocument.findFirst({ where: { checksum }, select: { id: true, publicId: true, lifecycle: true } });
    if (dup) throw new ConflictException({ message: 'This file has already been registered', existing: dup });

    const node = input.nodeId
      ? await this.repo.getNode(input.nodeId)
      : await this.repo.upload(input.filename, input.data, input.mimeType);

    const m = input.metadata ?? {};
    const type = m.type ?? DocumentType.OTHER;
    const doc = await this.createWithPublicId(type, {
      sourceUri: `alfresco://${node.id}`,
      type,
      title: m.title ?? input.filename.replace(/\.[^.]+$/, ''),
      documentDate: m.documentDate,
      language: m.language ?? 'en',
      sensitivity: m.sensitivity,
      sittingId: m.sittingId,
      billId: m.billId,
      checksum,
      ownerId: actor.userId,
      metadata: { filename: input.filename, mimeType: input.mimeType, sizeBytes: input.data.length },
    }).catch((e) => {
      // A concurrent identical upload loses the race on the unique (checksum, version) constraint.
      if (e?.code === 'P2002') throw new ConflictException('This file has already been registered');
      throw e;
    });
    await this.jobs.enqueue(JOB_PROCESS, { documentId: doc.id }, { dedupeKey: `${JOB_PROCESS}:${doc.id}:${doc.version}`, correlationId });
    return doc;
  }

  private async createWithPublicId(type: DocumentType, data: Omit<Prisma.ParliamentaryDocumentUncheckedCreateInput, 'publicId'>) {
    for (let i = 0; i < 5; i++) {
      const publicId = `${PREFIX[type]}-${randomBytes(4).toString('hex').toUpperCase()}`;
      try {
        return await this.prisma.parliamentaryDocument.create({ data: { ...data, publicId } });
      } catch (e: any) {
        if (e?.code === 'P2002' && String(e.meta?.target).includes('publicId')) continue;
        throw e;
      }
    }
    throw new ConflictException('Could not allocate a document ID');
  }

  // ---------- Processing job (steps 2-3) ----------

  async processDocument(documentId: string, finalAttempt = false): Promise<void> {
    const doc = await this.get(documentId);
    if (doc.lifecycle === L.REVIEW) return; // idempotent: already processed
    if (doc.lifecycle === L.DRAFT) {
      assertTransition(L.DRAFT, L.PROCESSING);
      await this.prisma.parliamentaryDocument.update({ where: { id: doc.id }, data: { lifecycle: L.PROCESSING } });
    } else if (doc.lifecycle !== L.PROCESSING) {
      throw new ConflictException(`Cannot process a document in state ${doc.lifecycle}`);
    }
    try {
      const mime = (doc.metadata as any)?.mimeType ?? 'application/pdf';
      const nodeId = doc.sourceUri.replace('alfresco://', '');
      const data = await this.repo.download(nodeId);
      if (sha256(data) !== doc.checksum) throw new Error('Repository content does not match registered checksum');
      const { text, pages } = await this.extractor.extract(data, mime);
      const quality = assessQuality(text, pages);
      assertTransition(L.PROCESSING, L.REVIEW);
      await this.prisma.parliamentaryDocument.update({
        where: { id: doc.id },
        data: { extractedText: text, qualityReport: quality as unknown as Prisma.InputJsonValue, lifecycle: L.REVIEW },
      });
    } catch (e) {
      if (finalAttempt) {
        await this.prisma.parliamentaryDocument.update({
          where: { id: doc.id },
          data: { lifecycle: L.DRAFT, qualityReport: { passed: false, issues: ['processing_failed'], error: (e as Error).message } },
        });
      }
      throw e;
    }
  }

  // ---------- Reads ----------

  async get(id: string) {
    // An undefined clause inside OR would match every row, so build the filter explicitly.
    const doc = await this.prisma.parliamentaryDocument.findFirst({ where: isUuid(id) ? { OR: [{ id }, { publicId: id }] } : { publicId: id } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async list(q: { lifecycle?: L; type?: DocumentType; search?: string; cursor?: string; limit?: number }) {
    const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const items = await this.prisma.parliamentaryDocument.findMany({
      where: {
        lifecycle: q.lifecycle,
        type: q.type,
        ...(q.search ? { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { publicId: { contains: q.search, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, publicId: true, title: true, type: true, documentDate: true, language: true, lifecycle: true, isPublished: true, version: true, qualityReport: true, createdAt: true, updatedAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /** Document counts per lifecycle state (drives dashboard figures; backend-derived, not hard-coded). */
  async stats(): Promise<Record<string, number>> {
    const rows = await this.prisma.parliamentaryDocument.groupBy({ by: ['lifecycle'], _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.lifecycle, r._count._all]));
  }

  /** Metadata issues that block approval (step 4 review screen). */
  async reviewReport(id: string) {
    const doc = await this.get(id);
    return { metadataIssues: validateMetadata(doc as MetadataFields), quality: doc.qualityReport };
  }

  // ---------- Metadata (step 4) ----------

  async updateMetadata(id: string, patch: Partial<MetadataFields> & { title?: string }) {
    const doc = await this.get(id);
    if (doc.lifecycle !== L.DRAFT && doc.lifecycle !== L.REVIEW) {
      throw new ConflictException(`Metadata can only be edited in DRAFT or REVIEW (document is ${doc.lifecycle}); published records are versioned, not edited`);
    }
    return this.prisma.parliamentaryDocument.update({ where: { id: doc.id }, data: patch as Prisma.ParliamentaryDocumentUncheckedUpdateInput });
  }

  // ---------- Approval and publication gate (steps 5-7) ----------

  async approve(id: string, approver: Principal, opts: { acknowledgeQualityIssues?: boolean; notes?: string } = {}) {
    const doc = await this.get(id);
    assertTransition(doc.lifecycle, L.APPROVED);
    if (doc.ownerId && doc.ownerId === approver.userId && !approver.roles.includes(Role.ADMIN)) {
      throw new ForbiddenException('The uploader cannot approve their own document');
    }
    const issues = validateMetadata(doc as MetadataFields);
    if (issues.length) throw new UnprocessableEntityException({ message: 'Metadata is incomplete', issues });
    const quality: any = doc.qualityReport;
    if (quality && quality.passed === false && !opts.acknowledgeQualityIssues) {
      throw new UnprocessableEntityException({ message: 'Quality checks failed; reviewer must acknowledge', issues: quality.issues });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.approval.create({
        data: { objectType: 'document', objectId: doc.id, objectVersion: String(doc.version), decision: 'APPROVED', approverId: approver.userId, decidedAt: new Date(), evidence: { notes: opts.notes ?? null, qualityAcknowledged: !!opts.acknowledgeQualityIssues, checksum: doc.checksum } },
      });
      return tx.parliamentaryDocument.update({ where: { id: doc.id }, data: { lifecycle: L.APPROVED, reviewerId: approver.userId, rejectionReason: null } });
    });
  }

  async reject(id: string, approver: Principal, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('A rejection reason is required');
    const doc = await this.get(id);
    assertTransition(doc.lifecycle, L.REJECTED);
    return this.prisma.$transaction(async (tx) => {
      await tx.approval.create({ data: { objectType: 'document', objectId: doc.id, objectVersion: String(doc.version), decision: 'REJECTED', approverId: approver.userId, decidedAt: new Date(), evidence: { reason } } });
      return tx.parliamentaryDocument.update({ where: { id: doc.id }, data: { lifecycle: L.REJECTED, reviewerId: approver.userId, rejectionReason: reason } });
    });
  }

  /** Returns a rejected or failed document to DRAFT and re-runs processing. */
  async reprocess(id: string, correlationId?: string) {
    const doc = await this.get(id);
    if (doc.lifecycle === L.REJECTED) {
      assertTransition(L.REJECTED, L.DRAFT);
      await this.prisma.parliamentaryDocument.update({ where: { id: doc.id }, data: { lifecycle: L.DRAFT } });
    } else if (doc.lifecycle !== L.DRAFT) {
      throw new ConflictException(`Only DRAFT or REJECTED documents can be reprocessed (document is ${doc.lifecycle})`);
    }
    await this.jobs.enqueue(JOB_PROCESS, { documentId: doc.id }, { dedupeKey: `${JOB_PROCESS}:${doc.id}:${doc.version}`, correlationId });
    return this.get(id);
  }

  /** Publication gate: only an APPROVED version with a matching approval record may be indexed and published. */
  async publish(id: string, correlationId?: string) {
    const doc = await this.get(id);
    if (doc.lifecycle !== L.APPROVED) throw new ConflictException(`Only APPROVED documents can be published (document is ${doc.lifecycle})`);
    const approval = await this.prisma.approval.findFirst({
      where: { objectType: 'document', objectId: doc.id, objectVersion: String(doc.version), decision: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) throw new ForbiddenException('No approval record for this document version');
    if (!doc.extractedText) throw new UnprocessableEntityException('Document has no extracted text to index');
    return this.jobs.enqueue(JOB_INDEX, { documentId: doc.id }, { dedupeKey: `${JOB_INDEX}:${doc.id}:${doc.version}`, correlationId });
  }

  /** Chunk, embed and index, then publish atomically. Safe to re-run (idempotent per document version). */
  async indexDocument(documentId: string): Promise<void> {
    const doc = await this.get(documentId);
    if (doc.lifecycle !== L.APPROVED && doc.lifecycle !== L.PUBLISHED) {
      throw new ConflictException(`Refusing to index a document in state ${doc.lifecycle}`);
    }
    if (!doc.extractedText) throw new UnprocessableEntityException('No extracted text');
    const drafts = chunkText(doc.extractedText);
    if (!drafts.length) throw new UnprocessableEntityException('Document produced no chunks');
    const vectors = await this.embedder.embed(drafts.map((d) => d.text));
    const indexVersion = `${this.embedder.version}@${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

    await this.prisma.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { documentId: doc.id, documentVersion: doc.version } });
      await tx.documentChunk.createMany({
        data: drafts.map((d, i) => ({ documentId: doc.id, documentVersion: doc.version, sequence: d.sequence, text: d.text, anchor: d.anchor, embedding: vectors[i], embeddingId: `${doc.publicId}:${doc.version}:${d.sequence}`, indexVersion, language: doc.language })),
      });
      if (doc.lifecycle === L.APPROVED) assertTransition(L.APPROVED, L.PUBLISHED);
      await tx.parliamentaryDocument.update({ where: { id: doc.id }, data: { lifecycle: L.PUBLISHED, isPublished: true, publishedAt: doc.publishedAt ?? new Date(), indexVersion } });
    });
  }

  /** Rollback: withdraws a document from public retrieval without deleting the record or its history. */
  async unpublish(id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('A reason is required');
    const doc = await this.get(id);
    assertTransition(doc.lifecycle, L.APPROVED);
    return this.prisma.parliamentaryDocument.update({ where: { id: doc.id }, data: { lifecycle: L.APPROVED, isPublished: false, metadata: { ...(doc.metadata as object), unpublishedReason: reason, unpublishedAt: new Date().toISOString() } } });
  }

  async supersede(id: string) {
    const doc = await this.get(id);
    assertTransition(doc.lifecycle, L.SUPERSEDED);
    return this.prisma.parliamentaryDocument.update({ where: { id: doc.id }, data: { lifecycle: L.SUPERSEDED, isPublished: false } });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);
