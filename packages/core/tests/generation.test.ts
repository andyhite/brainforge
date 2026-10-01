import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OperationResult } from "@brainforge/contracts";
import { ASSET_YAML, agent, createHarness, expectOk, human, put } from "./helpers.ts";
import { generationFixture, waitFor, type GenerationFixture } from "./generation-fixture.ts";

const open: GenerationFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.dispose();
});

async function fixture(options?: Parameters<typeof generationFixture>[0]): Promise<GenerationFixture> {
  const f = await generationFixture(options);
  open.push(f);
  return f;
}

function errorOf(result: OperationResult<unknown>) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.data)}`);
  return result.error;
}

const terminal = (states: string[]) => (jobs: { state: string }[]) => jobs.length > 0 && jobs.every((j) => states.includes(j.state));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("budgets", () => {
  test("only a human grants or revokes; counters and status are computed", async () => {
    const f = await fixture();
    const denied = errorOf(await f.h.call("budget.grant", { assetId: "cortex", stepId: "concept", maxStarts: 1, maxCandidateSubmissions: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { project: f.root, context: agent }));
    expect(denied.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    const past = errorOf(await f.h.call("budget.grant", { assetId: "cortex", stepId: "concept", maxStarts: 1, maxCandidateSubmissions: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() }, { project: f.root }));
    expect(past.code).toBe("INVALID_INPUT");
    const missing = errorOf(await f.h.call("budget.grant", { assetId: "nobody", stepId: "concept", maxStarts: 1, maxCandidateSubmissions: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { project: f.root }));
    expect(missing.code).toBe("NOT_FOUND");

    const budget = await f.grant();
    expect(budget).toMatchObject({ status: "active", usedStarts: 0, usedCandidateSubmissions: 0, createdBy: human.actorId });
    expect(expectOk(await f.h.call("budget.list", {}, { project: f.root, context: agent })).budgets.map((b) => b.budgetId)).toEqual([budget.budgetId]);

    expect(errorOf(await f.h.call("budget.revoke", { budgetId: budget.budgetId, reason: "no" }, { project: f.root, context: agent })).code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    const revoked = expectOk(await f.h.call("budget.revoke", { budgetId: budget.budgetId, reason: "changed my mind" }, { project: f.root })).budget;
    expect(revoked.status).toBe("revoked");
    expect(expectOk(await f.h.call("budget.list", {}, { project: f.root })).budgets).toEqual([]);
    expect(expectOk(await f.h.call("budget.list", { includeInactive: true }, { project: f.root })).budgets).toHaveLength(1);
  });
});

describe("generation.plan", () => {
  test("composes the prompt from authored files with sources, pins hashes, and stores seeds", async () => {
    const f = await fixture();
    await f.grant();
    const plan = await f.plan({ count: 3 });
    expect(plan.blockers).toEqual([]);
    expect(plan.workflow).toMatchObject({ id: "krea2-still", version: 1 });
    expect(plan.prompt).toContain("A guarded teenager with an exposed brain.");
    expect(plan.promptSources.find((p) => p.label === "Subject")?.source).toBe("brainforge/assets/cortex/asset.yaml:description");
    expect(plan.prompt).toBe(plan.promptSources.map((p) => p.text).join("\n"));
    expect(Object.keys(plan.inputs.specHashes).sort()).toEqual(["brainforge/assets/cortex/asset.yaml", "brainforge/project.yaml"]);
    expect(plan.submissions).toHaveLength(3);
    expect(new Set(plan.submissions.map((s) => s.seed)).size).toBe(3);
    expect(plan.submissions.every((s) => s.values.seed === s.seed && s.values.prompt === plan.prompt)).toBe(true);
    expect(plan.limits).toEqual({ maxBatchCandidates: 4, maxConcurrentGenerations: 1, maxAttemptsPerStep: 3 });
    expect(plan.budgets).toHaveLength(1);
    expect(plan.preflight.ok).toBe(true);
    // nothing was sent to ComfyUI by planning
    expect(f.fake.submissionCount()).toBe(0);
    expect(f.fake.requestCount("POST", "/prompt")).toBe(0);
    expect(f.fake.requestCount("POST", "/upload/image")).toBe(0);

    const again = await f.plan({ count: 3 });
    expect(again.planId).not.toBe(plan.planId);
    expect(again.planHash).not.toBe(plan.planHash); // fresh seeds are part of the pinned content
  });

  test("blockers, not exceptions: failed preflight, unreachable or unconfigured ComfyUI, no budget, oversize batch", async () => {
    const f = await fixture();
    const unbudgeted = await f.plan();
    expect(unbudgeted.blockers.map((b) => b.code)).toEqual(["NO_BUDGET"]);
    expect(unbudgeted.blockers[0]?.recoveryActions[0]?.operation).toBe("budget.grant");

    await f.grant();
    f.fake.hideModel("birefnet.safetensors");
    f.fake.hideNode("InvertMask");
    const preflight = await f.plan();
    expect(preflight.preflight).toMatchObject({ ok: false, missingNodes: ["InvertMask"], missingModels: ["birefnet.safetensors"] });
    expect(preflight.blockers.map((b) => b.code)).toEqual(["PREFLIGHT_FAILED", "PREFLIGHT_FAILED"]);

    expect((await f.plan({ count: 5 })).blockers.map((b) => b.code)).toContain("BATCH_TOO_LARGE");

    f.online.value = false;
    expect((await f.plan()).blockers.map((b) => b.code)).toContain("COMFY_NOT_CONFIGURED");
    f.online.value = true;
    await f.fake.stop();
    expect((await f.plan()).blockers.map((b) => b.code)).toContain("COMFY_UNREACHABLE");
  });

  test("a variation needs a real parent and instructions; its workflow is the identity-edit one", async () => {
    const f = await fixture();
    await f.grant();
    const noParent = await f.plan({ mode: "variation", iterationInstructions: "bluer" });
    expect(noParent.blockers.map((b) => b.code)).toContain("PARENT_REQUIRED");
    const badParent = await f.plan({ mode: "variation", parentCandidateId: "cand-nope", iterationInstructions: "bluer" });
    expect(badParent.blockers.map((b) => b.code)).toContain("PARENT_MISSING");
    expect((await f.plan({ parentCandidateId: "cand-x" })).blockers.map((b) => b.code)).toContain("PARENT_UNEXPECTED");
  });

  test("concept exploration belongs to no branch; jobs and budgets report their own step", async () => {
    const f = await fixture();
    const budget = await f.grant({ stepId: "construction-sheet" });
    expect(budget.stepId).toBe("construction-sheet");
    const plan = await f.plan({ branchId: "br-x" });
    expect(plan.blockers.map((b) => b.code)).toContain("BRANCH_UNEXPECTED");
    expect(plan.crops).toEqual([]);
  });
});

describe("generation.start", () => {
  test("charges the budget exactly once, even when the same request is re-sent", async () => {
    const f = await fixture({ fake: { latencyMs: 20 } });
    const budget = await f.grant();
    const plan = await f.plan({ count: 2 });
    const input = { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId };
    const first = expectOk(await f.h.call("generation.start", input, { project: f.root, requestId: "start-1" }));
    const replay = expectOk(await f.h.call("generation.start", input, { project: f.root, requestId: "start-1" }));
    expect(replay.runId).toBe(first.runId);
    expect(first.jobs).toHaveLength(2);
    expect(first.jobs.every((j) => j.state === "queued" && j.cancellable && j.availableActions.length > 0)).toBe(true);
    expect(first.budget).toMatchObject({ usedStarts: 1, usedCandidateSubmissions: 2 });

    // a different request for the same plan is refused rather than starting a second run
    const second = errorOf(await f.h.call("generation.start", input, { project: f.root, requestId: "start-2" }));
    expect(second.code).toBe("STEP_BLOCKED");

    await f.waitJobs(terminal(["succeeded"]), "both jobs to succeed");
    expect(f.fake.submissionCount()).toBe(2);
    const listed = expectOk(await f.h.call("budget.list", {}, { project: f.root })).budgets[0];
    expect(listed).toMatchObject({ usedStarts: 1, usedCandidateSubmissions: 2 });
  });

  test("is refused without a usable budget, with a recovery action pointing at the human-only grant", async () => {
    const f = await fixture();
    const plan = await f.plan({ count: 3 });
    const ask = async (budgetId: string) => errorOf(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId }, { project: f.root, context: agent }));

    expect((await ask("budget-unknown")).code).toBe("NOT_FOUND");

    const small = await f.grant({ maxStarts: 1, maxCandidateSubmissions: 2 });
    const over = await ask(small.budgetId);
    expect(over.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(over.recoveryActions[0]?.operation).toBe("budget.grant");

    const expiring = await f.grant();
    const db = f.h.registry.getOpen(f.root)!.db;
    db.query("UPDATE generation_budgets SET expires_at = ? WHERE budget_id = ?").run(new Date(Date.now() - 1000).toISOString(), expiring.budgetId);
    expect((await ask(expiring.budgetId)).message).toContain("expired");

    const revoked = await f.grant();
    expectOk(await f.h.call("budget.revoke", { budgetId: revoked.budgetId, reason: "test" }, { project: f.root }));
    expect((await ask(revoked.budgetId)).message).toContain("revoked");

    const wrongAsset = await f.grant();
    db.query("UPDATE generation_budgets SET asset_id = 'other' WHERE budget_id = ?").run(wrongAsset.budgetId);
    expect((await ask(wrongAsset.budgetId)).code).toBe("INVALID_INPUT");

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM generation_jobs").get()?.n).toBe(0);
    expect(f.fake.submissionCount()).toBe(0);
  });

  test("refuses a stale plan: edited spec, wrong hash", async () => {
    const f = await fixture();
    const budget = await f.grant();
    const plan = await f.plan();
    expect(errorOf(await f.h.call("generation.start", { planId: plan.planId, planHash: "0".repeat(64), budgetId: budget.budgetId }, { project: f.root })).code).toBe("REVISION_CONFLICT");
    await put(f.root, "brainforge/assets/cortex/asset.yaml", `${ASSET_YAML}identity:\n  hair: a bright green mohawk\n`);
    const stale = errorOf(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    expect(stale.code).toBe("REVISION_CONFLICT");
    expect(stale.message).toContain("asset.yaml");
    expect((await f.plan()).prompt).toContain("a bright green mohawk");
    expect(f.h.registry.getOpen(f.root)!.db.query<{ n: number }, []>("SELECT used_starts AS n FROM generation_budgets").get()?.n).toBe(0);
  });

  test("notes and style descriptions never reach the prompt", async () => {
    const f = await fixture();
    await put(f.root, "brainforge/assets/cortex/asset.yaml", `${ASSET_YAML}notes: SECRET-STATUS-NOTE proposal pending\nidentity:\n  eyes: two big round white eyes\n`);
    const { prompt, promptSources } = await f.plan();
    expect(prompt).toContain("two big round white eyes");
    expect(prompt).not.toContain("SECRET-STATUS-NOTE");
    expect(prompt).not.toContain("eyes:");
    expect(promptSources.some((p) => p.source.endsWith(":notes") || p.source.endsWith(":description") && p.source.includes("styles/"))).toBe(false);
  });

  test("refuses when ComfyUI fails its preflight at start time", async () => {
    const f = await fixture();
    const budget = await f.grant();
    const plan = await f.plan();
    f.fake.hideModel("birefnet.safetensors");
    expect(errorOf(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root })).code).toBe("WORKFLOW_UNAVAILABLE");
  });

  test("attempts per step: the cap holds until a person grants a new budget", async () => {
    const f = await fixture({ fake: { latencyMs: 5 } });
    const budget = await f.grant({ maxStarts: 10, maxCandidateSubmissions: 40 });
    const plans = [];
    for (let i = 0; i < 4; i++) plans.push(await f.plan({ count: 1 }));
    for (const plan of plans.slice(0, 3)) {
      expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root, context: agent }));
    }
    const fourth = plans[3]!;
    const blocked = errorOf(await f.h.call("generation.start", { planId: fourth.planId, planHash: fourth.planHash, budgetId: budget.budgetId }, { project: f.root, context: agent }));
    expect(blocked.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(blocked.message).toContain("3 of 3");
    const replanned = await f.plan({ count: 1 });
    expect(replanned.blockers.map((b) => b.code)).toEqual(["ATTEMPTS_EXHAUSTED"]);

    const fresh = await f.grant();
    expectOk(await f.h.call("generation.start", { planId: fourth.planId, planHash: fourth.planHash, budgetId: fresh.budgetId }, { project: f.root, context: agent }));
    await f.waitJobs(terminal(["succeeded"]), "all runs to finish");
  });
});

describe("running jobs", () => {
  test("happy path: files and rows are published, one prompt per job with its identity, never more than the concurrency limit at once", async () => {
    const f = await fixture({ fake: { latencyMs: 40 } });
    const budget = await f.grant();
    const plan = await f.plan({ count: 3 });
    const started = expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));

    let busiest = 0;
    const jobs = await waitFor(async () => {
      const now = await f.jobs();
      busiest = Math.max(busiest, now.filter((j) => ["submitting", "running", "collecting"].includes(j.state)).length);
      return now;
    }, terminal(["succeeded"]), "three succeeded jobs");
    expect(busiest).toBe(1);

    expect(f.fake.submissionCount()).toBe(3);
    for (const job of started.jobs) {
      const remote = f.fake.prompts().filter((p) => p.identity === `bf:${job.jobId}:1`);
      expect(remote).toHaveLength(1);
      expect(remote[0]?.extraData.brainforge).toMatchObject({ jobId: job.jobId, attempt: 1 });
    }

    const project = f.h.registry.getOpen(f.root)!;
    for (const job of jobs) {
      expect(job.candidateId).toBeDefined();
      const inspected = expectOk(await f.h.call("job.inspect", { jobId: job.jobId }, { project: f.root }));
      const candidate = inspected.candidate!;
      expect(candidate).toMatchObject({ assetId: "cortex", jobId: job.jobId, prompt: plan.prompt, favorite: false });
      expect(candidate.seed).toBe(plan.submissions.find((s) => s.label === job.label)?.seed);
      expect(candidate.outputs.map((o) => o.role).sort()).toEqual(["matted", "untouched"]);
      for (const output of candidate.outputs) {
        const rel = `brainforge/assets/cortex/work/candidates/${candidate.candidateId}/original/${output.role}.png`;
        const bytes = await readFile(join(f.root, rel));
        expect(sha(bytes)).toBe(output.sha256);
        expect(output.fileId).toBe(output.outputId);
        expect(output.width).toBeGreaterThan(0);
      }
    }
    const events = project.eventsAfter(0).events;
    expect(events.filter((e) => e.type === "candidate.created")).toHaveLength(3);
    expect(events.filter((e) => e.type === "job.changed" && typeof e.data === "object" && e.data !== null && "state" in e.data && e.data.state === "succeeded")).toHaveLength(3);
    expect(await Bun.file(join(f.root, `brainforge/assets/cortex/work/runs/${started.runId}/inputs.json`)).exists()).toBe(true);
  });

  test("a variation continues from a parent's matted output through the identity-edit workflow", async () => {
    const f = await fixture({ fake: { latencyMs: 10 } });
    const budget = await f.grant();
    const first = await f.plan({ count: 1 });
    expectOk(await f.h.call("generation.start", { planId: first.planId, planHash: first.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const [parentJob] = await f.waitJobs(terminal(["succeeded"]), "the parent to finish");
    const parentId = parentJob!.candidateId!;

    const plan = await f.plan({ mode: "variation", count: 1, parentCandidateId: parentId, iterationInstructions: "make the jeans darker" });
    expect(plan.blockers).toEqual([]);
    expect(plan.workflow.id).toBe("krea2-variation");
    expect(plan.prompt).toContain("Change: make the jeans darker");
    expect(plan.inputs.references).toHaveLength(1);
    expect(plan.inputs.references[0]).toMatchObject({ role: "reference", id: `${parentId}-matted` });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const jobs = await f.waitJobs((js) => js.length === 2 && terminal(["succeeded"])(js), "the variation to finish");

    const variation = jobs.find((j) => j.jobId !== parentJob!.jobId)!;
    const child = expectOk(await f.h.call("job.inspect", { jobId: variation.jobId }, { project: f.root })).candidate!;
    expect(child.parentCandidateId).toBe(parentId);
    const remote = f.fake.prompts().find((p) => p.identity === `bf:${variation.jobId}:1`)!;
    const loadImage = Object.values(remote.graph).find((n) => n.class_type === "LoadImage")!;
    expect(String(loadImage.inputs.image)).toMatch(/^brainforge\/bf-[0-9a-f]{24}\.png$/);
    expect(f.fake.requestCount("POST", "/upload/image")).toBe(1);
  });

  test("submit-timeout-after-accept: exactly one prompt exists and the job attaches to it by identity", async () => {
    const f = await fixture({ fake: { faults: ["submit-timeout-after-accept"] }, clientTimeoutMs: 250 });
    const budget = await f.grant();
    const plan = await f.plan({ count: 1 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const [job] = await f.waitJobs(terminal(["succeeded"]), "the job to succeed");
    expect(f.fake.submissionCount()).toBe(1);
    expect(f.fake.requestCount("POST", "/prompt")).toBe(1);
    expect(job!.promptId).toBe(f.fake.prompts()[0]!.promptId);
  });

  test("submit-timeout-before-accept: unresolved, nothing resubmitted; only a human's new attempt submits again and keeps the old attempt", async () => {
    const f = await fixture({ fake: { faults: ["submit-timeout-before-accept"] }, clientTimeoutMs: 250 });
    const budget = await f.grant();
    const plan = await f.plan({ count: 1 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const [stuck] = await f.waitJobs(terminal(["unresolved"]), "the job to become unresolved");
    expect(stuck).toMatchObject({ unresolved: { reason: "no-match", matches: [] }, cancellable: false });
    expect(stuck!.availableActions.map((a) => a.operation)).toEqual(["job.reconcile", "job.retry"]);

    await Bun.sleep(150);
    expect(f.fake.requestCount("POST", "/prompt")).toBe(1);
    expect(f.fake.submissionCount()).toBe(0);

    const reconciled = expectOk(await f.h.call("job.reconcile", { jobId: stuck!.jobId }, { project: f.root }));
    expect(reconciled.outcome).toBe("no-match");
    expect(f.fake.requestCount("POST", "/prompt")).toBe(1);

    const agentRetry = errorOf(await f.h.call("job.retry", { jobId: stuck!.jobId, mode: "new-attempt" }, { project: f.root, context: agent }));
    expect(agentRetry.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(f.fake.requestCount("POST", "/prompt")).toBe(1);

    const retried = expectOk(await f.h.call("job.retry", { jobId: stuck!.jobId, mode: "new-attempt" }, { project: f.root })).job;
    expect(retried).toMatchObject({ attempt: 2, state: "queued", label: stuck!.label });
    const jobs = await f.waitJobs((js) => js.some((j) => j.attempt === 2 && j.state === "succeeded"), "the new attempt to succeed");
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.attempt === 1)?.state).toBe("cancelled");
    expect(f.fake.submissionCount()).toBe(1);
    expect(f.fake.prompts()[0]!.identity).toBe(`bf:${retried.jobId}:2`);
    expect(expectOk(await f.h.call("budget.list", {}, { project: f.root })).budgets[0]).toMatchObject({ usedStarts: 1, usedCandidateSubmissions: 2 });
  });

  test("a prompt that vanished from ComfyUI is unresolved, not failed, and reconcile finds it again", async () => {
    const f = await fixture({ fake: { faults: ["history-missing"], latencyMs: 20 } });
    const budget = await f.grant();
    const plan = await f.plan({ count: 1 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const [lost] = await f.waitJobs(terminal(["unresolved"]), "the job to become unresolved");
    expect(lost!.error?.message).toContain("neither");
    f.fake.clearFault("history-missing");
    const reconciled = expectOk(await f.h.call("job.reconcile", { jobId: lost!.jobId }, { project: f.root }));
    expect(reconciled.outcome).toBe("attached");
    await f.waitJobs(terminal(["succeeded"]), "the reattached job to succeed");
    expect(f.fake.submissionCount()).toBe(1);
  });

  test("view-truncate fails with stage download; retry collect then publishes the same remote result without regenerating", async () => {
    const f = await fixture({ fake: { faults: ["view-truncate"] } });
    const budget = await f.grant();
    const plan = await f.plan({ count: 1 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const [failed] = await f.waitJobs(terminal(["failed"]), "the job to fail");
    expect(failed!.error?.stage).toBe("download");
    expect(failed!.error?.message).toContain("truncated");
    expect(failed!.availableActions.map((a) => a.input)).toContainEqual({ jobId: failed!.jobId, mode: "collect" });
    const db = f.h.registry.getOpen(f.root)!.db;
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidates").get()?.n).toBe(0);

    // still truncated: the retry fails the same way and still costs nothing
    expectOk(await f.h.call("job.retry", { jobId: failed!.jobId, mode: "collect" }, { project: f.root }));
    await waitFor(() => f.h.call("job.inspect", { jobId: failed!.jobId }, { project: f.root }), (r) => r.ok && r.data.job.state === "failed", "the second failure");
    f.fake.clearFault("view-truncate");
    expectOk(await f.h.call("job.retry", { jobId: failed!.jobId, mode: "collect" }, { project: f.root }));
    await f.waitJobs(terminal(["succeeded"]), "the collection to succeed");
    expect(f.fake.submissionCount()).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidates").get()?.n).toBe(1);
    expect(expectOk(await f.h.call("budget.list", {}, { project: f.root })).budgets[0]).toMatchObject({ usedCandidateSubmissions: 1 });
  });

  test("cancel: a running prompt is refused; a prompt pending on ComfyUI is deleted by id only; the budget is not refunded", async () => {
    const f = await fixture({
      fake: { latencyMs: 1500 },
      projectYaml: "schema: brainforge.project.v2\nid: demo\nname: Demo\nautomation:\n  maxConcurrentGenerations: 2\nexport:\n  preset: generic\n  destination: assets/brainforge\n",
    });
    const budget = await f.grant();
    const plan = await f.plan({ count: 3 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const jobs = await f.waitJobs((js) => js.filter((j) => j.state === "running").length === 2 && js.some((j) => j.queuePosition === 1), "one running, one pending, one local");
    const running = jobs.find((j) => j.state === "running" && j.queuePosition === undefined && !j.cancellable)!;
    const pending = jobs.find((j) => j.queuePosition === 1)!;
    const local = jobs.find((j) => j.state === "queued")!;

    const refused = errorOf(await f.h.call("job.cancel", { jobId: running.jobId }, { project: f.root }));
    expect(refused.code).toBe("CANCEL_UNAVAILABLE");
    expect(refused.message).toContain("cannot be cancelled");

    const cancelled = expectOk(await f.h.call("job.cancel", { jobId: pending.jobId }, { project: f.root })).job;
    expect(cancelled.state).toBe("cancelled");
    expect(f.fake.prompts().find((p) => p.promptId === pending.promptId)?.state).toBe("deleted");
    expect(f.fake.prompts().find((p) => p.promptId === running.promptId)?.state).not.toBe("deleted");

    expect(expectOk(await f.h.call("job.cancel", { jobId: local.jobId }, { project: f.root })).job.state).toBe("cancelled");
    expect(errorOf(await f.h.call("job.cancel", { jobId: cancelled.jobId }, { project: f.root })).code).toBe("CANCEL_UNAVAILABLE");

    const finished = await f.waitJobs((js) => js.find((j) => j.jobId === running.jobId)?.state === "succeeded", "the running job to finish anyway");
    expect(finished.filter((j) => j.state === "cancelled")).toHaveLength(2);
    expect(f.fake.requestCount("POST", "/interrupt")).toBe(0);
    expect(expectOk(await f.h.call("budget.list", {}, { project: f.root })).budgets[0]).toMatchObject({ usedCandidateSubmissions: 3 });
  });
});

describe("restart and recovery", () => {
  test("a new runtime over the same database resumes running jobs without a second submission or duplicate candidates", async () => {
    const f = await fixture({ fake: { latencyMs: 500 } });
    const budget = await f.grant();
    const plan = await f.plan({ count: 2 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    await f.waitJobs((js) => js.some((j) => j.state === "running" && j.promptId !== undefined), "a running job");
    await f.h.registry.closeAll();

    const second = createHarness({ comfy: () => f.client });
    expectOk(await second.call("project.open", { path: f.root }));
    const jobs = await waitFor(
      async () => expectOk(await second.call("job.list", { limit: 50 }, { project: f.root })).jobs,
      terminal(["succeeded"]),
      "both jobs to finish after the restart",
    );
    expect(jobs).toHaveLength(2);
    expect(f.fake.submissionCount()).toBe(2);
    const db = second.registry.getOpen(f.root)!.db;
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidates").get()?.n).toBe(2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidate_outputs").get()?.n).toBe(4);
    expect(expectOk(await second.call("budget.list", {}, { project: f.root })).budgets[0]).toMatchObject({ usedStarts: 1, usedCandidateSubmissions: 2 });
    await second.registry.closeAll();
  });

  test("a job left `submitting` by a crash is resolved by identity: attached when ComfyUI has exactly one match, unresolved when none", async () => {
    const f = await fixture({ fake: { latencyMs: 400 } });
    const budget = await f.grant();
    const plan = await f.plan({ count: 2 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const [running] = (await f.waitJobs((js) => js.some((j) => j.state === "running"), "a running job")).filter((j) => j.state === "running");
    await f.h.registry.closeAll();

    // Crash simulation 1: the prompt was accepted but its id never reached the database.
    // Crash simulation 2: the second job was marked submitting and the process died before the request was sent.
    const raw = new Database(join(f.root, "brainforge/.state/project.sqlite"));
    raw.query("UPDATE generation_jobs SET state = 'submitting', prompt_id = NULL, submitted_at = NULL WHERE job_id = ?").run(running!.jobId);
    raw.query("UPDATE generation_jobs SET state = 'submitting' WHERE job_id != ?").run(running!.jobId);
    raw.close();

    const second = createHarness({ comfy: () => f.client });
    expectOk(await second.call("project.open", { path: f.root }));
    const jobs = await waitFor(
      async () => expectOk(await second.call("job.list", { limit: 50 }, { project: f.root })).jobs,
      (js) => js.some((j) => j.jobId === running!.jobId && j.state === "succeeded") && js.some((j) => j.state === "unresolved"),
      "one job attached and finished, the other unresolved",
    );
    expect(jobs.find((j) => j.jobId === running!.jobId)?.promptId).toBe(f.fake.prompts()[0]!.promptId);
    expect(jobs.find((j) => j.state === "unresolved")?.unresolved?.reason).toBe("no-match");
    await Bun.sleep(100);
    expect(f.fake.requestCount("POST", "/prompt")).toBe(1);
    expect(f.fake.submissionCount()).toBe(1);
    await second.registry.closeAll();
  });

  test("closing is `closing` while jobs are active and completes by itself once they are terminal", async () => {
    const f = await fixture({ fake: { latencyMs: 150 } });
    const budget = await f.grant();
    const plan = await f.plan({ count: 1 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const closing = expectOk(await f.h.call("project.close", {}, { project: f.root }));
    expect(closing.state).toBe("closing");
    await waitFor(() => f.h.registry.get(f.root), (p) => p === undefined, "the project to close itself");
    expect(f.fake.submissionCount()).toBe(1);
    const raw = new Database(join(f.root, "brainforge/.state/project.sqlite"), { readonly: true });
    expect(raw.query<{ state: string }, []>("SELECT state FROM generation_jobs").all()).toEqual([{ state: "succeeded" }]);
    raw.close();
  });

  test("a crash between writing candidate files and committing rows re-adopts the files by hash: one candidate, bytes untouched", async () => {
    const f = await fixture();
    const budget = await f.grant();
    const plan = await f.plan({ count: 1 });
    expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
    const [done] = await f.waitJobs(terminal(["succeeded"]), "the job to succeed");
    const candidateId = done!.candidateId!;
    await f.h.registry.closeAll();

    const files = ["untouched", "matted"].map((role) => join(f.root, `brainforge/assets/cortex/work/candidates/${candidateId}/original/${role}.png`));
    const before = await Promise.all(files.map(async (p) => ({ bytes: sha(await readFile(p)), mtime: (await stat(p)).mtimeMs })));
    const raw = new Database(join(f.root, "brainforge/.state/project.sqlite"));
    raw.exec("PRAGMA foreign_keys = ON");
    raw.query("DELETE FROM candidate_outputs WHERE candidate_id = ?").run(candidateId);
    raw.query("DELETE FROM candidates WHERE candidate_id = ?").run(candidateId);
    raw.query("UPDATE generation_jobs SET state = 'collecting', candidate_id = NULL, collected_at = NULL WHERE job_id = ?").run(done!.jobId);
    raw.close();

    const second = createHarness({ comfy: () => f.client });
    expectOk(await second.call("project.open", { path: f.root }));
    const [again] = await waitFor(async () => expectOk(await second.call("job.list", {}, { project: f.root })).jobs, terminal(["succeeded"]), "the job to be collected again");
    expect(again!.candidateId).toBe(candidateId);
    const db = second.registry.getOpen(f.root)!.db;
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidates").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidate_outputs").get()?.n).toBe(2);
    const after = await Promise.all(files.map(async (p) => ({ bytes: sha(await readFile(p)), mtime: (await stat(p)).mtimeMs })));
    expect(after).toEqual(before);
    expect(f.fake.submissionCount()).toBe(1);
    await second.registry.closeAll();
  });
});
