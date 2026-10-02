import { randomBytes } from "node:crypto";
import type { Job, JobState, NextAction } from "@brainforge/contracts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure, type ProjectHandle } from "../runtime.ts";

export const newId = (prefix: string): string => `${prefix}-${randomBytes(5).toString("hex")}`;

/** Job states in which work is still owed by the scheduler (an `unresolved` job waits for a person). */
export const ACTIVE_STATES = ["queued", "submitting", "running", "collecting"] as const satisfies readonly JobState[];

export interface JobError { stage: "upload" | "submit" | "execute" | "download" | "publish"; message: string; recovery: string[] }
interface JobUnresolved { reason: "no-match" | "multiple-matches" | "unreachable"; matches: string[]; supersededBy?: string }

export interface JobRow {
  job_id: string; run_id: string; asset_id: string; step_id: string; slot: number; attempt: number; label: string; identity: string;
  seed: number | null; state: JobState; prompt_id: string | null; candidate_id: string | null; submission_json: string;
  error_json: string | null; unresolved_json: string | null; queue_position: number | null;
  created_at: string; updated_at: string; submitted_at: string | null; collected_at: string | null;
}

export function jobRow(db: ProjectHandle["db"], jobId: string): JobRow {
  const row = db.query<JobRow, [string]>("SELECT * FROM generation_jobs WHERE job_id = ?").get(jobId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No job ${jobId}`, undefined, [{ label: "List jobs", operation: "job.list" }]);
  return row;
}

export function jobError(row: JobRow): JobError | undefined {
  return row.error_json === null ? undefined : (JSON.parse(row.error_json) as JobError);
}

function jobUnresolved(row: JobRow): JobUnresolved | undefined {
  return row.unresolved_json === null ? undefined : (JSON.parse(row.unresolved_json) as JobUnresolved);
}

/** True while the prompt is pending on ComfyUI (so deleting it is safe) or the job has not been submitted. */
const isCancellable = (row: JobRow): boolean => row.state === "queued" || (row.state === "running" && (row.queue_position ?? 0) > 0);

function actionsFor(row: JobRow): NextAction[] {
  const error = jobError(row);
  switch (row.state) {
    case "queued":
      return [{ label: "Cancel this queued job", operation: "job.cancel", input: { jobId: row.job_id } }];
    case "submitting":
      return [{ label: "Look the prompt up on ComfyUI by its saved identity", operation: "job.reconcile", input: { jobId: row.job_id } }];
    case "running":
      return isCancellable(row)
        ? [{ label: "Cancel while still pending on ComfyUI", operation: "job.cancel", input: { jobId: row.job_id } }]
        : [{ label: "Wait: ComfyUI is generating. Running prompts cannot be cancelled and finish on their own", operation: "job.inspect", input: { jobId: row.job_id } }];
    case "collecting":
      return [{ label: "Wait: downloading and publishing the result", operation: "job.inspect", input: { jobId: row.job_id } }];
    case "unresolved":
      return [
        { label: "Search ComfyUI again by the saved identity", operation: "job.reconcile", input: { jobId: row.job_id } },
        { label: "Ask the user to authorize a new attempt (resubmits the prompt; only they can judge whether the original is truly lost)", operation: "job.retry", input: { jobId: row.job_id, mode: "new-attempt" } },
      ];
    case "failed": {
      const out: NextAction[] = [];
      if (row.prompt_id !== null && (error?.stage === "download" || error?.stage === "publish")) {
        out.push({ label: "Retry downloading and publishing the existing ComfyUI result (no regeneration)", operation: "job.retry", input: { jobId: row.job_id, mode: "collect" } });
      }
      out.push({ label: "Ask the user to authorize a new attempt (spends one more candidate submission)", operation: "job.retry", input: { jobId: row.job_id, mode: "new-attempt" } });
      return out;
    }
    case "succeeded":
      return row.candidate_id === null ? [] : [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId: row.candidate_id } }];
    case "cancelled":
      return [];
  }
}

export function toJob(row: JobRow): Job {
  const error = jobError(row);
  const unresolved = jobUnresolved(row);
  return {
    jobId: row.job_id, runId: row.run_id, assetId: row.asset_id, stepId: row.step_id, label: row.label, state: row.state, attempt: row.attempt,
    ...(row.seed === null ? {} : { seed: row.seed }),
    ...(row.prompt_id === null ? {} : { promptId: row.prompt_id }),
    ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id }),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.submitted_at === null ? {} : { submittedAt: row.submitted_at }),
    ...(row.collected_at === null ? {} : { collectedAt: row.collected_at }),
    ...(row.queue_position !== null && row.queue_position > 0 ? { queuePosition: row.queue_position } : {}),
    ...(error ? { error } : {}),
    ...(unresolved ? { unresolved: { reason: unresolved.reason, matches: unresolved.matches } } : {}),
    cancellable: isCancellable(row),
    availableActions: actionsFor(row),
  };
}

export interface JobPatch {
  state?: JobState;
  promptId?: string | null;
  error?: JobError | null;
  unresolved?: JobUnresolved | null;
  queuePosition?: number | null;
  submittedAt?: string;
  collectedAt?: string;
  candidateId?: string;
}

export function jobEventData(row: JobRow): Record<string, unknown> {
  return {
    jobId: row.job_id, runId: row.run_id, assetId: row.asset_id, stepId: row.step_id, label: row.label, state: row.state, attempt: row.attempt,
    ...(row.prompt_id === null ? {} : { promptId: row.prompt_id }), ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id }),
  };
}

/**
 * Compare-and-set a job: applies `patch` only while the job is in one of `from`, then appends `job.changed`.
 * The state check and the transaction run without an await between them, so a concurrent cancel cannot interleave.
 * Returns the updated row, or undefined when the job had already left `from`.
 */
export async function patchJob(project: OpenProject, jobId: string, from: readonly JobState[], patch: JobPatch, actorId = "system:scheduler"): Promise<JobRow | undefined> {
  return project.mutate(async () => {
    const current = jobRow(project.db, jobId);
    if (!from.includes(current.state)) return undefined;
    const sets: string[] = ["updated_at = ?"];
    const args: (string | number | null)[] = [new Date().toISOString()];
    const put = (column: string, value: string | number | null): void => { sets.push(`${column} = ?`); args.push(value); };
    if (patch.state !== undefined) put("state", patch.state);
    if (patch.promptId !== undefined) put("prompt_id", patch.promptId);
    if (patch.error !== undefined) put("error_json", patch.error === null ? null : JSON.stringify(patch.error));
    if (patch.unresolved !== undefined) put("unresolved_json", patch.unresolved === null ? null : JSON.stringify(patch.unresolved));
    if (patch.queuePosition !== undefined) put("queue_position", patch.queuePosition);
    if (patch.submittedAt !== undefined) put("submitted_at", patch.submittedAt);
    if (patch.collectedAt !== undefined) put("collected_at", patch.collectedAt);
    if (patch.candidateId !== undefined) put("candidate_id", patch.candidateId);
    project.transact(() => {
      project.db.query(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE job_id = ?`).run(...args, jobId);
    }, [{ type: "job.changed", data: jobEventData({ ...current, state: patch.state ?? current.state, prompt_id: patch.promptId === undefined ? current.prompt_id : patch.promptId, candidate_id: patch.candidateId ?? current.candidate_id }), actorId }]);
    return jobRow(project.db, jobId);
  });
}

export function activeJobCount(db: ProjectHandle["db"]): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM generation_jobs WHERE state IN (${ACTIVE_STATES.map((s) => `'${s}'`).join(",")})`).get()?.n ?? 0;
}

export interface NewCandidate {
  candidateId: string; assetId: string; stepId: string; runId: string; jobId: string; parentCandidateId: string | null; branchId: string | null;
  label: string; seed: number | null; prompt: string; createdAt: string;
}

/** Inserts the candidate row unless it exists; returns its `candidate.created` event, or undefined when it was already there. Call inside a transaction. */
export function insertCandidate(db: ProjectHandle["db"], c: NewCandidate, actorId: string): { type: string; data: unknown; actorId: string } | undefined {
  if (db.query("SELECT 1 FROM candidates WHERE candidate_id = ?").get(c.candidateId)) return undefined;
  db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, parent_candidate_id, branch_id, label, seed, prompt, favorite, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
    .run(c.candidateId, c.assetId, c.stepId, c.runId, c.jobId, c.parentCandidateId, c.branchId, c.label, c.seed, c.prompt, c.createdAt);
  return { type: "candidate.created", data: { candidateId: c.candidateId, assetId: c.assetId, stepId: c.stepId, runId: c.runId, jobId: c.jobId, ...(c.parentCandidateId ? { parentCandidateId: c.parentCandidateId } : {}) }, actorId };
}

/** Marks a `collecting` job succeeded; returns its `job.changed` event, or undefined when the job had already left `collecting`. Call inside a transaction. */
export function markJobSucceeded(db: ProjectHandle["db"], jobId: string, candidateId: string, now: string, actorId: string): { type: string; data: unknown; actorId: string } | undefined {
  const done = db.query("UPDATE generation_jobs SET state = 'succeeded', candidate_id = ?, collected_at = ?, updated_at = ?, queue_position = NULL, error_json = NULL WHERE job_id = ? AND state = 'collecting'").run(candidateId, now, now, jobId);
  if (done.changes === 0) return undefined;
  const job = jobRow(db, jobId);
  return { type: "job.changed", data: { jobId, runId: job.run_id, assetId: job.asset_id, stepId: job.step_id, state: "succeeded", attempt: job.attempt, candidateId }, actorId };
}
