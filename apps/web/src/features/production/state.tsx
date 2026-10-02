import { useQueries } from "@tanstack/react-query";
import type { AssetVersion, ExportRecord, OperationData } from "@brainforge/contracts";
import { callOperation } from "../../api/client.ts";
import { useOperation } from "../../api/hooks.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";

export type VersionList = OperationData<"version.list">;

/** The version `active` points at, if it is in the list. */
export function activeOf(versions: readonly AssetVersion[], active: { versionId?: string | null }): AssetVersion | undefined {
  return versions.find((version) => version.versionId === active.versionId);
}

/** version.list for many assets at once, on the same cache keys as `useOperation("version.list")`. undefined = loading, null = unavailable. */
export function useVersionLists(assetIds: readonly string[]): Record<string, VersionList | null | undefined> {
  const { root } = useProjectRoot();
  const results = useQueries({
    queries: assetIds.map((assetId) => ({
      queryKey: ["op", "version.list", root ?? null, { assetId }],
      queryFn: ({ signal }: { signal: AbortSignal }) => callOperation("version.list", { project: root, input: { assetId }, signal }),
      enabled: root !== undefined,
      retry: false,
    })),
  });
  const lists: Record<string, VersionList | null | undefined> = {};
  assetIds.forEach((assetId, index) => {
    const query = results[index];
    lists[assetId] = query?.error ? null : query?.data ? (query.data.ok ? query.data.data : null) : undefined;
  });
  return lists;
}

export interface CurrentExport {
  current: ExportRecord | undefined;
  /** Game-root-relative destination from project.yaml, when the server reports one. */
  destination: string | undefined;
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
    destination: query.data?.ok ? query.data.data.destination : undefined,
    pending: root !== undefined && !query.data && !query.error,
    unavailable: Boolean(query.error) || query.data?.ok === false,
    exportedVersionId: (assetId: string) => current?.selection.find((item) => item.assetId === assetId)?.versionId,
  };
}

export interface ExportNeed {
  /** Something active is not in the game, or an exported asset lost its active version. Exporting would change the game. */
  changed: string[];
  /** The game has what is active, but that version no longer matches the asset's requirements. */
  obsolete: string[];
}

/** What differs between the current export and what is active now, in plain sentences naming each asset. */
export function exportNeed(assets: ReadonlyArray<{ assetId: string; name?: string | undefined }>, lists: Record<string, VersionList | null | undefined>, exported: CurrentExport): ExportNeed {
  const changed: string[] = [];
  const obsolete: string[] = [];
  for (const asset of assets) {
    const list = lists[asset.assetId];
    if (!list) continue;
    const name = asset.name ?? asset.assetId;
    const active = activeOf(list.versions, list.active);
    const exportedId = exported.exportedVersionId(asset.assetId);
    const inGame = list.versions.find((version) => version.versionId === exportedId);
    if (active && active.versionId !== exportedId) {
      changed.push(inGame ? `${name}: version ${active.versionNumber} is active, the game has version ${inGame.versionNumber}` : `${name}: version ${active.versionNumber} is not in the game yet`);
    } else if (!active && exportedId) {
      changed.push(`${name}: no longer has an active version`);
    } else if (active && !active.matchesCurrent) {
      obsolete.push(`${name}: its requirements changed after version ${active.versionNumber}`);
    }
  }
  return { changed, obsolete };
}

/** The newest promoted version that is newer than the active one: what "Activate version N…" offers. */
export function newestPromoted(versions: readonly AssetVersion[], activeId: string | null | undefined): AssetVersion | undefined {
  const floor = versions.find((version) => version.versionId === activeId)?.versionNumber ?? 0;
  return versions
    .filter((version) => version.state === "promoted" && version.versionNumber > floor)
    .reduce<AssetVersion | undefined>((best, version) => (!best || version.versionNumber > best.versionNumber ? version : best), undefined);
}

/** The four release states, named once so no screen merges the verbs. */
export function ReleaseKey() {
  return (
    <dl className="rel-key" aria-label="How a version reaches the game">
      <div><dt>Approved</dt><dd>Outputs you approved for each deliverable. Nothing is versioned yet.</dd></div>
      <div><dt>Promoted</dt><dd>An immutable version is saved. Nothing else changes.</dd></div>
      <div><dt>Active</dt><dd>The one promoted version that counts as current.</dd></div>
      <div><dt>In the game</dt><dd>Copied to the game folder by a separate export.</dd></div>
    </dl>
  );
}
