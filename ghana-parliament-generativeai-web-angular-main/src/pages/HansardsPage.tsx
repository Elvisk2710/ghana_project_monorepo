import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, RecordPage } from '../api';

const TYPES: [string, string][] = [['', 'All types'], ['HANSARD', 'Hansard'], ['ORDER_PAPER', 'Order paper'], ['BILL_TEXT', 'Bill text'], ['COMMITTEE_REPORT', 'Committee report'], ['OTHER', 'Other']];
export const typeLabel = (t: string) => TYPES.find(([v]) => v === t)?.[1] ?? t;
export const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Date not recorded');

type State = { kind: 'loading' } | { kind: 'error'; error: ApiError } | { kind: 'done'; data: RecordPage };

/** Filters live in the URL so a search can be bookmarked or shared. */
export default function HansardsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const page = Math.max(parseInt(params.get('page') ?? '1', 10) || 1, 1);
  const [draft, setDraft] = useState({ q, type, from, to });
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setState({ kind: 'loading' });
    api.records({ q, type, from, to, page }, ctl.signal)
      .then((data) => setState({ kind: 'done', data }))
      .catch((e) => { if (e.name !== 'AbortError') setState({ kind: 'error', error: e as ApiError }); });
    return () => ctl.abort();
  }, [q, type, from, to, page, retry]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) return;
    const next: Record<string, string> = {};
    Object.entries(draft).forEach(([k, v]) => v && (next[k] = v));
    setParams(next);
  };
  const goto = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
    heading.current?.focus();
  };
  const badRange = !!draft.from && !!draft.to && draft.from > draft.to;

  return (
    <div className="py-10">
      <h1 ref={heading} tabIndex={-1} className="font-display text-[34px] font-semibold outline-none">Hansards and published records</h1>
      <p className="mt-2 max-w-[60ch] text-ink-soft">Official records published by Parliament. Open a record to read the full text.</p>

      <form onSubmit={apply} role="search" aria-label="Search records" className="mt-6 grid gap-4 rounded-portal border border-parliament-line bg-paper p-5 shadow-portal sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <label htmlFor="rq" className="mb-1 block text-sm font-semibold">Title contains</label>
          <input id="rq" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} className="w-full rounded-lg border border-parliament-line px-3 py-2" />
        </div>
        <div>
          <label htmlFor="rt" className="mb-1 block text-sm font-semibold">Type</label>
          <select id="rt" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} className="w-full rounded-lg border border-parliament-line bg-paper px-3 py-2">
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="rf" className="mb-1 block text-sm font-semibold">From</label>
          <input id="rf" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className="w-full rounded-lg border border-parliament-line px-3 py-2" />
        </div>
        <div>
          <label htmlFor="rto" className="mb-1 block text-sm font-semibold">To</label>
          <input id="rto" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-invalid={badRange} aria-describedby={badRange ? 'range-err' : undefined} className="w-full rounded-lg border border-parliament-line px-3 py-2" />
        </div>
        <div className="sm:col-span-2 lg:col-span-5">
          {badRange && <p id="range-err" role="alert" className="mb-2 text-sm text-[#8a1c13]">The start date must be before the end date.</p>}
          <button type="submit" disabled={badRange} className="rounded-xl bg-parliament-green px-6 py-2.5 font-semibold text-white disabled:opacity-60">Search</button>
          <button type="button" className="ml-3 font-semibold underline" onClick={() => { setDraft({ q: '', type: '', from: '', to: '' }); setParams({}); }}>Clear</button>
        </div>
      </form>

      <div aria-live="polite" className="mt-6">
        {state.kind === 'loading' && <p role="status" className="text-ink-soft">Loading records...</p>}
        {state.kind === 'error' && (
          <div role="alert" className="rounded-portal border border-parliament-line bg-paper p-5">
            <p>{state.error.message}</p>
            <button type="button" onClick={() => setRetry((n) => n + 1)} className="mt-3 rounded-xl bg-parliament-green px-5 py-2 font-semibold text-white">Try again</button>
          </div>
        )}
        {state.kind === 'done' && (
          state.data.items.length === 0 ? (
            <p className="rounded-portal border border-parliament-line bg-paper p-5">No published records match your search. Try fewer words or a wider date range.</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-soft">{state.data.total} {state.data.total === 1 ? 'record' : 'records'} - page {state.data.page} of {state.data.totalPages}</p>
              <ul className="grid gap-3">
                {state.data.items.map((r) => (
                  <li key={r.publicId} className="rounded-xl border border-parliament-line bg-paper p-4">
                    <Link to={`/hansards/${encodeURIComponent(r.publicId)}`} className="font-display text-[18px] font-semibold text-parliament-green-deep underline">{r.title}</Link>
                    <p className="mt-1 text-sm text-ink-soft">{typeLabel(r.type)} - {fmtDate(r.documentDate)} - {r.publicId}</p>
                  </li>
                ))}
              </ul>
              <nav aria-label="Pagination" className="mt-6 flex items-center gap-4">
                <button type="button" disabled={state.data.page <= 1} onClick={() => goto(state.data.page - 1)} className="rounded-xl border border-parliament-line px-4 py-2 font-semibold disabled:opacity-50">Previous</button>
                <span aria-current="page">Page {state.data.page} of {state.data.totalPages}</span>
                <button type="button" disabled={state.data.page >= state.data.totalPages} onClick={() => goto(state.data.page + 1)} className="rounded-xl border border-parliament-line px-4 py-2 font-semibold disabled:opacity-50">Next</button>
              </nav>
            </>
          )
        )}
      </div>
    </div>
  );
}
