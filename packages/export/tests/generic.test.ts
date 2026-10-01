import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { buildSnapshot, validateSnapshot, ExportError, type ExportPackaging } from "../src/index.ts";
import { CANVAS, FRAME_DURATIONS, makeInput, makePng, tempDir } from "./fixtures.ts";

async function build(packaging: ExportPackaging, over: { seed?: number; exportId?: string; frameCount?: number } = {}) {
  const base = await tempDir();
  const sourceDir = path.join(base, "src");
  const root = path.join(base, "out");
  await mkdir(root);
  const input = await makeInput({ sourceDir, packaging, ...over });
  const outcome = await buildSnapshot(input, root);
  return { base, root, input, outcome };
}

const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, "utf8"));

async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe("generic snapshot", () => {
  test("frames packaging: names, count, durations, pivots equal the source animation", async () => {
    const { root, input } = await build("frames");
    const anim = path.join(root, "assets/cortex/animations/walk");
    expect(await listDir(path.join(anim, "frames"))).toEqual(["0000.png", "0001.png", "0002.png"]);
    expect(await listDir(anim)).toEqual(["animation.json", "frames"]);
    const doc = await readJson(path.join(anim, "animation.json"));
    expect(doc.schema).toBe("brainforge.animation.v2");
    expect(doc).toMatchObject({ sourceFps: 16, playbackFps: 12, loop: true, canvas: { width: CANVAS, height: CANVAS }, pivot: { x: 0.5, y: 14 / 16 }, pivotPx: { x: 8, y: 14 } });
    expect(doc.frames).toHaveLength(3);
    for (const [i, f] of doc.frames.entries()) {
      expect(f).toMatchObject({ index: i, durationMs: FRAME_DURATIONS[i], sourceFrame: i * 2, file: `frames/000${i}.png` });
      expect(f.atlas).toBeUndefined();
    }
    expect(doc.atlasPages).toBeUndefined();
    expect((input.assets[0]!.deliverables.find((d) => d.deliverableId === "walk")!.media as { frames: unknown[] }).frames).toHaveLength(3);
  });

  test("atlas packaging writes pages with the exact source rectangles and no frame files", async () => {
    const { root, input } = await build("atlas");
    const anim = path.join(root, "assets/cortex/animations/walk");
    expect(await listDir(anim)).toEqual(["animation.json", "atlas-0.png"]);
    const doc = await readJson(path.join(anim, "animation.json"));
    expect(doc.atlasPages).toEqual([{ page: 0, file: "atlas-0.png", width: 32, height: 32 }]);
    const source = input.assets[0]!.deliverables.find((d) => d.deliverableId === "walk")!.media;
    if (source.kind !== "animation") throw new Error("fixture");
    expect(doc.frames.map((f: { atlas: unknown }) => f.atlas)).toEqual(source.frames.map((f) => f.atlas));
    expect(doc.frames.every((f: { file?: string }) => f.file === undefined)).toBe(true);
  });

  test("both packaging writes frames and atlas, and an absent mode is not an error", async () => {
    const { root } = await build("both", { frameCount: 4 });
    const anim = path.join(root, "assets/cortex/animations/idle");
    expect(await listDir(anim)).toEqual(["animation.json", "atlas-0.png", "frames"]);
    const doc = await readJson(path.join(anim, "animation.json"));
    expect(doc.frames).toHaveLength(4);
    expect(doc.frames[3]).toMatchObject({ file: "frames/0003.png", atlas: { page: 0, x: 16, y: 16, width: 16, height: 16 } });
  });

  test("asset.json carries ids, pivots, scales, files and metadata", async () => {
    const { root } = await build("both");
    const asset = await readJson(path.join(root, "assets/cortex/asset.json"));
    expect(asset).toMatchObject({ schema: "brainforge.export-asset.v2", assetId: "cortex", family: "character", versionId: "ver-1", requirementsHash: "req-1", dependencies: [], metadata: { note: "fixture" } });
    const walk = asset.deliverables.find((d: { deliverableId: string }) => d.deliverableId === "walk");
    expect(walk).toMatchObject({ candidateId: "cand-walk", outputHash: "hash-walk", canvas: { width: 16, height: 16 }, pivot: { x: 8, y: 14 }, pivotNormalized: { x: 0.5, y: 0.875 }, displayScale: 0.5, relativeScale: 1, animation: "animations/walk/animation.json" });
    expect(walk.files).toContain("animations/walk/frames/0002.png");
    expect(walk.files).toContain("animations/walk/atlas-0.png");
    const front = asset.deliverables.find((d: { deliverableId: string }) => d.deliverableId === "front");
    expect(front.files).toEqual(["stills/front.png"]);
  });

  test("manifest lists every file but itself, hashes match, and output is deterministic", async () => {
    const a = await build("both");
    const b = await build("both", { exportId: "exp-1" });
    expect(a.outcome.manifestText).toBe(b.outcome.manifestText);
    expect(a.outcome.manifest.ownedFiles.map((f) => f.path)).not.toContain("manifest.json");
    expect(a.outcome.manifest.ownedFiles.map((f) => f.path)).toEqual([...a.outcome.manifest.ownedFiles.map((f) => f.path)].sort());
    expect((await validateSnapshot(a.root, a.outcome.manifestSha256)).exportId).toBe("exp-1");
    expect(a.outcome.manifest.assets).toEqual([{ assetId: "cortex", versionId: "ver-1", metadataPath: "assets/cortex/asset.json", resourcePaths: [] }]);
  });

  test("a changed owned file fails validation", async () => {
    const a = await build("frames");
    await Bun.write(path.join(a.root, "assets/cortex/animations/walk/frames/0001.png"), "tampered");
    await expect(validateSnapshot(a.root)).rejects.toMatchObject({ code: "EXPORT_CONFLICT" });
  });

  test("a source PNG whose size differs from the declared canvas is rejected", async () => {
    const base = await tempDir();
    const root = path.join(base, "out");
    await mkdir(root);
    const input = await makeInput({ sourceDir: path.join(base, "src") });
    const front = input.assets[0]!.deliverables.find((d) => d.deliverableId === "front")!;
    if (front.media.kind !== "still") throw new Error("fixture");
    await makePng(front.media.sourcePath, 8, 8, 3);
    await expect(buildSnapshot(input, root)).rejects.toBeInstanceOf(ExportError);
  });

  test("non-contiguous frame indices are rejected", async () => {
    const base = await tempDir();
    const root = path.join(base, "out");
    await mkdir(root);
    const input = await makeInput({ sourceDir: path.join(base, "src"), packaging: "frames" });
    const walk = input.assets[0]!.deliverables.find((d) => d.deliverableId === "walk")!;
    if (walk.media.kind !== "animation") throw new Error("fixture");
    walk.media.frames[1]!.index = 5;
    await expect(buildSnapshot(input, root)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
