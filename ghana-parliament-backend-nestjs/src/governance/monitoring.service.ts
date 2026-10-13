import { ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { MetricsService } from '../metrics/metrics';
import { StaffAlertService } from '../cases/staff-alerts';
import { PrismaService } from '../prisma/prisma.service';
import { evaluateRules, mergeThresholds, RuleResult, Snapshot } from './monitoring.rules';

const SUBSTANTIVE = Prisma.sql`'GROUNDED','CONFLICTING_SOURCES','NO_EVIDENCE','SERVICE_UNAVAILABLE'`;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export interface MonitorReport {
  at: string;
  windowMinutes: number;
  deploymentId: string | null;
  current: Snapshot;
  previous: Snapshot;
  rules: RuleResult[];
}

/**
 * Bias and quality monitoring over real public answers (T-075). Reads QuestionSession, scoped to the
 * live deployment, and keeps one open alert per rule and scope.
 */
@Injectable()
export class MonitoringService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MonitoringService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly staffAlerts: StaffAlertService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.JOBS_ENABLED === 'false') return;
    this.timer = setInterval(() => {
      this.evaluate().catch((e) => this.logger.error(`Monitoring run failed: ${(e as Error).message}`));
    }, Number(process.env.MONITOR_INTERVAL_MS ?? 300_000));
    this.timer.unref();
    // Publish gauges soon after start so "no data" in the monitoring stack means the task is not running.
    setTimeout(() => this.refreshGauges().catch(() => undefined), 5000).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async snapshot(from: Date, to: Date, deploymentId: string | null): Promise<Snapshot> {
    const scope = Prisma.sql`"deploymentId" IS NOT DISTINCT FROM ${deploymentId}::uuid`;
    const [row] = await this.prisma.$queryRaw<any[]>`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status IN (${SUBSTANTIVE}))::int AS substantive,
        count(*) FILTER (WHERE status IN ('GROUNDED','CONFLICTING_SOURCES'))::int AS grounded,
        count(*) FILTER (WHERE status = 'NO_EVIDENCE')::int AS "noEvidence",
        count(*) FILTER (WHERE status = 'SERVICE_UNAVAILABLE')::int AS unavailable,
        count(*) FILTER (WHERE status = 'UNSUPPORTED_LANGUAGE')::int AS unsupported,
        count(*) FILTER (WHERE status IN ('GROUNDED','CONFLICTING_SOURCES') OR "failureReason" IN ('citation_invalid','generation_error'))::int AS generated,
        count(*) FILTER (WHERE "failureReason" IN ('citation_invalid','generation_error','fallback_extractive'))::int AS "citationFailures",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") FILTER (WHERE "latencyMs" IS NOT NULL AND status IN (${SUBSTANTIVE})) AS "latencyP95",
        avg("topScore") FILTER (WHERE "topScore" IS NOT NULL) AS "avgTop",
        count("topScore")::int AS "topN"
      FROM "QuestionSession" WHERE ("createdAt" AT TIME ZONE 'UTC') >= ${from} AND ("createdAt" AT TIME ZONE 'UTC') < ${to} AND ${scope}`;
    const langs = await this.prisma.$queryRaw<any[]>`
      SELECT language,
        count(*) FILTER (WHERE status IN (${SUBSTANTIVE}))::int AS substantive,
        count(*) FILTER (WHERE status = 'NO_EVIDENCE')::int AS "noEvidence",
        count(*) FILTER (WHERE status = 'SERVICE_UNAVAILABLE')::int AS unavailable
      FROM "QuestionSession" WHERE ("createdAt" AT TIME ZONE 'UTC') >= ${from} AND ("createdAt" AT TIME ZONE 'UTC') < ${to} AND ${scope}
      GROUP BY language HAVING count(*) FILTER (WHERE status IN (${SUBSTANTIVE})) > 0 ORDER BY language`;
    // Reports are dated by when they were made, not when the answer was asked.
    const [rep] = await this.prisma.$queryRaw<any[]>`
      SELECT count(*)::int AS c FROM "QuestionSession" s, jsonb_array_elements(COALESCE(s.feedback, '[]'::jsonb)) f
      WHERE f->>'reportType' IN ('harmful','privacy') AND (f->>'at')::timestamptz >= ${from} AND (f->>'at')::timestamptz < ${to} AND s."deploymentId" IS NOT DISTINCT FROM ${deploymentId}::uuid`;
    return {
      total: n(row.total), substantive: n(row.substantive), grounded: n(row.grounded), noEvidence: n(row.noEvidence), unavailable: n(row.unavailable), unsupported: n(row.unsupported),
      generated: n(row.generated), citationFailures: n(row.citationFailures), harmfulReports: n(rep?.c),
      latencyP95Ms: row.latencyP95 === null ? null : Number(row.latencyP95), avgTopScore: row.avgTop === null ? null : Number(row.avgTop), topScoreN: n(row.topN),
      byLanguage: langs.map((l) => ({ language: l.language, substantive: n(l.substantive), noEvidence: n(l.noEvidence), unavailable: n(l.unavailable) })),
    };
  }

  /** Computes every rule for the live deployment over the last window. Does not write anything. */
  async report(windowMinutes = Number(process.env.MONITOR_WINDOW_MINUTES ?? 60)): Promise<MonitorReport> {
    const live = await this.prisma.aiDeployment.findFirst({ where: { status: 'ACTIVE' }, select: { id: true, thresholds: true } });
    const deploymentId = live?.id ?? null;
    const now = new Date();
    const mid = new Date(now.getTime() - windowMinutes * 60_000);
    const start = new Date(mid.getTime() - windowMinutes * 60_000);
    const [current, previous] = await Promise.all([this.snapshot(mid, new Date(now.getTime() + 1000), deploymentId), this.snapshot(start, mid, deploymentId)]);
    return { at: now.toISOString(), windowMinutes, deploymentId, current, previous, rules: evaluateRules(current, previous, mergeThresholds(live?.thresholds)) };
  }

  /** Evaluates the rules, opens or refreshes an alert for each firing rule, and resolves those that recovered. */
  async evaluate(windowMinutes?: number): Promise<MonitorReport & { opened: number; resolved: number }> {
    const report = await this.report(windowMinutes);
    let opened = 0;
    let resolved = 0;
    const dep = report.deploymentId;
    for (const r of report.rules) {
      const where = { rule: r.rule, scopeKey: r.scopeKey, deploymentId: dep, status: { not: 'RESOLVED' as const } };
      const existing = await this.prisma.monitorAlert.findFirst({ where });
      if (r.status === 'firing') {
        const data = { value: r.value ?? 0, threshold: r.threshold, sampleSize: r.sampleSize, lastSeenAt: new Date(), detail: { message: r.message } as Prisma.InputJsonValue };
        if (existing) { await this.prisma.monitorAlert.update({ where: { id: existing.id }, data }); continue; }
        try {
          const a = await this.prisma.monitorAlert.create({ data: { ...data, rule: r.rule, scopeKey: r.scopeKey, severity: r.severity, deploymentId: dep, metric: r.metric } });
          opened++;
          await this.staffAlerts.notify({ kind: 'admins' }, `AI alert (${r.severity}): ${r.rule}`, '/mlops', `The monitoring rule "${r.rule}" is firing (${r.severity}). ${r.message}`, `alert:${a.id}`);
          await this.audit.recordSafe({ action: 'ai.alert.open', objectType: 'ai_alert', objectId: a.id, payload: { rule: r.rule, scopeKey: r.scopeKey, severity: r.severity, value: r.value, threshold: r.threshold, deploymentId: dep } });
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e; // another instance opened it first
        }
      } else if (existing && r.status === 'ok') {
        await this.prisma.monitorAlert.update({ where: { id: existing.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
        resolved++;
        await this.audit.recordSafe({ action: 'ai.alert.resolve', objectType: 'ai_alert', objectId: existing.id, payload: { rule: r.rule, reason: 'recovered' } });
      }
    }
    // Alerts about a deployment that is no longer live describe a past configuration.
    const notLive: Prisma.MonitorAlertWhereInput = dep ? { OR: [{ deploymentId: null }, { deploymentId: { not: dep } }] } : { deploymentId: { not: null } };
    const stale = await this.prisma.monitorAlert.updateMany({ where: { status: { not: 'RESOLVED' }, ...notLive }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    resolved += stale.count;
    await this.refreshGauges();
    return { ...report, opened, resolved };
  }

  /** Publishes current state for Prometheus: open alerts, the kill switch, and operational backlogs. */
  async refreshGauges(): Promise<void> {
    const [alerts, flag, dead, failed, overdue] = await Promise.all([
      this.prisma.monitorAlert.groupBy({ by: ['rule', 'severity'], where: { status: { not: 'RESOLVED' } }, _count: { _all: true } }),
      this.prisma.systemFlag.findUnique({ where: { key: 'ai.answering' } }),
      this.prisma.job.count({ where: { status: 'DEAD' } }),
      this.prisma.notification.count({ where: { state: 'FAILED' } }),
      this.prisma.citizenCase.count({ where: { anonymizedAt: null, status: { notIn: ['RESOLVED', 'CLOSED'] }, dueAt: { lt: new Date() }, firstResponseAt: null } }),
    ]);
    this.metrics.clearGauge('ai_alerts_open');
    for (const a of alerts) this.metrics.setGauge('ai_alerts_open', a._count._all, { rule: a.rule, severity: a.severity });
    this.metrics.setGauge('ai_answering_enabled', (flag?.value as { enabled?: boolean } | undefined)?.enabled === false ? 0 : 1);
    this.metrics.setGauge('ops_dead_jobs', dead);
    this.metrics.setGauge('ops_failed_notifications', failed);
    this.metrics.setGauge('ops_overdue_cases', overdue);
  }

  listAlerts(status?: string) {
    const s = status && ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(status) ? (status as 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED') : undefined;
    return this.prisma.monitorAlert.findMany({ where: { status: s ?? { not: 'RESOLVED' } }, orderBy: [{ firedAt: 'desc' }], take: 200 });
  }

  async acknowledge(p: Principal, id: string) {
    const a = await this.prisma.monitorAlert.findUnique({ where: { id } }).catch(() => null);
    if (!a) throw new NotFoundException('Alert not found');
    if (a.status !== 'OPEN') throw new ConflictException('Only an open alert can be acknowledged');
    const row = await this.prisma.monitorAlert.update({ where: { id }, data: { status: 'ACKNOWLEDGED', acknowledgedById: p.userId } });
    await this.audit.record({ action: 'ai.alert.acknowledge', objectType: 'ai_alert', objectId: id, payload: { rule: a.rule } });
    return row;
  }
}
