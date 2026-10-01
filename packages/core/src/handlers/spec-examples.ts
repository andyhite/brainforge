import type { AuthoredKind } from "@brainforge/contracts";

/** Examples are parsed by the real schemas in tests, so they cannot drift from the contracts. */

export const PROJECT_MINIMAL = `schema: brainforge.project.v2
id: my-game
name: My Game
export:
  preset: generic
  destination: assets/brainforge
`;

export const PROJECT_FULL = `schema: brainforge.project.v2
id: my-game
name: My Game
artDirection: >
  Hand-inked cartoon look: bold dark warm-brown outer contours, thinner interior fold lines,
  broad flat colour areas with one soft shadow tone, clean smooth fills.
notes: >
  Not sent to the model. Setting: a 2D side-scrolling platformer. Rule: art must read at 120 px tall.
  Source: docs/03-art-direction.md. Status: perspective still under review.
styleIds: [cranium]
references: []
defaults:
  perspective: side-oriented three-quarter
  sizing: { width: 256, height: 256 }
  animation: { playbackFps: 12 }
familyDefaults:
  character:
    sizing: { width: 256, height: 256, subjectHeightPx: 216, displayScale: 0.5 }
layers:
  - { id: foreground, description: Layer in front of the player }
requirements:
  assets: [cortex]
approval:
  conceptLock: human
  productionReview: agent_with_escalation
  promotion: human
  activation: human
automation:
  maxAttemptsPerStep: 3
  maxConcurrentGenerations: 1
  maxBatchCandidates: 4
  autoRegenerate: false
export:
  preset: godot4
  destination: assets/brainforge
  godotProjectRoot: .
`;

export const STYLE_MINIMAL = `schema: brainforge.style.v2
id: cranium
`;

export const STYLE_FULL = `schema: brainforge.style.v2
id: cranium
description: Documentation only, not sent to the model. Warm, flat, cel-shaded look with dark warm contours.
palette:
  - Warm dark brown contours around every shape
  - Muted off-white and denim blue for clothing
  - Flat colour areas with one broad shadow tone
references: []
preferences: []
`;

export const ASSET_MINIMAL = `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A sixteen-year-old boy with a huge coral-pink brain for a head, standing upright with a slouch.
`;

export const ASSET_FULL = `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A sixteen-year-old boy with a huge coral-pink brain for a head, standing upright with a slouch.
notes: >
  Not sent to the model. Status: four-finger hands still a proposal (docs/04-characters.md).
  Appears in level 1 only after the tutorial. Do not reuse the early concept pose.
identity:
  brain: Coral-pink brain with broad folds, taller than the whole body below it and about twice as wide as his shoulders.
  eyes: Two big round white eyes with dark pupils in the middle of the front of the brain.
  mouth: A small wide curved mouth in a dark line just below the eyes.
  clothing: White T-shirt, blue jeans with a brown belt, black high-top sneakers.
styleIds: [cranium]
references: []
deliverables:
  - id: construction-sheet
    kind: reference-sheet
    required: true
    description: One sheet with three upright figures side by side, labelled views front, profile and rear, on plain light grey.
    regions:
      - { id: front, x: 0, y: 0, width: 512, height: 768 }
      - { id: profile, x: 512, y: 0, width: 512, height: 768 }
      - { id: rear, x: 1024, y: 0, width: 512, height: 768 }
  - id: idle-rest
    kind: pose
    required: true
    description: Side-oriented three-quarter standing pose with relaxed arms and weight on one leg, used as the idle loop guide.
    dependsOn: [construction-sheet]
  - id: idle
    kind: animation
    required: true
    description: Slow breathing idle loop.
    dependsOn: [idle-rest]
    animation:
      motion: Slow breathing with a slight brain bob, feet planted.
      loop: true
`;

export interface SpecExamples {
  readonly pathPattern: string;
  readonly minimal: string;
  readonly full: string;
  readonly conventions: readonly string[];
}

const COMMON_CONVENTIONS = [
  "Objects are strict: unknown keys are errors. The validator names the offending key; fix the typo rather than adding fields.",
  "All paths are relative to the game root. No URLs, secrets, tokens or absolute machine paths in portable YAML.",
  "Call spec_validate before spec_write; pass its currentHash as expectedHash (null to create a new file).",
  "The YAML text is the image prompt. Describe the picture, not the design process: every feature gets shape + colour + position, positive phrasing only (no 'not', 'without', 'do not'), no doc references, status, proposals, lore or other characters' names.",
  "Exaggerate proportions the model undersizes and state ratios relatively (e.g. 'taller than the whole body below it'). Front/profile/rear/turnaround wording belongs only in the construction-sheet deliverable description.",
  "Before generation_start: run generation_plan, read plan.prompt and promptSources in full, fix any sentence that breaks these rules via spec_write, and re-plan.",
];

export const SPEC_EXAMPLES: Record<AuthoredKind, SpecExamples> = {
  project: {
    pathPattern: "brainforge/project.yaml",
    minimal: PROJECT_MINIMAL,
    full: PROJECT_FULL,
    conventions: [
      "Required: schema, id (lowercase kebab-case), name, export.",
      "artDirection: sent to model: yes. Visual phrases only (line, colour, rendering); no setting, rules or status.",
      "notes: sent to model: no. Setting, rules, status, source docs live here.",
      "defaults.perspective: sent to model: yes. One short phrase (e.g. 'side-oriented three-quarter view'). defaults.palette: sent to model: yes, visual phrase only.",
      "id, name, styleIds, references, requirements, approval, automation, layers, export, sizing and animation fields: sent to model: no.",
      "Precedence: defaults, then familyDefaults.<family>, then asset overrides, then deliverable overrides. Scalars and arrays replace; objects merge.",
      "requirements.assets lists the asset ids that must be complete; optional experiments stay out of it.",
      "export.preset is generic or godot4; export.destination is game-root-relative.",
      ...COMMON_CONVENTIONS,
    ],
  },
  style: {
    pathPattern: "brainforge/styles/<id>.yaml",
    minimal: STYLE_MINIMAL,
    full: STYLE_FULL,
    conventions: [
      "<id> is lowercase kebab-case and must equal the file name without .yaml.",
      "palette: sent to model: yes, every entry. One visual phrase per entry (colour, line, rendering), positive wording only, most important first.",
      "description: sent to model: no. Documentation only.",
      "id, references, preferences: sent to model: no.",
      "preferences holds only confirmed preference ids; do not invent them.",
      ...COMMON_CONVENTIONS,
    ],
  },
  asset: {
    pathPattern: "brainforge/assets/<id>/asset.yaml",
    minimal: ASSET_MINIMAL,
    full: ASSET_FULL,
    conventions: [
      "<id> is lowercase kebab-case and must equal the asset's directory name.",
      "description: sent to model: yes. One or two concrete sentences about what the picture shows.",
      "identity values: sent to model: yes, every value, unlabelled (keys are not sent). Short concrete sentences about appearance: shape + colour + position per feature.",
      "notes: sent to model: no. Status, open questions, proposals, source docs, lore and setting belong here.",
      "overrides.perspective / overrides.palette: sent to model: yes (effective value). Perspective is one short phrase.",
      "name, id, styleIds, references, regions and every other deliverable's fields: sent to model: no. The deliverable being generated contributes its own description (stills/poses) or animation.motion (animations).",
      "A concept needs only id, name, family and description; add identity and deliverables when production starts.",
      "family is one of: character, creature, item, equipment, prop, environment, background, tile, ui, icon, effect.",
      "deliverable kind is one of: view, pose, expression, still, variant, animation, tile, ui-state, reference-sheet.",
      "deliverables[].dependsOn lists other deliverable ids in the same asset; deliverable ids are lowercase kebab-case.",
      "identity is a free map of plain-language requirements (anatomy, clothing, material, ...).",
      "animation deliverables take animation: {motion, loop, sourceFrameCount (4n+1), startReference, endReference (pose deliverable ids in dependsOn), sourceFps, playbackFps}; motion is one concrete positive sentence of what moves, no process words. reference-sheet deliverables take regions: [{id, x, y, width, height}] in source pixels.",
      "Each family allows only some deliverable kinds and requires some fields per kind (animation.motion; reference-sheet regions; tile environment.tileSize; ui-state ui.state; ui and effect animations also write animation.loop). Call family_list for the rules and family_template {family,id,name} for a starter file instead of guessing.",
      "deliverables[].output: {alpha: transparent|opaque, width, height}: width and height together or neither. State output.alpha: opaque on opaque stills (backgrounds, tiles, UI panels). Not sent to the model.",
      "environment assets list children in collection.members; a child binds the environment's locked concept with referenceRoles.<name>: {assetId, branchId, role: direction} (branchId from branch_list after the human locks). attachments only on equipment and props. export: {sprites: individual|atlas|both} packages stills.",
      ...COMMON_CONVENTIONS,
    ],
  },
};
