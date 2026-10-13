import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { LanguageProvider } from './language';

type Out = { status: number; body?: unknown } | 'network-error' | undefined;
type Route = (url: string, init: RequestInit) => Out;
let routes: Route[];
let calls: { url: string; method: string; body?: any }[];

const LANGS = [{ code: 'en', name: 'English', level: 'supported', note: 'x' }];
const TEMA = { id: 'c-tema', code: 'GA-TE', name: 'Tema East', region: 'Greater Accra' };
const MP = { id: 'mp1', name: 'Hon. Ama Mensah', party: 'NDC', roleTitle: null, contact: { office: 'Tema Community 1 office' }, since: '2021-01-07' };

function mount(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><LanguageProvider><App /></LanguageProvider></MemoryRouter>);
}

beforeEach(() => {
  calls = [];
  routes = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/public', '');
    calls.push({ url: path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    for (const r of routes) {
      const out = r(path, init);
      if (out === 'network-error') throw new TypeError('Failed to fetch');
      if (out) return new Response(JSON.stringify(out.body ?? {}), { status: out.status });
    }
    if (path === '/languages') return new Response(JSON.stringify(LANGS), { status: 200 });
    if (path === '/regions') return new Response(JSON.stringify(['Greater Accra']), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
const on = (method: string, prefix: string, out: Out): Route => (u, i) => ((i.method ?? 'GET') === method && u.startsWith(prefix) ? out : undefined);

describe('Meeting request', () => {
  it('lets a citizen request a meeting inside the MP’s published availability', async () => {
    routes.push(on('GET', '/constituencies/lookup', { status: 200, body: { query: 'Tema East', matches: [{ constituency: TEMA, matchedOn: 'exact_name', explanation: 'x', mp: MP }] } }));
    routes.push(on('GET', '/mps/mp1/availability', { status: 200, body: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] }));
    routes.push(on('POST', '/meetings', { status: 201, body: { id: 'mt1', status: 'REQUESTED', requestedSlot: '2026-10-19T10:00:00.000Z', durationMinutes: 30 } }));

    mount('/my-mp');
    await userEvent.type(screen.getByLabelText('Constituency, area or town'), 'Tema East');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    await screen.findByText('Hon. Ama Mensah');

    await userEvent.click(screen.getByRole('button', { name: /Request a meeting with Hon\. Ama Mensah/ }));
    expect(await screen.findByText(/Mondays, 09:00/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Your name'), 'Kofi Mensah');
    await userEvent.type(screen.getByLabelText('What is it about?'), 'Road repairs');
    await userEvent.selectOptions(screen.getByLabelText('Available time'), '0');
    await userEvent.type(screen.getByLabelText('Date'), '2026-10-19');
    await userEvent.type(screen.getByLabelText('Time'), '10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText(/meeting request has been sent/)).toBeTruthy();
    const posted = calls.find((c) => c.url === '/meetings' && c.method === 'POST');
    expect(posted!.body).toMatchObject({ mpId: 'mp1', requestedName: 'Kofi Mensah', topic: 'Road repairs' });
  });

  it('shows a plain message when the office has not published any available times', async () => {
    routes.push(on('GET', '/constituencies/lookup', { status: 200, body: { query: 'Tema East', matches: [{ constituency: TEMA, matchedOn: 'exact_name', explanation: 'x', mp: MP }] } }));
    routes.push(on('GET', '/mps/mp1/availability', { status: 200, body: [] }));
    mount('/my-mp');
    await userEvent.type(screen.getByLabelText('Constituency, area or town'), 'Tema East');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    await userEvent.click(await screen.findByRole('button', { name: /Request a meeting/ }));
    expect(await screen.findByText('This office has not published any available times yet.')).toBeTruthy();
  });
});

describe('Policy-impact feedback', () => {
  const assentedBill = { id: 'b1', title: 'Sanitation Levy Act', sponsor: null, stage: 'ASSENTED', introducedOn: null, committee: null, summary: null, sittings: [], documents: [] };
  const draftBill = { ...assentedBill, stage: 'FIRST_READING' as const };

  it('shows the feedback form once a bill has been assented, and submits a choice', async () => {
    routes.push(on('GET', '/bills/b1', { status: 200, body: assentedBill }));
    routes.push(on('POST', '/bills/b1/feedback', { status: 201, body: { id: 'f1', thankYou: 'Thank you. Your feedback on this policy has been recorded.' } }));
    mount('/bills/b1');
    expect(await screen.findByText('Tell Parliament how this is working')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('This is working well'));
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByText(/Thank you\. Your feedback/)).toBeTruthy();
    const posted = calls.find((c) => c.url === '/bills/b1/feedback' && c.method === 'POST');
    expect(posted!.body).toEqual({ sentiment: 'POSITIVE' });
  });

  it('does not show the feedback form for a bill that is not yet in force', async () => {
    routes.push(on('GET', '/bills/b1', { status: 200, body: draftBill }));
    mount('/bills/b1');
    await screen.findByText('Sanitation Levy Act');
    expect(screen.queryByText('Tell Parliament how this is working')).toBeNull();
  });
});
