import type { ExportPlan, PlanBlocker } from "@brainforge/contracts";
import { Link } from "react-router-dom";
import { Banner, Blockers, Status } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";

function inspectTarget(blocker: PlanBlocker): string | undefined {
  for (const action of blocker.recoveryActions) {
    const input: unknown = action.input;
    if (action.operation === "export.inspect" && typeof input === "object" && input !== null && "exportId" in input && typeof input.exportId === "string") return input.exportId;
  }
  return undefined;
}


/** The exact plan: which version of which asset, how many files, what leaves, and anything that blocks it. */
export function ExportPlanView({ plan, onConfirmEmpty, onInspect }: { plan: ExportPlan; onConfirmEmpty: () => void; onInspect: (exportId: string) => void }) {
  return (
    <div className="rel-plan">
      <p className="rel-note">
        {plan.fileCount} {plan.fileCount === 1 ? "file" : "files"} will be written for this export, using the <strong>{plan.preset}</strong> layout.
      </p>
      <div className="table-wrap">
        <table className="rel-pick">
          <caption className="sr-only">Versions selected for this export</caption>
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Version</th>
              <th scope="col">Chosen as</th>
              <th scope="col">Requirements</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {plan.selection.length === 0 ? <tr><td colSpan={5}>Nothing is selected.</td></tr> : plan.selection.map((row) => (
              <tr key={row.assetId}>
                <th scope="row"><Link to={paths.assetVersions(row.assetId, { version: row.versionId })}>{row.assetId}</Link></th>
                <td>v{row.versionNumber}</td>
                <td>
                  {row.source === "explicit" ? <Status tone="info">Pinned by you</Status> : row.source === "member" ? <Status tone="idle">Collection member</Status> : <Status tone="ok">Active version</Status>}
                </td>
                <td>{row.matchesCurrent ? <Status tone="ok">Up to date</Status> : <Status tone="warn">Out of date: requirements changed</Status>}</td>
                <td>{row.notes.length === 0 ? "—" : <ul className="plain-list">{row.notes.map((note) => <li key={note}>{note}</li>)}</ul>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {plan.leaving.length > 0 ? (
        <div className="rel-sub">
          <h3>Assets that will leave the game</h3>
          <p className="secondary">They are in the current export but not in this one. Their promoted versions are not deleted.</p>
          <ul aria-label="Assets that will leave the game">
            {plan.leaving.map((item) => <li key={item.assetId}><span className="mono">{item.assetId}</span> (version <span className="mono">{item.versionId.slice(0, 8)}</span>)</li>)}
          </ul>
        </div>
      ) : null}
      {plan.leavingResourceKinds.length > 0 ? (
        <div className="rel-sub">
          <h3>Resource types that will leave the game</h3>
          <p className="secondary">Switching preset removes these from the next snapshot.</p>
          <ul aria-label="Resource types that will leave the game">
            {plan.leavingResourceKinds.map((kind) => <li key={kind}>{kind}</li>)}
          </ul>
        </div>
      ) : null}

      {plan.warnings.length > 0 ? (
        <ul className="plain-list rel-sub" aria-label="Export warnings">
          {plan.warnings.map((warning) => <li key={warning}><Banner tone="info" title="Warning">{warning}</Banner></li>)}
        </ul>
      ) : null}
      <Blockers
        // The server's "plan again" recovery actions re-run a plan this dialog does not hold, so they become its own controls.
        items={plan.blockers.map((blocker) => ({ ...blocker, inspectId: inspectTarget(blocker), recoveryActions: blocker.recoveryActions.filter((action) => action.operation !== "export.plan" && action.operation !== "export.inspect") }))}
        label="Export blockers"
        actions={(blocker) => {
          const { inspectId } = blocker;
          return (
            <>
              {blocker.code === "EMPTY_SELECTION" ? <button type="button" onClick={onConfirmEmpty}>Confirm empty export</button> : null}
              {inspectId ? <button type="button" onClick={() => onInspect(inspectId)}>Inspect the current export</button> : null}
            </>
          );
        }}
      >
        {(blocker) => blocker.code === "EXPORT_CONFLICT" ? (
          <div className="secondary">Nothing was changed. Files you own are never overwritten: move or restore the named files, or choose another export destination in the project settings, then plan again.</div>
        ) : null}
      </Blockers>
    </div>
  );
}
