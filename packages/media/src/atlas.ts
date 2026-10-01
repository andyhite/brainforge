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

export interface SpriteSize { id: string; width: number; height: number }
export interface SpriteRect extends AtlasRect { id: string }
export interface SpriteLayout { pages: { width: number; height: number }[]; rects: SpriteRect[]; cells: { page: number; x: number; y: number; width: number; height: number }[] }

/**
 * Shelf layout for sprites of DIFFERENT sizes (a UI state set or icon sheet), in the given order, no rotation, same
 * `padding` gutters and `extrude` edge replication as the animation atlas, and no page beyond `maxSize`. Pure
 * geometry from sizes only, so exporters can plan resources before reading a pixel. `rects` are the sprite rectangles
 * (inside their extrusion); `cells` include the extrusion.
 */
export function layoutSprites(sprites: readonly SpriteSize[], opts: AtlasOptions): SpriteLayout {
  const { maxSize, padding, extrude } = opts;
  if (sprites.length === 0) throw new MediaError("empty", "no sprites to pack");
  const pages: { width: number; height: number }[] = [];
  const rects: SpriteRect[] = [];
  const cells: SpriteLayout["cells"] = [];
  let page = 0, x = 0, y = 0, rowH = 0;
  for (const s of sprites) {
    if (!(s.width > 0 && s.height > 0)) throw new MediaError("invalid_input", `sprite ${s.id} has an empty size`);
    const cw = s.width + 2 * extrude, ch = s.height + 2 * extrude;
    if (cw > maxSize || ch > maxSize) throw new MediaError("invalid_input", `sprite ${s.id} (${s.width}x${s.height}) with extrusion exceeds atlas max ${maxSize}`);
    if (x > 0 && x + cw > maxSize) { x = 0; y += rowH + padding; rowH = 0; }
    if (y > 0 && y + ch > maxSize) { page++; x = 0; y = 0; rowH = 0; }
    const current = (pages[page] ??= { width: 0, height: 0 });
    current.width = Math.max(current.width, x + cw);
    current.height = Math.max(current.height, y + ch);
    cells.push({ page, x, y, width: cw, height: ch });
    rects.push({ id: s.id, page, x: x + extrude, y: y + extrude, width: s.width, height: s.height });
    x += cw + padding;
    rowH = Math.max(rowH, ch);
  }
  return { pages, rects, cells };
}

/** Renders a `layoutSprites` layout; every PNG must have the size its layout entry was computed from. */
export async function buildSpriteAtlas(sprites: readonly { id: string; png: Uint8Array }[], layout: SpriteLayout, extrude: number): Promise<AtlasPage[]> {
  const layersByPage: sharp.OverlayOptions[][] = layout.pages.map(() => []);
  for (const [i, s] of sprites.entries()) {
    const rect = layout.rects[i]!, cell = layout.cells[i]!;
    if (rect.id !== s.id) throw new MediaError("invalid_input", `sprite ${s.id} does not match layout entry ${rect.id}`);
    const meta = await sharp(s.png).metadata();
    if (meta.width !== rect.width || meta.height !== rect.height) throw new MediaError("invalid_input", `sprite ${s.id} is ${meta.width}x${meta.height}, layout expects ${rect.width}x${rect.height}`);
    const input = extrude > 0
      ? await sharp(s.png).ensureAlpha().extend({ top: extrude, bottom: extrude, left: extrude, right: extrude, extendWith: "copy" }).png().toBuffer()
      : await sharp(s.png).ensureAlpha().png().toBuffer();
    layersByPage[cell.page]!.push({ input, left: cell.x, top: cell.y });
  }
  return Promise.all(layout.pages.map(async (p, n) => ({
    png: await sharp({ create: { width: p.width, height: p.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layersByPage[n]!).png({ compressionLevel: 9, palette: false }).toBuffer(),
    width: p.width, height: p.height,
  })));
}
