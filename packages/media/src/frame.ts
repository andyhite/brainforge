import sharp from "sharp";
import { decodeRgba, MediaError } from "./decode.ts";

export interface Bounds { x: number; y: number; width: number; height: number }

/** Bounding box of pixels with alpha above `threshold`. Throws `empty` if none. */
export async function foregroundBounds(png: Uint8Array, threshold = 16): Promise<Bounds> {
  const { width, height, data } = await decodeRgba(png);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new MediaError("empty", "no foreground pixels (fully transparent image)");
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface FramingTransform {
  /** Source pixels per output pixel is 1/scale. */
  scale: number;
  canvas: { width: number; height: number };
  /** Where the source foreground bottom-centre lands in the canvas (feet anchor). */
  anchor: { x: number; y: number };
  sourceBounds: Bounds;
  subjectHeightPx: number;
}

/**
 * Fixed transform calibrated from a neutral reference: uniform scale puts the
 * foreground's standing height at `subjectHeightPx`; the foreground bottom-centre
 * maps to `anchor` (default: centred horizontally, 12px above the bottom edge).
 */
export function calibrateFraming(sourceBounds: Bounds, opts: {
  subjectHeightPx: number; canvas: { width: number; height: number }; anchor?: { x: number; y: number };
}): FramingTransform {
  return {
    scale: opts.subjectHeightPx / sourceBounds.height,
    canvas: opts.canvas,
    anchor: opts.anchor ?? { x: opts.canvas.width / 2, y: opts.canvas.height - 12 },
    sourceBounds,
    subjectHeightPx: opts.subjectHeightPx,
  };
}

/** Applies a calibrated transform to a same-sized source; throws `clipped` if foreground leaves the canvas. */
export async function applyFraming(png: Uint8Array, t: FramingTransform): Promise<{ png: Uint8Array; clipped: boolean }> {
  const meta = await sharp(png).metadata();
  if (!meta.width || !meta.height) throw new MediaError("decode_failed", "no dimensions");
  const w = Math.max(1, Math.round(meta.width * t.scale));
  const h = Math.max(1, Math.round(meta.height * t.scale));
  const scaled = await sharp(png).ensureAlpha().resize(w, h, { kernel: "lanczos3" }).png().toBuffer();
  const fx = (t.sourceBounds.x + t.sourceBounds.width / 2) * t.scale;
  const fy = (t.sourceBounds.y + t.sourceBounds.height) * t.scale;
  const left = Math.round(t.anchor.x - fx);
  const top = Math.round(t.anchor.y - fy);
  // Extract the visible window of the scaled image and composite on a transparent canvas.
  const sx = Math.max(0, -left), sy = Math.max(0, -top);
  const dx = Math.max(0, left), dy = Math.max(0, top);
  const cw = Math.min(w - sx, t.canvas.width - dx), ch = Math.min(h - sy, t.canvas.height - dy);
  const base = sharp({ create: { width: t.canvas.width, height: t.canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  if (cw <= 0 || ch <= 0) throw new MediaError("clipped", "framing places the subject wholly outside the canvas");
  const piece = await sharp(scaled).extract({ left: sx, top: sy, width: cw, height: ch }).png().toBuffer();
  const out = await base.composite([{ input: piece, left: dx, top: dy }]).png().toBuffer();
  // Clipped if any foreground touches a canvas edge.
  const edge = await decodeRgba(out);
  let clipped = false;
  for (let x = 0; x < edge.width && !clipped; x++) {
    if ((edge.data[x * 4 + 3] ?? 0) > 16 || (edge.data[((edge.height - 1) * edge.width + x) * 4 + 3] ?? 0) > 16) clipped = true;
  }
  for (let y = 0; y < edge.height && !clipped; y++) {
    if ((edge.data[y * edge.width * 4 + 3] ?? 0) > 16 || (edge.data[(y * edge.width + edge.width - 1) * 4 + 3] ?? 0) > 16) clipped = true;
  }
  return { png: out, clipped };
}

export type FieldBackground = "dark" | "light" | "checker";

async function backgroundField(kind: FieldBackground, width: number, height: number): Promise<Buffer> {
  if (kind === "checker") {
    const tile = 16;
    const rects: string[] = [];
    for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) {
      if (((x / tile) + (y / tile)) % 2 === 0) rects.push(`<rect x="${x}" y="${y}" width="${tile}" height="${tile}" fill="#b8b8b8"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#e6e6e6"/>${rects.join("")}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
  const c = kind === "dark" ? { r: 34, g: 36, b: 42 } : { r: 236, g: 232, b: 222 };
  return sharp({ create: { width, height, channels: 3, background: c } }).png().toBuffer();
}

/**
 * 1280x720 comparison field: the framed canvas displayed at several standing
 * heights side by side, feet on a shared baseline. `canvasSubjectHeightPx` is
 * the standing height inside the framed canvas (display scale = H / that).
 */
export async function comparisonField(framed: Uint8Array, opts: {
  background: FieldBackground; displayHeights: number[]; canvasSubjectHeightPx: number; canvasAnchorY: number; size?: { width: number; height: number };
}): Promise<Uint8Array> {
  const { width, height } = opts.size ?? { width: 1280, height: 720 };
  const meta = await sharp(framed).metadata();
  const cw = meta.width ?? 256, ch = meta.height ?? 256;
  const baseline = height - 140;
  const slot = width / opts.displayHeights.length;
  const layers: sharp.OverlayOptions[] = [];
  const labels: string[] = [];
  for (const [i, H] of opts.displayHeights.entries()) {
    const s = H / opts.canvasSubjectHeightPx;
    const dw = Math.round(cw * s), dh = Math.round(ch * s);
    // Nearest-neighbour keeps the displayed pixels honest for pixel-level review.
    const img = await sharp(framed).resize(dw, dh, { kernel: "nearest" }).png().toBuffer();
    layers.push({ input: img, left: Math.round(slot * i + slot / 2 - dw / 2), top: Math.round(baseline - opts.canvasAnchorY * s) });
    const fill = opts.background === "dark" ? "#e8e8e8" : "#202020";
    labels.push(`<text x="${Math.round(slot * i + slot / 2)}" y="${baseline + 40}" text-anchor="middle" font-family="Helvetica" font-size="20" fill="${fill}">${H}px standing height</text>`);
  }
  const fill = opts.background === "dark" ? "#888" : "#555";
  labels.push(`<line x1="0" y1="${baseline}" x2="${width}" y2="${baseline}" stroke="${fill}" stroke-dasharray="6 6"/>`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels.join("")}</svg>`);
  const bg = await backgroundField(opts.background, width, height);
  return sharp(bg).composite([...layers, { input: svg, left: 0, top: 0 }]).png().toBuffer();
}

/** Composite RGBA onto an opaque colour (default light grey 216,216,216, matching the Krea concept backdrop). */
export async function flattenOnGrey(png: Uint8Array, grey = 216): Promise<Uint8Array> {
  return sharp(png).flatten({ background: { r: grey, g: grey, b: grey } }).png().toBuffer();
}

/** Pixel-exact crop of a named region; throws if it leaves the image. */
export async function extractRegion(png: Uint8Array, r: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
  const meta = await sharp(png).metadata();
  if (r.x + r.width > (meta.width ?? 0) || r.y + r.height > (meta.height ?? 0)) throw new MediaError("invalid_input", "region exceeds image bounds");
  return sharp(png).extract({ left: r.x, top: r.y, width: r.width, height: r.height }).png().toBuffer();
}
