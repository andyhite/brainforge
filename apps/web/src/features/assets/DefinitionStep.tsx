import { useEffect, useState } from "react";
import { stringify } from "yaml";
import { AssetFamily, type OperationData } from "@brainforge/contracts";
import { ConflictDialog, SpecEditor, BLOCKED_TEXT } from "../../components/SpecEditor.tsx";
import { ProblemList, Status } from "../../components/ui.tsx";
import { useSpecFile } from "../../lib/spec-file.ts";
import { specRoute } from "../../lib/use-project.ts";

type Inspect = OperationData<"asset.inspect">;

function readIdentity(spec: unknown): { description: string | undefined; identity: Array<[string, string]> } {
  if (typeof spec !== "object" || spec === null) return { description: undefined, identity: [] };
  const description = "description" in spec && typeof spec.description === "string" ? spec.description : undefined;
  const identity: Array<[string, string]> = [];
  if ("identity" in spec && typeof spec.identity === "object" && spec.identity !== null) {
    for (const [key, value] of Object.entries(spec.identity)) {
      if (typeof value === "string") identity.push([key, value]);
    }
  }
  return { description, identity };
}

function CreateFields({ assetId, onChange }: { assetId: string; onChange: (text: string) => void }) {
  const [name, setName] = useState(assetId);
  const [family, setFamily] = useState<AssetFamily>("character");
  const [description, setDescription] = useState("");
  const update = (next: { name?: string; family?: AssetFamily; description?: string }) => {
    const merged = { name: next.name ?? name, family: next.family ?? family, description: next.description ?? description };
    if (next.name !== undefined) setName(next.name);
    if (next.family !== undefined) setFamily(next.family);
    if (next.description !== undefined) setDescription(next.description);
    onChange(stringify({ schema: "brainforge.asset.v2", id: assetId, name: merged.name, family: merged.family, description: merged.description }));
  };
  return (
    <div className="grid-2">
      <div className="field">
        <label htmlFor="def-new-name">Name</label>
        <input id="def-new-name" value={name} onChange={(e) => update({ name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="def-new-family">Family</label>
        <select id="def-new-family" value={family} onChange={(e) => update({ family: AssetFamily.parse(e.target.value) })}>
          {AssetFamily.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <label htmlFor="def-new-description">Description (required)</label>
        <input id="def-new-description" value={description} onChange={(e) => update({ description: e.target.value })} aria-invalid={description.trim() === ""} />
        {description.trim() === "" ? <span className="secondary">✖ A description is required before the definition is valid.</span> : null}
      </div>
    </div>
  );
}

export function DefinitionStep({ inspect, autoCreate }: { inspect: Inspect; autoCreate: boolean }) {
  const { summary } = inspect;
  const { description, identity } = readIdentity(inspect.spec);
  const missing = inspect.yamlHash === undefined;
  const file = useSpecFile(inspect.yamlPath);
  const [creating, setCreating] = useState(false);
  const template = stringify({ schema: "brainforge.asset.v2", id: summary.assetId, name: summary.assetId, family: "character", description: "" });
  const startCreate = () => {
    setCreating(true);
    file.setDraft(template);
  };
  const ready = !file.loading && file.loadError === undefined;
  useEffect(() => {
    if (autoCreate && missing && ready && !creating) startCreate();
    // startCreate is stable enough for a one-shot trigger when the file has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCreate, missing, ready]);
  const showEditor = !missing || creating;
  return (
    <div className="stack">
      <section className="panel" aria-labelledby="asset-def-result">
        <h2 id="asset-def-result">Definition</h2>
        {summary.valid ? (
          <Status tone="ok">Valid</Status>
        ) : missing ? (
          <>
            <Status tone="warn">Definition missing</Status>
            <p style={{ margin: "12px 0" }}>
              <code>{inspect.yamlPath}</code> has not been written yet. Work and references in this folder are kept; production steps stay blocked until a valid definition exists.
            </p>
            {creating ? null : <button type="button" className="primary" onClick={startCreate} disabled={!ready}>Write asset.yaml</button>}
          </>
        ) : (
          <>
            <Status tone="bad">Invalid — {summary.problems.length} {summary.problems.length === 1 ? "problem" : "problems"}</Status>
            <ProblemList problems={summary.problems} blocked={BLOCKED_TEXT} onOpenFile={specRoute} />
          </>
        )}
      </section>

      {description !== undefined || identity.length > 0 ? (
        <section className="panel" aria-labelledby="asset-def-identity">
          <h2 id="asset-def-identity">Identity</h2>
          <dl className="kv">
            {description !== undefined ? <><dt>Description</dt><dd>{description}</dd></> : null}
            {identity.map(([key, value]) => <div key={key} style={{ display: "contents" }}><dt>{key}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="asset-def-dirs">
        <h2 id="asset-def-dirs">Asset folders</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th scope="col">Path</th><th scope="col">Exists</th><th scope="col">Files</th></tr>
            </thead>
            <tbody>
              {inspect.directories.map((dir) => (
                <tr key={dir.path}>
                  <th scope="row" className="mono">{dir.path}</th>
                  <td>{dir.exists ? <Status tone="ok">Exists</Status> : <Status tone="idle">Not created</Status>}</td>
                  <td>{dir.fileCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginBottom: 0 }}>Registered retained artifacts: {inspect.registeredArtifacts}</p>
        {inspect.registeredArtifacts > 0 ? <p className="secondary">M0 art-proof media registered in place; not production approvals.</p> : null}
      </section>

      {showEditor ? (
        <details open className="panel">
          <summary>{missing ? "Create asset.yaml" : "Asset YAML"}</summary>
          {missing && creating ? <CreateFields assetId={summary.assetId} onChange={file.setDraft} /> : null}
          <SpecEditor file={file} onOpenFile={specRoute} />
          <ConflictDialog file={file} />
        </details>
      ) : null}
    </div>
  );
}
