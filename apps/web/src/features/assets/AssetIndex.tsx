import { useState } from "react";
import { Link } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { FamilyChip, splitProblems, useFamilies } from "../families/useFamilies.tsx";
import { ProductionState } from "../production/ProductionState.tsx";
import { isDefinitionMissing } from "./missing.ts";
import "./workbench.css";

type Filter = "all" | "required" | "optional" | "invalid";

/** Searchable, filterable list of every asset with validity, requirement and production state. */
export function AssetIndex() {
  const { root } = useProjectRoot();
  const list = useOperation("asset.list", {}, { enabled: root !== undefined });
  const families = useFamilies();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  if (root === undefined) {
    return (
      <EmptyState title="No project selected">
        <p>Open a project to see its assets.</p>
        <Link className="button primary" to="/projects/open">Open a project</Link>
      </EmptyState>
    );
  }
  if (list.error) return <NetworkProblem error={list.error} />;
  if (!list.data) return <p className="secondary" role="status">Loading assets…</p>;
  if (!list.data.ok) return <ErrorBanner error={list.data.error} />;

  const assets = list.data.data.assets;
  if (assets.length === 0) {
    return (
      <EmptyState title="No assets yet">
        <p>
          Asset definitions live at <code>brainforge/assets/&lt;asset-id&gt;/asset.yaml</code>. An agent can author them
          with <code>spec.write</code>, or start one here from a family template.
        </p>
        <Link className="button primary" to="/assets/new">New asset</Link>
      </EmptyState>
    );
  }
  const needle = query.trim().toLowerCase();
  const shown = assets.filter((asset) => {
    if (needle && !`${asset.name ?? ""} ${asset.assetId} ${asset.family}`.toLowerCase().includes(needle)) return false;
    return filter === "required" ? asset.required : filter === "optional" ? !asset.required : filter === "invalid" ? !asset.valid : true;
  });

  return (
    <section className="asset-index" aria-labelledby="asset-index-title">
      <h2 id="asset-index-title">Assets ({shown.length} of {assets.length})</h2>
      <div className="index-tools">
        <label className="sr-only" htmlFor="index-search">Search assets</label>
        <input id="index-search" type="search" placeholder="Search name, id or family" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className="sr-only" htmlFor="index-filter">Filter assets</label>
        <select id="index-filter" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
          <option value="all">All assets</option>
          <option value="required">Required</option>
          <option value="optional">Optional</option>
          <option value="invalid">Needs a valid definition</option>
        </select>
        <Link className="button primary" to="/assets/new">New asset</Link>
      </div>
      {shown.length === 0 ? <p className="secondary">No assets match.</p> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Family</th>
                <th scope="col">Id</th>
                <th scope="col">Definition</th>
                <th scope="col">Requirement</th>
                <th scope="col">Deliverables</th>
                <th scope="col">Production</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((asset) => {
                const { errors, warnings } = splitProblems(asset.problems);
                return (
                  <tr key={asset.assetId}>
                    <th scope="row"><Link to={`/assets/${encodeURIComponent(asset.assetId)}`}>{asset.name ?? asset.assetId}</Link></th>
                    <td><FamilyChip family={asset.family} profile={families.profileOf(asset.family)} /></td>
                    <td className="mono">{asset.assetId}</td>
                    <td>
                      {asset.valid
                        ? <><Status tone="ok">Valid</Status>{warnings.length > 0 ? <> <Status tone="warn">{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</Status></> : null}</>
                        : isDefinitionMissing(asset.problems)
                          ? <Status tone="warn">Definition missing</Status>
                          : <Status tone="bad">Invalid — {errors.length} {errors.length === 1 ? "problem" : "problems"}</Status>}
                    </td>
                    <td>{asset.required ? <Status tone="info">Required</Status> : <Status tone="idle">Optional</Status>}</td>
                    <td>{asset.deliverableCount}</td>
                    <td><ProductionState assetId={asset.assetId} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
