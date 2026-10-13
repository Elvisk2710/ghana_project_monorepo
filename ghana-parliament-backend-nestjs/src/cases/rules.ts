import { CasePriority, CaseStatus } from '@prisma/client';

// ---------- Categories ----------

export interface CaseCategory {
  id: string;
  label: string;
  /** Sensitive categories always get human escalation (T-057). */
  sensitive: boolean;
  keywords: string[];
}

/** Provisional list: the final taxonomy is a Phase 0 decision with Parliament. */
export const CATEGORIES: CaseCategory[] = [
  { id: 'roads_infrastructure', label: 'Roads and infrastructure', sensitive: false, keywords: ['road', 'bridge', 'pothole', 'drain', 'culvert', 'street light', 'streetlight', 'market', 'construction'] },
  { id: 'water_sanitation', label: 'Water and sanitation', sensitive: false, keywords: ['water', 'borehole', 'toilet', 'sanitation', 'sewage', 'refuse', 'waste', 'gutter'] },
  { id: 'health', label: 'Health', sensitive: false, keywords: ['hospital', 'clinic', 'nurse', 'doctor', 'health', 'medicine', 'nhis', 'ambulance', 'maternity'] },
  { id: 'education', label: 'Education', sensitive: false, keywords: ['school', 'teacher', 'student', 'education', 'scholarship', 'classroom', 'textbook', 'shs', 'jhs'] },
  { id: 'electricity', label: 'Electricity', sensitive: false, keywords: ['electricity', 'power cut', 'outage', 'transformer', 'ecg', 'light off', 'dumsor', 'blackout'] },
  { id: 'agriculture', label: 'Agriculture', sensitive: false, keywords: ['farm', 'farmer', 'cocoa', 'fertilizer', 'fertiliser', 'crop', 'harvest', 'irrigation'] },
  { id: 'employment', label: 'Jobs and livelihoods', sensitive: false, keywords: ['job', 'unemployed', 'employment', 'salary', 'wages', 'trader', 'business', 'loan'] },
  { id: 'security_safety', label: 'Security and personal safety', sensitive: true, keywords: ['threat', 'attack', 'violence', 'assault', 'robbery', 'police', 'unsafe', 'danger', 'harass'] },
  { id: 'corruption_allegation', label: 'Corruption allegation', sensitive: true, keywords: ['corruption', 'bribe', 'embezzle', 'kickback', 'fraud', 'misappropriat'] },
  { id: 'legal_matter', label: 'Legal matter', sensitive: true, keywords: ['court', 'lawyer', 'lawsuit', 'arrest', 'evict', 'land dispute', 'defamation'] },
  { id: 'other', label: 'Something else', sensitive: false, keywords: [] },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const categoryById = (id: string) => CATEGORIES.find((c) => c.id === id);

export interface Suggestion {
  category: string;
  confidence: number;
  summary: string;
  method: string;
}

export const CLASSIFIER_VERSION = 'keyword-rules-v1';

/**
 * Rule-based suggestion of category and a one-line summary. It never changes the citizen's
 * text: the suggestion is shown beside it and the citizen must confirm (T-052).
 * This is a keyword heuristic, not a model; confidence is a coarse signal only.
 */
export function suggest(text: string): Suggestion {
  const lower = text.toLowerCase();
  const scored = CATEGORIES.map((c) => ({ id: c.id, hits: c.keywords.filter((k) => lower.includes(k)).length })).filter((s) => s.hits > 0);
  scored.sort((a, b) => b.hits - a.hits);
  const top = scored[0];
  const second = scored[1];
  const confidence = top ? Math.round((top.hits / (top.hits + (second?.hits ?? 0) + 1)) * 100) / 100 : 0;
  const firstSentence = text.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  const summary = firstSentence.length > 140 ? `${firstSentence.slice(0, 137).trimEnd()}...` : firstSentence;
  return { category: top?.id ?? 'other', confidence, summary, method: CLASSIFIER_VERSION };
}

// ---------- Escalation (T-057) ----------

export interface EscalationRule {
  id: string;
  reason: string;
  test: (input: { category: string; text: string }) => boolean;
  priority: CasePriority;
}

/** Typed, versioned rules; every match is recorded on the case and in the audit ledger. */
export const ESCALATION_RULES: EscalationRule[] = [
  {
    id: 'personal_safety',
    reason: 'Possible threat to personal safety',
    priority: CasePriority.URGENT,
    test: ({ text }) => /\b(kill|murder|threaten(?:ed|ing)?|beat(?:en|ing)?|rape[d]?|abuse[d]?|gun|weapon|suicide|self[- ]harm|in danger|attacked)\b/i.test(text),
  },
  {
    id: 'sensitive_category',
    reason: 'Sensitive category: needs a named human owner',
    priority: CasePriority.HIGH,
    test: ({ category }) => !!categoryById(category)?.sensitive,
  },
  {
    id: 'named_official_allegation',
    reason: 'Allegation about a named official or institution',
    priority: CasePriority.HIGH,
    test: ({ text }) => /\b(?:minister|dce|mce|director|commissioner|judge|police\s+officer)\b[^.]{0,80}\b(?:bribe|stole|corrupt|embezzl|abus)/i.test(text),
  },
];

const PRIORITY_RANK: Record<CasePriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };

export interface EscalationDecision {
  escalate: boolean;
  priority: CasePriority;
  reasons: string[];
  ruleIds: string[];
}

export function evaluateEscalation(input: { category: string; text: string }): EscalationDecision {
  const matched = ESCALATION_RULES.filter((r) => r.test(input));
  const priority = matched.reduce<CasePriority>((p, r) => (PRIORITY_RANK[r.priority] > PRIORITY_RANK[p] ? r.priority : p), CasePriority.NORMAL);
  return { escalate: matched.length > 0, priority, reasons: matched.map((r) => r.reason), ruleIds: matched.map((r) => r.id) };
}

/** Shown to the citizen when a safety rule fired. Numbers must be confirmed with Parliament before launch. */
export const SAFETY_NOTICE = 'If you or someone else is in immediate danger, call the national emergency number 112 now. Parliament cannot respond to emergencies.';

// ---------- Status machine (T-054) ----------

const S = CaseStatus;

export const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  [S.RECEIVED]: [S.TRIAGED, S.CLOSED],
  [S.TRIAGED]: [S.IN_PROGRESS, S.AWAITING_INFORMATION, S.RESOLVED, S.CLOSED],
  [S.IN_PROGRESS]: [S.AWAITING_INFORMATION, S.RESOLVED, S.CLOSED],
  [S.AWAITING_INFORMATION]: [S.IN_PROGRESS, S.RESOLVED, S.CLOSED],
  [S.RESOLVED]: [S.IN_PROGRESS, S.CLOSED],
  [S.CLOSED]: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Citizen-facing wording for each status. */
export const PUBLIC_STATUS_LABEL: Record<CaseStatus, string> = {
  RECEIVED: 'Received',
  TRIAGED: 'Triaged',
  IN_PROGRESS: 'In progress',
  AWAITING_INFORMATION: 'Awaiting information from you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/** A citizen reply moves a waiting or resolved case back to work; a closed case stays closed. */
export function statusAfterCitizenReply(status: CaseStatus): CaseStatus | null {
  if (status === S.AWAITING_INFORMATION || status === S.RESOLVED) return S.IN_PROGRESS;
  return null;
}
