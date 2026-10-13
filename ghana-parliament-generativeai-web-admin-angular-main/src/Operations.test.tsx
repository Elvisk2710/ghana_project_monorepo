import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { ApprovalsScreen, AuditScreen, OverviewScreen, UsersScreen } from './GovernanceScreens';
import { BillsScreen, CommitteesScreen, MpsScreen, SittingsScreen } from './RecordsScreens';

type Reply = { status: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: any }[];
let respond: (path: string, method: string) => Reply;
let roles: string[];
let db: Record<string, unknown>;

const iso = (d = 0) => new Date(Date.now() + d * 86_400_000).toISOString();
const bill = (o = {}) => ({ id: 'b1', title: 'Petroleum Revenue Amendment Bill', sponsor: null, stage: 'COMMITTEE', committeeId: null, committee: null, isPublished: false, introducedOn: iso(-5), summary: null, ...o });
const sitting = (o = {}) => ({ id: 's1', date: iso(10), type: 'Plenary', status: 'SCHEDULED', agenda: [{ title: 'Statements' }], isPublished: false, _count: { documents: 2, bills: 1 }, ...o });
const mp = (o = {}) => ({ id: 'm1', officialName: 'Hon. Ama Mensah', party: 'NDC', roleTitle: null, publicContact: { office: 'Tema' }, constituencyId: 'c1', constituency: { code: 'GA-TE', name: 'Tema East' }, activeFrom: iso(-900), activeTo: null, isPublished: true, ...o });
const approval = (o = {}) => ({ id: 'a1', objectType: 'bill', objectId: 'b1', objectLabel: 'Petroleum Revenue Amendment Bill', action: 'publish', decision: 'PENDING', reason: null, evidence: null, requesterId: 'u-other', requester: { id: 'u-other', displayName: 'Ama Staff' }, approver: null, createdAt: iso(-1), decidedAt: null, ...o });
const user = (o = {}) => ({ id: 'u2', email: 'kofi@parliament.gh', displayName: 'Kofi Boateng', roles: ['STAFF'], active: true, invited: false, lastLoginAt: iso(-3), constituencies: [{ constituencyId: 'c1', constituency: { name: 'Tema East' } }], ...o });
const overview = (o = {}) => ({ generatedAt: iso(), documents: { PUBLISHED: 7, REVIEW: 2, APPROVED: 1 }, publishedChunks: 321, answers: { last7Days: 40, grounded: 30, groundedShare: 75 }, approvalsPending: 3, upcomingSittings: 2, billsByStage: { COMMITTEE: 4 }, cases: { open: 9, overdue: 2, escalated: 1, failedNotifications: 0 }, system: { deadJobs: 0, activeUsers: 12 }, ...o });

beforeEach(() => {
  calls = [];
  roles = ['STAFF'];
  respond = () => undefined;
  db = { bills: [bill()], sittings: [sitting()], committees: [{ id: 'k1', name: 'Finance Committee', remit: null, chairMpId: null, chair: null, isPublished: true, _count: { members: 3, bills: 1 } }], mps: [mp()], approvals: [] };
  sessionStorage.setItem('parliament.access_token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/internal', '').replace('/api/v1/public', '/public');
    const method = init.method ?? 'GET';
    calls.push({ url: path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const custom = respond(path, method);
    const out: NonNullable<Reply> = custom ?? (
      path === '/me' ? { status: 200, body: { userId: 'u-me', email: 'me@x', roles, constituencyIds: [] } }
      : path === '/public/constituencies' ? { status: 200, body: [{ id: 'c1', name: 'Tema East', region: 'Greater Accra' }] }
      : path === '/overview' ? { status: 200, body: overview() }
      : path.startsWith('/approvals') && method === 'GET' ? { status: 200, body: (db['approvals'] as { decision: string }[]).filter((a) => !path.includes('decision=PENDING') || a.decision === 'PENDING') }
      : path === '/bills' && method === 'GET' ? { status: 200, body: db['bills'] }
      : path.startsWith('/bills/') && method === 'GET' ? { status: 200, body: { ...bill(), sittings: [{ sittingId: 's1' }] } }
      : path === '/sittings' && method === 'GET' ? { status: 200, body: db['sittings'] }
      : path === '/committees' && method === 'GET' ? { status: 200, body: db['committees'] }
      : path.startsWith('/committees/') && method === 'GET' ? { status: 200, body: { id: 'k1', members: [{ mpId: 'm1', role: 'Member' }] } }
      : path === '/mps' && method === 'GET' ? { status: 200, body: db['mps'] }
      : path === '/users' ? { status: 200, body: db['users'] ?? [] }
      : path.startsWith('/audit-events') ? { status: 200, body: { items: [], nextCursor: null } }
      : method !== 'GET' ? { status: 201, body: {} }
      : { status: 404, body: {} });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const mount = (ui: React.ReactElement, path = '/') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
const posted = (suffix: string, method = 'POST') => calls.find((c) => c.method === method && c.url.endsWith(suffix));

describe('Records screens: persisted lists, and publication only by request', () => {
  it('loads bills from the API and offers editing and publication requests to STAFF', async () => {
    mount(<BillsScreen />);
    expect(await screen.findByText('Petroleum Revenue Amendment Bill')).toBeTruthy();
    expect(calls.some((c) => c.url === '/bills' && c.method === 'GET')).toBe(true);
    expect(await screen.findByRole('button', { name: '+ Add new' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request publishing' })).toBeTruthy();
    expect(screen.getByText('Not public')).toBeTruthy();
  });

  it('is read-only for people who cannot write (no add, edit or request buttons)', async () => {
    roles = ['REVIEWER'];
    mount(<BillsScreen />);
    await screen.findByText('Petroleum Revenue Amendment Bill');
    await waitFor(() => expect(calls.some((c) => c.url === '/me')).toBe(true));
    expect(screen.queryByRole('button', { name: '+ Add new' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request publishing' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
  });

  it('requests publication instead of publishing, then shows it as pending', async () => {
    mount(<BillsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Request publishing' }));
    await waitFor(() => expect(posted('/approvals')?.body).toEqual({ objectType: 'bill', objectId: 'b1', action: 'publish' }));
    expect(await screen.findByText(/different reviewer must approve it/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('shows a record with a pending decision as pending, without a second request button', async () => {
    db['approvals'] = [approval()];
    mount(<BillsScreen />);
    expect(await screen.findByText('Approval pending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request publishing' })).toBeNull();
  });

  it('asks for a reason before requesting withdrawal, and does nothing without one', async () => {
    db['bills'] = [bill({ isPublished: true })];
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('');
    mount(<BillsScreen />);
    const btn = await screen.findByRole('button', { name: 'Request withdrawal' });
    await userEvent.click(btn);
    expect(posted('/approvals')).toBeUndefined();
    prompt.mockReturnValueOnce('Sponsor withdrew it');
    await userEvent.click(btn);
    await waitFor(() => expect(posted('/approvals')?.body).toEqual({ objectType: 'bill', objectId: 'b1', action: 'unpublish', reason: 'Sponsor withdrew it' }));
    prompt.mockRestore();
  });

  it('creates a bill with its linked sittings, and never sends a publication flag', async () => {
    mount(<BillsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '+ Add new' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'New bill' }));
    await userEvent.type(dlg.getByLabelText('Title'), 'Education Amendment Bill');
    await userEvent.selectOptions(dlg.getByLabelText('Stage'), 'SECOND_READING');
    await userEvent.click(await dlg.findByRole('checkbox', { name: /Plenary/ }));
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/bills')?.body).toMatchObject({ title: 'Education Amendment Bill', stage: 'SECOND_READING', sittingIds: ['s1'] }));
    expect(JSON.stringify(posted('/bills')?.body)).not.toMatch(/isPublished/);
    expect(await screen.findByText('Bill created.')).toBeTruthy();
  });

  it('validates before saving and shows the server\'s reason when it refuses', async () => {
    mount(<BillsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '+ Add new' }));
    const dlg = within(await screen.findByRole('dialog'));
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    expect(dlg.getByRole('alert').textContent).toMatch(/at least 3 characters/);
    expect(posted('/bills')).toBeUndefined();
    respond = (p, m) => (m === 'POST' && p === '/bills' ? { status: 400, body: { message: 'One or more sittings do not exist' } } : undefined);
    await userEvent.type(dlg.getByLabelText('Title'), 'Valid title');
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    expect((await dlg.findByRole('alert')).textContent).toMatch(/sittings do not exist/);
  });

  it('edits a bill by PATCH and loads its linked sittings first', async () => {
    mount(<BillsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Petroleum Revenue Amendment Bill' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Edit bill' }));
    await waitFor(() => expect((dlg.getByRole('checkbox', { name: /Plenary/ }) as HTMLInputElement).checked).toBe(true));
    await userEvent.selectOptions(dlg.getByLabelText('Stage'), 'THIRD_READING');
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/bills/b1', 'PATCH')?.body).toMatchObject({ stage: 'THIRD_READING', sittingIds: ['s1'] }));
  });

  it('builds an order paper with agenda items linked to bills', async () => {
    mount(<SittingsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '+ Add new' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'New sitting' }));
    await userEvent.type(dlg.getByLabelText('Date'), '2026-12-01');
    await userEvent.click(dlg.getByRole('button', { name: '+ Add agenda item' }));
    await userEvent.type(dlg.getByLabelText('Agenda item 1 title'), 'Second reading');
    await dlg.findByRole('option', { name: 'Petroleum Revenue Amendment Bill' });
    await userEvent.selectOptions(dlg.getByLabelText('Agenda item 1 bill'), 'b1');
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/sittings')?.body).toMatchObject({ date: '2026-12-01', type: 'Plenary', agenda: [{ title: 'Second reading', billId: 'b1' }] }));
  });

  it('refuses an agenda item with no title', async () => {
    mount(<SittingsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '+ Add new' }));
    const dlg = within(await screen.findByRole('dialog'));
    await userEvent.type(dlg.getByLabelText('Date'), '2026-12-01');
    await userEvent.click(dlg.getByRole('button', { name: '+ Add agenda item' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    expect(dlg.getByRole('alert').textContent).toMatch(/needs a title/);
  });

  it('saves a committee with its chair and members', async () => {
    mount(<CommitteesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '+ Add new' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'New committee' }));
    await userEvent.type(dlg.getByLabelText('Name'), 'Health Committee');
    await dlg.findByRole('option', { name: /Ama Mensah/ });
    await userEvent.selectOptions(dlg.getByLabelText('Chair'), 'm1');
    await userEvent.click(dlg.getByRole('checkbox', { name: /Ama Mensah/ }));
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/committees')?.body).toMatchObject({ name: 'Health Committee', chairMpId: 'm1', members: [{ mpId: 'm1', role: 'Chair' }] }));
  });

  it('lets only administrators edit the MP directory', async () => {
    mount(<MpsScreen />);
    await screen.findByText('Hon. Ama Mensah');
    await waitFor(() => expect(calls.some((c) => c.url === '/me')).toBe(true));
    expect(screen.queryByRole('button', { name: '+ Add new' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit Hon/ })).toBeNull();
    cleanup();
    roles = ['ADMIN'];
    mount(<MpsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Hon. Ama Mensah' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Edit MP' }));
    await userEvent.clear(dlg.getByLabelText('Party'));
    await userEvent.type(dlg.getByLabelText('Party'), 'NPP');
    await userEvent.click(dlg.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/mps/m1', 'PATCH')?.body).toMatchObject({ party: 'NPP', publicContact: { office: 'Tema' } }));
    expect(JSON.stringify(posted('/mps/m1', 'PATCH')?.body)).not.toMatch(/isPublished/);
  });

  it('asks to sign in on 401', async () => {
    respond = (p) => (p === '/bills' ? { status: 401, body: { message: 'x' } } : undefined);
    mount(<BillsScreen />);
    expect(await screen.findByLabelText('Access token')).toBeTruthy();
  });
});

describe('Approvals ledger (T-067)', () => {
  it('lets a reviewer approve, with the decision sent to the server', async () => {
    roles = ['REVIEWER'];
    db['approvals'] = [approval()];
    mount(<ApprovalsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Petroleum Revenue Amendment Bill' }));
    await waitFor(() => expect(posted('/approvals/a1/decision')?.body).toEqual({ decision: 'APPROVED' }));
    expect(await screen.findByText(/Approved: Petroleum Revenue/)).toBeTruthy();
  });

  it('will not let you decide your own request, and says why', async () => {
    roles = ['ADMIN'];
    db['approvals'] = [approval({ requesterId: 'u-me', requester: { id: 'u-me', displayName: 'Me' } })];
    mount(<ApprovalsScreen />);
    expect(await screen.findByText('Waiting for another reviewer')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === '/me')).toBe(true));
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('shows no decision buttons to people who are not reviewers', async () => {
    db['approvals'] = [approval()];
    mount(<ApprovalsScreen />);
    expect(await screen.findByText('Reviewer decision needed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('requires an explanation to reject or request changes', async () => {
    roles = ['REVIEWER'];
    db['approvals'] = [approval()];
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('  ');
    mount(<ApprovalsScreen />);
    const reject = await screen.findByRole('button', { name: 'Reject Petroleum Revenue Amendment Bill' });
    await userEvent.click(reject);
    expect(posted('/approvals/a1/decision')).toBeUndefined();
    prompt.mockReturnValueOnce('Summary is wrong');
    await userEvent.click(reject);
    await waitFor(() => expect(posted('/approvals/a1/decision')?.body).toEqual({ decision: 'REJECTED', notes: 'Summary is wrong' }));
    prompt.mockRestore();
  });

  it('surfaces server refusals such as an edit after the request (409)', async () => {
    roles = ['REVIEWER'];
    db['approvals'] = [approval()];
    respond = (p, m) => (m === 'POST' && p.endsWith('/decision') ? { status: 409, body: { message: 'The record was edited after approval was requested. Ask for approval again.' } } : undefined);
    mount(<ApprovalsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /^Approve/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/edited after approval was requested/);
  });

  it('shows who asked, who decided and why', async () => {
    db['approvals'] = [approval({ decision: 'CHANGES_REQUESTED', evidence: { notes: 'Add a summary' }, approver: { id: 'r', displayName: 'Reviewer Rita' }, decidedAt: iso() })];
    mount(<ApprovalsScreen />);
    const row = within((await screen.findByText(/Bill: Petroleum Revenue/)).closest('tr')!);
    expect(row.getByText('Ama Staff')).toBeTruthy();
    expect(row.getByText('Changes requested')).toBeTruthy();
    expect(row.getByText('Add a summary')).toBeTruthy();
    expect(row.getByText(/Reviewer Rita/)).toBeTruthy();
  });

  it('filters by decision on the server', async () => {
    mount(<ApprovalsScreen />);
    await userEvent.selectOptions(await screen.findByLabelText('Filter by decision'), 'PENDING');
    await waitFor(() => expect(calls.some((c) => c.url === '/approvals?decision=PENDING')).toBe(true));
  });
});

describe('Users and roles (T-066)', () => {
  beforeEach(() => { roles = ['ADMIN']; db['users'] = [user(), user({ id: 'u3', displayName: 'New Person', email: 'new@parliament.gh', invited: true, lastLoginAt: null }), user({ id: 'u4', displayName: 'Old Timer', email: 'old@parliament.gh', lastLoginAt: iso(-200) }), user({ id: 'u-me', displayName: 'Me Admin', roles: ['ADMIN'] })]; });

  it('lists users with their real status and no self-deactivation', async () => {
    mount(<UsersScreen />);
    const row = within((await screen.findByText('New Person')).closest('tr')!);
    expect(row.getByText('Invited')).toBeTruthy();
    expect(row.getByText('Not yet')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Deactivate Me Admin' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Deactivate Kofi Boateng' })).toBeTruthy();
  });

  it('invites a user with roles and constituencies', async () => {
    mount(<UsersScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '+ Invite user' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Invite user' }));
    await userEvent.type(dlg.getByLabelText('Email'), 'amina@parliament.gh');
    await userEvent.type(dlg.getByLabelText('Name'), 'Amina Yusuf');
    await userEvent.click(dlg.getByRole('checkbox', { name: 'Reviewer' }));
    await userEvent.click(await dlg.findByRole('checkbox', { name: /Tema East/ }));
    await userEvent.click(dlg.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(posted('/users/invitations')?.body).toEqual({ email: 'amina@parliament.gh', displayName: 'Amina Yusuf', roles: ['STAFF', 'REVIEWER'], constituencyIds: ['c1'] }));
    expect(await screen.findByText(/get access when they first sign in with that email/)).toBeTruthy();
  });

  it('validates the invitation and shows server conflicts', async () => {
    respond = (p, m) => (m === 'POST' && p === '/users/invitations' ? { status: 409, body: { message: 'A user with that email already exists' } } : undefined);
    mount(<UsersScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '+ Invite user' }));
    const dlg = within(await screen.findByRole('dialog'));
    await userEvent.click(dlg.getByRole('button', { name: 'Send invitation' }));
    expect(dlg.getByRole('alert').textContent).toMatch(/valid email/);
    await userEvent.type(dlg.getByLabelText('Email'), 'dup@parliament.gh');
    await userEvent.type(dlg.getByLabelText('Name'), 'Dup');
    await userEvent.click(dlg.getByRole('button', { name: 'Send invitation' }));
    expect((await dlg.findByRole('alert')).textContent).toMatch(/already exists/);
  });

  it('changes roles by PATCH', async () => {
    mount(<UsersScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit access for Kofi Boateng' }));
    const dlg = within(await screen.findByRole('dialog'));
    await userEvent.click(dlg.getByRole('checkbox', { name: 'Mp' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(posted('/users/u2', 'PATCH')?.body).toMatchObject({ roles: ['STAFF', 'MP'], constituencyIds: ['c1'] }));
  });

  it('confirms before deactivating, and reports the server\'s protection of the last admin', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    mount(<UsersScreen />);
    const btn = await screen.findByRole('button', { name: 'Deactivate Kofi Boateng' });
    await userEvent.click(btn);
    expect(posted('/users/u2/active')).toBeUndefined();
    confirm.mockReturnValueOnce(true);
    respond = (p, m) => (m === 'POST' && p.endsWith('/active') ? { status: 409, body: { message: 'You cannot deactivate yourself or the last active administrator' } } : undefined);
    await userEvent.click(btn);
    await waitFor(() => expect(posted('/users/u2/active')?.body).toEqual({ active: false }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/last active administrator/);
    confirm.mockRestore();
  });

  it('offers an access review of people who have not signed in for 90 days', async () => {
    mount(<UsersScreen />);
    await screen.findByText('Kofi Boateng');
    await userEvent.click(screen.getByLabelText(/Access review/));
    expect(screen.getByText('Old Timer')).toBeTruthy();
    expect(screen.queryByText('Kofi Boateng')).toBeNull();
    expect(screen.queryByText('New Person')).toBeNull();
  });

  it('explains a 403 for non-administrators', async () => {
    respond = (p) => (p === '/users' ? { status: 403, body: { message: 'Insufficient role' } } : undefined);
    mount(<UsersScreen />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/role does not allow/);
  });
});

describe('Audit trail', () => {
  it('pages through events and filters on the server', async () => {
    const ev = (id: string, action: string) => ({ id, occurredAt: iso(), actorType: 'user', actorId: 'abcdef1234', actorRoles: ['ADMIN'], action, objectType: 'bill', objectId: 'b1234567', outcome: 'success' });
    respond = (p) => (p.startsWith('/audit-events') ? { status: 200, body: p.includes('cursor=c1') ? { items: [ev('e2', 'bill.update')], nextCursor: null } : { items: [ev('e1', 'bill.create')], nextCursor: 'c1' } } : undefined);
    mount(<AuditScreen />);
    expect(await screen.findByText('bill.create')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('bill.update')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Filter by record type'), 'case');
    await waitFor(() => expect(calls.some((c) => c.url.includes('objectType=case'))).toBe(true));
    expect(screen.getByText(/cannot be edited or deleted/)).toBeTruthy();
  });
});

describe('Overview (T-068) and the removal of sample data (T-069)', () => {
  it('shows live figures from the backend, not fixed numbers', async () => {
    mount(<OverviewScreen />);
    expect(await screen.findByText('321')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    const tile = (name: string) => within(screen.getByText(name).closest('article')!);
    expect(tile('Published documents').getByText('7')).toBeTruthy();
    expect(tile('Documents awaiting review').getByText('3')).toBeTruthy();
    expect(tile('Approvals waiting').getByText('3')).toBeTruthy();
    expect(tile('Open citizen cases').getByText('9')).toBeTruthy();
  });

  it('says so when there is no data rather than inventing a percentage', async () => {
    respond = (p) => (p === '/overview' ? { status: 200, body: overview({ answers: { last7Days: 0, grounded: 0, groundedShare: null } }) } : undefined);
    mount(<OverviewScreen />);
    expect(await screen.findByText('No questions yet')).toBeTruthy();
  });

  it('flags permanently failed background jobs', async () => {
    respond = (p) => (p === '/overview' ? { status: 200, body: overview({ system: { deadJobs: 2, activeUsers: 1 } }) } : undefined);
    mount(<OverviewScreen />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/2 background job/);
  });

  it('the app no longer contains any sample records or invented status labels', async () => {
    const { container } = mount(<App />, '/overview');
    await screen.findByText('321');
    const text = container.textContent ?? '';
    for (const fake of ['J. Ako', 'Ama Mensah', 'CASE-1042', 'Petroleum Revenue Amendment', 'Act 843 Compliant', 'ML Cluster', '94.6%', '142k', '12.4k', 'All systems operational']) expect(text).not.toContain(fake);
    expect(screen.getByText(/Approvals waiting:/).textContent).toContain('3');
    expect(screen.getByText(/Corpus:/).textContent).toContain('7 published');
  });

  it('an address outside the console says the page was not found', async () => {
    mount(<App />, '/nowhere');
    expect(await screen.findByText('We could not find that page.')).toBeTruthy();
    expect(screen.queryByText('Not available yet')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('every screen that was static now calls the API after a reload (nothing lives only in memory)', async () => {
    for (const [path, api] of [['/sittings', '/sittings'], ['/bills', '/bills'], ['/committees', '/committees'], ['/mps', '/mps'], ['/approvals', '/approvals'], ['/users', '/users']] as const) {
      calls = [];
      const { unmount } = mount(<App />, path);
      await waitFor(() => expect(calls.some((c) => c.url.startsWith(api) && c.method === 'GET')).toBe(true));
      unmount();
    }
  });
});
