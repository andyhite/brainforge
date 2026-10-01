import { Link } from "react-router-dom";
import type { StepState } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, Status, type Tone } from "../../components/ui.tsx";
import { ReassessmentReasons } from "../branches/shared.tsx";

const STATE_TONE: Record<StepState["state"], Tone> = { blocked: "warn", ready: "info", running: "info", awaiting_review: "info", complete: "ok", failed: "bad" };
const STATE_TEXT: Record<StepState["state"], string> = {
  blocked: "Blocked", ready: "Ready", running: "Generating", awaiting_review: "Awaiting review", complete: "Complete", failed: "Failed",
};

/** The one thing to do next, derived only from the server-provided state. */
export function primaryAction(step: StepState): string | undefined {
  if (step.stepId === "concept") {
    if (step.counts.candidates === 0) return step.state === "blocked" ? undefined : "Generate concepts";
    return step.selected ? "Open concept" : "Lock a concept";
  }
  switch (step.state) {
    case "blocked": return undefined;
    case "running": return "Watch progress";
    case "failed": return "Inspect failure";
    case "awaiting_review": return step.counts.pendingEscalations > 0 ? "Waiting for a human decision" : "Review";
    case "complete": return "View";
    case "ready": return step.counts.candidates === 0 ? "Generate" : step.selected ? "Review" : "Select a candidate";
  }
}

function depths(steps: StepState[]): StepState[][] {
  const depth = new Map<string, number>();
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visit = (step: StepState, seen: Set<string>): number => {
    const known = depth.get(step.stepId);
    if (known !== undefined) return known;
    if (seen.has(step.stepId)) return 0;
    seen.add(step.stepId);
    const parents = step.dependsOn.flatMap((id) => { const parent = byId.get(id); return parent ? [parent] : []; });
    const value = parents.length === 0 ? (step.stepId === "concept" ? 0 : 1) : 1 + Math.max(...parents.map((parent) => visit(parent, seen)));
    depth.set(step.stepId, value);
    return value;
  };
  const levels: StepState[][] = [];
  for (const step of steps) (levels[visit(step, new Set())] ??= []).push(step);
  return levels.filter((level) => level.length > 0);
}

function StepCard({ step, href, active, stepNames }: { step: StepState; href: string; active: boolean; stepNames: Map<string, StepState> }) {
  const action = primaryAction(step);
  const unmet = step.blockers.map((blocker) => blocker.message);
  return (
    <li className={`pipeline-step${active ? " active" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <Link to={href} aria-current={active ? "step" : undefined}><strong>{step.stepId}</strong></Link>
        <Status tone={STATE_TONE[step.state]}>{STATE_TEXT[step.state]}</Status>
      </div>
      <div className="secondary">
        {step.kind}{step.stepId !== "concept" ? (step.required ? "" : " · optional") : ""}
        {step.dependsOn.length > 0 ? <> · after {step.dependsOn.map((id) => stepNames.get(id)?.stepId ?? id).join(", ")}</> : null}
      </div>
      {unmet.length > 0 ? <ul className="secondary" style={{ margin: "4px 0", paddingLeft: 18 }}>{unmet.map((message) => <li key={message}>{message}</li>)}</ul> : null}
      {step.selected ? (
        <div className="secondary">
          Selected {step.selected.candidateId.slice(0, 8)} · {step.selected.approval && step.selected.approval.state !== "none"
            ? <>{step.selected.approval.state}{step.selected.approval.decidedByType ? ` by ${step.selected.approval.decidedByType}` : ""}{step.selected.approval.overridden ? " (overridden)" : ""}{step.selected.approval.applicable ? "" : ` — stale${step.selected.approval.staleReason ? `: ${step.selected.approval.staleReason}` : ""}`}</>
            : "not approved"}
        </div>
      ) : null}
      <div className="secondary">
        {step.counts.candidates} candidates · {step.counts.activeJobs} running{step.counts.openRevisions > 0 ? ` · ${step.counts.openRevisions} open revisions` : ""}{step.counts.pendingEscalations > 0 ? ` · ${step.counts.pendingEscalations} escalated` : ""}
      </div>
      {step.needsReassessment ? <div role="status"><Status tone="warn">Needs reassessment</Status><div className="secondary"><ReassessmentReasons reasons={step.reassessmentReasons} /></div></div> : null}
      {action ? <div style={{ marginTop: 6 }}><Link to={href} className="button primary">{action}</Link></div> : null}
    </li>
  );
}

export function PipelineView({ assetId, branchId, activeStep, base }: { assetId: string; branchId: string | undefined; activeStep: string; base: string }) {
  const query = useOperation("step.list", { assetId, ...(branchId ? { branchId } : {}) });
  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary" role="status">Loading pipeline…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;
  const steps = query.data.data.steps;
  if (steps.length === 0) return <Banner tone="info" title="No steps yet">Complete the asset definition to see its pipeline.</Banner>;
  const names = new Map(steps.map((step) => [step.stepId, step]));
  const branchQuery = branchId ? `&branch=${encodeURIComponent(branchId)}` : "";
  return (
    <ol className="pipeline" aria-label="Pipeline steps in dependency order">
      {depths(steps).map((level, index) => (
        <li key={index} className="pipeline-level">
          {level.length > 1 ? <div className="secondary">These {level.length} steps are independent and can proceed in parallel</div> : null}
          <ul className="pipeline-row">
            {level.map((step) => (
              <StepCard key={step.stepId} step={step} stepNames={names} active={activeStep === step.stepId} href={`${base}?step=${encodeURIComponent(step.stepId)}${branchQuery}`} />
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
