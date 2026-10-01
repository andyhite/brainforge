import { useState, type ChangeEvent, type FormEvent } from "react";

import type { OperationData } from "@brainforge/contracts";
import { fileUrl, useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Viewer } from "../../components/Viewer.tsx";
import { ErrorBanner, NetworkProblem, Status } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";

type Inspect = OperationData<"asset.inspect">;

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}



export function ReferencesStep({ assetId, inspect }: { assetId: string; inspect: Inspect }) {
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const importReference = useMutationOperation("reference.import");
  const list = useOperation("reference.list", { assetId });
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"asset" | "project">("asset");
  const [viewing, setViewing] = useState<{ referenceId: string; label: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const referencesDir = inspect.directories.find((dir) => dir.path.replaceAll("\\", "/").endsWith("/references") || dir.path === "references");
  const references = list.data?.ok ? list.data.data.references : [];
  const result = importReference.data;

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked);
    setReadError(null);
    if (picked && label === "") {
      const dot = picked.name.lastIndexOf(".");
      setLabel(dot > 0 ? picked.name.slice(0, dot) : picked.name);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || label.trim() === "") return;
    setReadError(null);
    let contentBase64: string;
    try {
      contentBase64 = await toBase64(file);
    } catch {
      setReadError("The selected file could not be read.");
      return;
    }
    const response = await importReference
      .mutateAsync({
        input: { contentBase64, filename: file.name, label: label.trim(), scope, ...(scope === "asset" ? { assetId } : {}) },
      })
      .catch(() => undefined);
    if (response?.ok) {
      setFile(null);
      setLabel("");
      setViewing({ referenceId: response.data.referenceId, label: response.data.label });
    }
  };

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="asset-ref-import">
        <h2 id="asset-ref-import">Import reference</h2>
        <form className="stack" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="asset-ref-file">Image file</label>
            <input id="asset-ref-file" type="file" accept="image/*" onChange={onPick} key={result?.ok ? result.data.referenceId : "pick"} />
          </div>
          <div className="field">
            <label htmlFor="asset-ref-label">Label</label>
            <input id="asset-ref-label" value={label} onChange={(e) => setLabel(e.target.value)} required />
          </div>
          <fieldset>
            <legend>Scope</legend>
            <div className="row">
              <label><input type="radio" name="asset-ref-scope" checked={scope === "asset"} onChange={() => setScope("asset")} /> Asset-scoped</label>
              <label><input type="radio" name="asset-ref-scope" checked={scope === "project"} onChange={() => setScope("project")} /> Project-shared</label>
            </div>
          </fieldset>
          {readError ? <p role="alert"><Status tone="bad">{readError}</Status></p> : null}
          {importReference.error ? <NetworkProblem error={importReference.error} /> : null}
          {result && !result.ok ? <ErrorBanner error={result.error} /> : null}
          {result?.ok ? (
            <p role="status">
              <Status tone="ok">Imported</Status>{" "}
              <span className="mono">{result.data.referenceId}</span> · sha256 <span className="mono">{result.data.sha256.slice(0, 12)}</span>
              {result.data.width !== undefined && result.data.height !== undefined ? ` · ${result.data.width}×${result.data.height}` : ""}
            </p>
          ) : null}
          <div className="row">
            <button type="submit" className="primary" disabled={importReference.isPending || !file || label.trim() === ""}>
              {importReference.isPending ? "Importing…" : "Import reference"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel" aria-labelledby="asset-ref-list">
        <h2 id="asset-ref-list">References</h2>
        {referencesDir ? <p>{referencesDir.fileCount} {referencesDir.fileCount === 1 ? "file" : "files"} on disk</p> : null}
        {list.error ? <NetworkProblem error={list.error} /> : null}
        {list.data && !list.data.ok ? <ErrorBanner error={list.data.error} /> : null}
        {list.data?.ok && references.length === 0 ? <p className="secondary">No references imported yet.</p> : null}
        {references.length > 0 ? (
          <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
            {references.map((ref) => (
              <li key={ref.referenceId} className="row">
                {projectId ? <img className="thumb" src={fileUrl(projectId, ref.referenceId)} alt={ref.label} /> : null}
                <span>
                  {ref.label}{" "}
                  <Status tone={ref.scope === "asset" ? "info" : "idle"}>{ref.scope === "asset" ? "Asset-scoped" : "Project-shared"}</Status>
                  <br />
                  <span className="secondary mono">
                    {ref.referenceId} · sha256 {ref.sha256.slice(0, 12)}
                    {ref.width !== undefined && ref.height !== undefined ? ` · ${ref.width}×${ref.height}` : ""}
                  </span>
                </span>
                <button type="button" onClick={() => setViewing(ref)} aria-label={`View ${ref.label}`}>View</button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {viewing && projectId ? (
        <section className="panel" aria-labelledby="asset-ref-viewer">
          <h2 id="asset-ref-viewer">Viewing {viewing.label}</h2>
          <Viewer src={fileUrl(projectId, viewing.referenceId)} alt={viewing.label} caption={viewing.referenceId} />
        </section>
      ) : null}
    </div>
  );
}
