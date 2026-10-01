import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeImage } from "@brainforge/media";
import { sha256 } from "@brainforge/storage";
import { ASSET_YAML, PROJECT_YAML, agent, createHarness, expectOk, initializedGame, makePng, put } from "./helpers.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

const PLAN = (specHashes: Record<string, string>): string => JSON.stringify({
  workflow: { id: "krea2-still", version: 1, graphHash: "g".repeat(64) },
  inputs: { specHashes, references: [] },
  iterationInstructions: "warmer",
});

interface Seed { root: string; candidateId: string; outputId: string; outputHash: string }

/** A project with a valid asset and one candidate (one real PNG output) inserted the way the scheduler would. */
async function seeded(): Promise<Seed> {
  const root = await initializedGame(h);
  await put(root, "brainforge/assets/cortex/asset.yaml", ASSET_YAML);
  expectOk(await h.call("project.open", { path: root }));
  const db = h.registry.get(root)!.db;
  const png = makePng(200, 100, [180, 60, 60]);
  const rel = "brainforge/assets/cortex/work/candidates/cand_1/original/out_1.png";
  await put(root, rel, png);
  const hashes = { "brainforge/project.yaml": sha256(PROJECT_YAML), "brainforge/assets/cortex/asset.yaml": sha256(ASSET_YAML) };
  const now = new Date().toISOString();
  db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES ('run_1','cortex','concept','p','" + PLAN(hashes).replaceAll("'", "''") + "','b','human:local',?)").run(now);
  db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES ('job_1','run_1','cortex','concept',0,'A','id1','succeeded','{}',?,?)").run(now, now);
  db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, parent_candidate_id, label, seed, prompt, favorite, created_at) VALUES ('cand_1','cortex','concept','run_1','job_1',NULL,'A',7,'a prompt',0,?)").run(now);
  db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES ('out_1','cand_1','matted','out_1',?,?,200,100,'image/png')").run(rel, sha256(png));
  return { root, candidateId: "cand_1", outputId: "out_1", outputHash: sha256(png) };
}

const pin = { kind: "pin", x: 0.5, y: 0.5 } as const;

async function note(s: Seed, over: Record<string, unknown> = {}) {
  return expectOk(await h.call("annotation.create", { candidateId: s.candidateId, outputId: s.outputId, geometry: pin, text: "too pink", requiresRevision: true, ...over }, { project: s.root })).annotation;
}

describe("annotations", () => {
  test("anchor to the output hash and size; list and soft delete keep audit history", async () => {
    const s = await seeded();
    const a = await note(s);
    expect(a).toMatchObject({ outputHash: s.outputHash, imageWidth: 200, imageHeight: 100, version: 1, deleted: false });
    const updated = expectOk(await h.call("annotation.update", { annotationId: a.annotationId, expectedVersion: 1, text: "less pink" }, { project: s.root })).annotation;
    expect(updated).toMatchObject({ version: 2, text: "less pink", outputHash: s.outputHash });
    expectOk(await h.call("annotation.delete", { annotationId: a.annotationId, expectedVersion: 2 }, { project: s.root }));
    expect(expectOk(await h.call("annotation.list", { candidateId: s.candidateId }, { project: s.root })).annotations).toEqual([]);
    expect(expectOk(await h.call("annotation.list", { candidateId: s.candidateId, includeDeleted: true }, { project: s.root })).annotations[0]).toMatchObject({ deleted: true, version: 3 });
    const history = h.registry.get(s.root)!.db.query<{ version: number }, [string]>("SELECT version FROM annotation_history WHERE annotation_id = ? ORDER BY id").all(a.annotationId);
    expect(history.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  test("a stale expectedVersion is a REVISION_CONFLICT carrying the current note", async () => {
    const s = await seeded();
    const a = await note(s);
    expectOk(await h.call("annotation.update", { annotationId: a.annotationId, expectedVersion: 1, text: "mine" }, { project: s.root }));
    const r = await h.call("annotation.update", { annotationId: a.annotationId, expectedVersion: 1, text: "theirs" }, { project: s.root });
    if (r.ok) throw new Error("expected conflict");
    expect(r.error.code).toBe("REVISION_CONFLICT");
    expect(r.error.details).toMatchObject({ currentVersion: 2, current: { text: "mine" } });
    const del = await h.call("annotation.delete", { annotationId: a.annotationId, expectedVersion: 1 }, { project: s.root });
    expect(del.ok).toBe(false);
  });

  test("rejects rectangles outside the image or empty, and outputs of another candidate", async () => {
    const s = await seeded();
    for (const geometry of [{ kind: "rect", x: 0.6, y: 0.1, width: 0.5, height: 0.2 }, { kind: "rect", x: 0.1, y: 0.1, width: 0, height: 0.2 }]) {
      const r = await h.call("annotation.create", { candidateId: s.candidateId, outputId: s.outputId, geometry, text: "x" }, { project: s.root });
      if (r.ok) throw new Error("expected invalid");
      expect(r.error.code).toBe("INVALID_INPUT");
    }
    const edge = await h.call("annotation.create", { candidateId: s.candidateId, outputId: s.outputId, geometry: { kind: "rect", x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, text: "ok" }, { project: s.root });
    expect(edge.ok).toBe(true);
    const wrong = await h.call("annotation.create", { candidateId: s.candidateId, outputId: "nope", geometry: pin, text: "x" }, { project: s.root });
    if (wrong.ok) throw new Error("expected not found");
    expect(wrong.error.code).toBe("NOT_FOUND");
    const upd = await h.call("annotation.update", { annotationId: (await note(s)).annotationId, expectedVersion: 1, geometry: { kind: "rect", x: 0.9, y: 0.9, width: 0.5, height: 0.5 } }, { project: s.root });
    expect(upd.ok).toBe(false);
  });

  test("frame notes are anchored to source frames: the range survives edits and must lie within the played source frames; stills refuse it", async () => {
    const s = await seeded();
    const still = await h.call("annotation.create", { candidateId: s.candidateId, outputId: s.outputId, geometry: pin, frameRange: { start: 0, end: 0 }, text: "x" }, { project: s.root });
    if (still.ok) throw new Error("a still image cannot take a frame range");
    expect(still.error.code).toBe("INVALID_INPUT");

    // A processed clip of 3 frames that plays source frames 0, 2 and 4 (resampled from a longer source).
    const db = h.registry.get(s.root)!.db;
    db.query("UPDATE candidate_outputs SET media_kind = 'frames', stage = 'processed', frame_count = 3 WHERE output_id = ?").run(s.outputId);
    [0, 2, 4].forEach((source, idx) => db.query("INSERT INTO output_frames (output_id, idx, file_id, path, sha256, width, height, source_frame, duration_ms) VALUES (?, ?, ?, 'p', ?, 200, 100, ?, 83.3)").run(s.outputId, idx, `f${idx}`, "a".repeat(64), source));

    const a = (await note(s, { frameRange: { start: 2, end: 4 } }));
    expect(a.frameRange).toEqual({ start: 2, end: 4 });
    expect(a.geometry).toEqual(pin);
    const moved = expectOk(await h.call("annotation.update", { annotationId: a.annotationId, expectedVersion: 1, text: "later" }, { project: s.root })).annotation;
    expect(moved.frameRange).toEqual({ start: 2, end: 4 });
    const past = await h.call("annotation.create", { candidateId: s.candidateId, outputId: s.outputId, geometry: pin, frameRange: { start: 4, end: 5 }, text: "x" }, { project: s.root });
    if (past.ok) throw new Error("source frame 5 is never played");
    expect(past.error.code).toBe("INVALID_INPUT");
    const backwards = await h.call("annotation.create", { candidateId: s.candidateId, outputId: s.outputId, geometry: pin, frameRange: { start: 3, end: 1 }, text: "x" }, { project: s.root });
    expect(backwards.ok).toBe(false);
  });
});

describe("candidates", () => {
  test("inspect returns prompt inputs, visuals, annotations; favorite is independent state", async () => {
    const s = await seeded();
    await note(s);
    expect(expectOk(await h.call("candidate.favorite", { candidateId: s.candidateId, favorite: true }, { project: s.root })).candidate.favorite).toBe(true);
    const data = expectOk(await h.call("candidate.inspect", { candidateId: s.candidateId }, { project: s.root }));
    expect(data.candidate).toMatchObject({ prompt: "a prompt", favorite: true, annotationCount: 1 });
    expect(data.run).toMatchObject({ workflowId: "krea2-still", iterationInstructions: "warmer" });
    expect(data.visuals).toEqual([expect.objectContaining({ fileId: "out_1", role: "matted", width: 200, height: 100 })]);
    expect(expectOk(await h.call("candidate.list", { assetId: "cortex", favoriteOnly: true }, { project: s.root })).candidates).toHaveLength(1);
    expect(expectOk(await h.call("candidate.list", { assetId: "cortex", parentCandidateId: "other" }, { project: s.root })).candidates).toHaveLength(0);
  });
});

describe("revisions", () => {
  async function revision(s: Seed) {
    const a = await note(s);
    return { a, rev: expectOk(await h.call("revision.create", { candidateId: s.candidateId, annotationIds: [a.annotationId], summary: "fix colour" }, { project: s.root })) };
  }

  test("create renders annotated PNGs to the review directory and inspect hands over everything", async () => {
    const s = await seeded();
    const { a, rev } = await revision(s);
    expect(rev.revision).toMatchObject({ status: "open", waitingFor: "external-agent", annotationIds: [a.annotationId], outputIds: ["out_1"] });
    expect(rev.visuals).toHaveLength(1);
    const rendered = await readFile(join(s.root, `brainforge/assets/cortex/work/reviews/${rev.revision.revisionRequestId}/annotated-1.png`));
    expect(await decodeImage(rendered)).toMatchObject({ width: 200, height: 100 });

    const info = expectOk(await h.call("revision.inspect", { revisionRequestId: rev.revision.revisionRequestId }, { project: s.root, context: agent }));
    expect(info.prompt).toBe("a prompt");
    expect(info.annotations[0]).toMatchObject({ text: "too pink", outputHash: s.outputHash });
    expect(info.visuals.map((v) => v.role).sort()).toEqual(["annotated", "matted"]);
    expect(info.specs.projectYaml).toBe(PROJECT_YAML);
    expect(info.specs.assetYaml).toBe(ASSET_YAML);
    expect(info.specs.hashes["brainforge/project.yaml"]).toBe(sha256(PROJECT_YAML));
  });

  test("rejects notes of another candidate, deleted notes, and unknown notes", async () => {
    const s = await seeded();
    const a = await note(s);
    expectOk(await h.call("annotation.delete", { annotationId: a.annotationId, expectedVersion: 1 }, { project: s.root }));
    const gone = await h.call("revision.create", { candidateId: s.candidateId, annotationIds: [a.annotationId], summary: "x" }, { project: s.root });
    expect(gone.ok).toBe(false);
    const missing = await h.call("revision.create", { candidateId: s.candidateId, annotationIds: ["ann_missing"], summary: "x" }, { project: s.root });
    if (missing.ok) throw new Error("expected not found");
    expect(missing.error.code).toBe("NOT_FOUND");
  });

  test("a response moves the wait to the reviewer but never resolves; agents cannot resolve under the default policy", async () => {
    const s = await seeded();
    const { rev } = await revision(s);
    const id = rev.revision.revisionRequestId;
    const responded = expectOk(await h.call("revision.respond", { revisionRequestId: id, text: "made it cooler", kind: "followup", followUpJobIds: ["job_9"] }, { project: s.root, context: agent })).revision;
    expect(responded).toMatchObject({ status: "responded", waitingFor: "reviewer", responses: [{ actorType: "agent", kind: "followup", followUpJobIds: ["job_9"] }] });
    expect(expectOk(await h.call("revision.list", { status: "open" }, { project: s.root })).revisions).toHaveLength(0);

    for (const [op, input] of [["revision.resolve", {}], ["revision.waive", { reason: "fine" }]] as const) {
      const r = await h.call(op, { revisionRequestId: id, ...input }, { project: s.root, context: agent });
      if (r.ok) throw new Error("agent must be refused");
      expect(r.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    }
    expect(expectOk(await h.call("revision.inspect", { revisionRequestId: id }, { project: s.root })).revision.status).toBe("responded");

    const resolved = expectOk(await h.call("revision.resolve", { revisionRequestId: id, reason: "looks right" }, { project: s.root })).revision;
    expect(resolved).toMatchObject({ status: "resolved", waitingFor: null, resolvedBy: "human:local", resolutionReason: "looks right" });
    const again = await h.call("revision.respond", { revisionRequestId: id, text: "late" }, { project: s.root, context: agent });
    if (again.ok) throw new Error("terminal request must refuse responses");
    expect(again.error.code).toBe("REVISION_CONFLICT");
    expect((await h.call("revision.waive", { revisionRequestId: id, reason: "x" }, { project: s.root })).ok).toBe(false);
  });

  test("waive needs a reason and ends the request", async () => {
    const s = await seeded();
    const { rev } = await revision(s);
    const id = rev.revision.revisionRequestId;
    expect((await h.call("revision.waive", { revisionRequestId: id, reason: "   " }, { project: s.root })).ok).toBe(false);
    expect(expectOk(await h.call("revision.waive", { revisionRequestId: id, reason: "not needed" }, { project: s.root })).revision.status).toBe("waived");
  });

  test("an unconfirmed relaxation does not let agents resolve (POLICY_PENDING); a confirmed one does", async () => {
    const s = await seeded();
    const { rev } = await revision(s);
    const id = rev.revision.revisionRequestId;
    await put(s.root, "brainforge/project.yaml", `${PROJECT_YAML}approval:\n  conceptLock: agent\n`);
    const pending = await h.call("revision.resolve", { revisionRequestId: id }, { project: s.root, context: agent });
    if (pending.ok) throw new Error("expected refusal");
    expect(pending.error.code).toBe("POLICY_PENDING");
    const settings = expectOk(await h.call("settings.inspect", {}, { project: s.root }));
    expectOk(await h.call("policy.authorize", { requestedPolicyHash: settings.policy.requestedPolicyHash }, { project: s.root }));
    expect(expectOk(await h.call("revision.resolve", { revisionRequestId: id }, { project: s.root, context: agent })).revision).toMatchObject({ status: "resolved", resolvedBy: "agent:local" });
  });
});

describe("step.inspect", () => {
  test("blocked without an asset definition, ready with one, awaiting_review with candidates, running with active jobs", async () => {
    const root = await initializedGame(h);
    await put(root, "brainforge/assets/cortex/work/.keep", "");
    expectOk(await h.call("project.open", { path: root }));
    const blocked = expectOk(await h.call("step.inspect", { assetId: "cortex" }, { project: root })).step;
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockers[0]?.message).toContain("asset.yaml");

    const missing = await h.call("step.inspect", { assetId: "nobody" }, { project: root });
    if (missing.ok) throw new Error("expected not found");
    expect(missing.error.code).toBe("NOT_FOUND");

    await put(root, "brainforge/assets/cortex/asset.yaml", ASSET_YAML);
    const ready = expectOk(await h.call("step.inspect", { assetId: "cortex" }, { project: root })).step;
    expect(ready.state).toBe("ready");
    expect(ready.nextActions[0]).toMatchObject({ operation: "generation.plan" });
  });

  test("candidate and job counts drive the state; required notes stay actionable until their revision is closed", async () => {
    const s = await seeded();
    const step = async () => expectOk(await h.call("step.inspect", { assetId: "cortex" }, { project: s.root })).step;
    const first = await step();
    expect(first).toMatchObject({ state: "awaiting_review", needsReassessment: false, counts: { candidates: 1, favorites: 0 } });

    const a = await note(s);
    expect((await step()).nextActions.some((n) => n.operation === "revision.create")).toBe(true);
    const rev = expectOk(await h.call("revision.create", { candidateId: s.candidateId, annotationIds: [a.annotationId], summary: "s" }, { project: s.root })).revision;
    const open = await step();
    expect(open.counts.openRevisions).toBe(1);
    expect(open.nextActions.some((n) => n.operation === "revision.create")).toBe(true);
    expectOk(await h.call("revision.resolve", { revisionRequestId: rev.revisionRequestId }, { project: s.root }));
    const closed = await step();
    expect(closed.counts.openRevisions).toBe(0);
    expect(closed.nextActions.some((n) => n.operation === "revision.create")).toBe(false);
    // Editing the note afterwards makes it an unaddressed required note again.
    expectOk(await h.call("annotation.update", { annotationId: a.annotationId, expectedVersion: 1, text: "still wrong" }, { project: s.root }));
    expect((await step()).nextActions.some((n) => n.operation === "revision.create")).toBe(true);

    const now = new Date().toISOString();
    h.registry.get(s.root)!.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES ('job_2','run_1','cortex','concept',1,'B','id2','running','{}',?,?)").run(now, now);
    expect((await step())).toMatchObject({ state: "running", counts: { activeJobs: 1 } });
    h.registry.get(s.root)!.db.query("UPDATE generation_jobs SET state = 'unresolved' WHERE job_id = 'job_2'").run();
    const unresolved = await step();
    expect(unresolved.blockers.map((b) => b.code)).toContain("SUBMISSION_UNRESOLVED");
    expect(unresolved.counts.unresolvedJobs).toBe(1);
  });

  test("changing an authored file after generation flags reassessment with the file named", async () => {
    const s = await seeded();
    await put(s.root, "brainforge/assets/cortex/asset.yaml", `${ASSET_YAML}identity:\n  skin: coral\n`);
    const step = expectOk(await h.call("step.inspect", { assetId: "cortex" }, { project: s.root })).step;
    expect(step.needsReassessment).toBe(true);
    expect(step.reassessmentReasons).toEqual([expect.stringContaining("brainforge/assets/cortex/asset.yaml")]);
    expect(step.state).toBe("awaiting_review");
  });
});
