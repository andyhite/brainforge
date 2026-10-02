# Asset families (M10-M12)

Bare operation names. The catalog lives in code and is exposed read-only: `family.list` (all 11 profiles) and `family.template {family, id, name, description?}` (a starter `asset.yaml` that validates as written). NEVER guess a family's kinds or required fields: read `family.list`, or start from `family.template`, write its `text` to `path`, then `spec.read {path}` (ignore the template's `spec.write` next action; that is the UI's path).

Templates contain `REPLACE:` placeholders. `spec.read` reports each as a WARNING ("Unfinished placeholder"); replace every one before `generation.plan`. Only deliverables you keep become steps; delete the example deliverables the game does not need.

## The 11 families

|Family|Allowed deliverable kinds|Alpha (default)|Motion|Collection role|Required fields per kind|
|---|---|---|---|---|---|
|`character`|view pose expression still variant animation reference-sheet|transparent (matte)|typical|none|animation: `animation.motion`; reference-sheet: `regions`|
|`creature`|same as character (no humanoid assumptions)|transparent|typical|none|animation: `animation.motion`; reference-sheet: `regions`|
|`item`|view still variant reference-sheet|transparent|none (static)|none|reference-sheet: `regions`|
|`equipment`|view still variant animation reference-sheet|transparent|optional|none|animation: `animation.motion`; reference-sheet: `regions`|
|`prop`|view still variant animation reference-sheet|transparent|optional|member|animation: `animation.motion`; reference-sheet: `regions`|
|`environment`|view still variant reference-sheet|opaque|none|container|reference-sheet: `regions`|
|`background`|view still variant|opaque|none|member|-|
|`tile`|tile still variant|opaque|none|member|tile: `environment.tileSize`|
|`ui`|ui-state still variant animation|per deliverable (default opaque)|optional|none|ui-state: `ui.state`; animation: `animation.motion` + `animation.loop` written explicitly|
|`icon`|still variant ui-state|transparent|none|none|ui-state: `ui.state`|
|`effect`|still variant animation|per deliverable (default transparent)|typical|none|animation: `animation.motion` + `animation.loop` written explicitly|

- "Transparent" = the workflow removes the background (matted cut-out). "Opaque" = the full frame is kept; background removal is NEVER applied. `per deliverable` = decide with `output.alpha`.
- A static family (`item`, `icon`, `environment`, `background`, `tile`) with an `animation` block or `kind: animation` is an ERROR (`A item is static and declares no animation deliverables`). A wrong kind is an error listing the allowed kinds.
- Missing required fields are WARNINGS on the file and step-level BLOCKERS for that deliverable only; the concept and sibling deliverables stay usable.
- `collection` on a non-environment asset is an ERROR. Members (`background`, `tile`, `prop`) are listed by the environment, not by themselves: see [environments](environments.md).
- `attachments` is only valid on `equipment` and `prop` (error otherwise).
- Motion guides: `character`/`creature` animations start and end on a `pose` deliverable; every other family may use a `pose`, `still`, `view` or `variant` as `startReference`/`endReference`. Both must be in `dependsOn`.
- Workflows are chosen from family, stage and alpha (`workflow.list`): `krea2-still`, `krea2-variation`, `wan22-motion` for transparent; `krea2-still-opaque`, `krea2-variation-opaque`, `wan22-motion-opaque` for opaque. The opaque workflows are UNVERIFIED on real ComfyUI (no GPU run yet); `workflow.preflight` and the fake ComfyUI only prove the graph classes and wiring. Say so when you report opaque results; do not claim art quality.
- Effective `workflows` overrides select the exact stage/alpha key: `still`, `variation`, `motion`, or `stillOpaque`, `variationOpaque`, `motionOpaque`. Precedence: project → family → asset → deliverable. Unsupported family stages stay unavailable.
- Character templates opt only their construction sheet into `krea2-construction-sheet` / `krea2-construction-sheet-opaque` using deliverable `overrides.workflows`. The workflows stack `Krea2_Character_Design_4-View_V1.safetensors` with identity-edit. Use front/profile/rear full-body regions plus a face close-up (starter canvas 2048×1024, four 512×1024 regions). Existing sheets remain unchanged unless opted in. Baseline: override back to `krea2-variation` / `krea2-variation-opaque`. Live transparent Cortex comparison produced three bodies plus a face, versus five bodies without the adapter; front remained three-quarter and the wider face caused equal-width crops to cross subjects. MUST inspect framing and crops before approval. Opaque sheet workflow remains UNVERIFIED visually.
- `wan22-motion` and `wan22-motion-opaque` have a version 2 that adds the `wan2.2_animate_adapter_model` LoRA to both experts and switches the sampler to `ddim`. The newest version is used by default, and it is UNVERIFIED on real ComfyUI (version 1 is the one that has run live). Say so when you report motion results from it; `workflow.preflight` also fails if the adapter file is missing on the server.

## `output` and other deliverable fields

|Field|Rule|
|---|---|
|`output.alpha`|`transparent` or `opaque`; overrides the family default|
|`output.width` / `output.height`|Canvas in pixels for this element. BOTH or neither. Max 8192. Omit to use the workflow default. Processing fits the generated image to this exact canvas (`fit`, see [ui-vfx](ui-vfx.md))|
|`referenceStrength`|0..20. Lower lets the pose/state change more from the reference (`ref_boost`). Workflow default if omitted|
|`regions[].view`|Optional concrete phrase sent to the model for that region of a reference-sheet ("side profile facing right")|
|`attachments`|Top-level list `[{name: kebab, x, y, deliverable?}]` on `equipment`/`prop`: pixels of that deliverable's canvas, origin top-left, x right, y down. `deliverable` must exist. Exported: `asset.json` `metadata.attachments = [{name,x,y,deliverable?,nx,ny}]` (`nx`/`ny` normalized to that deliverable's exported canvas); the deliverable's own `metadata.attachments = [{name,x,y,nx,ny}]` also reaches Godot textures as metadata. Per FamGate; not re-verified by me. Brainforge models no inventory or sockets|
|`export.sprites`|Top-level `individual` (default) / `atlas` / `both`: packaging of still deliverables. See [ui-vfx](ui-vfx.md)|

## What the model receives

Same rule as every asset: the YAML is the prompt (SKILL.md "Writing prompt-bearing YAML"). Per family the fixed, positive framing sentence that is appended:

|Family|Framing / viewpoint|
|---|---|
|character, creature|single figure alone, fully visible, flat light-grey background; perspective is sent (not for a reference-sheet)|
|item, equipment, prop, icon|single object alone, fully visible, flat light-grey background; perspective sent|
|background|full-frame scene filling the canvas edge to edge|
|environment|establishing shot of the whole environment|
|tile|flat orthographic seamless repeating texture covering the frame; NO perspective sent|
|ui|opaque: one flat element filling the frame; transparent: centred on light grey; NO perspective sent; text is never generated|
|effect|opaque: fills the frame; transparent: effect alone, centred, with margin on light grey|

`ui.state`, `environment.*`, `attachments`, `output` are structural metadata: NEVER sent. Put what a state looks like into the deliverable `description` (only the deliverable being generated is sent).

Canvas and conditioning facts for every family: (1) a deliverable whose canvas (`output`) has a longer side under 256 px is still GENERATED at 1024x1024 and fitted down by processing; larger canvases generate at their own size (up to 2048). (2) Every deliverable is conditioned on the branch's locked concept alone (or on the one sheet region bound through `referenceRoles`); a `dependsOn` state or variant orders review but its pixels are NOT fed to the model. (3) The effective `palette`, every style `palette` entry and every `identity.*` value go into EVERY deliverable prompt, so a state that must look different must not contradict them. Style palette entries are joined with ", "; when any entry itself contains a comma they are joined with "; " so each entry stays one phrase. (4) Opaque rounded panels get light-grey corners: see [ui-vfx](ui-vfx.md).

## Writing rules per family

- character / creature: the Cortex rules in SKILL.md. A creature `identity` lists body plan, surface, head with shape + colour + position; no human anatomy unless it has it.
- item / equipment: material, shape, colours as concrete visuals ("a straight blade of pale blue steel as long as the forearm with a brown leather-wrapped handle"). One view per deliverable. Variants (`kind: variant`, `dependsOn: [front-view]`) describe only what differs ("the same sword with a red cloth wrapped around the handle").
- prop: static by default. Add an `animation` deliverable with `required: false` only if the user wants a loop; a prop never gets pose or sheet steps you did not declare.
- icon: ONE glyph subject, high contrast, readable at the output size ("a red heart with a thick dark outline, centred"). No text or numbers.
- ui: describe the panel/button shape, material, border and fill. NEVER mention labels, text or numbers (text stays outside generated art).
- effect: describe shape, colour, density and motion over time positively ("a ring of orange flame that expands outward and fades to grey smoke"). Do not write "no background"; transparency comes from `output.alpha`.
- background / tile / environment: see [environments](environments.md).

## Validated examples

Creature (transparent, with motion):

```yaml asset
schema: brainforge.asset.v2
id: mud-crawler
name: Mud Crawler
family: creature
description: A low four-legged swamp creature with a flat wide head and a long tail, seen from the side.
notes: Enemy for the swamp level. Source docs/06-enemies.md.
identity:
  body: a long low brown body as long as three heads, with four short thick legs spread wide
  surface: wet olive-green skin with dark brown mud patches along the back
  head: a flat wide head with two small yellow eyes on top and a wide toothless mouth
styleIds: []
deliverables:
  - id: side-view
    kind: view
    description: The whole body from the side, standing still with all four feet on the ground.
  - id: crawl-contact
    kind: pose
    dependsOn: [side-view]
    description: Mid-crawl pose with the front left and back right legs lifted and the body low.
  - id: crawl
    kind: animation
    dependsOn: [crawl-contact]
    animation:
      motion: the creature crawls forward in an even rhythm, legs pushing in diagonal pairs and the tail swaying side to side
      loop: true
      startReference: crawl-contact
      endReference: crawl-contact
```

Equipment with attachment points and a variant:

```yaml asset
schema: brainforge.asset.v2
id: iron-sword
name: Iron Sword
family: equipment
description: A straight one-handed sword drawn from the side, blade pointing up.
identity:
  blade: a straight blade of pale blue steel as long as a forearm with a thin dark centre line
  handle: a brown leather-wrapped handle with a round gold pommel and a short flat gold crossguard
attachments:
  - { name: grip, x: 256, y: 384, deliverable: side-view }
  - { name: tip, x: 256, y: 40, deliverable: side-view }
deliverables:
  - id: side-view
    kind: view
    description: The sword upright, seen from the side, fully visible.
    output: { width: 512, height: 512 }
  - id: red-wrap
    kind: variant
    dependsOn: [side-view]
    description: The same sword with a red cloth wrapped around the handle.
    output: { width: 512, height: 512 }
```

Static prop with an optional loop:

```yaml asset
schema: brainforge.asset.v2
id: health-pickup
name: Health Pickup
family: prop
description: A small round glass bottle filled with glowing red liquid and sealed with a cork.
identity:
  glass: clear round glass with a thick dark outline and a white highlight on the upper left
  liquid: bright red liquid filling three quarters of the bottle
deliverables:
  - id: front-view
    kind: view
    description: The bottle standing upright, seen from the front.
    output: { width: 256, height: 256 }
  - id: float-loop
    kind: animation
    required: false
    dependsOn: [front-view]
    description: The bottle floating in place.
    animation:
      motion: the bottle rises and falls gently while the liquid glows brighter and dimmer
      loop: true
      startReference: front-view
      endReference: front-view
```

Icon set (states carry `ui.state`):

```yaml asset
schema: brainforge.asset.v2
id: heart-icon
name: Heart Icon
family: icon
description: A single red heart glyph with a thick dark outline and a small white highlight.
deliverables:
  - id: heart-default
    kind: still
    description: A bright red heart with a thick dark outline, centred.
    output: { width: 128, height: 128, alpha: transparent }
  - id: heart-disabled
    kind: ui-state
    dependsOn: [heart-default]
    description: The same heart filled with flat mid-grey.
    output: { width: 128, height: 128, alpha: transparent }
    ui: { state: disabled }
```

Effect (transparent, plays once):

```yaml asset
schema: brainforge.asset.v2
id: blast-plume
name: Blast Plume
family: effect
description: A round burst of orange fire with a bright yellow core and grey smoke at the edges.
deliverables:
  - id: burst
    kind: still
    description: The key frame, the fireball at full size in the centre.
    output: { width: 512, height: 512, alpha: transparent }
  - id: plume
    kind: animation
    dependsOn: [burst]
    description: The explosion over time.
    output: { width: 512, height: 512, alpha: transparent }
    animation:
      motion: the fireball swells from a small yellow spark to a large orange burst, then thins into rising grey smoke
      loop: false
      startReference: burst
      endReference: burst
```

Common mistakes: `kind: animation` on an item; `output` with only `width`; `attachments` on a character; `ui-state` without `ui.state`; a tile without `environment.tileSize`; an effect/UI animation without an explicit `animation.loop`; text in a UI description.
