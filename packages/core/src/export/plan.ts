import { readFile, readdir } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { z } from "zod";
import { ExportManifest, type ExportPlan, type ExportPreset, type ExportSelectionRow, type PlanBlocker, type RecoveryAction } from "@brainforge/contracts";
import { ExportError, animationJsonPath, assetJsonPath, atlasPagePath, checkGodotRoot, framePath, planGodotFiles, planSprites, spriteAtlasPath, spritesJsonPath, stillPath, type ExportAsset, type ExportInput, type GodotTarget } from "@brainforge/export";
import { resolveIn } from "@brainforge/storage";
import { discoverAuthored } from "../authored.ts";
import { normalizedHash } from "../operations.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { activeSelection, compareToCurrent, readManifest, verifyVersion, type VersionRow } from "../production/versions.ts";
import { ownedFileFindings, readCurrentView } from "./current.ts";
import { GatherProblem, gatherVersion } from "./gather.ts";

const Request = z.object({ assetIds: z.array(z.string()).optional(), versions: z.record(z.string(), z.string()).optional(), confirmEmpty: z.boolean() });
export type ExportRequest = z.infer<typeof Request>;

export interface ExportRow {
  export_id: string; preset: ExportPreset; destination: string; state: "prepared" | "committed" | "failed"; selection_json: string;
  manifest_sha256: string | null; release_path: string; created_by: string; created_at: string; committed_at: string | null;
  warnings_json: string; error: string | null; request_id: string; replaces_export_id: string | null; retired_at: string | null;
}

/** Everything a start must find unchanged, plus the data it publishes. */
export interface ExportEvaluation {
  preset: ExportPreset;
  destination: string;
  godotProjectRoot?: string;
  destinationAbs?: string;
  godot?: GodotTarget;
  selection: ExportSelectionRow[];
  assets: ExportAsset[];
  /** Version manifest hashes, part of the plan hash. */
  manifestHashes: Record<string, string>;
  leaving: { assetId: string; versionId: string }[];
  leavingResourceKinds: string[];
  replacesExportId?: string;
  current?: { exportId: string; manifestSha256: string };
  fileCount: number;
  blockers: PlanBlocker[];
  warnings: string[];
}

const action = (label: string, operation: string, input?: Record<string, unknown>): RecoveryAction => ({ label, operation, ...(input ? { input } : {}) });
const fixProject = (what: string): RecoveryAction => action(`Read project.yaml, then correct ${what} with spec.write`, "spec.read", { path: "brainforge/project.yaml" });

/** The committed, not-yet-retired export a destination currently holds according to project state. */
export function currentExportRow(open: OpenProject, destination: string): ExportRow | undefined {
  return open.db.query<ExportRow | null, [string]>(
    "SELECT * FROM exports WHERE destination = ? AND state = 'committed' AND retired_at IS NULL ORDER BY rowid DESC LIMIT 1",
  ).get(destination) ?? undefined;
}

/** Normalised game-relative destination, or the reason it is unusable. */
function cleanDestination(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = posix.normalize(raw.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (value === "" || value === "." || value.startsWith("..") || value.startsWith("/")) return { ok: false, message: `export.destination "${raw}" must be a folder inside the game directory (not the game root, not outside it)` };
  if (value === "brainforge" || value.startsWith("brainforge/")) return { ok: false, message: `export.destination "${raw}" is inside brainforge/, which Brainforge owns; choose a game folder such as assets/brainforge` };
  return { ok: true, value };
}

/** Rows of `selection_json`: the assets and versions an export contains. */
export const SelectionJson = z.array(z.object({ assetId: z.string(), versionId: z.string() }));

const StoredPlan = z.object({ request: Request });


const GODOT_KINDS: [string, string][] = [["/animations.tres", "SpriteFrames"], ["/textures/", "AtlasTexture"], ["/styleboxes/", "StyleBoxTexture"], ["/tilesets/", "TileSet"]];

/** Resource kinds the current export has that the next one (without Godot output) will not. */
function godotKindsIn(manifest: ExportManifest | undefined): string[] {
  if (!manifest) return ["godot resources"];
  const kinds = new Set<string>();
  for (const f of manifest.ownedFiles) for (const [needle, kind] of GODOT_KINDS) if (f.path.includes("/godot/") && f.path.includes(needle)) kinds.add(kind);
  return [...kinds].sort();
}

/** Snapshot-relative paths the next export will write, per the documented layout. */
function plannedPaths(e: ExportEvaluation, godotPaths: string[]): string[] {
  const out = ["manifest.json", ...godotPaths];
  for (const asset of e.assets) {
    out.push(assetJsonPath(asset.assetId));
    const sprites = planSprites(asset);
    const atlasOnly = new Set(sprites?.packaging === "atlas" ? sprites.members.map((m) => m.deliverableId) : []);
    for (const d of asset.deliverables) {
      if (d.media.kind === "still") {
        if (!atlasOnly.has(d.deliverableId)) out.push(stillPath(asset.assetId, d.deliverableId));
        continue;
      }
      out.push(animationJsonPath(asset.assetId, d.deliverableId));
      if (d.media.packaging !== "atlas") for (const f of d.media.frames) out.push(framePath(asset.assetId, d.deliverableId, f.index));
      if (d.media.packaging !== "frames") (d.media.atlasPages ?? []).forEach((_, page) => out.push(atlasPagePath(asset.assetId, d.deliverableId, page)));
    }
    if (sprites) {
      out.push(spritesJsonPath(asset.assetId));
      sprites.layout.pages.forEach((_, page) => out.push(spriteAtlasPath(asset.assetId, page)));
    }
  }
  return out;
}

/** Unowned files in the current release that a managed path equals, sits under, or contains (same rule as publication). */
async function unownedCollisions(releaseAbs: string, planned: string[]): Promise<string[]> {
  const manifest = ExportManifest.safeParse(JSON.parse(await readFile(join(releaseAbs, "manifest.json"), "utf8")));
  if (!manifest.success) return [];
  const owned = new Set([...manifest.data.ownedFiles.map((f) => f.path), "manifest.json"]);
  const files = await readdir(releaseAbs, { recursive: true, withFileTypes: true });
  const unowned = files.filter((f) => f.isFile()).map((f) => posix.relative(releaseAbs.split(sep).join("/"), `${f.parentPath.split(sep).join("/")}/${f.name}`)).filter((p) => !owned.has(p));
  const next = new Set(planned);
  return unowned.filter((p) => {
    const parts = p.split("/");
    return next.has(p) || parts.slice(1).some((_, i) => next.has(parts.slice(0, i + 1).join("/"))) || planned.some((o) => o.startsWith(`${p}/`));
  }).sort();
}

export async function evaluateExport(open: OpenProject, request: ExportRequest): Promise<ExportEvaluation> {
  const blockers: PlanBlocker[] = [];
  const warnings: string[] = [];
  const set = await discoverAuthored(open.root);
  const project = set.project?.spec;
  const evaluation: ExportEvaluation = {
    preset: project?.export.preset ?? "generic", destination: project?.export.destination ?? "", selection: [], assets: [], manifestHashes: {},
    leaving: [], leavingResourceKinds: [], fileCount: 0, blockers, warnings,
  };

  // --- settings
  if (!project) {
    blockers.push({ code: "EXPORT_SETTINGS", message: "brainforge/project.yaml is missing or invalid, so export.preset and export.destination are unknown", recoveryActions: [fixProject("export")] });
    return evaluation;
  }
  const dest = cleanDestination(project.export.destination);
  if (!dest.ok) {
    blockers.push({ code: "EXPORT_SETTINGS", message: `${dest.message} (field export.destination)`, recoveryActions: [fixProject("export.destination")] });
    return evaluation;
  }
  evaluation.destination = dest.value;
  evaluation.godotProjectRoot = project.export.godotProjectRoot;
  try {
    evaluation.destinationAbs = await resolveIn(open.root, dest.value);
  } catch (e) {
    blockers.push({ code: "EXPORT_SETTINGS", message: `export.destination "${dest.value}" is not usable: ${e instanceof Error ? e.message : String(e)}`, recoveryActions: [fixProject("export.destination")] });
    return evaluation;
  }
  const destinationAbs = evaluation.destinationAbs;

  // --- the destination as project state and disk describe it
  const dbCurrent = currentExportRow(open, dest.value);
  const disk = await readCurrentView(destinationAbs);
  if (disk.kind === "conflict") {
    blockers.push({ code: "EXPORT_CONFLICT", message: `${disk.message}. Nothing was changed.`, recoveryActions: [action("Check the export history", "export.list")] });
  } else if (disk.kind === "release") {
    if (!dbCurrent || dbCurrent.export_id !== disk.exportId || dbCurrent.manifest_sha256 !== disk.manifestSha256) {
      blockers.push({
        code: "EXPORT_CONFLICT",
        message: `${dest.value}/current points to release ${disk.exportId}, which project state does not record as the current export. It was preserved: restore the matching project snapshot or choose another export.destination.`,
        recoveryActions: [action("Check the export history", "export.list")],
      });
    } else {
      evaluation.current = { exportId: disk.exportId, manifestSha256: disk.manifestSha256 ?? "" };
      evaluation.replacesExportId = disk.exportId;
      if (disk.manifest) {
        const findings = await ownedFileFindings(join(destinationAbs, ".releases", disk.exportId), disk.manifest);
        const modified = findings.filter((f) => f.reason.startsWith("modified"));
        if (modified.length > 0) {
          blockers.push({
            code: "EXPORT_CONFLICT",
            message: `Exported file(s) were modified outside Brainforge: ${modified.slice(0, 5).map((f) => f.path).join(", ")}${modified.length > 5 ? ` (+${modified.length - 5} more)` : ""}. They are preserved; restore or move them, then plan again.`,
            recoveryActions: [action("Inspect the current export", "export.inspect", { exportId: disk.exportId })],
          });
        }
        const missing = findings.length - modified.length;
        if (missing > 0) warnings.push(`${missing} previously exported file(s) were deleted outside Brainforge and will be regenerated.`);
      }
    }
  } else if (dbCurrent) {
    warnings.push(`The recorded current export ${dbCurrent.export_id} has no ${dest.value}/current pointer on disk; this export will be published as a first export.`);
  }

  // --- which versions
  const known = new Set(open.db.query<{ asset_id: string }, []>("SELECT DISTINCT asset_id FROM asset_versions").all().map((r) => r.asset_id));
  const wanted = new Set<string>();
  if (request.assetIds) for (const id of request.assetIds) wanted.add(id);
  else {
    for (const id of known) if (activeSelection(open.db, id).versionId !== null) wanted.add(id);
    for (const id of project.requirements.assets) wanted.add(id);
  }
  for (const id of Object.keys(request.versions ?? {})) wanted.add(id);

  const chosen: { row: VersionRow; source: "active" | "explicit" | "member"; active: string | null; direct: boolean; via?: string }[] = [];
  for (const assetId of [...wanted].sort()) {
    const active = activeSelection(open.db, assetId);
    const pin = request.versions?.[assetId];
    if (pin) {
      const row = open.db.query<VersionRow | null, [string, string]>("SELECT * FROM asset_versions WHERE version_id = ? AND asset_id = ?").get(pin, assetId);
      if (!row) {
        blockers.push({ code: "VERSION_NOT_FOUND", message: `Version ${pin} is not a promoted version of ${assetId}`, recoveryActions: [action(`List versions of ${assetId}`, "version.list", { assetId })] });
        continue;
      }
      chosen.push({ row, source: "explicit", active: active.versionId, direct: true });
    } else if (active.versionId === null) {
      blockers.push({
        code: "NO_ACTIVE_VERSION",
        message: `${assetId} has no active version, so it cannot be exported. ${known.has(assetId) ? "Activate a promoted version (a separate decision), or pin a specific version in this export." : "Nothing has been promoted for it yet."}`,
        recoveryActions: known.has(assetId) ? [action(`List versions of ${assetId}`, "version.list", { assetId }), action("Activate a version", "version.activate")] : [action(`Plan promotion of ${assetId}`, "promotion.plan", { assetId })],
      });
    } else {
      const row = open.db.query<VersionRow | null, [string]>("SELECT * FROM asset_versions WHERE version_id = ?").get(active.versionId);
      if (row) chosen.push({ row, source: "active", active: active.versionId, direct: request.assetIds?.includes(assetId) === true });
    }
  }

  // --- an environment version brings the member versions it pinned. A member chosen directly at another version is
  // left alone here: the dependency check below reports it as EXPORT_CONFLICT naming both versions. An implicit
  // (active-default) selection of a member yields to the aggregate's pin.
  for (const aggregate of [...chosen]) {
    const read = await readManifest(open, aggregate.row);
    if (!("manifest" in read)) continue; // reported by the verification below
    for (const pin of read.manifest.members ?? []) {
      const at = chosen.findIndex((c) => c.row.asset_id === pin.assetId);
      const existing = chosen[at];
      if (existing?.row.version_id === pin.versionId) continue;
      if (existing && (existing.direct || existing.source === "member")) continue;
      const row = open.db.query<VersionRow | null, [string, string]>("SELECT * FROM asset_versions WHERE version_id = ? AND asset_id = ?").get(pin.versionId, pin.assetId);
      if (!row) {
        blockers.push({ code: "VERSION_NOT_FOUND", message: `${aggregate.row.asset_id} pins ${pin.assetId} at version ${pin.versionId}, which is not a promoted version of ${pin.assetId}`, recoveryActions: [action(`List versions of ${pin.assetId}`, "version.list", { assetId: pin.assetId })] });
        continue;
      }
      const member = { row, source: "member" as const, active: activeSelection(open.db, pin.assetId).versionId, direct: false, via: `${aggregate.row.asset_id} version ${aggregate.row.version_number}` };
      if (existing) chosen[at] = member;
      else chosen.push(member);
    }
  }
  if (chosen.length === 0 && blockers.length === 0) {
    if (!request.confirmEmpty) {
      blockers.push({ code: "EMPTY_SELECTION", message: "No asset has an active version, so this export would contain nothing and remove everything currently exported. Confirm an empty export explicitly if that is intended.", recoveryActions: [action("Plan again, confirming the empty export", "export.plan", { confirmEmpty: true })] });
    } else {
      warnings.push("Empty export: current will contain no assets.");
    }
  }

  // --- verify and map each version
  for (const { row, source, active, via } of chosen) {
    const problems = await verifyVersion(open, row);
    const read = await readManifest(open, row);
    if (problems.length > 0 || !("manifest" in read)) {
      blockers.push({
        code: "VERSION_CORRUPT",
        message: `Version ${row.version_number} of ${row.asset_id} does not verify against its manifest: ${problems.length > 0 ? problems.slice(0, 3).join("; ") : "error" in read ? read.error : "unreadable"}`,
        recoveryActions: [action("Inspect the version", "version.inspect", { versionId: row.version_id })],
      });
      continue;
    }
    const manifest = read.manifest;
    const notes: string[] = [];
    const { matchesCurrent } = compareToCurrent(open, set, manifest);
    if (source === "member") notes.push(`Pinned by ${via ?? "an environment aggregate"}; included at exactly that version.`);
    if (source === "explicit") {
      if (active !== row.version_id) notes.push(active ? "Not the asset's active version." : "The asset has no active version.");
      if (!matchesCurrent) notes.push("No longer matches the asset's current requirements.");
    }
    evaluation.selection.push({ assetId: row.asset_id, versionId: row.version_id, versionNumber: row.version_number, source, matchesCurrent, notes });
    evaluation.manifestHashes[row.version_id] = row.manifest_sha256;
    try {
      evaluation.assets.push(await gatherVersion(open, project, set.assets.find((a) => a.fileId === row.asset_id)?.spec, row, manifest));
    } catch (e) {
      if (!(e instanceof GatherProblem)) throw e;
      blockers.push({ code: "VERSION_UNEXPORTABLE", message: e.message, recoveryActions: [action("Inspect the version", "version.inspect", { versionId: row.version_id })] });
    }
  }

  // --- a selected asset pinned at a different version than another selected asset depends on
  const selectedVersions = new Map(evaluation.selection.map((s) => [s.assetId, s.versionId]));
  for (const asset of evaluation.assets) {
    for (const dep of asset.dependencies) {
      const chosenVersion = selectedVersions.get(dep.assetId);
      if (chosenVersion && chosenVersion !== dep.versionId) {
        blockers.push({
          code: "EXPORT_CONFLICT",
          message: `${asset.assetId} pins ${dep.assetId} at version ${dep.versionId}, but this export selects ${chosenVersion}. Select the pinned version or a version of ${asset.assetId} that matches.`,
          recoveryActions: [action("Plan again with matching versions", "export.plan")],
        });
      }
    }
  }

  // --- what leaves current
  const selectedIds = new Set(evaluation.selection.map((s) => s.assetId));
  const currentRow = dbCurrent && evaluation.current ? dbCurrent : undefined;
  if (currentRow) {
    const previous = SelectionJson.parse(JSON.parse(currentRow.selection_json));
    evaluation.leaving = previous.filter((p) => !selectedIds.has(p.assetId));
    if (evaluation.leaving.length > 0) warnings.push(`${evaluation.leaving.length} previously exported asset(s) will leave current: ${evaluation.leaving.map((l) => l.assetId).join(", ")}.`);
    if (currentRow.preset === "godot4" && evaluation.preset === "generic") {
      const disk2 = await readCurrentView(destinationAbs);
      evaluation.leavingResourceKinds = godotKindsIn(disk2.kind === "release" ? disk2.manifest : undefined);
      warnings.push(`Switching from godot4 to generic removes the Godot resources (${evaluation.leavingResourceKinds.join(", ")}) from current.`);
    }
  }

  // --- preset specifics
  if (evaluation.preset === "godot4") {
    const godotAbs = await resolveIn(open.root, project.export.godotProjectRoot).catch(() => undefined);
    if (!godotAbs) {
      blockers.push({ code: "EXPORT_BLOCKED", message: `export.godotProjectRoot "${project.export.godotProjectRoot}" is not a folder inside the game directory (field godotProjectRoot)`, recoveryActions: [fixProject("export.godotProjectRoot")] });
    } else {
      const check = await checkGodotRoot({ godotProjectRootAbs: godotAbs, destinationAbs });
      if (!check.ok) {
        for (const b of check.blockers) blockers.push({ code: "EXPORT_BLOCKED", message: `${b.message} (field ${b.field === "godotProjectRoot" ? "export.godotProjectRoot" : "export.destination"})`, recoveryActions: [fixProject(b.field === "godotProjectRoot" ? "export.godotProjectRoot" : "export.destination")] });
      } else {
        evaluation.godot = { projectRootAbs: godotAbs, resRootPrefix: check.resRootPrefix };
      }
    }
  }

  evaluation.fileCount = countFiles(evaluation);
  if (evaluation.godot && blockers.length === 0) {
    try {
      evaluation.fileCount += planGodotFiles(toInput(evaluation, open.projectId, "plan", "")).length;
    } catch (e) {
      if (!(e instanceof ExportError)) throw e;
      blockers.push({ code: "EXPORT_BLOCKED", message: `Godot resources cannot be written: ${e.message}`, recoveryActions: [action("Inspect the asset definition", "asset.inspect")] });
    }
  }
  if (evaluation.current && !blockers.some((b) => b.code === "EXPORT_CONFLICT")) {
    const godotPaths = evaluation.godot && blockers.length === 0 ? planGodotFiles(toInput(evaluation, open.projectId, "plan", "")).map((f) => f.path) : [];
    const clash = await unownedCollisions(join(destinationAbs, ".releases", evaluation.current.exportId), plannedPaths(evaluation, godotPaths));
    for (const path of clash) {
      blockers.push({
        code: "EXPORT_CONFLICT",
        message: `an unowned file at ${path} would be overwritten by managed output; move it or rename the asset/deliverable`,
        recoveryActions: [action("Inspect the current export", "export.inspect", { exportId: evaluation.current.exportId })],
      });
    }
  }
  return evaluation;
}

/** Files the generic layout writes (Godot resources are counted separately). One definition with the collision check. */
const countFiles = (e: ExportEvaluation): number => plannedPaths(e, []).length;

export function toInput(e: ExportEvaluation, projectId: string, exportId: string, createdAt: string): ExportInput {
  return { projectId, exportId, preset: e.preset, createdAt, ...(e.godot ? { godot: e.godot } : {}), assets: e.assets };
}

/** Hash of everything a start must find unchanged. Excludes the plan id and creation time. */
export function exportHash(e: ExportEvaluation, request: ExportRequest): string {
  return normalizedHash({
    preset: e.preset, destination: e.destination, godotProjectRoot: e.godotProjectRoot ?? null, current: e.current ?? null,
    selection: e.selection.map((s) => [s.assetId, s.versionId, s.source, e.manifestHashes[s.versionId]]), confirmEmpty: request.confirmEmpty,
    blockers: e.blockers.map((b) => [b.code, b.message]),
  });
}

export function toExportPlan(e: ExportEvaluation, request: ExportRequest, planId: string, createdAt: string): ExportPlan {
  return {
    planId, planHash: exportHash(e, request), preset: e.preset, destination: e.destination,
    publicRoot: e.destination ? `${e.destination}/current` : "",
    ...(e.preset === "godot4" && e.godotProjectRoot ? { godotProjectRoot: e.godotProjectRoot } : {}),
    ...(e.godot ? { resRoot: `${e.godot.resRootPrefix}/current` } : {}),
    selection: e.selection, leaving: e.leaving, leavingResourceKinds: e.leavingResourceKinds,
    ...(e.replacesExportId ? { replacesExportId: e.replacesExportId } : {}),
    fileCount: e.fileCount, blockers: e.blockers, warnings: e.warnings, createdAt,
  };
}

export function storeExportPlan(open: OpenProject, plan: ExportPlan, request: ExportRequest, actorId: string): void {
  open.db.query("INSERT INTO export_plans (plan_id, plan_hash, plan_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(plan.planId, plan.planHash, JSON.stringify({ plan, request }), actorId, plan.createdAt);
}

export function loadExportPlan(open: OpenProject, planId: string): { planHash: string; request: ExportRequest } {
  const row = open.db.query<{ plan_hash: string; plan_json: string }, [string]>("SELECT plan_hash, plan_json FROM export_plans WHERE plan_id = ?").get(planId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No export plan ${planId}`, undefined, [action("Plan the export", "export.plan")]);
  return { planHash: row.plan_hash, request: StoredPlan.parse(JSON.parse(row.plan_json)).request };
}
