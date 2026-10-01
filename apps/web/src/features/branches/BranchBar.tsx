import { useState } from "react";
import { Link } from "react-router-dom";
import type { Branch } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, Status } from "../../components/ui.tsx";
import { DeliverableThumb } from "../production/DeliverableThumb.tsx";
import { CompareBranches } from "./CompareBranches.tsx";
import { ContinueDialog } from "./ContinueDialog.tsx";
import { InputModeBadge, rebaseSource } from "./shared.tsx";

function StepSummary({ assetId, branchId }: { assetId: string; branchId: string }) {
  const query = useOperation("step.list", { assetId, branchId });
  if (!query.data?.ok) return <span className="secondary">Steps: loading…</span>;
  const steps = query.data.data.steps;
  const complete = steps.filter((step) => step.state === "complete").length;
  const review = steps.filter((step) => step.state === "awaiting_review").length;
  const blocked = steps.filter((step) => step.state === "blocked").length;
  const stale = steps.filter((step) => step.needsReassessment).length;
  return (
    <span className="secondary">
      {complete} of {steps.length} steps complete
      {review > 0 ? ` · ${review} awaiting review` : ""}{blocked > 0 ? ` · ${blocked} blocked` : ""}{stale > 0 ? ` · ${stale} need reassessment` : ""}
    </span>
  );
}

/** Every branch of the asset: what it is, who made it, what basis it uses, and what to do with it. */
export function BranchBar({ assetId, branches, viewing, onView }: { assetId: string; branches: Branch[]; viewing: string | undefined; onView: (branchId: string) => void }) {
  const select = useMutationOperation("branch.select");
  const [compared, setCompared] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [rebasing, setRebasing] = useState<Branch | undefined>(undefined);

  if (branches.length === 0) {
    return <p className="secondary">No concept is locked yet. Lock one from the concept candidates to start production; steps after the concept stay blocked until then.</p>;
  }
  const names = new Map(branches.map((branch) => [branch.branchId, branch.name]));
  const toggle = (branchId: string) => {
    setShowCompare(false);
    setCompared((previous) => previous.includes(branchId) ? previous.filter((id) => id !== branchId) : [...previous, branchId].slice(-6));
  };

  return (
    <div className="stack">
      <ul className="candidate-grid branch-grid" aria-label="Branches of this asset">
        {branches.map((branch) => {
          const parent = branch.parentBranchId ? names.get(branch.parentBranchId) : undefined;
          return (
            <li key={branch.branchId} className={`candidate-card${branch.branchId === viewing ? " selected" : ""}`}>
              <div className="stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{branch.name}</strong>
                  <span className="row" style={{ gap: 4 }}>
                    {branch.isCurrent ? <Status tone="ok">Current</Status> : null}
                    {branch.branchId === viewing ? <Status tone="info">Viewing</Status> : null}
                  </span>
                </div>
                <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <DeliverableThumb candidateId={branch.conceptCandidateId} outputId={branch.conceptOutputId} label={`Concept of ${branch.name}`} />
                  <div className="stack" style={{ gap: 4 }}>
                    <InputModeBadge mode={branch.inputMode} />
                    <div className="secondary">
                      {parent ? <>From <button type="button" className="link" onClick={() => onView(branch.parentBranchId ?? "")}>{parent}</button></> : "Concept lock"}
                      {branch.sourceCandidateId ? <> · <Link to={`/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(branch.sourceCandidateId)}?branch=${encodeURIComponent(branch.branchId)}&step=concept`}>source candidate</Link></> : null}
                    </div>
                    <div className="secondary">By {branch.lockedBy} ({branch.lockedByType}) · {formatTime(branch.lockedAt)}</div>
                    <StepSummary assetId={assetId} branchId={branch.branchId} />
                  </div>
                </div>
                <div className="row">
                  <button type="button" disabled={branch.branchId === viewing} onClick={() => onView(branch.branchId)}>View</button>
                  <button type="button" disabled={branch.isCurrent || select.isPending} onClick={() => void select.mutateAsync({ input: { assetId, branchId: branch.branchId } })}>Make current</button>
                  {branch.inputMode === "saved" ? <button type="button" onClick={() => setRebasing(branch)}>Rebase to current inputs</button> : null}
                </div>
                {branches.length > 1 ? (
                  <label className="check" style={{ minHeight: 32 }}>
                    <input type="checkbox" checked={compared.includes(branch.branchId)} onChange={() => toggle(branch.branchId)} />
                    Compare
                  </label>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite">
        {select.error ? <NetworkProblem error={select.error} /> : null}
        {select.data && !select.data.ok ? <ErrorBanner error={select.data.error} /> : null}
        {select.data?.ok ? <p className="secondary" role="status">The asset now works on {select.data.data.branches.find((branch) => branch.isCurrent)?.name ?? "the chosen branch"}. Nothing was promoted or activated.</p> : null}
      </div>
      {branches.length > 1 ? (
        <div className="row">
          <button type="button" disabled={compared.length < 2} aria-expanded={showCompare} onClick={() => setShowCompare((previous) => !previous)}>
            {showCompare ? "Hide comparison" : compared.length >= 2 ? `Compare ${compared.length} branches` : "Compare branches"}
          </button>
          {compared.length < 2 ? <span className="secondary">Tick Compare on at least two branches.</span> : null}
        </div>
      ) : null}
      {showCompare && compared.length >= 2 ? <CompareBranches assetId={assetId} branchIds={compared} /> : null}
      {rebasing ? (
        <ContinueDialog assetId={assetId} {...rebaseSource(rebasing)} fixedMode="current" onClose={() => setRebasing(undefined)} />
      ) : null}
    </div>
  );
}
