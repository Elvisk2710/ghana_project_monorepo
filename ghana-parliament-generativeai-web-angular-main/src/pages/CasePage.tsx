import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError, CaseStatus, CaseView } from '../api';
import { Field, fmtDateTime, primaryButton, secondaryButton } from '../components/Field';

// The six statuses a citizen can see, in the order a case normally moves through them.
const STATUSES: { id: CaseStatus; label: string; help: string }[] = [
  { id: 'RECEIVED', label: 'Received', help: 'Your issue reached the constituency office.' },
  { id: 'TRIAGED', label: 'Triaged', help: 'Someone has read it and decided who should handle it.' },
  { id: 'IN_PROGRESS', label: 'In progress', help: 'The office is working on it.' },
  { id: 'AWAITING_INFORMATION', label: 'Awaiting information from you', help: 'The office needs more from you. Please reply below.' },
  { id: 'RESOLVED', label: 'Resolved', help: 'The office believes it has dealt with the issue. You can still reply.' },
  { id: 'CLOSED', label: 'Closed', help: 'This case is finished. To raise something new, start a new issue.' },
];
const MAX_BYTES = 5 * 1024 * 1024;

type State = { kind: 'loading' } | { kind: 'error'; error: ApiError } | { kind: 'done'; data: CaseView };

const codeFromHash = (hash: string) => new URLSearchParams(hash.replace(/^#/, '')).get('code') ?? '';

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The citizen's view of one case: status, conversation, files and their own data. Internal notes never reach this page. */
export default function CasePage() {
  const { reference = '' } = useParams();
  const location = useLocation();
  const code = codeFromHash(location.hash);
  const submitted = (location.state as { submitted?: boolean; safetyNotice?: string } | null) ?? {};
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState('');
  const [fileOk, setFileOk] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback((signal?: AbortSignal) => {
    api.caseView(reference, code, signal)
      .then((data) => setState({ kind: 'done', data }))
      .catch((e) => { if (e.name !== 'AbortError') setState({ kind: 'error', error: e as ApiError }); });
  }, [reference, code]);

  useEffect(() => {
    if (!code) return setState({ kind: 'error', error: new ApiError('not_found', 'A tracking code is needed.', 404) });
    const ctl = new AbortController();
    setState({ kind: 'loading' });
    load(ctl.signal);
    return () => ctl.abort();
  }, [code, load]);

  useEffect(() => { if (state.kind === 'done') heading.current?.focus(); }, [state.kind]);

  const sendReply = async (e: FormEvent) => {
    e.preventDefault();
    if (!reply.trim()) return setReplyError('Write your reply first.');
    setReplyError('');
    setBusy(true);
    try {
      setState({ kind: 'done', data: await api.caseReply(reference, code, reply.trim()) });
      setReply('');
      setNotice('Your reply was sent to the constituency office.');
    } catch (err) { setReplyError((err as ApiError).message); }
    setBusy(false);
  };

  const upload = async (file: File | undefined) => {
    setFileError(''); setFileOk('');
    if (!file) return;
    if (file.size > MAX_BYTES) return setFileError('That file is larger than 5 MB.');
    setBusy(true);
    try {
      await api.caseAttach(reference, code, file);
      setFileOk(`${file.name} was added.`);
      load();
    } catch (err) { setFileError((err as ApiError).message); }
    setBusy(false);
  };

  const download = async (id: string, name: string) => {
    try { saveBlob(await api.caseAttachmentBlob(reference, code, id), name); } catch (err) { setFileError((err as ApiError).message); }
  };

  const exportData = async () => {
    try {
      const data = await api.caseExport(reference, code);
      saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${reference}-my-data.json`);
    } catch (err) { setNotice((err as ApiError).message); }
  };

  const askErasure = async () => {
    if (!window.confirm('Ask Parliament to delete your personal data from this issue? You will no longer be able to see it here once it is done.')) return;
    try { setNotice((await api.caseErasure(reference, code)).message); } catch (err) { setNotice((err as ApiError).message); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); } catch { setCopied(false); }
  };

  if (state.kind === 'loading') return <p role="status" className="py-12 text-ink-soft">Loading your issue...</p>;
  if (state.kind === 'error') {
    return (
      <div className="max-w-[640px] py-12">
        <h1 className="font-display text-[30px] font-semibold">We could not open that issue</h1>
        <p role="alert" className="mt-3">{state.error.kind === 'not_found' ? 'Check the reference and tracking code. If you have lost the tracking code, we cannot recover it: you can raise a new issue.' : state.error.message}</p>
        <p className="mt-5"><Link to="/issues" className="font-semibold text-parliament-green-deep underline">Back to issues</Link></p>
      </div>
    );
  }

  const c = state.data;
  const currentIdx = STATUSES.findIndex((s) => s.id === c.status);
  return (
    <div className="max-w-[820px] py-10">
      <p className="text-sm font-semibold text-ink-soft">{c.reference} - {c.constituency}</p>
      <h1 ref={heading} tabIndex={-1} className="font-display text-[32px] font-semibold outline-none">{c.title ?? 'Issue (details removed)'}</h1>
      <p className="mt-1 text-sm text-ink-soft">Category: {c.category} - Received {fmtDateTime(c.receivedAt)}</p>

      {submitted.submitted && (
        <section aria-labelledby="saved" className="mt-6 rounded-portal border-2 border-parliament-green bg-green-wash p-5">
          <h2 id="saved" className="font-display text-[22px] font-semibold">Your issue was received</h2>
          <p className="mt-2">Your reference is <strong>{c.reference}</strong>. Keep this tracking code safe: you need it with your reference to see your issue again. Anyone who has it can read your issue, and we cannot recover it for you.</p>
          <p className="mt-3 flex flex-wrap items-center gap-3"><code className="break-all rounded bg-paper px-3 py-1.5 font-mono text-sm">{code}</code><button type="button" onClick={copy} className={secondaryButton}>{copied ? 'Copied' : 'Copy code'}</button></p>
          <p className="mt-3 text-sm text-ink-soft">The address of this page also contains your code, so you can bookmark it.</p>
        </section>
      )}
      {submitted.safetyNotice && <p role="alert" className="mt-4 rounded-xl bg-gold-wash px-4 py-3 font-semibold">{submitted.safetyNotice}</p>}
      {notice && <p role="status" className="mt-4 rounded-xl bg-green-wash px-4 py-3 text-sm">{notice}</p>}

      <section aria-labelledby="status" className="mt-8">
        <h2 id="status" className="font-display text-[22px] font-semibold">Where it stands</h2>
        <ol className="mt-3 grid gap-2">
          {STATUSES.map((s, i) => {
            const isCurrent = s.id === c.status;
            const seen = c.history.some((h) => h.status === s.id);
            return (
              <li key={s.id} aria-current={isCurrent ? 'step' : undefined} className={`rounded-xl border px-4 py-3 ${isCurrent ? 'border-parliament-green bg-green-wash' : 'border-parliament-line bg-paper'}`}>
                <span className="font-semibold">{s.label}</span>
                <span className="ml-2 text-sm text-ink-soft">{isCurrent ? '(current)' : seen ? '(done)' : i < currentIdx ? '(skipped)' : ''}</span>
                {isCurrent && <p className="mt-1 text-sm">{s.help}</p>}
              </li>
            );
          })}
        </ol>
        {c.awaitingYourReply && <p role="status" className="mt-3 rounded-xl bg-gold-wash px-4 py-3 text-sm font-semibold">The office is waiting for your reply. Please answer below.</p>}
      </section>

      <section aria-labelledby="history" className="mt-8">
        <h2 id="history" className="font-display text-[22px] font-semibold">History</h2>
        <ul className="mt-3 grid gap-1 text-sm">
          {c.history.map((h, i) => <li key={`${h.status}-${i}`}><strong>{h.label}</strong> - {fmtDateTime(h.at)}</li>)}
        </ul>
      </section>

      <section aria-labelledby="conv" className="mt-8">
        <h2 id="conv" className="font-display text-[22px] font-semibold">Conversation</h2>
        <ul className="mt-3 grid gap-3">
          {c.messages.map((m) => (
            <li key={m.id} className={`rounded-xl border border-parliament-line p-4 ${m.from === 'you' ? 'bg-paper' : 'bg-green-wash'}`}>
              <p className="text-sm font-semibold">{m.from === 'you' ? 'You' : 'Constituency office'} <span className="font-normal text-ink-soft">- {fmtDateTime(m.at)}</span></p>
              <p className="mt-1 whitespace-pre-wrap">{m.content}</p>
            </li>
          ))}
        </ul>
        {c.canReply ? (
          <form onSubmit={sendReply} className="mt-4 grid gap-3" noValidate>
            <Field id="reply" label="Add a reply" error={replyError}>
              {(p) => <textarea {...p} rows={4} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} />}
            </Field>
            <div><button type="submit" disabled={busy} className={primaryButton}>Send reply</button></div>
          </form>
        ) : <p className="mt-4 text-sm text-ink-soft">{c.anonymized ? 'Personal details were removed from this case.' : 'This case is closed, so replies are turned off.'}</p>}
      </section>

      <section aria-labelledby="files" className="mt-8">
        <h2 id="files" className="font-display text-[22px] font-semibold">Photos and documents</h2>
        {c.attachments.length === 0 ? <p className="mt-2 text-sm text-ink-soft">No files added.</p> : (
          <ul className="mt-3 grid gap-2">
            {c.attachments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-parliament-line bg-paper px-4 py-2 text-sm">
                <span className="font-semibold">{a.filename}</span><span className="text-ink-soft">{(a.sizeBytes / 1024).toFixed(0)} KB</span>
                <button type="button" onClick={() => download(a.id, a.filename)} className="font-semibold text-parliament-green-deep underline">Download</button>
              </li>
            ))}
          </ul>
        )}
        {c.canReply && (
          <div className="mt-3">
            <Field id="file" label="Add a file" hint="PDF, PNG or JPEG, up to 5 MB, 5 files per issue. Files are checked before they are accepted.">
              {(p) => <input {...p} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" disabled={busy} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />}
            </Field>
          </div>
        )}
        {fileError && <p role="alert" className="mt-2 text-sm font-medium text-[#8a1c13]">{fileError}</p>}
        {fileOk && <p role="status" className="mt-2 text-sm">{fileOk}</p>}
      </section>

      <section aria-labelledby="mydata" className="mt-8 rounded-portal border border-parliament-line bg-paper p-5">
        <h2 id="mydata" className="font-display text-[22px] font-semibold">Your data</h2>
        <p className="mt-2 text-sm text-ink-soft">You can download everything we hold on this issue, or ask for your personal details to be deleted. An administrator reviews deletion requests.</p>
        <p className="mt-3 flex flex-wrap gap-3"><button type="button" onClick={exportData} className={secondaryButton}>Download my data</button><button type="button" onClick={askErasure} className={secondaryButton} disabled={c.anonymized}>Ask for my data to be deleted</button></p>
      </section>
    </div>
  );
}
