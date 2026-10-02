import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AssetSummary, AssetVersion, OperationData } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, Modal, NetworkProblem, PageHeader, Status, formatTime, timeAgo, type Tone } from "../../components/ui.tsx";
import { OutputArt } from "../../components/OutputArt.tsx";
import { paths } from "../../lib/paths.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { ExportDialog } from "../export/ExportDialog.tsx";
import { ExportHistory } from "../export/ExportHistory.tsx";
import { ActivateDialog, isRestore } from "../production/ActivateDialog.tsx";
import { PromotePanel } from "../production/PromotePanel.tsx";
import { progress } from "../../lib/next.ts";
import { ReleaseKey, activeOf, exportNeed, newestPromoted, useCurrentExport, useVersionLists, type CurrentExport, type VersionList } from "../production/state.tsx";
import "./releases.css";

type RequiredAsset = OperationData<"project.completeness">["requiredAssets"][number];

/** One sentence per asset, read by form: icon + words. */
function rowState(
  list: VersionList | null | undefined, req: RequiredAsset | undefined, active: AssetVersion | undefined, pending: AssetVersion | undefined,
  inGame: AssetVersion | undefined, obsolete: boolean, prog: { approved: number; total: number } | undefined,
): { loading?: boolean; tone: Tone; text: string } {
  if (list === undefined) return { loading: true, tone: "idle", text: "" };
  if (list === null) return { tone: "warn", text: "Versions unavailable" };
  if (pending) return { tone: "info", text: `Version ${pending.versionNumber} promoted, not active` };
  if (obsolete) return { tone: "warn", text: `Out of date: requirements changed after v${active?.versionNumber ?? req?.activeVersionNumber ?? 1}` };
  if (!active) {
    const missing = prog && prog.total > 0 ? `${prog.approved} of ${prog.total} approved` : undefined;
    if (list.versions.length > 0) return { tone: "info", text: "Promoted, but no version is active" };
    return { tone: "idle", text: missing ? `Nothing promoted yet: ${missing}` : "Nothing promoted yet" };
  }
  if (inGame) return { tone: "ok", text: `In the game · v${inGame.versionNumber}` };
  switch (req?.state) {
    case "needs-reassessment": return { tone: "warn", text: "Active, but some approvals need another look" };
    case "open-feedback": return { tone: "warn", text: "Active, but has open notes to resolve" };
    case "invalid-definition": return { tone: "warn", text: "Its definition has a problem" };
  }
  return { tone: "info", text: `Version ${active.versionNumber} active, not in the game yet` };
}

function ReleaseRow({ asset, req, list, exported, targeted, onPromote, onActivate }: {
  asset: AssetSummary; req: RequiredAsset | undefined; list: VersionList | null | undefined; exported: CurrentExport; targeted: boolean;
  onPromote: () => void; onActivate: (version: AssetVersion) => void;
}) {
  const name = asset.name ?? asset.assetId;
  const versions = list?.versions ?? [];
  const active = list ? activeOf(versions, list.active) : undefined;
  const pending = newestPromoted(versions, list?.active.versionId);
  const inGameId = exported.exportedVersionId(asset.assetId);
  const inGame = versions.find((version) => version.versionId === inGameId);
  const shown = active ?? inGame ?? versions.reduce<AssetVersion | undefined>((best, version) => (!best || version.versionNumber > best.versionNumber ? version : best), undefined);
  const inspect = useOperation("version.inspect", { versionId: shown?.versionId ?? "" }, { enabled: shown !== undefined });
  const steps = useOperation("step.list", { assetId: asset.assetId }, { enabled: list !== undefined });
  const first = inspect.data?.ok ? inspect.data.data.manifest.deliverables[0] : undefined;
  const concept = steps.data?.ok ? steps.data.data.steps.find((step) => step.stepId === "concept")?.selected : undefined;
  const prog = steps.data?.ok ? progress(steps.data.data.steps) : undefined;
  const canPromote = prog !== undefined && prog.total > 0 && prog.approved === prog.total;
  const obsolete = active !== undefined && !active.matchesCurrent || req?.state === "obsolete-version";
  const state = rowState(list, req, active, pending, inGame, obsolete, prog);

  return (
    <li id={`asset-${asset.assetId}`} className="rel-release" aria-current={targeted ? "true" : undefined}>
      <div className="rel-release-art">
        {first ? <OutputArt candidateId={first.candidateId} outputId={first.outputId} max={192} alt="" />
          : concept ? <OutputArt candidateId={concept.candidateId} outputId={concept.outputId} max={192} alt="" />
          : <div className="art empty" aria-hidden="true" />}
      </div>
      <div className="rel-release-main">
        <Link className="rel-release-link" to={paths.asset(asset.assetId)}><strong>{name}</strong></Link>
        {state.loading ? <span className="secondary" role="status">Loading…</span> : <div><Status tone={state.tone}>{state.text}</Status></div>}
      </div>
      <div className="rel-release-act">
        {pending ? <button type="button" onClick={() => onActivate(pending)}>Activate version {pending.versionNumber}…</button>
          : canPromote && (versions.length === 0 || obsolete) ? <button type="button" onClick={onPromote}>Promote…</button>
          : null}
      </div>
    </li>
  );
}

/** Releases: what’s in the game, and what can go in. Promotion, activation and export are three separate actions, each confirmed on its own. */
export function ReleasesPage() {
  const { root } = useProjectRoot();
  const [params] = useSearchParams();
  const target = params.get("asset");
  const list = useOperation("asset.list", {}, { enabled: root !== undefined });
  const completeness = useOperation("project.completeness", {}, { enabled: root !== undefined });
  const exported = useCurrentExport();
  const assets = list.data?.ok ? list.data.data.assets : [];
  const lists = useVersionLists(assets.map((asset) => asset.assetId));
  const [exporting, setExporting] = useState(false);
  const [promoteFor, setPromoteFor] = useState<string | undefined>(undefined);
  const [activate, setActivate] = useState<{ assetId: string; version: AssetVersion } | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inspectId, setInspectId] = useState<string | undefined>(undefined);
  const loaded = assets.length > 0;
  useEffect(() => { if (target && loaded) document.getElementById(`asset-${target}`)?.scrollIntoView({ block: "center" }); }, [target, loaded]);

  if (root === undefined) return <div className="page"><PageHeader title="Releases" /><EmptyState title="No project selected"><Link className="button primary" to={paths.openProject()}>Open a project</Link></EmptyState></div>;
  if (list.error) return <div className="page"><PageHeader title="Releases" /><NetworkProblem error={list.error} /></div>;
  if (!list.data) return <div className="page"><PageHeader title="Releases" /><p className="secondary" role="status">Loading assets…</p></div>;
  if (!list.data.ok) return <div className="page"><PageHeader title="Releases" /><ErrorBanner error={list.data.error} /></div>;

  const required = completeness.data?.ok ? completeness.data.data.requiredAssets : undefined;
  const reqById = new Map((required ?? []).map((item) => [item.assetId, item] as const));
  const inGameCount = required?.filter((item) => exported.exportedVersionId(item.assetId) !== undefined).length;
  const settled = assets.every((asset) => lists[asset.assetId] !== undefined);
  const need = exportNeed(assets, lists, exported);
  const hasActive = assets.some((asset) => lists[asset.assetId]?.active.versionId);
  const needed = settled && (need.changed.length > 0 || (!exported.current && hasActive));
  const lines = [...need.changed, ...need.obsolete];
  const ordered = [...assets].sort((a, b) => Number(reqById.has(b.assetId)) - Number(reqById.has(a.assetId)));
  const activateList = activate ? lists[activate.assetId] : undefined;
  const promoteAsset = assets.find((asset) => asset.assetId === promoteFor);

  const openInspect = (exportId: string) => {
    setExporting(false);
    setHistoryOpen(true);
    setInspectId(exportId);
    requestAnimationFrame(() => document.getElementById("rel-history")?.scrollIntoView({ block: "start" }));
  };

  return (
    <div className="page rel-page">
      <PageHeader
        title="Releases"
        lede={required && inGameCount !== undefined ? `${inGameCount} of ${required.length} required ${required.length === 1 ? "asset is" : "assets are"} in the game. Promoting, activating and exporting are separate steps.` : "What’s in the game, and what can go in? Promoting, activating and exporting are separate steps."}
      />
      <div aria-live="polite" className="rel-live">{message ? <p className="rel-done"><Status tone="ok">{message}</Status></p> : null}</div>

      <section aria-labelledby="rel-export-title">
        <div className="section-head"><h2 id="rel-export-title">Export</h2><span className="aside">Copies active versions into your game folder</span></div>
        <div className="panel rel-export-state">
          <div className="rel-export-text">
            {!settled || exported.pending ? <p className="secondary" role="status">Checking what’s in the game…</p>
              : exported.unavailable ? <Status tone="warn">Export state unavailable</Status>
              : !exported.current ? (
                <>
                  <Status tone="idle">Nothing has been exported yet</Status>
                  <p className="rel-meta">{hasActive ? "Export copies each asset’s active version into your game folder." : "No asset has an active version yet, so there is nothing to export."}</p>
                </>
              ) : need.changed.length > 0 || need.obsolete.length > 0 ? (
                <Status tone="warn">Out of date: {lines.length} {lines.length === 1 ? "asset differs" : "assets differ"} from the game. Reasons are listed per asset below.</Status>
              ) : <Status tone="ok">The game has every active version</Status>}
            {exported.current ? (
              <p className="rel-meta">
                Last exported <time dateTime={exported.current.committedAt ?? exported.current.createdAt} title={formatTime(exported.current.committedAt ?? exported.current.createdAt)}>{timeAgo(exported.current.committedAt ?? exported.current.createdAt)}</time> to <code>{exported.current.destination}</code>
              </p>
            ) : exported.destination ? <p className="rel-meta">Destination <code>{exported.destination}</code></p> : null}
          </div>
          <button type="button" className={needed ? "primary" : undefined} onClick={() => setExporting(true)}>Export…</button>
        </div>
        <details className="rel-history-disclosure" id="rel-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
          <summary>Past exports</summary>
          {historyOpen ? <ExportHistory selected={inspectId} onSelect={setInspectId} /> : null}
        </details>
      </section>

      <section className="section" aria-labelledby="rel-assets-title">
        <div className="section-head"><h2 id="rel-assets-title">Assets</h2><span className="aside">{assets.length} in this project</span></div>
        {assets.length === 0 ? (
          <EmptyState title="No assets yet">Define an asset, approve its deliverables, then promote a version to put it in the game.<Link className="button" to={paths.newAsset()}>New asset</Link></EmptyState>
        ) : (
          <ul className="rows" aria-label="Assets and their release state">
            {ordered.map((asset) => (
              <ReleaseRow
                key={asset.assetId} asset={asset} req={reqById.get(asset.assetId)} list={lists[asset.assetId]} exported={exported}
                targeted={asset.assetId === target} onPromote={() => setPromoteFor(asset.assetId)} onActivate={(version) => setActivate({ assetId: asset.assetId, version })}
              />
            ))}
          </ul>
        )}
      </section>

      <details className="section rel-how">
        <summary>How a version reaches the game</summary>
        <ReleaseKey />
      </details>

      {exporting ? <ExportDialog assets={assets} onClose={() => setExporting(false)} onInspect={openInspect} /> : null}
      {promoteAsset ? (
        <Modal wide open onOpenChange={(open) => { if (!open) setPromoteFor(undefined); }} title={`Promote ${promoteAsset.name ?? promoteAsset.assetId}`} description="See exactly what will be bundled first. Nothing is promoted until you start it, and promoting doesn’t activate or export.">
          <PromotePanel
            assetId={promoteAsset.assetId} branchId={undefined} activeVersionId={lists[promoteAsset.assetId]?.active.versionId} showHeading={false}
            onActivate={(version) => { setPromoteFor(undefined); setActivate({ assetId: promoteAsset.assetId, version }); }}
          />
        </Modal>
      ) : null}
      {activate && activateList ? (
        <ActivateDialog
          key={activate.version.versionId} version={activate.version} restore={isRestore(activate.version, activateList.versions, activateList.active)} active={activateList.active}
          open onOpenChange={(open) => { if (!open) setActivate(undefined); }} onDone={setMessage}
        />
      ) : null}
    </div>
  );
}
