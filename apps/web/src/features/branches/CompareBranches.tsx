import { Link } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { ErrorBanner, NetworkProblem, Status } from "../../components/ui.tsx";
import { DeliverableThumb } from "../production/DeliverableThumb.tsx";
import { DifferencesTable, InputModeBadge, ReassessmentReasons } from "./shared.tsx";

/** Side-by-side per-step grid for 2+ branches, plus how their saved input bases differ. */
export function CompareBranches({ assetId, branchIds }: { assetId: string; branchIds: string[] }) {
  const query = useOperation("branch.compare", { assetId, branchIds });
  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary" role="status">Comparing branches…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;
  const { branches, steps, basisDifferences, currentBranchId } = query.data.data.comparison;
  const name = (branchId: string) => branches.find((branch) => branch.branchId === branchId)?.name ?? branchId.slice(0, 8);
  const candidateLink = (candidateId: string) => `/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(candidateId)}`;

  return (
    <div className="stack">
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Per-step comparison of the selected branches</caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              {branches.map((branch) => (
                <th key={branch.branchId} scope="col">
                  {branch.name} <InputModeBadge mode={branch.inputMode} />
                  {branch.branchId === currentBranchId ? <> <Status tone="ok">Current</Status></> : null}
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
                      <div><Status tone={cell.state === "complete" ? "ok" : cell.state === "failed" ? "bad" : cell.state === "blocked" ? "warn" : "info"}>{cell.state.replaceAll("_", " ")}</Status></div>
                      {cell.selected ? (
                        <div style={{ marginTop: 4 }}>
                          <DeliverableThumb candidateId={cell.selected.candidateId} outputId={cell.selected.outputId} label={`${step.stepId} selected in ${branch.name}`} />
                          <div className="secondary">{cell.selected.approval && cell.selected.approval !== "none" ? cell.selected.approval : "not approved"} · <Link to={candidateLink(cell.selected.candidateId)}>Open</Link></div>
                        </div>
                      ) : <div className="secondary">Nothing selected</div>}
                      <div className="secondary">{cell.openFeedback} open {cell.openFeedback === 1 ? "note" : "notes"}</div>
                      {cell.needsReassessment ? <div role="status" style={{ marginTop: 4 }}><Status tone="warn">Needs reassessment</Status><ReassessmentReasons reasons={cell.reassessmentReasons} /></div> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section aria-labelledby="cmp-basis">
        <h3 id="cmp-basis" style={{ margin: "0 0 8px" }}>Input basis differences</h3>
        {basisDifferences.length === 0 ? <p className="secondary" style={{ margin: 0 }}>These branches share the same input basis.</p> : basisDifferences.map((item) => (
          <div key={`${item.branchId}-${item.versus}`} style={{ marginBottom: 16 }}>
            <h4 style={{ margin: "0 0 4px" }}>{item.versus === "current" ? `${name(item.branchId)}: saved inputs vs current files` : `${name(item.branchId)} vs the other branch`}</h4>
            <DifferencesTable differences={item.differences} savedLabel={item.versus === "current" ? "Saved" : name(item.branchId)} currentLabel={item.versus === "current" ? "Current" : "Other branch"} />
          </div>
        ))}
      </section>
    </div>
  );
}
