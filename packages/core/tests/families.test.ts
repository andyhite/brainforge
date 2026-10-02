import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { AssetFamily, FamilyProfile, type Deliverable, type OperationName, type Problem } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import { parseAuthored } from "../src/authored.ts";
import { PROFILES, familyTemplate, framingFor, resolveAlpha, workflowFor } from "../src/families/index.ts";
import { buildPipeline } from "../src/pipeline.ts";
import { PROJECT_YAML, createHarness, expectOk, initializedGame, makePng, put } from "./helpers.ts";
import { generationFixture, type GenerationFixture } from "./generation-fixture.ts";

setDefaultTimeout(30_000);

const FAMILIES = AssetFamily.options;
const NOW = "2026-10-01T00:00:00.000Z";

const fixtures: GenerationFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
});

function parse(text: string, id = "thing") {
  const file = parseAuthored("asset", `brainforge/assets/${id}/asset.yaml`, id, text);
  if (file.kind !== "asset") throw new Error("not an asset");
  return file;
}
const errorsOf = (problems: Problem[]): Problem[] => problems.filter((p) => p.severity !== "warning");
const warningsOf = (problems: Problem[]): Problem[] => problems.filter((p) => p.severity === "warning");
const head = (family: string, rest = ""): string => `schema: brainforge.asset.v2\nid: thing\nname: Thing\nfamily: ${family}\ndescription: A concrete thing.\n${rest}`;

describe("family catalog", () => {
  test("family.list needs no project and describes all eleven families against the contract", async () => {
    const h = createHarness();
    const { families } = expectOk(await h.call("family.list", {}));
    expect(families.map((f) => f.family).sort()).toEqual([...FAMILIES].sort());
    for (const f of families) expect(FamilyProfile.safeParse(f).success).toBe(true);
    const by = Object.fromEntries(families.map((f) => [f.family, f]));
    expect(by.character).toMatchObject({ alpha: "matte", motion: "typical", collection: "none" });
    expect(by.environment).toMatchObject({ alpha: "opaque", motion: "none", collection: "container" });
    expect(by.tile?.requiredFields).toMatchObject({ tile: ["environment.tileSize"] });
    expect(by.ui?.requiredFields["ui-state"]).toEqual(["ui.state"]);
    expect(by.effect?.requiredFields.animation).toEqual(["animation.motion", "animation.loop"]);
    expect(by.item?.allowedKinds).not.toContain("animation");
    expect(by.prop?.motion).toBe("optional");
    expect(expectOk(await h.call("family.list", {})).families).toHaveLength(PROFILES.length);
  });

  test("every profile names workflows that exist on disk", async () => {
    const ids = new Set<string>();
    for (const p of PROFILES) for (const stage of ["still", "variation", "motion"] as const) for (const alpha of ["transparent", "opaque"] as const) {
      const id = workflowFor(p.family, stage, alpha);
      if (id) ids.add(id);
    }
    for (const id of ids) expect(await Bun.file(new URL(`../../comfy/workflows/${id}/1.yaml`, import.meta.url)).exists()).toBe(true);
  });
});

describe("family templates", () => {
  test.each(FAMILIES.map((f) => [f]))("%s: the starter file validates, carries placeholders as warnings, and has the family's shape", async (family) => {
    const h = createHarness();
    const t = expectOk(await h.call("family.template", { family, id: `sample-${family}`, name: "Sample" }));
    expect(t.path).toBe(`brainforge/assets/sample-${family}/asset.yaml`);
    const file = parse(t.text, `sample-${family}`);
    expect(errorsOf(file.problems)).toEqual([]);
    expect(file.valid).toBe(true);
    expect(warningsOf(file.problems).some((p) => p.message.includes("REPLACE:"))).toBe(true);
    expect(file.spec?.family).toBe(family);
    // a template never pre-declares a kind its family forbids
    const allowed = PROFILES.find((p) => p.family === family)?.allowedKinds ?? [];
    for (const d of file.spec?.deliverables ?? []) expect(allowed).toContain(d.kind);
  });

  test("a given description is kept and the creature template uses neutral body wording", () => {
    const t = familyTemplate("creature", "marsh-thing", "Marsh thing", "A low, wide swamp animal.");
    expect(t.text).toContain('description: "A low, wide swamp animal."');
    expect(t.text).not.toMatch(/humanoid|arms|legs|torso|clothing/i);
    expect(parse(t.text, "marsh-thing").spec?.identity).toHaveProperty("body");
  });

  test("item and equipment have views and variants; equipment carries attachments; props are static with an optional loop", () => {
    const item = parse(familyTemplate("item", "gem", "Gem").text, "gem").spec!;
    expect(item.deliverables.map((d) => d.kind)).toEqual(["view", "view", "variant"]);
    const equipment = parse(familyTemplate("equipment", "helm", "Helm").text, "helm").spec!;
    expect(equipment.deliverables.some((d) => d.kind === "variant")).toBe(true);
    expect(equipment.attachments).toEqual([{ name: "grip", x: 256, y: 384, deliverable: "front-view" }]);
    const prop = parse(familyTemplate("prop", "lamp", "Lamp").text, "lamp").spec!;
    const loop = prop.deliverables.find((d) => d.kind === "animation");
    expect(loop).toMatchObject({ id: "idle-loop", required: false });
    expect(prop.deliverables.filter((d) => d.required).every((d) => d.kind !== "animation")).toBe(true);
  });

  test("output sizes, alpha, tile and nine-slice fields appear where the family needs them", () => {
    const get = (family: AssetFamily): Deliverable[] => parse(familyTemplate(family, "x-asset", "X").text, "x-asset").spec!.deliverables;
    expect(get("background")[0]?.output).toEqual({ width: 1920, height: 1080, alpha: "opaque" });
    expect(get("tile")[0]?.environment?.tileSize).toEqual({ width: 64, height: 64 });
    expect(get("ui")[0]?.ui?.nineSlice).toEqual({ left: 24, top: 24, right: 24, bottom: 24 });
    expect(get("icon")[0]?.output).toMatchObject({ width: 128, height: 128 });
    expect(get("effect").find((d) => d.kind === "animation")?.animation?.loop).toBe(false);
  });

  test.each(FAMILIES.map((f) => [f]))("%s: a concept plan composes against the fake ComfyUI with no blockers", async (family) => {
    const f = await generationFixture();
    fixtures.push(f);
    const id = `sample-${family}`;
    const t = expectOk(await f.h.call("family.template", { family, id, name: "Sample" }));
    await put(f.root, t.path, t.text);
    const plan = expectOk(await f.h.call("generation.plan", { assetId: id, count: 1 }, { project: f.root })).plan;
    expect(plan.blockers).toEqual([]);
    expect(plan.workflow.id).toBe(workflowFor(family, "still", resolveAlpha(family)) ?? "");
    expect(plan.promptSources.at(-1)?.text).toBe(framingFor(family, resolveAlpha(family)));
    expect(plan.preflight.ok).toBe(true);
  });
});

describe("family validation", () => {
  test("a kind the family does not allow, and animation on a static family, are errors naming the field", () => {
    const file = parse(head("item", "deliverables:\n  - { id: spin, kind: animation, animation: { motion: spins } }\n  - { id: cell, kind: tile }\n"));
    const errors = errorsOf(file.problems);
    expect(errors.find((p) => p.field === "deliverables[0].kind")?.message).toContain("static");
    expect(errors.find((p) => p.field === "deliverables[0].animation")?.message).toContain("static");
    expect(errors.find((p) => p.field === "deliverables[1].kind")?.message).toContain("not allowed for a item");
    expect(errors.find((p) => p.field === "deliverables[1].kind")?.line).toBe(8);
    expect(file.valid).toBe(false);
  });

  test("required fields per kind are warnings that block only their own step", () => {
    const file = parse(head("tile", "deliverables:\n  - { id: cell, kind: tile }\n  - { id: plain, kind: still }\n"));
    expect(errorsOf(file.problems)).toEqual([]);
    expect(warningsOf(file.problems).map((p) => p.field)).toEqual(["deliverables[0].environment.tileSize"]);
    expect(file.valid).toBe(true);
    const pipeline = buildPipeline(file.spec);
    expect(pipeline.byId.get("cell")?.problems.join(" ")).toContain("environment.tileSize");
    expect(pipeline.byId.get("plain")?.problems).toEqual([]);

    const ui = parse(head("ui", "deliverables:\n  - { id: pressed, kind: ui-state }\n"));
    expect(warningsOf(ui.problems).map((p) => p.field)).toEqual(["deliverables[0].ui.state"]);
  });

  test("an effect or UI animation must state loop explicitly", () => {
    const implicit = parse(head("effect", "deliverables:\n  - { id: boom, kind: animation, animation: { motion: expands } }\n"));
    expect(warningsOf(implicit.problems).map((p) => p.field)).toEqual(["deliverables[0].animation.loop"]);
    const explicit = parse(head("effect", "deliverables:\n  - { id: boom, kind: animation, animation: { motion: expands, loop: false } }\n"));
    expect(explicit.problems).toEqual([]);
  });

  test("attachments are for equipment and props, and must name an existing deliverable", () => {
    const wrong = parse(head("item", "attachments:\n  - { name: grip, x: 1, y: 2 }\n"));
    expect(errorsOf(wrong.problems).map((p) => p.field)).toEqual(["attachments"]);
    const missing = parse(head("equipment", "deliverables:\n  - { id: front, kind: view }\nattachments:\n  - { name: grip, x: 1, y: 2, deliverable: back }\n"));
    expect(errorsOf(missing.problems).map((p) => p.field)).toEqual(["attachments[0].deliverable"]);
    expect(parse(head("prop", "deliverables:\n  - { id: front, kind: view }\nattachments:\n  - { name: grip, x: 1, y: 2, deliverable: front }\n")).problems).toEqual([]);
  });

  test("only an environment forms a collection, never listing itself or a member twice", () => {
    const notEnvironment = parse(head("prop", "collection:\n  members:\n    - { assetId: other }\n"));
    expect(errorsOf(notEnvironment.problems).map((p) => p.field)).toEqual(["collection"]);
    const env = parse(head("environment", "collection:\n  members:\n    - { assetId: thing }\n    - { assetId: sky }\n    - { assetId: sky }\n"));
    expect(errorsOf(env.problems).map((p) => p.field)).toEqual(["collection.members[0].assetId", "collection.members[2].assetId"]);
  });

  test("output sizes need both sides and sane values; nine-slice margins must fit; seamless axes need matching labels", () => {
    const half = parse(head("icon", "deliverables:\n  - { id: a, kind: still, output: { width: 128 } }\n  - { id: b, kind: still, output: { width: 9000, height: 64 } }\n"));
    expect(errorsOf(half.problems).map((p) => p.field)).toEqual(["deliverables[0].output", "deliverables[1].output.width"]);

    const slice = parse(head("ui", "deliverables:\n  - { id: panel, kind: ui-state, output: { width: 40, height: 100 }, ui: { state: normal, nineSlice: { left: 20, right: 20, top: 10, bottom: 10 } } }\n"));
    expect(errorsOf(slice.problems).map((p) => p.field)).toEqual(["deliverables[0].ui.nineSlice"]);
    expect(errorsOf(slice.problems)[0]?.message).toContain("output.width 40");

    const seam = parse(head("tile", "deliverables:\n  - id: cell\n    kind: tile\n    environment: { tileSize: { width: 32, height: 32 }, seamlessAxes: [x], connections: { west: grass, east: stone } }\n"));
    expect(errorsOf(seam.problems).map((p) => p.field)).toEqual(["deliverables[0].environment.connections"]);
    const ok = parse(head("tile", "deliverables:\n  - id: cell\n    kind: tile\n    environment: { tileSize: { width: 32, height: 32 }, seamlessAxes: [x], connections: { west: grass, east: grass, north: top } }\n"));
    expect(ok.problems).toEqual([]);
  });

  test("spec.validate and spec.write surface the same problems; placeholders warn without making the asset invalid", async () => {
    const h = createHarness();
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    const path = "brainforge/assets/lamp/asset.yaml";
    const text = familyTemplate("prop", "lamp", "Lamp").text;
    const v = expectOk(await h.call("spec.validate", { path, text }, { project: root }));
    expect(v.valid).toBe(true);
    expect(v.problems.length).toBeGreaterThan(0);
    expect(v.problems.every((p) => p.severity === "warning" && p.field && p.line)).toBe(true);
    const w = expectOk(await h.call("spec.write", { path, text: head("item").replace("id: thing", "id: lamp") + "deliverables:\n  - { id: x, kind: animation, animation: { motion: spins } }\n", expectedHash: null }, { project: root }));
    expect(w.problems.some((p) => p.field === "deliverables[0].kind")).toBe(true);
    const inspected = expectOk(await h.call("asset.inspect", { assetId: "lamp" }, { project: root }));
    expect(inspected.summary.problems.some((p) => p.field === "deliverables[0].kind")).toBe(true);
  });
});

describe("generation by family", () => {
  test("the character prompt and camera wording are byte-identical to the first release", async () => {
    const f = await generationFixture();
    fixtures.push(f);
    const plan = await f.plan({ count: 1 });
    expect(plan.blockers).toEqual([]);
    expect(plan.workflow.id).toBe("krea2-still");
    const lines = plan.prompt.split("\n");
    expect(lines.at(-1)).toBe("A single character alone in the frame, one figure only. The entire figure is fully visible with generous margin on every side. Flat plain light-grey background, no props, no text.");
    expect(framingFor("character", "transparent")).toBe(lines.at(-1) ?? "");
    // the whole prompt, as composed before families existed
    expect(plan.prompt).toBe(CORTEX_PROMPT);
  });

  test("style palette entries are joined with ', ', or '; ' when an entry itself contains a comma", async () => {
    const f = await generationFixture();
    fixtures.push(f);
    const styleLine = async (palette: string): Promise<string | undefined> => {
      await put(f.root, "brainforge/styles/cranium.yaml", `schema: brainforge.style.v2\nid: cranium\npalette:\n${palette}`);
      await put(f.root, "brainforge/assets/cortex/asset.yaml", "schema: brainforge.asset.v2\nid: cortex\nname: Cortex\nfamily: character\ndescription: A guarded teenager with an exposed brain.\nstyleIds: [cranium]\n");
      return (await f.plan({ count: 1 })).promptSources.find((p) => p.label === "Style cranium")?.text;
    };
    expect(await styleLine("  - warm brown contours\n  - flat colour areas\n")).toBe("warm brown contours, flat colour areas");
    expect(await styleLine("  - \"coral pink, slightly desaturated\"\n  - flat colour areas\n")).toBe("coral pink, slightly desaturated; flat colour areas");
  });

  test("a deliverable chooses matte or opaque; the family default applies otherwise", () => {
    expect(resolveAlpha("character")).toBe("transparent");
    expect(resolveAlpha("environment")).toBe("opaque");
    expect(resolveAlpha("tile", { output: { alpha: "transparent" } })).toBe("transparent");
    expect(resolveAlpha("effect")).toBe("transparent");
    expect(resolveAlpha("ui")).toBe("opaque");
    expect(resolveAlpha("ui", { output: { alpha: "transparent" } })).toBe("transparent");
    expect(workflowFor("character", "still", "transparent")).toBe("krea2-still");
    expect(workflowFor("effect", "motion", "opaque")).toBe("wan22-motion-opaque");
    expect(workflowFor("item", "motion", "transparent")).toBeUndefined();
  });

  test("the opaque workflows load, list, inspect and pass preflight, and save no matted output", async () => {
    const f = await generationFixture();
    fixtures.push(f);
    f.h.setComfyUrl(f.fake.url);
    const list = expectOk(await f.h.call("workflow.list", {}, { project: f.root })).workflows.map((w) => w.id);
    for (const id of ["krea2-still-opaque", "krea2-variation-opaque", "wan22-motion-opaque"]) {
      expect(list).toContain(id);
      const wf = expectOk(await f.h.call("workflow.inspect", { workflowId: id }, { project: f.root }));
      expect(wf.outputs.map((o) => o.role)).toEqual(["untouched"]);
      expect(Object.values(wf.requiredModels).some((m) => m.filename === "birefnet.safetensors")).toBe(false);
      const pre = expectOk(await f.h.call("workflow.preflight", { workflowId: id }, { project: f.root }));
      expect(pre.ok).toBe(true);
    }
  });

  test("opaque families plan on the opaque workflow; a transparent override on a tile plans on the matted one", async () => {
    const f = await generationFixture();
    fixtures.push(f);
    const write = async (id: string, family: string, extra: string): Promise<void> => {
      await put(f.root, `brainforge/assets/${id}/asset.yaml`, `schema: brainforge.asset.v2\nid: ${id}\nname: ${id}\nfamily: ${family}\ndescription: A concrete ${family}.\n${extra}`);
    };
    await write("hills", "background", "");
    await write("burst", "effect", "");
    const plan = async (assetId: string) => expectOk(await f.h.call("generation.plan", { assetId, count: 1 }, { project: f.root })).plan;
    const hills = await plan("hills");
    expect(hills.workflow.id).toBe("krea2-still-opaque");
    expect(hills.prompt).toContain("A full-frame scene filling the whole canvas edge to edge, with no characters and no text.");
    expect(hills.prompt).not.toContain("light-grey");
    const burst = await plan("burst");
    expect(burst.workflow.id).toBe("krea2-still");
    expect(burst.prompt).toContain("The effect alone in the frame");
  });

  test("a per-deliverable canvas rounds up to the model grid, tiny targets are drawn at native resolution, oversized targets block", async () => {
    const f = await generationFixture();
    fixtures.push(f);
    const asset = `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager with an exposed brain.
deliverables:
  - { id: small, kind: view, description: A small icon-like render., output: { width: 100, height: 70 } }
  - { id: huge, kind: view, description: Too large., output: { width: 3000, height: 3000 } }
  - { id: exact, kind: view, description: Exact grid., output: { width: 512, height: 768 } }
  - { id: tiny, kind: view, description: A 64px glyph., output: { width: 64, height: 64 } }
  - { id: tiny-off, kind: variant, dependsOn: [tiny], description: The same glyph in flat grey., output: { width: 64, height: 64 } }
`;
    await put(f.root, "brainforge/assets/cortex/asset.yaml", asset);
    expectOk(await f.h.call("project.open", { path: f.root }));
    await seedConcept(f);
    const branchId = expectOk(await f.h.call("concept.lock", { assetId: "cortex", candidateId: "cand_c", outputId: "out_cand_c" }, { project: f.root })).branch.branchId;
    const plan = async (stepId: string) => expectOk(await f.h.call("generation.plan", { assetId: "cortex", stepId, branchId, count: 1 }, { project: f.root })).plan;
    const small = await plan("small");
    expect(small.submissions[0]?.values).toMatchObject({ width: 1024, height: 720 });
    expect(small.notes.join(" ")).toContain("Target output 100x70px; generating 1024x720px");
    const exact = await plan("exact");
    expect(exact.submissions[0]?.values).toMatchObject({ width: 512, height: 768 });
    expect((await plan("tiny")).submissions[0]?.values).toMatchObject({ width: 1024, height: 1024 });
    expect((await plan("tiny")).prompt).toContain("proportions, colours and drawing style identical to the reference image.");
    const off = await plan("tiny-off");
    expect(off.prompt).toContain("this deliverable's description names what changes, including colours");
    expect(off.prompt).not.toContain("colours and drawing style identical");
    const huge = await plan("huge");
    expect(huge.blockers.map((b) => b.code)).toContain("SIZE_UNSUPPORTED");
    expect(huge.submissions[0]?.values.width).toBe(3008);
  });
});

describe("static and optional motion", () => {
  test("a static asset has no motion steps; motion exists only for a declared animation", () => {
    const item = parse(familyTemplate("item", "gem", "Gem").text, "gem").spec!;
    expect(buildPipeline(item).nodes.some((n) => n.kind === "animation")).toBe(false);
    const prop = parse(familyTemplate("prop", "lamp", "Lamp").text, "lamp").spec!;
    const withLoop = buildPipeline(prop).nodes.filter((n) => n.kind === "animation");
    expect(withLoop.map((n) => [n.id, n.required])).toEqual([["idle-loop", false]]);
    const without = { ...prop, deliverables: prop.deliverables.filter((d) => d.kind !== "animation") };
    expect(buildPipeline(without).nodes.some((n) => n.kind === "animation")).toBe(false);
  });

  test("an optional animation that was never produced does not block promotion", async () => {
    const h = createHarness();
    const root = await initializedGame(h);
    await put(root, "brainforge/project.yaml", `${PROJECT_YAML}approval:\n  conceptLock: human\n  productionReview: human\n  promotion: human\n  activation: human\n`);
    const text = familyTemplate("prop", "lamp", "Lamp", "A tall brass street lamp.").text
      .replace(/"REPLACE: [^"]*"/g, '"A concrete sentence."');
    await put(root, "brainforge/assets/lamp/asset.yaml", text);
    expectOk(await h.call("project.open", { path: root }));
    const at = { project: root };
    const requestedPolicyHash = expectOk(await h.call("settings.inspect", {}, at)).policy.requestedPolicyHash;
    expectOk(await h.call("policy.authorize", { requestedPolicyHash }, at));
    const open = h.registry.get(root)!;
    let shade = 20;
    const seed = async (id: string, stepId: string, branchId: string | undefined): Promise<void> => {
      const png = makePng(16, 16, [shade++, 60, 60]);
      const rel = `brainforge/assets/lamp/work/candidates/${id}/original/out.png`;
      await put(root, rel, png);
      open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, started_by, created_at) VALUES (?, 'lamp', ?, 'p', '{}', 'human:local', ?)").run(`run_${id}`, stepId, NOW);
      open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'lamp', ?, 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, stepId, `identity-${id}`, NOW, NOW);
      open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, 'lamp', ?, ?, ?, 'A', 'p', 0, ?, ?)").run(id, stepId, `run_${id}`, `job_${id}`, NOW, branchId ?? null);
      open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'untouched', ?, ?, ?, 16, 16, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha256(png));
    };
    await seed("cand_c", "concept", undefined);
    const branchId = expectOk(await h.call("concept.lock", { assetId: "lamp", candidateId: "cand_c", outputId: "out_cand_c" }, at)).branch.branchId;
    await seed("cand_front", "front-view", branchId);
    const m = expectOk(await h.call("review.material", { candidateId: "cand_front" }, at));
    expectOk(await h.call("review.decide", { candidateId: "cand_front", outputIds: ["out_cand_front"], requirementsHash: m.requirementsHash, decision: "approve", reasons: [] }, at));
    const plan = expectOk(await h.call("promotion.plan", { assetId: "lamp" }, at)).plan;
    expect(plan.blockers).toEqual([]);
  });
});

describe("motion for non-character families", () => {
  const effect = (alpha: "transparent" | "opaque"): string => `schema: brainforge.asset.v2
id: smoke
name: Smoke
family: effect
description: A rising column of grey smoke.
deliverables:
  - { id: burst, kind: still, description: The smoke at full height., output: { alpha: ${alpha}, width: 512, height: 512 } }
  - { id: plume, kind: animation, dependsOn: [burst], description: The column rises and thins., animation: { motion: The smoke column rises and thins out., loop: false }, output: { alpha: ${alpha}, width: 512, height: 512 } }
`;
  const succeeded = (jobs: { state: string }[]): boolean => jobs.length > 0 && jobs.every((j) => j.state === "succeeded");

  async function run(alpha: "transparent" | "opaque") {
    const f = await generationFixture({ fake: { latencyMs: 5 } });
    fixtures.push(f);
    await put(f.root, "brainforge/assets/smoke/asset.yaml", effect(alpha));
    const call = <K extends OperationName>(name: K, input: unknown) => f.h.call(name, input, { project: f.root });
    const generate = async (stepId: string, branchId?: string) => {
      const plan = expectOk(await call("generation.plan", { assetId: "smoke", stepId, count: 1, ...(branchId ? { branchId } : {}) })).plan;
      expect(plan.blockers).toEqual([]);
      expectOk(await call("generation.start", { planId: plan.planId, planHash: plan.planHash }));
      await f.waitJobs((jobs) => succeeded(jobs.filter((j) => j.stepId === stepId)), stepId);
      return { plan, candidates: expectOk(await call("candidate.list", { assetId: "smoke", stepId, ...(branchId ? { branchId } : {}) })).candidates };
    };
    const concept = (await generate("concept")).candidates[0]!;
    const branchId = expectOk(await call("concept.lock", { assetId: "smoke", candidateId: concept.candidateId, outputId: concept.outputs.find((o) => o.role === "matted")!.outputId })).branch.branchId;
    const burst = await generate("burst", branchId);
    const out = burst.candidates[0]!.outputs[0]!;
    expectOk(await call("candidate.select", { branchId, deliverableId: "burst", candidateId: burst.candidates[0]!.candidateId, outputId: out.outputId }));
    const m = expectOk(await call("review.material", { candidateId: burst.candidates[0]!.candidateId }));
    expectOk(await call("review.decide", { candidateId: burst.candidates[0]!.candidateId, outputIds: [out.outputId], requirementsHash: m.requirementsHash, decision: "approve" }));
    return { f, branchId, burst, generate };
  }

  test("an opaque effect animates from a still guide with no standing height, saving only the untouched frames", async () => {
    const { burst, generate, f } = await run("opaque");
    expect(burst.plan.workflow.id).toBe("krea2-variation-opaque");
    expect(burst.candidates[0]?.outputs.map((o) => o.role)).toEqual(["untouched"]);
    expect(burst.plan.submissions[0]?.values).toMatchObject({ width: 512, height: 512 });
    expect(burst.plan.prompt.split("\n").at(-1)).toBe(framingFor("effect", "opaque"));
    const branchId = burst.candidates[0]!.branchId!;
    const plume = await generate("plume", branchId);
    expect(plume.plan.workflow.id).toBe("wan22-motion-opaque");
    expect(plume.plan.prompt).toContain("Static camera, the scene fills the whole frame.");
    expect(plume.plan.motion).toMatchObject({ loop: false, closingFrame: "keep" });
    expect(plume.plan.notes.join(" ")).toContain("Whole-frame scale");
    expect(plume.plan.notes.join(" ")).toContain("Target output 512x512px. Wan renders 768x768px");
    expect(plume.candidates[0]?.outputs.map((o) => [o.role, o.mediaKind, o.frameCount])).toEqual([["untouched", "frames", 33]]);
    expect(f.fake.submissionCount()).toBe(3);
  });

  test("a transparent effect is matted and still needs no standing height", async () => {
    const { burst, generate } = await run("transparent");
    expect(burst.plan.workflow.id).toBe("krea2-variation");
    const plume = await generate("plume", burst.candidates[0]!.branchId!);
    expect(plume.plan.workflow.id).toBe("wan22-motion");
    expect(plume.plan.prompt).toContain("Static camera, flat plain light-grey background, the subject stays in place.");
    expect(plume.candidates[0]?.outputs.map((o) => o.role)).toEqual(["untouched", "matted"]);
  });
});

async function seedConcept(f: GenerationFixture): Promise<void> {
  const open = f.h.registry.get(f.root)!;
  const png = makePng(16, 16, [90, 60, 60]);
  const rel = "brainforge/assets/cortex/work/candidates/cand_c/original/out.png";
  await put(f.root, rel, png);
  open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, started_by, created_at) VALUES ('run_c', 'cortex', 'concept', 'p', '{}', 'human:local', ?)").run(NOW);
  open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES ('job_c', 'run_c', 'cortex', 'concept', 0, 'A', 'identity-c', 'succeeded', '{}', ?, ?)").run(NOW, NOW);
  open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES ('cand_c', 'cortex', 'concept', 'run_c', 'job_c', 'A', 'p', 0, ?, NULL)").run(NOW);
  open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES ('out_cand_c', 'cand_c', 'matted', 'out_cand_c', ?, ?, 16, 16, 'image/png')").run(rel, sha256(png));
}

/** The Cortex fixture's concept prompt as the first release composed it (captured before the family catalog existed). */
const CORTEX_PROMPT = [
  "A guarded teenager with an exposed brain.",
  "A single character alone in the frame, one figure only. The entire figure is fully visible with generous margin on every side. Flat plain light-grey background, no props, no text.",
].join("\n");
