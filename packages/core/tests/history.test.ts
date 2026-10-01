import { afterAll, describe, expect, test } from "bun:test";
import { createHarness, expectOk } from "./helpers.ts";
import { agent, historyGame, human, judge, seedCandidate, type HistoryGame } from "./history-fixture.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

/**
 * Rank order expected for asset cortex / step portrait:
 *  asset tier:        c1 (override, portrait) > c3 (portrait, newer) > c2 (walk)
 *  style+family tier: c4 (portrait, marcus) > c5 (walk, marcus)
 *  family tier:       c6 (grunt)
 *  excluded:          c7 (a prop)
 */
async function populated(): Promise<HistoryGame> {
  const g = await historyGame(h);
  for (const [id, asset, step] of [["c1", "cortex", "portrait"], ["c2", "cortex", "walk"], ["c3", "cortex", "portrait"], ["c4", "marcus", "portrait"], ["c5", "marcus", "walk"], ["c6", "grunt", "portrait"], ["c7", "crate", "portrait"]] as const) {
    await seedCandidate(g, id, asset, step);
  }
  await judge(g, "c1", "reject", agent);
  await judge(g, "c1", "approve", human, true);
  await judge(g, "c2", "approve", human);
  await judge(g, "c3", "reject", agent);
  await judge(g, "c4", "approve", human);
  await judge(g, "c5", "reject", agent);
  await judge(g, "c6", "approve", agent);
  await judge(g, "c7", "approve", human);
  return g;
}

const examples = async (g: HistoryGame, input: Record<string, unknown>) => expectOk(await h.call("history.examples", { assetId: "cortex", stepId: "portrait", ...input }, { project: g.root }));

describe("history.examples", () => {
  test("tiers asset, then style+family, then family; step match and human overrides rank first within a tier; a prop is excluded", async () => {
    const g = await populated();
    const r = await examples(g, {});
    expect(r.examples.map((e) => [e.candidateId, e.tier, e.outcome])).toEqual([
      ["c1", "asset", "accepted"], ["c3", "asset", "rejected"], ["c2", "asset", "accepted"],
      ["c4", "style-family", "accepted"], ["c5", "style-family", "rejected"], ["c6", "family", "accepted"],
    ]);
    expect(r).toMatchObject({ total: 6, accepted: 4, rejected: 2, scope: { assetId: "cortex", styleIds: ["cranium"], family: "character" } });
    // the override replaced the agent's rejection: one example for c1, naming the human override
    const c1 = r.examples[0]!;
    expect(c1).toMatchObject({ humanOverride: true, decision: { kind: "override", decision: "approve", actorType: "human" } });
    expect(c1.matched).toEqual(["same asset", "same step (portrait)", "human override of an earlier decision"]);
    expect(r.examples[3]!.matched).toEqual(["same style (cranium) and family character", "same step (portrait)"]);
    expect(r.examples[5]!.matched).toEqual(["same family (character)", "same step (portrait)"]);
    // the judged output's own visual and the sibling candidates of its step
    expect(c1.visuals.map((v) => v.fileId)).toEqual(["out_c1"]);
    expect(c1.alternatives).toEqual([{ candidateId: "c3", label: "C3", outcome: "rejected" }]);
  });

  test("a page keeps up to half accepted and half rejected and fills from the larger side; offset slices the full ordering", async () => {
    const g = await populated();
    expect((await examples(g, { limit: 4 })).examples.map((e) => e.candidateId)).toEqual(["c1", "c3", "c2", "c5"]);
    expect((await examples(g, { limit: 3 })).examples.map((e) => e.candidateId)).toEqual(["c1", "c3", "c2"]);
    const second = await examples(g, { limit: 4, offset: 4 });
    expect(second.examples.map((e) => e.candidateId)).toEqual(["c4", "c6"]);
    expect(second.total).toBe(6);
    expect((await examples(g, { limit: 4, offset: 6 })).examples).toEqual([]);
  });

  test("with no rejected history no negatives are invented", async () => {
    const g = await historyGame(h);
    await seedCandidate(g, "a1", "cortex", "portrait");
    await seedCandidate(g, "a2", "cortex", "portrait");
    await judge(g, "a1", "approve", human);
    await judge(g, "a2", "approve", agent);
    const r = await examples(g, {});
    expect(r).toMatchObject({ total: 2, accepted: 2, rejected: 0 });
    expect(r.examples.every((e) => e.outcome === "accepted")).toBe(true);
  });

  test("a decision whose bytes later changed still counts, and says so; an unknown asset is NOT_FOUND", async () => {
    const g = await historyGame(h);
    await seedCandidate(g, "b1", "cortex", "portrait");
    await judge(g, "b1", "reject", agent);
    g.h.registry.get(g.root)!.db.query("UPDATE candidate_outputs SET sha256 = ? WHERE output_id = 'out_b1'").run("f".repeat(64));
    const r = await examples(g, {});
    expect(r.examples[0]!.matched).toContain("decided against bytes that have since changed");
    const missing = await h.call("history.examples", { assetId: "nobody" }, { project: g.root });
    expect(missing.ok === false && missing.error.code).toBe("NOT_FOUND");
  });
});

describe("history.judgments", () => {
  test("counts agent decisions against the human overrides that replaced them, scoped by asset or style", async () => {
    const g = await populated();
    const esc = await seedCandidate(g, "c8", "cortex", "portrait");
    expectOk(await h.call("review.escalate", { candidateId: "c8", outputIds: [esc], reason: "unsure about the hands" }, { project: g.root, context: agent }));

    const all = expectOk(await h.call("history.judgments", {}, { project: g.root })).summary;
    expect(all).toMatchObject({ agentDecisions: 4, agentApprovals: 1, agentRejections: 3, humanDecisions: 4, overrides: 1, reversals: 1, escalations: 1, pendingEscalations: 1 });
    expect(all.cases).toHaveLength(1);
    expect(all.cases[0]).toMatchObject({ candidateId: "c1", agentDecision: { decision: "reject", actorType: "agent" }, humanDecision: { decision: "approve", kind: "override" }, reversed: true });

    const cortex = expectOk(await h.call("history.judgments", { assetId: "cortex" }, { project: g.root })).summary;
    expect(cortex).toMatchObject({ agentDecisions: 2, overrides: 1, scope: { assetId: "cortex" } });
    const cranium = expectOk(await h.call("history.judgments", { styleId: "cranium" }, { project: g.root })).summary;
    expect(cranium).toMatchObject({ agentDecisions: 3, humanDecisions: 3, overrides: 1, scope: { styleId: "cranium" } });
    const grunt = expectOk(await h.call("history.judgments", { assetId: "grunt", styleId: "cranium" }, { project: g.root })).summary;
    expect(grunt).toMatchObject({ agentDecisions: 0, overrides: 0 });

    const bad = await h.call("history.judgments", { styleId: "nope" }, { project: g.root });
    expect(bad.ok === false && bad.error.code).toBe("NOT_FOUND");
  });

  test("an override that repeats the agent's verdict is an override but not a reversal", async () => {
    const g = await historyGame(h);
    await seedCandidate(g, "d1", "cortex", "portrait");
    await judge(g, "d1", "approve", agent);
    await judge(g, "d1", "approve", human, true);
    expect(expectOk(await h.call("history.judgments", {}, { project: g.root })).summary).toMatchObject({ overrides: 1, reversals: 0 });
  });
});
