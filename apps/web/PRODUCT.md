# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo indie 2D game developer, working in their own game repo on macOS in a desktop browser. They use the web UI to run the whole pipeline, from kicking off generations through concept, review, promotion and export, and to review and approve what AI agents produce. Agents (via MCP/CLI) act alongside them on the same pipeline; the browser session is the "human".

## Product Purpose

Brainforge is a local, single-user asset-production workbench for 2D games. Asset specs are written in YAML; generation runs through the user's own ComfyUI workflows (Krea 2 Turbo stills, Wan 2.2 motion). The web UI starts generations and handles the pipeline from concept to export: explore, lock concept, produce, process, review, promote, activate, export. Success: a coherent, versioned set of PNGs, atlases and optional Godot 4 resources lands in the game, with a clear answer to "what is left?" at every stage.

## Positioning

A gated, versioned pipeline: nothing advances unreviewed, nothing is approved just because it was generated, and lock, promotion and activation are separate human decisions by default. Brainforge never generates art itself; it plans, tracks, reviews, processes, versions and exports ComfyUI output.

## Operating Context

- Local server on loopback (127.0.0.1:3210); Vite on 5173 in dev. Loopback does not imply local compute: ComfyUI may be a remote GPU, so workflow compute location and cost are shown and generation runs only under a human-granted budget.
- Everything lives in the game directory under `brainforge/`; the project is portable.
- Review judges transparency, so results are viewed on light, dark and checkerboard backgrounds, with frame stepping and actual atlas playback.
- Annotations: whole-image, pin and rectangle notes; frame and frame-range notes on animation.

## Capabilities and Constraints

- Asset families: character, creature, item, equipment, prop, environment, background, tile, ui, icon, effect.
- Terms: project, specification, job, candidate, annotation, branch, approval, production version, active version. Lock, approve, promote and activate are distinct actions.
- Jobs outlive the tab; uncertain submissions are never blindly resubmitted.
- Out of scope: audio, 3D, level editing, engine sync, multi-user, hosted deployment, in-app AI assistant, general workflow editor.
- Desktop browser on macOS is the target; mobile layouts are not specified.

## Evidence on Hand

- `README.md`, `docs/SPEC.md`, `docs/COVERAGE.md`, `docs/FIRST-CHARACTER-RUN.md`.
- Product is feature-complete against the spec with documented gaps; no external customers, testimonials or benchmarks exist. Do not fabricate any.

## Product Principles

1. Gates over speed: every stage advances only by an explicit, recorded decision.
2. Always show the next useful action and what is left.
3. Humans decide the irreversible; agents and humans share one pipeline and one vocabulary.
4. Judge the real output: transparency, motion and atlas playback shown as they will ship.
5. Cost and compute location are explicit before any generation.

## Accessibility & Inclusion

No product-specific standard established (inferred default: none beyond sound web practice). Required: light, dark and checkerboard backgrounds for judging transparency.
