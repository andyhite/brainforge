import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type AnimationDeliverable, type StillDeliverable,
  atlasPagePath, framePath, godotAnimationsPath, godotStyleBoxPath, godotTexturePath, godotTileSetPath,
  isAnimation, isStill, sortedAssets, sortedDeliverables, sortedFrames, stillPath, usesAtlas,
} from "./layout.ts";
import { ExportError, isEnoent } from "./fs.ts";
import type { ExportAsset, ExportDeliverable, ExportInput } from "./types.ts";
import { planSprites, spriteAtlasPath, spriteRect } from "./sprites.ts";
import type { SpriteRect } from "@brainforge/media";

export interface GodotFile {
  assetId: string;
  /** Deliverables this file belongs to (the asset-level SpriteFrames belongs to every animation). */
  deliverableIds: string[];
  /** Snapshot-root-relative posix path. */
  path: string;
  text: string;
}

// --------------------------------------------------------------------------- literals (pattern from the v1 SpriteFrames generator)

/** A value already in Godot text syntax (SubResource(...), Vector2(...), &"name"). */
class Raw {
  constructor(readonly text: string) {}
}

const quote = (s: string): string => JSON.stringify(s);

/** Godot reads `12` as an int and `12.0` as a float; durations and speeds must be floats. */
export function float(n: number): string {
  const rounded = Number(n.toFixed(9));
  return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
}

const vec2 = (x: number, y: number): Raw => new Raw(`Vector2(${float(x)}, ${float(y)})`);

function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Raw) return value.text;
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : float(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${quote(k)}: ${literal(v)}`);
    return entries.length === 0 ? "{}" : `{\n${entries.join(",\n")}\n}`;
  }
  throw new ExportError("INVALID_INPUT", `cannot serialize ${typeof value} metadata value to a Godot literal`, { reason: "bad-metadata" });
}

/** Resource ids derive from asset/deliverable/frame identity only, never the export id. kebab ids have no `_`, so this is injective. */
const slug = (id: string): string => id.replace(/-/g, "_");
const index4 = (i: number): string => String(i).padStart(4, "0");

class ResourceFile {
  private readonly ext: string[] = [];
  private readonly sub: string[] = [];
  private readonly props: string[] = [];
  private readonly extIds = new Set<string>();

  constructor(private readonly type: string) {}

  extTexture(id: string, resPath: string): Raw {
    if (!this.extIds.has(id)) {
      this.extIds.add(id);
      this.ext.push(`[ext_resource type="Texture2D" path=${quote(resPath)} id=${quote(id)}]`);
    }
    return new Raw(`ExtResource(${quote(id)})`);
  }

  subResource(type: string, id: string, props: [string, unknown][], rawLines: string[] = []): Raw {
    this.sub.push([`[sub_resource type="${type}" id=${quote(id)}]`, ...props.map(([k, v]) => `${k} = ${literal(v)}`), ...rawLines, ""].join("\n"));
    return new Raw(`SubResource(${quote(id)})`);
  }

  prop(name: string, value: unknown): void {
    this.props.push(`${name} = ${literal(value)}`);
  }

  render(): string {
    const head = `[gd_resource type="${this.type}" format=3]`;
    const parts = [head, ""];
    if (this.ext.length > 0) parts.push(...this.ext, "");
    for (const block of this.sub) parts.push(block);
    parts.push("[resource]", ...this.props, "");
    return parts.join("\n");
  }
}

const res = (prefix: string, rel: string): string => `${prefix}/current/${rel}`;

function deliverableMetadata(asset: ExportAsset, d: ExportDeliverable): [string, unknown][] {
  const out: [string, unknown][] = [
    ["asset_id", asset.assetId], ["deliverable_id", d.deliverableId], ["kind", d.kind], ["family", asset.family],
    ["version_id", asset.versionId], ["candidate_id", d.candidateId], ["output_hash", d.outputHash],
    ["pivot", vec2(d.pivot.x, d.pivot.y)],
    ["pivot_normalized", vec2(d.pivot.x / d.canvas.width, d.pivot.y / d.canvas.height)],
  ];
  if (d.relativeScale !== undefined) out.push(["relative_scale", d.relativeScale]);
  if (d.state !== undefined) out.push(["state", d.state]);
  if (d.displayScale !== undefined) out.push(["display_scale", d.displayScale]);
  if (Object.keys(d.metadata).length > 0) out.push(["extra", d.metadata]);
  return out;
}

// --------------------------------------------------------------------------- per-kind resources

function animationsResource(prefix: string, asset: ExportAsset, animations: AnimationDeliverable[]): string {
  const file = new ResourceFile("SpriteFrames");
  const entries: Record<string, unknown>[] = [];
  const meta: Record<string, unknown> = {};

  for (const d of animations) {
    const { media } = d;
    const useAtlas = usesAtlas(media.packaging);
    const frames: Record<string, unknown>[] = [];
    for (const frame of sortedFrames(media.frames)) {
      const id = `${slug(d.deliverableId)}_${index4(frame.index)}`;
      let texture: Raw;
      if (useAtlas && frame.atlas) {
        const page = file.extTexture(`atlas_${slug(d.deliverableId)}_${frame.atlas.page}`, res(prefix, atlasPagePath(asset.assetId, d.deliverableId, frame.atlas.page)));
        const { x, y, width, height } = frame.atlas;
        texture = file.subResource("AtlasTexture", `AtlasTexture_${id}`, [["atlas", page], ["region", new Raw(`Rect2(${x}, ${y}, ${width}, ${height})`)]]);
      } else {
        texture = file.extTexture(`frame_${id}`, res(prefix, framePath(asset.assetId, d.deliverableId, frame.index)));
      }
      frames.push({ duration: new Raw(float((frame.durationMs * media.playbackFps) / 1000)), texture });
    }
    entries.push({ name: new Raw(`&${quote(d.deliverableId)}`), speed: new Raw(float(media.playbackFps)), loop: media.loop, frames });
    meta[d.deliverableId] = {
      ...Object.fromEntries(deliverableMetadata(asset, d)),
      source_fps: media.sourceFps, playback_fps: media.playbackFps, frame_count: media.frames.length, packaging: media.packaging,
    };
  }
  file.prop("animations", entries);
  file.prop("metadata/asset_id", asset.assetId);
  file.prop("metadata/version_id", asset.versionId);
  file.prop("metadata/animations", meta);
  return file.render();
}

/** The texture of a still: its slot in the asset's sprite atlas when it is packed, else its own PNG (full-image region). */
function stillTexture(file: ResourceFile, prefix: string, asset: ExportAsset, d: StillDeliverable, rect: SpriteRect | undefined): { source: Raw; region: Raw } {
  if (rect) {
    return { source: file.extTexture(`sprites_${rect.page}`, res(prefix, spriteAtlasPath(asset.assetId, rect.page))), region: new Raw(`Rect2(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})`) };
  }
  return { source: file.extTexture(`tex_${slug(d.deliverableId)}`, res(prefix, stillPath(asset.assetId, d.deliverableId))), region: new Raw(`Rect2(0, 0, ${d.canvas.width}, ${d.canvas.height})`) };
}

function textureResource(prefix: string, asset: ExportAsset, d: StillDeliverable, rect: SpriteRect | undefined): string {
  const file = new ResourceFile("AtlasTexture");
  const { source, region } = stillTexture(file, prefix, asset, d, rect);
  file.prop("atlas", source);
  file.prop("region", region);
  for (const [k, v] of deliverableMetadata(asset, d)) file.prop(`metadata/${k}`, v);
  return file.render();
}

function styleBoxResource(prefix: string, asset: ExportAsset, d: StillDeliverable, nine: NonNullable<ExportDeliverable["nineSlice"]>, rect: SpriteRect | undefined): string {
  const file = new ResourceFile("StyleBoxTexture");
  if (rect) {
    const { source, region } = stillTexture(file, prefix, asset, d, rect);
    file.prop("texture", file.subResource("AtlasTexture", `AtlasTexture_${slug(d.deliverableId)}`, [["atlas", source], ["region", region]]));
  } else {
    file.prop("texture", file.extTexture(`tex_${slug(d.deliverableId)}`, res(prefix, stillPath(asset.assetId, d.deliverableId))));
  }
  file.prop("texture_margin_left", new Raw(float(nine.left)));
  file.prop("texture_margin_top", new Raw(float(nine.top)));
  file.prop("texture_margin_right", new Raw(float(nine.right)));
  file.prop("texture_margin_bottom", new Raw(float(nine.bottom)));
  for (const [k, v] of deliverableMetadata(asset, d)) file.prop(`metadata/${k}`, v);
  return file.render();
}

function tileSetResource(prefix: string, asset: ExportAsset, d: StillDeliverable, tile: NonNullable<ExportDeliverable["tile"]>): string {
  const file = new ResourceFile("TileSet");
  const png = file.extTexture(`tex_${slug(d.deliverableId)}`, res(prefix, stillPath(asset.assetId, d.deliverableId)));
  const cols = Math.floor(d.canvas.width / tile.width);
  const rows = Math.floor(d.canvas.height / tile.height);
  const tiles: string[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) tiles.push(`${x}:${y}/0 = 0`);
  const source = file.subResource("TileSetAtlasSource", `TileSetAtlasSource_${slug(d.deliverableId)}`, [
    ["texture", png], ["texture_region_size", new Raw(`Vector2i(${tile.width}, ${tile.height})`)],
  ], tiles);
  file.prop("tile_size", new Raw(`Vector2i(${tile.width}, ${tile.height})`));
  file.prop("sources/0", source);
  for (const [k, v] of deliverableMetadata(asset, d)) file.prop(`metadata/${k}`, v);
  if (tile.connections) file.prop("metadata/connections", tile.connections);
  if (tile.seamlessAxes) file.prop("metadata/seamless_axes", tile.seamlessAxes);
  return file.render();
}

/**
 * Godot 4.3+ text resources for every asset: one asset-level `SpriteFrames`, an `AtlasTexture` per still, a
 * `StyleBoxTexture` per nine-slice still and a `TileSet` per tile still. Pure and deterministic.
 */
export function planGodotFiles(input: ExportInput): GodotFile[] {
  if (!input.godot) throw new ExportError("EXPORT_BLOCKED", "godot4 export requires a Godot target", { field: "godotProjectRoot", reason: "missing-godot-target" });
  const prefix = input.godot.resRootPrefix.replace(/\/+$/, "");
  const files: GodotFile[] = [];
  for (const asset of sortedAssets(input.assets)) {
    const deliverables = sortedDeliverables(asset);
    const animations = deliverables.filter(isAnimation);
    const sprites = planSprites(asset);
    if (animations.length > 0) files.push({ assetId: asset.assetId, deliverableIds: animations.map((a) => a.deliverableId), path: godotAnimationsPath(asset.assetId), text: animationsResource(prefix, asset, animations) });
    for (const d of deliverables.filter(isStill)) {
      const rect = spriteRect(sprites, d.deliverableId);
      files.push({ assetId: asset.assetId, deliverableIds: [d.deliverableId], path: godotTexturePath(asset.assetId, d.deliverableId), text: textureResource(prefix, asset, d, rect) });
      if (d.nineSlice) files.push({ assetId: asset.assetId, deliverableIds: [d.deliverableId], path: godotStyleBoxPath(asset.assetId, d.deliverableId), text: styleBoxResource(prefix, asset, d, d.nineSlice, rect) });
      if (d.tile) files.push({ assetId: asset.assetId, deliverableIds: [d.deliverableId], path: godotTileSetPath(asset.assetId, d.deliverableId), text: tileSetResource(prefix, asset, d, d.tile) });
    }
  }
  return files;
}

// --------------------------------------------------------------------------- engine root

export interface GodotRootBlocker {
  field: "godotProjectRoot" | "destination";
  message: string;
}

export type GodotRootCheck = { ok: true; resRootPrefix: string } | { ok: false; blockers: GodotRootBlocker[] };

/** Real path of the nearest existing ancestor plus the not-yet-existing remainder. */
async function resolveLoose(p: string): Promise<string> {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(await realpath(cur), ...rest.reverse());
    } catch (e) {
      if (!isEnoent(e)) throw e;
      rest.push(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      cur = parent;
    }
  }
}

/**
 * The godot4 preset needs `project.godot` at the declared engine root and a destination strictly inside it. Failures are
 * field-specific blockers for the godot4 preset only; generic exports never call this.
 */
export async function checkGodotRoot(args: { godotProjectRootAbs: string; destinationAbs: string }): Promise<GodotRootCheck> {
  const blockers: GodotRootBlocker[] = [];
  const root = await resolveLoose(args.godotProjectRootAbs);
  let hasProject = false;
  try {
    hasProject = (await lstat(path.join(root, "project.godot"))).isFile();
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
  if (!hasProject) blockers.push({ field: "godotProjectRoot", message: `no project.godot at ${args.godotProjectRootAbs}; set export.godotProjectRoot to the folder containing project.godot` });

  const dest = await resolveLoose(args.destinationAbs);
  const rel = path.relative(root, dest);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    blockers.push({ field: "destination", message: `export destination ${args.destinationAbs} must be inside the Godot project root ${args.godotProjectRootAbs}` });
  }
  if (blockers.length > 0) return { ok: false, blockers };
  return { ok: true, resRootPrefix: `res://${rel.split(path.sep).join("/")}` };
}
