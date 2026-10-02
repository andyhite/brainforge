import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import type { DirectionPin, NextAction, OutputApproval, PlanBlocker, StepState } from "@brainforge/contracts";
import { resolveIn, sha256 } from "@brainforge/storage";
import { discoverAuthored, type AuthoredSet } from "../authored.ts";
import { feedbackCandidateIds } from "../branches/feedback.ts";
import { movedInputs, movedReasons } from "../branches/diff.ts";
import { directionReasons } from "../environments/direction.ts";
import { authoredSetFor, resolveDefaultBranchId } from "../branches/basis.ts";
import { buildPipeline, type PipelineNode, type PipelinePlan } from "../pipeline.ts";
import { standingApproval } from "../review/authority.ts";
import { stepFingerprint, stepRequirementsHash, selectedOutput, type SelectedOutput } from "../review/requirements.ts";
import { onDiskManifestHash } from "../outputs/frames.ts";
import { feedbackActions, inspectConceptStep, specHashesOf, unaddressedRequiredNotes } from "../review/step.ts";
import { OperationFailure } from "../runtime.ts";

const ACTIVE_JOB_STATES = "('queued','submitting','running','collecting')";
/** Blocker codes that stop a step from being ready. Others (for example an unresolved submission) only inform. */
const BLOCKING = new Set(["STEP_BLOCKED", "NO_BRANCH", "DEPENDENCY_NOT_APPROVED"]);

export interface StepContext { db: Database; root: string }

interface BranchRow { branch_id: string; concept_candidate_id: string; concept_output_id: string }

/** The selected output of a deliverable together with what is currently true of it. */
interface Standing { selection: SelectedOutput; approval: OutputApproval; stage: "source" | "processed" }

const scalar = (db: Database, sql: string, ...args: string[]): number => db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;

async function standingFor(ctx: StepContext, current: AuthoredSet, assetId: string, branchId: string, stepId: string): Promise<Standing | undefined> {
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
  const stage = row?.stage ?? "source";
  return { selection, stage, approval: standingApproval(ctx.db, selection.outputId, stepFingerprint(ctx, current, assetId, stepId, branchId, { stage }), onDisk, branchId) };
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

/** Open revision requests that hold a step of a branch (its own candidates' and those of the lineage it reused). */
function openRevisionIds(db: Database, assetId: string, stepId: string, branchId: string): string[] {
  return db.query<{ revision_request_id: string }, [string, string, string]>(
    "SELECT q.revision_request_id FROM revision_requests q WHERE q.asset_id = ? AND q.step_id = ? AND q.status IN ('open','responded') AND q.candidate_id IN (SELECT value FROM json_each(?)) ORDER BY q.created_at, q.rowid",
  ).all(assetId, stepId, JSON.stringify(feedbackCandidateIds(db, assetId, stepId, branchId))).map((r) => r.revision_request_id);
}

/** Required notes nobody has resolved or waived on this step's candidates in the branch (and on a reused lineage). */
function unaddressedOnStep(db: Database, assetId: string, stepId: string, branchId: string): { annotationId: string; candidateId: string }[] {
  const inScope = new Set(feedbackCandidateIds(db, assetId, stepId, branchId));
  return unaddressedRequiredNotes(db, assetId).filter((n) => inScope.has(n.candidateId));
}

/** Required notes plus open revision requests on this step in this branch that nobody has resolved or waived. */
export function openFeedbackCount(db: Database, assetId: string, stepId: string, branchId: string): number {
  return unaddressedOnStep(db, assetId, stepId, branchId).length + openRevisionIds(db, assetId, stepId, branchId).length;
}

const hasOpenFeedback = (db: Database, assetId: string, stepId: string, branchId: string): boolean => openFeedbackCount(db, assetId, stepId, branchId) > 0;

/** `current` = the authored files now (fingerprints resolve a branch's own basis from it); `set` = what this branch's inputs are. */
async function deliverableStep(ctx: StepContext, current: AuthoredSet, set: AuthoredSet, assetId: string, pipeline: PipelinePlan, node: PipelineNode, branch: BranchRow | undefined, memo: Map<string, Promise<Standing | undefined>>): Promise<StepState> {
  const { db } = ctx;
  const stepId = node.id;
  const branchId = branch?.branch_id;
  const standing = (id: string): Promise<Standing | undefined> => {
    if (!branchId) return Promise.resolve(undefined);
    const known = memo.get(id);
    if (known) return known;
    const made = standingFor(ctx, current, assetId, branchId, id);
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
    const feedbackOpen = branchId !== undefined && hasOpenFeedback(db, assetId, dep, branchId);
    if (branch && isApproved(s) && !rawMotion && !feedbackOpen) continue;
    blockers.push({
      code: "DEPENDENCY_NOT_APPROVED",
      message: `Waiting for ${dep}: ${!branch ? `${dep} needs a branch first` : rawMotion ? `${dep}'s selected output is raw source frames; it needs a processed, approved output` : feedbackOpen && isApproved(s) ? `${dep} has unresolved required feedback` : whyNotApproved(dep, s)}`,
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
      openRevisions: openRevisionIds(db, assetId, stepId, branchId).length,
      pendingEscalations: scalar(db, "SELECT COUNT(*) AS n FROM review_escalations WHERE asset_id = ? AND step_id = ? AND branch_id = ? AND status = 'pending'", ...where),
    };
    failedJobs = scalar(db, "SELECT COUNT(*) AS n FROM generation_jobs j JOIN generation_runs r ON r.run_id = j.run_id WHERE j.asset_id = ? AND j.step_id = ? AND r.branch_id = ? AND j.state = 'failed'", ...where);
    newest = db.query<{ candidate_id: string }, string[]>("SELECT candidate_id FROM candidates WHERE asset_id = ? AND step_id = ? AND branch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(...where)?.candidate_id;
    own = await standing(stepId);

    unaddressed = unaddressedOnStep(db, assetId, stepId, branchId);

    const stagePrefix = node.kind === "animation" ? (own?.stage === "processed" ? "processed: " : "raw: ") : "";
    if (own && (own.approval.state === "approved" || own.approval.state === "rejected") && !own.approval.applicable) {
      reasons.push(`${stagePrefix}${stepId}: ${own.approval.staleReason ?? "the decision no longer applies"}`);
    }
    // An approved dependency that went stale makes everything built on it worth a second look.
    for (const dep of node.dependsOn) {
      const up = dep === "concept" ? undefined : await standing(dep);
      if (up && (up.approval.state === "approved" || up.approval.state === "rejected") && !up.approval.applicable) {
        reasons.push(`upstream ${dep} changed: ${up.approval.staleReason ?? "its decision no longer applies"}`);
      }
    }
    const latest = db.query<{ plan_json: string }, string[]>(
      `SELECT r.plan_json FROM generation_runs r WHERE r.asset_id = ? AND r.step_id = ? AND r.branch_id = ?
          AND EXISTS (SELECT 1 FROM candidates c WHERE c.run_id = r.run_id)
        ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
    ).get(...where);
    if (latest) {
      const plan: { directionPins?: DirectionPin[] } = JSON.parse(latest.plan_json);
      const moved = movedInputs(ctx, set, specHashesOf(JSON.parse(latest.plan_json)), assetId, stepId);
      const processedStale = own?.stage === "processed" && !own.approval.applicable;
      reasons.push(...movedReasons(moved, `the newest candidates of ${stepId} were generated`, { source: node.kind === "animation" ? "raw: " : "", processed: "processed: " }, processedStale));
      reasons.push(...directionReasons(db, node.deliverable, plan.directionPins ?? [], stepId));
    }
  }
  if (counts.unresolvedJobs > 0) {
    blockers.push({
      code: "SUBMISSION_UNRESOLVED",
      message: `${counts.unresolvedJobs} job(s) have an ambiguous ComfyUI submission; they are not assumed to have run or not run`,
      recoveryActions: [{ label: "Inspect unresolved jobs", operation: "job.list", input: { assetId, state: "unresolved" } }],
    });
  }
  // Required feedback stays with the step and branch until an authorized reviewer resolves or waives it, however many newer candidates exist.
  if (unaddressed.length > 0 || counts.openRevisions > 0) {
    const openRevisions = openRevisionIds(db, assetId, stepId, branchId ?? "").map((revision_request_id) => ({ revision_request_id }));
    blockers.push({
      code: "REVISION_OPEN",
      message: `${stepId} has unresolved required feedback (${[...new Set(unaddressed.map((n) => n.candidateId))].join(", ") || openRevisions.map((r) => r.revision_request_id).join(", ")}); it stays open on every candidate of this step until revision.resolve or revision.waive`,
      recoveryActions: openRevisions.length > 0
        ? openRevisions.map((r) => ({ label: `Inspect ${r.revision_request_id}`, operation: "revision.inspect", input: { revisionRequestId: r.revision_request_id } }))
        : [{ label: "Bundle the required notes into a revision request", operation: "revision.create", input: { candidateId: unaddressed[0]?.candidateId, annotationIds: unaddressed.map((n) => n.annotationId) } }],
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
    next.push({ label: "Review the candidate material", operation: "review.material", input: { candidateId: own?.selection.candidateId ?? newest, branchId } });
  }
  if (branchId && counts.candidates > 0) {
    const requirementsHash = (stage: "source" | "processed") => stepFingerprint(ctx, current, assetId, stepId, branchId, { stage });
    if (!own) {
      const approved = db.query<{ candidate_id: string; output_id: string; sha256: string; stage: "source" | "processed" }, string[]>(
        `SELECT c.candidate_id, o.output_id, o.sha256, o.stage FROM candidates c JOIN candidate_outputs o ON o.candidate_id = c.candidate_id
          WHERE c.asset_id = ? AND c.step_id = ? AND c.branch_id = ?${node.kind === "animation" ? " AND o.stage = 'processed'" : ""} ORDER BY c.created_at DESC, c.rowid DESC`,
      ).all(assetId, stepId, branchId).find((o) => {
        const a = standingApproval(db, o.output_id, requirementsHash(o.stage), o.sha256, branchId);
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
  next.push(...feedbackActions(assetId, unaddressed, counts.openRevisions));

  return {
    assetId, stepId, ...(branchId ? { branchId } : {}), kind: node.kind, required: node.required, dependsOn: node.dependsOn,
    state, blockers, needsReassessment: reasons.length > 0, reassessmentReasons: reasons,
    ...(own ? { selected: { candidateId: own.selection.candidateId, outputId: own.selection.outputId, approval: own.approval } } : {}),
    counts, nextActions: next,
  };
}

/** Every step of an asset's pipeline for one branch (default: the current branch; with no branches, the concept step alone being able to be ready). */
export async function computeSteps(ctx: StepContext, assetId: string, requestedBranchId?: string): Promise<StepState[]> {
  const concept = await inspectConceptStep(ctx.db, ctx.root, assetId);
  const current = await discoverAuthored(ctx.root);
  const branchId = requestedBranchId ?? resolveDefaultBranchId(ctx.db, assetId);

  let branch: (BranchRow & { requirements_hash: string }) | undefined;
  if (branchId) {
    branch = ctx.db.query<BranchRow & { requirements_hash: string }, [string, string]>("SELECT branch_id, concept_candidate_id, concept_output_id, requirements_hash FROM branches WHERE branch_id = ? AND asset_id = ?").get(branchId, assetId) ?? undefined;
    if (!branch) throw new OperationFailure("NOT_FOUND", `Asset ${assetId} has no branch ${branchId}`, undefined, [{ label: "List branches", operation: "branch.list", input: { assetId } }]);
  }
  const set = authoredSetFor(ctx.db, current, branchId);
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  const pipeline = buildPipeline(spec);
  const steps: StepState[] = [];
  const memo = new Map<string, Promise<Standing | undefined>>();
  for (const node of pipeline.nodes) {
    if (node.id === "concept") {
      const note = pipeline.reserved.map((message): PlanBlocker => ({ code: "DELIVERABLE_IGNORED", message, recoveryActions: [{ label: "Read the asset definition", operation: "spec.read", input: { path: `brainforge/assets/${assetId}/asset.yaml` } }] }));
      // The concept a branch was locked on is judged against the requirements the branch consumes.
      const drifted = branch && stepRequirementsHash(ctx, current, assetId, "concept", branch.branch_id) !== branch.requirements_hash
        ? ["concept: identity or direction changed since this concept was locked; production needs a renewed concept-lock review"] : [];
      steps.push({
        ...concept, blockers: [...concept.blockers, ...note],
        ...(drifted.length > 0 ? { needsReassessment: true, reassessmentReasons: [...concept.reassessmentReasons, ...drifted] } : {}),
        ...(branch ? {
          branchId: branch.branch_id,
          state: concept.state === "running" || concept.state === "blocked" ? concept.state : "complete",
          selected: { candidateId: branch.concept_candidate_id, outputId: branch.concept_output_id },
        } : {}),
      });
    } else {
      steps.push(await deliverableStep(ctx, current, set, assetId, pipeline, node, branch, memo));
    }
  }
  return steps;
}
