# UI, icons and visual effects (M12)

Bare operation names. Read [families](families.md) for kinds/required fields and start from `family.template {family:"ui"|"icon"|"effect", ...}`. These families are produced as ART: text, localisation and dynamic state stay outside generated images, and nothing here builds working widgets.

## UI states and nine-slice

- Each state is a `ui-state` deliverable (or `still`/`variant`). `ui.state` (required on `ui-state`, free string such as `normal`, `pressed`) names the state; it is NEVER sent to the model, so write what the state looks like in that deliverable's `description`. Later states `dependsOn` the base state, which orders work and review (the state cannot start until the base is approved). It does NOT feed the base's pixels to the model: every deliverable is conditioned on the branch's locked concept alone (one reference image), so describe the changed state completely (shape stays, colours and details named in that description). For a derived `ui-state`/`variant` (one with `dependsOn`) the identity-lock sentence drops "colours", so a disabled grey icon can recolour; put the state's colours in ITS description, never in `identity.*` or the style palette, which are sent with every deliverable of every asset using them (a style palette naming red/yellow tinted a blue button red).
- `ui.nineSlice {left,top,right,bottom}` are integer margins in OUTPUT pixels of the exported image. They must leave a positive stretchable centre: validator ERROR when `left+right >= output.width` or `top+bottom >= output.height` (checked when `output.width/height` are authored); `processing.plan` also blocks with `NINESLICE_INVALID` when they do not fit the final output. The recipe's `nineSlice` defaults from `ui.nineSlice` and is carried to the export. Margins pinned in the reviewed output's recipe win over later YAML edits.
- Opaque panels: `output.alpha: opaque` (the `ui` default). Rounded or irregular outlines leave light-grey corners in an opaque panel; a cut-out element sets `output.alpha: transparent` (matted).
- Set one canvas per element with `output {width,height}` (both or neither, max 8192). Different elements may have different canvases.
- Canvas and conditioning facts (small canvases generated at 1024 and fitted; one locked-concept reference per deliverable; style palette and `identity.*` in every prompt; palette joining) are in [families](families.md) "What the model receives".

```yaml asset
schema: brainforge.asset.v2
id: hud-panel
name: HUD Panel
family: ui
description: A flat rounded rectangle panel with a thick dark border and a pale cream fill.
identity:
  shape: a rounded rectangle with evenly rounded corners and a flat edge on every side
  material: a pale cream flat fill with a thick dark brown outline and a thin lighter inner line
export:
  sprites: both
deliverables:
  - id: panel-normal
    kind: ui-state
    description: The panel at rest, plain cream fill.
    output: { width: 256, height: 256, alpha: opaque }
    ui: { state: normal, nineSlice: { left: 24, top: 24, right: 24, bottom: 24 } }
  - id: panel-pressed
    kind: ui-state
    dependsOn: [panel-normal]
    description: The same panel with a slightly darker tan fill and the border drawn one step thicker.
    output: { width: 256, height: 256, alpha: opaque }
    ui: { state: pressed, nineSlice: { left: 24, top: 24, right: 24, bottom: 24 } }
  - id: panel-disabled
    kind: ui-state
    required: false
    dependsOn: [panel-normal]
    description: The same panel in flat mid-grey tones.
    output: { width: 256, height: 256, alpha: opaque }
    ui: { state: disabled, nineSlice: { left: 24, top: 24, right: 24, bottom: 24 } }
```

## Sprite packaging: `export.sprites`

Top-level block of `asset.yaml`: `export: { sprites: individual | atlas | both }` (default `individual`). It packages the asset's STILL deliverables at export time:

|Value|Result under `<destination>/current/assets/<asset-id>/`|
|---|---|
|`individual`|`stills/<deliverable-id>.png` per still|
|`atlas`|`sprites/atlas-<n>.png` + `sprites/sprites.json` (`brainforge.sprites.v2`: pages and per-sprite `{id,state,page,x,y,width,height,nineSlice?}`); no individual PNGs|
|`both`|atlas AND individual PNGs|

Pages are capped at 4096x4096 with 2 px gutters, 1 px extrusion and no rotation; more stills create more pages; layout depends only on canvas sizes and ids. `tile` deliverables are never packed. Animations are packaged by their own processing recipe (`packaging: frames|atlas|both`), NOT by this field. `asset.json` points to `sprites/sprites.json` and each packed deliverable records its `sprite` rectangle, `state` and `nineSlice`. godot4 additionally writes `textures/<id>.tres` (`AtlasTexture`, atlas region when packed) and `styleboxes/<id>.tres` (`StyleBoxTexture` with exact margins) for nine-slice stills.

## Icons

`icon`: single glyph, transparent by default, fixed canvas (typically 16-256 px). States are `ui-state` variants with `ui.state`. One subject, no text/numbers, high contrast. Set `output {width,height}` so every state shares one size. A canvas whose longer side is under 256 px is still GENERATED at 1024x1024 (the model's native size) and fitted down by processing; set `defaults.processing.resizeFilter: nearest` for pixel art. BiRefNet cuts cream/white details out of the light-grey background imperfectly, so expect a few semi-transparent edge pixels; check the matte on the dark backdrop. See the `heart-icon` example in [families](families.md).

## Effects: transparent vs opaque, loop vs once

- `effect` default is transparent: the workflow removes the light-grey background (BiRefNet matte). `output.alpha: opaque` keeps the full frame (a screen flash, a smoke wash filling the canvas): background removal is NOT applied, edge contact is fine and no clipping check runs. For glow, smoke or fills that touch the canvas edge choose opaque or accept the matte's edge cut; never assume "background removal always required" as for characters.
- Effect and UI animations MUST state `animation.loop` explicitly (`true` loops, `false` plays once); an omitted `loop` is a warning and a blocker for that deliverable. Processing derives `closingFrame` from it: `loop:true` excludes the repeated closing frame, `loop:false` keeps every frame. Playback and export carry the flag (`animation.json` `loop`, Godot `SpriteFrames` loop).
- Start/end guides: any approved `still`/`variant`/`view`/`pose` of the same asset (`startReference`/`endReference`, both in `dependsOn`). Use the same still for both for a loop; a one-shot may start from a key frame.
- Source frames, processing, review, annotations and cadence comparison follow [motion-processing](motion-processing.md). Effects without a calibrated standing height contain the whole frame (`fit: contain`); opaque deliverables with `output.alpha: opaque` fill it (`fit: crop`).

```yaml asset
schema: brainforge.asset.v2
id: screen-flash
name: Screen Flash
family: effect
description: A full-frame wash of bright white light with a pale yellow glow spreading outward from the centre.
deliverables:
  - id: flash-key
    kind: still
    description: The flash at its brightest, white in the centre fading to pale yellow at the edges.
    output: { width: 1280, height: 720, alpha: opaque }
  - id: flash
    kind: animation
    dependsOn: [flash-key]
    description: The flash fading out.
    output: { width: 1280, height: 720, alpha: opaque }
    animation:
      motion: the white light fills the frame at once, then fades smoothly to nothing while the yellow glow shrinks toward the centre
      loop: false
      startReference: flash-key
      endReference: flash-key
```

## Processing fields that matter here

|Recipe field|Values / effect|
|---|---|
|`fit`|`none` character path (scale anchor + feet placement; source must already be output-sized without an anchor); `crop` uniform scale to COVER, centre-cut the overflow; `contain` uniform scale to fit INSIDE, centred on transparency (or `matteColor`); `stretch` non-uniform resize. `crop`/`contain`/`stretch` never look for a subject: no framing, margin or clipping checks. Derived default: `crop` when the deliverable says `output.alpha: opaque`, `contain` for stills and for animations with no calibrated `subjectHeightPx`, else `none`|
|`output {width,height}`|Exact export canvas; defaults from the deliverable's `output`, else `sizing` (stills fall back to their own size)|
|`nineSlice`|Output-pixel margins; default from `ui.nineSlice`; must leave a positive centre|
|`tileRepeat`|`none` (default) or mirror axes with a SYMMETRY warning; see [environments](environments.md)|
|`alpha` / `matteColor`|`preserve` keeps transparency; `matte` flattens onto the explicit color|
|`packaging`, `loop`|Per [motion-processing](motion-processing.md)|

Every change produces a NEW unapproved processed output; stills are reviewed and approved in processed form like animations.

## UNVERIFIED

The opaque workflows (`krea2-still-opaque`, `krea2-variation-opaque`, `wan22-motion-opaque`) and the family framing sentences have only run against the fake ComfyUI (graph wiring and protocol). No real GPU run exists for them: do not state that UI panels, VFX or backgrounds "look right"; the user judges the art in the viewer. Nine-slice scaling previews and multi-state comparison live in the web UI; there is no tool that renders them.

Common mistakes: text or labels in a UI description; `nineSlice` margins that cover the whole canvas; a `ui-state` without `ui.state`; forgetting `animation.loop` on an effect; expecting `export.sprites` to pack animations or tiles; opaque deliverable without `output.alpha: opaque`.
