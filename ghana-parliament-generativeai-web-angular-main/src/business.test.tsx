import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { LanguageProvider } from './language';

type Out = { status: number; body?: unknown } | 'network-error' | undefined;
let routes: ((url: string) => Out)[];
let calls: string[];

const BILL = { id: 'b1', title: 'Petroleum Revenue Amendment Bill', sponsor: 'Minister for Finance', stage: 'COMMITTEE', introducedOn: '2026-10-01', committee: { id: 'k1', name: 'Finance Committee' } };
const DOC = { publicId: 'HAN-PUB00001', title: 'Second Reading Debate', type: 'HANSARD', documentDate: '2026-11-03' };
const BILL_DETAIL = { ...BILL, summary: 'Changes how petroleum revenue is shared.', sittings: [{ id: 's1', date: '2026-11-03', type: 'Plenary' }], documents: [DOC] };
const SITTING_DETAIL = { id: 's1', date: '2026-11-03', type: 'Plenary', status: 'HELD', agenda: [{ title: 'Statements' }, { title: 'Second reading', billId: 'b1' }], bills: [{ id: 'b1', title: BILL.title, stage: 'COMMITTEE' }], documents: [DOC] };
const COMMITTEE_DETAIL = { id: 'k1', name: 'Finance Committee', remit: 'Budget and revenue', chair: { id: 'm1', name: 'Hon. Ama Mensah' }, members: [{ id: 'm1', name: 'Hon. Ama Mensah', party: 'NDC', role: 'Chair' }, { id: 'm2', name: 'Hon. Kofi Draft', party: 'NPP', role: 'Member' }], bills: [{ id: 'b1', title: BILL.title, stage: 'COMMITTEE' }] };

const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><LanguageProvider><App /></LanguageProvider></MemoryRouter>);
const json = (status: number, body: unknown): Out => ({ status, body });

beforeEach(() => {
  routes = [];
  calls = [];
  window.scrollTo = vi.fn() as any;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace('/api/v1/public', '');
    calls.push(path);
    for (const r of routes) {
      const out = r(path);
      if (out === 'network-error') throw new TypeError('Failed to fetch');
      if (out) return new Response(JSON.stringify(out.body ?? {}), { status: out.status });
    }
    if (path === '/languages') return new Response(JSON.stringify([{ code: 'en', name: 'English', level: 'supported', note: '' }]), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('Bills (T-070)', () => {
  it('lists published bills with stage and committee, linking to each', async () => {
    routes.push((u) => (u.startsWith('/bills?') || u === '/bills' ? json(200, { items: [BILL] }) : undefined));
    mount('/bills');
    const link = await screen.findByRole('link', { name: BILL.title });
    expect(link.getAttribute('href')).toBe('/bills/b1');
    const item = within(link.closest('li')!);
    expect(item.getByText('In committee')).toBeTruthy();
    expect(item.getByText(/Finance Committee/)).toBeTruthy();
  });

  it('applies search and stage filters through the URL and the API', async () => {
    routes.push((u) => (u.startsWith('/bills') ? json(200, { items: [] }) : undefined));
    mount('/bills');
    await screen.findByText(/No published bills match/);
    await userEvent.type(screen.getByLabelText('Title contains'), 'petrol');
    await userEvent.selectOptions(screen.getByLabelText('Stage'), 'COMMITTEE');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.includes('q=petrol') && c.includes('stage=COMMITTEE'))).toBe(true));
  });

  it('shows an error with retry, and an honest empty state', async () => {
    let n = 0;
    routes.push((u) => (u.startsWith('/bills') ? (++n === 1 ? 'network-error' : json(200, { items: [BILL] })) : undefined));
    mount('/bills');
    expect((await screen.findByRole('alert')).textContent).toMatch(/offline/);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: BILL.title })).toBeTruthy();
  });

  it('shows a bill with committee, sittings and official records cross-linked', async () => {
    routes.push((u) => (u === '/bills/b1' ? json(200, BILL_DETAIL) : undefined));
    mount('/bills/b1');
    expect(await screen.findByRole('heading', { name: BILL.title, level: 1 })).toBeTruthy();
    expect(screen.getByText('Changes how petroleum revenue is shared.')).toBeTruthy();
    expect(screen.getByText(/written by Parliament staff/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Finance Committee' }).getAttribute('href')).toBe('/committees/k1');
    expect(screen.getByRole('link', { name: 'Plenary - 3 November 2026' }).getAttribute('href')).toBe('/sittings/s1');
    expect(screen.getByRole('link', { name: 'Second Reading Debate' }).getAttribute('href')).toBe('/hansards/HAN-PUB00001');
  });

  it('says plainly when a bill has no linked records, instead of leaving blanks', async () => {
    routes.push((u) => (u === '/bills/b1' ? json(200, { ...BILL_DETAIL, committee: null, sittings: [], documents: [], summary: null }) : undefined));
    mount('/bills/b1');
    await screen.findByRole('heading', { name: BILL.title });
    expect(screen.getByText(/Not assigned to a published committee/)).toBeTruthy();
    expect(screen.getByText(/No published sittings are linked yet/)).toBeTruthy();
    expect(screen.getByText(/No published records are linked yet/)).toBeTruthy();
  });

  it('treats an unpublished or unknown bill as not found', async () => {
    routes.push((u) => (u.startsWith('/bills/') ? json(404, {}) : undefined));
    mount('/bills/zzz');
    expect(await screen.findByRole('heading', { name: 'Bill not found' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/may not be published/);
  });
});

describe('Sittings and committees (T-071 cross-links)', () => {
  it('lists published sittings', async () => {
    routes.push((u) => (u === '/sittings' ? json(200, { items: [{ id: 's1', date: '2026-11-03', type: 'Plenary', status: 'HELD' }] }) : undefined));
    mount('/sittings');
    expect((await screen.findByRole('link', { name: 'Plenary - 3 November 2026' })).getAttribute('href')).toBe('/sittings/s1');
    expect(screen.getByText('Held')).toBeTruthy();
  });

  it('shows the order paper with links only where an agenda item points at a bill', async () => {
    routes.push((u) => (u === '/sittings/s1' ? json(200, SITTING_DETAIL) : undefined));
    mount('/sittings/s1');
    const paper = within((await screen.findByRole('heading', { name: 'Order paper' })).closest('section')!);
    expect(paper.getByText('Statements').closest('a')).toBeNull();
    expect(paper.getByRole('link', { name: 'Second reading' }).getAttribute('href')).toBe('/bills/b1');
    expect(screen.getByRole('link', { name: BILL.title }).getAttribute('href')).toBe('/bills/b1');
    expect(screen.getByRole('link', { name: 'Second Reading Debate' }).getAttribute('href')).toBe('/hansards/HAN-PUB00001');
  });

  it('shows a committee with its published chair, members and bills', async () => {
    routes.push((u) => (u === '/committees/k1' ? json(200, COMMITTEE_DETAIL) : undefined));
    mount('/committees/k1');
    expect(await screen.findByRole('heading', { name: 'Finance Committee', level: 1 })).toBeTruthy();
    expect(screen.getByText('Budget and revenue')).toBeTruthy();
    const members = within(screen.getByRole('heading', { name: 'Members' }).closest('section')!);
    expect(members.getByText(/Hon. Ama Mensah/)).toBeTruthy();
    expect(members.getByText(/NPP/)).toBeTruthy();
    expect(screen.getByRole('link', { name: BILL.title }).getAttribute('href')).toBe('/bills/b1');
  });

  it('handles an unpublished chair and an empty committee list honestly', async () => {
    routes.push((u) => (u === '/committees/k1' ? json(200, { ...COMMITTEE_DETAIL, chair: null, members: [], bills: [] }) : u === '/committees' ? json(200, { items: [] }) : undefined));
    mount('/committees/k1');
    await screen.findByRole('heading', { name: 'Finance Committee' });
    expect(screen.getByText('Not published.')).toBeTruthy();
    expect(screen.getByText('No published members.')).toBeTruthy();
    expect(screen.getByText('No published bills.')).toBeTruthy();
  });

  it('lists committees', async () => {
    routes.push((u) => (u === '/committees' ? json(200, { items: [{ id: 'k1', name: 'Finance Committee', remit: 'Budget and revenue' }] }) : undefined));
    mount('/committees');
    expect((await screen.findByRole('link', { name: 'Finance Committee' })).getAttribute('href')).toBe('/committees/k1');
  });
});

describe('Accessibility of the business pages (automated checks only)', () => {
  const violations = async (c: HTMLElement) => (await axe.run(c, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')}`);
  it.each([
    ['/bills', 'Petroleum Revenue Amendment Bill'],
    ['/bills/b1', 'Official records'],
    ['/sittings/s1', 'Order paper'],
    ['/committees/k1', 'Members'],
  ])('%s has no detectable violations', async (path, waitFor_) => {
    routes.push((u) => (u.startsWith('/bills?') || u === '/bills' ? json(200, { items: [BILL] }) : u === '/bills/b1' ? json(200, BILL_DETAIL) : u === '/sittings/s1' ? json(200, SITTING_DETAIL) : u === '/committees/k1' ? json(200, COMMITTEE_DETAIL) : undefined));
    const { container } = mount(path);
    await screen.findByText(waitFor_);
    expect(await violations(container)).toEqual([]);
  });
});
