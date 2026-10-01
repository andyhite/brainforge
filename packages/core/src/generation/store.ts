import { randomBytes } from "node:crypto";
import type { Budget, BudgetStatus, Job, JobState, NextAction } from "@brainforge/contracts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure, type ProjectHandle } from "../runtime.ts";

export const newId = (prefix: string): string => `${prefix}-${randomBytes(5).toString("hex")}`;

/** Job states in which work is still owed by the scheduler (an `unresolved` job waits for a person). */
export const ACTIVE_STATES = ["queued", "submitting", "running", "collecting"] as const satisfies readonly JobState[];
export const TERMINAL_STATES = ["succeeded", "failed", "cancelled"] as const satisfies readonly JobState[];

export interface JobError { stage: "upload" | "submit" | "execute" | "download" | "publish"; message: string; recovery: string[] }
export interface JobUnresolved { reason: "no-match" | "multiple-matches" | "unreachable"; matches: string[]; supersededBy?: string }

export interface JobRow {
  job_id: string; run_id: string; asset_id: string; step_id: string; slot: number; attempt: number; label: string; identity: string;
  seed: number | null; state: JobState; prompt_id: string | null; candidate_id: string | null; submission_json: string;
  error_json: string | null; unresolved_json: string | null; queue_position: number | null;
  created_at: string; updated_at: string; submitted_at: string | null; collected_at: string | null;
}

export interface BudgetRow {
  budget_id: string; asset_id: string; step_id: string; max_starts: number; max_candidate_submissions: number;
  used_starts: number; used_candidate_submissions: number; spend_cap_usd: number | null; spent_usd: number;
  expires_at: string; note: string | null; created_by: string; created_at: string; revoked_at: string | null; revoke_reason: string | null;
}

export function jobRow(db: ProjectHandle["db"], jobId: string): JobRow {
  const row = db.query<JobRow, [string]>("SELECT * FROM generation_jobs WHERE job_id = ?").get(jobId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No job ${jobId}`, undefined, [{ label: "List jobs", operation: "job.list" }]);
  return row;
}

export function budgetRow(db: ProjectHandle["db"], budgetId: string): BudgetRow {
  const row = db.query<BudgetRow, [string]>("SELECT * FROM generation_budgets WHERE budget_id = ?").get(budgetId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No budget ${budgetId}`, undefined, [{ label: "List budgets", operation: "budget.list" }]);
  return row;
}

export function budgetStatus(row: BudgetRow, now = Date.now()): Budget["status"] {
  if (row.revoked_at !== null) return "revoked";
  if (Date.parse(row.expires_at) <= now) return "expired";
  if (row.used_starts >= row.max_starts || row.used_candidate_submissions >= row.max_candidate_submissions) return "exhausted";
  return "active";
}

export function toBudget(row: BudgetRow, now = Date.now()): Budget {
  return {
    budgetId: row.budget_id, assetId: row.asset_id, stepId: "concept",
    maxStarts: row.max_starts, maxCandidateSubmissions: row.max_candidate_submissions,
    usedStarts: row.used_starts, usedCandidateSubmissions: row.used_candidate_submissions,
    ...(row.spend_cap_usd === null ? {} : { spendCapUsd: row.spend_cap_usd }),
    spentUsd: row.spent_usd, expiresAt: row.expires_at, ...(row.note === null ? {} : { note: row.note }),
    createdBy: row.created_by, createdAt: row.created_at, ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    status: budgetStatus(row, now),
  };
}

/**
 * Why a budget cannot pay for `needs`, or undefined when it can. Starting needs one start plus its candidate
 * submissions; a new attempt for an existing slot needs one submission only.
 */
export function budgetShortfall(row: BudgetRow, needs: { starts: number; submissions: number }, now = Date.now()): string | undefined {
  if (row.revoked_at !== null) return `Budget ${row.budget_id} was revoked${row.revoke_reason ? `: ${row.revoke_reason}` : ""}`;
  if (Date.parse(row.expires_at) <= now) return `Budget ${row.budget_id} expired at ${row.expires_at}`;
  if (row.used_starts + needs.starts > row.max_starts) return `Budget ${row.budget_id} has no starts left (${row.used_starts}/${row.max_starts} used)`;
  if (row.used_candidate_submissions + needs.submissions > row.max_candidate_submissions) {
    return `Budget ${row.budget_id} cannot cover ${needs.submissions} more candidate submission(s) (${row.used_candidate_submissions}/${row.max_candidate_submissions} used)`;
  }
  return undefined;
}

/**
 * Starts since the most recent human grant for this asset step. A fresh grant opens a new attempt window, which is
 * why neither an agent nor a spec edit can reset the count.
 */
export function attemptsInWindow(db: ProjectHandle["db"], assetId: string, stepId: string): number {
  return db.query<{ n: number }, [string, string, string, string]>(
    `SELECT COUNT(*) AS n FROM generation_runs r JOIN generation_budgets b ON b.budget_id = r.budget_id
     WHERE r.asset_id = ? AND r.step_id = ? AND b.rowid >= COALESCE((SELECT MAX(rowid) FROM generation_budgets WHERE asset_id = ? AND step_id = ?), 0)`,
  ).get(assetId, stepId, assetId, stepId)?.n ?? 0;
}

export function jobError(row: JobRow): JobError | undefined {
  return row.error_json === null ? undefined : (JSON.parse(row.error_json) as JobError);
}

export function jobUnresolved(row: JobRow): JobUnresolved | undefined {
  return row.unresolved_json === null ? undefined : (JSON.parse(row.unresolved_json) as JobUnresolved);
}

/** True while the prompt is pending on ComfyUI (so deleting it is safe) or the job has not been submitted. */
export const isCancellable = (row: JobRow): boolean => row.state === "queued" || (row.state === "running" && (row.queue_position ?? 0) > 0);

function actionsFor(row: JobRow): NextAction[] {
  const error = jobError(row);
  switch (row.state) {
    case "queued":
      return [{ label: "Cancel this queued job (the budget is not refunded)", operation: "job.cancel", input: { jobId: row.job_id } }];
    case "submitting":
      return [{ label: "Look the prompt up on ComfyUI by its saved identity", operation: "job.reconcile", input: { jobId: row.job_id } }];
    case "running":
      return isCancellable(row)
        ? [{ label: "Cancel while still pending on ComfyUI (the budget is not refunded)", operation: "job.cancel", input: { jobId: row.job_id } }]
        : [{ label: "Wait: ComfyUI is generating. Running prompts cannot be cancelled and finish on their own", operation: "job.inspect", input: { jobId: row.job_id } }];
    case "collecting":
      return [{ label: "Wait: downloading and publishing the result", operation: "job.inspect", input: { jobId: row.job_id } }];
    case "unresolved":
      return [
        { label: "Search ComfyUI again by the saved identity", operation: "job.reconcile", input: { jobId: row.job_id } },
        { label: "Ask the user to authorize a new attempt (spends one more candidate submission)", operation: "job.retry", input: { jobId: row.job_id, mode: "new-attempt" } },
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
    jobId: row.job_id, runId: row.run_id, assetId: row.asset_id, stepId: "concept", label: row.label, state: row.state, attempt: row.attempt,
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
