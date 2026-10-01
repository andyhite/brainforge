import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { AssetPage } from "./features/assets/AssetPage.tsx";
import { AssetsPage } from "./features/assets/AssetsPage.tsx";
import { NewAssetWizard } from "./features/families/NewAssetWizard.tsx";
import { JobsPage } from "./features/jobs/JobsPage.tsx";
import { OpenProjectPage } from "./features/projects/OpenProjectPage.tsx";
import { OverviewPage } from "./features/projects/OverviewPage.tsx";
import { CandidatePage } from "./features/review/CandidatePage.tsx";
import { LibraryPage } from "./features/library/LibraryPage.tsx";
import { ReviewPage } from "./features/review/ReviewPage.tsx";
import { ExportPage } from "./features/export/ExportPage.tsx";
import { HistoryPage } from "./features/history/HistoryPage.tsx";
import { AgentSetupPage } from "./features/settings/AgentSetupPage.tsx";
import { ConnectionPage } from "./features/settings/ConnectionPage.tsx";
import { DirectionPage } from "./features/settings/DirectionPage.tsx";
import { ProjectSettingsPage } from "./features/settings/ProjectSettingsPage.tsx";
import { SettingsLayout } from "./features/settings/SettingsLayout.tsx";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="projects/open" element={<OpenProjectPage />} />
        <Route path="assets" element={<AssetsPage />} />
        <Route path="assets/new" element={<NewAssetWizard />} />
        <Route path="assets/:assetId" element={<AssetPage />} />
        <Route path="assets/:assetId/candidates/:candidateId" element={<CandidatePage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="export" element={<ExportPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<ProjectSettingsPage />} />
          <Route path="connection" element={<ConnectionPage />} />
          <Route path="direction" element={<DirectionPage />} />
          <Route path="agent" element={<AgentSetupPage />} />
        </Route>
        <Route path="*" element={<p>Page not found.</p>} />
      </Route>
    </Routes>
  );
}
