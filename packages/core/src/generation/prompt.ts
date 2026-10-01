import type { AssetSpec, Deliverable } from "@brainforge/contracts";
import type { AuthoredAsset, AuthoredSet } from "../authored.ts";
import { FLAT_FAMILIES, cameraFor, framingFor, resolveAlpha } from "../families/index.ts";
import type { EffectiveSettings } from "../effective.ts";

export interface PromptPart { label: string; source: string; text: string }

export interface PromptInput {
  set: AuthoredSet;
  asset: AuthoredAsset;
  spec: AssetSpec;
  effective: EffectiveSettings;
  mode: "fresh" | "variation";
  workflow: { id: string; version: number };
  iterationInstructions?: string;
  /** The deliverable step being generated; only ITS description is sent, never a sibling's. */
  deliverable?: { spec: Deliverable; index: number };
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

const POSITIONS: Record<number, string[]> = { 2: ["on the left", "on the right"], 3: ["on the left", "in the middle", "on the right"] };

/**
 * A positive layout instruction for a reference sheet, derived from its regions (left to right when they share a row).
 * A region's authored `view` phrase is used as written; otherwise its id names the view.
 */
export function sheetLayout(family: string, regions: readonly { id: string; x: number; y: number; view?: string }[]): string {
  const ordered = [...regions].sort((a, b) => a.x - b.x || a.y - b.y);
  const names = ordered.map((r) => r.view?.trim() || `${r.id.replace(/-/g, " ")} view`);
  const row = ordered.every((r) => r.y === ordered[0]?.y);
  const column = ordered.every((r) => r.x === ordered[0]?.x);
  const arrangement = row ? "side by side from left to right" : column ? "stacked from top to bottom" : "arranged in a grid";
  const count = COUNT_WORDS[ordered.length] ?? String(ordered.length);
  const positions = row ? POSITIONS[ordered.length] : undefined;
  const listing = positions ? names.map((n, i) => `${positions[i]} ${n}`).join(", ") : names.join(", ");
  return `${count[0]?.toUpperCase()}${count.slice(1)} views of the same ${family} ${arrangement} on one canvas, ${listing}. Every view is equal in size and shows the same ${family} with identical proportions, colours and costume, the entire figure fully visible with generous margin. Flat plain light-grey background, no text.`;
}

/** Styles the project names first, then the asset's own, without repeats. */
export function stylesFor(set: AuthoredSet, spec: AssetSpec) {
  const ids = [...new Set([...(set.project?.spec?.styleIds ?? []), ...spec.styleIds])];
  return ids.flatMap((id) => set.styles.filter((s) => s.fileId === id && s.spec));
}

/**
 * The exact positive prompt, one part per authored source so a reader can see where every sentence came from.
 * Iteration instructions affect this run only; they are never written back to authored files.
 */
export function composePrompt(input: PromptInput): PromptPart[] {
  const { set, asset, spec, effective } = input;
  const alpha = resolveAlpha(spec.family, input.deliverable?.spec);
  const parts: PromptPart[] = [];
  const iteration: PromptPart | undefined = input.iterationInstructions?.trim()
    ? { label: "Iteration instructions", source: "generation.plan iterationInstructions (this run only)", text: input.iterationInstructions.trim() }
    : undefined;

  if (input.mode === "variation" && iteration) parts.push({ ...iteration, text: `Change: ${iteration.text}` });
  const motion = input.deliverable?.spec.kind === "animation" ? input.deliverable.spec.animation?.motion.trim() : undefined;
  // A state or variant derived from a base deliverable (disabled icon, pressed button) exists to change appearance, so colours are not locked to the reference.
  const stateLike = (input.deliverable?.spec.kind === "ui-state" || input.deliverable?.spec.kind === "variant") && (input.deliverable.spec.dependsOn.length > 0);
  if (input.mode === "variation" || input.deliverable) {
    parts.push({
      label: "Identity lock", source: `workflow:${input.workflow.id}@${input.workflow.version}`,
      text: motion !== undefined
        ? "Keep the subject's identity, proportions, colours and drawing style identical to the first and last frame."
        : stateLike
          ? "Keep the subject's shape, proportions and drawing style identical to the reference image; this deliverable's description names what changes, including colours."
          : "Keep the subject's identity, proportions, colours and drawing style identical to the reference image.",
    });
  }
  const description = input.deliverable?.spec.description.trim();
  if (input.deliverable && description) {
    parts.push({ label: `Deliverable: ${input.deliverable.spec.id}`, source: `${asset.path}:deliverables[${input.deliverable.index}].description`, text: description });
  }
  if (input.deliverable && motion) {
    parts.push({ label: `Motion: ${input.deliverable.spec.id}`, source: `${asset.path}:deliverables[${input.deliverable.index}].animation.motion`, text: motion });
  }
  parts.push({ label: "Subject", source: `${asset.path}:description`, text: spec.description.trim() });
  for (const [key, value] of Object.entries(spec.identity)) {
    parts.push({ label: `Identity: ${key}`, source: `${asset.path}:identity.${key}`, text: value.trim() });
  }
  // A reference sheet lays out several views itself, and flat families (tiles, UI) have no viewpoint; a default perspective would contradict both.
  const viewpoint = input.deliverable?.spec.kind !== "reference-sheet" && !FLAT_FAMILIES.includes(spec.family);
  for (const key of viewpoint ? (["perspective", "palette"] as const) : (["palette"] as const)) {
    const leaf = effective.effective[key];
    if (typeof leaf?.value === "string" && leaf.value.trim()) {
      parts.push({ label: key === "perspective" ? "Perspective" : "Palette", source: `${leaf.source.file}:${leaf.source.field}`, text: leaf.value.trim() });
    }
  }
  const project = set.project;
  if (project?.spec?.artDirection.trim()) {
    parts.push({ label: "Art direction", source: `${project.path}:artDirection`, text: project.spec.artDirection.trim() });
  }
  for (const style of stylesFor(set, spec)) {
    const s = style.spec;
    if (!s) continue;
    if (s.palette.length > 0) {
      const entries = s.palette.map((p) => p.trim());
      // "; " keeps comma-bearing entries from reading as several phrases; plain entries keep the original ", ".
      parts.push({ label: `Style ${s.id}`, source: `${style.path}:palette`, text: entries.join(entries.some((p) => p.includes(",")) ? "; " : ", ") });
    }
  }
  if (input.mode === "fresh" && iteration) parts.push(iteration);
  const regions = input.deliverable?.spec.kind === "reference-sheet" ? input.deliverable.spec.regions : undefined;
  if (regions && regions.length > 0) {
    parts.push({ label: "Sheet layout", source: `${asset.path}:deliverables[${input.deliverable?.index}].regions`, text: sheetLayout(spec.family, regions) });
  } else if (motion !== undefined) {
    parts.push({ label: "Camera", source: `workflow:${input.workflow.id}@${input.workflow.version}`, text: cameraFor(spec.family, alpha) });
  } else {
    parts.push({
      label: "Framing", source: `workflow:${input.workflow.id}@${input.workflow.version}`,
      text: framingFor(spec.family, alpha),
    });
  }
  return parts;
}
