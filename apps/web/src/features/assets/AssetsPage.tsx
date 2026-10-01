import { Link } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { FamilyChip, familyHint, splitProblems, useFamilies } from "../families/useFamilies.tsx";
import { ProductionState } from "../production/ProductionState.tsx";
import { isDefinitionMissing } from "./missing.ts";

export function AssetsPage() {
  const { root } = useProjectRoot();
  const list = useOperation("asset.list", {}, { enabled: root !== undefined });
  const families = useFamilies();

  if (root === undefined) {
    return (
      <>
        <PageHeader title="Assets" />
        <EmptyState title="No project selected">
          <p>Open a project to see its assets.</p>
          <Link className="button primary" to="/projects/open">Open a project</Link>
        </EmptyState>
      </>
    );
  }
  if (list.error) return <><PageHeader title="Assets" /><NetworkProblem error={list.error} /></>;
  if (!list.data) return <><PageHeader title="Assets" /><p className="secondary" role="status">Loading assets…</p></>;
  if (!list.data.ok) return <><PageHeader title="Assets" /><ErrorBanner error={list.data.error} /></>;

  const assets = list.data.data.assets;
  if (assets.length === 0) {
    return (
      <>
        <PageHeader title="Assets" />
        <EmptyState title="No assets yet">
          <p>
            Asset definitions live at <code>brainforge/assets/&lt;asset-id&gt;/asset.yaml</code>. An agent can author them
            with <code>spec.write</code>, or start one here from a family template.
          </p>
          <Link className="button primary" to="/assets/new">New asset</Link>
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Assets">
        <Link className="button primary" to="/assets/new">New asset</Link>
      </PageHeader>
      <div className="table-wrap">
        <table>
          <caption className="secondary">{assets.length} {assets.length === 1 ? "asset" : "assets"}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Family</th>
              <th scope="col">Id</th>
              <th scope="col">Validity</th>
              <th scope="col">Requirement</th>
              <th scope="col">Deliverables</th>
              <th scope="col">Production</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => (
              <tr key={asset.assetId}>
                <th scope="row"><Link to={`/assets/${encodeURIComponent(asset.assetId)}`}>{asset.name ?? asset.assetId}</Link></th>
                <td>
                  <FamilyChip family={asset.family} profile={families.profileOf(asset.family)} />
                  {families.profileOf(asset.family) ? <div className="secondary">{familyHint(families.profileOf(asset.family))}</div> : null}
                </td>
                <td className="mono">{asset.assetId}</td>
                <td>
                  {asset.valid
                    ? <><Status tone="ok">Valid</Status>{splitProblems(asset.problems).warnings.length > 0 ? <> <Status tone="warn">{splitProblems(asset.problems).warnings.length} {splitProblems(asset.problems).warnings.length === 1 ? "warning" : "warnings"}</Status></> : null}</>
                    : isDefinitionMissing(asset.problems)
                      ? <Status tone="warn">Definition missing</Status>
                      : <Status tone="bad">Invalid — {splitProblems(asset.problems).errors.length} {splitProblems(asset.problems).errors.length === 1 ? "problem" : "problems"}</Status>}
                </td>
                <td>{asset.required ? <Status tone="info">Required</Status> : <Status tone="idle">Optional</Status>}</td>
                <td>{asset.deliverableCount}</td>
                <td><ProductionState assetId={asset.assetId} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
