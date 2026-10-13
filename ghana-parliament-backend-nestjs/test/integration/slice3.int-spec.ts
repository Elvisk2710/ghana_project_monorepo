import { freshDatabaseUrl } from './db';

process.env.DATABASE_URL = freshDatabaseUrl('slice3');
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

const SITTING_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

type Tok = { sub: string; email?: string; emailVerified?: boolean };

describe('Phase 4 - parliamentary operations: records, approvals gate, users, overview, public business', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const tokens: Record<string, Tok> = {
    staff: { sub: 'sub-staff' }, mp: { sub: 'sub-mp' }, rev: { sub: 'sub-rev' }, admin: { sub: 'sub-admin' }, admin2: { sub: 'sub-admin2' },
    newbie: { sub: 'sub-newbie', email: 'Newbie@Parliament.gh', emailVerified: true },
    spoof: { sub: 'sub-spoof', email: 'spoof@parliament.gh', emailVerified: false },
  };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());
  const get = (path: string, t = 'staff') => http().get(`/api/v1${path}`).set(auth(t));
  const post = (path: string, body: object, t = 'staff') => http().post(`/api/v1${path}`).set(auth(t)).send(body);
  const patch = (path: string, body: object, t = 'staff') => http().patch(`/api/v1${path}`).set(auth(t)).send(body);
  const pub = (path: string) => http().get(`/api/v1/public${path}`);
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    prisma = new PrismaClient();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue({ verify: async (t: string) => { if (!tokens[t]) throw new UnauthorizedException(); return tokens[t]; } })
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const mk = async (key: string, roles: any[]) => { ids[key] = (await prisma.user.create({ data: { externalId: `sub-${key}`, email: `${key}@parliament.gh`, displayName: key, roles } })).id; };
    await mk('staff', ['STAFF']); await mk('mp', ['MP']); await mk('rev', ['REVIEWER']); await mk('admin', ['ADMIN']); await mk('admin2', ['ADMIN']);
    ids.con = (await prisma.constituency.create({ data: { code: 'GA-TE', name: 'Tema East', region: 'Greater Accra' } })).id;
    ids.mp1 = (await prisma.mp.create({ data: { officialName: 'Hon. Ama Mensah', party: 'NDC', activeFrom: new Date('2021-01-07'), constituencyId: ids.con, isPublished: true } })).id;
    ids.mp2 = (await prisma.mp.create({ data: { officialName: 'Hon. Kofi Draft', party: 'NPP', activeFrom: new Date('2021-01-07'), constituencyId: ids.con, isPublished: false } })).id;
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  describe('records API', () => {
    it('requires a staff role to read and STAFF/ADMIN to write', async () => {
      await http().get('/api/v1/internal/bills').expect(401);
      await get('/internal/bills', 'newbie').expect(403); // unprovisioned yet
      await post('/internal/bills', { title: 'Nope bill' }, 'mp').expect(403);
      await post('/internal/bills', { title: 'Nope bill' }, 'rev').expect(403);
      await get('/internal/bills', 'mp').expect(200);
    });

    it('creates committees with members and a chair, and rejects bad references', async () => {
      const c = (await post('/internal/committees', { name: 'Finance Committee', remit: 'Budget and revenue', chairMpId: ids.mp1, members: [{ mpId: ids.mp1, role: 'Chair' }, { mpId: ids.mp2 }] }).expect(201)).body;
      ids.committee = c.id;
      const d = (await get(`/internal/committees/${c.id}`).expect(200)).body;
      expect(d.members.map((m: any) => m.role).sort()).toEqual(['Chair', 'Member']);
      expect(d.chair.officialName).toBe('Hon. Ama Mensah');
      await post('/internal/committees', { name: 'Finance Committee' }).expect(409);
      await post('/internal/committees', { name: 'Bad chair', chairMpId: randomUUID() }).expect(404);
      await post('/internal/committees', { name: 'Dup members', members: [{ mpId: ids.mp1 }, { mpId: ids.mp1 }] }).expect(400);
      await post('/internal/committees', { name: 'Ghost member', members: [{ mpId: randomUUID() }] }).expect(400);
      await patch(`/internal/committees/${c.id}`, { members: [{ mpId: ids.mp1, role: 'Chair' }] }).expect(200);
      expect((await get(`/internal/committees/${c.id}`)).body.members).toHaveLength(1);
    });

    it('creates, edits and persists bills linked to a committee and sittings', async () => {
      const s = (await post('/internal/sittings', { date: SITTING_DATE, type: 'Plenary', agenda: [{ title: 'Statements' }] }).expect(201)).body;
      ids.sitting = s.id;
      const b = (await post('/internal/bills', { title: 'Petroleum Revenue Amendment Bill', sponsor: 'Minister for Finance', committeeId: ids.committee, summary: 'Amends revenue sharing.', sittingIds: [s.id], introducedOn: '2026-10-01' }).expect(201)).body;
      ids.bill = b.id;
      expect((await patch(`/internal/bills/${b.id}`, { stage: 'COMMITTEE' }).expect(200)).body.stage).toBe('COMMITTEE');
      const d = (await get(`/internal/bills/${b.id}`)).body;
      expect(d).toMatchObject({ stage: 'COMMITTEE', committee: { name: 'Finance Committee' } });
      expect(d.sittings[0].sitting.id).toBe(s.id);
      expect((await get('/internal/bills').query({ stage: 'COMMITTEE', search: 'petroleum' })).body).toHaveLength(1);
      expect((await get('/internal/bills').query({ stage: 'ASSENTED' })).body).toHaveLength(0);
      await get('/internal/bills').query({ stage: 'BOGUS' }).expect(400);
      await post('/internal/bills', { title: 'x' }).expect(400);
      await post('/internal/bills', { title: 'Bad links bill', sittingIds: [randomUUID()] }).expect(400);
      await post('/internal/bills', { title: 'Bad committee bill', committeeId: randomUUID() }).expect(404);
      await get('/internal/bills/not-a-uuid').expect(404);
    });

    it('validates sitting agendas and the bills they point at', async () => {
      await patch(`/internal/sittings/${ids.sitting}`, { agenda: [{ title: 'Second reading', billId: ids.bill }, { title: 'Statements' }] }).expect(200);
      await patch(`/internal/sittings/${ids.sitting}`, { agenda: [{ title: '' }] }).expect(400);
      await patch(`/internal/sittings/${ids.sitting}`, { agenda: [{ title: 'x', billId: randomUUID() }] }).expect(400);
      await patch(`/internal/sittings/${ids.sitting}`, { agenda: 'nope' }).expect(400);
      await post('/internal/sittings', { type: 'Plenary' }).expect(400);
      expect((await get(`/internal/sittings/${ids.sitting}`)).body.agenda).toHaveLength(2);
      expect((await get('/internal/sittings').query({ from: SITTING_DATE, to: SITTING_DATE })).body).toHaveLength(1);
    });

    it('cannot publish by editing: visibility is not a writable field', async () => {
      await patch(`/internal/bills/${ids.bill}`, { isPublished: true }).expect(400);
      await patch(`/internal/sittings/${ids.sitting}`, { isPublished: true }).expect(400);
      await patch(`/internal/committees/${ids.committee}`, { isPublished: true }).expect(400);
      await patch(`/internal/mps/${ids.mp2}`, { isPublished: true }, 'admin').expect(400);
      expect((await prisma.bill.findUniqueOrThrow({ where: { id: ids.bill } })).isPublished).toBe(false);
    });

    it('shows nothing publicly before approval', async () => {
      expect((await pub('/bills')).body.items).toEqual([]);
      await pub(`/bills/${ids.bill}`).expect(404);
      await pub(`/sittings/${ids.sitting}`).expect(404);
      await pub(`/committees/${ids.committee}`).expect(404);
      await pub('/bills/not-a-uuid').expect(404);
    });
  });

  describe('approval gate', () => {
    const request_ = (objectType: string, objectId: string, extra: object = {}, t = 'staff') => post('/internal/approvals', { objectType, objectId, action: 'publish', ...extra }, t);

    it('only STAFF/ADMIN can ask, and only REVIEWER/ADMIN can decide', async () => {
      await request_('bill', ids.bill, {}, 'mp').expect(403);
      const a = (await request_('bill', ids.bill).expect(201)).body;
      ids.approvalBill = a.id;
      expect(a).toMatchObject({ decision: 'PENDING', action: 'publish', objectLabel: 'Petroleum Revenue Amendment Bill', requesterId: ids.staff });
      await post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'staff').expect(403);
      await post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'mp').expect(403);
    });

    it('refuses duplicate requests, unknown records and nonsense actions', async () => {
      await request_('bill', ids.bill).expect(409);
      await request_('bill', randomUUID()).expect(404);
      await request_('widget', ids.bill).expect(400);
      await request_('bill', ids.bill, { action: 'unpublish' }).expect(409); // not published, and pending
    });

    it('does not let someone approve their own request, even an administrator', async () => {
      const a = (await request_('committee', ids.committee, {}, 'admin').expect(201)).body;
      ids.approvalCommittee = a.id;
      const r = await post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'admin').expect(403);
      expect(r.body.message).toMatch(/yourself/);
      expect((await prisma.committee.findUniqueOrThrow({ where: { id: ids.committee } })).isPublished).toBe(false);
      await post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'admin2').expect(200);
      expect((await prisma.committee.findUniqueOrThrow({ where: { id: ids.committee } })).isPublished).toBe(true);
    });

    it('needs a reason to reject, and a rejection publishes nothing', async () => {
      await post(`/internal/approvals/${ids.approvalBill}/decision`, { decision: 'REJECTED' }, 'rev').expect(400);
      await post(`/internal/approvals/${ids.approvalBill}/decision`, { decision: 'CHANGES_REQUESTED', notes: 'Summary is missing' }, 'rev').expect(200);
      const row = await prisma.approval.findUniqueOrThrow({ where: { id: ids.approvalBill } });
      expect(row).toMatchObject({ decision: 'CHANGES_REQUESTED', approverId: ids.rev });
      expect(row.decidedAt).not.toBeNull();
      expect((await prisma.bill.findUniqueOrThrow({ where: { id: ids.bill } })).isPublished).toBe(false);
      await post(`/internal/approvals/${ids.approvalBill}/decision`, { decision: 'APPROVED' }, 'rev').expect(409); // already decided
    });

    it('invalidates approval if the record is edited after it was requested', async () => {
      const a = (await request_('bill', ids.bill).expect(201)).body;
      await patch(`/internal/bills/${ids.bill}`, { summary: 'Edited after the request' }).expect(200);
      const r = await post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'rev').expect(409);
      expect(r.body.message).toMatch(/edited after/);
      expect((await prisma.bill.findUniqueOrThrow({ where: { id: ids.bill } })).isPublished).toBe(false);
      await post(`/internal/approvals/${a.id}/decision`, { decision: 'REJECTED', notes: 'Stale, resubmit' }, 'rev').expect(200);
    });

    it('lets only one of two simultaneous decisions win', async () => {
      const a = (await request_('bill', ids.bill).expect(201)).body;
      const rs = await Promise.all([post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'rev'), post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'admin')]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await prisma.bill.findUniqueOrThrow({ where: { id: ids.bill } })).isPublished).toBe(true);
    });

    it('lists the ledger with who asked and who decided', async () => {
      const all = (await get('/internal/approvals', 'rev').expect(200)).body;
      expect(all.length).toBeGreaterThanOrEqual(4);
      const mine = all.find((a: any) => a.id === ids.approvalBill);
      expect(mine).toMatchObject({ decision: 'CHANGES_REQUESTED', requester: { displayName: 'staff' }, approver: { displayName: 'rev' } });
      expect((await get('/internal/approvals', 'rev').query({ decision: 'APPROVED' })).body.every((a: any) => a.decision === 'APPROVED')).toBe(true);
      await get('/internal/approvals', 'mp').expect(403);
    });

    it('the ledger events are in the append-only audit trail', async () => {
      const acts = (await prisma.auditEvent.findMany({ where: { action: { in: ['approval.request', 'approval.decide'] } } })).map((e) => e.action);
      expect(acts).toContain('approval.request');
      expect(acts).toContain('approval.decide');
      await expect(prisma.auditEvent.deleteMany({})).rejects.toThrow();
    });
  });

  describe('public parliamentary business (T-070, T-071)', () => {
    beforeAll(async () => {
      // Approve the sitting and an MP through the gate; leave one bill unpublished.
      ids.bill2 = (await post('/internal/bills', { title: 'Hidden Draft Bill', committeeId: ids.committee, sittingIds: [ids.sitting] }).expect(201)).body.id;
      const sa = (await post('/internal/approvals', { objectType: 'sitting', objectId: ids.sitting, action: 'publish' }).expect(201)).body;
      await post(`/internal/approvals/${sa.id}/decision`, { decision: 'APPROVED' }, 'rev').expect(200);
      const ma = (await post('/internal/approvals', { objectType: 'mp', objectId: ids.mp2, action: 'publish' }).expect(201)).body;
      await post(`/internal/approvals/${ma.id}/decision`, { decision: 'APPROVED' }, 'rev').expect(200);
      const doc = (publicId: string, published: boolean) => prisma.parliamentaryDocument.create({ data: { publicId, sourceUri: `x://${publicId}`, type: 'HANSARD', title: `Doc ${publicId}`, checksum: publicId, lifecycle: published ? 'PUBLISHED' : 'REVIEW', isPublished: published, sittingId: ids.sitting, billId: ids.bill } });
      await doc('HAN-PUB00001', true);
      await doc('HAN-DRAFT0001', false);
    });

    it('lists only published bills and links them to published committee, sittings and documents', async () => {
      const list = (await pub('/bills').expect(200)).body.items;
      expect(list.map((b: any) => b.title)).toEqual(['Petroleum Revenue Amendment Bill']);
      expect(list[0].committee).toMatchObject({ name: 'Finance Committee' });
      const b = (await pub(`/bills/${ids.bill}`).expect(200)).body;
      expect(b.sittings.map((s: any) => s.id)).toEqual([ids.sitting]);
      expect(b.documents.map((d: any) => d.publicId)).toEqual(['HAN-PUB00001']);
      expect(JSON.stringify(b)).not.toMatch(/HAN-DRAFT|isPublished|sourceUri|REVIEW/);
      await pub(`/bills/${ids.bill2}`).expect(404);
      expect((await pub('/bills').query({ q: 'hidden' })).body.items).toEqual([]);
      await pub('/bills').query({ stage: 'BOGUS' }).expect(400);
    });

    it('a sitting shows its agenda, but only links bills that are public', async () => {
      const s = (await pub(`/sittings/${ids.sitting}`).expect(200)).body;
      expect(s.bills.map((x: any) => x.title)).toEqual(['Petroleum Revenue Amendment Bill']);
      expect(s.agenda).toEqual([{ title: 'Second reading', billId: ids.bill }, { title: 'Statements' }]);
      expect(s.documents.map((d: any) => d.publicId)).toEqual(['HAN-PUB00001']);
      expect((await pub('/sittings').query({ from: SITTING_DATE })).body.items).toHaveLength(1);
      await pub('/sittings').query({ from: 'garbage' }).expect(400);
    });

    it('an agenda never leaks the link to an unpublished bill', async () => {
      await patch(`/internal/sittings/${ids.sitting}`, { agenda: [{ title: 'Hidden bill debate', billId: ids.bill2 }] }).expect(200);
      // Editing a published record is allowed but it must go back through the gate to change visibility; it stays published.
      const s = (await pub(`/sittings/${ids.sitting}`).expect(200)).body;
      expect(s.agenda).toEqual([{ title: 'Hidden bill debate' }]);
      expect(JSON.stringify(s)).not.toContain(ids.bill2);
    });

    it('a committee shows published members and published bills only', async () => {
      await patch(`/internal/committees/${ids.committee}`, { members: [{ mpId: ids.mp1, role: 'Chair' }, { mpId: ids.mp2 }] }).expect(200);
      const c = (await pub(`/committees/${ids.committee}`).expect(200)).body;
      expect(c.members.map((m: any) => m.name).sort()).toEqual(['Hon. Ama Mensah', 'Hon. Kofi Draft']);
      expect(c.chair).toEqual({ id: ids.mp1, name: 'Hon. Ama Mensah' }); // published chair is shown
      expect(c.bills.map((b: any) => b.title)).toEqual(['Petroleum Revenue Amendment Bill']);
      expect((await pub('/committees')).body.items.map((x: any) => x.name)).toEqual(['Finance Committee']);
    });

    it('hides an unpublished chair', async () => {
      await patch(`/internal/committees/${ids.committee}`, { chairMpId: ids.mp2 }).expect(200);
      await prisma.mp.update({ where: { id: ids.mp2 }, data: { isPublished: false } });
      expect((await pub(`/committees/${ids.committee}`)).body.chair).toBeNull();
      await prisma.mp.update({ where: { id: ids.mp2 }, data: { isPublished: true } });
    });

    it('withdrawing a record needs a reason and removes it and its cross-links at once', async () => {
      await post('/internal/approvals', { objectType: 'bill', objectId: ids.bill, action: 'unpublish' }).expect(400);
      const a = (await post('/internal/approvals', { objectType: 'bill', objectId: ids.bill, action: 'unpublish', reason: 'Withdrawn by sponsor' }).expect(201)).body;
      await post(`/internal/approvals/${a.id}/decision`, { decision: 'APPROVED' }, 'rev').expect(200);
      await pub(`/bills/${ids.bill}`).expect(404);
      expect((await pub(`/sittings/${ids.sitting}`)).body.bills).toEqual([]);
      expect((await pub(`/committees/${ids.committee}`)).body.bills).toEqual([]);
    });
  });

  describe('users and roles (T-066)', () => {
    it('is administrators only', async () => {
      await get('/internal/users', 'staff').expect(403);
      await get('/internal/users', 'rev').expect(403);
      expect((await get('/internal/users', 'admin').expect(200)).body.length).toBeGreaterThanOrEqual(5);
    });

    it('invites by email with roles and scope, never storing a usable identity yet', async () => {
      const r = await post('/internal/users/invitations', { email: 'Newbie@Parliament.gh', displayName: 'New Person', roles: ['STAFF'], constituencyIds: [ids.con] }, 'admin').expect(201);
      ids.newbie = r.body.id;
      expect(r.body.email).toBe('newbie@parliament.gh');
      const row = (await get('/internal/users', 'admin')).body.find((u: any) => u.id === ids.newbie);
      expect(row).toMatchObject({ invited: true, active: true, roles: ['STAFF'] });
      expect(JSON.stringify(row)).not.toContain('pending:');
      await post('/internal/users/invitations', { email: 'newbie@parliament.gh', displayName: 'Dup', roles: ['STAFF'] }, 'admin').expect(409);
      await post('/internal/users/invitations', { email: 'a@b.gh', displayName: 'No roles', roles: [] }, 'admin').expect(400);
      await post('/internal/users/invitations', { email: 'a@b.gh', displayName: 'Pub', roles: ['PUBLIC'] }, 'admin').expect(400);
      await post('/internal/users/invitations', { email: 'a@b.gh', displayName: 'Bad scope', roles: ['STAFF'], constituencyIds: [randomUUID()] }, 'admin').expect(400);
    });

    it('binds an invitation on first sign-in only with a verified email', async () => {
      await post('/internal/users/invitations', { email: 'spoof@parliament.gh', displayName: 'Spoof', roles: ['ADMIN'] }, 'admin').expect(201);
      await get('/internal/me', 'spoof').expect(403); // unverified email must not claim the invitation
      const me = (await get('/internal/me', 'newbie').expect(200)).body;
      expect(me).toMatchObject({ email: 'newbie@parliament.gh', roles: ['STAFF'], constituencyIds: [ids.con] });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.newbie } })).externalId).toBe('sub-newbie');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.newbie } })).lastLoginAt).not.toBeNull();
    });

    it('changes roles and scope, recording before and after', async () => {
      await patch(`/internal/users/${ids.newbie}`, { roles: ['STAFF', 'REVIEWER'], constituencyIds: [] }, 'admin').expect(200);
      expect((await get('/internal/me', 'newbie')).body.roles.sort()).toEqual(['REVIEWER', 'STAFF']);
      const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'user.access_changed', objectId: ids.newbie } });
      expect(ev.payload).toMatchObject({ rolesBefore: ['STAFF'], rolesAfter: ['STAFF', 'REVIEWER'], constituenciesBefore: [ids.con], constituenciesAfter: [] });
      await patch(`/internal/users/${ids.newbie}`, { roles: [] }, 'admin').expect(400);
      await patch(`/internal/users/${ids.newbie}`, { email: 'x@y.gh' }, 'admin').expect(400);
      await patch(`/internal/users/${randomUUID()}`, { displayName: 'Ghost' }, 'admin').expect(404);
    });

    it('protects the last administrator and the caller\'s own access', async () => {
      await patch(`/internal/users/${ids.admin}`, { roles: ['STAFF'] }, 'admin').expect(409);
      await post(`/internal/users/${ids.admin}/active`, { active: false }, 'admin').expect(409);
      await post(`/internal/users/${ids.admin2}/active`, { active: false }, 'admin').expect(200); // another admin may do it
      await post(`/internal/users/${ids.admin2}/active`, { active: true }, 'admin').expect(200);
    });

    it('deactivation takes effect immediately and releases open cases', async () => {
      const c = await prisma.citizenCase.create({ data: { publicId: 'GH-2026-700001', constituencyId: ids.con, category: 'other', title: 't', consentGivenAt: new Date(), consentPurpose: 'p', assigneeId: ids.newbie } });
      await post(`/internal/users/${ids.newbie}/active`, { active: false }, 'admin').expect(200);
      await get('/internal/me', 'newbie').expect(403);
      expect((await prisma.citizenCase.findUniqueOrThrow({ where: { id: c.id } })).assigneeId).toBeNull();
      await post(`/internal/users/${ids.newbie}/active`, { active: true }, 'admin').expect(200);
      await get('/internal/me', 'newbie').expect(200);
    });
  });

  describe('overview (T-068)', () => {
    it('is computed from the database, and scoped for non-administrators', async () => {
      await prisma.citizenCase.create({ data: { publicId: 'GH-2026-700002', constituencyId: ids.con, category: 'other', title: 't', consentGivenAt: new Date(), consentPurpose: 'p', dueAt: new Date(Date.now() - 3600_000), escalated: true } });
      const o = (await get('/internal/overview', 'admin').expect(200)).body;
      expect(o.cases).toMatchObject({ open: 2, overdue: 1, escalated: 1 });
      expect(o.billsByStage).toMatchObject({ FIRST_READING: 1, COMMITTEE: 1 });
      expect(o.upcomingSittings).toBe(1);
      expect(o.approvalsPending).toBe(0);
      expect(o.system.activeUsers).toBeGreaterThanOrEqual(5);
      // A staff user with no constituency sees no cases.
      expect((await get('/internal/overview', 'staff').expect(200)).body.cases).toMatchObject({ open: 0, overdue: 0 });
      await http().get('/api/v1/internal/overview').expect(401);
    });
  });
});
