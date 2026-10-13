import { FormEvent, useState } from 'react';
import { api, ApiError } from '../api';

const REPORTS: [string, string][] = [
  ['incorrect', 'The information is wrong'],
  ['misleading', 'It is misleading or missing context'],
  ['harmful', 'It is harmful or inappropriate'],
  ['privacy', 'It exposes personal information'],
  ['other', 'Something else'],
];

/** "Was this helpful?" plus a problem report. Both are stored against the answer. */
export default function Feedback({ answerId }: { answerId: string }) {
  const [helpful, setHelpful] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [type, setType] = useState('incorrect');
  const [comment, setComment] = useState('');
  const [reported, setReported] = useState(false);

  const send = async (body: Parameters<typeof api.feedback>[1], onOk: () => void) => {
    setSending(true);
    setError('');
    try { await api.feedback(answerId, body); onOk(); }
    catch (e) { setError((e as ApiError).message); }
    finally { setSending(false); }
  };

  const submitReport = (e: FormEvent) => {
    e.preventDefault();
    send({ helpful: false, reportType: type, comment: comment.trim() || undefined }, () => { setReported(true); setShowReport(false); });
  };

  return (
    <section aria-label="Feedback" className="mt-6 border-t border-parliament-line pt-4 text-sm">
      {helpful === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <span id="helpful-label" className="font-semibold">Was this helpful?</span>
          <div role="group" aria-labelledby="helpful-label" className="flex gap-2">
            <button type="button" disabled={sending} className="rounded-full border border-parliament-line px-4 py-1.5 font-semibold hover:bg-green-wash" onClick={() => send({ helpful: true }, () => setHelpful(true))}>Yes</button>
            <button type="button" disabled={sending} className="rounded-full border border-parliament-line px-4 py-1.5 font-semibold hover:bg-green-wash" onClick={() => send({ helpful: false }, () => setHelpful(false))}>No</button>
          </div>
        </div>
      ) : (
        <p role="status">Thank you for your feedback.</p>
      )}
      {reported ? (
        <p role="status" className="mt-3">Your report was sent. Thank you for helping us improve.</p>
      ) : (
        <div className="mt-3">
          <button type="button" aria-expanded={showReport} onClick={() => setShowReport(!showReport)} className="font-semibold text-parliament-green-deep underline">Report a problem with this answer</button>
          {showReport && (
            <form onSubmit={submitReport} className="mt-3 grid max-w-md gap-3">
              <div>
                <label htmlFor="report-type" className="mb-1 block font-semibold">What is wrong?</label>
                <select id="report-type" value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-parliament-line bg-paper px-3 py-2">
                  {REPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="report-comment" className="mb-1 block font-semibold">Details (optional)</label>
                <textarea id="report-comment" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} rows={3} className="w-full rounded-lg border border-parliament-line bg-paper px-3 py-2" />
                <p className="mt-1 text-xs text-ink-soft">Please do not include phone numbers, email addresses or ID numbers.</p>
              </div>
              <button type="submit" disabled={sending} className="w-fit rounded-xl bg-parliament-green px-5 py-2.5 font-semibold text-white disabled:opacity-60">{sending ? 'Sending...' : 'Send report'}</button>
            </form>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[#8a1c13]">{error} Please try again.</p>}
    </section>
  );
}
