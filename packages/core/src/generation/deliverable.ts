import type { Deliverable, DirectionPin, MotionPlan, PlanBlocker } from "@brainforge/contracts";
import { asCrossAsset, directionBindings, resolveDirection, unresolvedBlocker } from "../environments/direction.ts";
import type { AuthoredSet } from "../authored.ts";
import { buildPipeline } from "../pipeline.ts";
import { computeSteps } from "../pipeline/steps.ts";
import { selectedOutput } from "../review/requirements.ts";
import type { OpenProject } from "../project-runtime.ts";
import type { PinnedReference } from "./plan.ts";
import { readPinnedReference } from "./references.ts";
import { WAN_CANVAS, resolveMotion } from "./motion.ts";

/** Codes computeSteps reports that make a step unrunnable; they carry over to the plan unchanged. */
const STEP_BLOCKERS = new Set(["STEP_BLOCKED", "NO_BRANCH", "DEPENDENCY_NOT_APPROVED"]);
const STEP = 16;
const MIN_SIDE = 256;
const MAX_SIDE = 2048;

/** What a deliverable step contributes to a generation plan. */
export interface DeliverableInputs {
  blockers: PlanBlocker[];
  notes: string[];
  deliverable?: Deliverable;
  index: number;
  /** The single image the workflow conditions on for a fresh run, hash-pinned. */
  reference?: PinnedReference;
  /** Canvas for the run; omitted when the workflow default applies. */
  size?: { width: number; height: number };
  /** Regions of a reference sheet to crop at publication. */
  crops: { id: string; x: number; y: number; width: number; height: number }[];
  /** Extra hash-pinned images the workflow consumes by role (an animation's `start_pose` and `end_pose`). */
  references: PinnedReference[];
  /** Workflow values this step fixes (an animation's `length`). */
  values?: Record<string, number>;
  /** Present for animations: guides, scale anchor and frame count. */
  motion?: MotionPlan;
  /** Cross-asset `direction` bindings of this deliverable resolved to the named environment branch's locked concept output. */
  directionPins: DirectionPin[];
}

interface CropRow { file_id: string; sha256: string; region_id: string }

/** Smallest canvas that contains every region, on the workflow's size grid. */
function sheetSize(regions: readonly { x: number; y: number; width: number; height: number }[]): { width: number; height: number } {
  const up = (n: number): number => Math.ceil(n / STEP) * STEP;
  return { width: up(Math.max(...regions.map((r) => r.x + r.width))), height: up(Math.max(...regions.map((r) => r.y + r.height))) };
}

/**
 * Everything a plan (and, again, its start) needs to know about one deliverable step: whether it can run, which
 * image conditions it, and how large the canvas is. Blockers are computed from the live step state, so a plan and
 * `step.list` can never disagree about readiness.
 *
 * Reference choice, with the single-image limit of krea2-variation stated plainly in `notes`: the workflow takes ONE
 * reference. A deliverable that binds a region of an approved sheet dependency through
 * `referenceRoles: { <name>: { deliverableId, outputRole: <region-id> } }` is conditioned on that hash-pinned crop
 * alone; otherwise it is conditioned on the branch's locked concept output alone.
 */
export async function resolveDeliverable(project: OpenProject, set: AuthoredSet, assetId: string, stepId: string, branchId: string | undefined): Promise<DeliverableInputs> {
  const out: DeliverableInputs = { blockers: [], notes: [], index: -1, crops: [], references: [], directionPins: [] };
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  const node = buildPipeline(spec).byId.get(stepId);
  const index = spec?.deliverables.findIndex((d) => d.id === stepId) ?? -1;
  if (!node?.deliverable || !spec) {
    out.blockers.push({ code: "STEP_UNKNOWN", message: `${assetId} has no deliverable step "${stepId}".`, recoveryActions: [{ label: "List the asset's steps", operation: "step.list", input: { assetId } }] });
    return out;
  }
  out.deliverable = node.deliverable;
  out.index = index;

  const branch = branchId
    ? project.db.query<{ concept_output_id: string; concept_output_hash: string }, [string, string]>("SELECT concept_output_id, concept_output_hash FROM branches WHERE branch_id = ? AND asset_id = ?").get(branchId, assetId)
    : undefined;
  if (!branchId) {
    out.blockers.push({
      code: "NO_BRANCH",
      message: `${stepId} is produced inside a branch: pass branchId (lock a concept first).`,
      recoveryActions: [{ label: "List branches", operation: "branch.list", input: { assetId } }, { label: "Lock a concept output", operation: "concept.lock", input: { assetId } }],
    });
  } else if (!branch) {
    out.blockers.push({ code: "NO_BRANCH", message: `Asset ${assetId} has no branch ${branchId}.`, recoveryActions: [{ label: "List branches", operation: "branch.list", input: { assetId } }] });
  }

  const steps = branch && branchId ? await computeSteps(project, assetId, branchId) : [];
  for (const b of steps.find((s) => s.stepId === stepId)?.blockers ?? []) if (STEP_BLOCKERS.has(b.code)) out.blockers.push(b);
  if (!branch || !branchId) return out;

  // --- cross-asset direction: the NAMED environment branch's locked concept output, pinned by id and hash (never "latest")
  const direction = resolveDirection(project.db, directionBindings(node.deliverable));
  out.directionPins = direction.pins;
  for (const u of direction.unresolved) out.blockers.push(unresolvedBlocker(u, assetId, stepId));
  let directionUsable = true;
  for (const pin of direction.pins) {
    if (!(await readPinnedReference(project, { id: pin.conceptOutputId, sha256: pin.outputHash }))) {
      directionUsable = false;
      out.blockers.push({
        code: "REFERENCE_MISSING",
        message: `${assetId}/${stepId}: the locked concept output ${pin.conceptOutputId} of ${pin.assetId}/${pin.branchId} is missing on disk or no longer matches its recorded hash.`,
        recoveryActions: [{ label: `Inspect the concept candidate of ${pin.assetId}`, operation: "branch.list", input: { assetId: pin.assetId } }],
      });
    }
  }

  // --- motion: Wan takes two hash-pinned, normalized guide poses instead of a single reference
  if (node.deliverable.kind === "animation") {
    if (!node.deliverable.animation) {
      out.blockers.push({ code: "STEP_BLOCKED", message: `${stepId} is an animation but has no animation block (motion text) in asset.yaml.`, recoveryActions: [{ label: "Read the asset definition", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } }] });
      return out;
    }
    out.size = { width: WAN_CANVAS, height: WAN_CANVAS };
    const target = node.deliverable.output;
    if (target?.width !== undefined && target.height !== undefined) {
      out.notes.push(`Target output ${target.width}x${target.height}px. Wan renders ${WAN_CANVAS}x${WAN_CANVAS}px; processing fits the frames to the exact target and nothing is silently downscaled here.`);
    }
    const motion = await resolveMotion(project, set, assetId, spec, { ...node.deliverable, animation: node.deliverable.animation }, branchId, { id: branch.concept_output_id, sha256: branch.concept_output_hash }, steps);
    out.blockers.push(...motion.blockers);
    out.notes.push(...motion.notes);
    out.references.push(...motion.references);
    if (motion.motion) {
      out.motion = motion.motion;
      out.values = { length: motion.motion.frameCount };
    }
    return out;
  }

  // --- canvas
  const regions = node.deliverable.kind === "reference-sheet" ? node.deliverable.regions ?? [] : [];
  if (regions.length > 0) {
    out.size = sheetSize(regions);
    out.crops = regions.map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height }));
    if (out.size.width > MAX_SIDE || out.size.height > MAX_SIDE) {
      out.blockers.push({ code: "SIZE_UNSUPPORTED", message: `The regions of ${stepId} need a ${out.size.width}x${out.size.height} canvas; the workflow generates at most ${MAX_SIDE} on a side.`, recoveryActions: [{ label: "Shrink the regions in asset.yaml", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } }] });
    }
  }

  const target = node.deliverable.output;
  if (regions.length === 0 && target?.width !== undefined && target.height !== undefined) {
    const fit = (n: number): number => Math.max(MIN_SIDE, Math.ceil(n / STEP) * STEP);
    out.size = { width: fit(target.width), height: fit(target.height) };
    out.notes.push(`Target output ${target.width}x${target.height}px; generating ${out.size.width}x${out.size.height}px (rounded up to a multiple of ${STEP}, at least ${MIN_SIDE}). The exact target is applied by processing; nothing is silently downscaled here.`);
    if (out.size.width > MAX_SIDE || out.size.height > MAX_SIDE) {
      out.blockers.push({ code: "SIZE_UNSUPPORTED", message: `${stepId} asks for ${target.width}x${target.height}px, which needs a ${out.size.width}x${out.size.height} canvas; the workflow generates at most ${MAX_SIDE} on a side.`, recoveryActions: [{ label: "Lower output.width/height in asset.yaml", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } }] });
    }
  } else if (regions.length > 0 && target?.width !== undefined) {
    out.notes.push(`output.width/height are ignored for a reference sheet: its canvas comes from its regions (${out.size?.width}x${out.size?.height}px).`);
  }

  // --- reference: a bound crop of an approved sheet, else the environment's pinned direction, else the locked concept output
  const bound: { role: string; crop: CropRow | undefined; label: string }[] = [];
  for (const [role, value] of Object.entries(node.deliverable.referenceRoles)) {
    if (asCrossAsset(value)) continue; // resolved above as a direction pin
    const ref = value as { deliverableId?: unknown; outputRole?: unknown } | null;
    if (typeof ref !== "object" || ref === null || typeof ref.deliverableId !== "string" || typeof ref.outputRole !== "string") {
      out.notes.push(`referenceRoles.${role} is not a { deliverableId, outputRole } binding of this asset; it is ignored by generation.`);
      continue;
    }
    if (!node.deliverable.dependsOn.includes(ref.deliverableId)) {
      out.notes.push(`referenceRoles.${role} names ${ref.deliverableId}, which is not in dependsOn; it is ignored by generation.`);
      continue;
    }
    const selection = selectedOutput(project.db, branchId, ref.deliverableId);
    if (!selection) continue; // the dependency blocker already says it has nothing selected
    const crop = project.db.query<CropRow, [string, string]>("SELECT file_id, sha256, region_id FROM output_crops WHERE output_id = ? AND region_id = ?").get(selection.outputId, ref.outputRole) ?? undefined;
    bound.push({ role, crop, label: `${ref.deliverableId}/${ref.outputRole}` });
  }
  const first = bound[0];
  if (first) {
    if (!first.crop) {
      out.blockers.push({ code: "REFERENCE_MISSING", message: `referenceRoles.${first.role} names ${first.label}, but the selected ${first.label.split("/")[0]} output has no crop for that region.`, recoveryActions: [{ label: "Inspect the dependency", operation: "step.inspect", input: { assetId, stepId: first.label.split("/")[0], branchId } }] });
    } else {
      out.reference = { role: "reference", id: first.crop.file_id, sha256: first.crop.sha256 };
      out.notes.push(`Conditioned on the ${first.label} crop (sha256 ${first.crop.sha256.slice(0, 12)}) alone. krea2-variation takes a single reference image, so the locked concept output is not sent in this run; identity relies on the crop, which was derived from the approved sheet.`);
    }
    if (bound.length > 1) out.notes.push(`Only ${first.label} is sent: ${bound.slice(1).map((b) => b.label).join(", ")} cannot be used because the workflow takes one reference image.`);
  } else if (out.directionPins[0] && directionUsable) {
    const pin = out.directionPins[0];
    out.reference = { role: "reference", id: pin.conceptOutputId, sha256: pin.outputHash };
    out.notes.push(`Conditioned on the locked concept of ${pin.assetId}/${pin.branchId} (output ${pin.conceptOutputId}, sha256 ${pin.outputHash.slice(0, 12)}) as this step's direction, not on ${assetId}'s own concept. krea2-variation takes a single reference image.${out.directionPins.length > 1 ? ` Only ${pin.assetId}/${pin.branchId} is sent; the other direction bindings are pinned but not used as an image.` : ""}`);
  } else {
    out.reference = { role: "reference", id: branch.concept_output_id, sha256: branch.concept_output_hash };
    const sheets = node.dependsOn.flatMap((dep) => {
      const sel = selectedOutput(project.db, branchId, dep);
      const regionIds = sel ? project.db.query<{ region_id: string }, [string]>("SELECT region_id FROM output_crops WHERE output_id = ? ORDER BY region_id").all(sel.outputId).map((r) => r.region_id) : [];
      return regionIds.length > 0 ? [`${dep} (${regionIds.join(", ")})`] : [];
    });
    out.notes.push(`Conditioned on the branch's locked concept output alone (krea2-variation takes a single reference image).${sheets.length > 0 ? ` The approved crops of ${sheets.join("; ")} are not sent; bind one with referenceRoles: { <name>: { deliverableId: <sheet>, outputRole: <region-id> } } to use it instead.` : ""}`);
  }
  if (out.reference && !(await readPinnedReference(project, out.reference))) {
    out.blockers.push({ code: "OUTPUT_MISSING", message: `Reference ${out.reference.id} is missing on disk or no longer matches its recorded hash.`, recoveryActions: [{ label: "Inspect the step", operation: "step.inspect", input: { assetId, stepId, branchId } }] });
  }
  return out;
}
