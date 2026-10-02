import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  commitExport, ExportError, InjectedFault, prepareExport, recoverExport,
  type ExpectedCurrent, type ExportInput,
} from "../src/index.ts";
import { characterAsset, makeInput, stillDeliverable, tempDir, writeText } from "./fixtures.ts";

interface Env {
  dest: string;
  sourceDir: string;
}

async function env(): Promise<Env> {
  const base = await tempDir();
  return { dest: path.join(base, "game", "assets", "brainforge"), sourceDir: path.join(base, "src") };
}

const input = (e: Env, exportId: string, seed: number, withProp = false): Promise<ExportInput> =>
  characterAsset({ sourceDir: e.sourceDir, seed, versionId: `ver-${exportId}` }).then(async (asset) => {
    const assets = [asset];
    if (withProp) assets.push({ assetId: "old-prop", family: "prop", versionId: "pv", requirementsHash: "r", dependencies: [], metadata: {}, deliverables: [await stillDeliverable({ sourceDir: e.sourceDir, seed }, "crate", "still")] });
    return makeInput({ sourceDir: e.sourceDir, exportId, seed }, assets);
  });

async function publish(e: Env, inp: ExportInput, expected?: ExpectedCurrent) {
  const prepared = await prepareExport({ destinationAbs: e.dest, input: inp, ...(expected ? { expectedCurrent: expected } : {}) });
  const committed = await commitExport({ destinationAbs: e.dest, intent: prepared.intent });
  return { prepared, committed, current: { exportId: inp.exportId, manifestSha256: prepared.intent.manifestSha256 } satisfies ExpectedCurrent };
}

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
const releases = async (e: Env): Promise<string[]> => (await readdir(path.join(e.dest, ".releases"))).filter((n) => n !== ".lock").sort();
const pointer = (e: Env): Promise<string> => readlink(path.join(e.dest, "current"));
const errorOf = async (p: Promise<unknown>): Promise<ExportError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ExportError);
  return e as ExportError;
};

describe("atomic publication", () => {
  test("first export creates a relative current symlink to a complete release", async () => {
    const e = await env();
    const inp = await input(e, "exp-1", 1);
    const { prepared, committed } = await publish(e, inp);
    expect(committed.status).toBe("committed");
    expect(await pointer(e)).toBe(".releases/exp-1");
    const manifest = JSON.parse(await readFile(path.join(e.dest, "current/manifest.json"), "utf8"));
    expect(manifest.schema).toBe("brainforge.export.v2");
    expect(prepared.intent.manifestSha256).toBe(committed.manifestSha256);
    expect(await exists(path.join(e.dest, "current/assets/cortex/animations/walk/animation.json"))).toBe(true);
    expect(await releases(e)).toEqual(["exp-1"]);
  });

  test("replacement removes only manifest-owned stale files and leaves one release", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1, true));
    expect(await exists(path.join(e.dest, "current/assets/old-prop/stills/crate.png"))).toBe(true);
    await writeText(path.join(e.dest, "human-notes.txt"), "mine");
    const second = await publish(e, await input(e, "exp-2", 2), first.current);
    expect(second.committed.warnings).toEqual([]);
    expect(await pointer(e)).toBe(".releases/exp-2");
    expect(await exists(path.join(e.dest, "current/assets/old-prop"))).toBe(false);
    expect(await releases(e)).toEqual(["exp-2"]);
    expect(await readFile(path.join(e.dest, "human-notes.txt"), "utf8")).toBe("mine");
  });

  test("unowned files (root-level, and sidecars inside current) survive replacement and are carried unowned", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    const sidecar = "assets/cortex/stills/front.png.import";
    await writeText(path.join(e.dest, "root-file.txt"), "root");
    await writeText(path.join(e.dest, "current", sidecar), "engine-owned");
    await writeText(path.join(e.dest, "current/assets/cortex/godot-extra/front.png.uid"), "uid://abc");
    const second = await publish(e, await input(e, "exp-2", 2), first.current);
    expect(await readFile(path.join(e.dest, "root-file.txt"), "utf8")).toBe("root");
    expect(await readFile(path.join(e.dest, "current", sidecar), "utf8")).toBe("engine-owned");
    expect(await readFile(path.join(e.dest, "current/assets/cortex/godot-extra/front.png.uid"), "utf8")).toBe("uid://abc");
    const manifest = JSON.parse(await readFile(path.join(e.dest, "current/manifest.json"), "utf8"));
    expect(manifest.ownedFiles.map((f: { path: string }) => f.path)).not.toContain(sidecar);
    expect(second.prepared.intent.carried.map((f) => f.path).sort()).toEqual([sidecar, "assets/cortex/godot-extra/front.png.uid"].sort());
    expect(second.committed.warnings.join(" ")).toContain("unowned");
    // The retired release keeps the originals it does not own.
    expect(await exists(path.join(e.dest, ".releases/exp-1", sidecar))).toBe(true);
    expect(await exists(path.join(e.dest, ".releases/exp-1/manifest.json"))).toBe(false);
  });

  test("an unowned file that a new managed path would overwrite fails the export before touching current", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    const collide = "assets/cortex/stills/extra.png";
    await writeText(path.join(e.dest, "current", collide), "human file");
    const inp = await input(e, "exp-2", 2);
    inp.assets[0]!.deliverables.push(await stillDeliverable({ sourceDir: e.sourceDir, seed: 2 }, "extra", "still"));
    const error = await errorOf(prepareExport({ destinationAbs: e.dest, input: inp, expectedCurrent: first.current }));
    expect(error.details.reason).toBe("unowned-collision");
    expect(error.details.path).toBe(collide);
    expect(await readFile(path.join(e.dest, "current", collide), "utf8")).toBe("human file");
    expect(await pointer(e)).toBe(".releases/exp-1");
    expect(await releases(e)).toEqual(["exp-1"]);
  });

  test("an externally modified owned file is a conflict; current and the file are preserved", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    const edited = path.join(e.dest, "current/assets/cortex/stills/front.png");
    await writeFile(edited, "hand-edited");
    const error = await errorOf(prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-2", 2), expectedCurrent: first.current }));
    expect(error.code).toBe("EXPORT_CONFLICT");
    expect(error.details.reason).toBe("owned-file-modified");
    expect(error.message).toContain("assets/cortex/stills/front.png");
    expect(await readFile(edited, "utf8")).toBe("hand-edited");
    expect(await pointer(e)).toBe(".releases/exp-1");
    expect(await releases(e)).toEqual(["exp-1"]);
  });

  test("an owned file edited between prepare and commit is a conflict that keeps the prior current", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1, true));
    const prepared = await prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-2", 2), expectedCurrent: first.current });
    // Edited after preparation but only in a file the new export no longer has: caught by commit's recheck.
    await writeFile(path.join(e.dest, ".releases/exp-1/assets/old-prop/stills/crate.png"), "late-edit");
    const error = await errorOf(commitExport({ destinationAbs: e.dest, intent: prepared.intent }));
    expect(error.details.reason).toBe("owned-file-modified");
    expect(await pointer(e)).toBe(".releases/exp-1");
    expect(await releases(e)).toEqual(["exp-1"]);
  });

  test("failure during staging leaves the prior current intact and no staging debris", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    const error = await prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-2", 2), expectedCurrent: first.current, fault: "fail-during-staging" }).catch((x: unknown) => x);
    expect(error).toBeInstanceOf(InjectedFault);
    expect(await pointer(e)).toBe(".releases/exp-1");
    expect(await releases(e)).toEqual(["exp-1"]);
  });

  test("failure before the switch keeps the prior export resolvable; recovery removes only the prepared release", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    const prepared = await prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-2", 2), expectedCurrent: first.current });
    const error = await commitExport({ destinationAbs: e.dest, intent: prepared.intent, fault: "fail-before-switch" }).catch((x: unknown) => x);
    expect(error).toBeInstanceOf(InjectedFault);
    expect(await pointer(e)).toBe(".releases/exp-1");
    expect(JSON.parse(await readFile(path.join(e.dest, "current/manifest.json"), "utf8")).exportId).toBe("exp-1");
    expect(await releases(e)).toEqual(["exp-1", "exp-2"]);
    const recovered = await recoverExport({ destinationAbs: e.dest, intent: prepared.intent });
    expect(recovered.status).toBe("aborted");
    expect(await releases(e)).toEqual(["exp-1"]);
    expect(await pointer(e)).toBe(".releases/exp-1");
  });

  test("recovery keeps a prepared-release file whose bytes changed instead of deleting it", async () => {
    const e = await env();
    const prepared = await prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-1", 1) });
    await writeFile(path.join(e.dest, ".releases/exp-1/assets/cortex/stills/front.png"), "changed");
    const recovered = await recoverExport({ destinationAbs: e.dest, intent: prepared.intent });
    expect(recovered.status).toBe("aborted");
    expect(recovered.warnings.join(" ")).toContain("front.png");
    expect(await exists(path.join(e.dest, ".releases/exp-1/assets/cortex/stills/front.png"))).toBe(true);
    expect(await exists(path.join(e.dest, ".releases/exp-1/assets/cortex/asset.json"))).toBe(false);
  });

  test("a crash after the switch is recovered as success without a second export", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    const prepared = await prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-2", 2), expectedCurrent: first.current });
    const crash = await commitExport({ destinationAbs: e.dest, intent: prepared.intent, fault: "fail-after-switch" }).catch((x: unknown) => x);
    expect(crash).toBeInstanceOf(InjectedFault);
    expect(await pointer(e)).toBe(".releases/exp-2");
    expect(await releases(e)).toEqual(["exp-1", "exp-2"]);
    const recovered = await recoverExport({ destinationAbs: e.dest, intent: prepared.intent });
    expect(recovered.status).toBe("committed");
    expect(await releases(e)).toEqual(["exp-2"]);
    expect((await commitExport({ destinationAbs: e.dest, intent: prepared.intent })).status).toBe("already-committed");
    expect(await releases(e)).toEqual(["exp-2"]);
  });

  test("current that is a real directory, a foreign symlink, or escapes is refused and untouched", async () => {
    for (const make of ["dir", "absolute", "escape"] as const) {
      const e = await env();
      await mkdir(e.dest, { recursive: true });
      const current = path.join(e.dest, "current");
      if (make === "dir") {
        await writeText(path.join(current, "mine.txt"), "mine");
      } else {
        const outside = path.join(e.dest, "..", "elsewhere");
        await mkdir(outside, { recursive: true });
        await symlink(make === "absolute" ? outside : "../elsewhere", current);
      }
      const error = await errorOf(prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-1", 1) }));
      expect(error.code).toBe("EXPORT_CONFLICT");
      expect(error.details.reason).toBe(make === "dir" ? "unowned-current" : "unowned-symlink");
      expect((await lstat(current)).isSymbolicLink()).toBe(make !== "dir");
    }
  });

  test("a pointer to a release the project has no record of is a conflict even when it validates", async () => {
    const e = await env();
    await publish(e, await input(e, "exp-1", 1));
    const error = await errorOf(prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-2", 2) }));
    expect(error.details.reason).toBe("unknown-release");
    const wrong = await errorOf(prepareExport({ destinationAbs: e.dest, input: await input(e, "exp-2", 2), expectedCurrent: { exportId: "exp-1", manifestSha256: "0".repeat(64) } }));
    expect(wrong.details.reason).toBe("unknown-release");
    expect(await releases(e)).toEqual(["exp-1"]);
  });

  test("a missing pointer warns and publishes into the unoccupied current", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    await rm(path.join(e.dest, "current"));
    const second = await publish(e, await input(e, "exp-2", 2), first.current);
    expect(second.prepared.warnings.join(" ")).toContain("gone");
    expect(await pointer(e)).toBe(".releases/exp-2");
    expect(await exists(path.join(e.dest, ".releases/exp-1"))).toBe(true); // retired releases are preserved, never guessed at
  });

  test("concurrent exports to one destination are serialized; the loser conflicts instead of overwriting", async () => {
    const e = await env();
    const first = await publish(e, await input(e, "exp-1", 1));
    const inputA = await input(e, "exp-2", 2);
    const inputB = await input(e, "exp-3", 3);
    const [a, b] = await Promise.all([
      prepareExport({ destinationAbs: e.dest, input: inputA, expectedCurrent: first.current }),
      prepareExport({ destinationAbs: e.dest, input: inputB, expectedCurrent: first.current }),
    ]);
    await commitExport({ destinationAbs: e.dest, intent: a.intent });
    const error = await errorOf(commitExport({ destinationAbs: e.dest, intent: b.intent }));
    expect(error.details.reason).toBe("current-changed");
    expect(await pointer(e)).toBe(".releases/exp-2");
    expect(await releases(e)).toEqual(["exp-2"]);
  });

  test("a stale lock from a dead process is taken over", async () => {
    const e = await env();
    await mkdir(path.join(e.dest, ".releases"), { recursive: true });
    await writeFile(path.join(e.dest, ".releases/.lock"), JSON.stringify({ pid: 2 ** 22 - 1, token: "dead", createdAt: Date.now() }));
    const { committed } = await publish(e, await input(e, "exp-1", 1));
    expect(committed.status).toBe("committed");
  });

  test("godot4 is blocked on the field that is wrong, and generic exports to the same destination still work", async () => {
    const e = await env();
    const base = path.dirname(path.dirname(path.dirname(e.dest)));
    const g = await input(e, "exp-1", 1);
    g.preset = "godot4";
    g.godot = { projectRootAbs: path.join(base, "game"), resRootPrefix: "res://assets/brainforge" };
    const noProject = await errorOf(prepareExport({ destinationAbs: e.dest, input: g }));
    expect(noProject.code).toBe("EXPORT_BLOCKED");
    expect(noProject.details.field).toBe("godotProjectRoot");
    await writeText(path.join(base, "game/project.godot"), "config_version=5\n");
    g.godot = { projectRootAbs: path.join(base, "game", "assets", "brainforge", "nope"), resRootPrefix: "res://x" };
    const outside = await errorOf(prepareExport({ destinationAbs: e.dest, input: g }));
    expect(outside.details.field).toBe("godotProjectRoot");
    const elsewhere = await errorOf(prepareExport({ destinationAbs: path.join(base, "outside"), input: { ...g, godot: { projectRootAbs: path.join(base, "game"), resRootPrefix: "res://x" } } }));
    expect(elsewhere.details.field).toBe("destination");
    expect((await publish(e, await input(e, "exp-2", 2))).committed.status).toBe("committed");
  });
});


