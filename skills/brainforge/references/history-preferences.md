# Past examples, judgments and preferences (M5)

Bare operation names. Host forms: oh-my-pi `xd://mcp__brainforge_<op>`; Claude Code `mcp__brainforge__<op>`.

## `history_examples {assetId, stepId?, limit?, offset?}` (read-only)

Deterministic, project-local retrieval of past **accepted** and **rejected** outputs. No embeddings, no remote model, no invented negatives: if nothing was rejected, `rejected` is 0.

- Tiers, in order: 1 same asset; 2 same style plus same family; 3 same family. Within a tier: matching `stepId` kind first, then outputs where a human overrode an agent, then newest.
- `limit` (default 8, max 50) is a page size. When both sides exist at most half are accepted and half rejected; leftover slots fill from the side that has more. Page with `offset`; `total`, `accepted`, `rejected` count the whole history. `scope` echoes the asset, its style ids and family.
- Each example: `decisionId`, `outcome`, `tier`, matched reasons, the decision's reasons and actor, `humanOverride`, `visuals` (original, untouched outputs; they arrive as image blocks, within the usual 6-image / 8 MiB cap; the text lists any not attached with their fileId), and `alternatives` (sibling candidates with outcomes).
- Use it BEFORE changing authored direction or writing `iterationInstructions`: look at what the user accepted and rejected for this asset and style, then describe the accepted look positively in YAML. Never describe a rejected example as something to avoid (the model draws what you name).

## `history_judgments {assetId?, styleId?}` (read-only)

Counts and cases: agent decisions, how many approvals, and how often a human later overrode them, with example decision ids. It is **descriptive**. Do not present it as learned taste or as a reason to skip human review.

## Preferences

A preference is a short visual requirement backed by decisions, e.g. "Eyes stay large and round; reject versions with pupils narrower than a third of the eye."

|Status|Meaning|
|---|---|
|`proposed`|Agent or human suggested it. No effect on generation.|
|`confirmed`|A human accepted it (optionally correcting `text`). From then on it is an explicit requirement.|
|`rejected`|A human declined it with a reason. Kept in history.|

- `preference_propose {text, scope:"project"|"style", styleId?, evidenceIds}`: `evidenceIds` MUST be real decision ids (take them from `history_examples`/`review_history`); at least one. `styleId` is required for `scope:"style"` and must exist. Write `text` as positive, concrete visuals, like prompt-bearing YAML (see SKILL.md); put reasoning in the evidence, not the text.
- `preference_list {status?, styleId?}` lists them with evidence.
- `preference_confirm {preferenceId, text?, note?}` and `preference_reject {preferenceId, reason}` are **human only**: you are refused. After proposing, tell the user the preference id and to confirm or reject it in the web UI.
- Confirmation never edits authored YAML, never changes approval policy, never rewrites old runs or decisions. Confirmed preferences live in the project database, not in YAML. They appear in `settings_inspect` as requirements named `preference.<id>` and in the effective snapshot of **new** runs and requirements hashes (so older approvals can become stale; nothing regenerates automatically).
- A style's `preferences:` YAML list (see [style-yaml](style-yaml.md)) holds confirmed preference ids only. Do not invent ids there.
