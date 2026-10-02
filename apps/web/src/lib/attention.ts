import type { Job } from "@brainforge/contracts";
import { useOperation } from "../api/hooks.ts";
import { useProject } from "./use-project.ts";

/** Job states still doing work (the rest are terminal). */
export const JOB_IS_ACTIVE: Record<Job["state"], boolean> = {
  queued: true, submitting: true, running: true, collecting: true,
  succeeded: false, failed: false, cancelled: false, unresolved: false,
};

/** A failed or unresolved job the server still offers a recovery for. */
export function jobNeedsAttention(job: Job): boolean {
  return (job.state === "failed" || job.state === "unresolved") && job.availableActions.length > 0;
}

/** Candidates waiting for a human decision: the Review tab's count and the queue's order (newest first). */
export function useReviewQueue() {
  const project = useProject();
  const query = useOperation("review.list", { filter: "awaiting", limit: 200 }, { enabled: project.data !== undefined });
  const data = query.data?.ok ? query.data.data : undefined;
  return { items: data?.items ?? [], total: data?.total ?? 0, loaded: data !== undefined, query };
}

/** Jobs that are running and jobs that need a human to recover them. Polls slowly; SSE invalidation keeps it fresh. */
export function useJobAttention() {
  const project = useProject();
  const query = useOperation("job.list", { limit: 200 }, { enabled: project.data !== undefined, refetchInterval: 15_000 });
  const jobs = query.data?.ok ? query.data.data.jobs : [];
  return {
    running: jobs.filter((job) => JOB_IS_ACTIVE[job.state]),
    attention: jobs.filter(jobNeedsAttention),
    loaded: query.data?.ok === true,
    query,
  };
}
