import { expect, test } from "bun:test";
import sharp from "sharp";
import { ProcessingRecipe } from "@brainforge/contracts";
import { animationDocument, atlasLayout, buildAtlas, decodeRgba, loopJumps, MediaError, playSchedule, processClip, resample } from "../src/index.ts";

const sum = (xs: { durationMs: number }[]) => xs.reduce((a, f) => a + f.durationMs, 0);

test("33 source frames @16fps, exclude-last: 12fps -> 24 frames/2000ms, 16fps -> 32 frames/2000ms", () => {
  const base = { sourceFrameCount: 33, sourceFps: 16, closingFrame: "exclude-last" as const };
  const a = resample({ ...base, playbackFps: 12 });
  expect(a).toHaveLength(24);
  expect(sum(a)).toBeCloseTo(2000, 6);
  expect(a[23]!.sourceFrame).toBe(30);
  const b = resample({ ...base, playbackFps: 16 });
  expect(b).toHaveLength(32);
  expect(sum(b)).toBeCloseTo(2000, 6);
  expect(b.map((f) => f.sourceFrame)).toEqual(Array.from({ length: 32 }, (_, i) => i));
});

test("non-integer output count shortens the final frame and preserves duration", () => {
  const r = resample({ sourceFrameCount: 5, sourceFps: 16, playbackFps: 12, closingFrame: "keep" }); // D=0.3125s -> 4 frames
  expect(r).toHaveLength(4);
  expect(sum(r)).toBeCloseTo(312.5, 6);
  expect(r[3]!.durationMs).toBeLessThan(1000 / 12);
  expect(Math.max(...r.map((f) => f.sourceFrame))).toBeLessThanOrEqual(4);
});

test("single-frame clip resamples to one frame", () => {
  expect(resample({ sourceFrameCount: 1, sourceFps: 16, playbackFps: 12, closingFrame: "keep" })).toHaveLength(1);
});

async function solid(w: number, h: number, r: number, g: number, b: number) {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();
}

test("atlas unpacking reproduces frames; gutters are transparent; extrusion replicates edges", async () => {
  const frames = [await solid(4, 4, 255, 0, 0), await solid(4, 4, 0, 255, 0), await solid(4, 4, 0, 0, 255)];
  const atlas = await buildAtlas(frames, { maxSize: 64, padding: 2, extrude: 1 });
  expect(atlas.pages).toHaveLength(1);
  const page = atlas.pages[0]!;
  const raw = await sharp(page.png).raw().toBuffer();
  const px = (x: number, y: number) => [...raw.subarray((y * page.width + x) * 4, (y * page.width + x) * 4 + 4)];
  const expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  for (const [i, r] of atlas.frames.entries()) {
    for (const [dx, dy] of [[0, 0], [3, 3], [1, 2]]) expect(px(r.x + dx!, r.y + dy!)).toEqual([...expected[i]!, 255]);
    expect(px(r.x - 1, r.y)).toEqual([...expected[i]!, 255]); // extrusion
  }
  const gutterX = atlas.frames[0]!.x + 4 + 1 + 0; // right extrude column then gutter
  expect(px(gutterX + 1, atlas.frames[0]!.y)[3]).toBe(0);
});

test("pages are capped: overflow creates another page, none exceeds maxSize", async () => {
  const f = await solid(10, 10, 1, 2, 3);
  const atlas = await buildAtlas(Array.from({ length: 9 }, () => f), { maxSize: 32, padding: 2, extrude: 1 });
  expect(atlas.pages.length).toBeGreaterThan(1);
  for (const p of atlas.pages) { expect(p.width).toBeLessThanOrEqual(32); expect(p.height).toBeLessThanOrEqual(32); }
  expect(atlas.frames).toHaveLength(9);
});

test("mismatched frame sizes are rejected", async () => {
  await expect(buildAtlas([await solid(4, 4, 0, 0, 0), await solid(5, 4, 0, 0, 0)], { maxSize: 64, padding: 2, extrude: 1 })).rejects.toThrow();
});

// ---------------------------------------------------------------------------------------------- processClip

const SRC = 32;
type Rgba = [number, number, number, number];

/** A transparent canvas with one opaque rectangle (a stand-in for the character) at (x, y). */
async function figure(x: number, y: number, w: number, h: number, colour: Rgba = [200, 40, 40, 255], size = SRC): Promise<Uint8Array> {
  const block = await sharp({ create: { width: w, height: h, channels: 4, background: { r: colour[0], g: colour[1], b: colour[2], alpha: colour[3] / 255 } } }).png().toBuffer();
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: block, left: x, top: y }]).png().toBuffer());
}

/** Identity-scale recipe: the 32x32 source maps 1:1 onto a 32x32 canvas with feet at (16, 28). */
const recipe = (over: Record<string, unknown> = {}): ProcessingRecipe =>
  ProcessingRecipe.parse({
    crop: { x: 0, y: 0, width: SRC, height: SRC }, output: { width: SRC, height: SRC }, pivot: { x: 0.5, y: 28 / SRC }, playbackFps: 12, loop: false, closingFrame: "keep",
    scaleAnchor: { referenceOutputId: "ref", referenceHash: "0".repeat(64), sourceStandingHeightPx: 20, targetStandingHeightPx: 20, sourceFeet: { x: 16, y: 28 } },
    packaging: "both", atlas: { maxSize: 256, padding: 2, extrude: 1 }, ...over,
  });

/** A walk-ish sequence: the figure sways left-right and the last frame equals the first. */
const walker = (n: number): Promise<Uint8Array[]> => Promise.all(Array.from({ length: n }, (_, i) => figure(13 + Math.round(4 * Math.sin((2 * Math.PI * i) / (n - 1))), 8, 6, 20)));

test("33 source frames @16fps through processClip: 12fps -> 24 frames/2000ms (frame 23 shows source 30); 16fps -> 32 frames/2000ms", async () => {
  const source = await walker(33);
  const a = await processClip(source, 16, recipe({ loop: true, closingFrame: "exclude-last", playbackFps: 12 }), { pack: false });
  expect(a.frames).toHaveLength(24);
  expect(sum(a.frames)).toBeCloseTo(2000, 6);
  expect(a.frames[23]!.sourceFrame).toBe(30);
  const b = await processClip(source, 16, recipe({ loop: true, closingFrame: "exclude-last", playbackFps: 16 }), { pack: false });
  expect(b.frames).toHaveLength(32);
  expect(sum(b.frames)).toBeCloseTo(2000, 6);
  expect(b.frames.map((f) => f.sourceFrame)).toEqual(Array.from({ length: 32 }, (_, i) => i));
  // Output frame 23 really is source frame 30's picture.
  const direct = await processClip([source[30]!], 16, recipe({ playbackFps: 16 }), { pack: false });
  expect((await decodeRgba(a.frames[23]!.png)).data.equals((await decodeRgba(direct.frames[0]!.png)).data)).toBe(true);
});

test("trim keeps source indices absolute; zero-length and out-of-range trims are refused by name", () => {
  const s = playSchedule(10, 16, { trim: { start: 4, endExclusive: 8 }, closingFrame: "keep", playbackFps: 16 });
  expect(s.map((f) => f.sourceFrame)).toEqual([4, 5, 6, 7]);
  expect(() => playSchedule(10, 16, { trim: { start: 5, endExclusive: 5 }, closingFrame: "keep", playbackFps: 16 })).toThrow(MediaError);
  expect(() => playSchedule(10, 16, { trim: { start: 0, endExclusive: 11 }, closingFrame: "keep", playbackFps: 16 })).toThrow(/not inside the 10 source frames/);
  expect(() => playSchedule(1, 16, { closingFrame: "exclude-last", playbackFps: 16 })).toThrow(MediaError);
});

test("a single played frame yields one frame lasting its full source duration; a non-integer count shortens the last frame", async () => {
  const one = await processClip([await figure(13, 8, 6, 20)], 16, recipe(), { pack: false });
  expect(one.frames).toHaveLength(1);
  expect(one.frames[0]!.durationMs).toBeCloseTo(62.5, 6);
  const five = await processClip(await walker(5), 16, recipe(), { pack: false });
  expect(five.frames).toHaveLength(4);
  expect(sum(five.frames)).toBeCloseTo(312.5, 6);
  expect(five.frames[3]!.durationMs).toBeCloseTo(62.5, 6);
});

test("alpha is preserved: foreground stays opaque and the outside stays transparent", async () => {
  const clip = await processClip([await figure(13, 8, 6, 20)], 16, recipe(), { pack: false });
  const { data, width } = await decodeRgba(clip.frames[0]!.png);
  const at = (x: number, y: number) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  expect(at(15, 15)).toEqual([200, 40, 40, 255]);
  expect(at(2, 2)[3]).toBe(0);
  expect(at(30, 30)[3]).toBe(0);
  expect(clip.unionBounds).toEqual({ x: 13, y: 8, width: 6, height: 20 });
});

test("snap-near-opaque: 254 -> 255, 253 and soft edges unchanged; preserve touches nothing", async () => {
  const px = (a: number): Promise<Uint8Array> => figure(13, 8, 6, 20, [200, 40, 40, a]);
  const read = async (png: Uint8Array): Promise<number> => (await decodeRgba(png)).data[(15 * SRC + 15) * 4 + 3]!;
  const snap = recipe({ alpha: "snap-near-opaque" });
  for (const [alpha, want] of [[254, 255], [255, 255], [253, 253], [128, 128], [40, 40]] as const) {
    expect(await read((await processClip([await px(alpha)], 16, snap, { pack: false })).frames[0]!.png)).toBe(want);
  }
  expect(await read((await processClip([await px(254)], 16, recipe(), { pack: false })).frames[0]!.png)).toBe(254);
  // The colour channels and the transparent surround are untouched.
  const { data } = await decodeRgba((await processClip([await px(254)], 16, snap, { pack: false })).frames[0]!.png);
  expect([...data.subarray((15 * SRC + 15) * 4, (15 * SRC + 15) * 4 + 3)]).toEqual([200, 40, 40]);
  expect(data[3]).toBe(0);
});

test("one uniform scale: a crouching clip is NOT refit to its smaller bounding box", async () => {
  // The anchor says 20px standing -> 10px (scale 0.5). A 10px-tall crouch must come out 5px tall, not 10.
  const half = recipe({ scaleAnchor: { referenceOutputId: "ref", referenceHash: "0".repeat(64), sourceStandingHeightPx: 20, targetStandingHeightPx: 10, sourceFeet: { x: 16, y: 28 } } });
  const standing = await processClip([await figure(13, 8, 6, 20)], 16, half, { pack: false });
  const crouch = await processClip([await figure(13, 18, 6, 10)], 16, half, { pack: false });
  expect(standing.scale).toBe(0.5);
  expect(crouch.scale).toBe(0.5);
  expect(standing.unionBounds.height).toBe(10);
  expect(crouch.unionBounds.height).toBe(5);
  expect(standing.unionBounds.y + standing.unionBounds.height).toBe(crouch.unionBounds.y + crouch.unionBounds.height);
});

test("crop selects the source window before scaling and keeps the feet anchored; a crop outside the frame is refused", async () => {
  const full = await processClip([await figure(13, 8, 6, 20)], 16, recipe(), { pack: false });
  const cropped = await processClip([await figure(13, 8, 6, 20)], 16, recipe({ crop: { x: 4, y: 2, width: 24, height: 28 } }), { pack: false });
  expect(cropped.unionBounds).toEqual(full.unionBounds);
  await expect(processClip([await figure(13, 8, 6, 20)], 16, recipe({ crop: { x: 20, y: 0, width: 20, height: 32 } }), { pack: false })).rejects.toThrow(/leaves the 32x32 source frame/);
  // A crop is an explicit window: it removes what lies outside it (here the left half of the figure).
  const half = await processClip([await figure(13, 8, 6, 20)], 16, recipe({ crop: { x: 16, y: 0, width: 16, height: 32 } }), { pack: false });
  expect(half.unionBounds.width).toBe(3);
});

test("frameOffsets are explicit per-export-frame shifts after scaling; bad or duplicate indices are refused; pushing a subject off the canvas is reported", async () => {
  const source = await walker(4);
  const plain = await processClip(source, 16, recipe({ playbackFps: 16 }), { pack: false });
  const moved = await processClip(source, 16, recipe({ playbackFps: 16, frameOffsets: [{ index: 2, dx: 3, dy: -2 }] }), { pack: false });
  expect(moved.frames[1]!.png).toEqual(plain.frames[1]!.png);
  const b = plain.frames[2]!.bounds!;
  expect(moved.frames[2]!.bounds).toEqual({ ...b, x: b.x + 3, y: b.y - 2 });
  await expect(processClip(source, 16, recipe({ playbackFps: 16, frameOffsets: [{ index: 9, dx: 1, dy: 0 }] }), { pack: false })).rejects.toThrow(/beyond the 4 export frames/);
  await expect(processClip(source, 16, recipe({ playbackFps: 16, frameOffsets: [{ index: 1, dx: 1, dy: 0 }, { index: 1, dx: 2, dy: 0 }] }), { pack: false })).rejects.toThrow(/twice/);
  const off = await processClip(source, 16, recipe({ playbackFps: 16, frameOffsets: [{ index: 0, dx: -40, dy: 0 }] }), { pack: false, allowClipped: true, allowEmpty: true });
  expect(off.emptyFrames).toEqual([0]);
});

test("a subject touching the canvas edge is `clipped`: refused by default, reported with allowClipped", async () => {
  const source = [await figure(13, 0, 6, 28)];
  await expect(processClip(source, 16, recipe(), { pack: false })).rejects.toMatchObject({ code: "clipped" });
  const reported = await processClip(source, 16, recipe(), { pack: false, allowClipped: true });
  expect(reported.clippedFrames).toEqual([0]);
});

test("corrupt and mismatched source frames, an invalid pivot and a fully transparent clip are refused with a named reason", async () => {
  const good = await figure(13, 8, 6, 20);
  await expect(processClip([good, new Uint8Array([1, 2, 3])], 16, recipe(), { pack: false })).rejects.toThrow(/source frame 1/);
  await expect(processClip([good, await figure(1, 1, 2, 2, [1, 1, 1, 255], 16)], 16, recipe(), { pack: false })).rejects.toThrow(/source frame 1 is 16x16, expected 32x32/);
  await expect(processClip([good], 16, { ...recipe(), pivot: { x: 1.5, y: 0.5 } }, { pack: false })).rejects.toThrow(/pivot/);
  await expect(processClip([await figure(0, 0, 1, 1, [0, 0, 0, 0])], 16, recipe(), { pack: false })).rejects.toMatchObject({ code: "empty" });
});

test("an open loop is measurable: a closing step larger than every inner step jumps, a natural closing step does not", async () => {
  const closed = await processClip(await walker(9), 16, recipe({ loop: true, closingFrame: "exclude-last", playbackFps: 16 }), { pack: false });
  expect(loopJumps(closed.loop!)).toBe(false);
  const drifting = await Promise.all([2, 3, 4, 5, 6, 7].map((x) => figure(x, 8, 6, 20)));
  const jump = await processClip(drifting, 16, recipe({ loop: true, playbackFps: 16 }), { pack: false });
  expect(loopJumps(jump.loop!)).toBe(true);
});

test("atlas of processed frames: each rectangle reproduces its frame's exact RGBA, extrusion replicates the edge, gutters stay transparent, pages stay within maxSize", async () => {
  const frames = [await figure(0, 8, 6, 20, [10, 200, 30, 255]), await figure(0, 0, 32, 32, [200, 10, 30, 255]), await figure(5, 5, 9, 9), await figure(13, 8, 6, 20), await figure(20, 20, 8, 8, [1, 2, 250, 255])];
  const atlas = await buildAtlas(frames, { maxSize: 80, padding: 2, extrude: 1 });
  expect(atlas.pages).toHaveLength(2); // 34px cells: two columns and two rows fit an 80px page
  for (const p of atlas.pages) { expect(p.width).toBeLessThanOrEqual(80); expect(p.height).toBeLessThanOrEqual(80); }
  const rasters = await Promise.all(atlas.pages.map((p) => decodeRgba(p.png)));
  const px = (page: number, x: number, y: number) => [...rasters[page]!.data.subarray((y * rasters[page]!.width + x) * 4, (y * rasters[page]!.width + x) * 4 + 4)];
  for (const [i, f] of frames.entries()) {
    const own = await decodeRgba(f);
    const r = atlas.frames[i]!;
    for (let y = 0; y < SRC; y++) {
      for (let x = 0; x < SRC; x++) {
        expect(px(r.page, r.x + x, r.y + y)).toEqual([...own.data.subarray((y * SRC + x) * 4, (y * SRC + x) * 4 + 4)]);
      }
    }
    // Extrusion: the ring around the rectangle repeats the nearest edge pixel.
    for (const k of [0, 2, 10, 31]) {
      expect(px(r.page, r.x - 1, r.y + k)).toEqual(px(r.page, r.x, r.y + k));
      expect(px(r.page, r.x + SRC, r.y + k)).toEqual(px(r.page, r.x + SRC - 1, r.y + k));
      expect(px(r.page, r.x + k, r.y - 1)).toEqual(px(r.page, r.x + k, r.y));
      expect(px(r.page, r.x + k, r.y + SRC)).toEqual(px(r.page, r.x + k, r.y + SRC - 1));
    }
  }
  // The two-pixel gutter between neighbouring cells (frame 0 and frame 1 share a row) is fully transparent.
  const left = atlas.frames[0]!, right = atlas.frames[1]!;
  expect(left.page).toBe(right.page);
  for (let x = left.x + SRC + 1; x < right.x - 1; x++) for (let y = left.y; y < left.y + SRC; y++) expect(px(left.page, x, y)[3]).toBe(0);
  expect(right.x - (left.x + SRC)).toBe(2 + 2); // extrude + padding + extrude
});

test("a frame that cannot fit one page is impossible packing, named before any pixel work", () => {
  expect(() => atlasLayout(32, 32, 3, { maxSize: 33, padding: 2, extrude: 1 })).toThrow(/exceeds atlas max 33/);
  expect(atlasLayout(32, 32, 9, { maxSize: 80, padding: 2, extrude: 1 })).toEqual({ cols: 2, rows: 2, perPage: 4, pages: 3 });
});

test("animation.json keeps real durations and rectangles; a rectangle outside its page or a non-positive duration is refused", () => {
  const page = { page: 0, file: "atlas-0.png", width: 70, height: 70 };
  const base = { sourceFps: 16, playbackFps: 12, loop: true, canvas: { width: 32, height: 32 }, pivot: { x: 0.5, y: 0.875 }, atlasPages: [page] };
  const frame = (index: number, over: Record<string, unknown> = {}) => ({ index, durationMs: 83.3, sourceFrame: index, file: `000${index}.png`, atlas: { page: 0, x: 1, y: 1, width: 32, height: 32 }, ...over });
  const doc = animationDocument({ ...base, frames: [frame(0), frame(1, { durationMs: 62.5, atlas: { page: 0, x: 37, y: 1, width: 32, height: 32 } })] });
  expect(doc.schema).toBe("brainforge.animation.v2");
  expect(doc.pivotPx).toEqual({ x: 16, y: 28 });
  expect(doc.frames.map((f) => f.durationMs)).toEqual([83.3, 62.5]);
  expect(() => animationDocument({ ...base, frames: [frame(0, { atlas: { page: 0, x: 40, y: 1, width: 32, height: 32 } })] })).toThrow(/leaves atlas page 0/);
  expect(() => animationDocument({ ...base, frames: [frame(0, { durationMs: 0 })] })).toThrow(/non-positive duration/);
  expect(() => animationDocument({ ...base, frames: [frame(1)] })).toThrow(/listed with index 1/);
  expect(() => animationDocument({ ...base, pivot: { x: 2, y: 0 }, frames: [frame(0)] })).toThrow(/pivot/);
});
