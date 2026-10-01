import { useState } from "react";
import { Link } from "react-router-dom";
import type { Candidate, StepState } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, NextActions, Status, type Tone } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useProject } from "../../lib/use-project.ts";
import { ActiveJobsStrip } from "../jobs/JobsPage.tsx";
import { BudgetPanel } from "./BudgetPanel.tsx";
import { OpenNotes } from "../review/OpenNotes.tsx";
import { CompareView } from "./CompareView.tsx";
import { GenerateDialog, type GenerateRequest } from "./GenerateDialog.tsx";
import { ContinueButton } from "../branches/ContinueDialog.tsx";
import { BackdropPicker, outputUrl, pickOutput, RolePicker, useBackdrop, type Backdrop, type OutputRole } from "./media.tsx";

const STEP_TONE: Record<StepState["state"], Tone> = { blocked: "warn", ready: "info", running: "info", awaiting_review: "info", complete: "ok", failed: "bad" };
const STEP_TEXT: Record<StepState["state"], string> = {
  blocked: "Blocked", ready: "Ready to generate", running: "Generating", awaiting_review: "Awaiting review", complete: "Complete", failed: "Failed",
};
const MAX_COMPARE = 4;

function Thumb({ candidate, role, backdrop, projectId, selected, canSelect, onToggleSelect, onFavorite, favoriteBusy, assetId, context }: {
  candidate: Candidate; role: OutputRole; backdrop: Backdrop; projectId: string; selected: boolean; canSelect: boolean;
  onToggleSelect: () => void; onFavorite: () => void; favoriteBusy: boolean; assetId: string; context: string;
}) {
  const output = pickOutput(candidate, role);
  return (
    <li className={`candidate-card${selected ? " selected" : ""}`}>
      <Link to={`/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(candidate.candidateId)}?${context}`} className="candidate-link" aria-label={`Open ${candidate.label}`}>
        <div className={`stage-bg ${backdrop} candidate-thumb`} style={output ? { aspectRatio: `${output.width} / ${output.height}` } : { aspectRatio: "1 / 1" }}>
          {output ? (
            <img src={outputUrl(projectId, output.fileId, 384)} width={output.width} height={output.height} loading="lazy" alt={`${candidate.label}, ${output.role} output`} />
          ) : <span className="secondary">No image output</span>}
        </div>
      </Link>
      <div className="row" style={{ justifyContent: "space-between", gap: 8, marginTop: 8 }}>
        <strong>{candidate.label}</strong>
        <button type="button" aria-pressed={candidate.favorite} disabled={favoriteBusy} onClick={onFavorite} aria-label={`${candidate.favorite ? "Remove favorite from" : "Favorite"} ${candidate.label}`}>
          <Icon name="star" className={candidate.favorite ? "is-on" : ""} /> {candidate.favorite ? "Favorite" : "Add favorite"}
        </button>
      </div>
      <div className="secondary">
        {candidate.seed !== undefined ? <>seed <span className="mono">{candidate.seed}</span> · </> : null}
        {candidate.annotationCount} {candidate.annotationCount === 1 ? "note" : "notes"}
        {candidate.openRevisionCount > 0 ? <> · <strong>{candidate.openRevisionCount} open {candidate.openRevisionCount === 1 ? "revision" : "revisions"}</strong></> : null}
      </div>
      <div style={{ marginTop: 4 }}><ContinueButton assetId={assetId} candidateId={candidate.candidateId} outputId={pickOutput(candidate, "matted")?.outputId} label="Lock as concept" ariaLabel={`Lock ${candidate.label} as concept`} disabled={candidate.outputs.length === 0} /></div>
      <label className="check" style={{ minHeight: 32 }}>
        <input type="checkbox" checked={selected} disabled={!selected && !canSelect} onChange={onToggleSelect} />
        Compare{!selected && !canSelect ? ` (max ${MAX_COMPARE})` : ""}
      </label>
    </li>
  );
}

export function ConceptStep({ assetId, branchId }: { assetId: string; branchId?: string | undefined }) {
  const context = new URLSearchParams({ step: "concept", ...(branchId ? { branch: branchId } : {}) }).toString();
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const step = useOperation("step.inspect", { assetId, stepId: "concept" });
  const list = useOperation("candidate.list", { assetId, stepId: "concept", favoriteOnly: false, limit: 200 }, { refetchInterval: 15_000 });
  const favorite = useMutationOperation("candidate.favorite");
  const [backdrop, setBackdrop] = useBackdrop();
  const [role, setRole] = useState<OutputRole>("matted");
  const [selected, setSelected] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [dialog, setDialog] = useState<GenerateRequest | undefined>(undefined);
  const [grantOpen, setGrantOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);

  const candidates = list.data?.ok ? list.data.data.candidates : [];
  const chosen = selected.flatMap((id) => candidates.filter((candidate) => candidate.candidateId === id));
  const stepState = step.data?.ok ? step.data.data.step : undefined;
  const generateDisabled = stepState?.state === "blocked";

  const openGrant = () => { setBudgetOpen(true); setGrantOpen(true); };

  return (
    <div className="task">
      <div className="task-bar">
        <h2 id="concept-title">Concept exploration</h2>
        {stepState ? <Status tone={STEP_TONE[stepState.state]}>{STEP_TEXT[stepState.state]}</Status> : null}
        <span className="task-spacer" />
        <button type="button" className="primary" disabled={generateDisabled || !stepState} onClick={() => setDialog({ mode: "fresh" })}>Generate concepts</button>
      </div>

      <div className="task-grid">
        <section className="task-stage" aria-labelledby="candidates-title">
          <div className="task-toolbar">
            <h3 id="candidates-title" style={{ margin: 0 }}>Candidates</h3>
            <RolePicker value={role} onChange={setRole} />
            <BackdropPicker value={backdrop} onChange={setBackdrop} />
            <span className="task-spacer" />
            <button type="button" disabled={chosen.length < 2} onClick={() => setComparing(true)}>Compare selected ({chosen.length})</button>
            <button type="button" disabled={chosen.length !== 1 || generateDisabled} onClick={() => setDialog({ mode: "variation", ...(chosen[0] ? { parentCandidateId: chosen[0].candidateId } : {}) })}>Generate variations of selected</button>
            {chosen.length > 0 ? <button type="button" onClick={() => { setSelected([]); setComparing(false); }}>Clear selection</button> : null}
          </div>
          <p className="secondary" style={{ margin: 0 }}>
            {chosen.length < 2 ? `Select 2–${MAX_COMPARE} candidates to compare, or one to make variations. ` : ""}
            {role === "matted" ? "Showing the background-removed output; switch to Untouched for the raw decode. " : ""}
            Favorites are a shortlist only; they never approve a candidate.
          </p>
          {list.error ? <NetworkProblem error={list.error} /> : null}
          {!list.data && !list.error ? <p className="secondary" role="status">Loading candidates…</p> : null}
          {list.data && !list.data.ok ? <ErrorBanner error={list.data.error} /> : null}
          {list.data?.ok && candidates.length === 0 ? (
            <div className="empty-task">
              <strong>No concepts yet</strong>
              <p>Generate a batch to explore concepts. You will review the exact plan and pick a budget before anything is submitted.</p>
              <button type="button" className="primary" disabled={generateDisabled || !stepState} onClick={() => setDialog({ mode: "fresh" })}>Generate concepts</button>
              {generateDisabled ? <span className="secondary">Blocked: see the reason beside this task.</span> : null}
            </div>
          ) : null}
          {projectId && candidates.length > 0 ? (
            <ul className="candidate-grid" aria-label="Concept candidates">
              {candidates.map((candidate) => (
                <Thumb
                  key={candidate.candidateId} candidate={candidate} role={role} backdrop={backdrop} projectId={projectId} assetId={assetId} context={context}
                  selected={selected.includes(candidate.candidateId)} canSelect={selected.length < MAX_COMPARE}
                  onToggleSelect={() => setSelected((previous) => (previous.includes(candidate.candidateId) ? previous.filter((id) => id !== candidate.candidateId) : [...previous, candidate.candidateId]))}
                  onFavorite={() => void favorite.mutateAsync({ input: { candidateId: candidate.candidateId, favorite: !candidate.favorite } })}
                  favoriteBusy={favorite.isPending}
                />
              ))}
            </ul>
          ) : null}
          {favorite.data && !favorite.data.ok ? <ErrorBanner error={favorite.data.error} /> : null}
          {comparing && chosen.length >= 2 && projectId ? (
            <CompareView candidates={chosen} role={role} backdrop={backdrop} onBackdrop={setBackdrop} projectId={projectId} onClose={() => setComparing(false)} />
          ) : null}
        </section>

        <aside className="task-rail" aria-label="Concept status and blockers">
          {step.error ? <NetworkProblem error={step.error} /> : null}
          {!step.data && !step.error ? <p className="secondary" role="status">Loading step state…</p> : null}
          {step.data && !step.data.ok ? <ErrorBanner error={step.data.error} /> : null}
          {stepState ? (
            <>
              <p className="secondary">
                {stepState.counts.candidates} candidates · {stepState.counts.favorites} favorites · {stepState.counts.activeJobs} running · {stepState.counts.unresolvedJobs} unresolved · {stepState.counts.openRevisions} open revisions
              </p>
              {stepState.needsReassessment ? (
                <Banner tone="warn" title="Needs reassessment">
                  <ul style={{ margin: 0, paddingLeft: 20 }}>{stepState.reassessmentReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                </Banner>
              ) : null}
              {stepState.blockers.filter((blocker) => blocker.code !== "REVISION_OPEN").map((blocker) => (
                <Banner key={blocker.code} tone="warn" title={blocker.message}>
                  {blocker.recoveryActions.length > 0 ? <ul style={{ margin: 0, paddingLeft: 20 }}>{blocker.recoveryActions.map((action) => <li key={action.label}>{action.url ? <a href={action.url}>{action.label}</a> : action.label}</li>)}</ul> : null}
                </Banner>
              ))}
              {stepState.counts.openRevisions > 0 || stepState.blockers.some((blocker) => blocker.code === "REVISION_OPEN") ? <OpenNotes assetId={assetId} stepId="concept" /> : null}
              <NextActions actions={stepState.nextActions} />
            </>
          ) : null}
          <ActiveJobsStrip assetId={assetId} />
        </aside>
      </div>

      <details className="task-budget" open={budgetOpen} onToggle={(event) => setBudgetOpen(event.currentTarget.open)}>
        <summary>Compute and generation budget</summary>
        <BudgetPanel assetId={assetId} grantOpen={grantOpen} onGrantOpen={setGrantOpen} />
      </details>

      {dialog ? <GenerateDialog assetId={assetId} candidates={candidates} initial={dialog} onClose={() => setDialog(undefined)} onGrantBudget={openGrant} /> : null}
    </div>
  );
}
