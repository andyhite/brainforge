import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeImage } from "@brainforge/media";
import { sha256 } from "@brainforge/storage";
import { publishFrameSequence } from "../src/outputs/frames.ts";
import { createHarness, expectOk, makePng } from "./helpers.ts";
import { human, historyGame, judge, seedCandidate, type HistoryGame } from "./history-fixture.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

const pin = { kind: "pin", x: 0.25, y: 0.25 } as const;

async function locked(): Promise<{ g: HistoryGame; branchId: string }> {
  const g = await historyGame(h);
  await seedCandidate(g, "k0", "cortex", "concept");
  const { branch } = expectOk(await h.call("concept.lock", { assetId: "cortex", candidateId: "k0", outputId: "out_k0" }, { project: g.root }));
  return { g, branchId: branch.branchId };
}

describe("required feedback outlives newer candidates", () => {
  test("a required note on candidate A keeps the step (and its dependents) blocked after candidate B is approved, until resolved", async () => {
    const { g, branchId } = await locked();
    await seedCandidate(g, "a", "cortex", "portrait", undefined, branchId);
    const note = expectOk(await h.call("annotation.create", { candidateId: "a", outputId: "out_a", geometry: pin, text: "hands are wrong", requiresRevision: true }, { project: g.root })).annotation;
    const rev = expectOk(await h.call("revision.create", { candidateId: "a", annotationIds: [note.annotationId], summary: "fix the hands" }, { project: g.root })).revision;

    // a newer candidate B is generated, approved by the human and selected
    await seedCandidate(g, "b", "cortex", "portrait", undefined, branchId);
    await judge(g, "b", "approve", human);
    expectOk(await h.call("candidate.select", { branchId, deliverableId: "portrait", candidateId: "b" }, { project: g.root }));

    const step = async (stepId: string) => expectOk(await h.call("step.inspect", { assetId: "cortex", stepId, branchId }, { project: g.root })).step;
    const portrait = await step("portrait");
    expect(portrait.state).not.toBe("complete");
    expect(portrait.blockers.map((b) => b.code)).toContain("REVISION_OPEN");
    expect(portrait.blockers.find((b) => b.code === "REVISION_OPEN")!.recoveryActions[0]).toMatchObject({ operation: "revision.inspect", input: { revisionRequestId: rev.revisionRequestId } });
    const walk = await step("walk");
    expect(walk.state).toBe("blocked");
    expect(walk.blockers.find((b) => b.code === "DEPENDENCY_NOT_APPROVED")!.message).toContain("unresolved required feedback");

    // a response is not a resolution
    expectOk(await h.call("revision.respond", { revisionRequestId: rev.revisionRequestId, text: "regenerated as B", kind: "followup" }, { project: g.root, context: { actorId: "agent:local", actorType: "agent" } }));
    expect((await step("portrait")).state).not.toBe("complete");

    expectOk(await h.call("revision.resolve", { revisionRequestId: rev.revisionRequestId, reason: "B fixed the hands" }, { project: g.root }));
    const done = await step("portrait");
    expect(done.state).toBe("complete");
    expect(done.blockers.map((b) => b.code)).not.toContain("REVISION_OPEN");
    expect((await step("walk")).blockers).toEqual([]);
  });

  test("an open note on another step never shows up as a blocker of the concept step", async () => {
    const { g, branchId } = await locked();
    await seedCandidate(g, "a", "cortex", "portrait", undefined, branchId);
    const note = expectOk(await h.call("annotation.create", { candidateId: "a", outputId: "out_a", geometry: pin, text: "hands", requiresRevision: true }, { project: g.root })).annotation;
    expectOk(await h.call("revision.create", { candidateId: "a", annotationIds: [note.annotationId], summary: "s" }, { project: g.root }));
    const concept = expectOk(await h.call("step.inspect", { assetId: "cortex", stepId: "concept", branchId }, { project: g.root })).step;
    expect(concept.blockers.map((b) => b.code)).not.toContain("REVISION_OPEN");
    const portrait = expectOk(await h.call("step.inspect", { assetId: "cortex", stepId: "portrait", branchId }, { project: g.root })).step;
    expect(portrait.blockers.map((b) => b.code)).toContain("REVISION_OPEN");
  });

  test("a waived note is released too; a note edited after resolution blocks again", async () => {
    const { g, branchId } = await locked();
    await seedCandidate(g, "a", "cortex", "portrait", undefined, branchId);
    const note = expectOk(await h.call("annotation.create", { candidateId: "a", outputId: "out_a", geometry: pin, text: "off model", requiresRevision: true }, { project: g.root })).annotation;
    const step = async () => expectOk(await h.call("step.inspect", { assetId: "cortex", stepId: "portrait", branchId }, { project: g.root })).step;
    expect((await step()).blockers.map((b) => b.code)).toContain("REVISION_OPEN");
    const rev = expectOk(await h.call("revision.create", { candidateId: "a", annotationIds: [note.annotationId], summary: "s" }, { project: g.root })).revision;
    expectOk(await h.call("revision.waive", { revisionRequestId: rev.revisionRequestId, reason: "intended" }, { project: g.root }));
    expect((await step()).blockers.map((b) => b.code)).not.toContain("REVISION_OPEN");
    expectOk(await h.call("annotation.update", { annotationId: note.annotationId, expectedVersion: 1, text: "still off model" }, { project: g.root }));
    expect((await step()).blockers.map((b) => b.code)).toContain("REVISION_OPEN");
  });
});

describe("frame-range revision loop", () => {
  async function framesCandidate() {
    const { g, branchId } = await locked();
    await seedCandidate(g, "m1", "cortex", "walk", undefined, branchId);
    const open = g.h.registry.getOpen(g.root)!;
    const frames = Array.from({ length: 6 }, (_, i) => ({ png: makePng(32, 24, [20 + i * 30, 90, 90]), sourceFrame: i, durationMs: 62.5 }));
    await publishFrameSequence(open, {
      assetId: "cortex", candidateId: "m1", actorId: "test", purpose: "test",
      outputs: [{ outputId: "out_m1_frames", role: "matted", stage: "source", frames, sourceFps: 16 }],
    });
    return { g, frames };
  }

  test("a note on a frame range renders annotated frames; revision.inspect shows originals and annotated visuals together", async () => {
    const { g, frames } = await framesCandidate();
    const note = expectOk(await h.call("annotation.create", { candidateId: "m1", outputId: "out_m1_frames", geometry: { kind: "rect", x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, frameRange: { start: 2, end: 4 }, text: "foot slides", requiresRevision: true }, { project: g.root })).annotation;
    const created = expectOk(await h.call("revision.create", { candidateId: "m1", annotationIds: [note.annotationId], summary: "foot slides in frames 3-5" }, { project: g.root }));
    expect(created.revision.outputIds).toEqual(["out_m1_frames"]);
    expect(created.revision.stepId).toBe("walk"); // the candidate's own step, not a hardcoded "concept"
    expect(created.visuals.map((v) => v.label)).toEqual(["Annotated render of out_m1_frames, frame 3", "Annotated render of out_m1_frames, frame 5"]);

    const dir = `brainforge/assets/cortex/work/reviews/${created.revision.revisionRequestId}`;
    for (const [file, index] of [["annotated-01-frame-0003.png", 2], ["annotated-02-frame-0005.png", 4]] as const) {
      const bytes = await readFile(join(g.root, dir, file));
      expect(await decodeImage(bytes)).toMatchObject({ width: 32, height: 24 });
      expect(sha256(bytes)).not.toBe(sha256(frames[index]!.png)); // the note is drawn on it
    }

    const inspected = expectOk(await h.call("revision.inspect", { revisionRequestId: created.revision.revisionRequestId }, { project: g.root, context: { actorId: "agent:local", actorType: "agent" } }));
    expect(inspected.visuals.map((v) => v.role)).toEqual(["frame", "frame", "contact-sheet", "annotated", "annotated"]);
    expect(inspected.annotations[0]).toMatchObject({ frameRange: { start: 2, end: 4 } });
    // every visual is registered for the files route
    const db = g.h.registry.get(g.root)!.db;
    for (const v of inspected.visuals.filter((x) => x.role === "annotated")) {
      expect(db.query("SELECT 1 FROM review_files WHERE file_id = ?").get(v.fileId)).not.toBeNull();
    }
  });

  test("a single-frame range renders one frame carrying only the notes that cover it", async () => {
    const { g } = await framesCandidate();
    const first = expectOk(await h.call("annotation.create", { candidateId: "m1", outputId: "out_m1_frames", geometry: pin, frameRange: { start: 1, end: 1 }, text: "pop", requiresRevision: true }, { project: g.root })).annotation;
    const second = expectOk(await h.call("annotation.create", { candidateId: "m1", outputId: "out_m1_frames", geometry: pin, frameRange: { start: 3, end: 4 }, text: "drift", requiresRevision: true }, { project: g.root })).annotation;
    const created = expectOk(await h.call("revision.create", { candidateId: "m1", annotationIds: [first.annotationId, second.annotationId], summary: "two issues" }, { project: g.root }));
    expect(created.visuals.map((v) => v.label.split(", ").at(-1))).toEqual(["frame 2", "frame 4", "frame 5"]);
  });

  test("a frame that no longer matches its recorded hash is OUTPUT_MISSING, not a silent partial render", async () => {
    const { g } = await framesCandidate();
    const note = expectOk(await h.call("annotation.create", { candidateId: "m1", outputId: "out_m1_frames", geometry: pin, frameRange: { start: 0, end: 1 }, text: "x", requiresRevision: true }, { project: g.root })).annotation;
    const db = g.h.registry.get(g.root)!.db;
    const path = db.query<{ path: string }, []>("SELECT path FROM output_frames WHERE output_id = 'out_m1_frames' AND idx = 0").get()!.path;
    await Bun.write(join(g.root, path), makePng(32, 24, [1, 2, 3]));
    const r = await h.call("revision.create", { candidateId: "m1", annotationIds: [note.annotationId], summary: "x" }, { project: g.root });
    expect(r.ok === false && r.error.code).toBe("OUTPUT_MISSING");
  });
});

describe("review.list", () => {
  test("filters, offset and total: needs-revision, overridden, decided, escalated, awaiting", async () => {
    const { g, branchId } = await locked();
    const ids = ["r1", "r2", "r3", "r4", "r5"];
    for (const id of ids) await seedCandidate(g, id, "cortex", "portrait", undefined, branchId);
    const agentCtx = { actorId: "agent:local", actorType: "agent" } as const;
    await judge(g, "r1", "approve", human);                        // decided
    // A real candidate also carries its untouched decode, which nobody reviews: it must not keep r1 "awaiting".
    g.h.registry.get(g.root)!.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) SELECT 'out_r1_untouched', candidate_id, 'untouched', 'out_r1_untouched', path, sha256, width, height, media_type FROM candidate_outputs WHERE output_id = 'out_r1'").run();
    await judge(g, "r2", "reject", agentCtx);                      // overridden below
    await judge(g, "r2", "approve", human, true);
    const note = expectOk(await h.call("annotation.create", { candidateId: "r3", outputId: "out_r3", geometry: pin, text: "n", requiresRevision: true }, { project: g.root })).annotation;
    expect(note.requiresRevision).toBe(true);                       // needs-revision (undecided too)
    expectOk(await h.call("review.escalate", { candidateId: "r4", outputIds: ["out_r4"], reason: "unsure" }, { project: g.root, context: agentCtx }));
    // r5 stays undecided

    const list = async (filter: string, extra: Record<string, unknown> = {}) => expectOk(await h.call("review.list", { filter, ...extra }, { project: g.root }));
    const idsOf = (r: { items: { candidate: { candidateId: string } }[] }) => r.items.map((i) => i.candidate.candidateId);

    expect(idsOf(await list("decided"))).toEqual(["r2", "r1"]);
    expect(idsOf(await list("overridden"))).toEqual(["r2"]);
    expect((await list("overridden")).items[0]!.kind).toBe("overridden");
    expect(idsOf(await list("needs-revision"))).toEqual(["r3"]);
    expect(idsOf(await list("escalated"))).toEqual(["r4"]);
    // r1 is approved and selected for the step, so the undecided r5 and r3 are superseded old attempts; escalated r4 still waits for a human.
    expect(idsOf(await list("awaiting"))).toEqual(["r4"]);
    const all = await list("all");
    expect(all.total).toBe(5);
    expect(all.items.map((i) => [i.candidate.candidateId, i.kind])).toEqual([["r5", "decided"], ["r4", "escalated"], ["r3", "needs-revision"], ["r2", "overridden"], ["r1", "decided"]]);

    const page = await list("all", { limit: 2, offset: 1 });
    expect(idsOf(page)).toEqual(["r4", "r3"]);
    expect(page.total).toBe(5);
    expect(idsOf(await list("all", { stepId: "walk" }))).toEqual([]);
    expect((await list("all", { assetId: "marcus" })).total).toBe(0);
  });

  test("a candidate is awaiting until a different candidate of its step is selected and approved", async () => {
    const { g, branchId } = await locked();
    await seedCandidate(g, "old", "cortex", "portrait", undefined, branchId);
    await seedCandidate(g, "new", "cortex", "portrait", undefined, branchId);
    const awaiting = async () => expectOk(await h.call("review.list", { filter: "awaiting" }, { project: g.root })).items.map((i) => i.candidate.candidateId);
    expect((await awaiting()).sort()).toEqual(["new", "old"]);
    await judge(g, "new", "approve", human);
    expectOk(await h.call("candidate.select", { branchId, deliverableId: "portrait", candidateId: "new" }, { project: g.root }));
    expect(await awaiting()).toEqual([]);
    expect(expectOk(await h.call("review.list", { filter: "all" }, { project: g.root })).total).toBe(2);
  });
});
