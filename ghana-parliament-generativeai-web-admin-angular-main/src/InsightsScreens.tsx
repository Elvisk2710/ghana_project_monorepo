import { useState } from 'react';
import { insightsApi, opsApi } from './api';
import { Banner, fmtTime, hasRole, label, useLoad, useMe } from './ui';

/** Picks the constituency to show insights for: the caller's own (MP) or assigned (STAFF)
 *  constituencies, or any constituency for an administrator. */
function useConstituencyPicker() {
  const me = useMe();
  const mps = useLoad(opsApi.mps, []);
  const [chosen, setChosen] = useState('');
  const isAdmin = hasRole(me, 'ADMIN');
  const options = isAdmin
    ? (mps.data ?? []).map((m) => ({ id: m.constituencyId, name: m.constituency?.name ?? m.constituencyId }))
    : (me?.constituencyIds ?? []).map((id) => ({ id, name: (mps.data ?? []).find((m) => m.constituencyId === id)?.constituency?.name ?? id }));
  const dedup = [...new Map(options.map((o) => [o.id, o])).values()];
  const constituencyId = chosen || dedup[0]?.id || '';
  return { me, options: dedup, constituencyId, setChosen, loading: mps.loading };
}

function ConstituencyPicker({ options, value, onChange }: { options: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  if (options.length <= 1) return null;
  return (
    <div className="toolbar">
      <select aria-label="Constituency" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}

/** The MP self-service dashboard: read-only top concerns, trending topics, open-case volume,
 *  and constituency sentiment (when an AI provider is configured). */
export function MpDashboardScreen() {
  const { options, constituencyId, setChosen } = useConstituencyPicker();
  const overview = useLoad(() => insightsApi.mpOverview(constituencyId), [constituencyId]);
  const clusters = useLoad(() => insightsApi.clusters(constituencyId), [constituencyId]);
  const d = overview.data;

  if (!constituencyId) {
    return <div className="panel"><div className="panel-head"><h3>MP dashboard</h3></div><p style={{ padding: '0 22px 22px' }}>No constituency is assigned to your account yet.</p></div>;
  }

  return (
    <>
      <div className="panel">
        <div className="panel-head"><h3>{d ? `${d.constituency.name} — insight dashboard` : 'MP dashboard'}</h3>{d && <span className="sub">Measured {fmtTime(d.measuredAt)}</span>}</div>
        <p className="sub" style={{ margin: '0 22px 12px' }}>Read-only: what your constituents are raising, and how it is trending. Nothing here can be edited; respond to a case from Citizen cases.</p>
        <ConstituencyPicker options={options} value={constituencyId} onChange={setChosen} />
        <Banner error={overview.error} needsToken={overview.needsToken} onToken={overview.reload} />
      </div>
      {d && (
        <>
          <div className="stats">
            <article className="stat"><b>{d.openCases}</b><span>Open cases</span></article>
            {d.sentiment.available ? (
              <article className="stat"><b>{d.sentiment.label}</b><span>Constituency sentiment ({d.sentiment.sampleSize} recent cases)</span></article>
            ) : (
              <article className="stat"><b>Not available</b><span>Constituency sentiment</span></article>
            )}
          </div>
          {!d.sentiment.available && <p className="sub" style={{ padding: '0 22px' }}>{d.sentiment.reason}</p>}
          {d.sentiment.available && d.sentiment.summary && <p className="sub" style={{ padding: '0 22px' }}>{d.sentiment.summary}</p>}

          <div className="panel">
            <div className="panel-head"><h3>Top concerns</h3></div>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Top concerns</caption>
                <thead><tr><th scope="col">Category</th><th scope="col">Cases (all time)</th></tr></thead>
                <tbody>
                  {d.topConcerns.map((c) => <tr key={c.category}><td>{label(c.category)}</td><td>{c.count}</td></tr>)}
                  {!d.topConcerns.length && <tr><td colSpan={2}>No cases yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Trending topics (last 30 days vs. the 30 before)</h3></div>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Trending topics</caption>
                <thead><tr><th scope="col">Category</th><th scope="col">This period</th><th scope="col">Previous period</th><th scope="col">Change</th></tr></thead>
                <tbody>
                  {d.trendingTopics.map((t) => (
                    <tr key={t.category}><td>{label(t.category)}</td><td>{t.count}</td><td>{t.previousCount}</td><td>{t.change > 0 ? `+${t.change}` : t.change}</td></tr>
                  ))}
                  {!d.trendingTopics.length && <tr><td colSpan={4}>No recent cases.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Issue clusters</h3></div>
            <p className="sub" style={{ margin: '0 22px 12px' }}>Open cases grouped by category. A cluster is flagged urgent when it has an escalation, an overdue case, or at least 3 open cases.</p>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Issue clusters</caption>
                <thead><tr><th scope="col">Category</th><th scope="col">Open</th><th scope="col">Overdue</th><th scope="col">Escalated</th><th scope="col">Urgent</th></tr></thead>
                <tbody>
                  {(clusters.data ?? []).map((c) => (
                    <tr key={c.category}>
                      <td>{label(c.category)}</td><td>{c.count}</td><td>{c.overdue}</td><td>{c.escalated}</td>
                      <td>{c.urgent ? <span className="badge bad">Urgent</span> : <span className="badge">Normal</span>}</td>
                    </tr>
                  ))}
                  {!clusters.loading && !(clusters.data ?? []).length && <tr><td colSpan={5}>No open cases.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** National issue heatmap for Parliament leadership: region x category severity. ADMIN/REVIEWER only. */
export function HeatmapScreen() {
  const heatmap = useLoad(insightsApi.heatmap, []);
  return (
    <div className="panel">
      <div className="panel-head"><h3>National issue heatmap</h3></div>
      <p className="sub" style={{ margin: '0 22px 12px' }}>Open citizen cases by region, to help prioritise the national agenda. Severity rises with the overdue/escalated share and with volume.</p>
      <Banner error={heatmap.error} needsToken={heatmap.needsToken} onToken={heatmap.reload} />
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Regions by severity</caption>
          <thead><tr><th scope="col">Region</th><th scope="col">Open cases</th><th scope="col">Overdue</th><th scope="col">Escalated</th><th scope="col">Top category</th><th scope="col">Severity</th></tr></thead>
          <tbody>
            {(heatmap.data ?? []).map((r) => (
              <tr key={r.region}>
                <td>{r.region}</td><td>{r.openCases}</td><td>{r.overdue}</td><td>{r.escalated}</td><td>{r.topCategory ? label(r.topCategory) : '-'}</td>
                <td><span className={r.severity >= 0.6 ? 'badge bad' : r.severity >= 0.3 ? 'badge warn' : 'badge'}>{Math.round(r.severity * 100)}%</span></td>
              </tr>
            ))}
            {!heatmap.loading && !(heatmap.data ?? []).length && <tr><td colSpan={6}>No open cases anywhere.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
