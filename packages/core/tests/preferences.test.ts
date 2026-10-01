import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHarness, expectOk } from "./helpers.ts";
import { agent, historyGame, human, judge, seedCandidate, type HistoryGame } from "./history-fixture.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

async function withDecision(): Promise<{ g: HistoryGame; decisionId: string }> {
  const g = await historyGame(h);
  await seedCandidate(g, "p1", "cortex", "portrait");
  const decision = await judge(g, "p1", "approve", agent);
  return { g, decisionId: decision.decisionId };
}

const propose = (g: HistoryGame, input: Record<string, unknown>, context = agent) =>
  h.call("preference.propose", { text: "Keep the contour lines warm and dark", scope: "project", ...input }, { project: g.root, context });

describe("preference.propose", () => {
  test("validates evidence ids, the style and scope; an agent may propose and the proposal changes nothing", async () => {
    const { g, decisionId } = await withDecision();
    const unknown = await propose(g, { evidenceIds: [decisionId, "dec_nope"] });
    expect(unknown.ok === false && unknown.error.code).toBe("INVALID_INPUT");
    expect(unknown.ok === false && unknown.error.details).toEqual({ unknown: ["dec_nope"] });

    const noStyle = await propose(g, { scope: "style", evidenceIds: [decisionId] });
    expect(noStyle.ok === false && noStyle.error.code).toBe("INVALID_INPUT");
    const badStyle = await propose(g, { scope: "style", styleId: "ghost", evidenceIds: [decisionId] });
    expect(badStyle.ok === false && badStyle.error.code).toBe("INVALID_INPUT");
    const styledProject = await propose(g, { scope: "project", styleId: "cranium", evidenceIds: [decisionId] });
    expect(styledProject.ok === false && styledProject.error.code).toBe("INVALID_INPUT");

    const before = expectOk(await h.call("review.material", { candidateId: "p1" }, { project: g.root }));
    const ok = expectOk(await propose(g, { evidenceIds: [decisionId, decisionId] }));
    expect(ok.preference).toMatchObject({ status: "proposed", scope: "project", evidenceIds: [decisionId], proposedByType: "agent", corrected: false, text: "Keep the contour lines warm and dark" });
    const after = expectOk(await h.call("review.material", { candidateId: "p1" }, { project: g.root }));
    expect(after.requirementsHash).toBe(before.requirementsHash);
    expect(after.preferences).toEqual([]);
    expect(expectOk(await h.call("preference.list", { status: "proposed" }, { project: g.root })).preferences.map((p) => p.preferenceId)).toEqual([ok.preference.preferenceId]);
  });
});

describe("preference.confirm / reject", () => {
  test("only a human decides; only a proposal can be decided", async () => {
    const { g, decisionId } = await withDecision();
    const { preference } = expectOk(await propose(g, { evidenceIds: [decisionId] }));
    const refused = await h.call("preference.confirm", { preferenceId: preference.preferenceId }, { project: g.root, context: agent });
    expect(refused.ok === false && refused.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    const refusedReject = await h.call("preference.reject", { preferenceId: preference.preferenceId, reason: "no" }, { project: g.root, context: agent });
    expect(refusedReject.ok === false && refusedReject.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(expectOk(await h.call("preference.list", {}, { project: g.root })).preferences[0]!.status).toBe("proposed");

    const rejected = expectOk(await h.call("preference.reject", { preferenceId: preference.preferenceId, reason: "too vague" }, { project: g.root, context: human }));
    expect(rejected.preference).toMatchObject({ status: "rejected", note: "too vague", decidedBy: human.actorId });
    const again = await h.call("preference.confirm", { preferenceId: preference.preferenceId }, { project: g.root, context: human });
    expect(again.ok === false && again.error.code).toBe("REVISION_CONFLICT");
    const missing = await h.call("preference.confirm", { preferenceId: "pref_none" }, { project: g.root, context: human });
    expect(missing.ok === false && missing.error.code).toBe("NOT_FOUND");
  });

  test("confirming (with corrected wording) adds an effective requirement, changes the hash and stales an existing approval by name; YAML and policy are untouched", async () => {
    const { g, decisionId } = await withDecision();
    const projectYaml = await readFile(join(g.root, "brainforge/project.yaml"), "utf8");
    const policyBefore = expectOk(await h.call("settings.inspect", {}, { project: g.root })).policy;
    const before = expectOk(await h.call("review.material", { candidateId: "p1" }, { project: g.root }));
    expect(before.candidate.approvals[0]).toMatchObject({ state: "approved", applicable: true });

    const { preference } = expectOk(await propose(g, { evidenceIds: [decisionId] }));
    const confirmed = expectOk(await h.call("preference.confirm", { preferenceId: preference.preferenceId, text: "Warm dark contours, never black", note: "per the review of p1" }, { project: g.root, context: human })).preference;
    expect(confirmed).toMatchObject({ status: "confirmed", corrected: true, proposedText: "Keep the contour lines warm and dark", text: "Warm dark contours, never black", decidedBy: human.actorId });

    const after = expectOk(await h.call("review.material", { candidateId: "p1" }, { project: g.root }));
    expect(after.requirementsHash).not.toBe(before.requirementsHash);
    expect(after.preferences).toEqual([{ preferenceId: preference.preferenceId, scope: "project", text: "Warm dark contours, never black" }]);
    // the old decision keeps its recorded hash; it no longer applies, and the reason names the preference
    const approval = after.candidate.approvals[0]!;
    expect(approval).toMatchObject({ state: "approved", applicable: false });
    expect(approval.staleReason).toContain(preference.preferenceId);
    expect(approval.staleReason).toContain("Warm dark contours, never black");
    expect(after.decisions[0]!.requirementsHash).toBe(before.requirementsHash);

    // visible in settings.inspect with its own source, for the asset and the project
    const settings = expectOk(await h.call("settings.inspect", { assetId: "cortex" }, { project: g.root }));
    expect(settings.effective[`preference.${preference.preferenceId}`]).toEqual({
      value: "Warm dark contours, never black", source: { file: `preference:${preference.preferenceId}`, field: "project", layer: "project-defaults" },
    });
    expect(settings.policy.requestedPolicyHash).toBe(policyBefore.requestedPolicyHash);
    expect(await readFile(join(g.root, "brainforge/project.yaml"), "utf8")).toBe(projectYaml);

    // re-judging against the new requirements applies again
    const again = await judge(g, "p1", "approve", human, true);
    expect(again.requirementsHash).toBe(after.requirementsHash);
  });

  test("a style preference applies only to assets that use the style", async () => {
    const { g, decisionId } = await withDecision();
    await seedCandidate(g, "p2", "crate", "portrait");
    const { preference } = expectOk(await propose(g, { scope: "style", styleId: "cranium", text: "Coral stays saturated", evidenceIds: [decisionId] }));
    expectOk(await h.call("preference.confirm", { preferenceId: preference.preferenceId }, { project: g.root, context: human }));
    const key = `preference.${preference.preferenceId}`;
    expect(key in expectOk(await h.call("settings.inspect", { assetId: "cortex" }, { project: g.root })).effective).toBe(true);
    expect(key in expectOk(await h.call("settings.inspect", { assetId: "crate" }, { project: g.root })).effective).toBe(false);
    expect(expectOk(await h.call("review.material", { candidateId: "p2" }, { project: g.root })).preferences).toEqual([]);
    expect(expectOk(await h.call("review.material", { candidateId: "p1" }, { project: g.root })).preferences.map((p) => p.preferenceId)).toEqual([preference.preferenceId]);
  });
});
