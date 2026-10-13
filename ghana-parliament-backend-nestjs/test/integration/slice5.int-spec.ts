import { freshDatabaseUrl } from './db';

process.env.DATABASE_URL = freshDatabaseUrl('slice5');
process.env.OIDC_ISSUER = 'https://idp.test/realm';
process.env.OIDC_AUDIENCE = 'parliament-api';
process.env.JOBS_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT_OVERRIDE = '100000';
process.env.CASE_TOKEN_SECRET = 'integration-test-secret-0123456789abcdef';
process.env.ADMIN_APP_URL = 'https://admin.test';

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { TokenVerifier } from '../../src/auth/token-verifier';
import { NotificationSender, OutboundMessage } from '../../src/cases/notifications';
import { JobsService } from '../../src/jobs/jobs.service';

class FakeSender extends NotificationSender {
  sent: OutboundMessage[] = [];
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    return { providerRef: `fake-${this.sent.length}` };
  }
}

const STORY = 'The road from Community 9 to the main market has deep potholes and floods when it rains. Please call me on 0244123456.';

describe('Slice 5 - settings, staff alerts and the erasure ledger', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jobs: JobsService;
  const sender = new FakeSender();
  const tokens: Record<string, string> = { 'tok-staffA': 'sub-staffA', 'tok-admin': 'sub-admin', 'tok-rev': 'sub-rev' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());
  let temaEast: string;
  let emptyDistrict: string;

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
    temaEast = (await prisma.constituency.create({ data: { code: 'GA-TE', name: 'Tema East', region: 'Greater Accra', aliases: [], sourceRef: 'test' } })).id;
    emptyDistrict = (await prisma.constituency.create({ data: { code: 'XX-EM', name: 'Empty District', region: 'Volta', aliases: [], sourceRef: 'test' } })).id;
    const mk = (externalId: string, roles: any[], extra: object = {}) =>
      prisma.user.create({ data: { externalId, email: `${externalId}@parliament.gh`, displayName: externalId, roles, ...extra } });
    await mk('sub-staffA', ['STAFF'], { constituencies: { create: { constituencyId: temaEast } } });
    await mk('sub-admin', ['ADMIN']);
    await mk('sub-rev', ['REVIEWER']);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const submit = (over: object = {}) =>
    http().post('/api/v1/public/cases').send({
      constituencyId: temaEast, category: 'roads_infrastructure', title: 'Potholes on market road', description: STORY,
      consent: true, contact: { name: 'Kofi', email: 'kofi@example.com', channel: 'EMAIL' }, submissionKey: randomUUID(), ...over,
    });
  const alertsTo = (addr: string) => sender.sent.filter((m) => m.to === addr);

  describe('settings', () => {
    it('shows the effective settings to administrators and reviewers only', async () => {
      const r = await http().get('/api/v1/internal/settings').set(auth('tok-admin')).expect(200);
      expect(r.body.cases.values).toEqual({ retentionDays: 730, slaHours: 120, slaUrgentHours: 24 });
      expect(r.body.cases.sources.slaHours).toBe('default');
      expect(r.body.languages.items.find((l: any) => l.code === 'en').level).toBe('supported');
      expect(r.body.notifications.configured).toBe(false);
      await http().get('/api/v1/internal/settings').set(auth('tok-rev')).expect(200);
      await http().get('/api/v1/internal/settings').set(auth('tok-staffA')).expect(403);
      await http().get('/api/v1/internal/settings').expect(401);
    });

    it('only an administrator can change them, and bad values are refused', async () => {
      await http().put('/api/v1/internal/settings/cases').set(auth('tok-rev')).send({ retentionDays: 365, slaHours: 48, slaUrgentHours: 6 }).expect(403);
      await http().put('/api/v1/internal/settings/cases').set(auth('tok-admin')).send({ retentionDays: 365, slaHours: 48 }).expect(400);
      await http().put('/api/v1/internal/settings/cases').set(auth('tok-admin')).send({ retentionDays: 0, slaHours: 48, slaUrgentHours: 6 }).expect(400);
      await http().put('/api/v1/internal/settings/cases').set(auth('tok-admin')).send({ retentionDays: 365, slaHours: 5, slaUrgentHours: 6 }).expect(400);
      await http().put('/api/v1/internal/settings/cases').set(auth('tok-admin')).send({ retentionDays: 365, slaHours: 48, slaUrgentHours: 6, extra: 1 }).expect(400);
    });

    it('applies a change to new cases at once and records who changed what', async () => {
      const r = await http().put('/api/v1/internal/settings/cases').set(auth('tok-admin')).send({ retentionDays: 365, slaHours: 48, slaUrgentHours: 6 }).expect(200);
      expect(r.body.cases.values).toEqual({ retentionDays: 365, slaHours: 48, slaUrgentHours: 6 });
      expect(r.body.cases.sources.retentionDays).toBe('database');
      const ref = (await submit().expect(201)).body.reference;
      const c = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: ref } });
      expect(Math.round((c.dueAt!.getTime() - c.createdAt.getTime()) / 3600_000)).toBe(48);
      const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'settings.cases.update' } });
      expect(ev.payload).toMatchObject({ before: { slaHours: 120 }, after: { slaHours: 48 } });
    });
  });

  describe('staff alerts', () => {
    beforeEach(async () => { await jobs.drain(); sender.sent = []; });

    it('tells the constituency staff about a new issue without revealing what the citizen wrote', async () => {
      const ref = (await submit().expect(201)).body.reference;
      await jobs.drain();
      const mail = alertsTo('sub-staffA@parliament.gh');
      expect(mail).toHaveLength(1);
      expect(mail[0]).toMatchObject({ channel: 'EMAIL', subject: `New issue ${ref}` });
      expect(mail[0].body).toContain('https://admin.test/cases');
      expect(`${mail[0].subject} ${mail[0].body}`).not.toMatch(/pothole|0244|Kofi|kofi@|market/i);
      expect(alertsTo('sub-admin@parliament.gh')).toHaveLength(0);
    });

    it('marks an automatically escalated issue as escalated', async () => {
      const ref = (await submit({ description: 'Someone threatened me after I complained about the road contractor.' }).expect(201)).body.reference;
      await jobs.drain();
      expect(alertsTo('sub-staffA@parliament.gh').map((m) => m.subject)).toContain(`Escalated issue ${ref}`);
    });

    it('does not repeat an alert when the same submission is retried', async () => {
      const key = randomUUID();
      await submit({ submissionKey: key }).expect(201);
      await submit({ submissionKey: key }).expect(201);
      await jobs.drain();
      expect(alertsTo('sub-staffA@parliament.gh')).toHaveLength(1);
    });

    it('falls back to administrators when nobody is assigned to the constituency', async () => {
      const ref = (await submit({ constituencyId: emptyDistrict }).expect(201)).body.reference;
      await jobs.drain();
      expect(alertsTo('sub-staffA@parliament.gh')).toHaveLength(0);
      expect(alertsTo('sub-admin@parliament.gh').map((m) => m.subject)).toContain(`New issue ${ref}`);
    });

    it('can be switched off', async () => {
      process.env.STAFF_ALERTS = 'false';
      try {
        await submit().expect(201);
        await jobs.drain();
        expect(alertsTo('sub-staffA@parliament.gh')).toHaveLength(0);
      } finally {
        delete process.env.STAFF_ALERTS;
      }
    });

    it('stops sending to someone deactivated after the alert was queued', async () => {
      await submit().expect(201);
      await prisma.user.update({ where: { externalId: 'sub-staffA' }, data: { active: false } });
      await jobs.drain();
      await prisma.user.update({ where: { externalId: 'sub-staffA' }, data: { active: true } });
      expect(alertsTo('sub-staffA@parliament.gh')).toHaveLength(0);
    });
  });

  describe('erasure ledger', () => {
    it('records each erasure without personal data and cannot be altered', async () => {
      const sub = await submit().expect(201);
      const c = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: sub.body.reference } });
      await http().post(`/api/v1/internal/cases/${c.id}/erase`).set(auth('tok-admin')).send({ reason: 'citizen request' }).expect(200);

      const ledger = (await http().get('/api/v1/internal/erasures/ledger').set(auth('tok-admin')).expect(200)).body;
      expect(ledger.entries).toEqual([expect.objectContaining({ caseId: c.id, reference: sub.body.reference, kind: 'request' })]);
      expect(ledger.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(ledger)).not.toMatch(/kofi|pothole|0244/i);

      await expect(prisma.erasureLedger.deleteMany({})).rejects.toThrow(/append-only/);
      await expect(prisma.erasureLedger.updateMany({ data: { kind: 'x' } })).rejects.toThrow(/append-only/);
      await http().get('/api/v1/internal/erasures/ledger').set(auth('tok-staffA')).expect(403);
      await http().get('/api/v1/internal/erasures/ledger').set(auth('tok-admin')).query({ since: 'nonsense' }).expect(400);
    });

    it('lists only entries after a given time', async () => {
      const all = (await http().get('/api/v1/internal/erasures/ledger').set(auth('tok-admin'))).body;
      const after = (await http().get('/api/v1/internal/erasures/ledger').set(auth('tok-admin')).query({ since: new Date(Date.now() + 60_000).toISOString() })).body;
      expect(all.count).toBeGreaterThan(0);
      expect(after.count).toBe(0);
    });

    it('records retention erasures too', async () => {
      const ref = (await submit().expect(201)).body.reference;
      const c = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: ref } });
      await prisma.citizenCase.update({ where: { id: c.id }, data: { status: 'CLOSED', closedAt: new Date(), retainUntil: new Date(Date.now() - 1000) } });
      await http().post('/api/v1/internal/retention/sweep').set(auth('tok-admin')).expect(200);
      expect(await prisma.erasureLedger.findUnique({ where: { caseId: c.id } })).toMatchObject({ kind: 'retention', reference: ref });
    });

    it('erases again whatever a restore brought back, and is safe to repeat', async () => {
      const ref = (await submit().expect(201)).body.reference;
      const c = await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: ref } });
      await http().post(`/api/v1/internal/cases/${c.id}/erase`).set(auth('tok-admin')).send({ reason: 'citizen request' }).expect(200);
      const exported = (await http().get('/api/v1/internal/erasures/ledger').set(auth('tok-admin'))).body;

      // Simulate restoring a backup taken before the erasure: the personal data is back.
      await prisma.citizenCase.update({ where: { id: c.id }, data: { title: 'Potholes on market road', anonymizedAt: null } });
      await prisma.caseContact.create({ data: { caseId: c.id, channel: 'EMAIL', name: 'Kofi', email: 'kofi@example.com' } });

      const first = (await http().post('/api/v1/internal/erasures/reapply').set(auth('tok-admin')).send({ entries: exported.entries }).expect(200)).body;
      expect(first.erased).toBe(1);
      expect(first.requested).toBe(exported.entries.length);
      const after = await prisma.citizenCase.findUniqueOrThrow({ where: { id: c.id }, include: { contact: true } });
      expect(after.title).not.toMatch(/Potholes/);
      expect(after.anonymizedAt).not.toBeNull();
      expect(after.contact).toBeNull();

      const second = (await http().post('/api/v1/internal/erasures/reapply').set(auth('tok-admin')).send({ entries: exported.entries }).expect(200)).body;
      expect(second.erased).toBe(0);
      expect(second.alreadyErased).toBe(exported.entries.length);
    });

    it('reports unknown cases and refuses malformed or non-admin requests', async () => {
      const ghost = randomUUID();
      const r = (await http().post('/api/v1/internal/erasures/reapply').set(auth('tok-admin')).send({ entries: [{ caseId: ghost }] }).expect(200)).body;
      expect(r.missing).toEqual([ghost]);
      await http().post('/api/v1/internal/erasures/reapply').set(auth('tok-admin')).send({ entries: [{ caseId: 'nope' }] }).expect(400);
      await http().post('/api/v1/internal/erasures/reapply').set(auth('tok-admin')).send({}).expect(400);
      await http().post('/api/v1/internal/erasures/reapply').set(auth('tok-staffA')).send({ entries: [] }).expect(403);
    });
  });
});
