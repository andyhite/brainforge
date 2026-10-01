# Production versions: promote, activate, restore (M6/M7)

## Model

- A **version** is an immutable, coherent bundle of ALL required deliverables of one asset on one branch. Its directory `brainforge/assets/<asset>/versions/<versionId>/` holds `manifest.json` and `files/`. NEVER edit or delete it.
- **Promoted** (exists) and **active** (the asset's current selection, the one export uses) are separate. Promotion never activates. Promoting another version leaves the active one unchanged.
- Version ids are immutable; `versionNumber` is a monotonic per-asset display number.

## Promote

1. Finish every required deliverable: a selected PROCESSED output (animations), an approval whose requirements still match, no unresolved required notes.
2. `promotion.plan {assetId, branchId?}` → `plan` with `planId`, `planHash`, one row per deliverable, `blockers`, `capability`. Read-only toward versions; always show it to the user.
3. `promotion.start {planId, planHash, requestId, note?}`. Use a fresh unique `requestId` per promotion; on a lost response retry with the SAME `requestId` and input: you get the same version (`created:false`), never a second one. A stale plan is refused: re-plan.
4. A crash or staging failure leaves no visible half-version and the active pointer untouched.

### Row states and blockers (any one blocks the whole asset bundle)

|state|Meaning|Fix|
|---|---|---|
|`missing`|No selected output for a required deliverable|generate/select it (`step.list`, `candidate.select`)|
|`not-approved`|Selected output has no approval, or approval `rejected`/`escalated`|`review.material` → `review.decide`; wait for the human on escalation|
|`stale-approval`|Requirements or inputs changed since the approval|re-review against current requirements|
|`unresolved-feedback`|Required notes still open|`revision.respond`; human or policy-permitted reviewer resolves/waives|
|`bytes-changed`|Selected output's file hash differs from the approved hash|report `OUTPUT_MISSING`/changes to the user; re-process and re-review|
|`blocked-dependency`|A `dependsOn` deliverable is not ready|fix the dependency first|

Also blocking: empty required-deliverable list, a branch whose requirements differ from current (`requirements-basis-mismatch`), and `capability.allowed:false`.
Environment aggregates: `promotion.plan {assetId, members?}` also lists every collection member's pinned version and adds `COLLECTION_INCOMPLETE`, `MEMBER_UNKNOWN`, `VERSION_NOT_FOUND`, `VERSION_CORRUPT`, `DIRECTION_MISMATCH` blockers; activating the aggregate never changes a child's active pointer. See [environments](environments.md).

## Manifest (`brainforge.production.v2`)

`versionId, versionNumber, assetId, branchId, requirementsHash, specSnapshots` (authored path → sha256), `stepRequirements` (concept + each included deliverable's requirements fingerprint; `requirementsHash` aggregates them), `deliverables` (id, kind, candidate/output ids, `outputHash`, `decisionId`, files, `reusedFromVersionId`), `dependencyVersions`, `references` (selected concept/guides with hashes), `files` (path, sha256, mediaType, size), `reviewDecisionIds, createdBy, createdAt`.

## Reuse of unchanged deliverables

If only the walk changed, the plan row for idle carries `reusesVersionId`: the exact immutable idle files and its applicable approval are carried into the new version without a new candidate. Reuse is by exact hash/fingerprint, never by name.

## Inspect, activate, restore

- `version.list {assetId}` → `versions` (state `active|promoted|superseded`, `matchesCurrent`) and `active {versionId, revision}`.
- `version.inspect {versionId}` → manifest, `differences` against current requirements (`specSnapshots.<path>` entries are informational), activation history, and `problems` (files missing or changed on disk; empty when intact). A version with problems cannot be activated (`OUTPUT_MISSING`).
- `version.activate {versionId, expectedRevision, acknowledgeObsolete?, reason?}`. `expectedRevision` is `active.revision` from the latest `version.list`; `REVISION_CONFLICT` → re-list. Idempotent per `requestId`.
- **Restore** = activate an earlier version with the same operation (event kind `restore`); newer versions stay.
- **Obsolete** (`matchesCurrent:false`): activation needs `acknowledgeObsolete:true` AND human authority (an agent is accepted only when a human confirmed `approval.activation: agent`, and is still recorded by name). It never counts as currently complete. Agents: ask the user.

## Who may do what (`approval.promotion` / `approval.activation`)

|Policy|Agent|Human|
|---|---|---|
|`human` (default)|plan only; start/activate refused `HUMAN_AUTHORIZATION_REQUIRED`|yes|
|`agent`|yes, recorded as agent|yes|
|`agent_with_escalation`|yes; may leave the act to the human|yes|

Promotion and activation policies are independent: an agent that may promote may still be refused activation. YAML `approval` is a request; a relaxation stays pending (`POLICY_PENDING`) until the human confirms via `policy.authorize` (human-only). Never try to self-authorize; tell the user to promote/activate in the Library or confirm the policy.
