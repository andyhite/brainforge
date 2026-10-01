import { expect, test } from "bun:test";
import sharp from "sharp";
import { ProcessingRecipe } from "@brainforge/contracts";
import { buildSpriteAtlas, decodeRgba, layoutSprites, mirrorRepeat, processClip } from "../src/index.ts";

const recipe = (over: Record<string, unknown> & { output: { width: number; height: number } }): ProcessingRecipe =>
  ProcessingRecipe.parse({ crop: { x: 0, y: 0, width: over.output.width, height: over.output.height }, pivot: { x: 0.5, y: 0.5 }, playbackFps: 1, loop: false, ...over });

const rgba = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Promise<Buffer> => {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
};

test("opaque art edge-to-edge needs no subject, margin or anchor and is not flagged as clipped", async () => {
  const png = await rgba(8, 8, (x, y) => [x * 30, y * 30, 90, 255]);
  const clip = await processClip([png], 1, recipe({ output: { width: 8, height: 8 }, fit: "crop" }));
  expect(clip.clippedFrames).toEqual([]);
  expect(clip.frames).toHaveLength(1);
  expect(clip.frames[0]!.durationMs).toBe(1000);
  expect(clip.unionBounds).toEqual({ x: 0, y: 0, width: 8, height: 8 });
});

test("soft alpha survives 1x processing byte for byte (glow and smoke stay soft)", async () => {
  const png = await rgba(16, 16, (x, y) => [200 - x * 3, 120 + y, 40, (x * 16 + y) % 256]);
  const before = await decodeRgba(png);
  for (const fit of ["none", "crop", "contain", "stretch"] as const) {
    const clip = await processClip([png], 1, recipe({ output: { width: 16, height: 16 }, fit }));
    const after = await decodeRgba(clip.frames[0]!.png);
    expect(after.data.equals(before.data)).toBe(true);
  }
});

test("a 1x window crop keeps the selected pixels exactly", async () => {
  const png = await rgba(10, 10, (x, y) => [x * 20, y * 20, 7, 128]);
  const clip = await processClip([png], 1, recipe({ output: { width: 4, height: 4 }, crop: { x: 3, y: 2, width: 4, height: 4 }, fit: "none" }));
  const out = await decodeRgba(clip.frames[0]!.png);
  expect([...out.data.subarray(0, 4)]).toEqual([60, 40, 7, 128]);
});

test("canvas fit: crop covers and centre-cuts, contain letterboxes on transparency, stretch fills", async () => {
  const png = await rgba(40, 20, () => [255, 0, 0, 255]); // 2:1
  const crop = await decodeRgba((await processClip([png], 1, recipe({ output: { width: 10, height: 10 }, crop: { x: 0, y: 0, width: 40, height: 20 }, fit: "crop" }))).frames[0]!.png);
  expect(crop.width).toBe(10);
  expect(crop.data.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
  const contain = await decodeRgba((await processClip([png], 1, recipe({ output: { width: 10, height: 10 }, crop: { x: 0, y: 0, width: 40, height: 20 }, fit: "contain" }))).frames[0]!.png);
  const alphaAt = (y: number) => contain.data[(y * 10 + 5) * 4 + 3]!;
  expect(alphaAt(0)).toBe(0);
  expect(alphaAt(5)).toBe(255);
  expect(alphaAt(9)).toBe(0);
  const stretch = await decodeRgba((await processClip([png], 1, recipe({ output: { width: 10, height: 10 }, crop: { x: 0, y: 0, width: 40, height: 20 }, fit: "stretch" }))).frames[0]!.png);
  expect(stretch.data.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
});

test("fit none without an anchor refuses a size mismatch instead of guessing", async () => {
  const png = await rgba(8, 8, () => [1, 2, 3, 255]);
  await expect(processClip([png], 1, recipe({ output: { width: 4, height: 4 }, crop: { x: 0, y: 0, width: 8, height: 8 }, fit: "none" }))).rejects.toThrow(/fit "none"/);
});

test("alpha matte flattens onto the explicit colour and keeps the result opaque", async () => {
  const png = await rgba(4, 4, () => [255, 0, 0, 0]);
  const clip = await processClip([png], 1, recipe({ output: { width: 4, height: 4 }, fit: "crop", alpha: "matte", matteColor: "#00ff00" }));
  expect([...(await decodeRgba(clip.frames[0]!.png)).data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  await expect(processClip([png], 1, recipe({ output: { width: 4, height: 4 }, fit: "crop", alpha: "matte" }))).rejects.toThrow(/matteColor/);
});

test("nine-slice margins must leave a positive centre", async () => {
  const png = await rgba(8, 8, () => [9, 9, 9, 255]);
  await expect(processClip([png], 1, recipe({ output: { width: 8, height: 8 }, fit: "crop", nineSlice: { left: 4, right: 4, top: 1, bottom: 1 } }))).rejects.toThrow(/no centre/);
  const ok = await processClip([png], 1, recipe({ output: { width: 8, height: 8 }, fit: "crop", nineSlice: { left: 3, right: 4, top: 1, bottom: 1 } }));
  expect(ok.frames).toHaveLength(1);
});

test("mirror-repeat reflects the first half onto the second so the outer edges match", async () => {
  const png = await rgba(6, 4, (x, y) => [x * 40, y * 40, 0, 255]);
  const clip = await processClip([png], 1, recipe({ output: { width: 6, height: 4 }, fit: "crop", tileRepeat: "mirror-xy" }));
  const out = await decodeRgba(clip.frames[0]!.png);
  const at = (x: number, y: number) => [...out.data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 3)];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) expect(at(x, y)).toEqual(at(5 - x, y));
  for (let x = 0; x < 6; x++) for (let y = 0; y < 4; y++) expect(at(x, y)).toEqual(at(x, 3 - y));
  expect(at(0, 0)).toEqual([0, 0, 0]); // the first half is untouched
  expect(at(5, 0)).toEqual([0, 0, 0]);
});

test("mirror-repeat handles odd sizes and a single axis", () => {
  const w = 5, h = 2;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i, 0, 0, 255], i * 4);
  const out = mirrorRepeat(data, w, h, "mirror-x");
  expect([...out.subarray(0, 20)].filter((_, i) => i % 4 === 0)).toEqual([0, 1, 2, 1, 0]);
  expect([...out.subarray(20, 40)].filter((_, i) => i % 4 === 0)).toEqual([5, 6, 7, 6, 5]);
});

test("loop:false stays in the recipe and the packaged frame timing is unchanged", async () => {
  const frames = [await rgba(4, 4, () => [1, 1, 1, 255]), await rgba(4, 4, () => [2, 2, 2, 255]), await rgba(4, 4, () => [3, 3, 3, 255])];
  const r = recipe({ output: { width: 4, height: 4 }, fit: "crop", playbackFps: 8, loop: false });
  const clip = await processClip(frames, 8, r);
  expect(r.loop).toBe(false);
  expect(clip.loop).toBeUndefined();
  expect(clip.frames.map((f) => f.durationMs)).toEqual([125, 125, 125]);
});

test("sprite layout packs different sizes with gutters and extrusion inside the page cap", async () => {
  const sizes = [{ id: "a", width: 10, height: 10 }, { id: "b", width: 20, height: 6 }, { id: "c", width: 10, height: 10 }, { id: "d", width: 30, height: 30 }];
  const layout = layoutSprites(sizes, { maxSize: 64, padding: 2, extrude: 1 });
  for (const p of layout.pages) { expect(p.width).toBeLessThanOrEqual(64); expect(p.height).toBeLessThanOrEqual(64); }
  // cells never overlap
  for (const [i, a] of layout.cells.entries()) for (const [j, b] of layout.cells.entries()) {
    if (i >= j || a.page !== b.page) continue;
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  }
  const colours: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  const pngs = await Promise.all(sizes.map((s, i) => rgba(s.width, s.height, () => [...colours[i]!, 255] as [number, number, number, number])));
  const pages = await buildSpriteAtlas(sizes.map((s, i) => ({ id: s.id, png: pngs[i]! })), layout, 1);
  for (const [i, r] of layout.rects.entries()) {
    const page = await decodeRgba(pages[r.page]!.png);
    for (const [dx, dy] of [[0, 0], [r.width - 1, r.height - 1]] as const) {
      expect([...page.data.subarray(((r.y + dy) * page.width + r.x + dx) * 4, ((r.y + dy) * page.width + r.x + dx) * 4 + 3)]).toEqual(colours[i]!);
    }
  }
  expect(() => layoutSprites([{ id: "huge", width: 64, height: 8 }], { maxSize: 64, padding: 2, extrude: 1 })).toThrow(/exceeds atlas max/);
});
