# Brainforge: Product Definition (Draft 1)

17 November 2026. A working draft for refining the workflow before anything is built.

Tags: **[decided]** the operator said so. **[proposed]** a default written here, open to change. **[open]** undecided; see §15.

## 1. Purpose

Brainforge is the asset pipeline for one game, built by one person with no artists. It turns rough design ideas into finished, style-consistent 2D game assets using image, video and 3D generation models. **[decided]**

It succeeds when a character goes from a rough description to approved, animated sprites running in the game, with the operator spending time only on design conversations, concept choices and final approval.

## 2. Operator and constraints

- One operator, on an Apple Silicon Mac with 128 GB of memory. Agents run in oh-my-pi (omp). **[decided]**
- The game is a side-scrolling Metroidvania in Godot 4. Characters are about 96–120 px tall on a 1280×720 composition and face left or right.
- The style is a clean western cartoon: thick, even dark outlines, flat warm colour, soft two-tone shading, no texture, with elastic squash-and-stretch acting.
- Volume: one hero with roughly 40–60 clips, about ten enemy families with 6–9 clips each, about five bosses, about ten story characters, plus props, effects, UI, tiles and backgrounds for about six regions.
- Generated work costs money per call. Most of it must run in bulk, in the background. **[decided]**

## 3. Principles

1. **Agents write, the engine executes, the operator decides.** Anything that involves writing a prompt is done by an agent. The engine never composes prompt text. The operator never has to. **[decided]**
2. **Everything repeatable is a YAML file in git.** Characters, style rules, motions, prompts, judge questions and settings are files an agent or a person can read, diff and re-run. **[decided]**
3. **Art before specification.** A character's files grow as decisions are made. Nobody lists every deliverable before the first concept exists. **[proposed]**
4. **Motion is separate from drawing.** A clip's timing lives in a shared motion library. A renderer turns a motion plus a character into frames. **[decided]**
5. **Measure before asking.** Every output passes automated judging before the operator sees it. An uncertain or missing answer never counts as a pass. **[decided]**
6. **Enforce the style, don't hope for it.** Style rules are measurable (palette, outline width, flatness) and checked on every output. **[proposed]**
7. **One approval puts an asset in the game.** Versions are kept automatically. There is no separate promote or activate step. **[decided]**
8. **Models are replaceable.** Which model serves which role is a setting. Model limits come from the provider's catalog, not from code. **[proposed]**

## 4. Concepts

|Term|Meaning|
|---|---|
|Brief|A character's or asset's design, written as short checkable statements ("four fingers including the thumb", "no mouth").|
|Style bible|The game's measurable style rules plus a few approved anchor images that accompany every generation.|
|Reference pack|The approved concept and model sheet for one character: views, expressions, hands, props. Everything later is drawn against it.|
|Skeleton|A named set of joints shared by characters with the same anatomy.|
|Motion|One clip's movement on a skeleton: timing, loop points, foot contacts, anchors and gameplay event frames. No artwork.|
|Renderer|A method that turns a motion plus a reference pack into frames.|
|Request|One generation call written as data: model, prompt, reference images, settings. Authored by an agent, run verbatim by the engine.|
|Verdict|The judge's result for one output: measurements, answers, pass or fail, and why.|
|Lock file|An engine-written record of what was approved: output hashes, model versions, seeds, cost.|

## 5. Pipeline

|#|Stage|Who does the work|Result|Operator time|
|---|---|---|---|---|
|1|Design brief|Operator talks with an agent|`brief.yaml`: checkable design statements|A conversation|
|2|Style bible|Operator and agent, once per game|Measurable rules and anchor images|Heavy, once|
|3|Concept|Agent prompts; operator compares and directs|One chosen concept|Heavy, per character|
|4|Model sheet|Agent, unattended|Reference pack|One approval|
|5|Motion|Agent, unattended|Any motions the character needs that the library lacks|Quick batch look|
|6|Production|Agent, unattended, in bulk|Candidate frames for every clip and still|None|
|7|Judging|Engine, unattended|Verdicts; the best one or two candidates per asset|None|
|8|Approval|Operator|Approved assets exported to the game|Batch review|

- **Stage 1.** The brief's statements are used three ways: as source for prompts, as the judge's questions, and as the record of what the character is.
- **Stage 3.** The operator directs in conversation and by pinning notes on images. The agent turns direction into the next prompts. Several models can be compared side by side.
- **Stage 6.** When every candidate fails judging, the agent reads the verdicts and revises the request, within a set number of attempts and a spend limit. After that it stops and reports.
- **Stage 8.** Review happens at game size, on game backgrounds, with playback. The operator can reject with a note; the note goes back to stage 6.

## 6. Motion library

A motion is authored once and reused across the cast. Ten enemy families can share one walk, one hit reaction and one defeat. **[decided]**

New motions can be added at any time, for shared use or for one character's custom action. **[decided]** Every source produces the same motion file:

|Source|How|Suits|
|---|---|---|
|Agent-authored key poses|An agent writes poses and timing as data; the engine interpolates|Short, stylised, exaggerated actions|
|Text-to-motion model|An agent writes the description; the engine runs the model and imports the result|Ordinary body actions|
|Motion-capture clip|Import from a library and fit to the skeleton|Locomotion|
|Filmed reference|Extract poses from a video of someone acting it out|Specific acting|
|Derived|Retime, mirror, blend or exaggerate an existing motion|Variants|

- Each motion gets a free preview (a mannequin loop and a contact sheet) and is measured for loop closure, foot contact and joint limits before any paid rendering uses it.
- Squash and stretch are part of the motion, so the pose guides show the exaggeration.
- A motion names its gameplay events (windup, active, recovery). They carry through to the exported clip.
- Characters that are not humanoid (a drone, a machine) use their own skeleton.
- Whether a skeleton is two-dimensional or three-dimensional is **[open]**; the first milestone decides.

## 7. Renderers

The renderer is chosen per character or per clip. Which ones are worth building is **[open]** until the first milestone (§14).

|Renderer|How it works|Expected strength|Main risk|
|---|---|---|---|
|Guided redraw|Lay the motion's poses out as a grid; an image-edit model redraws every cell as the character in one image; slice|Drawn frames, exaggeration survives, stills-quality transparency|Whether models follow a pose guide closely is unverified|
|3D proxy|Concept to 3D model, automatic rig, toon render from a fixed camera|Perfect consistency, transparency, loops and anchors|Rigging the brain head; a 3D look|
|Video in-between|Generate key poses, let a video model fill between them|Elastic motion|Drift, no transparency, loose loops|
|2D rig|Character as layered parts on bones|Perfect consistency; clips are nearly free|Hidden-part repair; a cut-out look; hardest to automate|

Research scores (0–5, researchers' judgment from documentation and public write-ups, not tests on this game's art):

|Method|Style match|Consistency|Squash and stretch|Clean transparency|Loops and anchors|
|---|---|---|---|---|---|
|3D proxy|2|5|2|5|5|
|2D rig|3|5|2|4|5|
|Sprite service, per-clip video|3|2|3|2|2|
|Motion-transfer video|2|2|1|2|3|

Guided redraw has no score: it is this document's proposal and is untested.

## 8. Judging

Two layers, cheapest first. **[proposed]**

1. **Measurements** (local, free). Transparency and edge fringe against dark and light backdrops, canvas and scale, foot baseline, loop closure, camera motion, palette distance from the style bible, outline width, texture in flat areas, pose distance from the motion's guide.
2. **Model questions** (remote, fractions of a cent). Narrow yes/no questions taken from the brief, asked on cropped regions: finger count, mouth, shoe design, view (profile or three-quarter). A larger model is asked only when the small one is unsure or two disagree.

Rules:

- A failed measurement stops judging for that output and spends nothing further.
- Best-of-N: generate several, drop failures, rank the rest, show the operator the top one or two.
- A pass means "worth the operator's time". The judge never approves final art.
- Every operator decision is logged next to the judge's verdict. Thresholds are refitted from those decisions, and a check that stops agreeing with the operator becomes advisory.
- A fixed set of known-good and known-bad examples is re-judged whenever a model or question changes.

Known limit: small judge models are weak on subjective quality. In an earlier test by the operator they agreed with a reference 50–58% of the time on such questions. Subjective quality stays with the operator.

## 9. Surfaces

Three surfaces, each with one job. **[decided]**

|Surface|Job|Never does|
|---|---|---|
|Engine and CLI|Executes: validates files, runs requests, renders, processes, judges, exports, records|Write a prompt; make a creative choice|
|Agent layer (omp)|Authors: briefs, prompts, YAML, motions, judge questions; plans and runs batches; reacts to verdicts and notes|Approve; change files the engine owns|
|Web UI|Shows and records decisions: compare, pick, annotate, play back, approve|Take prompt text; edit YAML; call a model|

### Engine and CLI

One local program with a command-line interface that returns JSON. It is the only thing that calls models or writes outputs.

It is written in TypeScript on Bun, as are the web UI and any omp extensions. Local tools such as Blender or Python model tools run as subprocesses. **[decided]**

- Validate every YAML file and report problems by file and field.
- Run a request exactly as written, after showing its price from the provider's catalog and checking it against the spend limit.
- Import, fit, preview and measure motions.
- Run renderers; cut, scale and anchor frames; remove backgrounds and repair edge colour so no backdrop tint remains under soft edges; pack atlases.
- Run the judge and write verdicts.
- Export approved assets to the game and write lock files.
- Report queue, spend and status.

### Agent layer (omp)

|Piece|What it is|Contents|
|---|---|---|
|Skill|`skills/brainforge/`|The operating protocol, every YAML format, and one prompting guide per model family. Prompting knowledge changes here, not in code.|
|Role agents|`.omp/agents/*.md`|`brief-writer`, `art-director` (concepts and model sheets), `motion-author`, `producer` (bulk runs and revisions).|
|Slash commands|One per interactive stage|Entry points such as `/bf-brief <id>` and `/bf-concept <id>`.|
|Work queue|Kata issues, run by the Roundhouse loop|One issue per asset and stage, so bulk work runs unattended and resumes after a stop.|

No custom omp tools at first: agents call the CLI through the shell and open images with their reader. Add one only if agents lose turns to quoting or image handling. **[decided]**

### Web UI

- Concept board: candidates from several models side by side, pick, pin notes on regions.
- Reference pack and motion-preview approval.
- Batch approval at game size with playback, backgrounds and frame stepping.
- Each item shows why the judge passed it.
- Queue and spend.

The UI has no prompt box. Direction is given by notes and picks in the UI, or by talking to the agent. It can sit in a Tern browser block beside the agent's pane.

## 10. Files and repeatability

```text
<game>/brainforge/
  project.yaml              # model per role, spend limits, judge thresholds, export target
  style/bible.yaml          # measurable rules, anchor image list
  style/anchors/
  skeletons/<id>.yaml
  motions/<id>.yaml         # shared motion library
  characters/<id>/
    brief.yaml              # checkable design statements
    character.yaml          # skeleton, clips (motion + renderer), requests, judge questions
    motions/<id>.yaml       # motions only this character uses
    refs/                   # approved concept and model sheet
    character.lock.yaml     # engine-written: approved outputs, model versions, seeds, cost
  assets/<id>/asset.yaml    # props, tiles, backgrounds, UI, effects
```

- Agents and people write every file except lock files. **[decided]**
- A request stored in YAML can be re-run as written. Hosted models do not reproduce an image from a seed, so repeatable means the recipe re-runs and the approved result is pinned by hash in the lock file.
- Approved references and exported game assets are committed. Candidates and intermediate frames are kept out of git in a content-addressed store. **[decided]**
- Files are the source of truth. Any database is a cache that can be rebuilt from them. **[decided]**

## 11. Models and spend

- No ComfyUI. Hosted models are called through OpenRouter; local models and tools run directly on the Mac. **[decided]**
- On 17 November 2026 OpenRouter's catalogs listed 70 image models and 33 video models with machine-readable prices, including multi-reference edit models, models that return a transparent background, and video models with first-and-last-frame control.
- Gap: neither catalog lists background removal for an existing image or video. That step is local, or avoided by rendering with transparency.
- `project.yaml` names a model for each role (concept, edit, sheet, in-between, 3D, motion, judge). Changing a model is a one-line edit.
- Every run shows its catalog price first. Limits apply per run, per asset and per day. Actual spend is recorded per output.
- 3D, rigging and text-to-motion services are not on OpenRouter and need their own provider accounts. **[open]**

## 12. Assets that are not characters

Props, tiles, backgrounds and UI use stages 1–4 and 6–8 without motion. **[proposed]**

- Tiles are measured for seamless edges.
- Backgrounds may be generated as separate depth layers.
- UI and icons may be generated as vector art.
- Effects such as the blast plume may be better made in Godot (particles, shaders) than generated. **[open]**

## 13. Out of scope for the first version

- Other operators, accounts or remote hosting.
- Engines other than Godot 4.
- Audio, dialogue and lip-sync.
- Training custom style or character models. Revisit once about thirty approved assets exist.
- A general-purpose image tool. Brainforge serves this game's pipeline.

## 14. First milestone: the renderer bake-off

Nothing else is built until this is done. **[decided]**

- **Input:** the existing Cortex concept, `docs/references/cortex-target-look.png` in the game repository.
- **Test:** three clips (idle, run, kick) through guided redraw, 3D proxy and video in-between.
- **Scoring:** the §8 measurements, plus the operator's eye at 120 px on a game background.
- **Estimate:** about half a day and under $15 of paid generation.
- **Outcome:** which renderers to build, whether skeletons are 2D or 3D, and a first set of operator decisions to calibrate the judge.

Second milestone: Cortex end to end, from brief to approved clips running in a Godot test scene.

## 15. Decisions and open questions

### Decided

|Decision|Source|
|---|---|
|The tool is an asset pipeline for one game|Operator, 17 Nov|
|Designs are refined with an LLM before any concept is generated|Operator, 17 Nov|
|Concept work is operator-heavy; everything after it is minimised|Operator, 17 Nov|
|Automated judging comes before operator approval|Operator, 17 Nov|
|Motion library plus swappable renderer|Operator, 17 Nov|
|New motions can be generated, including per-character custom actions|Operator, 17 Nov|
|Anything that involves prompting is agent-driven|Operator, 17 Nov|
|Characters and configuration are YAML, repeatable and version-controlled|Operator, 17 Nov|
|No ComfyUI; models directly or through OpenRouter|Operator, 17 Nov|
|One approval puts an asset in the game; versions are automatic|Operator, 17 Nov|
|Files are the source of truth; any database is a rebuildable cache|Operator, 17 Nov|
|Candidates and intermediate frames stay out of git|Operator, 17 Nov|
|The operator gives new motion previews a quick batch look before paid rendering|Operator, 17 Nov|
|The engine and CLI execute, the agent layer authors, the web UI shows and records decisions|Operator, 17 Nov|
|No custom omp tools at first|Operator, 17 Nov|
|The renderer bake-off is the first milestone|Operator, 17 Nov|
|TypeScript on Bun for the engine, CLI and web UI; local tools run as subprocesses|Operator delegated the choice, 17 Nov|

### Open

1. Which renderers to build, and 2D or 3D skeletons. Settled by §14.
2. Providers for 3D, rigging and text-to-motion.
3. How long candidates and intermediate frames are kept.
4. Whether effects are generated or built in Godot.
5. Whether the existing game design documents feed stage 1 directly, or briefs are written fresh.
