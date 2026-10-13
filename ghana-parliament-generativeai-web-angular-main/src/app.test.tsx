import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { LanguageProvider } from './language';

type Route = (url: string, init: RequestInit) => { status: number; body?: unknown } | 'network-error' | undefined;
let routes: Route[];
let calls: { url: string; method: string; body?: any }[];

const LANGS = [
  { code: 'en', name: 'English', level: 'supported', note: 'Questions and answers in English.' },
  { code: 'tw', name: 'Akan (Twi)', level: 'planned', note: 'Not yet available. Please ask in English.' },
];
const citation = { n: 1, documentId: 'HAN-FUEL0001', title: 'Petroleum Pricing - Second Reading', date: '2024-03-14', anchor: 'paragraph 2', relevance: 0.72 };
const grounded = (over = {}) => ({
  answerId: 'ans-1', answer: 'These are the most relevant passages in the published parliamentary record:\n- "Fuel prices rose sharply." [1]', message: null,
  language: 'en', status: 'grounded', confidence: 'high', disclosure: 'AI-assisted result based only on published parliamentary records. It is not an official statement of Parliament.',
  citations: [citation], answerVersion: { model: 'extractive', prompt: 'extractive-v1', retriever: 'idx' }, ...over,
});
const failing = (status: string, message: string) => ({ answerId: 'ans-x', answer: null, message, language: 'en', status, confidence: null, disclosure: 'd', citations: [], answerVersion: { model: null, prompt: null, retriever: null } });

function mount(path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><LanguageProvider><App /></LanguageProvider></MemoryRouter>);
}
const ask = async (q: string) => {
  await userEvent.type(screen.getByLabelText('Your question'), q);
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
};

beforeEach(() => {
  calls = [];
  routes = [];
  localStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
  window.scrollTo = vi.fn() as any;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/public', '');
    calls.push({ url: path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    for (const r of routes) {
      const out = r(path, init);
      if (out === 'network-error') throw new TypeError('Failed to fetch');
      if (out) return new Response(JSON.stringify(out.body ?? {}), { status: out.status });
    }
    if (path === '/languages') return new Response(JSON.stringify(LANGS), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('Ask Parliament', () => {
  it('sends the question and language and shows a cited answer with disclosure', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded() } : undefined));
    mount();
    await ask('What did Parliament say about fuel prices?');
    expect(await screen.findByRole('heading', { name: 'From the published record' })).toBeTruthy();
    expect(calls.find((c) => c.url === '/answers')!.body).toEqual({ question: 'What did Parliament say about fuel prices?', language: 'en' });
    expect(screen.getByText('Strong match')).toBeTruthy();
    expect(screen.getByText(/not an official statement/)).toBeTruthy();
    const sources = screen.getByRole('region', { name: 'Sources' });
    expect(within(sources).getByText(/Petroleum Pricing - Second Reading/)).toBeTruthy();
  });

  it('opens the cited passage in one click and links to the full record', async () => {
    routes.push(
      (u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded() } : undefined),
      (u) => (u.startsWith('/documents/HAN-FUEL0001/passages') ? { status: 200, body: { documentId: 'HAN-FUEL0001', title: 't', date: null, passages: [{ anchor: 'paragraph 2', text: 'The price of fuel at the pump has risen sharply.' }] } } : undefined),
    );
    mount();
    await ask('fuel prices');
    await userEvent.click(await screen.findByRole('button', { name: 'View passage' }));
    expect(await screen.findByText('The price of fuel at the pump has risen sharply.')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('anchor=paragraph+2'))).toBe(true);
    expect(screen.getAllByRole('link', { name: /Open (the )?full record/ })[0].getAttribute('href')).toBe('/hansards/HAN-FUEL0001');
  });

  it('lets inline [n] markers open their source', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded() } : undefined), (u) => (u.includes('/passages') ? { status: 200, body: { documentId: 'x', title: 't', date: null, passages: [{ anchor: 'paragraph 2', text: 'Passage text.' }] } } : undefined));
    mount();
    await ask('fuel prices');
    await userEvent.click(await screen.findByRole('button', { name: /Source 1: Petroleum Pricing/ }));
    expect(await screen.findByText('Passage text.')).toBeTruthy();
  });

  it.each([
    ['no_evidence', 'I could not find this in the published parliamentary records, so I will not guess.', 'Nothing found in the published record'],
    ['needs_clarification', 'Please add a little more detail.', 'Can you tell us a little more?'],
    ['safety_refusal', 'I cannot help with that request.', 'We cannot help with that request'],
    ['unsupported_language', 'This language is not available yet. Please ask in English.', 'This language is not available yet'],
  ])('renders the %s state with a clear message and no sources', async (status, message, title) => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: failing(status, message) } : undefined));
    mount();
    await ask('something unrelated');
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull();
  });

  it('renders conflicting sources with a distinct heading', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded({ status: 'conflicting_sources', message: 'The published records disagree on this.' }) } : undefined));
    mount();
    await ask('fuel prices');
    expect(await screen.findByRole('heading', { name: 'The published records disagree' })).toBeTruthy();
    expect(screen.getByText('The published records disagree on this.')).toBeTruthy();
  });

  it('shows the service-unavailable state from a 503 response and does not crash', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 503, body: failing('service_unavailable', 'The service is temporarily unavailable.') } : undefined));
    mount();
    await ask('fuel prices');
    expect(await screen.findByRole('heading', { name: 'The service is temporarily unavailable' })).toBeTruthy();
  });

  it('shows the paused state from a 503 response with a clear message', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 503, body: failing('answering_paused', 'Ask Parliament is paused while we check a problem.') } : undefined));
    mount();
    await ask('fuel prices');
    expect(await screen.findByRole('heading', { name: 'Ask Parliament is paused for now' })).toBeTruthy();
    expect(screen.getByText('Ask Parliament is paused while we check a problem.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull();
  });

  it('tells people up front when answering is paused, disables asking, and keeps browsing available', async () => {
    routes.push((u) => (u === '/answering-status' ? { status: 200, body: { enabled: false, message: 'Ask Parliament is paused while we check a problem.' } } : undefined));
    mount();
    expect((await screen.findByRole('status')).textContent).toMatch(/paused/);
    await userEvent.type(screen.getByLabelText('Your question'), 'fuel prices');
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Browse the Hansards' }).length).toBeGreaterThan(0);
  });

  it('behaves normally when the status check fails', async () => {
    routes.push((u) => (u === '/answering-status' ? 'network-error' : undefined));
    mount();
    await userEvent.type(screen.getByLabelText('Your question'), 'fuel prices');
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a network error with a retry that works', async () => {
    let fail = true;
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? (fail ? 'network-error' : { status: 200, body: grounded() }) : undefined));
    mount();
    await ask('fuel prices');
    expect((await screen.findByRole('alert')).textContent).toMatch(/offline|cannot be reached/);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'From the published record' })).toBeTruthy();
  });

  it('explains rate limiting', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 429, body: {} } : undefined));
    mount();
    await ask('fuel prices');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Too many requests/);
  });

  it('moves focus to the result heading for screen-reader and keyboard users', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded() } : undefined));
    mount();
    await ask('fuel prices');
    const h = await screen.findByRole('heading', { name: 'From the published record' });
    await waitFor(() => expect(document.activeElement).toBe(h));
  });

  it('does not submit an empty question', async () => {
    mount();
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Feedback and reporting', () => {
  beforeEach(() => {
    routes.push(
      (u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded() } : undefined),
      (u, i) => (u === '/answers/ans-1/feedback' && i.method === 'POST' ? { status: 201, body: { ok: true } } : undefined),
    );
  });

  it('sends helpful feedback', async () => {
    mount();
    await ask('fuel prices');
    await userEvent.click(await screen.findByRole('button', { name: 'Yes' }));
    expect(await screen.findByText('Thank you for your feedback.')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/feedback'))!.body).toEqual({ helpful: true });
  });

  it('submits a problem report with type and comment', async () => {
    mount();
    await ask('fuel prices');
    await userEvent.click(await screen.findByRole('button', { name: 'Report a problem with this answer' }));
    await userEvent.selectOptions(screen.getByLabelText('What is wrong?'), 'misleading');
    await userEvent.type(screen.getByLabelText(/Details/), 'Missing the 2023 context');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/Your report was sent/)).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/feedback'))!.body).toEqual({ helpful: false, reportType: 'misleading', comment: 'Missing the 2023 context' });
  });

  it('shows an error and keeps the form when sending fails', async () => {
    routes.unshift((u) => (u.endsWith('/feedback') ? { status: 500, body: {} } : undefined));
    mount();
    await ask('fuel prices');
    await userEvent.click(await screen.findByRole('button', { name: 'No' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Something went wrong/);
    expect(screen.queryByText('Thank you for your feedback.')).toBeNull();
  });
});

describe('Language selection', () => {
  it('lists languages with honest availability and warns when an unavailable one is chosen', async () => {
    mount();
    const select = await screen.findByLabelText('Language');
    await waitFor(() => expect(within(select).getByRole('option', { name: /Akan \(Twi\) \(not yet available\)/ })).toBeTruthy());
    await userEvent.selectOptions(select, 'tw');
    expect(screen.getByRole('status').textContent).toMatch(/Akan \(Twi\) is not available yet/);
    expect(localStorage.getItem('parliament.language')).toBe('tw');
  });

  it('sends the selected language so the server can respond honestly', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: failing('unsupported_language', 'This language is not available yet.') } : undefined));
    localStorage.setItem('parliament.language', 'tw');
    mount();
    await screen.findByRole('option', { name: /Akan/ });
    await ask('fuel prices');
    await screen.findByRole('heading', { name: 'This language is not available yet' });
    expect(calls.find((c) => c.url === '/answers')!.body.language).toBe('tw');
  });

  it('falls back to English only if the language list cannot be loaded', async () => {
    routes.push((u) => (u === '/languages' ? { status: 500, body: {} } : undefined));
    mount();
    const select = await screen.findByLabelText('Language');
    expect(within(select).getAllByRole('option')).toHaveLength(1);
  });
});

const page = (items: any[], over = {}) => ({ items, page: 1, pageSize: 10, total: items.length, totalPages: 1, ...over });
const rec = (id: string, title: string) => ({ publicId: id, title, type: 'HANSARD', documentDate: '2024-03-14T00:00:00.000Z', language: 'en' });

describe('Hansards browsing', () => {
  it('lists published records with links and applies filters through the URL', async () => {
    routes.push((u) => (u.startsWith('/documents?') ? { status: 200, body: page([rec('HAN-1', 'Petroleum Pricing'), rec('HAN-2', 'Education Bill')]) } : undefined));
    mount('/hansards');
    expect(await screen.findByRole('link', { name: 'Petroleum Pricing' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Petroleum Pricing' }).getAttribute('href')).toBe('/hansards/HAN-1');
    expect(screen.getAllByText(/14 March 2024/, { selector: 'p' })).toHaveLength(2);
    await userEvent.type(screen.getByLabelText('Title contains'), 'water');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'BILL_TEXT');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=water') && c.url.includes('type=BILL_TEXT'))).toBe(true));
  });

  it('paginates', async () => {
    routes.push((u) => (u.startsWith('/documents?') ? { status: 200, body: page([rec('HAN-1', 'A')], { page: u.includes('page=2') ? 2 : 1, total: 12, totalPages: 2 }) } : undefined));
    mount('/hansards');
    await screen.findByRole('link', { name: 'A' });
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('page=2'))).toBe(true));
  });

  it('shows empty and error states', async () => {
    routes.push((u) => (u.startsWith('/documents?') ? { status: 200, body: page([]) } : undefined));
    mount('/hansards');
    expect(await screen.findByText(/No published records match/)).toBeTruthy();
  });

  it('shows an error with retry', async () => {
    let n = 0;
    routes.push((u) => (u.startsWith('/documents?') ? (n++ === 0 ? { status: 500, body: {} } : { status: 200, body: page([rec('HAN-1', 'Recovered')]) }) : undefined));
    mount('/hansards');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Something went wrong/);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Recovered' })).toBeTruthy();
  });

  it('blocks an inverted date range', async () => {
    routes.push((u) => (u.startsWith('/documents?') ? { status: 200, body: page([]) } : undefined));
    mount('/hansards');
    await screen.findByText(/No published records match/);
    await userEvent.type(screen.getByLabelText('From'), '2024-06-01');
    await userEvent.type(screen.getByLabelText('To'), '2024-01-01');
    expect(screen.getByRole('alert').textContent).toMatch(/start date must be before/);
    expect((screen.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Record page', () => {
  it('shows the official text first with stable identifiers', async () => {
    routes.push((u) => (u === '/documents/HAN-1' ? { status: 200, body: { ...rec('HAN-1', 'Petroleum Pricing'), version: 2, publishedAt: null, extractedText: 'Mr. Speaker: The House will now consider the Bill.' } } : undefined));
    mount('/hansards/HAN-1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Petroleum Pricing' })).toBeTruthy();
    expect(screen.getByText('Mr. Speaker: The House will now consider the Bill.')).toBeTruthy();
    expect(screen.getByText('HAN-1')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Official text' })).toBeTruthy();
  });

  it('shows not-found clearly', async () => {
    routes.push((u) => (u.startsWith('/documents/') ? { status: 404, body: {} } : undefined));
    mount('/hansards/NOPE');
    expect(await screen.findByRole('heading', { name: 'Record not found' })).toBeTruthy();
  });
});

describe('About', () => {
  it('is still honest about unknown routes', async () => {
    mount('/nowhere');
    expect(screen.getByText('Not available yet')).toBeTruthy();
  });

  it('explains limits, privacy and language support from live data', async () => {
    mount('/about');
    expect(screen.getByRole('heading', { name: 'What the AI can and cannot do' })).toBeTruthy();
    expect(screen.getByText(/official statement of Parliament/i, { selector: 'li' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('row', { name: /Akan \(Twi\) Not yet available/ })).toBeTruthy());
  });
});

describe('Accessibility (automated checks; not a substitute for assistive-technology testing)', () => {
  const violations = async (container: HTMLElement) => {
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } }); // jsdom cannot compute layout colours
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')}`);
  };

  it.each(['/', '/hansards', '/about'])('%s has no detectable violations', async (path) => {
    routes.push((u) => (u.startsWith('/documents?') ? { status: 200, body: page([rec('HAN-1', 'Petroleum Pricing')]) } : undefined));
    const { container } = mount(path);
    await screen.findByRole('main');
    if (path === '/hansards') await screen.findByRole('link', { name: 'Petroleum Pricing' });
    expect(await violations(container)).toEqual([]);
  });

  it('answer page with sources and feedback has no violations', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded() } : undefined));
    const { container } = mount();
    await ask('fuel prices');
    await screen.findByRole('heading', { name: 'From the published record' });
    expect(await violations(container)).toEqual([]);
  });

  it('has a skip link, landmarks and a labelled language control', async () => {
    mount();
    expect(screen.getByText('Skip to main content').getAttribute('href')).toBe('#main');
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    expect(screen.getByLabelText('Language')).toBeTruthy();
  });

  it('can be operated by keyboard alone: type, submit with Enter, open a source', async () => {
    routes.push((u, i) => (u === '/answers' && i.method === 'POST' ? { status: 200, body: grounded() } : undefined), (u) => (u.includes('/passages') ? { status: 200, body: { documentId: 'x', title: 't', date: null, passages: [{ anchor: 'paragraph 2', text: 'Keyboard passage.' }] } } : undefined));
    mount();
    await userEvent.click(screen.getByLabelText('Your question'));
    await userEvent.keyboard('fuel prices{Enter}');
    const view = await screen.findByRole('button', { name: 'View passage' });
    view.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Keyboard passage.')).toBeTruthy();
  });
});
