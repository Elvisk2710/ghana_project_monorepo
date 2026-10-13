import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, CaseSettings, SettingSource, settingsApi } from './api';
import { Banner, fmtTime, hasRole, label, useLoad, useMe } from './ui';

const FIELDS: { key: keyof CaseSettings; name: string; unit: string; help: string }[] = [
  { key: 'retentionDays', name: 'Keep closed cases for', unit: 'days', help: 'After this period a closed case has its personal data erased. The anonymous record is kept for statistics.' },
  { key: 'slaHours', name: 'First response due within', unit: 'hours', help: 'Time allowed for a first response to a normal case before it counts as overdue.' },
  { key: 'slaUrgentHours', name: 'Urgent cases due within', unit: 'hours', help: 'Time allowed for a first response to an urgent (escalated) case. Cannot be longer than the normal time.' },
];

const SOURCE: Record<SettingSource, string> = { database: 'set here', environment: 'from server configuration', default: 'built-in default (awaiting a decision from Parliament)' };

export default function SettingsScreen() {
  const me = useMe();
  const canEdit = hasRole(me, 'ADMIN');
  const s = useLoad(settingsApi.get, []);
  const [draft, setDraft] = useState<Record<keyof CaseSettings, string> | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const cases = s.data?.cases;
  useEffect(() => {
    if (cases) setDraft({ retentionDays: String(cases.values.retentionDays), slaHours: String(cases.values.slaHours), slaUrgentHours: String(cases.values.slaUrgentHours) });
  }, [cases]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!cases || !draft) return;
    setNotice('');
    const next = {} as CaseSettings;
    for (const f of FIELDS) {
      const n = Number(draft[f.key]);
      const { min, max } = cases.limits[f.key];
      if (draft[f.key].trim() === '' || !Number.isInteger(n) || n < min || n > max) return setError(`${f.name}: enter a whole number from ${min} to ${max}.`);
      next[f.key] = n;
    }
    if (next.slaUrgentHours > next.slaHours) return setError('Urgent cases cannot be given longer than normal cases.');
    setBusy(true);
    setError('');
    try {
      s.setData(await settingsApi.saveCases(next));
      setNotice('Saved. New cases and new closures use these values straight away; the change is recorded in the audit trail.');
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const downloadLedger = async () => {
    setError('');
    try {
      const ledger = await settingsApi.ledger();
      const url = URL.createObjectURL(new Blob([JSON.stringify(ledger, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `erasure-ledger-${ledger.generatedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${ledger.count} erasure record(s). Keep the file outside the database; it contains no personal data.`);
    } catch (err) {
      setError((err as ApiError).message);
    }
  };

  const d = s.data;
  return (
    <>
      <Banner error={error || s.error} notice={notice} needsToken={s.needsToken} onToken={s.reload} />
      {d && draft && (
        <>
          <div className="panel">
            <div className="panel-head"><h3>Case handling</h3>{d.cases.updatedAt && <span className="sub">Last changed {fmtTime(d.cases.updatedAt)}</span>}</div>
            <form onSubmit={save} className="formgrid" noValidate>
              {FIELDS.map((f) => (
                <label className="field" key={f.key}>
                  {f.name} ({f.unit})
                  <input
                    type="number" inputMode="numeric" min={d.cases.limits[f.key].min} max={d.cases.limits[f.key].max}
                    value={draft[f.key]} disabled={!canEdit || busy}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    aria-describedby={`${f.key}-help`}
                  />
                  <span id={`${f.key}-help`} className="sub">{f.help} Current value is {SOURCE[d.cases.sources[f.key]]}.</span>
                </label>
              ))}
              {canEdit
                ? <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving...' : 'Save case settings'}</button>
                : <p className="sub">Only an administrator can change these values.</p>}
            </form>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Public answers and retrieval</h3><Link to="/mlops" className="link">Open AI governance</Link></div>
            <dl className="kv">
              <dt>Public answering</dt><dd>{d.answering.enabled ? 'On' : `Paused${d.answering.reason ? `: ${d.answering.reason}` : ''}`}</dd>
              <dt>Answer generator</dt><dd>{d.retrieval.deploymentId ? `${label(d.retrieval.generator)} (approved deployment)` : 'Built-in baseline: quotes the best-matching source passage'}</dd>
              <dt>Minimum source match</dt><dd>{d.retrieval.minScore}</dd>
              <dt>Passages used per answer</dt><dd>{d.retrieval.maxPassages}</dd>
              <dt>Retriever version</dt><dd>{d.retrieval.retrieverVersion ?? 'Built-in'}</dd>
            </dl>
            <p className="sub" style={{ padding: '0 22px 16px' }}>These are not editable here on purpose. {d.retrieval.changeVia}; {d.answering.changeVia.toLowerCase()}. Each change then needs evaluation evidence and a second person's approval.</p>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Languages</h3></div>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Language support levels</caption>
                <thead><tr><th scope="col">Language</th><th scope="col">Support</th><th scope="col">What citizens are told</th></tr></thead>
                <tbody>
                  {d.languages.items.map((l) => (
                    <tr key={l.code}><td>{l.name}</td><td><span className={l.level === 'supported' ? 'badge' : 'badge warn'}>{label(l.level)}</span></td><td>{l.note}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub" style={{ padding: '12px 22px 16px' }}>{d.languages.changeVia}.</p>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Notifications and attachments</h3></div>
            <dl className="kv">
              <dt>Citizen notifications</dt>
              <dd>{d.notifications.configured ? `Provider: ${d.notifications.provider}` : 'No delivery provider configured: notifications fail and show as failed on the case.'}</dd>
              <dt>Staff alerts</dt><dd>{d.notifications.staffAlerts ? 'On: new and escalated issues, AI alerts and incidents' : 'Off'}</dd>
              <dt>Attachment scanning</dt><dd>{d.attachments.scanner}</dd>
            </dl>
            <p className="sub" style={{ padding: '0 22px 16px' }}>{d.notifications.changeVia}.</p>
          </div>

          {canEdit && (
            <div className="panel">
              <div className="panel-head"><h3>Erasure ledger</h3></div>
              <p style={{ padding: '0 22px 12px' }}>A list of the cases whose personal data has been erased. It holds no personal data. Download it regularly and keep it outside the database: after restoring a backup it is replayed so erased data does not come back.</p>
              <div style={{ padding: '0 22px 18px' }}><button type="button" className="btn ghost" onClick={downloadLedger}>Download erasure ledger</button></div>
            </div>
          )}
        </>
      )}
    </>
  );
}
