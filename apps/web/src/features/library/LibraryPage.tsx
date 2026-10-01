import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AssetSummary, AssetVersion } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { ExportedTag, ReleaseKey, useCurrentExport, type CurrentExport } from "../production/ProductionState.tsx";
import { FamilyChip, familyHint, useFamilies } from "../families/useFamilies.tsx";
import "../production/releases.css";

/** One asset's four release states plus the single next useful action. Promotion and activation stay on the Versions tab; export is its own page. */
function AssetRow({ asset, exported }: { asset: AssetSummary; exported: CurrentExport }) {
  const families = useFamilies();
  const { root } = useProjectRoot();
  const query = useOperation("version.list", { assetId: asset.assetId }, { enabled: root !== undefined });
  const versionsLink = `/assets/${encodeURIComponent(asset.assetId)}?step=versions`;
  const exportLink = `/export?asset=${encodeURIComponent(asset.assetId)}`;
  const profile = families.profileOf(asset.family);

  let production: ReactNode;
  let next: ReactNode;
  if (query.error || (query.data && !query.data.ok)) {
    production = <Status tone="warn">Production state unavailable</Status>;
    next = <Link to={versionsLink}>Open versions</Link>;
  } else if (!query.data) {
    production = <span className="secondary" role="status">Loading…</span>;
    next = null;
  } else {
    const { versions, active } = query.data.data;
    const activeVersion = versions.find((version) => version.versionId === active.versionId);
    const newest = versions.reduce<AssetVersion | undefined>((best, version) => (!best || version.versionNumber > best.versionNumber ? version : best), undefined);
    const waiting = newest && newest.state === "promoted" ? newest : undefined;
    const exportedId = exported.exportedVersionId(asset.assetId);
    const exportedVersion = versions.find((version) => version.versionId === exportedId);
    production = (
      <>
        <div className="rel-cell" data-cell="active">{activeVersion ? <Status tone="ok">v{activeVersion.versionNumber} active</Status> : <Status tone="idle">No active version</Status>}</div>
        {waiting ? <div className="rel-cell"><Status tone="info">v{waiting.versionNumber} promoted — not active</Status></div> : null}
      </>
    );
    if (versions.length === 0) next = <Link className="button" to={versionsLink}>Plan promotion</Link>;
    else if (waiting) next = <Link className="button primary" to={versionsLink}>Review v{waiting.versionNumber} to activate</Link>;
    else if (activeVersion && exportedId !== activeVersion.versionId) next = <Link className="button" to={exportLink}>Export v{activeVersion.versionNumber}</Link>;
    else if (!activeVersion) next = <Link className="button" to={versionsLink}>Choose active version</Link>;
    else next = <Link to={versionsLink}>Versions</Link>;
    return (
      <tr>
        <th scope="row" className="rel-asset">
          <Link to={versionsLink}>{asset.name ?? asset.assetId}</Link>
          <div className="rel-cell"><FamilyChip family={asset.family} profile={profile} /><span className="secondary">{familyHint(profile)}</span></div>
        </th>
        <td data-label="Promoted and active"><div style={{ display: "grid", gap: 4 }}>{production}</div></td>
        <td data-label="Exported">
          {!exported.current ? <span className="secondary">{exported.pending ? "Loading…" : exported.unavailable ? "Export state unavailable" : "Nothing exported"}</span>
            : exportedVersion ? <div className="rel-cell"><ExportedTag label={`v${exportedVersion.versionNumber} exported`} />{activeVersion && exportedVersion.versionId !== activeVersion.versionId ? <span className="secondary">active is v{activeVersion.versionNumber}</span> : null}</div>
            : <span className="secondary">Not in the current export</span>}
        </td>
        <td data-label="Next">{next}</td>
      </tr>
    );
  }
  return (
    <tr>
      <th scope="row" className="rel-asset"><Link to={versionsLink}>{asset.name ?? asset.assetId}</Link><div className="rel-cell"><FamilyChip family={asset.family} profile={profile} /></div></th>
      <td data-label="Promoted and active">{production}</td>
      <td data-label="Exported"><span className="secondary">—</span></td>
      <td data-label="Next">{next}</td>
    </tr>
  );
}

export function LibraryPage() {
  const { root } = useProjectRoot();
  const list = useOperation("asset.list", {}, { enabled: root !== undefined });
  const exported = useCurrentExport();
  if (root === undefined) return <><PageHeader title="Releases" /><EmptyState title="No project selected"><Link className="button primary" to="/projects/open">Open a project</Link></EmptyState></>;
  if (list.error) return <><PageHeader title="Releases" /><NetworkProblem error={list.error} /></>;
  if (!list.data) return <><PageHeader title="Releases" /><p className="secondary" role="status">Loading assets…</p></>;
  if (!list.data.ok) return <><PageHeader title="Releases" /><ErrorBanner error={list.data.error} /></>;
  const assets = list.data.data.assets;
  return (
    <div className="rel-page">
      <PageHeader title="Releases">
        <span className="rel-tools">
          <Link className="button" to="/export">Export…</Link>
          <Link className="button" to="/assets/new">New asset</Link>
        </span>
      </PageHeader>
      <ReleaseKey />
      <p className="rel-note">Promoted versions are immutable. A version becomes current only when you activate it, and reaches the game only when you export. Each step is separate.</p>
      {assets.length === 0 ? (
        <div className="rel-empty">
          <h2>No assets yet</h2>
          <p>Define an asset, review its deliverables, then promote a version here.</p>
          <Link className="button primary" to="/assets/new">New asset</Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="rel-ledger">
            <caption className="sr-only">Assets with promoted, active and exported versions</caption>
            <thead><tr><th scope="col">Asset</th><th scope="col">Promoted and active</th><th scope="col">Exported</th><th scope="col">Next</th></tr></thead>
            <tbody>{assets.map((asset) => <AssetRow key={asset.assetId} asset={asset} exported={exported} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
