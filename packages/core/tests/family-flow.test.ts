import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssetFamily, Candidate, ExportPlan, OperationName } from "@brainforge/contracts";
import { parseAuthored } from "../src/authored.ts";
import { generationFixture, type GenerationFixture } from "./generation-fixture.ts";
import { decodeRgba } from "@brainforge/media";
import { buildPipeline } from "../src/pipeline.ts";
import { expectOk, put } from "./helpers.ts";

setDefaultTimeout(120_000);

const PROJECT = (preset: "generic" | "godot4" = "generic") => `schema: brainforge.project.v2
id: demo
name: Demo
defaults:
  sizing: { width: 64, height: 64 }
  animation: { playbackFps: 12 }
familyDefaults:
  creature:
    sizing: { width: 128, height: 128, subjectHeightPx: 100 }
export:
  preset: ${preset}
  destination: assets/brainforge
`;

const open: GenerationFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.dispose();
});

export async function game(): Promise<GenerationFixture> {
  const f = await generationFixture({ fake: { latencyMs: 3 }, projectYaml: PROJECT() });
  open.push(f);
  await put(f.root, "project.godot", "config_version=5\n");
  return f;
}

const call = <K extends OperationName>(f: GenerationFixture, name: K, input: unknown) => f.h.call(name, input, { project: f.root });
const succeeded = (jobs: { state: string }[]) => jobs.length > 0 && jobs.every((j) => j.state === "succeeded");
const concrete = (text: string): string => text.replace(/"REPLACE: [^"]*"/g, '"A concrete sentence of art."');

/** Author an asset from `family.template` through spec.write (exclusive create). */
export async function author(f: GenerationFixture, family: AssetFamily, id: string, edit: (text: string) => string = (t) => t): Promise<string> {
  const tpl = expectOk(await call(f, "family.template", { family, id, name: id }));
  const text = edit(concrete(tpl.text));
  const written = expectOk(await call(f, "spec.write", { path: tpl.path, text, expectedHash: null }));
  expect(written.problems.filter((p) => p.severity !== "warning")).toEqual([]);
  return text;
}

export function deliverablesOfSpec(text: string, id: string) {
  const file = parseAuthored("asset", `brainforge/assets/${id}/asset.yaml`, id, text);
  if (file.kind !== "asset" || !file.spec) throw new Error(`bad asset ${id}`);
  return file.spec;
}

export const deliverablesOf = (text: string, id: string) => deliverablesOfSpec(text, id).deliverables;

async function generate(f: GenerationFixture, assetId: string, stepId: string, branchId?: string): Promise<Candidate> {
  expectOk(await call(f, "budget.grant", { assetId, stepId, maxStarts: 3, maxCandidateSubmissions: 6, expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  const plan = expectOk(await call(f, "generation.plan", { assetId, stepId, count: 1, ...(branchId ? { branchId } : {}) })).plan;
  expect(plan.blockers).toEqual([]);
  const before = (await f.jobs()).filter((j) => j.assetId === assetId && j.stepId === stepId).length;
  expectOk(await call(f, "generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: plan.budgets[0]!.budgetId }));
  await f.waitJobs((jobs) => { const mine = jobs.filter((j) => j.assetId === assetId && j.stepId === stepId); return mine.length > before && succeeded(mine); }, `${assetId}/${stepId}`);
  const list = expectOk(await call(f, "candidate.list", { assetId, stepId, ...(branchId ? { branchId } : {}) })).candidates;
  return list.at(-1)!;
}

async function approve(f: GenerationFixture, candidateId: string, outputId: string): Promise<void> {
  const m = expectOk(await call(f, "review.material", { candidateId }));
  expectOk(await call(f, "review.decide", { candidateId, outputIds: [outputId], requirementsHash: m.requirementsHash, decision: "approve" }));
}

const primary = (c: Candidate) => c.outputs.find((o) => o.role === "matted") ?? c.outputs.find((o) => o.role === "untouched")!;

export interface ProduceOptions {
  skipOptional?: boolean;
  recipes?: Record<string, Record<string, unknown>>;
  /** Called with the text once the concept is locked, to bind the child to a direction before deliverables. */
  afterLock?: (branchId: string) => Promise<string>;
}

export interface Produced { branchId: string; versionId: string; processed: Record<string, { candidateId: string; outputId: string }>; skipped: string[] }

/** concept → lock → deliverables (generate, select+approve raw, process, select+approve processed) → promote → activate. */
export async function produce(f: GenerationFixture, assetId: string, text: string, options: ProduceOptions = {}): Promise<Produced> {
  const concept = await generate(f, assetId, "concept");
  const branchId = expectOk(await call(f, "concept.lock", { assetId, candidateId: concept.candidateId, outputId: primary(concept).outputId })).branch.branchId;
  if (options.afterLock) text = await options.afterLock(branchId);
  const processed: Produced["processed"] = {};
  const skipped: string[] = [];
  for (const d of deliverablesOf(text, assetId)) {
    if (options.skipOptional && d.required === false) { skipped.push(d.id); continue; }
    const candidate = await generate(f, assetId, d.id, branchId);
    const raw = primary(candidate);
    expectOk(await call(f, "candidate.select", { branchId, deliverableId: d.id, candidateId: candidate.candidateId, outputId: raw.outputId }));
    await approve(f, candidate.candidateId, raw.outputId);
    const plan = expectOk(await call(f, "processing.plan", { candidateId: candidate.candidateId, outputId: raw.outputId, recipe: options.recipes?.[d.id] ?? {} })).plan;
    expect(plan.blockers).toEqual([]);
    const out = expectOk(await call(f, "processing.start", { planId: plan.planId, planHash: plan.planHash })).output;
    expectOk(await call(f, "candidate.select", { branchId, deliverableId: d.id, candidateId: candidate.candidateId, outputId: out.outputId }));
    await approve(f, candidate.candidateId, out.outputId);
    processed[d.id] = { candidateId: candidate.candidateId, outputId: out.outputId };
  }
  const versionId = await promoteAndActivate(f, assetId, branchId);
  return { branchId, versionId, processed, skipped };
}

export async function promoteAndActivate(f: GenerationFixture, assetId: string, branchId: string, requestId = `promote-${assetId}-0001`): Promise<string> {
  const plan = expectOk(await call(f, "promotion.plan", { assetId, branchId })).plan;
  expect(plan.blockers).toEqual([]);
  const versionId = expectOk(await call(f, "promotion.start", { planId: plan.planId, planHash: plan.planHash, requestId })).version.versionId;
  const { active } = expectOk(await call(f, "version.list", { assetId }));
  expectOk(await call(f, "version.activate", { versionId, expectedRevision: active.revision, acknowledgeObsolete: true }));
  return versionId;
}

export async function exportBoth(f: GenerationFixture, input: Record<string, unknown> = {}): Promise<{ generic: string; godot: string }> {
  const root = join(f.root, "assets/brainforge/current");
  const run = async (preset: "generic" | "godot4", requestId: string): Promise<string> => {
    await put(f.root, "brainforge/project.yaml", PROJECT(preset));
    const plan: ExportPlan = expectOk(await call(f, "export.plan", input)).plan;
    expect(plan.blockers).toEqual([]);
    expectOk(await call(f, "export.start", { planId: plan.planId, planHash: plan.planHash, requestId }));
    return root;
  };
  const generic = await run("generic", "export-generic-0001");
  const snapshot = join(f.root, "generic-snapshot");
  await cp(generic, snapshot, { recursive: true, dereference: true });
  expect((await listing(snapshot)).some((p) => p.includes("/godot/"))).toBe(false);
  const godot = await run("godot4", "export-godot-0001");
  return { generic: snapshot, godot };
}

export async function listing(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await listing(join(dir, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}

export const readJson = async <T = Record<string, any>>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

const out = (root: string, ...rel: string[]): string => join(root, ...rel);
const text = (root: string, ...rel: string[]): Promise<string> => readFile(out(root, ...rel), "utf8");
const framesOf = async (dir: string): Promise<string[]> => (await readdir(join(dir, "frames"))).sort();
const pixels = async (file: string) => decodeRgba(await readFile(file));
const alphaAt = (img: { data: Uint8Array; width: number }, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3]!;

async function allOpaque(file: string): Promise<boolean> {
  const img = await pixels(file);
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
  return true;
}

describe("family flow: template → concept → lock → deliverables → process → promote → activate → both presets", () => {
  test("creature: locomotion loop through a pose guide, scale-anchored, exported as frames, atlas and SpriteFrames", async () => {
    const f = await game();
    const yaml = await author(f, "creature", "newt");
    const made = await produce(f, "newt", yaml);
    expect(Object.keys(made.processed)).toEqual(["side-view", "walk-contact", "walk"]);
    const { generic, godot } = await exportBoth(f);

    const asset = await readJson(out(generic, "assets/newt/asset.json"));
    expect(asset).toMatchObject({ family: "creature", versionId: made.versionId });
    expect(asset.deliverables.map((d: { deliverableId: string }) => d.deliverableId).sort()).toEqual(["side-view", "walk", "walk-contact"]);
    const anim = await readJson(out(generic, "assets/newt/animations/walk/animation.json"));
    // 33 source frames, closing guide frame excluded: 32 frames = 2000 ms at 12 fps => 24 frames
    expect(anim).toMatchObject({ schema: "brainforge.animation.v2", sourceFps: 16, playbackFps: 12, loop: true, canvas: { width: 128, height: 128 } });
    expect(anim.frames).toHaveLength(24);
    expect(anim.frames.reduce((n: number, fr: { durationMs: number }) => n + fr.durationMs, 0)).toBeCloseTo(2000, 3);
    expect(await framesOf(out(generic, "assets/newt/animations/walk"))).toHaveLength(24);
    const frames = await text(godot, "assets/newt/godot/animations.tres");
    expect(frames).toContain('[gd_resource type="SpriteFrames"');
    expect(frames).toContain('"loop": true');
    expect(frames).toContain("speed");
    expect(await listing(out(godot, "assets/newt/godot"))).toContain("textures/side-view.tres");
  });

  test("item with variants: stills only, no motion steps, one AtlasTexture per variant", async () => {
    const f = await game();
    const yaml = await author(f, "item", "gem");
    const made = await produce(f, "gem", yaml);
    const steps = expectOk(await call(f, "step.list", { assetId: "gem", branchId: made.branchId })).steps;
    expect(steps.some((s) => s.kind === "animation")).toBe(false);
    const { generic, godot } = await exportBoth(f);
    const asset = await readJson(out(generic, "assets/gem/asset.json"));
    expect(asset.deliverables.map((d: { deliverableId: string; kind: string }) => [d.deliverableId, d.kind]).sort()).toEqual([["front-view", "view"], ["side-view", "view"], ["worn", "variant"]]);
    expect((await listing(generic)).filter((p) => p.includes("animations"))).toEqual([]);
    expect((await listing(godot)).filter((p) => p.includes("animations"))).toEqual([]);
    expect(await text(godot, "assets/gem/godot/textures/worn.tres")).toContain('metadata/kind = "variant"');
  });

  test("equipment: attachment points reach asset.json and the Godot resource metadata", async () => {
    const f = await game();
    const yaml = await author(f, "equipment", "blade");
    await produce(f, "blade", yaml);
    const { generic, godot } = await exportBoth(f);
    const asset = await readJson(out(generic, "assets/blade/asset.json"));
    expect(asset.metadata.attachments).toEqual([{ name: "grip", x: 256, y: 384, deliverable: "front-view", nx: 0.5, ny: 0.75 }]);
    expect(asset.deliverables.find((d: { deliverableId: string }) => d.deliverableId === "front-view").metadata.attachments).toEqual([{ name: "grip", x: 256, y: 384, nx: 0.5, ny: 0.75 }]);
    const tex = await text(godot, "assets/blade/godot/textures/front-view.tres");
    expect(tex).toContain('"attachments"');
    expect(tex).toContain('"name": "grip"');
    expect(tex).toContain('"ny": 0.75');
    expect(await text(godot, "assets/blade/godot/textures/side-view.tres")).not.toContain("attachments");
  });

  test("prop: static has no motion steps; an optional animation never blocks; a produced one exports as SpriteFrames", async () => {
    const staticYaml = await (async () => {
      const f = await game();
      const yaml = (await author(f, "prop", "crate", (t) => t.replace(/\n  # Optional motion[\s\S]*$/, "\n")));
      expect(deliverablesOf(yaml, "crate").some((d) => d.kind === "animation")).toBe(false);
      const made = await produce(f, "crate", yaml);
      expect(expectOk(await call(f, "step.list", { assetId: "crate", branchId: made.branchId })).steps.some((s) => s.kind === "animation")).toBe(false);
      const { generic } = await exportBoth(f);
      expect((await listing(generic)).some((p) => p.includes("animations/"))).toBe(false);
      return yaml;
    })();
    expect(staticYaml).not.toContain("idle-loop");

    const skipped = await game();
    const yaml = await author(skipped, "prop", "lamp");
    expect(buildPipeline(deliverablesOfSpec(yaml, "lamp")).nodes.filter((n) => n.kind === "animation").map((n) => n.required)).toEqual([false]);
    const partial = await produce(skipped, "lamp", yaml, { skipOptional: true });
    expect(partial.skipped).toEqual(["active-state", "idle-loop"]);
    const first = await exportBoth(skipped);
    expect((await listing(first.generic)).some((p) => p.includes("animations/"))).toBe(false);

    const full = await game();
    const fullYaml = await author(full, "prop", "lamp2");
    await produce(full, "lamp2", fullYaml);
    const { generic, godot } = await exportBoth(full);
    expect(await readJson(out(generic, "assets/lamp2/animations/idle-loop/animation.json"))).toMatchObject({ loop: true, playbackFps: 12 });
    expect(await text(godot, "assets/lamp2/godot/animations.tres")).toContain("idle-loop");
  });

  test("tile: opaque to the edges, tile size, seamless axes, connections and mirror-repeat reach the export and the TileSet", async () => {
    const f = await game();
    const yaml = await author(f, "tile", "grass");
    const made = await produce(f, "grass", yaml, { recipes: { "base-tile": { tileRepeat: "mirror-xy" } } });
    const recipe = f.h.registry.getOpen(f.root)!.db.query<{ recipe_json: string }, [string]>("SELECT recipe_json FROM candidate_outputs WHERE output_id = ?").get(made.processed["base-tile"]!.outputId)!;
    expect(JSON.parse(recipe.recipe_json)).toMatchObject({ tileRepeat: "mirror-xy", alpha: "preserve" });
    const sourceRoles = expectOk(await call(f, "candidate.list", { assetId: "grass", stepId: "base-tile", branchId: made.branchId })).candidates[0]!.outputs.filter((o) => o.stage === "source").map((o) => o.role);
    expect(sourceRoles).toEqual(["untouched"]);
    const { generic, godot } = await exportBoth(f);
    const asset = await readJson(out(generic, "assets/grass/asset.json"));
    expect(asset.deliverables[0].tile).toEqual({ width: 64, height: 64, connections: { north: "ground", east: "ground", south: "ground", west: "ground" }, seamlessAxes: ["x", "y"] });
    const file = out(generic, "assets/grass/stills/base-tile.png");
    expect(await allOpaque(file)).toBe(true);
    const img = await pixels(file);
    for (const [x, y] of [[0, 0], [3, 40], [100, 200]] as const) {
      const at = (px: number, py: number) => [...img.data.subarray((py * img.width + px) * 4, (py * img.width + px) * 4 + 4)];
      expect(at(x, y)).toEqual(at(img.width - 1 - x, y));
      expect(at(x, y)).toEqual(at(x, img.height - 1 - y));
    }
    const tiles = await text(godot, "assets/grass/godot/tilesets/base-tile.tres");
    expect(tiles).toContain("texture_region_size = Vector2i(64, 64)");
    expect(tiles).toContain('"seamlessAxes": ["x", "y"]');
  });

  test("ui: states keep their nine-slice margins in StyleBoxTexture, and a sprite atlas lists every state", async () => {
    const f = await game();
    const yaml = await author(f, "ui", "hud", (t) => `${t}export:\n  sprites: both\n`);
    await produce(f, "hud", yaml);
    const { generic, godot } = await exportBoth(f);
    const asset = await readJson(out(generic, "assets/hud/asset.json"));
    expect(asset.deliverables.map((d: { state: string }) => d.state).sort()).toEqual(["normal", "pressed"]);
    for (const state of ["normal", "pressed"]) {
      const box = await text(godot, `assets/hud/godot/styleboxes/panel-${state}.tres`);
      expect(box).toContain('[gd_resource type="StyleBoxTexture"');
      for (const side of ["left", "top", "right", "bottom"]) expect(box).toContain(`texture_margin_${side} = 24.0`);
    }
    const sprites = await readJson(out(generic, "assets/hud/sprites/sprites.json"));
    expect(sprites.sprites.map((s: { id: string }) => s.id).sort()).toEqual(["panel-normal", "panel-pressed"]);
    expect(sprites.sprites[0].nineSlice).toEqual({ left: 24, top: 24, right: 24, bottom: 24 });
    expect(await allOpaque(out(generic, "assets/hud/stills/panel-normal.png"))).toBe(true);
    expect(await listing(generic)).toContain("assets/hud/sprites/atlas-0.png");
  });

  test("icon: transparent glyph and a disabled state, atlas-only packaging drops the individual PNGs", async () => {
    const f = await game();
    const yaml = await author(f, "icon", "pip", (t) => `${t}export:\n  sprites: atlas\n`);
    await produce(f, "pip", yaml);
    const { generic } = await exportBoth(f);
    const files = await listing(generic);
    expect(files).toContain("assets/pip/sprites/sprites.json");
    expect(files.some((p) => p.startsWith("assets/pip/stills/"))).toBe(false);
    const sprites = await readJson(out(generic, "assets/pip/sprites/sprites.json"));
    expect(sprites.sprites.map((s: { id: string }) => s.id).sort()).toEqual(["icon-default", "icon-disabled"]);
    const page = await pixels(out(generic, "assets/pip/sprites", "atlas-0.png"));
    expect([...page.data.subarray(0, 4)][3]).toBe(0);
  });

  test("effect: a transparent once-playing animation exports loop:false; the opaque variant keeps edge contact with no matte", async () => {
    const transparent = await game();
    const yaml = await author(transparent, "effect", "smoke");
    await produce(transparent, "smoke", yaml);
    const t = await exportBoth(transparent);
    const anim = await readJson(out(t.generic, "assets/smoke/animations/plume/animation.json"));
    expect(anim.loop).toBe(false);
    expect(anim.frames).toHaveLength(25);
    const frame = await pixels(out(t.generic, "assets/smoke/animations/plume/frames/0000.png"));
    expect(alphaAt(frame, 0, 0)).toBe(0);
    expect(await text(t.godot, "assets/smoke/godot/animations.tres")).toContain('"loop": false');

    const opaque = await game();
    const opaqueYaml = await author(opaque, "effect", "flash", (x) => x.replaceAll("alpha: transparent", "alpha: opaque"));
    const made = await produce(opaque, "flash", opaqueYaml);
    const db = opaque.h.registry.getOpen(opaque.root)!.db;
    expect(db.query<{ role: string }, []>("SELECT DISTINCT role FROM candidate_outputs WHERE stage = 'source' AND candidate_id IN (SELECT candidate_id FROM candidates WHERE asset_id = 'flash' AND step_id != 'concept')").all().map((r) => r.role)).toEqual(["untouched"]);
    expect(JSON.parse(db.query<{ recipe_json: string }, [string]>("SELECT recipe_json FROM candidate_outputs WHERE output_id = ?").get(made.processed.plume!.outputId)!.recipe_json)).toMatchObject({ alpha: "preserve", loop: false });
    const o = await exportBoth(opaque);
    for (const n of ["0000", "0012", "0024"]) expect(await allOpaque(out(o.generic, "assets/flash/animations/plume/frames", `${n}.png`))).toBe(true);
    expect(await allOpaque(out(o.generic, "assets/flash/stills/burst.png"))).toBe(true);
    expect(await text(o.godot, "assets/flash/godot/animations.tres")).toContain('"loop": false');
  });

  test("environment: an aggregate pins background and tile versions, exports them, and a direction-bound child follows the environment branch", async () => {
    const f = await game();
    const envYaml = await author(f, "environment", "flat", (t) => t.replace("required: false", "required: true"));
    const roles = (branchId: string, deliverable: string) => (t: string) => t.replace(new RegExp(`(  - id: ${deliverable}\\n    kind: \\w+\\n)`), `$1    referenceRoles:\n      direction: { assetId: flat, branchId: ${branchId}, role: direction }\n`);
    const members: Record<string, string> = {};
    const made = await produce(f, "flat", envYaml, {
      afterLock: async (envBranch) => {
        const backdrop = await author(f, "background", "flat-backdrop", roles(envBranch, "backdrop"));
        const tile = await author(f, "tile", "flat-ground-tile", roles(envBranch, "base-tile"));
        members.backdrop = (await produce(f, "flat-backdrop", backdrop)).versionId;
        members.tile = (await produce(f, "flat-ground-tile", tile)).versionId;
        const plan = expectOk(await call(f, "generation.plan", { assetId: "flat-backdrop", stepId: "backdrop", count: 1, branchId: expectOk(await call(f, "branch.list", { assetId: "flat-backdrop" })).branches[0]!.branchId })).plan;
        expect(plan.directionPins).toHaveLength(1);
        expect(plan.directionPins[0]).toMatchObject({ assetId: "flat", branchId: envBranch });
        return envYaml;
      },
    });
    const { manifest } = expectOk(await call(f, "version.inspect", { versionId: made.versionId }));
    expect(manifest.members?.map((m) => [m.assetId, m.versionId, m.family])).toEqual([["flat-backdrop", members.backdrop!, "background"], ["flat-ground-tile", members.tile!, "tile"]]);

    const { generic, godot } = await exportBoth(f, { assetIds: ["flat"] });
    const asset = await readJson(out(generic, "assets/flat/asset.json"));
    expect(asset.metadata.members.map((m: { assetId: string; versionId: string }) => [m.assetId, m.versionId])).toEqual([["flat-backdrop", members.backdrop!], ["flat-ground-tile", members.tile!]]);
    const files = await listing(godot);
    expect(files).toContain("assets/flat-backdrop/stills/backdrop.png");
    expect(files).toContain("assets/flat-ground-tile/godot/tilesets/base-tile.tres");
    const backdrop = await readJson(out(generic, "assets/flat-backdrop/asset.json"));
    expect(backdrop.deliverables[0].metadata.environment).toMatchObject({ layer: "far", parallax: { x: 0.3, y: 0 }, seamlessAxes: ["x"] });
    expect(await allOpaque(out(generic, "assets/flat-backdrop/stills/backdrop.png"))).toBe(true);
  });
});
