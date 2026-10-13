import { freshDatabaseUrl } from './db';

process.env.DATABASE_URL = freshDatabaseUrl('slice2');
process.env.OIDC_ISSUER = 'https://idp.test/realm';
process.env.OIDC_AUDIENCE = 'parliament-api';
process.env.JOBS_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT_OVERRIDE = '100000';
process.env.CASE_TOKEN_SECRET = 'integration-test-secret-0123456789abcdef';

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { TokenVerifier } from '../../src/auth/token-verifier';
import { NotificationSender, OutboundMessage } from '../../src/cases/notifications';
import { CasesService } from '../../src/cases/cases.service';
import { JobsService } from '../../src/jobs/jobs.service';

class FakeSender extends NotificationSender {
  sent: OutboundMessage[] = [];
  failing = false;
  async send(msg: OutboundMessage) {
    if (this.failing) throw new Error('provider unavailable');
    this.sent.push(msg);
    return { providerRef: `fake-${this.sent.length}` };
  }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const STORY = 'The road from Community 9 to the main market has deep potholes and floods when it rains. Please call me on 0244123456 about it.';

describe('Slice 2 - constituency engagement: issue -> MP queue -> response -> citizen status', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jobs: JobsService;
  const sender = new FakeSender();
  const tokens: Record<string, string> = { 'tok-staffA': 'sub-staffA', 'tok-staffB': 'sub-staffB', 'tok-mpA': 'sub-mpA', 'tok-admin': 'sub-admin', 'tok-rev': 'sub-rev' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());
  let temaEast: string;
  let tamale: string;
  let staffAId: string;
  let staffBId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue({ verify: async (t: string) => { if (!tokens[t]) throw new UnauthorizedException(); return { sub: tokens[t] }; } })
      .overrideProvider(NotificationSender)
      .useValue(sender)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jobs = app.get(JobsService);

    temaEast = (await prisma.constituency.create({ data: { code: 'GA-TE', name: 'Tema East', region: 'Greater Accra', aliases: ['Tema Community 1'], sourceRef: 'test' } })).id;
    tamale = (await prisma.constituency.create({ data: { code: 'NR-TC', name: 'Tamale Central', region: 'Northern', aliases: ['Tamale'], sourceRef: 'test' } })).id;
    const mk = (externalId: string, roles: any[], extra: object = {}) =>
      prisma.user.create({ data: { externalId, email: `${externalId}@parliament.gh`, displayName: externalId, roles, ...extra } });
    staffAId = (await mk('sub-staffA', ['STAFF'], { constituencies: { create: { constituencyId: temaEast } } })).id;
    staffBId = (await mk('sub-staffB', ['STAFF'], { constituencies: { create: { constituencyId: tamale } } })).id;
    const mpUser = await mk('sub-mpA', ['MP']);
    await mk('sub-admin', ['ADMIN']);
    await mk('sub-rev', ['REVIEWER']);
    await prisma.mp.create({ data: { officialName: 'Hon. Ama Mensah', party: 'NDC', activeFrom: new Date('2021-01-07'), constituencyId: temaEast, userId: mpUser.id, isPublished: true, publicContact: { office: 'Tema Community 1 office' } } });
    await prisma.mp.create({ data: { officialName: 'Hon. Unpublished Person', party: 'NPP', activeFrom: new Date('2021-01-07'), constituencyId: tamale, isPublished: false } });
    await prisma.messageTemplate.create({ data: { name: 'Acknowledged', body: 'Thank you. Your MP has noted this and the office will follow up.' } });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const submit = (over: object = {}) =>
    http().post('/api/v1/public/cases').send({
      constituencyId: temaEast, category: 'roads_infrastructure', title: 'Potholes on market road', description: STORY,
      consent: true, contact: { name: 'Kofi', email: 'Kofi@Example.com', channel: 'EMAIL' }, submissionKey: randomUUID(), ...over,
    });
  const view = (ref: string, token?: string) => http().get(`/api/v1/public/cases/${ref}`).set(token ? { 'X-Case-Token': token } : {});

  // ---------------------------------------------------------------- T-048 / T-050
  describe('constituency and MP directory', () => {
    it('matches by official name and explains how, with the published MP', async () => {
      const r = await http().get('/api/v1/public/constituencies/lookup').query({ q: 'tema east' }).expect(200);
      expect(r.body.matches[0]).toMatchObject({ matchedOn: 'exact_name', constituency: { name: 'Tema East' }, mp: { name: 'Hon. Ama Mensah', party: 'NDC' } });
      expect(r.body.matches[0].explanation).toMatch(/official name/);
    });

    it('matches aliases and labels partial matches as partial', async () => {
      expect((await http().get('/api/v1/public/constituencies/lookup').query({ q: 'Tema Community 1' })).body.matches[0].matchedOn).toBe('alias');
      const partial = (await http().get('/api/v1/public/constituencies/lookup').query({ q: 'ema ea' })).body.matches[0];
      expect(partial.matchedOn).toBe('contains');
      expect(partial.explanation).toMatch(/partial match/);
    });

    it('returns no matches for an unknown place instead of guessing', async () => {
      expect((await http().get('/api/v1/public/constituencies/lookup').query({ q: 'Atlantis' }).expect(200)).body.matches).toEqual([]);
    });

    it('never exposes an unpublished MP, and never exposes internal fields', async () => {
      const r = (await http().get('/api/v1/public/constituencies/lookup').query({ q: 'Tamale' })).body.matches[0];
      expect(r.mp).toBeNull();
      expect(JSON.stringify(r)).not.toMatch(/userId|isPublished|sourceRef|lookupRef/);
      expect((await http().get(`/api/v1/public/constituencies/${temaEast}`).expect(200)).body.mp.name).toBe('Hon. Ama Mensah');
      await http().get('/api/v1/public/constituencies/not-a-uuid').expect(404);
    });

    it('only an administrator can edit MPs or import boundaries', async () => {
      await http().post('/api/v1/internal/constituencies/import').set(auth('tok-staffA')).send({ sourceRef: 'x', rows: [] }).expect(403);
      await http().patch('/api/v1/internal/mps/' + randomUUID()).set(auth('tok-staffA')).send({ party: 'X' }).expect(403);
    });
  });

  // ---------------------------------------------------------------- T-051 / T-052
  describe('issue submission', () => {
    it('requires consent, a known category, a real constituency and a usable contact channel', async () => {
      await submit({ consent: false }).expect(400);
      await submit({ category: 'nonsense' }).expect(400);
      await submit({ constituencyId: randomUUID() }).expect(400);
      await submit({ contact: { channel: 'EMAIL' } }).expect(400);
      await submit({ contact: { channel: 'SMS' } }).expect(400);
      await submit({ unexpected: 'field' }).expect(400);
      await submit({ description: 'too short' }).expect(400);
    });

    it('suggests a category without changing the citizen text', async () => {
      const s = await http().post('/api/v1/public/cases/suggest').send({ description: STORY }).expect(200);
      expect(s.body).toMatchObject({ category: 'roads_infrastructure', method: 'keyword-rules-v1' });
      expect(s.body.note).toMatch(/never changed/);
      expect((await http().get('/api/v1/public/case-categories')).body.map((c: any) => c.id)).toContain('roads_infrastructure');
    });

    it('creates a durable case, stores the words verbatim and keeps the AI suggestion separate', async () => {
      const key = randomUUID();
      const r = await submit({ submissionKey: key, category: 'other' }).expect(201);
      expect(r.body.reference).toMatch(/^GH-\d{4}-\d{6}$/);
      expect(r.body.trackingCode.length).toBeGreaterThan(20);
      expect(r.body.status).toBe('RECEIVED');
      const row = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: r.body.reference }, include: { messages: true, contact: true, events: true } });
      expect(row.messages[0]).toMatchObject({ authorType: 'CITIZEN', visibility: 'PUBLIC', content: STORY });
      expect(row.category).toBe('other'); // the citizen's choice stands
      expect(row.aiSuggestedCategory).toBe('roads_infrastructure'); // AI view recorded separately
      expect(row.consentGivenAt).toBeInstanceOf(Date);
      expect(row.contact).toMatchObject({ channel: 'EMAIL', email: 'kofi@example.com' });
      expect(row.constituencyId).toBe(temaEast);
      expect(row.dueAt).not.toBeNull();
      expect(row.events.map((e) => e.kind)).toContain('created');
    });

    it('is idempotent: a retried submit returns the same case and tracking code, with no duplicate', async () => {
      const key = randomUUID();
      const a = await submit({ submissionKey: key }).expect(201);
      const b = await submit({ submissionKey: key }).expect(201);
      expect(b.body.reference).toBe(a.body.reference);
      expect(b.body.trackingCode).toBe(a.body.trackingCode);
      expect(b.body.duplicate).toBe(true);
      expect(await prisma.citizenCase.count({ where: { submissionKey: key } })).toBe(1);
    });

    it('survives simultaneous submissions with the same key', async () => {
      const key = randomUUID();
      const rs = await Promise.all([1, 2, 3, 4].map(() => submit({ submissionKey: key })));
      expect(new Set(rs.map((r) => r.body.reference)).size).toBe(1);
      expect(await prisma.citizenCase.count({ where: { submissionKey: key } })).toBe(1);
    });

    it('hands out unique references under concurrency', async () => {
      const rs = await Promise.all(Array.from({ length: 8 }, () => submit()));
      expect(new Set(rs.map((r) => r.body.reference)).size).toBe(8);
    });
  });

  // ---------------------------------------------------------------- the whole journey
  describe('journey: citizen -> MP queue -> response -> citizen status', () => {
    let id: string;
    let ref: string;
    let code: string;

    beforeAll(async () => {
      const r = await submit({ contact: { name: 'Kofi', email: 'kofi@example.com', channel: 'EMAIL' } }).expect(201);
      ref = r.body.reference;
      code = r.body.trackingCode;
      id = (await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: ref } })).id;
    });

    it('sends an acknowledgement that carries no case content', async () => {
      sender.sent = [];
      await jobs.drain();
      const ack = sender.sent.find((m) => m.subject.includes(ref));
      expect(ack).toBeDefined();
      expect(ack!.to).toBe('kofi@example.com');
      expect(`${ack!.subject} ${ack!.body}`).not.toMatch(/pothole|market|0244123456/i);
      const n = await prisma.notification.findFirstOrThrow({ where: { caseId: id, kind: 'acknowledgement' } });
      expect(n.state).toBe('SENT');
    });

    it('lets the citizen see the case only with the right tracking code', async () => {
      await view(ref).expect(404);
      await view(ref, 'wrong-code').expect(404);
      await view('GH-2099-999999', code).expect(404);
      const ok = await view(ref, code).expect(200);
      expect(ok.body).toMatchObject({ reference: ref, status: 'RECEIVED', statusLabel: 'Received', constituency: 'Tema East', canReply: true });
      expect(ok.body.messages[0]).toMatchObject({ from: 'you', content: STORY });
      // A code for one case never opens another.
      const other = await submit().expect(201);
      await view(ref, other.body.trackingCode).expect(404);
      // Lower-case references work (people type them that way).
      await view(ref.toLowerCase(), code).expect(200);
    });

    it('shows the case in the right constituency queue only', async () => {
      const mine = await http().get('/api/v1/internal/cases').set(auth('tok-staffA')).expect(200);
      expect(mine.body.items.map((c: any) => c.id)).toContain(id);
      const theirs = await http().get('/api/v1/internal/cases').set(auth('tok-staffB')).expect(200);
      expect(theirs.body.items.map((c: any) => c.id)).not.toContain(id);
      const mp = await http().get('/api/v1/internal/cases').set(auth('tok-mpA')).expect(200);
      expect(mp.body.items.map((c: any) => c.id)).toContain(id);
      const admin = await http().get('/api/v1/internal/cases').set(auth('tok-admin')).expect(200);
      expect(admin.body.items.map((c: any) => c.id)).toContain(id);
    });

    it('enforces role and constituency scope on every case operation', async () => {
      await http().get('/api/v1/internal/cases').expect(401);
      await http().get('/api/v1/internal/cases').set(auth('tok-rev')).expect(403); // wrong role
      // Staff B cannot even learn that the case exists.
      await http().get(`/api/v1/internal/cases/${id}`).set(auth('tok-staffB')).expect(404);
      await http().post(`/api/v1/internal/cases/${id}/notes`).set(auth('tok-staffB')).send({ content: 'x' }).expect(404);
      await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffB')).send({ content: 'x' }).expect(404);
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffB')).send({ status: 'TRIAGED' }).expect(404);
      await http().get(`/api/v1/internal/cases/${id}/export`).set(auth('tok-staffB')).expect(404);
      expect((await prisma.citizenCase.findUniqueOrThrow({ where: { id } })).status).toBe('RECEIVED');
    });

    it('validates status transitions', async () => {
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'RESOLVED' }).expect(409);
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'BOGUS' }).expect(400);
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'TRIAGED' }).expect(200);
      expect((await view(ref, code)).body.status).toBe('TRIAGED');
    });

    it('tells the console which statuses are allowed next and who can be assigned', async () => {
      const d = (await http().get(`/api/v1/internal/cases/${id}`).set(auth('tok-staffA')).expect(200)).body;
      expect(d.status).toBe('TRIAGED');
      expect(d.allowedTransitions).toEqual(['IN_PROGRESS', 'AWAITING_INFORMATION', 'RESOLVED', 'CLOSED']);
      const who = (await http().get(`/api/v1/internal/cases/${id}/assignees`).set(auth('tok-staffA')).expect(200)).body;
      const names = who.map((u: any) => u.displayName);
      expect(names).toEqual(expect.arrayContaining(['sub-staffA', 'sub-mpA', 'sub-admin']));
      expect(names).not.toContain('sub-staffB');
      expect(JSON.stringify(who)).not.toMatch(/email|externalId/);
      await http().get(`/api/v1/internal/cases/${id}/assignees`).set(auth('tok-staffB')).expect(404);
    });

    it('assigns only to someone who can handle that constituency', async () => {
      await http().post(`/api/v1/internal/cases/${id}/assign`).set(auth('tok-staffA')).send({ assigneeId: staffBId }).expect(400);
      const r = await http().post(`/api/v1/internal/cases/${id}/assign`).set(auth('tok-staffA')).send({ assigneeId: staffAId }).expect(200);
      expect(r.body.assignee.id).toBe(staffAId);
      const mine = await http().get('/api/v1/internal/cases').query({ assignee: 'me' }).set(auth('tok-staffA'));
      expect(mine.body.items.map((c: any) => c.id)).toContain(id);
    });

    it('keeps internal notes out of everything the citizen can reach', async () => {
      await http().post(`/api/v1/internal/cases/${id}/notes`).set(auth('tok-staffA')).send({ content: 'INTERNAL: contractor is the MCE cousin' }).expect(201);
      await http().patch(`/api/v1/internal/cases/${id}`).set(auth('tok-staffA')).send({ priority: 'HIGH' }).expect(200);
      const v = await view(ref, code).expect(200);
      const json = JSON.stringify(v.body);
      expect(json).not.toMatch(/INTERNAL|MCE cousin|assignee|aiSuggested|escalat|constituencyId|staffA/);
      const exp = await http().get(`/api/v1/public/cases/${ref}/export`).set('X-Case-Token', code).expect(200);
      expect(JSON.stringify(exp.body)).not.toMatch(/INTERNAL|MCE cousin/);
    });

    it('sends a response from a template, records delivery and shows it to the citizen', async () => {
      const tpl = (await http().get('/api/v1/internal/message-templates').set(auth('tok-staffA')).expect(200)).body[0];
      sender.sent = [];
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'IN_PROGRESS' }).expect(200);
      const r = await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffA')).send({ templateId: tpl.id }).expect(201);
      const reply = r.body.messages.find((m: any) => m.visibility === 'PUBLIC' && m.authorType === 'STAFF');
      expect(reply.content).toBe(tpl.body);
      expect(reply.deliveryState).toBe('PENDING');
      expect(r.body.firstResponseAt).not.toBeNull();
      await jobs.drain();
      const detail = (await http().get(`/api/v1/internal/cases/${id}`).set(auth('tok-staffA')).expect(200)).body;
      expect(detail.messages.find((m: any) => m.id === reply.id).deliveryState).toBe('SENT');
      expect(detail.notifications.filter((n: any) => n.kind === 'response')[0]).toMatchObject({ state: 'SENT', channel: 'EMAIL' });
      expect(sender.sent.some((m) => /new response/i.test(m.subject))).toBe(true);
      const v = (await view(ref, code)).body;
      expect(v.status).toBe('IN_PROGRESS');
      expect(v.messages.map((m: any) => m.from)).toEqual(['you', 'constituency_office']);
      expect(v.history.map((h: any) => h.status)).toEqual(['RECEIVED', 'TRIAGED', 'IN_PROGRESS']);
    });

    it('rejects an empty response and an unknown template', async () => {
      await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffA')).send({}).expect(400);
      await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffA')).send({ templateId: randomUUID() }).expect(400);
    });

    it('makes a failed delivery visible instead of hiding it', async () => {
      sender.failing = true;
      const r = await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffA')).send({ content: 'We have scheduled a site visit.' }).expect(201);
      const msg = r.body.messages.filter((m: any) => m.authorType === 'STAFF' && m.visibility === 'PUBLIC').pop();
      await prisma.job.updateMany({ where: { status: 'PENDING' }, data: { maxAttempts: 1 } });
      await jobs.drain();
      sender.failing = false;
      const detail = (await http().get(`/api/v1/internal/cases/${id}`).set(auth('tok-staffA'))).body;
      expect(detail.messages.find((m: any) => m.id === msg.id).deliveryState).toBe('FAILED');
      const n = detail.notifications.filter((x: any) => x.kind === 'response').pop();
      expect(n).toMatchObject({ state: 'FAILED', lastError: 'provider unavailable' });
      // The response itself is still on the tracking page.
      expect(JSON.stringify((await view(ref, code)).body)).toMatch(/site visit/);
    });

    it('asks the citizen for information and moves the case back to work when they reply', async () => {
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'AWAITING_INFORMATION' }).expect(200);
      const waiting = (await view(ref, code)).body;
      expect(waiting).toMatchObject({ status: 'AWAITING_INFORMATION', awaitingYourReply: true });
      const r = await http().post(`/api/v1/public/cases/${ref}/messages`).set('X-Case-Token', code).send({ content: 'It is near the Community 9 junction.' }).expect(201);
      expect(r.body.status).toBe('IN_PROGRESS');
      expect(r.body.messages.pop()).toMatchObject({ from: 'you', content: 'It is near the Community 9 junction.' });
      await http().post(`/api/v1/public/cases/${ref}/messages`).send({ content: 'no token' }).expect(404);
    });

    it('accepts safe evidence and refuses malicious or mislabelled files, storing nothing for them', async () => {
      const base = `/api/v1/public/cases/${ref}/attachments`;
      const ok = await http().post(base).set('X-Case-Token', code).attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' }).expect(201);
      expect(ok.body).toMatchObject({ filename: 'photo.png', mimeType: 'image/png' });

      const eicar = Buffer.from(`%PDF-1.4\n${EICAR}`);
      const bad = await http().post(base).set('X-Case-Token', code).attach('file', eicar, { filename: 'invoice.pdf', contentType: 'application/pdf' }).expect(422);
      expect(bad.body.message).toMatch(/EICAR|malware/i);
      await http().post(base).set('X-Case-Token', code).attach('file', Buffer.from('MZ\x90\x00 pe'), { filename: 'photo.png', contentType: 'image/png' }).expect(422);
      await http().post(base).set('X-Case-Token', code).attach('file', PNG, { filename: 'photo.png', contentType: 'application/pdf' }).expect(422);
      await http().post(base).attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' }).expect(404);
      await http().post(base).set('X-Case-Token', code).expect(400);

      expect(await prisma.caseAttachment.count({ where: { caseId: id } })).toBe(1);
      expect(await prisma.auditEvent.count({ where: { action: 'case.attachment.rejected', objectId: id } })).toBe(3);
    });

    it('serves attachments as downloads that cannot execute, to staff in scope only', async () => {
      const att = await prisma.caseAttachment.findFirstOrThrow({ where: { caseId: id } });
      const staff = await http().get(`/api/v1/internal/cases/${id}/attachments/${att.id}`).set(auth('tok-staffA')).expect(200);
      expect(staff.headers['content-disposition']).toMatch(/^attachment;/);
      expect(staff.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(staff.body, PNG)).toBe(0);
      await http().get(`/api/v1/internal/cases/${id}/attachments/${att.id}`).set(auth('tok-staffB')).expect(404);
      await http().get(`/api/v1/public/cases/${ref}/attachments/${att.id}`).expect(404);
      await http().get(`/api/v1/public/cases/${ref}/attachments/${att.id}`).set('X-Case-Token', code).expect(200);
    });

    it('limits the number of attachments per case', async () => {
      for (let i = 0; i < 10; i++) {
        const r = await http().post(`/api/v1/public/cases/${ref}/attachments`).set('X-Case-Token', code).attach('file', PNG, { filename: `p${i}.png`, contentType: 'image/png' });
        if (r.status === 409) break;
      }
      expect(await prisma.caseAttachment.count({ where: { caseId: id } })).toBe(5);
    });

    it('closes the case, sets a retention date and freezes it', async () => {
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'RESOLVED' }).expect(200);
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'CLOSED' }).expect(200);
      const row = await prisma.citizenCase.findUniqueOrThrow({ where: { id } });
      expect(row.closedAt).not.toBeNull();
      expect(row.retainUntil!.getTime()).toBeGreaterThan(Date.now() + 700 * 24 * 3600_000);
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'IN_PROGRESS' }).expect(409);
      await http().post(`/api/v1/public/cases/${ref}/messages`).set('X-Case-Token', code).send({ content: 'hello again' }).expect(409);
      await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffA')).send({ content: 'late' }).expect(409);
      const v = (await view(ref, code)).body;
      expect(v).toMatchObject({ status: 'CLOSED', canReply: false });
      expect(v.history.map((h: any) => h.status)).toEqual(['RECEIVED', 'TRIAGED', 'IN_PROGRESS', 'AWAITING_INFORMATION', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
    });

    it('exports the full case history with its audit trail (T-060)', async () => {
      const r = await http().get(`/api/v1/internal/cases/${id}/export`).set(auth('tok-staffA')).expect(200);
      expect(r.body.case.reference).toBe(ref);
      expect(r.body.messages.some((m: any) => m.visibility === 'INTERNAL' && /MCE cousin/.test(m.content))).toBe(true);
      expect(r.body.statusHistory.length).toBeGreaterThan(5);
      const actions = r.body.auditTrail.map((a: any) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['case.submit', 'case.status', 'case.assign', 'case.note', 'case.respond', 'case.citizen_reply']));
      expect(r.body.notifications.length).toBeGreaterThan(2);
      // The export itself is audited.
      expect(await prisma.auditEvent.count({ where: { action: 'case.export', objectId: id } })).toBeGreaterThan(0);
    });

    it('never writes the citizen\'s words into the audit ledger', async () => {
      const events = await prisma.auditEvent.findMany({ where: { objectId: id } });
      expect(events.length).toBeGreaterThan(5);
      expect(JSON.stringify(events)).not.toMatch(/pothole|0244123456|kofi@example|MCE cousin/i);
    });

    it('gives the citizen a copy of their data (T-058)', async () => {
      const r = await http().get(`/api/v1/public/cases/${ref}/export`).set('X-Case-Token', code).expect(200);
      expect(r.body).toMatchObject({ reference: ref, contact: { email: 'kofi@example.com', channel: 'EMAIL' }, consent: { purpose: expect.any(String) } });
      expect(r.body.messages[0].content).toBe(STORY);
      await http().get(`/api/v1/public/cases/${ref}/export`).expect(404);
    });

    it('records an erasure request, which only an administrator can carry out', async () => {
      await http().post(`/api/v1/public/cases/${ref}/erasure-request`).set('X-Case-Token', code).expect(202);
      expect(await prisma.caseEvent.count({ where: { caseId: id, kind: 'erasure_requested' } })).toBe(1);
      await http().post(`/api/v1/internal/cases/${id}/erase`).set(auth('tok-staffA')).send({ reason: 'citizen request' }).expect(403);
      await http().post(`/api/v1/internal/cases/${id}/erase`).set(auth('tok-admin')).send({ reason: 'x' }).expect(400);
      const r = await http().post(`/api/v1/internal/cases/${id}/erase`).set(auth('tok-admin')).send({ reason: 'citizen request' }).expect(200);
      expect(r.body.alreadyAnonymized).toBe(false);

      expect(await prisma.caseContact.count({ where: { caseId: id } })).toBe(0);
      expect(await prisma.caseAttachment.count({ where: { caseId: id } })).toBe(0);
      const row = await prisma.citizenCase.findUniqueOrThrow({ where: { id }, include: { messages: true } });
      expect(row.anonymizedAt).not.toBeNull();
      expect(row.title).toMatch(/removed/);
      expect(row.messages.every((m) => /removed/.test(m.content))).toBe(true);
      // Non-identifying record survives for accountability and statistics.
      expect(row).toMatchObject({ publicId: ref, status: 'CLOSED', category: 'roads_infrastructure' });
      expect(await prisma.auditEvent.count({ where: { action: 'case.anonymize', objectId: id } })).toBe(1);
      const v = (await view(ref, code)).body;
      expect(v).toMatchObject({ anonymized: true, title: null });
      expect(JSON.stringify(v)).not.toMatch(/pothole/i);
      // Repeating it is safe.
      expect((await http().post(`/api/v1/internal/cases/${id}/erase`).set(auth('tok-admin')).send({ reason: 'again' }).expect(200)).body.alreadyAnonymized).toBe(true);
      // Anonymised cases drop out of work queues.
      expect((await http().get('/api/v1/internal/cases').set(auth('tok-staffA'))).body.items.map((c: any) => c.id)).not.toContain(id);
    });
  });

  // ---------------------------------------------------------------- T-057
  describe('human escalation', () => {
    let id: string;
    let ref: string;

    beforeAll(async () => {
      const r = await submit({ category: 'other', title: 'Threats from a landlord', description: 'A man has threatened to kill me if I report him to the assembly.' }).expect(201);
      ref = r.body.reference;
      expect(r.body.safetyNotice).toMatch(/112/);
      id = (await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: ref } })).id;
    });

    it('flags the case, raises priority and shortens the deadline', async () => {
      const c = await prisma.citizenCase.findUniqueOrThrow({ where: { id } });
      expect(c).toMatchObject({ escalated: true, priority: 'URGENT' });
      expect(c.escalationReason).toMatch(/safety/);
      expect(c.dueAt!.getTime() - c.createdAt.getTime()).toBeLessThanOrEqual(24 * 3600_000 + 1000);
      expect(await prisma.auditEvent.count({ where: { action: 'case.escalate', objectId: id } })).toBe(1);
    });

    it('lists escalated cases first and counts them', async () => {
      const q = await http().get('/api/v1/internal/cases').set(auth('tok-staffA')).expect(200);
      expect(q.body.items[0].id).toBe(id);
      const only = await http().get('/api/v1/internal/cases').query({ escalated: 'true' }).set(auth('tok-staffA'));
      expect(only.body.items.every((c: any) => c.escalated)).toBe(true);
      expect((await http().get('/api/v1/internal/cases/stats').set(auth('tok-staffA'))).body.escalated).toBeGreaterThan(0);
    });

    it('lets staff triage and note, but only the MP or an administrator answer or lift it', async () => {
      await http().post(`/api/v1/internal/cases/${id}/status`).set(auth('tok-staffA')).send({ status: 'TRIAGED' }).expect(200);
      await http().post(`/api/v1/internal/cases/${id}/notes`).set(auth('tok-staffA')).send({ content: 'Call police liaison' }).expect(201);
      await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffA')).send({ content: 'We will look into it.' }).expect(403);
      await http().post(`/api/v1/internal/cases/${id}/escalation`).set(auth('tok-staffA')).send({ escalated: false, reason: 'not serious' }).expect(403);
      await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-mpA')).send({ content: 'I have asked the police liaison to contact you.' }).expect(201);
      const lifted = await http().post(`/api/v1/internal/cases/${id}/escalation`).set(auth('tok-mpA')).send({ escalated: false, reason: 'police engaged' }).expect(200);
      expect(lifted.body.escalated).toBe(false);
      await http().post(`/api/v1/internal/cases/${id}/responses`).set(auth('tok-staffA')).send({ content: 'Follow-up from the office.' }).expect(201);
    });

    it('lets staff escalate manually and records why', async () => {
      const r = await submit().expect(201);
      const cid = (await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: r.body.reference } })).id;
      const e = await http().post(`/api/v1/internal/cases/${cid}/escalation`).set(auth('tok-staffA')).send({ escalated: true, reason: 'Caller mentioned a legal threat' }).expect(200);
      expect(e.body).toMatchObject({ escalated: true, priority: 'HIGH' });
      expect(e.body.events.map((x: any) => x.kind)).toContain('escalated');
    });

    it('escalates sensitive categories even when the text looks ordinary', async () => {
      const r = await submit({ category: 'corruption_allegation', description: 'The contract for the clinic was given without any tender process at all.' }).expect(201);
      const c = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: r.body.reference } });
      expect(c).toMatchObject({ escalated: true, priority: 'HIGH' });
      expect(r.body.safetyNotice).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------- T-056 (no provider)
  describe('citizens who opted out of notifications', () => {
    it('sends nothing to a citizen who chose no channel, and still publishes responses on the tracking page', async () => {
      const none = await submit({ contact: { channel: 'NONE' } }).expect(201);
      const row = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: none.body.reference } });
      expect(await prisma.notification.count({ where: { caseId: row.id } })).toBe(0);
      // Staff responses to a no-notification citizen are published to the tracking page and marked delivered there.
      const cid = row.id;
      const r = await http().post(`/api/v1/internal/cases/${cid}/responses`).set(auth('tok-staffA')).send({ content: 'Seen.' }).expect(201);
      expect(r.body.messages.pop()).toMatchObject({ channel: 'portal', deliveryState: 'DELIVERED' });
    });
  });

  // ---------------------------------------------------------------- T-058
  describe('retention', () => {
    it('anonymises closed cases past their retention date and leaves the rest alone', async () => {
      const old = await submit().expect(201);
      const fresh = await submit().expect(201);
      const oldRow = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: old.body.reference } });
      const freshRow = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: fresh.body.reference } });
      for (const c of [oldRow, freshRow]) await prisma.citizenCase.update({ where: { id: c.id }, data: { status: 'CLOSED', closedAt: new Date(), retainUntil: c.id === oldRow.id ? new Date(Date.now() - 1000) : new Date(Date.now() + 86_400_000) } });
      await http().post('/api/v1/internal/retention/sweep').set(auth('tok-staffA')).expect(403);
      const r = await http().post('/api/v1/internal/retention/sweep').set(auth('tok-admin')).expect(200);
      expect(r.body.anonymized).toBeGreaterThanOrEqual(1);
      expect((await prisma.citizenCase.findUniqueOrThrow({ where: { id: oldRow.id } })).anonymizedAt).not.toBeNull();
      expect(await prisma.caseContact.count({ where: { caseId: oldRow.id } })).toBe(0);
      expect((await prisma.citizenCase.findUniqueOrThrow({ where: { id: freshRow.id } })).anonymizedAt).toBeNull();
      expect(await prisma.caseContact.count({ where: { caseId: freshRow.id } })).toBe(1);
      // Open cases are never swept, however old.
      const open = await submit().expect(201);
      await prisma.citizenCase.update({ where: { publicId: open.body.reference }, data: { retainUntil: new Date(Date.now() - 1000) } });
      await app.get(CasesService).sweepRetention();
      expect((await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: open.body.reference } })).anonymizedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------- T-049
  describe('boundary changes', () => {
    it('previews, applies and reports a boundary update without deleting history', async () => {
      const rows = [
        { code: 'GA-TE', name: 'Tema East', region: 'Greater Accra', aliases: ['Tema Community 1', 'Tema East Municipal'] },
        { code: 'GA-TN', name: 'Tema North (new)', region: 'Greater Accra' },
      ]; // Tamale Central is absent => deactivated
      const dry = await http().post('/api/v1/internal/constituencies/import').set(auth('tok-admin')).send({ sourceRef: 'EC gazette 2026/12', rows, dryRun: true }).expect(200);
      expect(dry.body).toMatchObject({ dryRun: true, added: ['GA-TN'], updated: ['GA-TE'], deactivated: ['NR-TC'] });
      expect(await prisma.constituency.count()).toBe(2); // nothing written

      await prisma.citizenCase.create({ data: { publicId: 'GH-2026-900001', constituencyId: tamale, category: 'other', title: 't', consentGivenAt: new Date(), consentPurpose: 'p' } });
      const done = await http().post('/api/v1/internal/constituencies/import').set(auth('tok-admin')).send({ sourceRef: 'EC gazette 2026/12', rows }).expect(200);
      expect(done.body.openCasesNeedingReroute).toBe(1);
      expect(await prisma.constituency.count()).toBe(3);
      const t = await prisma.constituency.findUniqueOrThrow({ where: { id: tamale } });
      expect(t).toMatchObject({ isActive: false, sourceRef: 'EC gazette 2026/12' });
      // Deactivated constituencies leave public lookup and cannot receive new cases.
      expect((await http().get('/api/v1/public/constituencies/lookup').query({ q: 'Tamale' })).body.matches).toEqual([]);
      await submit({ constituencyId: tamale }).expect(400);
      // ...but the historic case is still there and can be rerouted by an administrator.
      const tn = (await prisma.constituency.findUniqueOrThrow({ where: { code: 'GA-TN' } })).id;
      const old = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: 'GH-2026-900001' } });
      await http().post(`/api/v1/internal/cases/${old.id}/reroute`).set(auth('tok-staffA')).send({ constituencyId: tn }).expect(403);
      await http().post(`/api/v1/internal/cases/${old.id}/reroute`).set(auth('tok-admin')).send({ constituencyId: tn }).expect(200);
      expect((await prisma.citizenCase.findUniqueOrThrow({ where: { id: old.id } })).constituencyId).toBe(tn);
      await http().post('/api/v1/internal/constituencies/import').set(auth('tok-admin')).send({ sourceRef: 'dup', rows: [rows[0], rows[0]] }).expect(400);
    });
  });
});
