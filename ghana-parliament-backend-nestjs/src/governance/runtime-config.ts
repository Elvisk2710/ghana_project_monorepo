import { Injectable } from '@nestjs/common';
import { AiDeployment, AiVersion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { GeneratorSettings } from '../answers/generator';

/** What actually serves a public answer: the approved deployment, or the built-in baseline. */
export interface RuntimeConfig {
  /** Null while no approved deployment is live (built-in baseline). */
  deploymentId: string | null;
  /** "baseline" is the generator bound at start-up (extractive unless overridden in tests). */
  generator: 'baseline' | 'extractive' | 'anthropic';
  settings: GeneratorSettings;
  retriever: { minScore: number; maxPassages: number; label: string | null };
}

export interface AnsweringState {
  enabled: boolean;
  reason: string | null;
  changedById: string | null;
  changedAt: string | null;
  incidentId: string | null;
}

export const ANSWERING_FLAG = 'ai.answering';
export const MAX_PASSAGES_LIMIT = 8;

export const baselineConfig = (): RuntimeConfig => ({
  deploymentId: null,
  generator: 'baseline',
  settings: {},
  retriever: { minScore: Number(process.env.ANSWER_MIN_SCORE ?? 0.15), maxPassages: 5, label: null },
});

export const versionLabel = (v: Pick<AiVersion, 'name' | 'version'>) => `${v.name}@${v.version}`;

type DeploymentWithVersions = AiDeployment & { model: AiVersion; prompt: AiVersion; retriever: AiVersion };

/** Turns a deployment (or a candidate triple under evaluation) into the settings the pipeline uses. */
export function configFrom(model: AiVersion, prompt: AiVersion, retriever: AiVersion, deploymentId: string | null): RuntimeConfig {
  const m = model.config as { generator?: string; modelId?: string };
  const p = prompt.config as { system?: string };
  const r = retriever.config as { minScore?: number; maxPassages?: number };
  return {
    deploymentId,
    generator: m.generator === 'anthropic' ? 'anthropic' : 'extractive',
    settings: { modelId: m.modelId, system: p.system, promptVersion: versionLabel(prompt) },
    retriever: {
      minScore: typeof r.minScore === 'number' ? r.minScore : 0.15,
      maxPassages: Math.min(Math.max(Math.trunc(r.maxPassages ?? 5), 1), MAX_PASSAGES_LIMIT),
      label: versionLabel(retriever),
    },
  };
}

/**
 * Reads the live AI configuration on every request. There is deliberately no cache: a rollback or
 * the kill switch must take effect on the very next question, on every API instance.
 */
@Injectable()
export class RuntimeConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async answering(): Promise<AnsweringState> {
    const row = await this.prisma.systemFlag.findUnique({ where: { key: ANSWERING_FLAG } });
    const v = (row?.value ?? {}) as Partial<{ enabled: boolean; reason: string; incidentId: string }>;
    return {
      enabled: v.enabled !== false,
      reason: v.reason ?? null,
      changedById: row?.updatedById ?? null,
      changedAt: row?.updatedAt.toISOString() ?? null,
      incidentId: v.incidentId ?? null,
    };
  }

  async activeDeployment(): Promise<DeploymentWithVersions | null> {
    return this.prisma.aiDeployment.findFirst({ where: { status: 'ACTIVE' }, include: { model: true, prompt: true, retriever: true } });
  }

  async current(): Promise<{ state: AnsweringState; config: RuntimeConfig }> {
    const [state, dep] = await Promise.all([this.answering(), this.activeDeployment()]);
    return { state, config: dep ? configFrom(dep.model, dep.prompt, dep.retriever, dep.id) : baselineConfig() };
  }
}
