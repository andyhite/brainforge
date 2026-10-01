import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildSnapshot, validateSnapshot, type ExportAsset, type ExportInput } from "../src/index.ts";
import { animationDeliverable, stillDeliverable, tempDir } from "./fixtures.ts";

const RES = "res://game/assets/brainforge";

async function build(sprites: "individual" | "atlas" | "both") {
  const base = await tempDir();
  const o = { sourceDir: path.join(base, "src"), preset: "godot4" as const, godot: { projectRootAbs: base, resRootPrefix: RES }, exportId: "e1" };
  const asset: ExportAsset = {
    assetId: "hud-buttons", family: "ui", versionId: "ver-1", requirementsHash: "req", dependencies: [], metadata: {}, sprites,
    deliverables: [
      await stillDeliverable(o, "button-normal", "ui-state", { state: "normal", nineSlice: { left: 3, top: 4, right: 3, bottom: 4 } }, 24),
      await stillDeliverable(o, "button-pressed", "ui-state", { state: "pressed", nineSlice: { left: 3, top: 4, right: 3, bottom: 4 } }, 24),
      await stillDeliverable(o, "icon-heart", "variant", {}, 12),
      await stillDeliverable(o, "ground", "tile", { tile: { width: 8, height: 8 } }, 16),
      await animationDeliverable({ ...o, packaging: "frames" }, "burst", false),
    ],
  };
  const root = path.join(base, "out");
  await mkdir(root);
  const input: ExportInput = { projectId: "p", exportId: "e1", preset: "godot4", createdAt: "2026-10-01T00:00:00.000Z", godot: o.godot, assets: [asset] };
  const outcome = await buildSnapshot(input, root);
  return { root, outcome, read: (rel: string) => readFile(path.join(root, rel), "utf8"), exists: (rel: string) => outcome.ownedFiles.some((f) => f.path === rel) };
}

describe("sprite atlas packaging", () => {
  test("sprites.json rectangles, the packed pixels and the Godot AtlasTexture regions agree", async () => {
    const { root, read, outcome } = await build("both");
    const doc = JSON.parse(await read("assets/hud-buttons/sprites/sprites.json")) as { schema: string; atlasPages: { page: number; file: string; width: number; height: number }[]; sprites: { id: string; state: string; page: number; x: number; y: number; width: number; height: number; nineSlice?: unknown }[] };
    expect(doc.schema).toBe("brainforge.sprites.v2");
    expect(doc.sprites.map((s) => s.id)).toEqual(["button-normal", "button-pressed", "icon-heart"]); // tiles stay individual
    expect(doc.sprites.map((s) => s.state)).toEqual(["normal", "pressed", "icon-heart"]);
    expect(doc.sprites[0]!.nineSlice).toEqual({ left: 3, top: 4, right: 3, bottom: 4 });
    expect(doc.sprites[2]!.nineSlice).toBeUndefined();
    for (const s of doc.sprites) {
      // the atlas holds exactly the original sprite's pixels at the recorded rectangle
      const page = doc.atlasPages.find((p) => p.page === s.page)!;
      const atlas = await sharp(path.join(root, "assets/hud-buttons/sprites", page.file)).raw().toBuffer({ resolveWithObject: true });
      expect(atlas.info.width).toBe(page.width);
      const original = await sharp(path.join(root, "assets/hud-buttons/stills", `${s.id}.png`)).ensureAlpha().raw().toBuffer();
      for (let y = 0; y < s.height; y++) {
        const from = ((s.y + y) * page.width + s.x) * 4;
        expect(atlas.data.subarray(from, from + s.width * 4).equals(original.subarray(y * s.width * 4, (y + 1) * s.width * 4))).toBe(true);
      }
      // godot AtlasTexture points at the same rectangle
      const tres = await read(`assets/hud-buttons/godot/textures/${s.id}.tres`);
      expect(tres).toContain(`path="${RES}/current/assets/hud-buttons/sprites/atlas-${s.page}.png"`);
      expect(tres).toContain(`region = Rect2(${s.x}, ${s.y}, ${s.width}, ${s.height})`);
    }
    // extrusion and gutters: neighbouring rectangles never touch
    for (const [i, a] of doc.sprites.entries()) for (const b of doc.sprites.slice(i + 1)) {
      if (a.page !== b.page) continue;
      const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width)), gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
      expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(2);
    }
    const sb = await read("assets/hud-buttons/godot/styleboxes/button-pressed.tres");
    const pressed = doc.sprites.find((s) => s.id === "button-pressed")!;
    expect(sb).toContain('[sub_resource type="AtlasTexture" id="AtlasTexture_button_pressed"]');
    expect(sb).toContain(`region = Rect2(${pressed.x}, ${pressed.y}, ${pressed.width}, ${pressed.height})`);
    expect(sb).toContain("texture_margin_left = 3.0");
    expect(sb).toContain("texture_margin_bottom = 4.0");
    expect(await read("assets/hud-buttons/godot/tilesets/ground.tres")).toContain("TileSetAtlasSource");
    const asset = JSON.parse(await read("assets/hud-buttons/asset.json")) as { sprites: string; deliverables: { deliverableId: string; files: string[]; sprite?: { page: number; x: number; y: number } }[] };
    expect(asset.sprites).toBe("sprites/sprites.json");
    expect(asset.deliverables.find((d) => d.deliverableId === "icon-heart")!.sprite).toMatchObject({ page: 0, x: doc.sprites[2]!.x, y: doc.sprites[2]!.y });
    await validateSnapshot(root, outcome.manifestSha256);
  });

  test("atlas-only drops the individual PNGs of packed sprites but keeps tiles; both keeps every PNG; individual writes no atlas", async () => {
    const only = await build("atlas");
    expect(only.exists("assets/hud-buttons/stills/button-normal.png")).toBe(false);
    expect(only.exists("assets/hud-buttons/stills/icon-heart.png")).toBe(false);
    expect(only.exists("assets/hud-buttons/stills/ground.png")).toBe(true);
    expect(only.exists("assets/hud-buttons/sprites/atlas-0.png")).toBe(true);
    await validateSnapshot(only.root, only.outcome.manifestSha256);

    const both = await build("both");
    expect(both.exists("assets/hud-buttons/stills/button-normal.png")).toBe(true);
    expect(both.exists("assets/hud-buttons/sprites/atlas-0.png")).toBe(true);

    const individual = await build("individual");
    expect(individual.exists("assets/hud-buttons/sprites/sprites.json")).toBe(false);
    expect(individual.exists("assets/hud-buttons/stills/button-normal.png")).toBe(true);
    const tres = await individual.read("assets/hud-buttons/godot/textures/button-normal.tres");
    expect(tres).toContain("stills/button-normal.png");
    expect(tres).toContain("region = Rect2(0, 0, 24, 24)");
  });

  test("resource ids and the atlas layout do not depend on the export id", async () => {
    const a = await build("both");
    const b = await build("both");
    expect(await a.read("assets/hud-buttons/sprites/sprites.json")).toBe(await b.read("assets/hud-buttons/sprites/sprites.json"));
    expect(await a.read("assets/hud-buttons/godot/styleboxes/button-normal.tres")).toBe(await b.read("assets/hud-buttons/godot/styleboxes/button-normal.tres"));
  });

  test("a once-playing effect keeps loop:false in animation.json and the SpriteFrames loop flag, with unchanged frame timing", async () => {
    const { read } = await build("both");
    const anim = JSON.parse(await read("assets/hud-buttons/animations/burst/animation.json")) as { loop: boolean; frames: { durationMs: number }[] };
    expect(anim.loop).toBe(false);
    expect(anim.frames.map((f) => f.durationMs)).toEqual([1000 / 12, 1000 / 12, 100]);
    const frames = await read("assets/hud-buttons/godot/animations.tres");
    expect(frames).toContain('"loop": false');
    expect(frames).toContain('"duration": 1.2');
  });
});
