# `brainforge/assets/<asset-id>/asset.yaml`

Human-readable companion to `spec.schema {kind:"asset"}`; `spec.schema` wins on conflict. Per-family kinds/required fields/templates: [families](families.md) (`family.list`, `family.template`); environments: [environments](environments.md); UI/icons/effects: [ui-vfx](ui-vfx.md).

Schema `brainforge.asset.v2`. `.strict()` everywhere. `id` MUST equal the parent directory name (kebab-case, unique across the project). Create a new asset by writing `brainforge/assets/<id>/asset.yaml`. Concept validity needs only `schema, id, name, family, description`; missing production fields only block the steps that need them. Display-name or family edits never move the directory.

## Asset fields

|Field|Req|Type / default|
|---|---|---|
|`schema`|yes|literal `brainforge.asset.v2`|
|`id`|yes|kebab-case = directory name|
|`name`|yes|non-empty string|
|`family`|yes|`character creature item equipment prop environment background tile ui icon effect`|
|`description`|yes|non-empty string. SENT to the model except for reference-sheet edits: one or two concrete sentences of what the picture shows|
|`notes`|no|string, `""`. NEVER sent to the model: status, open questions, proposals, doc references, lore, setting|
|`identity`|no|map string -> string. EVERY value is SENT to the model except for reference-sheet edits, unlabelled (keys are not): short concrete appearance sentences, shape + colour + position per feature; values MUST be strings (`age: 16` fails, write `age: "16"`)|
|`styleIds`|no|kebab ids of existing styles, `[]`; real and checked, not decoration|
|`references`|no|string[] reference ids, `[]`|
|`overrides`|no|Defaults block (see project-yaml.md), `{}`|
|`deliverables`|no|list of Deliverable, `[]`|
|`collection`|no|`{members:[{assetId: kebab, required: bool=true}], styleId?: kebab}`; ONLY on `environment` assets ([environments](environments.md))|
|`attachments`|no|`[{name: kebab, x: number, y: number, deliverable?: kebab}]`, `[]`; ONLY `equipment`/`prop`; pixels of that deliverable's canvas, origin top-left; exported as `metadata.attachments` with normalized `nx`/`ny` ([families](families.md))|
|`export`|no|`{sprites: individual\|atlas\|both = individual}`: packaging of still deliverables ([ui-vfx](ui-vfx.md))|

## Deliverable

|Field|Req|Type / default|
|---|---|---|
|`id`|yes|kebab-case, unique within the asset|
|`kind`|yes|`view pose expression still variant animation tile ui-state reference-sheet`|
|`required`|no|bool, `true`; optional experiments set `false`|
|`description`|no|string|
|`dependsOn`|no|deliverable ids in the same asset|
|`referenceRoles`|no|map role-name -> EITHER `{deliverableId, outputRole}` (same asset: `deliverableId` is in `dependsOn`, `outputRole` is a region id of that reference-sheet, e.g. `identity: {deliverableId: construction-sheet, outputRole: profile}`) OR `{assetId, branchId, role: direction}` (cross-asset: the NAMED branch of an environment; see [environments](environments.md)). Anything else is an ERROR. Same-asset: the first binding supplies the ONE reference image (a hash-pinned crop of the approved sheet); without a binding the branch's locked concept output is the reference; further bindings are ignored and the plan's `notes` say so|
|`overrides`|no|Defaults block, highest precedence|
|`animation`|no|`{motion: string (required), loop: bool=true, sourceFps?, playbackFps?: number>0, sourceFrameCount?: int>0, startReference?, endReference?: string}`|
|`environment`|no|`{layer?, pivot?{x,y}, relativeScale?>0, tileSize?{width,height ints>0}, connections?{north,east,south,west: label strings}, seamlessAxes?: [] \| ["x"] \| ["y"] \| ["x","y"], parallax?{x,y}}`|
|`ui`|no|`{state?: string, nineSlice?{left,top,right,bottom: ints>=0}}`|
|`regions`|no|only for `reference-sheet`: `[{id: kebab, x,y: int>=0, width,height: int>0, view?: string}]` in source pixels; `view` is a concrete phrase sent to the model for that region|
|`referenceStrength`|no|number 0..20: image-conditioning strength (workflow `ref_boost`); lower lets pose/state change more. Workflow default if omitted|
|`output`|no|`{alpha?: transparent\|opaque, width?: int>0, height?: int>0}`: width and height together or neither, max 8192. `alpha` overrides the family default (opaque deliverables should say `alpha: opaque`; it also selects the opaque workflows and `fit: crop` processing). Not sent to the model|

Animation timing: exact generation size, required images and `4n+1` frame counts come from the workflow; `sourceFrameCount` must be `4n+1` (5..81). `animation.startReference`/`endReference` name a deliverable in `dependsOn`: a POSE for `character`/`creature` (e.g. `idle-rest`; default: the first approved pose dependency), a `pose`, `still`, `view` or `variant` for every other family. `animation.motion` is prompt-bearing: one concrete positive sentence of what moves. `animation.loop` defaults to `true` but MUST be written explicitly for `ui` and `effect` animations. `playbackFps` is the export rate (processing resamples, preserving duration). Full guide: [motion-processing](motion-processing.md).

Precedence for settings: project `defaults` → `familyDefaults` → asset `overrides` → deliverable `overrides`. Scalars/arrays replace, objects merge. Check with `settings.inspect {assetId, deliverableId}`.

Prompt rules (full list: SKILL.md "Writing prompt-bearing YAML"): SENT = `description`, every `identity` value, effective `perspective`/`palette` from `overrides`, and, only when that deliverable is generated, that deliverable's own `description` (other deliverables' text is never sent, so each description MUST follow the same rules: concrete picture, positive phrasing). NEVER sent = `notes`, `name`, ids, other deliverables' fields. Describe the picture, no doc references/status/other characters' names; front/profile/rear wording only in the construction-sheet deliverable description. Changing a sent field invalidates art; `name` and `notes` do not.

For `reference-sheet` edits, the reference image supplies identity and style instead: only the identity-lock instruction, sheet `description`, region layout and per-run iteration instructions are sent. Asset description/identity, effective palette/perspective, project art direction and style palettes are omitted. MUST keep sheet descriptions focused on the requested views.

`dependsOn` (same-asset deliverable ids): a deliverable step is `ready` only after a concept is locked (branch) and every listed deliverable has a selected output with an applicable approval. Independent deliverables are ready independently; cycles, missing ids and a deliverable named `concept` are reported as problems on the affected steps only. Declare only dependencies the art needs: a static prop with no `dependsOn` never gets reference steps. Changing a dependency's approved output makes dependents need reassessment. See [branches-review](branches-review.md).

## Minimal valid

```yaml asset
schema: brainforge.asset.v2
id: health-pickup
name: Health Pickup
family: item
description: A small collectible that restores health.
```

## Full example (Cortex-style character)

```yaml asset
schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: >-
  A sixteen-year-old boy with a huge coral-pink brain for a head, standing upright
  with a slouch and his weight on one leg.
notes: >-
  Not sent to the model. Source: docs/04-characters.md. Four-finger hands are a proposal,
  awaiting approval. Early concept lives in references/ and is exploratory only.
identity:
  brain: coral-pink brain with broad deliberate folds, taller than the whole body below it and about twice as wide as his shoulders
  eyes: two big round white eyes with dark pupils in the middle of the front of the brain
  mouth: a small wide curved mouth drawn as a dark line just below the eyes
  clothing: white T-shirt, blue jeans with a brown belt, black high-top sneakers
  hands: four-fingered hands in light peach skin colour at the end of thin arms
  attitude: slouched shoulders, head tilted slightly forward, weight on one leg
styleIds:
  - cranium
references: []
overrides:
  perspective: side-oriented three-quarter view facing right
deliverables:
  - id: construction-sheet
    kind: reference-sheet
    description: One sheet with three upright figures side by side, labelled views front, profile and rear, on plain light grey.
    regions:
      - { id: front, x: 0, y: 0, width: 512, height: 768 }
      - { id: profile, x: 512, y: 0, width: 512, height: 768 }
      - { id: rear, x: 1024, y: 0, width: 512, height: 768 }
  - id: idle-rest
    kind: pose
    description: Neutral resting stance used as the idle loop guide.
    dependsOn: [construction-sheet]
  - id: walk-contact
    kind: pose
    description: Walk contact pose with a clear stride, used as the walk loop guide.
    dependsOn: [construction-sheet]
  - id: idle
    kind: animation
    dependsOn: [idle-rest]
    animation:
      motion: slow breathing with a small weight shift
      loop: true
      startReference: idle-rest
      endReference: idle-rest
  - id: walk
    kind: animation
    dependsOn: [walk-contact]
    overrides:
      animation:
        playbackFps: 16
    animation:
      motion: relaxed slouching walk cycle, brain bobbing slightly
      loop: true
      sourceFps: 16
      sourceFrameCount: 33
      startReference: walk-contact
      endReference: walk-contact
  - id: surprised
    kind: expression
    required: false
    description: Eyes wide, mouth stretched.
```

## Common mistakes (validator output)

|Mistake|Message|
|---|---|
|`family: monster`|`family: Invalid option: expected one of "character"\|"creature"\|...`|
|`id` ≠ directory name|`id "cortex-2" must equal the directory name "cortex"`|
|non-kebab id (`Cortex_1`)|`id: must be lowercase kebab-case`|
|empty `description`|`description: Too small: expected string to have >=1 characters`|
|`kind: video`|`deliverables.0.kind: Invalid option: expected one of "view"\|"pose"\|...`|
|numeric identity value|`identity.age: Invalid input: expected string, received number`|
|unknown key|`Unrecognized key "tags"`|
|wrong schema literal|`schema: Invalid input: expected "brainforge.asset.v2"`|
|abstract or doc-style feature text ("large integrated eyes", "proposal needed")|valid, but sent verbatim to the model; rewrite concretely, move status to `notes`|
|negation ("gray backdrop is not part of the character")|valid, but the named thing gets drawn; state only what to draw|
|kind not allowed for the family (`kind: animation` on an `item`, `tile` on a `ui`)|`Deliverable kind "..." is not allowed for a item; allowed: ...` (ERROR; see [families](families.md))|
|`collection` on a non-environment, `attachments` on a character|`Only environment assets form collections...` / `Attachment points are only for equipment and props...` (ERRORs)|
|`output` with only `width`|`output needs both width and height, or neither.`|
|nine-slice margins covering the canvas|`Nine-slice left (24) + right (24) must leave a stretchable centre inside output.width 48.`|
|seamless tile with different edge labels|`A tile that is seamless on x repeats onto itself, so its west (...) and east (...) connection labels must match.`|
|missing production field, leftover `REPLACE:` text|WARNING only (`... needs animation.motion before it can be produced`, `Unfinished placeholder`); blocks that deliverable's step, not the file|

Never put URLs or absolute machine paths in asset YAML: they are non-portable. `spec.read` shows these messages after an edit.
