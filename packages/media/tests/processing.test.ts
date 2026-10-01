import { expect, test } from "bun:test";
import sharp from "sharp";
import { buildAtlas, resample } from "../src/index.ts";

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
