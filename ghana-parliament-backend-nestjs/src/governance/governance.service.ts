import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { AiArtifactKind, AiVersion, Approval, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { AnswersService } from '../answers/answers.service';
import { DEFAULT_SYSTEM_PROMPT, REQUIRED_PROMPT_MARKERS } from '../answers/generator';
import { LANGUAGES } from '../answers/languages';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { aggregate, DEFAULT_THRESHOLDS, evaluateGate, GateThresholds, scoreCase, ScoredRow, slice } from './eval-metrics';
import { THRESHOLD_KEYS } from './monitoring.rules';
import { ANSWERING_FLAG, configFrom, MAX_PASSAGES_LIMIT, RuntimeConfigService, versionLabel } from './runtime-config';

const JOB_EVAL = 'ai.eval';
export const DEPLOYMENT_APPROVAL = 'ai_deployment';
export const STATUSES = ['grounded', 'no_evidence', 'needs_clarification', 'conflicting_sources', 'unsupported_language', 'safety_refusal', 'service_unavailable'] as const;
const MAX_CASES = 500;

/** Prisma throws on malformed UUIDs and missing rows; both mean "no such record" to the caller. */
async function found<T>(p: Promise<T | null>, what: string): Promise<T> {
  const r = await p.catch(() => null);
  if (!r) throw new NotFoundException(`${what} not found`);
  return r;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

export function validateConfig(kind: Exclude<AiArtifactKind, 'DATASET'>, config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new BadRequestException('config must be an object');
  const c = config as Record<string, unknown>;
  if (kind === 'MODEL') {
    if (c.generator !== 'extractive' && c.generator !== 'anthropic') throw new BadRequestException('model config.generator must be "extractive" or "anthropic"');
    if (c.generator === 'anthropic' && (typeof c.modelId !== 'string' || c.modelId.length < 3 || c.modelId.length > 100)) throw new BadRequestException('an anthropic model needs config.modelId');
    return { generator: c.generator, ...(c.modelId ? { modelId: c.modelId } : {}), ...(typeof c.provider === 'string' ? { provider: c.provider.slice(0, 100) } : {}), ...(typeof c.dataResidency === 'string' ? { dataResidency: c.dataResidency.slice(0, 200) } : {}) };
  }
  if (kind === 'PROMPT') {
    if (typeof c.system !== 'string' || c.system.length < 50 || c.system.length > 4000) throw new BadRequestException('prompt config.system must be 50-4000 characters');
    const missing = REQUIRED_PROMPT_MARKERS.filter((m) => !m.marker.test(c.system as string)).map((m) => m.why);
    if (missing.length) throw new BadRequestException(`The system prompt is missing required safeguards: it ${missing.join('; it ')}`);
    return { system: c.system };
  }
  if (typeof c.minScore !== 'number' || c.minScore < 0 || c.minScore > 1) throw new BadRequestException('retriever config.minScore must be a number from 0 to 1');
  if (!Number.isInteger(c.maxPassages) || (c.maxPassages as number) < 1 || (c.maxPassages as number) > MAX_PASSAGES_LIMIT) throw new BadRequestException(`retriever config.maxPassages must be an integer from 1 to ${MAX_PASSAGES_LIMIT}`);
  return { minScore: c.minScore, maxPassages: c.maxPassages };
}

export interface DatasetCaseInput {
  key: string;
  question: string;
  language?: string;
  constituency?: string;
  tags?: string[];
  expectedStatus?: string;
  expectedDocumentIds?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
}

export function validateCases(cases: unknown): Required<Omit<DatasetCaseInput, 'constituency'>>[] & { constituency?: string }[] {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > MAX_CASES) throw new BadRequestException(`a dataset needs 1 to ${MAX_CASES} cases`);
  const keys = new Set<string>();
  const langs = new Set(LANGUAGES.map((l) => l.code));
  const strs = (v: unknown, name: string, n: number, max = 200): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > max)) throw new BadRequestException(`case ${n}: ${name} must be a list of up to 20 short strings`);
    return v.map((x: string) => x.trim());
  };
  return cases.map((c: any, i) => {
    const n = i + 1;
    if (!c || typeof c.key !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(c.key)) throw new BadRequestException(`case ${n}: key must be 1-60 letters, digits, dot, dash or underscore`);
    if (keys.has(c.key)) throw new BadRequestException(`case ${n}: duplicate key "${c.key}"`);
    keys.add(c.key);
    if (typeof c.question !== 'string' || !c.question.trim() || c.question.length > 500) throw new BadRequestException(`case ${n}: question must be 1-500 characters`);
    const language = c.language ?? 'en';
    if (!langs.has(language)) throw new BadRequestException(`case ${n}: unknown language "${language}"`);
    const expectedStatus = c.expectedStatus ?? 'grounded';
    if (!(STATUSES as readonly string[]).includes(expectedStatus)) throw new BadRequestException(`case ${n}: expectedStatus must be one of ${STATUSES.join(', ')}`);
    if (c.constituency !== undefined && (typeof c.constituency !== 'string' || !c.constituency.trim() || c.constituency.length > 100)) throw new BadRequestException(`case ${n}: constituency must be a short string`);
    return {
      key: c.key, question: c.question.trim(), language, expectedStatus,
      ...(c.constituency ? { constituency: c.constituency.trim() } : {}),
      tags: strs(c.tags, 'tags', n, 50), expectedDocumentIds: strs(c.expectedDocumentIds, 'expectedDocumentIds', n, 60),
      mustContain: strs(c.mustContain, 'mustContain', n), mustNotContain: strs(c.mustNotContain, 'mustNotContain', n),
    };
  }) as any;
}

export function mergeGateThresholds(o: unknown): GateThresholds {
  const merged: GateThresholds = { ...DEFAULT_THRESHOLDS };
  if (o === undefined || o === null) return merged;
  if (typeof o !== 'object' || Array.isArray(o)) throw new BadRequestException('thresholds must be an object');
  for (const [k, v] of Object.entries(o)) {
    if (!(k in DEFAULT_THRESHOLDS)) throw new BadRequestException(`Unknown threshold "${k}"`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BadRequestException(`Threshold "${k}" must be a non-negative number`);
    (merged as any)[k] = v;
  }
  return merged;
}

@Injectable()
export class GovernanceService implements OnModuleInit {
  private readonly logger = new Logger(GovernanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly answers: AnswersService,
    private readonly runtime: RuntimeConfigService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(JOB_EVAL, (p, job) => this.executeRun(p.runId, job.attempts >= job.maxAttempts));
  }

  // ---------------------------------------------------------------- Registry (T-073)

  listVersions(q: { kind?: AiArtifactKind; includeRetired?: boolean }) {
    return this.prisma.aiVersion.findMany({
      where: { kind: q.kind, status: q.includeRetired ? undefined : 'AVAILABLE' },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }, { createdAt: 'desc' }],
      take: 300,
    }).then((rows) => this.withOwners(rows));
  }

  private async withOwners<T extends { ownerId: string }>(rows: T[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } }, select: { id: true, displayName: true } });
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    return rows.map((r) => ({ ...r, ownerName: name.get(r.ownerId) ?? null }));
  }

  private async resolveOwner(p: Principal, ownerId?: string): Promise<string> {
    if (!ownerId || ownerId === p.userId) return p.userId;
    const u = await this.prisma.user.findFirst({ where: { id: ownerId, active: true, externalId: { not: { startsWith: 'pending:' } } } }).catch(() => null);
    if (!u) throw new BadRequestException('The named owner is not an active user');
    return u.id;
  }

  async registerVersion(p: Principal, d: { kind: Exclude<AiArtifactKind, 'DATASET'>; name: string; version: string; description?: string; config: unknown; ownerId?: string }) {
    const config = validateConfig(d.kind, d.config);
    const ownerId = await this.resolveOwner(p, d.ownerId);
    try {
      const row = await this.prisma.aiVersion.create({
        data: { kind: d.kind, name: d.name, version: d.version, description: d.description, ownerId, config: config as Prisma.InputJsonValue, checksum: sha256(canonical({ kind: d.kind, name: d.name, version: d.version, config })) },
      });
      await this.audit.record({ action: 'ai.version.register', objectType: 'ai_version', objectId: row.id, payload: { kind: d.kind, label: versionLabel(row), checksum: row.checksum, ownerId } });
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`${d.kind.toLowerCase()} ${d.name}@${d.version} is already registered. Versions never change: register a new version instead.`);
      throw e;
    }
  }

  /** Registers the built-in behaviour (extractive answers, default prompt and retrieval) so it can be evaluated and compared. Idempotent. */
  async registerBaseline(p: Principal) {
    const specs = [
      { kind: 'MODEL' as const, name: 'extractive', version: 'v1', description: 'No model: quotes the most relevant published passages.', config: { generator: 'extractive' } },
      { kind: 'PROMPT' as const, name: 'grounded', version: 'v1', description: 'Default grounded-answer system prompt.', config: { system: DEFAULT_SYSTEM_PROMPT } },
      { kind: 'RETRIEVER' as const, name: 'hybrid', version: 'v1', description: 'Hybrid vector and keyword retrieval, default thresholds.', config: { minScore: 0.15, maxPassages: 5 } },
    ];
    const out = [];
    for (const s of specs) {
      const existing = await this.prisma.aiVersion.findUnique({ where: { kind_name_version: { kind: s.kind, name: s.name, version: s.version } } });
      out.push(existing ?? (await this.registerVersion(p, s)));
    }
    return out;
  }

  async registerDataset(p: Principal, d: { name: string; version: string; description?: string; cases: unknown; ownerId?: string }) {
    const cases = validateCases(d.cases) as any[];
    const ownerId = await this.resolveOwner(p, d.ownerId);
    const config = { caseCount: cases.length, casesSha256: sha256(canonical(cases)) };
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const v = await tx.aiVersion.create({
          data: { kind: 'DATASET', name: d.name, version: d.version, description: d.description, ownerId, config, checksum: sha256(canonical({ name: d.name, version: d.version, config })) },
        });
        await tx.evalCase.createMany({ data: cases.map((c) => ({ ...c, datasetId: v.id })) });
        return v;
      });
      await this.audit.record({ action: 'ai.dataset.register', objectType: 'ai_version', objectId: row.id, payload: { label: versionLabel(row), ...config } });
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`dataset ${d.name}@${d.version} is already registered. Datasets never change: register a new version instead.`);
      throw e;
    }
  }

  async getDataset(id: string) {
    const v = await found(this.prisma.aiVersion.findFirst({ where: { id, kind: 'DATASET' }, include: { cases: { orderBy: { key: 'asc' } } } }), 'Dataset');
    return v;
  }

  async retireVersion(p: Principal, id: string, reason: string) {
    const v = await found(this.prisma.aiVersion.findUnique({ where: { id } }), 'Version');
    if (v.status === 'RETIRED') throw new ConflictException('Already retired');
    const inUse = await this.prisma.aiDeployment.findFirst({
      where: { status: { in: ['ACTIVE', 'PENDING_APPROVAL'] }, OR: [{ modelId: id }, { promptId: id }, { retrieverId: id }] },
    });
    if (inUse) throw new ConflictException('This version is part of a live or pending deployment. Roll back or reject that deployment first.');
    const row = await this.prisma.aiVersion.update({ where: { id }, data: { status: 'RETIRED', retiredAt: new Date(), retiredReason: reason } });
    await this.audit.record({ action: 'ai.version.retire', objectType: 'ai_version', objectId: id, payload: { label: versionLabel(v), reason } });
    return row;
  }

  // ---------------------------------------------------------------- Evaluation harness (T-072)

  async createRun(p: Principal, d: { datasetId: string; modelId: string; promptId: string; retrieverId: string; thresholds?: unknown }) {
    const thresholds = mergeGateThresholds(d.thresholds);
    const [dataset, model, prompt, retriever] = await Promise.all([
      found(this.prisma.aiVersion.findFirst({ where: { id: d.datasetId, kind: 'DATASET' } }), 'Dataset'),
      found(this.prisma.aiVersion.findFirst({ where: { id: d.modelId, kind: 'MODEL' } }), 'Model version'),
      found(this.prisma.aiVersion.findFirst({ where: { id: d.promptId, kind: 'PROMPT' } }), 'Prompt version'),
      found(this.prisma.aiVersion.findFirst({ where: { id: d.retrieverId, kind: 'RETRIEVER' } }), 'Retriever version'),
    ]);
    const retired = [dataset, model, prompt, retriever].filter((v) => v.status === 'RETIRED');
    if (retired.length) throw new ConflictException(`Retired version(s) cannot be evaluated: ${retired.map(versionLabel).join(', ')}`);
    const total = await this.prisma.evalCase.count({ where: { datasetId: dataset.id } });
    const run = await this.prisma.evalRun.create({
      data: { datasetId: dataset.id, modelId: model.id, promptId: prompt.id, retrieverId: retriever.id, total, startedById: p.userId, thresholds: thresholds as unknown as Prisma.InputJsonValue },
    });
    await this.jobs.enqueue(JOB_EVAL, { runId: run.id }, { dedupeKey: `${JOB_EVAL}:${run.id}` });
    await this.audit.record({ action: 'ai.eval.create', objectType: 'ai_eval_run', objectId: run.id, payload: { dataset: versionLabel(dataset), model: versionLabel(model), prompt: versionLabel(prompt), retriever: versionLabel(retriever), cases: total, thresholds } });
    return run;
  }

  /** Runs every case through the public pipeline with the candidate configuration. Resumable: finished cases are skipped. */
  async executeRun(runId: string, final = false): Promise<void> {
    const run = await this.prisma.evalRun.findUnique({ where: { id: runId }, include: { model: true, prompt: true, retriever: true } });
    if (!run || run.status === 'COMPLETED' || run.status === 'FAILED') return;
    try {
      if (run.status === 'QUEUED') await this.prisma.evalRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });
      const config = configFrom(run.model, run.prompt, run.retriever, null);
      const cases = await this.prisma.evalCase.findMany({ where: { datasetId: run.datasetId }, orderBy: { key: 'asc' } });
      const done = new Set((await this.prisma.evalResult.findMany({ where: { runId }, select: { caseId: true } })).map((r) => r.caseId));
      for (const c of cases) {
        if (done.has(c.id)) continue;
        const o = await this.answers.evaluate({ question: c.question, language: c.language }, config);
        const observed = {
          status: o.status, answer: o.answer, citedDocumentIds: [...new Set(o.citations.map((x) => x.documentId))],
          retrievedDocumentIds: [...new Set(o.retrieved.map((h) => h.documentId))], latencyMs: o.latencyMs,
        };
        const s = scoreCase(c, observed);
        await this.prisma.evalResult.create({
          data: {
            runId, caseId: c.id, language: c.language, constituency: c.constituency, tags: c.tags, expectedStatus: c.expectedStatus, status: o.status,
            correct: s.correct, statusMatch: s.statusMatch, retrievalHit: s.retrievalHit, citationOk: s.citationOk, contentOk: s.contentOk, harmful: s.harmful,
            answer: o.answer, citedDocumentIds: observed.citedDocumentIds, retrievedDocumentIds: observed.retrievedDocumentIds, latencyMs: o.latencyMs,
            inputTokens: o.usage?.inputTokens, outputTokens: o.usage?.outputTokens,
          },
        });
        await this.prisma.evalRun.update({ where: { id: runId }, data: { completed: { increment: 1 } } });
      }
      const rows = await this.prisma.evalResult.findMany({ where: { runId } });
      const scored: ScoredRow[] = rows.map((r) => ({ ...r, retrievalHit: r.retrievalHit, citationOk: r.citationOk }));
      const thresholds = run.thresholds as unknown as GateThresholds;
      const summary = aggregate(scored);
      const slices = slice(scored, thresholds.minSliceCases);
      const gate = evaluateGate(summary, slices, thresholds);
      await this.prisma.evalRun.update({
        where: { id: runId },
        data: { status: 'COMPLETED', completedAt: new Date(), summary: summary as any, slices: slices as any, gate: gate as any },
      });
      await this.audit.recordSafe({ action: 'ai.eval.complete', objectType: 'ai_eval_run', objectId: runId, payload: { passed: gate.passed, failures: gate.failures.length, cases: rows.length } });
    } catch (e) {
      this.logger.error(`Evaluation ${runId} failed: ${(e as Error).message}`);
      if (final) await this.prisma.evalRun.update({ where: { id: runId }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 1000), completedAt: new Date() } }).catch(() => undefined);
      throw e;
    }
  }

  listRuns() {
    return this.prisma.evalRun.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: this.runInclude() });
  }

  private runInclude() {
    const pick = { select: { id: true, name: true, version: true } };
    return { dataset: pick, model: pick, prompt: pick, retriever: pick } as const;
  }

  async getRun(id: string) {
    return found(this.prisma.evalRun.findUnique({ where: { id }, include: this.runInclude() }), 'Evaluation');
  }

  async runResults(id: string, q: { failedOnly?: boolean; language?: string; limit?: number }) {
    await this.getRun(id);
    return this.prisma.evalResult.findMany({
      where: { runId: id, correct: q.failedOnly ? false : undefined, language: q.language },
      include: { case: { select: { key: true, question: true, expectedDocumentIds: true } } },
      orderBy: { createdAt: 'asc' },
      take: Math.min(q.limit ?? 200, 500),
    });
  }

  // ---------------------------------------------------------------- Deployments and approval (T-074)

  private depInclude() {
    const pick = { select: { id: true, name: true, version: true, kind: true } };
    return { model: pick, prompt: pick, retriever: pick, evalRun: { select: { id: true, summary: true, gate: true, completedAt: true, startedById: true } } } as const;
  }

  async listDeployments() {
    const rows = await this.prisma.aiDeployment.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: this.depInclude() });
    return this.withOwners(rows);
  }

  async getDeployment(id: string) {
    const d = await found(this.prisma.aiDeployment.findUnique({ where: { id }, include: this.depInclude() }), 'Deployment');
    const approval = d.approvalId ? await this.prisma.approval.findUnique({ where: { id: d.approvalId }, include: { requester: { select: { id: true, displayName: true } }, approver: { select: { id: true, displayName: true } } } }) : null;
    return { ...(await this.withOwners([d]))[0], approval };
  }

  /** The live deployment, or null when the built-in baseline is serving. */
  async active() {
    const a = await this.prisma.aiDeployment.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } });
    return a ? this.getDeployment(a.id) : null;
  }

  async requestDeployment(p: Principal, d: { modelId: string; promptId: string; retrieverId: string; evalRunId: string; ownerId?: string; thresholds?: unknown; notes?: string }) {
    const run = await found(this.prisma.evalRun.findUnique({ where: { id: d.evalRunId } }), 'Evaluation');
    if (run.status !== 'COMPLETED') throw new ConflictException('The evaluation has not finished');
    if (run.modelId !== d.modelId || run.promptId !== d.promptId || run.retrieverId !== d.retrieverId) {
      throw new BadRequestException('That evaluation was run on a different model, prompt or retriever. Evaluate the exact combination you want to deploy.');
    }
    const gate = run.gate as unknown as { passed: boolean; failures: string[] };
    if (!gate?.passed) throw new ConflictException({ message: 'The evaluation did not pass the release gate, so this combination cannot be put forward for approval.', failures: gate?.failures ?? [] });
    const versions = await this.prisma.aiVersion.findMany({ where: { id: { in: [d.modelId, d.promptId, d.retrieverId] } } });
    const retired = versions.filter((v) => v.status === 'RETIRED');
    if (retired.length) throw new ConflictException(`Retired version(s) cannot be deployed: ${retired.map(versionLabel).join(', ')}`);
    if (await this.prisma.aiDeployment.findFirst({ where: { evalRunId: run.id, status: { in: ['PENDING_APPROVAL', 'ACTIVE'] } } })) throw new ConflictException('This evaluation already backs a pending or live deployment');
    const ownerId = await this.resolveOwner(p, d.ownerId);
    const monitoring = this.validateMonitoring(d.thresholds);
    const label = versions.map(versionLabel);

    const dep = await this.prisma.$transaction(async (tx) => {
      const dep = await tx.aiDeployment.create({
        data: { modelId: d.modelId, promptId: d.promptId, retrieverId: d.retrieverId, evalRunId: run.id, requesterId: p.userId, ownerId, thresholds: monitoring as Prisma.InputJsonValue, notes: d.notes },
      });
      const approval = await tx.approval.create({
        data: {
          objectType: DEPLOYMENT_APPROVAL, objectId: dep.id, objectVersion: run.id, action: 'deploy', requesterId: p.userId, reason: d.notes,
          objectLabel: `AI deployment: ${label.join(' + ')}`,
          evidence: { evalRunId: run.id, summary: run.summary, gate: run.gate, slices: run.slices, releaseThresholds: run.thresholds, monitoringThresholds: monitoring } as unknown as Prisma.InputJsonValue,
        },
      });
      return tx.aiDeployment.update({ where: { id: dep.id }, data: { approvalId: approval.id } });
    });
    await this.audit.record({ action: 'ai.deployment.request', objectType: 'ai_deployment', objectId: dep.id, payload: { evalRunId: run.id, versions: label, ownerId, approvalId: dep.approvalId } });
    return dep;
  }

  private validateMonitoring(o: unknown): Record<string, number> {
    if (o === undefined || o === null) return {};
    if (typeof o !== 'object' || Array.isArray(o)) throw new BadRequestException('monitoring thresholds must be an object');
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!(THRESHOLD_KEYS as string[]).includes(k)) throw new BadRequestException(`Unknown monitoring threshold "${k}"`);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BadRequestException(`Monitoring threshold "${k}" must be a non-negative number`);
      out[k] = v;
    }
    return out;
  }

  /**
   * Applies an approval decision for an AI deployment. Called from the shared approvals endpoint after
   * it has checked the approval is pending, the decider is not the requester, and notes are present.
   */
  async decideDeployment(p: Principal, a: Approval, decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED', notes: string | undefined, reviewedEvidence: boolean | undefined) {
    const dep = await found(this.prisma.aiDeployment.findUnique({ where: { id: a.objectId }, include: { evalRun: true } }), 'Deployment');
    if (dep.status !== 'PENDING_APPROVAL') throw new ConflictException('This deployment is no longer waiting for approval');
    if (decision === 'APPROVED') {
      if (reviewedEvidence !== true) throw new BadRequestException('Confirm that you reviewed the evaluation evidence, including the failure cases and the language and constituency slices (reviewedEvidence: true).');
      if (dep.evalRun.startedById === p.userId) throw new ForbiddenException('You ran this evaluation, so you cannot approve the deployment it supports');
      if (dep.ownerId === p.userId) throw new ForbiddenException('The deployment owner cannot approve their own deployment');
      const versions = await this.prisma.aiVersion.findMany({ where: { id: { in: [dep.modelId, dep.promptId, dep.retrieverId] } } });
      if (versions.some((v) => v.status === 'RETIRED')) throw new ConflictException('A version in this deployment has been retired since it was requested');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.approval.updateMany({
        where: { id: a.id, decision: 'PENDING' },
        data: { decision, approverId: p.userId, decidedAt: new Date(), evidence: { ...(a.evidence as object), notes: notes ?? null, reviewedEvidence: decision === 'APPROVED' ? true : undefined } as Prisma.InputJsonValue },
      });
      if (claimed.count === 0) throw new ConflictException('This approval has already been decided');
      if (decision !== 'APPROVED') {
        await tx.aiDeployment.update({ where: { id: dep.id }, data: { status: 'REJECTED', endedAt: new Date(), endedReason: notes } });
        return { activated: false, supersededId: null as string | null };
      }
      const current = await tx.aiDeployment.findFirst({ where: { status: 'ACTIVE' } });
      if (current) await tx.aiDeployment.update({ where: { id: current.id }, data: { status: 'SUPERSEDED', endedAt: new Date(), endedReason: `Superseded by ${dep.id}` } });
      await tx.aiDeployment.update({ where: { id: dep.id }, data: { status: 'ACTIVE', activatedAt: new Date(), rollbackTargetId: current?.id ?? null } });
      return { activated: true, supersededId: current?.id ?? null };
    });
    await this.audit.record({
      action: result.activated ? 'ai.deployment.activate' : 'ai.deployment.reject', objectType: 'ai_deployment', objectId: dep.id,
      payload: { decision, approvalId: a.id, supersededId: result.supersededId, rollbackTargetId: result.supersededId, notes: notes ?? null },
    });
    return this.prisma.approval.findUniqueOrThrow({ where: { id: a.id } });
  }

  /** Returns to the previous deployment (or the built-in baseline). Immediate; needs no second approver because speed matters. */
  async rollback(p: Principal, id: string, reason: string) {
    const dep = await found(this.prisma.aiDeployment.findUnique({ where: { id } }), 'Deployment');
    if (dep.status !== 'ACTIVE') throw new ConflictException('Only the live deployment can be rolled back');
    let target = null as null | { id: string };
    if (dep.rollbackTargetId) {
      const t = await found(this.prisma.aiDeployment.findUnique({ where: { id: dep.rollbackTargetId } }), 'Rollback target');
      const vs = await this.prisma.aiVersion.findMany({ where: { id: { in: [t.modelId, t.promptId, t.retrieverId] } } });
      if (vs.some((v) => v.status === 'RETIRED')) throw new ConflictException('The rollback target uses a retired version. Roll back to the baseline by retiring or rejecting instead, or register new versions.');
      target = t;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.aiDeployment.update({ where: { id }, data: { status: 'ROLLED_BACK', endedAt: new Date(), endedReason: reason } });
      if (target) await tx.aiDeployment.update({ where: { id: target.id }, data: { status: 'ACTIVE', endedAt: null, endedReason: null } });
    });
    await this.audit.record({ action: 'ai.deployment.rollback', objectType: 'ai_deployment', objectId: id, payload: { reason, restoredDeploymentId: target?.id ?? null, restoredBaseline: !target } });
    return { rolledBack: id, restored: target?.id ?? 'baseline' };
  }

  // ---------------------------------------------------------------- Kill switch (T-076)

  answeringState() {
    return this.runtime.answering();
  }

  private async setAnswering(p: Principal, enabled: boolean, reason: string, incidentId?: string) {
    if (!reason?.trim()) throw new BadRequestException('A reason is required');
    const value = { enabled, reason: reason.trim(), incidentId: incidentId ?? null } as Prisma.InputJsonValue;
    await this.prisma.systemFlag.upsert({ where: { key: ANSWERING_FLAG }, create: { key: ANSWERING_FLAG, value, updatedById: p.userId }, update: { value, updatedById: p.userId } });
    await this.audit.record({ action: enabled ? 'ai.answering.resume' : 'ai.answering.pause', objectType: 'ai_control', objectId: ANSWERING_FLAG, payload: { reason: reason.trim(), incidentId: incidentId ?? null } });
    return this.runtime.answering();
  }

  async pause(p: Principal, reason: string, incidentId?: string) {
    return this.setAnswering(p, false, reason, incidentId);
  }

  async resume(p: Principal, reason: string, incidentId?: string) {
    const critical = await this.prisma.aiIncident.count({ where: { severity: 'CRITICAL', status: 'OPEN' } });
    if (critical) throw new ConflictException(`${critical} critical incident(s) are still open. Mitigate or resolve them before resuming public answers.`);
    return this.setAnswering(p, true, reason, incidentId);
  }
}
