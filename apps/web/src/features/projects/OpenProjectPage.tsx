import "./project-entry.css";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { OperationData, OperationError } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, OpResult, Status, timeAgo } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { paths } from "../../lib/paths.ts";

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
        navigate(paths.home());
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
    <div className="page narrow entry-page">
      <div className="page-header">
        <div>
          <h1>Open a project</h1>
          <p className="page-lede">
            {root === undefined ? "No project is open yet. Pick one you’ve used before, open a game folder, or start a new project. " : ""}
            Brainforge reads a folder on this machine; nothing is uploaded from the browser.
          </p>
        </div>
      </div>
      {networkMessage ? <NetworkProblem error={{ message: networkMessage }} /> : null}
      {error ? <ErrorBanner error={error} extra={needsInit ? <button type="button" onClick={() => void previewInit(path)} disabled={busy}>Preview initialization</button> : null} /> : null}

      <section className="section" aria-labelledby="recent-title">
        <div className="section-head"><h2 id="recent-title">Recent projects</h2></div>
        <OpResult m={recent} />
        {!recent.data && !recent.error ? <p className="secondary" role="status">Loading recent projects…</p> : null}
        {recent.data?.ok && recent.data.data.projects.length === 0 ? <p className="secondary">No projects have been opened on this machine yet.</p> : null}
        {recent.data?.ok && recent.data.data.projects.length > 0 ? (
          <ul className="rows entry-recent" aria-labelledby="recent-title">
            {recent.data.data.projects.map((item) => (
              <li key={item.root}>
                <button type="button" className="recent-row" onClick={() => { setPath(item.root); void openPath(item.root); }} disabled={busy} aria-label={`Open ${item.name ?? item.root}`}>
                  <span className="recent-main">
                    <strong>{item.name ?? "Unnamed project"}</strong>
                    <span className="mono faint">{item.root}</span>
                  </span>
                  {item.root === root ? <span className="stamp">Current</span> : null}
                  <span className="faint" title={formatTime(item.lastOpenedAt)}>Opened {timeAgo(item.lastOpenedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="section" aria-labelledby="open-title">
        <div className="section-head"><h2 id="open-title">Open a folder</h2></div>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="project-path">Game folder (absolute path)</label>
            <div className="row">
              <input id="project-path" type="text" spellCheck={false} placeholder="/Users/you/Code/my-game" value={path} onChange={(event) => setPath(event.target.value)} aria-describedby="project-path-hint" />
              <button type="submit" disabled={busy || path.trim() === ""}>{open.isPending ? "Opening…" : "Open"}</button>
              {open.isPending ? <Status tone="info">Validating folder…</Status> : null}
            </div>
            <div className="hint" id="project-path-hint">
              The folder that contains <code>brainforge/project.yaml</code>: the game root, not the inner <code>brainforge/</code> folder. No parent folders are searched.
            </div>
          </div>
        </form>
      </section>

      <section className="section" aria-labelledby="create-title">
        <div className="section-head"><h2 id="create-title">Start a new project</h2></div>
        <p className="secondary">Adds Brainforge’s own <code>brainforge/</code> folder to a game folder that doesn’t have one. You’ll see exactly which paths would be created before anything is written.</p>
        <form onSubmit={(event) => { event.preventDefault(); if (createPath.trim()) void previewInit(createPath); }}>
          <div className="field">
            <label htmlFor="create-path">Game folder to start in (absolute path)</label>
            <div className="row">
              <input id="create-path" type="text" spellCheck={false} placeholder="/Users/you/Code/new-game" value={createPath} onChange={(event) => setCreatePath(event.target.value)} />
              <button type="submit" disabled={busy || createPath.trim() === ""}>{init.isPending && !preview ? "Checking…" : "Preview…"}</button>
            </div>
          </div>
        </form>

        {preview ? (
          <div className="entry-preview" role="group" aria-labelledby="init-title">
            <h3 id="init-title">Start Brainforge in this folder?</h3>
            <p className="mono">{preview.root}</p>
            <div className="grid-2">
              <div>
                <h4>Will be created</h4>
                {preview.plannedPaths.length === 0 ? <p className="secondary">Nothing new.</p> : <ul>{preview.plannedPaths.map((item) => <li key={item} className="mono">{item}</li>)}</ul>}
              </div>
              <div>
                <h4>Already there (kept as is)</h4>
                {preview.existingPaths.length === 0 ? <p className="secondary">None.</p> : <ul>{preview.existingPaths.map((item) => <li key={item} className="mono">{item}</li>)}</ul>}
              </div>
            </div>
            <div className="field">
              <label htmlFor="init-name">Project name (optional)</label>
              <input id="init-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <p className="secondary">Only Brainforge’s own paths are created. An existing <code>project.yaml</code> is never replaced.</p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void confirmInit()} disabled={busy}>{init.isPending ? "Creating…" : "Create these paths and open"}</button>
              <button type="button" onClick={() => setPreview(undefined)}>Cancel</button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
