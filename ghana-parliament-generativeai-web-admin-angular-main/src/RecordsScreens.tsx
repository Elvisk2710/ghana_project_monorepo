import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { AgendaItem, ApiError, Bill, BillStage, Committee, Mp, ObjectType, Sitting, SittingStatus, opsApi } from './api';
import { Banner, CheckList, Dialog, fmtDate, hasRole, label, publicationBadge, useLoad, useMe } from './ui';

const STAGES: BillStage[] = ['FIRST_READING', 'COMMITTEE', 'SECOND_READING', 'CONSIDERATION', 'THIRD_READING', 'ASSENTED', 'WITHDRAWN'];
const SITTING_STATUS: SittingStatus[] = ['SCHEDULED', 'HELD', 'CANCELLED'];

/** Shared behaviour of a records screen: list, edit dialog, and requesting (never applying) publication. */
function useRecords<T extends { id: string; isPublished: boolean }>(kind: ObjectType, list: () => Promise<T[]>) {
  const me = useMe();
  const canWrite = hasRole(me, 'STAFF', 'ADMIN');
  const items = useLoad(list, []);
  const pending = useLoad(() => opsApi.approvals('PENDING'), []);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const pendingIds = useMemo(() => new Set((pending.data ?? []).filter((a) => a.objectType === kind).map((a) => a.objectId)), [pending.data, kind]);

  const act = async (done: string, fn: () => Promise<unknown>) => {
    setError(''); setNotice('');
    try { await fn(); setNotice(done); await Promise.all([items.reload(), pending.reload()]); } catch (e) { setError((e as ApiError).message); }
  };
  const requestPublication = (r: T, name: string) => {
    if (r.isPublished) {
      const reason = window.prompt(`Why should "${name}" be withdrawn from the public?`);
      if (reason?.trim()) act('Withdrawal requested. A reviewer must approve it.', () => opsApi.requestApproval(kind, r.id, 'unpublish', reason.trim()));
    } else {
      act('Publication requested. A different reviewer must approve it before it is public.', () => opsApi.requestApproval(kind, r.id, 'publish'));
    }
  };
  const publicationCell = (r: T, name: string): ReactNode => (
    <>
      {publicationBadge(r.isPublished, pendingIds.has(r.id))}{' '}
      {canWrite && !pendingIds.has(r.id) && <button type="button" className="link" onClick={() => requestPublication(r, name)}>{r.isPublished ? 'Request withdrawal' : 'Request publishing'}</button>}
    </>
  );
  return { items, canWrite, notice, setNotice, error, setError, act, publicationCell };
}

function Shell({ title, intro, canWrite, onNew, children, banner }: { title: string; intro: string; canWrite: boolean; onNew: () => void; children: ReactNode; banner: ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head"><h3>{title}</h3>{canWrite && <button type="button" className="btn primary" onClick={onNew}>+ Add new</button>}</div>
      <p className="sub" style={{ margin: '0 0 12px' }}>{intro}</p>
      {banner}
      <div className="table-wrap">{children}</div>
    </div>
  );
}

const Row = ({ label: l, children }: { label: string; children: ReactNode }) => <label className="field">{l}{children}</label>;

// ---------------------------------------------------------------- Sittings

export function SittingsScreen() {
  const r = useRecords<Sitting>('sitting', opsApi.sittings);
  const [editing, setEditing] = useState<Sitting | 'new' | null>(null);
  return (
    <Shell title="Sittings and order papers" canWrite={r.canWrite} onNew={() => setEditing('new')} intro="Saved to the database. Changing a sitting never changes what the public sees: publishing needs approval from a different reviewer."
      banner={<Banner error={r.error || r.items.error} notice={r.notice} needsToken={r.items.needsToken} onToken={r.items.reload} />}>
      <table>
        <caption className="sr-only">Sittings</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Agenda items</th><th scope="col">Documents</th><th scope="col">Public</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {(r.items.data ?? []).map((s) => (
            <tr key={s.id}>
              <td>{fmtDate(s.date)}</td><td>{s.type}</td><td><span className="badge">{label(s.status)}</span></td>
              <td>{s.agenda?.length ?? 0}</td><td>{s._count?.documents ?? 0}</td>
              <td>{r.publicationCell(s, `${s.type} ${fmtDate(s.date)}`)}</td>
              <td>{r.canWrite && <button type="button" className="link" onClick={() => setEditing(s)} aria-label={`Edit ${s.type} ${fmtDate(s.date)}`}>Edit</button>}</td>
            </tr>
          ))}
          {!r.items.loading && !(r.items.data ?? []).length && <tr><td colSpan={7}>No sittings yet.</td></tr>}
        </tbody>
      </table>
      {editing && <SittingForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); r.setNotice(m); r.items.reload(); }} />}
    </Shell>
  );
}

function SittingForm({ initial, onClose, onSaved }: { initial: Sitting | null; onClose: () => void; onSaved: (m: string) => void }) {
  const bills = useLoad(opsApi.bills, []);
  const [date, setDate] = useState(initial ? fmtDate(initial.date) : '');
  const [type, setType] = useState(initial?.type ?? 'Plenary');
  const [status, setStatus] = useState<SittingStatus>(initial?.status ?? 'SCHEDULED');
  const [agenda, setAgenda] = useState<AgendaItem[]>(initial?.agenda ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setItem = (i: number, p: Partial<AgendaItem>) => setAgenda((a) => a.map((x, n) => (n === i ? { ...x, ...p } : x)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!date || !type.trim()) return setError('Date and type are required.');
    if (agenda.some((a) => !a.title.trim())) return setError('Every agenda item needs a title.');
    setBusy(true); setError('');
    try {
      await opsApi.saveSitting(initial?.id ?? null, { date, type: type.trim(), status, agenda: agenda.map((a) => ({ title: a.title.trim(), ...(a.billId ? { billId: a.billId } : {}) })) } as never);
      onSaved(initial ? 'Sitting saved.' : 'Sitting created.');
    } catch (err) { setError((err as ApiError).message); setBusy(false); }
  };
  return (
    <Dialog title={initial ? 'Edit sitting' : 'New sitting'} onClose={onClose}>
      <form onSubmit={submit} className="formgrid" noValidate>
        <Row label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Row>
        <Row label="Type"><input value={type} onChange={(e) => setType(e.target.value)} maxLength={100} /></Row>
        <Row label="Status"><select value={status} onChange={(e) => setStatus(e.target.value as SittingStatus)}>{SITTING_STATUS.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Row>
        <fieldset className="checklist"><legend>Order paper (agenda)</legend>
          {agenda.map((a, i) => (
            <div key={i} className="agenda-row">
              <input aria-label={`Agenda item ${i + 1} title`} value={a.title} onChange={(e) => setItem(i, { title: e.target.value })} maxLength={300} />
              <select aria-label={`Agenda item ${i + 1} bill`} value={a.billId ?? ''} onChange={(e) => setItem(i, { billId: e.target.value || undefined })}>
                <option value="">No bill</option>{(bills.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
              </select>
              <button type="button" className="link" onClick={() => setAgenda((x) => x.filter((_, n) => n !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn ghost sm" onClick={() => setAgenda((x) => [...x, { title: '' }])}>+ Add agenda item</button>
        </fieldset>
        {error && <div role="alert" className="badge bad">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Bills

export function BillsScreen() {
  const r = useRecords<Bill>('bill', opsApi.bills);
  const [editing, setEditing] = useState<Bill | 'new' | null>(null);
  const [stage, setStage] = useState('');
  const shown = (r.items.data ?? []).filter((b) => !stage || b.stage === stage);
  return (
    <Shell title="Bills tracker" canWrite={r.canWrite} onNew={() => setEditing('new')} intro="Bills, their stage, committee and the sittings that considered them. Publishing needs approval from a different reviewer."
      banner={<><Banner error={r.error || r.items.error} notice={r.notice} needsToken={r.items.needsToken} onToken={r.items.reload} />
        <div className="toolbar"><select aria-label="Filter by stage" value={stage} onChange={(e) => setStage(e.target.value)}><option value="">All stages</option>{STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div></>}>
      <table>
        <caption className="sr-only">Bills</caption>
        <thead><tr><th scope="col">Title</th><th scope="col">Stage</th><th scope="col">Committee</th><th scope="col">Introduced</th><th scope="col">Public</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {shown.map((b) => (
            <tr key={b.id}>
              <td>{b.title}</td><td><span className="badge">{label(b.stage)}</span></td><td>{b.committee?.name ?? '-'}</td><td>{fmtDate(b.introducedOn)}</td>
              <td>{r.publicationCell(b, b.title)}</td>
              <td>{r.canWrite && <button type="button" className="link" onClick={() => setEditing(b)} aria-label={`Edit ${b.title}`}>Edit</button>}</td>
            </tr>
          ))}
          {!r.items.loading && !shown.length && <tr><td colSpan={6}>{stage ? 'No bills at this stage.' : 'No bills yet.'}</td></tr>}
        </tbody>
      </table>
      {editing && <BillForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); r.setNotice(m); r.items.reload(); }} />}
    </Shell>
  );
}

function BillForm({ initial, onClose, onSaved }: { initial: Bill | null; onClose: () => void; onSaved: (m: string) => void }) {
  const sittings = useLoad(opsApi.sittings, []);
  const committees = useLoad(opsApi.committees, []);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [sponsor, setSponsor] = useState(initial?.sponsor ?? '');
  const [stage, setStage] = useState<BillStage>(initial?.stage ?? 'FIRST_READING');
  const [committeeId, setCommitteeId] = useState(initial?.committeeId ?? '');
  const [introducedOn, setIntroducedOn] = useState(initial?.introducedOn ? fmtDate(initial.introducedOn) : '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [sittingIds, setSittingIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (initial) opsApi.bill(initial.id).then((b) => setSittingIds((b.sittings ?? []).map((s) => s.sittingId))).catch(() => undefined); }, [initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 3) return setError('The title needs at least 3 characters.');
    setBusy(true); setError('');
    try {
      await opsApi.saveBill(initial?.id ?? null, { title: title.trim(), sponsor: sponsor.trim() || undefined, stage, committeeId: committeeId || undefined, introducedOn: introducedOn || undefined, summary: summary.trim() || undefined, sittingIds });
      onSaved(initial ? 'Bill saved.' : 'Bill created.');
    } catch (err) { setError((err as ApiError).message); setBusy(false); }
  };
  return (
    <Dialog title={initial ? 'Edit bill' : 'New bill'} onClose={onClose}>
      <form onSubmit={submit} className="formgrid" noValidate>
        <Row label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} /></Row>
        <Row label="Sponsor"><input value={sponsor} onChange={(e) => setSponsor(e.target.value)} maxLength={200} /></Row>
        <Row label="Stage"><select value={stage} onChange={(e) => setStage(e.target.value as BillStage)}>{STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Row>
        <Row label="Committee"><select value={committeeId} onChange={(e) => setCommitteeId(e.target.value)}><option value="">None</option>{(committees.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Row>
        <Row label="Introduced on"><input type="date" value={introducedOn} onChange={(e) => setIntroducedOn(e.target.value)} /></Row>
        <Row label="Plain-language summary"><textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} /></Row>
        <CheckList legend="Sittings that considered this bill" options={(sittings.data ?? []).map((s) => ({ id: s.id, label: `${fmtDate(s.date)} - ${s.type}` }))} value={sittingIds} onChange={setSittingIds} />
        {error && <div role="alert" className="badge bad">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Committees

export function CommitteesScreen() {
  const r = useRecords<Committee>('committee', opsApi.committees);
  const [editing, setEditing] = useState<Committee | 'new' | null>(null);
  return (
    <Shell title="Committees" canWrite={r.canWrite} onNew={() => setEditing('new')} intro="Committee membership and remit. Publishing needs approval from a different reviewer; only published MPs are named publicly."
      banner={<Banner error={r.error || r.items.error} notice={r.notice} needsToken={r.items.needsToken} onToken={r.items.reload} />}>
      <table>
        <caption className="sr-only">Committees</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Chair</th><th scope="col">Members</th><th scope="col">Bills</th><th scope="col">Public</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {(r.items.data ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td><td>{c.chair?.officialName ?? '-'}</td><td>{c._count?.members ?? 0}</td><td>{c._count?.bills ?? 0}</td>
              <td>{r.publicationCell(c, c.name)}</td>
              <td>{r.canWrite && <button type="button" className="link" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>Edit</button>}</td>
            </tr>
          ))}
          {!r.items.loading && !(r.items.data ?? []).length && <tr><td colSpan={6}>No committees yet.</td></tr>}
        </tbody>
      </table>
      {editing && <CommitteeForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); r.setNotice(m); r.items.reload(); }} />}
    </Shell>
  );
}

function CommitteeForm({ initial, onClose, onSaved }: { initial: Committee | null; onClose: () => void; onSaved: (m: string) => void }) {
  const mps = useLoad(opsApi.mps, []);
  const [name, setName] = useState(initial?.name ?? '');
  const [remit, setRemit] = useState(initial?.remit ?? '');
  const [chairMpId, setChairMpId] = useState(initial?.chairMpId ?? '');
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (initial) opsApi.committee(initial.id).then((c) => setMembers((c.members ?? []).map((m) => m.mpId))).catch(() => undefined); }, [initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return setError('The committee needs a name.');
    setBusy(true); setError('');
    try {
      await opsApi.saveCommittee(initial?.id ?? null, { name: name.trim(), remit: remit.trim() || undefined, chairMpId: chairMpId || undefined, members: members.map((mpId) => ({ mpId, role: mpId === chairMpId ? 'Chair' : 'Member' })) });
      onSaved(initial ? 'Committee saved.' : 'Committee created.');
    } catch (err) { setError((err as ApiError).message); setBusy(false); }
  };
  const options = (mps.data ?? []).map((m) => ({ id: m.id, label: `${m.officialName} (${m.party})` }));
  return (
    <Dialog title={initial ? 'Edit committee' : 'New committee'} onClose={onClose}>
      <form onSubmit={submit} className="formgrid" noValidate>
        <Row label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Row>
        <Row label="Remit"><textarea rows={3} value={remit} onChange={(e) => setRemit(e.target.value)} maxLength={2000} /></Row>
        <Row label="Chair"><select value={chairMpId} onChange={(e) => setChairMpId(e.target.value)}><option value="">None</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></Row>
        <CheckList legend="Members" options={options} value={members} onChange={setMembers} />
        {error && <div role="alert" className="badge bad">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- MP directory

export function MpsScreen() {
  const r = useRecords<Mp>('mp', opsApi.mps);
  const isAdmin = hasRole(useMe(), 'ADMIN'); // MP create/edit is administrator-only on the server
  const [editing, setEditing] = useState<Mp | 'new' | null>(null);
  return (
    <Shell title="Members of Parliament" canWrite={isAdmin} onNew={() => setEditing('new')} intro="The MP directory behind Find my MP. Only published members appear publicly, and publishing needs approval from a different reviewer."
      banner={<Banner error={r.error || r.items.error} notice={r.notice} needsToken={r.items.needsToken} onToken={r.items.reload} />}>
      <table>
        <caption className="sr-only">Members of Parliament</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Party</th><th scope="col">Constituency</th><th scope="col">Since</th><th scope="col">Public</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {(r.items.data ?? []).map((m) => (
            <tr key={m.id}>
              <td>{m.officialName}</td><td>{m.party}</td><td>{m.constituency?.name ?? '-'}</td><td>{fmtDate(m.activeFrom)}{m.activeTo ? ` to ${fmtDate(m.activeTo)}` : ''}</td>
              <td>{r.publicationCell(m, m.officialName)}</td>
              <td>{isAdmin && <button type="button" className="link" onClick={() => setEditing(m)} aria-label={`Edit ${m.officialName}`}>Edit</button>}</td>
            </tr>
          ))}
          {!r.items.loading && !(r.items.data ?? []).length && <tr><td colSpan={6}>No members yet.</td></tr>}
        </tbody>
      </table>
      {editing && <MpForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); r.setNotice(m); r.items.reload(); }} />}
    </Shell>
  );
}

function MpForm({ initial, onClose, onSaved }: { initial: Mp | null; onClose: () => void; onSaved: (m: string) => void }) {
  const cons = useLoad(opsApi.constituencies, []);
  const [officialName, setName] = useState(initial?.officialName ?? '');
  const [party, setParty] = useState(initial?.party ?? '');
  const [roleTitle, setRole] = useState(initial?.roleTitle ?? '');
  const [constituencyId, setCon] = useState(initial?.constituencyId ?? '');
  const [activeFrom, setFrom] = useState(initial ? fmtDate(initial.activeFrom) : '');
  const [activeTo, setTo] = useState(initial?.activeTo ? fmtDate(initial.activeTo) : '');
  const [contact, setContact] = useState<Record<string, string>>({ office: '', phone: '', email: '', ...(initial?.publicContact ?? {}) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!officialName.trim() || !party.trim() || !constituencyId || !activeFrom) return setError('Name, party, constituency and start date are required.');
    setBusy(true); setError('');
    const publicContact = Object.fromEntries(Object.entries(contact).filter(([, v]) => v.trim()));
    try {
      await opsApi.saveMp(initial?.id ?? null, { officialName: officialName.trim(), party: party.trim(), roleTitle: roleTitle.trim() || undefined, constituencyId, activeFrom, activeTo: activeTo || undefined, publicContact });
      onSaved(initial ? 'MP saved.' : 'MP created.');
    } catch (err) { setError((err as ApiError).message); setBusy(false); }
  };
  return (
    <Dialog title={initial ? 'Edit MP' : 'New MP'} onClose={onClose}>
      <form onSubmit={submit} className="formgrid" noValidate>
        <Row label="Official name"><input value={officialName} onChange={(e) => setName(e.target.value)} maxLength={200} /></Row>
        <Row label="Party"><input value={party} onChange={(e) => setParty(e.target.value)} maxLength={100} /></Row>
        <Row label="Role or title (optional)"><input value={roleTitle} onChange={(e) => setRole(e.target.value)} maxLength={200} /></Row>
        <Row label="Constituency"><select value={constituencyId} onChange={(e) => setCon(e.target.value)}><option value="">Choose</option>{(cons.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.region})</option>)}</select></Row>
        <Row label="Active from"><input type="date" value={activeFrom} onChange={(e) => setFrom(e.target.value)} /></Row>
        <Row label="Active to (leave empty if current)"><input type="date" value={activeTo} onChange={(e) => setTo(e.target.value)} /></Row>
        <fieldset className="checklist"><legend>Public contact details (shown on Find my MP once published)</legend>
          {(['office', 'phone', 'email'] as const).map((k) => <Row key={k} label={label(k)}><input value={contact[k] ?? ''} onChange={(e) => setContact({ ...contact, [k]: e.target.value })} maxLength={200} /></Row>)}
        </fieldset>
        {error && <div role="alert" className="badge bad">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </form>
    </Dialog>
  );
}
