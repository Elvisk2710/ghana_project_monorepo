import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { LanguageProvider } from './language';
import { validate } from './pages/NewIssuePage';

type Out = { status: number; body?: unknown } | 'network-error' | undefined;
type Route = (url: string, init: RequestInit) => Out;
let routes: Route[];
let calls: { url: string; method: string; body?: any; headers: Record<string, string> }[];

const LANGS = [{ code: 'en', name: 'English', level: 'supported', note: 'Questions and answers in English.' }];
const TEMA = { id: 'c-tema', code: 'GA-TE', name: 'Tema East', region: 'Greater Accra' };
const TAMALE = { id: 'c-tam', code: 'NR-TC', name: 'Tamale Central', region: 'Northern' };
const MP = { id: 'mp1', name: 'Hon. Ama Mensah', party: 'NDC', roleTitle: null, contact: { office: 'Tema Community 1 office' }, since: '2021-01-07' };
const CATS = [{ id: 'roads_infrastructure', label: 'Roads and infrastructure' }, { id: 'health', label: 'Health' }, { id: 'other', label: 'Something else' }];
const STORY = 'The road to the market has deep potholes and floods when it rains.';

const caseView = (over: Record<string, unknown> = {}) => ({
  reference: 'GH-2026-000123', title: 'Potholes on market road', status: 'IN_PROGRESS', statusLabel: 'In progress', category: 'Roads and infrastructure',
  constituency: 'Tema East', receivedAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z', awaitingYourReply: false, canReply: true, anonymized: false,
  history: [{ status: 'RECEIVED', label: 'Received', at: '2026-10-01T09:00:00.000Z' }, { status: 'TRIAGED', label: 'Triaged', at: '2026-10-01T12:00:00.000Z' }, { status: 'IN_PROGRESS', label: 'In progress', at: '2026-10-02T09:00:00.000Z' }],
  messages: [{ id: 'm1', from: 'you', content: STORY, at: '2026-10-01T09:00:00.000Z' }, { id: 'm2', from: 'constituency_office', content: 'We have scheduled a site visit.', at: '2026-10-02T09:00:00.000Z' }],
  attachments: [{ id: 'a1', filename: 'photo.png', sizeBytes: 20480, mimeType: 'image/png' }], ...over,
});

function mount(path: string | { pathname: string; hash?: string; state?: unknown } = '/') {
  return render(<MemoryRouter initialEntries={[path as any]}><LanguageProvider><App /></LanguageProvider></MemoryRouter>);
}

beforeEach(() => {
  calls = [];
  routes = [];
  localStorage.clear();
  window.scrollTo = vi.fn() as any;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/public', '');
    calls.push({ url: path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, headers: (init.headers ?? {}) as Record<string, string> });
    for (const r of routes) {
      const out = r(path, init);
      if (out === 'network-error') throw new TypeError('Failed to fetch');
      if (out) return new Response(JSON.stringify(out.body ?? {}), { status: out.status });
    }
    if (path === '/languages') return new Response(JSON.stringify(LANGS), { status: 200 });
    if (path === '/regions') return new Response(JSON.stringify(['Greater Accra', 'Northern']), { status: 200 });
    if (path === '/case-categories') return new Response(JSON.stringify(CATS), { status: 200 });
    if (path === '/constituencies') return new Response(JSON.stringify([TEMA, TAMALE]), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const on = (method: string, prefix: string, out: Out): Route => (u, i) => ((i.method ?? 'GET') === method && u.startsWith(prefix) ? out : undefined);

// ------------------------------------------------------------------ Find my MP (T-050)
describe('Find my MP', () => {
  const lookup = (matches: unknown[]) => on('GET', '/constituencies/lookup', { status: 200, body: { query: 'q', matches } });

  it('shows the match, HOW it was matched, and the published MP', async () => {
    routes.push(lookup([{ constituency: TEMA, matchedOn: 'exact_name', explanation: 'You searched for "Tema East", which is the official name of the Tema East constituency.', mp: MP }]));
    mount('/my-mp');
    await userEvent.type(screen.getByLabelText('Constituency, area or town'), 'Tema East');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    expect(await screen.findByText(/official name of the Tema East constituency/)).toBeTruthy();
    expect(screen.getByText('How we matched this:')).toBeTruthy();
    expect(screen.getByText('Exact match')).toBeTruthy();
    expect(screen.getByText('Hon. Ama Mensah')).toBeTruthy();
    expect(screen.getByText('Tema Community 1 office')).toBeTruthy();
    expect(calls.find((c) => c.url.startsWith('/constituencies/lookup'))!.url).toContain('q=Tema+East');
    expect(screen.getByRole('link', { name: /Raise an issue with Tema East/ }).getAttribute('href')).toBe('/issues/new?constituency=c-tema');
  });

  it('labels partial matches as partial and lists every candidate', async () => {
    routes.push(lookup([
      { constituency: TEMA, matchedOn: 'starts_with', explanation: '"Tema" is the start of the constituency name Tema East. Check this is the right one.', mp: MP },
      { constituency: { ...TEMA, id: 'c-tw', name: 'Tema West' }, matchedOn: 'starts_with', explanation: '"Tema" is the start of the constituency name Tema West. Check this is the right one.', mp: null },
    ]));
    mount('/my-mp');
    await userEvent.type(screen.getByLabelText('Constituency, area or town'), 'Tema');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    expect(await screen.findByRole('heading', { name: /2 matches/ })).toBeTruthy();
    expect(screen.getAllByText('Partial match')).toHaveLength(2);
    expect(screen.getAllByText(/Check this is the right one\./)).toHaveLength(2);
  });

  it('says so plainly when there is no published MP, without inventing one', async () => {
    routes.push(lookup([{ constituency: TAMALE, matchedOn: 'exact_name', explanation: 'x', mp: null }]));
    mount('/my-mp');
    await userEvent.type(screen.getByLabelText('Constituency, area or town'), 'Tamale Central');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    expect(await screen.findByText(/No published MP record is available for Tamale Central yet/)).toBeTruthy();
  });

  it('does not guess when nothing matches', async () => {
    routes.push(lookup([]));
    mount('/my-mp');
    await userEvent.type(screen.getByLabelText('Constituency, area or town'), 'Atlantis');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    expect(await screen.findByText(/We will not guess/)).toBeTruthy();
  });

  it('shows an error state and does not search for fewer than two characters', async () => {
    routes.push(on('GET', '/constituencies/lookup', 'network-error'));
    mount('/my-mp');
    const input = screen.getByLabelText('Constituency, area or town');
    await userEvent.type(input, 'T');
    expect((screen.getByRole('button', { name: 'Find my MP' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(input, 'e');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/offline/);
  });

  it('lets people choose from the official list when they do not know the name', async () => {
    routes.push(on('GET', '/constituencies?region=Greater+Accra', { status: 200, body: [TEMA] }), on('GET', '/constituencies/c-tema', { status: 200, body: { constituency: TEMA, mp: MP } }));
    mount('/my-mp');
    await screen.findByRole('option', { name: 'Greater Accra' });
    await userEvent.selectOptions(screen.getByLabelText('Region'), 'Greater Accra');
    await screen.findByRole('option', { name: 'Tema East' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Constituency' }), 'c-tema');
    expect(await screen.findByText(/You chose Tema East from the official list/)).toBeTruthy();
    expect(screen.getByText('Hon. Ama Mensah')).toBeTruthy();
  });
});

// ------------------------------------------------------------------ Issue form (T-051, T-052)
describe('Issue submission', () => {
  const fillStory = async (over: { category?: string } = {}) => {
    await screen.findByRole('option', { name: /Tema East/ });
    await userEvent.selectOptions(screen.getByLabelText('Constituency'), 'c-tema');
    await screen.findByRole('option', { name: 'Health' });
    await userEvent.selectOptions(screen.getByLabelText('Category'), over.category ?? 'health');
    await userEvent.type(screen.getByLabelText('Short title'), 'Potholes on market road');
    await userEvent.type(screen.getByLabelText('Describe your issue'), `  ${STORY}  `);
  };
  const suggestion = (category: string, label: string) => on('POST', '/cases/suggest', { status: 200, body: { category, categoryLabel: label, confidence: 0.7, summary: 's', method: 'keyword-rules-v1', note: 'This is an automatic suggestion. You choose the category and your own words are never changed.' } });

  it('validates every required field and sends nothing', async () => {
    mount('/issues/new');
    await screen.findByRole('option', { name: /Tema East/ });
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/Choose your constituency[\s\S]*category[\s\S]*short title[\s\S]*few words[\s\S]*agreement/i);
    expect(document.activeElement?.id).toBe('constituency');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('validates contact details for the chosen channel and requires consent', () => {
    const base = { constituencyId: 'c', category: 'health', title: 'Title', description: 'A long enough description', locationText: '', channel: 'NONE' as const, name: '', email: '', phone: '', consent: false };
    expect(validate(base)).toEqual({ consent: expect.any(String) });
    expect(validate({ ...base, consent: true })).toEqual({});
    expect(validate({ ...base, consent: true, channel: 'EMAIL', email: 'nope' }).email).toBeTruthy();
    expect(validate({ ...base, consent: true, channel: 'EMAIL', email: 'a@b.gh' }).email).toBeUndefined();
    expect(validate({ ...base, consent: true, channel: 'SMS', phone: '12' }).phone).toBeTruthy();
    expect(validate({ ...base, consent: true, channel: 'SMS', phone: '+233 24 412 3456' }).phone).toBeUndefined();
  });

  it('preselects the constituency chosen on Find my MP', async () => {
    mount('/issues/new?constituency=c-tema');
    await screen.findByRole('option', { name: /Tema East/ });
    await waitFor(() => expect((screen.getByLabelText('Constituency') as HTMLSelectElement).value).toBe('c-tema'));
  });

  it('shows a review with the citizen\'s own words and sends nothing until they confirm', async () => {
    routes.push(suggestion('roads_infrastructure', 'Roads and infrastructure'));
    mount('/issues/new');
    await fillStory();
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    expect(await screen.findByRole('heading', { name: 'Review your issue' })).toBeTruthy();
    expect(screen.getByText(STORY, { selector: 'blockquote' })).toBeTruthy();
    expect(screen.getByText(/sent exactly as written/)).toBeTruthy();
    expect(calls.some((c) => c.url === '/cases' && c.method === 'POST')).toBe(false);
  });

  it('offers the AI category as a choice, keeps the citizen\'s own by default, and never edits their words', async () => {
    routes.push(suggestion('roads_infrastructure', 'Roads and infrastructure'), on('POST', '/cases', { status: 201, body: { reference: 'GH-2026-000123', trackingCode: 'code-abc', status: 'RECEIVED', statusLabel: 'Received', receivedAt: 'x', duplicate: false } }), on('GET', '/cases/GH-2026-000123', { status: 200, body: caseView({ status: 'RECEIVED' }) }));
    mount('/issues/new');
    await fillStory();
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    const keep = (await screen.findByLabelText(/Keep my choice/)) as HTMLInputElement;
    const use = screen.getByLabelText(/Use the suggestion/) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    expect(use.checked).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and submit' }));
    const post = await waitFor(() => { const c = calls.find((x) => x.url === '/cases' && x.method === 'POST'); expect(c).toBeTruthy(); return c!; });
    expect(post.body).toMatchObject({ category: 'health', description: STORY, title: 'Potholes on market road', constituencyId: 'c-tema', consent: true, contact: { channel: 'NONE' } });
    expect(post.body.submissionKey).toMatch(/^[0-9a-f-]{36}$/);
    // Lands on the tracking page with the code shown once.
    expect(await screen.findByText('code-abc')).toBeTruthy();
    expect(calls.find((c) => c.url === '/cases/GH-2026-000123')!.headers['X-Case-Token']).toBe('code-abc');
  });

  it('sends the suggested category only when the citizen picks it', async () => {
    routes.push(suggestion('roads_infrastructure', 'Roads and infrastructure'), on('POST', '/cases', { status: 201, body: { reference: 'GH-2026-000123', trackingCode: 'c', status: 'RECEIVED', statusLabel: 'Received', receivedAt: 'x', duplicate: false } }));
    mount('/issues/new');
    await fillStory();
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    await userEvent.click(await screen.findByLabelText(/Use the suggestion/));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and submit' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/cases' && c.method === 'POST')?.body.category).toBe('roads_infrastructure'));
  });

  it('keeps the same submission key when a failed send is retried, so no duplicate is created', async () => {
    let attempt = 0;
    routes.push(suggestion('health', 'Health'), (u, i) => (u === '/cases' && i.method === 'POST' ? (++attempt === 1 ? 'network-error' : { status: 201, body: { reference: 'GH-2026-000124', trackingCode: 'c2', status: 'RECEIVED', statusLabel: 'Received', receivedAt: 'x', duplicate: true } }) : undefined));
    mount('/issues/new');
    await fillStory();
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm and submit' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/offline[\s\S]*not lost/);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and submit' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/cases' && c.method === 'POST')).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.url === '/cases' && c.method === 'POST');
    expect(a.body.submissionKey).toBe(b.body.submissionKey);
  });

  it('sends contact details only for the channel the citizen chose', async () => {
    routes.push(suggestion('health', 'Health'), on('POST', '/cases', { status: 201, body: { reference: 'GH-2026-000125', trackingCode: 'c', status: 'RECEIVED', statusLabel: 'Received', receivedAt: 'x', duplicate: false } }));
    mount('/issues/new');
    await fillStory();
    await userEvent.click(screen.getByLabelText('SMS'));
    await userEvent.type(screen.getByLabelText('Phone number'), '0244123456');
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm and submit' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/cases' && c.method === 'POST')).toBeTruthy());
    expect(calls.find((c) => c.url === '/cases' && c.method === 'POST')!.body.contact).toEqual({ channel: 'SMS', phone: '0244123456' });
  });

  it('shows the server\'s explanation if a submission is refused', async () => {
    routes.push(suggestion('health', 'Health'), on('POST', '/cases', { status: 400, body: { message: 'Unknown constituency' } }));
    mount('/issues/new');
    await fillStory();
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm and submit' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Unknown constituency/);
  });

  it('still lets the citizen submit when the suggestion service is down', async () => {
    routes.push(on('POST', '/cases/suggest', { status: 500 }));
    mount('/issues/new');
    await fillStory();
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    expect(await screen.findByText(/suggestion is not available right now/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm and submit' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ------------------------------------------------------------------ Issues landing + tracking page (T-053)
describe('Tracking an issue', () => {
  it('puts the tracking code in the URL fragment, never in the path or query', async () => {
    routes.push(on('GET', '/cases/GH-2026-000123', { status: 200, body: caseView() }));
    mount('/issues');
    await userEvent.type(screen.getByLabelText('Reference'), 'gh-2026-000123');
    await userEvent.type(screen.getByLabelText('Tracking code'), 'secret-code');
    await userEvent.click(screen.getByRole('button', { name: 'See my issue' }));
    expect(await screen.findByRole('heading', { name: 'Potholes on market road' })).toBeTruthy();
    const req = calls.find((c) => c.url.startsWith('/cases/GH-2026-000123'))!;
    expect(req.url).toBe('/cases/GH-2026-000123');
    expect(req.headers['X-Case-Token']).toBe('secret-code');
  });

  it('asks for both fields', async () => {
    mount('/issues');
    await userEvent.click(screen.getByRole('button', { name: 'See my issue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/both your reference and your tracking code/);
    expect(calls.some((c) => c.url.startsWith('/cases/'))).toBe(false);
  });

  const open = (view = caseView(), extra: Route[] = []) => {
    routes.push(on('GET', '/cases/GH-2026-000123', { status: 200, body: view }), ...extra);
    return mount({ pathname: '/issues/GH-2026-000123', hash: '#code=tok123' });
  };

  it('shows all six statuses, marks the current one, and shows history and the conversation', async () => {
    open();
    await screen.findByRole('heading', { name: 'Potholes on market road' });
    const items = within(screen.getByRole('heading', { name: 'Where it stands' }).closest('section')!).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('span')!.textContent)).toEqual(['Received', 'Triaged', 'In progress', 'Awaiting information from you', 'Resolved', 'Closed']);
    expect(items[2].getAttribute('aria-current')).toBe('step');
    expect(items[2].textContent).toMatch(/\(current\)/);
    expect(items[0].textContent).toMatch(/\(done\)/);
    expect(screen.getByText('We have scheduled a site visit.')).toBeTruthy();
    expect(screen.getByText('Constituency office')).toBeTruthy();
  });

  it('never shows anything internal', async () => {
    const { container } = open();
    await screen.findByRole('heading', { name: 'Potholes on market road' });
    expect(container.textContent).not.toMatch(/internal|assignee|escalat|confidence|aiSuggested/i);
  });

  it('tells the citizen when the office is waiting for them', async () => {
    open(caseView({ status: 'AWAITING_INFORMATION', statusLabel: 'Awaiting information', awaitingYourReply: true }));
    expect((await screen.findByText(/waiting for your reply/)).getAttribute('role')).toBe('status');
  });

  it('sends a follow-up reply with the tracking code and shows the updated case', async () => {
    const updated = caseView({ messages: [...caseView().messages, { id: 'm3', from: 'you', content: 'It is near the junction.', at: '2026-10-03T09:00:00.000Z' }] });
    open(caseView(), [on('POST', '/cases/GH-2026-000123/messages', { status: 200, body: updated })]);
    await userEvent.type(await screen.findByLabelText('Add a reply'), 'It is near the junction.');
    await userEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByText('Your reply was sent to the constituency office.')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ content: 'It is near the junction.' });
    expect(post.headers['X-Case-Token']).toBe('tok123');
    expect(screen.getAllByText('It is near the junction.').length).toBeGreaterThan(0);
  });

  it('will not send an empty reply', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Send reply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Write your reply first/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('turns replies and uploads off for a closed case', async () => {
    open(caseView({ status: 'CLOSED', statusLabel: 'Closed', canReply: false }));
    await screen.findByRole('heading', { name: 'Potholes on market road' });
    expect(screen.queryByLabelText('Add a reply')).toBeNull();
    expect(screen.queryByLabelText('Add a file')).toBeNull();
    expect(screen.getByText(/This case is closed, so replies are turned off/)).toBeTruthy();
  });

  it('explains when personal details have been removed', async () => {
    open(caseView({ title: null, anonymized: true, canReply: false, messages: [], attachments: [] }));
    expect(await screen.findByRole('heading', { name: /details removed/ })).toBeTruthy();
    expect(screen.getByText(/Personal details were removed/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Ask for my data to be deleted/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the reason a file was refused', async () => {
    open(caseView(), [on('POST', '/cases/GH-2026-000123/attachments', { status: 422, body: { message: 'Attachment rejected: malware signature detected (EICAR test file)' } })]);
    const input = (await screen.findByLabelText('Add a file')) as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'bad.pdf', { type: 'application/pdf' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/malware signature detected/);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toBeInstanceOf(FormData);
    expect(post.headers['X-Case-Token']).toBe('tok123');
  });

  it('refuses a file over 5 MB without uploading it', async () => {
    open();
    const input = (await screen.findByLabelText('Add a file')) as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/larger than 5 MB/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('adds an accepted file and reloads the case', async () => {
    open(caseView(), [on('POST', '/cases/GH-2026-000123/attachments', { status: 201, body: { id: 'a2', filename: 'ok.png', sizeBytes: 1, mimeType: 'image/png' } })]);
    await userEvent.upload((await screen.findByLabelText('Add a file')) as HTMLInputElement, new File(['x'], 'ok.png', { type: 'image/png' }));
    expect(await screen.findByText('ok.png was added.')).toBeTruthy();
    expect(calls.filter((c) => c.url === '/cases/GH-2026-000123' && c.method === 'GET').length).toBeGreaterThan(1);
  });

  it('downloads an attachment through the tracking-code header', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    open(caseView(), [(u) => (u.startsWith('/cases/GH-2026-000123/attachments/a1') ? { status: 200, body: {} } : undefined)]);
    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.find((c) => c.url.includes('/attachments/a1'))!.headers['X-Case-Token']).toBe('tok123');
    click.mockRestore();
  });

  it('only asks for deletion after the citizen confirms', async () => {
    open(caseView(), [on('POST', '/cases/GH-2026-000123/erasure-request', { status: 202, body: { received: true, message: 'Your request has been recorded.' } })]);
    const button = await screen.findByRole('button', { name: /Ask for my data to be deleted/ });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await userEvent.click(button);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    confirm.mockReturnValueOnce(true);
    await userEvent.click(button);
    expect(await screen.findByText('Your request has been recorded.')).toBeTruthy();
    confirm.mockRestore();
  });

  it('says what to do when the code is wrong, without revealing whether the reference exists', async () => {
    routes.push(on('GET', '/cases/GH-2026-000123', { status: 404, body: { message: 'No case matches that reference and tracking code' } }));
    mount({ pathname: '/issues/GH-2026-000123', hash: '#code=wrong' });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Check the reference and tracking code[\s\S]*cannot recover it/);
  });

  it('needs a tracking code at all and does not call the API without one', async () => {
    mount('/issues/GH-2026-000123');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Check the reference/);
    expect(calls.some((c) => c.url.startsWith('/cases/'))).toBe(false);
  });

  it('shows the safety notice prominently after a risky submission', async () => {
    routes.push(on('GET', '/cases/GH-2026-000123', { status: 200, body: caseView({ status: 'RECEIVED' }) }));
    mount({ pathname: '/issues/GH-2026-000123', hash: '#code=tok123', state: { submitted: true, safetyNotice: 'If you or someone else is in immediate danger, call the national emergency number 112 now.' } } as any);
    expect((await screen.findByText(/call the national emergency number 112/)).closest('[role=alert]')).toBeTruthy();
    expect(screen.getByText('tok123')).toBeTruthy();
    expect(screen.getByText(/we cannot recover it for you/)).toBeTruthy();
  });
});

// ------------------------------------------------------------------ Accessibility
describe('Accessibility of the new pages (automated checks only)', () => {
  const violations = async (container: HTMLElement) => {
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 90)).join(' | ')}`);
  };

  it.each(['/my-mp', '/issues', '/issues/new'])('%s has no detectable violations', async (path) => {
    const { container } = mount(path);
    await screen.findByRole('main');
    if (path === '/issues/new') await screen.findByRole('option', { name: /Tema East/ });
    if (path === '/my-mp') await screen.findByRole('option', { name: 'Greater Accra' });
    expect(await violations(container)).toEqual([]);
  });

  it('the form with errors showing has no detectable violations', async () => {
    const { container } = mount('/issues/new');
    await screen.findByRole('option', { name: /Tema East/ });
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    await screen.findAllByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('find my MP results have no detectable violations', async () => {
    routes.push(on('GET', '/constituencies/lookup', { status: 200, body: { query: 'Tema', matches: [{ constituency: TEMA, matchedOn: 'exact_name', explanation: 'e', mp: MP }] } }));
    const { container } = mount('/my-mp');
    await userEvent.type(screen.getByLabelText('Constituency, area or town'), 'Tema');
    await userEvent.click(screen.getByRole('button', { name: 'Find my MP' }));
    await screen.findByText('Hon. Ama Mensah');
    expect(await violations(container)).toEqual([]);
  });

  it('the case page has no detectable violations', async () => {
    routes.push(on('GET', '/cases/GH-2026-000123', { status: 200, body: caseView() }));
    const { container } = mount({ pathname: '/issues/GH-2026-000123', hash: '#code=tok123' });
    await screen.findByRole('heading', { name: 'Potholes on market road' });
    expect(await violations(container)).toEqual([]);
  });

  it('the review step has no detectable violations', async () => {
    routes.push(on('POST', '/cases/suggest', { status: 200, body: { category: 'roads_infrastructure', categoryLabel: 'Roads and infrastructure', confidence: 0.7, summary: 's', method: 'm', note: 'n' } }));
    const { container } = mount('/issues/new');
    await screen.findByRole('option', { name: /Tema East/ });
    await userEvent.selectOptions(screen.getByLabelText('Constituency'), 'c-tema');
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'health');
    await userEvent.type(screen.getByLabelText('Short title'), 'Potholes');
    await userEvent.type(screen.getByLabelText('Describe your issue'), STORY);
    await userEvent.click(screen.getByLabelText(/I agree that the constituency office/));
    await userEvent.click(screen.getByRole('button', { name: 'Review your issue' }));
    await screen.findByLabelText(/Use the suggestion/);
    expect(await violations(container)).toEqual([]);
  });
});
