import type { AssetVersion } from "@brainforge/contracts";
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
