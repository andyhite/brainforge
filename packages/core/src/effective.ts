import type { Deliverable, EffectiveLeaf } from "@brainforge/contracts";
import type { ConfirmedPreference } from "./preferences/store.ts";
import type { AuthoredAsset, AuthoredProject, AuthoredSet, AuthoredStyle } from "./authored.ts";

type Layer = EffectiveLeaf["source"]["layer"];

export interface EffectiveConflict { field: string; values: { file: string; value: unknown }[] }
export interface EffectiveSettings { effective: Record<string, EffectiveLeaf>; conflicts: EffectiveConflict[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Flatten nested objects to dotted leaves. Arrays and scalars are leaves (they replace, never merge). */
export function flattenLeaves(value: unknown, prefix = ""): [string, unknown][] {
  if (!isPlainObject(value)) return prefix ? [[prefix, value]] : [];
  const entries = Object.entries(value);
  if (entries.length === 0) return [];
  return entries.flatMap(([k, v]) => flattenLeaves(v, prefix ? `${prefix}.${k}` : k));
}

class LeafMap {
  readonly leaves: Record<string, EffectiveLeaf> = {};

  /** Later layers replace earlier leaves; a scalar/array replaces every nested descendant and vice versa. */
  set(key: string, value: unknown, file: string, field: string, layer: Layer): void {
    for (const existing of Object.keys(this.leaves)) {
      if (existing.startsWith(`${key}.`)) delete this.leaves[existing];
    }
    this.leaves[key] = { value, source: { file, field, layer } };
  }

  apply(block: unknown, file: string, fieldPrefix: string, layer: Layer, keyPrefix = ""): void {
    for (const [key, value] of flattenLeaves(block)) {
      this.set(keyPrefix ? `${keyPrefix}.${key}` : key, value, file, `${fieldPrefix}.${key}`, layer);
    }
  }
}

function rawBlock(file: AuthoredProject | AuthoredAsset | undefined, ...path: string[]): unknown {
  let cur: unknown = file?.raw;
  for (const p of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Project-level non-default settings: authored values report their file, absent ones report the built-in default. */
function projectPolicyLeaves(map: LeafMap, project: AuthoredProject): void {
  if (!project.spec) return;
  const blocks: [string, Record<string, unknown>][] = [
    ["approval", project.spec.approval], ["automation", project.spec.automation], ["export", project.spec.export],
  ];
  for (const [block, values] of blocks) {
    const authored = rawBlock(project, block);
    for (const [key, value] of flattenLeaves(values)) {
      const wasAuthored = isPlainObject(authored) && Object.hasOwn(authored, key.split(".")[0] ?? key);
      map.set(`${block}.${key}`, value, wasAuthored ? project.path : "built-in", `${block}.${key}`, wasAuthored ? "project-defaults" : "built-in");
    }
  }
}

function styleLeaves(map: LeafMap, style: AuthoredStyle, layer: Layer): void {
  if (!style.spec) return;
  const s = style.spec;
  map.set(`style.${s.id}.description`, s.description, style.path, "description", layer);
  map.set(`style.${s.id}.palette`, s.palette, style.path, "palette", layer);
  map.set(`style.${s.id}.references`, s.references, style.path, "references", layer);
  map.set(`style.${s.id}.preferences`, s.preferences, style.path, "preferences", layer);
}

/** Styles that disagree on a concrete value (palette) are reported, not silently picked. */
function styleConflicts(styles: readonly AuthoredStyle[]): EffectiveConflict[] {
  const withPalette = styles.filter((s) => s.spec && s.spec.palette.length > 0);
  if (withPalette.length < 2) return [];
  const first = JSON.stringify(withPalette[0]?.spec?.palette);
  if (withPalette.every((s) => JSON.stringify(s.spec?.palette) === first)) return [];
  return [{ field: "palette", values: withPalette.map((s) => ({ file: s.path, value: s.spec?.palette })) }];
}

export interface EffectiveOptions { assetId?: string; deliverableId?: string; preferences?: readonly ConfirmedPreference[] }
export class EffectiveLookupError extends Error {
  constructor(readonly what: "asset" | "deliverable", message: string) {
    super(message);
  }
}

/**
 * Precedence: project defaults → project familyDefaults → asset overrides → deliverable overrides (and the
 * deliverable's own animation block). Scalars and arrays replace, objects merge, omitted inherits.
 */
export function computeEffective(set: AuthoredSet, options: EffectiveOptions = {}): EffectiveSettings {
  const map = new LeafMap();
  const project = set.project;
  let asset: AuthoredAsset | undefined;
  if (options.assetId !== undefined) {
    asset = set.assets.find((a) => a.fileId === options.assetId);
    if (!asset) throw new EffectiveLookupError("asset", `Asset ${options.assetId} does not exist`);
  }
  let deliverable: Deliverable | undefined;
  if (options.deliverableId !== undefined) {
    if (!asset) throw new EffectiveLookupError("asset", "deliverableId requires assetId");
    deliverable = asset.spec?.deliverables.find((d) => d.id === options.deliverableId);
    if (!deliverable) throw new EffectiveLookupError("deliverable", `Deliverable ${options.deliverableId} does not exist on ${asset.fileId}`);
  }

  if (project) {
    projectPolicyLeaves(map, project);
    if (project.spec) map.apply(project.spec.defaults, project.path, "defaults", "project-defaults");
    if (project.spec && asset?.spec) {
      const family = asset.spec.family;
      map.apply(project.spec.familyDefaults[family], project.path, `familyDefaults.${family}`, "family-defaults");
    }
  }
  if (asset?.spec) map.apply(asset.spec.overrides, asset.path, "overrides", "asset");
  if (asset && deliverable) {
    const field = `deliverables[${deliverable.id}]`;
    map.apply(deliverable.overrides, asset.path, `${field}.overrides`, "deliverable");
    const { motion: _motion, loop: _loop, startReference: _s, endReference: _e, ...numeric } = deliverable.animation ?? { motion: "" };
    map.apply({ animation: numeric }, asset.path, field, "deliverable");
  }

  const projectStyles = (project?.spec?.styleIds ?? []).flatMap((id) => set.styles.filter((s) => s.fileId === id));
  const assetStyles = (asset?.spec?.styleIds ?? []).flatMap((id) => set.styles.filter((s) => s.fileId === id && !projectStyles.includes(s)));
  for (const s of projectStyles) styleLeaves(map, s, "project-defaults");
  for (const s of assetStyles) styleLeaves(map, s, "asset");

  // Confirmed preferences are explicit requirements. A style preference applies where that style is in effect.
  const inEffect = new Set([...projectStyles, ...assetStyles].map((s) => s.fileId));
  for (const p of options.preferences ?? []) {
    if (p.scope === "style" && (p.styleId === undefined || !inEffect.has(p.styleId))) continue;
    map.set(`preference.${p.preferenceId}`, p.text, `preference:${p.preferenceId}`, p.scope === "style" ? `style:${p.styleId}` : "project", "project-defaults");
  }

  return { effective: map.leaves, conflicts: styleConflicts([...projectStyles, ...assetStyles]) };
}
