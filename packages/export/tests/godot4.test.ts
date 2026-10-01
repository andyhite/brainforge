import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildSnapshot, checkGodotRoot, ExportError, type ExportInput } from "../src/index.ts";
import { characterAsset, makeInput, stillDeliverable, tempDir, writeText } from "./fixtures.ts";

const RES = "res://game/assets/brainforge";

async function build(over: { exportId: string; seed?: number; packaging?: "frames" | "atlas" | "both" }) {
  const base = await tempDir();
  const sourceDir = path.join(base, "src");
  const root = path.join(base, "out");
  await mkdir(root);
  const o = { sourceDir, preset: "godot4" as const, godot: { projectRootAbs: base, resRootPrefix: RES }, ...over };
  const extras = [
    await stillDeliverable(o, "panel", "ui-state", { nineSlice: { left: 3, top: 4, right: 5, bottom: 6 } }),
    await stillDeliverable(o, "grass", "tile", { tile: { width: 8, height: 8, connections: { north: "g", east: "g" }, seamlessAxes: ["x"] } }),
  ];
  const input: ExportInput = await makeInput(o, [await characterAsset(o, extras)]);
  const outcome = await buildSnapshot(input, root);
  const read = (rel: string): Promise<string> => readFile(path.join(root, rel), "utf8");
  return { base, root, input, outcome, read };
}

describe("godot4 resources", () => {
  test("SpriteFrames: named entries, loop flags, speed, relative durations, atlas rectangles, res:// paths", async () => {
    const { read } = await build({ exportId: "e1" });
    const text = await read("assets/cortex/godot/animations.tres");
    expect(text.startsWith('[gd_resource type="SpriteFrames" format=3]')).toBe(true);
    expect(text).not.toContain("uid=");
    expect(text).toContain(`path="${RES}/current/assets/cortex/animations/walk/atlas-0.png"`);
    expect(text).toContain('"name": &"walk"');
    expect(text).toContain('"name": &"idle"');
    expect(text).toContain('"speed": 12.0');
    expect(text).toContain('"loop": true');
    // 1000/12 ms at 12 fps -> exactly one animation frame; 100 ms at 12 fps -> 1.2
    expect(text).toContain('"duration": 1.0');
    expect(text).toContain('"duration": 1.2');
    expect(text).toContain('[sub_resource type="AtlasTexture" id="AtlasTexture_walk_0001"]');
    expect(text).toMatch(/AtlasTexture_walk_0001"\]\natlas = ExtResource\("atlas_walk_0"\)\nregion = Rect2\(16, 0, 16, 16\)/);
    expect(text).toMatch(/AtlasTexture_walk_0002"\]\natlas = ExtResource\("atlas_walk_0"\)\nregion = Rect2\(0, 16, 16, 16\)/);
    expect(text).toContain('metadata/animations = {');
    expect(text).toContain('"candidate_id": "cand-walk"');
    expect(text).toContain('"version_id": "ver-1"');
    expect(text).toContain('"pivot": Vector2(8.0, 14.0)');
    expect(text).toContain('"relative_scale": 1');
  });

  test("frames-only packaging points at frame PNG Texture2D resources", async () => {
    const { read } = await build({ exportId: "e1", packaging: "frames" });
    const text = await read("assets/cortex/godot/animations.tres");
    expect(text).toContain(`[ext_resource type="Texture2D" path="${RES}/current/assets/cortex/animations/walk/frames/0002.png" id="frame_walk_0002"]`);
    expect(text).not.toContain("AtlasTexture");
    expect(text).toContain('"texture": ExtResource("frame_walk_0002")');
  });

  test("stills get a full-image AtlasTexture; nine-slice gets exact margins; tiles get a TileSet", async () => {
    const { read, outcome } = await build({ exportId: "e1" });
    const tex = await read("assets/cortex/godot/textures/front.tres");
    expect(tex).toContain('[gd_resource type="AtlasTexture" format=3]');
    expect(tex).toContain(`path="${RES}/current/assets/cortex/stills/front.png"`);
    expect(tex).toContain("region = Rect2(0, 0, 16, 16)");

    const box = await read("assets/cortex/godot/styleboxes/panel.tres");
    expect(box).toContain('[gd_resource type="StyleBoxTexture" format=3]');
    for (const line of ["texture_margin_left = 3.0", "texture_margin_top = 4.0", "texture_margin_right = 5.0", "texture_margin_bottom = 6.0"]) expect(box).toContain(line);

    const tiles = await read("assets/cortex/godot/tilesets/grass.tres");
    expect(tiles).toContain('[gd_resource type="TileSet" format=3]');
    expect(tiles).toContain("texture_region_size = Vector2i(8, 8)");
    expect(tiles).toContain("tile_size = Vector2i(8, 8)");
    expect(tiles.match(/^\d+:\d+\/0 = 0$/gm)).toEqual(["0:0/0 = 0", "1:0/0 = 0", "0:1/0 = 0", "1:1/0 = 0"]);
    expect(tiles).toContain('"north": "g"');
    expect(tiles).toContain('metadata/seamless_axes = ["x"]');

    expect(outcome.manifest.assets[0]!.resourcePaths).toEqual([
      "assets/cortex/godot/animations.tres",
      "assets/cortex/godot/styleboxes/panel.tres",
      "assets/cortex/godot/textures/front.tres",
      "assets/cortex/godot/textures/grass.tres",
      "assets/cortex/godot/textures/panel.tres",
      "assets/cortex/godot/tilesets/grass.tres",
    ]);
    // No sidecars, ever.
    expect(outcome.ownedFiles.some((f) => /\.(uid|import)$/.test(f.path))).toBe(false);
  });

  test("resource text and ids are identical across exports with different export ids", async () => {
    const a = await build({ exportId: "export-one" });
    const b = await build({ exportId: "export-two" });
    for (const rel of a.outcome.manifest.assets[0]!.resourcePaths) expect(await b.read(rel)).toBe(await a.read(rel));
    expect(await a.read("assets/cortex/godot/animations.tres")).not.toContain("export-");
  });

  test("a nested godotProjectRoot yields res:// relative to the engine root", async () => {
    const game = await tempDir();
    const engine = path.join(game, "client");
    await writeText(path.join(engine, "project.godot"), "config_version=5\n");
    const ok = await checkGodotRoot({ godotProjectRootAbs: engine, destinationAbs: path.join(engine, "assets", "brainforge") });
    expect(ok).toEqual({ ok: true, resRootPrefix: "res://assets/brainforge" });
  });

  test("blockers are field-specific: missing project.godot, destination outside the engine root", async () => {
    const game = await tempDir();
    const engine = path.join(game, "client");
    await mkdir(engine);
    const noProject = await checkGodotRoot({ godotProjectRootAbs: engine, destinationAbs: path.join(engine, "out") });
    expect(noProject.ok === false && noProject.blockers.map((b) => b.field)).toEqual(["godotProjectRoot"]);
    await writeText(path.join(engine, "project.godot"), "");
    const outside = await checkGodotRoot({ godotProjectRootAbs: engine, destinationAbs: path.join(game, "assets", "brainforge") });
    expect(outside.ok === false && outside.blockers.map((b) => b.field)).toEqual(["destination"]);
  });

  test("godot4 without a Godot target is blocked on godotProjectRoot", async () => {
    const base = await tempDir();
    await mkdir(path.join(base, "out"));
    const input = await makeInput({ sourceDir: path.join(base, "src"), preset: "godot4" });
    const error = await buildSnapshot(input, path.join(base, "out")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).details.field).toBe("godotProjectRoot");
  });
});
