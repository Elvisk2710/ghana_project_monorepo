import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import CasesScreen from './CasesScreen';
import DocumentsScreen from './DocumentsScreen';
import SettingsScreen from './SettingsScreen';
import { MlOpsScreen } from './AiScreens';
import { ApprovalsScreen, AuditScreen, OverviewScreen, UsersScreen } from './GovernanceScreens';
import { BillsScreen, CommitteesScreen, MpsScreen, SittingsScreen } from './RecordsScreens';
import { HeatmapScreen, MpDashboardScreen } from './InsightsScreens';
import { MeetingsScreen } from './MeetingsScreen';
import { AuthCallback, AuthProvider, RequireAuth, SignInPage, useAuth } from './SignIn';
import { Overview, opsApi } from './api';

const groups: { heading: string; items: readonly (readonly [string, string])[] }[] = [
  { heading: 'Workspace', items: [['Overview', 'overview'], ['Hansard documents', 'documents'], ['Approvals', 'approvals'], ['Users & roles', 'users']] },
  { heading: 'Parliament', items: [['Sittings', 'sittings'], ['Bills', 'bills'], ['Citizen cases', 'cases'], ['Committees', 'committees'], ['Members of Parliament', 'mps'], ['Meetings', 'meetings']] },
  { heading: 'Intelligence', items: [['MP dashboard', 'mp-dashboard'], ['National heatmap', 'heatmap'], ['Audit trail', 'audit'], ['AI governance', 'mlops'], ['Settings', 'settings']] },
];
const all = groups.flatMap((g) => g.items);

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <aside className={`sidebar ${open ? 'mobile-open' : ''}`} aria-label="Main navigation">
      <div className="brand"><img className="crest" src="/assets/images/Coat_of_arms_of_Ghana.svg" alt="Coat of arms of Ghana" /><div className="brand-text"><small>Republic of Ghana</small><strong>Admin Console</strong></div></div>
      {groups.map((g) => (
        <div className="navgroup" key={g.heading}>
          <p>{g.heading}</p>
          {g.items.map(([name, path]) => <NavLink key={path} to={'/' + path} onClick={onClose} className={({ isActive }) => `navitem ${isActive ? 'active' : ''}`}><span className="nav-icon" aria-hidden="true" />{name}</NavLink>)}
        </div>
      ))}
    </aside>
  );
}

/** Shown for an address that is not part of the console. */
function NotFound() {
  return (
    <div className="panel">
      <div className="panel-head"><h3>Page not found</h3></div>
      <p style={{ padding: '12px 22px 22px' }}>We could not find that page. <Link to="/overview" className="link">Back to overview</Link></p>
    </div>
  );
}

function Screen({ onOverview }: { onOverview: (o: Overview) => void }) {
  const route = useLocation().pathname.slice(1) || 'overview';
  const title = all.find(([, p]) => p === route)?.[1] ? all.find(([, p]) => p === route)![0] : 'Not found';
  const body = route === 'overview' ? <OverviewScreen onLoaded={onOverview} />
    : route === 'documents' ? <DocumentsScreen />
    : route === 'cases' ? <CasesScreen />
    : route === 'sittings' ? <SittingsScreen />
    : route === 'bills' ? <BillsScreen />
    : route === 'committees' ? <CommitteesScreen />
    : route === 'mps' ? <MpsScreen />
    : route === 'meetings' ? <MeetingsScreen />
    : route === 'mp-dashboard' ? <MpDashboardScreen />
    : route === 'heatmap' ? <HeatmapScreen />
    : route === 'approvals' ? <ApprovalsScreen />
    : route === 'users' ? <UsersScreen />
    : route === 'audit' ? <AuditScreen />
    : route === 'mlops' ? <MlOpsScreen />
    : route === 'settings' ? <SettingsScreen />
    : <NotFound />;
  return (
    <main className="main-content">
      <div className="pagehead"><div><h1>{title}</h1>{route === 'overview' && <p>Platform health and content at a glance. Figures are read from the live database.</p>}</div></div>
      {body}
      <footer>2026 Parliament of Ghana | Admin Console</footer>
    </main>
  );
}

function Shell() {
  const { user, signOut } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { setNavOpen(false); }, [pathname]);
  // Header figures come from the same live overview; shown as unknown until it loads.
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => { opsApi.overview().then(setOverview).catch(() => undefined); }, []);
  const published = overview ? String(overview.documents['PUBLISHED'] ?? 0) : '-';
  const waiting = overview ? String(overview.approvalsPending) : '-';
  return (
    <div className="app-shell">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className={`sidebar-scrim ${navOpen ? 'open' : ''}`} onClick={() => setNavOpen(false)} aria-hidden="true" />
      <div className="main-wrapper">
        <header className="app-header">
          <button type="button" className="menu-btn" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>Menu</button>
          <div className="sys-brand"><img src="/assets/images/Coat_of_arms_of_Ghana.svg" alt="Ghana coat of arms" /> <span>Ghana Parliament AI Engagement System</span></div>
          <div className="header-stats"><span>Corpus: <strong>{published} published</strong></span><span>Approvals waiting: <strong>{waiting}</strong></span></div>
          <div className="user-menu">
            {user && <span className="user-id" title={user.roles.join(', ')}>{user.email}</span>}
            <button type="button" className="btn ghost sm" onClick={() => void signOut()}>Sign out</button>
          </div>
        </header>
        <Screen onOverview={setOverview} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="*" element={<RequireAuth><Shell /></RequireAuth>} />
      </Routes>
    </AuthProvider>
  );
}
