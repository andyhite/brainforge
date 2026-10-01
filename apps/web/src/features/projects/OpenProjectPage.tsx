import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { OperationData, OperationError } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, formatTime, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";

type InitPreview = OperationData<"project.init">;

export function OpenProjectPage() {
  const navigate = useNavigate();
  const { select } = useProjectRoot();
  const recent = useOperation("project.recent", {}, { project: null });
  const open = useMutationOperation("project.open");
  const init = useMutationOperation("project.init");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<OperationError | undefined>(undefined);
  const [networkMessage, setNetworkMessage] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<InitPreview | undefined>(undefined);

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

  const previewInit = async () => {
    setNetworkMessage(undefined);
    try {
      const result = await init.mutateAsync({ input: { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}), confirm: false }, project: null });
      if (result.ok) {
        setPreview(result.data);
        setError(undefined);
      } else setError(result.error);
    } catch (caught) {
      setNetworkMessage(caught instanceof Error ? caught.message : "Request failed");
    }
  };

  const confirmInit = async () => {
    setNetworkMessage(undefined);
    try {
      const result = await init.mutateAsync({ input: { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}), confirm: true }, project: null });
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
    <div>
      <PageHeader title="Open a project" />
      <form className="panel" onSubmit={submit}>
        <div className="field">
          <label htmlFor="project-path">Game directory (absolute path)</label>
          <input id="project-path" type="text" spellCheck={false} placeholder="/Users/you/Code/my-game" value={path} onChange={(event) => setPath(event.target.value)} aria-describedby="project-path-hint" />
          <div className="hint" id="project-path-hint">
            Type the folder that contains <code>brainforge/project.yaml</code> — the game root, not the inner <code>brainforge/</code> folder. The server validates it; no parent folders are searched.
          </div>
        </div>
        <button type="submit" className="primary" disabled={busy || path.trim() === ""}>{open.isPending ? "Opening…" : "Open project"}</button>
      </form>

      {networkMessage ? <div style={{ marginTop: 16 }}><NetworkProblem error={{ message: networkMessage }} /></div> : null}
      {error ? (
        <div style={{ marginTop: 16 }}>
          <ErrorBanner error={error} extra={needsInit ? <button type="button" onClick={() => void previewInit()} disabled={busy}>Preview initialization</button> : null} />
        </div>
      ) : null}

      {preview ? (
        <section className="panel" aria-labelledby="init-title" style={{ marginTop: 16 }}>
          <h2 id="init-title">Initialize Brainforge in this directory?</h2>
          <p className="mono">{preview.root}</p>
          <div className="grid-2">
            <div>
              <h3>Will be created</h3>
              {preview.plannedPaths.length === 0 ? <p className="secondary">Nothing new.</p> : <ul>{preview.plannedPaths.map((item) => <li key={item} className="mono">{item}</li>)}</ul>}
            </div>
            <div>
              <h3>Already present (kept as is)</h3>
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
        </section>
      ) : null}

      <section className="panel" aria-labelledby="recent-title" style={{ marginTop: 16 }}>
        <h2 id="recent-title">Recent projects</h2>
        {recent.error ? <NetworkProblem error={recent.error} /> : null}
        {recent.data && !recent.data.ok ? <ErrorBanner error={recent.data.error} /> : null}
        {recent.data?.ok && recent.data.data.projects.length === 0 ? <p className="secondary">No projects opened on this machine yet.</p> : null}
        {recent.data?.ok && recent.data.data.projects.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {recent.data.data.projects.map((item) => (
              <li key={item.root} className="row" style={{ justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--border)" }}>
                <span>
                  <strong>{item.name ?? "Unnamed project"}</strong><br />
                  <span className="mono secondary">{item.root}</span><br />
                  <span className="secondary">Last opened {formatTime(item.lastOpenedAt)}</span>
                </span>
                <button type="button" onClick={() => { setPath(item.root); void openPath(item.root); }} disabled={busy} aria-label={`Open ${item.name ?? item.root}`}>Open</button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {open.isPending ? <Status tone="info">Validating directory…</Status> : null}
      <Banner tone="info" title="Backend directory selection">This page asks the server to open a folder on this machine. It is not a browser upload.</Banner>
    </div>
  );
}
