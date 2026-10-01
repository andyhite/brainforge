import "./project-entry.css";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { OperationData, OperationError } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";

type InitPreview = OperationData<"project.init">;

export function OpenProjectPage() {
  const navigate = useNavigate();
  const { root, select } = useProjectRoot();
  const recent = useOperation("project.recent", {}, { project: null });
  const open = useMutationOperation("project.open");
  const init = useMutationOperation("project.init");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<OperationError | undefined>(undefined);
  const [networkMessage, setNetworkMessage] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<InitPreview | undefined>(undefined);
  const [createPath, setCreatePath] = useState("");
  const [initTarget, setInitTarget] = useState("");

  const openPath = async (target: string) => {
    setError(undefined);
    setNetworkMessage(undefined);
    setPreview(undefined);
    try {
      const result = await open.mutateAsync({ input: { path: target }, project: null });
      if (result.ok) {
        select(result.data.project.root);
        navigate("/");
        return;
      }
      setError(result.error);
    } catch (caught) {
      setNetworkMessage(caught instanceof Error ? caught.message : "Request failed");
    }
  };

  const previewInit = async (target: string) => {
    setNetworkMessage(undefined);
    try {
      const result = await init.mutateAsync({ input: { path: target.trim(), ...(name.trim() ? { name: name.trim() } : {}), confirm: false }, project: null });
      if (result.ok) {
        setInitTarget(target.trim());
        setPreview(result.data);
        setError(undefined);
      } else setError(result.error);
    } catch (caught) {
      setNetworkMessage(caught instanceof Error ? caught.message : "Request failed");
    }
  };

  const confirmInit = async () => {
    if (!preview) return;
    setNetworkMessage(undefined);
    try {
      const result = await init.mutateAsync({ input: { path: initTarget, ...(name.trim() ? { name: name.trim() } : {}), confirm: true }, project: null });
      if (result.ok) {
        setPreview(undefined);
        await openPath(result.data.root);
      } else setError(result.error);
    } catch (caught) {
      setNetworkMessage(caught instanceof Error ? caught.message : "Request failed");
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (path.trim()) void openPath(path.trim());
  };

  const needsInit = error !== undefined && (error.code === "NOT_FOUND" || error.recoveryActions.some((action) => action.operation === "project.init"));
  const busy = open.isPending || init.isPending;

  return (
    <div className="entry-page">
      <PageHeader title="Project" />
      <p className="secondary entry-note" role="note">
        {root === undefined ? "No project is open. Open an existing game directory or create Brainforge's folder inside one. " : ""}
        Brainforge asks the server to read a folder on this machine; nothing is uploaded from the browser.
      </p>
      {networkMessage ? <NetworkProblem error={{ message: networkMessage }} /> : null}
      {error ? <ErrorBanner error={error} extra={needsInit ? <button type="button" onClick={() => void previewInit(path)} disabled={busy}>Preview initialization</button> : null} /> : null}

      <div className="entry-columns">
        <section aria-labelledby="open-title" className="entry-pane">
          <h2 id="open-title">Open an existing project</h2>
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="project-path">Game directory (absolute path)</label>
              <input id="project-path" type="text" spellCheck={false} placeholder="/Users/you/Code/my-game" value={path} onChange={(event) => setPath(event.target.value)} aria-describedby="project-path-hint" />
              <div className="hint" id="project-path-hint">
                The folder that contains <code>brainforge/project.yaml</code> — the game root, not the inner <code>brainforge/</code> folder. The server validates it; no parent folders are searched.
              </div>
            </div>
            <div className="row">
              <button type="submit" className="primary" disabled={busy || path.trim() === ""}>{open.isPending ? "Opening…" : "Open project"}</button>
              {open.isPending ? <Status tone="info">Validating directory…</Status> : null}
            </div>
          </form>

          <h3 id="recent-title">Recent on this machine</h3>
          {recent.error ? <NetworkProblem error={recent.error} /> : null}
          {recent.data && !recent.data.ok ? <ErrorBanner error={recent.data.error} /> : null}
          {!recent.data && !recent.error ? <p className="secondary" role="status">Loading recent projects…</p> : null}
          {recent.data?.ok && recent.data.data.projects.length === 0 ? <p className="secondary">No projects have been opened on this machine yet.</p> : null}
          {recent.data?.ok && recent.data.data.projects.length > 0 ? (
            <ul className="entry-recent" aria-labelledby="recent-title">
              {recent.data.data.projects.map((item) => (
                <li key={item.root}>
                  <span className="entry-recent-main">
                    <strong>{item.name ?? "Unnamed project"}</strong>
                    <span className="mono secondary">{item.root}</span>
                    <span className="secondary">Last opened {formatTime(item.lastOpenedAt)}</span>
                  </span>
                  <button type="button" onClick={() => { setPath(item.root); void openPath(item.root); }} disabled={busy} aria-label={`Open ${item.name ?? item.root}`}>Open</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section aria-labelledby="create-title" className="entry-pane">
          <h2 id="create-title">Create a new project</h2>
          <p className="secondary">Adds Brainforge's own <code>brainforge/</code> folder to a game directory that does not have one. You will see exactly which paths would be created before anything is written.</p>
          <form onSubmit={(event) => { event.preventDefault(); if (createPath.trim()) void previewInit(createPath); }}>
            <div className="field">
              <label htmlFor="create-path">Game directory to initialize (absolute path)</label>
              <input id="create-path" type="text" spellCheck={false} placeholder="/Users/you/Code/new-game" value={createPath} onChange={(event) => setCreatePath(event.target.value)} />
            </div>
            <button type="submit" disabled={busy || createPath.trim() === ""}>{init.isPending && !preview ? "Checking…" : "Preview new project"}</button>
          </form>

          {preview ? (
            <div className="entry-preview" role="group" aria-labelledby="init-title">
              <h3 id="init-title">Initialize Brainforge in this directory?</h3>
              <p className="mono">{preview.root}</p>
              <div className="grid-2">
                <div>
                  <h4>Will be created</h4>
                  {preview.plannedPaths.length === 0 ? <p className="secondary">Nothing new.</p> : <ul>{preview.plannedPaths.map((item) => <li key={item} className="mono">{item}</li>)}</ul>}
                </div>
                <div>
                  <h4>Already present (kept as is)</h4>
                  {preview.existingPaths.length === 0 ? <p className="secondary">None.</p> : <ul>{preview.existingPaths.map((item) => <li key={item} className="mono">{item}</li>)}</ul>}
                </div>
              </div>
              <div className="field">
                <label htmlFor="init-name">Project name (optional)</label>
                <input id="init-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <p className="secondary">Only Brainforge-owned paths are created. An existing <code>project.yaml</code> is never replaced.</p>
              <div className="row">
                <button type="button" className="primary" onClick={() => void confirmInit()} disabled={busy}>{init.isPending ? "Creating…" : "Create these paths and open"}</button>
                <button type="button" onClick={() => setPreview(undefined)}>Cancel</button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
