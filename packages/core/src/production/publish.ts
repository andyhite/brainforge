import { chmod, constants, copyFile, mkdir, open as openFile, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ProductionManifest, type ActorType, type ProductionDeliverable, type ProductionFile } from "@brainforge/contracts";
import { paths, resolveIn, sha256, writeFileAtomic } from "@brainforge/storage";
import { newId } from "../generation/store.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import type { Evaluation, SourceFile } from "./plan.ts";

export const PROMOTION_INTENT_KIND = "promotion";

/** Test-only crash points; release server construction never takes them from any outside input. */
export type PromotionFault = "fail-before-publish" | "fail-after-rename-before-commit";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Payload = z.object({
  versionId: z.string(),
  assetId: z.string(),
  branchId: z.string(),
  versionNumber: z.number().int().positive(),
  requestId: z.string(),
  note: z.string().nullable(),
  actorId: z.string(),
  actorType: z.enum(["human", "agent", "system"]),
  createdAt: z.string(),
  requirementsHash: Sha,
  /** Exact manifest.json bytes; its hash is the version's identity. */
  manifestText: z.string(),
  manifestSha256: Sha,
  deliverables: z.array(z.object({ deliverableId: z.string(), candidateId: z.string(), outputId: z.string(), outputHash: Sha, decisionId: z.string(), reusedFromVersionId: z.string().nullable() })),
});
type Payload = z.infer<typeof Payload>;

const dirOf = (p: Payload): string => paths.versionDir(p.assetId, p.versionId);

async function syncDir(abs: string): Promise<void> {
  const fh = await openFile(abs, "r");
  try { await fh.sync(); } finally { await fh.close(); }
}

/** Problems found comparing a directory to its manifest: unreadable manifest, hash drift, missing or changed files. */
export async function verifyDirectory(abs: string, expectedManifestSha256: string): Promise<{ manifest?: ProductionManifest; problems: string[] }> {
  const problems: string[] = [];
  const text = await readFile(join(abs, "manifest.json"), "utf8").catch(() => undefined);
  if (text === undefined) return { problems: ["manifest.json is missing"] };
  if (sha256(text) !== expectedManifestSha256) problems.push("manifest.json no longer matches the hash recorded at promotion");
  let manifest: ProductionManifest;
  try {
    manifest = ProductionManifest.parse(JSON.parse(text));
  } catch (e) {
    return { problems: [...problems, `manifest.json is unreadable: ${e instanceof Error ? e.message : String(e)}`] };
  }
  for (const f of manifest.files) {
    const bytes = await readFile(join(abs, f.path)).catch(() => undefined);
    if (!bytes) problems.push(`${f.path} is missing`);
    else if (sha256(bytes) !== f.sha256) problems.push(`${f.path} no longer matches its recorded hash`);
  }
  return { manifest, problems };
}

function buildManifest(e: Evaluation, versionId: string, actorId: string, createdAt: string): { manifest: ProductionManifest; files: SourceFile[] } {
  const files: SourceFile[] = [...(e.concept.file ? [e.concept.file] : []), ...e.rows.flatMap((r) => r.files)];
  const dependedOn = new Set(e.rows.flatMap((r) => r.dependsOn));
  const deliverables: ProductionDeliverable[] = e.rows.map((r) => {
    if (!r.row.candidateId || !r.row.outputId || !r.row.outputHash || !r.decisionId) {
      throw new OperationFailure("STEP_BLOCKED", `Deliverable ${r.row.deliverableId} is not ready to publish`);
    }
    return {
      deliverableId: r.row.deliverableId, kind: r.row.kind, required: r.row.required, candidateId: r.row.candidateId, outputId: r.row.outputId, outputHash: r.row.outputHash,
      ...(r.sourceOutputId ? { sourceOutputId: r.sourceOutputId } : {}), ...(r.recipeHash ? { recipeHash: r.recipeHash } : {}),
      decisionId: r.decisionId, files: r.files.map((f) => f.dest), ...(r.row.reusesVersionId ? { reusedFromVersionId: r.row.reusesVersionId } : {}),
    };
  });
  const productionFiles: ProductionFile[] = files.map((f) => ({ path: f.dest, sha256: f.sha256, mediaType: f.mediaType, size: f.size }));
  const manifest: ProductionManifest = {
    schema: "brainforge.production.v2", versionId, versionNumber: e.nextVersionNumber, assetId: e.assetId, branchId: e.branchId,
    requirementsHash: e.requirementsHash, specSnapshots: e.specSnapshots, stepRequirements: e.stepRequirements, deliverables, dependencyVersions: e.dependencyVersions,
    ...(e.memberPins.length > 0 || e.collectionMembers.length > 0 ? { members: e.memberPins, collectionMembers: e.collectionMembers } : {}),
    references: [
      { role: "concept", candidateId: e.concept.candidateId, outputId: e.concept.outputId, outputHash: e.concept.outputHash, ...(e.concept.file ? { path: e.concept.file.dest } : {}) },
      ...e.rows.filter((r) => dependedOn.has(r.row.deliverableId)).map((r) => ({
        role: r.row.deliverableId, deliverableId: r.row.deliverableId, candidateId: r.row.candidateId!, outputId: r.row.outputId!, outputHash: r.row.outputHash!,
      })),
      // The environment output each deliverable was generated against, so an aggregate can check the member against its own branch.
      ...e.rows.flatMap((r) => (r.directions ?? []).map((d) => ({
        role: `direction:${d.name}@${d.assetId}/${d.branchId}`, deliverableId: r.row.deliverableId, candidateId: d.candidateId, outputId: d.conceptOutputId, outputHash: d.outputHash,
      }))),
    ],
    files: productionFiles, reviewDecisionIds: deliverables.map((d) => d.decisionId), createdBy: actorId, createdAt,
  };
  return { manifest, files };
}

/** Insert the version rows (idempotently) and mark the intent committed, in one transaction. The active selection is never touched. */
function commit(open: OpenProject, intentId: string, p: Payload): void {
  const now = new Date().toISOString();
  open.transact(() => {
    if (!open.db.query("SELECT 1 FROM asset_versions WHERE version_id = ?").get(p.versionId)) {
      open.db.query("INSERT INTO asset_versions (version_id, asset_id, version_number, branch_id, requirements_hash, manifest_sha256, directory, created_by, created_by_type, created_at, note, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.versionId, p.assetId, p.versionNumber, p.branchId, p.requirementsHash, p.manifestSha256, dirOf(p), p.actorId, p.actorType, p.createdAt, p.note, p.requestId);
      for (const d of p.deliverables) {
        open.db.query("INSERT INTO version_deliverables (version_id, deliverable_id, candidate_id, output_id, output_hash, decision_id, reused_from_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(p.versionId, d.deliverableId, d.candidateId, d.outputId, d.outputHash, d.decisionId, d.reusedFromVersionId);
      }
    }
    open.db.query("UPDATE publication_intents SET state = 'committed', resolved_at = ?, error = NULL WHERE intent_id = ?").run(now, intentId);
  }, [{ type: "version.promoted", data: { assetId: p.assetId, versionId: p.versionId, versionNumber: p.versionNumber, branchId: p.branchId, actorType: p.actorType }, actorId: p.actorId }]);
}

/** Remove what this intent created (its staging directory, and a final directory no row points at) and mark it failed. */
async function failIntent(open: OpenProject, intentId: string, payload: Payload | undefined, error: string): Promise<void> {
  if (payload && !open.db.query("SELECT 1 FROM asset_versions WHERE version_id = ?").get(payload.versionId)) {
    await rm(await resolveIn(open.root, dirOf(payload)), { recursive: true, force: true });
  }
  await rm(await resolveIn(open.root, paths.staging(intentId)), { recursive: true, force: true });
  open.db.query("UPDATE publication_intents SET state = 'failed', error = ?, resolved_at = ? WHERE intent_id = ?").run(error, new Date().toISOString(), intentId);
}

export interface PublishRequest {
  evaluation: Evaluation;
  actorId: string;
  actorType: ActorType;
  requestId: string;
  note?: string;
  fault?: PromotionFault;
}

/**
 * Publish one immutable version, visibly all-or-nothing: record a `prepared` intent BEFORE any file is written,
 * stage copies (reflink where the filesystem has it; never hard links into mutable candidate folders), hash every
 * copy, write manifest.json last, sync, rename the staging directory to `versions/<id>/`, then insert the rows and
 * mark the intent committed in one transaction. An exception before the rename removes only the staging directory.
 * Past the rename, the intent is left for `recoverPromotions` (a crash and a failed commit take the same path).
 */
export async function publishVersion(open: OpenProject, request: PublishRequest): Promise<{ versionId: string }> {
  const { evaluation: e } = request;
  const versionId = newId("ver");
  const intentId = newId("pub");
  const createdAt = new Date().toISOString();

  // Sizes were filled in by the plan's verification of every source file.
  const { manifest, files } = buildManifest(e, versionId, request.actorId, createdAt);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const payload: Payload = {
    versionId, assetId: e.assetId, branchId: e.branchId, versionNumber: manifest.versionNumber, requestId: request.requestId, note: request.note ?? null,
    actorId: request.actorId, actorType: request.actorType, createdAt, requirementsHash: e.requirementsHash, manifestText, manifestSha256: sha256(manifestText),
    deliverables: manifest.deliverables.map((d) => ({ deliverableId: d.deliverableId, candidateId: d.candidateId, outputId: d.outputId, outputHash: d.outputHash, decisionId: d.decisionId, reusedFromVersionId: d.reusedFromVersionId ?? null })),
  };

  const stagingRel = paths.staging(intentId);
  open.db.query("INSERT INTO publication_intents (intent_id, kind, payload_json, staging_path, state, created_at) VALUES (?, ?, ?, ?, 'prepared', ?)")
    .run(intentId, PROMOTION_INTENT_KIND, JSON.stringify(payload), stagingRel, createdAt);

  try {
    const stagingAbs = await resolveIn(open.root, stagingRel);
    const madeDirs = new Set<string>([stagingAbs]);
    await mkdir(stagingAbs, { recursive: true });
    for (const f of files) {
      const dst = join(stagingAbs, f.dest);
      await mkdir(dirname(dst), { recursive: true });
      madeDirs.add(dirname(dst));
      await copyFile(await resolveIn(open.root, f.src), dst, constants.COPYFILE_FICLONE);
      if (sha256(await readFile(dst)) !== f.sha256) throw new Error(`${f.src} changed while it was being copied`);
      await chmod(dst, 0o444);
    }
    await writeFileAtomic(join(stagingAbs, "manifest.json"), manifestText);
    await chmod(join(stagingAbs, "manifest.json"), 0o444);
    for (const d of madeDirs) await syncDir(d);
    if (request.fault === "fail-before-publish") throw new Error("injected failure before publication");

    const finalAbs = await resolveIn(open.root, dirOf(payload));
    await mkdir(dirname(finalAbs), { recursive: true });
    await rename(stagingAbs, finalAbs);
    await syncDir(dirname(finalAbs));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failIntent(open, intentId, undefined, message);
    throw new OperationFailure("IO_ERROR", `Promotion could not be published: ${message}. No version was created and the active selection is unchanged.`, { intentId });
  }

  try {
    if (request.fault === "fail-after-rename-before-commit") throw new Error("injected crash after the rename, before the commit");
    commit(open, intentId, payload);
  } catch (error) {
    throw new OperationFailure("IO_ERROR", `Promotion files are in place but the version was not recorded (${error instanceof Error ? error.message : String(error)}); reopening the project finishes it`, { intentId });
  }
  return { versionId };
}

export interface PromotionRecovery { committed: string[]; failed: { intentId: string; error: string }[] }

/** Resolve every prepared promotion intent without taking the mutation gate (callers hold it or run at open). */
export async function recoverPromotionIntents(open: OpenProject): Promise<PromotionRecovery> {
  const report: PromotionRecovery = { committed: [], failed: [] };
  const intents = open.db.query<{ intent_id: string; payload_json: string }, [string]>("SELECT intent_id, payload_json FROM publication_intents WHERE kind = ? AND state = 'prepared' ORDER BY rowid").all(PROMOTION_INTENT_KIND);
  for (const intent of intents) {
    const parsed = Payload.safeParse(JSON.parse(intent.payload_json));
    if (!parsed.success) {
      await failIntent(open, intent.intent_id, undefined, `payload unreadable: ${parsed.error.message}`);
      report.failed.push({ intentId: intent.intent_id, error: "payload unreadable" });
      continue;
    }
    const p = parsed.data;
    try {
      const alreadyRecorded = open.db.query("SELECT 1 FROM asset_versions WHERE version_id = ?").get(p.versionId) !== null;
      const finalAbs = await resolveIn(open.root, dirOf(p));
      if (!alreadyRecorded && (await verifyDirectory(finalAbs, p.manifestSha256)).problems.length > 0) {
        // Not (fully) renamed: finish from staging only if the staged copy is complete and verified.
        const stagingAbs = await resolveIn(open.root, paths.staging(intent.intent_id));
        const staged = await verifyDirectory(stagingAbs, p.manifestSha256);
        if (staged.problems.length > 0 || (await readdir(stagingAbs).catch(() => [])).length === 0) {
          throw new Error(`neither the published nor the staged version verifies: ${staged.problems.join("; ") || "nothing staged"}`);
        }
        await rm(finalAbs, { recursive: true, force: true });
        await mkdir(dirname(finalAbs), { recursive: true });
        await rename(stagingAbs, finalAbs);
        await syncDir(dirname(finalAbs));
      }
      commit(open, intent.intent_id, p);
      await rm(await resolveIn(open.root, paths.staging(intent.intent_id)), { recursive: true, force: true });
      report.committed.push(intent.intent_id);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await failIntent(open, intent.intent_id, p, error);
      report.failed.push({ intentId: intent.intent_id, error });
    }
  }
  return report;
}

/** Finish or roll back interrupted promotions. Run on project open, before anything reads versions. */
export function recoverPromotions(open: OpenProject): Promise<PromotionRecovery> {
  return open.mutate(() => recoverPromotionIntents(open));
}
