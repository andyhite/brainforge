# Concept generation and review loop (M2)

Bare operation names below, in the MCP form (`generation_plan`); with the CLI use the dotted name (`generation.plan`). Host forms: oh-my-pi writes JSON to `xd://mcp__brainforge_generation_plan`; Claude Code calls `mcp__brainforge__generation_plan`. Read the xd:// path first for the schema in omp.

## Loop

1. `budget_list {assetId?}`: what the human authorized (max starts, max candidate submissions, expiry, used/remaining). Budgets are scoped to ONE step id, so a character needs a grant for `concept` and one for every deliverable (e.g. sheet, two poses, two clips = six); the `concept` budget must also cover the variations a revision follow-up needs. Tell the user the full list up front. No active budget for the step → ask the user to grant one in the web UI. `budget_grant` / `budget_revoke` are human-only; you are refused.
2. `step_inspect {assetId, stepId:"concept"}`: state and blockers. `blocked` lists what is missing (e.g. asset.yaml fields, ComfyUI connection).
3. `generation_plan {assetId, mode:"fresh"|"variation", count, parentCandidateId? (variation), referenceBindings?, iterationInstructions?}`: submits NOTHING. Returns `planId`, `planHash`, composed prompt with sources, workflow, execution/cost disclosure, pinned input hashes, remaining budget, blockers. Show the user the counts and disclosure before starting.
4. `generation_start {planId, planHash, budgetId}`: revalidates and queues jobs; consumes one start plus one submission per candidate. Reuse `requestId` on retry: the same request never starts twice.
5. Poll `job_inspect {jobId}` (or `job_list {activeOnly:true}`) every few seconds until terminal. Do not loop faster than 2 s.
6. `candidate_list {assetId}` then `candidate_inspect {candidateId}`: exact prompt, run inputs, lineage, notes, and the images as image content blocks (matted and untouched outputs).
7. Humans annotate in the UI; you may add notes with `annotation_create {candidateId, outputId, geometry, text, requiresRevision}`. Geometry is whole image, pin `{x,y}` or rectangle `{x,y,width,height}`, all normalized 0..1.
8. `revision_list {status:"open"}` finds work waiting for an agent. `revision_inspect {revisionRequestId}` returns notes with coordinates, original and annotated images (image blocks), exact prompt, authored YAML in force.
9. Act: edit YAML (`spec_validate` → `spec_write`), or `generation_plan mode:"variation"` with `iterationInstructions` → show user → `generation_start` (needs budget). Then `revision_respond {revisionRequestId, text, followUpJobIds}`.
10. Stop. The reviewer accepts with `revision_resolve` or closes with `revision_waive`.

## Image blocks

Tools returning `data.visuals` append a text note and up to 6 image blocks (model-sized derivatives, total size capped). The note lists each `fileId` and every image NOT attached (limit, size, fetch failure). Never claim you viewed an image the note says was not attached.

## States

|Job state|Meaning|
|---|---|
|`queued`|Saved locally, not yet sent. `job_cancel` works.|
|`submitting`|Sending to ComfyUI; outcome not yet known.|
|`running`|In ComfyUI. `job_cancel` → `CANCEL_UNAVAILABLE`; let it finish and ignore the result.|
|`collecting`|Downloading/publishing outputs.|
|`succeeded`|Candidate published.|
|`failed`|Terminal; error stage and recovery are on the job. Download/publish failures: `job_retry {mode:"collect"}` reuses the remote result, no regeneration.|
|`cancelled`|Queued prompt removed.|
|`unresolved`|Submission outcome unknown (lost response, 0 or several matches).|

Step states: `blocked|ready|running|awaiting_review|complete|failed`. A concept is not complete just because candidates exist.

## Honest-failure rules

- `unresolved`: run `job_reconcile` (read-only lookup by saved identity; it never submits). If still unresolved, report to the user. NEVER start a duplicate plan to "fix" it. `job_retry mode:"new-attempt"` is human-only and spends budget.
- Cancel only removes a queued prompt. Never claim a running job was stopped.
- Budget exhausted → report `return-to-human`; do not look for ways around it (new branch, spec edit, new revision do not reset counters).
- Unknown values (seed, cost, GPU time) stay unknown. Report what the job/candidate records say.
- Favorites are a shortlist, not approval.
- Identity-edit variations (`mode:"variation"`, and every pose/sheet) keep the reference's identity and ignore size or proportion instructions ("make the brain bigger") at the default `referenceStrength`. Change the authored YAML, raise `referenceStrength`, or generate a fresh batch instead; look at the result before saying it worked.
- A construction sheet can return front and profile both three-quarter (rear is usually a true rear). Check each region with `review_material` and say so in the decision reason; fix `regions[].view` wording and regenerate only if the user asks.
- Several agents may share one Chrome DevTools endpoint and `browser.open` can hand back another agent's tab. Create a private page (`PUT /json/new`) and attach to it by `target`.

## Common mistakes

- Assuming you can grant or extend a budget.
- Calling `generation_start` without showing the plan, or with a stale `planHash` after editing YAML (replan).
- Resolving or waiving a revision you responded to. Only when the user told you to and policy allows.
- Resubmitting an `unresolved` job, or retrying with a changed payload under the same `requestId`.
- Guessing or "fixing" seeds, prompts, or workflow ids; read them from `candidate_inspect` and `workflow_list`.
- Describing images from the JSON labels instead of the attached image blocks.
- Polling `revision_list` without `status:"open"` and re-handling already answered requests.
- Treating the matted output as the only output: the untouched decode is also provided for judging matte errors.
