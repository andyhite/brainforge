import type { AssetFamily } from "@brainforge/contracts";
import { paths } from "@brainforge/storage";
import { PLACEHOLDER, findPlaceholders } from "./validate.ts";
import { parseAuthored } from "../authored.ts";

export interface FamilyTemplate { path: string; text: string; notes: string[] }

const q = (s: string): string => JSON.stringify(s);
const todo = (what: string): string => q(`${PLACEHOLDER} ${what}`);

const SHEET = (id: string): string[] => [
  "  - id: construction-sheet",
  "    kind: reference-sheet",
  `    description: ${todo(`one line on what the sheet must keep identical across its three views of the ${id}`)}`,
  "    output: { width: 1536, height: 768 }",
  "    regions:",
  `      - { id: front, x: 0, y: 0, width: 512, height: 768, view: ${q("front view, facing the camera")} }`,
  `      - { id: profile, x: 512, y: 0, width: 512, height: 768, view: ${q("side profile facing right")} }`,
  `      - { id: rear, x: 1024, y: 0, width: 512, height: 768, view: ${q("rear view, facing away from the camera")} }`,
];

/** The deliverables and extra top-level blocks of each family's starter file. */
function body(family: AssetFamily, id: string): { identity: string[]; extra: string[]; deliverables: string[] } {
  switch (family) {
    case "character":
      return {
        identity: ["anatomy", "clothing", "expression"],
        extra: [],
        deliverables: [
          ...SHEET("character"),
          "  - id: idle-rest",
          "    kind: pose",
          `    description: ${todo("the neutral resting pose, concrete body position")}`,
          "    dependsOn: [construction-sheet]",
          "    referenceRoles: { front: { deliverableId: construction-sheet, outputRole: front } }",
          "  - id: idle",
          "    kind: animation",
          "    dependsOn: [idle-rest]",
          `    description: ${todo("what the idle loop shows")}`,
          `    animation: { motion: ${todo("one concrete sentence of what moves")}, loop: true, startReference: idle-rest, endReference: idle-rest }`,
        ],
      };
    case "creature":
      return {
        identity: ["body", "surface", "head"],
        extra: [],
        deliverables: [
          "  - id: side-view",
          "    kind: view",
          `    description: ${todo("side view of the whole body, concrete features")}`,
          "  - id: walk-contact",
          "    kind: pose",
          `    description: ${todo("the contact pose of one locomotion cycle")}`,
          "    dependsOn: [side-view]",
          "  - id: walk",
          "    kind: animation",
          "    dependsOn: [walk-contact]",
          `    description: ${todo("what the locomotion loop shows")}`,
          `    animation: { motion: ${todo("one concrete sentence of how the creature moves")}, loop: true, startReference: walk-contact, endReference: walk-contact }`,
        ],
      };
    case "item":
      return {
        identity: ["material", "shape", "colours"],
        extra: [],
        deliverables: [
          "  - id: front-view",
          "    kind: view",
          `    description: ${todo("front view of the item")}`,
          "    output: { width: 512, height: 512 }",
          "  - id: side-view",
          "    kind: view",
          `    description: ${todo("side view of the item")}`,
          "    output: { width: 512, height: 512 }",
          "  - id: worn",
          "    kind: variant",
          "    dependsOn: [front-view]",
          `    description: ${todo("how the worn or used variant differs")}`,
          "    output: { width: 512, height: 512 }",
        ],
      };
    case "equipment":
      return {
        identity: ["material", "shape", "colours"],
        extra: ["attachments:", "  # Pixels of the named deliverable's canvas, origin top-left. Move these onto the real attachment point.", "  - { name: grip, x: 256, y: 384, deliverable: front-view }"],
        deliverables: [
          "  - id: front-view",
          "    kind: view",
          `    description: ${todo("front view of the equipment")}`,
          "    output: { width: 512, height: 512 }",
          "  - id: side-view",
          "    kind: view",
          `    description: ${todo("side view of the equipment")}`,
          "    output: { width: 512, height: 512 }",
          "  - id: alternate",
          "    kind: variant",
          "    dependsOn: [front-view]",
          `    description: ${todo("the colour or material variant")}`,
          "    output: { width: 512, height: 512 }",
        ],
      };
    case "prop":
      return {
        identity: ["material", "shape", "colours"],
        extra: ["attachments: []"],
        deliverables: [
          "  - id: front-view",
          "    kind: view",
          `    description: ${todo("front view of the prop at rest")}`,
          "    output: { width: 512, height: 512 }",
          "  - id: active-state",
          "    kind: variant",
          "    required: false",
          "    dependsOn: [front-view]",
          `    description: ${todo("the prop in its active state")}`,
          "    output: { width: 512, height: 512 }",
          "  # Optional motion: omit this deliverable and the prop stays static. required: false never blocks completeness.",
          "  - id: idle-loop",
          "    kind: animation",
          "    required: false",
          "    dependsOn: [front-view]",
          `    description: ${todo("what the optional loop shows")}`,
          `    animation: { motion: ${todo("one concrete sentence of what moves")}, loop: true, startReference: front-view, endReference: front-view }`,
        ],
      };
    case "environment":
      return {
        identity: ["setting", "lighting", "mood"],
        extra: [`collection:`, `  members:`, `    - { assetId: ${id}-backdrop, required: true }`, `    - { assetId: ${id}-ground-tile, required: false }`],
        deliverables: [
          "  - id: establishing",
          "    kind: still",
          `    description: ${todo("establishing shot of the whole environment")}`,
          "    output: { width: 1920, height: 1080 }",
        ],
      };
    case "background":
      return {
        identity: ["setting", "lighting", "mood"],
        extra: [],
        deliverables: [
          "  - id: backdrop",
          "    kind: still",
          `    description: ${todo("the full-frame scene, concrete landmarks from far to near")}`,
          "    output: { width: 1920, height: 1080, alpha: opaque }",
          "    environment: { layer: far, parallax: { x: 0.3, y: 0 }, seamlessAxes: [x] }",
        ],
      };
    case "tile":
      return {
        identity: ["surface", "colours", "pattern"],
        extra: [],
        deliverables: [
          "  - id: base-tile",
          "    kind: tile",
          `    description: ${todo("the repeating surface, concrete texture and pattern")}`,
          "    output: { width: 512, height: 512, alpha: opaque }",
          "    environment:",
          "      tileSize: { width: 64, height: 64 }",
          "      seamlessAxes: [x, y]",
          "      connections: { north: ground, east: ground, south: ground, west: ground }",
        ],
      };
    case "ui":
      return {
        identity: ["shape", "material", "visual language"],
        extra: [],
        deliverables: [
          "  - id: panel-normal",
          "    kind: ui-state",
          `    description: ${todo("the panel at rest, without any text")}`,
          "    output: { width: 256, height: 256, alpha: opaque }",
          "    ui: { state: normal, nineSlice: { left: 24, top: 24, right: 24, bottom: 24 } }",
          "  - id: panel-pressed",
          "    kind: ui-state",
          "    dependsOn: [panel-normal]",
          `    description: ${todo("how the pressed state differs")}`,
          "    output: { width: 256, height: 256, alpha: opaque }",
          "    ui: { state: pressed, nineSlice: { left: 24, top: 24, right: 24, bottom: 24 } }",
        ],
      };
    case "icon":
      return {
        identity: ["glyph", "colours", "outline"],
        extra: [],
        deliverables: [
          "  - id: icon-default",
          "    kind: still",
          `    description: ${todo("the glyph, one concrete subject")}`,
          "    output: { width: 128, height: 128, alpha: transparent }",
          "  - id: icon-disabled",
          "    kind: ui-state",
          "    dependsOn: [icon-default]",
          `    description: ${todo("how the disabled state differs")}`,
          "    output: { width: 128, height: 128, alpha: transparent }",
          "    ui: { state: disabled }",
        ],
      };
    case "effect":
      return {
        identity: ["shape", "colours", "energy"],
        extra: [],
        deliverables: [
          "  - id: burst",
          "    kind: still",
          `    description: ${todo("the key frame of the effect")}`,
          "    output: { width: 512, height: 512, alpha: transparent }",
          "  - id: plume",
          "    kind: animation",
          "    dependsOn: [burst]",
          `    description: ${todo("what the sequence shows")}`,
          `    animation: { motion: ${todo("one concrete sentence of how the effect evolves")}, loop: false, startReference: burst, endReference: burst }`,
          "    output: { alpha: transparent, width: 512, height: 512 }",
        ],
      };
  }
}

/** A starter asset.yaml for a family. It validates as written; `REPLACE:` text marks what a person still has to author. */
export function familyTemplate(family: AssetFamily, id: string, name: string, description?: string): FamilyTemplate {
  const { identity, extra, deliverables } = body(family, id);
  const lines = [
    "schema: brainforge.asset.v2",
    `id: ${id}`,
    `name: ${q(name)}`,
    `family: ${family}`,
    `description: ${description ? q(description) : todo(`one concrete sentence describing the ${family}`)}`,
    `notes: ${q("Starter file from family.template. Replace every REPLACE: text, then check it with spec.validate.")}`,
    "identity:",
    ...identity.map((k) => `  ${k}: ${todo(`concrete visible features (${k})`)}`),
    "styleIds: []",
    ...extra,
    "deliverables:",
    ...deliverables,
  ];
  const text = `${lines.join("\n")}\n`;
  const path = paths.assetYaml(id);
  const parsed = parseAuthored("asset", path, id, text);
  const notes = [
    `Write it with spec.write to ${path} (expectedHash: null creates the file).`,
    parsed.kind === "asset" && parsed.spec ? `Replace the ${findPlaceholders(parsed.spec).length} REPLACE: placeholder(s) before generating; until then spec.validate reports them as warnings.` : "The starter file has problems; this is a bug in the template.",
    "Adjust the example deliverables to what the game needs; only declared deliverables become steps.",
  ];
  return { path, text, notes };
}
