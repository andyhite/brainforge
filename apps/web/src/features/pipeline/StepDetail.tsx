import { useState } from "react";
import { Link } from "react-router-dom";
import type { Candidate, StepState } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, Status } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { ActiveJobsStrip } from "../jobs/JobsPage.tsx";
import { BudgetPanel } from "../generation/BudgetPanel.tsx";
import { GenerateDialog } from "../generation/GenerateDialog.tsx";
import { BackdropPicker, outputUrl, pickOutput, useBackdrop } from "../generation/media.tsx";
import { OpenNotes } from "../review/OpenNotes.tsx";
import { ContinueButton } from "../branches/ContinueDialog.tsx";
import { ReassessmentReasons } from "../branches/shared.tsx";
import { STATE_TEXT, STATE_TONE } from "./steps.ts";
import { formatMs, outputLabel } from "../animation/timing.ts";

const REGION_ORDER = ["front", "profile", "rear"];

function SheetCrops({ candidate, outputId, projectId }: { candidate: Candidate; outputId: string; projectId: string }) {
  const [backdrop] = useBackdrop();
  const material = useOperation("review.material", { candidateId: candidate.candidateId });
  if (material.error) return <NetworkProblem error={material.error} />;
  if (!material.data) return <p className="secondary" role="status">Loading crops…</p>;
  if (!material.data.ok) return <ErrorBanner error={material.data.error} />;
  const crops = material.data.data.visuals
    .filter((visual) => visual.role === "crop" && visual.fileId.startsWith(`${outputId}-crop-`))
    .sort((a, b) => (REGION_ORDER.indexOf(a.label) + 1 || 99) - (REGION_ORDER.indexOf(b.label) + 1 || 99));
  if (crops.length === 0) return <p className="secondary">No view crops are published for this sheet.</p>;
  return (
    <ul className="crop-row" aria-label="View crops derived from the sheet">
      {crops.map((crop) => (
        <li key={crop.fileId}>
          <figure>
            <div className={`stage-bg ${backdrop} candidate-thumb`} style={{ aspectRatio: "2 / 3" }}>
              <img src={outputUrl(projectId, crop.fileId, 320)} alt={`${crop.label} view crop of ${candidate.label}`} />
            </div>
            <figcaption><strong>{crop.label}</strong>{crop.width && crop.height ? <span className="secondary"> {crop.width}×{crop.height}</span> : null}</figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}

function CandidateRow({ candidate, step, branchId, projectId, assetId }: { candidate: Candidate; step: StepState; branchId: string; projectId: string; assetId: string }) {
  const select = useMutationOperation("candidate.select");
  const [backdrop] = useBackdrop();
  const animation = step.kind === "animation";
  const processed = candidate.outputs.filter((o) => o.stage === "processed");
  const output = animation ? processed[processed.length - 1] ?? pickOutput(candidate, "matted") : pickOutput(candidate, "matted");
  const needsProcessing = animation && output?.stage !== "processed";
  const candidateLink = `/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(candidate.candidateId)}?${new URLSearchParams({ ...(animation && output ? { output: output.outputId } : {}), branch: branchId, step: step.stepId }).toString()}`;
  const approval = output ? candidate.approvals.find((item) => item.outputId === output.outputId) : undefined;
  const isSelected = step.selected?.candidateId === candidate.candidateId && (step.selected.outputId === undefined || step.selected.outputId === output?.outputId);
  return (
    <li className={`candidate-card${isSelected ? " selected" : ""}`} style={{ gridColumn: step.kind === "reference-sheet" ? "1 / -1" : undefined }}>
      <div className="stack" style={{ alignItems: "stretch", gap: 16 }}>
        <Link to={candidateLink} className="candidate-link" aria-label={`Open ${candidate.label}`} style={{ maxWidth: 640 }}>
          <div className={`stage-bg ${backdrop} candidate-thumb`} style={{ aspectRatio: output ? `${output.width} / ${output.height}` : "1 / 1" }}>
            {output ? <img src={outputUrl(projectId, output.fileId, 640)} width={output.width} height={output.height} loading="lazy" alt={`${candidate.label}${step.kind === "reference-sheet" ? ", full sheet" : ""}`} /> : <span className="secondary">No image output</span>}
          </div>
        </Link>
        <div className="stack" style={{ flex: 1 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{candidate.label}</strong>
            {isSelected ? <Status tone="info">Selected</Status> : null}
          </div>
          {output && output.mediaKind === "frames" ? <p className="secondary" style={{ margin: 0 }}>{outputLabel(output)}{output.totalDurationMs !== undefined ? ` · ${formatMs(output.totalDurationMs)}` : ""}</p> : null}
          <div className="secondary">
            {approval && approval.state !== "none"
              ? <>{approval.state}{approval.decidedByType ? ` by ${approval.decidedByType}` : ""}{approval.overridden ? " (overridden)" : ""}{approval.applicable ? "" : " — stale, needs reassessment"}</>
              : "Not approved yet"}
            {candidate.openRevisionCount > 0 ? ` · ${candidate.openRevisionCount} open revisions` : ""}
          </div>
          {step.kind === "reference-sheet" && output ? <SheetCrops candidate={candidate} outputId={output.outputId} projectId={projectId} /> : null}
          <div className="row">
            <button type="button" disabled={isSelected || !output || needsProcessing || select.isPending} onClick={() => void select.mutateAsync({ input: { branchId, deliverableId: step.stepId, candidateId: candidate.candidateId, ...(output ? { outputId: output.outputId } : {}) } })}>
              {isSelected ? "In use" : "Use this one"}
            </button>
            <Link to={candidateLink} className="button">{needsProcessing ? "Process and review" : "Review"}</Link>
            {output ? <ContinueButton assetId={assetId} candidateId={candidate.candidateId} outputId={output.outputId} ariaLabel={`Continue from here: ${candidate.label}`} /> : null}
          </div>
          {animation
            ? <p className="secondary" style={{ margin: 0 }}>{needsProcessing ? "Raw frames cannot complete this step. Process them into an export clip first." : `Showing the latest of ${processed.length} processed ${processed.length === 1 ? "clip" : "clips"}.`} Using a clip is not approval.</p>
            : <p className="secondary" style={{ margin: 0 }}>Using a candidate is not approval; it still needs a review decision.</p>}
          {select.error ? <NetworkProblem error={select.error} /> : null}
          {select.data && !select.data.ok ? <ErrorBanner error={select.data.error} /> : null}
        </div>
      </div>
    </li>
  );
}

export function StepDetail({ assetId, step, branchId }: { assetId: string; step: StepState; branchId: string }) {
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const list = useOperation("candidate.list", { assetId, stepId: step.stepId, branchId, favoriteOnly: false, limit: 200 }, { refetchInterval: 15_000 });
  const [backdrop, setBackdrop] = useBackdrop();
  const [dialog, setDialog] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const candidates = list.data?.ok ? list.data.data.candidates : [];
  const canGenerate = step.state === "ready" || step.state === "awaiting_review" || step.state === "complete";

  return (
    <div className="task">
      <div className="task-bar">
        <h2 id="step-title">{step.stepId} <span className="secondary">({step.kind}{step.required ? "" : ", optional"})</span></h2>
        <Status tone={STATE_TONE[step.state]}>{STATE_TEXT[step.state]}</Status>
        <span className="task-spacer" />
        <BackdropPicker value={backdrop} onChange={setBackdrop} />
        <button type="button" className="primary" disabled={!canGenerate} onClick={() => setDialog(true)}>{candidates.length === 0 ? "Generate" : "Generate more"}</button>
      </div>

      <div className="task-grid">
        <section className="task-stage" aria-labelledby="step-candidates">
          <h3 id="step-candidates" className="sr-only">Candidates</h3>
          {list.error ? <NetworkProblem error={list.error} /> : null}
          {!list.data && !list.error ? <p className="secondary" role="status">Loading candidates…</p> : null}
          {list.data && !list.data.ok ? <ErrorBanner error={list.data.error} /> : null}
          {list.data?.ok && candidates.length === 0 ? (
            <div className="empty-task">
              <strong>No candidates yet</strong>
              <p>{step.state === "blocked" ? "This step is blocked; see the reason beside this task." : "Generate this step to get candidates. You will see the exact plan first."}</p>
              <button type="button" className="primary" disabled={!canGenerate} onClick={() => setDialog(true)}>Generate</button>
            </div>
          ) : null}
          {projectId && candidates.length > 0 ? (
            <ul className="candidate-grid" aria-label={`Candidates for ${step.stepId}`}>
              {candidates.map((candidate) => <CandidateRow key={candidate.candidateId} candidate={candidate} step={step} branchId={branchId} projectId={projectId} assetId={assetId} />)}
            </ul>
          ) : null}
        </section>

        <aside className="task-rail" aria-label="Step blockers and notes">
          {step.dependsOn.length > 0 ? <p className="secondary">Runs after {step.dependsOn.join(", ")}.</p> : null}
          {step.blockers.filter((blocker) => blocker.code !== "REVISION_OPEN").map((blocker) => <Banner key={blocker.code + blocker.message} tone="warn" title={blocker.message} />)}
          {step.counts.openRevisions > 0 || step.blockers.some((blocker) => blocker.code === "REVISION_OPEN") ? <OpenNotes assetId={assetId} stepId={step.stepId} /> : null}
          {step.kind === "animation" && step.state === "ready" ? <p className="secondary">Ready by its dependencies. Generating makes raw frames; you then process them into an export clip, and only a reviewed processed clip completes this step.</p> : null}
          {step.needsReassessment ? <Banner tone="warn" title="Needs reassessment"><ReassessmentReasons reasons={step.reassessmentReasons} /></Banner> : null}
          <ActiveJobsStrip assetId={assetId} />
        </aside>
      </div>

      <details className="task-budget" open={budgetOpen} onToggle={(event) => setBudgetOpen(event.currentTarget.open)}>
        <summary>Compute and generation budget</summary>
        <BudgetPanel assetId={assetId} stepId={step.stepId} grantOpen={grantOpen} onGrantOpen={setGrantOpen} />
      </details>

      {dialog ? (
        <GenerateDialog
          assetId={assetId} stepId={step.stepId} stepKind={step.kind} branchId={branchId} candidates={candidates} initial={{ mode: "fresh" }}
          onClose={() => setDialog(false)}
          onGrantBudget={() => { setBudgetOpen(true); setGrantOpen(true); }}
        />
      ) : null}
    </div>
  );
}
