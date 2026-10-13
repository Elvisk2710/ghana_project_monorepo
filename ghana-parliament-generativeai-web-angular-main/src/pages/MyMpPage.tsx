import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, ConstituencyMatch, ConstituencyOption, PublicMp } from '../api';
import { Field, primaryButton, secondaryButton } from '../components/Field';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Lets a citizen request a meeting inside one of the MP's published weekly availability windows. */
function RequestMeeting({ mp }: { mp: PublicMp }) {
  const [open, setOpen] = useState(false);
  const [windows, setWindows] = useState<{ dayOfWeek: number; startTime: string; endTime: string }[] | null>(null);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [windowIndex, setWindowIndex] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ requestedSlot: string } | null>(null);

  useEffect(() => {
    if (!open || windows !== null) return;
    api.mpAvailability(mp.id).then(setWindows).catch(() => setError('The MP’s availability could not be loaded.'));
  }, [open, windows, mp.id]);

  const chosenWindow = windows?.[Number(windowIndex)];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !topic.trim() || !chosenWindow || !date || !time) return;
    const slot = new Date(`${date}T${time}:00Z`);
    setBusy(true); setError('');
    try {
      const r = await api.requestMeeting({ mpId: mp.id, requestedName: name.trim(), topic: topic.trim(), requestedSlot: slot.toISOString() });
      setDone({ requestedSlot: r.requestedSlot });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <p className="mt-2"><button type="button" onClick={() => setOpen(true)} className="font-semibold text-parliament-green-deep underline">Request a meeting with {mp.name}</button></p>;
  }

  if (done) {
    return <p className="mt-3 rounded-lg bg-green-wash px-4 py-3 text-sm">Your meeting request has been sent. The office will confirm or decline it.</p>;
  }

  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 rounded-lg border border-parliament-line bg-paper p-4" noValidate>
      <p className="text-sm font-semibold">Request a meeting with {mp.name}</p>
      {windows === null && !error && <p className="text-sm text-ink-soft">Loading available times...</p>}
      {windows !== null && windows.length === 0 && <p className="text-sm text-ink-soft">This office has not published any available times yet.</p>}
      {windows !== null && windows.length > 0 && (
        <>
          <Field id="meeting-name" label="Your name">{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
          <Field id="meeting-topic" label="What is it about?">{(p) => <input {...p} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} />}</Field>
          <Field id="meeting-window" label="Available time" hint="Pick one of the office's open windows, then choose a date and time inside it.">
            {(p) => (
              <select {...p} value={windowIndex} onChange={(e) => setWindowIndex(e.target.value)}>
                <option value="">Choose a window</option>
                {windows.map((w, i) => <option key={i} value={i}>{`${DAY_NAMES[w.dayOfWeek]}s, ${w.startTime}–${w.endTime}`}</option>)}
              </select>
            )}
          </Field>
          {chosenWindow && (
            <div className="grid grid-cols-2 gap-3">
              <Field id="meeting-date" label="Date">{(p) => <input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
              <Field id="meeting-time" label="Time" hint={`Between ${chosenWindow.startTime} and ${chosenWindow.endTime}`}>{(p) => <input {...p} type="time" min={chosenWindow.startTime} max={chosenWindow.endTime} value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="text-sm text-[#8a1c13]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !windows?.length} className={primaryButton}>{busy ? 'Sending...' : 'Send request'}</button>
        <button type="button" onClick={() => setOpen(false)} className={secondaryButton}>Cancel</button>
      </div>
    </form>
  );
}

type Result =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiError }
  | { kind: 'done'; query: string; matches: ConstituencyMatch[] };

const MATCH_LABEL: Record<ConstituencyMatch['matchedOn'], string> = {
  exact_name: 'Exact match', code: 'Code match', alias: 'Alternative name', starts_with: 'Partial match', contains: 'Partial match',
};

function MpCard({ mp, constituency }: { mp: PublicMp | null; constituency: string }) {
  if (!mp) {
    return <p className="mt-3 rounded-lg bg-gold-wash px-4 py-3 text-sm">No published MP record is available for {constituency} yet, so we cannot show a name or contact details. You can still raise an issue for this constituency&apos;s office.</p>;
  }
  const contact = Object.entries(mp.contact ?? {});
  return (
    <div className="mt-3 rounded-lg bg-green-wash px-4 py-3">
      <p className="font-display text-[18px] font-semibold">{mp.name}</p>
      <p className="text-sm text-ink-soft">{mp.party}{mp.roleTitle ? ` - ${mp.roleTitle}` : ''} - Member since {mp.since}</p>
      {contact.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {contact.map(([k, v]) => (<div key={k} className="contents"><dt className="font-semibold capitalize">{k}</dt><dd>{v}</dd></div>))}
        </dl>
      )}
      <RequestMeeting mp={mp} />
    </div>
  );
}

function ConstituencyResult({ c, mp, explanation, badge }: { c: ConstituencyOption; mp: PublicMp | null; explanation: string; badge?: string }) {
  return (
    <li className="rounded-xl border border-parliament-line bg-paper p-5">
      <h3 className="font-display text-[20px] font-semibold">{c.name} <span className="text-base font-normal text-ink-soft">- {c.region}</span></h3>
      {badge && <p className="mt-1 inline-block rounded-full bg-green-wash px-3 py-0.5 text-xs font-bold text-parliament-green-deep">{badge}</p>}
      <p className="mt-2 text-sm"><strong>How we matched this:</strong> {explanation}</p>
      <MpCard mp={mp} constituency={c.name} />
      <p className="mt-4"><Link to={`/issues/new?constituency=${encodeURIComponent(c.id)}`} className="font-semibold text-parliament-green-deep underline">Raise an issue with {c.name}</Link></p>
    </li>
  );
}

/** Find my MP: type a constituency, area or town, or pick from the official list. Matching is by name only. */
export default function MyMpPage() {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const [regions, setRegions] = useState<string[]>([]);
  const [region, setRegion] = useState('');
  const [options, setOptions] = useState<ConstituencyOption[]>([]);
  const [picked, setPicked] = useState<{ c: ConstituencyOption; mp: PublicMp | null } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { api.regions().then(setRegions).catch(() => setListError('The list of regions could not be loaded.')); }, []);
  useEffect(() => {
    setOptions([]);
    setPicked(null);
    if (!region) return;
    api.constituencies(region).then(setOptions).catch(() => setListError('The list of constituencies could not be loaded.'));
  }, [region]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (query.length < 2) return;
    setResult({ kind: 'loading' });
    try {
      const r = await api.lookup(query);
      setResult({ kind: 'done', query, matches: r.matches });
    } catch (err) {
      setResult({ kind: 'error', error: err as ApiError });
    }
  };

  const pick = async (id: string) => {
    if (!id) return setPicked(null);
    try {
      const r = await api.constituency(id);
      setPicked({ c: r.constituency, mp: r.mp });
    } catch { setListError('That constituency could not be loaded.'); }
  };

  return (
    <div className="max-w-[820px] py-10">
      <h1 ref={heading} tabIndex={-1} className="font-display text-[34px] font-semibold outline-none">Find my MP</h1>
      <p className="mt-2 max-w-[60ch] text-ink-soft">Search for your constituency by name, or choose it from the list. We match on names only: we do not use your location, and we always show how a match was made so you can check it.</p>

      <form onSubmit={search} role="search" aria-label="Find your constituency" className="mt-6 rounded-portal border border-parliament-line bg-paper p-5 shadow-portal">
        <Field id="q" label="Constituency, area or town" hint="For example: Tema East">
          {(p) => <input {...p} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />}
        </Field>
        <button type="submit" disabled={q.trim().length < 2 || result.kind === 'loading'} className={`${primaryButton} mt-4`}>Find my MP</button>
      </form>

      <div aria-live="polite" className="mt-6">
        {result.kind === 'loading' && <p role="status" className="text-ink-soft">Searching...</p>}
        {result.kind === 'error' && <p role="alert" className="rounded-portal border border-parliament-line bg-paper p-5">{result.error.message}</p>}
        {result.kind === 'done' && result.matches.length === 0 && (
          <p className="rounded-portal border border-parliament-line bg-paper p-5">We could not find a constituency matching &ldquo;{result.query}&rdquo;. Try the official constituency name, or choose it from the list below. We will not guess.</p>
        )}
        {result.kind === 'done' && result.matches.length > 0 && (
          <>
            <h2 className="mb-3 font-display text-[22px] font-semibold">{result.matches.length === 1 ? '1 match' : `${result.matches.length} matches`} for &ldquo;{result.query}&rdquo;</h2>
            <ul className="grid gap-4">
              {result.matches.map((m) => <ConstituencyResult key={m.constituency.id} c={m.constituency} mp={m.mp} explanation={m.explanation} badge={MATCH_LABEL[m.matchedOn]} />)}
            </ul>
          </>
        )}
      </div>

      <section aria-labelledby="browse" className="mt-10 rounded-portal border border-parliament-line bg-paper p-5">
        <h2 id="browse" className="font-display text-[22px] font-semibold">Or choose from the official list</h2>
        {listError && <p role="alert" className="mt-2 text-sm text-[#8a1c13]">{listError}</p>}
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field id="region" label="Region">
            {(p) => (
              <select {...p} value={region} onChange={(e) => setRegion(e.target.value)}>
                <option value="">Choose a region</option>
                {regions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
          </Field>
          <Field id="constituency" label="Constituency">
            {(p) => (
              <select {...p} disabled={!region} value={picked?.c.id ?? ''} onChange={(e) => pick(e.target.value)}>
                <option value="">Choose a constituency</option>
                {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </Field>
        </div>
        {picked && <ul className="mt-4"><ConstituencyResult c={picked.c} mp={picked.mp} explanation={`You chose ${picked.c.name} from the official list for ${picked.c.region}.`} /></ul>}
      </section>
    </div>
  );
}
