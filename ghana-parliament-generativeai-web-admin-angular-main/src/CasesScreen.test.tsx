import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CasesScreen, { slaLabel } from './CasesScreen';

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  id: 'case-1', reference: 'GH-2026-000001', title: 'Potholes on market road', status: 'RECEIVED', priority: 'NORMAL', category: 'roads_infrastructure', escalated: false,
  constituency: 'Tema East', constituencyId: 'con-1', assignee: null, dueAt: iso(72 * HOUR), firstResponseAt: null, overdue: false, createdAt: iso(-HOUR), ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  id: 'case-1', publicId: 'GH-2026-000001', title: 'Potholes on market road', status: 'TRIAGED', priority: 'NORMAL', category: 'roads_infrastructure', escalated: false, escalationReason: null,
  constituency: { id: 'con-1', name: 'Tema East', region: 'Greater Accra' }, assignee: null, createdAt: iso(-HOUR), dueAt: iso(48 * HOUR), firstResponseAt: null, closedAt: null,
  retainUntil: null, anonymizedAt: null, overdue: false, locationText: 'Community 9', preferredLanguage: 'en', consentGivenAt: iso(-HOUR), consentPurpose: 'p',
  contact: { channel: 'EMAIL', name: 'Kofi', email: 'kofi@example.com', phone: null },
  aiClassification: { category: 'health', confidence: 0.5, summary: 's', method: 'keyword-rules-v1' },
  allowedTransitions: ['IN_PROGRESS', 'AWAITING_INFORMATION', 'RESOLVED', 'CLOSED'],
  messages: [
    { id: 'm1', authorType: 'CITIZEN', authorUserId: null, visibility: 'PUBLIC', content: 'The road has deep potholes. Call me on 0244123456.', channel: 'portal', deliveryState: 'DELIVERED', createdAt: iso(-HOUR) },
    { id: 'm2', authorType: 'STAFF', authorUserId: 'u1', visibility: 'INTERNAL', content: 'Contractor is a relative of the MCE', channel: 'internal', deliveryState: 'DELIVERED', createdAt: iso(-HOUR / 2) },
    { id: 'm3', authorType: 'STAFF', authorUserId: 'u1', visibility: 'PUBLIC', content: 'We will visit the site on Friday.', channel: 'email', deliveryState: 'FAILED', createdAt: iso(-HOUR / 3) },
  ],
  events: [{ id: 'e1', kind: 'created', fromValue: null, toValue: 'RECEIVED', actorType: 'citizen', createdAt: iso(-HOUR) }, { id: 'e2', kind: 'status', fromValue: 'RECEIVED', toValue: 'TRIAGED', actorType: 'staff', createdAt: iso(-HOUR / 2) }],
  attachments: [{ id: 'att-1', filename: 'photo.png', mimeType: 'image/png', sizeBytes: 20480, scanStatus: 'CLEAN', scanDetail: 'ok' }],
  notifications: [{ id: 'n1', kind: 'response', channel: 'EMAIL', state: 'FAILED', attempts: 5, lastError: 'provider unavailable', messageId: 'm3', createdAt: iso(-HOUR / 3), sentAt: null }],
  ...over,
});
const TEMPLATES = [{ id: 't1', name: 'Acknowledged', body: 'Thank you. Your MP has noted this.', active: true }];
const ASSIGNEES = [{ id: 'u1', displayName: 'Ama Staff', roles: ['STAFF'] }, { id: 'u2', displayName: 'Hon. Mensah', roles: ['MP'] }];

type Reply = { status: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: any; auth: string | null }[];
let respond: (path: string, method: string) => Reply;
let roles: string[];
let current: ReturnType<typeof detail>;

beforeEach(() => {
  calls = [];
  roles = ['STAFF'];
  current = detail();
  respond = () => undefined;
  sessionStorage.setItem('parliament.access_token', 'tok-123');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/internal', '');
    const method = init.method ?? 'GET';
    calls.push({ url: path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, auth: new Headers(init.headers).get('Authorization') });
    const custom = respond(path, method);
    const out: Reply = custom ?? (
      path === '/me' ? { status: 200, body: { userId: 'u1', email: 'a@b', roles, constituencyIds: ['con-1'] } }
      : path === '/message-templates' ? { status: 200, body: TEMPLATES }
      : path.endsWith('/assignees') ? { status: 200, body: ASSIGNEES }
      : path === '/cases/stats' ? { status: 200, body: { byStatus: { RECEIVED: 2, IN_PROGRESS: 1 }, unassigned: 2, escalated: 1, overdue: 1 } }
      : path.startsWith('/cases?') ? { status: 200, body: { items: [row()], nextCursor: null } }
      : path.endsWith('/export') ? { status: 200, body: { case: { reference: 'GH-2026-000001' }, auditTrail: [{ action: 'case.submit' }] } }
      : /^\/cases\/case-1$/.test(path) && method === 'GET' ? { status: 200, body: current }
      : method === 'POST' || method === 'PATCH' ? { status: 200, body: current }
      : { status: 404, body: {} });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const mount = (path = '/cases') => render(<MemoryRouter initialEntries={[path]}><CasesScreen /></MemoryRouter>);
const post = (suffix: string) => calls.find((c) => c.method === 'POST' && c.url.endsWith(suffix));

describe('response-time label', () => {
  const base = { dueAt: null as string | null, overdue: false, firstResponseAt: null as string | null, status: 'RECEIVED' as const };
  it('shows overdue, due soon, due later, responded and not applicable', () => {
    expect(slaLabel({ ...base, dueAt: iso(-5 * HOUR), overdue: true })).toEqual({ text: 'Overdue by 5h', tone: 'bad' });
    expect(slaLabel({ ...base, dueAt: iso(-72 * HOUR), overdue: true }).text).toBe('Overdue by 3d');
    expect(slaLabel({ ...base, dueAt: iso(10 * HOUR) })).toEqual({ text: 'Due in 10h', tone: 'warn' });
    expect(slaLabel({ ...base, dueAt: iso(96 * HOUR) })).toEqual({ text: 'Due in 4d', tone: 'ok' });
    expect(slaLabel({ ...base, dueAt: iso(-HOUR), firstResponseAt: iso(-2 * HOUR) })).toEqual({ text: 'Responded', tone: 'ok' });
    expect(slaLabel({ ...base, status: 'CLOSED', dueAt: iso(-HOUR), overdue: true }).tone).toBe('none');
    expect(slaLabel(base).tone).toBe('none');
  });
});

describe('Case queue', () => {
  it('loads the caller\'s cases from the API with their bearer token', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Open case GH-2026-000001' })).toBeTruthy();
    const list = calls.find((c) => c.url.startsWith('/cases?'))!;
    expect(list.auth).toBe('Bearer tok-123');
    const r = within(screen.getByText('Potholes on market road').closest('tr')!);
    expect(r.getByText('Tema East')).toBeTruthy();
    expect(r.getByText('Received')).toBeTruthy();
    expect(r.getByText('Unassigned')).toBeTruthy();
    expect(r.getByText('Due in 3d')).toBeTruthy();
  });

  it('flags escalated and overdue cases', async () => {
    respond = (p) => (p.startsWith('/cases?') ? { status: 200, body: { items: [row({ escalated: true, priority: 'URGENT', overdue: true, dueAt: iso(-3 * HOUR) })], nextCursor: null } } : undefined);
    mount();
    const r = within((await screen.findByText('Potholes on market road')).closest('tr')!);
    expect(r.getByText('Escalated')).toBeTruthy();
    expect(r.getByText('Overdue by 3h')).toBeTruthy();
    expect(r.getByText('Urgent')).toBeTruthy();
  });

  it('shows the live counts and turns them into filters', async () => {
    mount();
    const group = await screen.findByRole('group', { name: 'Quick filters' });
    expect(within(group).getByRole('button', { name: /Unassigned: 2/ })).toBeTruthy();
    await userEvent.click(within(group).getByRole('button', { name: /Overdue: 1/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('overdue=true'))).toBe(true));
    await userEvent.click(within(group).getByRole('button', { name: /Escalated: 1/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('escalated=true') && !c.url.includes('overdue'))).toBe(true));
  });

  it('filters by status, assignee and search text on the server', async () => {
    mount();
    await screen.findByText('Potholes on market road');
    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'IN_PROGRESS');
    await userEvent.selectOptions(screen.getByLabelText('Filter by assignee'), 'me');
    await userEvent.type(screen.getByLabelText('Search cases'), 'pothole');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=IN_PROGRESS') && c.url.includes('assignee=me') && c.url.includes('search=pothole'))).toBe(true));
  });

  it('pages through results with the server cursor', async () => {
    respond = (p) => (p.startsWith('/cases?') ? (p.includes('cursor=abc') ? { status: 200, body: { items: [row({ id: 'case-2', reference: 'GH-2026-000002', title: 'Second case' })], nextCursor: null } } : { status: 200, body: { items: [row()], nextCursor: 'abc' } }) : undefined);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second case')).toBeTruthy();
    expect(screen.getByText('Potholes on market road')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says so when the queue is empty or nothing matches', async () => {
    respond = (p) => (p.startsWith('/cases?') ? { status: 200, body: { items: [], nextCursor: null } } : undefined);
    mount();
    expect(await screen.findByText('No cases in your queue.')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'CLOSED');
    expect(await screen.findByText('No cases match these filters.')).toBeTruthy();
  });

  it('asks to sign in on 401 and explains a 403 plainly', async () => {
    respond = (p) => (p.startsWith('/cases?') ? { status: 401, body: { message: 'Authentication required' } } : undefined);
    const first = mount();
    expect(await screen.findByLabelText('Access token')).toBeTruthy();
    first.unmount();
    respond = (p) => (p.startsWith('/cases?') ? { status: 403, body: { message: 'Insufficient role' } } : undefined);
    mount();
    expect((await screen.findByRole('alert')).textContent).toMatch(/not set up to handle citizen cases/);
  });

  it('opens a case from the queue', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Open case GH-2026-000001' }));
    expect(await screen.findByRole('heading', { name: /GH-2026-000001 - Potholes on market road/ })).toBeTruthy();
  });
});

describe('Case detail', () => {
  const open = () => mount('/cases?case=case-1');

  it('shows the citizen\'s words as written, the AI suggestion as a suggestion, and keeps internal notes distinct', async () => {
    open();
    expect((await screen.findByText(/The road has deep potholes\. Call me on 0244123456\./, { selector: 'blockquote' })).textContent).toBe('The road has deep potholes. Call me on 0244123456.');
    expect(screen.getByText(/keyword rule - not a person/)).toBeTruthy();
    expect(screen.getByText(/confidence 50%/)).toBeTruthy();
    const note = screen.getByText('Contractor is a relative of the MCE').closest('li')!;
    expect(within(note).getByText('Internal note')).toBeTruthy();
    expect(within(note).getByText('Not visible to the citizen')).toBeTruthy();
  });

  it('makes delivery success and failure visible, with the reason', async () => {
    open();
    const resp = (await screen.findByText('We will visit the site on Friday.')).closest('li')!;
    expect(within(resp).getByText(/Delivery failed via email/)).toBeTruthy();
    const table = screen.getByRole('heading', { name: 'Notifications to the citizen' }).closest('section')!;
    expect(within(table).getByText('Delivery failed')).toBeTruthy();
    expect(within(table).getByText('provider unavailable')).toBeTruthy();
  });

  it('offers exactly the status changes the server allows', async () => {
    open();
    const group = await screen.findByRole('group', { name: 'Move this case to' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['In progress', 'Awaiting information', 'Resolved', 'Closed']);
    await userEvent.click(within(group).getByRole('button', { name: 'In progress' }));
    await waitFor(() => expect(post('/cases/case-1/status')?.body).toEqual({ status: 'IN_PROGRESS' }));
    expect(await screen.findByText('Status changed to In progress.')).toBeTruthy();
  });

  it('refreshes and explains when someone else changed the case first (409)', async () => {
    respond = (p, m) => (m === 'POST' && p.endsWith('/status') ? { status: 409, body: { message: 'The case was changed by someone else. Reload and try again.' } } : undefined);
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Resolved' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed by someone else/);
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/cases/case-1').length).toBeGreaterThan(1);
  });

  it('fills the response box from an approved template, which can still be edited, then sends it', async () => {
    open();
    await userEvent.selectOptions(await screen.findByLabelText('Insert a template'), 't1');
    const box = screen.getByLabelText(/Response to the citizen/) as HTMLTextAreaElement;
    expect(box.value).toBe('Thank you. Your MP has noted this.');
    await userEvent.type(box, ' We will visit on Friday.');
    await userEvent.click(screen.getByRole('button', { name: 'Send response' }));
    await waitFor(() => expect(post('/cases/case-1/responses')?.body).toEqual({ content: 'Thank you. Your MP has noted this. We will visit on Friday.' }));
    expect(await screen.findByText('Response sent.')).toBeTruthy();
    expect((screen.getByLabelText(/Response to the citizen/) as HTMLTextAreaElement).value).toBe('');
  });

  it('will not send an empty response', async () => {
    open();
    expect(((await screen.findByRole('button', { name: 'Send response' })) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds an internal note without it going to the citizen endpoint', async () => {
    open();
    await userEvent.type(await screen.findByLabelText('Internal note (staff only)'), 'Called the contractor');
    await userEvent.click(screen.getByRole('button', { name: 'Add internal note' }));
    await waitFor(() => expect(post('/cases/case-1/notes')?.body).toEqual({ content: 'Called the contractor' }));
    expect(post('/cases/case-1/responses')).toBeUndefined();
  });

  it('assigns to someone who can handle the constituency, from the server\'s list', async () => {
    open();
    const sel = (await screen.findByLabelText('Assigned to')) as HTMLSelectElement;
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Unassigned', 'Ama Staff', 'Hon. Mensah']);
    await userEvent.selectOptions(sel, 'u2');
    await waitFor(() => expect(post('/cases/case-1/assign')?.body).toEqual({ assigneeId: 'u2' }));
  });

  it('lets staff correct the category and priority', async () => {
    open();
    await userEvent.selectOptions(await screen.findByLabelText('Category'), 'health');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ category: 'health' }));
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'HIGH');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').pop()?.body).toEqual({ priority: 'HIGH' }));
  });

  describe('escalated cases', () => {
    beforeEach(() => { current = detail({ escalated: true, escalationReason: 'Possible threat to personal safety', priority: 'URGENT' }); });

    it('stops ordinary staff from responding or lifting the escalation, and says why', async () => {
      open();
      expect(await screen.findByText(/Only the MP or an administrator can respond/)).toBeTruthy();
      await waitFor(() => expect((screen.getByLabelText(/Response to the citizen/) as HTMLTextAreaElement).disabled).toBe(true));
      expect(screen.getByRole('button', { name: 'Send response' }).hasAttribute('disabled')).toBe(true);
      expect(screen.queryByRole('button', { name: 'Lift escalation' })).toBeNull();
    });

    it('lets the MP respond and lift the escalation with a reason', async () => {
      roles = ['MP'];
      open();
      await waitFor(() => expect(calls.some((c) => c.url === '/me')).toBe(true));
      const lift = await screen.findByRole('button', { name: 'Lift escalation' });
      const prompt = vi.spyOn(window, 'prompt').mockReturnValue('police engaged');
      await userEvent.click(lift);
      await waitFor(() => expect(post('/cases/case-1/escalation')?.body).toEqual({ escalated: false, reason: 'police engaged' }));
      expect((screen.getByLabelText(/Response to the citizen/) as HTMLTextAreaElement).disabled).toBe(false);
      prompt.mockRestore();
    });
  });

  it('lets staff escalate with a reason, and does nothing if they give none', async () => {
    open();
    const btn = await screen.findByRole('button', { name: 'Escalate to MP' });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('');
    await userEvent.click(btn);
    expect(post('/cases/case-1/escalation')).toBeUndefined();
    prompt.mockReturnValueOnce('Caller mentioned a legal threat');
    await userEvent.click(btn);
    await waitFor(() => expect(post('/cases/case-1/escalation')?.body).toEqual({ escalated: true, reason: 'Caller mentioned a legal threat' }));
    prompt.mockRestore();
  });

  it('turns everything off for a closed case', async () => {
    current = detail({ status: 'CLOSED', allowedTransitions: [] });
    open();
    expect(await screen.findByText(/closed and cannot be changed/)).toBeTruthy();
    expect(screen.queryByLabelText(/Response to the citizen/)).toBeNull();
    expect(screen.queryByLabelText('Internal note (staff only)')).toBeNull();
    expect((screen.getByLabelText('Priority') as HTMLSelectElement).disabled).toBe(true);
  });

  it('exports the full history with the audit trail as a file (T-060)', async () => {
    let saved: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => { saved = b; return 'blob:x'; }) as any;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Export case history' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(saved!); });
    expect(JSON.parse(text)).toMatchObject({ case: { reference: 'GH-2026-000001' }, auditTrail: [{ action: 'case.submit' }] });
    expect(screen.getByText(/Handle it as confidential/)).toBeTruthy();
    click.mockRestore();
  });

  it('downloads an attachment using the bearer token', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x') as any;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    respond = (p) => (p.includes('/attachments/') ? { status: 200, body: {} } : undefined);
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const req = fetchMock.mock.calls.find((c) => String(c[0]).includes('/attachments/att-1'))!;
    expect((req[1] as RequestInit).headers).toEqual({ Authorization: 'Bearer tok-123' });
    click.mockRestore();
  });

  it('shows erase only to administrators, asks for a reason, and says what is kept', async () => {
    open();
    await screen.findByRole('button', { name: 'Export case history' });
    expect(screen.queryByRole('button', { name: 'Erase personal data' })).toBeNull();
    cleanup();
    roles = ['ADMIN'];
    open();
    const btn = await screen.findByRole('button', { name: 'Erase personal data' });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('citizen request');
    await userEvent.click(btn);
    await waitFor(() => expect(post('/cases/case-1/erase')?.body).toEqual({ reason: 'citizen request' }));
    expect(await screen.findByText(/non-identifying case record is kept/)).toBeTruthy();
    prompt.mockRestore();
  });

  it('explains that an anonymised case has had its personal data removed', async () => {
    current = detail({ anonymizedAt: iso(-HOUR), contact: null, allowedTransitions: ['CLOSED'] });
    open();
    expect(await screen.findByText(/Personal data was removed on/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Erase personal data' })).toBeNull();
    expect(screen.queryByLabelText(/Response to the citizen/)).toBeNull();
  });

  it('reports a case outside the user\'s constituencies as not found, not forbidden', async () => {
    respond = (p, m) => (m === 'GET' && p === '/cases/case-1' ? { status: 404, body: { message: 'Case not found' } } : undefined);
    open();
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not exist or is not in your constituencies/);
  });
});
