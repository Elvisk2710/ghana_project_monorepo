import { useMemo, useState } from 'react';
import { ApiError, AvailabilityWindow, Mp, meetingsApi, opsApi } from './api';
import { Banner, fmtTime, hasRole, label, useLoad, useMe } from './ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function useMyMp(mps: Mp[] | null) {
  const me = useMe();
  const isAdmin = hasRole(me, 'ADMIN');
  const [chosen, setChosen] = useState('');
  const mine = isAdmin ? (mps ?? []) : (mps ?? []).filter((m) => (me?.constituencyIds ?? []).includes(m.constituencyId));
  const mpId = chosen || mine[0]?.id || '';
  return { mine, mpId, setChosen };
}

/** MP/staff console for publishing weekly availability and deciding on citizen meeting requests. */
export function MeetingsScreen() {
  const mps = useLoad(opsApi.mps, []);
  const { mine, mpId, setChosen } = useMyMp(mps.data);
  const meetings = useLoad(() => meetingsApi.list(mpId), [mpId]);
  const availability = useLoad(() => meetingsApi.availability(mpId), [mpId]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [windows, setWindows] = useState<AvailabilityWindow[]>([]);
  useMemo(() => setWindows(availability.data ?? []), [availability.data]);

  const act = async (done: string, fn: () => Promise<unknown>) => {
    setError(''); setNotice('');
    try { await fn(); setNotice(done); await Promise.all([meetings.reload(), availability.reload()]); } catch (e) { setError((e as ApiError).message); }
  };

  const saveWindows = () => act('Availability updated.', () => meetingsApi.setAvailability(mpId, windows.map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime }))));

  if (!mpId) {
    return <div className="panel"><div className="panel-head"><h3>Meetings</h3></div><p style={{ padding: '0 22px 22px' }}>No MP record is linked to your account yet.</p></div>;
  }

  const requested = (meetings.data ?? []).filter((m) => m.status === 'REQUESTED');
  const decided = (meetings.data ?? []).filter((m) => m.status !== 'REQUESTED');

  return (
    <>
      <div className="panel">
        <div className="panel-head"><h3>Meetings</h3></div>
        {mine.length > 1 && (
          <div className="toolbar">
            <select aria-label="MP" value={mpId} onChange={(e) => setChosen(e.target.value)}>
              {mine.map((m) => <option key={m.id} value={m.id}>{m.officialName}</option>)}
            </select>
          </div>
        )}
        <Banner error={error || meetings.error || availability.error} notice={notice} needsToken={meetings.needsToken} onToken={meetings.reload} />
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Weekly availability</h3></div>
        <p className="sub" style={{ margin: '0 22px 12px' }}>Citizens can only request a meeting inside one of these windows. Replacing the list below replaces it entirely.</p>
        <div className="formgrid" style={{ padding: '0 22px 16px' }}>
          {windows.map((w, i) => (
            <div key={i} className="agenda-row">
              <select aria-label={`Window ${i + 1} day`} value={w.dayOfWeek} onChange={(e) => setWindows((x) => x.map((y, n) => (n === i ? { ...y, dayOfWeek: Number(e.target.value) } : y)))}>
                {DAYS.map((d, n) => <option key={n} value={n}>{d}</option>)}
              </select>
              <input aria-label={`Window ${i + 1} start`} type="time" value={w.startTime} onChange={(e) => setWindows((x) => x.map((y, n) => (n === i ? { ...y, startTime: e.target.value } : y)))} />
              <input aria-label={`Window ${i + 1} end`} type="time" value={w.endTime} onChange={(e) => setWindows((x) => x.map((y, n) => (n === i ? { ...y, endTime: e.target.value } : y)))} />
              <button type="button" className="link" onClick={() => setWindows((x) => x.filter((_, n) => n !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn ghost sm" onClick={() => setWindows((x) => [...x, { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }])}>+ Add window</button>
          <button type="button" className="btn primary" onClick={saveWindows}>Save availability</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Requested ({requested.length})</h3></div>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Requested meetings</caption>
            <thead><tr><th scope="col">Requested by</th><th scope="col">Topic</th><th scope="col">Time</th><th scope="col">Duration</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {requested.map((m) => (
                <tr key={m.id}>
                  <td>{m.requestedName}</td><td>{m.topic}</td><td>{fmtTime(m.requestedSlot)}</td><td>{m.durationMinutes} min</td>
                  <td>
                    <button type="button" className="link" onClick={() => act('Meeting confirmed.', () => meetingsApi.decide(m.id, 'CONFIRMED'))}>Confirm</button>
                    {' '}<button type="button" className="link" onClick={() => { const note = window.prompt('Reason for declining (shown to no one automatically; kept for your own record)')?.trim(); act('Meeting declined.', () => meetingsApi.decide(m.id, 'DECLINED', note)); }}>Decline</button>
                  </td>
                </tr>
              ))}
              {!meetings.loading && !requested.length && <tr><td colSpan={5}>No pending requests.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Decided</h3></div>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Decided meetings</caption>
            <thead><tr><th scope="col">Requested by</th><th scope="col">Topic</th><th scope="col">Time</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {decided.map((m) => (
                <tr key={m.id}><td>{m.requestedName}</td><td>{m.topic}</td><td>{fmtTime(m.confirmedSlot ?? m.requestedSlot)}</td><td><span className="badge">{label(m.status)}</span></td></tr>
              ))}
              {!meetings.loading && !decided.length && <tr><td colSpan={4}>None yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
