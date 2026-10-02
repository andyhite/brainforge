import { PLAN_TTL_MS, createPlan } from "../generation/plan.ts";
import { transportOf } from "../generation/comfy.ts";
import { cancelJob, lookupByIdentity, newAttempt, retryCollect } from "../generation/jobs.ts";
import { schedulerOf } from "../generation/scheduler.ts";
import { startGeneration } from "../generation/start.ts";
import { ACTIVE_STATES, jobRow, toJob, type JobRow } from "../generation/store.ts";
import { candidateRow, requirementsResolver, toCandidate } from "../review/records.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";

export const generationHandlers: HandlerMap = {
  "generation.plan": async ({ input, project, runtime, context }) => {
    const open = requireOpen(project);
    const comfy = transportOf(runtime);
    const plan = await createPlan({ project: open, workflowsDir: runtime.workflowsDir, comfy, comfyHost: comfy ? new URL(comfy.baseUrl).host : undefined, actorId: context.actorId }, input);
    const { revision } = await open.mutate(async () =>
      open.transact(() => {
        open.db.query("INSERT INTO generation_plans (plan_id, plan_hash, plan_json, branch_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(plan.planId, plan.planHash, JSON.stringify(plan), plan.branchId ?? null, context.actorId, plan.createdAt);
      }, [{ type: "generation.planned", data: { planId: plan.planId, assetId: plan.assetId, stepId: plan.stepId, mode: plan.mode, count: plan.count, blockers: plan.blockers.length }, actorId: context.actorId }]),
    );
    const expires = new Date(Date.parse(plan.createdAt) + PLAN_TTL_MS).toISOString();
    return {
      data: { plan }, revision,
      nextActions: plan.blockers.length > 0
        ? plan.blockers.flatMap((b) => b.recoveryActions)
        : [{ label: `Start this plan (valid until ${expires})`, operation: "generation.start", input: { planId: plan.planId, planHash: plan.planHash } }],
    };
  },

  "generation.start": async ({ input, project, runtime, context }) => {
    const open = requireOpen(project);
    const started = await startGeneration({ project: open, workflowsDir: runtime.workflowsDir, comfy: transportOf(runtime), actorId: context.actorId }, input);
    return {
      data: started,
      nextActions: [{ label: "Watch the jobs (they run in the background and survive closing the browser)", operation: "job.list", input: { activeOnly: true } }],
    };
  },

  "job.list": async ({ input, project }) => {
    const open = requireOpen(project);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (input.assetId !== undefined) { where.push("asset_id = ?"); args.push(input.assetId); }
    if (input.state !== undefined) { where.push("state = ?"); args.push(input.state); }
    if (input.activeOnly) where.push(`state IN (${[...ACTIVE_STATES, "unresolved"].map((s) => `'${s}'`).join(",")})`);
    const rows = open.db
      .query<JobRow, (string | number)[]>(`SELECT * FROM generation_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...args, input.limit);
    return { data: { jobs: rows.map(toJob) } };
  },

  "job.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    const row = jobRow(open.db, input.jobId);
    const cand = row.candidate_id === null ? undefined : candidateRow(open.db, row.candidate_id);
    return { data: { job: toJob(row), ...(cand ? { candidate: toCandidate(open.db, cand, await requirementsResolver(open, cand.asset_id)) } : {}) } };
  },

  "job.reconcile": async ({ input, project, runtime }) => {
    const open = requireOpen(project);
    const scheduler = schedulerOf(open);
    const row = jobRow(open.db, input.jobId);
    if (row.state === "running") return { data: { job: toJob(row), outcome: "still-running" } };
    if ((row.state !== "submitting" && row.state !== "unresolved") || (row.state === "submitting" && scheduler?.drives(row.job_id))) {
      return { data: { job: toJob(row), outcome: "unchanged" } };
    }
    const comfy = transportOf(runtime);
    if (!comfy) {
      throw new OperationFailure("WORKFLOW_UNAVAILABLE", "No ComfyUI URL is configured, so the job cannot be looked up.", undefined, [{ label: "Ask the user to set the ComfyUI URL", operation: "connection.set" }]);
    }
    const { outcome, job } = await lookupByIdentity(open, row, comfy);
    scheduler?.kick();
    return { data: { job: toJob(job), outcome }, nextActions: toJob(job).availableActions };
  },

  "job.retry": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const row = jobRow(open.db, input.jobId);
    if (input.mode === "new-attempt" && context.actorType !== "human") {
      throw new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", "A new attempt resubmits to ComfyUI, and the original submission may still be running there, so a second prompt could duplicate it; ask the user to do it in the Brainforge UI after they have looked at the unresolved job.", { jobId: row.job_id }, [
        { label: "Inspect the job to show the user", operation: "job.inspect", input: { jobId: row.job_id } },
      ]);
    }
    const job = input.mode === "collect" ? await retryCollect(open, row, context.actorId) : await newAttempt(open, row.job_id, context.actorId);
    schedulerOf(open)?.kick();
    return { data: { job: toJob(job) }, nextActions: toJob(job).availableActions };
  },

  "job.cancel": async ({ input, project, runtime, context }) => {
    const open = requireOpen(project);
    const job = await cancelJob(open, jobRow(open.db, input.jobId), transportOf(runtime), context.actorId);
    schedulerOf(open)?.kick();
    return { data: { job: toJob(job) } };
  },
};
