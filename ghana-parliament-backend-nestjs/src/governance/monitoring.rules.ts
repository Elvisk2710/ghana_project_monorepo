// Pure monitoring rules (T-075): a snapshot of recent public answers in, a verdict per rule out.

export interface LanguageStats { language: string; substantive: number; noEvidence: number; unavailable: number }

export interface Snapshot {
  total: number;
  /** Questions that reached retrieval (answered, nothing found, or failed). Excludes clarification, refusals and unsupported languages. */
  substantive: number;
  grounded: number;
  noEvidence: number;
  unavailable: number;
  unsupported: number;
  /** Questions that reached generation. */
  generated: number;
  citationFailures: number;
  harmfulReports: number;
  latencyP95Ms: number | null;
  avgTopScore: number | null;
  topScoreN: number;
  byLanguage: LanguageStats[];
}

export interface RuleThresholds {
  citationFailureRate: number;
  emptyRetrievalRate: number;
  unavailableRate: number;
  harmfulReports: number;
  latencyP95Ms: number;
  noEvidenceDrift: number;
  retrievalScoreDrop: number;
  languageGap: number;
  unsupportedDemand: number;
  /** Minimum questions in a window before a rate rule may fire or be called healthy. */
  minSample: number;
}

/** Provisional. Parliament decision #12 (quality, latency, cost thresholds) sets the real values. */
export const DEFAULT_RULE_THRESHOLDS: RuleThresholds = {
  citationFailureRate: 0.02,
  emptyRetrievalRate: 0.4,
  unavailableRate: 0.05,
  harmfulReports: 1,
  latencyP95Ms: 8000,
  noEvidenceDrift: 0.15,
  retrievalScoreDrop: 0.1,
  languageGap: 0.2,
  unsupportedDemand: 0.1,
  minSample: 20,
};
export const THRESHOLD_KEYS = Object.keys(DEFAULT_RULE_THRESHOLDS) as (keyof RuleThresholds)[];

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RuleResult {
  rule: string;
  scopeKey: string;
  severity: Severity;
  metric: string;
  status: 'ok' | 'firing' | 'insufficient_data';
  value: number | null;
  threshold: number;
  sampleSize: number;
  message: string;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function evaluateRules(cur: Snapshot, prev: Snapshot, t: RuleThresholds): RuleResult[] {
  const out: RuleResult[] = [];
  const rate = (rule: string, severity: Severity, metric: string, num: number, den: number, threshold: number, label: string) => {
    if (den < t.minSample) {
      out.push({ rule, scopeKey: '', severity, metric, status: 'insufficient_data', value: null, threshold, sampleSize: den, message: `${label}: only ${den} question(s) in the window; at least ${t.minSample} are needed` });
      return;
    }
    const value = r3(num / den);
    out.push({ rule, scopeKey: '', severity, metric, status: value >= threshold ? 'firing' : 'ok', value, threshold, sampleSize: den, message: `${label} is ${pct(value)} (alert at ${pct(threshold)})` });
  };

  rate('citation_failure_rate', 'HIGH', 'citation failures / generated answers', cur.citationFailures, cur.generated, t.citationFailureRate, 'Answers with missing or invalid citations');
  rate('empty_retrieval_rate', 'MEDIUM', 'no evidence / questions searched', cur.noEvidence, cur.substantive, t.emptyRetrievalRate, 'Questions where nothing was found');
  rate('unavailable_rate', 'HIGH', 'service unavailable / questions searched', cur.unavailable, cur.substantive, t.unavailableRate, 'Questions that failed');
  rate('unsupported_language_demand', 'LOW', 'unsupported-language questions / all questions', cur.unsupported, cur.total, t.unsupportedDemand, 'Questions asked in a language we do not support yet');

  out.push({
    rule: 'harmful_reports', scopeKey: '', severity: 'HIGH', metric: 'harmful or privacy reports', status: cur.harmfulReports >= t.harmfulReports ? 'firing' : 'ok',
    value: cur.harmfulReports, threshold: t.harmfulReports, sampleSize: cur.total, message: `${cur.harmfulReports} harmful or privacy report(s) in the window (alert at ${t.harmfulReports})`,
  });

  if (cur.latencyP95Ms === null || cur.substantive < t.minSample) {
    out.push({ rule: 'latency_p95', scopeKey: '', severity: 'MEDIUM', metric: 'p95 latency (ms)', status: 'insufficient_data', value: null, threshold: t.latencyP95Ms, sampleSize: cur.substantive, message: `Latency: only ${cur.substantive} question(s) in the window; at least ${t.minSample} are needed` });
  } else {
    out.push({ rule: 'latency_p95', scopeKey: '', severity: 'MEDIUM', metric: 'p95 latency (ms)', status: cur.latencyP95Ms >= t.latencyP95Ms ? 'firing' : 'ok', value: Math.round(cur.latencyP95Ms), threshold: t.latencyP95Ms, sampleSize: cur.substantive, message: `p95 latency is ${Math.round(cur.latencyP95Ms)} ms (alert at ${t.latencyP95Ms} ms)` });
  }

  // Drift: compare with the window just before.
  if (cur.substantive < t.minSample || prev.substantive < t.minSample) {
    out.push({ rule: 'no_evidence_drift', scopeKey: '', severity: 'MEDIUM', metric: 'change in no-evidence rate vs previous window', status: 'insufficient_data', value: null, threshold: t.noEvidenceDrift, sampleSize: Math.min(cur.substantive, prev.substantive), message: 'Drift needs enough questions in both this and the previous window' });
  } else {
    const d = r3(Math.abs(cur.noEvidence / cur.substantive - prev.noEvidence / prev.substantive));
    out.push({ rule: 'no_evidence_drift', scopeKey: '', severity: 'MEDIUM', metric: 'change in no-evidence rate vs previous window', status: d >= t.noEvidenceDrift ? 'firing' : 'ok', value: d, threshold: t.noEvidenceDrift, sampleSize: Math.min(cur.substantive, prev.substantive), message: `No-evidence rate moved by ${pct(d)} since the previous window (alert at ${pct(t.noEvidenceDrift)})` });
  }
  if (cur.avgTopScore === null || prev.avgTopScore === null || cur.topScoreN < t.minSample || prev.topScoreN < t.minSample) {
    out.push({ rule: 'retrieval_score_drop', scopeKey: '', severity: 'MEDIUM', metric: 'drop in average best retrieval score', status: 'insufficient_data', value: null, threshold: t.retrievalScoreDrop, sampleSize: Math.min(cur.topScoreN, prev.topScoreN), message: 'Retrieval drift needs enough scored questions in both windows' });
  } else {
    const drop = r3(prev.avgTopScore - cur.avgTopScore);
    out.push({ rule: 'retrieval_score_drop', scopeKey: '', severity: 'MEDIUM', metric: 'drop in average best retrieval score', status: drop >= t.retrievalScoreDrop ? 'firing' : 'ok', value: drop, threshold: t.retrievalScoreDrop, sampleSize: Math.min(cur.topScoreN, prev.topScoreN), message: `Average best retrieval score fell by ${drop} (alert at ${t.retrievalScoreDrop})` });
  }

  // Bias: a supported language doing clearly worse than the overall service.
  const failures = (x: { noEvidence: number; unavailable: number }) => x.noEvidence + x.unavailable;
  const overall = cur.substantive ? failures(cur) / cur.substantive : 0;
  for (const l of cur.byLanguage) {
    if (l.substantive < t.minSample) {
      out.push({ rule: 'language_gap', scopeKey: l.language, severity: 'MEDIUM', metric: `failure rate for "${l.language}" minus overall`, status: 'insufficient_data', value: null, threshold: t.languageGap, sampleSize: l.substantive, message: `Language "${l.language}": only ${l.substantive} question(s); at least ${t.minSample} are needed` });
      continue;
    }
    const gap = r3(failures(l) / l.substantive - overall);
    out.push({ rule: 'language_gap', scopeKey: l.language, severity: 'MEDIUM', metric: `failure rate for "${l.language}" minus overall`, status: gap >= t.languageGap ? 'firing' : 'ok', value: gap, threshold: t.languageGap, sampleSize: l.substantive, message: `Language "${l.language}" fails ${pct(Math.max(gap, 0))} more often than the service overall (alert at ${pct(t.languageGap)})` });
  }
  return out;
}

export function mergeThresholds(overrides: unknown): RuleThresholds {
  const o = (overrides && typeof overrides === 'object' ? overrides : {}) as Record<string, unknown>;
  const merged = { ...DEFAULT_RULE_THRESHOLDS };
  for (const k of THRESHOLD_KEYS) if (typeof o[k] === 'number' && Number.isFinite(o[k] as number) && (o[k] as number) >= 0) merged[k] = o[k] as number;
  return merged;
}
