import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, OperationData, OperationName, OperationResult, PromotionPlan } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import type { OpenProject } from "../src/index.ts";
import { publishFrameSequence } from "../src/outputs/frames.ts";
import { PROJECT_YAML, agent, createHarness, expectOk, human, initializedGame, makePng, put, type Harness } from "./helpers.ts";

setDefaultTimeout(30_000);

const ASSET = `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager with an exposed brain.
deliverables:
  - id: construction-sheet
    kind: reference-sheet
    description: Front, profile and rear.
    regions:
      - { id: front, x: 0, y: 0, width: 4, height: 8 }
  - id: idle-rest
    kind: pose
    description: Resting guide.
    dependsOn: [construction-sheet]
  - id: walk
    kind: animation
    description: Walk cycle.
    dependsOn: [construction-sheet]
    animation: { motion: walk, loop: true, sourceFps: 16 }
`;

const policy = (over: { promotion?: string; activation?: string } = {}): string =>
  `${PROJECT_YAML}approval:\n  conceptLock: human\n  productionReview: agent_with_escalation\n  promotion: ${over.promotion ?? "human"}\n  activation: ${over.activation ?? "human"}\n`;

const NOW = "2026-10-01T00:00:00.000Z";

interface World {
  h: Harness;
  root: string;
  open: OpenProject;
  branchId: string;
  call<K extends OperationName>(name: K, input: unknown, as?: OperationContext, requestId?: string): Promise<OperationResult<OperationData<K>>>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    delete w.h.runtime.faults;
    await w.h.registry.closeAll();
  }
});

let shade = 10;

/** One candidate with one real PNG output, inserted the way the scheduler would. */
async function seedStill(w: World, id: string, stepId: string, branchId: string | undefined): Promise<void> {
  const { root, open } = w;
  const png = makePng(16, 16, [shade++, 60, 60]);
  const rel = `brainforge/assets/cortex/work/candidates/${id}/original/out.png`;
  await put(root, rel, png);
  open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'cortex', ?, 'p', '{}', 'b', 'human:local', ?)").run(`run_${id}`, stepId, NOW);
  open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'cortex', ?, 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, stepId, `identity-${id}`, NOW, NOW);
  open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, 'cortex', ?, ?, ?, 'A', 'a prompt', 0, ?, ?)").run(id, stepId, `run_${id}`, `job_${id}`, NOW, branchId ?? null);
  open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'matted', ?, ?, ?, 16, 16, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha256(png));
}

/** A processed 4-frame clip for the walk step. */
async function seedClip(w: World, id: string): Promise<void> {
  w.open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'cortex', 'walk', 'p', '{}', 'b', 'human:local', ?)").run(`run_${id}`, NOW);
  w.open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'cortex', 'walk', 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, `identity-${id}`, NOW, NOW);
  await publishFrameSequence(w.open, {
    assetId: "cortex", candidateId: id, actorId: "system", purpose: "test",
    candidate: { candidateId: id, runId: `run_${id}`, jobId: `job_${id}`, branchId: w.branchId, label: "Walk", prompt: "p" },
    outputs: [{
      outputId: `out_${id}`, role: "matted", stage: "processed", sourceFps: 16, playbackFps: 12, totalDurationMs: 333.4,
      frames: Array.from({ length: 4 }, (_, i) => ({ png: makePng(16, 16, [shade++, 90, i]), sourceFrame: i, durationMs: 83.3 })),
    }],
  });
}

async function world(over: { promotion?: string; activation?: string } = {}): Promise<World> {
  const h = createHarness();
  const root = await initializedGame(h);
  await put(root, "brainforge/project.yaml", policy(over));
  await put(root, "brainforge/assets/cortex/asset.yaml", ASSET);
  expectOk(await h.call("project.open", { path: root }));
  const open = h.registry.get(root) as OpenProject;
  const call: World["call"] = (name, input, as, requestId) => h.call(name, input, { project: root, ...(as ? { context: as } : {}), ...(requestId ? { requestId } : {}) });
  expectOk(await call("policy.authorize", { requestedPolicyHash: expectOk(await call("settings.inspect", {})).policy.requestedPolicyHash }));
  const w: World = { h, root, open, branchId: "", call };
  await seedStill(w, "cand_concept", "concept", undefined);
  w.branchId = expectOk(await call("concept.lock", { assetId: "cortex", candidateId: "cand_concept", outputId: "out_cand_concept" })).branch.branchId;
  worlds.push(w);
  return w;
}

async function approve(w: World, candidateId: string, as: OperationContext = human): Promise<void> {
  const m = expectOk(await w.call("review.material", { candidateId }, as));
  expectOk(await w.call("review.decide", { candidateId, outputIds: [`out_${candidateId}`], requirementsHash: m.requirementsHash, decision: "approve", reasons: [] }, as));
}

/** Sheet, idle and walk produced, approved and selected: everything a promotion needs. */
async function complete(over: { promotion?: string; activation?: string } = {}): Promise<World> {
  const w = await world(over);
  await seedStill(w, "cand_sheet", "construction-sheet", w.branchId);
  await seedStill(w, "cand_idle", "idle-rest", w.branchId);
  await seedClip(w, "cand_walk");
  for (const id of ["cand_sheet", "cand_idle", "cand_walk"]) await approve(w, id);
  return w;
}

const plan = async (w: World, as: OperationContext = human): Promise<PromotionPlan> => expectOk(await w.call("promotion.plan", { assetId: "cortex" }, as)).plan;
const start = (w: World, p: PromotionPlan, requestId = "promote-0001", as: OperationContext = human) => w.call("promotion.start", { planId: p.planId, planHash: p.planHash, requestId }, as);
const promote = async (w: World, requestId = "promote-0001", as: OperationContext = human) => expectOk(await start(w, await plan(w, as), requestId, as)).version;
const list = async (w: World) => expectOk(await w.call("version.list", { assetId: "cortex" }));
const activateAt = async (w: World, versionId: string, as: OperationContext = human, extra: Record<string, unknown> = {}) =>
  w.call("version.activate", { versionId, expectedRevision: (await list(w)).active.revision, ...extra }, as);

const codes = (p: PromotionPlan): string[] => p.blockers.map((b) => b.code);
const rows = (w: World, table: string): number => w.open.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
const versionsDir = (w: World): string => join(w.root, "brainforge/assets/cortex/versions");

describe("promotion.plan", () => {
  test("lists every required deliverable ready with its output, approval and no blockers", async () => {
    const w = await complete();
    const p = await plan(w);
    expect(p.blockers).toEqual([]);
    expect(p.nextVersionNumber).toBe(1);
    expect(p.deliverables.map((d) => [d.deliverableId, d.state, d.approval])).toEqual([["construction-sheet", "ready", "approved"], ["idle-rest", "ready", "approved"], ["walk", "ready", "approved"]]);
    expect(p.deliverables.find((d) => d.deliverableId === "walk")).toMatchObject({ candidateId: "cand_walk", outputId: "out_cand_walk" });
    expect(p.capability).toMatchObject({ policy: "human", allowed: true });
    expect(await readdir(versionsDir(w)).catch(() => [])).toEqual([]);
  });

  test("a missing walk blocks the whole bundle, naming it", async () => {
    const w = await world();
    await seedStill(w, "cand_sheet", "construction-sheet", w.branchId);
    await seedStill(w, "cand_idle", "idle-rest", w.branchId);
    await approve(w, "cand_sheet");
    await approve(w, "cand_idle");
    const p = await plan(w);
    expect(codes(p)).toEqual(["DELIVERABLE_MISSING"]);
    expect(p.blockers[0]!.message).toContain("walk");
    const refused = await start(w, p);
    expect(refused.ok === false && refused.error.code).toBe("STEP_BLOCKED");
    expect(rows(w, "asset_versions")).toBe(0);
  });

  test("an unapproved or raw-source animation is not ready", async () => {
    const w = await world();
    await seedStill(w, "cand_sheet", "construction-sheet", w.branchId);
    await approve(w, "cand_sheet");
    await seedStill(w, "cand_idle", "idle-rest", w.branchId);
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "idle-rest", candidateId: "cand_idle" }));
    await seedClip(w, "cand_walk");
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "cand_walk" }));
    const p = await plan(w);
    expect(p.deliverables.filter((d) => d.state === "not-approved").map((d) => d.deliverableId)).toEqual(["idle-rest", "walk"]);
    expect(codes(p)).toEqual(["NOT_APPROVED", "NOT_APPROVED"]);
  });

  test("unresolved required feedback blocks until it is resolved", async () => {
    const w = await complete();
    const note = expectOk(await w.call("annotation.create", { candidateId: "cand_idle", outputId: "out_cand_idle", geometry: { kind: "whole" }, text: "Hands look wrong", requiresRevision: true })).annotation;
    const p = await plan(w);
    expect(codes(p)).toEqual(["REVISION_OPEN"]);
    expect(p.deliverables.find((d) => d.deliverableId === "idle-rest")).toMatchObject({ state: "unresolved-feedback", unresolvedFeedback: 1 });

    const revision = expectOk(await w.call("revision.create", { candidateId: "cand_idle", annotationIds: [note.annotationId], summary: "fix hands" })).revision;
    expectOk(await w.call("revision.waive", { revisionRequestId: revision.revisionRequestId, reason: "accepted as is" }));
    expect(codes(await plan(w))).toEqual([]);
  });

  test("a processed frame changed on disk is BYTES_CHANGED and cannot be published", async () => {
    const w = await complete();
    const p = await plan(w);
    const frame = w.open.db.query<{ path: string }, []>("SELECT path FROM output_frames WHERE output_id = 'out_cand_walk' AND idx = 1").get()!.path;
    await writeFile(join(w.root, frame), makePng(16, 16, [1, 2, 3]));
    const after = await plan(w);
    expect(codes(after)).toEqual(["BYTES_CHANGED"]);
    expect(after.deliverables.find((d) => d.deliverableId === "walk")?.state).toBe("bytes-changed");
    const stale = await start(w, p);
    expect(stale.ok === false && stale.error.code).toBe("REVISION_CONFLICT");
    expect(rows(w, "asset_versions")).toBe(0);
  });

  test("a changed current requirement makes approvals stale and reports the basis mismatch; an old plan is refused", async () => {
    const w = await complete();
    const old = await plan(w);
    await put(w.root, "brainforge/project.yaml", `${policy()}artDirection: Flat colors, warm dark contours, broad folds.\n`);
    const after = await plan(w);
    expect(codes(after)).toContain("STALE_APPROVAL");
    expect(after.blockers.some((b) => b.code === "STEP_BLOCKED" && b.message.includes("requirements-basis-mismatch"))).toBe(true);
    expect(after.deliverables.every((d) => d.state === "stale-approval" || d.state === "blocked-dependency")).toBe(true);
    const refused = await start(w, old);
    expect(refused.ok === false && refused.error.code).toBe("REVISION_CONFLICT");
  });

  test("an asset with no locked concept or two branches needs a branch named", async () => {
    const w = await complete();
    expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: "cand_concept", outputId: "out_cand_concept" }));
    const ambiguous = await w.call("promotion.plan", { assetId: "cortex" });
    expect(ambiguous.ok === false && ambiguous.error.code).toBe("INVALID_INPUT");
    const named = expectOk(await w.call("promotion.plan", { assetId: "cortex", branchId: w.branchId })).plan;
    expect(named.branchId).toBe(w.branchId);
  });
});

describe("promotion.start", () => {
  test("publishes one immutable version with hashed copies, manifest last, nothing active", async () => {
    const w = await complete();
    const version = await promote(w);
    expect(version).toMatchObject({ versionNumber: 1, state: "promoted", matchesCurrent: true, createdByType: "human", deliverableIds: ["construction-sheet", "idle-rest", "walk"] });
    expect(version.directory).toBe(`brainforge/assets/cortex/versions/${version.versionId}`);

    const inspected = expectOk(await w.call("version.inspect", { versionId: version.versionId }));
    expect(inspected.problems).toEqual([]);
    expect(inspected.differences).toEqual([]);
    const manifest = inspected.manifest;
    expect(manifest).toMatchObject({ schema: "brainforge.production.v2", versionNumber: 1, branchId: w.branchId, assetId: "cortex" });
    expect(manifest.deliverables.map((d) => d.deliverableId)).toEqual(["construction-sheet", "idle-rest", "walk"]);
    expect(manifest.references.map((r) => r.role)).toEqual(["concept", "construction-sheet"]);
    const walk = manifest.deliverables.find((d) => d.deliverableId === "walk")!;
    expect(walk.files).toEqual(["frames/0000.png", "frames/0001.png", "frames/0002.png", "frames/0003.png"].map((f) => `files/walk/${f}`));
    for (const f of manifest.files) {
      const abs = join(w.root, version.directory, f.path);
      const bytes = await readFile(abs);
      expect(sha256(bytes)).toBe(f.sha256);
      expect(bytes.byteLength).toBe(f.size);
      expect((await stat(abs)).mode & 0o222).toBe(0);
    }
    expect(sha256(await readFile(join(w.root, version.directory, "manifest.json")))).toBe(version.manifestSha256);
    expect((await list(w)).active).toMatchObject({ versionId: null, revision: 0 });
    expect(await readdir(join(w.root, "brainforge/.state/staging"))).toEqual([]);
  });

  test("the same requestId returns the same version (created=false); a different request with the used plan is refused", async () => {
    const w = await complete();
    const p = await plan(w);
    const first = expectOk(await start(w, p, "promote-0001"));
    const again = expectOk(await start(w, p, "promote-0001"));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, version: { versionId: first.version.versionId } });
    expect(rows(w, "asset_versions")).toBe(1);
    expect(await readdir(versionsDir(w))).toHaveLength(1);

    const other = await start(w, p, "promote-0002");
    expect(other.ok === false && other.error.code).toBe("REVISION_CONFLICT");
    expect(rows(w, "asset_versions")).toBe(1);
  });

  test("a staging failure leaves no half version and the earlier active selection unchanged", async () => {
    const w = await complete();
    const v1 = await promote(w);
    expectOk(await activateAt(w, v1.versionId));
    const before = (await list(w)).active;

    w.h.runtime.faults = { promotion: "fail-before-publish" };
    const failed = await start(w, await plan(w), "promote-0002");
    expect(failed.ok === false && failed.error.code).toBe("IO_ERROR");
    expect(rows(w, "asset_versions")).toBe(1);
    expect(await readdir(versionsDir(w))).toEqual([v1.versionId]);
    expect(await readdir(join(w.root, "brainforge/.state/staging"))).toEqual([]);
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM publication_intents WHERE kind = 'promotion' ORDER BY rowid DESC LIMIT 1").get()?.state).toBe("failed");
    expect((await list(w)).active).toEqual(before);

    delete w.h.runtime.faults;
    const retried = expectOk(await start(w, await plan(w), "promote-0002"));
    expect(retried).toMatchObject({ created: true, version: { versionNumber: 2 } });
    expect((await list(w)).active).toEqual(before);
  });

  test("a crash between rename and commit is finished into a complete version at the next open", async () => {
    const w = await complete();
    w.h.runtime.faults = { promotion: "fail-after-rename-before-commit" };
    const p = await plan(w);
    const failed = await start(w, p, "promote-0001");
    expect(failed.ok === false && failed.error.code).toBe("IO_ERROR");
    expect(rows(w, "asset_versions")).toBe(0);
    expect(await readdir(versionsDir(w))).toHaveLength(1);

    delete w.h.runtime.faults;
    expectOk(await w.call("project.close", {}));
    expectOk(await w.h.call("project.open", { path: w.root }));
    w.open = w.h.registry.get(w.root) as OpenProject;
    const { versions, active } = await list(w);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNumber: 1, state: "promoted", matchesCurrent: true });
    expect(active.versionId).toBeNull();
    expect(expectOk(await w.call("version.inspect", { versionId: versions[0]!.versionId })).problems).toEqual([]);
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM publication_intents WHERE kind = 'promotion'").get()?.state).toBe("committed");

    const again = expectOk(await start(w, p, "promote-0001"));
    expect(again).toMatchObject({ created: false, version: { versionId: versions[0]!.versionId } });
  });

  test("a crash before a verifiable directory exists is rolled back at open", async () => {
    const w = await complete();
    w.h.runtime.faults = { promotion: "fail-after-rename-before-commit" };
    await start(w, await plan(w), "promote-0001");
    const dir = join(versionsDir(w), (await readdir(versionsDir(w)))[0]!);
    await chmod(join(dir, "manifest.json"), 0o644);
    await writeFile(join(dir, "manifest.json"), "{}");

    delete w.h.runtime.faults;
    expectOk(await w.call("project.close", {}));
    expectOk(await w.h.call("project.open", { path: w.root }));
    w.open = w.h.registry.get(w.root) as OpenProject;
    expect(rows(w, "asset_versions")).toBe(0);
    expect(await readdir(versionsDir(w))).toEqual([]);
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM publication_intents WHERE kind = 'promotion'").get()?.state).toBe("failed");
  });

  test("project.snapshot carries the versions directory", async () => {
    const w = await complete();
    const version = await promote(w);
    const destination = join(await mkdtemp(join(tmpdir(), "bf-snap-")), "copy");
    expectOk(await w.call("project.snapshot", { destination }));
    const manifest = await readFile(join(destination, version.directory, "manifest.json"), "utf8");
    expect(sha256(manifest)).toBe(version.manifestSha256);
    expect(await readdir(join(destination, version.directory, "files/walk/frames"))).toHaveLength(4);
  });
});

describe("version.list / version.inspect", () => {
  test("newest first, with state and whether each still matches current requirements", async () => {
    const w = await complete();
    const v1 = await promote(w, "promote-0001");
    expectOk(await activateAt(w, v1.versionId));

    // The walk is regenerated and re-approved; the idle is unchanged.
    await seedClip(w, "cand_walk2");
    await approve(w, "cand_walk2");
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "cand_walk2" }));
    const p2 = await plan(w);
    expect(p2.deliverables.find((d) => d.deliverableId === "idle-rest")?.reusesVersionId).toBe(v1.versionId);
    expect(p2.deliverables.find((d) => d.deliverableId === "walk")?.reusesVersionId).toBeUndefined();
    const v2 = expectOk(await start(w, p2, "promote-0002")).version;

    const { versions, active } = await list(w);
    expect(versions.map((v) => [v.versionNumber, v.state, v.matchesCurrent])).toEqual([[2, "promoted", true], [1, "active", true]]);
    expect(active.versionId).toBe(v1.versionId);

    const inspected = expectOk(await w.call("version.inspect", { versionId: v2.versionId }));
    const idle = inspected.manifest.deliverables.find((d) => d.deliverableId === "idle-rest")!;
    expect(idle).toMatchObject({ candidateId: "cand_idle", reusedFromVersionId: v1.versionId });
    expect(inspected.manifest.deliverables.find((d) => d.deliverableId === "walk")).toMatchObject({ candidateId: "cand_walk2" });
    expect(inspected.manifest.deliverables.find((d) => d.deliverableId === "walk")?.reusedFromVersionId).toBeUndefined();
    // The unchanged deliverable was carried over: no new candidate exists for it.
    expect(w.open.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidates WHERE step_id = 'idle-rest'").get()!.n).toBe(1);
  });

  test("a changed requirement makes a version not match, listing the differing fields; a corrupted file is reported", async () => {
    const w = await complete();
    const v1 = await promote(w);
    await put(w.root, "brainforge/project.yaml", `${policy()}artDirection: Flat colors, warm dark contours, broad folds.\n`);
    const { versions } = await list(w);
    expect(versions[0]!.matchesCurrent).toBe(false);
    const inspected = expectOk(await w.call("version.inspect", { versionId: v1.versionId }));
    expect(inspected.differences.map((d) => d.field)).toEqual(expect.arrayContaining(["requirementsHash", "stepRequirements.concept", "specSnapshots.brainforge/project.yaml"]));

    const target = join(w.root, v1.directory, "files/idle-rest/out.png");
    await chmod(target, 0o644);
    await writeFile(target, makePng(16, 16, [9, 9, 9]));
    const corrupted = expectOk(await w.call("version.inspect", { versionId: v1.versionId }));
    expect(corrupted.problems).toEqual(["files/idle-rest/out.png no longer matches its recorded hash"]);
  });
});

describe("version.activate", () => {
  test("promoting an alternative leaves version 1 active; restore uses the same operation and keeps newer versions", async () => {
    const w = await complete();
    const v1 = await promote(w, "promote-0001");
    const first = expectOk(await activateAt(w, v1.versionId, human, { reason: "first" }));
    expect(first.event).toMatchObject({ kind: "activate", fromVersionId: null, toVersionId: v1.versionId, actorType: "human", acknowledgedObsolete: false });
    expect(first.active).toMatchObject({ versionId: v1.versionId, revision: 1, activatedByType: "human" });

    await seedClip(w, "cand_walk2");
    await approve(w, "cand_walk2");
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "cand_walk2" }));
    const v2 = await promote(w, "promote-0002");
    expect((await list(w)).active).toMatchObject({ versionId: v1.versionId, revision: 1 });
    expect(rows(w, "activation_events")).toBe(1);

    const forward = expectOk(await activateAt(w, v2.versionId));
    expect(forward.event.kind).toBe("activate");
    const back = expectOk(await activateAt(w, v1.versionId));
    expect(back.event).toMatchObject({ kind: "restore", fromVersionId: v2.versionId, toVersionId: v1.versionId });
    const { versions, active } = await list(w);
    expect(versions.map((v) => [v.versionNumber, v.state])).toEqual([[2, "superseded"], [1, "active"]]);
    expect(active).toMatchObject({ versionId: v1.versionId, revision: 3 });
    expect(await readdir(versionsDir(w))).toHaveLength(2);
  });

  test("a stale expectedRevision is refused and changes nothing", async () => {
    const w = await complete();
    const v1 = await promote(w);
    const stale = await w.call("version.activate", { versionId: v1.versionId, expectedRevision: 5 });
    expect(stale.ok === false && stale.error.code).toBe("REVISION_CONFLICT");
    expect((await list(w)).active.versionId).toBeNull();
    expect(rows(w, "activation_events")).toBe(0);
  });

  test("an agent is denied activation under a human policy even where it may promote", async () => {
    const w = await complete({ promotion: "agent", activation: "human" });
    const version = await promote(w, "promote-0001", agent);
    expect(version.createdByType).toBe("agent");
    const denied = await activateAt(w, version.versionId, agent);
    expect(denied.ok === false && denied.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect((await list(w)).active.versionId).toBeNull();

    // A relaxation in project.yaml is only a request until a human confirms exactly that change.
    await put(w.root, "brainforge/project.yaml", policy({ promotion: "agent", activation: "agent" }));
    const pending = await activateAt(w, version.versionId, agent);
    expect(pending.ok === false && pending.error.code).toBe("POLICY_PENDING");
    const settings = expectOk(await w.call("settings.inspect", {}));
    expect(settings.policy.diff.map((d) => d.field)).toEqual(["activation"]);
    expectOk(await w.call("policy.authorize", { requestedPolicyHash: settings.policy.requestedPolicyHash }));

    const done = expectOk(await activateAt(w, version.versionId, agent));
    expect(done.event).toMatchObject({ actorId: agent.actorId, actorType: "agent", kind: "activate" });
    expect(done.active).toMatchObject({ versionId: version.versionId, activatedBy: agent.actorId, activatedByType: "agent" });
    expect(expectOk(await w.call("version.inspect", { versionId: version.versionId })).activations[0]).toMatchObject({ actorType: "agent" });
  });

  test("a promotion denied to an agent under a human policy creates nothing", async () => {
    const w = await complete();
    const p = await plan(w, agent);
    expect(p.capability).toMatchObject({ policy: "human", allowed: false });
    const denied = await start(w, p, "promote-0001", agent);
    expect(denied.ok === false && denied.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(rows(w, "asset_versions")).toBe(0);
  });

  test("an obsolete version needs acknowledgement, and only a person can give it unless policy hands activation to agents", async () => {
    const w = await complete();
    const v1 = await promote(w);
    await put(w.root, "brainforge/project.yaml", `${policy()}artDirection: Flat colors, warm dark contours, broad folds.\n`);
    const refused = await activateAt(w, v1.versionId);
    expect(refused.ok === false && refused.error.code).toBe("STEP_BLOCKED");
    expect(refused.ok === false && JSON.stringify(refused.error.details)).toContain("stepRequirements.concept");

    const agentAck = await activateAt(w, v1.versionId, agent, { acknowledgeObsolete: true });
    expect(agentAck.ok === false && agentAck.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");

    const done = expectOk(await activateAt(w, v1.versionId, human, { acknowledgeObsolete: true }));
    expect(done.active.acknowledgedObsolete).toBe(true);
    expect(done.event.acknowledgedObsolete).toBe(true);
    expect((await list(w)).versions[0]).toMatchObject({ state: "active", matchesCurrent: false });
  });

  test("a version whose files changed cannot be activated", async () => {
    const w = await complete();
    const v1 = await promote(w);
    const target = join(w.root, v1.directory, "files/idle-rest/out.png");
    await chmod(target, 0o644);
    await writeFile(target, makePng(16, 16, [9, 9, 9]));
    const refused = await activateAt(w, v1.versionId);
    expect(refused.ok === false && refused.error.code).toBe("OUTPUT_MISSING");
    expect((await list(w)).active.versionId).toBeNull();
  });
});

describe("a still approved in processed form", () => {
  test("a freshly promoted version matches current requirements and can be activated without acknowledgement", async () => {
    const w = await world();
    await seedStill(w, "cand_sheet", "construction-sheet", w.branchId);
    w.open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES ('run_idle', 'cortex', 'idle-rest', 'p', '{}', 'b', 'human:local', ?)").run(NOW);
    w.open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES ('job_idle', 'run_idle', 'cortex', 'idle-rest', 0, 'A', 'identity-idle', 'succeeded', '{}', ?, ?)").run(NOW, NOW);
    await publishFrameSequence(w.open, {
      assetId: "cortex", candidateId: "cand_idle", actorId: "system", purpose: "test",
      candidate: { candidateId: "cand_idle", runId: "run_idle", jobId: "job_idle", branchId: w.branchId, label: "Idle", prompt: "p" },
      outputs: [{ outputId: "out_cand_idle", role: "matted", stage: "processed", sourceFps: 1, playbackFps: 1, totalDurationMs: 1000, frames: [{ png: makePng(16, 16, [shade++, 40, 40]), sourceFrame: 0, durationMs: 1000 }] }],
    });
    await seedClip(w, "cand_walk");
    for (const id of ["cand_sheet", "cand_idle", "cand_walk"]) await approve(w, id);
    const version = await promote(w);
    expect(version.matchesCurrent).toBe(true);
    expectOk(await activateAt(w, version.versionId));
  });
});
