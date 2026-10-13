import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, PassageResult } from '../api';

/** Shows the exact passage a citation points to, with a link to the full official record. */
export default function SourcePanel({ documentId, anchor, onClose }: { documentId: string; anchor: string | null; onClose: () => void }) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ok'; data: PassageResult } | { kind: 'error'; message: string }>({ kind: 'loading' });

  useEffect(() => {
    if (!anchor) { setState({ kind: 'error', message: 'This citation has no passage location. Open the full record instead.' }); return; }
    const ctl = new AbortController();
    setState({ kind: 'loading' });
    api.passage(documentId, anchor, ctl.signal)
      .then((data) => setState({ kind: 'ok', data }))
      .catch((e) => { if (e.name !== 'AbortError') setState({ kind: 'error', message: (e as ApiError).message }); });
    return () => ctl.abort();
  }, [documentId, anchor]);

  return (
    <section aria-label={`Source passage from ${documentId}`} className="mt-2 rounded-xl border border-parliament-line bg-cream p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <h4 className="font-semibold">Passage from the official record{anchor ? ` (${anchor})` : ''}</h4>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs font-semibold underline">Close</button>
      </div>
      {state.kind === 'loading' && <p role="status" className="mt-2 text-ink-soft">Loading passage...</p>}
      {state.kind === 'error' && <p role="alert" className="mt-2 text-[#8a1c13]">{state.message}</p>}
      {state.kind === 'ok' && state.data.passages.map((p, i) => (
        <blockquote key={i} className="mt-2 whitespace-pre-wrap border-l-4 border-parliament-green pl-3 leading-6">{p.text}</blockquote>
      ))}
      <p className="mt-3"><Link className="font-semibold text-parliament-green-deep underline" to={`/hansards/${encodeURIComponent(documentId)}`}>Open the full record</Link></p>
    </section>
  );
}
