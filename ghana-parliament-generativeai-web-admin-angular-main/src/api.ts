// Backend API client. The console only presents the signed-in user's token to the
// backend; it holds no repository (Alfresco) or other privileged credentials.

const TOKEN_KEY = 'parliament.access_token';
const BASE = '/api/v1/internal';
/** Fired when the API rejects the stored token, so the console can send the person back to sign in. */
export const SESSION_EXPIRED = 'parliament:session-expired';

export type Lifecycle = 'DRAFT' | 'PROCESSING' | 'REVIEW' | 'APPROVED' | 'PUBLISHED' | 'REJECTED' | 'SUPERSEDED';

export interface DocumentSummary {
  id: string;
  publicId: string;
  title: string;
  type: string;
  documentDate: string | null;
  language: string;
  lifecycle: Lifecycle;
  isPublished: boolean;
  version: number;
  qualityReport: { passed?: boolean; issues?: string[]; words?: number } | null;
}

export interface ReviewReport {
  metadataIssues: { field: string; message: string }[];
  quality: { passed?: boolean; issues?: string[]; words?: number } | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

export const getToken = (): string | null => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setToken = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
};

export async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    let message = body?.message ?? res.statusText;
    if (res.status === 401) {
      message = 'Not signed in or session expired';
      // A rejected token is dead: drop it so the console returns to the sign-in page.
      if (token) { setToken(null); window.dispatchEvent(new Event(SESSION_EXPIRED)); }
    }
    if (Array.isArray(body?.issues)) message += `: ${body.issues.map((i: any) => i.message ?? i).join('; ')}`;
    if (Array.isArray(message)) message = message.join('; ');
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

export const post = <T,>(path: string, data: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(data) });

export const documentsApi = {
  list: async () => (await call<{ items: DocumentSummary[] }>('/documents?limit=200')).items,
  stats: () => call<Record<string, number>>('/documents/stats'),
  review: (id: string) => call<ReviewReport>(`/documents/${id}/review`),
  upload: (file: File, meta: Record<string, string | undefined>) => {
    const form = new FormData();
    form.append('file', file, file.name);
    Object.entries(meta).forEach(([k, v]) => v && form.append(k, v));
    return call<DocumentSummary>('/documents', { method: 'POST', body: form });
  },
  approve: (id: string, acknowledgeQualityIssues: boolean) => post(`/documents/${id}/approve`, { acknowledgeQualityIssues }),
  reject: (id: string, reason: string) => post(`/documents/${id}/reject`, { reason }),
  publish: (id: string) => post(`/documents/${id}/publish`),
  unpublish: (id: string, reason: string) => post(`/documents/${id}/unpublish`, { reason }),
  reprocess: (id: string) => post(`/documents/${id}/reprocess`),
};

// ---- Citizen cases (Phase 3). Access is limited server-side to the caller's constituencies.
export type CaseStatus = 'RECEIVED' | 'TRIAGED' | 'IN_PROGRESS' | 'AWAITING_INFORMATION' | 'RESOLVED' | 'CLOSED';
export type CasePriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface Me { userId: string; email: string; roles: string[]; constituencyIds: string[] }

export interface CaseRow {
  id: string; reference: string; title: string; status: CaseStatus; priority: CasePriority; category: string; escalated: boolean;
  constituency: string; constituencyId: string; assignee: { id: string; displayName: string } | null;
  dueAt: string | null; firstResponseAt: string | null; overdue: boolean; createdAt: string;
}
export interface CaseList { items: CaseRow[]; nextCursor: string | null }
export interface CaseStats { byStatus: Partial<Record<CaseStatus, number>>; unassigned: number; escalated: number; overdue: number }
export interface CaseFilters { status?: string; assignee?: string; escalated?: boolean; overdue?: boolean; search?: string }

export interface CaseMessage {
  id: string; authorType: 'CITIZEN' | 'STAFF' | 'SYSTEM'; authorUserId: string | null; visibility: 'PUBLIC' | 'INTERNAL';
  content: string; channel: string | null; deliveryState: 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED'; createdAt: string;
}
export interface CaseDetail {
  id: string; publicId: string; title: string; status: CaseStatus; priority: CasePriority; category: string; escalated: boolean; escalationReason: string | null;
  constituency: { id: string; name: string; region: string }; assignee: { id: string; displayName: string } | null;
  createdAt: string; dueAt: string | null; firstResponseAt: string | null; closedAt: string | null; retainUntil: string | null; anonymizedAt: string | null;
  overdue: boolean; locationText: string | null; preferredLanguage: string; consentGivenAt: string; consentPurpose: string;
  contact: { channel: string; name: string | null; email: string | null; phone: string | null } | null;
  aiClassification: { category: string | null; confidence: number | null; summary: string | null; method: string };
  allowedTransitions: CaseStatus[];
  messages: CaseMessage[];
  events: { id: string; kind: string; fromValue: string | null; toValue: string | null; actorType: string; createdAt: string }[];
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number; scanStatus: string; scanDetail: string | null }[];
  notifications: { id: string; kind: string; channel: string; state: 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED'; attempts: number; lastError: string | null; messageId: string | null; createdAt: string; sentAt: string | null }[];
}
export interface Template { id: string; name: string; body: string; active: boolean }
export interface Assignee { id: string; displayName: string; roles: string[] }

export const query = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => v !== undefined && v !== '' && v !== false && p.set(k, String(v)));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Email-and-password sign-in. Public endpoint, so it bypasses the bearer-token handling in call(). */
export async function loginWithPassword(email: string, password: string): Promise<{ accessToken: string; expiresIn: number }> {
  let res: Response;
  try {
    res = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, res.status === 429 ? 'Too many attempts. Wait a minute and try again.' : String(Array.isArray(body?.message) ? body.message.join('; ') : body?.message ?? res.statusText), body);
  return body;
}

export const casesApi = {
  me: () => call<Me>('/me'),
  list: (f: CaseFilters, cursor?: string) => call<CaseList>(`/cases${query({ ...f, cursor, limit: 25 })}`),
  stats: () => call<CaseStats>('/cases/stats'),
  get: (id: string) => call<CaseDetail>(`/cases/${id}`),
  assignees: (id: string) => call<Assignee[]>(`/cases/${id}/assignees`),
  templates: () => call<Template[]>('/message-templates'),
  update: (id: string, patch: { category?: string; priority?: CasePriority }) => call<CaseDetail>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  assign: (id: string, assigneeId: string | null) => post<CaseDetail>(`/cases/${id}/assign`, { assigneeId }),
  setStatus: (id: string, status: CaseStatus) => post<CaseDetail>(`/cases/${id}/status`, { status }),
  note: (id: string, content: string) => post<CaseDetail>(`/cases/${id}/notes`, { content }),
  respond: (id: string, body: { content?: string; templateId?: string }) => post<CaseDetail>(`/cases/${id}/responses`, body),
  setEscalation: (id: string, escalated: boolean, reason: string) => post<CaseDetail>(`/cases/${id}/escalation`, { escalated, reason }),
  exportCase: (id: string) => call<unknown>(`/cases/${id}/export`),
  erase: (id: string, reason: string) => post<{ id: string; alreadyAnonymized: boolean }>(`/cases/${id}/erase`, { reason }),
  /** Attachments need the bearer token, so they are fetched and saved as a blob rather than linked. */
  async attachment(id: string, attachmentId: string): Promise<Blob> {
    const token = getToken();
    let res: Response;
    try { res = await fetch(`${BASE}/cases/${id}/attachments/${attachmentId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); }
    catch { throw new ApiError(0, 'Cannot reach the server'); }
    if (!res.ok) throw new ApiError(res.status, 'The attachment could not be downloaded');
    return res.blob();
  },
};

// ---- Parliamentary operations (Phase 4)
export type BillStage = 'FIRST_READING' | 'COMMITTEE' | 'SECOND_READING' | 'CONSIDERATION' | 'THIRD_READING' | 'ASSENTED' | 'WITHDRAWN';
export type SittingStatus = 'SCHEDULED' | 'HELD' | 'CANCELLED';
export type ObjectType = 'sitting' | 'bill' | 'committee' | 'mp';
export interface AgendaItem { title: string; billId?: string }
export interface Sitting { id: string; date: string; type: string; status: SittingStatus; agenda: AgendaItem[] | null; isPublished: boolean; _count?: { documents: number; bills: number } }
export interface Bill { id: string; title: string; sponsor: string | null; stage: BillStage; committeeId: string | null; committee?: { id: string; name: string } | null; isPublished: boolean; introducedOn: string | null; summary: string | null; sittings?: { sittingId: string }[] }
export interface Committee { id: string; name: string; remit: string | null; chairMpId: string | null; chair?: { id: string; officialName: string } | null; isPublished: boolean; members?: { mpId: string; role: string; mp?: { officialName: string } }[]; _count?: { members: number; bills: number } }
export interface Mp { id: string; officialName: string; party: string; roleTitle: string | null; publicContact: Record<string, string> | null; constituencyId: string; constituency?: { code: string; name: string }; activeFrom: string; activeTo: string | null; isPublished: boolean }
export interface ApprovalRow { id: string; objectType: ObjectType | 'ai_deployment'; objectId: string; objectLabel: string | null; action: 'publish' | 'unpublish' | 'deploy'; decision: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'; reason: string | null; evidence: { notes?: string; summary?: { n: number; answerQuality: number | null; retrievalRecall: number | null; citationCompleteness: number | null; refusalQuality: number | null; harmfulOutputs: number; latencyP95Ms: number | null }; gate?: { passed: boolean; failures: string[]; warnings: string[] }; slices?: { dimension: string; value: string; n: number; answerQuality: number | null; underpowered: boolean }[]; releaseThresholds?: Record<string, number>; evalRunId?: string } | null; requesterId: string | null; requester: { id: string; displayName: string } | null; approver: { id: string; displayName: string } | null; createdAt: string; decidedAt: string | null }
export interface UserRow { id: string; email: string; displayName: string; roles: string[]; active: boolean; invited: boolean; lastLoginAt: string | null; constituencies: { constituencyId: string; constituency: { name: string } }[] }
export interface AuditRow { id: string; occurredAt: string; actorType: string; actorId: string | null; actorRoles: string[]; action: string; objectType: string | null; objectId: string | null; outcome: string }
export interface Overview {
  generatedAt: string; documents: Record<string, number>; publishedChunks: number; answers: { last7Days: number; grounded: number; groundedShare: number | null };
  approvalsPending: number; upcomingSittings: number; billsByStage: Record<string, number>;
  cases: { open: number; overdue: number; escalated: number; failedNotifications: number }; system: { deadJobs: number; activeUsers: number };
}

const qs2 = (o: Record<string, string | undefined>) => query(o);

export const opsApi = {
  sittings: () => call<Sitting[]>('/sittings'),
  saveSitting: (id: string | null, d: Partial<Sitting>) => (id ? call<Sitting>(`/sittings/${id}`, { method: 'PATCH', body: JSON.stringify(d) }) : post<Sitting>('/sittings', d)),
  bills: () => call<Bill[]>('/bills'),
  bill: (id: string) => call<Bill>(`/bills/${id}`),
  saveBill: (id: string | null, d: Record<string, unknown>) => (id ? call<Bill>(`/bills/${id}`, { method: 'PATCH', body: JSON.stringify(d) }) : post<Bill>('/bills', d)),
  committees: () => call<Committee[]>('/committees'),
  committee: (id: string) => call<Committee>(`/committees/${id}`),
  saveCommittee: (id: string | null, d: Record<string, unknown>) => (id ? call<Committee>(`/committees/${id}`, { method: 'PATCH', body: JSON.stringify(d) }) : post<Committee>('/committees', d)),
  mps: () => call<Mp[]>('/mps'),
  saveMp: (id: string | null, d: Record<string, unknown>) => (id ? call<Mp>(`/mps/${id}`, { method: 'PATCH', body: JSON.stringify(d) }) : post<Mp>('/mps', d)),
  approvals: (decision?: string) => call<ApprovalRow[]>(`/approvals${qs2({ decision })}`),
  requestApproval: (objectType: ObjectType, objectId: string, action: 'publish' | 'unpublish', reason?: string) => post<ApprovalRow>('/approvals', { objectType, objectId, action, reason }),
  decide: (id: string, decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED', notes?: string, reviewedEvidence?: boolean) => post<ApprovalRow>(`/approvals/${id}/decision`, { decision, notes, reviewedEvidence }),
  users: () => call<UserRow[]>('/users'),
  invite: (d: { email: string; displayName: string; roles: string[]; constituencyIds?: string[] }) => post<UserRow>('/users/invitations', d),
  updateUser: (id: string, d: { displayName?: string; roles?: string[]; constituencyIds?: string[] }) => call<UserRow>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
  setActive: (id: string, active: boolean) => post<UserRow>(`/users/${id}/active`, { active }),
  audit: (cursor?: string, filters: { objectType?: string; actorId?: string } = {}) => call<{ items: AuditRow[]; nextCursor: string | null }>(`/audit-events${qs2({ cursor, ...filters, limit: '50' })}`),
  overview: () => call<Overview>('/overview'),
  /** Constituencies come from the public directory (approved list); no credentials are needed. */
  async constituencies(): Promise<{ id: string; name: string; region: string }[]> {
    const r = await fetch('/api/v1/public/constituencies');
    if (!r.ok) throw new ApiError(r.status, 'Could not load constituencies');
    return r.json();
  },
};

// ---- Insights: MP dashboard, issue clustering, national heatmap, sentiment
export interface CategoryCount { category: string; count: number }
export interface TrendingTopic { category: string; count: number; previousCount: number; change: number }
export type Sentiment =
  | { available: false; reason: string }
  | { available: true; overallScore: number; label: string; topConcern: string | null; summary: string | null; sampleSize: number; model: string };
export interface MpOverview {
  constituency: { id: string; name: string; region: string };
  openCases: number;
  topConcerns: CategoryCount[];
  trendingTopics: TrendingTopic[];
  sentiment: Sentiment;
  measuredAt: string;
}
export interface IssueCluster { category: string; count: number; overdue: number; escalated: number; urgent: boolean }
export interface HeatmapRegion { region: string; openCases: number; overdue: number; escalated: number; severity: number; topCategory: string | null }

export const insightsApi = {
  mpOverview: (constituencyId: string) => call<MpOverview>(`/insights/mp-overview${query({ constituencyId })}`),
  clusters: (constituencyId: string) => call<IssueCluster[]>(`/insights/clusters${query({ constituencyId })}`),
  sentiment: (constituencyId: string) => call<Sentiment>(`/insights/sentiment${query({ constituencyId })}`),
  heatmap: () => call<HeatmapRegion[]>('/insights/heatmap'),
};

// ---- Per-sitting AI summarization
export type SummaryStatus = 'PENDING' | 'AVAILABLE' | 'UNAVAILABLE';
export interface SittingSummary {
  status: SummaryStatus;
  topics: string[] | null;
  decisions: string[] | null;
  mpContributions: { mp: string; point: string }[] | null;
  model: string | null;
  unavailableReason: string | null;
  generatedAt: string | null;
}
export const summariesApi = {
  get: (sittingId: string) => call<SittingSummary | null>(`/sittings/${sittingId}/summary`),
  request: (sittingId: string) => post<SittingSummary>(`/sittings/${sittingId}/summary`),
};

// ---- AI-drafted case responses
export type DraftResponse = { available: false; reason: string } | { available: true; draft: string; model: string; note: string };
export const draftResponseApi = {
  get: (caseId: string) => call<DraftResponse>(`/cases/${caseId}/draft-response`),
};

// ---- Meetings: MP availability windows and citizen requests
export type MeetingStatus = 'REQUESTED' | 'CONFIRMED' | 'DECLINED' | 'CANCELLED';
export interface AvailabilityWindow { id?: string; dayOfWeek: number; startTime: string; endTime: string }
export interface MeetingRow {
  id: string; requestedName: string; topic: string; requestedSlot: string; durationMinutes: number;
  status: MeetingStatus; confirmedSlot: string | null; staffNote: string | null; createdAt: string;
}
export const meetingsApi = {
  availability: (mpId: string) => call<AvailabilityWindow[]>(`/mps/${mpId}/meetings/availability`),
  setAvailability: (mpId: string, windows: AvailabilityWindow[]) => post<AvailabilityWindow[]>(`/mps/${mpId}/meetings/availability`, { windows }),
  list: (mpId: string, status?: MeetingStatus) => call<MeetingRow[]>(`/mps/${mpId}/meetings${query({ status })}`),
  decide: (id: string, decision: 'CONFIRMED' | 'DECLINED', note?: string) => call<MeetingRow>(`/meetings/${id}`, { method: 'PATCH', body: JSON.stringify({ decision, note }) }),
  cancel: (id: string) => call<MeetingRow>(`/meetings/${id}/cancel`, { method: 'PATCH', body: JSON.stringify({}) }),
};

// ---- Policy-impact feedback (internal view of citizen feedback on an in-force bill)
export interface BillFeedbackSummary {
  billId: string; total: number; byLabel: Record<'POSITIVE' | 'NEUTRAL' | 'NEGATIVE', number>;
  recentComments: { sentiment: string; comment: string; createdAt: string }[];
}
export const billFeedbackApi = {
  summary: (billId: string) => call<BillFeedbackSummary>(`/bills/${billId}/feedback`),
};

// ---- Settings and erasure ledger
export type SettingSource = 'database' | 'environment' | 'default';
export interface CaseSettings { retentionDays: number; slaHours: number; slaUrgentHours: number }
export interface SettingsOverview {
  cases: { values: CaseSettings; sources: Record<keyof CaseSettings, SettingSource>; updatedAt: string | null; updatedById: string | null; limits: Record<keyof CaseSettings, { min: number; max: number }>; editable: true };
  answering: { enabled: boolean; reason: string | null; editable: false; changeVia: string };
  retrieval: { deploymentId: string | null; generator: string; minScore: number; maxPassages: number; retrieverVersion: string | null; editable: false; changeVia: string };
  languages: { items: { code: string; name: string; level: 'supported' | 'planned'; note: string }[]; editable: false; changeVia: string };
  notifications: { provider: string | null; configured: boolean; staffAlerts: boolean; editable: false; changeVia: string };
  attachments: { scanner: string; editable: false; changeVia: string };
}
export interface ErasureLedger { generatedAt: string; count: number; checksum: string; entries: { caseId: string; reference: string; kind: string; erasedAt: string }[] }

export const settingsApi = {
  get: () => call<SettingsOverview>('/settings'),
  saveCases: (d: CaseSettings) => call<SettingsOverview>('/settings/cases', { method: 'PUT', body: JSON.stringify(d) }),
  ledger: () => call<ErasureLedger>('/erasures/ledger'),
};
