// Public API client. Anonymous: no credentials are stored or sent.
const BASE = '/api/v1/public';

export type AnswerStatus =
  | 'grounded' | 'no_evidence' | 'needs_clarification' | 'conflicting_sources'
  | 'unsupported_language' | 'safety_refusal' | 'service_unavailable' | 'answering_paused';

export interface Citation {
  n: number;
  documentId: string;
  title: string;
  date: string | null;
  anchor: string | null;
  relevance: number;
}

export interface Answer {
  answerId: string;
  answer: string | null;
  message: string | null;
  language: string;
  status: AnswerStatus;
  confidence: 'high' | 'medium' | 'low' | null;
  disclosure: string;
  citations: Citation[];
  answerVersion: { model: string | null; prompt: string | null; retriever: string | null };
  /** True when staff withdrew this answer after a review. */
  withdrawn?: boolean;
}

export interface AnsweringStatus { enabled: boolean; message: string | null }

export interface LanguageInfo { code: string; name: string; level: 'supported' | 'planned'; note: string }

export interface RecordSummary { publicId: string; title: string; type: string; documentDate: string | null; language: string }
export interface RecordPage { items: RecordSummary[]; page: number; pageSize: number; total: number; totalPages: number }
export interface RecordDetail extends RecordSummary { version: number; publishedAt: string | null; extractedText: string | null }
export interface PassageResult { documentId: string; title: string; date: string | null; passages: { anchor: string | null; text: string }[] }

// ---- Constituency directory and issues (Phase 3)
export interface PublicMp { id: string; name: string; party: string; roleTitle: string | null; contact: Record<string, string> | null; since: string }
export interface ConstituencyOption { id: string; code: string; name: string; region: string }
export interface ConstituencyMatch {
  constituency: ConstituencyOption;
  matchedOn: 'exact_name' | 'code' | 'alias' | 'starts_with' | 'contains';
  explanation: string;
  mp: PublicMp | null;
}
export interface CaseCategory { id: string; label: string }
export interface CaseSuggestion { category: string; categoryLabel: string; confidence: number; summary: string; method: string; note: string }
export type CaseStatus = 'RECEIVED' | 'TRIAGED' | 'IN_PROGRESS' | 'AWAITING_INFORMATION' | 'RESOLVED' | 'CLOSED';
export interface SubmitCase {
  constituencyId: string; category: string; title: string; description: string; locationText?: string; preferredLanguage?: string;
  consent: true; contact: { name?: string; email?: string; phone?: string; channel: 'EMAIL' | 'SMS' | 'NONE' }; submissionKey: string;
}
export interface SubmitResult { reference: string; trackingCode: string; status: CaseStatus; statusLabel: string; receivedAt: string; duplicate: boolean; safetyNotice?: string }
export interface CaseView {
  reference: string; title: string | null; status: CaseStatus; statusLabel: string; category: string; constituency: string; receivedAt: string; updatedAt: string;
  awaitingYourReply: boolean; canReply: boolean; anonymized: boolean;
  history: { status: CaseStatus; label: string; at: string }[];
  messages: { id: string; from: 'you' | 'constituency_office'; content: string; at: string }[];
  attachments: { id: string; filename: string; sizeBytes: number; mimeType: string }[];
}

// ---- Parliamentary business (Phase 4): published records only
export type BillStage = 'FIRST_READING' | 'COMMITTEE' | 'SECOND_READING' | 'CONSIDERATION' | 'THIRD_READING' | 'ASSENTED' | 'WITHDRAWN';
export interface BillSummary { id: string; title: string; sponsor: string | null; stage: BillStage; introducedOn: string | null; committee: { id: string; name: string } | null }
export interface DocLink { publicId: string; title: string; type: string; documentDate: string | null }
export interface BillDetail extends BillSummary { summary: string | null; sittings: { id: string; date: string; type: string }[]; documents: DocLink[] }
export interface SittingSummary { id: string; date: string; type: string; status: 'SCHEDULED' | 'HELD' | 'CANCELLED' }
export interface SittingDetail extends SittingSummary { agenda: { title: string; billId?: string }[]; bills: { id: string; title: string; stage: BillStage }[]; documents: DocLink[] }
export interface CommitteeSummary { id: string; name: string; remit: string | null }
export interface CommitteeDetail extends CommitteeSummary { chair: { id: string; name: string } | null; members: { id: string; name: string; party: string; role: string }[]; bills: { id: string; title: string; stage: BillStage }[] }

export class ApiError extends Error {
  /** kind lets the UI show the right message without parsing text. */
  constructor(public kind: 'network' | 'rate_limited' | 'not_found' | 'invalid' | 'conflict' | 'server', message: string, public status = 0) {
    super(message);
  }
}

const OFFLINE = 'You appear to be offline or the service cannot be reached.';
const messageOf = (body: any, fallback: string) => (Array.isArray(body?.message) ? body.message.join(' ') : typeof body?.message === 'string' ? body.message : fallback);

/** Maps a failed response to an ApiError. Server wording is used for 400/409/422 because it is written for citizens. */
function failure(res: Response, body: any): ApiError {
  if (res.status === 429) return new ApiError('rate_limited', 'Too many requests. Please wait a minute and try again.', 429);
  if (res.status === 404) return new ApiError('not_found', 'We could not find that record.', 404);
  if (res.status === 400 || res.status === 422) return new ApiError('invalid', messageOf(body, 'That request was not valid.'), res.status);
  if (res.status === 409) return new ApiError('conflict', messageOf(body, 'That is not possible right now.'), 409);
  return new ApiError('server', 'Something went wrong on our side. Please try again shortly.', res.status);
}

async function call<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    const json = init.body && !(init.body instanceof FormData);
    res = await fetch(`${BASE}${path}`, { ...init, headers: { Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) } });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('network', OFFLINE);
  }
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  // The answer endpoint returns a typed body even for 503 so the UI can render service_unavailable or answering_paused.
  if (res.ok || (res.status === 503 && (body?.status === 'service_unavailable' || body?.status === 'answering_paused'))) return body as T;
  throw failure(res, body);
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => v !== undefined && v !== '' && p.set(k, String(v)));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** A citizen proves ownership of a case with its tracking code, sent as X-Case-Token. */
const withCode = (code: string): { 'X-Case-Token': string } => ({ 'X-Case-Token': code });
const ref = (r: string) => encodeURIComponent(r);

export const api = {
  languages: () => call<LanguageInfo[]>('/languages'),
  answeringStatus: (signal?: AbortSignal) => call<AnsweringStatus>('/answering-status', { signal }),
  ask: (question: string, language: string, signal?: AbortSignal) =>
    call<Answer>('/answers', { method: 'POST', body: JSON.stringify({ question, language }), signal }),
  answer: (id: string) => call<Answer>(`/answers/${encodeURIComponent(id)}`),
  feedback: (id: string, body: { helpful?: boolean; reportType?: string; comment?: string }) =>
    call<{ ok: true }>(`/answers/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  records: (q: { q?: string; type?: string; from?: string; to?: string; page?: number }, signal?: AbortSignal) =>
    call<RecordPage>(`/documents${qs({ ...q, pageSize: 10 })}`, { signal }),
  record: (id: string, signal?: AbortSignal) => call<RecordDetail>(`/documents/${encodeURIComponent(id)}`, { signal }),
  passage: (id: string, anchor: string, signal?: AbortSignal) =>
    call<PassageResult>(`/documents/${encodeURIComponent(id)}/passages${qs({ anchor })}`, { signal }),

  bills: (q: { q?: string; stage?: string }, signal?: AbortSignal) => call<{ items: BillSummary[] }>(`/bills${qs(q)}`, { signal }),
  bill: (id: string, signal?: AbortSignal) => call<BillDetail>(`/bills/${encodeURIComponent(id)}`, { signal }),
  sittings: (signal?: AbortSignal) => call<{ items: SittingSummary[] }>('/sittings', { signal }),
  sitting: (id: string, signal?: AbortSignal) => call<SittingDetail>(`/sittings/${encodeURIComponent(id)}`, { signal }),
  committees: (signal?: AbortSignal) => call<{ items: CommitteeSummary[] }>('/committees', { signal }),
  committee: (id: string, signal?: AbortSignal) => call<CommitteeDetail>(`/committees/${encodeURIComponent(id)}`, { signal }),

  regions: () => call<string[]>('/regions'),
  constituencies: (region?: string) => call<ConstituencyOption[]>(`/constituencies${qs({ region })}`),
  lookup: (q: string, signal?: AbortSignal) => call<{ query: string; matches: ConstituencyMatch[] }>(`/constituencies/lookup${qs({ q })}`, { signal }),
  constituency: (id: string) => call<{ constituency: ConstituencyOption; mp: PublicMp | null }>(`/constituencies/${encodeURIComponent(id)}`),

  categories: () => call<CaseCategory[]>('/case-categories'),
  suggest: (description: string) => call<CaseSuggestion>('/cases/suggest', { method: 'POST', body: JSON.stringify({ description }) }),
  submitCase: (body: SubmitCase) => call<SubmitResult>('/cases', { method: 'POST', body: JSON.stringify(body) }),
  caseView: (reference: string, code: string, signal?: AbortSignal) => call<CaseView>(`/cases/${ref(reference)}`, { headers: withCode(code), signal }),
  caseReply: (reference: string, code: string, content: string) =>
    call<CaseView>(`/cases/${ref(reference)}/messages`, { method: 'POST', body: JSON.stringify({ content }), headers: withCode(code) }),
  caseAttach: (reference: string, code: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return call<{ id: string; filename: string; sizeBytes: number; mimeType: string }>(`/cases/${ref(reference)}/attachments`, { method: 'POST', body: form, headers: withCode(code) });
  },
  caseExport: (reference: string, code: string) => call<unknown>(`/cases/${ref(reference)}/export`, { headers: withCode(code) }),
  caseErasure: (reference: string, code: string) => call<{ received: true; message: string }>(`/cases/${ref(reference)}/erasure-request`, { method: 'POST', headers: withCode(code) }),
  /** Attachments need the tracking-code header, so they are fetched and saved as a blob rather than linked. */
  async caseAttachmentBlob(reference: string, code: string, id: string): Promise<Blob> {
    let res: Response;
    try { res = await fetch(`${BASE}/cases/${ref(reference)}/attachments/${encodeURIComponent(id)}`, { headers: withCode(code) }); }
    catch { throw new ApiError('network', OFFLINE); }
    if (!res.ok) throw failure(res, undefined);
    return res.blob();
  },
};
