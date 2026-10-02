import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExportPlan, OperationContext, OperationData, OperationName, OperationResult, PromotionPlan } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import type { OpenProject } from "../src/index.ts";
import { PROJECT_YAML, createHarness, expectOk, human, initializedGame, makePng, put, type Harness } from "./helpers.ts";

setDefaultTimeout(30_000);

const NOW = "2026-10-01T00:00:00.000Z";
const POLICY = "approval:\n  conceptLock: human\n  productionReview: agent_with_escalation\n  promotion: human\n  activation: human\nlayers:\n  - { id: sky, description: Far backdrop }\n  - { id: ground, description: Walkable ground }\n";

interface World {
  h: Harness;
  root: string;
  open: OpenProject;
  /** Environment branch the children are bound to. */
  envBranch: string;
  call<K extends OperationName>(name: K, input: unknown, as?: OperationContext, requestId?: string): Promise<OperationResult<OperationData<K>>>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.h.registry.closeAll();
});

let shade = 10;
let sequence = 1;

interface Pin { name: string; assetId: string; branchId: string; conceptOutputId: string; outputHash: string }

/** One candidate with a real PNG output, inserted the way the scheduler would; `plan` is the run's recorded plan. */
async function seed(w: World, assetId: string, id: string, stepId: string, branchId: string | undefined, plan: Record<string, unknown> = {}): Promise<void> {
  const png = makePng(16, 16, [shade++, 60, 60]);
  const rel = `brainforge/assets/${assetId}/work/candidates/${id}/original/out.png`;
  await put(w.root, rel, png);
  w.open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, branch_id, plan_hash, plan_json, started_by, created_at) VALUES (?, ?, ?, ?, 'p', ?, 'human:local', ?)").run(`run_${id}`, assetId, stepId, branchId ?? null, JSON.stringify(plan), NOW);
  w.open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, assetId, stepId, `identity-${id}`, NOW, NOW);
  w.open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, ?, ?, ?, ?, 'A', 'a prompt', 0, ?, ?)").run(id, assetId, stepId, `run_${id}`, `job_${id}`, NOW, branchId ?? null);
  w.open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'matted', ?, ?, ?, 16, 16, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha256(png));
}

async function lock(w: World, assetId: string, tag: string): Promise<string> {
  await seed(w, assetId, `concept_${assetId}_${tag}`, "concept", undefined);
  return expectOk(await w.call("concept.lock", { assetId, candidateId: `concept_${assetId}_${tag}`, outputId: `out_concept_${assetId}_${tag}` })).branch.branchId;
}

async function approve(w: World, candidateId: string): Promise<void> {
  const m = expectOk(await w.call("review.material", { candidateId }, human));
  expectOk(await w.call("review.decide", { candidateId, outputIds: [`out_${candidateId}`], requirementsHash: m.requirementsHash, decision: "approve", reasons: [] }, human));
}

const pinOf = (w: World, branchId: string, name = "direction"): Pin => {
  const row = w.open.db.query<{ asset_id: string; concept_output_id: string; concept_output_hash: string }, [string]>("SELECT asset_id, concept_output_id, concept_output_hash FROM branches WHERE branch_id = ?").get(branchId)!;
  return { name, assetId: row.asset_id, branchId, conceptOutputId: row.concept_output_id, outputHash: row.concept_output_hash };
};

const envYaml = (members: string): string => `schema: brainforge.asset.v2
id: flatlands
name: Flatlands
family: environment
description: Windswept grey flatlands under a low sun.
collection:
  members:
${members}
deliverables:
  - id: mood
    kind: still
    description: Establishing view of the flatlands.
`;

const MEMBERS = "    - { assetId: sky }\n    - { assetId: ground }\n    - { assetId: fog, required: false }";

function childYaml(id: string, family: string, branchId: string | undefined, over: { kind?: string; environment?: string; roles?: string } = {}): string {
  const roles = over.roles ?? (branchId ? `    referenceRoles:\n      direction: { assetId: flatlands, branchId: ${branchId}, role: direction }\n` : "");
  return `schema: brainforge.asset.v2
id: ${id}
name: ${id}
family: ${family}
description: A ${id} piece of the flatlands.
deliverables:
  - id: main
    kind: ${over.kind ?? "still"}
    description: The ${id}.
${roles}${over.environment ?? ""}`;
}

const GROUND_ENV = "    environment:\n      layer: ground\n      pivot: { x: 8, y: 16 }\n      relativeScale: 1.5\n      tileSize: { width: 16, height: 16 }\n      connections: { west: grass, east: grass }\n      seamlessAxes: [x]\n      parallax: { x: 1, y: 0 }\n";
const SKY_ENV = "    environment:\n      layer: sky\n      parallax: { x: 0.2, y: 0 }\n";

const childSpecs = (branch: string | undefined): Record<string, string> => ({
  sky: childYaml("sky", "background", branch, { environment: SKY_ENV }),
  ground: childYaml("ground", "tile", branch, { kind: "tile", environment: GROUND_ENV }),
  fog: childYaml("fog", "prop", branch),
});

/** A game whose environment has a locked concept (branch B1) and three children bound to it: sky and ground required, fog optional. */
async function world(): Promise<World> {
  const h = createHarness();
  const root = await initializedGame(h);
  await put(root, "brainforge/project.yaml", PROJECT_YAML + POLICY);
  await put(root, "brainforge/assets/flatlands/asset.yaml", envYaml(MEMBERS));
  for (const [id, yaml] of Object.entries(childSpecs(undefined))) await put(root, `brainforge/assets/${id}/asset.yaml`, yaml);
  expectOk(await h.call("project.open", { path: root }));
  const open = h.registry.get(root) as OpenProject;
  const call: World["call"] = (name, input, as, requestId) => h.call(name, input, { project: root, ...(as ? { context: as } : {}), ...(requestId ? { requestId } : {}) });
  expectOk(await call("policy.authorize", { requestedPolicyHash: expectOk(await call("settings.inspect", {})).policy.requestedPolicyHash }));
  const w: World = { h, root, open, envBranch: "", call };
  worlds.push(w);
  w.envBranch = await lock(w, "flatlands", "a");
  for (const [id, yaml] of Object.entries(childSpecs(w.envBranch))) await put(root, `brainforge/assets/${id}/asset.yaml`, yaml);
  return w;
}

/** Lock a child's own concept and produce its approved `main` against the environment branch it is bound to. */
async function produce(w: World, id: string, directionBranch = w.envBranch): Promise<string> {
  const branch = await lock(w, id, "a");
  const candidate = `main_${id}_${sequence++}`;
  await seed(w, id, candidate, "main", branch, { directionPins: [pinOf(w, directionBranch)] });
  await approve(w, candidate);
  return branch;
}

async function produceEnvironment(w: World, branchId = w.envBranch): Promise<void> {
  const candidate = `mood_${sequence++}`;
  await seed(w, "flatlands", candidate, "mood", branchId);
  await approve(w, candidate);
}

const promotionPlan = async (w: World, assetId: string, extra: Record<string, unknown> = {}): Promise<PromotionPlan> => expectOk(await w.call("promotion.plan", { assetId, ...extra })).plan;
const promote = async (w: World, assetId: string, requestId: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const p = await promotionPlan(w, assetId, extra);
  if (p.blockers.length > 0) throw new Error(`blocked: ${p.blockers.map((b) => b.code).join(",")}`);
  return expectOk(await w.call("promotion.start", { planId: p.planId, planHash: p.planHash }, undefined, requestId)).version.versionId;
};
const activate = async (w: World, assetId: string, versionId: string): Promise<void> => {
  const { active } = expectOk(await w.call("version.list", { assetId }));
  expectOk(await w.call("version.activate", { versionId, expectedRevision: active.revision, acknowledgeObsolete: true }));
};
const activeOf = async (w: World, assetId: string): Promise<string | null> => expectOk(await w.call("version.list", { assetId })).active.versionId;
const codes = (p: { blockers: { code: string }[] }): string[] => p.blockers.map((b) => b.code);
const stepOf = async (w: World, assetId: string, branchId: string, stepId: string) => expectOk(await w.call("step.list", { assetId, branchId })).steps.find((s) => s.stepId === stepId)!;

/** Sky and ground promoted and active, environment produced: a complete aggregate is ready. */
async function ready(w: World): Promise<{ sky: string; ground: string }> {
  await produce(w, "sky");
  await produce(w, "ground");
  await produceEnvironment(w);
  const sky = await promote(w, "sky", "promote-sky-0001");
  const ground = await promote(w, "ground", "promote-ground-0001");
  await activate(w, "sky", sky);
  await activate(w, "ground", ground);
  return { sky, ground };
}

describe("cross-asset direction binding", () => {
  test("resolves the named environment branch to its locked concept output id and hash, pins it in the plan and uses it as the reference", async () => {
    const w = await world();
    const branch = await lock(w, "sky", "a");
    const { plan } = expectOk(await w.call("generation.plan", { assetId: "sky", stepId: "main", branchId: branch, mode: "fresh", count: 1 }));
    const pin = pinOf(w, w.envBranch);
    expect(plan.directionPins).toEqual([pin]);
    expect(plan.inputs.references).toContainEqual({ role: "reference", id: pin.conceptOutputId, sha256: pin.outputHash });
    expect(plan.notes.join(" ")).toContain(`flatlands/${w.envBranch}`);
    expect(plan.blockers.map((b) => b.code)).not.toContain("REFERENCE_MISSING");
  });

  test("an unnamed, 'latest' or other asset's branch never resolves: REFERENCE_MISSING with recovery", async () => {
    const w = await world();
    const skyBranch = await lock(w, "sky", "a");
    for (const named of ["latest", skyBranch, "branch_nope"]) {
      await put(w.root, "brainforge/assets/sky/asset.yaml", childYaml("sky", "background", named, { environment: SKY_ENV }));
      const { plan } = expectOk(await w.call("generation.plan", { assetId: "sky", stepId: "main", branchId: skyBranch, mode: "fresh", count: 1 }));
      const missing = plan.blockers.find((b) => b.code === "REFERENCE_MISSING");
      expect(missing?.message).toContain(named);
      expect(missing?.recoveryActions.map((a) => a.operation)).toContain("branch.list");
      expect(plan.directionPins).toEqual([]);
      expect(plan.inputs.references.some((r) => r.id === pinOf(w, w.envBranch).conceptOutputId)).toBe(false);
    }
  });

  test("a locked environment output whose file is gone blocks with REFERENCE_MISSING", async () => {
    const w = await world();
    const branch = await lock(w, "sky", "a");
    await put(w.root, "brainforge/assets/flatlands/work/candidates/concept_flatlands_a/original/out.png", makePng(16, 16, [1, 2, 3]));
    const { plan } = expectOk(await w.call("generation.plan", { assetId: "sky", stepId: "main", branchId: branch, mode: "fresh", count: 1 }));
    expect(plan.blockers.find((b) => b.code === "REFERENCE_MISSING")?.message).toContain("missing on disk");
  });

  test("malformed and self bindings are spec errors; binding an environment that does not list the child is a warning", async () => {
    const w = await world();
    const problems = async (id: string) => expectOk(await w.call("spec.list", {})).files.find((f) => f.id === id)!;

    await put(w.root, "brainforge/assets/sky/asset.yaml", childYaml("sky", "background", undefined, { roles: "    referenceRoles:\n      direction: { assetId: flatlands, role: direction }\n" }));
    const malformed = await problems("sky");
    expect(malformed.valid).toBe(false);
    expect(malformed.problems.some((p) => p.field === "deliverables.main.referenceRoles.direction" && p.severity !== "warning")).toBe(true);

    await put(w.root, "brainforge/assets/sky/asset.yaml", childYaml("sky", "background", undefined, { roles: `    referenceRoles:\n      direction: { assetId: sky, branchId: ${w.envBranch}, role: direction }\n` }));
    const self = await problems("sky");
    expect(self.valid).toBe(false);
    expect(self.problems.map((p) => p.message).join(" ")).toContain("its own direction");

    await put(w.root, "brainforge/assets/rock/asset.yaml", childYaml("rock", "prop", w.envBranch));
    const rock = await problems("rock");
    expect(rock.valid).toBe(true);
    expect(rock.problems).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringContaining("does not list rock in collection.members") })]);
  });

  test("changing which environment branch a child binds stales its approval and names the environment branch in the reassessment reasons", async () => {
    const w = await world();
    const skyBranch = await produce(w, "sky");
    const before = await stepOf(w, "sky", skyBranch, "main");
    expect(before.needsReassessment).toBe(false);
    expect(before.selected?.approval?.applicable).toBe(true);

    const second = await lock(w, "flatlands", "b");
    await put(w.root, "brainforge/assets/sky/asset.yaml", childYaml("sky", "background", second, { environment: SKY_ENV }));
    const after = await stepOf(w, "sky", skyBranch, "main");
    expect(after.needsReassessment).toBe(true);
    expect(after.reassessmentReasons.join(" | ")).toContain(`flatlands/${second}`);
    expect(after.selected?.approval?.applicable).toBe(false);
  });
});

describe("collection completeness", () => {
  test("step.list shows each member's production state and blocks an incomplete collection; the aggregate cannot be planned", async () => {
    const w = await world();
    await produce(w, "sky");
    await produceEnvironment(w);
    const sky = await promote(w, "sky", "promote-sky-0001");

    let collection = expectOk(await w.call("step.list", { assetId: "flatlands", branchId: w.envBranch })).collection!;
    expect(collection.members.map((m) => [m.assetId, m.required, m.state])).toEqual([["sky", true, "promoted"], ["ground", true, "no-version"], ["fog", false, "no-version"]]);
    expect(collection.complete).toBe(false);
    expect(collection.blockers[0]?.code).toBe("COLLECTION_INCOMPLETE");
    expect(collection.blockers[0]?.message).toContain("ground");

    await activate(w, "sky", sky);
    collection = expectOk(await w.call("step.list", { assetId: "flatlands", branchId: w.envBranch })).collection!;
    expect(collection.members.find((m) => m.assetId === "sky")?.state).toBe("active");

    const plan = await promotionPlan(w, "flatlands");
    expect(codes(plan)).toContain("COLLECTION_INCOMPLETE");
    expect(plan.blockers.find((b) => b.code === "COLLECTION_INCOMPLETE")?.message).toContain("ground");
    expect(plan.blockers.find((b) => b.code === "COLLECTION_INCOMPLETE")?.message).not.toContain("sky");
    const refused = await w.call("promotion.start", { planId: plan.planId, planHash: plan.planHash }, undefined, "promote-env-0001");
    expect(refused.ok).toBe(false);
  });

  test("ordinary assets have no collection state and reject member pins", async () => {
    const w = await world();
    expect(expectOk(await w.call("step.list", { assetId: "sky" })).collection).toBeUndefined();
    const r = await w.call("promotion.plan", { assetId: "sky", members: { ground: "x" } });
    expect(r.ok === false && r.error.code).toBe("INVALID_INPUT");
  });
});

describe("aggregate promotion", () => {
  test("a complete collection promotes pinning each member version and the metadata each child declared; optional members stay out", async () => {
    const w = await world();
    const { sky, ground } = await ready(w);
    const plan = await promotionPlan(w, "flatlands");
    expect(plan.blockers).toEqual([]);
    expect(plan.members.map((m) => [m.assetId, m.required, m.versionId ?? null, m.source ?? null, m.directionMatches])).toEqual([
      ["sky", true, sky, "active", true], ["ground", true, ground, "active", true], ["fog", false, null, null, true],
    ]);
    expect(plan.dependencyVersions).toEqual([{ assetId: "ground", versionId: ground }, { assetId: "sky", versionId: sky }]);

    const version = expectOk(await w.call("promotion.start", { planId: plan.planId, planHash: plan.planHash }, undefined, "promote-env-0001")).version;
    const { manifest } = expectOk(await w.call("version.inspect", { versionId: version.versionId }));
    expect(manifest.dependencyVersions).toEqual(plan.dependencyVersions);
    expect(manifest.members?.map((m) => [m.assetId, m.versionId, m.source, m.family])).toEqual([["sky", sky, "active", "background"], ["ground", ground, "active", "tile"]]);
    expect(manifest.members?.find((m) => m.assetId === "ground")?.environment).toEqual([
      { deliverableId: "main", environment: { layer: "ground", pivot: { x: 8, y: 16 }, relativeScale: 1.5, tileSize: { width: 16, height: 16 }, connections: { west: "grass", east: "grass" }, seamlessAxes: ["x"], parallax: { x: 1, y: 0 } } },
    ]);
    expect(manifest.collectionMembers).toEqual([{ assetId: "sky", required: true }, { assetId: "ground", required: true }, { assetId: "fog", required: false }]);
    expect(manifest.members?.map((m) => m.directionOutputHash)).toEqual([pinOf(w, w.envBranch).outputHash, pinOf(w, w.envBranch).outputHash]);
    expect(version.matchesCurrent).toBe(true);
  });

  test("an explicit member version is shown in the plan, and an optional member joins only when named", async () => {
    const w = await world();
    const { sky: sky1 } = await ready(w);
    await produce(w, "fog");
    const fog = await promote(w, "fog", "promote-fog-0001");
    // sky gets a second version and becomes the active one
    const sky2 = await promote(w, "sky", "promote-sky-0002");
    await activate(w, "sky", sky2);

    const byDefault = await promotionPlan(w, "flatlands");
    expect(byDefault.members.find((m) => m.assetId === "sky")).toMatchObject({ versionId: sky2, source: "active" });
    expect(byDefault.members.find((m) => m.assetId === "fog")).toMatchObject({ required: false, directionMatches: true });
    expect(byDefault.members.find((m) => m.assetId === "fog")?.versionId).toBeUndefined();

    const explicit = await promotionPlan(w, "flatlands", { members: { sky: sky1, fog } });
    expect(explicit.blockers).toEqual([]);
    expect(explicit.members.map((m) => [m.assetId, m.versionId, m.source])).toEqual([["sky", sky1, "explicit"], ["ground", expect.any(String), "active"], ["fog", fog, "explicit"]]);
    expect(explicit.dependencyVersions.map((d) => d.assetId)).toEqual(["fog", "ground", "sky"]);

    // start re-evaluates with exactly the pins the plan showed
    const version = expectOk(await w.call("promotion.start", { planId: explicit.planId, planHash: explicit.planHash }, undefined, "promote-env-0002")).version;
    const { manifest } = expectOk(await w.call("version.inspect", { versionId: version.versionId }));
    expect(manifest.members?.map((m) => [m.assetId, m.versionId, m.source])).toEqual([["sky", sky1, "explicit"], ["ground", expect.any(String), "active"], ["fog", fog, "explicit"]]);

    const unknown = await promotionPlan(w, "flatlands", { members: { sky: sky1, rock: "v" } });
    expect(codes(unknown)).toContain("MEMBER_UNKNOWN");
    const wrong = await promotionPlan(w, "flatlands", { members: { sky: "ver_nope" } });
    expect(codes(wrong)).toContain("VERSION_NOT_FOUND");
  });

  test("a member made against another direction output blocks the whole aggregate; obsolete members only warn", async () => {
    const w = await world();
    await ready(w);
    const second = await lock(w, "flatlands", "b");
    await produceEnvironment(w, second);

    const plan = await promotionPlan(w, "flatlands", { branchId: second });
    expect(codes(plan).filter((c) => c === "DIRECTION_MISMATCH")).toHaveLength(2);
    expect(plan.members.filter((m) => !m.directionMatches).map((m) => m.assetId)).toEqual(["sky", "ground"]);
    expect(plan.blockers.find((b) => b.code === "DIRECTION_MISMATCH")?.message).toContain(`${w.envBranch}`);
    expect((await w.call("promotion.start", { planId: plan.planId, planHash: plan.planHash }, undefined, "promote-env-0003")).ok).toBe(false);

    // a member whose own requirements moved on is shown, not blocking, for the branch it matches
    await put(w.root, "brainforge/assets/sky/asset.yaml", childYaml("sky", "background", w.envBranch, { environment: SKY_ENV }).replace("A sky piece", "A hazy sky piece"));
    const first = await promotionPlan(w, "flatlands", { branchId: w.envBranch });
    expect(codes(first)).not.toContain("DIRECTION_MISMATCH");
    expect(first.blockers).toEqual([]);
    expect(first.members.find((m) => m.assetId === "sky")?.obsolete).toBe(true);
  });

  test("aggregate activation never moves a child's active pointer", async () => {
    const w = await world();
    const { sky, ground } = await ready(w);
    const skyRevision = expectOk(await w.call("version.list", { assetId: "sky" })).active.revision;
    const sky2 = await promote(w, "sky", "promote-sky-0002");
    const env = await promote(w, "flatlands", "promote-env-0001");
    await activate(w, "flatlands", env);

    expect(await activeOf(w, "flatlands")).toBe(env);
    expect(await activeOf(w, "sky")).toBe(sky);
    expect(await activeOf(w, "ground")).toBe(ground);
    expect(expectOk(await w.call("version.list", { assetId: "sky" })).active.revision).toBe(skyRevision);
    expect(sky2).not.toBe(sky);
  });

  test("a membership change makes the earlier aggregate obsolete and needs a new version; the prior one stays", async () => {
    const w = await world();
    await ready(w);
    const v1 = await promote(w, "flatlands", "promote-env-0001");
    expect(expectOk(await w.call("version.list", { assetId: "flatlands" })).versions[0]?.matchesCurrent).toBe(true);

    await put(w.root, "brainforge/assets/flatlands/asset.yaml", envYaml("    - { assetId: sky }\n    - { assetId: fog, required: false }"));
    const listed = expectOk(await w.call("version.list", { assetId: "flatlands" })).versions;
    expect(listed.map((v) => [v.versionId, v.matchesCurrent])).toEqual([[v1, false]]);
    const inspected = expectOk(await w.call("version.inspect", { versionId: v1 }));
    expect(inspected.differences.map((d) => d.field)).toContain("collection.members");

    const v2 = await promote(w, "flatlands", "promote-env-0002");
    const after = expectOk(await w.call("version.list", { assetId: "flatlands" })).versions;
    expect(after.map((v) => [v.versionNumber, v.matchesCurrent])).toEqual([[2, true], [1, false]]);
    const { manifest } = expectOk(await w.call("version.inspect", { versionId: v2 }));
    expect(manifest.members?.map((m) => m.assetId)).toEqual(["sky"]);
  });
});

describe("aggregate export", () => {
  const planExport = async (w: World, input: Record<string, unknown>): Promise<ExportPlan> => expectOk(await w.call("export.plan", input)).plan;

  test("selecting an environment version exports its pinned member versions and lists them with their metadata in asset.json", async () => {
    const w = await world();
    const { sky: sky1, ground } = await ready(w);
    const env = await promote(w, "flatlands", "promote-env-0001");
    await activate(w, "flatlands", env);
    // sky moves on after the aggregate pinned version 1
    const sky2 = await promote(w, "sky", "promote-sky-0002");
    await activate(w, "sky", sky2);

    const plan = await planExport(w, { assetIds: ["flatlands"] });
    expect(plan.blockers).toEqual([]);
    expect(plan.selection.map((s) => [s.assetId, s.versionId, s.source])).toEqual([["flatlands", env, "active"], ["sky", sky1, "member"], ["ground", ground, "member"]]);

    // the default selection (every active version) yields to the aggregate's pin instead of conflicting
    const everything = await planExport(w, {});
    expect(everything.blockers).toEqual([]);
    expect(everything.selection.find((s) => s.assetId === "sky")).toMatchObject({ versionId: sky1, source: "member" });

    expectOk(await w.call("export.start", { planId: plan.planId, planHash: plan.planHash }, undefined, "export-0001"));
    const doc = JSON.parse(await readFile(join(w.root, "assets/brainforge/current/assets/flatlands/asset.json"), "utf8")) as { metadata: { members: { assetId: string; versionId: string; environment: { deliverableId: string; environment: Record<string, unknown> }[] }[] } };
    expect(doc.metadata.members.map((m) => [m.assetId, m.versionId])).toEqual([["sky", sky1], ["ground", ground]]);
    expect(doc.metadata.members.find((m) => m.assetId === "ground")?.environment[0]?.environment).toMatchObject({ layer: "ground", tileSize: { width: 16, height: 16 }, connections: { west: "grass", east: "grass" }, seamlessAxes: ["x"], parallax: { x: 1, y: 0 }, relativeScale: 1.5, pivot: { x: 8, y: 16 } });
    const groundDoc = JSON.parse(await readFile(join(w.root, "assets/brainforge/current/assets/ground/asset.json"), "utf8")) as { deliverables: { metadata: { environment: Record<string, unknown> }; tile?: { width: number } }[] };
    expect(groundDoc.deliverables[0]?.metadata.environment).toMatchObject({ layer: "ground", parallax: { x: 1, y: 0 } });
  });

  test("a child selected directly at a different version than the aggregate pinned is EXPORT_CONFLICT naming both, and start refuses it", async () => {
    const w = await world();
    const { sky: sky1 } = await ready(w);
    const env = await promote(w, "flatlands", "promote-env-0001");
    await activate(w, "flatlands", env);
    const sky2 = await promote(w, "sky", "promote-sky-0002");
    await activate(w, "sky", sky2);

    const direct = await planExport(w, { assetIds: ["flatlands", "sky"] });
    const conflict = direct.blockers.find((b) => b.code === "EXPORT_CONFLICT");
    expect(conflict?.message).toContain(sky1);
    expect(conflict?.message).toContain(sky2);
    const refused = await w.call("export.start", { planId: direct.planId, planHash: direct.planHash }, undefined, "export-0002");
    expect(refused.ok).toBe(false);

    const pinned = await planExport(w, { assetIds: ["flatlands", "sky"], versions: { sky: sky1 } });
    expect(pinned.blockers).toEqual([]);
  });
});
