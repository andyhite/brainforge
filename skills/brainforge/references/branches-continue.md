# Continue from here: branches, input bases, rebuild only what changed (M9)

## Flow

1. `branch.plan {candidateId, outputId?, inputMode, name?}` (read-only). Returns `planHash`, `kind` (`continue` | `rebase`), `source` (branch, candidate, output, step), `differences` (per-field **saved** vs **current**, each with the steps it `affects`), `reusedSelections` (exact dependency-fingerprint match, with reason), `clearedSelections` (selections built on the source step, rebuilt from the chosen one; or no longer a deliverable), `reassess` (reused selections whose inputs changed: kept but need a fresh review; a `concept` entry means a renewed concept-lock review), `carriedFeedback`, `authorization` (`operation` is `branch.create` or `concept.lock`, plus `allowed`/`reason`) and `blockers`.
2. Choose `inputMode` explicitly:
   - `saved` (default): continue with the inputs the source candidate was generated from (its recorded authored-file texts). If that text is no longer retained → blocker `SAVED_INPUTS_UNAVAILABLE` with a recovery to plan with `current`.
   - `current`: use today's effective YAML. Choose it when you edited the YAML and want the new settings.
   - `kind:"rebase"` is derived, not requested: `inputMode:"current"` on a candidate that is SELECTED in its branch, when that branch was `saved`-mode or its inputs differ from today's. Pick the selected candidate of the furthest-downstream step you want to keep (selections downstream of the source step are cleared, siblings and upstream are kept or flagged).
3. `branch.create {candidateId, outputId?, inputMode, planHash, name?, reason?}` with the plan's `planHash`. Failures: concept candidate → `INVALID_INPUT` (use `concept.lock`); candidate with no branch → `INVALID_INPUT`; agent without a human-granted generation budget → `HUMAN_AUTHORIZATION_REQUIRED`; changed YAML, selections or feedback since the plan → `REVISION_CONFLICT` (re-plan); plan `blockers` → `STEP_BLOCKED`.
4. `branch.compare {assetId, branchIds?}` (read-only): branches side by side (concept, selections, basis, state).
5. `branch.select {assetId, branchId, reason?}` makes a branch the asset's current one. It never changes active versions, approvals or other branches.

## Concept candidates

A concept (unlocked or alternative) can only become a branch through `concept.lock {assetId, candidateId, outputId, inputMode}` under `approval.conceptLock`. `branch.plan` on a concept candidate reports `authorization.operation:"concept.lock"`; `branch.create` refuses concept sources and cannot swap a locked branch's concept. Policy `human` (or a pending, unconfirmed relaxation) → you are refused: ask the user which candidate and output to lock; never retry.

`branch.create` takes a reference or animation candidate of an already locked branch. Humans may always; an agent needs a human-granted generation budget for that asset (`budget.list`).

## What is reused

Reuse is by exact dependency fingerprint, never by filename or asset id. The child branch inherits only upstream selections applicable to the chosen source; downstream selections are cleared. Branches hold selections and reviews, not copied YAML.

## What a change invalidates

|Change|Raw generated output|Processed output + its approval|Nothing|
|---|---|---|---|
|Identity, description, perspective/palette/artDirection, style palette, reference|stale (and descendants)|stale|-|
|One animation's motion|that animation only|that animation only|sibling motions|
|Playback fps, crop, alpha, pivot, packing, trim, scale|kept|stale (new unapproved processed output needed)|-|
|Cross-asset `direction` binding edited, or the named environment branch locks another concept|stale for that deliverable (and descendants); reason names `<asset>/<branch>`|stale|-|
|Display name, `notes`, style description|-|-|yes|

Nothing regenerates automatically; affected steps are flagged for reassessment. Promoted versions never change.

## Feedback

Unresolved required notes carry into a child branch when the same output/step lineage is reused. Notes on abandoned alternative outputs stay in history and do not block an independent fresh concept branch.

## Promotion and rebase

Promotion always checks CURRENT effective requirements. A saved-input branch whose basis differs returns `STEP_BLOCKED` reason `requirements-basis-mismatch` with per-field differences. Rebase: `branch.plan` then `branch.create` with `inputMode:"current"` from the branch's selected candidate; unchanged fingerprints are reused, the rest is marked for reassessment. If the locked concept no longer satisfies current identity, the concept needs a renewed `concept.lock` (user decision under policy) before production. Old versions stay activatable with the obsolete acknowledgement (human), but that does not allow a new incomplete bundle.

## Who may do what

|Operation|Agent|
|---|---|
|`branch.plan`, `branch.compare`, `branch.list`|yes (read-only)|
|`branch.create`|yes with generation authority, locked-branch sources only|
|`branch.select`|yes|
|`concept.lock`|only if `approval.conceptLock` allows agents; otherwise ask the user|
|Promote / activate|per `approval.promotion` / `approval.activation`; see [production-versions](production-versions.md)|

See also [branches-review](branches-review.md).
