# Motion: animation deliverables, processing, cleanup (M4)

## Authoring an animation deliverable

```yaml asset
schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A sixteen-year-old boy with a huge coral-pink brain for a head, standing upright with a slouch.
deliverables:
  - id: walk-contact
    kind: pose
    description: Mid-stride walking pose, right foot forward with the heel down, left arm swung forward.
  - id: walk
    kind: animation
    dependsOn: [walk-contact]
    animation:
      motion: a relaxed slouching walk at an even pace, arms swinging gently, the brain bobbing slightly with each step, one foot always touching the ground
      loop: true
      sourceFps: 16
      sourceFrameCount: 33
      startReference: walk-contact
      endReference: walk-contact
      playbackFps: 12
```

- `startReference` / `endReference` are POSE deliverable ids (in `dependsOn`); both default to the animation's first approved `pose` dependency. Each guide is a cyclic pose: use a stride pose for a walk, never a standing pose.
- The animation step is `ready` only when its guide poses are approved. `generation.plan` normalizes both guides into the 768x768 Wan canvas with the branch's scale anchor and stores that transform on the plan; read it.
- `sourceFrameCount` MUST be `4n+1` (5..81); 33 at `sourceFps` 16 is two seconds plus the closing frame. `playbackFps` is the exported rate; it falls back to the effective `defaults.animation.playbackFps`.
- `motion` is prompt-bearing: describe the movement as one concrete positive sentence (what the body parts do, rhythm, what stays planted). No "do not", "without", "loop", "seamless", doc references, status or process words. Put reasoning in `notes`.

## Source vs processed

|Output|`stage`|Made by|Use|
|---|---|---|---|
|Source frames (untouched + matted sequences at the workflow fps)|`source`|`generation.start`|Raw material; annotate and inspect. NEVER the deliverable|
|Processed clip (cropped, scaled, pivoted, resampled)|`processed`|`processing.start`, or a processed-stage cleanup import|The deliverable; review, select, approve this|

Processing never edits a source. Every run creates a NEW processed output (`parentOutputId` = its source) that starts UNAPPROVED and never inherits approval. An animation step completes only when the SELECTED output is a processed output with an applicable approval.

## Loop

1. `step.list`: animation step `ready`. `generation.plan {assetId, branchId, stepId, mode:"fresh", count:1}`; read `plan.prompt`, blockers, budget; `generation.start` under a human budget (`budget.list`); poll `job.inspect`.
2. `candidate.inspect {candidateId}`: source outputs (untouched + matted, `stage:"source"`). Review the matted one; you do not approve it.
3. `processing.plan {candidateId, outputId?, recipe?}`. Read the plan before running it:
   - `recipe` with `sources` (every defaulted field and where it came from), `sourceFrameCount`, `frames` (output index -> `sourceFrame`, `durationMs`), `totalDurationMs`, `canvas`, `pivotPx`, `foregroundBounds`, `warnings`, `blockers`.
4. `processing.start {planId, planHash}` -> new processed output. It starts unapproved.
5. `output.inspect {outputId}`: every frame with zero-based SOURCE index, duration, atlas rectangle; recipe; warnings. `review.material` / `candidate.inspect` attach the contact sheet and first/last frame as images.
6. `candidate.select {branchId, deliverableId, candidateId, outputId: <processed id>}` then `review.material` -> `review.decide` for that processed output id.
7. Change anything (pivot, crop, fps, filter, offsets): `processing.plan` with the new `recipe` fields -> `processing.start`. That is a NEW output beside the old one; the old one is unchanged.

## Recipe fields (`recipe` is partial; omitted fields are derived)

|Field|Effect|
|---|---|
|`trim {start, endExclusive}`|Source frames played (zero-based). Default: all|
|`closingFrame`|`exclude-last` drops the final source frame (default for `loop:true`: the closing guide frame duplicates frame 0); `keep` otherwise|
|`crop {x,y,width,height}`|Source-pixel window, one per clip|
|`output {width,height}`|Exported canvas (e.g. 256x256)|
|`scaleAnchor`|One uniform scale from the branch's approved reference (see below); persisted with the hash|
|`resizeFilter`|`lanczos3` (smooth) or `nearest` (pixel art)|
|`alpha`, `matteColor`|`preserve` keeps transparency as is; `snap-near-opaque` also sets alpha >= 254 to 255 in the PROCESSED frames only (in-graph BiRefNet leaves foreground at 254; soft edges below 254 and all originals stay untouched). It is the default for matted families (character, creature, item, equipment, prop, icon) whose deliverable is transparent, and `preserve` for opaque or effect/UI art; `matte` flattens onto `matteColor` (explicit only)|
|Scale anchor|The standing height is measured on the branch's selected neutral `pose` output (first `pose` deliverable, e.g. `idle-rest`), the same kind of image Wan is conditioned on, else the construction sheet's front crop, else the locked concept. Every guide of the branch is scaled by that one factor; the plan notes list the anchor image, its height and each guide's height. A guide that is simply larger is scaled consistently, never blocked unless it truly clips the Wan canvas. Processed standing height therefore equals `sizing.subjectHeightPx`.|
|`pivot {x,y}`|Normalized 0..1, origin top-left; feet usually `x:0.5`|
|`frameOffsets [{index,dx,dy}]`|Explicit per-frame pixel corrections; never automatic|
|`playbackFps`|Exported rate|
|`packaging`, `atlas {maxSize,padding,extrude}`|`frames`, `atlas` or `both`; pages <= 4096, gutter 2, extrude 1, untrimmed canvases, no rotation|
|`loop`|Loop flag for playback and the loop-boundary warning|
|`scaleReferenceOutputId`|Re-anchor on a different approved reference output|

## Resampling rule

Duration is preserved: `D = playedSourceFrames / sourceFps`. Output frame count `ceil(D * playbackFps)`; output frame `i` shows source frame `min(N-1, floor(i * sourceFps / playbackFps))`; the last frame's duration is shortened if needed. Example: 33 source frames at 16 fps, `exclude-last` -> 32 played = 2000 ms -> 24 frames at 12 fps or 32 frames at 16 fps; output frame 23 at 12 fps is source frame 30. Cadence decision: plan and run both `playbackFps: 12` and `16` on the same source, compare the two processed outputs; the clip length stays 2 s in both.

## Scale anchor

One uniform scale per branch, measured once on the branch's approved reference (default: the selected construction-sheet front crop, else the locked concept) as standing height vs `familyDefaults.<family>.sizing.subjectHeightPx` (character 216 on a 256x256 canvas). The guides are normalized with the same scale before motion, and processing reuses it. NEVER fit per clip or per frame, and NEVER change `output` size hoping to rescale: the anchor, not padding, sets size.

## Warnings (honest, never auto-fixed)

|Code|Meaning|Do|
|---|---|---|
|`CLIPPED`|Motion leaves the canvas at the anchored scale (plan BLOCKER)|Ask the user to enlarge `output`/crop or explicitly revise scale; do not shrink silently|
|`EMPTY_FRAME`|A frame has no foreground|Inspect that source frame; regenerate or clean up|
|`PIVOT_OUTSIDE`|Pivot outside the canvas|Fix `pivot`/`crop`|
|`SCALE_CHANGED`|Scale differs from the branch anchor|Confirm it is intended; otherwise drop the override|
|`LOOP_DISCONTINUITY`|First and last played frame differ visibly|Try `closingFrame: "exclude-last"`, regenerate, or clean up|
|`ATLAS_PAGES`|Frames need more than one atlas page|Informational; or reduce frames/canvas|

## Cleanup round trip (external edit)

1. `candidate.export-cleanup {candidateId, outputId, stage}` writes numbered PNGs + `sidecar.json` into `brainforge/assets/<asset>/work/cleanup/<cleanupId>/`; originals untouched. Pick `stage:"source"` to repaint raw frames, `"processed"` to touch up final frames.
2. The user edits PNGs in an external tool (same filename, same size).
3. `candidate.import-cleanup {parentCandidateId, parentOutputId, stage, frames:[{index,file}], notes, effortMinutes}`; `index` is the zero-based frame index of the exported stage; unlisted frames are copied from the parent by hash. Creates a NEW unapproved child candidate.
   - `stage:"source"`: keeps source size and count; then `processing.plan`/`processing.start` on the new candidate (same scale anchor).
   - `stage:"processed"`: keeps canvas, count, durations and source map; creates a processed output directly and is NEVER cropped, scaled or resampled again.
   - Wrong size, count, duplicate/out-of-range index, or sidecar/hash mismatch -> `INVALID_INPUT` naming the frame; nothing written.

## Annotations

`annotation.create {candidateId, outputId, frameRange:{start,end}, ...}`: indices are zero-based SOURCE frame indices (inclusive). A processed clip's frames carry `sourceFrame`; use that, never the processed output index, so feedback survives resampling. The UI shows one-based labels.

## Common mistakes

- Approving raw source frames; selecting a source output for an animation step.
- Expecting a changed recipe to update an old output; it creates a new unapproved one.
- Per-clip or per-frame scaling; resizing the canvas to "fit".
- Treating 12 and 16 fps as different durations; the duration is preserved, only frame count changes.
- Annotating with processed frame indices instead of source indices.
- A standing pose as walk guide; guide poses not approved first.
- Negations or process words in `motion` ("no sliding", "seamless loop").
- Re-processing a processed-stage cleanup import (it is final; edit again via a new cleanup instead).
