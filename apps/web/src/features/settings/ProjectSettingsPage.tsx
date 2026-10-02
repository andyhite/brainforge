import "./settings.css";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { OperationData, OperationError } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, ProblemList, Status } from "../../components/ui.tsx";
import { BLOCKED_TEXT } from "../../components/SpecEditor.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { specRoute, useProject } from "../../lib/use-project.ts";

type SnapshotData = OperationData<"project.snapshot">;
type CloseData = OperationData<"project.close">;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function ProjectSettingsPage() {
  const project = useProject();
  const navigate = useNavigate();
  const { select } = useProjectRoot();
  const snapshot = useMutationOperation("project.snapshot");
  const close = useMutationOperation("project.close");
  const [destination, setDestination] = useState("");
  const [snapshotResult, setSnapshotResult] = useState<SnapshotData | undefined>(undefined);
  const [snapshotError, setSnapshotError] = useState<OperationError | undefined>(undefined);
  const [closeResult, setCloseResult] = useState<CloseData | undefined>(undefined);
  const [closeError, setCloseError] = useState<OperationError | undefined>(undefined);
  const [network, setNetwork] = useState<string | undefined>(undefined);

  if (!project.root) {
    return <Banner tone="info" title="No project selected" actions={<Link className="button primary" to="/projects/open">Open a project</Link>}>Choose the game directory to see its settings.</Banner>;
  }
  if (project.networkError) return <NetworkProblem error={project.networkError} />;
  if (project.envelope && !project.envelope.ok) return <ErrorBanner error={project.envelope.error} />;
  const data = project.data;
  if (!data) return <p role="status">Loading project…</p>;
  const summary = data.project;
  const closing = summary.state === "closing" || closeResult?.state === "closing";

  const takeSnapshot = async (event: FormEvent) => {
    event.preventDefault();
    setSnapshotError(undefined);
    setSnapshotResult(undefined);
    setNetwork(undefined);
    try {
      const result = await snapshot.mutateAsync({ input: { destination: destination.trim() } });
      if (result.ok) setSnapshotResult(result.data);
      else setSnapshotError(result.error);
    } catch (caught) {
      setNetwork(caught instanceof Error ? caught.message : "Request failed");
    }
  };

  const closeProject = async () => {
    setCloseError(undefined);
    setNetwork(undefined);
    try {
      const result = await close.mutateAsync({ input: {} });
      if (!result.ok) {
        setCloseError(result.error);
        return;
      }
      setCloseResult(result.data);
      if (result.data.state === "closed") {
        select(undefined);
        navigate("/");
      }
    } catch (caught) {
      setNetwork(caught instanceof Error ? caught.message : "Request failed");
    }
  };

  return (
    <div className="settings-stack">
      <section className="settings-section" aria-labelledby="dir-title">
        <h2 id="dir-title">{summary.name}</h2>
        <p className="mono settings-root" data-testid="game-directory">{summary.root}</p>
        <div className="row">
          {summary.state === "open" ? <Status tone="ok">Open</Status> : summary.state === "closing" ? <Status tone="warn">Closing</Status> : <Status tone="idle">Closed</Status>}
          {summary.writable ? <Status tone="ok">Writable</Status> : <Status tone="warn">Read-only</Status>}
          {summary.specValid ? <Status tone="ok">project.yaml is valid</Status> : <Status tone="bad">project.yaml needs fixing</Status>}
        </div>
        {summary.problems.length > 0 ? <ProblemList problems={summary.problems} blocked={BLOCKED_TEXT} onOpenFile={specRoute} /> : null}
        <details>
          <summary>Project details</summary>
          <dl className="kv">
            <dt>Project ID</dt><dd className="mono">{summary.projectId}</dd>
            <dt>Schema</dt><dd>{summary.specValid ? "brainforge.project.v2, valid" : "needs fixing, see problems"}</dd>
            <dt>Revision</dt><dd>{summary.revision}</dd>
          </dl>
        </details>
      </section>

      <section className="settings-section" aria-labelledby="snap-title">
        <h2 id="snap-title">Back up this project</h2>
        <p className="secondary">A consistent, portable copy of <code>brainforge/</code> including its hidden state and the configured exports. Copying an open project by hand isn’t a supported backup.</p>
        <form onSubmit={(event) => void takeSnapshot(event)}>
          <div className="field">
            <label htmlFor="snap-dest">Destination folder (absolute path, must not exist yet)</label>
            <input id="snap-dest" type="text" spellCheck={false} placeholder="/Users/you/Backups/my-game-snapshot" value={destination} onChange={(event) => setDestination(event.target.value)} />
          </div>
          <button type="submit" className="primary" disabled={snapshot.isPending || destination.trim() === ""}>{snapshot.isPending ? "Copying…" : "Create snapshot"}</button>
        </form>
        {snapshotError ? <ErrorBanner error={snapshotError} /> : null}
        {snapshotResult ? (
          <div role="status" className="settings-result">
            <Status tone="ok">Snapshot created</Status>
            <dl className="kv">
              <dt>Location</dt><dd className="mono">{snapshotResult.destination}</dd>
              <dt>Files</dt><dd>{snapshotResult.fileCount}</dd>
              <dt>Size</dt><dd>{formatBytes(snapshotResult.bytes)}</dd>
              <dt>Links preserved</dt><dd>{snapshotResult.links}</dd>
            </dl>
          </div>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="close-title">
        <h2 id="close-title">Close project</h2>
        <p className="secondary">Closing finishes saving, checkpoints the database and releases the project. Background work is never cancelled.</p>
        {closing ? <Banner tone="warn" title="Closing: background work continues, so it isn’t safe to move yet">{closeResult?.message ?? "The folder is still in use until tracked work finishes."}</Banner> : null}
        {closeResult?.state === "closed" ? <Banner tone="ok" title="Closed">{closeResult.message}</Banner> : null}
        {closeError ? <ErrorBanner error={closeError} /> : null}
        {network ? <NetworkProblem error={{ message: network }} /> : null}
        <button type="button" onClick={() => void closeProject()} disabled={close.isPending}>{closing ? "Check again" : "Close project"}</button>
      </section>
    </div>
  );
}
