# Concept lock, branches, step states and review decisions (M3)

## Concept lock and branches

- Concept candidates are exploration only. They are never reviewed with `review_*` (that returns `INVALID_INPUT` pointing at `concept.lock`).
- `concept.lock {assetId, candidateId, outputId, name?, reason?}` pins the exact output hash and the requirements hash into a **branch**. It is not a production version. Locking again makes another branch; earlier branches keep their work.
- Authority follows `approval.conceptLock` (default `human`). As an agent you are refused with `HUMAN_AUTHORIZATION_REQUIRED` (or `POLICY_PENDING` while a relaxation awaits human confirmation). Do NOT retry or work around it: tell the user which `candidateId` and `outputId` to lock in the web UI.
- Only lock what the user chose, and only if policy lets you.
- `branch.list {assetId}`: branches with locked concept output and per-deliverable selections.
- `candidate.select {branchId, deliverableId, candidateId, outputId?}` picks a branch's output for a deliverable. Selection is NOT approval.
- Continue from any candidate (`branch.plan` → `branch.create`, `branch.compare`, `branch.select`, saved vs current inputs, rebase): [branches-continue](branches-continue.md). `concept.lock` also takes `inputMode`.

## Step states (`step.list {assetId, branchId?}`)

`blocked | ready | running | awaiting_review | complete | failed`. Steps: `concept`, then one per deliverable, in dependency order.

- A deliverable step is `ready` only if a branch exists AND every `dependsOn` deliverable has a selected output with an **applicable** approval; blockers name the unmet dependency. Independent deliverables are ready independently.
- `awaiting_review`: candidates exist but the selected/any output has no applicable decision, or an escalation is pending.
- `complete`: selected output has an applicable approval AND no unresolved required revision note.
- A static asset with no sheet/animations authored has only concept → its stills. Never expect reference steps it did not declare.
- Cycles, duplicate ids, missing dependency ids and a deliverable called `concept` are reported on the affected steps only.
- Generation: `generation.plan`/`generation.start` accept a deliverable `stepId` plus `branchId`, only when the step is `ready`. An animation step is ready once its guide poses are approved; its generated source frames never complete it, only an approved processed output does. See [motion-processing](motion-processing.md).
- A `reference-sheet` candidate's `regions` are cropped into separately hashed outputs; they are shown in `review.material.visuals` and used as references for dependents.

## Review loop

1. `review.list {assetId?, stepId?, filter, limit?, offset?}`; `filter` is `awaiting`, `escalated`, `needs-revision` (unresolved required notes), `overridden` (human reversed a decision), `decided`, or `all`. Items are `{candidate, kind, escalation?}` with `kind` one of `awaiting-review|escalated|needs-revision|overridden|decided`; `total` counts all matches.
2. `review.material {candidateId, outputIds?}`: returns the prompt, deliverable description, references, `requirementsHash`, `reviewPolicy`, `you` (`canDecide`, `canEscalate`, `canOverride`, `why`), decision history, and `visuals` (saved as `visualFiles`, sheet crops included; open every `path`). Do not decide on a visual whose entry has `error` instead of `path`.
3. Judge each output against the deliverable description, effective requirements and the exact prompt.
4. Sure: `review.decide {candidateId, outputIds, requirementsHash, decision:"approve"|"reject", reasons}`. `requirementsHash` MUST be the one just returned; rejecting needs at least one concrete reason (what is wrong, where).
5. Unsure (policy `agent_with_escalation`): `review.escalate {candidateId, outputIds, reason}`. It waits for a human, is not approval, and blocks further agent decisions on that output.
6. `review.history {candidateId}`: every decision, override, escalation with actor and reasons.
7. After a rejection, do not regenerate automatically: change YAML / iteration instructions and start a new plan.

## Authority (enforced against actor type, never labels in YAML)

|`approval.productionReview`|human|agent|
|---|---|---|
|`human`|decide, override|`review.decide` refused (`HUMAN_AUTHORIZATION_REQUIRED`): ask the user. Check `review.material.you.canEscalate` before escalating.|
|`agent`|decide, override|decide (recorded as agent)|
|`agent_with_escalation`|decide, override (also settles an escalation)|decide or escalate|

- `approval.conceptLock`: same values, applied to `concept.lock`.
- `review.override` is human only: adds a later `override` row that supersedes the standing decision; the earlier row stays and the approval reports `overridden:true`. Reasons required.
- A policy relaxation in YAML is only a request until the human confirms it (`POLICY_PENDING` meanwhile).
- Your decision is stored and shown as `agent`. Never tell the user it was human-approved.

## Staleness

A decision is applicable only if its `requirementsHash` equals the current one AND its `outputHash` equals the output's current bytes hash. Otherwise the approval is `applicable:false` with a `staleReason` and the step needs reassessment; nothing regenerates automatically. The hash covers family, asset description/identity, effective perspective/palette/artDirection, style palettes, and for a deliverable also its own spec, the branch's locked concept hash and the selected output hashes of its `dependsOn` deliverables. It ignores `notes`, names, style description and sibling deliverables. So editing a prompt-bearing field or replacing a dependency's approved output makes old approvals stale; call `review.material` again for the new hash.

## Mistakes

- Deciding without `review.material`, or reusing a stale `requirementsHash`.
- Guessing instead of escalating; calling an escalation or a selection "approval".
- Claiming a human approved what you decided.
- Locking a concept the user did not pick; retrying a refused lock.
- Generating a deliverable with no branch, or before its dependency is approved.

## Frame-range revision loop (animation)

1. The reviewer marks a source-frame range (`annotation.create {candidateId, outputId, frameRange:{start,end}, text, requiresRevision:true}`; zero-based SOURCE indices, inclusive). The request waits with no agent connected.
2. `revision.list {status:"open"}` -> `revision.inspect`: notes with ranges, originals, and annotated frames of the range (`visualFiles`), plus authored YAML in force. Also run `history.examples` for accepted/rejected precedent ([history-preferences](history-preferences.md)).
3. Fix the cause: edit motion/identity YAML (edit the file, then `spec.read` until no `problems`), or pass `iterationInstructions` to `generation.plan` (they affect one run only, never become requirements). Then `generation.start`.
4. `revision.respond {revisionRequestId, text, followUpJobIds}`. This links your attempt but does NOT resolve anything.
5. Required notes keep blocking their branch/step lineage after new candidates exist, until an authorized reviewer calls `revision.resolve` or `revision.waive` (reason required). New output needs its own review; the old approval is not inherited.
6. Unsure whether the fix is good: `review.escalate`; the human decides or overrides (`review.override`, recorded with identity and reasons).
