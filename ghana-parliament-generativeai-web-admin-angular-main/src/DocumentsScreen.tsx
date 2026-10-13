import { useCallback, useEffect, useMemo, useState } from 'react';
import { oidcConfigured, signIn } from './auth';
import { ApiError, DocumentSummary, Lifecycle, ReviewReport, documentsApi, getToken, setToken } from './api';

const LABEL: Record<Lifecycle, string> = {
  DRAFT: 'Draft', PROCESSING: 'Processing', REVIEW: 'In review', APPROVED: 'Approved',
  PUBLISHED: 'Published', REJECTED: 'Rejected', SUPERSEDED: 'Superseded',
};
const TYPES: Record<string, string> = { Hansard: 'HANSARD', 'Order paper': 'ORDER_PAPER', 'Bill text': 'BILL_TEXT', 'Committee report': 'COMMITTEE_REPORT', Other: 'OTHER' };
const LANGS: Record<string, string> = { English: 'en', Twi: 'tw', Ewe: 'ee', Ga: 'gaa', Dagbani: 'dag', Hausa: 'ha' };
const ACCEPTED = ['application/pdf', 'text/plain'];
const MAX_BYTES = 50 * 1024 * 1024;

export default function DocumentsScreen() {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [open, setOpen] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewReport | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setDocs(await documentsApi.list());
      setNeedsToken(false);
    } catch (e) {
      const err = e as ApiError;
      setNeedsToken(err.status === 401);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Documents still being processed or indexed refresh themselves.
  useEffect(() => {
    if (!docs.some((d) => d.lifecycle === 'PROCESSING')) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [docs, load]);

  const run = async (done: string, fn: () => Promise<unknown>) => {
    setNotice('');
    let failure = '';
    try {
      await fn();
    } catch (e) {
      failure = (e as ApiError).message;
    }
    await load(); // refresh resets messages, so report the outcome afterwards
    if (failure) setError(failure);
    else setNotice(done);
  };

  const toggle = async (d: DocumentSummary) => {
    if (open === d.id) return setOpen(null);
    setOpen(d.id);
    setReview(null);
    try { setReview(await documentsApi.review(d.id)); } catch { /* detail is optional */ }
  };

  const approve = (d: DocumentSummary) => {
    const flagged = d.qualityReport?.passed === false;
    if (flagged && !window.confirm(`Quality checks flagged: ${d.qualityReport?.issues?.join(', ')}. Approve anyway?`)) return;
    run(`Approved ${d.publicId}`, () => documentsApi.approve(d.id, flagged));
  };
  const reject = (d: DocumentSummary) => {
    const reason = window.prompt(`Reason for rejecting ${d.publicId}:`);
    if (reason?.trim()) run(`Rejected ${d.publicId}`, () => documentsApi.reject(d.id, reason));
  };
  const unpublish = (d: DocumentSummary) => {
    const reason = window.prompt(`Reason for withdrawing ${d.publicId} from public search:`);
    if (reason?.trim()) run(`Withdrew ${d.publicId} from public search`, () => documentsApi.unpublish(d.id, reason));
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter((d) => (status === 'ALL' || d.lifecycle === status) && (!q || d.title.toLowerCase().includes(q) || d.publicId.toLowerCase().includes(q)));
  }, [docs, query, status]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Hansard documents</h3>
        <button className="btn primary" onClick={() => setShowUpload(true)}>+ Upload document</button>
      </div>
      <p className="sub" style={{ margin: '0 0 12px' }}>
        Uploaded files are processed, reviewed and approved before they can be published. Only published documents are visible to the public.
      </p>

      {needsToken && <TokenBox onSaved={load} />}
      {error && !needsToken && <div role="alert" className="badge" style={{ display: 'block', margin: '8px 0', padding: '8px 12px', background: '#fdecea', color: '#8a1c13' }}>{error}</div>}
      {notice && <div role="status" className="badge" style={{ display: 'block', margin: '8px 0', padding: '8px 12px' }}>{notice}</div>}

      <div className="toolbar">
        <input className="search" placeholder="Search by title or ID..." value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search documents" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="ALL">All statuses</option>
          {Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Title</th><th>Date</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {shown.map((d) => (
              <FragmentRows key={d.id}>
                <tr>
                  <td>{d.publicId}</td>
                  <td>{d.title}</td>
                  <td>{d.documentDate ? d.documentDate.slice(0, 10) : '-'}</td>
                  <td>{d.type}</td>
                  <td><span className="badge">{LABEL[d.lifecycle]}</span></td>
                  <td>
                    <button className="icon-btn" onClick={() => toggle(d)} aria-expanded={open === d.id}>{open === d.id ? 'Hide' : 'Details'}</button>{' '}
                    {d.lifecycle === 'REVIEW' && <><button className="icon-btn" onClick={() => approve(d)}>Approve</button>{' '}<button className="icon-btn" onClick={() => reject(d)}>Reject</button></>}
                    {d.lifecycle === 'APPROVED' && <button className="icon-btn" onClick={() => run(`Publishing ${d.publicId}: indexing started`, () => documentsApi.publish(d.id))}>Publish</button>}
                    {d.lifecycle === 'PUBLISHED' && <button className="icon-btn" onClick={() => unpublish(d)}>Unpublish</button>}
                    {(d.lifecycle === 'DRAFT' || d.lifecycle === 'REJECTED') && <button className="icon-btn" onClick={() => run(`Reprocessing ${d.publicId}`, () => documentsApi.reprocess(d.id))}>Reprocess</button>}
                  </td>
                </tr>
                {open === d.id && (
                  <tr>
                    <td colSpan={6}>
                      <div>Version {d.version} - language {d.language} - words extracted {d.qualityReport?.words ?? '-'}</div>
                      {d.qualityReport?.issues?.length ? <div>Quality issues: {d.qualityReport.issues.join(', ')}</div> : null}
                      {review?.metadataIssues.map((i) => <div key={i.field}>Needs attention: {i.message}</div>)}
                      {review && !review.metadataIssues.length && !d.qualityReport?.issues?.length && <div>No outstanding issues.</div>}
                    </td>
                  </tr>
                )}
              </FragmentRows>
            ))}
            {!loading && !shown.length && <tr><td colSpan={6}>{docs.length ? 'No documents match the filter.' : 'No documents yet. Upload one to begin.'}</td></tr>}
          </tbody>
        </table>
      </div>

      {showUpload && <UploadDialog onClose={() => setShowUpload(false)} onDone={(m) => { setShowUpload(false); setNotice(m); load(); }} onError={setError} />}
    </div>
  );
}

// Small helper so a document can render a main row plus a details row without extra wrappers.
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function TokenBox({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState(getToken() ?? '');
  if (oidcConfigured) {
    return (
      <div className="panel" style={{ margin: '8px 0' }}>
        <p>Your session has expired or you are not signed in.</p>
        <button className="btn primary" onClick={() => signIn()}>Sign in</button>
      </div>
    );
  }
  return (
    <div className="panel" style={{ margin: '8px 0' }}>
      <p>You are not signed in. Paste an access token issued by the Parliament identity provider (interim, until the sign-in flow is connected).</p>
      <input className="search" type="password" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Access token" autoComplete="off" />{' '}
      <button className="btn primary" onClick={() => { setToken(value.trim() || null); onSaved(); }}>Use token</button>
    </div>
  );
}

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function UploadDialog({ onClose, onDone, onError }: { onClose: () => void; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('Hansard');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lang, setLang] = useState('English');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  const problem = !file ? '' : !ACCEPTED.includes(file.type) ? 'Only PDF and plain-text files are supported.' : file.size > MAX_BYTES ? 'File is larger than 50 MB.' : file.size === 0 ? 'File is empty.' : '';

  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  };

  const submit = async () => {
    if (!file || problem || busy) return;
    setBusy(true);
    try {
      const d = await documentsApi.upload(file, { title, type: TYPES[type], documentDate: date, language: LANGS[lang], sensitivity: 'public' });
      onDone(`Uploaded ${d.publicId}. Processing has started; it will appear for review shortly.`);
    } catch (e) {
      const err = e as ApiError;
      const existing = err.body?.existing?.publicId;
      onError(err.status === 409 && existing ? `This file is already registered as ${existing}` : err.message);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="upload-title" className="modal">
        <header className="modal-head">
          <div>
            <h3 id="upload-title">Upload document</h3>
            <p>Add a Hansard, bill or report to the repository.</p>
          </div>
          <button type="button" className="modal-x" aria-label="Close" onClick={onClose} disabled={busy}>&times;</button>
        </header>

        <div className="modal-body">
          {!file ? (
            <label className={`dropzone ${drag ? 'drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
              <span className="dz-icon" aria-hidden="true">&#8593;</span>
              <strong>Drop a file here, or <u>browse</u></strong>
              <span className="dz-hint">PDF or plain text, up to 50 MB</span>
              <input type="file" accept=".pdf,.txt,application/pdf,text/plain" onChange={(e) => pick(e.target.files?.[0])} aria-label="File" />
            </label>
          ) : (
            <div className={`filechip ${problem ? 'bad' : ''}`}>
              <span className="fc-ext" aria-hidden="true">{(file.name.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()}</span>
              <div className="fc-meta"><strong title={file.name}>{file.name}</strong><span>{fileSize(file.size)}</span></div>
              <button type="button" className="link" onClick={() => setFile(null)} disabled={busy}>Replace</button>
            </div>
          )}
          {problem && <div role="alert" className="modal-error">{problem}</div>}

          <div className="modal-grid">
            <label className="field wide">Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Hansard, 12 March 2026" />
            </label>
            <label className="field">Type
              <select value={type} onChange={(e) => setType(e.target.value)}>{Object.keys(TYPES).map((t) => <option key={t}>{t}</option>)}</select>
            </label>
            <label className="field">Language
              <select value={lang} onChange={(e) => setLang(e.target.value)}>{Object.keys(LANGS).map((l) => <option key={l}>{l}</option>)}</select>
            </label>
            <label className="field wide">Document date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>

          <p className="modal-note">Saved as a draft first. Extraction and quality checks run next, then a reviewer approves it. Nothing is public until it is published.</p>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={!file || !!problem || busy} onClick={submit}>{busy ? 'Uploading...' : 'Upload for review'}</button>
        </footer>
      </div>
    </div>
  );
}
