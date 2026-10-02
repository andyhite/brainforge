import type { ComfyTransport } from "@brainforge/comfy";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { jobEventData, jobRow, newId, patchJob, jobError, type JobRow } from "./store.ts";

export type ReconcileOutcome = "attached" | "no-match" | "multiple-matches" | "unreachable";

const retryLater = (message: string): string[] => [message, "Run job.reconcile again, or ask the user to authorize a new attempt (job.retry mode=new-attempt)."];

/**
 * Search ComfyUI's queue and history for the job's saved identity. Exactly one match is attached and the job
 * continues as `running`; zero or several leave it `unresolved`. This never submits anything.
 */
export async function lookupByIdentity(project: OpenProject, row: JobRow, comfy: ComfyTransport): Promise<{ outcome: ReconcileOutcome; job: JobRow }> {
  const from = ["submitting", "unresolved"] as const;
  let matches;
  try {
    matches = await comfy.findByIdentity(row.identity);
  } catch (e) {
    const message = `ComfyUI queue/history could not be read, so the submission outcome is unknown: ${e instanceof Error ? e.message : String(e)}`;
    const job = await patchJob(project, row.job_id, from, {
      state: "unresolved", unresolved: { reason: "unreachable", matches: [] },
      error: { stage: "submit", message, recovery: retryLater("Make sure ComfyUI is reachable.") },
    });
    return { outcome: "unreachable", job: job ?? jobRow(project.db, row.job_id) };
  }
  const only = matches[0];
  if (matches.length === 1 && only) {
    const job = await patchJob(project, row.job_id, from, {
      state: "running", promptId: only.promptId, submittedAt: new Date().toISOString(), unresolved: null, error: null, queuePosition: null,
    });
    return { outcome: "attached", job: job ?? jobRow(project.db, row.job_id) };
  }
  const multiple = matches.length > 1;
  const job = await patchJob(project, row.job_id, from, {
    state: "unresolved",
    unresolved: { reason: multiple ? "multiple-matches" : "no-match", matches: matches.map((m) => m.promptId) },
    error: {
      stage: "submit",
      message: multiple
        ? `${matches.length} ComfyUI prompts carry this job's identity (${matches.map((m) => m.promptId).join(", ")}); Brainforge will not guess which one is right.`
        : "No ComfyUI prompt carries this job's identity. The submission may have been lost, or it may not have reached ComfyUI; Brainforge cannot tell and will not submit again by itself.",
      recovery: retryLater(multiple ? "Inspect the listed prompts in ComfyUI." : "Check ComfyUI's history if you can."),
    },
  });
  return { outcome: multiple ? "multiple-matches" : "no-match", job: job ?? jobRow(project.db, row.job_id) };
}

/**
 * A new attempt for the same candidate slot: a new job row with identity bf:<newJobId>:<attempt>. The original row
 * stays visible (an unresolved original is marked cancelled and points at its successor). The handler restricts this
 * to humans: the original submission may still be running on ComfyUI, so a second prompt could duplicate it.
 */
export async function newAttempt(project: OpenProject, jobId: string, actorId: string): Promise<JobRow> {
  return project.mutate(async () => {
    const original = jobRow(project.db, jobId);
    if (original.state !== "unresolved" && original.state !== "failed") {
      throw new OperationFailure("STEP_BLOCKED", `Job ${jobId} is ${original.state}; a new attempt is only possible for an unresolved or failed job.`, undefined, [{ label: "Inspect the job", operation: "job.inspect", input: { jobId } }]);
    }
    const superseded = project.db.query<{ job_id: string }, [string, number, number]>("SELECT job_id FROM generation_jobs WHERE run_id = ? AND slot = ? AND attempt > ?").get(original.run_id, original.slot, original.attempt);
    if (superseded) {
      throw new OperationFailure("STEP_BLOCKED", `Job ${jobId} already has a newer attempt (${superseded.job_id}).`, { newerJobId: superseded.job_id }, [{ label: "Inspect the newer attempt", operation: "job.inspect", input: { jobId: superseded.job_id } }]);
    }
    const newJobId = newId("job");
    const attempt = original.attempt + 1;
    const now = new Date().toISOString();
    const priorUnresolved = original.unresolved_json;
    project.transact(() => {
      project.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, attempt, label, identity, seed, state, submission_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
        .run(newJobId, original.run_id, original.asset_id, original.step_id, original.slot, attempt, original.label, `bf:${newJobId}:${attempt}`, original.seed, original.submission_json, now, now);
      if (original.state === "unresolved") {
        const detail = priorUnresolved === null ? { reason: "no-match", matches: [] } : (JSON.parse(priorUnresolved) as Record<string, unknown>);
        project.db.query("UPDATE generation_jobs SET state = 'cancelled', unresolved_json = ?, updated_at = ? WHERE job_id = ?").run(JSON.stringify({ ...detail, supersededBy: newJobId }), now, original.job_id);
      }
    }, [
      { type: "job.changed", data: { ...jobEventData(original), state: original.state === "unresolved" ? "cancelled" : original.state, supersededBy: newJobId }, actorId },
      { type: "job.changed", data: { jobId: newJobId, runId: original.run_id, assetId: original.asset_id, stepId: original.step_id, state: "queued", attempt }, actorId },
    ]);
    return jobRow(project.db, newJobId);
  });
}

/** Re-download and publish the existing ComfyUI result of a job that failed while collecting. No regeneration. */
export async function retryCollect(project: OpenProject, row: JobRow, actorId: string): Promise<JobRow> {
  const stage = jobError(row)?.stage;
  if (row.state === "collecting") return row;
  if (row.state !== "failed" || row.prompt_id === null || (stage !== "download" && stage !== "publish")) {
    throw new OperationFailure("STEP_BLOCKED", `Job ${row.job_id} has no remote result to collect again (state ${row.state}${stage ? `, failed at ${stage}` : ""}).`, undefined, [
      { label: "Inspect the job", operation: "job.inspect", input: { jobId: row.job_id } },
      ...(row.state === "failed" || row.state === "unresolved" ? [{ label: "Ask the user to authorize a new attempt", operation: "job.retry", input: { jobId: row.job_id, mode: "new-attempt" } }] : []),
    ]);
  }
  const job = await patchJob(project, row.job_id, ["failed"], { state: "collecting", error: null }, actorId);
  return job ?? jobRow(project.db, row.job_id);
}

/**
 * Cancel only what is safe to cancel: a job still local to Brainforge, or a prompt still pending on ComfyUI (deleted
 * by id). A running prompt cannot be stopped without interrupting the shared instance, which Brainforge never does.
 */
export async function cancelJob(project: OpenProject, row: JobRow, comfy: ComfyTransport | undefined, actorId: string): Promise<JobRow> {
  const unavailable = (why: string): OperationFailure => new OperationFailure("CANCEL_UNAVAILABLE", why, { state: row.state }, [{ label: "Inspect the job", operation: "job.inspect", input: { jobId: row.job_id } }]);
  if (row.state === "queued") {
    const job = await patchJob(project, row.job_id, ["queued"], { state: "cancelled", error: null }, actorId);
    if (!job) throw unavailable("The job started submitting before it could be cancelled.");
    return job;
  }
  if (row.state !== "running" || row.prompt_id === null) {
    throw unavailable(`Job ${row.job_id} is ${row.state} and cannot be cancelled${row.state === "submitting" ? " until its submission is resolved" : ""}.`);
  }
  const promptId = row.prompt_id;
  if (!comfy) throw unavailable("No ComfyUI URL is configured, so the prompt's queue position cannot be verified.");
  const before = await comfy.queue().catch((e: unknown) => { throw unavailable(`ComfyUI's queue could not be read: ${e instanceof Error ? e.message : String(e)}`); });
  if (!before.queue_pending.some((t) => t[1] === promptId)) {
    throw unavailable("The prompt is already executing (or finished) on ComfyUI. Running prompts cannot be cancelled without interrupting the shared instance; it will finish and its result can simply be ignored.");
  }
  await comfy.deleteQueued(promptId);
  const after = await comfy.queue().catch((e: unknown) => { throw unavailable(`The cancel was sent but ComfyUI's queue could not be re-read: ${e instanceof Error ? e.message : String(e)}`); });
  const history = await comfy.history(promptId).catch(() => ({}));
  if (after.queue_running.some((t) => t[1] === promptId) || promptId in history) {
    throw unavailable("The prompt started executing before the cancel landed; it will finish and its result can simply be ignored.");
  }
  const job = await patchJob(project, row.job_id, ["running"], { state: "cancelled", queuePosition: null }, actorId);
  return job ?? jobRow(project.db, row.job_id);
}
