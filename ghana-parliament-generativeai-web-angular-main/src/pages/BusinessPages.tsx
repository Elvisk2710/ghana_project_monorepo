import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, BillStage, DocLink } from '../api';
import { primaryButton } from '../components/Field';
import { fmtDate, typeLabel } from './HansardsPage';

export const STAGE_LABEL: Record<BillStage, string> = {
  FIRST_READING: 'First reading', COMMITTEE: 'In committee', SECOND_READING: 'Second reading', CONSIDERATION: 'Consideration stage',
  THIRD_READING: 'Third reading', ASSENTED: 'Assented', WITHDRAWN: 'Withdrawn',
};
const STATUS_LABEL = { SCHEDULED: 'Scheduled', HELD: 'Held', CANCELLED: 'Cancelled' } as const;

type State<T> = { kind: 'loading' } | { kind: 'error'; error: ApiError } | { kind: 'done'; data: T };

/** Loads one resource; every page below shares the same loading, error and not-found handling. */
function useFetch<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<State<T>>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setState({ kind: 'loading' });
    load(ctl.signal).then((data) => setState({ kind: 'done', data })).catch((e) => { if (e.name !== 'AbortError') setState({ kind: 'error', error: e as ApiError }); });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, retry]);
  return { state, retry: () => setRetry((n) => n + 1) };
}

function Page({ title, intro, children, headingRef }: { title: string; intro?: string; children: ReactNode; headingRef?: React.RefObject<HTMLHeadingElement | null> }) {
  return (
    <div className="max-w-[900px] py-10">
      <h1 ref={headingRef} tabIndex={-1} className="font-display text-[34px] font-semibold outline-none">{title}</h1>
      {intro && <p className="mt-2 max-w-[60ch] text-ink-soft">{intro}</p>}
      {children}
    </div>
  );
}

function Status<T>({ s, retry, what, children }: { s: State<T>; retry: () => void; what: string; children: (d: T) => ReactNode }) {
  if (s.kind === 'loading') return <p role="status" className="mt-6 text-ink-soft">Loading...</p>;
  if (s.kind === 'error') {
    return s.error.kind === 'not_found'
      ? <p role="alert" className="mt-6 rounded-portal border border-parliament-line bg-paper p-5">We could not find that {what}. It may not be published. <Link to="/bills" className="font-semibold text-parliament-green-deep underline">Back to bills</Link></p>
      : <div role="alert" className="mt-6 rounded-portal border border-parliament-line bg-paper p-5"><p>{s.error.message}</p><button type="button" onClick={retry} className={`${primaryButton} mt-3`}>Try again</button></div>;
  }
  return <>{children(s.data)}</>;
}

const DocList = ({ docs }: { docs: DocLink[] }) => (
  <ul className="mt-3 grid gap-2">
    {docs.map((d) => (
      <li key={d.publicId} className="rounded-xl border border-parliament-line bg-paper p-3">
        <Link to={`/hansards/${encodeURIComponent(d.publicId)}`} className="font-semibold text-parliament-green-deep underline">{d.title}</Link>
        <p className="text-sm text-ink-soft">{typeLabel(d.type)} - {fmtDate(d.documentDate)}</p>
      </li>
    ))}
  </ul>
);

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section aria-labelledby={id} className="mt-8"><h2 id={id} className="font-display text-[22px] font-semibold">{title}</h2>{children}</section>
);

const SubNav = () => (
  <nav aria-label="Parliamentary business" className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold">
    <Link to="/bills" className="text-parliament-green-deep underline">Bills</Link>
    <Link to="/sittings" className="text-parliament-green-deep underline">Sittings</Link>
    <Link to="/committees" className="text-parliament-green-deep underline">Committees</Link>
  </nav>
);

// ---------------------------------------------------------------- Bills

export function BillsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const stage = params.get('stage') ?? '';
  const [draft, setDraft] = useState(q);
  const { state, retry } = useFetch((signal) => api.bills({ q, stage }, signal), [q, stage]);
  const apply = (e: FormEvent) => { e.preventDefault(); const n = new URLSearchParams(params); draft.trim() ? n.set('q', draft.trim()) : n.delete('q'); setParams(n); };
  return (
    <Page title="Bills" intro="Bills before Parliament, where they stand, and the sittings and records that mention them. Only bills Parliament has approved for publication are listed.">
      <SubNav />
      <form onSubmit={apply} role="search" aria-label="Search bills" className="mt-6 flex flex-wrap items-end gap-4 rounded-portal border border-parliament-line bg-paper p-5 shadow-portal">
        <div className="grow"><label htmlFor="bq" className="mb-1 block text-sm font-semibold">Title contains</label><input id="bq" value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full rounded-lg border border-parliament-line px-3 py-2" /></div>
        <div><label htmlFor="bs" className="mb-1 block text-sm font-semibold">Stage</label>
          <select id="bs" value={stage} onChange={(e) => { const n = new URLSearchParams(params); e.target.value ? n.set('stage', e.target.value) : n.delete('stage'); setParams(n); }} className="rounded-lg border border-parliament-line bg-paper px-3 py-2">
            <option value="">All stages</option>{Object.entries(STAGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        <button type="submit" className={primaryButton}>Search</button>
      </form>
      <div aria-live="polite">
        <Status s={state} retry={retry} what="bills">
          {({ items }) => items.length === 0
            ? <p className="mt-6 rounded-portal border border-parliament-line bg-paper p-5">No published bills match. Bills appear here once Parliament approves them for publication.</p>
            : <ul className="mt-6 grid gap-3">{items.map((b) => (
                <li key={b.id} className="rounded-xl border border-parliament-line bg-paper p-4">
                  <Link to={`/bills/${b.id}`} className="font-display text-[18px] font-semibold text-parliament-green-deep underline">{b.title}</Link>
                  <p className="mt-1 text-sm text-ink-soft"><strong>{STAGE_LABEL[b.stage]}</strong>{b.committee ? ` - ${b.committee.name}` : ''}{b.introducedOn ? ` - introduced ${fmtDate(b.introducedOn)}` : ''}</p>
                </li>))}</ul>}
        </Status>
      </div>
    </Page>
  );
}

export function BillPage() {
  const { id = '' } = useParams();
  const h = useRef<HTMLHeadingElement>(null);
  const { state, retry } = useFetch((s) => api.bill(id, s), [id]);
  useEffect(() => { if (state.kind !== 'loading') h.current?.focus(); }, [state.kind]);
  if (state.kind !== 'done') return <Page title={state.kind === 'error' && state.error.kind === 'not_found' ? 'Bill not found' : 'Bill'} headingRef={h}><Status s={state} retry={retry} what="bill">{() => null}</Status></Page>;
  const b = state.data;
  return (
    <Page title={b.title} headingRef={h}>
      <p className="mt-2 text-ink-soft"><strong>{STAGE_LABEL[b.stage]}</strong>{b.sponsor ? ` - sponsor: ${b.sponsor}` : ''}{b.introducedOn ? ` - introduced ${fmtDate(b.introducedOn)}` : ''}</p>
      {b.summary && <Section id="sum" title="Summary"><p className="mt-2 leading-7">{b.summary}</p><p className="mt-2 text-sm text-ink-soft">This summary was written by Parliament staff to help you read the bill. The bill text and official records are the authority.</p></Section>}
      <Section id="comm" title="Committee">{b.committee ? <p className="mt-2"><Link to={`/committees/${b.committee.id}`} className="font-semibold text-parliament-green-deep underline">{b.committee.name}</Link></p> : <p className="mt-2 text-ink-soft">Not assigned to a published committee.</p>}</Section>
      <Section id="sit" title="Sittings that considered this bill">
        {b.sittings.length ? <ul className="mt-3 grid gap-2">{b.sittings.map((s) => <li key={s.id}><Link to={`/sittings/${s.id}`} className="font-semibold text-parliament-green-deep underline">{s.type} - {fmtDate(s.date)}</Link></li>)}</ul> : <p className="mt-2 text-ink-soft">No published sittings are linked yet.</p>}
      </Section>
      <Section id="docs" title="Official records">{b.documents.length ? <DocList docs={b.documents} /> : <p className="mt-2 text-ink-soft">No published records are linked yet.</p>}</Section>
    </Page>
  );
}

// ---------------------------------------------------------------- Sittings

export function SittingsPage() {
  const { state, retry } = useFetch((s) => api.sittings(s), []);
  return (
    <Page title="Sittings" intro="Sittings of Parliament with their order papers and records, once approved for publication.">
      <SubNav />
      <div aria-live="polite">
        <Status s={state} retry={retry} what="sittings">
          {({ items }) => items.length === 0
            ? <p className="mt-6 rounded-portal border border-parliament-line bg-paper p-5">No sittings have been published yet.</p>
            : <ul className="mt-6 grid gap-3">{items.map((s) => (
                <li key={s.id} className="rounded-xl border border-parliament-line bg-paper p-4">
                  <Link to={`/sittings/${s.id}`} className="font-display text-[18px] font-semibold text-parliament-green-deep underline">{s.type} - {fmtDate(s.date)}</Link>
                  <p className="mt-1 text-sm text-ink-soft">{STATUS_LABEL[s.status]}</p>
                </li>))}</ul>}
        </Status>
      </div>
    </Page>
  );
}

export function SittingPage() {
  const { id = '' } = useParams();
  const h = useRef<HTMLHeadingElement>(null);
  const { state, retry } = useFetch((s) => api.sitting(id, s), [id]);
  useEffect(() => { if (state.kind !== 'loading') h.current?.focus(); }, [state.kind]);
  if (state.kind !== 'done') return <Page title="Sitting" headingRef={h}><Status s={state} retry={retry} what="sitting">{() => null}</Status></Page>;
  const s = state.data;
  return (
    <Page title={`${s.type} - ${fmtDate(s.date)}`} headingRef={h}>
      <p className="mt-2 text-ink-soft">{STATUS_LABEL[s.status]}</p>
      <Section id="agenda" title="Order paper">
        {s.agenda.length ? (
          <ol className="mt-3 list-decimal space-y-2 pl-6">{s.agenda.map((a, i) => <li key={i}>{a.billId ? <Link to={`/bills/${a.billId}`} className="font-semibold text-parliament-green-deep underline">{a.title}</Link> : a.title}</li>)}</ol>
        ) : <p className="mt-2 text-ink-soft">No order paper has been published for this sitting.</p>}
      </Section>
      <Section id="bills" title="Bills considered">{s.bills.length ? <ul className="mt-3 grid gap-2">{s.bills.map((b) => <li key={b.id}><Link to={`/bills/${b.id}`} className="font-semibold text-parliament-green-deep underline">{b.title}</Link> <span className="text-sm text-ink-soft">({STAGE_LABEL[b.stage]})</span></li>)}</ul> : <p className="mt-2 text-ink-soft">No published bills are linked.</p>}</Section>
      <Section id="docs" title="Official records">{s.documents.length ? <DocList docs={s.documents} /> : <p className="mt-2 text-ink-soft">No published records are linked yet.</p>}</Section>
    </Page>
  );
}

// ---------------------------------------------------------------- Committees

export function CommitteesPage() {
  const { state, retry } = useFetch((s) => api.committees(s), []);
  return (
    <Page title="Committees" intro="Parliamentary committees and what they cover.">
      <SubNav />
      <div aria-live="polite">
        <Status s={state} retry={retry} what="committees">
          {({ items }) => items.length === 0
            ? <p className="mt-6 rounded-portal border border-parliament-line bg-paper p-5">No committees have been published yet.</p>
            : <ul className="mt-6 grid gap-3">{items.map((c) => (
                <li key={c.id} className="rounded-xl border border-parliament-line bg-paper p-4">
                  <Link to={`/committees/${c.id}`} className="font-display text-[18px] font-semibold text-parliament-green-deep underline">{c.name}</Link>
                  {c.remit && <p className="mt-1 text-sm text-ink-soft">{c.remit}</p>}
                </li>))}</ul>}
        </Status>
      </div>
    </Page>
  );
}

export function CommitteePage() {
  const { id = '' } = useParams();
  const h = useRef<HTMLHeadingElement>(null);
  const { state, retry } = useFetch((s) => api.committee(id, s), [id]);
  useEffect(() => { if (state.kind !== 'loading') h.current?.focus(); }, [state.kind]);
  if (state.kind !== 'done') return <Page title="Committee" headingRef={h}><Status s={state} retry={retry} what="committee">{() => null}</Status></Page>;
  const c = state.data;
  return (
    <Page title={c.name} intro={c.remit ?? undefined} headingRef={h}>
      <Section id="chair" title="Chair">{c.chair ? <p className="mt-2">{c.chair.name}</p> : <p className="mt-2 text-ink-soft">Not published.</p>}</Section>
      <Section id="members" title="Members">
        {c.members.length ? <ul className="mt-3 grid gap-1">{c.members.map((m) => <li key={m.id}>{m.name} <span className="text-sm text-ink-soft">- {m.party}{m.role !== 'Member' ? `, ${m.role}` : ''}</span></li>)}</ul> : <p className="mt-2 text-ink-soft">No published members.</p>}
      </Section>
      <Section id="bills" title="Bills before this committee">{c.bills.length ? <ul className="mt-3 grid gap-2">{c.bills.map((b) => <li key={b.id}><Link to={`/bills/${b.id}`} className="font-semibold text-parliament-green-deep underline">{b.title}</Link> <span className="text-sm text-ink-soft">({STAGE_LABEL[b.stage]})</span></li>)}</ul> : <p className="mt-2 text-ink-soft">No published bills.</p>}</Section>
    </Page>
  );
}

