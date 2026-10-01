import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ActiveSelection, AssetVersion } from "@brainforge/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, formatTime } from "../../components/ui.tsx";
import { ActivateDialog, isRestore } from "./ActivateDialog.tsx";
import { DeliverableThumb } from "./DeliverableThumb.tsx";
import { MatchBadge, VersionStateBadge } from "./ProductionState.tsx";
import { PromotePanel } from "./PromotePanel.tsx";
import { VersionDetail } from "./VersionDetail.tsx";

function VersionCard({ assetId, version, versions, active, onActivate }: {
  assetId: string; version: AssetVersion; versions: AssetVersion[]; active: ActiveSelection; onActivate: (version: AssetVersion) => void;
}) {
  const [params, setParams] = useSearchParams();
  const selected = params.get("version") === version.versionId;
  const restore = isRestore(version, versions, active);
  const inspect = useOperation("version.inspect", { versionId: version.versionId });
  const deliverables = inspect.data?.ok ? inspect.data.data.manifest.deliverables : [];
  return (
    <li className="version-card" aria-current={selected ? "true" : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Version {version.versionNumber}</h3>
        <span className="row" style={{ gap: 8 }}>
          <VersionStateBadge state={version.state} />
          <MatchBadge matches={version.matchesCurrent} />
        </span>
      </div>
      <div className="secondary">
        Created by {version.createdBy} ({version.createdByType}) · <time dateTime={version.createdAt}>{formatTime(version.createdAt)}</time>
        {version.note ? <> · {version.note}</> : null}
      </div>
      {deliverables.length > 0 ? (
        <ul className="thumb-strip" aria-label={`Deliverables in version ${version.versionNumber}`}>
          {deliverables.map((item) => (
            <li key={item.deliverableId}>
              <DeliverableThumb candidateId={item.candidateId} outputId={item.outputId} label={`${item.deliverableId} in version ${version.versionNumber}`} />
              <div className="secondary">{item.deliverableId}</div>
            </li>
          ))}
        </ul>
      ) : <div className="secondary">{version.deliverableIds.join(", ")}</div>}
      <div className="row" style={{ marginTop: 8 }}>
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
  const [target, setTarget] = useState<AssetVersion | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const selectedId = params.get("version");
  const messageRef = useRef<HTMLDivElement>(null);
  // The Activate button disappears once its version is active, so focus moves to the confirmation.
  useEffect(() => { if (message) messageRef.current?.focus(); }, [message]);

  return (
    <>
      <PromotePanel assetId={assetId} branchId={branchId} base={base} activeVersionId={query.data?.ok ? query.data.data.active.versionId : undefined} onActivate={setTarget} />
      <section className="panel" aria-labelledby="versions-title">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="versions-title" style={{ margin: 0 }}>Versions</h2>
          <span className="row" style={{ gap: 8 }}>
            <Link className="button" to={`/export?asset=${encodeURIComponent(assetId)}`}>Export…</Link>
            <button type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["op"] })}>Refresh</button>
          </span>
        </div>
        <div aria-live="polite" ref={messageRef} tabIndex={-1}>{message ? <Banner tone="ok" title={message} /> : null}</div>
        {query.error ? <NetworkProblem error={query.error} /> : !query.data ? <p className="secondary" role="status">Loading versions…</p> : !query.data.ok ? <ErrorBanner error={query.data.error} /> : (() => {
          const { versions, active } = query.data.data;
          const ordered = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
          const activeVersion = versions.find((version) => version.versionId === active.versionId);
          return (
            <>
              <p role="status">
                {activeVersion ? <>Active: <strong>version {activeVersion.versionNumber}</strong>{active.activatedBy ? <> · by {active.activatedBy}{active.activatedByType ? ` (${active.activatedByType})` : ""}</> : null}</> : <strong>No active version</strong>}
              </p>
              {ordered.length === 0 ? <p className="secondary">No versions yet. Plan a promotion above once every required deliverable is ready.</p> : (
                <ul className="plain-list version-list" aria-label="Versions, newest first">
                  {ordered.map((version) => <VersionCard key={version.versionId} assetId={assetId} version={version} versions={versions} active={active} onActivate={setTarget} />)}
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
    </>
  );
}
