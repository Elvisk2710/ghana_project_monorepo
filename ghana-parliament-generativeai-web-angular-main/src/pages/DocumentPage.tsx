import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, RecordDetail } from '../api';
import { fmtDate, typeLabel } from './HansardsPage';

type State = { kind: 'loading' } | { kind: 'error'; error: ApiError } | { kind: 'done'; doc: RecordDetail };

/** The official text is shown as published; nothing here rewrites or replaces it. */
export default function DocumentPage() {
  const { id = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setState({ kind: 'loading' });
    api.record(id, ctl.signal)
      .then((doc) => setState({ kind: 'done', doc }))
      .catch((e) => { if (e.name !== 'AbortError') setState({ kind: 'error', error: e as ApiError }); });
    return () => ctl.abort();
  }, [id]);

  useEffect(() => { if (state.kind !== 'loading') heading.current?.focus(); }, [state.kind]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied('ok'); }
    catch { setCopied('failed'); }
  };

  if (state.kind === 'loading') return <p role="status" className="py-10 text-ink-soft">Loading record...</p>;
  if (state.kind === 'error') {
    return (
      <div className="py-10">
        <h1 ref={heading} tabIndex={-1} className="font-display text-[28px] font-semibold outline-none">{state.error.kind === 'not_found' ? 'Record not found' : 'We could not load this record'}</h1>
        <p role="alert" className="mt-2 text-ink-soft">{state.error.kind === 'not_found' ? 'It may have been withdrawn or the link may be wrong.' : state.error.message}</p>
        <p className="mt-4"><Link to="/hansards" className="font-semibold text-parliament-green-deep underline">Back to all records</Link></p>
      </div>
    );
  }
  const d = state.doc;
  return (
    <article className="py-10">
      <p className="mb-3 text-sm"><Link to="/hansards" className="font-semibold text-parliament-green-deep underline">All records</Link></p>
      <h1 ref={heading} tabIndex={-1} className="font-display text-[34px] font-semibold leading-tight outline-none">{d.title}</h1>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-soft">
        <div className="flex gap-1"><dt className="font-semibold">Type:</dt><dd>{typeLabel(d.type)}</dd></div>
        <div className="flex gap-1"><dt className="font-semibold">Date:</dt><dd>{fmtDate(d.documentDate)}</dd></div>
        <div className="flex gap-1"><dt className="font-semibold">Record ID:</dt><dd>{d.publicId}</dd></div>
        <div className="flex gap-1"><dt className="font-semibold">Version:</dt><dd>{d.version}</dd></div>
      </dl>
      <div className="mt-4">
        <button type="button" onClick={copy} className="rounded-xl border border-parliament-line bg-paper px-4 py-2 text-sm font-semibold">Copy link to this record</button>
        <span role="status" className="ml-3 text-sm">{copied === 'ok' ? 'Link copied.' : copied === 'failed' ? 'Could not copy. Copy the address from your browser.' : ''}</span>
      </div>
      <section aria-labelledby="official" className="mt-8">
        <h2 id="official" className="font-display text-[22px] font-semibold">Official text</h2>
        {d.extractedText
          ? <div className="mt-3 whitespace-pre-wrap rounded-portal border border-parliament-line bg-paper p-5 text-[15px] leading-7 shadow-portal">{d.extractedText}</div>
          : <p className="mt-3 text-ink-soft">The text of this record is not available online.</p>}
      </section>
    </article>
  );
}
