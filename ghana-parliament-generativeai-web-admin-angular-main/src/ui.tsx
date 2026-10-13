import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError, Me, casesApi } from './api';
import { TokenBox } from './DocumentsScreen';

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : '-');
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '-');
export const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, ' ');

/** Loads data once and on demand. A 401 turns into a sign-in prompt, other failures into a message. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError('');
      setNeedsToken(false);
    } catch (e) {
      const err = e as ApiError;
      setNeedsToken(err.status === 401);
      setError(err.status === 403 ? 'Your role does not allow you to see this.' : err.message);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => { reload(); }, [reload]);
  return { data, setData, error, needsToken, loading, reload };
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { casesApi.me().then(setMe).catch(() => undefined); }, []);
  return me;
}
export const hasRole = (me: Me | null, ...roles: string[]) => !!me && roles.some((r) => me.roles.includes(r));

export function Banner({ error, notice, needsToken, onToken }: { error?: string; notice?: string; needsToken?: boolean; onToken?: () => void }) {
  return (
    <>
      {needsToken && <TokenBox onSaved={onToken ?? (() => undefined)} />}
      {error && !needsToken && <div role="alert" className="badge bad" style={{ display: 'block', margin: '8px 0', padding: '8px 12px' }}>{error}</div>}
      {notice && <div role="status" className="badge" style={{ display: 'block', margin: '8px 0', padding: '8px 12px' }}>{notice}</div>}
    </>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="panel dialog">
      <div className="panel-head"><h3>{title}</h3><button type="button" className="btn ghost" onClick={onClose}>Cancel</button></div>
      {children}
    </div>
  );
}

/** Checkbox list for choosing several items (sittings, MPs, roles). */
export function CheckList<T extends string>({ legend, options, value, onChange }: { legend: string; options: { id: T; label: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <fieldset className="checklist">
      <legend>{legend}</legend>
      {options.length === 0 && <p className="sub">Nothing to choose from yet.</p>}
      {options.map((o) => (
        <label key={o.id}><input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} /> {o.label}</label>
      ))}
    </fieldset>
  );
}

export const publicationBadge = (published: boolean, pending?: boolean) =>
  pending ? <span className="badge warn">Approval pending</span> : published ? <span className="badge">Published</span> : <span className="badge warn">Not public</span>;
