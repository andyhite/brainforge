import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate, OperationName } from "@brainforge/contracts";
import { decodeImage, decodeRgba } from "@brainforge/media";
import { sha256 } from "@brainforge/storage";
import { frameFileId, frameManifestHash, publishFrameSequence, readFrameSequence, recoverPublications, type FrameInput } from "../src/outputs/frames.ts";
import { createHarness, expectOk, put, PROJECT_YAML } from "./helpers.ts";
import { generationFixture, waitFor, type GenerationFixture } from "./generation-fixture.ts";

setDefaultTimeout(60_000);

const PROJECT = (subjectHeightPx = 216) => `${PROJECT_YAML}defaults:
  sizing: { width: 256, height: 256 }
familyDefaults:
  character:
    sizing: { width: 256, height: 256, subjectHeightPx: ${subjectHeightPx} }
`;

const ASSET = (animation = "{ motion: \"Slow breathing with a slight bob, feet planted.\", loop: true }") => `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager with an exposed brain.
deliverables:
  - id: idle-rest
    kind: pose
    description: Resting guarded stance.
  - id: idle
    kind: animation
    description: Slow breathing loop.
    dependsOn: [idle-rest]
    animation: ${animation}
  - id: after-idle
    kind: still
    description: A still that follows the loop.
    dependsOn: [idle]
`;

const open: GenerationFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.dispose();
});

async function game(options: { asset?: string; project?: string } = {}): Promise<GenerationFixture> {
  const f = await generationFixture({ fake: { latencyMs: 5 }, projectYaml: options.project ?? PROJECT() });
  open.push(f);
  await put(f.root, "brainforge/assets/cortex/asset.yaml", options.asset ?? ASSET());
  return f;
}

const call = <K extends OperationName>(f: GenerationFixture, name: K, input: unknown) => f.h.call(name, input, { project: f.root });
const succeeded = (jobs: { state: string }[]) => jobs.length > 0 && jobs.every((j) => j.state === "succeeded");

async function generate(f: GenerationFixture, stepId: string, branchId?: string): Promise<Candidate[]> {
  const plan = await f.plan({ stepId, count: 1, ...(branchId ? { branchId } : {}) });
  expect(plan.blockers).toEqual([]);
  expectOk(await call(f, "generation.start", { planId: plan.planId, planHash: plan.planHash }));
  await f.waitJobs((jobs) => succeeded(jobs.filter((j) => j.stepId === stepId)), `${stepId} jobs`);
  return expectOk(await call(f, "candidate.list", { assetId: "cortex", stepId, ...(branchId ? { branchId } : {}) })).candidates;
}

async function lockedBranch(f: GenerationFixture): Promise<string> {
  const [concept] = await generate(f, "concept");
  const output = concept!.outputs.find((o) => o.role === "matted")!;
  return expectOk(await call(f, "concept.lock", { assetId: "cortex", candidateId: concept!.candidateId, outputId: output.outputId })).branch.branchId;
}

async function selectAndApprove(f: GenerationFixture, branchId: string, stepId: string, candidate: Candidate, approve = true): Promise<string> {
  const matted = candidate.outputs.find((o) => o.role === "matted")!;
  expectOk(await call(f, "candidate.select", { branchId, deliverableId: stepId, candidateId: candidate.candidateId, outputId: matted.outputId }));
  if (approve) {
    const material = expectOk(await call(f, "review.material", { candidateId: candidate.candidateId }));
    expectOk(await call(f, "review.decide", { candidateId: candidate.candidateId, outputIds: [matted.outputId], requirementsHash: material.requirementsHash, decision: "approve" }));
  }
  return matted.outputId;
}

/** A branch with an approved `idle-rest` pose, ready for the animation. */
async function branchWithPose(f: GenerationFixture): Promise<{ branchId: string; poseOutputId: string }> {
  const branchId = await lockedBranch(f);
  const [pose] = await generate(f, "idle-rest", branchId);
  return { branchId, poseOutputId: await selectAndApprove(f, branchId, "idle-rest", pose!) };
}

async function generateIdle(f: GenerationFixture, branchId: string): Promise<Candidate> {
  const [idle] = await generate(f, "idle", branchId);
  return idle!;
}

const codes = (blockers: { code: string }[]) => blockers.map((b) => b.code);

describe("animation generation.plan", () => {
  test("a guide must be selected and approved; the planner names which guide and why", async () => {
    const f = await game();
    const branchId = await lockedBranch(f);
    const noPose = await f.plan({ stepId: "idle", branchId });
    expect(codes(noPose.blockers)).toContain("DEPENDENCY_NOT_APPROVED");
    expect(noPose.blockers.find((b) => b.code === "GUIDE_MISSING")?.message).toContain("idle-rest");
    expect(noPose.motion).toBeUndefined();

    const [pose] = await generate(f, "idle-rest", branchId);
    await selectAndApprove(f, branchId, "idle-rest", pose!, false);
    const unapproved = await f.plan({ stepId: "idle", branchId });
    expect(codes(unapproved.blockers)).toContain("GUIDE_NOT_APPROVED");
    const sent = f.fake.submissionCount();
    const refused = await call(f, "generation.start", { planId: unapproved.planId, planHash: unapproved.planHash });
    expect(refused.ok === false && refused.error.code).toBe("STEP_BLOCKED");
    expect(f.fake.submissionCount()).toBe(sent);
  });

  test("sourceFrameCount must be 4n+1 for Wan", async () => {
    const f = await game({ asset: ASSET("{ motion: \"Breathes.\", loop: true, sourceFrameCount: 30 }") });
    const { branchId } = await branchWithPose(f);
    const plan = await f.plan({ stepId: "idle", branchId });
    expect(codes(plan.blockers)).toEqual(["FRAME_COUNT_INVALID"]);
    const sent = f.fake.submissionCount();
    const refused = await call(f, "generation.start", { planId: plan.planId, planHash: plan.planHash });
    expect(refused.ok === false && refused.error.code).toBe("STEP_BLOCKED");
    expect(f.fake.submissionCount()).toBe(sent);
  });

  test("a canvas that cannot hold the figure at the calibrated scale blocks instead of refitting", async () => {
    const f = await game({ project: PROJECT(250) });
    const branchId = await lockedBranch(f);
    const [pose] = await generate(f, "idle-rest", branchId);
    await selectAndApprove(f, branchId, "idle-rest", pose!);
    const plan = await f.plan({ stepId: "idle", branchId });
    expect(codes(plan.blockers)).toContain("GUIDE_CLIPPED");
    expect(plan.blockers.find((b) => b.code === "GUIDE_CLIPPED")?.message).toContain("never refits");
  });

  test("without sizing.subjectHeightPx there is no scale to calibrate", async () => {
    const f = await game({ project: PROJECT_YAML });
    const { branchId } = await branchWithPose(f);
    expect(codes((await f.plan({ stepId: "idle", branchId })).blockers)).toEqual(["ANCHOR_MISSING"]);
  });
});

describe("animation generation", () => {
  test("one uniform scale normalizes the approved guide; Wan returns untouched and matted frame sequences that are published whole", async () => {
    const f = await game();
    const { branchId, poseOutputId } = await branchWithPose(f);
    const plan = await f.plan({ stepId: "idle", branchId, count: 1 });
    expect(plan.blockers).toEqual([]);
    expect(plan.workflow.id).toBe("wan22-motion");
    expect(plan.prompt).toContain("Slow breathing with a slight bob");
    expect(plan.prompt).toContain("Static camera, flat plain light-grey background");
    expect(plan.prompt).toContain("A guarded teenager with an exposed brain.");
    expect(plan.motion).toMatchObject({ frameCount: 33, sourceFps: 16, width: 768, height: 768, loop: true, closingFrame: "exclude-last" });
    expect(plan.motion?.guides.map((g) => [g.role, g.outputId])).toEqual([["start", poseOutputId], ["end", poseOutputId]]);
    expect(plan.inputs.references.map((r) => r.role)).toEqual(["start_pose", "end_pose"]);
    expect(plan.submissions[0]?.values).toMatchObject({ width: 768, height: 768, length: 33 });
    const norm = plan.motion!.guideNormalization;
    expect(norm.subjectHeightPx).toBeCloseTo((216 * 768) / 256, 5);
    expect(norm.scale * norm.sourceStandingHeightPx).toBeCloseTo(norm.subjectHeightPx, 5);
    // The anchor is the neutral pose Wan is conditioned on (never the construction sheet or another image of the figure):
    // the pose's own height at the branch scale is exactly the target standing height in the Wan canvas.
    expect(norm.referenceOutputId).toBe(poseOutputId);
    const poseBounds = plan.motion!.guides[0]!.transform.sourceBounds;
    expect(poseBounds.height * norm.scale).toBeCloseTo(norm.subjectHeightPx, 5);
    expect(plan.notes.join("\n")).toContain("guide idle-rest stands");

    expectOk(await call(f, "generation.start", { planId: plan.planId, planHash: plan.planHash }));
    await f.waitJobs((jobs) => succeeded(jobs.filter((j) => j.stepId === "idle")), "the motion job");
    expect(f.fake.submissionCount()).toBe(3); // concept, pose, motion

    // The guide Wan received is the approved pose at the branch scale on the shared feet baseline.
    const graph = f.fake.prompts().at(-1)!.graph;
    const uploaded = String(graph.img_start?.inputs.image);
    expect(uploaded).toBe(String(graph.img_end?.inputs.image));
    const [subfolder, filename] = uploaded.split("/") as [string, string];
    const guide = await f.client.view({ subfolder, filename, type: "input" });
    const { width, height } = await decodeImage(guide);
    expect([width, height]).toEqual([768, 768]);

    const [candidate] = expectOk(await call(f, "candidate.list", { assetId: "cortex", stepId: "idle", branchId })).candidates;
    expect(candidate!.outputs.map((o) => [o.role, o.stage, o.mediaKind, o.frameCount, o.sourceFps, o.totalDurationMs])).toEqual([
      ["untouched", "source", "frames", 33, 16, (33 * 1000) / 16],
      ["matted", "source", "frames", 33, 16, (33 * 1000) / 16],
    ]);

    const db = f.h.registry.getOpen(f.root)!.db;
    const project = f.h.registry.getOpen(f.root)!;
    for (const output of candidate!.outputs) {
      const { frames } = await readFrameSequence(project, output.outputId);
      expect(frames).toHaveLength(33);
      expect(frames.map((fr) => fr.index)).toEqual(Array.from({ length: 33 }, (_, i) => i));
      expect(frames.every((fr) => fr.width === 768 && fr.height === 768 && fr.sourceFrame === fr.index && fr.durationMs === 62.5)).toBe(true);
      // rows agree with the bytes on disk, and the manifest hash is the documented one
      for (const fr of frames) expect(sha256(await readFile(join(f.root, fr.path)))).toBe(fr.sha256);
      expect(output.sha256).toBe(frameManifestHash(frames.map((fr) => fr.sha256)));
      expect(output.fileId).toBe(frameFileId(output.outputId, 0));
      expect(new Set(frames.map((fr) => fr.sha256)).size).toBe(33); // frames actually move
    }
    const matted = await readFrameSequence(project, candidate!.outputs[1]!.outputId);
    const px = await decodeRgba(matted.frames[10]!.bytes);
    expect(px.data[3]).toBe(0); // transparent border
    expect(px.data[(384 * 768 + 384) * 4 + 3]).toBe(255); // opaque subject
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM publication_intents WHERE state = 'committed'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM publication_intents WHERE state != 'committed'").get()?.n).toBe(0);
  });

  test("a raw source output never completes an animation, and dependents keep waiting", async () => {
    const f = await game();
    const { branchId } = await branchWithPose(f);
    const idle = await generateIdle(f, branchId);
    await selectAndApprove(f, branchId, "idle", idle);
    const steps = Object.fromEntries(expectOk(await call(f, "step.list", { assetId: "cortex", branchId })).steps.map((s) => [s.stepId, s]));
    expect(steps.idle?.state).not.toBe("complete");
    expect(steps.idle?.blockers.map((b) => b.code)).toContain("PROCESSING_REQUIRED");
  });

  test("review material and candidate.inspect show motion through images: first and last frame and a contact sheet, registered once", async () => {
    const f = await game();
    const { branchId } = await branchWithPose(f);
    const idle = await generateIdle(f, branchId);
    const inspected = expectOk(await call(f, "candidate.inspect", { candidateId: idle.candidateId }));
    const roles = inspected.visuals.map((v) => v.role);
    expect(roles.filter((r) => r === "frame")).toHaveLength(4);
    expect(roles.filter((r) => r === "contact-sheet")).toHaveLength(2);
    const sheet = inspected.visuals.find((v) => v.role === "contact-sheet" && v.label.startsWith("Source matted"))!;
    const last = inspected.visuals.find((v) => v.role === "frame" && v.label.includes("last frame"))!;
    expect(last.fileId.endsWith("-f32")).toBe(true);
    const db = f.h.registry.getOpen(f.root)!.db;
    const row = db.query<{ path: string; sha256: string }, [string]>("SELECT path, sha256 FROM output_files WHERE file_id = ? AND kind = 'contact-sheet'").get(sheet.fileId)!;
    const bytes = await readFile(join(f.root, row.path));
    expect(sha256(bytes)).toBe(row.sha256);
    const decoded = await decodeImage(bytes);
    expect([decoded.width, decoded.height]).toEqual([sheet.width!, sheet.height!]);

    const material = expectOk(await call(f, "review.material", { candidateId: idle.candidateId }));
    expect(material.visuals.filter((v) => v.role === "contact-sheet").map((v) => v.fileId).sort()).toEqual(inspected.visuals.filter((v) => v.role === "contact-sheet").map((v) => v.fileId).sort());
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM output_files WHERE kind = 'contact-sheet'").get()?.n).toBe(2);
  });
});

describe("collection of frame sequences", () => {
  test("a sequence cut short midway publishes nothing, fails at download, and retry collect reuses the remote result", async () => {
    const f = await game();
    const { branchId } = await branchWithPose(f);
    const plan = await f.plan({ stepId: "idle", branchId, count: 1 });
    f.fake.injectFault("view-truncate-late");
    expectOk(await call(f, "generation.start", { planId: plan.planId, planHash: plan.planHash }));
    const failed = (await f.waitJobs((jobs) => jobs.some((j) => j.stepId === "idle" && j.state === "failed"), "the partial download to fail")).find((j) => j.stepId === "idle")!;
    expect(failed.error?.stage).toBe("download");
    expect(failed.error?.message).toMatch(/Frame \d+ of 33/);
    expect(failed.error?.message).toContain("nothing was published");
    const db = f.h.registry.getOpen(f.root)!.db;
    const countFrames = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM output_frames").get()!.n;
    expect(countFrames()).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidates WHERE step_id = 'idle'").get()?.n).toBe(0);
    const submitted = f.fake.submissionCount();

    f.fake.clearFault("view-truncate-late");
    expectOk(await call(f, "job.retry", { jobId: failed.jobId, mode: "collect" }));
    await f.waitJobs((jobs) => succeeded(jobs.filter((j) => j.stepId === "idle")), "the retried collection");
    expect(f.fake.submissionCount()).toBe(submitted);
    expect(countFrames()).toBe(66);
  });

  test("a restart in the middle of collection resumes from ComfyUI's stored result without resubmitting", async () => {
    const f = await game();
    const { branchId } = await branchWithPose(f);
    const idle = await generateIdle(f, branchId);
    const jobId = idle.candidateId.replace("cand-", "job-");
    await f.h.registry.closeAll();
    const raw = new Database(join(f.root, "brainforge/.state/project.sqlite"));
    raw.exec("PRAGMA foreign_keys = OFF");
    for (const table of ["output_frames", "output_files"]) raw.query(`DELETE FROM ${table} WHERE output_id LIKE ?`).run(`${idle.candidateId}%`);
    raw.query("DELETE FROM candidate_outputs WHERE candidate_id = ?").run(idle.candidateId);
    raw.query("DELETE FROM candidates WHERE candidate_id = ?").run(idle.candidateId);
    raw.query("UPDATE generation_jobs SET state = 'collecting', candidate_id = NULL, collected_at = NULL WHERE job_id = ?").run(jobId);
    raw.close();

    const second = createHarness({ comfy: () => f.client });
    expectOk(await second.call("project.open", { path: f.root }));
    await waitFor(async () => expectOk(await second.call("job.list", {}, { project: f.root })).jobs.filter((j) => j.stepId === "idle"), succeeded, "the job to be collected again");
    const resumed = expectOk(await second.call("candidate.list", { assetId: "cortex", stepId: "idle" }, { project: f.root })).candidates;
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.candidateId).toBe(idle.candidateId);
    expect(resumed[0]!.outputs.map((o) => o.frameCount)).toEqual([33, 33]);
    expect(f.fake.submissionCount()).toBe(3);
    await second.registry.closeAll();
  });
});

describe("frame publication recovery", () => {
  /** Add two processed-style outputs to a real candidate through the same publisher the pipeline uses. */
  async function setup() {
    const f = await game();
    const { branchId } = await branchWithPose(f);
    const idle = await generateIdle(f, branchId);
    const project = f.h.registry.getOpen(f.root)!;
    const frames = (await readFrameSequence(project, idle.outputs[1]!.outputId)).frames.slice(0, 4);
    const input: FrameInput[] = frames.map((fr, i) => ({ png: fr.bytes, sourceFrame: fr.sourceFrame, durationMs: 83.3 + i }));
    const spec = (outputId: string) => ({
      assetId: "cortex", candidateId: idle.candidateId, actorId: "test", purpose: "processing",
      outputs: [{ outputId, role: "matted" as const, stage: "processed" as const, frames: input, parentOutputId: idle.outputs[1]!.outputId, playbackFps: 12 }],
    });
    return { f, project, idle, spec };
  }


  test("a crash after the files were moved but before the rows were written is finished on the next open", async () => {
    const { f, project, idle, spec } = await setup();
    const id = `${idle.candidateId}-p1`;
    await expect(publishFrameSequence(project, spec(id), { afterMove: async () => { throw new Error("power cut"); } })).rejects.toThrow("power cut");
    expect(project.db.query("SELECT 1 FROM candidate_outputs WHERE output_id = ?").get(id)).toBeNull();
    const report = await recoverPublications(project);
    expect(report.failed).toEqual([]);
    expect(report.committed).toHaveLength(1);
    const { output, frames } = await readFrameSequence(project, id);
    expect(output).toMatchObject({ stage: "processed", frame_count: 4, parent_output_id: idle.outputs[1]!.outputId, playback_fps: 12 });
    expect(frames.map((fr) => fr.durationMs)).toEqual([83.3, 84.3, 85.3, 86.3]);
    expect(await recoverPublications(project)).toEqual({ committed: [], failed: [] });
    expect(f.fake.submissionCount()).toBe(3);
  });

  test("a crash with files still in staging is completed by moving them", async () => {
    const { project, idle, spec } = await setup();
    const id = `${idle.candidateId}-p2`;
    await expect(publishFrameSequence(project, spec(id), { afterStaging: async () => { throw new Error("killed"); } })).rejects.toThrow("killed");
    expect(project.db.query("SELECT 1 FROM candidate_outputs WHERE output_id = ?").get(id)).toBeNull();
    expect((await recoverPublications(project)).committed).toHaveLength(1);
    expect((await readFrameSequence(project, id)).frames).toHaveLength(4);
  });

  test("corrupt staged bytes fail the intent, remove only what it created and expose nothing", async () => {
    const { f, project, idle, spec } = await setup();
    const id = `${idle.candidateId}-p3`;
    await expect(publishFrameSequence(project, spec(id), { afterStaging: async () => { throw new Error("killed"); } })).rejects.toThrow("killed");
    const intent = project.db.query<{ intent_id: string }, []>("SELECT intent_id FROM publication_intents WHERE state = 'prepared'").get()!;
    const staged = join(f.root, "brainforge/.state/staging", intent.intent_id, id, "0002.png");
    const bytes = await readFile(staged);
    await writeFile(staged, bytes.subarray(0, bytes.length - 40));

    const report = await recoverPublications(project);
    expect(report.committed).toEqual([]);
    expect(report.failed[0]?.intentId).toBe(intent.intent_id);
    expect(report.failed[0]?.error).toContain(id);
    expect(project.db.query("SELECT 1 FROM candidate_outputs WHERE output_id = ?").get(id)).toBeNull();
    expect(project.db.query("SELECT COUNT(*) AS n FROM output_frames WHERE output_id = ?").get(id)).toEqual({ n: 0 });
    expect(await Bun.file(join(f.root, "brainforge/.state/staging", intent.intent_id)).exists()).toBe(false);
    expect(project.db.query<{ state: string }, [string]>("SELECT state FROM publication_intents WHERE intent_id = ?").get(intent.intent_id)?.state).toBe("failed");
    // the generated source it was derived from is untouched
    expect((await readFrameSequence(project, idle.outputs[1]!.outputId)).frames).toHaveLength(33);
    await rm(join(f.root, "brainforge/.state/staging"), { recursive: true, force: true });
  });

  test("a frame that does not decode, or a size that differs from frame 0, is refused before anything is staged", async () => {
    const { project, idle, spec } = await setup();
    const good = spec(`${idle.candidateId}-p4`);
    const broken = { ...good, outputs: [{ ...good.outputs[0]!, frames: [good.outputs[0]!.frames[0]!, { png: new Uint8Array([1, 2, 3]), sourceFrame: 1, durationMs: 80 }] }] };
    await expect(publishFrameSequence(project, broken)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(project.db.query("SELECT COUNT(*) AS n FROM publication_intents WHERE state = 'prepared'").get()).toEqual({ n: 0 });
  });
});
