import { rm } from "node:fs/promises";
import { GenerationPlan, type Job, type ParsedOperationInput, type RecoveryAction } from "@brainforge/contracts";
import { graphHash, preflight, type ComfyTransport } from "@brainforge/comfy";
import { paths, resolveIn, writeJsonAtomic } from "@brainforge/storage";
import { discoverAuthored } from "../authored.ts";
import { authoredSetFor } from "../branches/basis.ts";
import { computeEffective } from "../effective.ts";
import { confirmedPreferences } from "../preferences/store.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { loadDescriptor } from "./descriptors.ts";
import { resolveDeliverable } from "./deliverable.ts";
import { PLAN_TTL_MS, changedSpecs, storedPlan } from "./plan.ts";
import { motionBasis } from "./motion.ts";
import { assertPlanHash, normalizedHash } from "../operations.ts";
import { readPinnedReference } from "./references.ts";
import { schedulerOf } from "./scheduler.ts";
import { jobRow, newId, toJob } from "./store.ts";

/** Plan blockers that describe the plan's own content. Everything else is environmental and re-checked live at start. */
const CONTENT_BLOCKERS = new Set([
  "PROJECT_INVALID", "ASSET_INVALID", "BATCH_TOO_LARGE", "WORKFLOW_UNAVAILABLE", "PARENT_REQUIRED", "PARENT_MISSING", "PARENT_UNEXPECTED",
  "OUTPUT_MISSING", "REFERENCE_UNSUPPORTED", "REFERENCE_CONFLICT", "REFERENCE_MISSING", "REFERENCE_REQUIRED", "ITERATION_REQUIRED",
  "STYLE_CONFLICT", "WORKFLOW_INPUT_MISSING", "STEP_UNKNOWN", "STEP_BLOCKED", "NO_BRANCH", "DEPENDENCY_NOT_APPROVED", "SIZE_UNSUPPORTED", "BRANCH_UNEXPECTED",
  "GUIDE_MISSING", "GUIDE_NOT_APPROVED", "GUIDE_CLIPPED", "FRAME_COUNT_INVALID", "ANCHOR_MISSING", "MODE_UNSUPPORTED", "SAVED_INPUTS_UNAVAILABLE",
]);

export interface StartEnvironment {
  project: OpenProject;
  comfy: ComfyTransport | undefined;
  actorId: string;
}

/**
 * Revalidate an inspected plan against the files and ComfyUI, then atomically persist the run with its queued jobs.
 * Nothing touches ComfyUI beyond the read-only preflight: the scheduler submits later, one job at a time.
 */
export async function startGeneration(env: StartEnvironment, input: ParsedOperationInput<"generation.start">): Promise<{ runId: string; jobs: Job[] }> {
  const { project } = env;
  const stored = storedPlan(project, input.planId);
  const plan = stored.plan;
  assertPlanHash(plan.planHash, input.planHash, [{ label: "Inspect the plan again", operation: "generation.plan" }]);
  if (stored.startedRunId !== null) {
    throw new OperationFailure("STEP_BLOCKED", `Plan ${plan.planId} was already started as run ${stored.startedRunId}; plan again to start another batch.`, { runId: stored.startedRunId }, [{ label: "See the run's jobs", operation: "job.list", input: { assetId: plan.assetId } }]);
  }
  if (Date.now() - Date.parse(stored.createdAt) > PLAN_TTL_MS) {
    throw new OperationFailure("REVISION_CONFLICT", "The plan is older than two hours; inputs may have changed. Plan again.", undefined, [{ label: "Plan again", operation: "generation.plan" }]);
  }
  const contentBlockers = plan.blockers.filter((b) => CONTENT_BLOCKERS.has(b.code));
  if (contentBlockers.length > 0) {
    throw new OperationFailure("STEP_BLOCKED", `The plan has blockers: ${contentBlockers.map((b) => b.message).join(" ")}`, { blockers: contentBlockers }, contentBlockers.flatMap((b) => b.recoveryActions));
  }

  // --- inputs unchanged since the inspection
  // A saved-input branch generates from its recorded versions of the authored files, so those are what must be unchanged.
  const set = authoredSetFor(project.db, await discoverAuthored(project.root), plan.branchId);
  const changed = changedSpecs(set, plan.inputs.specHashes);
  if (changed.length > 0) {
    throw new OperationFailure("REVISION_CONFLICT", `Authored files changed since the plan was inspected: ${changed.map((c) => c.path).join(", ")}. Plan again so the prompt reflects them.`, { changed }, [{ label: "Plan again", operation: "generation.plan" }]);
  }
  if (plan.stepId !== "concept") {
    // The branch, the dependencies' approvals and the chosen reference are re-read now, not trusted from the quote.
    const current = await resolveDeliverable(project, set, plan.assetId, plan.stepId, plan.branchId);
    if (current.blockers.length > 0) {
      throw new OperationFailure("STEP_BLOCKED", `${plan.stepId} can no longer be generated: ${current.blockers.map((b) => b.message).join(" ")}`, { blockers: current.blockers }, current.blockers.flatMap((b) => b.recoveryActions));
    }
    const pinned = plan.inputs.references.find((r) => r.role === "reference");
    if (!plan.parentCandidateId && (current.reference?.id !== pinned?.id || current.reference?.sha256 !== pinned?.sha256)) {
      throw new OperationFailure("REVISION_CONFLICT", "The reference this step is conditioned on changed since the plan was inspected. Plan again.", { was: pinned, now: current.reference }, [{ label: "Plan again", operation: "generation.plan", input: { assetId: plan.assetId, stepId: plan.stepId, branchId: plan.branchId } }]);
    }
    if (normalizedHash(motionBasis(current.motion)) !== normalizedHash(motionBasis(plan.motion))) {
      throw new OperationFailure("REVISION_CONFLICT", "The guide poses or the scale anchor changed since the plan was inspected. Plan again.", { was: motionBasis(plan.motion), now: motionBasis(current.motion) }, [{ label: "Plan again", operation: "generation.plan", input: { assetId: plan.assetId, stepId: plan.stepId, branchId: plan.branchId } }]);
    }
  }
  for (const ref of plan.inputs.references) {
    if (!(await readPinnedReference(project, ref))) {
      throw new OperationFailure("OUTPUT_MISSING", `Reference ${ref.id} is missing or no longer matches the hash pinned by the plan.`, { reference: ref }, [{ label: "Plan again", operation: "generation.plan" }]);
    }
  }
  const wf = await loadDescriptor(plan.workflow.id, plan.workflow.version).catch((e: unknown) => {
    throw new OperationFailure("WORKFLOW_UNAVAILABLE", `Workflow ${plan.workflow.id}@${plan.workflow.version} cannot be loaded: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (graphHash(wf.graph) !== plan.workflow.graphHash) {
    throw new OperationFailure("REVISION_CONFLICT", "The bundled workflow changed since the plan was inspected. Plan again.", undefined, [{ label: "Plan again", operation: "generation.plan" }]);
  }
  const setUrl: RecoveryAction = { label: "Ask the user to set the ComfyUI URL in Settings → Connection", operation: "connection.set" };
  if (!env.comfy) throw new OperationFailure("WORKFLOW_UNAVAILABLE", "No ComfyUI URL is configured on this machine.", undefined, [setUrl]);
  const report = await preflight(wf, env.comfy).catch((e: unknown) => {
    throw new OperationFailure("WORKFLOW_UNAVAILABLE", `ComfyUI could not be queried: ${e instanceof Error ? e.message : String(e)}`, undefined, [setUrl]);
  });
  if (!report.ok) {
    throw new OperationFailure("WORKFLOW_UNAVAILABLE", "ComfyUI does not satisfy the workflow's requirements.", report, [{ label: "Inspect the workflow", operation: "workflow.inspect", input: { workflowId: wf.id } }]);
  }

  // --- durable record of what the run consumed, written before the rows that point at it
  const runId = newId("run");
  const effective = computeEffective(set, { assetId: plan.assetId, preferences: confirmedPreferences(project.db) });
  const inputsRel = paths.runInputs(plan.assetId, runId);
  const inputsAbs = await resolveIn(project.root, inputsRel);
  const pinnedTexts = Object.fromEntries(set.all().filter((f) => f.path in plan.inputs.specHashes).map((f) => [f.path, f.text]));
  await writeJsonAtomic(inputsAbs, { runId, plan, specTexts: pinnedTexts, effective: effective.effective, conflicts: effective.conflicts });

  try {
    return await project.mutate(async () => {
      const slots = plan.submissions.map((submission) => ({ submission, jobId: newId("job") }));
      const jobIds = slots.map((s) => s.jobId);
      project.transact(() => {
        const again = project.db.query<{ started_run_id: string | null }, [string]>("SELECT started_run_id FROM generation_plans WHERE plan_id = ?").get(plan.planId);
        if (again?.started_run_id) throw new OperationFailure("STEP_BLOCKED", `Plan ${plan.planId} was already started as run ${again.started_run_id}.`, { runId: again.started_run_id });
        const now = new Date().toISOString();
        project.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, branch_id, plan_hash, plan_json, started_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(runId, plan.assetId, plan.stepId, plan.branchId ?? null, plan.planHash, JSON.stringify(GenerationPlan.parse(plan)), env.actorId, now);
        slots.forEach(({ submission, jobId }, slot) => {
          project.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, attempt, label, identity, seed, state, submission_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'queued', ?, ?, ?)")
            .run(jobId, runId, plan.assetId, plan.stepId, slot, submission.label, `bf:${jobId}:1`, submission.seed, JSON.stringify(submission), now, now);
        });
        project.db.query("UPDATE generation_plans SET started_run_id = ? WHERE plan_id = ?").run(runId, plan.planId);
      }, [
        { type: "generation.started", data: { runId, planId: plan.planId, assetId: plan.assetId, stepId: plan.stepId, count: plan.count }, actorId: env.actorId },
        ...jobIds.map((jobId) => ({ type: "job.changed", data: { jobId, runId, assetId: plan.assetId, stepId: plan.stepId, state: "queued" }, actorId: env.actorId })),
      ]);
      return { runId, jobs: jobIds.map((id) => toJob(jobRow(project.db, id))) };
    }).then((result) => {
      schedulerOf(project)?.kick();
      return result;
    });
  } catch (e) {
    await rm(inputsAbs, { force: true });
    throw e;
  }
}
