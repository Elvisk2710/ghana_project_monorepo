// AI governance API (Phase 5). The console only presents the signed-in user's token; every rule
// (roles, four-eyes, release gate) is enforced by the backend, so this file holds no logic.
import { call, post, query } from './api';

export type AiKind = 'MODEL' | 'PROMPT' | 'RETRIEVER' | 'DATASET';
export interface AiVersion { id: string; kind: AiKind; name: string; version: string; description: string | null; ownerId: string; ownerName: string | null; config: Record<string, unknown>; checksum: string; status: 'AVAILABLE' | 'RETIRED'; createdAt: string }
export interface VersionRef { id: string; name: string; version: string }
export interface Metrics {
  n: number; answerQuality: number | null; retrievalRecall: number | null; retrievalCases: number; citationCompleteness: number | null; groundedAnswers: number;
  refusalQuality: number | null; refusalCases: number; harmfulOutputs: number; latencyP50Ms: number | null; latencyP95Ms: number | null; inputTokens: number; outputTokens: number;
}
export interface SliceReport extends Metrics { dimension: 'language' | 'constituency' | 'tag'; value: string; underpowered: boolean }
export interface Gate { passed: boolean; failures: string[]; warnings: string[]; thresholds: Record<string, number> }
export interface EvalRun {
  id: string; status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'; total: number; completed: number; createdAt: string; completedAt: string | null; error: string | null;
  dataset: VersionRef; model: VersionRef; prompt: VersionRef; retriever: VersionRef; summary: Metrics | null; slices: SliceReport[] | null; gate: Gate | null;
}
export interface EvalResultRow { id: string; status: string; expectedStatus: string; language: string; answer: string | null; correct: boolean; case: { key: string; question: string } }
export interface Deployment {
  id: string; status: 'PENDING_APPROVAL' | 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK' | 'REJECTED'; model: VersionRef; prompt: VersionRef; retriever: VersionRef;
  ownerId: string; ownerName: string | null; requesterId: string; approvalId: string | null; rollbackTargetId: string | null; notes: string | null;
  activatedAt: string | null; endedAt: string | null; endedReason: string | null; createdAt: string;
  approval?: { decision: string; approver: { displayName: string } | null; requester: { displayName: string } | null; decidedAt: string | null } | null;
}
export interface Answering { enabled: boolean; reason: string | null; changedAt: string | null; incidentId: string | null }
export interface RuleResult { rule: string; scopeKey: string; severity: string; metric: string; status: 'ok' | 'firing' | 'insufficient_data'; value: number | null; threshold: number; sampleSize: number; message: string }
export interface Alert { id: string; rule: string; scopeKey: string; severity: string; metric: string; value: number; threshold: number; sampleSize: number; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'; firedAt: string; lastSeenAt: string; detail: { message?: string } | null }
export interface MonitorReport { at: string; windowMinutes: number; deploymentId: string | null; rules: RuleResult[]; alerts: Alert[] }
export interface Incident { id: string; title: string; description: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; status: 'OPEN' | 'MITIGATED' | 'RESOLVED'; scope: Record<string, string | string[]>; createdAt: string; resolution: string | null }
export interface IncidentDetail extends Incident {
  owner: { displayName: string } | null; affectedAnswers: number; withdrawnAnswers: number; timeline: { occurredAt: string; action: string; actorId: string | null }[];
}
export interface Affected {
  total: number; byVersion: { deploymentId: string | null; model: string | null; prompt: string | null; retriever: string | null; answers: number }[];
  items: { id: string; createdAt: string; question: string; status: string; withdrawnAt: string | null }[]; nextCursor: string | null;
}
export interface Reconstruction {
  answerId: string; asked: { question: string; language: string; at: string }; seen: { status: string; answer: string | null; failureReason: string | null };
  sources: { n: number; documentId: string; title: string; documentVersion: number | null; text: string; snapshotValid: boolean; document: { unchangedSince: boolean } | null }[];
  version: { model: string | null; prompt: string | null; retriever: string | null; deployment: 'baseline' | { id: string; status: string; approval: { decision: string; approver: { displayName: string } | null } | null } };
  withdrawn: { at: string; reason: string | null } | null; completeness: { ok: boolean; missing: string[] };
}
export interface ReconstructionTest { sampled: number; passed: number; failed: number; ok: boolean; failures: { answerId: string; missing: string[] }[] }

export const aiApi = {
  versions: (kind?: AiKind) => call<AiVersion[]>(`/ai/versions${query({ kind })}`),
  register: (d: { kind: string; name: string; version: string; description?: string; config: unknown }) => post<AiVersion>('/ai/versions', d),
  retire: (id: string, reason: string) => post<AiVersion>(`/ai/versions/${id}/retire`, { reason }),
  baseline: () => post<AiVersion[]>('/ai/registry/baseline'),
  dataset: (d: { name: string; version: string; description?: string; cases: unknown }) => post<AiVersion>('/ai/datasets', d),
  runs: () => call<EvalRun[]>('/ai/evaluations'),
  run: (id: string) => call<EvalRun>(`/ai/evaluations/${id}`),
  results: (id: string, failedOnly: boolean) => call<EvalResultRow[]>(`/ai/evaluations/${id}/results${query({ failed: failedOnly })}`),
  startRun: (d: { datasetId: string; modelId: string; promptId: string; retrieverId: string }) => post<EvalRun>('/ai/evaluations', d),
  deployments: () => call<Deployment[]>('/ai/deployments'),
  active: () => call<Deployment | null>('/ai/deployments/active').then((d) => (d && d.id ? d : null)),
  requestDeployment: (d: { modelId: string; promptId: string; retrieverId: string; evalRunId: string; notes?: string }) => post<Deployment>('/ai/deployments', d),
  rollback: (id: string, reason: string) => post<{ restored: string }>(`/ai/deployments/${id}/rollback`, { reason }),
  answering: () => call<Answering>('/ai/answering'),
  pause: (reason: string) => post<Answering>('/ai/answering/pause', { reason }),
  resume: (reason: string) => post<Answering>('/ai/answering/resume', { reason }),
  monitoring: () => call<MonitorReport>('/ai/monitoring'),
  evaluate: () => post<MonitorReport>('/ai/monitoring/evaluate', {}),
  acknowledge: (id: string) => post<Alert>(`/ai/alerts/${id}/acknowledge`),
  incidents: () => call<Incident[]>('/ai/incidents'),
  incident: (id: string) => call<IncidentDetail>(`/ai/incidents/${id}`),
  affected: (id: string) => call<Affected>(`/ai/incidents/${id}/affected`),
  openIncident: (d: { title: string; description: string; severity: string; scope?: Record<string, string>; pauseAnswering?: boolean }) => post<Incident>('/ai/incidents', d),
  setIncidentStatus: (id: string, status: 'MITIGATED' | 'RESOLVED', note: string) => post<Incident>(`/ai/incidents/${id}/status`, { status, note }),
  withdraw: (id: string, note: string) => post<{ withdrawn: number }>(`/ai/incidents/${id}/withdraw-answers`, { note }),
  reconstruct: (answerId: string) => call<Reconstruction>(`/ai/answers/${encodeURIComponent(answerId)}/reconstruction`),
  reconstructionTest: (sample: number) => post<ReconstructionTest>('/ai/reconstruction-test', { sample }),
};
