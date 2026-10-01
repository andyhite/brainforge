#!/usr/bin/env bun
/**
 * Recovery acceptance harness (plan "Repeatable recovery smoke scenarios"). Not an application feature.
 *
 *   bun scripts/recovery-smoke.ts --source-project <game dir> --scenario <name|all> [--keep] [--copy-work]
 *
 * For each scenario it builds an OS-temp fixture game from the source project's AUTHORED YAML (project.yaml with a fresh
 * project id, styles, assets/<id>/asset.yaml; the source is only read), plus two fixture-only assets
 * (`fixture-prop`, `fixture-walker`) for the scenarios that need promotable/processable material. ComfyUI is the
 * in-process protocol-test fake (`@brainforge/comfy/testing`, synthetic images, no GPU); the real BF_COMFY_URL is
 * never read. The server under test is `apps/server/src/test-entry.ts` run as a CHILD process on a free port; it is
 * the only process this script kills (SIGKILL) and restarts. Exactly one hold or failure is armed per scenario.
 *
 * Fixture seeding: generation runs through the real operations (budget.grant -> generation.plan/start -> the real
 * scheduler against the fake). Candidates for promotion/export/processing are inserted DIRECTLY into the project DB
 * (and via the real publishFrameSequence) before the server starts, because no operation imports finished candidates;
 * everything after that (concept.lock, review, promotion, activation, export, processing) uses the real operations.
 */
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import type { Candidate, OperationData, OperationInput, OperationName, OperationRequest, OperationResult, OutputDetail } from "@brainforge/contracts";
import { createFakeComfy, type FakeComfy } from "@brainforge/comfy/testing";
import {
  HUMAN_CONTEXT, createMachineStore, createProjectRegistry, executeOperation, projectHandlers,
  type OpenProject, type OperationRuntime,
} from "@brainforge/core";
import { publishFrameSequence } from "../packages/core/src/outputs/frames.ts";
import { makePng, makeRgbaPng } from "../packages/core/tests/helpers.ts";

const REPO = resolve(import.meta.dir, "..");
const SCENARIOS = ["collection-restart", "partial-download", "processing-restart", "promotion-failure", "export-failure"] as const;
type Scenario = (typeof SCENARIOS)[number];
const DEFAULT_SOURCE = "/Users/user/Code/andyhite/shit-your-brain-pants";
const NOW = "2026-10-01T00:00:00.000Z";

const { values: args } = parseArgs({
  options: { "source-project": { type: "string" }, scenario: { type: "string" }, keep: { type: "boolean" }, "copy-work": { type: "boolean" } },
});
const sourceProject = resolve(args["source-project"] ?? DEFAULT_SOURCE);
const requested = args.scenario ?? "all";
const selected: readonly Scenario[] = requested === "all" ? SCENARIOS : SCENARIOS.filter((s) => s === requested);
if (selected.length === 0) {
  console.error(`usage: bun scripts/recovery-smoke.ts --source-project <game dir> --scenario <${SCENARIOS.join("|")}|all> [--keep] [--copy-work]`);
  process.exit(2);
}

// --------------------------------------------------------------------------- reporting

let failures = 0;

function check(scenario: string, name: string, ok: boolean, evidence = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${evidence ? ` -- ${evidence}` : ""}`);
}

function evidence(scenario: string, text: string): void {
  console.log(`     [${scenario}] ${text}`);
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(40);
  }
}

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const listDir = (path: string): Promise<string[]> => readdir(path).then((names) => names.filter((n) => !n.startsWith(".DS")).sort(), () => []);

async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer();
      probe.once("error", () => done(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port from ${start}`);
}

// --------------------------------------------------------------------------- fixture

interface Fixture {
  scenario: Scenario;
  dir: string;
  root: string;
  cfg: string;
  control: string;
  projectId: string;
  fake: FakeComfy;
}

const PROP_YAML = `schema: brainforge.asset.v2
id: fixture-prop
name: Fixture prop
family: prop
description: A plain wooden crate with rope handles. Recovery-harness fixture asset, not part of the game.
deliverables:
  - id: hero
    kind: still
    required: true
    description: The crate seen from the front.
`;

const WALKER_YAML = `schema: brainforge.asset.v2
id: fixture-walker
name: Fixture walker
family: character
description: A plain upright figure. Recovery-harness fixture asset, not part of the game.
overrides:
  sizing: { width: 40, height: 40, subjectHeightPx: 24 }
deliverables:
  - id: walk
    kind: animation
    description: Walk cycle.
    animation: { motion: walk, loop: true, sourceFps: 16 }
`;

/** Hash of the source's authored files, to prove the source was only read. */
async function authoredHash(): Promise<string> {
  const files = [join(sourceProject, "brainforge/project.yaml")];
  for (const style of await listDir(join(sourceProject, "brainforge/styles"))) files.push(join(sourceProject, "brainforge/styles", style));
  for (const asset of await listDir(join(sourceProject, "brainforge/assets"))) files.push(join(sourceProject, "brainforge/assets", asset, "asset.yaml"));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(await readFile(file).catch(() => ""));
  return hash.digest("hex");
}

/** An in-process runtime over the real handlers, used only before the server child starts (init and seeding). */
async function withLocalProject<T>(fx: Fixture, fn: (api: LocalApi) => Promise<T>): Promise<T> {
  const machine = createMachineStore({ configDir: join(fx.dir, "setup-cfg") });
  const registry = createProjectRegistry();
  const runtime: OperationRuntime = { projects: registry, machine, workflowsDir: join(REPO, "packages/comfy/workflows"), publicUrl: "http://127.0.0.1:1" };
  let seq = 0;
  const api: LocalApi = {
    call: (name, input, project = fx.root) => executeOperation(runtime, projectHandlers, HUMAN_CONTEXT, name, {
      requestId: `local-${++seq}-${randomBytes(3).toString("hex")}`, ...(project ? { project } : {}), input: input as OperationInput<typeof name>,
    } satisfies OperationRequest<typeof name>),
    open: () => registry.get(fx.root) as OpenProject,
  };
  try {
    return await fn(api);
  } finally {
    await registry.closeAll();
    machine.close();
  }
}

interface LocalApi {
  call<K extends OperationName>(name: K, input: unknown, project?: string | null): Promise<OperationResult<OperationData<K>>>;
  open(): OpenProject;
}

function must<T>(result: OperationResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code}: ${result.error.message}`);
  return result.data;
}

async function createFixture(scenario: Scenario): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), `bf-recovery-${scenario}-`));
  const root = join(dir, "game");
  await mkdir(root);
  const fake = await createFakeComfy({ port: await freePort(8201), latencyMs: 150 });
  if (fake.port === 8188) throw new Error("refusing to use port 8188");
  const projectId = `recovery-fixture-${randomBytes(4).toString("hex")}`;
  const fx: Fixture = { scenario, dir, root, cfg: join(dir, "server-cfg"), control: join(dir, "control"), projectId, fake };
  await mkdir(fx.control);

  await withLocalProject(fx, async (api) => {
    must(await api.call("project.init", { path: root, confirm: true }, null), "project.init");
  });
  const source = join(sourceProject, "brainforge");
  const projectYaml = await readFile(join(source, "project.yaml"), "utf8").catch(() => { throw new Error(`${source}/project.yaml not found; pass --source-project <game dir>`); });
  await writeFile(join(root, "brainforge/project.yaml"), projectYaml.replace(/^id: .*$/m, `id: ${projectId}`));
  for (const style of await listDir(join(source, "styles"))) {
    await mkdir(join(root, "brainforge/styles"), { recursive: true });
    await writeFile(join(root, "brainforge/styles", style), await readFile(join(source, "styles", style)));
  }
  for (const asset of await listDir(join(source, "assets"))) {
    const yaml = await readFile(join(source, "assets", asset, "asset.yaml")).catch(() => undefined);
    if (!yaml) continue;
    await mkdir(join(root, "brainforge/assets", asset), { recursive: true });
    await writeFile(join(root, "brainforge/assets", asset, "asset.yaml"), yaml);
    if (args["copy-work"] && await exists(join(source, "assets", asset, "work"))) await cp(join(source, "assets", asset, "work"), join(root, "brainforge/assets", asset, "work"), { recursive: true });
  }
  for (const [id, yaml] of [["fixture-prop", PROP_YAML], ["fixture-walker", WALKER_YAML]] as const) {
    await mkdir(join(root, "brainforge/assets", id), { recursive: true });
    await writeFile(join(root, "brainforge/assets", id, "asset.yaml"), yaml);
  }
  evidence(scenario, `fixture directory: ${dir} (game ${root}; fake ComfyUI ${fake.url}, synthetic images; project id ${projectId})`);
  return fx;
}

async function disposeFixture(fx: Fixture): Promise<void> {
  await fx.fake.stop();
  if (args.keep) console.log(`     [${fx.scenario}] kept ${fx.dir}`);
  else await rm(fx.dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- the server child

let requestSeq = 0;

class Server {
  private constructor(
    readonly fx: Fixture,
    readonly port: number,
    readonly proc: Subprocess,
    readonly logPath: string,
  ) {}

  static async start(fx: Fixture, tag: string): Promise<Server> {
    const port = await freePort(3561);
    const logPath = join(fx.dir, `server-${tag}.log`);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("BF_")) env[key] = value;
    env.BF_COMFY_URL = fx.fake.url;
    env.BF_CONFIG_DIR = fx.cfg;
    const proc = Bun.spawn(["bun", "apps/server/src/test-entry.ts", "--port", String(port), "--control", fx.control], {
      cwd: REPO, env, stdout: Bun.file(logPath), stderr: Bun.file(logPath),
    });
    const server = new Server(fx, port, proc, logPath);
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`test server exited early (${proc.exitCode}): ${await readFile(logPath, "utf8")}`);
      return fetch(`${server.origin}/api/health`).then((r) => r.ok, () => false);
    }, (up) => up, "the test server to listen", 30_000);
    must(await server.call("project.open", { path: fx.root }, { project: false }), "project.open");
    return server;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** `human` sends the browser's Origin header (fixture only); `agent` sends none, like the CLI. */
  async call<K extends OperationName>(name: K, input: unknown, opts: { as?: "human" | "agent"; requestId?: string; project?: false } = {}): Promise<OperationResult<OperationData<K>>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if ((opts.as ?? "human") === "human") headers.origin = this.origin;
    else headers["x-brainforge-agent"] = "recovery-smoke";
    const res = await fetch(`${this.origin}/api/operations/${name}`, {
      method: "POST", headers,
      body: JSON.stringify({ requestId: opts.requestId ?? `rs-${++requestSeq}-${randomBytes(3).toString("hex")}`, ...(opts.project === false ? {} : { project: this.fx.root }), input }),
    });
    return (await res.json()) as OperationResult<OperationData<K>>;
  }

  async file(fileId: string): Promise<Uint8Array> {
    const res = await fetch(`${this.origin}/api/projects/${this.fx.projectId}/files/${fileId}`, { headers: { origin: this.origin } });
    if (!res.ok) throw new Error(`file ${fileId}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** SIGKILL: the process gets no chance to finish a publication or release anything. */
  async kill(): Promise<void> {
    this.proc.kill("SIGKILL");
    await this.proc.exited;
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.proc.kill("SIGTERM");
    await Promise.race([this.proc.exited, Bun.sleep(8000).then(() => this.proc.kill("SIGKILL"))]);
  }
}

const faultsFile = (fx: Fixture, faults: Record<string, string> | null): Promise<void> =>
  faults ? writeFile(join(fx.control, "faults.json"), JSON.stringify(faults)) : rm(join(fx.control, "faults.json"), { force: true });

const arm = (fx: Fixture, point: string): Promise<void> => writeFile(join(fx.control, `hold-${point}`), "");
const release = (fx: Fixture, point: string): Promise<void> => rm(join(fx.control, `hold-${point}`), { force: true });
const reached = (fx: Fixture, point: string): Promise<string> => until(() => readFile(join(fx.control, `reached-${point}`), "utf8").catch(() => ""), (s) => s.length > 0, `the server to reach ${point}`);

/** Row counts and states straight from the project DB, read-only, for evidence alongside the HTTP view. */
function dbRows<T>(fx: Fixture, sql: string): T[] {
  const db = new Database(join(fx.root, "brainforge/.state/project.sqlite"), { readonly: true });
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------- shared steps

async function startGeneration(server: Server, count = 1): Promise<{ jobId: string; budgetId: string }> {
  const budget = must(await server.call("budget.grant", { assetId: "cortex", stepId: "concept", maxStarts: 3, maxCandidateSubmissions: 12, expiresAt: new Date(Date.now() + 3600_000).toISOString() }), "budget.grant").budget;
  const plan = must(await server.call("generation.plan", { assetId: "cortex", count }), "generation.plan").plan;
  const started = must(await server.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }), "generation.start");
  return { jobId: started.jobs[0]!.jobId, budgetId: budget.budgetId };
}

const jobOf = async (server: Server, jobId: string) => must(await server.call("job.inspect", { jobId }), "job.inspect").job;
const conceptCandidates = async (server: Server) => must(await server.call("candidate.list", { assetId: "cortex", stepId: "concept" }), "candidate.list").candidates;

/** Every output of the candidates is served by the real files route and hashes to what the record says. */
async function outputsVerify(server: Server, candidates: Candidate[]): Promise<string> {
  let checked = 0;
  for (const c of candidates) {
    for (const o of c.outputs) {
      const bytes = await server.file(o.fileId);
      if (sha(bytes) !== o.sha256) return `output ${o.outputId} bytes do not match its recorded hash`;
      checked++;
    }
  }
  return checked > 0 ? "" : "no outputs to verify";
}

async function framesVerify(server: Server, detail: OutputDetail): Promise<string> {
  for (const frame of detail.frames) if (sha(await server.file(frame.fileId)) !== frame.sha256) return `frame ${frame.index} does not match its hash`;
  for (const page of detail.atlasPages) if (sha(await server.file(page.fileId)) !== page.sha256) return `atlas page ${page.page} does not match its hash`;
  return "";
}

// --------------------------------------------------------------------------- scenarios: generation

async function collectionRestart(fx: Fixture): Promise<void> {
  const s = fx.scenario;
  await arm(fx, "after-receipt");
  let server = await Server.start(fx, "a");
  try {
    const { jobId } = await startGeneration(server);
    const hit = await reached(fx, "after-receipt");
    const job = await jobOf(server, jobId);
    const before = await conceptCandidates(server);
    evidence(s, `injected hold: after remote receipt, before candidate publication (${hit.trim()})`);
    check(s, "hold observed with the job collecting and no candidate visible", job.state === "collecting" && before.length === 0, `job ${job.state}, candidates ${before.length}, ComfyUI prompts accepted ${fx.fake.submissionCount()}`);

    await server.kill();
    await release(fx, "after-receipt");
    evidence(s, "SIGKILLed the server child mid-collection, restarting it");
    server = await Server.start(fx, "b");
    const done = await until(() => jobOf(server, jobId), (j) => j.state === "succeeded" || j.state === "failed", "the job to finish after restart");
    const after = await conceptCandidates(server);
    check(s, "the same job succeeded after the restart", done.state === "succeeded" && done.candidateId !== undefined, `state ${done.state}${done.error ? `: ${done.error.message}` : ""}`);
    check(s, "exactly one candidate exists and it is the job's", after.length === 1 && after[0]!.candidateId === done.candidateId, `candidates ${after.length}`);
    check(s, "no regeneration was submitted", fx.fake.submissionCount() === 1 && fx.fake.requestCount("POST", "/prompt") === 1, `POST /prompt ${fx.fake.requestCount("POST", "/prompt")}, accepted ${fx.fake.submissionCount()}`);
    const bad = await outputsVerify(server, after);
    check(s, "candidate files are served and match their recorded hashes", bad === "", bad || `${after[0]!.outputs.length} outputs`);
    const dirs = await listDir(join(fx.root, "brainforge/assets/cortex/work/candidates"));
    check(s, "one candidate directory on disk", dirs.length === 1, dirs.join(","));
  } finally {
    await server.stop();
  }
}

async function partialDownload(fx: Fixture): Promise<void> {
  const s = fx.scenario;
  fx.fake.injectFault("view-truncate");
  let server = await Server.start(fx, "a");
  try {
    const { jobId } = await startGeneration(server);
    const failed = await until(() => jobOf(server, jobId), (j) => j.state === "failed" || j.state === "succeeded", "the truncated download to fail");
    evidence(s, `injected failure: ComfyUI /view serves 60% of each output's bytes (view requests: ${fx.fake.requestCount("GET", "/view")})`);
    check(s, "the job failed at the download stage naming the truncation", failed.state === "failed" && failed.error?.stage === "download" && /truncated|not a valid image/.test(failed.error.message), failed.error?.message ?? failed.state);
    check(s, "nothing partial is visible", (await conceptCandidates(server)).length === 0 && (await listDir(join(fx.root, "brainforge/assets/cortex/work/candidates"))).length === 0);

    await server.kill();
    evidence(s, "SIGKILLed the server child, restarting it");
    server = await Server.start(fx, "b");
    check(s, "after the restart the failure and the empty candidate list persist", (await jobOf(server, jobId)).state === "failed" && (await conceptCandidates(server)).length === 0);

    fx.fake.clearFault("view-truncate");
    must(await server.call("job.retry", { jobId, mode: "collect" }, { as: "agent" }), "job.retry");
    const done = await until(() => jobOf(server, jobId), (j) => j.state === "succeeded" || j.state === "failed", "the retried collection");
    const after = await conceptCandidates(server);
    check(s, "job.retry collect recovered the same remote result", done.state === "succeeded" && after.length === 1, `state ${done.state}, candidates ${after.length}`);
    check(s, "no regeneration was submitted", fx.fake.submissionCount() === 1 && fx.fake.requestCount("POST", "/prompt") === 1, `POST /prompt ${fx.fake.requestCount("POST", "/prompt")}`);
    const bad = await outputsVerify(server, after);
    check(s, "recovered files match their recorded hashes", bad === "", bad);
  } finally {
    await server.stop();
  }
}

// --------------------------------------------------------------------------- scenarios: processing

/** A locked concept for fixture-walker plus a 33-frame source walk, seeded like the core processing tests. */
async function seedWalker(fx: Fixture): Promise<void> {
  await withLocalProject(fx, async (api) => {
    must(await api.call("project.open", { path: fx.root }, null), "project.open");
    const open = api.open();
    const policy = must(await api.call("settings.inspect", {}), "settings.inspect").policy.requestedPolicyHash;
    must(await api.call("policy.authorize", { requestedPolicyHash: policy }), "policy.authorize");
    const run = (runId: string, jobId: string, stepId: string, planJson: unknown) => {
      open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'fixture-walker', ?, 'x', ?, 'b', 'recovery-smoke', ?)").run(runId, stepId, JSON.stringify(planJson), NOW);
      open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'fixture-walker', ?, 1, 'x', ?, 'succeeded', '{}', ?, ?)").run(jobId, runId, stepId, `id-${jobId}`, NOW, NOW);
    };
    const figure = (x: number, y: number, w: number, h: number, size = 48): Buffer => makeRgbaPng(size, size, (px, py) => (px >= x && px < x + w && py >= y && py < y + h ? [200, 40, 40, 255] : [0, 0, 0, 0]));
    const concept = figure(22, 2, 20, 60, 64);
    const rel = "brainforge/assets/fixture-walker/work/candidates/cand-c/original/cand-c-matted.png";
    await mkdir(dirname(join(fx.root, rel)), { recursive: true });
    await writeFile(join(fx.root, rel), concept);
    run("run-c", "job-c", "concept", {});
    open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, created_at) VALUES ('cand-c', 'fixture-walker', 'concept', 'run-c', 'job-c', 'c', 'p', ?)").run(NOW);
    open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES ('cand-c-matted', 'cand-c', 'matted', 'cand-c-matted', ?, ?, 64, 64, 'image/png')").run(rel, sha(concept));
    const branchId = must(await api.call("concept.lock", { assetId: "fixture-walker", candidateId: "cand-c", outputId: "cand-c-matted" }), "concept.lock").branch.branchId;
    run("run-w", "job-w", "walk", { motion: { guideNormalization: { scale: 0.5, feet: { x: 24, y: 44 }, canvas: { width: 48, height: 48 }, referenceOutputId: "cand-c-matted", referenceHash: sha(concept) } } });
    const frames = Array.from({ length: 33 }, (_, i) => ({ png: figure(19 + Math.round(5 * Math.sin((2 * Math.PI * i) / 32)), 14, 10, 30), sourceFrame: i, durationMs: 62.5 }));
    await publishFrameSequence(open, {
      assetId: "fixture-walker", candidateId: "cand-w", actorId: "recovery-smoke", purpose: "test",
      candidate: { candidateId: "cand-w", runId: "run-w", jobId: "job-w", branchId, label: "Walk", prompt: "p" },
      outputs: [{ outputId: "cand-w-matted", role: "matted", stage: "source", frames, sourceFps: 16, totalDurationMs: 2062.5 }],
    });
  });
}

async function processingRestart(fx: Fixture): Promise<void> {
  const s = fx.scenario;
  await seedWalker(fx);
  await arm(fx, "processing-after-staging");
  let server = await Server.start(fx, "a");
  try {
    const plan = must(await server.call("processing.plan", { candidateId: "cand-w" }), "processing.plan").plan;
    if (plan.blockers.length > 0) throw new Error(`processing plan blocked: ${plan.blockers.map((b) => b.message).join(" ")}`);
    const inflight = server.call("processing.start", { planId: plan.planId, planHash: plan.planHash }).catch(() => undefined);
    const hit = await reached(fx, "processing-after-staging");
    const staging = await listDir(join(fx.root, "brainforge/.state/staging"));
    const prepared = dbRows<{ state: string }>(fx, "SELECT state FROM publication_intents WHERE state = 'prepared'").length;
    const processedBefore = (must(await server.call("candidate.list", { assetId: "fixture-walker", stepId: "walk" }), "candidate.list").candidates[0]?.outputs ?? []).filter((o) => o.stage === "processed");
    evidence(s, `injected hold: after processed staging, before publication (${hit.trim()})`);
    check(s, "hold observed: staged files and a prepared intent exist, no processed output is visible", staging.length === 1 && prepared === 1 && processedBefore.length === 0, `staging dirs ${staging.length}, prepared intents ${prepared}, processed outputs ${processedBefore.length}`);

    await server.kill();
    await inflight;
    await release(fx, "processing-after-staging");
    evidence(s, "SIGKILLed the server child mid-publication, restarting it");
    server = await Server.start(fx, "b");
    const retried = must(await server.call("processing.start", { planId: plan.planId, planHash: plan.planHash }), "processing.start after restart").output;
    const outputs = (must(await server.call("candidate.list", { assetId: "fixture-walker", stepId: "walk" }), "candidate.list").candidates[0]?.outputs ?? []).filter((o) => o.stage === "processed");
    check(s, "exactly one processed output exists and processing.start returns it", outputs.length === 1 && outputs[0]!.outputId === retried.outputId, `processed outputs ${outputs.length}`);
    const complete = retried.frames.length === plan.frames.length && retried.frames.length > 0;
    const bad = await framesVerify(server, retried);
    check(s, "the processed output is complete: every planned frame and atlas page is served and matches its hash", complete && bad === "", bad || `${retried.frames.length}/${plan.frames.length} frames, ${retried.atlasPages.length} atlas page(s)`);
    const states = dbRows<{ state: string }>(fx, "SELECT state FROM publication_intents").map((r) => r.state);
    check(s, "no prepared intent or staging directory is left", !states.includes("prepared") && (await listDir(join(fx.root, "brainforge/.state/staging"))).length === 0, `intent states ${states.join(",")}`);
    const again = must(await server.call("processing.start", { planId: plan.planId, planHash: plan.planHash }), "processing.start replay").output;
    check(s, "a replay of the same plan returns the same output", again.outputId === retried.outputId);
    const source = await framesVerify(server, must(await server.call("output.inspect", { outputId: "cand-w-matted" }), "output.inspect").output);
    check(s, "the source frames were not touched", source === "", source);
  } finally {
    await server.stop();
  }
}

// --------------------------------------------------------------------------- scenarios: promotion and export

/** fixture-prop with a locked concept and an approved `hero` still (candidates inserted directly, review through real operations). */
async function seedProp(fx: Fixture): Promise<void> {
  await withLocalProject(fx, async (api) => {
    must(await api.call("project.open", { path: fx.root }, null), "project.open");
    const open = api.open();
    const policy = must(await api.call("settings.inspect", {}), "settings.inspect").policy.requestedPolicyHash;
    must(await api.call("policy.authorize", { requestedPolicyHash: policy }), "policy.authorize");
    let shade = 20;
    const still = async (id: string, stepId: string, branchId: string | undefined) => {
      const png = makePng(16, 16, [shade++, 60, 60]);
      const rel = `brainforge/assets/fixture-prop/work/candidates/${id}/original/out.png`;
      await mkdir(dirname(join(fx.root, rel)), { recursive: true });
      await writeFile(join(fx.root, rel), png);
      open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'fixture-prop', ?, 'p', '{}', 'b', 'recovery-smoke', ?)").run(`run_${id}`, stepId, NOW);
      open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'fixture-prop', ?, 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, stepId, `identity-${id}`, NOW, NOW);
      open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, 'fixture-prop', ?, ?, ?, 'A', 'a prompt', 0, ?, ?)").run(id, stepId, `run_${id}`, `job_${id}`, NOW, branchId ?? null);
      open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'matted', ?, ?, ?, 16, 16, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha(png));
    };
    await still("cand_concept", "concept", undefined);
    const branchId = must(await api.call("concept.lock", { assetId: "fixture-prop", candidateId: "cand_concept", outputId: "out_cand_concept" }), "concept.lock").branch.branchId;
    await still("cand_hero", "hero", branchId);
    const material = must(await api.call("review.material", { candidateId: "cand_hero" }), "review.material");
    must(await api.call("review.decide", { candidateId: "cand_hero", outputIds: ["out_cand_hero"], requirementsHash: material.requirementsHash, decision: "approve", reasons: [] }), "review.decide");
  });
}

const promote = async (server: Server, requestId: string) => {
  const plan = must(await server.call("promotion.plan", { assetId: "fixture-prop" }), "promotion.plan").plan;
  return server.call("promotion.start", { planId: plan.planId, planHash: plan.planHash, requestId });
};

const versionsOf = async (server: Server) => must(await server.call("version.list", { assetId: "fixture-prop" }), "version.list");

/** Promote version 1 and activate it through the real operations. */
async function activateFirstVersion(server: Server): Promise<string> {
  const first = must(await promote(server, "recovery-promote-1"), "first promotion").version;
  const { active } = await versionsOf(server);
  must(await server.call("version.activate", { versionId: first.versionId, expectedRevision: active.revision }), "version.activate");
  return first.versionId;
}

async function promotionFailure(fx: Fixture): Promise<void> {
  const s = fx.scenario;
  await seedProp(fx);
  let server = await Server.start(fx, "a");
  try {
    const v1 = await activateFirstVersion(server);
    const versionsDir = join(fx.root, "brainforge/assets/fixture-prop/versions");
    const before = await versionsOf(server);
    await faultsFile(fx, { promotion: "fail-before-publish" });
    evidence(s, "injected failure: promotion fails before the production directory is published");
    const failed = await promote(server, "recovery-promote-2");
    const invariants = async (label: string, srv: Server) => {
      const now = await versionsOf(srv);
      const dirs = await listDir(versionsDir);
      const staging = await listDir(join(fx.root, "brainforge/.state/staging"));
      check(s, `${label}: no half version is visible and the earlier active selection is unchanged`, now.versions.length === 1 && dirs.length === 1 && dirs[0] === basename(before.versions[0]!.directory) && now.active.versionId === v1 && now.active.revision === before.active.revision, `versions ${now.versions.length}, version dirs ${dirs.length}, active ${now.active.versionId}`);
      check(s, `${label}: no staging leftovers`, staging.length === 0, `staging entries ${staging.length}`);
    };
    check(s, "the injected promotion failed with IO_ERROR", !failed.ok && failed.error.code === "IO_ERROR", failed.ok ? "succeeded" : failed.error.code);
    await invariants("after the failure", server);
    const intent = dbRows<{ state: string }>(fx, "SELECT state FROM publication_intents WHERE kind = 'promotion' ORDER BY rowid DESC LIMIT 1")[0]?.state;
    check(s, "the failed promotion's intent is recorded as failed", intent === "failed", `intent ${intent}`);

    await server.kill();
    evidence(s, "SIGKILLed the server child, restarting it");
    server = await Server.start(fx, "b");
    await invariants("after the restart", server);

    await faultsFile(fx, null);
    const retried = must(await promote(server, "recovery-promote-2"), "retry with the same requestId");
    check(s, "retrying the same requestId produced version 2", retried.created && retried.version.versionNumber === 2, `versionNumber ${retried.version.versionNumber}`);
    const replay = must(await promote(server, "recovery-promote-2"), "replay of the same requestId");
    const final = await versionsOf(server);
    check(s, "replaying it again returns the same version and creates nothing", !replay.created && replay.version.versionId === retried.version.versionId && final.versions.length === 2 && (await listDir(versionsDir)).length === 2, `versions ${final.versions.length}`);
    check(s, "promotion still did not move the active selection", final.active.versionId === v1);
  } finally {
    await server.stop();
  }
}

async function exportFailure(fx: Fixture): Promise<void> {
  const s = fx.scenario;
  await seedProp(fx);
  let server = await Server.start(fx, "a");
  try {
    const v1 = await activateFirstVersion(server);
    const destination = join(fx.root, "assets/brainforge");
    const exportOnce = async (srv: Server, requestId: string) => {
      const plan = must(await srv.call("export.plan", { assetIds: ["fixture-prop"] }), "export.plan").plan;
      if (plan.blockers.length > 0) throw new Error(`export plan blocked: ${plan.blockers.map((b) => b.message).join(" ")}`);
      return srv.call("export.start", { planId: plan.planId, planHash: plan.planHash, requestId });
    };
    const first = must(await exportOnce(server, "recovery-export-1"), "first export").export;
    const snapshot = async () => {
      const link = await readlink(join(destination, "current")).catch(() => "");
      const manifest = await readFile(join(destination, "current/manifest.json")).then(sha, () => "");
      const hero = await readFile(join(destination, "current/assets/fixture-prop/stills/hero.png")).then(sha, () => "");
      const releases = (await listDir(join(destination, ".releases"))).filter((n) => !n.startsWith("."));
      return { link, manifest, hero, releases };
    };
    const prior = await snapshot();
    check(s, "the first export resolves through current", prior.link === `.releases/${first.exportId}` && prior.manifest !== "" && prior.hero !== "", `current -> ${prior.link}`);

    await faultsFile(fx, { export: "fail-before-switch" });
    evidence(s, "injected failure: the second export fails before the current pointer switch");
    const failed = await exportOnce(server, "recovery-export-2");
    const invariants = async (label: string, srv: Server) => {
      const now = await snapshot();
      check(s, `${label}: current still resolves to the prior complete export`, JSON.stringify(now) === JSON.stringify(prior), `current -> ${now.link}, releases ${now.releases.join(",")}`);
      const list = must(await srv.call("export.list", {}), "export.list").exports;
      check(s, `${label}: the prior export is still current and the failed one is recorded failed`, list.find((e) => e.exportId === first.exportId)?.current === true && list.some((e) => e.state === "failed" && !e.current), list.map((e) => `${e.state}${e.current ? "*" : ""}`).join(","));
      const versions = await versionsOf(srv);
      check(s, `${label}: promotion and activation are untouched`, versions.versions.length === 1 && versions.active.versionId === v1);
    };
    check(s, "the injected export failed with IO_ERROR", !failed.ok && failed.error.code === "IO_ERROR", failed.ok ? "succeeded" : failed.error.code);
    await invariants("after the failure", server);

    await server.kill();
    evidence(s, "SIGKILLed the server child, restarting it");
    server = await Server.start(fx, "b");
    await invariants("after the restart", server);

    await faultsFile(fx, null);
    const retried = must(await exportOnce(server, "recovery-export-3"), "retry after disarming").export;
    const next = await snapshot();
    check(s, "a retry publishes a new release atomically and current resolves to it", retried.current && next.link === `.releases/${retried.exportId}` && next.manifest !== "" && next.hero === prior.hero, `current -> ${next.link}`);
    check(s, "only the new release remains backing current", next.releases.length === 1 && next.releases[0] === retried.exportId, next.releases.join(","));
  } finally {
    await server.stop();
  }
}

// --------------------------------------------------------------------------- main

const RUN: Record<Scenario, (fx: Fixture) => Promise<void>> = {
  "collection-restart": collectionRestart,
  "partial-download": partialDownload,
  "processing-restart": processingRestart,
  "promotion-failure": promotionFailure,
  "export-failure": exportFailure,
};

const sourceBefore = await authoredHash();
const summary: { scenario: Scenario; ok: boolean }[] = [];
for (const scenario of selected) {
  console.log(`\n== ${scenario}`);
  const failuresBefore = failures;
  const fx = await createFixture(scenario);
  try {
    await RUN[scenario](fx);
  } catch (e) {
    check(scenario, "scenario ran to completion", false, e instanceof Error ? e.message : String(e));
  } finally {
    await disposeFixture(fx);
  }
  summary.push({ scenario, ok: failures === failuresBefore });
}
check("all", "the source project's authored files were only read", (await authoredHash()) === sourceBefore);

console.log(`\n${summary.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.scenario}`).join("\n")}`);
console.log(failures === 0 ? "\nRECOVERY SMOKE: PASS" : `\nRECOVERY SMOKE: FAIL (${failures} failed check${failures === 1 ? "" : "s"})`);
process.exit(failures === 0 ? 0 : 1);
