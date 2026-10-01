# `brainforge/assets/<asset-id>/asset.yaml`

Human-readable companion to `spec_schema {kind:"asset"}`; `spec_schema` wins on conflict.

Schema `brainforge.asset.v2`. `.strict()` everywhere. `id` MUST equal the parent directory name (kebab-case, unique across the project). Create a new asset with `spec_write {path:"brainforge/assets/<id>/asset.yaml", expectedHash:null}`. Concept validity needs only `schema, id, name, family, description`; missing production fields only block the steps that need them. Display-name or family edits never move the directory.

## Asset fields

|Field|Req|Type / default|
|---|---|---|
|`schema`|yes|literal `brainforge.asset.v2`|
|`id`|yes|kebab-case = directory name|
|`name`|yes|non-empty string|
|`family`|yes|`character creature item equipment prop environment background tile ui icon effect`|
|`description`|yes|non-empty string. SENT to the model: one or two concrete sentences of what the picture shows|
|`notes`|no|string, `""`. NEVER sent to the model: status, open questions, proposals, doc references, lore, setting|
|`identity`|no|map string -> string. EVERY value is SENT to the model, unlabelled (keys are not): short concrete appearance sentences, shape + colour + position per feature; values MUST be strings (`age: 16` fails, write `age: "16"`)|
|`styleIds`|no|kebab ids of existing styles, `[]`; real and checked, not decoration|
|`references`|no|string[] reference ids, `[]`|
|`overrides`|no|Defaults block (see project-yaml.md), `{}`|
|`deliverables`|no|list of Deliverable, `[]`|
|`collection`|no|`{members:[{assetId: kebab, required: bool=true}], styleId?: kebab}`; for `environment` collections|

## Deliverable

|Field|Req|Type / default|
|---|---|---|
|`id`|yes|kebab-case, unique within the asset|
|`kind`|yes|`view pose expression still variant animation tile ui-state reference-sheet`|
|`required`|no|bool, `true`; optional experiments set `false`|
|`description`|no|string|
|`dependsOn`|no|deliverable ids in the same asset|
|`referenceRoles`|no|map role-name -> `{deliverableId, outputRole}` where `deliverableId` is in `dependsOn` and `outputRole` is a region id of that reference-sheet (e.g. `identity: {deliverableId: construction-sheet, outputRole: profile}`). The first binding supplies the ONE reference image the deliverable is generated from (a hash-pinned crop of the approved sheet); without a binding the branch's locked concept output is the reference. The workflow takes a single reference, so further bindings are ignored and the plan's `notes` say so|
|`overrides`|no|Defaults block, highest precedence|
|`animation`|no|`{motion: string (required), loop: bool=true, sourceFps?, playbackFps?: number>0, sourceFrameCount?: int>0, startReference?, endReference?: string}`|
|`environment`|no|`{layer?, pivot?{x,y}, relativeScale?>0, tileSize?{width,height ints>0}, connections?{north,east,south,west: label strings}, seamlessAxes?: [] \| ["x"] \| ["y"] \| ["x","y"], parallax?{x,y}}`|
|`ui`|no|`{state?: string, nineSlice?{left,top,right,bottom: ints>=0}}`|
|`regions`|no|only for `reference-sheet`: `[{id: kebab, x,y: int>=0, width,height: int>0}]` in source pixels|

Animation timing: exact generation size, required images and `4n+1` frame counts come from the workflow; `sourceFrameCount` must be `4n+1` (5..81). `animation.startReference`/`endReference` name a POSE deliverable in `dependsOn` (e.g. `idle-rest`; default: the first approved pose dependency). `animation.motion` is prompt-bearing: one concrete positive sentence of what moves. `playbackFps` is the export rate (processing resamples, preserving duration). Full guide: [motion-processing](motion-processing.md).

Precedence for settings: project `defaults` → `familyDefaults` → asset `overrides` → deliverable `overrides`. Scalars/arrays replace, objects merge. Check with `settings_inspect {assetId, deliverableId}`.

Prompt rules (full list: SKILL.md "Writing prompt-bearing YAML"): SENT = `description`, every `identity` value, effective `perspective`/`palette` from `overrides`, and, only when that deliverable is generated, that deliverable's own `description` (other deliverables' text is never sent, so each description MUST follow the same rules: concrete picture, positive phrasing). NEVER sent = `notes`, `name`, ids, other deliverables' fields. Describe the picture, no doc references/status/other characters' names; front/profile/rear wording only in the construction-sheet deliverable description. Changing a sent field invalidates art; `name` and `notes` do not.

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

Never put URLs or absolute machine paths in asset YAML: they are non-portable. Use `spec_validate` to see these messages without writing.
