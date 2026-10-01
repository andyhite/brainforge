import type { AssetVersion, ExportRecord } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Status, type Tone } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";

export const STATE_LABEL: Record<AssetVersion["state"], string> = { active: "Active", promoted: "Promoted — not active", superseded: "Superseded" };
export const STATE_TONE: Record<AssetVersion["state"], Tone> = { active: "ok", promoted: "info", superseded: "idle" };

export function VersionStateBadge({ state }: { state: AssetVersion["state"] }) {
  return <Status tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Status>;
}

export function MatchBadge({ matches }: { matches: boolean }) {
  return matches ? <Status tone="ok">Matches current requirements</Status> : <Status tone="warn">Obsolete: requirements changed</Status>;
}

export interface CurrentExport {
  current: ExportRecord | undefined;
  pending: boolean;
  unavailable: boolean;
  exportedVersionId: (assetId: string) => string | undefined;
}

/** Which version of each asset the current committed export contains. Exported is independent of promoted and active. */
export function useCurrentExport(): CurrentExport {
  const { root } = useProjectRoot();
  const query = useOperation("export.list", { limit: 20 }, { enabled: root !== undefined });
  const current = query.data?.ok ? query.data.data.exports.find((record) => record.current && record.state === "committed") : undefined;
  return {
    current,
    pending: root !== undefined && !query.data && !query.error,
    unavailable: Boolean(query.error) || query.data?.ok === false,
    exportedVersionId: (assetId: string) => current?.selection.find((item) => item.assetId === assetId)?.versionId,
  };
}

export function ExportedTag({ label = "Exported" }: { label?: string }) {
  return <span className="rel-tag">{label}</span>;
}

/** The four release states, named once so no page merges the verbs. */
export function ReleaseKey() {
  return (
    <dl className="rel-key" aria-label="Release states">
      <div><dt>Reviewed</dt><dd>Outputs approved for each deliverable. Nothing is versioned yet.</dd></div>
      <div><dt>Promoted</dt><dd>An immutable version was created. It changes nothing else.</dd></div>
      <div><dt>Active</dt><dd>The one promoted version that counts as current.</dd></div>
      <div><dt>Exported</dt><dd>Copied to the game destination by a separate export.</dd></div>
    </dl>
  );
}

/** Compact per-asset production state: "v2 active", "v3 promoted — not active", "no version". */
export function ProductionState({ assetId }: { assetId: string }) {
  const { root } = useProjectRoot();
  const query = useOperation("version.list", { assetId }, { enabled: root !== undefined });
  if (query.error) return <span className="secondary">Unavailable</span>;
  if (!query.data) return <span className="secondary">Loading…</span>;
  if (!query.data.ok) return <span className="secondary">Unavailable</span>;
  const { versions, active } = query.data.data;
  const activeVersion = versions.find((version) => version.versionId === active.versionId);
  const newest = versions.reduce<AssetVersion | undefined>((best, version) => (!best || version.versionNumber > best.versionNumber ? version : best), undefined);
  if (versions.length === 0) return <Status tone="idle">No version</Status>;
  const pending = newest && newest.state === "promoted" ? newest : undefined;
  return (
    <span className="row" style={{ gap: 8 }}>
      {activeVersion ? <Status tone="ok">v{activeVersion.versionNumber} active</Status> : <Status tone="warn">No active version</Status>}
      {pending ? <Status tone="info">v{pending.versionNumber} promoted — not active</Status> : null}
    </span>
  );
}
