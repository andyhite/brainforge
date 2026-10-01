import { randomBytes } from "node:crypto";
import type { Candidate } from "@brainforge/contracts";
import { ProcessingRecipe } from "@brainforge/contracts";
import { paths, resolveIn, sha256, writeFileAtomic } from "@brainforge/storage";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { packageClip } from "../processing/package.ts";
import { publishFrameSequence, type DerivedFileInput, type FrameInput, type PublicationFaults } from "../outputs/frames.ts";
import { candidateRow, requirementsResolver, toCandidate } from "../review/records.ts";
import { inheritedMeta, insertLineage, reconcileCleanupLineage, type Lineage } from "./lineage.ts";
import { loadParent, type Parent } from "./parent.ts";
import { validateImport } from "./validate.ts";

export interface ImportInput { parentCandidateId: string; parentOutputId: string; stage: "source" | "processed"; frames: { index: number; file: string }[]; notes: string; effortMinutes?: number | undefined }

/**
 * Validates everything first, then publishes a NEW unapproved child candidate. Frames not listed are copied from the
 * parent by hash. Nothing the parent owns is touched, and no decision, approval or selection is carried over.
 */
export async function importCleanup(open: OpenProject, actorId: string, input: ImportInput, faults: PublicationFaults = {}): Promise<{ candidate: Candidate; outputId: string }> {
  reconcileCleanupLineage(open);
  const parent = await loadParent(open, input.parentCandidateId, input.parentOutputId, input.stage);
  const replacements = await validateImport(open, parent, input.stage, input.frames);
  const byIndex = new Map(replacements.map((r) => [r.index, r]));
  const pngs = parent.frames.map((f) => byIndex.get(f.index)?.bytes ?? f.bytes);

  const candidateId = `cand-cleanup-${randomBytes(6).toString("hex")}`;
  const outputId = `${candidateId}-${parent.output.role}`;
  const lineage: Lineage = {
    parentCandidateId: parent.candidate.candidate_id, parentOutputId: parent.output.output_id, stage: input.stage, notes: input.notes, effortMinutes: input.effortMinutes ?? null,
    replaced: replacements.map(({ index, file, sha256: hash, parentSha256 }) => ({ index, file, sha256: hash, parentSha256 })).sort((a, b) => a.index - b.index),
    createdBy: actorId, createdAt: new Date().toISOString(),
  };
  const label = `Cleanup of ${parent.candidate.label}`;

  if (parent.output.media_kind === "image") {
    await publishStill(open, parent, { candidateId, outputId, label, png: pngs[0]!, lineage });
  } else {
    const processed = input.stage === "processed";
    let frames: FrameInput[] = parent.frames.map((f, i) => ({ png: pngs[i]!, sourceFrame: f.sourceFrame, durationMs: f.durationMs }));
    let files: DerivedFileInput[] = [];
    if (processed) {
      if (!parent.output.recipe_json || parent.output.source_fps === null || parent.output.playback_fps === null) {
        throw new OperationFailure("OUTPUT_MISSING", `Processed output ${parent.output.output_id} does not record its recipe and frame rates, so its packaging cannot be reproduced`, { outputId: parent.output.output_id });
      }
      const recipe = ProcessingRecipe.parse(JSON.parse(parent.output.recipe_json));
      // The pixels are the user's; only atlas pages, animation.json and previews are rebuilt, from the unchanged recipe.
      ({ frames, files } = await packageClip({
        outputId, canvas: { width: parent.output.width, height: parent.output.height }, pivot: recipe.pivot, loop: recipe.loop,
        sourceFps: parent.output.source_fps, playbackFps: parent.output.playback_fps, packaging: recipe.packaging, atlas: recipe.atlas, frames,
      }));
    }
    await publishFrameSequence(open, {
      assetId: parent.candidate.asset_id, candidateId, actorId, purpose: "cleanup-import",
      candidate: {
        candidateId, runId: parent.candidate.run_id, jobId: parent.candidate.job_id, parentCandidateId: parent.candidate.candidate_id,
        ...(parent.candidate.branch_id ? { branchId: parent.candidate.branch_id } : {}), label, ...(parent.candidate.seed === null ? {} : { seed: parent.candidate.seed }), prompt: parent.candidate.prompt,
      },
      outputs: [{
        outputId, role: parent.output.role, stage: input.stage, frames,
        ...(parent.output.source_fps === null ? {} : { sourceFps: parent.output.source_fps }),
        ...(parent.output.playback_fps === null ? {} : { playbackFps: parent.output.playback_fps }),
        ...(parent.output.total_duration_ms === null ? {} : { totalDurationMs: parent.output.total_duration_ms }),
        ...(processed ? { parentOutputId: parent.output.output_id } : {}),
        ...(processed && parent.output.recipe_json ? { recipe: JSON.parse(parent.output.recipe_json) as unknown } : {}),
        ...(parent.output.recipe_hash ? { recipeHash: parent.output.recipe_hash } : {}),
        meta: { ...inheritedMeta(parent.output.meta_json), cleanup: lineage },
        files,
      }],
    }, faults);
    reconcileCleanupLineage(open);
  }

  const resolver = await requirementsResolver(open, parent.candidate.asset_id);
  return { candidate: toCandidate(open.db, candidateRow(open.db, candidateId), resolver), outputId };
}

async function publishStill(open: OpenProject, parent: Parent, s: { candidateId: string; outputId: string; label: string; png: Uint8Array; lineage: Lineage }): Promise<void> {
  const rel = paths.candidateFile(parent.candidate.asset_id, s.candidateId, "original", `${parent.output.role}.png`);
  await open.mutate(async () => {
    await writeFileAtomic(await resolveIn(open.root, rel), s.png);
    const c = parent.candidate;
    open.transact(() => {
      open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, parent_candidate_id, branch_id, label, seed, prompt, favorite, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
        .run(s.candidateId, c.asset_id, c.step_id, c.run_id, c.job_id, c.candidate_id, c.branch_id, s.label, c.seed, c.prompt, s.lineage.createdAt);
      open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type, stage, media_kind, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'image/png', 'source', 'image', ?)")
        .run(s.outputId, s.candidateId, parent.output.role, s.outputId, rel, sha256(s.png), parent.output.width, parent.output.height, JSON.stringify({ ...inheritedMeta(parent.output.meta_json), cleanup: s.lineage }));
      insertLineage(open, s.candidateId, s.lineage);
    }, [{ type: "candidate.created", data: { candidateId: s.candidateId, assetId: c.asset_id, stepId: c.step_id, parentCandidateId: c.candidate_id }, actorId: s.lineage.createdBy }]);
  });
}
