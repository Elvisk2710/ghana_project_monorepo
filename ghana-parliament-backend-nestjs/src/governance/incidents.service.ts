import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IncidentSeverity, IncidentStatus, Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { StaffAlertService } from '../cases/staff-alerts';
import { PrismaService } from '../prisma/prisma.service';
import { GovernanceService } from './governance.service';

export interface IncidentScope {
  deploymentId?: string;
  modelVersion?: string;
  promptVersion?: string;
  retrieverVersion?: string;
  /** Public document ID (e.g. HAN-1000): every answer that cited it. */
  documentId?: string;
  from?: string;
  to?: string;
  answerIds?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_ROLES: Role[] = [Role.RESEARCHER, Role.REVIEWER, Role.ADMIN];
const CONTENT = ['GROUNDED', 'CONFLICTING_SOURCES'] as const;

export function validateScope(s: unknown): IncidentScope {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new BadRequestException('scope must be an object');
  const o = s as Record<string, unknown>;
  const allowed = ['deploymentId', 'modelVersion', 'promptVersion', 'retrieverVersion', 'documentId', 'from', 'to', 'answerIds'];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new BadRequestException(`Unknown scope field "${k}"`);
  const out: IncidentScope = {};
  const str = (k: keyof IncidentScope, max = 200) => {
    if (o[k] === undefined) return;
    if (typeof o[k] !== 'string' || !(o[k] as string).trim() || (o[k] as string).length > max) throw new BadRequestException(`scope.${k} must be a short string`);
    (out as any)[k] = (o[k] as string).trim();
  };
  str('modelVersion'); str('promptVersion'); str('retrieverVersion'); str('documentId', 60);
  if (o.deploymentId !== undefined) {
    if (typeof o.deploymentId !== 'string' || !UUID.test(o.deploymentId)) throw new BadRequestException('scope.deploymentId must be a deployment ID');
    out.deploymentId = o.deploymentId;
  }
  for (const k of ['from', 'to'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'string' || Number.isNaN(Date.parse(o[k] as string))) throw new BadRequestException(`scope.${k} must be a date-time`);
    out[k] = new Date(o[k] as string).toISOString();
  }
  if (o.answerIds !== undefined) {
    if (!Array.isArray(o.answerIds) || o.answerIds.length > 500 || o.answerIds.some((x) => typeof x !== 'string' || !UUID.test(x))) throw new BadRequestException('scope.answerIds must be up to 500 answer IDs');
    out.answerIds = o.answerIds as string[];
  }
  const criteria = Object.keys(out).filter((k) => k !== 'from' && k !== 'to' && k !== 'answerIds');
  if (!criteria.length && !out.answerIds?.length) throw new BadRequestException('Say which answers are affected: a deployment, a model/prompt/retriever version, a document, or specific answer IDs. A date range alone is too broad.');
  return out;
}

/** The set of public answers an incident covers: criteria are AND-ed, explicit IDs are added. */
export function affectedWhere(scope: IncidentScope): Prisma.QuestionSessionWhereInput {
  const and: Prisma.QuestionSessionWhereInput[] = [{ status: { in: [...CONTENT] } }];
  if (scope.deploymentId) and.push({ deploymentId: scope.deploymentId });
  if (scope.modelVersion) and.push({ modelVersion: scope.modelVersion });
  if (scope.promptVersion) and.push({ promptVersion: scope.promptVersion });
  if (scope.retrieverVersion) and.push({ retrieverVersion: { startsWith: scope.retrieverVersion } });
  if (scope.documentId) and.push({ citations: { array_contains: [{ documentId: scope.documentId }] } });
  if (scope.from || scope.to) and.push({ createdAt: { gte: scope.from ? new Date(scope.from) : undefined, lte: scope.to ? new Date(scope.to) : undefined } });
  const hasCriteria = !!(scope.deploymentId || scope.modelVersion || scope.promptVersion || scope.retrieverVersion || scope.documentId);
  const byCriteria: Prisma.QuestionSessionWhereInput | null = hasCriteria ? { AND: and } : null;
  const byIds: Prisma.QuestionSessionWhereInput | null = scope.answerIds?.length ? { id: { in: scope.answerIds } } : null;
  return { OR: [byCriteria, byIds].filter((x): x is Prisma.QuestionSessionWhereInput => !!x) };
}

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly governance: GovernanceService,
    private readonly staffAlerts: StaffAlertService,
  ) {}

  async create(p: Principal, d: { title: string; description: string; severity: IncidentSeverity; scope?: unknown; alertId?: string; ownerId?: string; pauseAnswering?: boolean }) {
    let scope: IncidentScope;
    if (d.scope === undefined) {
      const live = await this.prisma.aiDeployment.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } });
      if (!live) throw new BadRequestException('No approved deployment is live, so there is no default scope. Say which answers are affected.');
      scope = { deploymentId: live.id };
    } else scope = validateScope(d.scope);
    if (scope.deploymentId) await this.prisma.aiDeployment.findUniqueOrThrow({ where: { id: scope.deploymentId } }).catch(() => { throw new BadRequestException('scope.deploymentId is not a known deployment'); });
    const ownerId = d.ownerId ?? p.userId;
    const owner = await this.prisma.user.findFirst({ where: { id: ownerId, active: true, roles: { hasSome: OWNER_ROLES } } }).catch(() => null);
    if (!owner) throw new BadRequestException('The incident owner must be an active researcher, reviewer or administrator');
    if (d.alertId) await this.prisma.monitorAlert.findUniqueOrThrow({ where: { id: d.alertId } }).catch(() => { throw new BadRequestException('alertId is not a known alert'); });
    if (d.pauseAnswering && !p.roles.some((r) => r === Role.REVIEWER || r === Role.ADMIN)) throw new ForbiddenException('Only a reviewer or administrator can pause public answers');

    const inc = await this.prisma.aiIncident.create({
      data: { title: d.title, description: d.description, severity: d.severity, ownerId, reporterId: p.userId, scope: scope as unknown as Prisma.InputJsonValue, alertId: d.alertId },
    });
    await this.audit.record({ action: 'ai.incident.open', objectType: 'ai_incident', objectId: inc.id, payload: { title: d.title, severity: d.severity, scope, ownerId, alertId: d.alertId ?? null } });
    if (d.pauseAnswering) await this.governance.pause(p, `Incident: ${d.title}`, inc.id);
    await this.staffAlerts.notify({ kind: 'users', userIds: [ownerId] }, `AI incident assigned to you (${d.severity})`, '/mlops', `An AI incident has been opened and you are the owner. Severity: ${d.severity}.`, `incident-owner:${inc.id}`);
    await this.staffAlerts.notify({ kind: 'admins' }, `AI incident opened (${d.severity})`, '/mlops', `An AI incident has been opened. Severity: ${d.severity}. Public answering ${d.pauseAnswering ? 'has been paused' : 'has not been paused'}.`, `incident:${inc.id}`);
    return { ...inc, affectedAnswers: await this.prisma.questionSession.count({ where: affectedWhere(scope) }) };
  }

  list(status?: string) {
    const s = status && (Object.values(IncidentStatus) as string[]).includes(status) ? (status as IncidentStatus) : undefined;
    return this.prisma.aiIncident.findMany({ where: { status: s }, orderBy: [{ createdAt: 'desc' }], take: 100 });
  }

  private async load(id: string) {
    const inc = await this.prisma.aiIncident.findUnique({ where: { id } }).catch(() => null);
    if (!inc) throw new NotFoundException('Incident not found');
    return inc;
  }

  async get(id: string) {
    const inc = await this.load(id);
    const scope = inc.scope as unknown as IncidentScope;
    const [affected, withdrawn, timeline, owner] = await Promise.all([
      this.prisma.questionSession.count({ where: affectedWhere(scope) }),
      this.prisma.questionSession.count({ where: { incidentId: id, withdrawnAt: { not: null } } }),
      this.prisma.auditEvent.findMany({ where: { OR: [{ objectType: 'ai_incident', objectId: id }, { payload: { path: ['incidentId'], equals: id } }] }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true, action: true, actorId: true, payload: true } }),
      this.prisma.user.findUnique({ where: { id: inc.ownerId }, select: { id: true, displayName: true } }),
    ]);
    return { ...inc, owner, affectedAnswers: affected, withdrawnAnswers: withdrawn, timeline };
  }

  /** The answers an incident covers, with a breakdown by version so remediation can be targeted. */
  async affected(id: string, q: { limit?: number; cursor?: string }) {
    const inc = await this.load(id);
    const where = affectedWhere(inc.scope as unknown as IncidentScope);
    const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const [items, byVersion, total] = await Promise.all([
      this.prisma.questionSession.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        select: { id: true, createdAt: true, question: true, language: true, status: true, modelVersion: true, promptVersion: true, retrieverVersion: true, deploymentId: true, withdrawnAt: true, citations: true },
      }),
      this.prisma.questionSession.groupBy({ by: ['deploymentId', 'modelVersion', 'promptVersion', 'retrieverVersion'], where, _count: { _all: true } }),
      this.prisma.questionSession.count({ where }),
    ]);
    const more = items.length > take;
    const page = more ? items.slice(0, take) : items;
    return {
      total,
      byVersion: byVersion.map((g) => ({ deploymentId: g.deploymentId, model: g.modelVersion, prompt: g.promptVersion, retriever: g.retrieverVersion, answers: g._count._all })),
      items: page,
      nextCursor: more ? page[page.length - 1].id : null,
    };
  }

  async setStatus(p: Principal, id: string, status: 'MITIGATED' | 'RESOLVED', note: string) {
    const inc = await this.load(id);
    if (inc.status === 'RESOLVED') throw new ConflictException('This incident is already resolved');
    if (status === 'MITIGATED' && inc.status !== 'OPEN') throw new ConflictException('Only an open incident can be marked mitigated');
    if (!note?.trim()) throw new BadRequestException('Say what was done');
    const now = new Date();
    const row = await this.prisma.aiIncident.update({
      where: { id },
      data: status === 'MITIGATED' ? { status, mitigatedAt: now } : { status, resolvedAt: now, resolution: note.trim(), mitigatedAt: inc.mitigatedAt ?? now },
    });
    await this.audit.record({ action: `ai.incident.${status.toLowerCase()}`, objectType: 'ai_incident', objectId: id, payload: { note: note.trim() } });
    return row;
  }

  /** Stops affected answers from being shown at their shared links. The stored record is kept. */
  async withdrawAnswers(p: Principal, id: string, note: string) {
    const inc = await this.load(id);
    if (!note?.trim()) throw new BadRequestException('Say why these answers are being withdrawn');
    const where: Prisma.QuestionSessionWhereInput = { AND: [affectedWhere(inc.scope as unknown as IncidentScope), { withdrawnAt: null }] };
    const res = await this.prisma.questionSession.updateMany({ where, data: { withdrawnAt: new Date(), withdrawnReason: note.trim().slice(0, 500), incidentId: id } });
    await this.audit.record({ action: 'ai.incident.withdraw_answers', objectType: 'ai_incident', objectId: id, payload: { withdrawn: res.count, note: note.trim() } });
    return { withdrawn: res.count };
  }
}
