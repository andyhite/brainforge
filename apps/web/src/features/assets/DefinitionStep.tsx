import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { OperationData } from "@brainforge/contracts";
import { BLOCKED_TEXT } from "../../components/SpecEditor.tsx";
import { ProblemList, Status } from "../../components/ui.tsx";
import { FamilyEditor } from "../families/FamilyEditor.tsx";
import { splitProblems } from "../families/useFamilies.tsx";
import { useSpecFile } from "../../lib/spec-file.ts";
import { specRoute } from "../../lib/use-project.ts";

type Inspect = OperationData<"asset.inspect">;

export function DefinitionStep({ inspect, autoCreate }: { inspect: Inspect; autoCreate: boolean }) {
  const { summary } = inspect;
  const missing = inspect.yamlHash === undefined;
  const navigate = useNavigate();
  const file = useSpecFile(inspect.yamlPath);
  const wizard = `/assets/new?id=${encodeURIComponent(summary.assetId)}`;
  useEffect(() => {
    if (autoCreate && missing) navigate(wizard, { replace: true });
  }, [autoCreate, missing, navigate, wizard]);
  const { errors, warnings } = splitProblems(summary.problems);
  return (
    <div className="stack">
      <section className="panel" aria-labelledby="asset-def-result">
        <h2 id="asset-def-result">Definition</h2>
        {summary.valid ? (
          <div className="row">
            <Status tone="ok">Valid</Status>
            {warnings.length > 0 ? <Status tone="warn">{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</Status> : null}
          </div>
        ) : missing ? (
          <>
            <Status tone="warn">Definition missing</Status>
            <p style={{ margin: "12px 0" }}>
              <code>{inspect.yamlPath}</code> has not been written yet. Work and references in this folder are kept; production steps stay blocked until a valid definition exists.
            </p>
            <Link className="button primary" to={wizard}>Start from a family template</Link>
          </>
        ) : (
          <Status tone="bad">Invalid — {errors.length} {errors.length === 1 ? "problem" : "problems"}</Status>
        )}
        {!missing && summary.problems.length > 0 ? <ProblemList problems={summary.problems} blocked={errors.length > 0 ? BLOCKED_TEXT : "Warnings never block exploring the concept; they name what a production step still needs."} onOpenFile={specRoute} /> : null}
      </section>

      {!missing ? (
        <section aria-labelledby="asset-def-editor">
          <h2 id="asset-def-editor" className="sr-only">Edit asset definition</h2>
          <FamilyEditor file={file} assetId={summary.assetId} />
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
        {inspect.registeredArtifacts > 0 ? <p className="secondary">Feasibility-trial media registered in place; these are not production approvals.</p> : null}
      </section>
    </div>
  );
}
