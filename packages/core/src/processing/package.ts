import { animationDocument, buildAtlas, buildContactSheet, layoutSprites, serializeAnimation } from "@brainforge/media";
import { animationFileId, atlasFileId, contactFileId, frameFileName, type DerivedFileInput, type FrameInput } from "../outputs/frames.ts";

export interface PackageSpec {
  outputId: string;
  canvas: { width: number; height: number };
  /** Normalized output pivot. */
  pivot: { x: number; y: number };
  loop: boolean;
  sourceFps: number;
  playbackFps: number;
  packaging: "frames" | "atlas" | "both";
  atlas: { maxSize: number; padding: number; extrude: number };
  frames: readonly { png: Uint8Array; sourceFrame: number; durationMs: number }[];
}

const ANIMATION_FILE = "animation.json";
const CONTACT_FILE = "contact.png";
const atlasFileName = (page: number): string => `atlas-${page}.png`;

/**
 * Everything derived from a finished frame sequence: atlas pages when the recipe packs, the `animation.json` that
 * drives playback (real durations, source frames, packed rectangles) and a contact sheet. Frame PNGs are always
 * kept; `packaging` decides whether an atlas is built. Pure repacking: pixels are never resized or resampled.
 */
export async function packageClip(spec: PackageSpec): Promise<{ frames: FrameInput[]; files: DerivedFileInput[] }> {
  const pngs = spec.frames.map((f) => f.png);
  const atlas = spec.packaging === "frames" ? undefined : await buildAtlas(pngs, spec.atlas);
  const files: DerivedFileInput[] = [];
  for (const [page, p] of (atlas?.pages ?? []).entries()) {
    files.push({ kind: "atlas-page", fileId: atlasFileId(spec.outputId, page), page, filename: atlasFileName(page), bytes: p.png, mediaType: "image/png", width: p.width, height: p.height });
  }
  const frames: FrameInput[] = spec.frames.map((f, i) => ({
    png: f.png, sourceFrame: f.sourceFrame, durationMs: f.durationMs,
    ...(atlas ? { atlas: { page: atlas.frames[i]!.page, x: atlas.frames[i]!.x, y: atlas.frames[i]!.y } } : {}),
  }));
  const doc = animationDocument({
    sourceFps: spec.sourceFps, playbackFps: spec.playbackFps, loop: spec.loop, canvas: spec.canvas, pivot: spec.pivot,
    frames: spec.frames.map((f, i) => ({
      index: i, durationMs: f.durationMs, sourceFrame: f.sourceFrame, file: frameFileName(i),
      ...(atlas ? { atlas: { ...atlas.frames[i]! } } : {}),
    })),
    ...(atlas ? { atlasPages: atlas.pages.map((p, page) => ({ page, file: atlasFileName(page), width: p.width, height: p.height })) } : {}),
  });
  files.push({ kind: "animation-json", fileId: animationFileId(spec.outputId), filename: ANIMATION_FILE, bytes: new TextEncoder().encode(serializeAnimation(doc)), mediaType: "application/json" });
  const sheet = await buildContactSheet(spec.frames.map((f, i) => ({ png: f.png, label: f.sourceFrame === i ? `${i}` : `${i} (src ${f.sourceFrame})` })));
  files.push({ kind: "contact-sheet", fileId: contactFileId(spec.outputId), filename: CONTACT_FILE, bytes: sheet.png, mediaType: "image/png", width: sheet.width, height: sheet.height });
  return { frames, files };
}

/** Number of atlas pages a clip will need, without building any pixels (throws `invalid_input` when a frame cannot fit). */
export const atlasPageCount = (canvas: { width: number; height: number }, frameCount: number, atlas: PackageSpec["atlas"]): number =>
  layoutSprites(Array.from({ length: frameCount }, (_, i) => ({ id: String(i), ...canvas })), atlas).pages.length;
