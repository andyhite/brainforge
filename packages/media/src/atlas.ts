import sharp from "sharp";
import { MediaError } from "./decode.ts";

export interface AtlasRect { page: number; x: number; y: number; width: number; height: number }
export interface AtlasPage { png: Uint8Array; width: number; height: number }
export interface BuiltAtlas { pages: AtlasPage[]; frames: AtlasRect[] }

export interface AtlasOptions { maxSize: number; padding: number; extrude: number }

/**
 * Page geometry for `count` equally sized canvases, without touching pixels. Throws `invalid_input` when one
 * extruded cell cannot fit a page (impossible packing), so plans can say so before any work happens.
 */
export function atlasLayout(width: number, height: number, count: number, opts: AtlasOptions): { cols: number; rows: number; perPage: number; pages: number } {
  const { maxSize, padding, extrude } = opts;
  const cellW = width + 2 * extrude, cellH = height + 2 * extrude;
  if (cellW > maxSize || cellH > maxSize) throw new MediaError("invalid_input", `frame ${width}x${height} with extrusion exceeds atlas max ${maxSize}`);
  const cols = Math.floor((maxSize + padding) / (cellW + padding));
  const rows = Math.floor((maxSize + padding) / (cellH + padding));
  const perPage = cols * rows;
  return { cols, rows, perPage, pages: Math.ceil(count / perPage) };
}

/**
 * Row-major atlas of equally sized complete (untrimmed) canvases, no rotation.
 * Each frame has `extrude` px of edge replication, separated by `padding` px
 * gutters. Overflow starts a new page; no page exceeds `maxSize`.
 */
export async function buildAtlas(frames: Uint8Array[], opts: AtlasOptions): Promise<BuiltAtlas> {
  if (frames.length === 0) throw new MediaError("empty", "no frames to pack");
  const meta = await Promise.all(frames.map((f) => sharp(f).metadata()));
  const { width: w, height: h } = meta[0]!;
  if (!w || !h) throw new MediaError("decode_failed", "frame has no dimensions");
  if (meta.some((m) => m.width !== w || m.height !== h)) throw new MediaError("invalid_input", "frames must share one canvas size");
  const { padding, extrude } = opts;
  const cellW = w + 2 * extrude, cellH = h + 2 * extrude;
  const { cols, perPage } = atlasLayout(w, h, frames.length, opts);
  const rects: AtlasRect[] = [];
  const pages: AtlasPage[] = [];
  for (let start = 0; start < frames.length; start += perPage) {
    const slice = frames.slice(start, start + perPage);
    const usedCols = Math.min(cols, slice.length);
    const usedRows = Math.ceil(slice.length / cols);
    const pw = usedCols * cellW + (usedCols - 1) * padding;
    const ph = usedRows * cellH + (usedRows - 1) * padding;
    const layers: sharp.OverlayOptions[] = [];
    for (const [i, f] of slice.entries()) {
      const cx = (i % cols) * (cellW + padding), cy = Math.floor(i / cols) * (cellH + padding);
      const cell = extrude > 0
        ? await sharp(f).ensureAlpha().extend({ top: extrude, bottom: extrude, left: extrude, right: extrude, extendWith: "copy" }).png().toBuffer()
        : await sharp(f).ensureAlpha().png().toBuffer();
      layers.push({ input: cell, left: cx, top: cy });
      rects.push({ page: pages.length, x: cx + extrude, y: cy + extrude, width: w, height: h });
    }
    const png = await sharp({ create: { width: pw, height: ph, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(layers).png({ compressionLevel: 9, palette: false }).toBuffer();
    pages.push({ png, width: pw, height: ph });
  }
  return { pages, frames: rects };
}
