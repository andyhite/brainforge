# First-character run, fresh fixture (M13)

Repeat of `docs/SPEC.md` "Demonstrate the complete workflow" (steps 1-11) on a game-docs-only copy of the real game
(`docs/` only, no `brainforge/`), real ComfyUI (RTX PRO 4500, metered), throw-away server on port 3651. Human = request with
`Origin: http://127.0.0.1:3651`; agent = `bun apps/cli/src/main.ts` without Origin, driven only from `skills/brainforge/`
and the CLI's schema operations. One run, 2026-10-01, about 22 minutes wall clock.

> Historical: this run happened while budgets existed (human budget grants, per-step counters, `budgetId` on `generation.start`). Budgets have since been removed; generation now starts from `generation.plan` with `{planId, planHash}` and is limited only by batch and concurrency caps. References to budgets below are run facts, not current behavior.

## Result per step

|#|What ran|Result|Evidence|
|---|---|---|---|
|1|`project.init` (human, preview then `confirm`), `project.inspect`|Pass|Created `brainforge/{project.yaml,styles,references,workflows,assets,.state,.gdignore}` only; docs untouched.|
|2|Agent: `spec.schema` x3, `family.template`, `spec.validate`, `spec.write` (`expectedHash` null/hash) for `project.yaml`, `styles/cranium.yaml`, `assets/cortex/asset.yaml`|Pass, 0 problems|256x256 canvas, `subjectHeightPx` 216, `displayScale` 0.5556, export `generic` into `assets/brainforge`; five deliverables (construction-sheet, idle-rest, walk-contact, idle, walk). Plan prompt read before generating: no process text or negations.|
|3|Budget grant (human), `generation.plan/start` x4 batch; annotation (rect, human) on candidate 2; `revision.create`; agent `revision.inspect` (annotated PNG viewed), YAML edit of `identity.brain`, identity-edit variation x2 with `iterationInstructions`, `revision.respond`; human `revision.resolve`|Pass for the loop; creative result weak|4 concepts consistent (same coral brain, tee, jeans, black high-tops). Both variations kept identity but did NOT visibly enlarge the brain: the identity edit at `ref_boost` 4 ignores the size instruction. The resolve reason says so.|
|4|Agent `concept.lock` refused (`HUMAN_AUTHORIZATION_REQUIRED`); human lock of candidate 2 (matted), branch `A`|Pass|Steps after lock: sheet and both poses `ready`, idle/walk `blocked` until their pose is approved.|
|5|Sheet (1, `referenceStrength` 2, per-region `view` phrases): agent `review.material` + `review.decide`; poses idle-rest, walk-contact (1 each)|Pass with a limitation|1536x768 sheet: rear view is a true rear; **front and profile are both three-quarter** (front not frontal). Poses read correctly; walk-contact has a real stride. Approved by the agent with that limitation written in the reason.|
|6|Wan clips, 33 frames at 16 fps, 1 each; `processing.plan/start` at project default 12 fps; processed review in Chrome (play, step, checkerboard/light, pivot and baseline, atlas)|Pass|Processed: 24 frames, 2000 ms, source frame 30 for frame 23, foreground bounds 217 px high (target 216), no warnings. Viewer showed "Frame 16 of 24, source frame 21, 83.3 ms", clean alpha on checker and light, baseline line under the shoes, atlas playback. Idle eyes half-close and recover (reads as a guarded slouch, loop closes). A thin light fringe is visible around the figure in contact sheets.|
|7|Note on source frames 14-20 (rect), `revision.create`, agent saw annotated frames 14 and 20, changed ONLY `deliverables.walk.animation.motion`, `asset.impact` listed walk only, regenerated walk (1), `revision.respond`, approved the new processed walk, human `revision.resolve`|Pass|Original: legs closed and mouth popped to an O in frames 16-20. New walk: mouth stays a closed line; stride still narrows briefly near source frames 16-18 (stated in the approval reason). Idle candidate and approval untouched.|
|8|`promotion.plan`; agent `promotion.start` refused; human `promotion.start` (`promo-req-1`, replayed once: same version); human `version.activate`|Pass|`ver-1032e74974` v1 promoted first, `active: null` until the explicit activation (revision 0 to 1).|
|9|`export.plan/start` (generic)|Pass|`assets/brainforge/current -> .releases/exp-...`; `animation.json` schema `brainforge.animation.v2`, 24 frames, playback 12, sums to 2000 ms; PNG frames 256x256 RGBA, atlas page, `asset.json`, stills (sheet 1536x768, poses 1024x1024).|
|10|Human `concept.lock` of candidate 3 with `inputMode: saved` (branch B) after the YAML edits; `promotion.plan` on B; `branch.plan` saved vs current; relock `current` (B rebased)|Pass|B promotion plan: `STEP_BLOCKED requirements-basis-mismatch` with the field diffs `identity.brain` and `deliverables.walk.animation.motion`, plus missing deliverables. A stayed active the whole time. A concept cannot be rebased via `branch.create`; renewed lock is the path (as designed). B's deliverables were not generated (budget).|
|11|Agent set walk `playbackFps: 16`: `asset.impact` marked walk only (processed); reprocess (no generation), approve, `promotion.start` v2, human activate, export again; then a human file in `current`, an externally edited owned file, `recovery-smoke export-failure`|Pass|v2 manifest: idle, idle-rest, walk-contact, sheet identical hashes to v1; only walk differs (24 to 32 frames). v1 stayed active until the human activated v2. Re-export: human file carried and preserved, warning names the retired release still holding it; edited owned file blocked as `EXPORT_CONFLICT` and preserved; harness `export-failure`: PASS (prior complete export still current after failure and after SIGKILL restart; retry publishes).|

Not done literally: step 11 was exercised with a fps change on the same approved clip, not a second generated walk (the three-clip budget was spent on idle, walk, and the revision walk).

## GPU use

12 submissions, no retries: 4 concepts + 2 variations, 1 sheet, 2 poses, 3 Wan clips (idle, walk, revised walk). Stills 10-25 s each, clips about 65-80 s each; two clips measured 04:39:07 to 04:41:51 and the revised walk 04:44:57 to 04:46:00. About 8 minutes of ComfyUI wall time in total. Ceiling not exceeded.

## Defects found and fixed

1. `review.list` "awaiting" (and Overview/Review queue counts) kept every approved still and clip because its untouched decode had no decision. Now only a stale decision, or none, means undecided (`packages/core/src/handlers/decisions.ts`; regression in `revision-loop.test.ts`).
2. `RevisionRequest.stepId` was hard-coded to `"concept"`, so a walk revision reported the concept step. Now the candidate's own step (`review/records.ts`; asserted in `revision-loop.test.ts`).
3. The pressed Play button in the viewer was invisible (accent text on accent background: `.viewer-tools button[aria-pressed]` outranked `.primary`). Fixed in `apps/web/src/styles.css`; checked in Chrome after rebuilding `apps/web/dist` (text now dark on blue).

## Found, not fixed

- Concept step shows `REVISION_OPEN` among its blockers while a walk revision is open (concept step uses asset-wide notes) although it reports `complete`.
- Review queue and Overview keep counting superseded candidates (the stale 12 fps walk approval, the first walk) as "awaiting a decision" after the asset is complete and exported.
- The viewer's right panel says "Notes on this matted output" while a processed output is selected.
- At 1440x757 the animation stage is below the fold: the output list, speed and background buttons use the first screen.
- The style palette is joined into the prompt with ", ", so entries that contain commas read as extra phrases.
- `packages/core/tests/family-flow.test.ts` "creature" fails with `OUTPUT_MISSING` for the scale reference: it is in files other agents were editing (`processing/anchor.ts`, `plan.ts`); not touched here.

## Skill / docs gaps hit

1. SKILL.md names tools with underscores (`spec_schema`); the CLI wants dots (`spec.schema`) and the skill never says the CLI exists. The CLI cannot set an agent name; every call is `agent:cli`.
2. The `spec_schema` asset example has no `regions[].view`, `referenceStrength` or `referenceRoles`, and no walk-contact example; they appear only in `family.template` and `references/asset-yaml.md`.
3. `promotion.start` and `export.start` need `requestId` inside the input as well as the envelope; the skill lists it but does not say so.
4. (Historical) Budgets were per step id and a human had to grant six for the character. Budgets no longer exist; this finding is resolved by removal.
5. Nothing tells the agent that front and profile may come back identical, nor that identity-edit variation ignores "make X bigger" at the default `referenceStrength`; both needed the generated images to notice.
6. A Chrome DevTools endpoint shared by several agents hands back the same page to every `browser.open`; create a private page (`PUT /json/new`) and attach with `target`. (My first open navigated another agent's tab.)

## Unverified

Godot export (generic preset only here), 12 vs 16 fps compared only by processing counts and one viewer pass, 200% zoom and narrow layouts, keyboard-only operation, the web annotation drawing tools (annotations were created through the API; the viewer was used only to review).
