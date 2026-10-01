import type { CollectionState, PlanBlocker } from "@brainforge/contracts";
import type { AuthoredSet } from "../authored.ts";
import type { OpenProject } from "../project-runtime.ts";
import { activeSelection, versionRows } from "../production/versions.ts";

/**
 * Each member of an environment's collection with where it stands in production: no version, promoted (not active),
 * or active. A required member without an ACTIVE version blocks the aggregate (it defaults to active versions), and
 * the blocker names what is missing. Undefined for an asset without `collection.members`.
 */
export function collectionState(open: OpenProject, set: AuthoredSet, assetId: string): CollectionState | undefined {
  const declared = set.assets.find((a) => a.fileId === assetId)?.spec?.collection?.members;
  if (!declared || declared.length === 0) return undefined;
  const members = [...new Map(declared.map((m) => [m.assetId, m])).values()].map((m) => {
    const versions = versionRows(open.db, m.assetId);
    const active = activeSelection(open.db, m.assetId).versionId;
    const state: "no-version" | "promoted" | "active" = active !== null ? "active" : versions.length > 0 ? "promoted" : "no-version";
    return { assetId: m.assetId, required: m.required, state, ...(active ? { activeVersionId: active } : {}), ...(versions[0] ? { latestVersionId: versions[0].version_id } : {}) };
  });
  const lacking = members.filter((m) => m.required && m.state !== "active");
  const blockers: PlanBlocker[] = lacking.length === 0 ? [] : [{
    code: "COLLECTION_INCOMPLETE",
    message: `Required member(s) of ${assetId}: ${lacking.map((m) => `${m.assetId} (${m.state === "no-version" ? "no version" : "promoted, not active"})`).join(", ")}. The aggregate pins active versions by default.`,
    recoveryActions: lacking.map((m) => (m.state === "no-version"
      ? { label: `Plan promotion of ${m.assetId}`, operation: "promotion.plan", input: { assetId: m.assetId } }
      : { label: `List versions of ${m.assetId}`, operation: "version.list", input: { assetId: m.assetId } })),
  }];
  return { members, complete: lacking.length === 0, blockers };
}
