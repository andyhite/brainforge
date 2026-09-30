# Brainforge Product Specification

**Status:** Agreed product direction, with implementation choices still open.  
**Updated:** September 30, 2026

Brainforge helps a user go from an empty game project to a complete, consistent library of 2D visual assets through a managed and repeatable pipeline. YAML specifications describe the desired results. A web UI and external agent tools operate the same pipeline.

This document consolidates the target product discussed in this project. It replaces earlier product assumptions for this planning effort. Brainforge v2 will be a replacement implementation, using selected v1 components where useful. V1 contracts are historical reference and do not carry forward by default. This document does not itself authorize code removal or other implementation changes.

## Product scope

Brainforge supports characters, creatures, animations, items, equipment, props, environment pieces, backgrounds, tiles, UI elements, icons, and visual effects. It is generic across games, genres, and visual styles.

The product owns asset specifications, generation jobs, candidates, review feedback, branches, production versions, and exports. It should make the next useful action clear at every stage.

Generation runs through ComfyUI using Krea 2 Turbo for still images and Wan 2.2 for animation. Krea 2 Turbo is a model choice; the Krea hosted API is outside the target scope. Routine image and animation processing can use conventional local code.

ComfyUI is the sole generation submission interface. This does not guarantee local execution or zero hosted costs. Before a workflow is used, its execution location, required credentials, and compute or hosted-cost requirements must be explicit, including those of the selected Krea 2 Turbo workflow. Brainforge does not add a separate hosted-provider integration.

The game engine assembles levels and implements gameplay. Brainforge produces environment assets with metadata describing their intended use, such as layer, pivot, relative scale, tiling, or parallax. An environment can group related assets under one visual direction without defining an assembled level.

### Outside the current scope

- Audio, music, dialogue production, and 3D assets.
- Level editors, level compilation, scene assembly, traversal checks, and gameplay code generation.
- Direct engine synchronization, engine tests, game builds, and release support.
- Rights management, licensing gates, and compliance workflows.
- A separate validation product or extensive validation framework. Basic input, file, job, and packaging checks remain part of normal operations.
- Generation submission interfaces other than ComfyUI.
- An embedded AI assistant, model training system, or general visual workflow editor.

## Core workflow

**Define project → define and explore an asset → lock a concept → produce and review → promote → activate → export**

Definition and exploration form a loop. Production and review also form a loop. Users can annotate results, revise specifications, and try another candidate throughout the process.

The common terms are:

| Term | Meaning |
| --- | --- |
| Project | The game directory and its shared art direction, defaults, asset requirements, and pipeline history. |
| Specification | Authored YAML describing the project, an asset, shared style, or production requirements. |
| Job | A tracked execution attempt, including its inputs, progress, outputs, and failure information. |
| Candidate | A generated or processed option tied to the inputs that produced it. |
| Annotation | Feedback attached to a particular image, region, animation frame, or frame range. |
| Branch | A line of development with its own selected references and downstream results. |
| Approval | A recorded decision that a particular result satisfies a step's requirements. |
| Production version | An immutable bundle of approved deliverables created through promotion. |
| Active version | The production version currently selected for an asset's default export. |

Concept locking establishes creative direction for a branch. Approval allows a result to satisfy a pipeline step. Promotion makes finished deliverables a production version. Activation selects a production version for default export. These are separate actions.

## Project definition and storage

### Local application

Brainforge initially runs as a local, single-user application with a browser-based UI. A local backend owns access to explicitly opened project directories and executes operations. Hosted application deployment, browser-only filesystem access, and multi-user collaboration are outside the initial scope.

Jobs continue when the browser tab closes. After a backend restart, interrupted jobs are reconciled with saved records and ComfyUI state. The UI and tools report whether work is still running, completed, failed, or has an unresolved outcome; uncertain submissions are not blindly resubmitted.

### Select the game directory

Project setup begins by selecting the actual game project directory. The web UI displays that directory in project settings. Agent tools can target it explicitly, without depending on the agent's current working directory.

All authored specifications and portable project material belong in the game directory: configuration, styles, references, project-specific workflows, candidates, annotations, reviews, branch history, and production versions. Exports are written to a configured destination within that directory.

Brainforge's installation is separate from the game project. Opening an existing game directory must recover its Brainforge state without relying on an application-private copy of the specifications. Application preferences may remember recently opened directories; they are not the authoritative project record.

Paths within the project should be relative so the project can be moved. Selecting a directory resolves the project root; the export destination is interpreted relative to that root.

Machine-specific connection settings and credentials are separate from portable project records. Project files preserve workflow choices and execution requirements without embedding secrets or assuming that another machine has the same ComfyUI address. A moved project retains its history and may require local connection setup before new generation.

Proposed layout, with exact names still open:

```text
my-game/
  brainforge.yaml
  brainforge/
    specs/
    references/
    workflows/
    candidates/
    reviews/
    production/
  assets/
    brainforge/
```

### Shared settings

Project configuration owns defaults that should not be repeated in every asset:

- Shared art direction, styles, palettes, and visual references.
- Perspective and scale conventions.
- Asset dimensions or sizing defaults appropriate to each asset family.
- Default exported animation playback frame rate.
- Transparency, pivot, and sprite packaging conventions.
- Environment layer names and their intended roles.
- ComfyUI workflow selections and execution requirements, with connection details resolved from local settings.
- Approval policies and limits on automated generation retries.
- Export preset and destination.

Asset specifications inherit applicable project defaults. An asset can declare an explicit exception when necessary. The UI and tools expose effective values and their source.

The desired output frame rate is separate from a model's native generation frame rate. Processing must make any conversion explicit and preview the result at its exported playback rate.

Changes to shared settings identify affected work. They do not silently regenerate assets, rewrite previous runs, or replace production versions.

### YAML as the authored source of truth

Humans and external agents can directly write and modify YAML. The UI reads and edits those same files. External edits become visible without maintaining a second authoritative copy inside the application.

Character specifications focus on that character: appearance, distinguishing features, behavior conveyed through motion, references, required views, expressions, and animations. Other asset families follow the same principle of describing their own identity and deliverables.

An initial concept specification can be incomplete for production. Missing production details should block only the steps that need them. Invalid YAML produces a clear, actionable error without destroying existing work.

Generated records, review decisions, branch selections, and production history are managed through Brainforge operations rather than hand-edited by agents.

## Definition and concept exploration

Concept development is expected to be heavily agent-driven, with the user providing direction and visual feedback.

The working loop is:

1. The user and agent establish or revise the asset description.
2. The agent or user starts a batch of concepts.
3. The user compares candidates, keeps favorites, and annotates results.
4. The agent reads the feedback and decides which specification edits or candidate-specific changes are appropriate.
5. Another generation explores the revised direction.
6. The loop continues until a concept is selected and locked.

Exploration supports fresh batches, variations based on a selected candidate, and retained alternatives. It does not require setting up every production deliverable first.

Feedback distinguishes persistent direction from a correction to one result. “This character always wears oversized gloves” may become a specification requirement. “This glove has an extra finger” remains feedback on that candidate unless a broader change is appropriate.

Each generation records its exact specification snapshot, resolved project settings, references, workflow, model settings, and seed where available. Current YAML remains editable while previous results retain their original context.

Locking a concept records the selected reference and its context and starts a production branch. It does not require prior promotion.

## Visual annotations and revision requests

Annotations are a core part of concept exploration and production review. Every relevant visual review surface should support them.

The initial annotation tools should include:

- Whole-image comments.
- Pins and rectangles with attached notes.
- Notes on individual animation frames.
- Notes covering a frame range, such as a period of foot sliding.

Each annotation records the exact candidate and visual output, author, text, region where relevant, and frame or time reference where relevant. Region coordinates retain enough information to locate the same area regardless of preview scaling.

Original images remain intact. Annotated previews are derived review material. An annotation stays attached to the version it describes when a newer candidate is generated.

Annotations and approval are independent. A user can leave exploratory notes without rejecting a candidate and identify which comments require a revision.

Unresolved feedback marked as requiring revision blocks completion of the affected step until an authorized reviewer records that it has been addressed or explicitly waives it with a reason. Starting another generation alone does not resolve the feedback.

### Handoff to an external agent

Requesting a revision creates a persistent request that agent tools can retrieve. It contains:

- The candidate, branch, and step being revised.
- Original images or relevant animation frames.
- An annotated preview.
- Notes and their spatial or temporal references.
- Applicable specifications, shared settings, and locked references.

The agent can update authored specifications, provide iteration-specific instructions, and invoke generation. Brainforge records which request and feedback were used for the next attempt and whether the requested changes have been addressed or still need review.

This handoff must work without an embedded agent or direct chat connection. Exact notification or polling transport is an implementation choice. When no agent is connected, requests remain available and the UI clearly shows that they are waiting.

## Production pipelines

Asset families use a small set of built-in pipelines. Users select the deliverables they need; routine work should not require authoring a workflow graph.

| Asset family | Example outputs and steps |
| --- | --- |
| Characters and creatures | Concept, required reference views, poses, expressions, animations, sprite packaging. |
| Items and props | Concept, views, variants, optional animation, packaging. |
| Environments | Shared visual direction, backgrounds, layers, tiles, modular pieces, placement metadata. |
| UI and icons | Visual direction, individual elements, states or variants, packaging. |
| Visual effects | Visual reference, still assets or animation sequences, packaging. |

Only necessary steps appear. A static prop does not inherit a character's animation workflow. A turnaround is required only when a downstream operation needs it.

Approved inputs enable dependent steps. Independent deliverables can proceed separately. A failed step can be retried without repeating already completed work.

All generative image and motion work goes through ComfyUI. Brainforge handles references, submission, progress, results, and retry information. Conventional processing handles tasks such as cropping, transparency preparation, frame extraction, resizing, and atlas packing as appropriate to the pipeline.

Review includes the processed result that will be exported. A visually acceptable raw clip does not establish that its extracted and packaged animation is usable.

Repeatability means preserving the recipe and its dependencies. Byte-identical results from every repeated model execution are not assumed.

## Human and external agent approval

Humans review through the web UI. External agents review through tools. Both use the same operations and produce recorded decisions with their reviewer identity and reasons.

Each review step supports these policies:

- **Human:** a person must approve.
- **Agent:** an authorized external agent may approve.
- **Agent with escalation:** an agent may approve clear results and refer uncertain decisions to a person.

The starting default is human concept locking and agent review with escalation during production. Promotion and activation each require explicit authorization and initially default to human actions; either can be delegated to an agent by the user.

The operation layer determines reviewer identity and permissions from the caller's authorization context. A caller-supplied reviewer label is not authorization. An agent cannot identify itself as a human, grant itself promotion or activation authority, or relax its own approval policy. Policy changes require explicit user authorization. Direct YAML editing does not bypass this rule: a changed policy is not effective until that authorization is established.

Brainforge does not contain the reasoning model for approval. An external agent, including one running in oh-my-pi, retrieves the relevant visuals, specifications, references, and feedback and records its decision through tools.

Review considers asset identity, consistency with the locked concept and project style, fulfillment of the requested output, and practical usability. The goal is useful visual review, without a separate compliance process.

A human can override an agent decision. Overrides and previous decisions remain in history. An agent decision is identified as an agent decision, never as a human confirmation.

An approval applies to the exact reviewed output and the requirements used to assess it. Relevant changes to an asset specification, project defaults, references, or processing settings mark the approval as needing reassessment for current work. Historical decisions remain intact. Newly processed output requires review before it can satisfy the step. For example, a costume change affects identity review, while a frame-rate change affects review of processed animation playback. Unrelated edits need not invalidate every approval.

Previously promoted versions remain immutable and available. The UI distinguishes their historical approvals from whether they satisfy current requirements.

Automated generation loops have explicit attempt or resource limits and a condition for returning to the user. A rejected result must not cause indefinite regeneration.

## Learning from human preferences

Brainforge retains selections, rejected alternatives, annotations, approval reasons, and overrides as a project-specific review history.

Tools let an external agent retrieve relevant examples when revising specifications or reviewing new work. The history should support comparisons between accepted and rejected candidates, rather than retaining only isolated approval labels.

An agent may propose persistent preferences based on repeated feedback. The user can confirm or correct them. Preferences remain scoped to a project or style unless deliberately shared.

The initial approach is retrieval of examples and explicit preferences. Model fine-tuning is outside the initial scope. Whether this history improves review enough to increase automatic approval must be assessed against human decisions; learning the user's taste is a capability to develop, not a guaranteed outcome.

## Branches and changes to earlier decisions

Users can select an earlier candidate and choose **Continue from here**. Brainforge creates a branch with its own selected references, downstream outputs, and reviews.

Branches preserve selected inputs and results rather than independent editable copies of every YAML file. Each run captures its effective specification. Continuing from an earlier result explicitly identifies which saved inputs are reused and which current settings apply. The UI and tools expose that resolved choice before generation so an older concept cannot silently acquire unexpected new defaults.

Existing branches and promoted versions remain available. The UI makes the current branch clear and supports comparison between alternatives.

For example, concept A may already have a turnaround and finished animations. Continuing from concept B preserves A's work and starts B's dependent production steps. B does not inherit approvals for outputs generated from A.

Every result retains its exact dependencies. A changed upstream selection identifies the steps that need rebuilding. Outputs may be reused only when their inputs remain applicable; similar filenames or asset IDs are insufficient.

The same behavior applies when returning to an intermediate reference or animation candidate. Branching must not require the user to understand version-control terminology.

## Promotion and export

Promotion creates an immutable production version from approved, processed deliverables. Activation is a separate explicit selection, which the UI may offer together with promotion. Generating, approving, or promoting an alternative never implicitly changes the active version.

A character version can bundle selected references, animations, frame files or atlases, playback information, pivots, and other required metadata. The version identifies the exact source candidates, specification snapshots, and dependencies.

Changing one animation creates a new coherent character bundle that reuses unchanged deliverables whose approvals and dependencies remain applicable. It does not require regenerating everything or modifying the earlier bundle.

The default promotion unit is an asset and its required deliverables. For grouped assets, exact grouping behavior remains to be specified. The product must prevent an apparently complete version from silently omitting required deliverables.

Earlier production versions can be selected again without deleting newer ones. A failed promotion leaves the previous active version intact.

### Export behavior

Exports package selected promoted versions. The default selection is the active version of each chosen asset. A manifest records which versions were included.

The generic format provides ordinary image or animation files and engine-neutral metadata. A Godot-compatible preset provides an appropriate file layout and metadata or resource packaging. Its exact contract remains an implementation decision.

Exports go to the configured path in the selected game project and update only Brainforge-owned files. A failed export leaves the previous complete export usable; replacement must not expose a partially updated bundle as the completed export. Files no longer included are removed only when the previous export manifest identifies them as Brainforge-owned. Unowned path conflicts are reported without overwriting human-authored scenes, scripts, or unrelated assets.

Export is separate from promotion. If export fails, the production version remains available for another export attempt. There is no direct engine synchronization, scene assembly, game build, or release step.

Environment metadata can include intended layer, pivot, relative scale, tile dimensions, connection information, seamless axes, and parallax hints when relevant. Placement and level assembly remain in the game engine.

## Web UI and agent tools

### Web UI

The web UI is the primary human interface. Its main surfaces are:

- Project selection, shared settings, and art direction.
- A project overview of required assets and progress.
- Concept exploration and candidate comparison.
- Asset production steps and visual previews.
- Annotation, revision requests, and a review queue.
- Branch and production-version history.
- The promoted library and export controls.

Each asset view explains the current result, active work or blocker, and next available actions. Jobs show progress and failures with useful recovery actions. Effective inherited settings are inspectable without exposing ComfyUI internals during routine work.

Project completeness means that all declared required assets and deliverables have selected production versions that satisfy current requirements. Approvals awaiting reassessment and unresolved required revisions prevent affected work from being shown as complete. Export status is shown separately.

### External agent operations

An oh-my-pi agent must be able to operate the complete pipeline within its granted permissions. No essential operation may exist only as an interactive UI gesture. This is operation parity, not permission parity: a tool can expose an operation and return “human authorization required” when the caller lacks authority.

| Capability | Required behavior |
| --- | --- |
| Open or initialize a project | Target an explicit game directory and inspect effective settings. |
| Read and edit specifications | Work directly with project YAML, including shared styles and asset requirements. |
| Inspect progress | Retrieve assets, steps, dependencies, blockers, and available next actions. |
| Generate | Start a specified step with selected references and iteration instructions. |
| Track jobs | Retrieve progress, outputs, errors, and available retry or cancellation actions. |
| Retrieve review material | Access actual visuals, annotated previews, specifications, references, and relevant review history. |
| Handle feedback | Retrieve pending revision requests, record responses, and associate follow-up work. |
| Record decisions | Approve or reject with reasons and identity established by the authorization context, subject to project policy. |
| Select and branch | Lock concepts and continue from earlier candidates. |
| Manage production versions | Promote authorized results and explicitly activate new or earlier versions when authorized. |
| Export | Package selected production versions into the configured game directory. |

The UI and tools share one operation layer and enforce the same rules. Direct YAML editing is supported; pipeline state changes go through operations.

Long-running calls return job identifiers so agents can inspect them later. Tool results are structured and include actionable errors. Retrying a request after a connection interruption should not accidentally create duplicate generation work or promotions.

A CLI with structured output, wrapped as oh-my-pi tools, is the proposed initial interface. Whether an additional API or MCP adapter is useful remains open. Multiple independently implemented operation layers are unnecessary.

## Minimum state model

Keep persisted concepts small and derive overview status from actual steps and decisions.

| Record | Essential information |
| --- | --- |
| Authored specification | Current YAML and identity. |
| Run and job | Saved inputs, execution state, results, and failure details. |
| Candidate | Output files and the run and references that produced them. |
| Branch | Selected concept or intermediate candidate and downstream selections. |
| Annotation and revision request | Exact visual target, feedback, author, and follow-up state. |
| Review decision | Candidate, decision, reviewer, reasons, and applicable requirements. |
| Production version | Immutable deliverable bundle and exact source dependencies. |
| Active selection | Production version selected for an asset. |
| Export record | Destination and manifest of exported versions. |

Steps need to distinguish blocked, ready, running, awaiting review, complete, and failed work. Failed work includes a reason and recovery action. A completed step identifies its selected result, an approval applicable to current requirements, and no unresolved revision-required feedback. Relevant changes return affected work to reassessment without erasing its history.

Simultaneous UI and agent activity must not silently overwrite authored changes or apply a decision to the wrong revision. The technical mechanism is an implementation choice.

## First complete character workflow

### Prove the art pipeline first

Before implementing the full application, exercise the chosen ComfyUI workflows on one representative character. Produce a still reference and idle and walk animations, process them into the intended export format, and inspect them at target scale and playback rate.

Assess background removal and transparency, consistent framing, stable scale and pivots, loop boundaries, and preservation of character identity. Record required manual intervention, workflow settings, execution and cost requirements, and known limitations. An attractive generated clip alone does not establish a usable game animation.

This feasibility check precedes the full UI, branch management, and review queues. Its findings must inform pipeline design; if the outputs are not usable, resolve or explicitly bound those limitations before building the full management system. It is part of the first character workflow and does not reduce the target asset scope.

### Demonstrate the complete workflow

The first end-to-end implementation should demonstrate a character with idle and walk animations:

1. Select the game directory and define project defaults and art direction.
2. Have an external agent author the initial character specification.
3. Generate concepts, annotate results, and iterate between specification edits and exploration.
4. Lock a concept and establish its production branch.
5. Generate and approve only the reference views needed by the requested animations.
6. Generate idle and walk motion through ComfyUI, process the frames, and review exported playback previews.
7. Request and complete at least one revision through annotated feedback and external agent tools.
8. Promote the approved deliverables as a coherent character version and explicitly activate it.
9. Export into the configured game directory.
10. Continue from another concept candidate, preserve the first branch, and promote an alternative without changing the active version until explicitly activated.
11. Change one animation, reuse applicable unchanged deliverables in a new production version, and verify that export replacement removes only previously owned stale files and preserves the previous complete export on failure.

This establishes the common operations before expanding asset-family pipelines. It does not reduce the target scope to characters.

## Existing implementation to reuse or simplify

The current checkout at `~/Code/andyhite/brainforge` was inspected as reference material. The rebuild will replace v1. Before removing code, preserve a read-only v1 snapshot containing its useful workflows, examples, and recorded observations. Components listed below are reuse candidates; their existing contracts and architecture do not carry forward by default.

| Existing capability | Target treatment |
| --- | --- |
| Project-local YAML and specification loading | Keep the file-based approach; add explicit project selection and shared output defaults. |
| Saved specifications, prompts, workflows, and model settings | Preserve enough context for repeatable generation and branching. |
| Krea 2 Turbo and Wan 2.2 ComfyUI workflows | Use as starting points and retain useful operational knowledge. |
| Image processing, frame extraction, atlases, and previews | Reuse where they meet the simplified output requirements. |
| Review history and reviewer identity | Keep; add spatial and temporal annotations and permit authorized agent approvals. |
| Environment layer, tiling, and parallax metadata | Keep relevant export information. |
| Versioned production assets and active selections | Preserve explicit promotion and recovery behavior. |
| Human-only approval attestations | Replace with the agreed human or external-agent policy. |
| Provider abstractions and configuration surfaces | Reduce to what the chosen ComfyUI workflows need. |
| Godot synchronization, level compilation, rights and release tooling | Exclude from the target product. |

Useful repository references:

- `packages/core/src/workflows/init-project.ts` and `packages/core/src/specs/spec-repository.ts`: project files and specification loading.
- `packages/schemas/src/config.ts` and `packages/core/src/config/loader.ts`: existing configuration behavior.
- `packages/schemas/src/generation.ts`: saved generation inputs.
- `packages/schemas/src/review-event.ts` and `packages/core/src/services/review-service.ts`: decisions and current human-only restrictions.
- `packages/review/src/` and `packages/image/src/`: review material and processing.
- `fixtures/comfy/` and `packages/render/src/comfyui/`: workflow definitions and execution.
- `docs/live-provider-tests.md`: recorded model runs and observed visual limitations.

Repository inspection confirmed these foundations in source and documentation. No live generation or end-to-end verification was performed while drafting this specification.

## Remaining implementation decisions

The following choices remain open without changing the product direction:

- Exact YAML schemas, folder names, and supported asset-specific overrides.
- Exact ComfyUI workflow versions and processing settings for each deliverable.
- Initial oh-my-pi tool packaging and revision-request notification mechanism.
- Generic export metadata and the Godot-compatible export contract.
- Promotion boundaries for grouped environment assets and other collections.
- How relevant human feedback is selected for an agent's review context.

The next engineering specification should resolve these choices around the first complete character workflow. Existing complexity should be carried forward only where it serves a requirement in this document.
