/**
 * Export-format acceptance against a real Godot 4.3+ install: exports into a disposable Godot project, imports it
 * headless, loads the generated resources and a human-owned scene, then replaces the export with a distinct version and
 * proves the same res:// paths now show the new data while unowned files and engine sidecars survive.
 *
 *   bun packages/export/scripts/godot-verify.ts [--keep]
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitExport, checkGodotRoot, prepareExport, type ExpectedCurrent, type ExportInput } from "../src/index.ts";
import { animationDeliverable, characterAsset, makeInput, stillDeliverable } from "../tests/fixtures.ts";

const GODOT = process.env.GODOT_BIN ?? "/Applications/Godot.app/Contents/MacOS/Godot";
const keep = process.argv.includes("--keep");
const RES = "res://assets/brainforge";
const CURRENT_RES = `${RES}/current/assets/cortex/godot`;

if (!(await access(GODOT).then(() => true, () => false))) {
  console.log(`SKIP: Godot not found at ${GODOT} (set GODOT_BIN); resource-open verification was not run.`);
  process.exit(0);
}

const base = await mkdtemp(path.join(tmpdir(), "bf-godot-"));
const project = path.join(base, "game");
const sourceDir = path.join(base, "src");
const dest = path.join(project, "assets", "brainforge");
let failures = 0;

const check = (ok: boolean, what: string, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

async function godot(args: string[]): Promise<string> {
  const proc = Bun.spawn([GODOT, "--headless", "--path", project, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 120_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  return `${out}${err}`;
}

// Headless --script runs print engine shutdown leak diagnostics for any scene/texture a script touched; those are not resource errors.
const SHUTDOWN_NOISE = /leaked at exit|still in use at exit/;
const errorLines = (text: string): string[] => text.split("\n").filter((l) => /(^|\s)(ERROR|SCRIPT ERROR|Parse Error|BF_ERROR)/.test(l) && !SHUTDOWN_NOISE.test(l));
const sha = async (file: string): Promise<string> => createHash("sha256").update(await readFile(file)).digest("hex");

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, childRel)));
    else out.push(childRel);
  }
  return out.sort();
}

const CHECK_GD = `extends SceneTree

func rect(r: Rect2) -> Array:
	return [r.position.x, r.position.y, r.size.x, r.size.y]

func fail(msg: String) -> void:
	print("BF_ERROR " + msg)
	quit(1)

func _init() -> void:
	run()

func run() -> void:
	var out := {}
	var sf := load("${CURRENT_RES}/animations.tres") as SpriteFrames
	if sf == null:
		return fail("could not load animations.tres as SpriteFrames")
	var anims := {}
	for name in sf.get_animation_names():
		var frames := []
		for i in sf.get_frame_count(name):
			var tex := sf.get_frame_texture(name, i)
			if tex == null:
				return fail("%s frame %d has no texture" % [name, i])
			var entry := {"duration": sf.get_frame_duration(name, i), "class": tex.get_class(), "w": tex.get_width(), "h": tex.get_height()}
			if tex is AtlasTexture:
				entry["region"] = rect(tex.region)
				entry["atlas"] = tex.atlas.resource_path
			else:
				entry["path"] = tex.resource_path
			frames.append(entry)
		anims[name] = {"speed": sf.get_animation_speed(name), "loop": sf.get_animation_loop(name), "frames": frames}
	out["animations"] = anims
	out["meta_walk"] = sf.get_meta("animations")["walk"]
	out["version"] = sf.get_meta("version_id")

	var still := load("${CURRENT_RES}/textures/front.tres") as AtlasTexture
	if still == null:
		return fail("could not load textures/front.tres as AtlasTexture")
	out["still"] = {"region": rect(still.region), "atlas": still.atlas.resource_path, "w": still.get_width()}

	var sb := load("${CURRENT_RES}/styleboxes/panel.tres") as StyleBoxTexture
	if sb == null:
		return fail("could not load styleboxes/panel.tres as StyleBoxTexture")
	out["stylebox"] = [sb.texture_margin_left, sb.texture_margin_top, sb.texture_margin_right, sb.texture_margin_bottom]

	var ts := load("${CURRENT_RES}/tilesets/grass.tres") as TileSet
	if ts == null:
		return fail("could not load tilesets/grass.tres as TileSet")
	var src := ts.get_source(ts.get_source_id(0)) as TileSetAtlasSource
	out["tileset"] = {"tile_size": [ts.tile_size.x, ts.tile_size.y], "sources": ts.get_source_count(), "region_size": [src.texture_region_size.x, src.texture_region_size.y], "tiles": src.get_tiles_count(), "texture": src.texture.resource_path, "connections": ts.get_meta("connections")}

	var scene := load("res://main.tscn") as PackedScene
	if scene == null:
		return fail("could not load main.tscn")
	var inst := scene.instantiate()
	var sprite := inst.get_node("Sprite") as AnimatedSprite2D
	out["scene"] = {"animation": str(sprite.animation), "frames": sprite.sprite_frames.get_frame_count(sprite.animation)}
	inst.free()

	print("BF_RESULT " + JSON.stringify(out))
	quit()
`;

const MAIN_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="SpriteFrames" path="${CURRENT_RES}/animations.tres" id="1"]

[node name="Main" type="Node2D"]

[node name="Sprite" type="AnimatedSprite2D" parent="."]
sprite_frames = ExtResource("1")
animation = &"walk"
`;

interface Result {
  animations: Record<string, { speed: number; loop: boolean; frames: { duration: number; class: string; region?: number[]; atlas?: string; path?: string; w: number; h: number }[] }>;
  meta_walk: Record<string, unknown>;
  version: string;
  still: { region: number[]; atlas: string; w: number };
  stylebox: number[];
  tileset: { tile_size: number[]; sources: number; region_size: number[]; tiles: number; texture: string; connections: Record<string, string> };
  scene: { animation: string; frames: number };
}

async function importAndLoad(label: string): Promise<Result> {
  const imp = await godot(["--import"]);
  console.log(`--- godot --import (${label}) ---\n${imp.trim()}\n`);
  check(errorLines(imp).length === 0, `${label}: headless import reports no errors`, errorLines(imp));
  const run = await godot(["--script", "res://check.gd"]);
  console.log(`--- godot --script check.gd (${label}) ---\n${run.trim()}\n`);
  const line = run.split("\n").find((l) => l.startsWith("BF_RESULT "));
  check(line !== undefined && errorLines(run).length === 0, `${label}: resources load in Godot`, errorLines(run));
  if (!line) throw new Error(`Godot could not open the generated resources (${label}):\n${errorLines(run).join("\n") || run}`);
  return JSON.parse(line.slice("BF_RESULT ".length)) as Result;
}

async function exportVersion(exportId: string, seed: number, frameCount: number, expected?: ExpectedCurrent): Promise<{ input: ExportInput; manifestSha256: string; carried: string[]; warnings: string[] }> {
  const o = { sourceDir: path.join(sourceDir, exportId), exportId, seed, frameCount, versionId: `ver-${exportId}`, packaging: "atlas" as const };
  const extras = [
    await stillDeliverable(o, "panel", "ui-state", { nineSlice: { left: 3, top: 4, right: 5, bottom: 6 } }),
    await stillDeliverable(o, "grass", "tile", { tile: { width: 8, height: 8, connections: { north: "g" } } }),
  ];
  const asset = await characterAsset(o, extras);
  const walk = asset.deliverables.find((d) => d.deliverableId === "walk")!;
  walk.candidateId = `cand-walk-${exportId}`;
  // idle exercises frames-only packaging (Texture2D frame PNGs) in real Godot; walk exercises atlas rectangles.
  asset.deliverables.splice(asset.deliverables.findIndex((d) => d.deliverableId === "idle"), 1, await animationDeliverable({ ...o, packaging: "frames" }, "idle", true));
  const check_ = await checkGodotRoot({ godotProjectRootAbs: project, destinationAbs: dest });
  if (!check_.ok) throw new Error(check_.blockers.map((b) => b.message).join("; "));
  const input = await makeInput({ ...o, preset: "godot4", godot: { projectRootAbs: project, resRootPrefix: check_.resRootPrefix } }, [asset]);
  const prepared = await prepareExport({ destinationAbs: dest, input, ...(expected ? { expectedCurrent: expected } : {}) });
  const committed = await commitExport({ destinationAbs: dest, intent: prepared.intent });
  return { input, manifestSha256: committed.manifestSha256, carried: prepared.intent.carried.map((f) => f.path), warnings: [...prepared.warnings, ...committed.warnings] };
}

try {
  console.log(`Godot: ${(await new Response(Bun.spawn([GODOT, "--version"], { stdout: "pipe" }).stdout).text()).trim()}`);
  console.log(`Project: ${project}\n`);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="bf-export-verify"\nconfig/features=PackedStringArray("4.3")\n');
  await writeFile(path.join(project, "check.gd"), CHECK_GD);
  await writeFile(path.join(project, "main.tscn"), MAIN_TSCN);
  const sceneHash = await sha(path.join(project, "main.tscn"));
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, "human-notes.txt"), "root-level human file\n");

  // ---- export 1, import, load
  const first = await exportVersion("exp-1", 1, 3);
  console.log(`export 1 committed; current -> ${await Bun.$`readlink ${path.join(dest, "current")}`.text()}`.trim());
  const r1 = await importAndLoad("export 1");
  check(Object.keys(r1.animations).sort().join() === "idle,walk", "SpriteFrames has named animations idle and walk", Object.keys(r1.animations));
  check(r1.animations.idle?.frames.length === 3 && r1.animations.idle.frames.every((f) => f.class !== "AtlasTexture" && f.w === 16 && f.path?.includes("/idle/frames/000")), "idle (frames packaging): 3 Texture2D frame PNGs", r1.animations.idle?.frames.map((f) => f.path));
  check(r1.animations.walk?.frames.length === 3 && r1.animations.walk.speed === 12 && r1.animations.walk.loop === true, "walk: 3 frames, speed 12, loop", r1.animations.walk);
  const w1 = r1.animations.walk!.frames;
  check(w1.every((f) => f.class === "AtlasTexture" && f.w === 16 && f.h === 16), "walk frames are 16x16 AtlasTexture");
  check(JSON.stringify(w1.map((f) => f.region)) === JSON.stringify([[0, 0, 16, 16], [16, 0, 16, 16], [0, 16, 16, 16]]), "walk atlas rectangles match the source", w1.map((f) => f.region));
  check(Math.abs(w1[0]!.duration - 1) < 1e-6 && Math.abs(w1[2]!.duration - 1.2) < 1e-6, "relative durations 1.0 / 1.2 (durationMs*fps/1000)", w1.map((f) => f.duration));
  check(r1.animations.walk!.frames[0]!.atlas === `${CURRENT_RES.replace("godot", "animations/walk")}/atlas-0.png`, "atlas texture path is the stable res://…/current/… path", w1[0]!.atlas);
  check(r1.version === "ver-exp-1" && String(r1.meta_walk.candidate_id) === "cand-walk-exp-1", "metadata carries version/candidate ids", r1.meta_walk);
  check(String(r1.meta_walk.pivot) === "(8.0, 14.0)", "metadata carries pivot (Vector2)", r1.meta_walk.pivot);
  check(JSON.stringify(r1.still.region) === "[0,0,16,16]" && r1.still.w === 16, "still AtlasTexture covers the full image", r1.still);
  check(JSON.stringify(r1.stylebox) === "[3,4,5,6]", "StyleBoxTexture margins l/t/r/b = 3/4/5/6", r1.stylebox);
  check(r1.tileset.sources === 1 && r1.tileset.tiles === 4 && JSON.stringify(r1.tileset.tile_size) === "[8,8]" && JSON.stringify(r1.tileset.region_size) === "[8,8]", "TileSet: one atlas source, 4 tiles of 8x8", r1.tileset);
  check(r1.scene.animation === "walk" && r1.scene.frames === 3, "human-owned scene resolves walk with 3 frames", r1.scene);

  // ---- sidecars and human files that must survive replacement
  const sidecars = (await walk(path.join(dest, "current"))).filter((f) => /\.(import|uid)$/.test(f));
  console.log(`engine sidecars inside current after import: ${JSON.stringify(sidecars)}`);
  check(sidecars.some((f) => f.endsWith(".png.import")), "Godot wrote .import sidecars inside current", sidecars);
  await writeFile(path.join(dest, "current/assets/cortex/godot/animations.tres.uid"), "uid://bfverifyuidplaceholder\n");
  const sidecarBefore = new Map<string, string>();
  for (const f of [...sidecars, "assets/cortex/godot/animations.tres.uid"]) sidecarBefore.set(f, await sha(path.join(dest, "current", f)));

  // ---- export 2: distinct version, same res:// paths
  const second = await exportVersion("exp-2", 2, 4, { exportId: "exp-1", manifestSha256: first.manifestSha256 });
  console.log(`export 2 committed; carried unowned: ${JSON.stringify(second.carried)}; warnings: ${JSON.stringify(second.warnings)}`);
  const r2 = await importAndLoad("export 2");
  check(r2.animations.walk?.frames.length === 4 && r2.scene.frames === 4, "same path now shows walk with 4 frames (scene too)", { walk: r2.animations.walk?.frames.length, scene: r2.scene });
  check(r2.version === "ver-exp-2" && String(r2.meta_walk.candidate_id) === "cand-walk-exp-2", "metadata changed to version 2", r2.meta_walk);
  check(JSON.stringify(r2.animations.walk!.frames[3]!.region) === "[16,16,16,16]", "walk frame 3 atlas rectangle", r2.animations.walk!.frames[3]!.region);
  check((await sha(path.join(project, "main.tscn"))) === sceneHash, "human-owned scene bytes are unchanged");
  check((await readFile(path.join(dest, "human-notes.txt"), "utf8")) === "root-level human file\n", "root-level unowned file survived");
  for (const [f, hash] of sidecarBefore) check((await sha(path.join(dest, "current", f)).catch(() => "missing")) === hash, `sidecar still in current and unchanged: ${f}`);
  const releases = (await readdir(path.join(dest, ".releases"))).filter((n) => n !== ".lock").sort();
  check(releases.join() === "exp-1,exp-2", "current plus the retired release that still shelters unowned originals", releases);
  const retired = await walk(path.join(dest, ".releases/exp-1"));
  check(retired.length > 0 && retired.length === second.carried.length && retired.every((f) => /\.(import|uid)$/.test(f)), `retired release holds only the ${second.carried.length} unowned sidecars; every managed file was removed`, retired);

  // ---- .releases must not leak into Godot's view of the project
  const gdFiles = await walk(path.join(project, ".godot")).catch(() => [] as string[]);
  let leaked = gdFiles.filter((f) => f.includes(".releases"));
  for (const f of gdFiles.filter((n) => /uid_cache|global_script_class_cache|filesystem_cache|\.editor\//.test(n))) {
    if ((await readFile(path.join(project, ".godot", f))).includes(".releases")) leaked.push(f);
  }
  check(leaked.length === 0, "Godot's caches never mention .releases (no duplicate public assets)", leaked);

  console.log(failures === 0 ? "\nALL GODOT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
} finally {
  if (keep) console.log(`kept ${base}`);
  else await rm(base, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
