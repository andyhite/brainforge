import { readFile } from "node:fs/promises";
import { GenerationPlan, type WorkflowDescriptor } from "@brainforge/contracts";
import { ComfyHttpError, bindInputs, graphHash, outputImages, type ComfyTransport, type HistoryEntry } from "@brainforge/comfy";
import { MediaError, decodeImage, flattenOnGrey, type DecodedImage } from "@brainforge/media";
import { paths, resolveIn, sha256, writeFileAtomic } from "@brainforge/storage";
import { readAuthoredFile } from "../authored.ts";
import type { OpenProject } from "../project-runtime.ts";
import { loadDescriptor } from "./descriptors.ts";
import { lookupByIdentity } from "./jobs.ts";
import { readPinnedReference } from "./references.ts";
import { activeJobCount, jobError, jobRow, patchJob, type JobError, type JobRow } from "./store.ts";

export interface SchedulerOptions {
  /** Resolved on every step, so a changed machine setting or an injected fake takes effect immediately. */
  comfy: () => ComfyTransport | undefined;
  workflowsDir: string;
  /** Queue/history poll interval while a prompt is outstanding (default 2000, per the plan). */
  pollIntervalMs?: number;
  /** How often the loop looks for new or recoverable jobs when nothing wakes it (default 1000). */
  tickIntervalMs?: number;
}

const schedulers = new WeakMap<object, GenerationScheduler>();
export const schedulerOf = (project: object): GenerationScheduler | undefined => schedulers.get(project);

const SUBMISSION = GenerationPlan.shape.submissions.element;
const ROLES = ["untouched", "matted"] as const;

interface Collected { role: (typeof ROLES)[number]; decoded: DecodedImage }

function executionMessage(entry: HistoryEntry): string {
  for (const m of entry.status?.messages ?? []) {
    if (Array.isArray(m) && m[0] === "execution_error" && m[1] && typeof m[1] === "object") {
      const data = m[1] as { exception_message?: unknown; node_type?: unknown };
      return `ComfyUI execution failed${typeof data.node_type === "string" ? ` in ${data.node_type}` : ""}: ${typeof data.exception_message === "string" ? data.exception_message.trim() : "no message"}`;
    }
  }
  return "ComfyUI reported an execution error without details.";
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Runs a project's generation jobs: uploads, submits one prompt per candidate, polls ComfyUI's queue and history,
 * and publishes results. Every step first commits the job's new state, so any crash resumes from the database and
 * never resubmits an ambiguous prompt.
 */
export class GenerationScheduler {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private idleWake: (() => void) | undefined;
  private kicked = false;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly sleepers = new Set<() => void>();
  private readonly notBefore = new Map<string, number>();
  private readonly uploaded = new Map<string, string>();
  /** Called when the project is closing and its last tracked job has finished. */
  onIdle: (() => void) | undefined;
  private idleNotified = false;

  constructor(private readonly project: OpenProject, private readonly options: SchedulerOptions) {}

  private get pollMs(): number { return this.options.pollIntervalMs ?? 2000; }

  start(): void {
    this.project.setTrackedWorkProbe(() => activeJobCount(this.project.db));
    schedulers.set(this.project, this);
    this.loop = this.run();
  }

  /** Make the loop look at the database now (a job was queued, retried or reconciled). */
  kick(): void {
    this.kicked = true;
    this.idleWake?.();
  }

  drives(jobId: string): boolean {
    return this.inflight.has(jobId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of [...this.sleepers]) wake();
    this.kick();
    const patience = Promise.withResolvers<void>();
    const timer = setTimeout(patience.resolve, 3000);
    await Promise.race([Promise.allSettled([this.loop, ...this.inflight.values()]), patience.promise]);
    clearTimeout(timer);
    schedulers.delete(this.project);
  }

  /** Sleep that `stop()` can cut short. */
  private sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const wake = (): void => { clearTimeout(timer); this.sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    this.sleepers.add(wake);
    return promise;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      this.kicked = false;
      try {
        await this.tick();
      } catch (e) {
        if (!this.stopping) console.error("[brainforge] generation scheduler:", describe(e));
      }
      if (this.kicked || this.stopping) continue;
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, this.options.tickIntervalMs ?? 1000);
      this.idleWake = resolve;
      await promise;
      clearTimeout(timer);
      this.idleWake = undefined;
    }
  }

  private async maxConcurrent(): Promise<number> {
    const file = await readAuthoredFile(this.project.root, paths.projectYaml());
    return file?.kind === "project" && file.spec ? file.spec.automation.maxConcurrentGenerations : 1;
  }

  /** Adopt recoverable work first (it already holds a ComfyUI slot), then queued jobs up to the concurrency limit. */
  private async tick(): Promise<void> {
    const rows = this.project.db.query<JobRow, []>("SELECT * FROM generation_jobs WHERE state IN ('submitting','running','collecting','queued') ORDER BY created_at, rowid").all();
    if (rows.length === 0) {
      if (this.project.state === "closing" && !this.idleNotified) {
        this.idleNotified = true;
        this.onIdle?.();
      }
      return;
    }
    if (!this.options.comfy()) return;
    const max = await this.maxConcurrent();
    const now = Date.now();
    for (const row of rows) {
      if (this.inflight.has(row.job_id) || row.state === "queued") continue;
      this.launch(row.job_id);
    }
    for (const row of rows) {
      if (row.state !== "queued" || this.inflight.has(row.job_id)) continue;
      if (this.inflight.size >= max) break;
      if ((this.notBefore.get(row.job_id) ?? 0) > now) continue;
      this.launch(row.job_id);
    }
  }

  private launch(jobId: string): void {
    const task = this.drive(jobId)
      .catch((e: unknown) => {
        if (!this.stopping) console.error(`[brainforge] job ${jobId}:`, describe(e));
      })
      .finally(() => {
        this.inflight.delete(jobId);
        this.kick();
      });
    this.inflight.set(jobId, task);
  }

  /** Move one job forward until it reaches a state that needs a person, a terminal state, or shutdown. */
  private async drive(jobId: string): Promise<void> {
    for (;;) {
      if (this.stopping) return;
      const row = jobRow(this.project.db, jobId);
      let proceed: boolean;
      switch (row.state) {
        case "queued": proceed = await this.submit(row); break;
        case "submitting": proceed = await this.resolveSubmission(row); break;
        case "running": proceed = await this.watch(row); break;
        case "collecting": proceed = await this.collect(row); break;
        default: return;
      }
      if (!proceed) return;
    }
  }

  private async fail(row: JobRow, stage: JobError["stage"], message: string, recovery: string[]): Promise<false> {
    await patchJob(this.project, row.job_id, [row.state], { state: "failed", error: { stage, message, recovery }, queuePosition: null });
    return false;
  }

  private async loadRun(row: JobRow): Promise<{ plan: GenerationPlan; wf: WorkflowDescriptor } | { failure: string }> {
    const run = this.project.db.query<{ plan_json: string }, [string]>("SELECT plan_json FROM generation_runs WHERE run_id = ?").get(row.run_id);
    if (!run) return { failure: `Run ${row.run_id} is missing from the database.` };
    const plan = GenerationPlan.parse(JSON.parse(run.plan_json));
    try {
      const wf = await loadDescriptor(this.options.workflowsDir, plan.workflow.id, plan.workflow.version);
      if (graphHash(wf.graph) !== plan.workflow.graphHash) return { failure: `Bundled workflow ${wf.id}@${wf.version} changed since the plan was inspected.` };
      return { plan, wf };
    } catch (e) {
      return { failure: `Workflow ${plan.workflow.id}@${plan.workflow.version} cannot be loaded: ${describe(e)}` };
    }
  }

  /** queued → upload references → submitting (committed) → submit → running. */
  private async submit(row: JobRow): Promise<boolean> {
    const comfy = this.options.comfy();
    if (!comfy) return false;
    const loaded = await this.loadRun(row);
    if ("failure" in loaded) return this.fail(row, "submit", loaded.failure, ["Inspect the plan and start again."]);
    const { plan, wf } = loaded;
    const submission = SUBMISSION.parse(JSON.parse(row.submission_json));

    const values: Record<string, string | number> = { ...submission.values };
    for (const ref of plan.inputs.references) {
      const bytes = await readPinnedReference(this.project, ref);
      if (!bytes) return this.fail(row, "upload", `Reference ${ref.id} is missing or changed since the plan pinned it.`, ["Plan again so the reference is re-pinned."]);
      try {
        values[ref.role] = await this.upload(comfy, await flattenOnGrey(bytes));
      } catch (e) {
        const transient = e instanceof ComfyHttpError && e.status === undefined;
        if (!transient) return this.fail(row, "upload", `Uploading ${ref.id} failed: ${describe(e)}`, ["Check ComfyUI, then ask the user to authorize a new attempt."]);
        const message = `ComfyUI is unreachable (${describe(e)}). The job stays queued and retries automatically.`;
        if (jobError(row)?.message !== message) await patchJob(this.project, row.job_id, ["queued"], { error: { stage: "upload", message, recovery: ["Start ComfyUI or fix the connection; nothing was submitted."] } });
        this.notBefore.set(row.job_id, Date.now() + Math.max(this.pollMs * 3, 200));
        return false;
      }
    }
    let graph;
    try {
      graph = bindInputs(wf, values);
    } catch (e) {
      return this.fail(row, "submit", `The workflow rejected the planned inputs: ${describe(e)}`, ["Plan again."]);
    }

    // The new state is durable BEFORE the network call, so a crash mid-submit is found by identity afterwards.
    const claimed = await patchJob(this.project, row.job_id, ["queued"], { state: "submitting", error: null });
    if (!claimed) return false;
    let promptId: string;
    try {
      promptId = await comfy.submit(graph, `brainforge-${this.project.projectId}`, {
        brainforge: { identity: row.identity, projectId: this.project.projectId, jobId: row.job_id, attempt: row.attempt },
      });
    } catch (e) {
      if (e instanceof ComfyHttpError && e.status !== undefined) {
        const detail = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "");
        return this.fail(claimed, "submit", `ComfyUI rejected the prompt (HTTP ${e.status}): ${detail.slice(0, 600)}`, ["Fix the cause reported above, then ask the user to authorize a new attempt."]);
      }
      return this.resolveSubmission(claimed);
    }
    await patchJob(this.project, row.job_id, ["submitting"], { state: "running", promptId, submittedAt: new Date().toISOString(), queuePosition: null });
    return true;
  }

  private async upload(comfy: ComfyTransport, png: Uint8Array): Promise<string> {
    const name = `bf-${sha256(png).slice(0, 24)}.png`;
    const key = `${comfy.baseUrl}\0${name}`;
    const known = this.uploaded.get(key);
    if (known) return known;
    const ref = await comfy.uploadImage(png, name, "brainforge");
    const value = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
    this.uploaded.set(key, value);
    return value;
  }

  /** A submission whose outcome is unknown: look it up by identity; never submit again. */
  private async resolveSubmission(row: JobRow): Promise<boolean> {
    const comfy = this.options.comfy();
    if (!comfy) return false;
    const { outcome } = await lookupByIdentity(this.project, row, comfy);
    return outcome === "attached";
  }

  /** running → poll history (and the queue, for position and disappearance) until the prompt finishes. */
  private async watch(row: JobRow): Promise<boolean> {
    const promptId = row.prompt_id;
    if (promptId === null) return this.resolveSubmission(row);
    let misses = 0;
    for (;;) {
      if (this.stopping) return false;
      const current = jobRow(this.project.db, row.job_id);
      if (current.state !== "running") return true;
      const comfy = this.options.comfy();
      if (comfy) {
        try {
          const entry = (await comfy.history(promptId))[promptId];
          if (entry?.status?.status_str === "error") {
            return await this.fail(current, "execute", executionMessage(entry), ["Ask the user to authorize a new attempt once the cause is fixed."]);
          }
          if (entry?.status?.completed === true) {
            await patchJob(this.project, row.job_id, ["running"], { state: "collecting", queuePosition: null });
            return true;
          }
          const queue = await comfy.queue();
          const pending = queue.queue_pending.findIndex((t) => t[1] === promptId);
          const executing = queue.queue_running.some((t) => t[1] === promptId);
          if (pending >= 0 || executing) {
            misses = 0;
            const position = executing ? 0 : pending + 1;
            if (position !== current.queue_position) await patchJob(this.project, row.job_id, ["running"], { queuePosition: position });
          } else if (++misses >= 2) {
            await patchJob(this.project, row.job_id, ["running"], {
              state: "unresolved", unresolved: { reason: "no-match", matches: [] }, queuePosition: null,
              error: {
                stage: "execute",
                message: `Prompt ${promptId} is in neither ComfyUI's queue nor its history; it may have been cleared or ComfyUI restarted. It is not treated as failed.`,
                recovery: ["Run job.reconcile to search again.", "Or ask the user to authorize a new attempt (job.retry mode=new-attempt)."],
              },
            });
            return false;
          }
        } catch {
          if (this.stopping) return false;
          // ComfyUI unreachable or restarting: the job stays `running` and polling continues.
        }
      }
      await this.sleep(this.pollMs);
    }
  }

  /** collecting → download every output, verify it decodes, publish files then rows. Reuses the remote result. */
  private async collect(row: JobRow): Promise<boolean> {
    const comfy = this.options.comfy();
    if (!comfy) {
      await this.sleep(this.pollMs);
      return true;
    }
    const promptId = row.prompt_id;
    if (promptId === null) return this.fail(row, "download", "The job has no ComfyUI prompt id to collect from.", ["Ask the user to authorize a new attempt."]);
    const loaded = await this.loadRun(row);
    if ("failure" in loaded) return this.fail(row, "publish", loaded.failure, ["Inspect the plan and start again."]);
    const { plan, wf } = loaded;
    const retry = ["job.retry mode=collect downloads the same ComfyUI result again without regenerating."];

    let entry: HistoryEntry | undefined;
    try {
      entry = (await comfy.history(promptId))[promptId];
    } catch (e) {
      return this.fail(row, "download", `ComfyUI's history could not be read: ${describe(e)}`, retry);
    }
    if (!entry) return this.fail(row, "download", `Prompt ${promptId} is no longer in ComfyUI's history, so its images cannot be downloaded.`, ["Ask the user to authorize a new attempt."]);

    const items: (Collected & { bytes: Uint8Array })[] = [];
    for (const binding of wf.outputBindings) {
      const role = ROLES.find((r) => r === binding.role);
      if (!role) return this.fail(row, "publish", `Workflow output role "${binding.role}" is not a stored candidate role.`, []);
      const ref = outputImages(entry, binding.nodeId)[0];
      if (!ref) return this.fail(row, "download", `ComfyUI produced no image for ${binding.role} (node ${binding.nodeId}).`, retry);
      try {
        const bytes = await comfy.view(ref);
        items.push({ role, bytes, decoded: await decodeImage(bytes, `${binding.role} output`) });
      } catch (e) {
        const why = e instanceof MediaError ? `is truncated or not a valid image (${e.message})` : `could not be downloaded (${describe(e)})`;
        return this.fail(row, "download", `The ${binding.role} output ${why}.`, retry);
      }
    }

    try {
      await this.publish(row, plan, items);
    } catch (e) {
      return this.fail(row, "publish", `Saving the candidate failed: ${describe(e)}`, retry);
    }
    return false;
  }

  /**
   * Files first (atomic, skipped when identical bytes are already in place), then the rows and the job's success in
   * one transaction. A crash in between leaves orphan files that the retry adopts by hash instead of duplicating.
   */
  private async publish(row: JobRow, plan: GenerationPlan, items: readonly (Collected & { bytes: Uint8Array })[]): Promise<void> {
    const project = this.project;
    const candidateId = `cand-${row.job_id.replace(/^job-/, "")}`;
    await project.mutate(async () => {
      const outputs: { id: string; role: string; rel: string; decoded: DecodedImage }[] = [];
      for (const item of items) {
        const rel = paths.candidateFile(row.asset_id, candidateId, "original", `${item.role}.png`);
        const abs = await resolveIn(project.root, rel);
        const existing = await readFile(abs).catch(() => undefined);
        if (!existing || sha256(existing) !== item.decoded.sha256) await writeFileAtomic(abs, item.bytes);
        outputs.push({ id: `${candidateId}-${item.role}`, role: item.role, rel, decoded: item.decoded });
      }
      const submission = SUBMISSION.parse(JSON.parse(row.submission_json));
      const prompt = typeof submission.values.prompt === "string" ? submission.values.prompt : plan.prompt;
      const now = new Date().toISOString();
      const current = jobRow(project.db, row.job_id);
      if (current.state !== "collecting") return;
      project.transact(() => {
        const exists = project.db.query("SELECT 1 FROM candidates WHERE candidate_id = ?").get(candidateId);
        if (!exists) {
          project.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, parent_candidate_id, label, seed, prompt, favorite, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
            .run(candidateId, row.asset_id, row.step_id, row.run_id, row.job_id, plan.parentCandidateId ?? null, row.label, row.seed, prompt, now);
          for (const o of outputs) {
            project.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'image/png')")
              .run(o.id, candidateId, o.role, o.id, o.rel, o.decoded.sha256, o.decoded.width, o.decoded.height);
          }
        }
        project.db.query("UPDATE generation_jobs SET state = 'succeeded', candidate_id = ?, collected_at = ?, updated_at = ?, queue_position = NULL, error_json = NULL WHERE job_id = ?")
          .run(candidateId, now, now, row.job_id);
      }, [
        { type: "candidate.created", data: { candidateId, assetId: row.asset_id, stepId: row.step_id, runId: row.run_id, jobId: row.job_id, ...(plan.parentCandidateId ? { parentCandidateId: plan.parentCandidateId } : {}) }, actorId: "system:scheduler" },
        { type: "job.changed", data: { jobId: row.job_id, runId: row.run_id, assetId: row.asset_id, stepId: row.step_id, state: "succeeded", attempt: row.attempt, candidateId }, actorId: "system:scheduler" },
      ]);
    });
  }
}
