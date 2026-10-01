import sharp from "sharp";
import { MediaError } from "./decode.ts";

export interface ContactFrame {
  png: Uint8Array;
  /** Shown under the cell, e.g. `3` or `3 (src 5)`. */
  label: string;
}

export interface ContactSheet {
  png: Uint8Array;
  width: number;
  height: number;
  /** Indices (into the input) of the frames drawn, in order. */
  shown: number[];
}

const MAX_FRAMES = 16;
const CELL = 192;
const LABEL_H = 22;
const GAP = 6;
const CHECK = 12;

/** Up to `limit` indices spread evenly over `count`, always including the first and the last. */
export function evenlySpaced(count: number, limit = MAX_FRAMES): number[] {
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  return Array.from({ length: limit }, (_, i) => Math.round((i * (count - 1)) / (limit - 1)));
}

function checker(width: number, height: number): Buffer {
  const rects: string[] = [];
  for (let y = 0; y < height; y += CHECK) {
    for (let x = 0; x < width; x += CHECK) {
      if (((x / CHECK) + (y / CHECK)) % 2 === 0) rects.push(`<rect x="${x}" y="${y}" width="${CHECK}" height="${CHECK}" fill="#c9c9c9"/>`);
    }
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ededed"/>${rects.join("")}</svg>`);
}

const escape = (s: string): string => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);

/**
 * A labelled grid of at most 16 evenly spaced frames (first and last always included) on a checker backdrop, so
 * a reviewer who only receives still images can still read the motion. Frames keep their aspect ratio, untrimmed.
 */
export async function buildContactSheet(frames: readonly ContactFrame[]): Promise<ContactSheet> {
  if (frames.length === 0) throw new MediaError("invalid_input", "contact sheet needs at least one frame");
  const shown = evenlySpaced(frames.length);
  const first = await sharp(frames[0]!.png).metadata();
  if (!first.width || !first.height) throw new MediaError("decode_failed", "contact sheet: frame 0 has no dimensions");
  const scale = Math.min(CELL / first.width, CELL / first.height, 1);
  const cw = Math.max(1, Math.round(first.width * scale));
  const ch = Math.max(1, Math.round(first.height * scale));
  const cols = Math.min(4, shown.length);
  const rows = Math.ceil(shown.length / cols);
  const width = cols * cw + (cols + 1) * GAP;
  const height = rows * (ch + LABEL_H) + (rows + 1) * GAP;

  const layers: sharp.OverlayOptions[] = [];
  const labels: string[] = [];
  for (const [slot, index] of shown.entries()) {
    const left = GAP + (slot % cols) * (cw + GAP);
    const top = GAP + Math.floor(slot / cols) * (ch + LABEL_H + GAP);
    layers.push({ input: checker(cw, ch), left, top });
    let cell: Buffer;
    try {
      cell = await sharp(frames[index]!.png).ensureAlpha().resize(cw, ch, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
    } catch (cause) {
      throw new MediaError("decode_failed", `contact sheet: frame ${index}: ${(cause as Error).message}`);
    }
    layers.push({ input: cell, left, top });
    labels.push(`<text x="${left + cw / 2}" y="${top + ch + 16}" font-family="Helvetica, Arial, sans-serif" font-size="14" font-weight="700" text-anchor="middle" fill="#111111">${escape(frames[index]!.label)}</text>`);
  }
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels.join("")}</svg>`), left: 0, top: 0 });
  const png = await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(layers).png().toBuffer();
  return { png, width, height, shown };
}
