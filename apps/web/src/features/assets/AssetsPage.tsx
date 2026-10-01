import { Link } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { CreateAssetForm } from "./CreateAssetForm.tsx";
import { isDefinitionMissing } from "./missing.ts";

export function AssetsPage() {
  const { root } = useProjectRoot();
  const list = useOperation("asset.list", {}, { enabled: root !== undefined });

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
            with <code>spec.write</code>, or you can write the YAML in the editor. You can also create a first definition here.
          </p>
        </EmptyState>
        <section className="panel" aria-labelledby="assets-create-heading">
          <h2 id="assets-create-heading">Create asset definition</h2>
          <CreateAssetForm primary />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Assets" />
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
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => (
              <tr key={asset.assetId}>
                <th scope="row"><Link to={`/assets/${encodeURIComponent(asset.assetId)}`}>{asset.name ?? asset.assetId}</Link></th>
                <td>{asset.family ?? "—"}</td>
                <td className="mono">{asset.assetId}</td>
                <td>
                  {asset.valid
                    ? <Status tone="ok">Valid</Status>
                    : isDefinitionMissing(asset.problems)
                      ? <Status tone="warn">Definition missing</Status>
                      : <Status tone="bad">Invalid — {asset.problems.length} {asset.problems.length === 1 ? "problem" : "problems"}</Status>}
                </td>
                <td>{asset.required ? <Status tone="info">Required</Status> : <Status tone="idle">Optional</Status>}</td>
                <td>{asset.deliverableCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="panel" style={{ marginTop: 16 }}>
        <summary>Create asset definition</summary>
        <CreateAssetForm primary={false} />
      </details>
    </>
  );
}
