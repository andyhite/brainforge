import { Link } from "react-router-dom";
import type { StepState } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { formatTime, gate, Status } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { STEP_STATE_TEXT } from "../../lib/steps.ts";
import { DeliverableThumb } from "../production/DeliverableThumb.tsx";
import { DifferencesTable, InputModeBadge, ReassessmentReasons } from "./shared.tsx";

/** Side-by-side per-deliverable grid for 2+ branches, plus how their saved input bases differ. */
export function CompareBranches({ assetId, branchIds }: { assetId: string; branchIds: string[] }) {
  const query = useOperation("branch.compare", { assetId, branchIds });
  const g = gate(query, "Comparing branches…");
  if ("node" in g) return g.node;
  const { branches, steps, basisDifferences, currentBranchId } = g.data.comparison;
  const name = (branchId: string) => branches.find((branch) => branch.branchId === branchId)?.name ?? branchId.slice(0, 8);

  return (
    <div className="branch-compare">
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Per-deliverable comparison of the selected branches</caption>
          <thead>
            <tr>
              <th scope="col">Deliverable</th>
              {branches.map((branch) => (
                <th key={branch.branchId} scope="col">
                  {branch.name} <InputModeBadge mode={branch.inputMode} />
                  {branch.branchId === currentBranchId ? <> <Status tone="ok">Current</Status></> : null}
                  <small>Locked by {branch.lockedBy} · {formatTime(branch.lockedAt)}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => (
              <tr key={step.stepId}>
                <th scope="row">{step.stepId}</th>
                {branches.map((branch) => {
                  const cell = step.perBranch.find((item) => item.branchId === branch.branchId);
                  if (!cell) return <td key={branch.branchId}>—</td>;
                  return (
                    <td key={branch.branchId}>
                      <div className="compare-cell">
                        <Status tone={cell.state === "complete" ? "ok" : cell.state === "failed" ? "bad" : cell.state === "blocked" ? "warn" : "info"}>{STEP_STATE_TEXT[cell.state as StepState["state"]] ?? cell.state.replaceAll("_", " ")}</Status>
                        {cell.selected ? (
                          <>
                            <DeliverableThumb candidateId={cell.selected.candidateId} outputId={cell.selected.outputId} label={`${step.stepId} selected in ${branch.name}`} />
                            <span className="faint">{cell.selected.approval === "approved" ? "Approved" : cell.selected.approval === "rejected" ? "Rejected" : "Not approved"} · <Link to={paths.step(assetId, step.stepId, { candidate: cell.selected.candidateId, ...(cell.selected.outputId ? { output: cell.selected.outputId } : {}), branch: branch.branchId })}>Open</Link></span>
                          </>
                        ) : <span className="faint">Nothing selected</span>}
                        {cell.openFeedback > 0 ? <span className="faint">{cell.openFeedback} open {cell.openFeedback === 1 ? "note" : "notes"}</span> : null}
                        {cell.needsReassessment ? <div role="status"><Status tone="warn">Needs reassessment</Status><ReassessmentReasons reasons={cell.reassessmentReasons} /></div> : null}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section aria-labelledby="cmp-basis">
        <h3 id="cmp-basis">Input basis differences</h3>
        {basisDifferences.length === 0 ? <p>These branches share the same input basis.</p> : basisDifferences.map((item) => (
          <div key={`${item.branchId}-${item.versus}`} className="basis">
            <h4>{item.versus === "current" ? `${name(item.branchId)}: saved inputs vs current files` : `${name(item.branchId)} vs the other branch`}</h4>
            <DifferencesTable differences={item.differences} savedLabel={item.versus === "current" ? "Saved" : name(item.branchId)} currentLabel={item.versus === "current" ? "Current" : "Other branch"} />
          </div>
        ))}
      </section>
    </div>
  );
}
