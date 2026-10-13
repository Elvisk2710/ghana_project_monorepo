import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TokenBox } from './DocumentsScreen';
import {
  ApiError, Assignee, CaseDetail, CaseFilters, CasePriority, CaseRow, CaseStats, CaseStatus, Me, Template, casesApi,
} from './api';

export const STATUS_LABEL: Record<CaseStatus, string> = {
  RECEIVED: 'Received', TRIAGED: 'Triaged', IN_PROGRESS: 'In progress', AWAITING_INFORMATION: 'Awaiting information', RESOLVED: 'Resolved', CLOSED: 'Closed',
};
const PRIORITIES: CasePriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const CATEGORIES: [string, string][] = [
  ['roads_infrastructure', 'Roads and infrastructure'], ['water_sanitation', 'Water and sanitation'], ['health', 'Health'], ['education', 'Education'],
  ['electricity', 'Electricity'], ['agriculture', 'Agriculture'], ['employment', 'Jobs and livelihoods'], ['security_safety', 'Security and personal safety'],
  ['corruption_allegation', 'Corruption allegation'], ['legal_matter', 'Legal matter'], ['other', 'Something else'],
];
const catLabel = (id: string | null) => CATEGORIES.find(([k]) => k === id)?.[1] ?? id ?? '-';
const DELIVERY: Record<string, string> = { PENDING: 'Pending', SENT: 'Sent', DELIVERED: 'Delivered', FAILED: 'Delivery failed' };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '-');

/** Response-time label for the queue. Overdue means no first response by the due date. */
export function slaLabel(c: Pick<CaseRow, 'dueAt' | 'overdue' | 'firstResponseAt' | 'status'>, now = Date.now()): { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' } {
  if (c.status === 'RESOLVED' || c.status === 'CLOSED') return { text: '-', tone: 'none' };
  if (c.firstResponseAt) return { text: 'Responded', tone: 'ok' };
  if (!c.dueAt) return { text: '-', tone: 'none' };
  const ms = new Date(c.dueAt).getTime() - now;
  const hours = Math.max(Math.round(Math.abs(ms) / 3_600_000), 1);
  const span = hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  if (c.overdue || ms < 0) return { text: `Overdue by ${span}`, tone: 'bad' };
  return { text: `Due in ${span}`, tone: hours <= 24 ? 'warn' : 'ok' };
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const tone = (t: string) => (t === 'bad' ? 'badge bad' : t === 'warn' ? 'badge warn' : t === 'none' ? '' : 'badge');

export default function CasesScreen() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('case');
  return openId
    ? <CaseView id={openId} onBack={() => setParams({})} />
    : <CaseQueue onOpen={(id) => setParams({ case: id })} />;
}

// ---------------------------------------------------------------- Queue

function CaseQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<CaseFilters>({});
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<CaseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [needsToken, setNeedsToken] = useState(false);

  const load = useCallback(async (more?: string) => {
    setLoading(true);
    setError('');
    try {
      const page = await casesApi.list(filters, more);
      setRows((r) => (more ? [...r, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setNeedsToken(false);
      casesApi.stats().then(setStats).catch(() => undefined);
    } catch (e) {
      const err = e as ApiError;
      setNeedsToken(err.status === 401);
      setError(err.status === 403 ? 'Your account is not set up to handle citizen cases.' : err.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const set = (patch: CaseFilters) => setFilters((f) => ({ ...f, ...patch }));
  const chip = (label: string, n: number | undefined, active: boolean, patch: CaseFilters) => (
    <button key={label} type="button" className={`chip${active ? ' on' : ''}`} aria-pressed={active} onClick={() => setFilters(active ? {} : patch)}>
      {label}: <strong>{n ?? 0}</strong>
    </button>
  );

  return (
    <div className="panel">
      <div className="panel-head"><h3>Citizen cases</h3></div>
      <p className="sub" style={{ margin: '0 0 12px' }}>Cases raised by citizens for your constituencies. You only see cases you are permitted to handle; escalated cases are listed first.</p>

      {needsToken && <TokenBox onSaved={() => load()} />}
      {error && !needsToken && <div role="alert" className="badge bad" style={{ display: 'block', margin: '8px 0', padding: '8px 12px' }}>{error}</div>}

      {stats && (
        <div className="chips" role="group" aria-label="Quick filters">
          {chip('Unassigned', stats.unassigned, filters.assignee === 'none', { assignee: 'none' })}
          {chip('Escalated', stats.escalated, filters.escalated === true, { escalated: true })}
          {chip('Overdue', stats.overdue, filters.overdue === true, { overdue: true })}
          {(['RECEIVED', 'IN_PROGRESS', 'AWAITING_INFORMATION'] as CaseStatus[]).map((s) => chip(STATUS_LABEL[s], stats.byStatus[s], filters.status === s, { status: s }))}
        </div>
      )}

      <form className="toolbar" role="search" onSubmit={(e) => { e.preventDefault(); set({ search: draft.trim() || undefined }); }}>
        <input className="search" placeholder="Search by reference or title..." value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Search cases" />
        <select value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })} aria-label="Filter by status">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filters.assignee ?? ''} onChange={(e) => set({ assignee: e.target.value || undefined })} aria-label="Filter by assignee">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
        <button type="submit" className="btn ghost">Search</button>
        <button type="button" className="btn ghost" onClick={() => { setFilters({}); setDraft(''); }}>Clear</button>
      </form>

      <div className="table-wrap">
        <table>
          <caption className="sr-only">Citizen cases</caption>
          <thead><tr><th scope="col">Reference</th><th scope="col">Title</th><th scope="col">Constituency</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Assigned to</th><th scope="col">Response due</th></tr></thead>
          <tbody>
            {rows.map((c) => {
              const sla = slaLabel(c);
              return (
                <tr key={c.id}>
                  <td><button type="button" className="link" onClick={() => onOpen(c.id)} aria-label={`Open case ${c.reference}`}>{c.reference}</button></td>
                  <td>{c.title} {c.escalated && <span className="badge bad">Escalated</span>}</td>
                  <td>{c.constituency}</td>
                  <td>{c.priority[0] + c.priority.slice(1).toLowerCase()}</td>
                  <td><span className="badge">{STATUS_LABEL[c.status]}</span></td>
                  <td>{c.assignee?.displayName ?? <em>Unassigned</em>}</td>
                  <td>{sla.tone === 'none' ? sla.text : <span className={tone(sla.tone)}>{sla.text}</span>}</td>
                </tr>
              );
            })}
            {!loading && !rows.length && <tr><td colSpan={7}>{Object.keys(filters).length ? 'No cases match these filters.' : 'No cases in your queue.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '12px 22px' }}>
        {loading && <span role="status">Loading...</span>}
        {!loading && cursor && <button type="button" className="btn ghost" onClick={() => load(cursor)}>Load more</button>}
        {!loading && <button type="button" className="btn ghost" style={{ marginLeft: 8 }} onClick={() => load()}>Refresh</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- One case

function CaseView({ id, onBack }: { id: string; onBack: () => void }) {
  const [c, setC] = useState<CaseDetail | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setC(await casesApi.get(id));
      setNeedsToken(false);
    } catch (e) {
      const err = e as ApiError;
      setNeedsToken(err.status === 401);
      setError(err.status === 404 ? 'That case does not exist or is not in your constituencies.' : err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    casesApi.me().then(setMe).catch(() => undefined);
    casesApi.templates().then(setTemplates).catch(() => undefined);
    casesApi.assignees(id).then(setAssignees).catch(() => undefined);
  }, [id, load]);

  const isSenior = !!me && (me.roles.includes('MP') || me.roles.includes('ADMIN'));
  const isAdmin = !!me?.roles.includes('ADMIN');

  /** Runs a mutation, replaces the case with the server's answer and reports the outcome. */
  const act = async (done: string, fn: () => Promise<CaseDetail | unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'allowedTransitions' in r) setC(r as CaseDetail);
      else await load();
      setNotice(done);
    } catch (e) {
      setError((e as ApiError).message);
      if ((e as ApiError).status === 409) await load(); // someone else changed it: show the current state
    } finally {
      setBusy(false);
    }
  };

  const exportCase = () => act('Case history exported with its audit trail.', async () => {
    const data = await casesApi.exportCase(id);
    saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${c?.publicId ?? 'case'}-history.json`);
  });

  const download = async (aid: string, name: string) => {
    try { saveBlob(await casesApi.attachment(id, aid), name); } catch (e) { setError((e as ApiError).message); }
  };

  const toggleEscalation = () => {
    if (!c) return;
    const verb = c.escalated ? 'lifting the escalation on' : 'escalating';
    const reason = window.prompt(`Reason for ${verb} ${c.publicId}:`);
    if (reason?.trim()) act(c.escalated ? 'Escalation lifted.' : 'Case escalated.', () => casesApi.setEscalation(id, !c.escalated, reason.trim()));
  };

  const erase = () => {
    if (!c) return;
    const reason = window.prompt(`Erase personal data from ${c.publicId}? This cannot be undone. Reason:`);
    if (reason?.trim()) act('Personal data erased. The non-identifying case record is kept.', () => casesApi.erase(id, reason.trim()));
  };

  const original = useMemo(() => c?.messages.find((m) => m.authorType === 'CITIZEN'), [c]);
  const blockedByEscalation = !!c?.escalated && !isSenior;

  if (needsToken) return <div className="panel"><TokenBox onSaved={load} /></div>;
  if (!c) {
    return (
      <div className="panel">
        <button type="button" className="btn ghost" onClick={onBack}>Back to cases</button>
        {error ? <div role="alert" className="badge bad" style={{ display: 'block', margin: '12px 0', padding: '8px 12px' }}>{error}</div> : <p role="status">Loading case...</p>}
      </div>
    );
  }

  const closed = c.status === 'CLOSED';
  const sla = slaLabel({ ...c, firstResponseAt: c.firstResponseAt });
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <button type="button" className="btn ghost sm" onClick={onBack}>Back to cases</button>
          <h3 style={{ marginTop: 10 }}>{c.publicId} - {c.title}</h3>
          <p className="sub">{c.constituency.name}, {c.constituency.region} - received {fmt(c.createdAt)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge">{STATUS_LABEL[c.status]}</span>
          {c.escalated && <span className="badge bad">Escalated</span>}
          {sla.tone !== 'none' && <span className={tone(sla.tone)}>{sla.text}</span>}
        </div>
      </div>

      {error && <div role="alert" className="badge bad" style={{ display: 'block', margin: '8px 0', padding: '8px 12px' }}>{error}</div>}
      {notice && <div role="status" className="badge" style={{ display: 'block', margin: '8px 0', padding: '8px 12px' }}>{notice}</div>}
      {c.escalated && (
        <div role="note" className="callout">
          <strong>Escalated: {c.escalationReason}.</strong> {isSenior ? 'You may respond and lift the escalation.' : 'Only the MP or an administrator can respond. You can triage, add notes and assign.'}
        </div>
      )}
      {c.anonymizedAt && <div role="note" className="callout">Personal data was removed on {fmt(c.anonymizedAt)}. Only the non-identifying record remains.</div>}

      <div className="case-grid">
        <section aria-labelledby="orig">
          <h4 id="orig">Citizen&apos;s issue (as written)</h4>
          <blockquote className="quote">{original?.content ?? '-'}</blockquote>
          <dl className="facts">
            <div><dt>Location</dt><dd>{c.locationText ?? '-'}</dd></div>
            <div><dt>Reply language</dt><dd>{c.preferredLanguage}</dd></div>
            <div><dt>Contact</dt><dd>{c.contact ? `${c.contact.channel}${c.contact.email ? ` - ${c.contact.email}` : ''}${c.contact.phone ? ` - ${c.contact.phone}` : ''}${c.contact.name ? ` (${c.contact.name})` : ''}` : 'None held'}</dd></div>
            <div><dt>Consent</dt><dd>Given {fmt(c.consentGivenAt)}</dd></div>
            <div><dt>Keep until</dt><dd>{fmt(c.retainUntil)}</dd></div>
          </dl>
        </section>

        <section aria-labelledby="triage">
          <h4 id="triage">Triage</h4>
          <p className="sub">Automatic suggestion ({c.aiClassification.method}, a keyword rule - not a person): <strong>{catLabel(c.aiClassification.category)}</strong>
            {c.aiClassification.confidence !== null && <> - confidence {Math.round(c.aiClassification.confidence * 100)}%</>}. Correct the category if it is wrong.</p>
          <div className="form-row">
            <label>Category
              <select value={c.category} disabled={busy || closed} onChange={(e) => act('Category updated.', () => casesApi.update(id, { category: e.target.value }))}>
                {CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>Priority
              <select value={c.priority} disabled={busy || closed} onChange={(e) => act('Priority updated.', () => casesApi.update(id, { priority: e.target.value as CasePriority }))}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
              </select>
            </label>
            <label>Assigned to
              <select value={c.assignee?.id ?? ''} disabled={busy || closed} onChange={(e) => act(e.target.value ? 'Case assigned.' : 'Case unassigned.', () => casesApi.assign(id, e.target.value || null))}>
                <option value="">Unassigned</option>
                {assignees.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
              </select>
            </label>
          </div>
          <div className="actions" role="group" aria-label="Move this case to">
            {c.allowedTransitions.map((s) => (
              <button key={s} type="button" className={s === 'CLOSED' ? 'btn ghost' : 'btn'} disabled={busy} onClick={() => act(`Status changed to ${STATUS_LABEL[s]}.`, () => casesApi.setStatus(id, s))}>{STATUS_LABEL[s]}</button>
            ))}
            {!c.allowedTransitions.length && <span className="sub">This case is closed and cannot be changed.</span>}
          </div>
          {!closed && (c.escalated ? isSenior : true) && (
            <p><button type="button" className="btn ghost sm" disabled={busy} onClick={toggleEscalation}>{c.escalated ? 'Lift escalation' : 'Escalate to MP'}</button></p>
          )}
        </section>
      </div>

      <section aria-labelledby="thread">
        <h4 id="thread">Conversation</h4>
        <ul className="thread">
          {c.messages.map((m) => (
            <li key={m.id} className={m.visibility === 'INTERNAL' ? 'msg internal' : m.authorType === 'CITIZEN' ? 'msg citizen' : 'msg staff'}>
              <p className="meta">
                <strong>{m.visibility === 'INTERNAL' ? 'Internal note' : m.authorType === 'CITIZEN' ? 'Citizen' : 'Office response'}</strong> - {fmt(m.createdAt)}
                {m.visibility === 'INTERNAL' && <span className="badge warn" style={{ marginLeft: 8 }}>Not visible to the citizen</span>}
                {m.authorType === 'STAFF' && m.visibility === 'PUBLIC' && <span className={m.deliveryState === 'FAILED' ? 'badge bad' : 'badge'} style={{ marginLeft: 8 }}>{DELIVERY[m.deliveryState]}{m.channel ? ` via ${m.channel}` : ''}</span>}
              </p>
              <p style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>
            </li>
          ))}
        </ul>

        {!closed && !c.anonymizedAt && (
          <>
            <div className="reply">
              <label htmlFor="reply">Response to the citizen (they will see this)</label>
              {templates.length > 0 && (
                <select aria-label="Insert a template" value="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) setReply(t.body); }}>
                  <option value="">Insert an approved template...</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              <textarea id="reply" rows={4} value={reply} onChange={(e) => setReply(e.target.value)} disabled={blockedByEscalation} aria-describedby={blockedByEscalation ? 'reply-block' : undefined} />
              {blockedByEscalation && <p id="reply-block" className="sub">This case is escalated, so only the MP or an administrator can send a response.</p>}
              <button type="button" className="btn" disabled={busy || blockedByEscalation || !reply.trim()} onClick={() => act('Response sent.', async () => { const r = await casesApi.respond(id, { content: reply.trim() }); setReply(''); return r; })}>Send response</button>
            </div>
            <div className="reply">
              <label htmlFor="note">Internal note (staff only)</label>
              <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="btn ghost" disabled={busy || !note.trim()} onClick={() => act('Note added.', async () => { const r = await casesApi.note(id, note.trim()); setNote(''); return r; })}>Add internal note</button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="notif">
        <h4 id="notif">Notifications to the citizen</h4>
        {c.notifications.length === 0 ? <p className="sub">No notifications sent: the citizen chose not to receive any, or none have been queued yet.</p> : (
          <table>
            <thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">Channel</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {c.notifications.map((n) => (
                <tr key={n.id}><td>{fmt(n.createdAt)}</td><td>{n.kind.replace(/_/g, ' ')}</td><td>{n.channel}</td>
                  <td><span className={n.state === 'FAILED' ? 'badge bad' : n.state === 'PENDING' ? 'badge warn' : 'badge'}>{DELIVERY[n.state]}</span></td>
                  <td>{n.lastError ?? (n.sentAt ? `Sent ${fmt(n.sentAt)}` : `Attempts: ${n.attempts}`)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="files">
        <h4 id="files">Attachments</h4>
        {c.attachments.length === 0 ? <p className="sub">No attachments.</p> : (
          <ul>
            {c.attachments.map((a) => (
              <li key={a.id}>{a.filename} ({Math.round(a.sizeBytes / 1024)} KB, {a.scanStatus.toLowerCase()}) <button type="button" className="link" onClick={() => download(a.id, a.filename)}>Download</button></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hist">
        <h4 id="hist">History</h4>
        <ol className="history">
          {c.events.map((e) => (
            <li key={e.id}>{fmt(e.createdAt)} - <strong>{e.kind.replace(/_/g, ' ')}</strong>{e.fromValue || e.toValue ? `: ${[e.fromValue, e.toValue].filter(Boolean).join(' to ')}` : ''} <span className="sub">({e.actorType})</span></li>
          ))}
        </ol>
        <div className="actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={exportCase}>Export case history</button>
          {isAdmin && !c.anonymizedAt && <button type="button" className="btn danger" disabled={busy} onClick={erase}>Erase personal data</button>}
        </div>
        <p className="sub">The export includes every message (including internal notes), the status history, notifications and the audit trail. Handle it as confidential.</p>
      </section>
    </div>
  );
}
