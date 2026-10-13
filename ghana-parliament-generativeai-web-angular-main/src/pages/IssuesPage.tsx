import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Field, primaryButton } from '../components/Field';

/** Landing page for issues: how it works, start a new issue, or look up an existing one. */
export default function IssuesPage() {
  const nav = useNavigate();
  const [ref, setRef] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const track = (e: FormEvent) => {
    e.preventDefault();
    if (!ref.trim() || !code.trim()) return setError('Enter both your reference and your tracking code.');
    setError('');
    // The code goes in the URL fragment, which browsers never send to the server.
    nav(`/issues/${encodeURIComponent(ref.trim().toUpperCase())}#code=${encodeURIComponent(code.trim())}`);
  };

  return (
    <div className="max-w-[820px] py-10">
      <h1 className="font-display text-[34px] font-semibold">Raise an issue with your MP&apos;s office</h1>
      <p className="mt-2 max-w-[60ch] text-ink-soft">Tell the constituency office about a problem or concern. A person reads every issue. You get a reference and a tracking code so you can see progress and reply.</p>

      <p role="note" className="mt-5 rounded-xl bg-gold-wash px-4 py-3 text-sm"><strong>This is not for emergencies.</strong> If you or someone else is in immediate danger, call 112. Raising an issue is not a legal petition and does not guarantee a particular outcome.</p>

      <section aria-labelledby="how" className="mt-8">
        <h2 id="how" className="font-display text-[22px] font-semibold">How it works</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-6 leading-7">
          <li>Choose your constituency and describe the issue in your own words.</li>
          <li>You can add a photo or document after you submit.</li>
          <li>We may suggest a category. You decide: your words are never changed.</li>
          <li>The constituency office receives it, replies, and you can follow each step here.</li>
        </ol>
        <p className="mt-5 flex flex-wrap items-center gap-4">
          <Link to="/issues/new" className={`${primaryButton} inline-block no-underline`}>Raise an issue</Link>
          <Link to="/my-mp" className="font-semibold text-parliament-green-deep underline">Not sure of your constituency? Find my MP</Link>
        </p>
      </section>

      <section aria-labelledby="track" className="mt-10 rounded-portal border border-parliament-line bg-paper p-5 shadow-portal">
        <h2 id="track" className="font-display text-[22px] font-semibold">Already raised an issue?</h2>
        <form onSubmit={track} className="mt-3 grid gap-4 sm:grid-cols-2" noValidate>
          <Field id="ref" label="Reference" hint="Looks like GH-2026-000123">
            {(p) => <input {...p} value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" />}
          </Field>
          <Field id="code" label="Tracking code" hint="Shown when you submitted">
            {(p) => <input {...p} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
          {error && <p role="alert" className="text-sm font-medium text-[#8a1c13] sm:col-span-2">{error}</p>}
          <div className="sm:col-span-2"><button type="submit" className={primaryButton}>See my issue</button></div>
        </form>
      </section>

      <section aria-labelledby="priv" className="mt-10">
        <h2 id="priv" className="font-display text-[22px] font-semibold">What we keep</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6 leading-7">
          <li>Your issue, your replies, any files you add, and the contact details you choose to give. You can choose to give none and just use the tracking page.</li>
          <li>Only the constituency office and authorised staff can see your issue. Internal notes are never shown to you.</li>
          <li>You can download your data or ask for it to be deleted from your issue page. How long cases are kept has not been finalised and will be published here once Parliament confirms it.</li>
        </ul>
      </section>
    </div>
  );
}
