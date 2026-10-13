import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, ApprovalRow, AuditRow, Overview, UserRow, opsApi } from './api';
import { Banner, CheckList, Dialog, fmtTime, hasRole, label, useLoad, useMe } from './ui';

const ROLES = ['STAFF', 'MP', 'RESEARCHER', 'REVIEWER', 'ADMIN'];
const DECISION: Record<ApprovalRow['decision'], string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CHANGES_REQUESTED: 'Changes requested' };

// ---------------------------------------------------------------- Approvals ledger (T-067)

export function ApprovalsScreen() {
  const me = useMe();
  const [filter, setFilter] = useState('');
  const list = useLoad(() => opsApi.approvals(filter || undefined), [filter]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const canDecide = hasRole(me, 'REVIEWER', 'ADMIN');
  const [review, setReview] = useState<ApprovalRow | null>(null);

  const decide = async (a: ApprovalRow, decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED', reviewedEvidence?: boolean) => {
    // An AI deployment is approved on its evaluation evidence: show it, and require the reviewer to say they read it.
    if (decision === 'APPROVED' && a.objectType === 'ai_deployment' && !reviewedEvidence) { setReview(a); return; }
    let notes: string | undefined;
    if (decision !== 'APPROVED') {
      notes = window.prompt(decision === 'REJECTED' ? `Why are you rejecting "${a.objectLabel}"?` : `What changes are needed to "${a.objectLabel}"?`)?.trim();
      if (!notes) return;
    }
    setError(''); setNotice('');
    try { await opsApi.decide(a.id, decision, notes, reviewedEvidence); setNotice(`${DECISION[decision]}: ${a.objectLabel}.`); setReview(null); } catch (e) { setError((e as ApiError).message); }
    await list.reload();
  };

  return (
    <div className="panel">
      <div className="panel-head"><h3>Approvals</h3></div>
      <p className="sub" style={{ margin: '0 0 12px' }}>Nothing becomes public, or is withdrawn, until a reviewer other than the requester approves it. Each decision is recorded here and in the audit trail.</p>
      <Banner error={error || list.error} notice={notice} needsToken={list.needsToken} onToken={list.reload} />
      <div className="toolbar">
        <select aria-label="Filter by decision" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All decisions</option>
          {Object.entries(DECISION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button type="button" className="btn ghost" onClick={list.reload}>Refresh</button>
      </div>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Approval requests</caption>
          <thead><tr><th scope="col">Requested</th><th scope="col">Record</th><th scope="col">Request</th><th scope="col">By</th><th scope="col">Decision</th><th scope="col">Decided by</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {(list.data ?? []).map((a) => {
              const mine = a.requesterId === me?.userId;
              return (
                <tr key={a.id}>
                  <td>{fmtTime(a.createdAt)}</td>
                  <td>{label(a.objectType)}: {a.objectLabel ?? a.objectId}</td>
                  <td>{a.action === 'publish' ? 'Publish' : a.action === 'deploy' ? 'Deploy to the public' : 'Withdraw'}{a.reason ? ` - ${a.reason}` : ''}</td>
                  <td>{a.requester?.displayName ?? '-'}</td>
                  <td><span className={a.decision === 'PENDING' ? 'badge warn' : a.decision === 'APPROVED' ? 'badge' : 'badge bad'}>{DECISION[a.decision]}</span>{a.evidence?.notes ? <div className="sub">{a.evidence.notes}</div> : null}</td>
                  <td>{a.approver ? `${a.approver.displayName} (${fmtTime(a.decidedAt)})` : '-'}</td>
                  <td>
                    {a.decision === 'PENDING' && canDecide && !mine && (
                      <span className="actions">
                        <button type="button" className="btn sm" onClick={() => decide(a, 'APPROVED')} aria-label={`Approve ${a.objectLabel}`}>Approve</button>
                        <button type="button" className="btn ghost sm" onClick={() => decide(a, 'CHANGES_REQUESTED')} aria-label={`Request changes to ${a.objectLabel}`}>Request changes</button>
                        <button type="button" className="btn ghost sm" onClick={() => decide(a, 'REJECTED')} aria-label={`Reject ${a.objectLabel}`}>Reject</button>
                      </span>
                    )}
                    {a.decision === 'PENDING' && mine && <span className="sub">Waiting for another reviewer</span>}
                    {a.decision === 'PENDING' && !canDecide && !mine && <span className="sub">Reviewer decision needed</span>}
                  </td>
                </tr>
              );
            })}
            {!list.loading && !(list.data ?? []).length && <tr><td colSpan={7}>No approval requests{filter ? ' with this decision' : ''}.</td></tr>}
          </tbody>
        </table>
      </div>
      {review && <EvidenceDialog approval={review} onClose={() => setReview(null)} onApprove={() => decide(review, 'APPROVED', true)} />}
    </div>
  );
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

/** Shows what the evaluation found before a reviewer can approve an AI deployment. */
function EvidenceDialog({ approval, onClose, onApprove }: { approval: ApprovalRow; onClose: () => void; onApprove: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const e = approval.evidence;
  return (
    <Dialog title={`Evidence for: ${approval.objectLabel ?? 'AI deployment'}`} onClose={onClose}>
      <div style={{ padding: '0 22px 22px' }}>
        {e?.summary ? (
          <ul aria-label="Evaluation results">
            <li>Answer quality {pct(e.summary.answerQuality)} over {e.summary.n} cases</li>
            <li>Retrieval recall {pct(e.summary.retrievalRecall)}; citations complete {pct(e.summary.citationCompleteness)}; refusals correct {pct(e.summary.refusalQuality)}</li>
            <li>Harmful outputs {e.summary.harmfulOutputs}; p95 latency {e.summary.latencyP95Ms ?? 'n/a'} ms</li>
          </ul>
        ) : <p role="alert" className="badge bad">The evaluation evidence is missing, so this cannot be approved.</p>}
        {e?.gate && !e.gate.passed && <p role="alert" className="badge bad">The release gate was not passed.</p>}
        {(e?.gate?.warnings ?? []).length > 0 && <><h5>Warnings</h5><ul>{e!.gate!.warnings.map((w) => <li key={w}>{w}</li>)}</ul></>}
        <h5>Results by group</h5>
        <ul aria-label="Results by group">
          {(e?.slices ?? []).map((s) => <li key={`${s.dimension}:${s.value}`}>{label(s.dimension)} {s.value}: quality {pct(s.answerQuality)} over {s.n} case(s){s.underpowered ? ' (too few cases to rely on)' : ''}</li>)}
        </ul>
        <p className="sub">The thresholds used to pass this evaluation are on record: {Object.entries(e?.releaseThresholds ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}. A threshold lower than the default is visible here.</p>
        <label><input type="checkbox" checked={confirmed} onChange={(ev) => setConfirmed(ev.target.checked)} /> I reviewed the failure cases and the language and constituency results, and I am not the person who ran this evaluation or asked for it.</label>
        <p><button type="button" className="btn" disabled={!confirmed || !e?.summary} onClick={onApprove}>Approve deployment</button></p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Users and roles (T-066)

export function UsersScreen() {
  const me = useMe();
  const users = useLoad(opsApi.users, []);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const shown = useMemo(() => {
    const cutoff = Date.now() - 90 * 86_400_000;
    return (users.data ?? []).filter((u) => !stale || (u.active && !u.invited && (!u.lastLoginAt || new Date(u.lastLoginAt).getTime() < cutoff)));
  }, [users.data, stale]);

  const toggle = async (u: UserRow) => {
    if (u.active && !window.confirm(`Deactivate ${u.displayName}? They lose access immediately and their open cases become unassigned.`)) return;
    setError(''); setNotice('');
    try { await opsApi.setActive(u.id, !u.active); setNotice(u.active ? `${u.displayName} was deactivated.` : `${u.displayName} was reactivated.`); } catch (e) { setError((e as ApiError).message); }
    await users.reload();
  };

  return (
    <div className="panel">
      <div className="panel-head"><h3>Users and roles</h3><button type="button" className="btn primary" onClick={() => setEditing('new')}>+ Invite user</button></div>
      <p className="sub" style={{ margin: '0 0 12px' }}>Access is granted here, not by the sign-in token. An invited person is linked to their identity the first time they sign in with that verified email address.</p>
      <Banner error={error || users.error} notice={notice} needsToken={users.needsToken} onToken={users.reload} />
      <div className="toolbar">
        <label><input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} /> Access review: active people who have not signed in for 90 days</label>
      </div>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Users</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Roles</th><th scope="col">Constituencies</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td><td>{u.email}</td>
                <td>{u.roles.map((r) => <span key={r} className="badge" style={{ marginRight: 4 }}>{label(r)}</span>)}</td>
                <td>{u.constituencies.map((c) => c.constituency.name).join(', ') || '-'}</td>
                <td><span className={!u.active ? 'badge bad' : u.invited ? 'badge warn' : 'badge'}>{!u.active ? 'Deactivated' : u.invited ? 'Invited' : 'Active'}</span></td>
                <td>{u.invited ? 'Not yet' : fmtTime(u.lastLoginAt)}</td>
                <td>
                  <button type="button" className="link" onClick={() => setEditing(u)} aria-label={`Edit access for ${u.displayName}`}>Edit access</button>{' '}
                  {u.id !== me?.userId && <button type="button" className="link" onClick={() => toggle(u)} aria-label={`${u.active ? 'Deactivate' : 'Reactivate'} ${u.displayName}`}>{u.active ? 'Deactivate' : 'Reactivate'}</button>}
                </td>
              </tr>
            ))}
            {!users.loading && !shown.length && <tr><td colSpan={7}>{stale ? 'Everyone has signed in recently.' : 'No users.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <UserForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); setNotice(m); users.reload(); }} />}
    </div>
  );
}

function UserForm({ initial, onClose, onSaved }: { initial: UserRow | null; onClose: () => void; onSaved: (m: string) => void }) {
  const cons = useLoad(opsApi.constituencies, []);
  const [email, setEmail] = useState('');
  const [displayName, setName] = useState(initial?.displayName ?? '');
  const [roles, setRoles] = useState<string[]>(initial?.roles ?? ['STAFF']);
  const [scope, setScope] = useState<string[]>(initial?.constituencies.map((c) => c.constituencyId) ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!initial && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter a valid email address.');
    if (displayName.trim().length < 2) return setError('Enter a name.');
    if (!roles.length) return setError('Choose at least one role.');
    setBusy(true); setError('');
    try {
      if (initial) await opsApi.updateUser(initial.id, { displayName: displayName.trim(), roles, constituencyIds: scope });
      else await opsApi.invite({ email: email.trim(), displayName: displayName.trim(), roles, constituencyIds: scope });
      onSaved(initial ? 'Access updated.' : `Invitation recorded for ${email.trim()}. They get access when they first sign in with that email.`);
    } catch (err) { setError((err as ApiError).message); setBusy(false); }
  };
  return (
    <Dialog title={initial ? `Edit access: ${initial.displayName}` : 'Invite user'} onClose={onClose}>
      <form onSubmit={submit} className="formgrid" noValidate>
        {!initial && <label className="field">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>}
        <label className="field">Name<input value={displayName} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
        <CheckList legend="Roles" options={ROLES.map((r) => ({ id: r, label: label(r) }))} value={roles} onChange={setRoles} />
        <CheckList legend="Constituencies they handle cases for (STAFF and MP)" options={(cons.data ?? []).map((c) => ({ id: c.id, label: `${c.name} (${c.region})` }))} value={scope} onChange={setScope} />
        {error && <div role="alert" className="badge bad">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving...' : initial ? 'Save access' : 'Send invitation'}</button>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Audit trail

export function AuditScreen() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [objectType, setObjectType] = useState('');
  const first = useLoad(async () => {
    const page = await opsApi.audit(undefined, { objectType: objectType || undefined });
    setRows(page.items);
    setCursor(page.nextCursor);
    return page;
  }, [objectType]);
  const [error, setError] = useState('');

  const more = async () => {
    try {
      const page = await opsApi.audit(cursor ?? undefined, { objectType: objectType || undefined });
      setRows((r) => [...r, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) { setError((e as ApiError).message); }
  };

  return (
    <div className="panel">
      <div className="panel-head"><h3>Audit trail</h3></div>
      <p className="sub" style={{ margin: '0 0 12px' }}>An append-only record of who did what. Entries cannot be edited or deleted, even by administrators or the application.</p>
      <Banner error={error || first.error} needsToken={first.needsToken} onToken={first.reload} />
      <div className="toolbar">
        <select aria-label="Filter by record type" value={objectType} onChange={(e) => setObjectType(e.target.value)}>
          <option value="">All records</option>
          {['document', 'case', 'sitting', 'bill', 'committee', 'mp', 'user', 'approval', 'constituency', 'template'].map((t) => <option key={t} value={t}>{label(t)}</option>)}
        </select>
        <button type="button" className="btn ghost" onClick={first.reload}>Refresh</button>
      </div>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Audit events</caption>
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Record</th><th scope="col">Outcome</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{fmtTime(e.occurredAt)}</td>
                <td>{e.actorType === 'user' ? `${e.actorRoles.map(label).join(', ')} (${e.actorId?.slice(0, 8)})` : label(e.actorType)}</td>
                <td>{e.action}</td><td>{e.objectType ? `${e.objectType} ${e.objectId?.slice(0, 8) ?? ''}` : '-'}</td>
                <td><span className={e.outcome === 'success' ? 'badge' : 'badge bad'}>{label(e.outcome)}</span></td>
              </tr>
            ))}
            {!first.loading && !rows.length && <tr><td colSpan={5}>No events.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '12px 22px' }}>{cursor && <button type="button" className="btn ghost" onClick={more}>Load more</button>}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Overview (T-068)

export function OverviewScreen({ onLoaded }: { onLoaded?: (o: Overview) => void }) {
  const o = useLoad(async () => { const r = await opsApi.overview(); onLoaded?.(r); return r; }, []);
  const d = o.data;
  const docs = d?.documents ?? {};
  const tiles: [string, string | number, string][] = d ? [
    ['Published documents', docs['PUBLISHED'] ?? 0, 'documents'],
    ['Documents awaiting review', (docs['REVIEW'] ?? 0) + (docs['APPROVED'] ?? 0), 'documents'],
    ['Passages searchable by the public', d.publishedChunks, 'documents'],
    ['Questions answered, last 7 days', d.answers.last7Days, ''],
    ['Answers backed by sources', d.answers.groundedShare === null ? 'No questions yet' : `${d.answers.groundedShare}%`, ''],
    ['Approvals waiting', d.approvalsPending, 'approvals'],
    ['Upcoming sittings', d.upcomingSittings, 'sittings'],
    ['Open citizen cases', d.cases.open, 'cases'],
    ['Cases past their response date', d.cases.overdue, 'cases'],
    ['Escalated cases', d.cases.escalated, 'cases'],
    ['Failed notifications', d.cases.failedNotifications, 'cases'],
    ['Active users', d.system.activeUsers, 'users'],
  ] : [];
  return (
    <>
      <Banner error={o.error} needsToken={o.needsToken} onToken={o.reload} />
      <div className="stats">
        {tiles.map(([name, n, to]) => (
          <article className="stat" key={name}>
            <b>{n}</b><span>{to ? <Link to={`/${to}`}>{name}</Link> : name}</span>
          </article>
        ))}
      </div>
      {d && (
        <div className="panel">
          <div className="panel-head"><h3>Bills by stage</h3><span className="sub">Measured {fmtTime(d.generatedAt)}</span></div>
          <p style={{ padding: '0 22px 16px' }}>{Object.keys(d.billsByStage).length ? Object.entries(d.billsByStage).map(([s, n]) => `${label(s)}: ${n}`).join(' - ') : 'No bills recorded yet.'}</p>
          {d.system.deadJobs > 0 && <p role="alert" className="badge bad" style={{ margin: '0 22px 16px' }}>{d.system.deadJobs} background job(s) failed permanently and need attention.</p>}
        </div>
      )}
    </>
  );
}
