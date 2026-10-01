# Brainforge CLI setup

Entry: `<brainforge checkout>/apps/cli/src/main.ts`, run with Bun. A thin HTTP client of the Brainforge server; it holds no state and executes no domain logic.

## Prerequisites

1. Brainforge server running: in the checkout, `bun run server` (listens on `http://127.0.0.1:3210`, also serves the web UI).
2. `brainforge` on PATH: in the checkout, `bun run install-cli` (writes `~/.local/bin/brainforge` pointing at that checkout; rerun after moving it).
   Without it: `bun /path/to/brainforge/apps/cli/src/main.ts <op> ...`, or `bun run bf -- <op> ...` inside the checkout.
3. `BF_SERVER_URL` is OPTIONAL; default `http://127.0.0.1:3210`. Set it only for a different loopback address.
4. Agent identity is fixed: the CLI sends `x-brainforge-agent: cli`, so history shows `agent:cli`.

## Usage

```sh
brainforge --list                                   # every operation: name, summary, mutating, humanOnly
brainforge <op> --help                              # input JSON Schema of one operation
brainforge <op> --input '<json>'                    # call it
brainforge <op> --input-file input.json             # large input from a file
printf '%s' '<json>' | brainforge <op> --input -   # input from stdin
```

Flags: `--project <abs dir>` overrides discovery, `--request-id <id>` sets the idempotency key (reuse it on retry), `--timeout <seconds>` (default 60; only stops waiting, never cancels server work).

Output: stdout is exactly one JSON envelope (`{ok:true,data,nextActions,warnings}` or `{ok:false,error:{code,message,recoveryActions,details?}}`); diagnostics go to stderr. Exit codes: 0 ok, non-zero per error code.

Visuals: when a result carries images (`review.material`, `revision.inspect`, `candidate.inspect`, `output.inspect`, `history.examples`), the envelope gains `visualFiles: [{fileId, role, label, path?, error?}]`. Each `path` is a model-sized PNG/JPEG (longest edge <= 1568 px) in a fresh temp directory; open it with your image-capable file reader. An `error` entry names a visual that could not be saved. The original stays addressable by `fileId`.

## Project resolution

The CLI walks up from its working directory looking for `<dir>/brainforge/project.yaml`; the first hit is the game root. Run it inside the game repo (or a subdirectory), or pass `--project <absolute game root>`.

## Troubleshooting

|Symptom|Cause / fix|
|---|---|
|`IO_ERROR` "Cannot reach the Brainforge server"|Start `bun run server` in the checkout; confirm `curl http://127.0.0.1:3210/api/health`|
|"No brainforge/project.yaml found"|cwd has no ancestor with `brainforge/project.yaml`. `cd` into the game, pass `--project`, or `project.init` (preview first, then `confirm:true`)|
|`PROJECT_NOT_OPEN`|Handled automatically (the CLI calls `project.open` and retries once). If it persists, call `project.open {path}`|
|`HUMAN_AUTHORIZATION_REQUIRED` on `policy.authorize` / `connection.set`|Human-only; the user does it in the UI at http://127.0.0.1:3210|
|`brainforge: command not found`|Install the wrapper (Prerequisites 2); check `bun --version` is 1.3.14|
