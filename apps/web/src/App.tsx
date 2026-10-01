import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { fetchSession, NetworkError, UNAUTHENTICATED_EVENT } from "./api/client.ts";
import { Layout } from "./components/Layout.tsx";
import { NetworkProblem } from "./components/ui.tsx";
import { AgentsPage } from "./features/settings/AgentsPage.tsx";
import { AssetPage } from "./features/assets/AssetPage.tsx";
import { AssetsPage } from "./features/assets/AssetsPage.tsx";
import { Pairing } from "./features/pairing/Pairing.tsx";
import { OpenProjectPage } from "./features/projects/OpenProjectPage.tsx";
import { OverviewPage } from "./features/projects/OverviewPage.tsx";
import { LibraryPage, ReviewPage } from "./features/review/Placeholders.tsx";
import { ConnectionPage } from "./features/settings/ConnectionPage.tsx";
import { DirectionPage } from "./features/settings/DirectionPage.tsx";
import { ProjectSettingsPage } from "./features/settings/ProjectSettingsPage.tsx";
import { SettingsLayout } from "./features/settings/SettingsLayout.tsx";

export function App() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: fetchSession, retry: false, refetchOnWindowFocus: true });

  useEffect(() => {
    const handler = () => void queryClient.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener(UNAUTHENTICATED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, handler);
  }, [queryClient]);

  if (session.isPending) return <p style={{ padding: 24 }} role="status">Connecting to Brainforge…</p>;
  if (session.error instanceof NetworkError) {
    return <div style={{ padding: 24, maxWidth: 640 }}><NetworkProblem error={session.error} /><button type="button" onClick={() => void session.refetch()}>Retry</button></div>;
  }
  if (!session.data?.authenticated) {
    return <Pairing onPaired={() => void session.refetch()} />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="projects/open" element={<OpenProjectPage />} />
        <Route path="assets" element={<AssetsPage />} />
        <Route path="assets/:assetId" element={<AssetPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<ProjectSettingsPage />} />
          <Route path="connection" element={<ConnectionPage />} />
          <Route path="direction" element={<DirectionPage />} />
          <Route path="agents" element={<AgentsPage />} />
        </Route>
        <Route path="*" element={<p>Page not found.</p>} />
      </Route>
    </Routes>
  );
}
