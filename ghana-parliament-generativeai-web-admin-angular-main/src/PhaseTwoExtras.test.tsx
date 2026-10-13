import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CasesScreen from './CasesScreen';
import { BillsScreen, SittingsScreen } from './RecordsScreens';

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Reply = { status: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: any }[];
let respond: (path: string, method: string) => Reply;

function stubFetch(extra: (path: string, method: string) => Reply) {
  calls = [];
  respond = extra;
  sessionStorage.setItem('parliament.access_token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/internal', '').replace('/api/v1/public', '/public');
    const method = init.method ?? 'GET';
    calls.push({ url: path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const custom = respond(path, method);
    const out: NonNullable<Reply> = custom ?? { status: 404, body: {} };
    return new Response(JSON.stringify(out.body), { status: out.status });
  }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const mount = (ui: React.ReactElement, path = '/') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

describe('Per-sitting AI summary', () => {
  const sitting = { id: 's1', date: iso(10 * 24 * HOUR), type: 'Plenary', status: 'SCHEDULED', agenda: [], isPublished: false, _count: { documents: 1, bills: 0 } };

  it('is honest when no AI provider is configured, and does not fabricate a summary', async () => {
    stubFetch((path, method) => (
      path === '/me' ? { status: 200, body: { userId: 'u', email: 'a@b', roles: ['STAFF'], constituencyIds: ['c1'] } }
      : path === '/sittings' && method === 'GET' ? { status: 200, body: [sitting] }
      : path === '/sittings/s1/summary' && method === 'GET' ? { status: 200, body: null }
      : path === '/sittings/s1/summary' && method === 'POST' ? { status: 201, body: { status: 'UNAVAILABLE', topics: null, decisions: null, mpContributions: null, model: null, unavailableReason: 'No AI provider is configured yet.', generatedAt: null } }
      : path.startsWith('/approvals') ? { status: 200, body: [] }
      : undefined
    ));
    mount(<SittingsScreen />);
    const open = await screen.findByRole('button', { name: /AI summary/i });
    await userEvent.click(open);
    expect(await screen.findByText('No summary has been requested for this sitting yet.')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Request a summary' }));
    expect(await screen.findByText('No AI provider is configured yet.')).toBeTruthy();
  });

  it('shows topics, decisions and MP contributions once a summary is available', async () => {
    stubFetch((path, method) => (
      path === '/me' ? { status: 200, body: { userId: 'u', email: 'a@b', roles: ['STAFF'], constituencyIds: ['c1'] } }
      : path === '/sittings' && method === 'GET' ? { status: 200, body: [sitting] }
      : path === '/sittings/s1/summary' && method === 'GET' ? { status: 200, body: { status: 'AVAILABLE', topics: ['Fuel prices'], decisions: ['Referred to committee'], mpContributions: [{ mp: 'Hon. Mensah', point: 'Raised transport costs' }], model: 'claude-sonnet-5-5', unavailableReason: null, generatedAt: iso(0) } }
      : path.startsWith('/approvals') ? { status: 200, body: [] }
      : undefined
    ));
    mount(<SittingsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /AI summary/i }));
    expect(await screen.findByText('Fuel prices')).toBeTruthy();
    expect(await screen.findByText('Referred to committee')).toBeTruthy();
    expect(await screen.findByText(/Raised transport costs/)).toBeTruthy();
  });
});

describe('Policy-impact feedback on an assented bill', () => {
  const assentedBill = { id: 'b1', title: 'Sanitation Levy Act', sponsor: null, stage: 'ASSENTED', committeeId: null, committee: null, isPublished: true, introducedOn: iso(-30 * 24 * HOUR), summary: null };

  it('shows the staff-facing aggregate once feedback exists', async () => {
    stubFetch((path, method) => (
      path === '/me' ? { status: 200, body: { userId: 'u', email: 'a@b', roles: ['STAFF'], constituencyIds: ['c1'] } }
      : path === '/bills' && method === 'GET' ? { status: 200, body: [assentedBill] }
      : path === '/bills/b1/feedback' ? { status: 200, body: { billId: 'b1', total: 2, byLabel: { POSITIVE: 1, NEUTRAL: 0, NEGATIVE: 1 }, recentComments: [{ sentiment: 'NEGATIVE', comment: 'The levy is too high.', createdAt: iso(0) }] } }
      : path.startsWith('/approvals') ? { status: 200, body: [] }
      : undefined
    ));
    mount(<BillsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /Policy feedback/i }));
    expect(await screen.findByText('Negative: 1')).toBeTruthy();
    expect(await screen.findByText('The levy is too high.')).toBeTruthy();
  });
});

describe('AI-drafted case response', () => {
  const caseDetail = {
    id: 'case-1', publicId: 'GH-2026-000001', title: 'Potholes', status: 'TRIAGED', priority: 'NORMAL', category: 'roads_infrastructure', escalated: false, escalationReason: null,
    constituency: { id: 'con-1', name: 'Tema East', region: 'Greater Accra' }, assignee: null, createdAt: iso(-HOUR), dueAt: iso(48 * HOUR), firstResponseAt: null, closedAt: null,
    retainUntil: null, anonymizedAt: null, overdue: false, locationText: null, preferredLanguage: 'en', consentGivenAt: iso(-HOUR), consentPurpose: 'p',
    contact: null, aiClassification: { category: 'roads_infrastructure', confidence: 0.5, summary: 's', method: 'keyword-rules-v1' },
    allowedTransitions: ['IN_PROGRESS'], messages: [], events: [], attachments: [], notifications: [],
  };

  it('fills the reply box from the draft when an AI provider is configured', async () => {
    stubFetch((path, method) => (
      path === '/me' ? { status: 200, body: { userId: 'u1', email: 'a@b', roles: ['STAFF'], constituencyIds: ['con-1'] } }
      : path === '/cases/case-1' && method === 'GET' ? { status: 200, body: caseDetail }
      : path === '/cases/case-1/assignees' ? { status: 200, body: [] }
      : path === '/message-templates' ? { status: 200, body: [] }
      : path === '/cases/case-1/draft-response' ? { status: 200, body: { available: true, draft: 'We are aware of the issue and have referred it to the roads agency.', model: 'claude-sonnet-5-5', note: 'This is an AI-drafted suggestion. Review and edit it before sending.' } }
      : undefined
    ));
    mount(<CasesScreen />, '/cases?case=case-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Get an AI-drafted suggestion' }));
    expect(await screen.findByDisplayValue(/We are aware of the issue/)).toBeTruthy();
    expect(await screen.findByText(/Review and edit it before sending/)).toBeTruthy();
  });

  it('is honest when no AI provider is configured, and never fabricates a draft', async () => {
    stubFetch((path, method) => (
      path === '/me' ? { status: 200, body: { userId: 'u1', email: 'a@b', roles: ['STAFF'], constituencyIds: ['con-1'] } }
      : path === '/cases/case-1' && method === 'GET' ? { status: 200, body: caseDetail }
      : path === '/cases/case-1/assignees' ? { status: 200, body: [] }
      : path === '/message-templates' ? { status: 200, body: [] }
      : path === '/cases/case-1/draft-response' ? { status: 200, body: { available: false, reason: 'No AI provider is configured yet.' } }
      : undefined
    ));
    mount(<CasesScreen />, '/cases?case=case-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Get an AI-drafted suggestion' }));
    expect(await screen.findByText('No AI provider is configured yet.')).toBeTruthy();
  });
});
