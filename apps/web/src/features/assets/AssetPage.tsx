import { Link, useParams, useSearchParams } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { DefinitionStep } from "./DefinitionStep.tsx";
import { ReferencesStep } from "./ReferencesStep.tsx";
import { ConceptStep } from "../generation/ConceptStep.tsx";
import { BranchBar } from "../branches/BranchBar.tsx";
import { PipelineView } from "../pipeline/PipelineView.tsx";
import { StepDetail } from "../pipeline/StepDetail.tsx";
import { ProductionState } from "../production/ProductionState.tsx";
import { VersionsSection } from "../production/VersionsSection.tsx";
import { CollectionView } from "../families/CollectionView.tsx";
import { FamilyChip, splitProblems, useFamilies } from "../families/useFamilies.tsx";
export function AssetPage() {
  const { assetId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const step = params.get("step") ?? "definition";
  const { root } = useProjectRoot();
  const enabled = root !== undefined && assetId !== "";
  const query = useOperation("asset.inspect", { assetId }, { enabled });
  const branches = useOperation("branch.list", { assetId }, { enabled });
  const branchList = branches.data?.ok ? branches.data.data.branches : [];
  const requestedBranch = params.get("branch");
  const branchId = branchList.find((branch) => branch.branchId === requestedBranch)?.branchId ?? branchList.find((branch) => branch.isCurrent)?.branchId ?? branchList[0]?.branchId;
  const steps = useOperation("step.list", { assetId, ...(branchId ? { branchId } : {}) }, { enabled });
  const families = useFamilies();
  const activeStep = steps.data?.ok ? steps.data.data.steps.find((candidate) => candidate.stepId === step) : undefined;

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
        {summary.family ? <FamilyChip family={summary.family} profile={families.profileOf(summary.family)} /> : null}
        <span className="mono">{summary.assetId}</span>
        {summary.required ? <Status tone="info">Required</Status> : <Status tone="idle">Optional</Status>}
        {summary.valid ? <Status tone="ok">Valid</Status> : missing ? <Status tone="warn">Definition missing</Status> : <Status tone="bad">Invalid — {splitProblems(summary.problems).errors.length} {splitProblems(summary.problems).errors.length === 1 ? "problem" : "problems"}</Status>}
        {summary.valid && splitProblems(summary.problems).warnings.length > 0 ? <Status tone="warn">{splitProblems(summary.problems).warnings.length} {splitProblems(summary.problems).warnings.length === 1 ? "warning" : "warnings"}</Status> : null}
        <ProductionState assetId={assetId} />
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
            <Link to={`${base}?step=versions${branchId ? `&branch=${encodeURIComponent(branchId)}` : ""}`} aria-current={step === "versions" ? "step" : undefined}>Versions</Link>{" "}
            <ProductionState assetId={assetId} />
          </li>
        </ol>
      </nav>
      <section aria-labelledby="pipeline-title" className="panel">
        <h2 id="pipeline-title" style={{ marginTop: 0 }}>Pipeline</h2>
        <BranchBar assetId={assetId} branches={branchList} viewing={branchId} onView={(next) => setParams((previous) => { const copy = new URLSearchParams(previous); copy.set("branch", next); return copy; })} />
        <PipelineView assetId={assetId} branchId={branchId} activeStep={step} base={base} />
        <p style={{ marginBottom: 0 }}><Link className="button" to={`${base}?step=versions${branchId ? `&branch=${encodeURIComponent(branchId)}` : ""}`}>Promote…</Link></p>
      </section>
      {summary.family === "environment" && step !== "definition" ? <CollectionView assetId={assetId} collection={steps.data?.ok ? steps.data.data.collection : undefined} branches={branchList} /> : null}
      {step === "versions" ? <VersionsSection assetId={assetId} branchId={branchId} base={base} /> : step === "concept" ? <ConceptStep assetId={assetId} /> : step === "references" ? <ReferencesStep assetId={assetId} inspect={inspect} /> : step === "definition" ? <DefinitionStep inspect={inspect} autoCreate={params.get("create") === "1"} /> : activeStep && branchId ? <StepDetail key={`${branchId}-${step}`} assetId={assetId} step={activeStep} branchId={branchId} /> : <Banner tone="info" title={branchId ? `No step named ${step}` : "Lock a concept first"}>{branchId ? "Pick a step from the pipeline above." : "Production steps need a locked concept branch."}</Banner>}
    </>
  );
}
