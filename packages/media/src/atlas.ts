import sharp from "sharp";
import { MediaError } from "./decode.ts";

export interface AtlasRect { page: number; x: number; y: number; width: number; height: number }
export interface AtlasPage { png: Uint8Array; width: number; height: number }
export interface BuiltAtlas { pages: AtlasPage[]; frames: AtlasRect[] }

export interface AtlasOptions { maxSize: number; padding: number; extrude: number }

/**
 * Row-major atlas of equally sized complete (untrimmed) canvases, no rotation: the shelf layout below with one
 * size. Each frame has `extrude` px of edge replication, separated by `padding` px gutters. Overflow starts a new
 * page; no page exceeds `maxSize`.
 */
export async function buildAtlas(frames: Uint8Array[], opts: AtlasOptions): Promise<BuiltAtlas> {
  if (frames.length === 0) throw new MediaError("empty", "no frames to pack");
  const { width, height } = await sharp(frames[0]!).metadata();
  const sprites = frames.map((png, i) => ({ id: String(i), png }));
  const layout = layoutSprites(sprites.map(({ id }) => ({ id, width: width!, height: height! })), opts);
  return { pages: await buildSpriteAtlas(sprites, layout, opts.extrude), frames: layout.rects.map(({ id, ...rect }) => rect) };
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
