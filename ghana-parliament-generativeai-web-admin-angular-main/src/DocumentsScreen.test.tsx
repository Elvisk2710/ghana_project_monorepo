import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentsScreen from './DocumentsScreen';

const doc = (over: Record<string, unknown>) => ({
  id: 'id-1', publicId: 'HAN-AAAA1111', title: 'Petroleum Pricing', type: 'HANSARD', documentDate: '2024-03-14T00:00:00.000Z',
  language: 'en', lifecycle: 'REVIEW', isPublished: false, version: 1, qualityReport: { passed: true, issues: [], words: 500 }, ...over,
});

let calls: { url: string; method: string; body?: unknown; auth?: string | null }[];
let items: ReturnType<typeof doc>[];
let respond: (url: string, method: string) => { status: number; body: unknown } | undefined;

beforeEach(() => {
  calls = [];
  items = [doc({})];
  respond = () => undefined;
  sessionStorage.setItem('parliament.access_token', 'tok-123');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body, auth: new Headers(init.headers).get('Authorization') });
    const custom = respond(url, method);
    const { status, body } = custom ?? (url.includes('/review') ? { status: 200, body: { metadataIssues: [{ field: 'sensitivity', message: 'Sensitivity classification is required' }], quality: null } } : method === 'GET' ? { status: 200, body: { items } } : { status: 201, body: {} });
    return new Response(JSON.stringify(body), { status });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('DocumentsScreen', () => {
  it('loads documents from the API with the bearer token', async () => {
    render(<DocumentsScreen />);
    expect(await screen.findByText('Petroleum Pricing')).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('In review')).toBeTruthy();
    expect(calls[0].url).toContain('/api/v1/internal/documents');
    expect(calls[0].auth).toBe('Bearer tok-123');
  });

  it('shows the right action for each lifecycle state', async () => {
    items = [doc({ id: 'a', publicId: 'A', lifecycle: 'REVIEW' }), doc({ id: 'b', publicId: 'B', lifecycle: 'APPROVED' }), doc({ id: 'c', publicId: 'C', lifecycle: 'PUBLISHED' }), doc({ id: 'd', publicId: 'D', lifecycle: 'REJECTED' })];
    render(<DocumentsScreen />);
    const row = async (id: string) => within((await screen.findByText(id)).closest('tr')!);
    expect((await row('A')).getByText('Approve')).toBeTruthy();
    expect((await row('B')).getByText('Publish')).toBeTruthy();
    expect((await row('C')).getByText('Unpublish')).toBeTruthy();
    expect((await row('D')).getByText('Reprocess')).toBeTruthy();
    expect((await row('C')).queryByText('Approve')).toBeNull();
  });

  it('approves a document and refreshes the list', async () => {
    render(<DocumentsScreen />);
    await userEvent.click(await screen.findByText('Approve'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/documents/id-1/approve'))).toBe(true));
    expect(await screen.findByText('Approved HAN-AAAA1111')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'GET' && c.url.includes('limit=200')).length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces backend rejection reasons (e.g. incomplete metadata)', async () => {
    respond = (url, method) => (method === 'POST' && url.endsWith('/approve') ? { status: 422, body: { message: 'Metadata is incomplete', issues: [{ field: 'language', message: 'Language must be valid' }] } } : undefined);
    render(<DocumentsScreen />);
    await userEvent.click(await screen.findByText('Approve'));
    expect((await screen.findByRole('alert')).textContent).toContain('Metadata is incomplete: Language must be valid');
  });

  it('shows review issues in the details row', async () => {
    render(<DocumentsScreen />);
    await userEvent.click(await screen.findByText('Details'));
    expect(await screen.findByText(/Sensitivity classification is required/)).toBeTruthy();
  });

  it('asks to sign in on 401', async () => {
    sessionStorage.clear();
    respond = (_u, m) => (m === 'GET' ? { status: 401, body: { message: 'Authentication required' } } : undefined);
    render(<DocumentsScreen />);
    expect(await screen.findByText(/not signed in/i)).toBeTruthy();
    expect(screen.getByLabelText('Access token')).toBeTruthy();
  });

  it('rejects unsupported files before uploading', async () => {
    render(<DocumentsScreen />);
    await userEvent.click(await screen.findByText('+ Upload document'));
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'photo.png', { type: 'image/png' }), { applyAccept: false });
    expect(screen.getByText('Only PDF and plain-text files are supported.')).toBeTruthy();
    expect((screen.getByText('Upload for review') as HTMLButtonElement).disabled).toBe(true);
  });

  it('uploads a valid file as multipart with metadata', async () => {
    render(<DocumentsScreen />);
    await userEvent.click(await screen.findByText('+ Upload document'));
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await userEvent.upload(input, new File(['hello hansard'], 'budget_debate.txt', { type: 'text/plain' }));
    await userEvent.click(screen.getByText('Upload for review'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.body instanceof FormData)).toBe(true));
    const form = calls.find((c) => c.body instanceof FormData)!.body as FormData;
    expect((form.get('file') as File).name).toBe('budget_debate.txt');
    expect(form.get('type')).toBe('HANSARD');
    expect(form.get('language')).toBe('en');
    expect(form.get('title')).toBe('budget debate');
  });
});
