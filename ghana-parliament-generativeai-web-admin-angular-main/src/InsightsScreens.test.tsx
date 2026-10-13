import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeatmapScreen, MpDashboardScreen } from './InsightsScreens';
import { MeetingsScreen } from './MeetingsScreen';

type Reply = { status: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: any }[];
let respond: (path: string, method: string) => Reply;
let roles: string[];
let constituencyIds: string[];

const mp = (o = {}) => ({ id: 'm1', officialName: 'Hon. Ama Mensah', party: 'NDC', roleTitle: null, publicContact: null, constituencyId: 'c1', constituency: { code: 'GA-TE', name: 'Tema East' }, activeFrom: '2021-01-07', activeTo: null, isPublished: true, ...o });

beforeEach(() => {
  calls = [];
  roles = ['MP'];
  constituencyIds = ['c1'];
  respond = () => undefined;
  sessionStorage.setItem('parliament.access_token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1/internal', '').replace('/api/v1/public', '/public');
    const method = init.method ?? 'GET';
    calls.push({ url: path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const custom = respond(path, method);
    const out: NonNullable<Reply> = custom ?? (
      path === '/me' ? { status: 200, body: { userId: 'u-mp', email: 'mp@x', roles, constituencyIds } }
      : path === '/mps' ? { status: 200, body: [mp()] }
      : path.startsWith('/insights/mp-overview') ? {
          status: 200,
          body: {
            constituency: { id: 'c1', name: 'Tema East', region: 'Greater Accra' },
            openCases: 4,
            topConcerns: [{ category: 'roads_infrastructure', count: 2 }],
            trendingTopics: [{ category: 'roads_infrastructure', count: 2, previousCount: 0, change: 2 }],
            sentiment: { available: false, reason: 'No AI provider is configured yet.' },
            measuredAt: '2026-10-13T08:00:00.000Z',
          },
        }
      : path.startsWith('/insights/clusters') ? { status: 200, body: [{ category: 'water_sanitation', count: 1, overdue: 0, escalated: 1, urgent: true }] }
      : path === '/insights/heatmap' ? { status: 200, body: [{ region: 'Greater Accra', openCases: 4, overdue: 1, escalated: 1, severity: 0.5, topCategory: 'roads_infrastructure' }] }
      : path.startsWith('/mps/') && path.endsWith('/meetings/availability') && method === 'GET' ? { status: 200, body: [{ id: 'w1', dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] }
      : path.startsWith('/mps/') && path.endsWith('/meetings/availability') && method === 'POST' ? { status: 201, body: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] }
      : path.startsWith('/mps/') && path.endsWith('/meetings') ? { status: 200, body: [{ id: 'mt1', requestedName: 'Kofi Mensah', topic: 'Road repairs', requestedSlot: '2026-10-20T10:00:00.000Z', durationMinutes: 30, status: 'REQUESTED', confirmedSlot: null, staffNote: null, createdAt: '2026-10-13T08:00:00.000Z' }] }
      : path.startsWith('/meetings/') ? { status: 200, body: { id: 'mt1', status: 'CONFIRMED' } }
      : method !== 'GET' ? { status: 201, body: {} }
      : { status: 404, body: {} });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const mount = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('MP insight dashboard', () => {
  it('shows the signed-in MP their own constituency: open cases, top concerns, trending topics and clusters', async () => {
    mount(<MpDashboardScreen />);
    expect(await screen.findByText(/Tema East/)).toBeTruthy();
    expect(await screen.findByText('4')).toBeTruthy(); // open cases
    expect((await screen.findAllByText('Roads infrastructure')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Water sanitation')).toBeTruthy(); // from clusters
    expect((await screen.findAllByText('Urgent')).length).toBeGreaterThan(0);
  });

  it('is honest when no AI provider is configured: shows "Not available" rather than a fake score', async () => {
    mount(<MpDashboardScreen />);
    expect(await screen.findByText('Not available')).toBeTruthy();
    expect(await screen.findByText(/No AI provider is configured yet/)).toBeTruthy();
  });
});

describe('National heatmap', () => {
  it('shows regions with their severity', async () => {
    mount(<HeatmapScreen />);
    expect(await screen.findByText('Greater Accra')).toBeTruthy();
    expect(await screen.findByText('50%')).toBeTruthy();
  });
});

describe('Meetings', () => {
  it('lets the MP confirm a requested meeting that falls inside their published availability', async () => {
    mount(<MeetingsScreen />);
    expect(await screen.findByText('Kofi Mensah')).toBeTruthy();
    expect(await screen.findByText('Road repairs')).toBeTruthy();
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url === '/meetings/mt1' && c.method === 'PATCH' && c.body.decision === 'CONFIRMED')).toBe(true));
  });

  it('shows the MP’s published weekly availability windows', async () => {
    mount(<MeetingsScreen />);
    expect(await screen.findByDisplayValue('09:00')).toBeTruthy();
    expect(await screen.findByDisplayValue('12:00')).toBeTruthy();
  });
});
