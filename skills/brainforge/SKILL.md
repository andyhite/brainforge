---
name: brainforge
description: "Use when the cwd or an ancestor has brainforge/project.yaml, or the user mentions Brainforge, asset specs (project/style/asset YAML), concepts or candidates, or the brainforge MCP server. Covers MCP tools and YAML authoring."
---

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` are aliases for `MUST NOT` and `SHOULD NOT`.
</system-conventions>

# Brainforge

Local asset-production tool for a game project. Humans review, approve, lock, and promote in the web UI (http://127.0.0.1:3210). You author specs (YAML) and read state through the MCP server `brainforge`.

<critical>
- NEVER learn the YAML format by writing drafts or hunting the filesystem. Call `spec_schema`, then dry-run with `spec_validate`.
- ALWAYS pass `expectedHash` to `spec_write`: the `currentHash` from `spec_validate` (or `hash` from `spec_read`); `null` ONLY to create a new file.
- NEVER hand-edit `brainforge/.state/`, any `versions/` or `work/` directory.
- Generation spends the user's GPU. Only start jobs under a human-granted budget (`budget_list`), after showing the plan. Details: [generation-review](references/generation-review.md).
- Human decisions (grant budget, approve, lock concept, confirm policy, connection settings) are refused for agents. Tell the user to do it in the UI.
</critical>

## Tool names

Operations are named `spec_write`, `project_inspect`, etc. (operation name with `.` → `_`). The host adds a prefix; use the exact form your host shows:
- oh-my-pi: `mcp__brainforge_<op>`, called by writing JSON to `xd://mcp__brainforge_<op>` (read that path first for the schema). A wrong form such as `xd__mcp__brainforge_project_inspect` fails.
- Claude Code: `mcp__brainforge__<op>`.

Everywhere else this document uses the bare operation name.

## Am I in a project?

- MCP tools find the project from the working directory: walk up from cwd; the first `<dir>/brainforge/project.yaml` makes `<dir>` the game root.
- Pass `project` (absolute game root) to any tool only to override.
- No match → tools fail with a "no project found" error. Ask the user for the game directory, or `project_init` (preview unless `confirm:true`).
- Closed or never-opened project (`PROJECT_NOT_OPEN`) → the client opens it and retries once automatically.
- Every `spec_*` path is relative to the game root, e.g. `brainforge/assets/cortex/asset.yaml`.

## Tools

Inputs are JSON objects; unknown keys are rejected. Every tool also accepts optional `project` (absolute game root) and `requestId` alongside the operation's own fields.

|Group|Tools|
|---|---|
|Project|`project_inspect` (summary, assets, authored files, connection status), `project_init {path, name?, id?, confirm}`, `project_open {path}`, `project_close`, `project_snapshot {destination}`, `project_recent`|
|Specs|`spec_schema {kind:"project"\|"style"\|"asset"}` (authoritative format: pathPattern, JSON Schema, minimal + full examples, conventions), `spec_validate {path, text}` (dry run → `problems` with line/column/field, `currentHash`), `spec_list` (files + validity + hash), `spec_read {path}` → `{text, hash, problems}`, `spec_write {path, text, expectedHash}`|
|Settings|`settings_inspect {assetId?, deliverableId?}` → effective value per field with source file, requested vs effective policy, conflicts|
|Assets|`asset_list`, `asset_inspect {assetId}` (yaml path/hash, directories, registered artifacts)|
|References|`reference_import {sourcePath \| contentBase64+filename, label, scope:"project"\|"asset", assetId?}`, `reference_list {assetId?}`|
|Workflows|`workflow_list`, `workflow_inspect {workflowId, version?}`, `workflow_preflight {workflowId, version?}` (read-only)|
|Generation|`budget_list`, `step_inspect`, `generation_plan` (no submit), `generation_start {planId, planHash, budgetId}`, `job_list/inspect/reconcile/retry/cancel`, `candidate_list/inspect/favorite`|
|Review|`annotation_create/update/delete/list`, `revision_list {status}`, `revision_inspect` (images), `revision_create`, `revision_respond`; `revision_resolve/waive` only if the user says so|
|Branches/review|`concept_lock`, `branch_list`, `step_list`, `candidate_select`, `review_list/material/decide/escalate/history`; `review_override` is human only. See [branches-review](references/branches-review.md)|
|Motion|`output_inspect` (frames with source indices), `processing_plan` → `processing_start`, `candidate_export_cleanup` / `candidate_import_cleanup`. See [motion-processing](references/motion-processing.md)|
|Human only|`budget_grant`, `budget_revoke`, `policy_authorize {requestedPolicyHash}`, `connection_set {comfyUrl}`, `review_override`|

`spec_write` accepts only `brainforge/project.yaml`, `brainforge/styles/<style-id>.yaml`, `brainforge/assets/<asset-id>/asset.yaml`. Any other path → `INVALID_INPUT`.

## Protocol

1. `project_inspect` + `asset_list`. Read `problems` on every listed spec.
2. First time you write a given kind: `spec_schema {kind}`. It wins over anything else, including the companion references: [project](references/project-yaml.md), [style](references/style-yaml.md), [asset](references/asset-yaml.md) (they mirror `spec_schema`).
3. Existing file: `spec_read` first and edit its `text` (keep comments and unrelated fields). New file: draft from the `spec_schema` examples.
4. `spec_validate {path, text}` until `problems` is empty.
5. `spec_write {path, text, expectedHash: currentHash}` (`null` to create). Check `problems` in the result.
6. `SPEC_CONFLICT`: someone (human, editor, other agent) changed the file. Error `details` carry `currentText` and `currentHash`. Merge your intent into `currentText`, re-validate, retry with `expectedHash = currentHash`. NEVER overwrite blindly. Your rejected text is kept as a draft.
7. Retries after a timeout MUST reuse the same `requestId` and identical input. Changed input with the same id → `IDEMPOTENCY_CONFLICT`.
8. Afterwards `settings_inspect {assetId}` shows which file supplies each effective value.
9. Reference images: `reference_import` copies them into the project. NEVER copy files into `assets/` or `brainforge/` yourself.
10. Before you start a generation: `generation_plan`, read `plan.prompt` and `promptSources` in full, check every sentence against "Writing prompt-bearing YAML", fix the YAML via `spec_write`, re-plan. Only then ask the user / `generation_start`.
11. Concept chosen: ask the user to lock it (`concept_lock` obeys policy; if refused name the candidate/output for the UI). Then `step_list` shows ready deliverables; plan/start with `branchId` + `stepId`. Review: `review_list` → `review_material` → judge → `review_decide` (with its `requirementsHash`) or `review_escalate`. Details: [branches-review](references/branches-review.md).
12. Motion: an animation step needs its start/end guide poses approved. After generation only SOURCE frames exist: `processing_plan` → read it (sources, frame count, duration, warnings) → `processing_start` → NEW unapproved processed output → `candidate_select` it → review/decide that id. Compare 12 vs 16 fps outputs; one scale anchor per branch. Details: [motion-processing](references/motion-processing.md).

## Writing prompt-bearing YAML

The YAML text IS the image prompt. The model (Krea, cfg 1) obeys what you describe and cannot be told what to avoid.

|Sent to the model|NEVER sent|
|---|---|
|asset `description`, EVERY `identity.*` value (unlabelled), effective `perspective` and `palette`, project `artDirection`, style `palette` entries, a fixed single-figure framing sentence; plus the generated deliverable's own `description` (only that one) or, for an animation, its `animation.motion`|asset `notes`, project `notes`, style `description`, other deliverables' text, names, ids|

- Describe the picture, not the design process. Put status, proposals, open questions, doc references, lore, setting in `notes`.
- Every feature gets shape + colour + position: "two big round white eyes with dark pupils in the middle of the front of the brain". Never "large integrated eyes".
- Positive phrasing only: no "not", "without", "do not", no mention of things you do not want (it gets drawn).
- No other characters' names, no doc references, no "proposal", "open", "TBD".
- Exaggerate proportions the model undersizes; state ratios relatively: "taller than the whole body below it and about twice as wide as his shoulders".
- One view per concept. front/profile/rear/turnaround wording belongs ONLY in the construction-sheet deliverable `description`, never in `description`, `identity`, `perspective`.
- `perspective`: one short phrase. `palette` entries and `artDirection`: visual phrases only. `identity` values: short concrete sentences about appearance.

## Rules

- YAML objects reject unknown keys. Ids are lowercase kebab-case and equal the directory (asset) or file name (style).
- `project.yaml` rejects URLs, credential-like keys, and absolute or `~` paths. All paths are relative to the game root. ComfyUI URLs are set by the human via `connection_set` in the UI.
- Do not invent fields, families, deliverable kinds, or workflow ids. Use `workflow_list` for real workflow ids.
- Take facts from the game's own docs (`docs/` in the game repo), then restate them as concrete visuals. Record guesses and doc sources in `notes`, never in prompt-bearing fields. Asset and project `notes` and style `description` are documentation only.
- Author the deliverables the user needs.
- `approval` in `project.yaml` is a request. Relaxing it does not take effect until the human confirms it (`policy_authorize` is human-only). Never claim a policy changed.
- `requirements.assets` lists required assets. Add an asset id only if the user wants it counted for completeness.
- Denied with `HUMAN_AUTHORIZATION_REQUIRED` → stop, tell the user what to do in the UI.

## Common agent mistakes

- Wrong tool-name prefix (see Tool names).
- Grepping the filesystem or repo for the schema instead of calling `spec_schema`.
- Probing with junk `spec_write` calls to see validator errors; use `spec_validate`.
- Dropping deliverables from an asset because the format was unknown.
- Writing YAML as design-doc prose (abstract features, status, doc references, lore, other characters' names) or with negations ("without X" draws X): all of it ends up in the prompt; move to `notes`.
- Turnaround/front-profile-rear language in `description`/`identity`/`perspective`: the model draws several figures.
- Starting a generation without reading `plan.prompt` and `promptSources` first.
- Calling `review_decide` without `review_material` first, or with a stale `requirementsHash`; asserting human approval for your own decision; treating escalation or `candidate_select` as approval.
- Locking a concept the user did not choose; expecting deliverable generation without a branch or approved dependency.
- Approving source frames as an animation; annotating processed frame indices (use source indices); per-clip scaling; expecting a changed recipe to edit an old output.

## Error codes

`INVALID_INPUT` fix the input. `SPEC_CONFLICT` merge (step 6). `REVISION_CONFLICT` re-read, retry. `NOT_FOUND` check ids/paths via `asset_list`/`spec_list`. `HUMAN_AUTHORIZATION_REQUIRED` human-only action. `PROJECT_NOT_OPEN` handled by client. `IO_ERROR` report to user.

Trust: requests with a UI Origin are the human; this MCP server is agent `agent:<name>`. Setup: [references/mcp-setup.md](references/mcp-setup.md).

<critical>
Recap: `spec_schema` → `spec_validate` → `spec_write` with `expectedHash`; YAML is the prompt: read `plan.prompt` before starting; never probe with writes; never touch `.state/`, `versions/`, `work/`; start only under a human budget; respond to revisions, don't resolve them; human-only decisions go to the UI.
</critical>
