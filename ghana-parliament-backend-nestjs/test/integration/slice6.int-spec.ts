import { freshDatabaseUrl } from './db';

process.env.DATABASE_URL = freshDatabaseUrl('slice6');
process.env.OIDC_ISSUER = 'https://idp.test/realm';
process.env.OIDC_AUDIENCE = 'parliament-api';
process.env.JOBS_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT_OVERRIDE = '100000';
process.env.CASE_TOKEN_SECRET = 'integration-test-secret-0123456789abcdef';
delete process.env.ANTHROPIC_API_KEY;

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { TokenVerifier } from '../../src/auth/token-verifier';

describe('Slice 6 - MP insights, meetings and policy feedback (no AI provider configured)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const tokens: Record<string, string> = { 'tok-staff': 'sub-staff', 'tok-mp': 'sub-mp', 'tok-admin': 'sub-admin', 'tok-other-staff': 'sub-other-staff' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

  let temaEast: string;
  let tamale: string;
  let mpId: string;
  let billId: string;
  let sittingId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue({ verify: async (t: string) => { if (!tokens[t]) throw new UnauthorizedException(); return { sub: tokens[t] }; } })
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    temaEast = (await prisma.constituency.create({ data: { code: 'GA-TE', name: 'Tema East', region: 'Greater Accra', aliases: [], sourceRef: 'test' } })).id;
    tamale = (await prisma.constituency.create({ data: { code: 'NR-TM', name: 'Tamale Central', region: 'Northern', aliases: [], sourceRef: 'test' } })).id;

    const mpUser = await prisma.user.create({ data: { externalId: 'sub-mp', email: 'mp@parliament.gh', displayName: 'MP User', roles: ['MP'], constituencies: { create: { constituencyId: temaEast } } } });
    await prisma.user.create({ data: { externalId: 'sub-staff', email: 'staff@parliament.gh', displayName: 'Staff', roles: ['STAFF'], constituencies: { create: { constituencyId: temaEast } } } });
    await prisma.user.create({ data: { externalId: 'sub-other-staff', email: 'other@parliament.gh', displayName: 'Other Staff', roles: ['STAFF'], constituencies: { create: { constituencyId: tamale } } } });
    await prisma.user.create({ data: { externalId: 'sub-admin', email: 'admin@parliament.gh', displayName: 'Admin', roles: ['ADMIN'] } });

    mpId = (await prisma.mp.create({ data: { officialName: 'Hon. Ama Mensah', party: 'NDC', activeFrom: new Date('2021-01-07'), constituencyId: temaEast, userId: mpUser.id, isPublished: true } })).id;
    billId = (await prisma.bill.create({ data: { title: 'Sanitation Levy Act', stage: 'ASSENTED', isPublished: true } })).id;
    sittingId = (await prisma.sitting.create({ data: { date: new Date('2024-03-14'), type: 'Plenary' } })).id;

    // A handful of cases across categories so insights has real data to aggregate.
    const mkCase = (category: string, escalated = false) =>
      prisma.citizenCase.create({
        data: {
          publicId: `GH-TEST-${randomUUID().slice(0, 8)}`,
          constituencyId: temaEast,
          category,
          status: 'RECEIVED',
          consentGivenAt: new Date(),
          consentPurpose: 'test',
          escalated,
        },
      });
    await mkCase('roads_infrastructure');
    await mkCase('roads_infrastructure');
    await mkCase('water_sanitation', true);
    await mkCase('health');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('MP insight dashboard', () => {
    it('shows the MP their own constituency overview, scoped by role', async () => {
      const r = await http().get(`/api/v1/internal/insights/mp-overview?constituencyId=${temaEast}`).set(auth('tok-mp')).expect(200);
      expect(r.body.constituency.name).toBe('Tema East');
      expect(r.body.topConcerns.find((c: any) => c.category === 'roads_infrastructure').count).toBe(2);
      expect(r.body.openCases).toBe(4);
      // No AI provider configured: sentiment is honestly unavailable, never fabricated.
      expect(r.body.sentiment.available).toBe(false);
      expect(r.body.sentiment.reason).toMatch(/AI provider/);
    });

    it('refuses staff from a different constituency', async () => {
      await http().get(`/api/v1/internal/insights/mp-overview?constituencyId=${temaEast}`).set(auth('tok-other-staff')).expect(403);
    });

    it('lets an administrator view any constituency', async () => {
      await http().get(`/api/v1/internal/insights/mp-overview?constituencyId=${temaEast}`).set(auth('tok-admin')).expect(200);
    });
  });

  describe('issue clustering', () => {
    it('groups open cases by category and flags the escalated one as urgent', async () => {
      const r = await http().get(`/api/v1/internal/insights/clusters?constituencyId=${temaEast}`).set(auth('tok-staff')).expect(200);
      const water = r.body.find((c: any) => c.category === 'water_sanitation');
      expect(water.urgent).toBe(true);
      expect(water.escalated).toBe(1);
    });
  });

  describe('national heatmap', () => {
    it('is visible to admin, scored by region', async () => {
      const r = await http().get('/api/v1/internal/insights/heatmap').set(auth('tok-admin')).expect(200);
      const region = r.body.find((x: any) => x.region === 'Greater Accra');
      expect(region.openCases).toBe(4);
    });

    it('is refused to staff and MPs', async () => {
      await http().get('/api/v1/internal/insights/heatmap').set(auth('tok-staff')).expect(403);
      await http().get('/api/v1/internal/insights/heatmap').set(auth('tok-mp')).expect(403);
    });
  });

  describe('per-sitting AI summarization', () => {
    it('honestly reports unavailable with no AI provider configured, rather than fabricating a summary', async () => {
      const post = await http().post(`/api/v1/internal/sittings/${sittingId}/summary`).set(auth('tok-staff')).expect(201);
      expect(post.body.status).toBe('UNAVAILABLE');
      expect(post.body.unavailableReason).toMatch(/ANTHROPIC_API_KEY/);
      const get = await http().get(`/api/v1/internal/sittings/${sittingId}/summary`).set(auth('tok-staff')).expect(200);
      expect(get.body.status).toBe('UNAVAILABLE');
    });
  });

  describe('AI-drafted case response', () => {
    it('honestly reports unavailable with no AI provider configured', async () => {
      const submitted = await http().post('/api/v1/public/cases').send({
        constituencyId: temaEast, category: 'roads_infrastructure', title: 'Potholes', description: 'The road near my house is full of potholes and floods when it rains, please fix it soon.',
        consent: true, contact: { channel: 'NONE' }, submissionKey: randomUUID(),
      }).expect(201);
      const caseId = (await prisma.citizenCase.findUniqueOrThrow({ where: { publicId: submitted.body.reference } })).id;
      const r = await http().get(`/api/v1/internal/cases/${caseId}/draft-response`).set(auth('tok-staff')).expect(200);
      expect(r.body.available).toBe(false);
      expect(r.body.reason).toMatch(/ANTHROPIC_API_KEY/);
    });
  });

  describe('meeting scheduling', () => {
    it('refuses a request outside the MP’s published availability', async () => {
      const slot = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
      await http().post('/api/v1/public/meetings').send({ mpId, requestedName: 'Kofi Mensah', topic: 'Road repairs', requestedSlot: slot }).expect(400);
    });

    it('lets the MP open a weekly availability window, then confirms a citizen request inside it', async () => {
      // Open Mondays 09:00-12:00. Pick the next Monday regardless of today's day-of-week.
      await http().post(`/api/v1/internal/mps/${mpId}/meetings/availability`).set(auth('tok-mp')).send({ windows: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] }).expect(201);

      const nextMonday = new Date();
      nextMonday.setUTCDate(nextMonday.getUTCDate() + ((1 - nextMonday.getUTCDay() + 7) % 7 || 7));
      nextMonday.setUTCHours(10, 0, 0, 0);

      const req = await http().post('/api/v1/public/meetings').send({
        mpId, requestedName: 'Kofi Mensah', topic: 'Road repairs', requestedSlot: nextMonday.toISOString(),
      }).expect(201);
      expect(req.body.status).toBe('REQUESTED');

      const list = await http().get(`/api/v1/internal/mps/${mpId}/meetings`).set(auth('tok-mp')).expect(200);
      expect(list.body).toHaveLength(1);

      const decided = await http().patch(`/api/v1/internal/meetings/${req.body.id}`).set(auth('tok-mp')).send({ decision: 'CONFIRMED' }).expect(200);
      expect(decided.body.status).toBe('CONFIRMED');
      expect(decided.body.confirmedSlot).toBeTruthy();
    });

    it('refuses staff from another constituency from deciding this MP’s meetings', async () => {
      const windows = await http().get(`/api/v1/internal/mps/${mpId}/meetings/availability`).set(auth('tok-mp')).expect(200);
      expect(windows.body.length).toBeGreaterThan(0);
      await http().get(`/api/v1/internal/mps/${mpId}/meetings`).set(auth('tok-other-staff')).expect(403);
    });
  });

  describe('policy impact feedback loop', () => {
    it('refuses feedback on a bill that is not yet in force', async () => {
      const draft = await prisma.bill.create({ data: { title: 'Draft Bill', stage: 'FIRST_READING', isPublished: true } });
      await http().post(`/api/v1/public/bills/${draft.id}/feedback`).send({ sentiment: 'POSITIVE' }).expect(400);
    });

    it('accepts feedback on an assented (in-force) bill and aggregates it for staff', async () => {
      await http().post(`/api/v1/public/bills/${billId}/feedback`).send({ sentiment: 'NEGATIVE', comment: 'The levy is too high for small traders.' }).expect(201);
      await http().post(`/api/v1/public/bills/${billId}/feedback`).send({ sentiment: 'POSITIVE' }).expect(201);

      const summary = await http().get(`/api/v1/internal/bills/${billId}/feedback`).set(auth('tok-staff')).expect(200);
      expect(summary.body.total).toBe(2);
      expect(summary.body.byLabel.NEGATIVE).toBe(1);
      expect(summary.body.byLabel.POSITIVE).toBe(1);
      expect(summary.body.recentComments).toHaveLength(1);
    });
  });
});
