import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { LANGUAGES } from '../answers/languages';
import { RuntimeConfigService } from '../governance/runtime-config';
import { PrismaService } from '../prisma/prisma.service';

export const CASE_SETTINGS_FLAG = 'settings.cases';

/** Case handling settings an administrator may change at run time. Parliament decides the values (Decisions #3, #10). */
export interface CaseSettings {
  /** Days a closed case is kept before its personal data is erased. */
  retentionDays: number;
  /** Hours until a normal case needs a first response. */
  slaHours: number;
  /** Hours until an urgent (escalated) case needs a first response. */
  slaUrgentHours: number;
}

export const CASE_LIMITS = {
  retentionDays: { min: 1, max: 3650 },
  slaHours: { min: 1, max: 2160 },
  slaUrgentHours: { min: 1, max: 2160 },
} as const;

type Source = 'database' | 'environment' | 'default';

const DEFAULTS: CaseSettings = { retentionDays: 730, slaHours: 120, slaUrgentHours: 24 };
const ENV_KEYS: Record<keyof CaseSettings, string> = { retentionDays: 'CASE_RETENTION_DAYS', slaHours: 'CASE_SLA_HOURS', slaUrgentHours: 'CASE_SLA_URGENT_HOURS' };

/** Values from the environment, falling back to the provisional defaults. */
export function environmentCaseSettings(env: NodeJS.ProcessEnv = process.env): { values: CaseSettings; sources: Record<keyof CaseSettings, Source> } {
  const values = { ...DEFAULTS };
  const sources = { retentionDays: 'default', slaHours: 'default', slaUrgentHours: 'default' } as Record<keyof CaseSettings, Source>;
  for (const k of Object.keys(DEFAULTS) as (keyof CaseSettings)[]) {
    const raw = env[ENV_KEYS[k]];
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${ENV_KEYS[k]} must be a positive number`);
    values[k] = n;
    sources[k] = 'environment';
  }
  return { values, sources };
}

/** Validates a full set of case settings; throws a 400 naming the first problem. */
export function validateCaseSettings(input: unknown): CaseSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Settings must be an object');
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in CASE_LIMITS)) throw new BadRequestException(`Unknown setting "${k}"`);
  const out = {} as CaseSettings;
  for (const k of Object.keys(CASE_LIMITS) as (keyof CaseSettings)[]) {
    const v = o[k];
    const { min, max } = CASE_LIMITS[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BadRequestException(`${k} must be a whole number between ${min} and ${max}`);
    out[k] = v;
  }
  if (out.slaUrgentHours > out.slaHours) throw new BadRequestException('slaUrgentHours cannot be longer than slaHours');
  return out;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly runtime: RuntimeConfigService,
  ) {}

  /** Read on every use (no cache) so a change applies on every API instance straight away. */
  async cases(): Promise<{ values: CaseSettings; sources: Record<keyof CaseSettings, Source>; updatedAt: string | null; updatedById: string | null }> {
    const env = environmentCaseSettings();
    const row = await this.prisma.systemFlag.findUnique({ where: { key: CASE_SETTINGS_FLAG } });
    const stored = (row?.value ?? {}) as Partial<CaseSettings>;
    const values = { ...env.values };
    const sources = { ...env.sources };
    for (const k of Object.keys(CASE_LIMITS) as (keyof CaseSettings)[]) {
      const v = stored[k];
      if (typeof v === 'number' && v >= CASE_LIMITS[k].min && v <= CASE_LIMITS[k].max) {
        values[k] = v;
        sources[k] = 'database';
      }
    }
    return { values, sources, updatedAt: row?.updatedAt.toISOString() ?? null, updatedById: row?.updatedById ?? null };
  }

  async updateCases(p: Principal, input: unknown) {
    const next = validateCaseSettings(input);
    const before = (await this.cases()).values;
    await this.prisma.systemFlag.upsert({
      where: { key: CASE_SETTINGS_FLAG },
      create: { key: CASE_SETTINGS_FLAG, value: next as unknown as Prisma.InputJsonValue, updatedById: p.userId },
      update: { value: next as unknown as Prisma.InputJsonValue, updatedById: p.userId },
    });
    await this.audit.record({ action: 'settings.cases.update', objectType: 'settings', objectId: CASE_SETTINGS_FLAG, payload: { before, after: next } });
    return this.overview();
  }

  /** Everything an administrator needs to see, and what can be changed where. */
  async overview() {
    const [cases, current] = await Promise.all([this.cases(), this.runtime.current()]);
    const provider = process.env.NOTIFICATION_PROVIDER ?? null;
    return {
      cases: { ...cases, limits: CASE_LIMITS, editable: true },
      answering: {
        enabled: current.state.enabled,
        reason: current.state.reason,
        editable: false,
        changeVia: 'AI governance: pause or resume public answers',
      },
      retrieval: {
        deploymentId: current.config.deploymentId,
        generator: current.config.generator,
        minScore: current.config.retriever.minScore,
        maxPassages: current.config.retriever.maxPassages,
        retrieverVersion: current.config.retriever.label,
        editable: false,
        changeVia: 'AI governance: evaluate, approve and deploy a new retriever or model version',
      },
      languages: { items: LANGUAGES, editable: false, changeVia: 'A language becomes supported only after evaluation evidence exists (code change)' },
      notifications: {
        provider,
        configured: provider === 'log' || provider === 'webhook' || provider === 'smtp',
        staffAlerts: process.env.STAFF_ALERTS !== 'false',
        editable: false,
        changeVia: 'Server environment (NOTIFICATION_PROVIDER and provider credentials)',
      },
      attachments: { scanner: process.env.CLAMD_HOST ? 'clamd' : 'built-in checks only', editable: false, changeVia: 'Server environment (CLAMD_HOST, CLAMD_PORT)' },
    };
  }
}
