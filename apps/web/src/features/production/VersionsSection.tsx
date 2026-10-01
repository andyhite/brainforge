import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ActiveSelection, AssetVersion } from "@brainforge/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, formatTime } from "../../components/ui.tsx";
import { ActivateDialog, isRestore } from "./ActivateDialog.tsx";
import { DeliverableThumb } from "./DeliverableThumb.tsx";
import { ExportedTag, MatchBadge, ReleaseKey, VersionStateBadge, useCurrentExport } from "./ProductionState.tsx";
import { PromotePanel } from "./PromotePanel.tsx";
import { VersionDetail } from "./VersionDetail.tsx";
import "./releases.css";

function VersionRecord({ version, versions, active, exported, onActivate }: {
  version: AssetVersion; versions: AssetVersion[]; active: ActiveSelection; exported: boolean; onActivate: (version: AssetVersion) => void;
}) {
  const [params, setParams] = useSearchParams();
  const selected = params.get("version") === version.versionId;
  const restore = isRestore(version, versions, active);
  const inspect = useOperation("version.inspect", { versionId: version.versionId });
  const deliverables = inspect.data?.ok ? inspect.data.data.manifest.deliverables : [];
  return (
    <li className="rel-version" data-state={version.state} aria-current={selected ? "true" : undefined}>
      <h3 className="rel-vnum" style={{ margin: 0 }}><span className="sr-only">Version </span>v{version.versionNumber}</h3>
      <div className="rel-vbody">
        <div className="rel-vstates">
          <VersionStateBadge state={version.state} />
          {exported ? <ExportedTag label="Exported (current export)" /> : null}
          <MatchBadge matches={version.matchesCurrent} />
        </div>
        <div className="rel-vmeta">
          Created by {version.createdBy} ({version.createdByType}) · <time dateTime={version.createdAt}>{formatTime(version.createdAt)}</time>
          {version.note ? <> · {version.note}</> : null}
        </div>
        {deliverables.length > 0 ? (
          <ul className="rel-thumbs" aria-label={`Deliverables in version ${version.versionNumber}`}>
            {deliverables.map((item) => (
              <li key={item.deliverableId}>
                <DeliverableThumb candidateId={item.candidateId} outputId={item.outputId} label={`${item.deliverableId} in version ${version.versionNumber}`} />
                <div>{item.deliverableId}</div>
              </li>
            ))}
          </ul>
        ) : <div className="rel-vmeta">{version.deliverableIds.join(", ")}</div>}
      </div>
      <div className="rel-vact">
        {version.state !== "active" ? (
          <button type="button" className={version.state === "promoted" && !restore ? "primary" : undefined} onClick={() => onActivate(version)}>{restore ? "Restore this version" : "Activate"}</button>
        ) : null}
        <button type="button" aria-pressed={selected} onClick={() => setParams((previous) => { const copy = new URLSearchParams(previous); if (selected) copy.delete("version"); else copy.set("version", version.versionId); return copy; })}>
          {selected ? "Hide details" : `Details for version ${version.versionNumber}`}
        </button>
      </div>
    </li>
  );
}

export function VersionsSection({ assetId, branchId, base }: { assetId: string; branchId: string | undefined; base: string }) {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const query = useOperation("version.list", { assetId });
  const exported = useCurrentExport();
  const [target, setTarget] = useState<AssetVersion | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const selectedId = params.get("version");
  const messageRef = useRef<HTMLDivElement>(null);
  // The Activate button disappears once its version is active, so focus moves to the confirmation.
  useEffect(() => { if (message) messageRef.current?.focus(); }, [message]);

  return (
    <div className="rel-split">
      <section className="rel-page" aria-labelledby="versions-title">
        <div className="rel-head">
          <h2 id="versions-title">Versions</h2>
          <span className="rel-tools">
            <Link className="button" to={`/export?asset=${encodeURIComponent(assetId)}`}>Export…</Link>
            <button type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["op"] })}>Refresh</button>
          </span>
        </div>
        <ReleaseKey />
        <div aria-live="polite" ref={messageRef} tabIndex={-1}>{message ? <Banner tone="ok" title={message} /> : null}</div>
        {query.error ? <NetworkProblem error={query.error} /> : !query.data ? <p className="secondary" role="status">Loading versions…</p> : !query.data.ok ? <ErrorBanner error={query.data.error} /> : (() => {
          const { versions, active } = query.data.data;
          const ordered = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
          const activeVersion = versions.find((version) => version.versionId === active.versionId);
          const exportedId = exported.exportedVersionId(assetId);
          const exportedNumber = versions.find((version) => version.versionId === exportedId)?.versionNumber;
          const exportText = exported.current
            ? (exportedNumber !== undefined ? `Current export contains version ${exportedNumber}` : exportedId ? "Current export contains another version" : "This asset is not in the current export")
            : exported.pending ? "Checking export…" : exported.unavailable ? "Export state unavailable" : "Nothing exported yet";
          return (
            <>
              <p className="rel-current" role="status">
                {activeVersion ? <span>Active: <strong>version {activeVersion.versionNumber}</strong>{active.activatedBy ? <> · by {active.activatedBy}{active.activatedByType ? ` (${active.activatedByType})` : ""}</> : null}</span> : <strong>No active version</strong>}
                <span className="secondary">{exportText}</span>
              </p>
              {ordered.length === 0 ? (
                <div className="rel-empty">
                  <h2>No versions yet</h2>
                  <p>Plan a promotion once every required deliverable is ready. Blockers appear beside the Start button.</p>
                </div>
              ) : (
                <ul className="rel-versions" aria-label="Versions, newest first">
                  {ordered.map((version) => <VersionRecord key={version.versionId} version={version} versions={versions} active={active} exported={version.versionId === exportedId} onActivate={setTarget} />)}
                </ul>
              )}
              {selectedId && versions.some((version) => version.versionId === selectedId) ? <VersionDetail key={selectedId} versionId={selectedId} /> : null}
              {target ? (
                <ActivateDialog
                  key={target.versionId} version={target} restore={isRestore(target, versions, active)} active={active}
                  open onOpenChange={(open) => { if (!open) setTarget(undefined); }}
                  onDone={setMessage}
                />
              ) : null}
            </>
          );
        })()}
      </section>
      <aside className="rel-aside" aria-label="Promotion">
        <PromotePanel assetId={assetId} branchId={branchId} base={base} activeVersionId={query.data?.ok ? query.data.data.active.versionId : undefined} onActivate={setTarget} />
      </aside>
    </div>
  );
}
