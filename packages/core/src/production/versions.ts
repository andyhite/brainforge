import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ProductionManifest, type ActivationEvent, type ActiveSelection, type AssetVersion } from "@brainforge/contracts";
import { resolveIn } from "@brainforge/storage";
import type { AuthoredSet } from "../authored.ts";
import { buildPipeline } from "../pipeline.ts";
import type { OpenProject } from "../project-runtime.ts";
import { stepRequirementsHash } from "../review/requirements.ts";
import { OperationFailure } from "../runtime.ts";
import { aggregateRequirements } from "./plan.ts";
import { verifyDirectory } from "./publish.ts";

export interface VersionRow {
  version_id: string; asset_id: string; version_number: number; branch_id: string; requirements_hash: string; manifest_sha256: string;
  directory: string; created_by: string; created_by_type: "human" | "agent" | "system"; created_at: string; note: string | null; request_id: string;
}

export interface Difference { field: string; version: unknown; current: unknown }

export function versionRow(db: Database, versionId: string): VersionRow {
  const row = db.query<VersionRow, [string]>("SELECT * FROM asset_versions WHERE version_id = ?").get(versionId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No version ${versionId}`, undefined, [{ label: "List versions", operation: "version.list" }]);
  return row;
}

export function versionRows(db: Database, assetId: string): VersionRow[] {
  return db.query<VersionRow, [string]>("SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version_number DESC").all(assetId);
}

interface ActiveRow { asset_id: string; version_id: string | null; revision: number; activated_by: string | null; activated_by_type: "human" | "agent" | "system" | null; activated_at: string | null; acknowledged_obsolete: number }

/** An asset with no row has never had a selection: revision 0, nothing active. */
export function activeSelection(db: Database, assetId: string): ActiveSelection {
  const row = db.query<ActiveRow, [string]>("SELECT * FROM active_versions WHERE asset_id = ?").get(assetId);
  if (!row) return { assetId, versionId: null, revision: 0 };
  return {
    assetId, versionId: row.version_id, revision: row.revision,
    ...(row.activated_by ? { activatedBy: row.activated_by } : {}), ...(row.activated_by_type ? { activatedByType: row.activated_by_type } : {}),
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}), acknowledgedObsolete: row.acknowledged_obsolete === 1,
  };
}

export function activationEvents(db: Database, assetId: string, versionId?: string): ActivationEvent[] {
  const rows = db.query<{ event_id: string; asset_id: string; from_version_id: string | null; to_version_id: string; kind: "activate" | "restore"; actor_id: string; actor_type: "human" | "agent" | "system"; acknowledged_obsolete: number; reason: string | null; created_at: string }, [string]>(
    "SELECT * FROM activation_events WHERE asset_id = ? ORDER BY created_at DESC, rowid DESC",
  ).all(assetId);
  return rows
    .filter((r) => versionId === undefined || r.to_version_id === versionId || r.from_version_id === versionId)
    .map((r) => ({
      eventId: r.event_id, assetId: r.asset_id, fromVersionId: r.from_version_id, toVersionId: r.to_version_id, kind: r.kind, actorId: r.actor_id, actorType: r.actor_type,
      acknowledgedObsolete: r.acknowledged_obsolete === 1, ...(r.reason ? { reason: r.reason } : {}), createdAt: r.created_at,
    }));
}

/** The manifest as it is on disk now, or the reason it cannot be read. */
export async function readManifest(open: OpenProject, row: VersionRow): Promise<{ manifest: ProductionManifest } | { error: string }> {
  const text = await resolveIn(open.root, join(row.directory, "manifest.json")).then((abs) => readFile(abs, "utf8"), () => undefined).catch(() => undefined);
  if (text === undefined) return { error: "manifest.json is missing" };
  try {
    return { manifest: ProductionManifest.parse(JSON.parse(text)) };
  } catch (e) {
    return { error: `manifest.json is unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Hash-check every file of a version against its manifest. Empty means intact. */
export async function verifyVersion(open: OpenProject, row: VersionRow): Promise<string[]> {
  const abs = await resolveIn(open.root, row.directory).catch(() => undefined);
  if (!abs) return ["the version directory path is invalid"];
  return (await verifyDirectory(abs, row.manifest_sha256)).problems;
}

/**
 * How a version differs from what the asset requires now. `specSnapshots.*` entries are informational (an edited
 * file is not by itself an unmet requirement); every other entry makes the version not match current requirements.
 */
export function compareToCurrent(open: OpenProject, set: AuthoredSet, manifest: ProductionManifest): { differences: Difference[]; matchesCurrent: boolean } {
  const differences: Difference[] = [];
  const spec = set.assets.find((a) => a.fileId === manifest.assetId)?.spec;
  if (!spec) {
    differences.push({ field: "asset", version: manifest.assetId, current: "missing or invalid asset.yaml" });
    return { differences, matchesCurrent: false };
  }
  const nodes = buildPipeline(spec).nodes.filter((n) => n.id !== "concept");
  const ids = new Set(nodes.map((n) => n.id));
  const current: Record<string, string> = { concept: stepRequirementsHash(open, set, manifest.assetId, "concept") };
  for (const id of Object.keys(manifest.stepRequirements)) {
    if (id !== "concept" && ids.has(id)) current[id] = stepRequirementsHash(open, set, manifest.assetId, id, manifest.branchId);
  }

  if (current.concept !== manifest.stepRequirements.concept) differences.push({ field: "stepRequirements.concept", version: manifest.stepRequirements.concept, current: current.concept });
  const inVersion = new Set(manifest.deliverables.map((d) => d.deliverableId));
  for (const id of inVersion) {
    if (!ids.has(id)) differences.push({ field: `deliverables.${id}`, version: "included", current: "no longer defined by asset.yaml" });
    else if (current[id] !== manifest.stepRequirements[id]) differences.push({ field: `stepRequirements.${id}`, version: manifest.stepRequirements[id], current: current[id] });
  }
  const missing = nodes.filter((n) => n.required && !inVersion.has(n.id)).map((n) => n.id);
  if (missing.length > 0) differences.push({ field: "deliverables.missing", version: [...inVersion], current: missing });
  if (aggregateRequirements(current) !== manifest.requirementsHash) differences.unshift({ field: "requirementsHash", version: manifest.requirementsHash, current: aggregateRequirements(current) });
  for (const pin of manifest.dependencyVersions) {
    if (!open.db.query("SELECT 1 FROM asset_versions WHERE version_id = ? AND asset_id = ?").get(pin.versionId, pin.assetId)) {
      differences.push({ field: `dependencyVersions.${pin.assetId}`, version: pin.versionId, current: "no such version" });
    }
  }
  const matchesCurrent = differences.length === 0;
  for (const [path, hash] of Object.entries(manifest.specSnapshots)) {
    const now = set.all().find((f) => f.path === path)?.hash ?? null;
    if (now !== hash) differences.push({ field: `specSnapshots.${path}`, version: hash, current: now });
  }
  return { differences, matchesCurrent };
}

/** The API shape of a version row. A version whose manifest cannot be read never matches current requirements. */
export async function describeVersion(open: OpenProject, set: AuthoredSet, row: VersionRow, active: ActiveSelection): Promise<{ version: AssetVersion; manifest?: ProductionManifest; differences: Difference[]; readError?: string }> {
  const read = await readManifest(open, row);
  const compared = "manifest" in read ? compareToCurrent(open, set, read.manifest) : { differences: [{ field: "manifest", version: row.manifest_sha256, current: read.error }], matchesCurrent: false };
  const wasActive = open.db.query("SELECT 1 FROM activation_events WHERE to_version_id = ? LIMIT 1").get(row.version_id) !== null;
  const version: AssetVersion = {
    versionId: row.version_id, versionNumber: row.version_number, assetId: row.asset_id, branchId: row.branch_id, requirementsHash: row.requirements_hash,
    manifestSha256: row.manifest_sha256, directory: row.directory, createdBy: row.created_by, createdByType: row.created_by_type, createdAt: row.created_at,
    ...(row.note ? { note: row.note } : {}),
    state: active.versionId === row.version_id ? "active" : wasActive ? "superseded" : "promoted",
    matchesCurrent: compared.matchesCurrent,
    deliverableIds: open.db.query<{ deliverable_id: string }, [string]>("SELECT deliverable_id FROM version_deliverables WHERE version_id = ? ORDER BY deliverable_id").all(row.version_id).map((r) => r.deliverable_id),
  };
  return { version, ...("manifest" in read ? { manifest: read.manifest } : { readError: read.error }), differences: compared.differences };
}
