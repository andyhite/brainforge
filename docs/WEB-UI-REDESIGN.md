# Web UI redesign — Animation Checking Room

**Status:** Implemented and verified against an isolated fixture. The finish-review verdict resolved all seven identified material fixes.

**Target:** All of `apps/web`. **Mode:** Operate. **Selected direction:** Animation Checking Room.

## 1. Job, audience, and outcome

A solo indie 2D game developer uses Brainforge on a macOS desktop alongside their game editor. Humans and agents share one production pipeline; the browser is where the human inspects real outputs and makes gated decisions.

The redesign gives equal weight to three outcomes:

1. Know what remains, why it is blocked, and the next useful action.
2. Judge the actual artwork, transparency, and motion without scrolling past configuration.
3. Move from concept through export without repeatedly rebuilding asset, branch, and output context.

**Organizing idea:** Keep the selected artwork central while navigation, production tools, and decisions change around it. Project-wide readiness remains one deliberate view away, not buried inside the editor.

Product truth stays intact: specifications describe assets; ComfyUI generates; Brainforge plans, tracks, processes, reviews, versions, and exports. Generation, selection, approval, concept lock, promotion, activation, and export are not interchangeable states.

## 2. Whole-app structure

Replace the eight equally weighted navigation destinations with four task destinations and a project/settings utility. These are navigation groupings, not new backend entities.

| Destination | Purpose and retained coverage |
|---|---|
| **Workbench** | Combines Overview and Assets. Project readiness, required/optional assets, blockers, and next actions lead into the selected asset workspace. Retains asset creation, all families, specifications, imported references, concepts, branches, deliverables, generation, processing, and environment collections. |
| **Review** | Cross-project-asset decision queue feeding the same artwork workspace. Retains candidate/output comparison, favorites, whole-image/pin/rectangle/frame-range annotations, revisions, decisions, escalations, and reassessment. Return to the originating queue with its selection intact. |
| **Releases** | Combines Library, production versions, and Export. Distinguishes reviewed deliverables, immutable production versions, the active version, and exported files. Retains promotion blockers, activation, pinned/subset export selection, destination/preset details, export plans, conflicts, and history. “Release” is a navigation label, not a replacement operation. |
| **Activity** | Jobs and History as two views: running work and attention first, full records available. Retains failure/unresolved handling, reconciliation and supported retry/cancel actions, event provenance, and the existing preference proposal/confirmation flow. |
| **Project & settings** | Project switch/open/create, connection configuration, project/art-direction/style authoring, policy and budget controls, and agent setup. Preserve their existing scope and human-only authorization. Contextual budget controls also remain reachable from generation. |

### The shared asset workspace

- **Context header:** Project → asset → branch → deliverable, plus exact candidate/output selection when relevant. Show the viewed branch separately from the current branch and active production version. Preserve deep links and browser Back behavior.
- **Left navigator:** Searchable assets and their real deliverable/dependency structure. Expand only the selected asset by default. Do not replace the actual dependency graph with a fictional uniform sequence.
- **Center stage:** The largest region, reserved for the selected output, comparison, or task material. Before any output exists, show the definition/reference/generation task rather than an empty black viewer.
- **Right inspector:** The current decision, its blockers, and relevant notes/tools. Use progressive sections for processing and exact inputs; identifiers and full provenance stay accessible without consuming the primary viewing area.
- **Bottom strip:** Candidates during exploration; playback and frame navigation during motion review. Keep these distinct so candidate thumbnails do not compete with the timeline. Never autoplay a grid of clips.

**First viewport:** A compact context header, a narrow asset navigator, a dominant artwork stage, and a contextual decision inspector. At 1440×757 the artwork, essential playback controls, selected output identity, and next decision must be visible together. No large page title, output list, or pipeline summary pushes the stage below the fold.

**Signature interaction — retain the asset, change the task:** Moving between exploration, processing, review, and versions keeps the same asset/branch context. Comparing or selecting outputs updates the stage and its exact-output notes together. A decision updates the queue but does not unexpectedly advance, reorder the selected item, or move a control beneath the pointer.

## 3. Visual and interaction direction

**Scene assumption:** Long desktop sessions beside a game editor, under mixed ambient lighting. Use a neutral graphite viewing workspace with a fully designed light theme; the artwork background is independent of the application theme.

- **Visual system:** Neutral charcoal, slate control surfaces, clear light text, and one restrained blue selection/action accent. No neon, gradients, decorative textures, marketing typography, or nested cards around every fact. The artwork supplies the color.
- **Typography and controls:** System UI sans, compact but readable hierarchy, tabular figures for frame/time values, monospace only for technical identifiers. Consistent, familiar buttons, segmented controls, menus, and labeled fields; never hide a safety-critical action behind an unlabeled icon.
- **Viewing tools:** Preserve light/dark/checkerboard backgrounds, image zoom/pan, processed-versus-source selection, frame stepping, loop inspection, actual atlas playback, and applicable family previews. Use native output dimensions and explicit fit/zoom state; never alter the image merely to match the theme.
- **State and feedback:** Pair status color with text/icon. Put blocker explanations beside the disabled action. Keep reconnecting, uncertain submission, stale plan, and stale approval distinct; an old view must not appear live. Success names the completed operation, not a generic “Done.”
- **Adaptation and motion:** At narrower desktop widths, collapse the asset navigator first and let the inspector become a labeled, focus-managed drawer. At 200% zoom, reflow without concealing decisions or creating keyboard traps. No mobile-product expansion. Motion only explains state changes; respect reduced motion and preserve selection/focus during live updates.

The honest tradeoff is familiarity: this resembles a professional creative tool. Its distinctiveness must come from the integrated, gated production workflow—not ornamental chrome or invented controls.

## 4. States, safety, and boundaries

### Required states and content ranges

| State group | Required behavior |
|---|---|
| **First use and empty** | No project, missing/invalid specification, no assets, no candidates, and no locked branch each explain one useful next action. Connection readiness and generation eligibility remain separate. |
| **Small and dense projects** | Support a single asset with five deliverables and multiple branches, as documented in the character run; also design for long names, many deliverables, and a dense asset list. These are stress cases, not claims about typical customers. Existing 200-record job/revision limits must be explicit rather than implying a complete history. |
| **Changing work** | Generation/processing pending, failed or unresolved jobs, reconnect/resync, changed requirements, stale decisions, open/responded revisions, and superseded outputs remain distinguishable. Live updates do not discard drafts or silently change the output under review. |
| **Exact-output review** | Notes and decisions refer to the actual output ID/hash and appropriate source/processed frame mapping. Source, matted, and processed labels follow the selected output. Favorite is a shortlist marker, never approval. |
| **Production and export** | Show what is promoted, what is active, and what is exported independently. Explain incomplete bundles, requirement mismatch, destination conflicts, stale plans, and preserved prior exports beside the relevant action. |

### Non-negotiable safeguards

1. Show workflow compute location and budget before generation; never invent a monetary estimate that the backend does not provide.
2. Preserve human-only permissions and explicit confirmations. Never combine lock, approve, promote, activate, and export into an ambiguous “Finish” action.
3. Preserve uncertain-submission reconciliation, request identity, stale-plan checks, and existing conflict/data-loss protection. Visual changes must not create a blind retry path.
4. Keep branch/input provenance, annotation scope, and approval validity truthful. Derived badges and queue counts must agree with authoritative state.
5. Preserve keyboard operation, visible focus, accessible names, sufficient contrast, and non-color status cues. Stage tools must have a keyboard-usable equivalent where the existing interaction permits one.

**Outside scope:** New generation capabilities, a general workflow editor, an in-app assistant, audio/3D, multi-user/cloud hosting, engine synchronization, a new backend pipeline, or removing existing capabilities to simplify the UI.

## 5. Builder handoff and acceptance

This is a full UI replacement, not a recoloring pass. Preserve React, React Router, TanStack Query, existing operations/SSE, and the actual image/animation/annotation implementations where they already solve the task. Reorganize the shell and feature composition rather than writing a second viewer or duplicating business state.

Primary touchpoints are `App.tsx`, `components/Layout.tsx`, `styles.css`, and `components/ui.tsx`; then asset/candidate composition and the existing project, generation, review, processing, production, export, activity, and settings features. Every current route and action needs a mapped home. In the eventual implementation, update internal callers together and retain addressable asset/branch/output context.

### Acceptance scenarios

1. **Orient:** From project entry, find incomplete required assets, see the reason for a blocker, and open its relevant task without visiting unrelated pages.
2. **Produce:** Create or open an asset, inspect its definition/references, plan budgeted generation, compare concepts, lock explicitly, and navigate real dependent deliverables without losing context.
3. **Judge:** On 1440×757, inspect artwork and reach its decision without scrolling the stage into view. Exercise backgrounds, comparison, playback/frame stepping, source/processed identity, annotation selection, and return to the review queue.
4. **Deliver:** Review promotion blockers, promote, separately activate, inspect the export plan, and export through the existing safe workflow. UI state continues to distinguish all three operations, including errors and changed plans.
5. **Recover and adapt:** Inspect unresolved work without blind resubmission; preserve drafts and selection through live updates; exercise keyboard-only use, 200% zoom, light/dark themes, and 1280-, 1440-, and wider desktop layouts. Include settings, family-specific previews/collections, and empty/error states—not only the main viewer.

### Evidence and unresolved implementation dependencies

The direction is grounded in `apps/web/PRODUCT.md`, current routing/shell/tokens, asset and candidate composition, review/export flows, and `docs/FIRST-CHARACTER-RUN.md`. The current shell was inspected in Chrome; no representative project was opened, no GPU jobs were started, and no approval/export operations were performed. Populated-workspace conclusions therefore come from source and the recorded run, not a new end-to-end live test.

The recorded run reports superseded outputs counted as pending review, an asset-wide revision blocker appearing on the concept step, and an incorrect output label. A new layout alone cannot establish correct status semantics. Implementation must verify and address the relevant source-of-truth behavior rather than hide legitimate pending work in CSS or client filters.

**Approval:** The user approved this whole-UI brief and requested implementation. The application must preserve the boundaries and acceptance scenarios above.

## Implementation evidence

- The four-destination shell, shared asset/task navigator, exact-output review workspace, concept thumbnail strip, Releases, Activity, project entry, and settings are implemented. Existing deep-link routes and distinct safety-gated operations remain in use.
- Browser verification used the real backend with an isolated temporary project/config and synthetic fake-ComfyUI output. Through the UI: preview-bound project creation, family-template asset creation, budgeted generation, explicit concept locking, processed-output approval, separate promotion and activation, and a 31-file export completed. No real GPU or user-project data was used.
- Playback, frame stepping, source/processed comparison, atlas mode, independent viewing backgrounds, frame-note selection, required rejection reasons, and review-queue return context were exercised. Approval changed only the selected processed output; source outputs remained undecided. New-note text, draft pin geometry, and existing-note edits survived closing Notes; a draft also survived a live favorite update.
- The 256px fixture clip renders at 265px in the 1440×757 workspace and 286px at 1280×800 with pixelated sampling and visible decision controls. The narrow inspector uses a native modal drawer: 12 consecutive Tab stops stayed inside it, and Escape restored opener focus. Reflow was exercised at 390×844 and at a 720×378 CSS viewport equivalent to 200% zoom on 1440×757; an actual browser zoom setting was not used.
- Web and core typechecks passed; the production web build passed. The focused review regression file passed 9 tests with 45 assertions, including selected-output versus stale sibling approval behavior. Existing concept-step revision scoping was retained. Build notices remain for the large application chunk and third-party Zod pure-annotation comments.

Review screenshots and `verification.json` are under `apps/web/.impeccable/review/`; `fixes/` contains the finish-review corrections. Synthetic fixture artwork in these captures is verification material, not a design asset or a claim about generated art quality.

The shipped design system is recorded in `apps/web/DESIGN.md` and its token sidecar, `apps/web/.impeccable/design.json`. The isolated fixture service is stopped and temporary scripts are removed.
