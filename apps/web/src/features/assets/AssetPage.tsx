import { Link, useParams, useSearchParams } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { DefinitionStep } from "./DefinitionStep.tsx";
import { ReferencesStep } from "./ReferencesStep.tsx";
import { ConceptStep } from "../generation/ConceptStep.tsx";

export function AssetPage() {
  const { assetId = "" } = useParams();
  const [params] = useSearchParams();
  const stepParam = params.get("step");
  const step = stepParam === "references" || stepParam === "concept" ? stepParam : "definition";
  const { root } = useProjectRoot();
  const query = useOperation("asset.inspect", { assetId }, { enabled: root !== undefined && assetId !== "" });
  const conceptState = useOperation("step.inspect", { assetId, stepId: "concept" }, { enabled: root !== undefined && assetId !== "" });

  if (root === undefined) {
    return <><PageHeader title="Asset" /><p>No project selected. <Link to="/projects/open">Open a project</Link>.</p></>;
  }
  if (query.error) return <><PageHeader title="Asset" /><NetworkProblem error={query.error} /></>;
  if (!query.data) return <><PageHeader title="Asset" /><p className="secondary" role="status">Loading asset…</p></>;
  if (!query.data.ok) {
    return (
      <>
        <PageHeader title="Asset" />
        <ErrorBanner error={query.data.error} extra={<Link to="/assets">Back to assets</Link>} />
      </>
    );
  }

  const inspect = query.data.data;
  const { summary } = inspect;
  const referencesDir = inspect.directories.find((dir) => dir.path.replaceAll("\\", "/").endsWith("/references") || dir.path === "references");
  const referenceCount = referencesDir?.fileCount ?? 0;
  const base = `/assets/${encodeURIComponent(assetId)}`;
  const missing = inspect.yamlHash === undefined;

  return (
    <>
      <PageHeader title={summary.name ?? summary.assetId}>
        {summary.family ? <Status tone="info">{summary.family}</Status> : null}
        <span className="mono">{summary.assetId}</span>
        {summary.required ? <Status tone="info">Required</Status> : <Status tone="idle">Optional</Status>}
        {summary.valid ? <Status tone="ok">Valid</Status> : missing ? <Status tone="warn">Definition missing</Status> : <Status tone="bad">Invalid — {summary.problems.length} {summary.problems.length === 1 ? "problem" : "problems"}</Status>}
      </PageHeader>
      <p><Link to="/assets">← All assets</Link></p>
      <nav aria-label="Asset steps">
        <ol className="steps">
          <li>
            <Link to={`${base}?step=definition`} aria-current={step === "definition" ? "step" : undefined}>Definition</Link>{" "}
            {summary.valid ? <Status tone="ok">Valid</Status> : missing ? <Status tone="warn">Missing</Status> : <Status tone="bad">Invalid</Status>}
          </li>
          <li>
            <Link to={`${base}?step=references`} aria-current={step === "references" ? "step" : undefined}>References</Link>{" "}
            {referenceCount > 0 ? <Status tone="ok">{referenceCount} imported</Status> : <Status tone="idle">None yet</Status>}
          </li>
          <li>
            <Link to={`${base}?step=concept`} aria-current={step === "concept" ? "step" : undefined}>Concept</Link>{" "}
            {conceptState.data?.ok ? <Status tone={conceptState.data.data.step.state === "complete" ? "ok" : conceptState.data.data.step.state === "failed" ? "bad" : conceptState.data.data.step.state === "blocked" ? "warn" : "info"}>{conceptState.data.data.step.state.replaceAll("_", " ")}</Status> : <Status tone="idle">…</Status>}
          </li>
        </ol>
      </nav>
      {step === "concept" ? <ConceptStep assetId={assetId} /> : step === "references" ? <ReferencesStep assetId={assetId} inspect={inspect} /> : <DefinitionStep inspect={inspect} autoCreate={params.get("create") === "1"} />}
    </>
  );
}
