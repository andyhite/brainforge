# Brainforge

An asset pipeline for one 2D game, being rebuilt from scratch. `PRODUCT.md` is the product definition: read it before any work, follow its **[decided]** items, and keep its decisions log current when an issue settles one.

## Build, test, verify

- Language: TypeScript on Bun. The Bun version is pinned in `mise.toml`; run Bun as `mise exec -- bun …` when your shell does not already resolve that version.
- Layout: Bun workspaces. `packages/*` holds engine libraries, `apps/*` holds the CLI and web UI, `spikes/*` holds experiments.
- The gate is `scripts/check` (install, typecheck, tests). Roundhouse runs it; never run it directly in a managed session.
- One test file while working: `mise exec -- bun test <path>`.
- Keep tests fast: a test file runs in well under a second, the whole suite in seconds. The gate runs under a shared lock in the build loop, so every slow test stalls every other agent waiting to verify.
- Mock every external dependency in tests: paid providers, network calls, and the Blender, `ffmpeg` and `godot` subprocesses. Inject them so a test can pass a fake. Never sleep or poll real time; inject the clock.
- A check that needs the real tool or provider goes in a spike or a script run by hand, never in `bun test`.
- Local tools run as subprocesses: Blender at `/Applications/Blender.app/Contents/MacOS/Blender` (headless: `--background --python <script>`), `ffmpeg`, `godot`.
- Web UI changes: verify in Tern's browser block (`tern browser`), with a screenshot under `.evidence/<issue>/`.

## Files that stay out of git

- Generated candidates, intermediate frames, downloaded models and clips go under a spike's or package's `.work/` folder, or under `.evidence/<issue>/`. Both are shared across worktrees and ignored by git.
- Commit code, YAML, small test fixtures and approved reference images only.

## Paid providers

- Every paid call needs a spend limit stated in the issue. Stay under it; stop and hand off when it is reached. Never raise it yourself: spending beyond an issue's limit is a question for the operator.
- Record every paid call (provider, model, request, price, result path) in the ledger the issue names, before and after the call.
- An evaluator verifies paid work from the recorded outputs and ledger. It never repeats a paid call.
- `OPENROUTER_API_KEY` is in the environment. `TRIPO_API_KEY` is in `.envrc` at the checkout root (linked into worktrees): load it with `. ./.envrc` in the same shell command that needs it.
- Never print, log or commit a key.

## Rules from the product definition

- The engine never composes prompt text. Prompts are written by an agent into a request file and run exactly as written.
- Anything repeatable is a YAML file. Files are the source of truth; a database is only a rebuildable cache.
- Automated judging fails closed: a missing, refused or uncertain answer never counts as a pass.

## Roundhouse and Kata

- Issues live in the Kata project `brainforge` (`.kata.toml`). An issue's `## Acceptance` list is its contract.
- `main` has no remote, so `push` is off in `.roundhouse.json`.
- A branch that changes `.omp`, `AGENTS.md` or `.roundhouse.json` is not merged by the loop; the operator merges it.
