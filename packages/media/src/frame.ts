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

/** True when the foreground box reaches a canvas edge. */
export const touchesEdge = (b: Bounds, w: number, h: number): boolean => b.x <= 0 || b.y <= 0 || b.x + b.width >= w || b.y + b.height >= h;

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
  const clipped = await foregroundBounds(out).then((b) => touchesEdge(b, t.canvas.width, t.canvas.height), () => false); // no foreground: nothing touches an edge
  return { png: out, clipped };
}

/**
 * Moves an already framed canvas by whole pixels (an authored per-frame correction applied after scaling).
 * Pixels pushed off the canvas are lost; callers detect that from the bounds they track.
 */
export async function shiftCanvas(png: Uint8Array, dx: number, dy: number): Promise<Uint8Array> {
  if (dx === 0 && dy === 0) return png;
  const { width: w, height: h } = await sharp(png).metadata();
  if (!w || !h) throw new MediaError("decode_failed", "no dimensions");
  const blank = sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const cw = w - Math.abs(dx), ch = h - Math.abs(dy);
  if (cw <= 0 || ch <= 0) return blank.png().toBuffer();
  const piece = await sharp(png).ensureAlpha().extract({ left: Math.max(0, -dx), top: Math.max(0, -dy), width: cw, height: ch }).png().toBuffer();
  return blank.composite([{ input: piece, left: Math.max(0, dx), top: Math.max(0, dy) }]).png().toBuffer();
}

/** Alpha at or above this becomes fully opaque under `alpha: "snap-near-opaque"` (matting leaves foreground at 254). */
export const NEAR_OPAQUE_ALPHA = 254;

/** Sets every alpha >= 254 to 255; lower values (soft edges) and colour channels are untouched. */
export async function snapNearOpaque(png: Uint8Array): Promise<Uint8Array> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) if (data[i]! >= NEAR_OPAQUE_ALPHA) data[i] = 255;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
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
