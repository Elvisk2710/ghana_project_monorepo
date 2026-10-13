import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalDecision, BillStage, Prisma, Role, SittingStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { DEPLOYMENT_APPROVAL, GovernanceService } from '../governance/governance.service';
import { PrismaService } from '../prisma/prisma.service';

/** Objects whose public visibility is controlled by an approval (four-eyes) rather than a flag edit. */
export const GATED = ['sitting', 'bill', 'committee', 'mp'] as const;
export type GatedType = (typeof GATED)[number];

const notFound = (what: string) => new NotFoundException(`${what} not found`);

/** Prisma throws on malformed UUIDs and missing rows; both mean "no such record" to the caller. */
async function found<T>(p: Promise<T | null>, what: string): Promise<T> {
  const r = await p.catch(() => null);
  if (!r) throw notFound(what);
  return r;
}

export interface AgendaItem { title: string; billId?: string }

export function validateAgenda(a: unknown): AgendaItem[] {
  if (a === undefined || a === null) return [];
  if (!Array.isArray(a) || a.length > 100) throw new BadRequestException('agenda must be a list of at most 100 items');
  return a.map((i, n) => {
    if (!i || typeof i.title !== 'string' || !i.title.trim() || i.title.length > 300) throw new BadRequestException(`agenda item ${n + 1} needs a title`);
    if (i.billId !== undefined && typeof i.billId !== 'string') throw new BadRequestException(`agenda item ${n + 1} has an invalid billId`);
    return { title: i.title.trim(), ...(i.billId ? { billId: i.billId } : {}) };
  });
}

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly governance: GovernanceService,
  ) {}

  // ---------------- Sittings

  listSittings(q: { status?: SittingStatus; from?: Date; to?: Date }) {
    return this.prisma.sitting.findMany({
      where: { status: q.status, date: q.from || q.to ? { gte: q.from, lte: q.to } : undefined },
      include: { _count: { select: { documents: true, bills: true } } },
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      take: 200,
    });
  }

  getSitting(id: string) {
    return found(this.prisma.sitting.findUnique({ where: { id }, include: { documents: { select: { id: true, publicId: true, title: true, lifecycle: true } }, bills: { include: { bill: { select: { id: true, title: true, stage: true } } } } } }), 'Sitting');
  }

  async saveSitting(id: string | null, d: { date?: Date; type?: string; status?: SittingStatus; agenda?: unknown }) {
    const agenda = d.agenda === undefined ? undefined : (validateAgenda(d.agenda) as unknown as Prisma.InputJsonValue);
    if (agenda) await this.assertBillsExist((agenda as unknown as AgendaItem[]).map((a) => a.billId).filter((x): x is string => !!x));
    if (id === null) {
      if (!d.date || !d.type) throw new BadRequestException('date and type are required');
      return this.prisma.sitting.create({ data: { date: d.date, type: d.type, status: d.status, agenda } });
    }
    await found(this.prisma.sitting.findUnique({ where: { id } }), 'Sitting');
    return this.prisma.sitting.update({ where: { id }, data: { date: d.date, type: d.type, status: d.status, agenda } });
  }

  private async assertBillsExist(ids: string[]) {
    if (!ids.length) return;
    const n = await this.prisma.bill.count({ where: { id: { in: ids } } }).catch(() => -1);
    if (n !== new Set(ids).size) throw new BadRequestException('One or more bills in the agenda do not exist');
  }

  // ---------------- Bills

  listBills(q: { stage?: BillStage; search?: string }) {
    return this.prisma.bill.findMany({
      where: { stage: q.stage, ...(q.search ? { title: { contains: q.search, mode: 'insensitive' } } : {}) },
      include: { committee: { select: { id: true, name: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 200,
    });
  }

  getBill(id: string) {
    return found(this.prisma.bill.findUnique({ where: { id }, include: { committee: true, sittings: { include: { sitting: true } }, documents: { select: { id: true, publicId: true, title: true, lifecycle: true } } } }), 'Bill');
  }

  async saveBill(id: string | null, d: { title?: string; sponsor?: string | null; stage?: BillStage; committeeId?: string | null; introducedOn?: Date | null; summary?: string | null; sittingIds?: string[] }) {
    if (d.committeeId) await found(this.prisma.committee.findUnique({ where: { id: d.committeeId } }), 'Committee');
    if (d.sittingIds?.length) {
      const n = await this.prisma.sitting.count({ where: { id: { in: d.sittingIds } } });
      if (n !== new Set(d.sittingIds).size) throw new BadRequestException('One or more sittings do not exist');
    }
    const { sittingIds, ...data } = d;
    const links = sittingIds ? { deleteMany: {}, create: [...new Set(sittingIds)].map((sittingId) => ({ sittingId })) } : undefined;
    if (id === null) {
      if (!d.title) throw new BadRequestException('title is required');
      return this.prisma.bill.create({ data: { ...data, title: d.title, sittings: links && { create: links.create } } });
    }
    await found(this.prisma.bill.findUnique({ where: { id } }), 'Bill');
    return this.prisma.bill.update({ where: { id }, data: { ...data, sittings: links } });
  }

  // ---------------- Committees

  listCommittees() {
    return this.prisma.committee.findMany({ include: { chair: { select: { id: true, officialName: true } }, _count: { select: { members: true, bills: true } } }, orderBy: { name: 'asc' } });
  }

  getCommittee(id: string) {
    return found(this.prisma.committee.findUnique({ where: { id }, include: { chair: { select: { id: true, officialName: true } }, members: { include: { mp: { select: { id: true, officialName: true, party: true } } } }, bills: { select: { id: true, title: true, stage: true } } } }), 'Committee');
  }

  async saveCommittee(id: string | null, d: { name?: string; remit?: string | null; chairMpId?: string | null; members?: { mpId: string; role?: string }[] }) {
    if (d.chairMpId) await found(this.prisma.mp.findUnique({ where: { id: d.chairMpId } }), 'Chair MP');
    if (d.members) {
      const ids = new Set(d.members.map((m) => m.mpId));
      if (ids.size !== d.members.length) throw new BadRequestException('A member is listed twice');
      if ((await this.prisma.mp.count({ where: { id: { in: [...ids] } } })) !== ids.size) throw new BadRequestException('One or more members are not MPs in the directory');
    }
    const members = d.members ? { deleteMany: {}, create: d.members.map((m) => ({ mpId: m.mpId, role: m.role ?? 'Member' })) } : undefined;
    try {
      if (id === null) {
        if (!d.name) throw new BadRequestException('name is required');
        return await this.prisma.committee.create({ data: { name: d.name, remit: d.remit, chairMpId: d.chairMpId, members: members && { create: members.create } } });
      }
      await found(this.prisma.committee.findUnique({ where: { id } }), 'Committee');
      return await this.prisma.committee.update({ where: { id }, data: { name: d.name, remit: d.remit, chairMpId: d.chairMpId, members } });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('A committee with that name already exists');
      throw e;
    }
  }

  // ---------------- Approvals (publication gate)

  private delegate(type: GatedType) {
    return { sitting: this.prisma.sitting, bill: this.prisma.bill, committee: this.prisma.committee, mp: this.prisma.mp }[type] as unknown as {
      findUnique(a: unknown): Promise<any>;
      update(a: unknown): Promise<any>;
    };
  }

  private label(type: GatedType, o: any): string {
    return type === 'sitting' ? `${o.type} ${o.date.toISOString().slice(0, 10)}` : type === 'bill' ? o.title : type === 'committee' ? o.name : o.officialName;
  }

  async requestApproval(p: Principal, input: { objectType: GatedType; objectId: string; action: 'publish' | 'unpublish'; reason?: string }) {
    const obj = await found(this.delegate(input.objectType).findUnique({ where: { id: input.objectId } }), 'Record');
    if (input.action === 'publish' && obj.isPublished) throw new ConflictException('Already published');
    if (input.action === 'unpublish' && !obj.isPublished) throw new ConflictException('Not published');
    if (input.action === 'unpublish' && !input.reason?.trim()) throw new BadRequestException('A reason is required to withdraw a record from the public');
    const pending = await this.prisma.approval.findFirst({ where: { objectType: input.objectType, objectId: input.objectId, decision: 'PENDING' } });
    if (pending) throw new ConflictException('A decision is already pending for this record');
    return this.prisma.approval.create({
      data: { objectType: input.objectType, objectId: input.objectId, objectVersion: String(obj.updatedAt.getTime()), action: input.action, objectLabel: this.label(input.objectType, obj), reason: input.reason, requesterId: p.userId },
    });
  }

  listApprovals(q: { decision?: ApprovalDecision; objectType?: string; objectId?: string }) {
    return this.prisma.approval.findMany({
      where: q,
      include: { requester: { select: { id: true, displayName: true } }, approver: { select: { id: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 200,
    });
  }

  /**
   * Decides a pending approval. The decider must hold REVIEWER or ADMIN, must not be the requester,
   * and the decision is only effective if the record is unchanged since it was requested.
   */
  async decide(p: Principal, id: string, decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED', notes?: string, reviewedEvidence?: boolean) {
    const a = await found(this.prisma.approval.findUnique({ where: { id } }), 'Approval');
    if (a.decision !== 'PENDING') throw new ConflictException('This approval has already been decided');
    if (a.requesterId === p.userId) throw new ForbiddenException('You cannot decide a request you made yourself');
    if (decision !== 'APPROVED' && !notes?.trim()) throw new BadRequestException('Explain why when you do not approve');
    // AI deployments are approved on evaluation evidence, not on a record edit time; governance applies them.
    if (a.objectType === DEPLOYMENT_APPROVAL) return this.governance.decideDeployment(p, a, decision, notes, reviewedEvidence);
    const type = a.objectType as GatedType;
    const obj = await found(this.delegate(type).findUnique({ where: { id: a.objectId } }), 'Record');
    if (decision === 'APPROVED' && String(obj.updatedAt.getTime()) !== a.objectVersion) {
      throw new ConflictException('The record was edited after approval was requested. Ask for approval again.');
    }
    const claimed = await this.prisma.approval.updateMany({ where: { id, decision: 'PENDING' }, data: { decision, approverId: p.userId, decidedAt: new Date(), evidence: notes ? { notes } : undefined } });
    if (claimed.count === 0) throw new ConflictException('This approval has already been decided');
    if (decision === 'APPROVED') {
      await this.delegate(type).update({ where: { id: a.objectId }, data: { isPublished: a.action === 'publish' } });
    }
    return this.prisma.approval.findUniqueOrThrow({ where: { id } });
  }

  // ---------------- Users and roles (T-066)

  listUsers() {
    return this.prisma.user.findMany({
      select: { id: true, email: true, displayName: true, roles: true, active: true, lastLoginAt: true, createdAt: true, externalId: true, constituencies: { select: { constituencyId: true, constituency: { select: { name: true } } } } },
      orderBy: { displayName: 'asc' },
    }).then((us) => us.map(({ externalId, ...u }) => ({ ...u, invited: externalId.startsWith('pending:') })));
  }

  async invite(d: { email: string; displayName: string; roles: Role[]; constituencyIds?: string[] }) {
    const email = d.email.trim().toLowerCase();
    if (!d.roles.length) throw new BadRequestException('Choose at least one role');
    if (d.roles.includes(Role.PUBLIC)) throw new BadRequestException('PUBLIC is not a staff role');
    try {
      return await this.prisma.user.create({
        data: { email, displayName: d.displayName, roles: d.roles, externalId: `pending:${randomUUID()}`, constituencies: { create: [...new Set(d.constituencyIds ?? [])].map((constituencyId) => ({ constituencyId })) } },
        select: { id: true, email: true, displayName: true, roles: true, active: true },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('A user with that email already exists');
      if (e?.code === 'P2003') throw new BadRequestException('Unknown constituency');
      throw e;
    }
  }

  private async otherActiveAdmins(exceptId: string) {
    return this.prisma.user.count({ where: { id: { not: exceptId }, active: true, roles: { has: Role.ADMIN } } });
  }

  async updateUser(p: Principal, id: string, d: { displayName?: string; roles?: Role[]; constituencyIds?: string[] }) {
    const u = await found(this.prisma.user.findUnique({ where: { id }, include: { constituencies: true } }), 'User');
    if (d.roles) {
      if (!d.roles.length || d.roles.includes(Role.PUBLIC)) throw new BadRequestException('Choose at least one staff role');
      if (u.roles.includes(Role.ADMIN) && !d.roles.includes(Role.ADMIN) && (u.id === p.userId || (await this.otherActiveAdmins(u.id)) === 0)) {
        throw new ConflictException('There must always be at least one active administrator, and you cannot remove your own administrator role');
      }
    }
    const scope = d.constituencyIds ? { deleteMany: {}, create: [...new Set(d.constituencyIds)].map((constituencyId) => ({ constituencyId })) } : undefined;
    try {
      const updated = await this.prisma.user.update({ where: { id }, data: { displayName: d.displayName, roles: d.roles, constituencies: scope }, select: { id: true, email: true, displayName: true, roles: true, active: true } });
      await this.audit.record({ action: 'user.access_changed', objectType: 'user', objectId: id, payload: { rolesBefore: u.roles, rolesAfter: updated.roles, constituenciesBefore: u.constituencies.map((c) => c.constituencyId), constituenciesAfter: d.constituencyIds } });
      return updated;
    } catch (e: any) {
      if (e?.code === 'P2003') throw new BadRequestException('Unknown constituency');
      throw e;
    }
  }

  async setActive(p: Principal, id: string, active: boolean) {
    const u = await found(this.prisma.user.findUnique({ where: { id } }), 'User');
    if (!active && u.roles.includes(Role.ADMIN) && (u.id === p.userId || (await this.otherActiveAdmins(u.id)) === 0)) {
      throw new ConflictException('You cannot deactivate yourself or the last active administrator');
    }
    // Unassign open work so a deactivated person does not silently hold cases.
    if (!active) await this.prisma.citizenCase.updateMany({ where: { assigneeId: id, status: { notIn: ['RESOLVED', 'CLOSED'] } }, data: { assigneeId: null } });
    return this.prisma.user.update({ where: { id }, data: { active }, select: { id: true, email: true, displayName: true, roles: true, active: true } });
  }

  // ---------------- Overview (T-068)

  async overview(p: Principal) {
    const week = new Date(Date.now() - 7 * 86_400_000);
    const isAdmin = p.roles.includes(Role.ADMIN);
    const caseScope: Prisma.CitizenCaseWhereInput = isAdmin ? {} : { constituencyId: { in: p.constituencyIds } };
    const open: Prisma.CitizenCaseWhereInput = { ...caseScope, anonymizedAt: null, status: { notIn: ['RESOLVED', 'CLOSED'] } };
    const [docs, chunks, questions, grounded, pendingApprovals, upcoming, bills, openCases, overdue, escalated, failedNotifications, deadJobs, activeUsers] = await Promise.all([
      this.prisma.parliamentaryDocument.groupBy({ by: ['lifecycle'], _count: { _all: true } }),
      this.prisma.documentChunk.count({ where: { document: { isPublished: true } } }),
      this.prisma.questionSession.count({ where: { createdAt: { gte: week } } }),
      this.prisma.questionSession.count({ where: { createdAt: { gte: week }, status: 'GROUNDED' } }),
      this.prisma.approval.count({ where: { decision: 'PENDING' } }),
      this.prisma.sitting.count({ where: { date: { gte: new Date(new Date().toISOString().slice(0, 10)) }, status: 'SCHEDULED' } }),
      this.prisma.bill.groupBy({ by: ['stage'], _count: { _all: true } }),
      this.prisma.citizenCase.count({ where: open }),
      this.prisma.citizenCase.count({ where: { ...open, dueAt: { lt: new Date() }, firstResponseAt: null } }),
      this.prisma.citizenCase.count({ where: { ...open, escalated: true } }),
      this.prisma.notification.count({ where: { state: 'FAILED', case: caseScope } }),
      this.prisma.job.count({ where: { status: 'DEAD' } }),
      this.prisma.user.count({ where: { active: true, externalId: { not: { startsWith: 'pending:' } } } }),
    ]);
    const by = (rows: { _count: { _all: number } }[], key: string) => Object.fromEntries((rows as any[]).map((r) => [r[key], r._count._all]));
    return {
      generatedAt: new Date(),
      documents: by(docs, 'lifecycle'),
      publishedChunks: chunks,
      answers: { last7Days: questions, grounded, groundedShare: questions ? Math.round((grounded / questions) * 100) : null },
      approvalsPending: pendingApprovals,
      upcomingSittings: upcoming,
      billsByStage: by(bills, 'stage'),
      cases: { open: openCases, overdue, escalated, failedNotifications },
      system: { deadJobs, activeUsers },
    };
  }
}
