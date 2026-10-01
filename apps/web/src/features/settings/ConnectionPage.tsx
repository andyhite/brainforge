import "./settings.css";
import { useState, type FormEvent } from "react";
import type { OperationData, OperationError } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, NetworkProblem, Status } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";

type ConnectionData = OperationData<"connection.set">;

export function ConnectionPage() {
  const project = useProject();
  const setConnection = useMutationOperation("connection.set");
  const inspect = useOperation("project.inspect", {}, { enabled: project.root !== undefined });
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ConnectionData | undefined>(undefined);
  const [error, setError] = useState<OperationError | undefined>(undefined);
  const [network, setNetwork] = useState<string | undefined>(undefined);

  const apply = async (comfyUrl: string | null) => {
    setError(undefined);
    setNetwork(undefined);
    try {
      const response = await setConnection.mutateAsync({ input: { comfyUrl }, project: null });
      if (response.ok) setResult(response.data);
      else setError(response.error);
    } catch (caught) {
      setNetwork(caught instanceof Error ? caught.message : "Request failed");
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim()) void apply(url.trim());
  };

  const current = inspect.data?.ok ? inspect.data.data.comfy : undefined;
  const shown = result ?? current;

  return (
    <section className="settings-section" aria-labelledby="conn-title">
      <h2 id="conn-title">ComfyUI connection</h2>
      <p className="secondary">
        The URL is a machine-level setting kept outside the project, so it never travels with project files. A reachable address does not mean the computation happens on this Mac or is free; the workflow recipes state where they run.
      </p>
      <p>
        Current:{" "}
        {shown ? (
          shown.configured ? <Status tone="ok">Configured{shown.host ? ` — ${shown.host}` : ""}</Status> : <Status tone="idle">Not configured</Status>
        ) : <Status tone="idle">Unknown until a project is open or a URL is saved</Status>}
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="comfy-url">ComfyUI URL</label>
          <input id="comfy-url" type="url" spellCheck={false} placeholder="http://127.0.0.1:8188" value={url} onChange={(event) => setUrl(event.target.value)} aria-describedby="comfy-hint" />
          <div className="hint" id="comfy-hint">Saving checks the server and reports what ComfyUI answered. Nothing is submitted for generation.</div>
        </div>
        <div className="row">
          <button type="submit" className="primary" disabled={setConnection.isPending || url.trim() === ""}>{setConnection.isPending ? "Checking…" : "Save and test"}</button>
          <button type="button" onClick={() => void apply(null)} disabled={setConnection.isPending}>Clear connection</button>
        </div>
      </form>
      {network ? <NetworkProblem error={{ message: network }} /> : null}
      {error ? <ErrorBanner error={error} /> : null}
      {result ? (
        <div role="status" className="settings-result">
          {!result.configured ? <Status tone="idle">Connection cleared</Status> : result.reachable ? <Status tone="ok">Reachable</Status> : <Status tone="bad">Not reachable</Status>}
          <dl className="kv">
            <dt>Host</dt><dd>{result.host ?? "—"}</dd>
            <dt>ComfyUI version</dt><dd>{result.comfyuiVersion ?? "not reported"}</dd>
            <dt>Device</dt><dd>{result.device ?? "not reported"}</dd>
          </dl>
        </div>
      ) : null}
    </section>
  );
}
