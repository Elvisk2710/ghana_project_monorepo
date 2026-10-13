import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AnswersService, Citation, SourceSnapshot, statusFromDb } from '../answers/answers.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { GOVERNED_DOCUMENT_ACTIONS } from './reconstruction.actions';

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

export interface Reconstruction {
  answerId: string;
  asked: { question: string; language: string; at: string };
  /** Exactly what was stored for the user at the time. */
  seen: { status: string; answer: string | null; citations: Citation[]; failureReason: string | null; latencyMs: number | null };
  /** What a visitor opening the shared link sees now (differs if the answer was withdrawn). */
  shownNow: ReturnType<AnswersService['view']>;
  sources: (SourceSnapshot & { snapshotValid: boolean; document: { publicId: string; version: number; lifecycleNow: string; unchangedSince: boolean } | null })[];
  version: { model: string | null; prompt: string | null; retriever: string | null; deployment: unknown };
  publicationTrail: { documentId: string; action: string; at: string; actorId: string | null }[];
  auditTrail: { id: string; at: string; action: string; outcome: string }[];
  feedback: unknown[];
  withdrawn: { at: string; reason: string | null; incidentId: string | null } | null;
  completeness: { ok: boolean; missing: string[] };
}

/**
 * Rebuilds, from stored records alone, what a citizen asked, what they saw, which exact passages and
 * document versions supported it, which model/prompt/retriever produced it, and who approved that
 * configuration (T-082). Anything that cannot be rebuilt is listed in completeness.missing.
 */
@Injectable()
export class ReconstructionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly answers: AnswersService,
    private readonly audit: AuditService,
  ) {}

  async reconstruct(id: string, opts: { record?: boolean } = {}): Promise<Reconstruction> {
    const s = await this.prisma.questionSession.findUnique({ where: { id } }).catch(() => null);
    if (!s) throw new NotFoundException('Answer not found');
    const status = statusFromDb(s.status);
    const grounded = status === 'grounded' || status === 'conflicting_sources';
    const missing: string[] = [];
    const citations = (s.citations as unknown as Citation[]) ?? [];
    const snaps = ((s.sources as unknown as SourceSnapshot[]) ?? []);

    // Sources: the stored passage text, checked against itself and against the document now.
    const docs = snaps.length ? await this.prisma.parliamentaryDocument.findMany({ where: { publicId: { in: snaps.map((x) => x.documentId) } }, select: { publicId: true, version: true, checksum: true, lifecycle: true, id: true } }) : [];
    const byPublic = new Map(docs.map((d) => [d.publicId, d]));
    const sources = snaps.map((x) => {
      const d = byPublic.get(x.documentId);
      if (!d) missing.push(`source_document_missing:${x.documentId}`);
      return {
        ...x,
        snapshotValid: sha256(x.text) === x.textSha256,
        document: d ? { publicId: d.publicId, version: d.version, lifecycleNow: d.lifecycle, unchangedSince: d.checksum === x.documentChecksum && d.version === x.documentVersion } : null,
      };
    });
    if (sources.some((x) => !x.snapshotValid)) missing.push('source_snapshot_altered');
    if (grounded) {
      if (!snaps.length) missing.push('sources_not_recorded');
      for (const c of citations) if (!snaps.some((x) => x.n === c.n)) missing.push(`citation_${c.n}_has_no_source_snapshot`);
      if (!s.modelVersion || !s.promptVersion || !s.retrieverVersion) missing.push('version_not_recorded');
      if (!s.answer) missing.push('answer_text_missing');
      const markers = [...(s.answer ?? '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      if (markers.some((m) => !citations.some((c) => c.n === m))) missing.push('answer_cites_unlisted_source');
    }

    // Which approved configuration produced it.
    let deployment: unknown = 'baseline';
    if (s.deploymentId) {
      const dep = await this.prisma.aiDeployment.findUnique({
        where: { id: s.deploymentId },
        include: { model: true, prompt: true, retriever: true, evalRun: { select: { id: true, completedAt: true, gate: true, summary: true, startedById: true, dataset: { select: { name: true, version: true } } } } },
      });
      if (!dep) missing.push('deployment_not_found');
      else {
        const approval = dep.approvalId ? await this.prisma.approval.findUnique({ where: { id: dep.approvalId }, include: { requester: { select: { id: true, displayName: true } }, approver: { select: { id: true, displayName: true } } } }) : null;
        if (approval?.decision !== 'APPROVED' || !approval.approverId) missing.push('deployment_has_no_approval');
        deployment = {
          id: dep.id, status: dep.status, activatedAt: dep.activatedAt, ownerId: dep.ownerId,
          model: { id: dep.model.id, name: dep.model.name, version: dep.model.version, checksum: dep.model.checksum },
          prompt: { id: dep.prompt.id, name: dep.prompt.name, version: dep.prompt.version, checksum: dep.prompt.checksum },
          retriever: { id: dep.retriever.id, name: dep.retriever.name, version: dep.retriever.version, checksum: dep.retriever.checksum },
          evaluation: dep.evalRun,
          approval: approval && { id: approval.id, decision: approval.decision, requester: approval.requester, approver: approval.approver, decidedAt: approval.decidedAt },
        };
      }
    }

    const docIds = [...new Set(docs.map((d) => d.id))];
    const publicationTrail = docIds.length
      ? await this.prisma.auditEvent.findMany({ where: { objectType: 'document', objectId: { in: docIds }, action: { in: GOVERNED_DOCUMENT_ACTIONS }, outcome: 'success' }, orderBy: { occurredAt: 'asc' }, select: { objectId: true, action: true, occurredAt: true, actorId: true } })
      : [];
    const idToPublic = new Map(docs.map((d) => [d.id, d.publicId]));
    const askEvents = await this.prisma.auditEvent.findMany({ where: { objectType: 'answer', objectId: id }, orderBy: { occurredAt: 'asc' }, select: { id: true, occurredAt: true, action: true, outcome: true } });
    if (!askEvents.some((e) => e.action === 'answer.ask')) missing.push('ask_audit_event_missing');

    if (opts.record) await this.audit.recordSafe({ action: 'ai.reconstruction.view', objectType: 'answer', objectId: id, payload: { complete: missing.length === 0 } });
    return {
      answerId: id,
      asked: { question: s.question, language: s.language, at: s.createdAt.toISOString() },
      seen: { status, answer: s.answer, citations, failureReason: s.failureReason, latencyMs: s.latencyMs },
      shownNow: this.answers.view(s),
      sources,
      version: { model: s.modelVersion, prompt: s.promptVersion, retriever: s.retrieverVersion, deployment },
      publicationTrail: publicationTrail.map((e) => ({ documentId: idToPublic.get(e.objectId!) ?? e.objectId!, action: e.action, at: e.occurredAt.toISOString(), actorId: e.actorId })),
      auditTrail: askEvents.map((e) => ({ id: e.id, at: e.occurredAt.toISOString(), action: e.action, outcome: e.outcome })),
      feedback: (s.feedback as unknown[]) ?? [],
      withdrawn: s.withdrawnAt ? { at: s.withdrawnAt.toISOString(), reason: s.withdrawnReason, incidentId: s.incidentId } : null,
      completeness: { ok: missing.length === 0, missing },
    };
  }

  /** The release check for T-082: reconstruct a random sample of real answers and report anything that cannot be rebuilt. */
  async verifySample(sample: number, since?: Date) {
    const n = Math.min(Math.max(sample, 1), 200);
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS id FROM "QuestionSession" WHERE (${since ?? null}::timestamptz IS NULL OR ("createdAt" AT TIME ZONE 'UTC') >= ${since ?? null}::timestamptz)
      ORDER BY random() LIMIT ${n}`;
    const results = [];
    for (const { id } of ids) {
      const r = await this.reconstruct(id);
      results.push({ answerId: id, status: r.seen.status, ok: r.completeness.ok, missing: r.completeness.missing });
    }
    const failed = results.filter((r) => !r.ok);
    await this.audit.record({ action: 'ai.reconstruction.test', payload: { requested: n, sampled: results.length, failed: failed.length } });
    return { requested: n, sampled: results.length, passed: results.length - failed.length, failed: failed.length, ok: results.length > 0 && failed.length === 0, failures: failed.slice(0, 50) };
  }
}
