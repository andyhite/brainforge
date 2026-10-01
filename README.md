# Brainforge

A local, single-user asset-production workbench for 2D games. You describe an asset in YAML, an AI agent (or you) generates candidates through your own ComfyUI, you review and approve them in a web UI, and Brainforge promotes, activates and exports a coherent, versioned set of PNGs, atlases and (optionally) Godot 4 resources into your game.

Brainforge never generates art by itself. All image and motion generation goes through a ComfyUI server you run (Krea 2 for stills, Wan 2.2 for motion). Brainforge plans, tracks, reviews, processes, versions and exports the results.

- Everything lives inside your game directory, under `brainforge/`. Move or snapshot the project and the history goes with it.
- Humans decide: concept lock, approvals that policy reserves for humans, promotion, activation. Agents author YAML, plan, generate under a budget, review, and respond to notes.
- Full requirements are in [docs/SPEC.md](docs/SPEC.md). Requirement coverage and known gaps are in [docs/COVERAGE.md](docs/COVERAGE.md). A recorded end-to-end run is in [docs/FIRST-CHARACTER-RUN.md](docs/FIRST-CHARACTER-RUN.md).

## Requirements

|Need|Notes|
|---|---|
|[Bun](https://bun.sh) 1.3.14|Runtime, package manager, test runner. Pinned in `package.json` and `.bun-version`. No Node.js needed.|
|ComfyUI reachable over HTTP|Tested with 0.36.0. Needs the Krea 2 Turbo, Wan 2.2 i2v and BiRefNet models plus the Krea2 identity-edit nodes. Check with `workflow_preflight`.|
|FFmpeg / ffprobe (optional)|Only for video-producing workflows. The bundled Wan workflows save PNG frame sequences.|
|Godot 4.3+ (optional)|Only to open the `godot4` export. Not required for generic export.|

macOS is the development target. Stable export paths rely on relative directory symlinks.

## Install and run

```sh
bun install
bun run server        # API + built web UI on http://127.0.0.1:3210
```

Development with hot reload (server on 3210, Vite on 5173, proxying `/api`):

```sh
bun run dev
```

Production build and served UI:

```sh
bun run build
bun run server
```

Open <http://127.0.0.1:3210>. The server only accepts requests whose `Host` is loopback; browser requests from the UI origin are treated as the human.

### Point it at ComfyUI

Set the URL once in the UI (Settings → Connection). It is a machine setting, never stored in the project. For scripts and the feasibility CLI you can use `BF_COMFY_URL=http://127.0.0.1:8188`.

Loopback does not mean free or local compute. The ComfyUI server may be a remote GPU behind a tunnel. Workflows list their compute location and cost description, and generation only runs under a human-granted budget.

### Start a project

In your game repo (the **game root**):

1. In the UI, open Settings and enter the game directory, or let an agent call `project_init` (previews first, `confirm: true` to write).
2. Brainforge creates `brainforge/` (and `brainforge/.gdignore`). It never touches the rest of your game.
3. Author `project.yaml`, a style, and your first asset (see below).

## Using it with an agent (MCP)

`apps/mcp` is a stdio MCP server exposing one tool per operation (`spec_write`, `generation_plan`, `review_decide`, ...). It is a thin HTTP client of the running server.

oh-my-pi, in `~/.omp/agent/mcp.json` (or `<game>/.omp/mcp.json`):

```json
{
  "mcpServers": {
    "brainforge": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/brainforge/apps/mcp/src/main.ts"],
      "env": { "BF_SERVER_URL": "http://127.0.0.1:3210" }
    }
  }
}
```

Claude Code: the same block (without `type`) in the game repo's `.mcp.json`. Start the agent inside the game directory; the project is found by walking up to the first `brainforge/project.yaml`. More in [skills/brainforge/references/mcp-setup.md](skills/brainforge/references/mcp-setup.md).

The agent skill in [skills/brainforge/](skills/brainforge/SKILL.md) documents every tool, the YAML formats and the operating protocol. Without MCP, the same operations are available from the CLI:

```sh
bun run bf -- --list
bun run bf -- spec.schema --input '{"kind":"asset"}' --project /path/to/game
```

## Project layout

```text
<game>/
  brainforge/
    project.yaml                     # sole entry point: art direction, defaults, requirements, policy, export
    styles/<style-id>.yaml
    references/<id>/<file>           # shared reference images
    assets/<asset-id>/
      asset.yaml                     # one asset: family, identity, deliverables
      references/                    # asset-specific references
      work/                          # runs, candidates, reviews (managed)
      versions/<version-id>/         # immutable promoted versions (managed)
    .state/project.sqlite            # authoritative managed records (managed)
    .gdignore
  assets/brainforge/                 # configured export destination
    current -> .releases/<export-id> # atomically switched
```

You and agents author the YAML and references. Brainforge manages `work/`, `versions/` and `.state/`. They are durable project data, not caches: back up or move the whole `brainforge/` tree, or use `project_snapshot`, never copy an open database by hand.

## How the pipeline works

Every asset moves through the same stages. Each stage is gated: nothing advances on its own, and nothing is approved just because it was generated.

```mermaid
flowchart LR
  A[Author YAML] --> B[Explore concepts]
  B --> C[Lock concept]
  C --> D[Reference deliverables]
  D --> E[Stills and motion]
  E --> F[Process]
  F --> G[Review]
  G --> H[Promote]
  H --> I[Activate]
  I --> J[Export]
  G -- notes --> E
```

### Expected steps

1. **Author.** Write `project.yaml` (art direction, sizing, fps, required assets, review policy), a style, and `assets/<id>/asset.yaml` (family, description, identity, deliverables). The YAML text is the image prompt: describe the picture in concrete, positive phrasing. Validate with `spec_validate` before saving; saves use `expectedHash` so concurrent edits surface as a conflict instead of overwriting.
2. **Explore.** Plan a concept batch (`generation_plan` shows the exact prompt, counts and budget). A human grants a budget; then `generation_start`. Compare candidates, favorite, annotate with whole-image, pin or rectangle notes, and request revisions. Variations reuse a selected candidate as an identity reference.
3. **Lock.** A human locks one concept output. This creates a **branch** and unlocks production. A lock is a choice, not a production version.
4. **Reference deliverables.** Only what the family needs. A character gets a front/profile/rear construction sheet and pose guides; a static prop gets none. Each is generated, reviewed and approved before anything depends on it.
5. **Produce.** Generate the required stills and, for animations, Wan clips bound to approved start/end guides. Motion produces **source frames**; those are not yet the deliverable.
6. **Process.** `processing_plan` then `processing_start` crops, scales (one scale anchor per character), resamples to the playback fps, sets pivots and packs atlases. This creates a new, unapproved processed output. Reprocessing never overwrites originals. Corrected frames can round-trip through external editing via `candidate_export_cleanup` / `candidate_import_cleanup`.
7. **Review.** Look at the processed result (light, dark and checkerboard backgrounds, frame stepping, actual atlas playback). Approve, reject, escalate or leave notes. Required notes block completion until resolved or waived by an authorized reviewer. Policy per step decides who may approve: `human`, `agent`, or `agent_with_escalation` (default for production review).
8. **Promote.** `promotion_plan` lists every blocker for the whole bundle (missing deliverable, unresolved note, stale approval, requirements changed). `promotion_start` creates an immutable version. Promotion does not change what is active.
9. **Activate.** A separate, human step selects which promoted version is active. Earlier versions can be restored; activating one that no longer matches current requirements needs an explicit acknowledgement.
10. **Export.** `export_plan` then `export_start` publishes active versions to `assets/brainforge/current/...` as `generic` (PNGs, atlases, JSON metadata) or `godot4` (adds SpriteFrames, AtlasTexture, StyleBoxTexture, TileSet). The switch is one atomic symlink, so the game never sees a half-written export, and files you own in the destination are never overwritten.

Throughout, `project_completeness` answers "what is left?" and `asset_impact` shows which steps need reassessment after a YAML edit. Editing an asset marks only affected steps; it never regenerates or touches a promoted version.

### Humans and agents

|Action|Who|
|---|---|
|Author specs, plan, generate under budget, annotate, respond to revisions|Agent or human|
|Grant budgets, confirm policy changes, set connection, propose-confirm preferences|Human only|
|Lock concept, approve, promote, activate|Per policy; the default requires a human for lock, promotion and activation|

Identity comes from the transport: the browser UI is the human, MCP and CLI calls are agents. This guards against accidents and cross-site requests on a trusted local machine; it is not a sandbox against hostile local code.

### Asset families

`character`, `creature`, `item`, `equipment`, `prop`, `environment`, `background`, `tile`, `ui`, `icon`, `effect`. All share the pipeline above; families differ in which deliverable kinds, alpha behaviour and motion they allow. See `family_list` and [skills/brainforge/references/families.md](skills/brainforge/references/families.md).

## Repository layout

|Path|Purpose|
|---|---|
|`apps/server`|Bun + Hono API, durable scheduler, SSE, serves the web UI|
|`apps/web`|React + Vite review workbench|
|`apps/mcp`|MCP server for agents|
|`apps/cli`|Operation CLI (`bun run bf`)|
|`packages/contracts`|Zod schemas and operation registry (browser-safe)|
|`packages/core`|Operation handlers, pipeline planning, review, branching, promotion|
|`packages/storage`|Project paths, SQLite schema and migrations, atomic file helpers|
|`packages/comfy`|ComfyUI client, workflow descriptors, preflight|
|`packages/media`|Decode, framing, processing, resampling, atlas packing|
|`packages/export`|Generic and Godot 4 export, atomic publication|
|`skills/brainforge`|Agent skill and YAML references|
|`scripts`|`feasibility`, `recovery-smoke`, `audit-operations`|

## Scripts

|Command|What it does|
|---|---|
|`bun run server`|Start the server (API + UI) on 3210|
|`bun run dev`|Server and Vite dev server|
|`bun run build`|Build all workspaces|
|`bun run test`|All package tests (`bun:test`; no live ComfyUI needed)|
|`bun run typecheck`|`tsc` across workspaces|
|`bun run bf -- <operation> ...`|Call any operation from the CLI|
|`bun run audit`|Check every operation has handler, MCP tool, CLI, skill docs and tests|
|`bun run recovery-smoke -- --source-project <dir> --scenario all`|Fault-injection scenarios on a temp copy: restart mid-collection, partial download, promotion and export failure|
|`bun run feasibility -- --project <dir> --phase brief --plan`|Bounded art-proof harness used before the app existed|

## Testing

```sh
bun run typecheck
bun run test
```

Tests use a fake ComfyUI protocol server and synthetic media, so they prove transport, state and file behaviour, not art quality. Real-GPU runs are described in [docs/FIRST-CHARACTER-RUN.md](docs/FIRST-CHARACTER-RUN.md). Godot export compatibility is checked with `packages/export/scripts/godot-verify*.ts` against a local Godot 4.

## Status

Feature-complete against the spec, with gaps listed honestly in [docs/COVERAGE.md](docs/COVERAGE.md): video frame extraction (ffmpeg) is not implemented, the opaque Wan workflow has not run on a real ComfyUI, and some live behaviours are verified only against the fake server.

## License

[MIT](LICENSE)
