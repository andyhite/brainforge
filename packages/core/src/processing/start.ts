import { randomBytes } from "node:crypto";
import type { OutputDetail, ParsedOperationInput } from "@brainforge/contracts";
import { MediaError, processClip } from "@brainforge/media";
import { assertId } from "@brainforge/storage";
import { publishFrameSequence, readFrameSequence, type PublicationFaults } from "../outputs/frames.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { loadReferenceImage } from "./anchor.ts";
import { outputDetail } from "./detail.ts";
import { packageClip } from "./package.ts";
import { storedProcessingPlan } from "./plan.ts";

const inFlight = new Map<string, Promise<OutputDetail>>();

const outputOfPlan = (open: OpenProject, planId: string): string | undefined =>
  open.db.query<{ output_id: string }, [string]>("SELECT output_id FROM candidate_outputs WHERE json_extract(meta_json, '$.planId') = ?").get(planId)?.output_id;

/**
 * Execute an inspected plan: revalidate the plan hash, the source bytes and the scale reference, process the clip,
 * package atlas pages + animation.json + contact sheet, and publish ONE new unapproved `processed` output through the
 * two-phase frame publication. The source and every earlier processed output are never touched. A plan that
 * already produced an output (including one finished by startup recovery after a crash) returns that output.
 */
export function startProcessing(open: OpenProject, actorId: string, input: ParsedOperationInput<"processing.start">, faults: PublicationFaults = {}): Promise<OutputDetail> {
  const running = inFlight.get(input.planId);
  if (running) return running;
  const run = execute(open, actorId, input, faults).finally(() => inFlight.delete(input.planId));
  inFlight.set(input.planId, run);
  return run;
}

async function execute(open: OpenProject, actorId: string, input: ParsedOperationInput<"processing.start">, faults: PublicationFaults): Promise<OutputDetail> {
  const { plan, startedOutputId } = storedProcessingPlan(open, input.planId);
  if (plan.planHash !== input.planHash) {
    throw new OperationFailure("REVISION_CONFLICT", "planHash does not match the plan that was inspected under this planId", { expected: plan.planHash, got: input.planHash }, [{ label: "Plan processing again", operation: "processing.plan", input: { candidateId: plan.candidateId, outputId: plan.sourceOutputId } }]);
  }
  const existing = startedOutputId ?? outputOfPlan(open, plan.planId);
  if (existing) {
    // The same plan never produces a second output: a retry (or a crash finished by startup recovery) gets the one it made.
    if (!startedOutputId) open.db.query("UPDATE processing_plans SET started_output_id = ? WHERE plan_id = ?").run(existing, plan.planId);
    return outputDetail(open, existing);
  }
  if (plan.blockers.length > 0) {
    throw new OperationFailure("STEP_BLOCKED", `The plan has blockers: ${plan.blockers.map((b) => b.message).join(" ")}`, { blockers: plan.blockers }, plan.blockers.flatMap((b) => b.recoveryActions));
  }
  const anchor = plan.recipe.scaleAnchor;
  if (!anchor) throw new OperationFailure("STEP_BLOCKED", "The plan has no scale anchor.");

  // --- everything the plan consumed is unchanged
  const { output: source, frames } = await readFrameSequence(open, plan.sourceOutputId);
  const replan = [{ label: "Plan processing again", operation: "processing.plan", input: { candidateId: plan.candidateId, outputId: plan.sourceOutputId } }];
  if (source.sha256 !== plan.sourceHash) throw new OperationFailure("REVISION_CONFLICT", `Source output ${source.output_id} changed since the plan was inspected.`, { expected: plan.sourceHash, got: source.sha256 }, replan);
  const reference = await loadReferenceImage(open, anchor.referenceOutputId);
  if (!reference || reference.sha256 !== anchor.referenceHash) {
    throw new OperationFailure("REVISION_CONFLICT", `Scale reference ${anchor.referenceOutputId} is missing or changed since the plan was inspected.`, { referenceOutputId: anchor.referenceOutputId }, replan);
  }
  const candidate = open.db.query<{ asset_id: string }, [string]>("SELECT asset_id FROM candidates WHERE candidate_id = ?").get(plan.candidateId);
  if (!candidate || !source.source_fps) throw new OperationFailure("NOT_FOUND", `Candidate ${plan.candidateId} or its source frame rate is gone.`, undefined, replan);

  // --- process: strict about clipping (the plan carries no clipping blocker, so a mismatch means the inputs changed)
  let clip;
  try {
    clip = await processClip(frames.map((f) => f.bytes), source.source_fps, plan.recipe, { allowEmpty: true });
  } catch (e) {
    if (e instanceof MediaError) throw new OperationFailure(e.code === "invalid_input" || e.code === "clipped" ? "STEP_BLOCKED" : "IO_ERROR", `Processing failed: ${e.message}`, { mediaError: e.code }, replan);
    throw e;
  }
  const mismatch = clip.frames.length !== plan.frames.length || clip.frames.some((f, i) => f.sourceFrame !== plan.frames[i]!.sourceFrame || Math.abs(f.durationMs - plan.frames[i]!.durationMs) > 1e-6);
  if (mismatch) throw new OperationFailure("REVISION_CONFLICT", "Processing no longer reproduces the inspected frame map.", undefined, replan);

  const outputId = assertId("output", `${plan.candidateId}-p${randomBytes(4).toString("hex")}`, true);
  const packaged = await packageClip({
    outputId, canvas: plan.recipe.output, pivot: plan.recipe.pivot, loop: plan.recipe.loop, sourceFps: source.source_fps, playbackFps: plan.recipe.playbackFps,
    packaging: plan.recipe.packaging, atlas: plan.recipe.atlas, frames: clip.frames,
  });
  await publishFrameSequence(open, {
    assetId: candidate.asset_id, candidateId: plan.candidateId, actorId, purpose: "processing",
    outputs: [{
      outputId, role: "matted", stage: "processed", frames: packaged.frames, sourceFps: source.source_fps, playbackFps: plan.recipe.playbackFps, totalDurationMs: clip.totalDurationMs,
      parentOutputId: source.output_id, recipe: plan.recipe, recipeHash: plan.recipeHash, files: packaged.files,
      meta: { planId: plan.planId, planHash: plan.planHash, warnings: plan.warnings, sources: plan.sources, scale: clip.scale, foregroundBounds: plan.foregroundBounds ?? null, pivotPx: plan.pivotPx, atlasPages: packaged.files.filter((f) => f.kind === "atlas-page").length },
    }],
  }, faults);
  open.transact(() => {
    open.db.query("UPDATE processing_plans SET started_output_id = ? WHERE plan_id = ?").run(outputId, plan.planId);
  }, [{ type: "candidate.changed", data: { candidateId: plan.candidateId, outputId, processed: true }, actorId }]);
  return outputDetail(open, outputId);
}
