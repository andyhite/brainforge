# Export (generic and Godot 4)

Export publishes IMMUTABLE promoted versions to the game-relative destination in `project.yaml`. It never exports raw or unapproved candidates and never changes promotion or activation.

## Loop

1. Each asset needs an ACTIVE version: `promotion_start`, then `version_activate` (see [production-versions](production-versions.md)). A missing active version is a blocker, not skipped.
2. `export_plan {assetIds?, versions?, confirmEmpty?}`. Default = every asset with an active version. `versions: {assetId: versionId}` pins another promoted version; the plan shows it. Read `blockers`, `selection` (with `notes`), `leaving`, `leavingResourceKinds`, `warnings`, `fileCount`. `export_plan` is mutating (stores the plan) and needs a `requestId`.
3. Show the plan to the user. `export_start {planId, planHash, requestId}`: a fresh `requestId` per export; the SAME one when retrying a lost response (`created:false` = already exists).
4. `export_list` (history; which export is `current`), `export_inspect {exportId}` (manifest + externally modified owned files).

## Layout

```text
<destination>/current -> .releases/<export-id>        managed relative symlink; the only success boundary
<destination>/current/manifest.json                   brainforge.export.v2, ownedFiles with sha256
<destination>/current/assets/<asset-id>/asset.json    brainforge.export-asset.v2
<destination>/current/assets/<asset-id>/stills/<deliverable-id>.png
<destination>/current/assets/<asset-id>/animations/<deliverable-id>/frames/0000.png
<destination>/current/assets/<asset-id>/animations/<deliverable-id>/atlas-0.png
<destination>/current/assets/<asset-id>/animations/<deliverable-id>/animation.json   brainforge.animation.v2
<destination>/current/assets/<asset-id>/godot/...     godot4 preset only
<destination>/.releases/<export-id>/...               backing snapshot; not a public path
```

Public paths are always `<destination>/current/assets/...`. Game references NEVER include an export id or `.releases`. Frames, atlas or both follow the reviewed processing recipe `packaging`; an absent mode is not a missing deliverable. `animation.json` has per-frame `durationMs` (may be fractional), `sourceFrame`, `file` or atlas rect, pivot (origin top-left), `sourceFps`, `playbackFps`, `loop`.

## Presets

- `generic`: the files above only.
- `godot4` (Godot 4.3+ text resources) = generic plus, under `assets/<id>/godot/`:
  - `animations.tres`: one `SpriteFrames` per asset, named animations, loop flags, `speed = playbackFps`, per-frame relative duration `durationMs*playbackFps/1000`; frames are `AtlasTexture` sub-resources pointing at exact atlas rectangles (no rotation) or full PNGs.
  - `textures/<deliverable>.tres`: `AtlasTexture` for still/view/state/icon PNGs.
  - `styleboxes/<deliverable>.tres`: `StyleBoxTexture` with exact nine-slice margins (UI deliverables with `ui.nineSlice`).
  - `tilesets/<deliverable>.tres`: `TileSet` + `TileSetAtlasSource` using the declared tile size. Connection labels stay metadata (no terrain, no collision).
  - Backgrounds/modules: metadata only, no wrapper scenes. No `.tscn` is generated.
- `res://` paths = `res://<destination relative to godotProjectRoot>/current/assets/...`. The engine root is `export.godotProjectRoot` (default `.`), NOT necessarily the Brainforge project root. It must contain `project.godot` and contain the destination, else a field-specific blocker (generic exports are unaffected).

## Conflict rules

- Unowned files (human-owned, Godot `.import`/UID sidecars, anything not in the previous manifest) are never overwritten or deleted; they are carried unchanged into the new release. A new managed path colliding with one → `EXPORT_CONFLICT`; move or rename the human file, re-plan.
- Owned files modified on disk since export → `EXPORT_CONFLICT` (see `export_inspect` conflicts). Unowned `current` (directory or foreign symlink) or a pointer to an unknown release → `EXPORT_CONFLICT`; never adopted or deleted.
- Explicit subset or preset switch: the next snapshot contains exactly the selection; `leaving` / `leavingResourceKinds` list what disappears. An empty selection needs `confirmEmpty:true`.
- After success only unchanged files listed in the PREVIOUS manifest are removed; modified owned files stay with a warning.
- Environment aggregates export the member versions they pinned; a member selected directly at another version → `EXPORT_CONFLICT` ([environments](environments.md)). Still packaging per asset: `asset.yaml` `export.sprites` (`individual|atlas|both`) writes `sprites/atlas-<n>.png` + `sprites/sprites.json` ([ui-vfx](ui-vfx.md)).

## Recovery

- Failure before the pointer switch: previous `current` still resolves to the prior complete export; retry.
- Crash after the switch, lost response: same `requestId` returns the committed export (recovered at open); never a second export.
- Export failure does not undo promotion or activation.
- Moving the project: relative `current` link survives only if symlinks are preserved (`project_snapshot` does).
- Consumers (Godot) reload after export; no hot-read guarantee.

## `export:` block in `project.yaml`

|Field|Type / default|
|---|---|
|`preset`|`generic` \| `godot4` (required)|
|`destination`|relative path inside the game, outside `brainforge/` (required)|
|`godotProjectRoot`|relative path of the folder holding `project.godot`; default `.`|

```yaml project
schema: brainforge.project.v2
id: tiny-game
name: Tiny Game
export:
  preset: godot4
  destination: assets/brainforge
  godotProjectRoot: .
```

Preset or destination changes go through `spec_write`; the next `export_plan` shows what leaves current.
