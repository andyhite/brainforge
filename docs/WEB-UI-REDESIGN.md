# Web UI redesign: Sprite Sheet

**Status:** Shipped in `apps/web`. The finish review ran three rounds and its final disposition is **ship**. This replaces the earlier "Animation Checking Room" redesign, which the user judged to have confusing IA, amateur visuals, cluttered screens and an unclear next action.

**Mode:** Operate. **Audience:** a solo indie 2D game developer on a macOS desktop. They want good assets in their game, not to operate Brainforge's machinery.

The design system (tokens, components, rules) is recorded in `apps/web/DESIGN.md` and `apps/web/.impeccable/design.json`. The direction contract is in `apps/web/.impeccable/surfaces/src-app-tsx.md`.

## 1. What was causing the confusion

The diagnosis came from walking a populated copy of a real project: 7 assets, Cortex with 26 deliverables and two branches, open notes, failed jobs, and an out-of-date version and export.

| Kind | Problem | Change |
|---|---|---|
| Organization | An asset was a list of backend steps next to a 26-row sidebar tree. You answered "what's left?" by reading badges. | Each asset is a **sheet**. Every deliverable is a cell showing its art, what's waiting for you, or what it's blocked on. |
| Organization | The same decision lived in three places: step cards, the candidate page and the review queue. Select, approve and branch sat side by side. | All judging happens in **one room per deliverable**. "Use without approving" and "Start a branch here" moved to the candidate's ⋯ menu. |
| Hierarchy | Everything was a bordered pill, so nothing led. The "Next" banner named an internal state. | Home leads with a ranked **Up next** list, one action each. Filled ink is reserved for the single next action. |
| Wording | Labels exposed machinery: requirements hashes, "matted", "no promoted version", agent ids, sha256 in headers. | Plain consequences ("Its requirements changed after version 1 went into the game"). Identifiers moved to Details. |

## 2. Structure

Three tabs (**Home · Review · Releases**). The top bar holds the activity status (it opens Activity) and settings, and **⌘K** jumps to any asset or deliverable by name. Every screen answers one question and has one "next" slot.

| Screen | Route | Question it answers | Next action | Deeper material (on demand) |
|---|---|---|---|---|
| Home | `/` | What needs me, and how close is the game? | The first **Up next** item, ranked by what it unblocks (review › lock › recover › finish › redo › generate › promote › activate; optional assets rank lower) | "Show N more"; asset filters (All · Needs you · In progress · In the game); spec or policy problems appear only when they exist |
| Asset sheet | `/assets/:id` | What does this asset still need? | The **Next card**. Promotion and activation open their confirmation in place | **Definition** tab (spec editing, references); **Versions** tab; the branch menu (switch, compare, continue, rebase) |
| Room | `/assets/:id/steps/:step` | Is this candidate right? | The decision box: Approve, or the action that resolves the blocker; **Lock this concept…** for concepts | Details · Processing · History tabs; the ⋯ candidate menu; pivot and baseline, frames, atlas; compare |
| Generation | the room of an empty cell | Can I make this now? | **Plan generation…** opens the exact plan. Nothing starts until **Start generation** | plan details (workflow, hashes, inputs, remote-GPU disclosure) |
| Review | `/review` | What's waiting for me anywhere? | The same room in queue mode ("1 of 4 waiting", J/K); deciding advances to the next | The same as the room |
| Releases | `/releases` | What's in the game, and what can go in? | **Export…** carries ink only when exporting would change the game. A row button appears only for a real gate (**Activate version N…**, **Promote…**) | Past exports, "Choose what to export", the plan, Inspect the current export |
| Activity | `/activity` | What ran, what's running, what failed? | The job's recovery action | Jobs · Decisions · Preferences views; job detail via `?job=` |
| New asset | `/assets/new` | What kind of art is this? | Family → name → review and save (the draft persists) | Family detail expands on the selected row |
| Project entry, Settings | `/projects/open`, `/settings/*` | Which game? How is it configured? | Open, preview a new project, save | Project details, art direction, connection, agent setup |

**Continuity.** Back from a room lands on the same sheet cell with the marquee on it (`?step=`). Queue next and previous keep the branch and output context. Candidate and output stay in the URL. Live updates never move the control under the pointer.

### What left the default view, and where it went

| Before | Now |
|---|---|
| Sidebar listing every asset and step | The asset sheet, plus ⌘K |
| Home table with four status pills per asset | One state line per asset card; problems only in Up next |
| Step cards with "Use this one", "Review", "Continue from here" | Click the cell to open the room. The alternatives are in the ⋯ menu |
| Branch selector plus a separate branches panel | One branch menu in the asset header |
| Hashes, output ids, seeds, prompts and agent ids in headers | The room's Details tab; version hashes in Versions |
| Always-open reason box and policy disclosure | "Reject…" asks for reasons. Policy appears only when it changes who may decide |
| Separate Library, Releases and Export pages | One Releases page. Promote, activate and export remain separate confirmations |
| Jobs and History as top-level pages | Activity, opened from the top-bar status |
| Viewing backgrounds and zoom on every step page | Only on the room stage, where you judge the art |

## 3. Visual direction

**Sprite Sheet:** your project is a sheet you fill in. The chrome is graphite and paper in both themes, so the only saturated colour on screen is the artwork. Art sits on a transparency checker. Empty cells are dashed, blocked cells hold a lock, and the cell you came from gets a pixel-editor marquee. A tiny cell-per-deliverable glyph (the mini-sheet) shows progress as a pattern. Type is the system stack, compact and calm; mono is used only for frame numbers and counts. The stage background (checker, light, dark) is independent of the theme.

Rules the build holds to:

- **Ink marks the one next action.** When a required note blocks approval, Approve drops to secondary and the resolving action ("Go to the revision", "Open Candidate N") carries the ink.
- **State reads by form before colour:** filled, ringed, dashed, locked, struck.
- **Nothing disappears, it cancels:** rejected candidates stay in the strip, struck through.
- **Nothing is labelled twice:** one status per fact per screen.
- **Motion is state-only, at most 160ms.** The marquee holds still under reduced motion.

## 4. Safety and product truth (unchanged behaviour)

- Generation shows the exact plan before submitting and starts only when the user presses **Start generation**; there are no budgets.
- Approval covers one exact output. Notes are tied to outputs and frames, and frame labels are one-based everywhere (strip, transport, note anchors).
- Concept lock, promotion, activation and export are separate operations with separate confirmations and different names. None is combined or implied by another.
- Branch context, draft persistence, stale-plan and conflict checks, and request idempotency use the existing operation contracts. No backend change was made for the redesign.

## 5. Verification

**Setup.** The verification ran against a read-only copy of a real game project in a temp directory. It used the real Brainforge server with an isolated config and the fake ComfyUI protocol server from `packages/comfy/src/testing/fake.ts`; a local proxy swapped in artwork from earlier runs. No GPU was used, and no real project was touched.

**Observed in the browser (Chrome for Testing):**

- **Task completion:**
  - Approving from the Review queue recorded the decision, moved the queue from 4 to 3 waiting and opened the next candidate.
  - Activating Locker Key version 2 from the asset Next card went through its confirmation ("Version 2 is now active.").
  - Granting a budget from the generation stage worked. (Historical: budgets have since been removed; generation starts directly from the plan.)
  - A Stable Genius concept batch was planned and started (4 jobs), and 4 new concepts arrived in the strip.
  - A subset export of the three active assets completed ("Exported").
- **Blocked states and recovery:**
  - The full export was refused with per-asset reasons and recovery links (two required assets have no active version).
  - Planning Cortex `jump` was refused at plan time (no start or end guide), with a link to the YAML that fixes it.
  - Home's "See what failed" opens the job in Activity, and "Compare concepts" opens the concept room in compare mode.
  - A rejected candidate with an open required note offers "Open Candidate 1" as the next action.
- **Continuity and keyboard:**
  - Back from a room lands on the same cell with the marquee.
  - ⌘K found a deliverable, and Enter opened its room. J/K moved between candidates.
  - The focus ring is visible.
- **Themes and viewports:**
  - Dark and light were captured at 1440×900 and 1440×757, and dark at real 1024×768 and 800×700 viewports with no horizontal overflow.
  - At 1024 the room keeps a narrower inspector beside the stage, and the sheet keeps two columns. At 800 the room stacks, with the decision one scroll below the stage.
  - Under `prefers-reduced-motion` the marquee animation computes to `none`.
- **A bug found and fixed:** pages held in the back/forward cache kept their event stream open. With HTTP/1.1's six-connection limit, a few address-bar navigations stalled every request. The app now closes the stream on `pagehide` and reopens it on `pageshow`.

**Not verified (inferred from unchanged code or out of reach):** real ComfyUI or GPU generation; animation generation end to end (the only ready animation was blocked by its spec); the Godot export preset; browser zoom at 200%; screen-reader output; the A/R decision shortcuts; draft persistence in the new-asset wizard and note editor (the logic was kept, not re-exercised).

**Engineering checks:**

- `bun run typecheck` passed (9 workspaces).
- The production web build passed. It still warns about the 1 MB application chunk, which predates this redesign.
- `bunx turbo run test` passed all 9 tasks: core 299, comfy 18, media 42, cli 28, export 35, server 22, storage 9.

**Finish review:**

- Round 1 rejected four constrained-viewport captures (crops, not real viewports) and listed 8 material fixes.
- Round 2 rejected the light captures (they rendered dark) and listed 3 more fixes.
- Round 3 confirmed every fix and returned **ship**.
- Writing DESIGN.md turned up places where the build broke its own rules. Each was fixed and checked in the browser by computed style and a fresh capture. The transport Play button is no longer ink. The current Releases row and the selected version use the ink wash, not a side stripe. The room's Dark backdrop matches the shared `#141416`. The pivot cross uses `guide`, and its captions name marks by shape, not colour. A failed-jobs tag on an asset card is red unless every failure can be collected again, the same as its Up next row. The generation cell's heading went from 26px to 17px. The unused `--u` token was removed.

Captures are in `apps/web/.impeccable/review/sprite-sheet/`, which is gitignored and local only. The fixture artwork in them is verification material, not a claim about generation quality.

## 6. Known gaps

- A step can read "Ready to generate" while its plan is refused for a plan-time requirement, such as an animation guide. Readiness is server truth. Folding plan-time checks into step readiness would be a backend change.
- The application ships as a single 1 MB chunk. Code-splitting by route would remove the build warning.

## 7. Follow-up: the Definition tab

**Problem.** After shipping, the user found the asset **Definition** tab "insanely long", with thousands of controls and hard to read. It rendered every field of every deliverable as an open form. On Cortex (26 deliverables) it was 30,600px tall with 1,125 controls, 676 of them "Depends on" checkboxes, and the prompt text sat among the settings.

**Decision (user).** Read it like a spec and edit in place. The text sent to the image model (descriptions and motion) is what gets edited most. Mostly the page is read to check what is defined, because agents edit the YAML.

| Before | Now |
|---|---|
| Every field of every deliverable open at once | One row per deliverable, in the Sheet's groups: the id and kind, then the description, motion and a facts line (loop, size, dependencies), in full at a 75ch measure |
| Settings mixed with prompt text | Opening a row shows Description and Motion first. Id, kind, required, dependencies, timing, reference, output, tiles and UI state sit behind one **More** disclosure that names what is inside |
| Identity, style, attachments and members always shown as forms | Read views with **Edit** and **Done** in place |
| A checkbox for every other deliverable under "Depends on" | Removable chips plus one **Add…** select |
| Checks listed `deliverables[8].referenceStrength`, and nothing opened it | Checks say `jump · referenceStrength` and open the row (and More) with the field focused. Part heads, row heads and More carry "2 to fix" or "1 to finish" |

The YAML tab, the save bar, external-change and conflict handling, validation and `?section=` links are unchanged. The new-asset wizard uses the same editor. Its “Starter file” banner used to show the template's agent instructions (`spec.write`, `expectedHash: null`); it now tells people what to fill in. The starter file's `notes` starts empty instead of holding an agent instruction, so it is no longer a placeholder to finish.

**Verification.** This ran on the user's project with their permission. Nothing was saved, and the file on disk was checked afterwards.

- Cortex at 1440×757: 3,789px tall, with 41 controls and no checkboxes when the page opens. An open row adds about 23 controls.
- Enter on a row's id opens and closes the row. Editing a description shows "Unsaved changes", the row and the YAML tab show the draft, and Discard restores it. Adding and removing a dependency round-trips. Removing a chip by keyboard moves focus to the next chip, then to the Add select.
- A reference strength of 99 shows the field error, "1 to fix" on More and on the row, and `jump · referenceStrength` in Checks. Clicking that entry opens the row and More with the field focused.
- `?section=style` opens and focuses Style and references.
- Light and dark were checked at 1440, and dark at 1024, 800 and 740, with no horizontal overflow. The Sheet's grouping is unchanged. Wizard step 3 renders prop, UI and tile starter files with their placeholders in amber, and with nine-slice, tile size, connections and seamless axes under More.
- `bun run typecheck` passes. The finish review listed 7 fixes: full text, measure, Checks, the motion placeholder, chip focus, kind labels and DESIGN.md. All are applied, and the confirmation round returned **ship**.

Captures are in `apps/web/.impeccable/review/definition/`.
