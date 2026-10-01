import { rm } from "node:fs/promises";
import type { Budget, GenerationPlan, Job } from "@brainforge/contracts";
import { ComfyClient } from "@brainforge/comfy";
import { createFakeComfy, type FakeComfy, type FakeComfyOptions } from "@brainforge/comfy/testing";
import { ASSET_YAML, createHarness, expectOk, initializedGame, put, type Harness } from "./helpers.ts";

export async function waitFor<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(15);
  }
}

export interface GenerationFixture {
  fake: FakeComfy;
  client: ComfyClient;
  h: Harness;
  root: string;
  /** Whether the injected transport currently resolves (false = "no ComfyUI configured"). */
  online: { value: boolean };
  grant(over?: Record<string, unknown>): Promise<Budget>;
  plan(over?: Record<string, unknown>): Promise<GenerationPlan>;
  jobs(): Promise<Job[]>;
  waitJobs(done: (jobs: Job[]) => boolean, what: string): Promise<Job[]>;
  /** Close the project, stop the fake, and delete nothing the fake still needs. */
  dispose(): Promise<void>;
}

export async function generationFixture(options: { fake?: FakeComfyOptions; clientTimeoutMs?: number; projectYaml?: string } = {}): Promise<GenerationFixture> {
  const fake = await createFakeComfy({ latencyMs: 30, ...options.fake });
  const client = new ComfyClient(fake.url, options.clientTimeoutMs ?? 400);
  const online = { value: true };
  const h = createHarness({ comfy: () => (online.value ? client : undefined) });
  const root = await initializedGame(h);
  if (options.projectYaml) await put(root, "brainforge/project.yaml", options.projectYaml);
  await put(root, "brainforge/assets/cortex/asset.yaml", ASSET_YAML);
  expectOk(await h.call("project.open", { path: root }));

  const fixture: GenerationFixture = {
    fake, client, h, root, online,
    grant: async (over = {}) =>
      expectOk(await h.call("budget.grant", { assetId: "cortex", stepId: "concept", maxStarts: 3, maxCandidateSubmissions: 12, expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...over }, { project: root })).budget,
    plan: async (over = {}) => expectOk(await h.call("generation.plan", { assetId: "cortex", count: 2, ...over }, { project: root })).plan,
    jobs: async () => expectOk(await h.call("job.list", { limit: 200 }, { project: root })).jobs,
    waitJobs: (done, what) => waitFor(fixture.jobs, done, what),
    dispose: async () => {
      await h.registry.closeAll();
      await fake.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
  return fixture;
}
