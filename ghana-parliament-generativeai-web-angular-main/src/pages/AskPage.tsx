import { FormEvent, Fragment, ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Answer, api, ApiError, AnswerStatus, Citation } from '../api';
import Feedback from '../components/Feedback';
import SourcePanel from '../components/SourcePanel';
import { useLanguage } from '../language';

const EXAMPLES = ['What did Parliament say about fuel prices?', 'Debates on the cost of living', 'Water and sanitation funding', 'Healthcare budget'];

const STATUS_TITLE: Record<Exclude<AnswerStatus, 'grounded' | 'conflicting_sources'>, string> = {
  no_evidence: 'Nothing found in the published record',
  needs_clarification: 'Can you tell us a little more?',
  unsupported_language: 'This language is not available yet',
  safety_refusal: 'We cannot help with that request',
  service_unavailable: 'The service is temporarily unavailable',
  answering_paused: 'Ask Parliament is paused for now',
};

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiError }
  | { kind: 'done'; answer: Answer };

const CONFIDENCE: Record<string, string> = { high: 'Strong match', medium: 'Moderate match', low: 'Weak match: check the sources carefully' };

/** Turns "[2]" markers into buttons that open the matching source. */
function withCitationLinks(text: string, citations: Citation[], open: (c: Citation) => void): ReactNode[] {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    const c = m && citations.find((x) => x.n === Number(m[1]));
    if (!c) return <Fragment key={i}>{part}</Fragment>;
    return (
      <button key={i} type="button" onClick={() => open(c)} aria-label={`Source ${c.n}: ${c.title}`} className="mx-0.5 rounded bg-green-wash px-1.5 text-xs font-bold text-parliament-green-deep underline">
        {c.n}
      </button>
    );
  });
}

export default function AskPage() {
  const { current } = useLanguage();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [openSource, setOpenSource] = useState<Citation | null>(null);
  const [paused, setPaused] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => () => abort.current?.abort(), []);
  // Say so up front when staff have paused answering. If the check fails the page behaves as normal.
  useEffect(() => {
    const ctl = new AbortController();
    api.answeringStatus(ctl.signal).then((s) => setPaused(s.enabled ? null : s.message ?? 'Ask Parliament is paused for now.')).catch(() => undefined);
    return () => ctl.abort();
  }, []);
  useEffect(() => { if (state.kind === 'done' || state.kind === 'error') heading.current?.focus(); }, [state]);

  const submit = async (e?: FormEvent, text = query) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setOpenSource(null);
    setState({ kind: 'loading' });
    try {
      const answer = await api.ask(q, current.code, ctl.signal);
      setState({ kind: 'done', answer });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState({ kind: 'error', error: err as ApiError });
    }
  };

  const pick = (p: string) => { setQuery(p); void submit(undefined, p); };

  return (
    <div>
      <section className="py-12 text-center sm:py-16">
        <p className="mb-6 inline-flex rounded-full bg-green-wash px-[15px] py-[7px] text-xs font-bold uppercase text-parliament-green-deep">Plain-language access to the parliamentary record</p>
        <h1 className="mx-auto max-w-[16ch] font-display text-[clamp(34px,5.4vw,60px)] font-semibold leading-[1.05]">
          Ask Parliament. <em className="italic text-parliament-green">Check the source.</em>
        </h1>
        <p className="mx-auto mt-5 max-w-[54ch] text-[17px] leading-7 text-ink-soft">
          Search what Parliament has said and done. Every answer comes only from published records, with the sources shown so you can read them yourself.
        </p>

        {paused && <p role="status" className="mx-auto mt-6 max-w-[720px] rounded-portal border border-parliament-line bg-green-wash p-4 text-left text-[15px]"><b>Ask Parliament is paused.</b> {paused} <Link to="/hansards" className="font-semibold text-parliament-green-deep underline">Browse the Hansards</Link></p>}

        <form onSubmit={submit} role="search" aria-label="Ask Parliament" className="mx-auto mt-9 flex max-w-[720px] flex-col gap-2 rounded-portal border border-parliament-line bg-paper p-2 text-left shadow-portal sm:flex-row">
          <label htmlFor="question" className="sr-only">Your question</label>
          <input
            id="question" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={500} autoComplete="off"
            className="min-h-12 flex-1 border-0 bg-transparent px-3 text-base outline-none focus-visible:outline-2 focus-visible:outline-parliament-green"
            placeholder="For example: What did Parliament say about fuel prices?"
          />
          <button type="submit" disabled={state.kind === 'loading' || !query.trim() || !!paused} className="rounded-xl bg-parliament-green px-6 py-3.5 font-semibold text-white disabled:opacity-60">
            {state.kind === 'loading' ? 'Searching...' : 'Ask'}
          </button>
        </form>
        <p className="mx-auto mt-3 max-w-[720px] text-xs text-ink-soft">Please do not type personal details such as phone numbers or ID numbers.</p>

        <div className="mt-5 flex flex-wrap justify-center gap-2.5" aria-label="Example questions" role="group">
          {EXAMPLES.map((p) => (
            <button key={p} type="button" onClick={() => pick(p)} className="rounded-full border border-parliament-line bg-paper px-4 py-2 text-[13px] text-ink-soft hover:bg-green-wash">{p}</button>
          ))}
        </div>
      </section>

      <div aria-live="polite" className="mx-auto max-w-[780px]">
        {state.kind === 'loading' && <p role="status" className="rounded-portal border border-parliament-line bg-paper p-6 text-center text-ink-soft">Looking through the published record...</p>}

        {state.kind === 'error' && (
          <article className="rounded-portal border border-parliament-line bg-paper p-6 shadow-portal">
            <h2 ref={heading} tabIndex={-1} className="font-display text-[19px] font-semibold outline-none">We could not get an answer</h2>
            <p role="alert" className="mt-2 text-ink-soft">{state.error.message}</p>
            <button type="button" onClick={() => submit()} className="mt-4 rounded-xl bg-parliament-green px-5 py-2.5 font-semibold text-white">Try again</button>
          </article>
        )}

        {state.kind === 'done' && <AnswerCard answer={state.answer} heading={heading} openSource={openSource} setOpenSource={setOpenSource} />}
      </div>

      <section aria-labelledby="more" className="mt-14">
        <div className="mb-6 flex items-baseline gap-3.5"><h2 id="more" className="font-display text-[28px] font-semibold">What you can do</h2><span className="h-px flex-1 bg-parliament-line" aria-hidden="true" /></div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <article className="rounded-portal border border-parliament-line bg-paper p-6 shadow-portal">
            <h3 className="mb-2 font-display text-[19px] font-semibold">Browse the Hansards</h3>
            <p className="text-sm leading-6 text-ink-soft">Search published records by topic and date and read the official text.</p>
            <Link to="/hansards" className="mt-3 inline-block font-semibold text-parliament-green-deep underline">Browse records</Link>
          </article>
          <article className="rounded-portal border border-parliament-line bg-paper p-6 shadow-portal">
            <h3 className="mb-2 font-display text-[19px] font-semibold">Find your MP</h3>
            <p className="text-sm leading-6 text-ink-soft">Look up your constituency and see who represents you in Parliament.</p>
            <Link to="/my-mp" className="mt-3 inline-block font-semibold text-parliament-green-deep underline">Find my MP</Link>
          </article>
          <article className="rounded-portal border border-parliament-line bg-paper p-6 shadow-portal">
            <h3 className="mb-2 font-display text-[19px] font-semibold">Raise an issue</h3>
            <p className="text-sm leading-6 text-ink-soft">Send an issue to your constituency office and track its progress.</p>
            <Link to="/issues" className="mt-3 inline-block font-semibold text-parliament-green-deep underline">Report an issue</Link>
          </article>
        </div>
      </section>
    </div>
  );
}

function AnswerCard({ answer, heading, openSource, setOpenSource }: { answer: Answer; heading: React.RefObject<HTMLHeadingElement | null>; openSource: Citation | null; setOpenSource: (c: Citation | null) => void }) {
  const grounded = answer.status === 'grounded' || answer.status === 'conflicting_sources';
  const open = (c: Citation) => setOpenSource(c);
  const lines = (answer.answer ?? '').split('\n').filter((l) => l.trim());
  return (
    <article className="rounded-portal border border-parliament-line bg-paper text-left shadow-portal">
      <header className="border-b border-parliament-line bg-green-wash px-5 py-[18px]">
        <h2 ref={heading} tabIndex={-1} className="font-display text-[19px] font-semibold outline-none">
          {grounded ? (answer.status === 'conflicting_sources' ? 'The published records disagree' : 'From the published record') : STATUS_TITLE[answer.status as keyof typeof STATUS_TITLE]}
        </h2>
        {grounded && answer.confidence && <p className="mt-1 text-xs text-ink-soft">{CONFIDENCE[answer.confidence]}</p>}
      </header>
      <div className="px-5 py-6">
        {answer.message && <p className="text-[15px] leading-6">{answer.message}</p>}
        {grounded && (
          <div className="text-[15px] leading-7">
            {lines.map((l, i) => l.startsWith('- ')
              ? <p key={i} className="mb-2 border-l-4 border-parliament-line pl-3">{withCitationLinks(l.slice(2), answer.citations, open)}</p>
              : <p key={i} className="mb-2">{withCitationLinks(l, answer.citations, open)}</p>)}
          </div>
        )}

        {grounded && answer.citations.length > 0 && (
          <section aria-label="Sources" className="mt-5">
            <h3 className="mb-2 text-sm font-semibold">Sources</h3>
            <ol className="grid gap-2">
              {answer.citations.map((c) => (
                <li key={c.n} className="rounded-xl border border-parliament-line px-3.5 py-3 text-[13px]">
                  <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
                    <b>[{c.n}] {c.title}</b>
                    <span className="text-ink-soft sm:ml-auto">{c.date ?? ''}{c.anchor ? ` - ${c.anchor}` : ''}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4">
                    <button type="button" aria-expanded={openSource?.n === c.n} onClick={() => setOpenSource(openSource?.n === c.n ? null : c)} className="font-semibold text-parliament-green-deep underline">
                      {openSource?.n === c.n ? 'Hide passage' : 'View passage'}
                    </button>
                    <Link to={`/hansards/${encodeURIComponent(c.documentId)}`} className="font-semibold text-parliament-green-deep underline">Open full record</Link>
                  </div>
                  {openSource?.n === c.n && <SourcePanel documentId={c.documentId} anchor={c.anchor} onClose={() => setOpenSource(null)} />}
                </li>
              ))}
            </ol>
          </section>
        )}

        {answer.status === 'no_evidence' && <p className="mt-4"><Link to="/hansards" className="font-semibold text-parliament-green-deep underline">Browse the Hansards instead</Link></p>}
        {answer.status === 'unsupported_language' && <p className="mt-4 text-sm text-ink-soft">Use the language menu at the top of the page to switch to English.</p>}
        <p className="mt-5 text-xs leading-5 text-ink-soft">{answer.disclosure}</p>
        {answer.answerId !== 'unsaved' && <Feedback answerId={answer.answerId} />}
      </div>
    </article>
  );
}
