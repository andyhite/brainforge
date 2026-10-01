import type { ExportAsset, ExportDeliverable, ExportFrame } from "./types.ts";

/** Snapshot-root-relative posix paths of the documented layout. */
export const assetDir = (assetId: string): string => `assets/${assetId}`;
export const assetJsonPath = (assetId: string): string => `${assetDir(assetId)}/asset.json`;
export const stillPath = (assetId: string, deliverableId: string): string => `${assetDir(assetId)}/stills/${deliverableId}.png`;
export const animationDir = (assetId: string, deliverableId: string): string => `${assetDir(assetId)}/animations/${deliverableId}`;
export const framePath = (assetId: string, deliverableId: string, index: number): string => `${animationDir(assetId, deliverableId)}/frames/${String(index).padStart(4, "0")}.png`;
export const atlasPagePath = (assetId: string, deliverableId: string, page: number): string => `${animationDir(assetId, deliverableId)}/atlas-${page}.png`;
export const animationJsonPath = (assetId: string, deliverableId: string): string => `${animationDir(assetId, deliverableId)}/animation.json`;
export const godotDir = (assetId: string): string => `${assetDir(assetId)}/godot`;
export const godotAnimationsPath = (assetId: string): string => `${godotDir(assetId)}/animations.tres`;
export const godotTexturePath = (assetId: string, deliverableId: string): string => `${godotDir(assetId)}/textures/${deliverableId}.tres`;
export const godotStyleBoxPath = (assetId: string, deliverableId: string): string => `${godotDir(assetId)}/styleboxes/${deliverableId}.tres`;
export const godotTileSetPath = (assetId: string, deliverableId: string): string => `${godotDir(assetId)}/tilesets/${deliverableId}.tres`;

export const usesFrames = (packaging: string): boolean => packaging === "frames" || packaging === "both";
export const usesAtlas = (packaging: string): boolean => packaging === "atlas" || packaging === "both";

export type AnimationDeliverable = ExportDeliverable & { media: Extract<ExportDeliverable["media"], { kind: "animation" }> };
export type StillDeliverable = ExportDeliverable & { media: Extract<ExportDeliverable["media"], { kind: "still" }> };

export const isAnimation = (d: ExportDeliverable): d is AnimationDeliverable => d.media.kind === "animation";
export const isStill = (d: ExportDeliverable): d is StillDeliverable => d.media.kind === "still";

export const sortedAssets = (assets: ExportAsset[]): ExportAsset[] => [...assets].sort((a, b) => a.assetId.localeCompare(b.assetId));
export const sortedDeliverables = (asset: ExportAsset): ExportDeliverable[] => [...asset.deliverables].sort((a, b) => a.deliverableId.localeCompare(b.deliverableId));
export const sortedFrames = (frames: ExportFrame[]): ExportFrame[] => [...frames].sort((a, b) => a.index - b.index);
