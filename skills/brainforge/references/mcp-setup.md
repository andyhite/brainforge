# Registering the Brainforge MCP server

Stdio MCP server. Entry: `<brainforge checkout>/apps/mcp/src/main.ts`, run with Bun. It is a thin client of the Brainforge server over HTTP; it holds no state and executes no domain logic itself.

## Prerequisites

1. Brainforge server running: in the checkout, `bun run server` (listens on `http://127.0.0.1:3210`, also serves the web UI).
2. `BF_SERVER_URL` is OPTIONAL; default `http://127.0.0.1:3210`. Set it only for a different loopback address.
3. Agent identity is fixed: the MCP server sends `x-brainforge-agent: mcp`, so history shows `agent:mcp`. No env var changes it.
4. Optional binary flags: `--project <dir>` pins the game root; `--cwd <dir>` replaces the working directory used for the walk-up search.

Replace `/path/to/brainforge` with the checkout path (e.g. `/Users/user/Code/andyhite/brainforge`).

## oh-my-pi (omp)

User file `~/.omp/agent/mcp.json` (recommended), or project file `<game>/.omp/mcp.json`:

```json
{
  "mcpServers": {
    "brainforge": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/brainforge/apps/mcp/src/main.ts"],
      "env": { "BF_SERVER_URL": "http://127.0.0.1:3210" }
    }
  }
}
```

Recommended: put it in the user-level file once so every game sees it (project chosen from cwd at call time). The project-level `<game>/.omp/mcp.json` is the alternative and was verified end-to-end (`omp -p` from a game dir called `project_inspect` and `spec_write`). Source for locations: omp `mcp-config.md`; named profiles use `~/.omp/profiles/<name>/agent/mcp.json`. Verify inside omp with `/mcp`.

Tool names in omp: `mcp__brainforge_<op>` (e.g. `mcp__brainforge_spec_write`), called by writing JSON to `xd://mcp__brainforge_<op>`; read that path first for the schema.

## Claude Code

Project `.mcp.json` in the game repo:

```json
{
  "mcpServers": {
    "brainforge": {
      "command": "bun",
      "args": ["/path/to/brainforge/apps/mcp/src/main.ts"],
      "env": { "BF_SERVER_URL": "http://127.0.0.1:3210" }
    }
  }
}
```

Equivalent CLI (documented `claude mcp add` syntax; not run here, unverified against the installed version): `claude mcp add --scope user -e BF_SERVER_URL=http://127.0.0.1:3210 brainforge -- bun /path/to/brainforge/apps/mcp/src/main.ts`

Tool names in Claude Code: `mcp__brainforge__<op>`.

## Project resolution

The MCP process walks up from its working directory looking for `<dir>/brainforge/project.yaml`; the first hit is the game root. Start the agent inside the game repo (or a subdirectory). Tools accept an explicit absolute `project` argument to override.

## Troubleshooting

|Symptom|Cause / fix|
|---|---|
|Connection refused / "server not running"|Start `bun run server` in the checkout; confirm `curl http://127.0.0.1:3210/api/health`|
|"no project found" at cwd|cwd has no ancestor with `brainforge/project.yaml`. `cd` into the game, pass `project`, or `project_init` (preview first, then `confirm:true`)|
|`PROJECT_NOT_OPEN`|Handled automatically (client calls `project_open` and retries once). If it persists, call `project_open {path}`|
|`HUMAN_AUTHORIZATION_REQUIRED`: Origin not allowed|A browser-style Origin header was sent from a non-UI origin; the MCP/CLI path sends none|
|`HUMAN_AUTHORIZATION_REQUIRED` on `policy_authorize` / `connection_set`|Human-only; the user does it in the UI at http://127.0.0.1:3210|
|Tools missing in the agent|Server entry failed to start: run `bun /path/to/brainforge/apps/mcp/src/main.ts` by hand and read stderr; check `bun --version` is 1.3.14|
