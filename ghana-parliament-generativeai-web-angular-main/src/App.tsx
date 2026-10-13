import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import AboutPage from './pages/AboutPage';
import AskPage from './pages/AskPage';
import ComingSoon from './pages/ComingSoon';
import DocumentPage from './pages/DocumentPage';
import { BillPage, BillsPage, CommitteePage, CommitteesPage, SittingPage, SittingsPage } from './pages/BusinessPages';
import CasePage from './pages/CasePage';
import HansardsPage from './pages/HansardsPage';
import IssuesPage from './pages/IssuesPage';
import MyMpPage from './pages/MyMpPage';
import NewIssuePage from './pages/NewIssuePage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<AskPage />} />
        <Route path="hansards" element={<HansardsPage />} />
        <Route path="hansards/:id" element={<DocumentPage />} />
        <Route path="bills" element={<BillsPage />} />
        <Route path="bills/:id" element={<BillPage />} />
        <Route path="sittings" element={<SittingsPage />} />
        <Route path="sittings/:id" element={<SittingPage />} />
        <Route path="committees" element={<CommitteesPage />} />
        <Route path="committees/:id" element={<CommitteePage />} />
        <Route path="my-mp" element={<MyMpPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="issues/new" element={<NewIssuePage />} />
        <Route path="issues/:reference" element={<CasePage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="*" element={<ComingSoon title="Page not found" body="We could not find that page." />} />
      </Route>
    </Routes>
  );
}
