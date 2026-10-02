import { useState, type ChangeEvent, type FormEvent } from "react";

import type { OperationData } from "@brainforge/contracts";
import { fileUrl, useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Viewer } from "../../components/Viewer.tsx";
import { Modal, OpResult, Status } from "../../components/ui.tsx";
import "../families/families.css";
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
    <section id="def-references" tabIndex={-1} className="def-section" aria-labelledby="asset-ref-list">
      <div className="def-side-head">
        <h2 id="asset-ref-list">References</h2>
        {referencesDir ? <span className="secondary">{referencesDir.fileCount} {referencesDir.fileCount === 1 ? "file" : "files"} on disk</span> : null}
      </div>
      <OpResult m={list} />
      {list.data?.ok && references.length === 0 ? <p className="secondary">No references yet. Import an image the model should look at.</p> : null}
      {references.length > 0 ? (
        <ul className="ref-list">
          {references.map((ref) => (
            <li key={ref.referenceId}>
              {projectId ? <span className="thumb-box ref-thumb"><img src={fileUrl(projectId, ref.referenceId, 128)} alt={ref.label} loading="lazy" /></span> : <span className="thumb-box ref-thumb" />}
              <span>
                <span className="ref-name" title={ref.label}>{ref.label}</span>
                <span className="ref-meta">
                  {ref.scope === "asset" ? "This asset" : "Whole project"}
                  {ref.width !== undefined && ref.height !== undefined ? ` · ${ref.width}×${ref.height}` : ""}
                </span>
              </span>
              <button type="button" className="ghost sm" onClick={() => setViewing(ref)} aria-label={`View ${ref.label}`}>View</button>
            </li>
          ))}
        </ul>
      ) : null}

      <details className="ref-import-box">
        <summary>Import a reference…</summary>
        <form className="ref-import" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="asset-ref-file">Image file</label>
            <input id="asset-ref-file" type="file" accept="image/*" onChange={onPick} key={result?.ok ? result.data.referenceId : "pick"} />
          </div>
          <div className="field">
            <label htmlFor="asset-ref-label">Label</label>
            <input id="asset-ref-label" value={label} onChange={(e) => setLabel(e.target.value)} required />
          </div>
          <fieldset>
            <legend>Who can use it</legend>
            <div className="row">
              <label><input type="radio" name="asset-ref-scope" checked={scope === "asset"} onChange={() => setScope("asset")} /> This asset</label>
              <label><input type="radio" name="asset-ref-scope" checked={scope === "project"} onChange={() => setScope("project")} /> Whole project</label>
            </div>
          </fieldset>
          {readError ? <p role="alert"><Status tone="bad">{readError}</Status></p> : null}
          <OpResult m={importReference} />
          {result?.ok ? (
            <p role="status">
              <Status tone="ok">Imported {result.data.label}</Status>
              {result.data.width !== undefined && result.data.height !== undefined ? <span className="secondary"> {result.data.width}×{result.data.height}</span> : null}
            </p>
          ) : null}
          <div className="row">
            <button type="submit" disabled={importReference.isPending || !file || label.trim() === ""}>
              {importReference.isPending ? "Importing…" : "Import reference"}
            </button>
          </div>
        </form>
      </details>

      <Modal open={viewing !== null && projectId !== undefined} onOpenChange={(open) => { if (!open) setViewing(null); }} title={viewing?.label ?? "Reference"} description="Check the image on light, dark and transparency backgrounds." wide>
        {viewing && projectId ? <Viewer src={fileUrl(projectId, viewing.referenceId)} alt={viewing.label} /> : null}
      </Modal>
    </section>
  );
}
