import { afterAll, describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { createProjectRegistry } from "../src/index.ts";
import { createHarness, expectOk, initializedGame, tempGameDir } from "./helpers.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

describe("project runtime", () => {
  test("transact bumps the revision once, appends events, and notifies after commit; failures roll back", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    const p = h.registry.getOpen(root)!;
    const seen: string[] = [];
    const off = p.subscribe((e) => seen.push(`${e.sequence}:${e.type}`));
    const before = p.revision();

    const { value, revision } = p.transact(() => {
      p.db.query("INSERT INTO project_meta (key, value) VALUES ('a', '1')").run();
      return 7;
    }, [{ type: "one", data: { x: 1 } }, { type: "two", data: null }]);
    expect(value).toBe(7);
    expect(revision).toBe(before + 1);
    expect(seen.map((s) => s.split(":")[1])).toEqual(["one", "two"]);
    expect(p.eventsAfter(0).events.map((e) => e.type).slice(-2)).toEqual(["one", "two"]);

    const failing = () => p.transact(() => {
      p.db.query("INSERT INTO project_meta (key, value) VALUES ('b', '2')").run();
      throw new Error("boom");
    }, [{ type: "never", data: null }]);
    expect(failing).toThrow("boom");
    expect(p.revision()).toBe(before + 1);
    expect(p.db.query("SELECT 1 FROM project_meta WHERE key = 'b'").get()).toBeNull();
    expect(seen).toHaveLength(2);
    off();
  });

  test("the same project through a symlink is one handle", async () => {
    const root = await initializedGame(h);
    const alias = join(await tempGameDir(), "alias");
    await symlink(root, alias);
    const a = expectOk(await h.call("project.open", { path: root }));
    const b = expectOk(await h.call("project.open", { path: alias }));
    expect(b.project.root).toBe(a.project.root);
    expect(h.registry.get(alias)).toBe(h.registry.get(root));
    expect(h.registry.list().filter((x) => x.root === root)).toHaveLength(1);
  });

  test("a second registry in the same process is refused by the lease", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    await expect(createProjectRegistry().open(root)).rejects.toThrow("already open");
  });

  test("close reports closing while work is tracked, then closed with the lease released", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    const p = h.registry.getOpen(root)!;
    let work = 1;
    p.setTrackedWorkProbe(() => work);

    const closing = expectOk(await h.call("project.close", {}, { project: root }));
    expect(closing.state).toBe("closing");
    expect(closing.message).toContain("not yet safe to move");
    expect(h.registry.get(root)).toBeDefined();

    work = 0;
    const closed = expectOk(await h.call("project.close", {}, { project: root }));
    expect(closed.state).toBe("closed");
    expect(h.registry.get(root)).toBeUndefined();
    // the lease is free again
    const reopened = createProjectRegistry();
    await reopened.open(root);
    await reopened.closeAll();
  });

  test("snapshot quiesces: a transaction attempted while quiesced is refused", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    const p = h.registry.getOpen(root)!;
    let refused = "";
    await p.exclusive(async () => {
      try { p.transact(() => 1); } catch (e) { refused = e instanceof Error ? e.message : ""; }
    });
    expect(refused).toContain("quiesced");
    expect(p.transact(() => 1).value).toBe(1);
  });
});
