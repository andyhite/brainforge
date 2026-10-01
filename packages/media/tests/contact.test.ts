import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { buildContactSheet, decodeRgba, evenlySpaced } from "../src/index.ts";

const solid = (r: number, width = 64, height = 96): Promise<Uint8Array> =>
  sharp({ create: { width, height, channels: 4, background: { r, g: 10, b: 20, alpha: 1 } } }).png().toBuffer();

describe("evenlySpaced", () => {
  test("keeps everything up to 16 frames; beyond that spreads evenly and always keeps first and last", () => {
    expect(evenlySpaced(5)).toEqual([0, 1, 2, 3, 4]);
    expect(evenlySpaced(16)).toHaveLength(16);
    const spread = evenlySpaced(33);
    expect(spread).toHaveLength(16);
    expect(spread[0]).toBe(0);
    expect(spread.at(-1)).toBe(32);
    expect(new Set(spread).size).toBe(16);
    expect([...spread].sort((a, b) => a - b)).toEqual(spread);
  });
});

describe("buildContactSheet", () => {
  test("lays the shown frames out row-major so each cell holds its own frame", async () => {
    const frames = await Promise.all(Array.from({ length: 33 }, async (_, i) => ({ png: await solid(i * 7), label: String(i + 1) })));
    const sheet = await buildContactSheet(frames);
    expect(sheet.shown).toEqual(evenlySpaced(33));
    const px = await decodeRgba(sheet.png);
    expect([px.width, px.height]).toEqual([sheet.width, sheet.height]);
    // 4 columns of 64px cells with 6px gaps; the cell centre of slot 5 (row 1, column 1) is frame sheet.shown[5]
    const cell = (slot: number) => {
      const x = 6 + (slot % 4) * (64 + 6) + 32;
      const y = 6 + Math.floor(slot / 4) * (96 + 22 + 6) + 48;
      return px.data[(y * px.width + x) * 4];
    };
    for (const slot of [0, 5, 15]) expect(cell(slot)).toBe(sheet.shown[slot]! * 7);
  });

  test("a single frame still yields a sheet, and an undecodable frame is named", async () => {
    const one = await buildContactSheet([{ png: await solid(40), label: "1" }]);
    expect(one.shown).toEqual([0]);
    await expect(buildContactSheet([{ png: await solid(40), label: "1" }, { png: new Uint8Array([9, 9, 9]), label: "2" }])).rejects.toThrow("frame 1");
  });
});
