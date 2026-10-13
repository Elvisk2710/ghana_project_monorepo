import { join } from 'path';
import { freshDatabaseUrl } from './db';

// Environment must be set before AppModule is imported (it validates config at load time).
process.env.DATABASE_URL = freshDatabaseUrl('slice1');
process.env.OIDC_ISSUER = 'https://idp.test/realm';
process.env.OIDC_AUDIENCE = 'parliament-api';
process.env.JOBS_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.METRICS_TOKEN = 'scrape-secret';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AlfrescoNode, RepositoryClient } from '../../src/alfresco/alfresco.client';
import { TokenVerifier } from '../../src/auth/token-verifier';
import { JobsService } from '../../src/jobs/jobs.service';

class FakeRepo extends RepositoryClient {
  files = new Map<string, { node: AlfrescoNode; data: Buffer }>();
  async listFolder() { return [...this.files.values()].map((f) => f.node); }
  async getNode(id: string) { return this.files.get(id)!.node; }
  async download(id: string) { return this.files.get(id)!.data; }
  async upload(name: string, data: Buffer, mimeType: string) {
    const node = { id: `node-${this.files.size + 1}`, name, mimeType };
    this.files.set(node.id, { node, data });
    return node;
  }
}

const HANSARD = [
  'Mr. Speaker: The House will now consider the Petroleum Pricing Deregulation Bill at second reading.',
  'Hon. Member for Tema East: The price of fuel at the pump has risen sharply in 2024 and families in my constituency are struggling. The deregulation of petroleum pricing must be accompanied by protections for consumers and transport operators.',
  'Minister for Energy: Government will publish the pricing formula every fortnight so that the public can see how ex-pump prices are computed and how levies are applied to petroleum products.',
  ...Array.from({ length: 8 }, (_, i) => `Hon. Member ${i}: I rise to contribute to the debate on fuel pricing, import costs, the cedi exchange rate and the burden on ordinary citizens. `.repeat(3)),
].join('\n\n');

describe('Slice 1 - trusted knowledge: document -> approval -> index -> cited public search -> audit', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jobs: JobsService;
  const repo = new FakeRepo();
  const tokens: Record<string, string> = { 'tok-staff': 'sub-staff', 'tok-reviewer': 'sub-reviewer', 'tok-ghost': 'sub-ghost' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let docId: string;
  let publicId: string;
  let sittingId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue({ verify: async (t: string) => { if (!tokens[t]) throw new (await import('@nestjs/common')).UnauthorizedException(); return { sub: tokens[t] }; } })
      .overrideProvider(RepositoryClient)
      .useValue(repo)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    jobs = app.get(JobsService);

    await prisma.user.createMany({
      data: [
        { externalId: 'sub-staff', email: 'staff@parliament.gh', displayName: 'Staff', roles: ['STAFF'] },
        { externalId: 'sub-reviewer', email: 'rev@parliament.gh', displayName: 'Reviewer', roles: ['REVIEWER'] },
      ],
    });
    sittingId = (await prisma.sitting.create({ data: { date: new Date('2024-03-14'), type: 'Plenary' } })).id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects unauthenticated, invalid-token and unprovisioned callers', async () => {
    await request(app.getHttpServer()).get('/api/v1/internal/documents').expect(401);
    await request(app.getHttpServer()).get('/api/v1/internal/documents').set(auth('bad')).expect(401);
    await request(app.getHttpServer()).get('/api/v1/internal/documents').set(auth('tok-ghost')).expect(403);
    const denied = await prisma.auditEvent.count({ where: { action: 'auth.denied' } });
    expect(denied).toBeGreaterThanOrEqual(3);
  });

  it('exposes health and a token-protected metrics endpoint', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    await request(app.getHttpServer()).get('/api/v1/metrics').expect(401);
    const m = await request(app.getHttpServer()).get('/api/v1/metrics').set(auth('scrape-secret')).expect(200);
    expect(m.text).toContain('http_requests_total');
  });

  it('ingests a document (staff), registers it as DRAFT and queues processing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/internal/documents')
      .set(auth('tok-staff'))
      .set('X-Correlation-Id', 'corr-slice1-0001')
      .field('title', 'Petroleum Pricing (Deregulation) - Second Reading')
      .field('type', 'HANSARD')
      .field('documentDate', '2024-03-14')
      .field('sittingId', sittingId)
      .field('sensitivity', 'public')
      .attach('file', Buffer.from(HANSARD), { filename: 'hansard.txt', contentType: 'text/plain' })
      .expect(201);
    expect(res.headers['x-correlation-id']).toBe('corr-slice1-0001');
    expect(res.body.lifecycle).toBe('DRAFT');
    docId = res.body.id;
    publicId = res.body.publicId;
    expect(publicId).toMatch(/^HAN-[0-9A-F]{8}$/);
  });

  it('rejects a duplicate upload without creating a second record', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/internal/documents')
      .set(auth('tok-staff'))
      .attach('file', Buffer.from(HANSARD), { filename: 'copy.txt', contentType: 'text/plain' })
      .expect(409);
    expect(res.body.existing.publicId).toBe(publicId);
    expect(await prisma.parliamentaryDocument.count({ where: { title: 'Petroleum Pricing (Deregulation) - Second Reading' } })).toBe(1);
  });

  it('processes in the background: extract, quality report, move to REVIEW', async () => {
    await jobs.drain();
    const doc = await prisma.parliamentaryDocument.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.lifecycle).toBe('REVIEW');
    expect((doc.qualityReport as any).passed).toBe(true);
    expect(doc.extractedText).toContain('Petroleum Pricing');
  });

  it('keeps the document out of public search and public read while unapproved', async () => {
    const s = await request(app.getHttpServer()).get('/api/v1/public/search').query({ q: 'fuel pricing' }).expect(200);
    expect(s.body.results).toEqual([]);
    await request(app.getHttpServer()).get(`/api/v1/public/documents/${publicId}`).expect(404);
  });

  it('enforces roles: staff cannot approve or publish', async () => {
    await request(app.getHttpServer()).post(`/api/v1/internal/documents/${docId}/approve`).set(auth('tok-staff')).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/internal/documents/${docId}/publish`).set(auth('tok-staff')).expect(403);
  });

  it('blocks approval while metadata is incomplete, then approves once fixed', async () => {
    await prisma.parliamentaryDocument.update({ where: { id: docId }, data: { language: 'xx' } });
    const bad = await request(app.getHttpServer()).post(`/api/v1/internal/documents/${docId}/approve`).set(auth('tok-reviewer')).send({}).expect(422);
    expect(bad.body.issues[0].field).toBe('language');
    await request(app.getHttpServer()).patch(`/api/v1/internal/documents/${docId}/metadata`).set(auth('tok-staff')).send({ language: 'en' }).expect(200);
    const ok = await request(app.getHttpServer()).post(`/api/v1/internal/documents/${docId}/approve`).set(auth('tok-reviewer')).send({ notes: 'Checked against printed Hansard' }).expect(200);
    expect(ok.body.lifecycle).toBe('APPROVED');
  });

  it('refuses to publish a document that was never approved', async () => {
    const other = await request(app.getHttpServer())
      .post('/api/v1/internal/documents').set(auth('tok-staff'))
      .attach('file', Buffer.from('A different, unapproved record. '.repeat(30)), { filename: 'x.txt', contentType: 'text/plain' }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/internal/documents/${other.body.id}/publish`).set(auth('tok-reviewer')).expect(409);
  });

  it('publishes: index job builds chunks and flips the document live atomically', async () => {
    await request(app.getHttpServer()).post(`/api/v1/internal/documents/${docId}/publish`).set(auth('tok-reviewer')).expect(202);
    // Not live until the index job has run.
    const before = await request(app.getHttpServer()).get('/api/v1/public/search').query({ q: 'fuel pricing' }).expect(200);
    expect(before.body.results).toEqual([]);
    await jobs.drain();
    const doc = await prisma.parliamentaryDocument.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.lifecycle).toBe('PUBLISHED');
    expect(doc.isPublished).toBe(true);
    expect(doc.indexVersion).toMatch(/^hashing-v1-256@/);
    expect(await prisma.documentChunk.count({ where: { documentId: docId } })).toBeGreaterThan(0);
  });

  it('serves a cited answer source from public search with stable IDs and anchors', async () => {
    const s = await request(app.getHttpServer()).get('/api/v1/public/search').query({ q: 'What did Parliament say about fuel prices' }).expect(200);
    expect(s.body.results.length).toBeGreaterThan(0);
    const top = s.body.results[0];
    expect(top).toMatchObject({ documentId: publicId, title: 'Petroleum Pricing (Deregulation) - Second Reading', date: '2024-03-14' });
    expect(top.anchor).toMatch(/paragraph/);
    expect(top.indexVersion).toBeTruthy();
    const d = await request(app.getHttpServer()).get(`/api/v1/public/documents/${publicId}`).expect(200);
    expect(d.body.extractedText).toContain('Petroleum Pricing');
  });

  it('re-indexing is idempotent (no duplicate chunks)', async () => {
    const n = await prisma.documentChunk.count({ where: { documentId: docId } });
    await (app.get(require('../../src/documents/documents.service').DocumentsService) as any).indexDocument(docId);
    expect(await prisma.documentChunk.count({ where: { documentId: docId } })).toBe(n);
  });

  it('rolls back publication without deleting the record', async () => {
    await request(app.getHttpServer()).post(`/api/v1/internal/documents/${docId}/unpublish`).set(auth('tok-reviewer')).send({}).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/internal/documents/${docId}/unpublish`).set(auth('tok-reviewer')).send({ reason: 'Transcription error found' }).expect(200);
    const s = await request(app.getHttpServer()).get('/api/v1/public/search').query({ q: 'fuel pricing' }).expect(200);
    expect(s.body.results).toEqual([]);
    await request(app.getHttpServer()).get(`/api/v1/public/documents/${publicId}`).expect(404);
    expect(await prisma.parliamentaryDocument.findUnique({ where: { id: docId } })).not.toBeNull();
    expect(await prisma.approval.count({ where: { objectId: docId } })).toBeGreaterThan(0);
  });

  it('records an audit trail tied to the correlation ID, with actor and outcome', async () => {
    const ev = await prisma.auditEvent.findMany({ where: { correlationId: 'corr-slice1-0001' } });
    expect(ev.map((e) => e.action)).toContain('document.ingest');
    const ingest = ev.find((e) => e.action === 'document.ingest')!;
    expect(ingest.actorType).toBe('user');
    expect(ingest.outcome).toBe('success');
    const actions = (await prisma.auditEvent.findMany({ select: { action: true } })).map((e) => e.action);
    for (const a of ['document.approve', 'document.publish', 'document.unpublish', 'access.denied']) expect(actions).toContain(a);
  });

  it('makes the audit log append-only at the database level', async () => {
    const any = await prisma.auditEvent.findFirstOrThrow();
    await expect(prisma.auditEvent.update({ where: { id: any.id }, data: { action: 'tampered' } })).rejects.toThrow();
    await expect(prisma.auditEvent.delete({ where: { id: any.id } })).rejects.toThrow();
    await expect(prisma.auditEvent.deleteMany()).rejects.toThrow();
  });

  it('retries failing jobs with backoff and dead-letters them after max attempts, then allows retry', async () => {
    const job = await jobs.enqueue('no.such.handler', { x: 1 }, { dedupeKey: 'dead-test' });
    for (let i = 0; i < 5; i++) {
      await prisma.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
      await jobs.drain();
    }
    const dead = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(dead.status).toBe('DEAD');
    expect(dead.attempts).toBe(5);
    expect(dead.lastError).toMatch(/No handler/);
    // Dead jobs are visible to operators and can be retried.
    await prisma.user.create({ data: { externalId: 'sub-admin', email: 'admin@parliament.gh', displayName: 'Admin', roles: ['ADMIN'] } });
    tokens['tok-admin'] = 'sub-admin';
    const list = await request(app.getHttpServer()).get('/api/v1/internal/jobs').query({ status: 'DEAD' }).set(auth('tok-admin')).expect(200);
    expect(list.body.map((j: any) => j.id)).toContain(job.id);
    await request(app.getHttpServer()).post(`/api/v1/internal/jobs/${job.id}/retry`).set(auth('tok-admin')).expect(202);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING');
  });

  it('enqueue is idempotent per dedupe key', async () => {
    const a = await jobs.enqueue('x', {}, { dedupeKey: 'same' });
    const b = await jobs.enqueue('x', {}, { dedupeKey: 'same' });
    expect(b.id).toBe(a.id);
  });
});
