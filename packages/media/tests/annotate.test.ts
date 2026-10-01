import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { decodeRgba, renderAnnotated, resizeToMax } from "../src/index.ts";

async function solid(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 90, g: 120, b: 160, alpha: 1 } } }).png().toBuffer();
}

function pixel(img: { width: number; data: Buffer }, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [...img.data.subarray(i, i + 4)];
}

describe("renderAnnotated", () => {
  test("keeps the size and changes pixels at a pin but not far from it", async () => {
    const png = await solid(400, 300);
    const out = await decodeRgba(await renderAnnotated(png, [{ number: 1, geometry: { kind: "pin", x: 0.5, y: 0.5 } }]));
    const base = await decodeRgba(png);
    expect([out.width, out.height]).toEqual([400, 300]);
    expect(pixel(out, 200, 150)).not.toEqual(pixel(base, 200, 150));
    expect(pixel(out, 20, 280)).toEqual(pixel(base, 20, 280));
  });

  test("draws a rectangle outline on its edge, leaving its interior untouched", async () => {
    const png = await solid(400, 300);
    const out = await decodeRgba(await renderAnnotated(png, [{ number: 2, geometry: { kind: "rect", x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }]));
    const base = await decodeRgba(png);
    expect(pixel(out, 200, 75)).not.toEqual(pixel(base, 200, 75));
    expect(pixel(out, 200, 150)).toEqual(pixel(base, 200, 150));
  });

  test("a whole-image note frames the edge", async () => {
    const png = await solid(200, 200);
    const out = await decodeRgba(await renderAnnotated(png, [{ number: 1, geometry: { kind: "whole" } }]));
    const base = await decodeRgba(png);
    expect(pixel(out, 100, 2)).not.toEqual(pixel(base, 100, 2));
    expect(pixel(out, 100, 100)).toEqual(pixel(base, 100, 100));
  });

  test("rejects bytes that are not an image", async () => {
    await expect(renderAnnotated(new Uint8Array([1, 2, 3]), [])).rejects.toThrow();
  });
});

describe("resizeToMax", () => {
  test("fits the longest side and never enlarges", async () => {
    const png = await solid(400, 100);
    expect(await resizeToMax(png, 128)).toMatchObject({ width: 128, height: 32 });
    expect(await resizeToMax(png, 1000)).toMatchObject({ width: 400, height: 100 });
  });
});
