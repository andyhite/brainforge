import type { AssetFamily, Deliverable, FamilyProfile } from "@brainforge/contracts";

type Section = FamilyProfile["editorSections"][number];

const IDENTITY: Section = { id: "identity", label: "Identity", description: "Plain-language requirements the model can draw: concrete visible features, one per key.", fields: ["description", "identity"] };
const STYLE: Section = { id: "style", label: "Style and overrides", description: "Styles and per-asset settings that override project defaults.", fields: ["styleIds", "overrides", "references"] };
const OUTPUT: Section = { id: "output", label: "Output", description: "Per-deliverable canvas size and background treatment.", fields: ["deliverables[].output.width", "deliverables[].output.height", "deliverables[].output.alpha"] };
const VIEWS: Section = { id: "views", label: "Views and variants", description: "Requested views, poses, expressions, states and variants.", fields: ["deliverables[].id", "deliverables[].kind", "deliverables[].description", "deliverables[].required", "deliverables[].dependsOn"] };
const MOTION: Section = { id: "motion", label: "Motion", description: "Animations: motion text, loop, frame rates and start/end guide references.", fields: ["deliverables[].animation.motion", "deliverables[].animation.loop", "deliverables[].animation.sourceFps", "deliverables[].animation.playbackFps", "deliverables[].animation.sourceFrameCount", "deliverables[].animation.startReference", "deliverables[].animation.endReference"] };
const SHEET: Section = { id: "reference-sheet", label: "Reference sheet", description: "One canvas with named regions that become separately hashed crops.", fields: ["deliverables[].regions"] };

const SUBJECT_KINDS = ["view", "pose", "expression", "still", "variant", "animation", "reference-sheet"];

/** Alpha default of a `per-deliverable` family when a deliverable does not say. */
export const PER_DELIVERABLE_ALPHA: Partial<Record<AssetFamily, "transparent" | "opaque">> = { ui: "opaque", effect: "transparent" };

export const PROFILES: FamilyProfile[] = [
  {
    family: "character", label: "Character", summary: "A figure with a fixed identity: construction views, poses, expressions and animation. Transparent cut-outs.",
    allowedKinds: SUBJECT_KINDS, alpha: "matte", motion: "typical",
    requiredFields: { animation: ["animation.motion"], "reference-sheet": ["regions"] }, collection: "none",
    editorSections: [IDENTITY, STYLE, VIEWS, SHEET, MOTION, OUTPUT],
    exportMetadata: ["pivot", "relativeScale", "displayScale", "subjectHeightPx", "playbackFps", "loop"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque", motion: "wan22-motion", motionOpaque: "wan22-motion-opaque" },
  },
  {
    family: "creature", label: "Creature", summary: "A living subject of any body plan (no humanoid assumptions): construction views, poses and motion. Transparent cut-outs.",
    allowedKinds: SUBJECT_KINDS, alpha: "matte", motion: "typical",
    requiredFields: { animation: ["animation.motion"], "reference-sheet": ["regions"] }, collection: "none",
    editorSections: [IDENTITY, STYLE, VIEWS, SHEET, MOTION, OUTPUT],
    exportMetadata: ["pivot", "relativeScale", "displayScale", "subjectHeightPx", "playbackFps", "loop"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque", motion: "wan22-motion", motionOpaque: "wan22-motion-opaque" },
  },
  {
    family: "item", label: "Item", summary: "A held, picked-up or inventory object: requested views and variants. Static; transparent cut-outs.",
    allowedKinds: ["view", "still", "variant", "reference-sheet"], alpha: "matte", motion: "none",
    requiredFields: { "reference-sheet": ["regions"] }, collection: "none",
    editorSections: [IDENTITY, STYLE, VIEWS, SHEET, OUTPUT],
    exportMetadata: ["pivot", "relativeScale", "variant"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque" },
  },
  {
    family: "equipment", label: "Equipment", summary: "Worn or wielded visual art with optional named attachment points; views, variants and optional motion. No inventory or gameplay data.",
    allowedKinds: ["view", "still", "variant", "animation", "reference-sheet"], alpha: "matte", motion: "optional",
    requiredFields: { animation: ["animation.motion"], "reference-sheet": ["regions"] }, collection: "none",
    editorSections: [IDENTITY, STYLE, VIEWS, SHEET, { id: "attachments", label: "Attachment points", description: "Named pixel points on a deliverable's canvas (origin top-left).", fields: ["attachments[].name", "attachments[].x", "attachments[].y", "attachments[].deliverable"] }, MOTION, OUTPUT],
    exportMetadata: ["pivot", "relativeScale", "attachments", "variant", "playbackFps", "loop"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque", motion: "wan22-motion", motionOpaque: "wan22-motion-opaque" },
  },
  {
    family: "prop", label: "Prop", summary: "A world object: static by default, with views, variants/states and an optional animation. Can be a member of an environment.",
    allowedKinds: ["view", "still", "variant", "animation", "reference-sheet"], alpha: "matte", motion: "optional",
    requiredFields: { animation: ["animation.motion"], "reference-sheet": ["regions"] }, collection: "member",
    editorSections: [IDENTITY, STYLE, VIEWS, SHEET, { id: "attachments", label: "Attachment points", description: "Named pixel points on a deliverable's canvas (origin top-left).", fields: ["attachments[].name", "attachments[].x", "attachments[].y", "attachments[].deliverable"] }, MOTION, OUTPUT],
    exportMetadata: ["pivot", "relativeScale", "layer", "attachments", "playbackFps", "loop"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque", motion: "wan22-motion", motionOpaque: "wan22-motion-opaque" },
  },
  {
    family: "environment", label: "Environment", summary: "A visual collection: its concept sets shared direction for member backgrounds, tiles and modular pieces. Opaque; no level graph.",
    allowedKinds: ["view", "still", "variant", "reference-sheet"], alpha: "opaque", motion: "none",
    requiredFields: { "reference-sheet": ["regions"] }, collection: "container",
    editorSections: [IDENTITY, STYLE, VIEWS, SHEET, { id: "collection", label: "Members", description: "Child assets that follow this environment's direction.", fields: ["collection.members[].assetId", "collection.members[].required", "collection.styleId"] }, OUTPUT],
    exportMetadata: ["layer", "members", "parallax"],
    workflows: { still: "krea2-still-opaque", stillOpaque: "krea2-still-opaque", variation: "krea2-variation-opaque", variationOpaque: "krea2-variation-opaque" },
  },
  {
    family: "background", label: "Background", summary: "A full-frame scene without characters, with layer, parallax and wrap hints. Opaque.",
    allowedKinds: ["view", "still", "variant"], alpha: "opaque", motion: "none",
    requiredFields: {}, collection: "member",
    editorSections: [IDENTITY, STYLE, VIEWS, { id: "environment", label: "Layer and parallax", description: "Intended use as a layer; not level placement.", fields: ["deliverables[].environment.layer", "deliverables[].environment.parallax", "deliverables[].environment.seamlessAxes", "deliverables[].environment.relativeScale", "deliverables[].environment.pivot"] }, OUTPUT],
    exportMetadata: ["layer", "parallax", "seamlessAxes", "relativeScale", "pivot"],
    workflows: { still: "krea2-still-opaque", stillOpaque: "krea2-still-opaque", variation: "krea2-variation-opaque", variationOpaque: "krea2-variation-opaque" },
  },
  {
    family: "tile", label: "Tile", summary: "A repeating tile or modular surface with declared tile size, connection labels and seamless axes. Opaque.",
    allowedKinds: ["tile", "still", "variant"], alpha: "opaque", motion: "none",
    requiredFields: { tile: ["environment.tileSize"] }, collection: "member",
    editorSections: [IDENTITY, STYLE, VIEWS, { id: "tile", label: "Tile", description: "Tile dimensions, connection labels and seamless axes.", fields: ["deliverables[].environment.tileSize", "deliverables[].environment.connections", "deliverables[].environment.seamlessAxes", "deliverables[].environment.layer"] }, OUTPUT],
    exportMetadata: ["tileSize", "connections", "seamlessAxes", "layer"],
    workflows: { still: "krea2-still-opaque", stillOpaque: "krea2-still-opaque", variation: "krea2-variation-opaque", variationOpaque: "krea2-variation-opaque" },
  },
  {
    family: "ui", label: "UI", summary: "Interface elements and their states with optional nine-slice margins. Panels are opaque unless a deliverable asks for a cut-out; text stays outside generated art.",
    allowedKinds: ["ui-state", "still", "variant", "animation"], alpha: "per-deliverable", motion: "optional",
    requiredFields: { "ui-state": ["ui.state"], animation: ["animation.motion", "animation.loop"] }, collection: "none",
    editorSections: [IDENTITY, STYLE, VIEWS, { id: "ui", label: "States and nine-slice", description: "State name and stretch margins in pixels of the output.", fields: ["deliverables[].ui.state", "deliverables[].ui.nineSlice"] }, MOTION, OUTPUT],
    exportMetadata: ["state", "nineSlice", "playbackFps", "loop"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque", motion: "wan22-motion", motionOpaque: "wan22-motion-opaque" },
  },
  {
    family: "icon", label: "Icon", summary: "Small single-subject glyphs and their states at a fixed canvas size. Transparent cut-outs.",
    allowedKinds: ["still", "variant", "ui-state"], alpha: "matte", motion: "none",
    requiredFields: { "ui-state": ["ui.state"] }, collection: "none",
    editorSections: [IDENTITY, STYLE, VIEWS, { id: "ui", label: "States", description: "State name per icon variant.", fields: ["deliverables[].ui.state"] }, OUTPUT],
    exportMetadata: ["state", "pivot"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque" },
  },
  {
    family: "effect", label: "Effect", summary: "Visual effects as stills or animation sequences; transparent by default, loop or play once. The background is only removed when the deliverable is transparent.",
    allowedKinds: ["still", "variant", "animation"], alpha: "per-deliverable", motion: "typical",
    requiredFields: { animation: ["animation.motion", "animation.loop"] }, collection: "none",
    editorSections: [IDENTITY, STYLE, VIEWS, MOTION, OUTPUT],
    exportMetadata: ["pivot", "playbackFps", "loop"],
    workflows: { still: "krea2-still", stillOpaque: "krea2-still-opaque", variation: "krea2-variation", variationOpaque: "krea2-variation-opaque", motion: "wan22-motion", motionOpaque: "wan22-motion-opaque" },
  },
];

export function profileFor(family: AssetFamily): FamilyProfile {
  const p = PROFILES.find((x) => x.family === family);
  if (!p) throw new Error(`No family profile for ${family}`);
  return p;
}

/** Transparent (matted cut-out) or opaque (full frame): the deliverable's own choice, else the family default. */
export function resolveAlpha(family: AssetFamily, deliverable?: Pick<Deliverable, "output">): "transparent" | "opaque" {
  const chosen = deliverable?.output?.alpha;
  if (chosen) return chosen;
  const profile = profileFor(family);
  if (profile.alpha === "matte") return "transparent";
  if (profile.alpha === "opaque") return "opaque";
  return PER_DELIVERABLE_ALPHA[family] ?? "transparent";
}

export type WorkflowStage = "still" | "variation" | "motion";

/** The workflow id for a family, stage and alpha mode. A stage the family does not offer returns undefined. */
export function workflowFor(family: AssetFamily, stage: WorkflowStage, alpha: "transparent" | "opaque"): string | undefined {
  const w = profileFor(family).workflows;
  if (stage === "still") return alpha === "opaque" ? w.stillOpaque ?? w.still : w.still;
  if (stage === "variation") return alpha === "opaque" ? w.variationOpaque ?? w.variation : w.variation;
  return alpha === "opaque" ? w.motionOpaque ?? w.motion : w.motion;
}

/** Positive framing sentence appended to a still prompt. The character wording is fixed: existing prompts and fingerprints depend on it. */
export function framingFor(family: AssetFamily, alpha: "transparent" | "opaque"): string {
  switch (family) {
    case "character":
    case "creature":
      return `A single ${family} alone in the frame, one figure only. The entire figure is fully visible with generous margin on every side. Flat plain light-grey background, no props, no text.`;
    case "item":
    case "equipment":
    case "prop":
    case "icon":
      return `A single ${family} alone in the frame, one object only. The entire object is fully visible with generous margin on every side. Flat plain light-grey background, no other objects, no text.`;
    case "background":
      return "A full-frame scene filling the whole canvas edge to edge, with no characters and no text.";
    case "environment":
      return "An establishing shot of the whole environment, wide view filling the frame, with no characters and no text.";
    case "tile":
      return "A flat orthographic seamless repeating texture covering the frame edge to edge, no border, no perspective, no text.";
    case "ui":
      return alpha === "opaque"
        ? "A single flat game interface element filling the frame, centered, plain edges, no text."
        : "A single flat game interface element centered in the frame, plain edges, flat plain light-grey background, no text.";
    case "effect":
      return alpha === "opaque"
        ? "The effect fills the whole frame, centered, no text."
        : "The effect alone in the frame, centered with generous margin on every side. Flat plain light-grey background, no text.";
  }
}

/** Camera clause for motion prompts. Character wording is unchanged from the first release. */
export function cameraFor(family: AssetFamily, alpha: "transparent" | "opaque"): string {
  if (family === "character" && alpha === "transparent") return "Static camera, flat plain light-grey background, the character stays in place.";
  return alpha === "opaque" ? "Static camera, the scene fills the whole frame." : "Static camera, flat plain light-grey background, the subject stays in place.";
}

/** Families whose output is not a viewed object, so a default viewpoint would contradict the framing. */
export const FLAT_FAMILIES: readonly AssetFamily[] = ["tile", "ui"];

/**
 * Deliverable kinds that can serve as a motion's start/end guide. Characters and creatures use approved poses; other
 * families (props, effects, UI) have no pose, so a still, view or variant is the guide.
 */
export function guideKindsFor(family: AssetFamily): string[] {
  return family === "character" || family === "creature" ? ["pose"] : ["pose", "still", "view", "variant"];
}
