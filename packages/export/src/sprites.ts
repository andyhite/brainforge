import { layoutSprites, type AtlasOptions, type SpriteLayout, type SpriteRect } from "@brainforge/media";
import { assetDir, isStill, sortedDeliverables, type StillDeliverable } from "./layout.ts";
import type { ExportAsset } from "./types.ts";

/** Same gutters, extrusion and page cap as an animation atlas. */
export const SPRITE_ATLAS: AtlasOptions = { maxSize: 4096, padding: 2, extrude: 1 };

export const spritesDir = (assetId: string): string => `${assetDir(assetId)}/sprites`;
export const spritesJsonPath = (assetId: string): string => `${spritesDir(assetId)}/sprites.json`;
export const spriteAtlasPath = (assetId: string, page: number): string => `${spritesDir(assetId)}/atlas-${page}.png`;

export interface SpritePlan {
  /** `atlas`: states exist only in the atlas; `both`: individual PNGs are emitted too. */
  packaging: "atlas" | "both";
  /** Packed stills in id order (the layout order). */
  members: StillDeliverable[];
  layout: SpriteLayout;
}

export interface SpritesDocument {
  schema: "brainforge.sprites.v2";
  assetId: string;
  atlasPages: { page: number; file: string; width: number; height: number }[];
  sprites: { id: string; state: string; page: number; x: number; y: number; width: number; height: number; nineSlice?: { left: number; top: number; right: number; bottom: number } }[];
}

/**
 * The sprite atlas of one asset, or undefined when it does not pack. Every still that is not a tile joins (a tile
 * set must stay one addressable PNG); layout depends only on canvas sizes and ids, never on the export id.
 */
export function planSprites(asset: ExportAsset): SpritePlan | undefined {
  if (asset.sprites !== "atlas" && asset.sprites !== "both") return undefined;
  const members = sortedDeliverables(asset).filter(isStill).filter((d) => !d.tile);
  if (members.length === 0) return undefined;
  const layout = layoutSprites(members.map((d) => ({ id: d.deliverableId, width: d.canvas.width, height: d.canvas.height })), SPRITE_ATLAS);
  return { packaging: asset.sprites, members, layout };
}

export const spriteRect = (plan: SpritePlan | undefined, deliverableId: string): SpriteRect | undefined => plan?.layout.rects.find((r) => r.id === deliverableId);

export function spritesDocument(asset: ExportAsset, plan: SpritePlan): SpritesDocument {
  return {
    schema: "brainforge.sprites.v2",
    assetId: asset.assetId,
    atlasPages: plan.layout.pages.map((p, page) => ({ page, file: `atlas-${page}.png`, width: p.width, height: p.height })),
    sprites: plan.members.map((d, i) => {
      const r = plan.layout.rects[i]!;
      return { id: d.deliverableId, state: d.state ?? d.deliverableId, page: r.page, x: r.x, y: r.y, width: r.width, height: r.height, ...(d.nineSlice ? { nineSlice: d.nineSlice } : {}) };
    }),
  };
}
