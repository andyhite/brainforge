import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ActiveSelection, AssetVersion } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, EmptyState, gate, Status, timeAgo, formatTime } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { progress } from "../../lib/next.ts";
import { paths } from "../../lib/paths.ts";
import { whoLabel } from "../review/room-lib.ts";
import { ActivateDialog, isRestore } from "./ActivateDialog.tsx";
import { DeliverableThumb } from "./DeliverableThumb.tsx";
import { PromotePanel } from "./PromotePanel.tsx";
import { activeOf, useCurrentExport } from "./state.tsx";
import { VersionDetail } from "./VersionDetail.tsx";
import "./releases.css";

function VersionRow({ version, versions, active, inGame, onActivate }: {
  version: AssetVersion; versions: AssetVersion[]; active: ActiveSelection; inGame: boolean; onActivate: (version: AssetVersion) => void;
}) {
  const [params, setParams] = useSearchParams();
  const selected = params.get("version") === version.versionId;
  const restore = isRestore(version, versions, active);
  const inspect = useOperation("version.inspect", { versionId: version.versionId });
  const deliverables = inspect.data?.ok ? inspect.data.data.manifest.deliverables : [];
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => { if (selected) row.current?.scrollIntoView({ block: "center" }); }, [selected]);
  const setOpen = (open: boolean) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (open) next.set("version", version.versionId);
    else next.delete("version");
    return next;
  }, { replace: true });
  return (
    <li ref={row} className="rel-version" data-state={version.state} aria-current={selected ? "true" : undefined}>
      <div className="rel-version-main">
        <h3>Version {version.versionNumber}</h3>
        <div className="rel-stamps">
          {version.state === "active" ? <span className="stamp ok"><Icon name="check" />Active</span>
            : version.state === "promoted" ? <span className="stamp">Promoted, not active</span>
            : <span className="stamp">Replaced</span>}
          {inGame ? <span className="stamp ok"><Icon name="package" />In the game</span> : null}
          {!version.matchesCurrent ? <Status tone="warn">Out of date: requirements changed</Status> : null}
        </div>
        <div className="rel-meta">
          Saved <time dateTime={version.createdAt} title={formatTime(version.createdAt)}>{timeAgo(version.createdAt)}</time> by {whoLabel(version.createdBy).toLowerCase()}
          {version.note ? <> · {version.note}</> : null}
        </div>
        {deliverables.length > 0 ? (
          <ul className="rel-thumbs" aria-label={`Outputs in version ${version.versionNumber}`}>
            {deliverables.map((item) => (
              <li key={item.deliverableId}>
                <DeliverableThumb candidateId={item.candidateId} outputId={item.outputId} label={`${item.deliverableId}, version ${version.versionNumber}`} />
                <span>{item.deliverableId}</span>
              </li>
            ))}
          </ul>
        ) : <div className="rel-meta">{version.deliverableIds.join(", ")}</div>}
      </div>
      {version.state !== "active" ? (
        <div className="rel-version-act">
          <button type="button" onClick={() => onActivate(version)}>{restore ? `Restore version ${version.versionNumber}…` : `Activate version ${version.versionNumber}…`}</button>
        </div>
      ) : null}
      <details className="rel-version-details" open={selected} onToggle={(event) => { if (event.currentTarget.open !== selected) setOpen(event.currentTarget.open); }}>
        <summary>Details</summary>
        {selected ? <VersionDetail versionId={version.versionId} /> : null}
      </details>
    </li>
  );
}

/** The Versions tab: every saved version, promote a new one, activate or restore. Renders inside the asset layout. */
export function AssetVersions() {
  const { assetId = "" } = useParams();
  const [params] = useSearchParams();
  const branchId = params.get("branch") ?? undefined;
  const query = useOperation("version.list", { assetId }, { enabled: assetId !== "" });
  const steps = useOperation("step.list", { assetId, ...(branchId ? { branchId } : {}) }, { enabled: assetId !== "" });
  const exported = useCurrentExport();
  const [target, setTarget] = useState<AssetVersion | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const messageRef = useRef<HTMLDivElement>(null);
  // The Activate button disappears once its version is active, so focus moves to the confirmation.
  useEffect(() => { if (message) messageRef.current?.focus(); }, [message]);

  const g = gate(query, "Loading versions…");
  const list = query.data?.ok ? query.data.data : undefined;
  const ordered = list ? [...list.versions].sort((a, b) => b.versionNumber - a.versionNumber) : [];
  const activeVersion = list ? activeOf(list.versions, list.active) : undefined;
  const exportedId = exported.exportedVersionId(assetId);
  const exportedVersion = list?.versions.find((version) => version.versionId === exportedId);
  const counts = steps.data?.ok ? progress(steps.data.data.steps) : undefined;

  return (
    <div className="rel-split">
      <section aria-labelledby="versions-title">
        <div className="section-head">
          <h2 id="versions-title">Versions</h2>
          <span className="aside">Newest first</span>
        </div>
        <div aria-live="polite" ref={messageRef} tabIndex={-1}>{message ? <Banner tone="ok" title={message} /> : null}</div>
        {"node" in g ? g.node : list && (
          ordered.length === 0 ? (
            <EmptyState title="No versions yet">
              Promoting needs every required deliverable approved
              {counts ? <>; {counts.approved} of {counts.total} {counts.total === 1 ? "is" : "are"} approved now</> : null}.
              Once they are, plan a promotion here to save them as version 1.
            </EmptyState>
          ) : (
            <>
              <p className="rel-current">
                {activeVersion ? <span>Active: <strong>version {activeVersion.versionNumber}</strong>{list.active.activatedBy ? <> · by {whoLabel(list.active.activatedBy).toLowerCase()}</> : null}</span> : <strong>No active version</strong>}
                <span className="secondary">
                  {exported.current ? (exportedVersion ? `The game has version ${exportedVersion.versionNumber}` : "This asset isn’t in the game") : exported.pending ? "Checking the game…" : exported.unavailable ? "Game state unavailable" : "Nothing in the game yet"}
                  {" · "}<Link to={paths.releases({ asset: assetId })}>Releases</Link>
                </span>
              </p>
              <ul className="rows rel-versions" aria-label="Versions, newest first">
                {ordered.map((version) => <VersionRow key={version.versionId} version={version} versions={list.versions} active={list.active} inGame={version.versionId === exportedId} onActivate={setTarget} />)}
              </ul>
              {target ? (
                <ActivateDialog
                  key={target.versionId} version={target} restore={isRestore(target, list.versions, list.active)} active={list.active}
                  open onOpenChange={(open) => { if (!open) setTarget(undefined); }}
                  onDone={setMessage}
                />
              ) : null}
            </>
          )
        )}
      </section>
      <aside className="rel-aside" aria-label="Promotion">
        <PromotePanel assetId={assetId} branchId={branchId} activeVersionId={list?.active.versionId} onActivate={setTarget} autoPlan={params.has("plan")} />
      </aside>
    </div>
  );
}
