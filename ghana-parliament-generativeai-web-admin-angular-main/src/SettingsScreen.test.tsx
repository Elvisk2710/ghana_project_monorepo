import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import SettingsScreen from './SettingsScreen';

let calls: { url: string; method: string; body?: any }[];
let roles: string[];
let saveStatus: number;

const overview = (cases = { retentionDays: 730, slaHours: 120, slaUrgentHours: 24 }, source = 'default') => ({
  cases: {
    values: cases, sources: { retentionDays: source, slaHours: source, slaUrgentHours: source }, updatedAt: null, updatedById: null, editable: true,
    limits: { retentionDays: { min: 1, max: 3650 }, slaHours: { min: 1, max: 2160 }, slaUrgentHours: { min: 1, max: 2160 } },
  },
  answering: { enabled: true, reason: null, editable: false, changeVia: 'AI governance: pause or resume public answers' },
  retrieval: { deploymentId: null, generator: 'baseline', minScore: 0.15, maxPassages: 5, retrieverVersion: null, editable: false, changeVia: 'AI governance: evaluate, approve and deploy a new retriever or model version' },
  languages: { items: [{ code: 'en', name: 'English', level: 'supported', note: 'Questions and answers in English.' }, { code: 'tw', name: 'Akan (Twi)', level: 'planned', note: 'Not yet available. Please ask in English.' }], editable: false, changeVia: 'A language becomes supported only after evaluation evidence exists' },
  notifications: { provider: null, configured: false, staffAlerts: true, editable: false, changeVia: 'Server environment' },
  attachments: { scanner: 'built-in checks only', editable: false, changeVia: 'Server environment' },
});

beforeEach(() => {
  calls = [];
  roles = ['ADMIN'];
  saveStatus = 200;
  sessionStorage.setItem('parliament.access_token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/internal', '');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: path, method, body });
    const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (path === '/me') return reply(200, { userId: 'u1', email: 'a@x', roles, constituencyIds: [] });
    if (path === '/settings' && method === 'GET') return reply(200, overview());
    if (path === '/settings/cases' && method === 'PUT') return saveStatus === 200 ? reply(200, overview(body, 'database')) : reply(saveStatus, { message: 'slaUrgentHours cannot be longer than slaHours' });
    if (path === '/erasures/ledger') return reply(200, { generatedAt: '2026-10-12T10:00:00.000Z', count: 2, checksum: 'x', entries: [] });
    return reply(404, {});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const mount = (ui: React.ReactElement, path = '/settings') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
const field = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;

describe('Settings screen', () => {
  it('replaces the old "not available yet" page with the live settings', async () => {
    mount(<App />);
    expect(await screen.findByRole('heading', { name: 'Case handling' })).toBeTruthy();
    expect(screen.queryByText('Not available yet')).toBeNull();
    expect(field(/Keep closed cases for/).value).toBe('730');
    expect(field(/First response due within/).value).toBe('120');
    expect(screen.getAllByText(/built-in default \(awaiting a decision from Parliament\)/).length).toBe(3);
  });

  it('saves changed values and says where they came from afterwards', async () => {
    const user = userEvent.setup();
    mount(<SettingsScreen />);
    await screen.findByRole('heading', { name: 'Case handling' });
    await user.clear(field(/Keep closed cases for/));
    await user.type(field(/Keep closed cases for/), '365');
    await user.clear(field(/First response due within/));
    await user.type(field(/First response due within/), '48');
    await user.clear(field(/Urgent cases due within/));
    await user.type(field(/Urgent cases due within/), '6');
    await user.click(screen.getByRole('button', { name: 'Save case settings' }));
    expect(await screen.findByText(/recorded in the audit trail/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ retentionDays: 365, slaHours: 48, slaUrgentHours: 6 });
    await waitFor(() => expect(screen.getAllByText(/set here/).length).toBe(3));
  });

  it('checks values before sending anything', async () => {
    const user = userEvent.setup();
    mount(<SettingsScreen />);
    await screen.findByRole('heading', { name: 'Case handling' });
    await user.clear(field(/Keep closed cases for/));
    await user.type(field(/Keep closed cases for/), '0');
    await user.click(screen.getByRole('button', { name: 'Save case settings' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Keep closed cases for: enter a whole number from 1 to 3650/);
    await user.clear(field(/Keep closed cases for/));
    await user.type(field(/Keep closed cases for/), '30');
    await user.clear(field(/Urgent cases due within/));
    await user.type(field(/Urgent cases due within/), '200');
    await user.click(screen.getByRole('button', { name: 'Save case settings' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be given longer/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows a server refusal instead of pretending the change was saved', async () => {
    saveStatus = 400;
    const user = userEvent.setup();
    mount(<SettingsScreen />);
    await screen.findByRole('heading', { name: 'Case handling' });
    await user.click(screen.getByRole('button', { name: 'Save case settings' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be longer than slaHours/);
    expect(screen.queryByText(/recorded in the audit trail/)).toBeNull();
  });

  it('is read-only for reviewers and hides the erasure ledger', async () => {
    roles = ['REVIEWER'];
    mount(<SettingsScreen />);
    await screen.findByRole('heading', { name: 'Case handling' });
    await waitFor(() => expect(field(/Keep closed cases for/).disabled).toBe(true));
    expect(screen.queryByRole('button', { name: 'Save case settings' })).toBeNull();
    expect(screen.getByText('Only an administrator can change these values.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download erasure ledger' })).toBeNull();
  });

  it('tells the truth about what is not configurable here', async () => {
    mount(<SettingsScreen />);
    await screen.findByRole('heading', { name: 'Languages' });
    expect(screen.getByText('Planned')).toBeTruthy();
    expect(screen.getByText(/No delivery provider configured/)).toBeTruthy();
    expect(screen.getByText(/Built-in baseline: quotes the best-matching source passage/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open AI governance' }).getAttribute('href')).toBe('/mlops');
  });

  it('downloads the erasure ledger for administrators', async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    mount(<SettingsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Download erasure ledger' }));
    expect(await screen.findByText(/Downloaded 2 erasure record\(s\)/)).toBeTruthy();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});
