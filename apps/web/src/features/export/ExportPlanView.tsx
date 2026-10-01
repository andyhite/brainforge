import type { ExportPlan, PlanBlocker } from "@brainforge/contracts";
import { Link } from "react-router-dom";
import { ActionLinks, Banner, Status } from "../../components/ui.tsx";

function inspectTarget(blocker: PlanBlocker): string | undefined {
  for (const action of blocker.recoveryActions) {
    const input: unknown = action.input;
    if (action.operation === "export.inspect" && typeof input === "object" && input !== null && "exportId" in input && typeof input.exportId === "string") return input.exportId;
  }
  return undefined;
}

function Blocker({ blocker, onConfirmEmpty, onInspect }: { blocker: PlanBlocker; onConfirmEmpty: () => void; onInspect: (exportId: string) => void }) {
  const isEmpty = blocker.code === "EMPTY_SELECTION";
  // The server's "plan again" recovery actions re-run a plan this page does not hold, so they become this page's own controls.
  const remote = blocker.recoveryActions.filter((action) => action.operation !== "export.plan" && action.operation !== "export.inspect");
  const guidance = remote.filter((action) => !action.url && !(action.operation && action.input !== undefined));
  const inspectId = inspectTarget(blocker);
  const assetId = /^([a-z0-9-]+) has no active version/.exec(blocker.message)?.[1];
  return (
    <Banner
      tone="warn" title={blocker.code.replaceAll("_", " ").toLowerCase()}
      actions={
        <>
          {isEmpty ? <button type="button" onClick={onConfirmEmpty}>Confirm empty export</button> : null}
          {assetId ? <Link className="button" to={`/assets/${encodeURIComponent(assetId)}?step=versions`}>Open {assetId} versions</Link> : null}
          {inspectId ? <button type="button" onClick={() => onInspect(inspectId)}>Inspect the current export</button> : null}
          <ActionLinks actions={remote} />
        </>
      }
    >
      {blocker.message}
      {guidance.map((action) => <div key={action.label} className="secondary">{action.label}</div>)}
      {blocker.code === "EXPORT_CONFLICT" ? (
        <div className="secondary">Nothing was changed. Files you own are never overwritten: move or restore the named files, or choose another <code>export.destination</code>, then plan again.</div>
      ) : null}
    </Banner>
  );
}

export function ExportPlanView({ plan, onConfirmEmpty, onInspect }: { plan: ExportPlan; onConfirmEmpty: () => void; onInspect: (exportId: string) => void }) {
  return (
    <div>
      <p>
        Preset <strong>{plan.preset}</strong> · {plan.fileCount} {plan.fileCount === 1 ? "file" : "files"} will be owned by this export · stable path <code>{plan.publicRoot}</code>
      </p>
      <div className="table-wrap">
        <table>
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
                <th scope="row"><Link to={`/assets/${encodeURIComponent(row.assetId)}?step=versions&version=${encodeURIComponent(row.versionId)}`}>{row.assetId}</Link></th>
                <td>v{row.versionNumber}</td>
                <td>
                  {row.source === "explicit" ? <Status tone="info">Pinned by you</Status> : row.source === "member" ? <Status tone="idle">Collection member</Status> : <Status tone="ok">Active version</Status>}
                </td>
                <td>{row.matchesCurrent ? <Status tone="ok">Matches current</Status> : <Status tone="warn">Obsolete: requirements changed</Status>}</td>
                <td>{row.notes.length === 0 ? "—" : <ul className="plain-list">{row.notes.map((note) => <li key={note}>{note}</li>)}</ul>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {plan.leaving.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <h3>Assets that will leave current</h3>
          <p className="secondary">These are in the current export but not in this one. Their promoted versions are not deleted.</p>
          <ul aria-label="Assets that will leave current">
            {plan.leaving.map((item) => <li key={item.assetId}><span className="mono">{item.assetId}</span> (version <span className="mono">{item.versionId.slice(0, 8)}</span>)</li>)}
          </ul>
        </div>
      ) : null}
      {plan.leavingResourceKinds.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <h3>Resource types that will leave current</h3>
          <p className="secondary">Switching preset removes these from the next snapshot.</p>
          <ul aria-label="Resource types that will leave current">
            {plan.leavingResourceKinds.map((kind) => <li key={kind}>{kind}</li>)}
          </ul>
        </div>
      ) : null}

      {plan.warnings.length > 0 ? (
        <ul className="plain-list" aria-label="Export warnings" style={{ marginTop: 16 }}>
          {plan.warnings.map((warning) => <li key={warning}><Banner tone="info" title="Warning">{warning}</Banner></li>)}
        </ul>
      ) : null}
      {plan.blockers.length > 0 ? (
        <ul className="plain-list" aria-label="Export blockers" style={{ marginTop: 16 }}>
          {plan.blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}><Blocker blocker={blocker} onConfirmEmpty={onConfirmEmpty} onInspect={onInspect} /></li>)}
        </ul>
      ) : null}
    </div>
  );
}
