import { expect, test } from "bun:test";
import sharp from "sharp";
import { applyFraming, decodeImage, foregroundBounds, MediaError } from "../src/index.ts";

async function fixture(w: number, h: number, rect: { x: number; y: number; width: number; height: number }) {
  const fg = await sharp({ create: { width: rect.width, height: rect.height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fg, left: rect.x, top: rect.y }]).png().toBuffer();
}

test("foregroundBounds finds the opaque rectangle only", async () => {
  const png = await fixture(100, 100, { x: 10, y: 20, width: 30, height: 50 });
  expect(await foregroundBounds(png)).toEqual({ x: 10, y: 20, width: 30, height: 50 });
});

test("framing scales standing height uniformly and anchors feet", async () => {
  const png = await fixture(200, 200, { x: 80, y: 20, width: 40, height: 100 });
  const b = await foregroundBounds(png);
  const t = { scale: 50 / b.height, canvas: { width: 64, height: 64 }, anchor: { x: 32, y: 60 }, sourceBounds: b, subjectHeightPx: 50 };
  const { png: out, clipped } = await applyFraming(png, t);
  expect(clipped).toBe(false);
  const ob = await foregroundBounds(out);
  expect(ob.height).toBeGreaterThanOrEqual(49);
  expect(ob.height).toBeLessThanOrEqual(51);
  expect(ob.y + ob.height).toBeGreaterThanOrEqual(59);
  expect(ob.y + ob.height).toBeLessThanOrEqual(61);
});

test("fully transparent image is rejected and corrupt bytes fail decode", async () => {
  const empty = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  await expect(foregroundBounds(empty)).rejects.toBeInstanceOf(MediaError);
  const png = await fixture(50, 50, { x: 5, y: 5, width: 10, height: 10 });
  await expect(decodeImage(png.subarray(0, 60), "trunc")).rejects.toBeInstanceOf(MediaError);
});
