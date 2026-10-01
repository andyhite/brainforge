import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import impeccableExtension from "../extensions/impeccable";

// Real installed Impeccable launcher + real engine; only the omp host is a stub that captures handlers.
const SKILL = path.resolve(import.meta.dir, "../../.claude/skills/impeccable");
const SIDE_TAB = ".card { border-left: 4px solid #3b82f6; border-radius: 12px; padding: 8px; }\n";

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function withProject(files: Record<string, string>, body: (h: Harness) => Promise<void>) {
  const cwd = mkdtempSync(path.join(tmpdir(), "impeccable-bridge-"));
  const previousSession = process.env.IMPECCABLE_SESSION_ID;
  let h: Harness | undefined;
  try {
    mkdirSync(path.join(cwd, ".claude/skills"), { recursive: true });
    symlinkSync(SKILL, path.join(cwd, ".claude/skills/impeccable"));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(cwd, name), text);
    await git(cwd, "init", "-q");
    await git(cwd, "add", "--", ...Object.keys(files));
    await git(cwd, "commit", "-q", "-m", "base");
    h = harness(cwd);
    await body(h);
  } finally {
    await h?.close();
    if (previousSession === undefined) delete process.env.IMPECCABLE_SESSION_ID;
    else process.env.IMPECCABLE_SESSION_ID = previousSession;
    rmSync(cwd, { recursive: true, force: true });
  }
}

interface Harness {
  write(name: string, text: string): void;
  call(toolName: string, input: Record<string, unknown>, mutate: () => void, extra?: { isError?: boolean; details?: unknown }): Promise<string | undefined>;
  stop(): Promise<string | undefined>;
  close(): Promise<void>;
}
type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<{ additionalContext?: string } | undefined>;

function harness(cwd: string): Harness {
  const handlers: Record<string, Handler> = {};
  // Minimal host stub: the extension only registers callbacks via `on`.
  impeccableExtension({ on: (name: string, fn: Handler) => void (handlers[name] = fn) } as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    agent: { kind: "main" },
    sessionManager: { getSessionId: () => path.basename(cwd), getSessionFile: () => path.join(cwd, "session.jsonl") },
  };
  let n = 0;
  return {
    write: (name, text) => writeFileSync(path.join(cwd, name), text),
    /** Runs a tool call through the captured hooks; `mutate` is what the real tool would do to disk. */
    async call(toolName: string, input: Record<string, unknown>, mutate: () => void, extra: { isError?: boolean; details?: unknown } = {}) {
      const toolCallId = `c${++n}`;
      await handlers.tool_call({ toolName, toolCallId, input }, ctx);
      mutate();
      const result = await handlers.tool_result({ toolName, toolCallId, input, isError: false, ...extra }, ctx);
      await handlers.tool_execution_end({ toolCallId }, ctx);
      return result?.additionalContext as string | undefined;
    },
    async stop() {
      const result = await handlers.session_stop({ session_file: path.join(cwd, "session.jsonl"), stop_hook_active: false }, ctx);
      return result?.additionalContext as string | undefined;
    },
    async close() {
      await handlers.session_shutdown({}, ctx);
    },
  };
}

const GRADIENT = ".t { background: linear-gradient(90deg, #ff0000, #0000ff); -webkit-background-clip: text; background-clip: text; color: transparent; }\n";

test("bash and xd://resolve changes are routed to the hook by actual file diff", async () => {
  await withProject({ "dirty.css": ".b { color: red; }\n", "quiet.css": ".a { color: red; }\n" }, async h => {
    const nothing = () => {};
    h.write("dirty.css", SIDE_TAB); // uncommitted: the baseline is the dirty working tree, not HEAD

    expect(await h.call("bash", { command: "cat dirty.css" }, nothing)).toBeUndefined();

    const created = await h.call("bash", { command: "gen" }, () => h.write("new.css", SIDE_TAB));
    expect(created).toContain("new.css");
    expect(created).not.toContain("quiet.css");

    const dirty = await h.call("bash", { command: "sed" }, () => h.write("dirty.css", `${SIDE_TAB}.b { color: blue; }\n`));
    expect(dirty).toContain("dirty.css");

    const failed = await h.call("bash", { command: "boom" }, () => h.write("partial.css", GRADIENT), { isError: true });
    expect(failed).toContain("[gradient-text]");

    // Previews and rejects write nothing, so nothing is reported.
    expect(await h.call("write", { path: "xd://ast_edit", content: "{}" }, nothing)).toBeUndefined();
    expect(await h.call("ast_edit", { paths: ["quiet.css"], ops: [] }, nothing)).toBeUndefined();
    expect(await h.call("write", { path: "xd://reject", content: "Discard the preview." }, nothing)).toBeUndefined();
    const applied = await h.call("write", { path: "xd://resolve", content: "apply" }, () => h.write("quiet.css", GRADIENT));
    expect(applied).toContain("[gradient-text]");

    const stop = await h.stop();
    expect(stop).toContain("new.css");
    expect(stop).toContain("[side-tab]");
    expect(stop).not.toContain("dirty.css"); // pre-existing side-tab stays pre-existing
  });
});

test("background writes are found on later results and at every Stop, earliest baseline wins", async () => {
  await withProject({ "base.css": ".a { color: red; }\n" }, async h => {
    const running = { async: { state: "running", jobId: "bg_1", type: "bash" } };
    expect(await h.call("bash", { command: "serve", async: true }, () => {}, { details: running })).toBeUndefined();

    // The job writes shared.css; the next call edits it again before any reconcile saw the first write.
    h.write("shared.css", SIDE_TAB);
    const edit = await h.call("bash", { command: "append" }, () => h.write("shared.css", `${SIDE_TAB}.c { color: blue; }\n`));
    expect(edit).toContain("shared.css");
    expect(await h.call("read", { path: "base.css" }, () => {})).toBeUndefined(); // reported once
    expect(await h.stop()).toContain("[side-tab]"); // not hidden as pre-existing

    // The job outlives that Stop; its later write is still found.
    h.write("later.css", SIDE_TAB);
    const stop = await h.stop();
    expect(stop).toContain("later.css");
    expect(stop).toContain("[side-tab]");
  });
});
