import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, Me, SESSION_EXPIRED, casesApi, getToken, loginWithPassword, setToken } from './api';
import { completeSignIn, hasSession, oidcConfigured, signIn, signOut as endSession, tokenExpiry } from './auth';

type Reason = 'expired' | 'signedOut' | null;
interface AuthState {
  signedIn: boolean;
  user: Me | null;
  /** Why the person is on the sign-in page, so it can say so. */
  reason: Reason;
  signOut: () => Promise<void>;
  /** Called after a token has been stored (callback page or the development token form). */
  refresh: () => void;
}

const Ctx = createContext<AuthState | null>(null);
export const useAuth = (): AuthState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(hasSession);
  const [user, setUser] = useState<Me | null>(null);
  const [reason, setReason] = useState<Reason>(null);

  const refresh = useCallback(() => { setSignedIn(hasSession()); setReason(null); }, []);

  // Another tab signing out, or the API rejecting the token, ends this session too.
  useEffect(() => {
    const expired = () => { setSignedIn(false); setUser(null); setReason('expired'); };
    const storage = () => { if (!hasSession()) expired(); };
    window.addEventListener(SESSION_EXPIRED, expired);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(SESSION_EXPIRED, expired); window.removeEventListener('storage', storage); };
  }, []);

  // End the session when the token reaches its own expiry rather than waiting for a failed request.
  useEffect(() => {
    const t = signedIn ? getToken() : null;
    const exp = t ? tokenExpiry(t) : null;
    if (exp === null) return;
    const id = window.setTimeout(() => { setToken(null); window.dispatchEvent(new Event(SESSION_EXPIRED)); }, Math.max(0, Math.min(exp - Date.now(), 2 ** 31 - 1)));
    return () => window.clearTimeout(id);
  }, [signedIn]);

  // Who is signed in: informational only (the server decides what the person may do), so a failure never blocks the console.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    casesApi.me().then((m) => { if (live) setUser(m); }).catch(() => undefined);
    return () => { live = false; };
  }, [signedIn]);

  const signOut = useCallback(async () => {
    setSignedIn(false); setUser(null); setReason('signedOut');
    await endSession();
  }, []);

  const value = useMemo(() => ({ signedIn, user, reason, signOut, refresh }), [signedIn, user, reason, signOut, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Keeps every console page behind sign-in, remembering where the person was headed. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { signedIn } = useAuth();
  const loc = useLocation();
  if (!signedIn) return <Navigate to="/signin" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}

const safeReturn = (p: unknown): string =>
  typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/signin') && !p.startsWith('/auth/') ? p : '/overview';

export function SignInPage() {
  const { signedIn, reason, refresh } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const target = safeReturn((loc.state as { from?: string } | null)?.from);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);

  if (signedIn) return <Navigate to={target} replace />;

  const start = async () => {
    setBusy(true); setError('');
    try { await signIn(target); } catch (e) { setError(e instanceof Error ? e.message : 'Could not start sign-in'); setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy(true); setError('');
    try {
      const { accessToken } = await loginWithPassword(email.trim(), password);
      setToken(accessToken);
      // The token only proves who you are; the server still decides whether this account may use the console.
      await casesApi.me();
      setPassword('');
      refresh();
      nav(target, { replace: true });
    } catch (err) {
      setToken(null);
      setError(err instanceof ApiError && err.status === 403 ? 'This account is not authorised to use the admin console.'
        : err instanceof ApiError && err.status === 401 ? err.message
        : err instanceof Error ? err.message : 'Could not sign in.');
    } finally { setBusy(false); }
  };

  return (
    <main className="signin">
      <section className="signin-card" aria-labelledby="signin-title">
        <img className="signin-crest" src="/assets/images/Coat_of_arms_of_Ghana.svg" alt="Coat of arms of Ghana" />
        <p className="signin-eyebrow">Parliament of Ghana</p>
        <h1 id="signin-title">Admin Console</h1>
        <p className="signin-lede">Sign in with your Parliament account to manage documents, cases and AI governance.</p>

        {reason === 'expired' && <div className="signin-note" role="status">Your session has ended. Please sign in again.</div>}
        {reason === 'signedOut' && <div className="signin-note ok" role="status">You have been signed out.</div>}
        {error && <div className="signin-note bad" role="alert">{error}</div>}

        <form onSubmit={submit} className="signin-form" noValidate>
          <label htmlFor="signin-email">Email</label>
          <input id="signin-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <label htmlFor="signin-password">Password</label>
          <div className="signin-pw">
            <input id="signin-password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="signin-show" onClick={() => setShow((v) => !v)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
          </div>
          <button type="submit" className="btn primary signin-btn" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
        </form>
        {oidcConfigured && (
          <>
            <div className="signin-or"><span>or</span></div>
            <button type="button" className="btn ghost signin-btn" onClick={start} disabled={busy}>Sign in with Parliament SSO</button>
          </>
        )}
        <p className="signin-foot">Access is by invitation. If you cannot sign in, contact your system administrator.</p>
      </section>
    </main>
  );
}

export function AuthCallback() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    completeSignIn()
      .then((p) => { if (!live) return; refresh(); nav(safeReturn(p), { replace: true }); })
      .catch((e) => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [nav, refresh]);
  return (
    <main className="signin">
      <section className="signin-card" aria-live="polite">
        <img className="signin-crest" src="/assets/images/Coat_of_arms_of_Ghana.svg" alt="" />
        {err ? (
          <>
            <h1>Sign-in failed</h1>
            <div className="signin-note bad" role="alert">{err}</div>
            <button type="button" className="btn primary signin-btn" onClick={() => nav('/signin', { replace: true })}>Back to sign in</button>
          </>
        ) : (
          <>
            <h1>Signing you in</h1>
            <p className="signin-lede">One moment while we confirm your account.</p>
            <div className="signin-spinner" role="status" aria-label="Signing in" />
          </>
        )}
      </section>
    </main>
  );
}
