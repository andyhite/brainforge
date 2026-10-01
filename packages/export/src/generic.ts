import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ExportManifest, type ExportOwnedFile } from "@brainforge/contracts";
import { animationDocument, buildSpriteAtlas, serializeAnimation, type AnimationDocument, type SpriteRect } from "@brainforge/media";
import {
  type AnimationDeliverable,
  animationDir, animationJsonPath, assetDir, assetJsonPath, atlasPagePath, framePath, isAnimation, isStill, sortedAssets,
  sortedDeliverables, sortedFrames, stillPath, usesAtlas, usesFrames,
} from "./layout.ts";
import { ExportError, InjectedFault, copyInto, fsyncPath, readPngSize, safeJoin, sha256Bytes, sha256File, writeSynced } from "./fs.ts";
import { planGodotFiles, type GodotFile } from "./godot4.ts";
import { SPRITE_ATLAS, planSprites, spriteAtlasPath, spriteRect, spritesDocument, spritesJsonPath, type SpritePlan, type SpritesDocument } from "./sprites.ts";
import type { ExportAsset, ExportDeliverable, ExportFaults, ExportInput, ExportOutcome } from "./types.ts";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const invalid = (message: string, field?: string): ExportError => new ExportError("INVALID_INPUT", message, field ? { field } : {});

/** Structural checks on the input that need no file access. */
function validateInput(input: ExportInput): void {
  if (input.preset === "godot4" && !input.godot) throw new ExportError("EXPORT_BLOCKED", "godot4 export requires a Godot target", { field: "godotProjectRoot", reason: "missing-godot-target" });
  if (!SEGMENT.test(input.exportId)) throw invalid(`export id "${input.exportId}" is not a safe path segment`, "exportId");
  const assetIds = new Set<string>();
  for (const asset of input.assets) {
    if (!SEGMENT.test(asset.assetId)) throw invalid(`asset id "${asset.assetId}" is not a safe path segment`, "assetId");
    if (assetIds.has(asset.assetId)) throw new ExportError("EXPORT_CONFLICT", `asset ${asset.assetId} is selected at more than one version`, { reason: "duplicate-asset" });
    assetIds.add(asset.assetId);
    const ids = new Set<string>();
    for (const d of asset.deliverables) {
      const where = `${asset.assetId}/${d.deliverableId}`;
      if (!SEGMENT.test(d.deliverableId)) throw invalid(`deliverable id "${d.deliverableId}" is not a safe path segment`, "deliverableId");
      if (ids.has(d.deliverableId)) throw invalid(`${where} is duplicated`, "deliverableId");
      ids.add(d.deliverableId);
      if (!(d.canvas.width > 0 && d.canvas.height > 0)) throw invalid(`${where} has an empty canvas`, "canvas");
      if (!(d.pivot.x >= 0 && d.pivot.x <= d.canvas.width && d.pivot.y >= 0 && d.pivot.y <= d.canvas.height)) throw invalid(`${where} pivot (${d.pivot.x}, ${d.pivot.y}) is outside the ${d.canvas.width}x${d.canvas.height} canvas`, "pivot");
      if (d.nineSlice) {
        const n = d.nineSlice;
        if (n.left < 0 || n.right < 0 || n.top < 0 || n.bottom < 0 || n.left + n.right > d.canvas.width || n.top + n.bottom > d.canvas.height) {
          throw invalid(`${where} nine-slice margins ${JSON.stringify(n)} do not fit the ${d.canvas.width}x${d.canvas.height} canvas`, "nineSlice");
        }
      }
      if (d.tile && !(Number.isInteger(d.tile.width) && Number.isInteger(d.tile.height) && d.tile.width > 0 && d.tile.height > 0)) throw invalid(`${where} tile size must be positive integers`, "tile");
      if (isAnimation(d)) validateAnimation(where, d);
    }
  }
}

function validateAnimation(where: string, d: AnimationDeliverable): void {
  const { media } = d;
  if (media.frames.length === 0) throw invalid(`${where} has no frames`, "frames");
  if (!(media.playbackFps > 0 && media.sourceFps > 0)) throw invalid(`${where} needs positive source and playback fps`, "fps");
  const frames = sortedFrames(media.frames);
  for (const [i, frame] of frames.entries()) {
    if (frame.index !== i) throw invalid(`${where} frame indices must be 0..${frames.length - 1}; found ${frame.index} at position ${i}`, "frames");
    if (!(frame.durationMs > 0)) throw invalid(`${where} frame ${i} has non-positive duration`, "frames");
    if (usesFrames(media.packaging) && !frame.sourcePath) throw invalid(`${where} frame ${i} has no PNG but packaging is "${media.packaging}"`, "frames");
    if (usesAtlas(media.packaging)) {
      const a = frame.atlas;
      if (!a || !media.atlasPages?.[a.page]) throw invalid(`${where} frame ${i} has no atlas rectangle on a declared page but packaging is "${media.packaging}"`, "frames");
    }
  }
}

interface Planned {
  copies: { source: string; dest: string; expect?: { width: number; height: number } }[];
  texts: { path: string; text: string }[];
  /** Assets whose stills pack into sprite atlas pages; built after the plain copies. */
  spriteAtlases: { asset: ExportAsset; sprites: SpritePlan }[];
}

function deliverableEntry(asset: ExportAsset, d: ExportDeliverable, files: string[], godot: GodotFile[], sprite?: SpriteRect): Record<string, unknown> {
  const assetPrefix = `assets/${asset.assetId}/`;
  const resources = godot.filter((g) => g.deliverableIds.includes(d.deliverableId)).map((g) => g.path.slice(assetPrefix.length));
  return {
    deliverableId: d.deliverableId,
    kind: d.kind,
    candidateId: d.candidateId,
    outputHash: d.outputHash,
    files: files.map((f) => f.slice(assetPrefix.length)),
    ...(isAnimation(d) ? { animation: animationJsonPath(asset.assetId, d.deliverableId).slice(assetPrefix.length) } : {}),
    canvas: d.canvas,
    pivot: d.pivot,
    pivotNormalized: { x: d.pivot.x / d.canvas.width, y: d.pivot.y / d.canvas.height },
    ...(d.displayScale !== undefined ? { displayScale: d.displayScale } : {}),
    ...(d.relativeScale !== undefined ? { relativeScale: d.relativeScale } : {}),
    ...(d.nineSlice ? { nineSlice: d.nineSlice } : {}),
    ...(d.state ? { state: d.state } : {}),
    ...(sprite ? { sprite: { file: spriteAtlasPath(asset.assetId, sprite.page).slice(assetPrefix.length), page: sprite.page, x: sprite.x, y: sprite.y, width: sprite.width, height: sprite.height } } : {}),
    ...(d.tile ? { tile: d.tile } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    metadata: d.metadata,
  };
}

function animationFile(asset: ExportAsset, d: AnimationDeliverable): { doc: AnimationDocument; copies: Planned["copies"]; files: string[] } {
  const { media } = d;
  const frames = sortedFrames(media.frames);
  const copies: Planned["copies"] = [];
  const files: string[] = [];
  const dir = `${animationDir(asset.assetId, d.deliverableId)}/`;
  if (usesFrames(media.packaging)) {
    for (const f of frames) {
      const dest = framePath(asset.assetId, d.deliverableId, f.index);
      copies.push({ source: f.sourcePath!, dest, expect: d.canvas });
      files.push(dest);
    }
  }
  const pages = usesAtlas(media.packaging) ? (media.atlasPages ?? []) : [];
  for (const [n, page] of pages.entries()) {
    const dest = atlasPagePath(asset.assetId, d.deliverableId, n);
    copies.push({ source: page.sourcePath, dest, expect: { width: page.width, height: page.height } });
    files.push(dest);
  }
  const doc = animationDocument({
    sourceFps: media.sourceFps, playbackFps: media.playbackFps, loop: media.loop, canvas: d.canvas,
    pivot: { x: d.pivot.x / d.canvas.width, y: d.pivot.y / d.canvas.height },
    frames: frames.map((f) => ({
      index: f.index, durationMs: f.durationMs, sourceFrame: f.sourceFrame,
      ...(usesFrames(media.packaging) ? { file: framePath(asset.assetId, d.deliverableId, f.index).slice(dir.length) } : {}),
      ...(usesAtlas(media.packaging) && f.atlas ? { atlas: { page: f.atlas.page, x: f.atlas.x, y: f.atlas.y, width: f.atlas.width, height: f.atlas.height } } : {}),
    })),
    ...(pages.length > 0 ? { atlasPages: pages.map((p, n) => ({ page: n, file: atlasPagePath(asset.assetId, d.deliverableId, n).slice(dir.length), width: p.width, height: p.height })) } : {}),
  });
  files.push(animationJsonPath(asset.assetId, d.deliverableId));
  return { doc, copies, files };
}

function planFiles(input: ExportInput): Planned & { assets: ExportManifest["assets"] } {
  const godot = input.preset === "godot4" ? planGodotFiles(input) : [];
  const planned: Planned = { copies: [], texts: godot.map((g) => ({ path: g.path, text: g.text })), spriteAtlases: [] };
  const manifestAssets: ExportManifest["assets"] = [];
  for (const asset of sortedAssets(input.assets)) {
    const entries: Record<string, unknown>[] = [];
    const sprites = planSprites(asset);
    if (sprites) {
      planned.spriteAtlases.push({ asset, sprites });
      planned.texts.push({ path: spritesJsonPath(asset.assetId), text: `${JSON.stringify(spritesDocument(asset, sprites), null, 2)}\n` });
    }
    for (const d of sortedDeliverables(asset)) {
      let files: string[];
      let sprite: SpriteRect | undefined;
      if (isAnimation(d)) {
        const plan = animationFile(asset, d);
        planned.copies.push(...plan.copies);
        planned.texts.push({ path: animationJsonPath(asset.assetId, d.deliverableId), text: serializeAnimation(plan.doc) });
        files = plan.files;
      } else if (isStill(d)) {
        sprite = spriteRect(sprites, d.deliverableId);
        files = [];
        if (!sprite || sprites?.packaging === "both") {
          const dest = stillPath(asset.assetId, d.deliverableId);
          planned.copies.push({ source: d.media.sourcePath, dest, expect: d.canvas });
          files.push(dest);
        }
        if (sprite) files.push(spriteAtlasPath(asset.assetId, sprite.page));
      } else {
        throw invalid(`${asset.assetId}/${d.deliverableId} has unknown media`, "media");
      }
      entries.push(deliverableEntry(asset, d, files, godot.filter((g) => g.assetId === asset.assetId), sprite));
    }
    const assetJson = {
      schema: "brainforge.export-asset.v2",
      assetId: asset.assetId, family: asset.family, versionId: asset.versionId, requirementsHash: asset.requirementsHash,
      ...(sprites ? { sprites: spritesJsonPath(asset.assetId).slice(assetDir(asset.assetId).length + 1) } : {}),
      deliverables: entries,
      dependencies: [...asset.dependencies].sort((a, b) => a.assetId.localeCompare(b.assetId) || a.versionId.localeCompare(b.versionId)),
      metadata: asset.metadata,
    };
    planned.texts.push({ path: assetJsonPath(asset.assetId), text: `${JSON.stringify(assetJson, null, 2)}\n` });
    manifestAssets.push({
      assetId: asset.assetId, versionId: asset.versionId, metadataPath: assetJsonPath(asset.assetId),
      resourcePaths: godot.filter((g) => g.assetId === asset.assetId).map((g) => g.path).sort(),
    });
  }
  return { ...planned, assets: manifestAssets };
}

/**
 * Writes the complete snapshot tree (generic files, Godot resources, then `manifest.json`) into `root`, which must be an
 * existing empty directory. Every file is fsynced and hashed. Pure given its input: no timestamps except `createdAt`.
 */
export async function buildSnapshot(input: ExportInput, root: string, faults: ExportFaults = {}): Promise<ExportOutcome> {
  validateInput(input);
  const plan = planFiles(input);
  const owned: ExportOwnedFile[] = [];
  const claimed = new Set<string>();

  const place = async (rel: string): Promise<string> => {
    if (claimed.has(rel)) throw new ExportError("INVALID_INPUT", `two outputs map to ${rel}`, { reason: "duplicate-output", path: rel });
    claimed.add(rel);
    const abs = safeJoin(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    return abs;
  };
  const record = async (rel: string, abs: string): Promise<void> => {
    owned.push({ path: rel, sha256: await sha256File(abs), size: (await stat(abs)).size });
  };

  let written = 0;
  for (const copy of plan.copies) {
    if (faults.failDuringStaging && written === 1) throw new InjectedFault("failDuringStaging");
    const size = await readPngSize(copy.source);
    if (copy.expect && (size.width !== copy.expect.width || size.height !== copy.expect.height)) {
      throw new ExportError("INVALID_INPUT", `${copy.source} is ${size.width}x${size.height}, expected ${copy.expect.width}x${copy.expect.height} for ${copy.dest}`, { reason: "dimension-mismatch", path: copy.source });
    }
    const abs = await place(copy.dest);
    await copyInto(copy.source, abs);
    await fsyncPath(abs);
    await record(copy.dest, abs);
    written++;
  }
  for (const text of plan.texts) {
    if (faults.failDuringStaging && written === 1) throw new InjectedFault("failDuringStaging");
    const abs = await place(text.path);
    await writeSynced(abs, text.text);
    await record(text.path, abs);
    written++;
  }
  for (const { asset, sprites } of plan.spriteAtlases) {
    if (faults.failDuringStaging && written === 1) throw new InjectedFault("failDuringStaging");
    const sources: { id: string; png: Uint8Array }[] = [];
    for (const d of sprites.members) {
      const size = await readPngSize(d.media.sourcePath);
      if (size.width !== d.canvas.width || size.height !== d.canvas.height) {
        throw new ExportError("INVALID_INPUT", `${d.media.sourcePath} is ${size.width}x${size.height}, expected ${d.canvas.width}x${d.canvas.height} for sprite ${asset.assetId}/${d.deliverableId}`, { reason: "dimension-mismatch", path: d.media.sourcePath });
      }
      sources.push({ id: d.deliverableId, png: await readFile(d.media.sourcePath) });
    }
    const pages = await buildSpriteAtlas(sources, sprites.layout, SPRITE_ATLAS.extrude);
    for (const [n, page] of pages.entries()) {
      const rel = spriteAtlasPath(asset.assetId, n);
      const abs = await place(rel);
      await writeSynced(abs, page.png);
      await record(rel, abs);
      written++;
    }
  }
  if (faults.failDuringStaging) throw new InjectedFault("failDuringStaging");

  owned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: ExportManifest = {
    schema: "brainforge.export.v2",
    projectId: input.projectId, exportId: input.exportId, preset: input.preset, createdAt: input.createdAt,
    assets: plan.assets, ownedFiles: owned,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestAbs = await place("manifest.json");
  await writeSynced(manifestAbs, manifestText);
  return { manifest, manifestText, manifestSha256: sha256Bytes(manifestText), ownedFiles: owned, warnings: [] };
}

/**
 * Re-reads a written snapshot and checks that every owned file exists with its recorded hash, every file referenced from
 * `asset.json` exists, and each animation.json agrees with its frame files, atlas pages, durations and canvas.
 */
export async function validateSnapshot(root: string, expectedManifestSha256?: string): Promise<ExportManifest> {
  const text = await readFile(path.join(root, "manifest.json"), "utf8");
  if (expectedManifestSha256 && sha256Bytes(text) !== expectedManifestSha256) throw new ExportError("EXPORT_CONFLICT", "manifest.json does not match the prepared hash", { reason: "manifest-mismatch" });
  const manifest = ExportManifest.parse(JSON.parse(text));
  const known = new Set(manifest.ownedFiles.map((f) => f.path));
  for (const file of manifest.ownedFiles) {
    const abs = safeJoin(root, file.path);
    if ((await sha256File(abs).catch(() => undefined)) !== file.sha256) throw new ExportError("EXPORT_CONFLICT", `${file.path} is missing or does not match its recorded hash`, { reason: "owned-file-mismatch", path: file.path });
  }
  for (const asset of manifest.assets) {
    if (!known.has(asset.metadataPath)) throw new ExportError("EXPORT_CONFLICT", `${asset.metadataPath} is not an owned file`, { reason: "unlisted-metadata", path: asset.metadataPath });
    const assetDirRel = path.posix.dirname(asset.metadataPath);
    const assetJson = JSON.parse(await readFile(safeJoin(root, asset.metadataPath), "utf8")) as { sprites?: string; deliverables: { deliverableId: string; files: string[]; animation?: string; resources?: string[] }[] };
    for (const d of assetJson.deliverables) {
      for (const rel of [...d.files, ...(d.resources ?? [])]) {
        if (!known.has(`${assetDirRel}/${rel}`)) throw new ExportError("EXPORT_CONFLICT", `${asset.assetId}/${d.deliverableId} references missing file ${rel}`, { reason: "dangling-reference", path: rel });
      }
      if (d.animation) await validateAnimationFiles(root, `${assetDirRel}/${d.animation}`, known);
    }
    if (assetJson.sprites) await validateSpritesFile(root, `${assetDirRel}/${assetJson.sprites}`, known);
  }
  return manifest;
}

async function validateAnimationFiles(root: string, animationRel: string, known: Set<string>): Promise<void> {
  const doc = JSON.parse(await readFile(safeJoin(root, animationRel), "utf8")) as AnimationDocument;
  const dir = path.posix.dirname(animationRel);
  const fail = (message: string): never => {
    throw new ExportError("EXPORT_CONFLICT", `${animationRel}: ${message}`, { reason: "animation-mismatch", path: animationRel });
  };
  if (doc.schema !== "brainforge.animation.v2") fail(`unexpected schema ${String(doc.schema)}`);
  const frameFiles = [...known].filter((p) => p.startsWith(`${dir}/frames/`)).sort();
  const withFile = doc.frames.filter((f) => f.file !== undefined);
  if (withFile.length > 0 && withFile.length !== frameFiles.length) fail(`${doc.frames.length} frames but ${frameFiles.length} frame files`);
  for (const [i, f] of doc.frames.entries()) {
    if (f.index !== i) fail(`frame ${i} has index ${f.index}`);
    if (f.file !== undefined) {
      if (f.file !== `frames/${String(i).padStart(4, "0")}.png`) fail(`frame ${i} is named ${f.file}`);
      if (!known.has(`${dir}/${f.file}`)) fail(`frame ${i} file ${f.file} does not exist`);
      const size = await readPngSize(safeJoin(root, `${dir}/${f.file}`));
      if (size.width !== doc.canvas.width || size.height !== doc.canvas.height) fail(`frame ${i} is ${size.width}x${size.height}, canvas is ${doc.canvas.width}x${doc.canvas.height}`);
    }
    if (f.atlas) {
      const page = doc.atlasPages?.find((p) => p.page === f.atlas!.page);
      if (!page) fail(`frame ${i} uses missing atlas page ${f.atlas.page}`);
      else if (f.atlas.x + f.atlas.width > page.width || f.atlas.y + f.atlas.height > page.height) fail(`frame ${i} rectangle leaves page ${page.page}`);
    }
    if (f.file === undefined && !f.atlas) fail(`frame ${i} has no image`);
  }
  for (const page of doc.atlasPages ?? []) {
    if (!known.has(`${dir}/${page.file}`)) fail(`atlas page ${page.page} file ${page.file} does not exist`);
    const size = await readPngSize(safeJoin(root, `${dir}/${page.file}`));
    if (size.width !== page.width || size.height !== page.height) fail(`atlas page ${page.page} is ${size.width}x${size.height}, declared ${page.width}x${page.height}`);
  }
}

/** sprites.json must point at existing atlas pages and keep every rectangle inside its page. */
async function validateSpritesFile(root: string, spritesRel: string, known: Set<string>): Promise<void> {
  const doc = JSON.parse(await readFile(safeJoin(root, spritesRel), "utf8")) as SpritesDocument;
  const dir = path.posix.dirname(spritesRel);
  const fail = (message: string): never => {
    throw new ExportError("EXPORT_CONFLICT", `${spritesRel}: ${message}`, { reason: "sprites-mismatch", path: spritesRel });
  };
  if (doc.schema !== "brainforge.sprites.v2") fail(`unexpected schema ${String(doc.schema)}`);
  for (const page of doc.atlasPages) {
    if (!known.has(`${dir}/${page.file}`)) fail(`atlas page ${page.page} file ${page.file} does not exist`);
    const size = await readPngSize(safeJoin(root, `${dir}/${page.file}`));
    if (size.width !== page.width || size.height !== page.height) fail(`atlas page ${page.page} is ${size.width}x${size.height}, declared ${page.width}x${page.height}`);
  }
  for (const s of doc.sprites) {
    const page = doc.atlasPages.find((p) => p.page === s.page);
    if (!page) fail(`sprite ${s.id} uses missing atlas page ${s.page}`);
    else if (s.x < 0 || s.y < 0 || s.x + s.width > page.width || s.y + s.height > page.height) fail(`sprite ${s.id} rectangle leaves page ${page.page}`);
  }
}
