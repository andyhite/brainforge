import { Link } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, PageHeader } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { ProductionState } from "../production/ProductionState.tsx";

/** Library: per-asset production state. Promotion and activation are separate actions on each asset's Versions tab; export arrives in M8. */
export function LibraryPage() {
  const { root } = useProjectRoot();
  const list = useOperation("asset.list", {}, { enabled: root !== undefined });
  if (root === undefined) return <><PageHeader title="Library" /><EmptyState title="No project selected"><Link className="button primary" to="/projects/open">Open a project</Link></EmptyState></>;
  if (list.error) return <><PageHeader title="Library" /><NetworkProblem error={list.error} /></>;
  if (!list.data) return <><PageHeader title="Library" /><p className="secondary" role="status">Loading…</p></>;
  if (!list.data.ok) return <><PageHeader title="Library" /><ErrorBanner error={list.data.error} /></>;
  const assets = list.data.data.assets;
  return (
    <div>
      <PageHeader title="Library" />
      <p className="secondary">Promoted versions are immutable; a version only becomes current when it is explicitly activated. Export is a separate step.</p>
      {assets.length === 0 ? <EmptyState title="No assets yet"><p>Define an asset first.</p></EmptyState> : (
        <ul className="plain-list" aria-label="Assets and their production versions">
          {assets.map((asset) => (
            <li key={asset.assetId} className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <Link to={`/assets/${encodeURIComponent(asset.assetId)}?step=versions`}>{asset.name ?? asset.assetId}</Link>
                <ProductionState assetId={asset.assetId} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
