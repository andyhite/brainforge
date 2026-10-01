import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import type { NextAction, OutputApproval, PlanBlocker, StepState } from "@brainforge/contracts";
import { resolveIn, sha256 } from "@brainforge/storage";
import { discoverAuthored, type AuthoredSet } from "../authored.ts";
import { buildPipeline, type PipelineNode, type PipelinePlan } from "../pipeline.ts";
import { standingApproval } from "../review/authority.ts";
import { stepRequirementsHash, selectedOutput, type SelectedOutput } from "../review/requirements.ts";
import { onDiskManifestHash } from "../outputs/frames.ts";
import { inspectConceptStep, specHashesOf, unaddressedRequiredNotes } from "../review/step.ts";
import { OperationFailure } from "../runtime.ts";

const ACTIVE_JOB_STATES = "('queued','submitting','running','collecting')";
/** Blocker codes that stop a step from being ready. Others (for example an unresolved submission) only inform. */
const BLOCKING = new Set(["STEP_BLOCKED", "NO_BRANCH", "DEPENDENCY_NOT_APPROVED"]);

export interface StepContext { db: Database; root: string }

interface BranchRow { branch_id: string; concept_candidate_id: string; concept_output_id: string }

/** The selected output of a deliverable together with what is currently true of it. */
interface Standing { selection: SelectedOutput; approval: OutputApproval; stage: "source" | "processed" }

const scalar = (db: Database, sql: string, ...args: string[]): number => db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;

async function standingFor(ctx: StepContext, set: AuthoredSet, assetId: string, branchId: string, stepId: string): Promise<Standing | undefined> {
  const selection = selectedOutput(ctx.db, branchId, stepId);
  if (!selection) return undefined;
  const row = ctx.db.query<{ path: string; media_kind: string; stage: "source" | "processed" }, [string]>("SELECT path, media_kind, stage FROM candidate_outputs WHERE output_id = ?").get(selection.outputId);
  // The recorded hash is only trusted after the bytes on disk agree with it (a frame sequence's hash is its manifest hash).
  let onDisk = "missing";
  if (row?.media_kind === "frames") onDisk = (await onDiskManifestHash(ctx, selection.outputId)) ?? "missing";
  else if (row) {
    const bytes = await readFile(await resolveIn(ctx.root, row.path)).catch(() => undefined);
    if (bytes) onDisk = sha256(bytes);
  }
  return { selection, stage: row?.stage ?? "source", approval: standingApproval(ctx.db, selection.outputId, stepRequirementsHash(ctx, set, assetId, stepId, branchId), onDisk) };
}

const isApproved = (s: Standing | undefined): s is Standing => s !== undefined && s.approval.state === "approved" && s.approval.applicable;

function whyNotApproved(dep: string, s: Standing | undefined): string {
  if (!s) return `${dep} has no selected output yet`;
  const a = s.approval;
  if (!a.applicable) return `${dep}'s approval no longer applies: ${a.staleReason ?? "inputs changed"}`;
  if (a.state === "escalated") return `${dep} is waiting for a human decision on an escalation`;
  if (a.state === "rejected") return `${dep}'s selected output was rejected`;
  return `${dep}'s selected output has not been approved`;
}

async function deliverableStep(ctx: StepContext, set: AuthoredSet, assetId: string, pipeline: PipelinePlan, node: PipelineNode, branch: BranchRow | undefined, memo: Map<string, Promise<Standing | undefined>>): Promise<StepState> {
  const { db } = ctx;
  const stepId = node.id;
  const branchId = branch?.branch_id;
  const standing = (id: string): Promise<Standing | undefined> => {
    if (!branchId) return Promise.resolve(undefined);
    const known = memo.get(id);
    if (known) return known;
    const made = standingFor(ctx, set, assetId, branchId, id);
    memo.set(id, made);
    return made;
  };

  const blockers: PlanBlocker[] = [];
  const next: NextAction[] = [];
  const editAsset = [{ label: "Read the asset definition", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } }];
  for (const problem of node.problems) blockers.push({ code: "STEP_BLOCKED", message: problem, recoveryActions: editAsset });
  if (!set.project?.valid) {
    blockers.push({ code: "STEP_BLOCKED", message: "brainforge/project.yaml is missing or invalid", recoveryActions: [{ label: "Read project.yaml", operation: "spec.read", input: { path: "brainforge/project.yaml" } }] });
  }
  if (!branch) {
    blockers.push({
      code: "NO_BRANCH",
      message: `${stepId} is produced inside a branch, and no concept has been locked yet`,
      recoveryActions: [{ label: "Lock a concept output to create a branch", operation: "concept.lock", input: { assetId } }, { label: "List existing branches", operation: "branch.list", input: { assetId } }],
    });
  }
  for (const dep of node.dependsOn) {
    // Unknown ids and "concept" are already reported as this step's own problems.
    if (dep === "concept" || !pipeline.byId.has(dep)) continue;
    const s = await standing(dep);
    // An animation is delivered only as processed frames: approved raw source frames do not satisfy its dependents.
    const rawMotion = pipeline.byId.get(dep)?.kind === "animation" && s !== undefined && s.stage !== "processed";
    if (branch && isApproved(s) && !rawMotion) continue;
    blockers.push({
      code: "DEPENDENCY_NOT_APPROVED",
      message: `Waiting for ${dep}: ${!branch ? `${dep} needs a branch first` : rawMotion ? `${dep}'s selected output is raw source frames; it needs a processed, approved output` : whyNotApproved(dep, s)}`,
      recoveryActions: [{ label: `Inspect ${dep}`, operation: "step.inspect", input: { assetId, stepId: dep, ...(branchId ? { branchId } : {}) } }],
    });
  }

  const empty = { candidates: 0, activeJobs: 0, unresolvedJobs: 0, favorites: 0, openRevisions: 0, pendingEscalations: 0 };
  let counts = empty;
  let failedJobs = 0;
  const reasons: string[] = [];
  let own: Standing | undefined;
  let unaddressed: { annotationId: string; candidateId: string }[] = [];
  let newest: string | undefined;
  if (branchId) {
    const where = [assetId, stepId, branchId];
    counts = {
      candidates: scalar(db, "SELECT COUNT(*) AS n FROM candidates WHERE asset_id = ? AND step_id = ? AND branch_id = ?", ...where),
      activeJobs: scalar(db, `SELECT COUNT(*) AS n FROM generation_jobs j JOIN generation_runs r ON r.run_id = j.run_id WHERE j.asset_id = ? AND j.step_id = ? AND r.branch_id = ? AND j.state IN ${ACTIVE_JOB_STATES}`, ...where),
      unresolvedJobs: scalar(db, "SELECT COUNT(*) AS n FROM generation_jobs j JOIN generation_runs r ON r.run_id = j.run_id WHERE j.asset_id = ? AND j.step_id = ? AND r.branch_id = ? AND j.state = 'unresolved'", ...where),
      favorites: scalar(db, "SELECT COUNT(*) AS n FROM candidates WHERE asset_id = ? AND step_id = ? AND branch_id = ? AND favorite = 1", ...where),
      openRevisions: scalar(db, "SELECT COUNT(*) AS n FROM revision_requests q JOIN candidates c ON c.candidate_id = q.candidate_id WHERE q.asset_id = ? AND q.step_id = ? AND c.branch_id = ? AND q.status IN ('open','responded')", ...where),
      pendingEscalations: scalar(db, "SELECT COUNT(*) AS n FROM review_escalations WHERE asset_id = ? AND step_id = ? AND branch_id = ? AND status = 'pending'", ...where),
    };
    failedJobs = scalar(db, "SELECT COUNT(*) AS n FROM generation_jobs j JOIN generation_runs r ON r.run_id = j.run_id WHERE j.asset_id = ? AND j.step_id = ? AND r.branch_id = ? AND j.state = 'failed'", ...where);
    newest = db.query<{ candidate_id: string }, string[]>("SELECT candidate_id FROM candidates WHERE asset_id = ? AND step_id = ? AND branch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(...where)?.candidate_id;
    own = await standing(stepId);

    unaddressed = unaddressedRequiredNotes(db, assetId).filter((n) => {
      const c = db.query<{ step_id: string; branch_id: string | null }, [string]>("SELECT step_id, branch_id FROM candidates WHERE candidate_id = ?").get(n.candidateId);
      return c?.step_id === stepId && c.branch_id === branchId;
    });

    if (own && (own.approval.state === "approved" || own.approval.state === "rejected") && !own.approval.applicable) {
      reasons.push(`${stepId}: ${own.approval.staleReason ?? "the decision no longer applies"}`);
    }
    const latest = db.query<{ plan_json: string }, string[]>(
      `SELECT r.plan_json FROM generation_runs r WHERE r.asset_id = ? AND r.step_id = ? AND r.branch_id = ?
          AND EXISTS (SELECT 1 FROM candidates c WHERE c.run_id = r.run_id)
        ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
    ).get(...where);
    if (latest) {
      for (const [path, hash] of Object.entries(specHashesOf(JSON.parse(latest.plan_json)))) {
        const current = set.all().find((f) => f.path === path);
        if (!current) reasons.push(`${path} no longer exists`);
        else if (current.hash !== hash) reasons.push(`${path} changed since the newest candidates of ${stepId} were generated`);
      }
    }
  }
  if (counts.unresolvedJobs > 0) {
    blockers.push({
      code: "SUBMISSION_UNRESOLVED",
      message: `${counts.unresolvedJobs} job(s) have an ambiguous ComfyUI submission; they are not assumed to have run or not run`,
      recoveryActions: [{ label: "Inspect unresolved jobs", operation: "job.list", input: { assetId, state: "unresolved" } }],
    });
  }

  const structural = blockers.some((b) => BLOCKING.has(b.code));
  // An animation is only ever delivered as processed export-rate frames: approved raw source frames never complete it.
  const ownStage = own?.stage;
  const needsProcessing = node.kind === "animation" && own !== undefined && ownStage !== "processed";
  if (needsProcessing && own) {
    blockers.push({
      code: "PROCESSING_REQUIRED",
      message: `The selected output of ${stepId} is raw source frames. An animation completes only when a processed export-rate output is selected and approved.`,
      recoveryActions: [{ label: "Plan processing of the source frames", operation: "processing.plan", input: { candidateId: own.selection.candidateId, outputId: own.selection.outputId } }],
    });
  }
  const settled = own !== undefined && own.approval.state === "approved" && own.approval.applicable && !needsProcessing;
  const awaitingHuman = counts.pendingEscalations > 0 || own?.approval.state === "escalated";
  let state: StepState["state"];
  if (counts.activeJobs > 0) state = "running";
  else if (structural) state = "blocked";
  else if (settled && !awaitingHuman && unaddressed.length === 0 && counts.openRevisions === 0) state = "complete";
  else if (own && own.approval.state === "rejected" && own.approval.applicable && !awaitingHuman) state = "ready";
  else if (counts.candidates > 0) state = "awaiting_review";
  else if (failedJobs > 0 || counts.unresolvedJobs > 0) state = "failed";
  else state = "ready";

  if (state === "running") next.push({ label: "Watch running jobs", operation: "job.list", input: { assetId, activeOnly: true } });
  if (state === "ready" || state === "awaiting_review" || state === "failed") {
    next.push({ label: state === "ready" && counts.candidates === 0 ? "Plan the first batch" : "Plan another batch", operation: "generation.plan", input: { assetId, stepId, branchId, mode: "fresh" } });
  }
  if (branchId && newest) {
    if (node.kind === "animation") {
      if (!own || ownStage !== "processed") {
        const base = `FROM candidates c JOIN candidate_outputs o ON o.candidate_id = c.candidate_id WHERE c.asset_id = ? AND c.step_id = ? AND c.branch_id = ?`;
        const processed = db.query<{ candidate_id: string; output_id: string }, string[]>(`SELECT c.candidate_id, o.output_id ${base} AND o.stage = 'processed' ORDER BY c.created_at DESC, c.rowid DESC, o.rowid DESC LIMIT 1`).get(assetId, stepId, branchId);
        const source = db.query<{ candidate_id: string; output_id: string }, string[]>(`SELECT c.candidate_id, o.output_id ${base} AND o.stage = 'source' AND o.media_kind = 'frames' ORDER BY c.created_at DESC, c.rowid DESC, o.rowid DESC LIMIT 1`).get(assetId, stepId, branchId);
        if (processed) next.push({ label: "Select the newest processed output for this step", operation: "candidate.select", input: { branchId, deliverableId: stepId, candidateId: processed.candidate_id, outputId: processed.output_id } });
        else if (source) next.push({ label: "Process the newest source frames into an export-rate clip", operation: "processing.plan", input: { candidateId: source.candidate_id, outputId: source.output_id } });
      }
    } else if (!own) next.push({ label: "Select a candidate for this step", operation: "candidate.select", input: { branchId, deliverableId: stepId, candidateId: newest } });
    next.push({ label: "Review the candidate material", operation: "review.material", input: { candidateId: own?.selection.candidateId ?? newest } });
  }
  if (branchId && counts.candidates > 0) {
    const requirementsHash = stepRequirementsHash(ctx, set, assetId, stepId, branchId);
    if (!own) {
      const approved = db.query<{ candidate_id: string; output_id: string; sha256: string }, string[]>(
        `SELECT c.candidate_id, o.output_id, o.sha256 FROM candidates c JOIN candidate_outputs o ON o.candidate_id = c.candidate_id
          WHERE c.asset_id = ? AND c.step_id = ? AND c.branch_id = ?${node.kind === "animation" ? " AND o.stage = 'processed'" : ""} ORDER BY c.created_at DESC, c.rowid DESC`,
      ).all(assetId, stepId, branchId).find((o) => {
        const a = standingApproval(db, o.output_id, requirementsHash, o.sha256);
        return a.state === "approved" && a.applicable;
      });
      if (approved) {
        blockers.push({ code: "APPROVED_NOT_SELECTED", message: `Candidate ${approved.candidate_id} is approved but not selected, so ${stepId} cannot complete`, recoveryActions: [] });
        next.unshift({ label: "Use the approved candidate", operation: "candidate.select", input: { branchId, deliverableId: stepId, candidateId: approved.candidate_id, outputId: approved.output_id } });
      }
    } else if (own.approval.state === "rejected" && own.approval.applicable) {
      blockers.push({ code: "SELECTION_REJECTED", message: `The selected output of ${stepId} was rejected; select another candidate or generate a new one`, recoveryActions: [] });
      next.unshift({ label: "Select another candidate", operation: "candidate.list", input: { assetId, stepId } });
    }
  }
  if (unaddressed.length > 0) {
    next.push({ label: `Bundle ${unaddressed.length} required note(s) into a revision request`, operation: "revision.create", input: { candidateId: unaddressed[0]?.candidateId, annotationIds: unaddressed.map((n) => n.annotationId) } });
  }
  if (counts.openRevisions > 0) next.push({ label: "See open revision requests", operation: "revision.list", input: { assetId } });

  return {
    assetId, stepId, ...(branchId ? { branchId } : {}), kind: node.kind, required: node.required, dependsOn: node.dependsOn,
    state, blockers, needsReassessment: reasons.length > 0, reassessmentReasons: reasons,
    ...(own ? { selected: { candidateId: own.selection.candidateId, outputId: own.selection.outputId, approval: own.approval } } : {}),
    counts, nextActions: next,
  };
}

/** Every step of an asset's pipeline for one branch (or, with none, the concept step alone being able to be ready). */
export async function computeSteps(ctx: StepContext, assetId: string, branchId?: string): Promise<StepState[]> {
  const concept = await inspectConceptStep(ctx.db, ctx.root, assetId);
  const set = await discoverAuthored(ctx.root);
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  const pipeline = buildPipeline(spec);

  let branch: BranchRow | undefined;
  if (branchId) {
    branch = ctx.db.query<BranchRow, [string, string]>("SELECT branch_id, concept_candidate_id, concept_output_id FROM branches WHERE branch_id = ? AND asset_id = ?").get(branchId, assetId) ?? undefined;
    if (!branch) throw new OperationFailure("NOT_FOUND", `Asset ${assetId} has no branch ${branchId}`, undefined, [{ label: "List branches", operation: "branch.list", input: { assetId } }]);
  }
  const steps: StepState[] = [];
  const memo = new Map<string, Promise<Standing | undefined>>();
  for (const node of pipeline.nodes) {
    if (node.id === "concept") {
      const note = pipeline.reserved.map((message): PlanBlocker => ({ code: "DELIVERABLE_IGNORED", message, recoveryActions: [{ label: "Read the asset definition", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } }] }));
      steps.push({
        ...concept, blockers: [...concept.blockers, ...note],
        ...(branch ? {
          branchId: branch.branch_id,
          state: concept.state === "running" || concept.state === "blocked" ? concept.state : "complete",
          selected: { candidateId: branch.concept_candidate_id, outputId: branch.concept_output_id },
        } : {}),
      });
    } else {
      steps.push(await deliverableStep(ctx, set, assetId, pipeline, node, branch, memo));
    }
  }
  return steps;
}
