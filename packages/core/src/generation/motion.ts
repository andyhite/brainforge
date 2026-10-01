import type { AssetSpec, Deliverable, GenerationPlan, MotionGuide, MotionPlan, PlanBlocker, StepState } from "@brainforge/contracts";
import { MediaError, applyFraming, decodeImage, foregroundBounds, type Bounds, type FramingTransform } from "@brainforge/media";
import type { AuthoredSet } from "../authored.ts";
import { computeEffective } from "../effective.ts";
import type { OpenProject } from "../project-runtime.ts";
import { selectedOutput } from "../review/requirements.ts";
import type { PinnedReference } from "./plan.ts";
import { readPinnedReference } from "./references.ts";

export const MOTION_WORKFLOW = "wan22-motion";
/** The canvas Wan renders in and the guides are normalized into. */
export const WAN_CANVAS = 768;
/** Bottom-centre of every normalized guide's foreground: the shared feet baseline inside the Wan canvas. */
export const WAN_FEET = { x: WAN_CANVAS / 2, y: WAN_CANVAS - 40 };
export const DEFAULT_FRAME_COUNT = 33;
export const DEFAULT_SOURCE_FPS = 16;
/** Positive camera/background clause appended to every motion prompt. */
export const STATIC_CAMERA_CLAUSE = "Static camera, flat plain light-grey background, the character stays in place.";

const WAN_MIN_LENGTH = 5;
const WAN_MAX_LENGTH = 81;
type MotionDeliverable = Deliverable & { animation: NonNullable<Deliverable["animation"]> };

export interface MotionInputs {
  blockers: PlanBlocker[];
  notes: string[];
  references: PinnedReference[];
  motion?: MotionPlan;
}

const blocker = (code: string, message: string, recoveryActions: PlanBlocker["recoveryActions"] = []): PlanBlocker => ({ code, message, recoveryActions });

/** The scale-anchor reference: the branch's front crop of its selected construction sheet, else the locked concept output. */
async function anchorReference(project: OpenProject, spec: AssetSpec, branchId: string, concept: { id: string; sha256: string }): Promise<{ id: string; sha256: string; label: string }> {
  for (const sheet of spec.deliverables.filter((d) => d.kind === "reference-sheet")) {
    const sel = selectedOutput(project.db, branchId, sheet.id);
    if (!sel) continue;
    const crops = project.db.query<{ file_id: string; sha256: string; region_id: string }, [string]>("SELECT file_id, sha256, region_id FROM output_crops WHERE output_id = ?").all(sel.outputId);
    const front = crops.find((c) => c.region_id === "front") ?? crops.find((c) => /(^|-)front$/.test(c.region_id));
    if (front) return { id: front.file_id, sha256: front.sha256, label: `the front crop of ${sheet.id}` };
  }
  return { ...concept, label: "the branch's locked concept output" };
}

/** Foreground bounds of an image that must carry real alpha; otherwise the whole canvas would pass for the figure. */
async function measure(bytes: Uint8Array, label: string): Promise<Bounds> {
  const decoded = await decodeImage(bytes, label);
  if (!decoded.hasAlpha) throw new MediaError("invalid_input", `${label} has no alpha channel, so the figure cannot be measured`);
  return foregroundBounds(bytes);
}

/** Where the scaled foreground of a guide sits so its bottom-centre lands on the shared feet baseline. */
export function guideTransform(scale: number, bounds: Bounds): MotionGuide["transform"] {
  return {
    scale,
    offsetX: Math.round(WAN_FEET.x - (bounds.x + bounds.width / 2) * scale),
    offsetY: Math.round(WAN_FEET.y - (bounds.y + bounds.height) * scale),
    sourceBounds: bounds,
  };
}

/** The exact framing the scheduler applies to a pinned guide before uploading it to ComfyUI. */
export function guideFraming(motion: MotionPlan, guide: MotionGuide): FramingTransform {
  return {
    scale: guide.transform.scale,
    canvas: motion.guideNormalization.canvas,
    anchor: motion.guideNormalization.feet,
    sourceBounds: guide.transform.sourceBounds,
    subjectHeightPx: motion.guideNormalization.subjectHeightPx,
  };
}

/**
 * Everything an animation step contributes to a generation plan: the approved guide poses, the branch's one
 * uniform scale (measured once on the scale-anchor reference, never on the posed figure), the Wan frame count and
 * the prompt clause. Problems become blockers; nothing is fitted per clip.
 */
export async function resolveMotion(
  project: OpenProject, set: AuthoredSet, assetId: string, spec: AssetSpec, deliverable: MotionDeliverable,
  branchId: string, concept: { id: string; sha256: string }, steps: readonly StepState[],
): Promise<MotionInputs> {
  const out: MotionInputs = { blockers: [], notes: [], references: [] };
  const anim = deliverable.animation;
  const stepAction = (stepId: string): PlanBlocker["recoveryActions"] => [{ label: `Inspect ${stepId}`, operation: "step.inspect", input: { assetId, stepId, branchId } }];

  const frameCount = anim.sourceFrameCount ?? DEFAULT_FRAME_COUNT;
  if (!Number.isInteger(frameCount) || (frameCount - 1) % 4 !== 0 || frameCount < WAN_MIN_LENGTH || frameCount > WAN_MAX_LENGTH) {
    out.blockers.push(blocker("FRAME_COUNT_INVALID", `animation.sourceFrameCount ${frameCount} is not valid for Wan: it must be 4n+1 between ${WAN_MIN_LENGTH} and ${WAN_MAX_LENGTH} (for example 33).`, [
      { label: "Fix sourceFrameCount in asset.yaml", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } },
    ]));
  }
  const sourceFps = anim.sourceFps ?? DEFAULT_SOURCE_FPS;
  if (sourceFps !== DEFAULT_SOURCE_FPS) out.notes.push(`Wan renders at ${DEFAULT_SOURCE_FPS} fps; the authored sourceFps ${sourceFps} re-times the generated frames when they are played.`);

  // --- guides: default both to the first approved pose dependency
  const stepOf = (id: string): StepState | undefined => steps.find((s) => s.stepId === id);
  const approvedOf = (id: string): boolean => {
    const a = stepOf(id)?.selected?.approval;
    return a?.state === "approved" && a.applicable;
  };
  const poseDeps = deliverable.dependsOn.filter((id) => spec.deliverables.find((d) => d.id === id)?.kind === "pose");
  const fallback = poseDeps.find(approvedOf) ?? poseDeps[0];
  const startId = anim.startReference ?? fallback;
  const endId = anim.endReference ?? fallback;
  if (!startId || !endId) {
    out.blockers.push(blocker("GUIDE_MISSING", `${deliverable.id} has no start/end guide: set animation.startReference/endReference, or depend on an approved pose deliverable.`, [
      { label: "Edit the animation block in asset.yaml", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } },
    ]));
    return out;
  }

  // --- the scale anchor: measured once per branch, not per clip or pose
  const effective = computeEffective(set, { assetId }).effective;
  const subjectHeightPx = effective["sizing.subjectHeightPx"]?.value;
  const canvasHeight = effective["sizing.height"]?.value;
  if (typeof subjectHeightPx !== "number" || typeof canvasHeight !== "number") {
    out.blockers.push(blocker("ANCHOR_MISSING", "Motion needs sizing.subjectHeightPx and sizing.height (for example familyDefaults.character.sizing in project.yaml) to calibrate one scale for the branch.", [
      { label: "Read project.yaml", operation: "spec.read", input: { path: "brainforge/project.yaml" } },
    ]));
    return out;
  }
  const anchor = await anchorReference(project, spec, branchId, concept);
  const anchorBytes = await readPinnedReference(project, anchor);
  if (!anchorBytes) {
    out.blockers.push(blocker("OUTPUT_MISSING", `The scale-anchor reference ${anchor.id} (${anchor.label}) is missing on disk or no longer matches its recorded hash.`, stepAction(deliverable.id)));
    return out;
  }
  let anchorBounds: Bounds;
  try {
    anchorBounds = await measure(anchorBytes, `scale-anchor reference ${anchor.id}`);
  } catch (e) {
    out.blockers.push(blocker("ANCHOR_MISSING", `The standing height cannot be measured on ${anchor.label}: ${e instanceof Error ? e.message : String(e)}. Select a matted (transparent-background) reference.`, stepAction(deliverable.id)));
    return out;
  }
  const subjectInWan = (subjectHeightPx * WAN_CANVAS) / canvasHeight;
  const scale = subjectInWan / anchorBounds.height;
  out.notes.push(`Scale anchor: ${anchor.label} stands ${anchorBounds.height}px; guides are scaled by ${scale.toFixed(4)} so a standing figure is ${Math.round(subjectInWan)}px tall in the ${WAN_CANVAS}px Wan canvas (${subjectHeightPx}px on the ${canvasHeight}px export canvas). The same scale applies to every clip of this branch.`);

  // --- each distinct guide, pinned and normalized
  const guides: MotionGuide[] = [];
  const cache = new Map<string, MotionGuide["transform"] & { outputId: string; sha256: string }>();
  for (const [role, id] of [["start", startId], ["end", endId]] as const) {
    const guideSpec = spec.deliverables.find((d) => d.id === id);
    if (!guideSpec || guideSpec.kind === "animation") {
      out.blockers.push(blocker("GUIDE_MISSING", `animation.${role}Reference "${id}" is not a pose/still deliverable of ${assetId}.`, stepAction(deliverable.id)));
      continue;
    }
    const sel = selectedOutput(project.db, branchId, id);
    if (!sel) {
      out.blockers.push(blocker("GUIDE_MISSING", `The ${role} guide ${id} has no selected output on this branch. Select and approve one first.`, [
        { label: `List candidates of ${id}`, operation: "candidate.list", input: { assetId, stepId: id, branchId } },
        ...stepAction(id),
      ]));
      continue;
    }
    if (!approvedOf(id)) {
      const a = stepOf(id)?.selected?.approval;
      const why = a && !a.applicable ? `its approval no longer applies (${a.staleReason ?? "inputs changed"})` : `its selected output is ${a?.state === "escalated" ? "waiting for a human decision" : a?.state === "rejected" ? "rejected" : "not approved"}`;
      out.blockers.push(blocker("GUIDE_NOT_APPROVED", `The ${role} guide ${id} cannot be used: ${why}. A guide must be an approved pose.`, stepAction(id)));
      continue;
    }
    const hit = cache.get(sel.outputId);
    const bytes = hit ? undefined : await readPinnedReference(project, { id: sel.outputId, sha256: sel.sha256 });
    if (!hit && !bytes) {
      out.blockers.push(blocker("OUTPUT_MISSING", `The ${role} guide ${sel.outputId} is missing on disk or no longer matches its recorded hash.`, stepAction(id)));
      continue;
    }
    let transform = hit;
    if (!transform && bytes) {
      try {
        const bounds = await measure(bytes, `${role} guide ${sel.outputId}`);
        const t = guideTransform(scale, bounds);
        const framing: FramingTransform = { scale, canvas: { width: WAN_CANVAS, height: WAN_CANVAS }, anchor: WAN_FEET, sourceBounds: bounds, subjectHeightPx: subjectInWan };
        const { clipped } = await applyFraming(bytes, framing);
        if (clipped) {
          out.blockers.push(blocker("GUIDE_CLIPPED", `The ${role} guide ${id} touches the ${WAN_CANVAS}px canvas edge at the branch's calibrated scale (${scale.toFixed(4)}; figure ${bounds.width}x${bounds.height}px before scaling). Motion would be cropped. Enlarge the canvas or explicitly revise the scale; Brainforge never refits per clip.`, stepAction(id)));
          continue;
        }
        const ratio = bounds.height / anchorBounds.height;
        if (ratio < 0.75 || ratio > 1.33) out.notes.push(`The ${role} guide ${id} stands ${bounds.height}px against the anchor's ${anchorBounds.height}px (ratio ${ratio.toFixed(2)}); a different pixel scale or pose than the reference would change the character's apparent height. Review the normalized guide before approving the run.`);
        transform = { ...t, outputId: sel.outputId, sha256: sel.sha256 };
        cache.set(sel.outputId, transform);
      } catch (e) {
        const clipped = e instanceof MediaError && e.code === "clipped";
        out.blockers.push(blocker(clipped ? "GUIDE_CLIPPED" : "GUIDE_MISSING", `The ${role} guide ${id} cannot be normalized: ${e instanceof Error ? e.message : String(e)}.`, stepAction(id)));
        continue;
      }
    }
    if (!transform) continue;
    const { outputId, sha256: hash, ...geometry } = transform;
    guides.push({ role, deliverableId: id, outputId, originalFileId: outputId, sha256: hash, transform: geometry });
    out.references.push({ role: `${role}_pose`, id: outputId, sha256: hash });
  }
  if (out.blockers.length > 0 || guides.length < 2) return out;

  out.motion = {
    motion: anim.motion,
    frameCount,
    sourceFps,
    width: WAN_CANVAS,
    height: WAN_CANVAS,
    loop: anim.loop,
    closingFrame: anim.loop ? "exclude-last" : "keep",
    guideNormalization: {
      scale, feet: WAN_FEET, canvas: { width: WAN_CANVAS, height: WAN_CANVAS },
      referenceOutputId: anchor.id, referenceHash: anchor.sha256,
      sourceStandingHeightPx: anchorBounds.height, targetStandingHeightPx: subjectHeightPx, subjectHeightPx: subjectInWan,
    },
    guides,
  };
  return out;
}

/** Hash input for start-time revalidation: the parts of a motion plan that depend on files and approvals, not on the prompt. */
export const motionBasis = (m: GenerationPlan["motion"] | undefined): unknown =>
  m ? { guideNormalization: m.guideNormalization, guides: m.guides.map((g) => ({ role: g.role, outputId: g.outputId, sha256: g.sha256, transform: g.transform })) } : null;
