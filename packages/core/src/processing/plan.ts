import { ProcessingPlan, ProcessingRecipe, type ParsedOperationInput, type PlanBlocker, type ProcessingWarning, type RecipeRequest, type ScaleAnchor } from "@brainforge/contracts";
import { loopJumps, MediaError, processClip, type ProcessedClip } from "@brainforge/media";
import { discoverAuthored } from "../authored.ts";
import { computeEffective } from "../effective.ts";
import { normalizedHash } from "../operations.ts";
import { readFrameSequence, type FrameOutputRow } from "../outputs/frames.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { newId } from "../generation/store.ts";
import { computeSteps } from "../pipeline/steps.ts";
import { anchorScale, branchScaleReference, deriveScaleAnchor, guideNormalizationOf, loadReferenceImage } from "./anchor.ts";
import { atlasPageCount } from "./package.ts";

interface CandidateRow { candidate_id: string; asset_id: string; step_id: string; branch_id: string | null }

/** Tolerance, in output pixels, of how far a pivot may sit outside the clip's foreground before it is called out. */
const pivotMargin = (canvasHeight: number): number => Math.max(4, Math.round(canvasHeight * 0.04));
/** The feet sit this far above the canvas bottom by default (matches calibrateFraming), scaled down for tiny canvases. */
const feetMargin = (canvasHeight: number): number => Math.min(12, Math.floor(canvasHeight * 0.05));
/** Relative scale difference that counts as "the character's size changed". */
const SCALE_TOLERANCE = 0.005;

const processingRecipeDefaults = { resizeFilter: "lanczos3", alpha: "preserve", resample: "nearest", tileRepeat: "none", packaging: "both" } as const;

const recoveryPlan = (candidateId: string, outputId?: string) => ({ label: "Plan processing again", operation: "processing.plan", input: { candidateId, ...(outputId ? { outputId } : {}) } });

/** The source output a plan runs on: the named one, else the candidate's matted source frames. */
function pickSource(open: OpenProject, candidateId: string, outputId: string | undefined): FrameOutputRow {
  const rows = open.db.query<FrameOutputRow, [string]>("SELECT * FROM candidate_outputs WHERE candidate_id = ? ORDER BY (role = 'matted') DESC, rowid").all(candidateId);
  const row = outputId === undefined ? rows.find((r) => r.media_kind === "frames" && r.stage === "source") : rows.find((r) => r.output_id === outputId);
  if (!row) {
    throw new OperationFailure(outputId === undefined ? "INVALID_INPUT" : "NOT_FOUND",
      outputId === undefined ? `Candidate ${candidateId} has no source frame sequence to process.` : `Candidate ${candidateId} has no output ${outputId}.`,
      undefined, [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId } }]);
  }
  if (row.media_kind !== "frames") throw new OperationFailure("INVALID_INPUT", `Output ${row.output_id} is a single image; only frame sequences are processed.`);
  if (row.stage !== "source") {
    throw new OperationFailure("INVALID_INPUT", `Output ${row.output_id} is already processed. Processing never re-processes a processed output: plan from its source output ${row.parent_output_id ?? "(unknown)"}, or review it as it is.`, { parentOutputId: row.parent_output_id });
  }
  return row;
}

const warn = (code: ProcessingWarning["code"], message: string, frames: number[] = []): ProcessingWarning => ({ code, message, frames });

/**
 * Resolve a processing recipe and report, without running anything on disk, exactly what `processing.start` would
 * produce. Problems become blockers so the caller sees all of them at once. Never contacts ComfyUI.
 */
export async function createProcessingPlan(open: OpenProject, actorId: string, input: ParsedOperationInput<"processing.plan">): Promise<ProcessingPlan> {
  const cand = open.db.query<CandidateRow, [string]>("SELECT candidate_id, asset_id, step_id, branch_id FROM candidates WHERE candidate_id = ?").get(input.candidateId);
  if (!cand) throw new OperationFailure("NOT_FOUND", `No candidate ${input.candidateId}`, undefined, [{ label: "List candidates", operation: "candidate.list" }]);
  const sourceRow = pickSource(open, cand.candidate_id, input.outputId);
  const { output: source, frames: sourceFrames } = await readFrameSequence(open, sourceRow.output_id);
  if (!source.source_fps) throw new OperationFailure("INVALID_INPUT", `Source output ${source.output_id} has no recorded source fps, so playback duration cannot be preserved.`);
  const sourceFps = source.source_fps;
  const canvasW = sourceFrames[0]!.width, canvasH = sourceFrames[0]!.height;

  const blockers: PlanBlocker[] = [];
  const block = (code: string, message: string, recoveryActions: PlanBlocker["recoveryActions"] = []): void => { blockers.push({ code, message, recoveryActions }); };
  const warnings: ProcessingWarning[] = [];
  const sources: Record<string, string> = {};
  const req: RecipeRequest = input.recipe;

  const set = await discoverAuthored(open.root);
  const asset = set.assets.find((a) => a.fileId === cand.asset_id);
  const deliverable = asset?.spec?.deliverables.find((d) => d.id === cand.step_id);
  if (!asset?.spec || !deliverable) {
    block("ASSET_INVALID", `Asset ${cand.asset_id} has no valid definition of deliverable ${cand.step_id}, so its sizing, loop and frame rate are unknown.`, [{ label: "Read the asset definition", operation: "spec.read", input: { path: `brainforge/assets/${cand.asset_id}/asset.yaml` } }]);
  } else if (deliverable.kind !== "animation" || !deliverable.animation) {
    block("NOT_ANIMATION", `Deliverable ${deliverable.id} is a ${deliverable.kind}, not an animation; only animation frame sequences are processed.`);
  }
  const effective = asset?.spec && deliverable ? computeEffective(set, { assetId: cand.asset_id, deliverableId: deliverable.id }).effective : {};
  const leaf = (key: string): { value: unknown; source: string } | undefined => {
    const l = effective[key];
    return l ? { value: l.value, source: `${l.source.file}:${l.source.field}` } : undefined;
  };

  // --- animation step must be reachable (dependencies approved) on a branch
  const branchId = cand.branch_id ?? undefined;
  if (branchId) {
    const step = (await computeSteps({ db: open.db, root: open.root }, cand.asset_id, branchId)).find((s) => s.stepId === cand.step_id);
    for (const b of step?.blockers ?? []) if (b.code === "STEP_BLOCKED" || b.code === "DEPENDENCY_NOT_APPROVED" || b.code === "NO_BRANCH") blockers.push(b);
  }

  // --- resolve every field, recording where each default came from
  const pick = <T>(name: string, requested: T | undefined, fallback: () => { value: T; source: string } | undefined): T | undefined => {
    if (requested !== undefined) { sources[name] = "request"; return requested; }
    const d = fallback();
    if (d) sources[name] = d.source;
    return d?.value;
  };
  const builtIn = <T>(value: T): { value: T; source: string } => ({ value, source: "built-in default" });

  const loop = pick("loop", req.loop, () => (deliverable?.animation ? { value: deliverable.animation.loop, source: `${asset?.path}:deliverables[${deliverable.id}].animation.loop` } : undefined));
  const closingFrame = pick("closingFrame", req.closingFrame, () => (loop === undefined ? undefined : { value: loop ? "exclude-last" as const : "keep" as const, source: `derived: ${loop ? "loop:true plays the sequence without its repeated closing frame" : "loop:false keeps every frame"}` }));
  const crop = pick("crop", req.crop, () => ({ value: { x: 0, y: 0, width: canvasW, height: canvasH }, source: `derived: the full ${canvasW}x${canvasH} source frame` }));
  const output = pick("output", req.output, () => {
    const w = leaf("sizing.width"), h = leaf("sizing.height");
    return typeof w?.value === "number" && typeof h?.value === "number" ? { value: { width: w.value, height: h.value }, source: w.source === h.source ? w.source : `${w.source}, ${h.source}` } : undefined;
  });
  if (!output) block("SIZING_MISSING", "No export canvas: set sizing.width and sizing.height in project.yaml defaults or familyDefaults (or pass recipe.output).", [{ label: "Read project.yaml", operation: "spec.read", input: { path: "brainforge/project.yaml" } }]);
  const playbackFps = pick("playbackFps", req.playbackFps, () => {
    const l = leaf("animation.playbackFps");
    return typeof l?.value === "number" ? { value: l.value, source: l.source } : undefined;
  });
  if (playbackFps === undefined) block("PLAYBACK_FPS_MISSING", "No playback frame rate: set defaults.animation.playbackFps in project.yaml or animation.playbackFps on the deliverable (or pass recipe.playbackFps).", [{ label: "Read project.yaml", operation: "spec.read", input: { path: "brainforge/project.yaml" } }]);
  const resizeFilter = pick("resizeFilter", req.resizeFilter, () => builtIn(processingRecipeDefaults.resizeFilter));
  const alpha = pick("alpha", req.alpha, () => builtIn(processingRecipeDefaults.alpha));
  const packaging = pick("packaging", req.packaging, () => builtIn(processingRecipeDefaults.packaging));
  const atlasOpts = pick("atlas", req.atlas, () => builtIn({ maxSize: 4096, padding: 2, extrude: 1 }));
  const tileRepeat = pick("tileRepeat", req.tileRepeat, () => builtIn(processingRecipeDefaults.tileRepeat));
  const resampleMode = pick("resample", req.resample, () => builtIn(processingRecipeDefaults.resample));
  const pivot = pick("pivot", req.pivot, () => output
    ? { value: { x: 0.5, y: (output.height - feetMargin(output.height)) / output.height }, source: `derived: bottom-centre of the anchor's feet, ${feetMargin(output.height)}px above the canvas bottom` }
    : undefined);
  const trim = req.trim;
  if (trim) sources.trim = "request"; else sources.trim = `derived: all ${sourceFrames.length} source frames`;
  if (req.frameOffsets) sources.frameOffsets = "request";
  if (req.matteColor) sources.matteColor = "request";

  // --- scale anchor
  const subjectHeight = leaf("sizing.subjectHeightPx");
  const scaleWarnings: ProcessingWarning[] = [];
  let anchor: ScaleAnchor | undefined;
  if (req.scaleAnchor) {
    anchor = req.scaleAnchor;
    sources.scaleAnchor = "request";
  } else {
    const norm = guideNormalizationOf(open, cand.candidate_id);
    const target = typeof subjectHeight?.value === "number" ? subjectHeight.value : undefined;
    if (!norm) {
      block("ANCHOR_UNAVAILABLE", `The run that produced candidate ${cand.candidate_id} did not record how its guides were normalized, so the scale anchor cannot be carried into its frames. Generate the animation again, or pass an explicit recipe.scaleAnchor.`);
    } else if (target === undefined) {
      block("ANCHOR_UNAVAILABLE", "sizing.subjectHeightPx (the standing height in exported pixels) is not set for this asset family, so there is no calibrated scale.", [{ label: "Read project.yaml", operation: "spec.read", input: { path: "brainforge/project.yaml" } }]);
    } else {
      const referenceId = req.scaleReferenceOutputId ?? norm.referenceOutputId;
      const reference = await loadReferenceImage(open, referenceId);
      if (!reference) {
        block("OUTPUT_MISSING", `Scale reference ${referenceId} is unknown, missing on disk, or no longer matches its recorded hash.`, [recoveryPlan(cand.candidate_id, source.output_id)]);
      } else if (referenceId === norm.referenceOutputId && reference.sha256 !== norm.referenceHash) {
        block("REFERENCE_CHANGED", `Scale reference ${referenceId} changed since the guides were normalized (${norm.referenceHash.slice(0, 8)} -> ${reference.sha256.slice(0, 8)}); its frames were generated at the old scale.`, [{ label: "Generate the animation again from the current reference", operation: "generation.plan", input: { assetId: cand.asset_id, stepId: cand.step_id } }]);
      } else {
        try {
          anchor = await deriveScaleAnchor(reference, norm, target);
        } catch (e) {
          if (!(e instanceof MediaError)) throw e;
          block("ANCHOR_UNAVAILABLE", `Scale reference ${referenceId} has no measurable standing height: ${e.message}`);
        }
        const defaultRef = branchId ? branchScaleReference(open, set, cand.asset_id, branchId) : undefined;
        sources.scaleAnchor = `derived: ${referenceId === norm.referenceOutputId ? "the reference the run normalized its guides with" : `the explicit scaleReferenceOutputId ${referenceId}`}, standing height from its alpha bounds × guide scale ${norm.scale.toFixed(4)}, target ${subjectHeight?.source}`;
        if (req.scaleReferenceOutputId && req.scaleReferenceOutputId !== norm.referenceOutputId) {
          scaleWarnings.push(warn("SCALE_CHANGED", `Scale is anchored on ${referenceId}, not the reference ${norm.referenceOutputId} the guides were normalized with; the character's size differs from clips processed against that reference.`));
        }
        if (defaultRef && (defaultRef.id !== norm.referenceOutputId || defaultRef.sha256 !== norm.referenceHash)) {
          scaleWarnings.push(warn("SCALE_CHANGED", `The branch's scale reference is now ${defaultRef.id}, but these frames were generated with guides normalized against ${norm.referenceOutputId}.`));
        }
      }
    }
  }

  // --- assemble and validate the recipe
  let recipe: ProcessingRecipe | undefined;
  if (loop !== undefined && closingFrame && crop && output && playbackFps !== undefined && resizeFilter && alpha && packaging && atlasOpts && tileRepeat && resampleMode && pivot) {
    const parsed = ProcessingRecipe.safeParse({
      ...(trim ? { trim } : {}), closingFrame, crop, output, resizeFilter, alpha, ...(req.matteColor ? { matteColor: req.matteColor } : {}), pivot,
      ...(req.frameOffsets ? { frameOffsets: req.frameOffsets } : {}), playbackFps, resample: resampleMode, loop, ...(anchor ? { scaleAnchor: anchor } : {}), packaging, atlas: atlasOpts, tileRepeat,
    });
    if (parsed.success) recipe = parsed.data;
    else block("RECIPE_INVALID", `The resolved recipe is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }

  // --- dry run: frame map, bounds and checks, no atlas pixels and nothing written
  let clip: ProcessedClip | undefined;
  if (recipe?.scaleAnchor) {
    try {
      clip = await processClip(sourceFrames.map((f) => f.bytes), sourceFps, recipe, { allowClipped: true, allowEmpty: true, pack: false });
    } catch (e) {
      if (!(e instanceof MediaError)) throw e;
      block(e.code === "decode_failed" ? "OUTPUT_MISSING" : "RECIPE_INVALID", `Processing this recipe is impossible: ${e.message}`, [recoveryPlan(cand.candidate_id, source.output_id)]);
    }
  }
  let atlasPages = 0;
  if (recipe && recipe.packaging !== "frames") {
    try {
      atlasPages = atlasPageCount(recipe.output, clip?.frames.length ?? 1, recipe.atlas);
    } catch (e) {
      if (!(e instanceof MediaError)) throw e;
      block("PACKING_IMPOSSIBLE", e.message);
    }
  }

  // --- honest warnings and the clipping blocker
  warnings.push(...scaleWarnings);
  if (recipe?.scaleAnchor) {
    const mine = anchorScale(recipe.scaleAnchor);
    const others = open.db.query<{ output_id: string; recipe_json: string }, [string, string | null]>(
      `SELECT o.output_id, o.recipe_json FROM candidate_outputs o JOIN candidates c ON c.candidate_id = o.candidate_id
        WHERE c.asset_id = ? AND c.branch_id IS ? AND o.stage = 'processed' AND o.recipe_json IS NOT NULL ORDER BY o.rowid`,
    ).all(cand.asset_id, branchId ?? null);
    const differing = others.filter((o) => {
      const a = ProcessingRecipe.safeParse(JSON.parse(o.recipe_json)).data?.scaleAnchor;
      return a !== undefined && Math.abs(anchorScale(a) - mine) / mine > SCALE_TOLERANCE;
    }).map((o) => o.output_id);
    if (differing.length > 0) {
      warnings.push(warn("SCALE_CHANGED", `This plan's uniform scale (${mine.toFixed(4)}) differs from already processed output(s) on this branch: ${differing.slice(0, 5).join(", ")}. The character will not match their size.`));
    }
  }
  if (clip && recipe) {
    if (clip.clippedFrames.length > 0) {
      warnings.push(warn("CLIPPED", `The subject touches or leaves the ${recipe.output.width}x${recipe.output.height} canvas at the calibrated scale in ${clip.clippedFrames.length} export frame(s).`, clip.clippedFrames));
      block("CLIPPED", `At the calibrated scale the subject touches or leaves the ${recipe.output.width}x${recipe.output.height} canvas in export frame(s) ${clip.clippedFrames.slice(0, 12).join(", ")}${clip.clippedFrames.length > 12 ? ", ..." : ""}. Enlarge recipe.output, or explicitly revise the scale (scaleReferenceOutputId / scaleAnchor); processing never refits per clip.`, [
        { label: "Plan again with a larger canvas", operation: "processing.plan", input: { candidateId: cand.candidate_id, outputId: source.output_id, recipe: { output: { width: recipe.output.width * 2, height: recipe.output.height * 2 } } } },
      ]);
    }
    if (clip.emptyFrames.length > 0) warnings.push(warn("EMPTY_FRAME", `${clip.emptyFrames.length} export frame(s) have no visible foreground.`, clip.emptyFrames));
    const m = pivotMargin(recipe.output.height);
    const u = clip.unionBounds, p = clip.pivotPx;
    if (p.x < u.x - m || p.x > u.x + u.width + m || p.y < u.y - m || p.y > u.y + u.height + m) {
      warnings.push(warn("PIVOT_OUTSIDE", `The pivot (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) is more than ${m}px outside the clip's foreground bounds (x ${u.x}..${u.x + u.width}, y ${u.y}..${u.y + u.height}).`));
    }
    if (clip.loop && loopJumps(clip.loop)) {
      warnings.push(warn("LOOP_DISCONTINUITY", `The last played frame differs from the first on ${(clip.loop.difference * 100).toFixed(2)}% of pixels, against at most ${(clip.loop.largestStep * 100).toFixed(2)}% between neighbouring frames: the loop will visibly jump.`, [0, clip.frames.length - 1]));
    }
    if (atlasPages > 1) warnings.push(warn("ATLAS_PAGES", `The atlas needs ${atlasPages} pages of at most ${recipe.atlas.maxSize}px.`));
  }

  if (!recipe) {
    // A recipe cannot even be assembled (canvas, frame rate or pivot unknown): there is no plan to store.
    throw new OperationFailure("STEP_BLOCKED", `Cannot resolve a processing recipe: ${blockers.map((b) => b.message).join(" ")}`, { blockers }, blockers.flatMap((b) => b.recoveryActions));
  }

  const frames = (clip?.frames ?? []).map((f) => ({ index: f.index, sourceFrame: f.sourceFrame, durationMs: f.durationMs }));
  const content = {
    candidateId: cand.candidate_id, sourceOutputId: source.output_id, sourceHash: source.sha256, sourceFrameCount: sourceFrames.length, sourceFps,
    recipe, recipeHash: normalizedHash(recipe), sources, frames,
    totalDurationMs: clip?.totalDurationMs ?? 0, canvas: recipe.output,
    ...(clip ? { foregroundBounds: clip.unionBounds } : {}),
    pivotPx: { x: recipe.pivot.x * recipe.output.width, y: recipe.pivot.y * recipe.output.height },
    warnings, blockers,
  };
  const plan = ProcessingPlan.parse({ planId: newId("pplan"), planHash: normalizedHash(content), ...content, createdAt: new Date().toISOString() });
  open.db.query("INSERT INTO processing_plans (plan_id, plan_hash, plan_json, candidate_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(plan.planId, plan.planHash, JSON.stringify(plan), plan.candidateId, actorId, plan.createdAt);
  return plan;
}

/** A stored plan together with whether (and into which output) it has already been started. */
export function storedProcessingPlan(open: OpenProject, planId: string): { plan: ProcessingPlan; startedOutputId: string | null } {
  const row = open.db.query<{ plan_json: string; started_output_id: string | null }, [string]>("SELECT plan_json, started_output_id FROM processing_plans WHERE plan_id = ?").get(planId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No processing plan ${planId}`, undefined, [{ label: "Plan processing", operation: "processing.plan" }]);
  return { plan: ProcessingPlan.parse(JSON.parse(row.plan_json)), startedOutputId: row.started_output_id };
}
