import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, CaseCategory, CaseSuggestion, ConstituencyOption } from '../api';
import { Field, primaryButton, secondaryButton } from '../components/Field';
import { useLanguage } from '../language';

type Channel = 'EMAIL' | 'SMS' | 'NONE';
interface Form {
  constituencyId: string; category: string; title: string; description: string; locationText: string;
  channel: Channel; name: string; email: string; phone: string; consent: boolean;
}
type Errors = Partial<Record<keyof Form, string>>;
type Suggestion = { kind: 'loading' } | { kind: 'ready'; value: CaseSuggestion } | { kind: 'unavailable' };

const PURPOSE = 'I agree that the constituency office and authorised Parliament staff may use the details I give here to handle my issue and to send me updates by the method I choose.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9 -]{7,18}$/;

export function validate(f: Form): Errors {
  const e: Errors = {};
  if (!f.constituencyId) e.constituencyId = 'Choose your constituency.';
  if (!f.category) e.category = 'Choose the category that fits best. If none fit, choose "Something else".';
  if (f.title.trim().length < 3) e.title = 'Give your issue a short title (at least 3 characters).';
  if (f.description.trim().length < 10) e.description = 'Describe your issue in a few words (at least 10 characters).';
  if (f.channel === 'EMAIL' && !EMAIL_RE.test(f.email.trim())) e.email = 'Enter a valid email address, or choose a different way to get updates.';
  if (f.channel === 'SMS' && !PHONE_RE.test(f.phone.trim())) e.phone = 'Enter a valid phone number, or choose a different way to get updates.';
  if (!f.consent) e.consent = 'We need your agreement before we can send your issue.';
  return e;
}

/** Two steps: write, then review and confirm. Nothing is sent until the citizen confirms the review. */
export default function NewIssuePage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { current } = useLanguage();
  const [step, setStep] = useState<'write' | 'review'>('write');
  const [form, setForm] = useState<Form>({
    constituencyId: params.get('constituency') ?? '', category: '', title: '', description: '', locationText: '',
    channel: 'NONE', name: '', email: '', phone: '', consent: false,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [constituencies, setConstituencies] = useState<ConstituencyOption[]>([]);
  const [categories, setCategories] = useState<CaseCategory[]>([]);
  const [loadError, setLoadError] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion>({ kind: 'loading' });
  const [useSuggested, setUseSuggested] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  // One key per form, so a retry after a network failure returns the same case instead of a duplicate.
  const submissionKey = useRef(crypto.randomUUID());

  useEffect(() => {
    Promise.all([api.constituencies(), api.categories()])
      .then(([c, k]) => { setConstituencies(c); setCategories(k); })
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const label = useMemo(() => (id: string) => categories.find((c) => c.id === id)?.label ?? id, [categories]);

  const review = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(first === 'constituencyId' ? 'constituency' : first)?.focus();
      return;
    }
    setStep('review');
    setSuggestion({ kind: 'loading' });
    setUseSuggested(false);
    queueMicrotask(() => heading.current?.focus());
    try {
      setSuggestion({ kind: 'ready', value: await api.suggest(form.description.trim()) });
    } catch {
      setSuggestion({ kind: 'unavailable' });
    }
  };

  const suggestedDiffers = suggestion.kind === 'ready' && suggestion.value.category !== form.category && suggestion.value.category !== 'other';

  const submit = async () => {
    setSubmitting(true);
    setSubmitError('');
    const category = suggestedDiffers && useSuggested && suggestion.kind === 'ready' ? suggestion.value.category : form.category;
    try {
      const r = await api.submitCase({
        constituencyId: form.constituencyId, category, title: form.title.trim(), description: form.description.trim(),
        locationText: form.locationText.trim() || undefined, preferredLanguage: current.code, consent: true,
        contact: { channel: form.channel, name: form.name.trim() || undefined, email: form.channel === 'EMAIL' ? form.email.trim() : undefined, phone: form.channel === 'SMS' ? form.phone.trim() : undefined },
        submissionKey: submissionKey.current,
      });
      nav(`/issues/${encodeURIComponent(r.reference)}#code=${encodeURIComponent(r.trackingCode)}`, { state: { submitted: true, safetyNotice: r.safetyNotice } });
    } catch (e) {
      setSubmitError((e as ApiError).message);
      setSubmitting(false);
    }
  };

  const constituencyName = constituencies.find((c) => c.id === form.constituencyId)?.name ?? '';

  if (step === 'review') {
    return (
      <div className="max-w-[760px] py-10">
        <h1 ref={heading} tabIndex={-1} className="font-display text-[34px] font-semibold outline-none">Review your issue</h1>
        <p className="mt-2 text-ink-soft">Check everything below. Nothing has been sent yet.</p>

        <dl className="mt-6 grid gap-4 rounded-portal border border-parliament-line bg-paper p-5">
          <div><dt className="text-sm font-semibold text-ink-soft">Constituency</dt><dd>{constituencyName}</dd></div>
          <div><dt className="text-sm font-semibold text-ink-soft">Title</dt><dd>{form.title}</dd></div>
          <div>
            <dt className="text-sm font-semibold text-ink-soft">Your words (sent exactly as written)</dt>
            <dd><blockquote className="mt-1 whitespace-pre-wrap border-l-4 border-parliament-gold pl-4">{form.description}</blockquote></dd>
          </div>
          {form.locationText && <div><dt className="text-sm font-semibold text-ink-soft">Location</dt><dd>{form.locationText}</dd></div>}
          <div><dt className="text-sm font-semibold text-ink-soft">Updates</dt><dd>{form.channel === 'EMAIL' ? `By email to ${form.email}` : form.channel === 'SMS' ? `By SMS to ${form.phone}` : 'None. I will check the tracking page.'}</dd></div>
        </dl>

        <section aria-labelledby="cat" className="mt-6 rounded-portal border border-parliament-line bg-paper p-5">
          <h2 id="cat" className="font-display text-[20px] font-semibold">Category</h2>
          {suggestion.kind === 'loading' && <p role="status" className="mt-2 text-ink-soft">Checking for a suggested category...</p>}
          {suggestion.kind === 'unavailable' && <p className="mt-2 text-sm text-ink-soft">A suggestion is not available right now. Your chosen category is kept.</p>}
          {!suggestedDiffers && <p className="mt-2">{label(form.category)}</p>}
          {suggestedDiffers && suggestion.kind === 'ready' && (
            <fieldset className="mt-2">
              <legend className="text-sm text-ink-soft">An automatic suggestion differs from your choice. Pick the one you want. {suggestion.value.note}</legend>
              <div className="mt-3 grid gap-2">
                <label className="flex items-center gap-2"><input type="radio" name="cat" checked={!useSuggested} onChange={() => setUseSuggested(false)} /> Keep my choice: <strong>{label(form.category)}</strong></label>
                <label className="flex items-center gap-2"><input type="radio" name="cat" checked={useSuggested} onChange={() => setUseSuggested(true)} /> Use the suggestion: <strong>{suggestion.value.categoryLabel}</strong></label>
              </div>
            </fieldset>
          )}
          {suggestion.kind === 'ready' && !suggestedDiffers && <p className="mt-1 text-sm text-ink-soft">The automatic suggestion agrees with your choice or has no strong match.</p>}
        </section>

        {submitError && <p role="alert" className="mt-4 rounded-xl bg-gold-wash px-4 py-3 text-sm">{submitError} Your issue was not lost: you can press Submit again.</p>}
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => { setStep('write'); setSubmitError(''); }} className={secondaryButton} disabled={submitting}>Go back and edit</button>
          <button type="button" onClick={submit} className={primaryButton} disabled={submitting || suggestion.kind === 'loading'}>{submitting ? 'Sending...' : 'Confirm and submit'}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[760px] py-10">
      <h1 ref={heading} tabIndex={-1} className="font-display text-[34px] font-semibold outline-none">Raise an issue</h1>
      <p className="mt-2 text-ink-soft">Fields are required unless marked optional. For emergencies call 112: do not use this form.</p>
      {loadError && <p role="alert" className="mt-4 rounded-xl bg-gold-wash px-4 py-3 text-sm">{loadError} Please reload the page.</p>}

      <form onSubmit={review} noValidate className="mt-6 grid gap-5 rounded-portal border border-parliament-line bg-paper p-5 shadow-portal">
        <Field id="constituency" label="Constituency" error={errors.constituencyId} hint="Not sure? Use Find my MP first.">
          {(p) => (
            <select {...p} value={form.constituencyId} onChange={(e) => set('constituencyId', e.target.value)}>
              <option value="">Choose your constituency</option>
              {constituencies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.region})</option>)}
            </select>
          )}
        </Field>
        <p className="-mt-3 text-sm"><Link to="/my-mp" className="font-semibold text-parliament-green-deep underline">Find my MP</Link></p>

        <Field id="category" label="Category" error={errors.category}>
          {(p) => (
            <select {...p} value={form.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">Choose a category</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          )}
        </Field>
        <Field id="title" label="Short title" error={errors.title}>
          {(p) => <input {...p} value={form.title} maxLength={120} onChange={(e) => set('title', e.target.value)} />}
        </Field>
        <Field id="description" label="Describe your issue" error={errors.description} hint={`${form.description.length} of 2000 characters. We send your words exactly as you write them.`}>
          {(p) => <textarea {...p} rows={6} maxLength={2000} value={form.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
        <Field id="locationText" label="Where is it? (optional)" hint="A town, community or landmark. Do not give your home address unless it is needed.">
          {(p) => <input {...p} value={form.locationText} maxLength={200} onChange={(e) => set('locationText', e.target.value)} />}
        </Field>

        <fieldset>
          <legend className="mb-1 text-sm font-semibold">How should we send you updates?</legend>
          <p className="mb-2 text-sm text-ink-soft">Messages only say that there is an update. They never include the details of your issue. Replies language: {current.name}{current.level !== 'supported' ? ' (replies will be in English for now)' : ''}.</p>
          <div className="grid gap-2">
            {([['NONE', 'No messages: I will check the tracking page'], ['EMAIL', 'Email'], ['SMS', 'SMS']] as [Channel, string][]).map(([v, l]) => (
              <label key={v} className="flex items-center gap-2"><input type="radio" name="channel" value={v} checked={form.channel === v} onChange={() => set('channel', v)} /> {l}</label>
            ))}
          </div>
        </fieldset>
        {form.channel !== 'NONE' && (
          <Field id="name" label="Your name (optional)">
            {(p) => <input {...p} value={form.name} maxLength={120} autoComplete="name" onChange={(e) => set('name', e.target.value)} />}
          </Field>
        )}
        {form.channel === 'EMAIL' && (
          <Field id="email" label="Email address" error={errors.email}>
            {(p) => <input {...p} type="email" value={form.email} autoComplete="email" onChange={(e) => set('email', e.target.value)} />}
          </Field>
        )}
        {form.channel === 'SMS' && (
          <Field id="phone" label="Phone number" error={errors.phone}>
            {(p) => <input {...p} type="tel" value={form.phone} autoComplete="tel" onChange={(e) => set('phone', e.target.value)} />}
          </Field>
        )}

        <div>
          <label className="flex items-start gap-3"><input id="consent" type="checkbox" className="mt-1" checked={form.consent} aria-invalid={errors.consent ? true : undefined} aria-describedby={errors.consent ? 'consent-err' : undefined} onChange={(e) => set('consent', e.target.checked)} /> <span>{PURPOSE}</span></label>
          {errors.consent && <p id="consent-err" role="alert" className="mt-1 text-sm font-medium text-[#8a1c13]">{errors.consent}</p>}
        </div>

        <div><button type="submit" className={primaryButton}>Review your issue</button></div>
      </form>
    </div>
  );
}
