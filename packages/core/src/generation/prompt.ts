import type { AssetSpec } from "@brainforge/contracts";
import type { AuthoredAsset, AuthoredSet } from "../authored.ts";
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
  const parts: PromptPart[] = [];
  const iteration: PromptPart | undefined = input.iterationInstructions?.trim()
    ? { label: "Iteration instructions", source: "generation.plan iterationInstructions (this run only)", text: input.iterationInstructions.trim() }
    : undefined;

  if (input.mode === "variation") {
    if (iteration) parts.push({ ...iteration, text: `Change: ${iteration.text}` });
    parts.push({
      label: "Identity lock", source: `workflow:${input.workflow.id}@${input.workflow.version}`,
      text: "Keep the subject's identity, proportions, colours and drawing style identical to the reference image.",
    });
  }
  parts.push({ label: "Subject", source: `${asset.path}:description`, text: spec.description.trim() });
  for (const [key, value] of Object.entries(spec.identity)) {
    parts.push({ label: `Identity: ${key}`, source: `${asset.path}:identity.${key}`, text: value.trim() });
  }
  for (const key of ["perspective", "palette"] as const) {
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
    if (s.palette.length > 0) parts.push({ label: `Style ${s.id}`, source: `${style.path}:palette`, text: s.palette.map((p) => p.trim()).join(", ") });
  }
  if (input.mode === "fresh" && iteration) parts.push(iteration);
  parts.push({
    label: "Framing", source: `workflow:${input.workflow.id}@${input.workflow.version}`,
    text: `A single ${spec.family} alone in the frame, one figure only. The entire figure is fully visible with generous margin on every side. Flat plain light-grey background, no props, no text.`,
  });
  return parts;
}
