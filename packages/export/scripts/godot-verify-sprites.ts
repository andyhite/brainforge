/**
 * Export-format acceptance for UI/icon sprite sets, once-playing effects and opaque tiles against a real Godot 4.3+:
 * exports a nine-slice UI state set and an icon sheet (both packed into sprite atlases), a loop:false effect
 * animation and an opaque tile with a TileSet into a disposable Godot project, imports it headless, opens every
 * generated resource and compares what Godot reports (atlas regions, StyleBoxTexture margins, loop flags, frame
 * counts, tile data) with sprites.json and the exported files. Prints the evidence; exit 1 on any mismatch.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkGodotRoot, commitExport, prepareExport, type ExportAsset } from "../src/index.ts";
import { animationDeliverable, makeInput, stillDeliverable } from "../tests/fixtures.ts";
import { GODOT, RES, check, errorLines, failures, godot, keep } from "./godot-common.ts";

const CUR = `${RES}/current/assets`;

const base = await mkdtemp(path.join(tmpdir(), "bf-godot-sprites-"));
const project = path.join(base, "game");
const dest = path.join(project, "assets", "brainforge");

const CHECK_GD = `extends SceneTree

func rect(r: Rect2) -> Array:
	return [r.position.x, r.position.y, r.size.x, r.size.y]

func fail(msg: String) -> void:
	print("BF_ERROR " + msg)
	quit(1)

func _init() -> void:
	run()

func atlas_of(tex: Texture2D) -> Dictionary:
	var at := tex as AtlasTexture
	if at == null:
		return {"class": tex.get_class()}
	return {"class": "AtlasTexture", "region": rect(at.region), "atlas": at.atlas.resource_path}

func run() -> void:
	var out := {}
	for pair in ${JSON.stringify([["hud-states", ["button-normal", "button-pressed", "button-disabled"]], ["icons", ["icon-heart", "icon-star", "icon-bolt"]]])}:
		var asset: String = pair[0]
		var textures := {}
		var boxes := {}
		for id in pair[1]:
			var tex := load("${CUR}/%s/godot/textures/%s.tres" % [asset, id]) as AtlasTexture
			if tex == null:
				return fail("%s/%s texture did not load as AtlasTexture" % [asset, id])
			textures[id] = {"region": rect(tex.region), "atlas": tex.atlas.resource_path, "state": tex.get_meta("state", "")}
			var box_path := "${CUR}/%s/godot/styleboxes/%s.tres" % [asset, id]
			if ResourceLoader.exists(box_path):
				var sb := load(box_path) as StyleBoxTexture
				if sb == null:
					return fail("%s did not load as StyleBoxTexture" % box_path)
				var info := atlas_of(sb.texture)
				info["margins"] = [sb.texture_margin_left, sb.texture_margin_top, sb.texture_margin_right, sb.texture_margin_bottom]
				boxes[id] = info
		out[asset] = {"textures": textures, "styleboxes": boxes}

	var sf := load("${CUR}/fx/godot/animations.tres") as SpriteFrames
	if sf == null:
		return fail("fx animations.tres did not load as SpriteFrames")
	var anims := {}
	for name in sf.get_animation_names():
		anims[name] = {"loop": sf.get_animation_loop(name), "speed": sf.get_animation_speed(name), "frames": sf.get_frame_count(name), "first_duration": sf.get_frame_duration(name, 0)}
	out["fx"] = anims

	var ts := load("${CUR}/tiles/godot/tilesets/ground.tres") as TileSet
	if ts == null:
		return fail("ground.tres did not load as TileSet")
	var src := ts.get_source(ts.get_source_id(0)) as TileSetAtlasSource
	out["tiles"] = {"tile_size": [ts.tile_size.x, ts.tile_size.y], "tiles": src.get_tiles_count(), "texture": src.texture.resource_path}
	print("BF_RESULT " + JSON.stringify(out))
	quit()
`;

interface SpritesJson { atlasPages: { page: number; file: string }[]; sprites: { id: string; state: string; page: number; x: number; y: number; width: number; height: number; nineSlice?: { left: number; top: number; right: number; bottom: number } }[] }
interface Info { region: number[]; atlas: string; state: string }
interface BoxInfo { class: string; region?: number[]; atlas?: string; margins: number[] }
interface Result {
  "hud-states": { textures: Record<string, Info>; styleboxes: Record<string, BoxInfo> };
  icons: { textures: Record<string, Info>; styleboxes: Record<string, BoxInfo> };
  fx: Record<string, { loop: boolean; speed: number; frames: number; first_duration: number }>;
  tiles: { tile_size: number[]; tiles: number; texture: string };
}

try {
  console.log(`Godot: ${(await new Response(Bun.spawn([GODOT, "--version"], { stdout: "pipe" }).stdout).text()).trim()}`);
  console.log(`Project: ${project}\n`);
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(project, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="bf-sprites-verify"\nconfig/features=PackedStringArray("4.3")\n');
  await writeFile(path.join(project, "check.gd"), CHECK_GD);

  const o = { sourceDir: path.join(base, "src"), exportId: "exp-1", versionId: "ver-1" };
  const nine = { left: 3, top: 4, right: 5, bottom: 6 };
  const asset = (assetId: string, family: string, sprites: ExportAsset["sprites"], deliverables: ExportAsset["deliverables"]): ExportAsset =>
    ({ assetId, family, versionId: "ver-1", requirementsHash: `req-${assetId}`, dependencies: [], metadata: {}, ...(sprites ? { sprites } : {}), deliverables });
  const assets = [
    asset("hud-states", "ui", "atlas", [
      await stillDeliverable(o, "button-normal", "ui-state", { state: "normal", nineSlice: nine }, 24),
      await stillDeliverable(o, "button-pressed", "ui-state", { state: "pressed", nineSlice: nine }, 24),
      await stillDeliverable(o, "button-disabled", "ui-state", { state: "disabled", nineSlice: nine }, 32),
    ]),
    asset("icons", "icon", "both", [
      await stillDeliverable(o, "icon-heart", "variant", { state: "heart" }, 12),
      await stillDeliverable(o, "icon-star", "variant", { state: "star" }, 16),
      await stillDeliverable(o, "icon-bolt", "variant", { state: "bolt" }, 12),
    ]),
    asset("fx", "effect", undefined, [await animationDeliverable({ ...o, packaging: "both" }, "blast", false)]),
    asset("tiles", "tile", "atlas", [await stillDeliverable(o, "ground", "tile", { tile: { width: 8, height: 8 } }, 16)]),
  ];

  const target = await checkGodotRoot({ godotProjectRootAbs: project, destinationAbs: dest });
  if (!target.ok) throw new Error(target.blockers.map((b) => b.message).join("; "));
  const input = await makeInput({ ...o, preset: "godot4", godot: { projectRootAbs: project, resRootPrefix: target.resRootPrefix } }, assets);
  const prepared = await prepareExport({ destinationAbs: dest, input });
  await commitExport({ destinationAbs: dest, intent: prepared.intent });

  const imp = await godot(project, ["--import"]);
  console.log(`--- godot --import ---\n${imp.trim()}\n`);
  check(errorLines(imp).length === 0, "headless import reports no errors", errorLines(imp));
  const run = await godot(project, ["--script", "res://check.gd"]);
  console.log(`--- godot --script check.gd ---\n${run.trim()}\n`);
  const line = run.split("\n").find((l) => l.startsWith("BF_RESULT "));
  check(line !== undefined && errorLines(run).length === 0, "every generated resource loads in Godot", errorLines(run));
  if (!line) throw new Error(`Godot could not open the generated resources:\n${errorLines(run).join("\n") || run}`);
  const r = JSON.parse(line.slice("BF_RESULT ".length)) as Result;

  for (const assetId of ["hud-states", "icons"] as const) {
    const sheet = JSON.parse(await readFile(path.join(dest, "current/assets", assetId, "sprites/sprites.json"), "utf8")) as SpritesJson;
    check(sheet.sprites.length === 3, `${assetId}: sprites.json lists 3 sprites`, sheet.sprites.map((s) => s.id));
    for (const s of sheet.sprites) {
      const tex = r[assetId].textures[s.id]!;
      const want = [s.x, s.y, s.width, s.height];
      check(JSON.stringify(tex.region) === JSON.stringify(want) && tex.atlas === `${CUR}/${assetId}/sprites/atlas-${s.page}.png` && tex.state === s.state, `${assetId}/${s.id}: Godot AtlasTexture region ${JSON.stringify(tex.region)} = sprites.json rect, state "${tex.state}"`, { godot: tex, sheet: s });
      const box = r[assetId].styleboxes[s.id];
      if (s.nineSlice) {
        const m = [s.nineSlice.left, s.nineSlice.top, s.nineSlice.right, s.nineSlice.bottom];
        check(box !== undefined && JSON.stringify(box.margins) === JSON.stringify(m) && box.class === "AtlasTexture" && JSON.stringify(box.region) === JSON.stringify(want), `${assetId}/${s.id}: StyleBoxTexture margins ${JSON.stringify(box?.margins)} on atlas region ${JSON.stringify(box?.region)}`, { godot: box, sheet: s });
      } else {
        check(box === undefined, `${assetId}/${s.id}: no StyleBoxTexture without nine-slice`);
      }
    }
  }
  const individual = (await Bun.file(path.join(dest, "current/assets/icons/stills/icon-heart.png")).exists()) && !(await Bun.file(path.join(dest, "current/assets/hud-states/stills/button-normal.png")).exists());
  check(individual, "icons (both) keep individual PNGs; hud-states (atlas-only) does not");

  const blast = r.fx.blast;
  check(blast !== undefined && blast.loop === false && blast.frames === 3 && blast.speed === 12, `effect "blast": loop=${blast?.loop}, frames=${blast?.frames}, speed=${blast?.speed}`, blast);
  check(r.tiles.tiles === 4 && JSON.stringify(r.tiles.tile_size) === "[8,8]" && r.tiles.texture === `${CUR}/tiles/stills/ground.png`, `opaque tile: TileSet tile_size ${JSON.stringify(r.tiles.tile_size)}, ${r.tiles.tiles} tiles on ${r.tiles.texture}`, r.tiles);

  console.log(failures === 0 ? "\nALL GODOT SPRITE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
} finally {
  if (keep) console.log(`kept ${base}`);
  else await rm(base, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
