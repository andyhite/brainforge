# Brainforge v2 implementation plan

## Context
Implement all of `docs/SPEC.md` as a local single-user asset-production application, with Bun, React + TypeScript, Hono, and a Turborepo monorepo. Deliver the pipeline incrementally through runnable milestones; stop after each for the user to test, review, and explicitly approve proceeding. The first character workflow proves the common operations, not a reduction of the final asset-family scope.

## Confirmed starting point
The current repository root contains `docs/SPEC.md` and no implementation packages (read during planning). The user supplied the read-only reference archive at `../brainforge-v1`. The specification is authoritative; archive contracts do not carry forward automatically. No implementation or live generation has been performed during planning.

The Brainforge skill advertised by the environment could not be loaded (`skill://brainforge` returned file not found); use the actual specification and inspected archive evidence, not presumed skill instructions.

The actual target game is `../shit-your-brain-pants`; its `docs/` are authoritative for the game's art and character brief. `../shit-your-brain-pants.bk2` contains legacy v1 specifications and is reference-only. Never initialize the backup or confuse it with the actual target.

Read-only runtime observations: `bun --version` returned `1.3.14`. `GET http://127.0.0.1:8188/system_stats` returned ComfyUI `0.36.0` on Linux with an NVIDIA GeForce RTX 5090. This proves reachability, not model readiness or output quality; the browser/backend workstation is macOS, so the reachable endpoint must not be described as proof that computation happens on this Mac or costs nothing.

Inspected archive facts: `fixtures/comfy/workflows/krea2-still-rgba/v1.yaml` uses the local UNET/CLIP/VAE loaders, 8-step Krea 2 Turbo, and BiRefNet → InvertMask → JoinImageWithAlpha. Its notes explain why omitting the inversion makes the subject transparent. `fixtures/comfy/workflows/animation-clip/wan22-flf/v1.yaml` uses Wan 2.2 high/low experts with 4-step LoRAs, start/end references, and a 33-frame, 16 fps frame-sequence output. These are starting recipes, not approved game assets.

Do not copy v1 wholesale: `packages/render/src/comfyui/comfyui-provider.ts` documents ambiguous-submission reconciliation and safely restricts cancellation to queued prompts; retain those behaviors. `packages/image/src/animation-build.ts` includes useful atlas/preview helpers but also obsolete validation and engine-capture obligations. `packages/godot/CONTRACT.md` mixes useful SpriteFrames packaging with scene assembly, collision, testing, and builds that the v2 specification excludes.

## Architecture decisions

Use Bun `1.3.14` for installation, scripts, server, CLI, worker code, and `bun:test`; pin it in `packageManager` and the runtime-version file. Use Bun workspaces (`apps/*`, `packages/*`) with `workspace:*` dependencies and Turborepo tasks. Official Bun workspaces, Hono Bun integration, and Turborepo installation documentation were read during planning: https://bun.sh/docs/pm/workspaces, https://hono.dev/docs/getting-started/bun, https://turborepo.com/docs/getting-started/installation. No Node.js runtime requirement or pnpm wrapper carries forward.

New package boundaries (there is no implementation in the current checkout to extend):

| Package | Responsibility |
| --- | --- |
| `apps/server` | Bun/Hono loopback server, sessions, API, SSE, durable scheduler; serves built web assets. |
| `apps/web` | React + TypeScript + Vite, React Router, TanStack Query, Radix UI primitives, CSS variables; no server-only imports. Run Vite with Bun explicitly. |
| `apps/cli` and `packages/omp` | Structured Bun CLI HTTP client and thin oh-my-pi extension; neither executes a second copy of domain operations. |
| `packages/contracts` and `packages/core` | Zod schemas and operation types; shared authorization, planning, review, branching, promotion, and completeness rules. |
| `packages/storage`, `packages/comfy`, `packages/media`, `packages/export` | Project-local SQLite/files; sole generation transport; Sharp/FFmpeg processing; generic and Godot resource packaging. |

Dependency direction is `contracts` → `storage/comfy/media` → `export` (uses contracts/media) → `core` (orchestrates these concrete modules) → `server`. The web/CLI depend only on browser-safe contracts and HTTP; the omp extension depends on contracts plus the CLI executable package. Name workspaces `@brainforge/<directory-name>`, with `@brainforge/cli` exposing `brainforge` via `#!/usr/bin/env bun` and its executable entry as a package export so omp resolves it without CWD assumptions. Keep the operation registry/types in contracts separate from executable handlers to avoid importing SQLite/Sharp into the browser. Add packages when their first real behavior lands, not as empty scaffolds.

Use `bun:sqlite` in `brainforge/.state/project.sqlite` for authoritative managed records, alongside authored YAML and immutable project-local visual files. A single backend owns writes and a per-project OS-process lease; UI/CLI requests use optimistic revisions and durable idempotency keys. Avoid importing v1's multi-file JSON registry journal, provider factory, rights gates, or whole service facade. Reuse tested algorithms selectively after Bun smoke verification.

The durable scheduler runs in the server process, not a browser or CLI invocation. CPU-heavy media work runs in bounded Bun worker threads and FFmpeg subprocesses; no Redis, queue server, ORM, or embedded reasoning model. All jobs persist before dispatch. Restart reconciles ComfyUI queue/history and filesystem publication intents without resubmitting ambiguous generation.

The React app is a quiet asset workbench: persistent project switcher and five navigation entries (Overview, Assets, Review, Library, Settings), an asset step rail, a dominant visual preview/comparison area, and a collapsible inspector. Status is text plus icon, never color alone. Every work surface shows current result, blocker or running work, and one primary next action; advanced recipe details are progressively disclosed.

## Milestone execution rule

Each milestone delivers functioning operations, CLI/tool access, and its relevant human-facing surface together. Feasibility is the sole exception: it uses a small processed-art preview rather than the management UI. The implementer leaves the application and exact demo material available, supplies bounded hands-on steps and evidence, then stops for explicit user approval. Passing tests or silence is not approval. Rejected milestones are corrected and re-presented before downstream implementation. Subtasks may run concurrently inside a milestone only; future milestones are not implemented behind the user's review gate.

Approval of this plan authorizes starting **M0 only**. After each numbered milestone and each explicitly named sub-gate, ask for the user's decision through the interactive approval mechanism and wait. Do not pre-implement downstream milestones while waiting.

## Representative project and acceptance brief

Initialize only `/Users/user/Code/andyhite/shit-your-brain-pants`, never `.bk2` or the tool checkout. Treat `docs/03-art-direction.md:19-83`, `docs/04-characters.md:7-110`, `docs/08-animation-and-assets.md:81-98`, and `docs/10-production-and-generation.md:22-39` in that project as the art brief. The existing `docs/references/cortex-early-concept.png` was inspected: it is a frontal exploratory reference, not a locked model sheet. Copy it through the reference-import operation; do not alter it.

Cortex's starting identity is a sixteen-year-old humanoid with a coral-pink brain approximately two-fifths of standing height, integrated expressive eyes, a small elastic mouth, white T-shirt, belted blue jeans, and black high-top sneakers. Use side-oriented three-quarter gameplay framing, a guarded/slouched resting attitude, broad folds, warm dark contours, flat colors, and limited cel shading. Four-finger hands are a proposal to show for approval, not a pre-approved fact. The game's docs require front/profile/rear construction references before production animation; explicitly declare those dependencies for Cortex, without imposing turnarounds on other assets.

The backup `../shit-your-brain-pants.bk2/specs/characters/cortex.yaml` includes historical prompt compensation (“head taller than the body”) and a later “wide crooked smirk” trial. Do not import those as current requirements or import their approvals. Author fresh v2 YAML from current game docs; present differences in the first brief review.

Use 1024×1024 Krea still requests and 768×768, 33-frame Wan trials at source 16 fps as initial recipe values from inspected descriptors. Process to a 256×256 transparent trial canvas with a fixed framing transform calibrated to the chosen neutral reference; preview Cortex at 96, 108, and 120-pixel standing heights against a 1280×720 comparison field. These are explicit feasibility settings, not universal family defaults. Compare exported 12 and 16 fps playback at preserved duration, as requested by the user; their milestone review chooses the project default before production proceeds. Idle and **walk** satisfy Brainforge's first-workflow acceptance; walk is a tool feasibility deliverable, not a claim that it replaces the game's separately documented run action.

The user authorized support for **reviewed external cleanup**: export original frames for editing outside Brainforge and import corrected PNGs/frame sequences as new candidates with parent IDs, file hashes, notes, and processing provenance. Never replace originals or inherit approval onto cleaned bytes. This is a complete managed path, not an embedded painting editor or an excuse to leave generation/processing controls unfinished.

## Shared contracts to implement

These are new v2 contracts, not claims that code already exists. Create them in `packages/contracts/src/` at the first milestone that consumes them. Do not expose an unimplemented operation or a selectable pipeline option ahead of its milestone.

### Portable project layout and authored YAML

Use an **asset-centric** layout: each asset has one home for its authored definition, local references, working material, and promoted versions. Keep project-wide inputs together and hide only internal bookkeeping.

```text
<game>/
  brainforge/
    project.yaml
    styles/
      <style-id>.yaml
    references/
      <reference-id>/<filename>          # Shared project/style references
    workflows/
      <workflow-id>/<version>.yaml
    assets/
      <asset-id>/
        asset.yaml
        references/
          <reference-id>/<filename>      # Asset-specific source references
        work/
          runs/<run-id>/inputs.json
          candidates/<candidate-id>/{original,processed,previews}/...
          reviews/<revision-request-id>/...
          feasibility/<trial-id>/...
        versions/
          <version-id>/
            manifest.json
            files/...
    .state/
      project.sqlite
      staging/<operation-id>/...
    .gdignore
  assets/
    brainforge/                         # Configured engine-facing export destination
```

`brainforge/project.yaml` is the sole project entry point; do not create a second root-level config or a `specs/` wrapper. Asset family is metadata in `asset.yaml`, not another directory level. Environment collections and their child assets are peers under `assets/`; collection membership never physically nests or moves a child. Branches select outputs in the asset's shared history rather than duplicating directory trees.

Ownership is explicit: humans/agents author `project.yaml`, style/workflow YAML, `asset.yaml`, and source references; operations manage `work/`, `versions/`, and `.state/`. Both visible work history and hidden `.state/` are durable portable data. `.state/` is not a cache or a safe-to-delete directory. Back up/move the whole `brainforge/` tree, including hidden files, plus the configured exports.

All persisted paths and `spec.*` path arguments remain relative to the selected **game root**, not the current YAML file or asset directory. Create `packages/storage/src/project-paths.ts` as the single path-construction module used by initialization, authored-file discovery/watchers, runs, reference import, candidates, revisions, promotion, snapshots, and the feasibility harness. Resolve asset artifacts from their recorded `assetId`; never scan all asset trees to guess which owns a candidate ID. Cross-asset dependencies store IDs and hashes, not copied artifacts. This is a new implementation, so no aliases or migration layer for the earlier proposed layout are needed.

Reference imports take `scope:"project"|"asset"` with `assetId` required only for asset scope. Project/style references go under `brainforge/references/`; asset-specific sources go under that asset's `references/`. Record scope and owning asset with the reference ID so shared inputs are stored once and addressed consistently from every consumer. The reference-import UI defaults to asset scope from an asset page and project scope from shared settings. Scope affects storage ownership, not whether a different asset may explicitly reference the same imported ID.

All managed records and candidates are durable project material, not disposable caches. Branches, annotations, decisions, preferences, revisions, jobs, and exports live in SQLite; associated visuals live at relative paths. SQLite uses foreign keys, WAL, `synchronous=FULL`, numbered transactional migrations, and a graceful-close checkpoint. Move/copy a project only after closing it or using the app's consistent snapshot operation; copying an open database without its WAL is not a supported backup. A newer schema opens read-only with an upgrade instruction; malformed managed records never trigger silent reinitialization.

`brainforge/project.yaml` uses `schema: brainforge.project.v2`, immutable `id`, `name`, `artDirection`, `styleIds`, `references`, `defaults`, `familyDefaults`, `requirements`, `approval`, `automation`, and `export`. `requirements.assets` is an explicit list of required asset IDs; optional experiments never inflate completeness. `defaults` contains `perspective`, `palette`, `sizing`, `animation`, `processing`, and workflow selections; `layers` defines project environment-layer IDs and descriptions. `sizing` is `{width,height}` in exported pixels; `animation` contains `playbackFps`; `export` is `{preset:"generic"|"godot4",destination:"assets/brainforge"}`. Connection URLs, bearer tokens, machine paths, and credential values are rejected from portable settings.

For character/creature families, `sizing.subjectHeightPx` additionally defines neutral standing height in exported pixels, and `displayScale` controls intended display height independently of canvas dimensions. The initial trial uses subject height 216 on a 256×256 canvas, with display scales `96/216`, `108/216`, and `120/216`; M0 records the chosen value. Noncharacter families need not supply standing height.

`brainforge/assets/<asset-id>/asset.yaml` uses `schema: brainforge.asset.v2`, `id`, `name`, `family`, `description`, `identity`, `styleIds`, `references`, `overrides`, `deliverables`, and optional `collection`. `family` is exactly `character|creature|item|equipment|prop|environment|background|tile|ui|icon|effect`. `identity` is a string-keyed map of plain-language requirements so character anatomy/clothing, item material, or UI visual language do not require parallel schema systems. Asset IDs are lowercase kebab-case, unique across the project, and match the parent asset-directory name; style IDs match their YAML filename. Display-name or family edits do not move an asset or rewrite artifact paths. Concept validity needs only ID, family, name, and description; absent production fields yield step-specific blockers, not a globally unusable asset.

Each deliverable is `{id,kind,required,description,dependsOn,referenceRoles,overrides,animation?,environment?,ui?}`. `kind` is `view|pose|expression|still|variant|animation|tile|ui-state`. `dependsOn` contains deliverable IDs within the same asset; collection child versions use separate pinned dependencies. `referenceRoles` maps semantic names to selected branch outputs. Animation fields are `{motion,loop,sourceFps?,playbackFps?,sourceFrameCount?,startReference?,endReference?}`; exact generation dimensions, required image roles, and `4n+1` length constraints come from the selected workflow. Environment metadata is `{layer?,pivot?,relativeScale?,tileSize?,connections?,seamlessAxes?,parallax?}` with `seamlessAxes: []|["x"]|["y"]|["x","y"]`, `connections: {north?,east?,south?,west?}` as matching-label strings, and parallax `{x,y}`. UI metadata is `{state?,nineSlice?}` where nine-slice is `{left,top,right,bottom}` pixels. These describe intended use, not collision, level placement, or game logic.

Also support `kind: reference-sheet` with named `regions:[{id,x,y,width,height}]` in source pixels. One authored construction-sheet deliverable may be reviewed as a whole and expose derived view crops as separately hashed outputs bound to reference roles; the approval pins the sheet, crop recipe, and all selected derived views. A generic comparison contact sheet remains presentation-only and does not confer approval.

Style YAML uses `schema: brainforge.style.v2`, `id`, `description`, `palette`, `references`, and `preferences` (confirmed preference IDs). Effective precedence is project defaults → project family defaults → asset overrides → deliverable overrides. Styles contribute ordered named visual constraints; conflicting concrete values are reported, not silently resolved by concatenated prompts. Scalars and arrays replace; object fields merge; omitted means inherit. Return an effective value and source YAML path/field for each leaf. Iteration instructions affect only a run and never silently become authored requirements.

Use `yaml` document AST edits to preserve comments and unknown text formatting where possible, and Zod to validate known authored structures; actionable errors include file, line/column, field, and the blocked operations. Watch authored files and rescan on focus/reconnect. Re-read and hash files at every mutation boundary, not just watcher time. UI/CLI writes carry `expectedHash`; conflicting edits return `SPEC_CONFLICT` with both texts, leaving drafts intact. Before replacement retain the previous bytes and user draft as managed spec revisions. Publish via same-directory temporary files, sync, and exclusive writer coordination; detect intervening external saves and surface the conflict, never silently select the app's stale copy. Invalid or temporarily half-written YAML preserves history and blocks only dependent new work; historical previews stay readable.

`expectedHash:null` means exclusive creation of a new authored file; an existing path returns conflict. Agents must use `spec.write` for coordinated simultaneous editing, although ordinary external-editor changes remain supported and detected. Field forms never rewrite an invalid file behind the user.

### Managed records, applicability, and publication

Implement typed SQLite tables for projects/assets, spec revisions, runs, jobs, candidates/outputs, branches/selections, annotations, revision requests/responses, decisions, policy authorizations, preference proposals/confirmations, production versions/active selections, export records, operation requests, and publication intents. Large immutable snapshots and media stay in the relative files above, indexed by SHA-256. Store both original YAML text and resolved effective input snapshots; current authored files remain the only source for current requirements.

Every run records exact specification/style snapshots, selected reference output IDs and hashes, effective settings and source map, prompt and iteration instructions, workflow version/graph and hash, actual supplied model/sampler settings, seed (or explicit unavailable value), source/native fps, processing recipe, calling actor, and linked revision IDs. Never invent model checksums, GPU duration, seed, or cost that ComfyUI did not provide. File hashes verify identity; semantic input fingerprints determine applicability.

Step state is `blocked|ready|running|awaiting_review|complete|failed`; a separate `needsReassessment` flag and reason list avoid erasing historical completion. A step is currently complete only when its selected output has an applicable approval and no unresolved revision-required feedback in that branch/step lineage. Empty required-deliverable lists cannot yield a promotable “complete” asset. Missing files/hashes fail with recovery information; filesystem bytes are never assumed valid just because a row exists.

Use per-step fingerprints over only inputs consumed by that step. Identity/visual direction/reference changes invalidate relevant generation and all its descendants. A change to one animation's motion invalidates that animation, not sibling motion. Playback, crop, alpha, pivot, or packing changes invalidate processed outputs/reviews, not the original generated frames. Display names and descriptive project notes that are not prompt inputs do not invalidate art. Mark reasons and affected steps on edit; never auto-regenerate or mutate promoted versions.

Publish media and production files with a recoverable two-phase intent: reserve IDs/idempotency in a short DB transaction; write and hash a staging directory; sync files and directory; atomically rename to the final immutable location; then commit record visibility and the operation result in one DB transaction. No network or encoding inside a DB transaction. Startup finishes a valid pre-recorded publication intent or marks it failed with retained diagnostics; it never exposes partial files. A promotion crash cannot alter the active pointer. Use immutable version IDs plus monotonic per-asset display numbers.

### One operation layer and caller authority

Define `executeOperation<K extends OperationName>(context: OperationContext, request: OperationRequest<K>): Promise<OperationResult<K>>` in `packages/core/src/operations.ts`. HTTP, CLI, and agent wrappers share `OperationMap` schemas from `packages/contracts/src/operations.ts`. `OperationContext` contains server-established `{actorId,actorType:"human"|"agent"|"system",projectGrants,capabilities}`; no request argument can choose identity or make a caller human.

The server listens on `127.0.0.1:3210`; Vite development listens on `127.0.0.1:5173` and proxies `/api` to the server. Production serves the built SPA and API on 3210. Restrict Host/Origin to those configured local addresses; no wildcard CORS, credential-bearing query strings, unrestricted file paths, or arbitrary ComfyUI proxy endpoint. Same-site HttpOnly browser session cookies, CSRF tokens for mutations, and authenticated file-ID routes protect the browser boundary. Machine settings live under `~/.config/brainforge/`; session/token secrets use OS-user-only files and stored hashes, never project records.

On first start print a short-lived single-use pairing code to the user's terminal; the user enters it in the browser. Pairing creates a human session, not a caller-selected role. The UI issues named agent tokens with explicit root/project scopes and capabilities; CLI/omp uses `BF_SERVER_URL` and `BF_AGENT_TOKEN` (env or OS-user-only local credentials). Pairing tokens never enter agent tool results. Agents can request project access or policy changes and receive a pending human authorization URL; they cannot grant them. Threat boundary is a cooperative local single-user application, not a sandbox against hostile code running with the same OS account or an agent deliberately stealing browser/terminal credentials.

Default policy: human concept lock, `agent_with_escalation` production review, human promotion, human activation. Per-step review policy values are `human|agent|agent_with_escalation`; authorized humans may override any agent review with a new history event. Under agent escalation, an agent can approve/reject or explicitly escalate; unresolved escalation waits for a human and is not approval. Generation does not imply decision authority.

Treat YAML `approval` as **requested** policy. Effective authority is the last human-authorized policy snapshot, stored with its hash and actor. An edited/agent-written relaxed policy remains pending until an authenticated human confirms the exact change. Project move preserves historical policy events but machine agent grants require rebinding before use. Promotion and activation grants are independent. Required-feedback resolution/waiver uses the affected step's effective review policy, and waiver requires a non-empty reason. Neither request labels nor a favorite marker convey authorization.

Before the first policy confirmation, the effective policy is the built-in default above. `settings.inspect` returns requested/effective policies, their field diff, and `requestedPolicyHash`; `policy.authorize({requestedPolicyHash})` fails with `REVISION_CONFLICT` if YAML changed. Return `POLICY_PENDING` only when an unconfirmed requested change would permit an operation the effective policy denies; ordinary insufficient grants return `HUMAN_AUTHORIZATION_REQUIRED`.

Authorization requests implement a full inbox lifecycle in M1: `authorization.request/list/inspect/grant/deny/withdraw/revoke`. Requests record immutable requested root/project scope, capabilities/budget, requesting actor, and `pending|granted|denied|expired|withdrawn|revoked`. Pending requests expire after 24 hours; grants record their own explicit expiry. Human listing includes all project requests; an agent sees only its own. Request returns `{authorizationRequestId,status,url}` for the UI page; deny requires a human reason, withdraw is permitted to its requester or a human, and only humans grant/revoke. A grant may narrow requested scope, never broaden it without a newly displayed confirmation. M1/M2 acceptance includes request → pending → deny → new request → narrower grant → successful retry.

All mutating operations require `requestId` and relevant `expectedRevision` or `expectedHash`. `OperationResult` is `{ok:true,data,revision?,jobId?,nextActions,warnings}` or `{ok:false,error:{code,message,details,recoveryActions},requestId}`. Durable uniqueness is `(projectId,actorId,requestId)` plus normalized payload hash: identical retry returns the prior result/job; changed payload returns `IDEMPOTENCY_CONFLICT`. Errors include `INVALID_INPUT`, `SPEC_CONFLICT`, `REVISION_CONFLICT`, `NOT_FOUND`, `HUMAN_AUTHORIZATION_REQUIRED`, `POLICY_PENDING`, `STEP_BLOCKED`, `WORKFLOW_UNAVAILABLE`, `SUBMISSION_UNRESOLVED`, `CANCEL_UNAVAILABLE`, `OUTPUT_MISSING`, `EXPORT_CONFLICT`, and `IO_ERROR`. Use HTTP 400/401/403/404/409/422/503 as appropriate and structured errors on every transport.

Idempotency begins when validated, authorized execution is reserved, not on pre-execution rejection. Do not cache validation failures, insufficient authorization, pending-policy denials, or optimistic conflicts as terminal results; the same request can be retried after its prerequisite is corrected. Once execution is reserved, the payload hash is fixed and recovery/replay never performs the side effect twice. Authenticate and enforce project-read access before returning a saved result, even when execution has already completed.

### Transport, operation inventory, and external-agent handoff

Expose `POST /api/operations/<operationName>`, `GET /api/projects/<id>/events?after=<sequence>` as SSE, and authenticated `GET /api/projects/<id>/files/<fileId>` with image/video/range support. Persist event sequence numbers with operations; after reconnect, replay recent durable changes or return a resync marker and refetch current status. Never make SSE delivery the authoritative state.

Provide `bun run bf -- <operationName> --project <absolute-game-directory> --input '<json>' --json`; also accept `--input-file <path>` and `--input -` to avoid shell quoting. The root `bf` script runs `bun apps/cli/src/main.ts`. Except project-opening operations, resolve the explicit root to an authorized opened project; do not infer CWD. CLI stdout is one JSON envelope, diagnostics/progress stderr, exit 0 success, 2 invalid input, 3 not found, 4 conflict, 5 authorization required, 6 operation/IO/provider failure. Long work returns a job ID promptly; CLI cancellation of a wait never cancels the underlying job.

Required operation groups (one registry definition drives CLI/tool validation; server remains final authority):

| Group | Names and load-bearing inputs |
| --- | --- |
| Project and authored inputs | `project.open/init/inspect/close/snapshot` (`path`; snapshot `destination` explicitly authorized); `spec.list/read/write` (`path,text,expectedHash`); `settings.inspect`; `reference.import` (`sourcePath` or uploaded file, `label`, `scope:"project"|"asset"`, `assetId?`); `workflow.list/inspect/preflight`; `connection.set` (human local setting); `authorization.request/list/inspect/grant/deny/withdraw/revoke` (request ID, exact scope/capability/budget, reason); `policy.authorize` (`requestedPolicyHash`). |
| Planning and generation | `asset.list/inspect/impact`; `step.inspect`; `generation.plan` (`assetId,branchId?,stepId,mode:"fresh"|"variation",referenceBindings,iterationInstructions?,count`); `generation.start` (`planId,planHash,budgetId`); `job.list/inspect/reconcile/retry/cancel` (`jobId`); `candidate.list/inspect/favorite/select` (`candidateId,outputId?,expectedRevision`); `candidate.export-cleanup/import-cleanup` (`parentCandidateId,parentOutputId,stage:"source"|"processed",frames:[{index,file}],notes,effortMinutes`); `processing.plan/start` (`candidateId,recipe`). |
| Reviews and learning | `annotation.create/update/delete` (`candidateId,outputId,geometry?,frameRange?,text,requiresRevision`); `revision.create/list/inspect/respond/resolve/waive` (`requestId` as domain `revisionRequestId`, annotation IDs, response/follow-up IDs, reason); `review.material/decide/escalate/override` (`candidateId,outputIds,requirementsHash,decision,reasons`); `history.examples` (`assetId,styleIds,stepKind,limit`); `preference.propose/confirm/reject/list` (text, project/style scope, supporting decision IDs). |
| Selection and delivery | `concept.lock` (`candidateId,outputId,requirementsHash,inputMode:"saved"|"current",planHash`); `branch.plan/create/list/compare/select` (`sourceCandidateId,sourceBranchId,inputMode:"saved"|"current",overrides?,planHash`); `production.plan/promote/list/inspect` (`assetId,branchId,selection,planHash`); `production.activate` (`assetId,versionId`); `export.plan/start/inspect` (`assetIds`, optional explicit `versions`, preset, destination, `planHash`); `project.completeness`. |

Every name above is implemented by final acceptance. Plan/inspect calls expose missing data and permission blockers without mutation. Agent tools expose the same operations even where their current token cannot execute them. `authorization.grant`, policy confirmation, and preference confirmation remain human-only; requesting those decisions is tool-accessible.

Build the oh-my-pi extension at `packages/omp/src/index.ts` as `export default function brainforge(pi: ExtensionAPI)`. The inspected extension contract is `pi.registerTool({name,label,description,parameters,execute(toolCallId,params,signal,onUpdate,ctx)})`, using `pi.zod` for host schemas (`omp://extensions.md:69-109`). Register `brainforge_<operation_name_with_underscores>` tools and invoke the Bun CLI with an argv array/JSON stdin, never a shell-interpolated command. Return structured `details` and text; review-material calls also return actual image content blocks for selected originals, contact sheets, annotated previews, and animation frames, not merely inaccessible local paths. Resolve only IDs and hashes authorized by the backend. If an image exceeds the model transport size, return a resized review derivative plus explicit original-file reference and a frame/page selector; never silently omit visuals.

Revision requests persist without any connected agent. `revision.list` polling is the initial notification transport; no MCP server or embedded chat is added. UI says “Waiting for an external agent” until a response/follow-up is recorded, not “Agent working” based solely on polling. An attempted correction links the request/annotations but leaves required notes unresolved until an authorized reviewer accepts the fix or explicitly waives it.

## Review workbench behavior

Use React components in `apps/web/src/features/{projects,assets,review,library,settings}` and shared `VisualReview`, `CandidateCompare`, `StepRail`, `EffectiveSettings`, `JobStatus`, and `ConflictDialog` components. These are new: the archive is CLI-only, so no existing frontend is carried forward. Server responses supply available actions and blockers; do not duplicate state/permission decisions in client conditionals.

At regular width use a 208px navigation column, flexible central art area, and 320px optional inspector. Below 1100px move the inspector into a labeled drawer; below 760px collapse navigation to a menu and stack comparison panes. Maintain functions at 200% zoom. Use system-ui 15px body/13px secondary/22px page headings, 4px spacing units, 8px panel radius, semantic light/dark CSS tokens following `prefers-color-scheme`, visible keyboard focus, 36px desktop controls and 44px touch targets. Verify WCAG AA contrast rather than estimating from screenshots. Artwork carries visual personality; no decorative dashboard metrics, glass overlays over art, or animated autoplay galleries.

An asset header shows name, current branch, production version, and distinct active version. The step rail shows only requested work. The central viewer supports fit/1:1 zoom, light/dark/checkerboard alpha backgrounds, baseline/pivot overlay, and side-by-side reference/candidate comparison with synchronized scale. Animation has play/pause, frame stepping, target-fps timing, range selection, loop-boundary comparison, raw/processed switch, and actual exported atlas playback. Never use the raw video as a proxy for the exported preview.

Annotations use SVG overlays over immutable images: whole-output comments, pin `{x,y}`, rectangle `{x,y,width,height}` in normalized `[0,1]` coordinates plus original pixel dimensions. Animation uses zero-based **source output** frame indices and inclusive `{start,end}`; the UI labels frames one-based and displays timestamps. Processing stores a source-to-export frame mapping so resampling does not relabel old feedback. The same viewer is used in concepts, production, review queue, branch comparison, and production history; historical views allow notes on their exact outputs but do not mutate old approvals. Keyboard-accessible numeric coordinate/range entry complements pointer drawing.

Comments have explicit “Requires revision” independent of approve/reject. Deleted or edited annotations retain audit history; editing an already resolved note creates a new unresolved revision when marked required. Revision bundles include immutable originals/relevant frames, rendered annotated PNG previews, notes/coordinates/ranges, effective specs, locked references, and both accepted/rejected examples. A bundle is not complete until its actual visual files are retrievable through both UI and tools.

The Overview separates “Required assets complete,” “Needs reassessment,” “Waiting for review,” and “Export status.” The Review queue filters human-required/escalated/revision-required work, shows reviewer identity/reasons, and opens the exact output revision. Library separates promoted from active and makes promotion, activation, and export distinct buttons. A combined convenience action is permitted only as an explicit two-step confirm showing both requested operations and partial-success recovery.

## Approach — ordered, approval-gated milestones

Milestones are sequential. Within each, contract/core work precedes its transport/UI consumers; UI components and adapter work can then proceed independently against the settled contract. Each gate includes real usage, not only tests. A milestone may expose only its completed capabilities, but the implementation is not complete until every milestone below has passed.

### M0 — Prove usable Cortex art before the application

Create only the Bun/Turbo workspace root, `packages/contracts`, `packages/comfy`, `packages/media`, the shared path-construction module in `packages/storage`, and `scripts/feasibility.ts` needed for this proof. Database-backed storage arrives in M1. Root scripts are `feasibility: bun scripts/feasibility.ts`, `bf: bun apps/cli/src/main.ts` when M1 lands, `dev: turbo run dev`, `build: turbo run build`, `test: turbo run test`, and `typecheck: turbo run typecheck`. `dev` is persistent and uncached; tests and builds use dependency ordering, live-generation commands are uncached and never ordinary test dependencies. Server builds use Bun target with `sharp` external; web builds use Vite invoked through `bun --bun`.

Port only the necessary ComfyUI HTTP primitives and reference-upload behavior from `../brainforge-v1/packages/render/src/comfyui/`, adapting them to v2 contracts. Read dependencies before copying; do not import the archive at runtime. Create `packages/comfy/workflows/{krea2-still,krea2-variation,wan22-motion}/1.yaml` under `schema: brainforge.comfy-workflow.v2`. Base stills on `krea2-still-rgba/v1.yaml` and motion on `animation-clip/wan22-flf/v1.yaml`. For variation/reference/pose work, use the installed Krea 2 Identity Edit path below, not the archived continuity-strong/motion-weak img2img graph. Every reference is an uploaded, hashed image role. Flatten RGBA onto light gray before reference encoding, and include both untouched decode and matted output SaveImage nodes. Preserve the BiRefNet mask inversion. Package background removal as explicit workflow processing, not a negative prompt. Do not expose a nonfunctional Krea negative-prompt field at cfg 1.

The current server lists `krea2_identity_edit_v1_2.safetensors`, `Krea2EditModelPatch`, and `Krea2EditGroundedEncode`; all three were inspected live. Build `krea2-variation` using Krea Turbo → LoraLoaderModelOnly (that LoRA, strength 1.0) → Krea2EditModelPatch, with uploaded reference → VAEEncode → `source_latent` and reference image + VAE wired to the pixel path. Wire the same `EmptySD3LatentImage` target to both the patch's `target_latent` and KSampler's `latent_image`; use `fit_mode: fit`, `ref_boost: 4`, grounded encode at `grounding_px: 768`, 1024×1024 output, 8 steps, cfg 1, euler/simple, denoise 1. The grounded instruction is the positive conditioning; use a second grounded encode with empty instruction and the same image for the negative input (not a user-facing negative dial). Start with one reference; source-role order is explicit if two references are added by a project workflow. This recipe follows the inspected upstream [model card](https://huggingface.co/conradlocke/krea2-identity-edit) and [node wiring](https://github.com/lbouaraba/comfyui-krea2edit). Their claims are not visual proof for Cortex: distinctive geometry can still drift. No Raw-model removal path is added.

Workflow descriptors contain `{id,version,graph,inputBindings,outputBindings,requiredNodes,requiredModels,execution}`. `execution` records `{computeLocation,externalServices,credentialKeys,costDescription,upperBoundPerRunUsd?}` with no secret values. Workflow preflight checks all graph classes and required model filenames against `/object_info`, dimensions/input ranges, and node API/remote behavior. Live read-only inventory listed the required Krea/Wan diffusion models, Qwen/UMT5 encoders, Qwen/Wan VAEs, both Wan lightx2v LoRAs, BiRefNet, and the identity-edit nodes/LoRA. `WanFirstLastFrameToVideo` exposes the expected references and frame-length input. Model-file integrity, custom-node source revision, graph execution, and art quality remain **unverified — confirm first**. Pin the installed custom-node revision in the recipe when obtainable; otherwise record unavailable rather than fabricate it. Unknown/custom remote-node behavior needs explicit execution disclosure before use.

Read `BF_COMFY_URL` (initial test value `http://127.0.0.1:8188`) only from local config/environment. Present the Linux GPU execution location, credential requirements, maximum submissions, and any hosted/leased-compute cost description before each authorized live batch. Do not equate loopback access with free/on-Mac computation. No direct Krea API, fallback model, automatic downloads, or ComfyUI installation changes.

`scripts/feasibility.ts` accepts `--project`, `--trial-id`, `--phase brief|still|pose|motion|preview`, `--plan` or `--submit`, `--plan-hash`, and `--request-id`; submit consumes the inspected plan hash and explicit batch authorization. It also supports `--action decide|cleanup-export|cleanup-import|process --input-file <json>` without submitting generation. `decide` takes `{role,outputId,outputHash,decision:"select"|"approve"|"reject",notes,settings?}` and requires interactive human confirmation; later plans consume those hash-pinned decisions. Cleanup actions take `{parentOutputId,directory,notes,effortMinutes}` plus the stage/frame mapping defined in M4 and preserve originals and lineage. `process` takes `{outputId,recipe}` and reuses retained media without a ComfyUI POST. The first trial belongs to asset `cortex`: save trial decisions, recipe, submission receipts, cleanup effort, and evidence under `<game>/brainforge/assets/cortex/work/feasibility/<trial-id>/`; save run inputs and candidate media in that asset's canonical `work/runs/` and `work/candidates/` paths, referenced by the trial record. M1 registers these retained records/files without moving or duplicating them or converting feasibility decisions into production approvals. Reopening reconciles submissions rather than retrying blindly. This is a bounded art-proof CLI using production Comfy/media primitives, not a parallel management application.

Use three human sub-gates:

| Sub-gate | Deliver and inspect | Stop condition |
| --- | --- | --- |
| M0a — brief and still | Show current-docs Cortex brief and early-reference boundaries; generate at most four concept stills initially. Compare at all three target heights on dark, light, and checkerboard backgrounds. | User chooses direction or requests a bounded correction; no motion before reference review. |
| M0b — identity under change | Produce one 1536×768 front/profile/rear construction sheet (three named 512×768 regions), then two separate three-quarter guides: `idle-rest` and `walk-contact`. Normalize each guide to the same neutral-reference scale before approval. Start Identity Edit at ref_boost 4/grounding 768; if the pose is unchanged, compare ref_boost 2/grounding 512; if proportions drift, compare ref_boost 6/grounding 1024 instead. Maximum: four concepts + one sheet + two guides + one diagnostic comparison + two corrective stills = ten. | User approves the whole construction reference and its view crops, each loop guide, the chosen recipe, and any cleanup; unchanged pose or lost Cortex geometry is not success. |
| M0c — idle/walk delivery | Bind `idle-rest` as idle's start/end guide and `walk-contact` as walk's start/end guide; never use a standing pose as a substitute for a cyclic stride guide. Generate with Wan, initially 33 frames at source 16 fps. At most two attempts per animation, no automatic regeneration; cap total live wall time at 60 minutes excluding human review and stop dispatch when reached. Reprocess without regeneration to compare 12/16 fps at 96/108/120-pixel heights. | User approves identity, alpha, framing, scale, pivots, loop boundaries, cadence, and cleanup workload, then records project playback/display defaults through `decide`. |

Counts are ceilings, not quotas. If the ceiling or quality gate fails, stop at that sub-gate, present exact artifacts and failure causes, and obtain a new bounded trial authorization; do not proceed to the full management system or switch models silently. External cleanup is supported but its steps and effort are made visible. If usable output still cannot be produced, this milestone remains unapproved; no claim of a complete art pipeline is permitted.

For processing, adapt `decodeImage`/`decodeRgbaCached` from archive `packages/image/src/decode.ts` and `buildFrameAtlas` from `animation-atlas.ts`. Use Sharp prebuilt binaries under Bun; Sharp's installation docs explicitly support `bun add sharp` and macOS ARM64 binaries, but the specific dependency combination still needs a real decode/resize/pack smoke run. FFmpeg and ffprobe were found at `/opt/homebrew/bin/`; invoke via configured executable paths with argv arrays. Missing binaries produce a prerequisite error, not a stubbed media operation.

### M1 — Open the real project and author shared direction

Implement project storage, local connection settings, pairing/agent grants, operation registry, HTTP/CLI/omp transports, and the React shell. Add the server/web/CLI/omp/core packages and extend storage with those real behaviors; export implementation arrives in M8, not as a placeholder package. `project.init` previews its paths, refuses to replace an existing incompatible `brainforge/project.yaml`, preserves M0's existing asset work, and creates only Brainforge-owned paths. `project.open` validates the explicit game directory, loads `brainforge/project.yaml`, reuses stored state, and displays that absolute game directory. Missing configuration returns an initialization action; it does not search ancestor directories or mistake the inner `brainforge/` directory for a different project. Closing a project removes it from the active UI without cancelling or orphaning work; the backend retains durable job context until tracked work is terminal. Snapshot first quiesces dispatch/publication boundaries; backend shutdown checkpoints and leaves remote jobs recoverable.

`project.close` returns `closing` while tracked work is nonterminal and `closed` only after publication finishes, the DB checkpoints, and the project lease releases. The UI says “Background work continues — not yet safe to move” until then. Switching the selected project is not equivalent to moving/closing its backing directory.

Add explicit directory-path entry with backend validation and recent-project choices. This is backend directory selection, not a browser upload masquerading as filesystem access. File browsing is limited to explicitly authorized roots; reference upload copies files into the project. Resolve/sanitize every relative path; reject `..`, absolute record paths, and symlink escapes. Export must not overlap `brainforge/`, authored documents, or the project root itself.

Author fresh `brainforge/project.yaml`, `brainforge/styles/cranium.yaml`, and `brainforge/assets/cortex/asset.yaml` from the current game docs using the v2 schemas. Register M0's recipe/settings and retained artifact records, and import the early Cortex image into Cortex-scoped references; feasibility choices do not automatically become production approvals. The full game manifest is reference material, not an instruction to produce the whole game's content during tool implementation.

Implement fields + YAML editor over the same files, effective-source inspector, external-edit refresh, conflict UI, and step-local missing-field messages. Initialize policy using a human-authorized snapshot; permit named agent access to the target project. Implement a consistent `project.snapshot` copy for portability with the scheduler quiesced and DB backup captured; never copy half-published outputs.

Initialization also creates owned `brainforge/.gdignore` so a Godot project rooted here never imports candidates, production history, or feasibility media as game resources. Snapshot includes authored/managed material **and** configured exports; enumerate files with no symlink following and recreate the known relative `current` link with `readlink`/`symlink` preserving the literal target, never an absolute link back to the original. Refuse unknown escaping links. Copy immutable files while quiesced, use SQLite's backup API for the DB, and resume the original scheduler after the snapshot commits.

**Gate:** User opens the real game directory and sees it in Settings; an actual omp agent running from another CWD authors `brainforge/assets/cortex/asset.yaml` through `spec.write` with expected-hash checks. The user changes shared direction in `brainforge/project.yaml` through the UI, edits asset YAML externally, sees both changes, and inspects inherited frame-rate sources. In a snapshot, exercise invalid YAML and a stale save while earlier work stays visible. Reopen the snapshot at a new path with clean preferences: recover `.state/project.sqlite`, asset-local work/versions, shared and local references, and export links; require only connection/grant rebinding. Inspect Cortex's directory to confirm its work is colocated and no root-level config or parallel flat artifact tree was created.

### M2 — Explore, compare, annotate, and iterate concepts

Implement the durable generation scheduler and concept operations end-to-end. Persist a job before upload/submission, submit one prompt per candidate with stable project/job/request identity in ComfyUI `extra_data`, and save the prompt ID. Poll queue/history every two seconds during active work; optionally use ComfyUI websocket progress events, but queue/history remain the recovery authority. UI receives server SSE and agents use `job.inspect`.

Job states are `queued|submitting|running|collecting|succeeded|failed|cancelled|unresolved`. After ambiguous submission, search queue/history for the saved identity: attach exactly one match, report multiple matches as unresolved, and report no match as unresolved rather than assuming no submission. A user may explicitly authorize a **new attempt** only after inspecting the unresolved case; preserve the original attempt. Download/processing retries reuse the remote result and do not regenerate. Terminal failure records stage, remote message, and supported recovery.

Default automation is `{maxAttemptsPerStep:3,maxConcurrentGenerations:1,maxBatchCandidates:4,autoRegenerate:false}`. One attempt means one accepted `generation.start`, independent of its candidate count; submission retries with the same request ID do not count again. A human-authorized generation budget has its own immutable ID and branch/step scope, maximum starts, maximum candidate submissions, expiry, and optional spend cap. Counters persist across restart and spec edits; an agent cannot reset them by changing fingerprints, opening a revision, or creating another branch. A four-candidate batch followed by a variation consumes two starts/five candidate submissions. Once exhausted, return a return-to-human blocker. A human explicitly authorizes a new bounded budget through `authorization.grant`; no self-reset or unbounded continuation. Every job dispatch checks remaining candidate/resource limits; approval rejection never generates automatically. Generation plans show counts, execution/cost requirements, remaining budget, and input hashes, all revalidated at start.

Cancellation deletes only a specified queued ComfyUI prompt. Do not call global `/interrupt` on the shared instance. A running job returns `CANCEL_UNAVAILABLE` explaining that it can finish without selecting its results; closing a tab, canceling a CLI wait, or disconnecting an agent never abandons the tracked job. Application-local queued jobs and processing tasks are cancellable with durable terminal status.

Deliver the concept grid, 2–4 candidate comparison, favorites, fresh batches, selected-candidate variations, and whole-image/pin/rectangle annotations. Complete the still-image revision lifecycle now: annotated PNG rendering, `revision.create/list/inspect/respond/resolve/waive`, actual originals/annotation visuals through omp image blocks, and human decisions for required concept feedback. Generation snapshots current YAML while old candidates retain inputs; concept exploration requires no animation setup. Favorites remain independent of approval.

**Gate:** User generates a real Cortex batch and annotates a candidate. The omp agent retrieves originals, annotated PNGs, notes, and YAML, edits the spec, starts a variation, and records a response; the user resolves the required note. Show old/new snapshots. Close/reopen the browser during generation. On an isolated snapshot use the collection hold described below, restart the backend, and reconcile the same result. Same-request replay creates no duplicate. Using the protocol fixture, a four-candidate batch plus variation fit the default budget; the fourth start is blocked pending human authorization.

### M3 — Lock a concept and produce only required references

Implement concept locking, branch selections, built-in dependency planning, review material/decisions, per-step policies, escalation, and human overrides together. A concept lock is a human-authorized choice of exact output and requirements; it creates a branch and enables production without prior promotion. It is not a production version. `agent_with_escalation` is not enabled until agents can escalate and humans can decide/override the exact reference output through both operation and UI paths.

Create `buildPipeline(spec,effectiveSettings,branch): PipelinePlan` in `packages/core/src/pipeline.ts`. All families use the same primitives: concept → selected reference deliverables → selected still/motion deliverables → processing/review. Dependency edges come from declared required views/reference roles and built-in family rules, not a user-authored workflow graph. Detect cycles, missing IDs, duplicate roles, and unavailable workflow bindings with field-specific blockers. Independent deliverables become ready independently.

For Cortex, request one front/profile/rear construction-sheet deliverable with hashed view crops, then separately approved `idle-rest` and `walk-contact` guides at side-oriented three-quarter facing. Bind each guide as its animation's own start/end pair; reuse exact applicable outputs where roles permit. Approve the sheet/crop set as one explicitly authored deliverable, not an arbitrary gallery contact sheet. Individual expressions/views remain selectable when authored as separate deliverables. Do not impose these reference steps on a static prop or generate every game pose.

**Gate:** User locks a concept, sees the branch and next step, produces/reviews required references, and sees idle/walk ready only after actual dependencies pass. The agent escalates one uncertain reference, and the human decides or overrides with recorded identity/reasons. A minimal static prop shows no character references or animation. Unauthorized agent concept-lock is denied; authorized agent review is never labeled human.

### M4 — Produce and review the actual exported motion

Implement motion generation, processing plan/start, processed candidate selection, and animation/atlas previews using M0's accepted recipes. Preserve raw/matted sources, never overwrite them on reprocessing. All image/motion generation continues through ComfyUI. Decode frame-sequence outputs directly; video-producing project workflows use ffprobe to record rational source FPS and FFmpeg to extract ordered lossless frames.

Define `ProcessingRecipe` with `{trim:{start,endExclusive},closingFrame:"keep"|"exclude-last",crop:{x,y,width,height},output:{width,height},resizeFilter:"nearest"|"lanczos3",alpha:"preserve"|"matte",matteColor?,pivot:{x,y},frameOffsets?,playbackFps,resample:"nearest",loop,packaging:"frames"|"atlas"|"both",atlas:{maxSize,padding,extrude},tileRepeat:"none"|"mirror-x"|"mirror-y"|"mirror-xy"}`. All coordinates are source pixels except normalized output pivot; recipe versions/hashes and source-to-export mappings are retained. Fields appear only where applicable, and no control is rendered if it has no real effect.

For related character clips add `scaleAnchor:{referenceOutputId,referenceHash,sourceStandingHeightPx,targetStandingHeightPx}`. Measure neutral standing height once on the approved canonical reference, transform it into the normalized 768×768 guide coordinate space, and normalize both idle/walk guides against it before motion. Derive one uniform scale from that anchor, not from each animated pose's changing bounding box; padding/crop does not alter the intended scale. Persist the guide-normalization transform and anchor with each recipe so a new guide cannot silently change character height.

Use one crop and uniform scale across a clip and the shared scale anchor across related character clips, never per-frame or per-clip auto-fit. Union foreground bounds determine padding/clipping warnings only; if the selected canvas cannot contain motion at the calibrated scale, block and ask the user to enlarge the canvas or explicitly revise scale. Frame offsets are explicit authored corrections, not hidden drift suppression. Transparent output preserves alpha; opaque backgrounds keep it opaque. Matte removal is explicit with preview, not inferred from “background looks white.” Cleanup imports follow the same processing/review path.

Cleanup round trips distinguish source and processed stages. `candidate.export-cleanup` and the M0 `cleanup-export` action write a sidecar `{parentOutputId,parentHash,stage,canvas,frameCount,frames,durations,sourceFrameMap,recipeHash}`. Both import paths require `stage:"source"|"processed"` and indexed replacements `frames:[{index,file}]` (index 0 for a still); unlisted frames copy by hash from the parent. Source-stage imports preserve source dimensions/count and then execute the normal recipe with the same scale anchor. Processed-stage imports preserve processed canvas/count/durations/source mapping and create a new unapproved processed output directly: never crop, scale, or resample those bytes a second time. Repacking only rebuilds atlas/preview artifacts. Invalid/duplicate indices, changed dimensions/count, or sidecar/hash mismatch returns a specific input conflict with originals intact.

When resampling, keep duration `D = playedSourceFrames/sourceFps`. Output `ceil(D*playbackFps)` frames; sample source `min(N-1,floor(i*sourceFps/playbackFps))`, and shorten the final frame's duration to `D-(Nout-1)/playbackFps` when needed. Store per-frame duration and source index. For the accepted 33-source-frame loop trial, explicitly exclude the closing guide frame to play 32 frames/2 seconds, producing 24 frames at 12 fps or 32 at 16 fps. Never exclude an end frame for a nonloop by default.

Adapt the archive row-major atlas algorithm to support pages capped at 4096×4096, no rotation, two-pixel gutters and one-pixel extrusion; retain complete untrimmed canvases so pivots survive packing. More frames create additional pages rather than an oversized image. Provide PNG frames, atlas pages, frame metadata, and browser playback driven by the actual packed rectangles/durations. Basic checks reject corrupt/empty/clipped files, invalid pivots/dimensions, and impossible packing; qualitative identity/foot sliding/loop judgment remains review, not a new automated validation product.

**Gate:** User generates both Cortex idle and walk, sees raw vs processed side-by-side, steps through export-rate frames, inspects alpha on light/dark, changes a pivot/crop/fps and sees a new unapproved processed result. Test a partial output download and a worker restart without another ComfyUI submission. Import a deliberately corrected frame sequence and verify it becomes a traceable new candidate.

### M5 — Close the human/agent revision loop and retain preferences

Extend the complete still-image revision/review lifecycle from M2/M3 to animation frame/frame-range material, and finish the global queue filters/history/preferences surfaces. Frame notes and required-feedback resolution must already function when the M4 animation viewer first exposes annotations; M5 proves the full external-agent motion correction loop rather than shipping the first way to unblock earlier work. Decisions pin exact output hashes and requirements. Required notes on old candidates continue blocking their affected branch/step after new generation until authorized resolution/waiver.

Implement `history.examples` as deterministic project-local retrieval: exact asset first, same style plus family second, same family third; within a tier prioritize matching step kind, human overrides, then newest. Return matched reasons, original visuals, decisions, and linked alternatives. Default to at most eight examples, reserving up to four accepted and four rejected when available; no embeddings, remote inference, or invented negative examples. Scope queries to project/style and paginate full history.

Preference proposals store text, scope (`project` or named style), evidence IDs, and status `proposed|confirmed|rejected`. Only a human confirms/corrects a proposal; confirmation creates an explicit requirement included in effective snapshots. It never silently modifies policy or retroactively changes old runs. The history UI lets the user compare agent judgments with subsequent human overrides; report counts/examples, not an unsupported claim of learned taste.

**Gate:** User marks a frame range “requires revision”; an actual oh-my-pi session retrieves originals + annotated visuals + contextual YAML, changes authored direction or supplies iteration instructions, starts a follow-up, and records a response. The UI remains blocked until authorized resolution. Exercise an agent escalation and human override; then retrieve accepted/rejected examples, propose a preference, and confirm/correct it as a human.

### M6 — Promote a coherent immutable character version

Implement promotion planning and publication in `packages/core/src/production.ts` using the shared intent mechanism. A plan enumerates every required deliverable, selected processed output, applicable approval, unresolved feedback, dependency fingerprint, and policy capability. Missing required material or stale approval blocks the entire asset bundle. Revalidate the plan before publication.

Production manifests use `schema: brainforge.production.v2`, `versionId`, `versionNumber`, `assetId`, `branchId`, `requirementsHash`, `specSnapshots`, `deliverables`, `dependencyVersions`, `files` (`path,sha256,mediaType,size`), `reviewDecisionIds`, `createdBy`, and `createdAt`. Include selected references and their context along with finished outputs. Use copies/reflinks where safe, not writable hard links to mutable staging. A changed animation can reuse the exact immutable unchanged deliverable and its applicable review without copying it into a new candidate.

**Gate:** Promote Cortex idle+walk as one version. A missing walk, unresolved note, changed processed frame, or changed current requirement refuses promotion. Inject a staging failure: there is no visible half-version and any earlier active selection is unchanged. Retry a lost promotion response with the same request ID and observe one version.

### M7 — Explicitly activate and restore versions

Implement activation as a short revision-checked DB transaction and audit event, separate from promotion. Display “Promoted — not active” until explicit activation. Allow selecting an earlier immutable version without deleting newer ones. Show whether a historical version matches current requirements; require explicit human acknowledgement when activating an obsolete version, and do not count it as currently complete.

**Gate:** User activates Cortex version 1; promoting an alternative leaves version 1 active. An agent without activation capability is denied even if it can promote. Human grants only activation for the project; the agent can then activate within that grant, with an agent identity in history. Restore the earlier version through the same operation.

### M8 — Export safely to generic and Godot-compatible packages

Implement the export contract below in `packages/export/src/{generic,godot4,publish}.ts`, with the same export plan/start in UI and tools. Default selection uses active versions; explicit version selection is shown before export. Never export raw/unapproved candidates. Missing active versions are blockers, not silently skipped assets.

**Gate:** Export the first active Cortex version to the configured game-relative destination. Inspect ordinary PNGs/atlas metadata and the Godot SpriteFrames resources. Add a human-owned file and attempt a conflict; it is preserved with a clear error. Inject failure before the commit pointer changes and observe the prior complete export still resolves. A successful replacement removes only manifest-owned stale files. Export failure does not undo promotion/activation.

### M9 — Continue from earlier work and rebuild only affected outputs

Implement branch plan/create/compare/select and full impact propagation. “Continue from here” works on any concept, reference, or animation candidate. The pre-generation screen shows two explicit bases: “Use saved inputs” (default) or “Use current settings”; show per-field differences and which selected references are reused. Record that resolved choice in the branch/run.

Branches have their own selected concept/references/deliverables/reviews, not copied editable YAML trees. A child branch inherits only upstream selections applicable to the chosen source; clear affected downstream selections. Reuse is based on exact dependency fingerprints, never filenames/asset IDs. Carry unresolved required feedback when the same output/step lineage is reused; feedback on abandoned alternative outputs remains in history without blocking an independent fresh concept branch.

Do not bypass concept-lock authority via branching. A branch from an unlocked/alternative concept is created only through `concept.lock` with the selected input mode and effective concept-lock policy. `branch.create` accepts a reference/animation candidate in an already locked source branch and needs generation capability; it cannot replace the concept selection. Rebase of an existing locked branch uses `branch.create` with its current selected downstream candidate and `inputMode:"current"`; if its concept no longer satisfies current identity requirements, require renewed concept-lock review before production. `branch.plan` is readable and exposes that authorization requirement.

A saved-input branch can be explored/reviewed against saved requirements, but **new promotion always checks current effective requirements and required deliverables**. If consumed inputs differ, return `STEP_BLOCKED` with reason `requirements-basis-mismatch`, per-field differences, and the exact rebase/renewed-concept-lock action. Rebase reuses only unchanged dependency fingerprints and marks affected selections for reassessment/rebuilding. Historical versions remain activatable with the explicit obsolete-version acknowledgement; this does not permit a new incomplete bundle.

**Gate:** Continue from concept B with a human-authorized lock while A retains its work. Choose saved inputs after a relevant YAML change: see the promotion blocker/diff, rebase to current, review affected outputs, and promote B without changing active A. Change only A's walk, review a new walk, reuse approved idle in a new coherent version, activate, and export. A playback-fps change invalidates processed approvals but not raw clips; a display-name change invalidates none. An agent branch request cannot bypass concept-lock policy.

### M10 — Complete creatures, items, equipment, and props

Extend the built-in family catalog in `packages/core/src/pipelines/` and the schema-driven asset editor. Creatures use character reference/motion primitives without humanoid assumptions. Items/equipment/props support requested views, variants/states, optional animation, and packaging; a static asset never gets forced motion steps. Equipment is visual art plus optional named attachment pivot metadata, not inventory/gameplay mechanics.

Use the same concept/revision/branch/version/export path, with actual generated representative material. The game manifest identifies health pickup, First Stain garment, Plop camera, and other props; do not silently claim a game enemy is a nonhumanoid creature. Use a clearly labeled separate validation fixture project for a nonhumanoid creature if the actual game has no such requirement.

**Gate:** Stop separately after (a) creature motion, (b) item/equipment variants, and (c) static plus optional-animated prop workflows. Each has UI + tool review/promotion/export evidence. These three sub-gates may share implementation primitives but are not skipped because the character worked.

### M11 — Complete environment groups, backgrounds, tiles, and modules

An `environment` asset is a visual collection with `collection: {members:[{assetId,required}],styleId}`. Children remain ordinary assets (`background`, `tile`, or `prop` for a modular piece) with their own pipelines and versions. The environment's concept establishes shared visual direction; required child outputs depend on that exact direction reference. There is no level graph, placed scene, collision generation, or engine synchronization.

Cross-asset direction uses a typed reference binding `{assetId,branchId,role:"direction"}` in the child's `referenceRoles`; same-asset bindings use `{deliverableId,outputRole}`. Resolve the former to the named environment branch's locked concept output ID/hash at generation-plan time and pin it in child runs/fingerprints. Changing that environment selection marks dependent children for reassessment. Never resolve an unnamed “latest concept” or use mutable asset ID alone as a reference dependency.

Promotion boundaries: children promote independently. An environment promotion defaults required members to their active versions, with explicit `selection.members:{[assetId]:versionId}` overrides; the plan displays every pin. Missing active/selected members, stale approvals, or a child's recorded direction output that differs from the environment branch block aggregate promotion. The immutable aggregate pins all selected member versions and metadata; optional members require explicit selection. Aggregate activation does not change child active pointers. Export expands pinned members; a directly selected child at a conflicting version is `EXPORT_CONFLICT`. Membership changes require a new aggregate, preserving prior versions.

Expose layer role, pivot, relative scale, tile dimensions, connection labels, seamless axes, and parallax hints in authored forms/effective views/exports. Add a repeating 3×3 tile preview, horizontal/vertical background wrap preview, and parallax hint preview (an asset viewer, not assembled level authoring). Use ordinary Krea still generation plus explicit processing; if exact self-wrap is requested, offer the recipe's mirror-repeat transform on specified axes with a visible symmetry warning. Do not pretend independently generated connection labels prove pixel seam compatibility. Review paired tiles and processed seams visually; keep the archive's failed crossfade/mirror observations as evidence, not blanket success.

**Gate:** Stop after the Flatlands collection/background sub-gate, then after the tiles/modular-piece sub-gate. Generate/review actual examples, inspect wrap and parallax metadata, block an incomplete collection, promote a complete one, and export pinned child versions. No scene files or gameplay scripts are produced.

### M12 — Complete UI, icons, and visual effects

UI/icon pipelines support shared direction, separately requested elements and states/variants, per-element canvas constraints, optional nine-slice margins, and sprite packaging. Add multi-state comparison and nine-slice scaling previews. Text needing localization/dynamic state stays outside generated art; the tool produces visual assets, not functioning game widgets.

VFX support stills and Wan animation sequences, transparent or opaque output as requested, loop/once playback, and the same processed review/annotation tools. Preserve alpha and allow edge contact where the specified canvas intentionally fills; do not apply the character rule “background removal always required” to glow, smoke, backgrounds, or UI panels. Missing required variants/effect sequences block promotion just like missing character animations.

**Gate:** Stop after UI/icon state-set export, then after a real animated VFX export. For the target game use a clearly labeled trial HUD/control state set and separate blast plume/impact assets drawn from its asset plan. Confirm state identity, nine-slice behavior, alpha, and animation cadence in the actual viewer. Every family supports agent operations, branching, and both export presets.

### M13 — Verify the complete product and usability

Use accumulated M0–M9 evidence to show the literal first-character acceptance sequence from `docs/SPEC.md:344-356` on the actual project, including original initialization and agent authoring. Then repeat the full sequence in a fresh isolated game-docs-only fixture so steps 1–2 execute again without deleting/reinitializing the user's project; use real ComfyUI media and an external agent. Fault/recovery checks use the isolated harness below. A second small contrasting pixel-art/static-icon project verifies that Cortex-specific style/family/sizing/fps assumptions did not leak into application logic.

Present the final requirement coverage ledger and actual evidence. No unimplemented operation names, disabled promised controls, fake provider in a real workflow, incomplete family editor, inaccessible tool-only visuals, or unreviewed processed export counts as completion. A user-declared game asset backlog may remain unproduced; the full Brainforge capability set may not.

**Final gate:** User performs an uninterrupted define → explore → lock → produce/review → promote → activate → export loop, then continues an alternative and sees safe selective reuse. Review remaining usability defects before accepting the product.

## Exact export contract and atomic publication

The user chose **stable asset paths across re-export**. Use immutable staged releases plus **one atomic relative-directory-symlink switch** on the initial macOS target, rather than overwriting the live tree file-by-file. Public paths are always `<destination>/current/assets/...`; game references do not include an export ID. This is filesystem publication, not an engine synchronization service. UI “Open exported files” and tool results expose those stable paths.

```text
<destination>/current -> .releases/<export-id>
<destination>/current/manifest.json
<destination>/current/assets/<asset-id>/asset.json
<destination>/current/assets/<asset-id>/stills/<deliverable-id>.png
<destination>/current/assets/<asset-id>/animations/<deliverable-id>/frames/0000.png
<destination>/current/assets/<asset-id>/animations/<deliverable-id>/atlas-0.png
<destination>/current/assets/<asset-id>/animations/<deliverable-id>/animation.json
<destination>/current/assets/<asset-id>/godot/...
<destination>/.releases/<export-id>/...       # complete backing snapshot
```

Only this managed `current` symlink is allowed: its relative target must resolve to a committed/prepared release inside this exact destination. Refuse existing unowned symlinks/directories at `current`, escape targets, cross-filesystem staging, or filesystems without atomic same-directory symlink rename. Do not silently fall back to non-atomic file replacement. Relative links survive moving the closed project with symlinks preserved. Verify Godot's actual discovery/reload behavior at M8; it is **unverified — confirm first**, not assumed from filesystem semantics.

Emit frames/atlas/both according to the reviewed processing recipe; an absent output mode is not a missing deliverable. Each `asset.json` uses `schema: brainforge.export-asset.v2` and includes `{assetId,family,versionId,requirementsHash,deliverables,dependencies,metadata}`. Each deliverable identifies `candidateId`, `outputHash`, `files`, exported canvas, pixel pivot (origin top-left, x right/y down), normalized pivot, display/relative scale, and applicable family metadata. Animation JSON uses `schema: brainforge.animation.v2`, `{sourceFps,playbackFps,loop,canvas,pivot,frames}`; each frame includes `{index,durationMs,sourceFrame,file?,atlas?:{page,x,y,width,height}}`. `durationMs` may be fractional. Preserve animation identity and logical names; no implicit mirroring, engine event timing, or collision geometry.

The snapshot manifest is `schema: brainforge.export.v2` with `{projectId,exportId,preset,createdAt,assets:[{assetId,versionId,metadataPath,resourcePaths}],ownedFiles:[{path,sha256,size}]}`. Manifest paths are relative to its snapshot root; public paths prepend `<destination>/current`. Include all managed snapshot metadata/file hashes. The manifest itself is recognized by its schema/project ID and last committed hash in project state rather than a recursive self-hash; release directory and pointer ownership is recorded in the export receipt.

Add `export.godotProjectRoot`, relative to the selected game directory and defaulting to `"."`. For `godot4`, require `project.godot` at that root and an export destination contained within it; derive `res://` relative to this declared engine root, not implicitly from the Brainforge project root. Missing/mismatched engine roots return a field-specific export blocker without affecting generic exports. Planning confirmed the actual game currently contains only `docs/`; do not create its engine project as part of this tool rebuild. M8 performs generic export in the actual game and Godot-format/stable-path acceptance in a disposable Godot project; when the user creates the real engine project, the same preset/configuration works there.

For `godot4`, target standard Godot 4.3+ text resources and include the generic files. Still/view/state/icon outputs get `AtlasTexture` resources pointing at PNGs (full-image region for standalone PNGs). Animations get one asset-level `SpriteFrames` resource with named entries, loop flags, and `speed=playbackFps`; per-frame relative duration is `durationMs*playbackFps/1000`. AtlasTexture subresources point to exact atlas rectangles with no rotation. Metadata carries pivots, relative scale, source candidate/version IDs, and environment hints. UI nine-slice outputs also get `StyleBoxTexture` resources with exact texture margins. Tile deliverables get a `TileSet`/`TileSetAtlasSource` using declared tile dimensions; export connection labels as metadata without inventing Godot terrain/connectivity or collisions. Background/module resources carry metadata only, not wrapper scenes. Missing tile dimensions or invalid nine-slice sums block that resource's promotion/packaging.

Reuse string escaping, stable resource-ID generation, and SpriteFrames serialization patterns from archive `packages/godot/src/animation-generator.ts` and `resource-generator.ts`; do not port `GodotService.sync`, embedded duplicate pixel payloads, automatic `.tscn` generation, import/build subprocesses, ownership-by-header alone, or game tests. Generate stable `res://<destination-relative-to-godotProjectRoot>/current/assets/...` paths. Subresource IDs use asset/deliverable/frame identity, not export number; omit top-level `.tres` UID declarations rather than regenerating UIDs each export, and preserve engine-owned UID sidecars. Consumers reload after export; no transactional hot-game-read guarantee is implied.

Publication is serialized per destination and uses this order:

1. Re-read selected immutable versions and active-selection revisions; verify source hashes, pointer target, and current export ownership. Reject an unowned pointer/manifest or externally modified owned file as `EXPORT_CONFLICT` before touching current. Unrelated files directly under the destination are untouched. Inventory unowned files inside current separately; carry them unchanged to the staging tree without claiming ownership, and fail if a new managed path would overwrite one. Treat Godot-generated sidecars as unowned.
   A missing pointer means no current export: warn, preserve recorded retired releases, and publish a new one only to an unoccupied `current`. A pointer to an unknown release without a recoverable prepared intent is `EXPORT_CONFLICT` even if hashes validate; preserve it and instruct the user to restore the matching project snapshot or choose another destination. Never infer permission to adopt/delete an unknown tree.
2. Write a unique same-filesystem staging snapshot including the complete manifest and carried unowned files, stream copies/encoding, validate all outputs/references, sync, then rename to `.releases/<export-id>`. Record a prepared export intent before publication. Recheck source-current unowned hashes/paths and the prior pointer/manifest before the switch; concurrent edits cause conflict rather than a stale carried copy.
3. Create a temporary sibling relative symlink to `.releases/<export-id>`, then atomically rename it over `current` and sync the destination directory. This is the sole success boundary. Before it, current resolves the prior complete snapshot; after it, current resolves the new complete snapshot. No interval exposes a half-written bundle or a missing pointer.
4. Finalize the DB export receipt. Startup recovers a post-switch crash by matching current's target and manifest hash to the prepared intent. A response lost after commit is recovered as success, never a second export. Failures before the switch preserve the prior current pointer/snapshot; promotion/activation are unaffected.
5. After success, retire the old backing release by deleting every unchanged file explicitly listed in its previous `ownedFiles`, plus its known manifest; remove only empty directories bottom-up with `rmdir`. Never recursively remove unknown files; unowned originals remain untouched even when carried forward, and modified owned files remain with warnings. Startup removes a prepared-but-unswitched release only from that intent's explicit file list (including copies it made), after verifying hashes. Post-switch retirement errors report committed success with recovery warnings. Historical manifests remain in project state; production versions/candidates are never removed by export.

For a package-style selected subset, the next snapshot contains exactly that explicit managed selection; preview lists previously exported assets that will leave current. Reject an empty selection unless explicitly confirmed. Do not silently retain omitted managed versions or infer deletion ownership from directory name. A preset switch also shows which old managed resource types leave the current snapshot.

## Verification — commands, behavior, and evidence

All commands below are **planned new commands**, not claims that they already ran. Execute from `/Users/user/Code/andyhite/brainforge`. Working changes are verified after each milestone; user-facing gates are not replaceable by an automated pass. During planning only Bun/executable discovery and read-only ComfyUI status/inventory checks ran; no generation, build, tests, installs, or project changes were performed.

### Runtime and art proof

At M0 install locked dependencies with Bun, then run the actual media decode/resize/atlas scenario under Bun and perform the explicit art sub-gates:

```sh
bun install
BF_COMFY_URL=http://127.0.0.1:8188 bun run feasibility -- --project /Users/user/Code/andyhite/shit-your-brain-pants --phase brief --plan
BF_COMFY_URL=http://127.0.0.1:8188 bun run feasibility -- --project /Users/user/Code/andyhite/shit-your-brain-pants --phase still --plan
```

The plan output gives the exact trial ID, plan hash, execution disclosure, bounded budget, and next `--submit` command; add `--plan-hash <returned-hash>` to that command and use its durable `--request-id`. Only submit after the user has authorized that exact batch. Repeat the same plan/submit flow for pose and motion after their preceding sub-gate passes. `--phase preview` serves a small local read-only comparison page for the retained trial, including actual packed playback and both fps/three scale choices. Test with the user-started browser, not a static montage alone.

A concrete processing boundary test uses 33 ordered source frames at 16 fps with `exclude-last`: 12 fps output is 24 frames totaling 2000 ms; 16 fps output is 32 frames totaling 2000 ms. Frame 23 of the 12 fps output maps to source frame 30. Alpha in foreground stays opaque and outside silhouette transparent; atlas unpacking reproduces reviewed RGBA pixels and positions, including padding/extrusion boundaries. Use deterministic tiny authored fixtures for these algorithm tests, not a mock of the algorithm's own return value.

### Application and actual agent proof

From M1 onward:

```sh
bun run dev
bun run bf -- project.inspect --project /Users/user/Code/andyhite/shit-your-brain-pants --input '{}' --json
BF_SERVER_URL=http://127.0.0.1:3210 omp --no-extensions -e /Users/user/Code/andyhite/brainforge/packages/omp/src/index.ts
```

Set the named agent token in the process environment without echoing it; human pairing/grant creation happens in the UI. The omp `-e` loading mechanism was inspected in `omp://extension-loading.md:69-124`. Verify actual tool discovery, explicit project addressing from a different CWD, structured denial for unauthorized actions, and actual image blocks visible to the reviewing agent. Use the registered tools to complete M5, not raw HTTP alone.

For browser verification, first check `http://127.0.0.1:9222/json/version`. Attach only to user-started Chrome for Testing at that address; if unavailable ask the user to start `cft`/`cft headless` and wait. Open only task-owned tabs, exercise the real UI, record fresh visual evidence after changes, and close only those tabs. Use 1440×900 and 900×700 layouts plus 200% zoom; keyboard-operate navigation, candidate selection, annotation forms, review, and export. Verify focus restoration, accessible names, light/dark contrast, reduced motion, and persisted inline errors. Do not add a frontend test suite instead of exercising the surface.

At final verification also run `bun run build` then `bun apps/server/dist/index.js` and use the served production SPA at 3210, not only Vite. Start with a test PATH where invoking `node` fails and ensure the server, CLI, Vite/build tasks, and tests still use Bun; Turbo's native binary is permitted. Existing `node:` compatibility imports do not imply a Node.js runtime.

### Repeatable recovery smoke scenarios

Create `scripts/recovery-smoke.ts` as an isolated acceptance harness, not an application feature or production API. It creates an OS-temp snapshot of the source project's completed material, assigns a fresh fixture project ID, excludes live remote jobs/credentials/grants, and uses a local protocol-test server serving retained real media. Inject faults through test-only dependencies when constructing the actual server/storage/scheduler; release server construction never accepts those dependencies from environment, HTTP, UI, or agent input.

Implement named scenarios `collection-restart`, `partial-download`, `processing-restart`, `promotion-failure`, and `export-failure`. Each arms exactly one deterministic pause/failure: after remote receipt before candidate publication; midway through output bytes; after processed staging before publication; before production directory publication; or before the `current` pointer switch. The harness prints the fixture directory and observed hold point, terminates/restarts only its own child backend, releases the hold, and verifies the user-visible state through the real HTTP/CLI and files. It records the injected event as test evidence and never submits to the real ComfyUI URL. This avoids asking the user to race a millisecond filesystem operation or corrupt their actual game.

```sh
bun scripts/recovery-smoke.ts --source-project /Users/user/Code/andyhite/shit-your-brain-pants --scenario collection-restart
bun scripts/recovery-smoke.ts --source-project /Users/user/Code/andyhite/shit-your-brain-pants --scenario partial-download
bun scripts/recovery-smoke.ts --source-project /Users/user/Code/andyhite/shit-your-brain-pants --scenario processing-restart
bun scripts/recovery-smoke.ts --source-project /Users/user/Code/andyhite/shit-your-brain-pants --scenario promotion-failure
bun scripts/recovery-smoke.ts --source-project /Users/user/Code/andyhite/shit-your-brain-pants --scenario export-failure
```

Add scenarios only when their actual milestone behavior exists. M2/M4/M6/M8 gates combine these recovery proofs with their real ComfyUI/user-facing workflows; protocol fixtures are never substituted for live art generation or creative approval.

### Deterministic behavioral suites

Create `packages/core/tests/contracts.test.ts`, `packages/storage/tests/recovery.test.ts`, `packages/comfy/tests/transport.test.ts`, `packages/media/tests/processing.test.ts`, and `packages/export/tests/publication.test.ts` as their behaviors land. Root Turbo tests call each package's `bun test tests`; isolate temporary projects and a local protocol-test ComfyUI server. The test server is for transport failures only, never an application generation option or art acceptance evidence.

```sh
bun test packages/core/tests/contracts.test.ts
bun test packages/storage/tests/recovery.test.ts packages/comfy/tests/transport.test.ts
bun test packages/media/tests/processing.test.ts packages/export/tests/publication.test.ts
bun run test
bun run typecheck
```

| Suite | Consumer-visible cases that must pass |
| --- | --- |
| Core contracts | Incomplete concepts remain explorable; dependency cycles/missing references block only affected production; relevant vs irrelevant edits produce the specified reassessment; required feedback survives candidate replacement; no self-elevation via actor labels/YAML/token scope; agent escalation and human override history; promotion/activation remain distinct; group completeness/version conflicts. |
| Storage recovery | Concurrent stale revisions reject; external YAML edits preserve both versions; restart during each publication boundary yields either complete prior state or complete recorded new state; moved snapshot recovers without application-private specs; missing/corrupt outputs report recovery and never become approved. |
| Comfy transport | Lost response with one matching remote prompt reconciles; no/multiple matches stay unresolved with no second POST; backend restart collects the same candidate; queued cancellation targets only its prompt; running cancellation never interrupts unrelated jobs; bounded attempts persist across restart; partial downloads recover without regeneration. |
| Media processing | Explicit resampling duration/source-frame map, zero/one/noninteger-duration boundaries, alpha polarity, common-canvas/pivot preservation, atlas page/gutter bounds, corrupt/empty files, and external-cleanup lineage. |
| Export publication | Source version immutability; old manifest remains usable on every pre-commit failure; post-commit restart returns recovered success; unowned and externally changed files are preserved; only prior-owned stale files removed; aggregate child version collision refuses; generic/Godot frame counts, names, durations, pivots, resource references, and selected versions agree. |

Verify Godot resource compatibility by opening the generated SpriteFrames, texture, TileSet, and StyleBoxTexture resources in a disposable Godot 4.3+ project and inspecting their actual resource properties/playback. Planning located `/Applications/Godot.app/Contents/MacOS/Godot`; `--version` returned `4.7.2.stable.official.ed1daf0bf`. This is export-format acceptance, not adding an engine test/build/sync capability to Brainforge. If that installation becomes unavailable, complete all other checks but leave the Godot export acceptance gate explicitly unpassed until resource-open proof is performed; do not replace it with a text snapshot assertion.

For the stable-path gate, create one human-owned scene in the disposable Godot fixture referencing `res://assets/brainforge/current/assets/cortex/godot/animations.tres`. Open it, export a distinct approved version, reload the same unchanged resource path, and observe changed playback/metadata without changing that scene's bytes. Verify that `.releases` does not appear as duplicate public assets, and test an unowned file in the destination root plus an engine sidecar inside current; both remain usable after replacement. This exact scenario must pass before declaring the symlink publication strategy compatible with Godot.

### Requirement coverage ledger and final proof

Track each row against the actual milestone evidence and user approval:

| SPEC area | Delivery / proof |
| --- | --- |
| Local application, project selection/storage, movable records, YAML/inheritance/external edits, explicit execution/cost requirements (§56–118) | M0–M2; real directory, snapshot reopen, conflict/invalid YAML exercise, closed-browser and backend-restart job recovery. |
| Exploration, exact recipes, annotations, revision handoff, approval policies/identity/reassessment/limits, preference history (§120–230) | M2–M5; actual candidate variation, spatial/temporal notes, external-agent visual review and correction, required-note resolution, policy/override/preference proof. |
| Branching, intermediate continuation, immutable coherent production, explicit activation, safe exports (§232–268) | M6–M9; A/B branch isolation, idle reuse with changed walk, no implicit activation, failed and successful ownership-safe replacement. |
| Every asset family and environment/UI metadata (§12, §176–194, §268), web UI and complete agent operations/state/concurrency (§270–330) | M1–M13; each family sub-gate through both interfaces and both presets, operation registry coverage, state/action clarity, conflict/recovery/permission tests. |
| First complete character workflow, all eleven numbered steps (§332–358) | M0–M9 repeated in M13 on Cortex: define, agent-author, explore/annotate/iterate, lock, references, idle+walk processed review, one real revision, coherent promote, explicit activate/export, alternative branch, selective animation replacement and export failure/stale-file checks. |

## Assumptions and contingencies

The user's chosen acceptance basis is the actual game's current docs, with legacy specs only as reference; external reviewed cleanup is permitted; compare 12/16 fps before choosing the default. Do not convert archived creative approvals into new approvals. Final numerical framing/pivot/cadence choices are deliberate **user decisions at the specified art gates**, not unspecified implementer decisions.

The user also chose stable export resource paths. The initial atomic publication implementation therefore requires same-filesystem relative symlink support and a Godot-verified reload path; copying a project must preserve those links. Do not substitute versioned public paths or non-atomic overwrites without a new user decision.

The development target is the user's macOS/Bun environment and locally reachable ComfyUI, with portable project-relative data and ordinary exported assets. If the ComfyUI node/model inventory differs, name the missing dependency and keep generation blocked until the user restores it or approves an updated Krea/Wan recipe; do not install software, substitute another model/provider, or drop an asset family automatically.

No hosted-provider credentials or spending authorization are assumed. If the selected ComfyUI workflows require hosted services or leased-compute limits, display their verified requirements and obtain explicit bounded authorization before submitting. Unknown financial cost is not zero. GPU/platform unavailability never becomes a fabricated passing smoke test.

The app does not promise fully automatic art quality. If reference-conditioned changes, alpha, or motion need cleanup, use the agreed traceable cleanup-import path and review the actual workload at M0. If the workflow remains unusable, stop the affected gate with evidence and a bounded next experiment; revising that acceptance boundary requires the user's explicit decision.

The complete product supports all listed families; implementing Brainforge does not mean generating every row of the game's content inventory or adding the game's movement/story systems. Future game content remains ordinary user work in a finished pipeline, not unfinished application functionality.

