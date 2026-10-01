import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SCHEMA_VERSION, ProjectDbError, ProjectLeaseError, acquireProjectLease, appendEvents, openProjectDb, readEventsAfter } from "../src/index.ts";

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "bf-storage-")));
}

const key = { actorId: "a", requestId: "r1", operation: "spec.write", payloadHash: "h1" };

describe("openProjectDb", () => {
  test("creates WAL database with foreign keys and migrations", async () => {
    const root = await tempRoot();
    const p = openProjectDb(root);
    expect(p.writable).toBe(true);
    expect(p.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(p.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(p.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(p.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(2);
    p.close();
  });

  test("a newer schema opens read-only with an upgrade instruction", async () => {
    const root = await tempRoot();
    openProjectDb(root).close();
    const raw = new Database(join(root, "brainforge/.state/project.sqlite"));
    raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    raw.close();

    const p = openProjectDb(root);
    expect(p.writable).toBe(false);
    expect(p.upgradeInstruction).toContain("newer");
    expect(p.db.query<{ n: number }, []>("SELECT count(*) AS n FROM project_revision").get()?.n).toBe(1);
    expect(() => p.db.exec("UPDATE project_revision SET revision = 5")).toThrow();
    p.close();
  });

  test("a malformed database is an error and is left untouched", async () => {
    const root = await tempRoot();
    const path = join(root, "brainforge/.state/project.sqlite");
    openProjectDb(root).close();
    const garbage = "this is definitely not sqlite ".repeat(200);
    await writeFile(path, garbage);
    expect(() => openProjectDb(root)).toThrow(ProjectDbError);
    expect(await readFile(path, "utf8")).toBe(garbage);
  });

  test("close checkpoints the WAL", async () => {
    const root = await tempRoot();
    const p = openProjectDb(root);
    p.db.query("INSERT INTO project_meta (key, value) VALUES ('k', 'v')").run();
    p.close();
    expect((await readFile(join(root, "brainforge/.state/project.sqlite-wal")).catch(() => Buffer.alloc(0))).length).toBe(0);
    const again = openProjectDb(root);
    expect(again.db.query<{ value: string }, []>("SELECT value FROM project_meta WHERE key = 'k'").get()?.value).toBe("v");
    again.close();
  });
});

describe("idempotency store", () => {
  test("new, in-flight, replay, conflict, release", async () => {
    const p = openProjectDb(await tempRoot());
    const s = p.idempotency;
    expect(s.reserve(key)).toEqual({ kind: "new" });
    expect(s.reserve(key)).toEqual({ kind: "in-flight" });
    expect(s.reserve({ ...key, payloadHash: "h2" })).toEqual({ kind: "conflict" });
    s.complete(key, "{\"ok\":true}");
    expect(s.reserve(key)).toEqual({ kind: "replay", resultJson: "{\"ok\":true}" });
    expect(s.reserve({ ...key, payloadHash: "h2" })).toEqual({ kind: "conflict" });

    const other = { ...key, requestId: "r2" };
    expect(s.reserve(other)).toEqual({ kind: "new" });
    s.release(other);
    expect(s.reserve({ ...other, payloadHash: "changed" })).toEqual({ kind: "new" });
    p.close();
  });

  test("completed results survive reopen; a reservation left by a crash is treated as new", async () => {
    const root = await tempRoot();
    const first = openProjectDb(root);
    first.idempotency.reserve(key);
    first.idempotency.complete(key, "done");
    first.idempotency.reserve({ ...key, requestId: "crashed" });
    first.close();

    const second = openProjectDb(root);
    expect(second.idempotency.reserve(key)).toEqual({ kind: "replay", resultJson: "done" });
    expect(second.idempotency.reserve({ ...key, requestId: "crashed", payloadHash: "different-after-crash" })).toEqual({ kind: "new" });
    second.close();
  });
});

describe("events", () => {
  test("append and replay in order; unknown future sequence asks for resync", async () => {
    const p = openProjectDb(await tempRoot());
    const stored = appendEvents(p.db, [{ type: "a", data: { n: 1 } }, { type: "b", data: null, actorId: "x" }]);
    expect(stored.map((e) => e.sequence)).toEqual([1, 2]);
    expect(readEventsAfter(p.db, 0).events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(readEventsAfter(p.db, 1).events.map((e) => e.type)).toEqual(["b"]);
    expect(readEventsAfter(p.db, 2)).toEqual({ events: [], resync: false });
    expect(readEventsAfter(p.db, 99).resync).toBe(true);
    p.close();
  });
});

describe("project lease", () => {
  const child = join(import.meta.dir, "lease-child.ts");

  async function firstLine(proc: Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(value).trim();
  }

  test("a second process cannot take a live lease, and takes over once the holder dies", async () => {
    const root = await tempRoot();
    const holder = Bun.spawn(["bun", child, root, "hold"], { stdout: "pipe", stderr: "pipe" });
    expect(await firstLine(holder)).toBe("acquired");

    expect(() => acquireProjectLease(root)).toThrow(ProjectLeaseError);
    const contender = Bun.spawn(["bun", child, root, "try"], { stdout: "pipe", stderr: "pipe" });
    const out = await firstLine(contender);
    expect(out).toContain("another Brainforge process");
    expect(await contender.exited).toBe(3);

    holder.kill("SIGKILL");
    await holder.exited;
    const lease = acquireProjectLease(root); // dead pid: stale, taken over
    lease.release();
    expect(await readFile(lease.path, "utf8").catch(() => null)).toBeNull();
  });

  test("this process holding the lease blocks a child", async () => {
    const root = await tempRoot();
    const lease = acquireProjectLease(root);
    const contender = Bun.spawn(["bun", child, root, "try"], { stdout: "pipe", stderr: "pipe" });
    expect(await firstLine(contender)).toContain(`pid ${process.pid}`);
    lease.release();
    const after = Bun.spawn(["bun", child, root, "try"], { stdout: "pipe", stderr: "pipe" });
    expect(await firstLine(after)).toBe("acquired");
  });
});
