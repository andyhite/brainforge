import { Link, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { EmptyState } from "./components/ui.tsx";
import { ActivityPage } from "./features/activity/ActivityPage.tsx";
import { AssetDefinition } from "./features/assets/AssetDefinition.tsx";
import { AssetLayout } from "./features/assets/AssetLayout.tsx";
import { AssetSheet } from "./features/assets/AssetSheet.tsx";
import { NewAssetWizard } from "./features/families/NewAssetWizard.tsx";
import { HomePage } from "./features/home/HomePage.tsx";
import { AssetVersions } from "./features/production/AssetVersions.tsx";
import { OpenProjectPage } from "./features/projects/OpenProjectPage.tsx";
import { ReleasesPage } from "./features/releases/ReleasesPage.tsx";
import { ReviewPage } from "./features/review/ReviewPage.tsx";
import { StepRoomPage } from "./features/review/StepRoom.tsx";
import { AgentSetupPage } from "./features/settings/AgentSetupPage.tsx";
import { ConnectionPage } from "./features/settings/ConnectionPage.tsx";
import { DirectionPage } from "./features/settings/DirectionPage.tsx";
import { ProjectSettingsPage } from "./features/settings/ProjectSettingsPage.tsx";
import { SettingsLayout } from "./features/settings/SettingsLayout.tsx";
import { paths } from "./lib/paths.ts";

function NotFound() {
  return (
    <div className="page narrow">
      <EmptyState title="This page doesn’t exist">
        <p>The link may be incomplete, or it points somewhere that has moved.</p>
        <Link className="button primary" to={paths.home()}>Go to Home</Link>
      </EmptyState>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="projects/open" element={<OpenProjectPage />} />
        <Route path="assets/new" element={<NewAssetWizard />} />
        <Route path="assets/:assetId" element={<AssetLayout />}>
          <Route index element={<AssetSheet />} />
          <Route path="definition" element={<AssetDefinition />} />
          <Route path="versions" element={<AssetVersions />} />
        </Route>
        <Route path="assets/:assetId/steps/:stepId" element={<StepRoomPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="releases" element={<ReleasesPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<ProjectSettingsPage />} />
          <Route path="connection" element={<ConnectionPage />} />
          <Route path="direction" element={<DirectionPage />} />
          <Route path="agent" element={<AgentSetupPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
