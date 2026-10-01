/**
 * Impeccable for omp: design hook bridge + Claude agent model compatibility.
 *
 * `npx impeccable install --providers=claude` ships Impeccable's design hook as
 * Claude Code command hooks in .claude/settings.local.json: PostToolUse on
 * Edit|Write and a Stop deep pass. omp does not run Claude command hooks, so
 * this extension runs the same launcher with the same Claude-shaped stdin and
 * routes the output back through omp's equivalents:
 *
 *   edit/write/bash/xd://resolve result -> PostToolUse -> tool_result additionalContext
 *   main turn settling                  -> Stop        -> session_stop continuation
 *
 * Each file a call changes is reported as a Claude `Write` (full post-edit
 * content plus the pre-edit `originalFile`), which is enough for Impeccable to
 * verify its before-edit baseline and keep pre-existing findings out of the
 * Stop pass. edit/write know their files up front; bash and `write xd://resolve`
 * (the only ast_edit apply) are diffed over a Git-listed project snapshot, and
 * background bash jobs/services are reconciled on later results and at Stop.
 * On/off, quiet mode and ignores stay Impeccable's own:
 * `/impeccable hooks on|off`, .impeccable/config.json.
 *
 * Impeccable's subagents (.claude/agents, symlinked into .omp/agents) declare
 * Claude's `model: inherit`, which omp would resolve as a model named
 * "inherit" and fail; those spawns use `@designer` unless explicitly overridden.
 */

import { lstat } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const LAUNCHER = ".claude/skills/impeccable/scripts/impeccable";
// Same budgets as the Claude manifest Impeccable installs.
const EDIT_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 30_000;

// Module scope is shared by every session's binding, subagents included.
// Subagent edits are filed under the main session so its Stop pass covers them.
let mainSessionId: string | undefined;

function sessionId(ctx: ExtensionContext): string {
  const own = ctx.sessionManager.getSessionId();
  if (ctx.agent.kind === "sub") return mainSessionId ?? own;
  if (own !== mainSessionId) {
    mainSessionId = own;
    // What Impeccable's Claude SessionStart hook exports to Bash: `build-phase`
    // reads it to tie a craft build to the session whose Stop pass reminds about it.
    process.env.IMPECCABLE_SESSION_ID = own;
  }
  return own;
}

/** Absolute files an edit/write call targets; internal URLs (local://, xd://) are skipped. */
function targets(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
  if (toolName !== "edit" && toolName !== "write") return [];
  // omp derives `paths` from hashline edit headers; replace/patch edits and writes carry `path`.
  const raw = Array.isArray(input.paths) ? input.paths : [input.path];
  return raw
    .filter((p): p is string => typeof p === "string" && p.length > 0 && !p.includes("://"))
    .map(p => path.resolve(cwd, p));
}

async function readText(file: string): Promise<string | null> {
  const handle = Bun.file(file);
  return (await handle.exists()) ? await handle.text() : null;
}

// Built-in design suffixes of Impeccable's hook; detector.extensions in config adds more.
const DESIGN_SUFFIXES = [".tsx", ".jsx", ".html", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less", ".ts", ".js"];
const SKILL_PAYLOAD = ".claude/skills/impeccable/"; // installed tooling, not project source

type Snapshot = Map<string, string>;
/** [absolute file, content before (null = new), content now] */
type Change = [string, string | null, string];

/**
 * Tools that write files omp cannot enumerate. ast_edit only previews; the actual write happens in
 * `write xd://resolve`, so previews cost no scan. Other xd:// devices (bash, ast_edit) run an inner
 * tool call that is handled as its own event.
 */
function isIndirect(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "bash" || (toolName === "write" && input.path === "xd://resolve");
}

/** detector.extensions suffixes from shared + local config; malformed entries are ignored like the engine does. */
async function configSuffixes(cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of ["config.json", "config.local.json"]) {
    try {
      const list = JSON.parse(await Bun.file(path.join(cwd, ".impeccable", name)).text())?.detector?.extensions;
      if (Array.isArray(list)) for (const e of list) if (typeof e?.ext === "string" && e.ext) out.push(e.ext);
    } catch {}
  }
  return out;
}

/**
 * Contents of the project's design source files, listed by Git (so .gitignore is Git's call).
 * null when Git fails: callers skip rather than invent an empty baseline.
 * ponytail: O(project) read per indirect call (~60ms/280 files here), unbounded concurrency, no cache;
 * add an mtime/size cache if repos grow large. Attribution ceiling: a diff cannot tell which
 * process wrote a file, so concurrent user/background edits during a call are reported with it.
 */
async function snapshot(cwd: string): Promise<Snapshot | null> {
  try {
    const git = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
    });
    const listing = await new Response(git.stdout).text();
    if ((await git.exited) !== 0) return null;
    const suffixes = [...DESIGN_SUFFIXES, ...(await configSuffixes(cwd))];
    const snap: Snapshot = new Map();
    const rels = new Set(listing.split("\0"));
    await Promise.all(
      [...rels]
        .filter(rel => rel && !rel.startsWith(SKILL_PAYLOAD) && suffixes.some(s => rel.endsWith(s)))
        .map(async rel => {
          const file = path.join(cwd, rel);
          try {
            if ((await lstat(file)).isFile()) snap.set(file, await Bun.file(file).text());
          } catch (error) {
            // Deleted tracked file is fine; anything else would fake an absent baseline.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }),
    );
    return snap;
  } catch {
    return null;
  }
}

/** Files present in `after` that are new or differ from `before`; deletions are not reportable. */
function diff(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = [];
  for (const [file, content] of after) {
    const old = before.get(file);
    if (old !== content) out.push([file, old ?? null, content]);
  }
  return out;
}

/** Runs `impeccable hook` with a Claude Code hook event and returns its additionalContext. */
async function runHook(
  cwd: string,
  event: Record<string, unknown>,
  timeout: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const launcher = path.join(cwd, LAUNCHER);
  if (!(await Bun.file(launcher).exists())) return undefined;
  try {
    const proc = Bun.spawn([launcher, "hook"], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      stdin: new Blob([JSON.stringify({ ...event, cwd })]),
      stdout: "pipe",
      stderr: "ignore",
      timeout,
      signal,
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (!out) return undefined;
    const context = JSON.parse(out)?.hookSpecificOutput?.additionalContext;
    return typeof context === "string" && context.trim() ? context : undefined;
  } catch {
    // A detector failure must never fail the edit or the turn.
    return undefined;
  }
}

// Project source checkpoint per cwd, set once a background bash job/service reports "running"
// (omp documents no completion event for those). Each later result and Stop diffs against it and
// advances it; it lives until session switch/shutdown because a job can outlive the turn.
// ponytail: costs one O(project) snapshot per later tool result for the rest of the session.
// Module scope like mainSessionId so a subagent's job is seen by the main session's Stop.
const pending = new Map<string, Snapshot>();

export default function impeccableExtension(pi: ExtensionAPI) {
  // Pre-edit content per tool call, keyed by toolCallId, for Impeccable's attribution baseline.
  const originals = new Map<string, Map<string, string | null>>();
  // Whole-project baselines for calls whose written files are unknown up front.
  const snaps = new Map<string, Snapshot>();

  /** Reports one changed file as a Claude `Write`; `originalFile` null means created. */
  async function post(ctx: ExtensionContext, file: string, originalFile: string | null, content: string) {
    return runHook(
      ctx.cwd,
      {
        session_id: sessionId(ctx),
        transcript_path: ctx.sessionManager.getSessionFile(),
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: file, content },
        tool_response: {
          type: originalFile === null ? "create" : "update",
          filePath: file,
          content,
          originalFile,
        },
      },
      EDIT_TIMEOUT_MS,
    );
  }

  async function postAll(ctx: ExtensionContext, changes: Change[]): Promise<string[]> {
    const contexts: string[] = [];
    for (const [file, original, content] of changes) {
      const context = await post(ctx, file, original, content);
      if (context) contexts.push(context);
    }
    return contexts;
  }

  function reset(ctx?: ExtensionContext) {
    originals.clear();
    snaps.clear();
    if (ctx?.agent?.kind !== "sub") pending.clear(); // a subagent ending must not drop the main session's job
  }

  pi.on("session_start", (_event, ctx) => {
    sessionId(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    sessionId(ctx);
    reset(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    reset(ctx);
  });

  pi.on("before_subagent_spawn", (event) => {
    if (event.agent.startsWith("impeccable-") && event.patterns.length === 1 && event.patterns[0] === "inherit") {
      return { model: "@designer" };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    // tool_call errors block the tool; snapshotting is best effort.
    try {
      const input = event.input as Record<string, unknown>;
      const files = targets(event.toolName, input, ctx.cwd);
      const indirect = isIndirect(event.toolName, input);
      if ((files.length === 0 && !indirect) || !(await Bun.file(path.join(ctx.cwd, LAUNCHER)).exists())) return;
      if (files.length > 0) {
        const before = new Map<string, string | null>();
        for (const file of files) before.set(file, await readText(file));
        originals.set(event.toolCallId, before);
      } else {
        const snap = await snapshot(ctx.cwd);
        if (snap) snaps.set(event.toolCallId, snap);
      }
    } catch {}
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      const before = originals.get(event.toolCallId);
      const pre = snaps.get(event.toolCallId);
      originals.delete(event.toolCallId);
      snaps.delete(event.toolCallId);
      const baseline = pending.get(ctx.cwd);

      const changes = new Map<string, Change>();
      if (before && !event.isError) {
        for (const [file, originalFile] of before) {
          const content = await readText(file);
          if (content === null) continue; // removed or moved away by the edit
          changes.set(file, [file, originalFile, content]);
        }
      }
      if (pre || baseline) {
        // Errors included: a failed call may still have written files.
        const after = await snapshot(ctx.cwd);
        if (after) {
          if (pre) for (const c of diff(pre, after)) changes.set(c[0], c);
          // The earliest baseline wins: a background write before this call is not "pre-existing" for it.
          if (baseline) for (const c of diff(baseline, after)) changes.set(c[0], c);
          // omp reports async bash/services once, as a running result; completion arrives as a follow-up, not a tool_result.
          const d = event.details as { async?: { state?: string }; service?: { state?: string } } | undefined;
          const running = d?.async?.state === "running" || d?.service?.state === "running";
          if (baseline || running) pending.set(ctx.cwd, after);
        }
      }
      const contexts = await postAll(ctx, [...changes.values()]);
      if (contexts.length > 0) return { additionalContext: contexts.join("\n\n") };
    } catch {}
  });

  // Blocked or denied calls never reach tool_result.
  pi.on("tool_execution_end", event => {
    originals.delete(event.toolCallId);
    snaps.delete(event.toolCallId);
  });

  // Main sessions only: omp never fires session_stop for subagents.
  pi.on("session_stop", async (event, ctx) => {
    const contexts: string[] = [];
    try {
      const baseline = pending.get(ctx.cwd);
      const after = baseline && (await snapshot(ctx.cwd));
      if (baseline && after) {
        // Register delayed background changes before the deep pass reads Impeccable's state.
        contexts.push(...(await postAll(ctx, diff(baseline, after))));
        // The job/service may outlive this turn; keep checkpointing until switch/shutdown.
        pending.set(ctx.cwd, after);
      }
    } catch {}
    const stop = await runHook(
      ctx.cwd,
      {
        session_id: sessionId(ctx),
        transcript_path: event.session_file,
        hook_event_name: "Stop",
        stop_hook_active: event.stop_hook_active,
      },
      STOP_TIMEOUT_MS,
      event.signal,
    );
    if (stop) contexts.push(stop);
    if (contexts.length > 0) return { continue: true, additionalContext: contexts.join("\n\n") };
  });
}
