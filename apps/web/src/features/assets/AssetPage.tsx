import { Link, useParams, useSearchParams } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { DefinitionStep } from "./DefinitionStep.tsx";
import { ReferencesStep } from "./ReferencesStep.tsx";
import { AssetNavigator } from "./AssetNavigator.tsx";
import { ConceptStep } from "../generation/ConceptStep.tsx";
import { BranchBar } from "../branches/BranchBar.tsx";
import { StepDetail } from "../pipeline/StepDetail.tsx";
import { ProductionState } from "../production/ProductionState.tsx";
import { VersionsSection } from "../production/VersionsSection.tsx";
import { CollectionView } from "../families/CollectionView.tsx";
import { FamilyChip, splitProblems, useFamilies } from "../families/useFamilies.tsx";

export function AssetPage() {
  const { assetId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { root } = useProjectRoot();
  const enabled = root !== undefined && assetId !== "";
  const query = useOperation("asset.inspect", { assetId }, { enabled });
  const branches = useOperation("branch.list", { assetId }, { enabled });
  const branchList = branches.data?.ok ? branches.data.data.branches : [];
  const requestedBranch = params.get("branch");
  const current = branchList.find((branch) => branch.isCurrent);
  const viewed = branchList.find((branch) => branch.branchId === requestedBranch) ?? current ?? branchList[0];
  const branchId = viewed?.branchId;
  const steps = useOperation("step.list", { assetId, ...(branchId ? { branchId } : {}) }, { enabled });
  const families = useFamilies();
  const stepList = steps.data?.ok ? steps.data.data.steps : [];

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
  const missing = inspect.yamlHash === undefined;
  const { errors, warnings } = splitProblems(summary.problems);
  // No explicit task: lead with the first thing that actually needs doing for this asset.
  const step = params.get("step")
    ?? (!summary.valid ? "definition" : !branchId ? "concept" : stepList.find((candidate) => candidate.state === "ready" || candidate.state === "awaiting_review" || candidate.state === "failed")?.stepId ?? "concept");
  const activeStep = stepList.find((candidate) => candidate.stepId === step);
  const base = `/assets/${encodeURIComponent(assetId)}`;
  const branchQuery = branchId ? `&branch=${encodeURIComponent(branchId)}` : "";
  const notCurrent = viewed !== undefined && current !== undefined && viewed.branchId !== current.branchId;
  const setBranch = (next: string) => setParams((previous) => { const copy = new URLSearchParams(previous); copy.set("branch", next); return copy; });

  return (
    <div className="asset-workspace">
      <AssetNavigator assetId={assetId} {...(branchId ? { branchId } : {})} activeStep={step} />
      <div className="asset-workspace-main">
        <header className="asset-context">
          <nav className="crumbs" aria-label="Context">
            <Link to="/">Workbench</Link> › <Link to="/assets">Assets</Link> › <span>{summary.name ?? summary.assetId}</span>
            {viewed ? <> › <span>{viewed.name}</span></> : null} › <span aria-current="step">{step}</span>
          </nav>
          <div className="context-row">
            <h1>{summary.name ?? summary.assetId}</h1>
            {summary.family ? <FamilyChip family={summary.family} profile={families.profileOf(summary.family)} /> : null}
            <span className="mono secondary">{summary.assetId}</span>
            {summary.required ? <Status tone="info">Required</Status> : <Status tone="idle">Optional</Status>}
            {summary.valid ? <Status tone="ok">Valid</Status> : missing ? <Status tone="warn">Definition missing</Status> : <Status tone="bad">Invalid — {errors.length} {errors.length === 1 ? "problem" : "problems"}</Status>}
            {summary.valid && warnings.length > 0 ? <Status tone="warn">{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</Status> : null}
            <span className="context-spacer" />
            <ProductionState assetId={assetId} />
            <Link className="button" to={`${base}?step=versions${branchQuery}`}>Promote…</Link>
          </div>
          {branchList.length > 0 ? (
            <div className="branch-switch">
              <label htmlFor="viewed-branch">Viewing branch</label>
              <select id="viewed-branch" value={branchId} onChange={(event) => setBranch(event.target.value)}>
                {branchList.map((branch) => <option key={branch.branchId} value={branch.branchId}>{branch.name}{branch.isCurrent ? " (current)" : ""}</option>)}
              </select>
              {notCurrent ? <Status tone="warn">Not the current branch — current is {current.name}</Status> : <Status tone="ok">Current branch</Status>}
            </div>
          ) : <p className="secondary" style={{ margin: 0 }}>No concept is locked yet: generate concepts, then lock one to start production.</p>}
        </header>
        {branchList.length > 0 ? (
          <details className="branch-detail">
            <summary>Branches ({branchList.length}): make current, rebase, compare</summary>
            <BranchBar assetId={assetId} branches={branchList} viewing={branchId} onView={setBranch} />
          </details>
        ) : null}
        {step === "versions" ? <VersionsSection assetId={assetId} branchId={branchId} base={base} />
          : step === "concept" ? <ConceptStep assetId={assetId} branchId={branchId} />
          : step === "references" ? <ReferencesStep assetId={assetId} inspect={inspect} />
          : step === "definition" ? <DefinitionStep inspect={inspect} autoCreate={params.get("create") === "1"} />
          : activeStep && branchId ? <StepDetail key={`${branchId}-${step}`} assetId={assetId} step={activeStep} branchId={branchId} />
          : <Banner tone="info" title={branchId ? `No step named ${step}` : "Lock a concept first"}>{branchId ? "Pick a step from the navigator." : "Production steps need a locked concept branch."}</Banner>}
        {summary.family === "environment" && step !== "definition" ? (
          <details className="branch-detail" open>
            <summary>Environment collection</summary>
            <CollectionView assetId={assetId} collection={steps.data?.ok ? steps.data.data.collection : undefined} branches={branchList} />
          </details>
        ) : null}
      </div>
    </div>
  );
}
