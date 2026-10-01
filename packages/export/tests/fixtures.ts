import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ExportAsset, ExportDeliverable, ExportFrame, ExportInput, ExportPackaging } from "../src/index.ts";

export const tempDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "bf-export-"));

/** Solid-colour PNG; the colour makes every fixture's bytes distinct and deterministic. */
export async function makePng(file: string, width: number, height: number, seed: number): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: { r: seed % 256, g: (seed * 7) % 256, b: (seed * 13) % 256, alpha: 1 } } }).png().toFile(file);
  return file;
}

export const CANVAS = 16;
export const FRAME_DURATIONS = [1000 / 12, 1000 / 12, 100];

export interface FixtureOptions {
  /** Where source files live (an immutable-version-directory stand-in). */
  sourceDir: string;
  exportId?: string;
  versionId?: string;
  packaging?: ExportPackaging;
  frameCount?: number;
  /** Changes every source byte so two versions differ. */
  seed?: number;
  godot?: ExportInput["godot"];
  preset?: ExportInput["preset"];
}

export async function animationDeliverable(o: FixtureOptions, id: string, loop: boolean): Promise<ExportDeliverable> {
  const seed = o.seed ?? 1;
  const packaging = o.packaging ?? "both";
  const count = o.frameCount ?? 3;
  const frames: ExportFrame[] = [];
  for (let i = 0; i < count; i++) {
    const sourcePath = await makePng(path.join(o.sourceDir, id, `frame-${i}.png`), CANVAS, CANVAS, seed * 31 + i + id.length);
    frames.push({
      index: i,
      durationMs: FRAME_DURATIONS[i % FRAME_DURATIONS.length]!,
      sourceFrame: i * 2,
      ...(packaging !== "atlas" ? { sourcePath } : {}),
      ...(packaging !== "frames" ? { atlas: { page: 0, x: (i % 2) * CANVAS, y: Math.floor(i / 2) * CANVAS, width: CANVAS, height: CANVAS } } : {}),
    });
  }
  const atlasPath = await makePng(path.join(o.sourceDir, id, "atlas-0.png"), CANVAS * 2, CANVAS * 2, seed * 17 + 5);
  return {
    deliverableId: id, kind: "animation", candidateId: `cand-${id}`, outputHash: `hash-${id}`,
    media: {
      kind: "animation", frames, loop, sourceFps: 16, playbackFps: 12, packaging,
      ...(packaging !== "frames" ? { atlasPages: [{ sourcePath: atlasPath, width: CANVAS * 2, height: CANVAS * 2 }] } : {}),
    },
    canvas: { width: CANVAS, height: CANVAS }, pivot: { x: 8, y: 14 }, displayScale: 0.5, relativeScale: 1, metadata: { motion: id },
  };
}

export async function stillDeliverable(o: FixtureOptions, id: string, kind: string, extra: Partial<ExportDeliverable> = {}, size = CANVAS): Promise<ExportDeliverable> {
  const sourcePath = await makePng(path.join(o.sourceDir, `${id}.png`), size, size, (o.seed ?? 1) * 5 + id.length);
  return {
    deliverableId: id, kind, candidateId: `cand-${id}`, outputHash: `hash-${id}`, media: { kind: "still", sourcePath },
    canvas: { width: size, height: size }, pivot: { x: size / 2, y: size }, metadata: {}, ...extra,
  };
}

export async function characterAsset(o: FixtureOptions, extras: ExportDeliverable[] = []): Promise<ExportAsset> {
  return {
    assetId: "cortex", family: "character", versionId: o.versionId ?? "ver-1", requirementsHash: "req-1", dependencies: [], metadata: { note: "fixture" },
    deliverables: [await animationDeliverable(o, "walk", true), await animationDeliverable(o, "idle", true), await stillDeliverable(o, "front", "view"), ...extras],
  };
}

export async function makeInput(o: FixtureOptions, assets?: ExportAsset[]): Promise<ExportInput> {
  return {
    projectId: "proj-1", exportId: o.exportId ?? "exp-1", preset: o.preset ?? "generic", createdAt: "2026-10-01T00:00:00.000Z",
    ...(o.godot ? { godot: o.godot } : {}),
    assets: assets ?? [await characterAsset(o)],
  };
}

export const writeText = async (file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};
