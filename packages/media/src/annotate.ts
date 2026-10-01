import sharp from "sharp";
import type { Geometry } from "@brainforge/contracts";
import { MediaError } from "./decode.ts";

export interface RenderNote {
  /** Label drawn on the render; matches the numbering in the revision's note list. */
  number: number;
  geometry: Geometry;
}

const DARK = "#111111";
const LIGHT = "#ffd400";

function noteSvg(note: RenderNote, width: number, height: number, unit: number): string {
  const r = Math.max(11, unit * 0.028);
  const stroke = Math.max(2, unit * 0.004);
  const font = Math.round(r * 1.25);
  const badge = (cx: number, cy: number): string =>
    `<circle cx="${cx}" cy="${cy}" r="${r + stroke}" fill="${DARK}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${LIGHT}"/>`
    + `<text x="${cx}" y="${cy + font * 0.36}" font-family="Helvetica, Arial, sans-serif" font-size="${font}" font-weight="700" text-anchor="middle" fill="${DARK}">${note.number}</text>`;
  const g = note.geometry;
  if (g.kind === "pin") return badge(g.x * width, g.y * height);
  if (g.kind === "rect") {
    const x = g.x * width;
    const y = g.y * height;
    const w = g.width * width;
    const h = g.height * height;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${DARK}" stroke-width="${stroke * 3}"/>`
      + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${LIGHT}" stroke-width="${stroke}"/>`
      + badge(Math.min(width - r, Math.max(r, x)), Math.min(height - r, Math.max(r, y)));
  }
  const inset = stroke * 2;
  return `<rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" fill="none" stroke="${DARK}" stroke-width="${stroke * 3}"/>`
    + `<rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" fill="none" stroke="${LIGHT}" stroke-width="${stroke}"/>`
    + badge(r + inset + stroke * 2, r + inset + stroke * 2);
}

/**
 * Draw numbered pins and rectangles (dark outline plus bright inner line, readable on any art) over a copy of
 * the image. Whole-image notes get a frame and a corner badge. The result is a PNG of the original size.
 */
export async function renderAnnotated(imageBytes: Uint8Array, notes: readonly RenderNote[]): Promise<Buffer> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(imageBytes).metadata();
  } catch (cause) {
    throw new MediaError("decode_failed", `annotated render: ${(cause as Error).message}`);
  }
  const { width, height } = meta;
  if (!width || !height) throw new MediaError("decode_failed", "annotated render: image has no dimensions");
  const unit = Math.min(width, height);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${notes.map((n) => noteSvg(n, width, height, unit)).join("")}</svg>`;
  return sharp(imageBytes).ensureAlpha().composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

/** Longest side clamped to `max` (never enlarged); PNG keeps alpha. */
export async function resizeToMax(imageBytes: Uint8Array, max: number): Promise<{ bytes: Buffer; width: number; height: number }> {
  try {
    const { data, info } = await sharp(imageBytes).resize({ width: max, height: max, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height };
  } catch (cause) {
    throw new MediaError("decode_failed", `resize: ${(cause as Error).message}`);
  }
}
