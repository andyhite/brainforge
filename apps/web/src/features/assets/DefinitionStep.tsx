import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { OperationData, Problem } from "@brainforge/contracts";
import { Status } from "../../components/ui.tsx";
import { FamilyEditor, ProblemSummary } from "../families/FamilyEditor.tsx";
import { useSpecFile, type SpecFile } from "../../lib/spec-file.ts";
import { ReferencesStep } from "./ReferencesStep.tsx";
import "../families/families.css";

type Inspect = OperationData<"asset.inspect">;

/** Everything beside the editor: checks, references, and where the files live. */
function Side({ inspect, file, problems, pending }: { inspect: Inspect; file: SpecFile; problems: Problem[]; pending: boolean }) {
  const missing = inspect.yamlHash === undefined;
  return (
    <>
      {missing ? null : (
        <section id="def-problems" tabIndex={-1} className="def-section" aria-labelledby="def-problems-title">
          <h2 id="def-problems-title">Checks</h2>
          <ProblemSummary problems={problems} pending={pending} file={file} />
        </section>
      )}
      <ReferencesStep assetId={inspect.summary.assetId} inspect={inspect} />
      <details id="def-file" className="def-section">
        <summary>Files and folders</summary>
        <dl className="kv def-files">
          <dt>Definition</dt>
          <dd><code>{inspect.yamlPath}</code></dd>
          {inspect.directories.map((dir) => (
            <div key={dir.path} className="def-dir">
              <dt className="mono">{dir.path}</dt>
              <dd>{dir.exists ? `${dir.fileCount} ${dir.fileCount === 1 ? "file" : "files"}` : "Not created"}</dd>
            </div>
          ))}
          {inspect.registeredArtifacts > 0 ? (
            <>
              <dt>Registered media</dt>
              <dd>{inspect.registeredArtifacts} (trial media kept in place; not production approvals)</dd>
            </>
          ) : null}
        </dl>
      </details>
    </>
  );
}

/** What this asset is: the definition editor, or the create flow when no definition exists yet. */
export function DefinitionStep({ inspect, autoCreate }: { inspect: Inspect; autoCreate: boolean }) {
  const { summary } = inspect;
  const missing = inspect.yamlHash === undefined;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const section = params.get("section");
  const file = useSpecFile(inspect.yamlPath);
  const wizard = `/assets/new?id=${encodeURIComponent(summary.assetId)}`;

  useEffect(() => {
    if (autoCreate && missing) navigate(wizard, { replace: true });
  }, [autoCreate, missing, navigate, wizard]);

  // ?section= deep link: wait for the file so the editor sections exist, then scroll and focus.
  useEffect(() => {
    if (!section || (!missing && file.loading)) return;
    const target = document.getElementById(`def-${section}`);
    if (!target) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [section, missing, file.loading]);

  if (missing) {
    return (
      <div className="def-grid">
        <div className="def-main def-missing">
          <Status tone="warn">No definition yet</Status>
          <h2>Start from a family template</h2>
          <p className="secondary">
            This asset has no definition file, so production steps stay blocked. Anything already in its folder is kept. A template gives you the deliverables and rules for its family; you edit them before saving.
          </p>
          <Link className="button primary" to={wizard}>Create definition</Link>
        </div>
        <div className="def-side"><Side inspect={inspect} file={file} problems={[]} pending={false} /></div>
      </div>
    );
  }
  return <FamilyEditor file={file} assetId={summary.assetId} aside={({ problems, pending }) => <Side inspect={inspect} file={file} problems={problems} pending={pending} />} />;
}
