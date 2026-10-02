# Environments: collections, direction, aggregate promotion (M11)

Bare operation names. An `environment` asset is a VISUAL collection: its locked concept sets shared direction; member assets (`background`, `tile`, `prop`) stay ordinary assets with their own pipelines and versions. There is no level graph, placed scene, collision or engine sync. Read [families](families.md) first for kinds and required fields; start from `family.template {family:"environment", id, name}` (it writes placeholder member ids you must replace with real asset ids).

## Authoring a collection

```yaml asset
schema: brainforge.asset.v2
id: flatlands
name: Flatlands
family: environment
description: A wide open plain of pale yellow grass under a low grey sky, with a few bare dark trees on the horizon.
notes: Level 1 look. Members are listed here, not in the member files.
identity:
  setting: flat grassland stretching to a straight horizon, dry yellow grass in the foreground fading to blue-grey haze
  lighting: soft overcast light from above with no hard shadows
  mood: quiet, empty and faintly gloomy
collection:
  members:
    - { assetId: flatlands-backdrop, required: true }
    - { assetId: flatlands-ground, required: true }
    - { assetId: flatlands-signpost, required: false }
  styleId: cranium
deliverables:
  - id: establishing
    kind: still
    description: Establishing shot of the whole plain, horizon in the middle of the frame.
    output: { width: 1920, height: 1080, alpha: opaque }
```

- Only an `environment` may have `collection` (error otherwise). It may not list itself or list a member twice (errors). `styleId` is a style id. Membership is the ONLY thing that makes a child required, promoted and exported with the environment.
- `required: true` members must have an ACTIVE version before the aggregate can be promoted; `required: false` members join only when you name a version for them.
- `step.list {assetId}` on an environment also returns `collection`: per member `state` (`no-version` | `promoted` | `active`), `activeVersionId`, `latestVersionId`, and a `COLLECTION_INCOMPLETE` blocker naming what is missing.
- Membership changes need a NEW aggregate version; earlier versions keep the membership they pinned.

## Child assets and the direction binding

A child follows the environment's direction by binding it in a deliverable's `referenceRoles` with the cross-asset form `{assetId, branchId, role: direction}`:

```yaml asset
schema: brainforge.asset.v2
id: flatlands-backdrop
name: Flatlands Backdrop
family: background
description: A full-frame view of a flat plain of pale yellow grass with a straight horizon and a low grey sky.
identity:
  setting: dry yellow grass in the foreground, a thin line of dark bare trees on the horizon, grey clouds above
deliverables:
  - id: backdrop
    kind: still
    description: The far layer, horizon at the middle, grass texture fading into blue-grey haze.
    referenceRoles:
      direction: { assetId: flatlands, branchId: br_3f9a2c1d4e5b, role: direction }
    output: { width: 1920, height: 1080, alpha: opaque }
    environment:
      layer: far
      parallax: { x: 0.3, y: 0 }
      relativeScale: 1
      seamlessAxes: [x]
      connections: { west: sky-grass, east: sky-grass }
```

- `branchId` is the NAMED branch of the environment (from `branch.list {assetId:"flatlands"}` after the human locks its concept with `concept.lock`). There is no "latest concept": an unknown branch yields a `REFERENCE_MISSING` blocker on that step (recovery: `branch.list`, ask the user to lock). A binding to the asset itself is an ERROR; a value that is neither `{deliverableId, outputRole}` nor `{assetId, branchId, role: direction}` is an ERROR (`referenceRoles.<name> must be ...`).
- Warnings (file stays valid): the named asset is not in this project; or it does not list this child in `collection.members` (then it will not require, promote or export the child).
- At `generation.plan` time the binding resolves to the environment branch's locked concept output id + sha256 (`plan.directionPins`) and the child is conditioned on THAT image (`krea2-variation` takes one reference; with several bindings only the first is an image, the rest are pinned but unused). The pins enter the step fingerprint and the child's run.
- If the environment later locks a different concept for that branch, or the binding is edited, the child step is flagged `needsReassessment` with a reason naming `<asset>/<branch>`. Nothing regenerates automatically; the child's old versions stay valid as history.
- Same-asset bindings (`{deliverableId, outputRole}`) are the other form; both may coexist in one `referenceRoles` map.

## Environment metadata (structural, never sent to the model)

|Field (`deliverables[].environment`)|Meaning / rule|
|---|---|
|`layer`|Intended layer name (project `layers` list the ids); not level placement|
|`pivot {x,y}`|Pixels of the exported canvas; stills without one pivot at their centre|
|`relativeScale`|>0, exported as metadata|
|`tileSize {width,height}`|Integer >0. REQUIRED on a `tile` deliverable. Godot: becomes a `TileSet` with `TileSetAtlasSource` of that cell size|
|`connections {north,east,south,west}`|Matching-label STRINGS. Metadata only. Independently generated labels prove nothing about pixel seams; review seams visually|
|`seamlessAxes`|`[]`, `["x"]`, `["y"]` or `["x","y"]`|
|`parallax {x,y}`|Hint numbers for the game; no behaviour in Brainforge|

Validator: a deliverable that is seamless on `x` must have equal `west` and `east` labels (and `north`/`south` for `y`) — the tile repeats onto itself — otherwise an ERROR names the pair. A tile example:

```yaml asset
schema: brainforge.asset.v2
id: flatlands-ground
name: Flatlands Ground
family: tile
description: A flat top-down patch of dry yellow grass with small darker tufts, evenly spread.
identity:
  surface: short dry yellow grass blades with scattered tiny darker green tufts
  pattern: an even irregular speckle with no large features
deliverables:
  - id: grass-tile
    kind: tile
    description: A square grass texture covering the frame edge to edge.
    referenceRoles:
      direction: { assetId: flatlands, branchId: br_3f9a2c1d4e5b, role: direction }
    output: { width: 512, height: 512, alpha: opaque }
    environment:
      layer: ground
      tileSize: { width: 64, height: 64 }
      seamlessAxes: [x, y]
      connections: { north: grass, east: grass, south: grass, west: grass }
```

`tile` and `ui` omit the perspective from the prompt (flat orthographic framing); `tile` stills are NEVER packed into a sprite atlas (each stays one addressable PNG).

## Seams, wrap and mirror-repeat

Generated art does not tile by itself. If exact self-wrap is required, plan the processing with a mirror: `processing.plan {candidateId, recipe:{tileRepeat:"mirror-x"|"mirror-y"|"mirror-xy"}}`. The plan emits a `SYMMETRY` warning: one half is reflected onto the other so edges match, the picture becomes mirror-symmetric on that axis, and this is NOT evidence that the original art tiles. Tell the user and ask for a visual review of the seam. Default is `tileRepeat:"none"`. Never claim a seam is fixed from labels or a plan alone. Opaque backgrounds/tiles keep their full frame: the derived processing `fit` is `crop` ONLY when the deliverable states `output.alpha: opaque` (set it on every opaque deliverable, as the templates do).

## Aggregate promotion

1. Promote the children first (each: all required deliverables approved, `promotion.plan` → `promotion.start`, then `version.activate`), against the environment's locked direction.
2. `promotion.plan {assetId:"flatlands", branchId?, members?}` for the environment. `members` is `{[memberAssetId]: versionId}` and pins a member to a specific promoted version. Defaults: REQUIRED members pin their ACTIVE version; OPTIONAL members join only when named in `members`. The plan's `members` rows show every pin (`source` `active`|`explicit`, `versionNumber`, `directionMatches`, `obsolete`).
3. Blockers (whole-aggregate; fix, re-plan, show the user):

|Code|Meaning / fix|
|---|---|
|`COLLECTION_INCOMPLETE`|A required member has no active or selected version: promote/activate it or pin one in `members`|
|`MEMBER_UNKNOWN`|`members` names an asset the environment does not list|
|`VERSION_NOT_FOUND`|A pinned version id is not a promoted version of that member|
|`VERSION_CORRUPT`|A pinned member version fails its manifest hash check|
|`DIRECTION_MISMATCH`|The member version was generated against another output than THIS environment branch's locked concept: promote a member version made against this direction, or promote the environment branch it used|

   A member that no longer matches its own current requirements is shown `obsolete` and does NOT block; it is pinned as it was.
4. `promotion.start {planId, planHash}` as for any asset. The aggregate manifest pins every selected member version (`dependencyVersions`, `members` with each child's declared structural metadata, `collectionMembers`). Children promote and activate independently; ACTIVATING the aggregate never changes a child's active pointer.

## Export expansion and EXPORT_CONFLICT

- Exporting an environment version includes the member versions it pinned, at exactly those versions (`selection[].source:"member"`, note "Pinned by ..."). Members are exported as ordinary assets under `assets/<member-id>/`; the environment's `asset.json` carries `metadata.collection` and `metadata.members` (assetId, required, versionId, versionNumber, family, environment metadata).
- An implicit (active-default) selection of a member yields to the aggregate's pin. A member you select DIRECTLY at a different version than a selected aggregate pins → `EXPORT_CONFLICT` naming both versions: select the pinned version or a matching aggregate.
- Missing active versions, hash failures and unowned-file collisions are blockers as in [export](export.md). Godot: tile deliverables get `tilesets/<id>.tres`; backgrounds/modules carry metadata only, no `.tscn` wrappers; connection labels stay metadata (no terrain, no collision).
- Real tile/background generation uses the opaque workflows, which are UNVERIFIED on real ComfyUI; the fake ComfyUI proves protocol only.

Common mistakes: writing `branchId` before the environment concept is locked; forgetting the child in `collection.members`; `seamlessAxes: [x]` with different `west`/`east` labels; expecting labels to guarantee a seam; pinning the whole environment before required children are ACTIVE; omitting `output.alpha: opaque` on opaque stills.
