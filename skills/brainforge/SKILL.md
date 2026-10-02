---
name: brainforge
description: "Use when the cwd or an ancestor has brainforge/project.yaml, or the user mentions Brainforge, asset specs (project/style/asset YAML), concepts or candidates. Covers the brainforge CLI and YAML authoring."
---

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` are aliases for `MUST NOT` and `SHOULD NOT`.
</system-conventions>

# Brainforge

Local asset-production tool for a game project. Humans review, approve, lock, and promote in the web UI (http://127.0.0.1:3210). You author specs by editing their YAML files, and read state / run operations through the `brainforge` CLI.

<critical>
- NEVER learn the YAML format by hunting the filesystem or guessing. Run `spec.schema` first.
- After every YAML edit, run `spec.read {path}` and fix until `problems` is empty.
- NEVER hand-edit `brainforge/.state/`, any `versions/` or `work/` directory.
- Generation uses the user's GPU, which may be remote. Start jobs only for generation the user asked for: asking you to iterate on a character, concept or deliverable authorizes the plan → start → review → revise loop without per-step grants. Always run `generation.plan` first and show the user the counts and compute disclosure. Stay inside the user's request; NEVER widen it. Details: [generation-review](references/generation-review.md).
- Human decisions (approve when policy requires a human, lock concept, confirm policy, connection settings) are refused for agents. Tell the user to do it in the UI.
</critical>

## CLI

```sh
brainforge <op> --json --input '<json>'   # e.g. brainforge spec.read --json --input '{"path":"brainforge/project.yaml"}'
brainforge --help --json                  # CLI flags + all operations
brainforge <op> --help --json             # input JSON Schema of one operation
```

- You MUST pass `--json` on every `brainforge` call. Default stdout: TTY → human-readable text, non-TTY → JSON; `--json`/`--text` force a format (last flag wins). Format never changes your identity `agent:cli` or authorization.
- With `--json`, stdout is one JSON envelope: `{ok:true,data,nextActions,warnings}` or `{ok:false,error:{code,message,recoveryActions,details?}}`. Non-zero exit on error.
- Large or quote-heavy input: `--input-file <path>` or `--input -` (stdin).
- `--request-id <id>`: idempotency key for mutating ops; reuse it on retry. `--project <abs dir>`: override discovery.
- Images: results with visuals (`review.material`, `revision.inspect`, `candidate.inspect`, `output.inspect`, `history.examples`) add `visualFiles: [{fileId, role, label, path?, error?}]`. Open every `path` with your image reader before judging. An entry with `error` was NOT saved: never claim you saw it.
- `brainforge: command not found` or connection refused: [references/cli-setup.md](references/cli-setup.md).

## Am I in a project?

- The CLI walks up from cwd; the first `<dir>/brainforge/project.yaml` makes `<dir>` the game root. Run it from the game repo.
- No match → "No brainforge/project.yaml found". Ask the user for the game directory, or `project.init` (preview unless `confirm:true`).
- Closed or never-opened project (`PROJECT_NOT_OPEN`) → the CLI opens it and retries once automatically.
- Spec paths are relative to the game root, e.g. `brainforge/assets/cortex/asset.yaml`.

## Operations

Inputs are JSON objects; unknown keys are rejected.

|Group|Operations|
|---|---|
|Project|`project.inspect` (summary, assets, authored files, connection status), `project.init {path, name?, id?, confirm}`, `project.open {path}`, `project.close`, `project.snapshot {destination}`, `project.recent`|
|Specs|`spec.schema {kind:"project"\|"style"\|"asset"}` (authoritative format: pathPattern, JSON Schema, minimal + full examples, conventions), `spec.list` (files + validity + hash), `spec.read {path}` → `{text, hash, problems}`. `spec.validate`/`spec.write` exist for the web UI; you edit the files directly instead.|
|Settings|`settings.inspect {assetId?, deliverableId?}` → effective value per field with source file, requested vs effective policy, conflicts|
|Families|`family.list` (11 profiles: allowed kinds, alpha, motion, required fields, collection role), `family.template {family,id,name,description?}` → starter `asset.yaml` (placeholders `REPLACE:`); both read-only. [families](references/families.md), [environments](references/environments.md), [ui-vfx](references/ui-vfx.md)|
|Assets|`asset.list`, `asset.inspect {assetId}` (yaml path/hash, directories, registered artifacts), `asset.impact {assetId}` (read-only: per branch, which steps need reassessment after an edit and which inputs changed)|
|References|`reference.import {sourcePath \| contentBase64+filename, label, scope:"project"\|"asset", assetId?}`, `reference.list {assetId?}`|
|Workflows|`workflow.list`, `workflow.inspect {workflowId, version?}`, `workflow.preflight {workflowId, version?}` (read-only)|
|Generation|`step.inspect`, `generation.plan` (no submit), `generation.start {planId, planHash}`, `job.list/inspect/reconcile/retry/cancel`, `candidate.list`, `candidate.inspect`, `candidate.favorite` (a marker only, never approval)|
|Review|`annotation.create`, `annotation.update`, `annotation.delete`, `annotation.list`, `revision.list {status}`, `revision.inspect` (images), `revision.create`, `revision.respond`; `revision.resolve/waive` only if the user says so|
|Branches/review|`concept.lock {assetId,candidateId,outputId,inputMode}`, `branch.list`, `step.list`, `candidate.select`, `review.list/material/decide/escalate/history`; `review.override` human only. [branches-review](references/branches-review.md)|
|Continue|`branch.plan` (read-only) → `branch.create {candidateId,outputId?,inputMode,planHash}`, `branch.compare`, `branch.select {assetId,branchId}`. [branches-continue](references/branches-continue.md)|
|Motion|`output.inspect` (frames with source indices), `processing.plan` → `processing.start`, `candidate.export-cleanup` / `candidate.import-cleanup`. See [motion-processing](references/motion-processing.md)|
|History|`history.examples {assetId, stepId?}` (accepted/rejected examples as images), `history.judgments`, `preference.propose/list`. [history-preferences](references/history-preferences.md)|
|Production|`promotion.plan {assetId, branchId?, members?}` (all blockers for the whole bundle; `members` pins versions for an environment aggregate), `promotion.start {planId, planHash, note?}` (promote; does NOT activate), `version.list {assetId}`, `version.inspect {versionId}`, `version.activate {versionId, expectedRevision, acknowledgeObsolete?}`. [production-versions](references/production-versions.md)|
|Export|`export.plan {assetIds?, versions?, confirmEmpty?}` (stores a plan; lists blockers/leaving/conflicts), `export.start {planId, planHash}`, `export.list`, `export.inspect {exportId}`. [export](references/export.md)|
|Completeness|`project.completeness` (read-only): is every required asset (project.yaml `requirements.assets`) complete, i.e. an active version that matches current requirements with nothing awaiting reassessment or unresolved required notes; per-asset state and reasons, review-queue counts, and the separate export status. Call it to answer "what is left?"|
|Human only|`policy.authorize`, `connection.set`, `review.override`, `preference.confirm`, `preference.reject`|

Authored files are only `brainforge/project.yaml`, `brainforge/styles/<style-id>.yaml`, `brainforge/assets/<asset-id>/asset.yaml`. Anything else under `brainforge/` is tool-managed.

## Protocol

1. `project.inspect` + `asset.list`. Read `problems` on every listed spec.
2. First time you write a given kind: `spec.schema {kind}`. It wins over anything else, including the companion references: [project](references/project-yaml.md), [style](references/style-yaml.md), [asset](references/asset-yaml.md). New asset of a non-character family: `family.list`, then `family.template` and write its `text` to the file (never invent kinds/fields).
3. Edit the YAML file with your file tools. Existing file: read it first, keep comments and unrelated fields. New file: start from the `spec.schema` examples or `family.template`.
4. `spec.read {path}` until `problems` is empty (errors block steps; warnings such as `REPLACE:` placeholders need fixing too).
5. If the file changed under you (human in the UI, editor, other agent), re-read it and merge your intent; NEVER overwrite someone else's change.
6. Mutating ops: retries after a timeout MUST reuse the same `--request-id` and identical input. Changed input with the same id → `IDEMPOTENCY_CONFLICT`.
7. Afterwards `settings.inspect {assetId}` shows which file supplies each effective value.
8. Reference images: `reference.import` copies them into the project. NEVER copy files into `assets/` or `brainforge/` yourself.
9. Before you start a generation: `generation.plan`, read `plan.prompt` and `promptSources` in full, check every sentence against "Writing prompt-bearing YAML", fix the YAML, re-plan. Only then ask the user / `generation.start`.
10. Concept chosen: ask the user to lock it (`concept.lock` obeys policy; if refused name the candidate/output for the UI). Then `step.list` shows ready deliverables; plan/start with `branchId` + `stepId`. Review: `review.list` → `review.material` → open its `visualFiles` → judge → `review.decide` (with `requirementsHash`) or `review.escalate`. [branches-review](references/branches-review.md).
10b. Continue from a candidate: `branch.plan` first, choose `inputMode` (`saved` default, `current` after YAML edits), `branch.create` with its `planHash`. Promotion checks CURRENT requirements: saved-input branch → rebase with `inputMode:"current"`. Concepts only via `concept.lock`. [branches-continue](references/branches-continue.md).
11. Motion: an animation step needs its start/end guide poses approved. After generation only SOURCE frames exist: `processing.plan` → read it (sources, frame count, duration, warnings) → `processing.start` → NEW unapproved processed output → `candidate.select` it → review/decide that id. Compare 12 vs 16 fps outputs; one scale anchor per branch. Details: [motion-processing](references/motion-processing.md).
12. Promote: all required deliverables approved → `promotion.plan` → show blockers/plan to the user → `promotion.start` with a fresh `--request-id` (same one on retry). Activate separately: `version.list` → `version.activate` with its `active.revision`; obsolete versions need `acknowledgeObsolete` and a human. Refused → tell the user; never self-authorize. Details: [production-versions](references/production-versions.md).
13. Export: assets need an ACTIVE version. `export.plan` → show blockers/leaving/conflicts to the user → `export.start` with a fresh `--request-id` (same on retry). Public path is `<destination>/current/assets/...`, never with an export id. Unowned files are never overwritten (`EXPORT_CONFLICT`); export never promotes or activates. godot4 needs `export.godotProjectRoot` containing `project.godot`. Details: [export](references/export.md).
14. Families (see [families](references/families.md)): static families (item, icon, tile, background, environment) get no animation; opaque families/deliverables need `output.alpha: opaque`; ui/effect animations write `animation.loop`. Environments: members listed in `collection.members`, children bind `referenceRoles.<n>: {assetId, branchId, role: direction}` to the LOCKED environment branch; the aggregate pins member versions ([environments](references/environments.md)). UI nine-slice, `export.sprites`, effects loop/once: [ui-vfx](references/ui-vfx.md). Opaque workflows are UNVERIFIED on real ComfyUI: say so.

## Writing prompt-bearing YAML

The YAML text IS the image prompt. The model (Krea, cfg 1) obeys what you describe and cannot be told what to avoid.

|Sent to the model|NEVER sent|
|---|---|
|asset `description`, EVERY `identity.*` value (unlabelled), effective `perspective` and `palette`, project `artDirection`, style `palette` entries, a fixed single-figure framing sentence; plus the generated deliverable's own `description` (only that one) or, for an animation, its `animation.motion`|asset `notes`, project `notes`, style `description`, other deliverables' text, names, ids|

`reference-sheet` exception: the reference image supplies identity and style. Only the identity-lock instruction, that sheet's `description`, its `regions[].view` layout and per-run iteration instructions reach the prompt. Asset `description`/`identity`, project art direction, palette and style prose are omitted. MUST describe the requested views, not redescribe or redesign the locked character.

- Describe the picture, not the design process. Put status, proposals, open questions, doc references, lore, setting in `notes`.
- Every feature gets shape + colour + position: "two big round white eyes with dark pupils in the middle of the front of the brain". Never "large integrated eyes".
- Positive phrasing only: no "not", "without", "do not", no mention of things you do not want (it gets drawn).
- No other characters' names, no doc references, no "proposal", "open", "TBD".
- Exaggerate proportions the model undersizes; state ratios relatively: "taller than the whole body below it and about twice as wide as his shoulders".
- One view per concept. front/profile/rear/turnaround wording belongs ONLY in the construction-sheet deliverable `description`, never in `description`, `identity`, `perspective`.
- `perspective`: one short phrase. `palette` entries and `artDirection`: visual phrases only. `identity` values: short concrete sentences about appearance.

## Rules

- YAML objects reject unknown keys. Ids are lowercase kebab-case and equal the directory (asset) or file name (style).
- `project.yaml` rejects URLs, credential-like keys, and absolute or `~` paths. All paths are relative to the game root. ComfyUI URLs are set by the human via `connection.set` in the UI.
- Do not invent fields, families, deliverable kinds, or workflow ids. Use `family.list` and `workflow.list`.
- Take facts from the game's own docs, restate as concrete visuals. Guesses and doc sources go in `notes`, never prompt-bearing fields.
- `approval` in `project.yaml` is a request. Relaxing it does not take effect until the human confirms it (`policy.authorize` is human-only). Never claim a policy changed.
- `requirements.assets` lists required assets. Add an asset id only if the user wants it counted for completeness.
- Denied with `HUMAN_AUTHORIZATION_REQUIRED` → stop, tell the user what to do in the UI.

## Common agent mistakes

- Grepping or guessing the YAML format instead of `spec.schema`; leaving a file with `problems` (check `spec.read` after every edit); dropping deliverables for unknown format; describing images from `visualFiles` labels without opening the files.
- Design-doc prose, negations, or turnaround language in prompt-bearing YAML (it all reaches the model); starting generation without reading `plan.prompt`; trusting the sheet or a variation unseen (front and profile may both come back three-quarter; identity-edit variation ignores "make X bigger" at the default `referenceStrength`: [generation-review](references/generation-review.md)).
- `review.decide` without `review.material` or with a stale `requirementsHash`; claiming human approval; treating escalation or `candidate.select` as approval.
- Locking a concept the user did not choose; deliverable generation without a branch or approved dependency; branching a concept via `branch.create`.
- Approving source frames as an animation; processed frame indices in annotations; per-clip scaling; expecting a changed recipe to edit an old output.
- Promoting a saved-input branch without rebasing; proposing preferences without decision-id evidence.

## Error codes

`INVALID_INPUT` fix the input. `REVISION_CONFLICT` re-read, retry. `NOT_FOUND` check ids/paths via `asset.list`/`spec.list`. `HUMAN_AUTHORIZATION_REQUIRED` human-only action. `PROJECT_NOT_OPEN` handled by the CLI. `IO_ERROR` report to user (server down: [references/cli-setup.md](references/cli-setup.md)).

Trust: requests with a UI Origin are the human; the CLI is agent `agent:cli`. Setup: [references/cli-setup.md](references/cli-setup.md).

<critical>
Recap: `spec.schema` → edit the YAML file → `spec.read` until `problems` is empty; YAML is the prompt: read `plan.prompt` before starting; open `visualFiles` before judging images; never touch `.state/`, `versions/`, `work/`; start only generation the user asked for, after `generation.plan`; respond to revisions, don't resolve them; human-only decisions go to the UI.
</critical>
