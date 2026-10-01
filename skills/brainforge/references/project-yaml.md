# `brainforge/project.yaml`

Human-readable companion to `spec_schema {kind:"project"}`. `spec_schema` is authoritative; it wins on any conflict.

Path: `<game root>/brainforge/project.yaml`. Exactly one per project. Schema `brainforge.project.v2`. Every object is `.strict()`: unknown keys are errors. All paths are relative to the game root. Non-portable values are rejected anywhere in this file: strings starting with `scheme://`, `/`, `~`, or `C:\`, and keys matching token/secret/password/api-key/bearer/credential.

## Fields

|Field|Req|Type / default|
|---|---|---|
|`schema`|yes|literal `brainforge.project.v2`|
|`id`|yes|kebab-case (`[a-z0-9]+(-[a-z0-9]+)*`), immutable|
|`name`|yes|non-empty string|
|`artDirection`|no|string, default `""`. SENT to the model: visual phrases only (line, colour, rendering, mood), no setting, rules or status|
|`notes`|no|string, default `""`. NEVER sent to the model: setting, rules, status, source docs|
|`styleIds`|no|kebab ids of `styles/<id>.yaml`; default `[]`|
|`references`|no|string[] (imported reference ids); default `[]`|
|`defaults`|no|Defaults block (below); default `{}`|
|`familyDefaults`|no|map `family -> Defaults`; keys limited to asset families|
|`layers`|no|`[{id: kebab, description?: string}]`|
|`requirements.assets`|no|kebab asset ids that are required for completeness; default `[]`|
|`approval`|no|requested policy; each of `conceptLock`, `productionReview`, `promotion`, `activation` is `human`\|`agent`\|`agent_with_escalation`. Defaults: human, agent_with_escalation, human, human. `promotion` governs `promotion_start` (publishing an immutable version), `activation` governs `version_activate` (making it current); they are independent. See [production-versions](production-versions.md)|
|`automation`|no|`maxAttemptsPerStep` int>0 (3), `maxConcurrentGenerations` int>0 (1), `maxBatchCandidates` int>0 (4), `autoRegenerate` bool (false)|
|`export`|yes|`preset` `generic`\|`godot4`; `destination` non-empty relative path (not inside `brainforge/`); `godotProjectRoot` relative path, default `.`. For `godot4` that folder must contain `project.godot` and the destination must be inside it; `res://` is derived from it. Layout, conflicts, recovery: [export](export.md)|

Families: `character creature item equipment prop environment background tile ui icon effect`.

Defaults block (used by `defaults`, each `familyDefaults.<family>`, asset `overrides`, deliverable `overrides`; all optional): `perspective` string (SENT; one short phrase); `palette` string (SENT; visual phrase); `sizing {width:int>0, height:int>0, subjectHeightPx?:number>0, displayScale?:number>0}`; `animation {playbackFps:number>0}` (omit for static projects; stills need no frame rate); `processing {resizeFilter?: "nearest"|"lanczos3"}` (the default resize filter of `processing_plan`; set `nearest` for pixel art so hard edges stay hard, otherwise `lanczos3` smooths; a request's `recipe.resizeFilter` still wins; no other key is read); `workflows` map string->string (workflow ids). Only `artDirection`, `perspective`, `palette` reach the model; everything else in this file does not.

`approval` is a REQUEST. Effective authority is the last human-confirmed snapshot; `settings_inspect` shows requested vs effective. Relaxing a policy in YAML does not take effect until the human confirms it in the UI.

## Effective-settings precedence

project `defaults` → project `familyDefaults.<family>` → asset `overrides` → deliverable `overrides` (plus the deliverable's `animation` block). Later wins. Scalars and arrays replace; objects merge key by key; omitted inherits. `settings_inspect {assetId?, deliverableId?}` returns each leaf with its source file/field/layer. Styles contribute ordered `palette` constraints; two styles that disagree on a concrete value appear under `conflicts`, never silently resolved.

## Minimal valid

```yaml project
schema: brainforge.project.v2
id: tiny-game
name: Tiny Game
export:
  preset: generic
  destination: assets/brainforge
```

## Real example (shit-your-brain-pants)

```yaml project
schema: brainforge.project.v2
id: shit-your-brain-pants
name: Shit Your Brain-Pants
artDirection: >-
  Bold dark warm-brown outer contours, thinner interior fold lines, mostly flat colour
  with one broad shadow tone, elastic limbs and exaggerated expressive poses,
  softly painted lower-contrast backgrounds.
notes: >-
  Not sent to the model. Source: docs/03-art-direction.md. Setting: Cranium, a world of
  humanoid brains; the premise must survive at gameplay scale.
styleIds:
  - cranium
references: []
defaults:
  perspective: side-oriented three-quarter view facing right
  animation:
    # 16 fps chosen after comparing 12 and 16 fps at preserved duration.
    playbackFps: 16
familyDefaults:
  character:
    sizing:
      # Neutral standing height 216 px on a 256x256 canvas; display height 120 px.
      width: 256
      height: 256
      subjectHeightPx: 216
      displayScale: 0.5556
layers: []
requirements:
  assets:
    - cortex
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
  preset: generic
  destination: assets/brainforge
```

## Common mistakes (validator output)

|Mistake|Message|
|---|---|
|unknown key `colour`|`Unrecognized key "colour"` (reported at the key's line/column)|
|`id: My_Game`|`id: must be lowercase kebab-case`|
|`export.destination: /Users/me/out`|`export.destination: machine-specific absolute path`|
|URL in any string|`artDirection: connection URLs are machine settings, not portable project data`|
|`apiKey` key under `defaults.processing`|`defaults.processing.apiKey: credential-like key is not allowed in portable settings`|
|missing `export`|`export: Invalid input: expected object, received undefined`|
|`approval.promotion: robot`|`approval.promotion: Invalid option: expected one of "human"\|"agent"\|"agent_with_escalation"`|

Connection URLs (ComfyUI) never go in YAML; the human sets them in the UI. Use `spec_validate` to see these messages without writing.

## On-disk layout

```text
<game>/
  brainforge/
    project.yaml                        author-owned
    styles/<style-id>.yaml              author-owned (file name = id)
    assets/<asset-id>/
      asset.yaml                        author-owned (dir name = id)
      references/<ref-id>/<file>        created by reference_import
      work/  versions/                  tool-managed, never hand-edit
    references/<ref-id>/<file>          created by reference_import (project scope)
    .state/project.sqlite               tool-managed, durable data, never delete or edit
  assets/brainforge/                    configured export destination (tool-managed)
```

Authors own only `project.yaml`, `styles/*.yaml`, `assets/*/asset.yaml`. Only these locations are recognised by `spec_write`.
