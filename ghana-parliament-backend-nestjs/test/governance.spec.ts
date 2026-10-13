import { excerpt } from '../src/answers/generator';
import { aggregate, DEFAULT_THRESHOLDS, evaluateGate, percentile, scoreCase, ScoredRow, slice } from '../src/governance/eval-metrics';
import { validateCases, validateConfig, mergeGateThresholds } from '../src/governance/governance.service';
import { affectedWhere, validateScope } from '../src/governance/incidents.service';
import { DEFAULT_RULE_THRESHOLDS, evaluateRules, mergeThresholds, Snapshot } from '../src/governance/monitoring.rules';
import { DEFAULT_SYSTEM_PROMPT } from '../src/answers/generator';

const spec = { expectedStatus: 'grounded', expectedDocumentIds: ['HAN-1'], mustContain: [], mustNotContain: [] };
const seen = (o: Partial<Parameters<typeof scoreCase>[1]> = {}) => ({ status: 'grounded', answer: 'Fuel rose [1].', citedDocumentIds: ['HAN-1'], retrievedDocumentIds: ['HAN-1'], latencyMs: 100, ...o });

describe('scoreCase', () => {
  it('scores a correct, cited answer as correct', () => {
    expect(scoreCase(spec, seen())).toMatchObject({ correct: true, statusMatch: true, retrievalHit: true, citationOk: true, harmful: false });
  });
  it('fails a grounded answer that has no [n] markers or cites the wrong source', () => {
    expect(scoreCase(spec, seen({ answer: 'Fuel rose.' })).citationOk).toBe(false);
    expect(scoreCase(spec, seen({ citedDocumentIds: ['HAN-2'] })).citationOk).toBe(false);
    expect(scoreCase(spec, seen({ citedDocumentIds: [] })).correct).toBe(false);
  });
  it('treats conflicting_sources as grounded and credits a correct refusal', () => {
    expect(scoreCase(spec, seen({ status: 'conflicting_sources' })).statusMatch).toBe(true);
    const refusal = { ...spec, expectedStatus: 'no_evidence', expectedDocumentIds: [] };
    expect(scoreCase(refusal, seen({ status: 'no_evidence', answer: undefined, citedDocumentIds: [] }))).toMatchObject({ correct: true, citationOk: null, retrievalHit: null });
    expect(scoreCase(refusal, seen()).correct).toBe(false); // answered something that should not be answered
  });
  it('requires expected content and flags forbidden content as harmful', () => {
    expect(scoreCase({ ...spec, mustContain: ['formula'] }, seen()).correct).toBe(false);
    expect(scoreCase({ ...spec, mustContain: ['FUEL'] }, seen()).correct).toBe(true);
    const h = scoreCase({ ...spec, mustNotContain: ['rose'] }, seen());
    expect(h).toMatchObject({ harmful: true, correct: false });
  });
  it('scores retrieval separately from the answer', () => {
    expect(scoreCase(spec, seen({ retrievedDocumentIds: ['HAN-9'], citedDocumentIds: ['HAN-9'] })).retrievalHit).toBe(false);
  });
});

const row = (o: Partial<ScoredRow>): ScoredRow => ({
  status: 'grounded', expectedStatus: 'grounded', language: 'en', constituency: null, tags: [], latencyMs: 100,
  statusMatch: true, retrievalHit: true, citationOk: true, contentOk: true, harmful: false, correct: true, ...o,
});

describe('slices and the release gate', () => {
  it('computes percentiles', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([10, 20, 30], 50)).toBe(20);
  });
  it('reports a slice for every language, constituency and tag, flagging small ones instead of dropping them', () => {
    const rows = [...Array(6)].map(() => row({ constituency: 'Tema East' })).concat([row({ language: 'tw', tags: ['low-resource'], status: 'unsupported_language', expectedStatus: 'unsupported_language' })]);
    const s = slice(rows);
    expect(s.map((x) => `${x.dimension}:${x.value}:${x.n}:${x.underpowered}`)).toEqual(['language:en:6:false', 'language:tw:1:true', 'constituency:Tema East:6:false', 'tag:low-resource:1:true']);
  });
  it('does not let a strong aggregate hide a failing slice', () => {
    // 20 cases for one constituency all correct, 5 for another all wrong: aggregate quality is 80%.
    const rows = [...Array(20)].map(() => row({ constituency: 'Tema East' })).concat([...Array(5)].map(() => row({ constituency: 'Tamale Central', correct: false, statusMatch: false })));
    const summary = aggregate(rows);
    expect(summary.answerQuality).toBe(0.8);
    const gate = evaluateGate(summary, slice(rows), DEFAULT_THRESHOLDS);
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toMatch(/constituency "Tamale Central" answer quality is 0%/);
    expect(gate.failures.join(' ')).not.toMatch(/Answer quality is/);
  });
  it('fails when a supported language has too few cases, even if everything else is perfect', () => {
    const rows = [...Array(4)].map(() => row({}));
    const gate = evaluateGate(aggregate(rows), slice(rows), { ...DEFAULT_THRESHOLDS, minRetrievalRecall: 0 });
    expect(gate.failures.join(' ')).toMatch(/Language "en" is marked supported but has only 4/);
  });
  it('fails on any harmful output, missing evidence and slow answers', () => {
    const rows = [...Array(10)].map((_, i) => row({ harmful: i === 0, latencyMs: 9000 }));
    const gate = evaluateGate(aggregate(rows), slice(rows), DEFAULT_THRESHOLDS);
    expect(gate.failures.join(' ')).toMatch(/harmful output/);
    expect(gate.failures.join(' ')).toMatch(/p95 latency 9000 ms/);
    expect(gate.failures.join(' ')).toMatch(/no cases that should be refused/);
  });
  it('passes a healthy, well-covered run', () => {
    const rows = [...Array(8)].map(() => row({})).concat([...Array(2)].map(() => row({ status: 'no_evidence', expectedStatus: 'no_evidence', retrievalHit: null, citationOk: null })));
    const gate = evaluateGate(aggregate(rows), slice(rows), DEFAULT_THRESHOLDS);
    expect(gate).toMatchObject({ passed: true, failures: [] });
  });
});

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  total: 100, substantive: 100, grounded: 83, noEvidence: 15, unavailable: 2, unsupported: 0, generated: 85, citationFailures: 0, harmfulReports: 0,
  latencyP95Ms: 900, avgTopScore: 0.6, topScoreN: 100, byLanguage: [{ language: 'en', substantive: 100, noEvidence: 15, unavailable: 2 }], ...o,
});
const verdict = (rs: ReturnType<typeof evaluateRules>, rule: string, scope = '') => rs.find((r) => r.rule === rule && r.scopeKey === scope)!;

describe('monitoring rules', () => {
  const T = DEFAULT_RULE_THRESHOLDS;
  it('is healthy for ordinary traffic', () => {
    expect(evaluateRules(snap(), snap(), T).filter((r) => r.status === 'firing')).toEqual([]);
  });
  it('fires on citation failures, failed questions and harmful reports', () => {
    const rs = evaluateRules(snap({ citationFailures: 10, unavailable: 20, harmfulReports: 1 }), snap(), T);
    expect(verdict(rs, 'citation_failure_rate').status).toBe('firing');
    expect(verdict(rs, 'unavailable_rate').status).toBe('firing');
    expect(verdict(rs, 'harmful_reports')).toMatchObject({ status: 'firing', value: 1 });
  });
  it('says "insufficient data" rather than "ok" when the window is too small', () => {
    const rs = evaluateRules(snap({ total: 5, substantive: 5, generated: 3, citationFailures: 0, byLanguage: [{ language: 'en', substantive: 5, noEvidence: 0, unavailable: 0 }] }), snap(), T);
    expect(verdict(rs, 'citation_failure_rate').status).toBe('insufficient_data');
    expect(verdict(rs, 'language_gap', 'en').status).toBe('insufficient_data');
    expect(verdict(rs, 'latency_p95').status).toBe('insufficient_data');
  });
  it('detects drift against the previous window', () => {
    const rs = evaluateRules(snap({ noEvidence: 50, grounded: 45, avgTopScore: 0.4 }), snap(), T);
    expect(verdict(rs, 'no_evidence_drift')).toMatchObject({ status: 'firing' });
    expect(verdict(rs, 'retrieval_score_drop')).toMatchObject({ status: 'firing', value: 0.2 });
    expect(verdict(evaluateRules(snap(), snap({ substantive: 3 }), T), 'no_evidence_drift').status).toBe('insufficient_data');
  });
  it('flags a language that fails far more often than the service overall (bias)', () => {
    const cur = snap({ substantive: 200, noEvidence: 60, unavailable: 0, byLanguage: [{ language: 'en', substantive: 160, noEvidence: 20, unavailable: 0 }, { language: 'ha', substantive: 40, noEvidence: 40, unavailable: 0 }] });
    const rs = evaluateRules(cur, snap(), T);
    expect(verdict(rs, 'language_gap', 'ha')).toMatchObject({ status: 'firing' });
    expect(verdict(rs, 'language_gap', 'en').status).toBe('ok');
  });
  it('surfaces demand for languages that are not supported yet', () => {
    expect(verdict(evaluateRules(snap({ total: 100, unsupported: 30 }), snap(), T), 'unsupported_language_demand').status).toBe('firing');
  });
  it('lets a deployment override thresholds, ignoring junk', () => {
    expect(mergeThresholds({ citationFailureRate: 0.5, bogus: 1, minSample: -3, latencyP95Ms: 'x' })).toEqual({ ...T, citationFailureRate: 0.5 });
    const strict = mergeThresholds({ latencyP95Ms: 500 });
    expect(verdict(evaluateRules(snap(), snap(), strict), 'latency_p95').status).toBe('firing');
  });
});

describe('registry validation', () => {
  it('accepts the default prompt and rejects one missing safeguards', () => {
    expect(validateConfig('PROMPT', { system: DEFAULT_SYSTEM_PROMPT })).toEqual({ system: DEFAULT_SYSTEM_PROMPT });
    expect(() => validateConfig('PROMPT', { system: 'Be helpful and friendly and answer everything the user asks you, in {language}. ' })).toThrow(/untrusted/);
    expect(() => validateConfig('PROMPT', { system: DEFAULT_SYSTEM_PROMPT.replace('{language}', 'English') })).toThrow(/placeholder/);
  });
  it('validates model and retriever configs and drops unknown keys', () => {
    expect(validateConfig('MODEL', { generator: 'extractive', junk: 1 })).toEqual({ generator: 'extractive' });
    expect(() => validateConfig('MODEL', { generator: 'gpt' })).toThrow();
    expect(() => validateConfig('MODEL', { generator: 'anthropic' })).toThrow(/modelId/);
    expect(validateConfig('RETRIEVER', { minScore: 0.2, maxPassages: 4 })).toEqual({ minScore: 0.2, maxPassages: 4 });
    expect(() => validateConfig('RETRIEVER', { minScore: 0.2, maxPassages: 99 })).toThrow();
    expect(() => validateConfig('RETRIEVER', null)).toThrow();
  });
  it('validates dataset cases', () => {
    expect(() => validateCases([])).toThrow();
    expect(() => validateCases([{ key: 'bad key', question: 'x' }])).toThrow(/key/);
    expect(() => validateCases([{ key: 'a', question: 'q', expectedStatus: 'wow' }])).toThrow(/expectedStatus/);
    expect(validateCases([{ key: 'a', question: ' q? ', constituency: 'Tema East' }])[0]).toMatchObject({ question: 'q?', language: 'en', expectedStatus: 'grounded', constituency: 'Tema East' });
  });
  it('rejects unknown or negative gate thresholds', () => {
    expect(() => mergeGateThresholds({ nope: 1 })).toThrow(/Unknown/);
    expect(() => mergeGateThresholds({ minAnswerQuality: -1 })).toThrow();
    expect(mergeGateThresholds({ minAnswerQuality: 0.5 }).minAnswerQuality).toBe(0.5);
  });
});

describe('incident scope', () => {
  it('needs something narrower than a date range', () => {
    expect(() => validateScope({ from: '2025-01-01T00:00:00Z' })).toThrow(/too broad/);
    expect(() => validateScope({})).toThrow();
    expect(() => validateScope({ mood: 'x' })).toThrow(/Unknown/);
    expect(() => validateScope({ deploymentId: 'nope' })).toThrow();
    expect(() => validateScope({ answerIds: ['x'] })).toThrow();
  });
  it('normalises dates and builds a query that covers criteria and explicit answers', () => {
    const s = validateScope({ documentId: 'HAN-1', from: '2025-01-01', answerIds: ['00000000-0000-4000-8000-000000000001'] });
    expect(s.from).toBe('2025-01-01T00:00:00.000Z');
    const w = affectedWhere(s) as any;
    expect(w.OR).toHaveLength(2);
    expect(w.OR[0].AND).toEqual(expect.arrayContaining([{ citations: { array_contains: [{ documentId: 'HAN-1' }] } }]));
  });
});

describe('extractive excerpt', () => {
  const text = 'The Speaker opened the sitting and welcomed Members. Government will publish the pricing formula every fortnight. Water and sanitation funding in the northern regions must be protected in this budget. ' + 'Filler sentence about nothing. '.repeat(10);
  it('keeps short passages whole', () => {
    expect(excerpt('Short passage.', 'anything', 320)).toBe('Short passage.');
  });
  it('starts at the sentence that matches the question and stays verbatim', () => {
    const e = excerpt(text, 'water and sanitation funding', 160);
    expect(e).toMatch(/^\.\.\. Water and sanitation funding/);
    expect(e.length).toBeLessThanOrEqual(160);
    expect(text).toContain(e.replace(/^\.\.\. /, '').replace(/\.\.\.$/, '').trimEnd());
  });
  it('does not add a lead-in when the best sentence is the first', () => {
    expect(excerpt(text, 'speaker opened sitting welcomed', 160).startsWith('The Speaker')).toBe(true);
  });
});
