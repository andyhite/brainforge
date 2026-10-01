import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CleanupSidecar } from "@brainforge/contracts";
import { paths, resolveIn } from "@brainforge/storage";
import type { OpenProject } from "../project-runtime.ts";
import { frameName, loadParent } from "./parent.ts";

/** Writes the output's frames and a verifying sidecar into a NEW cleanup directory. Nothing existing is modified. */
export async function exportCleanup(open: OpenProject, actorId: string, input: { candidateId: string; outputId: string; stage: "source" | "processed" }): Promise<{ directory: string; sidecar: CleanupSidecar }> {
  const parent = await loadParent(open, input.candidateId, input.outputId, input.stage);
  const cleanupId = `cleanup-${randomBytes(6).toString("hex")}`;
  const directory = paths.cleanupDir(parent.candidate.asset_id, cleanupId);
  const sidecar: CleanupSidecar = {
    schema: "brainforge.cleanup.v1",
    candidateId: parent.candidate.candidate_id,
    parentOutputId: parent.output.output_id,
    parentHash: parent.output.sha256,
    stage: input.stage,
    canvas: { width: parent.output.width, height: parent.output.height },
    frameCount: parent.frames.length,
    frames: parent.frames.map((f) => ({ index: f.index, file: frameName(f.index), sha256: f.sha256 })),
    durationsMs: parent.frames.map((f) => f.durationMs),
    sourceFrameMap: parent.frames.map((f) => f.sourceFrame),
    ...(parent.output.recipe_hash ? { recipeHash: parent.output.recipe_hash } : {}),
    exportedAt: new Date().toISOString(),
  };

  const staging = await resolveIn(open.root, paths.staging(cleanupId));
  const finalAbs = await resolveIn(open.root, directory);
  await open.mutate(async () => {
    try {
      await mkdir(staging, { recursive: true });
      for (const f of parent.frames) await writeFile(`${staging}/${frameName(f.index)}`, f.bytes);
      await writeFile(`${staging}/sidecar.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
      await mkdir(dirname(finalAbs), { recursive: true });
      await rename(staging, finalAbs);
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
    const now = new Date().toISOString();
    open.transact(() => {
      open.db.query("INSERT INTO cleanup_exports (cleanup_id, candidate_id, output_id, stage, directory, sidecar_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(cleanupId, parent.candidate.candidate_id, parent.output.output_id, input.stage, directory, JSON.stringify(sidecar), actorId, now);
    }, [{ type: "cleanup.exported", data: { cleanupId, candidateId: parent.candidate.candidate_id, outputId: parent.output.output_id, directory }, actorId }]);
  });
  return { directory, sidecar };
}
