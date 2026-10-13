import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { getToken, setToken } from './api';

// OIDC authorization-code flow with PKCE against the Parliament identity provider.
// Configure with VITE_OIDC_AUTHORITY and VITE_OIDC_CLIENT_ID. No client secret is used or needed.
const authority = import.meta.env['VITE_OIDC_AUTHORITY'] as string | undefined;
const clientId = import.meta.env['VITE_OIDC_CLIENT_ID'] as string | undefined;
const audience = import.meta.env['VITE_OIDC_AUDIENCE'] as string | undefined;

export const oidcConfigured = Boolean(authority && clientId);

let manager: UserManager | null = null;
const mgr = (): UserManager => {
  if (!authority || !clientId) throw new Error('Sign-in is not configured (VITE_OIDC_AUTHORITY / VITE_OIDC_CLIENT_ID)');
  manager ??= new UserManager({
    authority,
    client_id: clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: 'code',
    scope: 'openid profile email',
    extraQueryParams: audience ? { audience } : undefined,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
  return manager;
};

/** Starts the identity-provider redirect; `returnTo` is where the person lands afterwards. */
export const signIn = (returnTo: string = window.location.pathname) => mgr().signinRedirect({ state: { returnTo } });

/** Expiry (ms since epoch) of a JWT access token, or null when the token is opaque or unreadable. */
export function tokenExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True when a token is held and has not passed its expiry. */
export function hasSession(): boolean {
  const t = getToken();
  if (!t) return false;
  const exp = tokenExpiry(t);
  return exp === null || exp > Date.now();
}

/** Completes the redirect, stores the access token for API calls, returns the path to go back to. */
export async function completeSignIn(): Promise<string> {
  const user = await mgr().signinRedirectCallback();
  setToken(user.access_token);
  return (user.state as { returnTo?: string } | undefined)?.returnTo || '/documents';
}

/** Ends the local session, and the identity provider's too when it supports it. Always ends signed out. */
export async function signOut(): Promise<void> {
  setToken(null);
  if (!oidcConfigured) return;
  try {
    await mgr().removeUser();
    await mgr().signoutRedirect();
  } catch {
    /* the provider has no end-session endpoint: the local session is already gone */
  }
}
