import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
const overview = { generatedAt: new Date().toISOString(), documents: { PUBLISHED: 1 }, publishedChunks: 1, answers: { last7Days: 0, grounded: 0, groundedShare: null }, approvalsPending: 0, upcomingSittings: 0, billsByStage: {}, cases: { open: 0, overdue: 0, escalated: 0, failedNotifications: 0 }, system: { deadJobs: 0, activeUsers: 1 } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/me')) return json({ userId: 'u1', email: 'clerk@parliament.gov.gh', roles: ['ADMIN'], constituencyIds: [] });
    return json(overview);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('admin sign-in', () => {
  it('sends a signed-out visitor to the sign-in page instead of showing a console page', async () => {
    mount('/documents');
    expect(await screen.findByRole('heading', { name: 'Admin Console' })).toBeTruthy();
    expect(screen.queryByText('Hansard documents')).toBeNull();
  });

  it('shows the server message for a wrong password and stays on sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Incorrect email or password' }, 401)));
    mount('/signin');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.gh' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Incorrect email or password');
    expect(sessionStorage.getItem('parliament.access_token')).toBeNull();
  });

  it('asks for both fields before calling the server', async () => {
    mount('/signin');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter your email and password');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('signs in with email and password and lands in the console', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/login')) return json({ accessToken: 'jwt', expiresIn: 3600 });
      if (url.endsWith('/me')) return json({ userId: 'u1', email: 'clerk@parliament.gov.gh', roles: ['ADMIN'], constituencyIds: [] });
      return json(overview);
    }));
    mount('/signin');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'clerk@parliament.gov.gh' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('clerk@parliament.gov.gh')).toBeTruthy();
    expect(sessionStorage.getItem('parliament.access_token')).toBe('jwt');
  });

  it('signs out and says so', async () => {
    sessionStorage.setItem('parliament.access_token', 'tok');
    mount('/overview');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByText('You have been signed out.')).toBeTruthy());
    expect(sessionStorage.getItem('parliament.access_token')).toBeNull();
  });
});
