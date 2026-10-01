import { afterAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@brainforge/storage";
import { patchYamlField } from "../src/index.ts";
import { ASSET_YAML, PROJECT_YAML, agent, createHarness, expectOk, human, initializedGame, makePng, put, tempGameDir } from "./helpers.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

async function openGame(): Promise<string> {
  const root = await initializedGame(h);
  expectOk(await h.call("project.open", { path: root }));
  return root;
}

describe("project.init", () => {
  test("preview lists planned paths without writing; confirm creates only owned paths and preserves asset work", async () => {
    const root = await tempGameDir();
    await put(root, "brainforge/assets/cortex/work/feasibility/t1/receipt.json", "{}");
    await put(root, "docs/readme.md", "game docs");

    const preview = expectOk(await h.call("project.init", { path: root, name: "Shit Brain", confirm: false }));
    expect(preview.confirmed).toBe(false);
    expect(preview.created).toEqual([]);
    expect(preview.plannedPaths).toContain("brainforge/project.yaml");
    expect(preview.plannedPaths).toContain("brainforge/.gdignore");
    expect(preview.existingPaths).toContain("brainforge/assets");
    expect(await lstat(join(root, "brainforge/project.yaml")).catch(() => null)).toBeNull();

    const done = expectOk(await h.call("project.init", { path: root, name: "Shit Brain", confirm: true }));
    expect(done.created.sort()).toEqual(preview.plannedPaths.slice().sort());
    expect(await readFile(join(root, "brainforge/assets/cortex/work/feasibility/t1/receipt.json"), "utf8")).toBe("{}");
    expect(await readFile(join(root, "brainforge/project.yaml"), "utf8")).toContain("id: shit-brain");
    expect((await lstat(join(root, "brainforge/.state/project.sqlite"))).isFile()).toBe(true);
    // nothing outside brainforge/ was created
    expect(await lstat(join(root, "assets")).catch(() => null)).toBeNull();

    const again = expectOk(await h.call("project.init", { path: root, confirm: false }));
    expect(again.plannedPaths).toEqual([]);
  });

  test("refuses to replace an invalid existing project.yaml", async () => {
    const root = await tempGameDir();
    await put(root, "brainforge/project.yaml", "schema: something-else\n");
    const r = await h.call("project.init", { path: root, confirm: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SPEC_CONFLICT");
    expect(await readFile(join(root, "brainforge/project.yaml"), "utf8")).toBe("schema: something-else\n");
  });
});

describe("project.open", () => {
  test("does not search ancestors and never treats brainforge/ as a project", async () => {
    const root = await initializedGame(h);
    await mkdir(join(root, "sub/dir"), { recursive: true });

    const sub = await h.call("project.open", { path: join(root, "sub/dir") });
    expect(sub.ok).toBe(false);
    if (!sub.ok) {
      expect(sub.error.code).toBe("NOT_FOUND");
      expect(sub.error.recoveryActions[0]?.operation).toBe("project.init");
    }

    const inner = await h.call("project.open", { path: join(root, "brainforge") });
    expect(inner.ok).toBe(false);
    if (!inner.ok) {
      expect(inner.error.code).toBe("INVALID_INPUT");
      expect(inner.error.message).toContain(root);
    }
  });

  test("opens, records recent, reports invalid project.yaml without failing", async () => {
    const root = await openGame();
    expect(h.recents.at(-1)?.root).toBe(root);
    await put(root, "brainforge/project.yaml", "schema: [unterminated\n");
    const inspect = expectOk(await h.call("project.inspect", {}, { project: root }));
    expect(inspect.project.specValid).toBe(false);
    expect(inspect.project.problems[0]?.line).toBeGreaterThan(0);
    expect(inspect.project.root).toBe(root);
  });
});

describe("spec.write", () => {
  test("identical retry replays, changed payload conflicts, validation failures are not cached", async () => {
    const root = await openGame();
    const p = { project: root, requestId: "idem-1" };
    const first = expectOk(await h.call("spec.write", { path: "brainforge/assets/cortex/asset.yaml", text: ASSET_YAML, expectedHash: null }, p));
    const replay = expectOk(await h.call("spec.write", { path: "brainforge/assets/cortex/asset.yaml", text: ASSET_YAML, expectedHash: null }, p));
    expect(replay).toEqual(first);
    const rows = await h.call("spec.list", {}, { project: root });
    expect(rows.ok && rows.data.files.filter((f) => f.path.endsWith("cortex/asset.yaml")).length).toBe(1);

    const changed = await h.call("spec.write", { path: "brainforge/assets/cortex/asset.yaml", text: `${ASSET_YAML}# x\n`, expectedHash: null }, p);
    expect(changed.ok === false && changed.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // a handler-level refusal releases the reservation, so the same requestId can be reused once corrected
    const bad = await h.call("spec.write", { path: "brainforge/notes.yaml", text: "a: 1\n", expectedHash: null }, { project: root, requestId: "idem-2" });
    expect(bad.ok === false && bad.error.code).toBe("INVALID_INPUT");
    const good = await h.call("spec.write", { path: "brainforge/styles/cranium.yaml", text: "schema: brainforge.style.v2\nid: cranium\n", expectedHash: null }, { project: root, requestId: "idem-2" });
    expect(good.ok).toBe(true);
  });

  test("stale hash returns SPEC_CONFLICT with both texts and keeps the draft", async () => {
    const root = await openGame();
    const path = "brainforge/assets/cortex/asset.yaml";
    const created = expectOk(await h.call("spec.write", { path, text: ASSET_YAML, expectedHash: null }, { project: root }));
    await writeFile(join(root, path), `${ASSET_YAML}# edited externally\n`);

    const mine = `${ASSET_YAML}# mine\n`;
    const r = await h.call("spec.write", { path, text: mine, expectedHash: created.hash }, { project: root, context: agent });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("SPEC_CONFLICT");
    const d = r.error.details as { currentText: string; yourText: string; currentHash: string; expectedHash: string };
    expect(d.currentText).toContain("edited externally");
    expect(d.yourText).toBe(mine);
    expect(d.expectedHash).toBe(created.hash);
    expect(d.currentHash).toBe(sha256(d.currentText));
    expect(await readFile(join(root, path), "utf8")).toContain("edited externally");

    const handle = h.registry.getOpen(root);
    const drafts = handle?.db.query<{ text: string }, []>("SELECT text FROM spec_drafts").all() ?? [];
    expect(drafts.map((x) => x.text)).toContain(mine);
    // the external bytes were retained as a revision
    const revs = handle?.db.query<{ source: string; text: string }, [string]>("SELECT source, text FROM spec_revisions WHERE path = ? ORDER BY id").all(path) ?? [];
    expect(revs.map((x) => x.source)).toEqual(["app", "external"]);
  });

  test("exclusive create conflicts with an existing file", async () => {
    const root = await openGame();
    const path = "brainforge/assets/cortex/asset.yaml";
    expectOk(await h.call("spec.write", { path, text: ASSET_YAML, expectedHash: null }, { project: root }));
    const r = await h.call("spec.write", { path, text: ASSET_YAML, expectedHash: null }, { project: root });
    expect(r.ok === false && r.error.code).toBe("SPEC_CONFLICT");
  });

  test("invalid YAML is saved with problems, history stays readable, other files unaffected", async () => {
    const root = await openGame();
    const path = "brainforge/assets/cortex/asset.yaml";
    const ok = expectOk(await h.call("spec.write", { path, text: ASSET_YAML, expectedHash: null }, { project: root }));
    expect(ok.problems).toEqual([]);

    const broken = "schema: brainforge.asset.v2\nid: cortex\nname: [oops\n";
    const saved = expectOk(await h.call("spec.write", { path, text: broken, expectedHash: ok.hash }, { project: root }));
    expect(saved.problems.length).toBeGreaterThan(0);
    expect(saved.problems[0]?.file).toBe(path);
    expect(saved.problems[0]?.line).toBeGreaterThan(0);

    const schemaBad = expectOk(await h.call("spec.write", { path, text: ASSET_YAML.replace("family: character", "family: wizard\nbogus: 1"), expectedHash: saved.hash }, { project: root }));
    expect(schemaBad.problems.some((p) => p.field === "family")).toBe(true);
    expect(schemaBad.problems.some((p) => p.field === "bogus")).toBe(true);
    expect(schemaBad.problems.find((p) => p.field === "family")?.line).toBe(4);

    const list = expectOk(await h.call("spec.list", {}, { project: root }));
    expect(list.files.find((f) => f.path === path)?.valid).toBe(false);
    expect(list.files.find((f) => f.path === "brainforge/project.yaml")?.valid).toBe(true);
    const asset = expectOk(await h.call("asset.list", {}, { project: root }));
    expect(asset.assets[0]).toMatchObject({ assetId: "cortex", valid: false });

    const revs = h.registry.getOpen(root)?.db.query<{ text: string }, [string]>("SELECT text FROM spec_revisions WHERE path = ? ORDER BY id").all(path) ?? [];
    expect(revs.map((r) => r.text)).toContain(ASSET_YAML);
    expect(revs.length).toBe(3);
  });

  test("portable-values violation is a validation problem, not a refusal", async () => {
    const root = await openGame();
    const r = expectOk(await h.call("spec.write", { path: "brainforge/project.yaml", text: `${PROJECT_YAML}artDirection: http://127.0.0.1:8188\n`, expectedHash: sha256(PROJECT_YAML) }, { project: root }));
    expect(r.problems.some((p) => p.message.includes("connection URLs"))).toBe(true);
  });

  test("id must equal the directory name", async () => {
    const root = await openGame();
    const r = expectOk(await h.call("spec.write", { path: "brainforge/assets/cortex/asset.yaml", text: ASSET_YAML.replace("id: cortex", "id: other"), expectedHash: null }, { project: root }));
    expect(r.problems.some((p) => p.field === "id")).toBe(true);
  });

  test("external edit is detected on the next list and read", async () => {
    const root = await openGame();
    const before = expectOk(await h.call("spec.list", {}, { project: root }));
    const projectBefore = before.files.find((f) => f.kind === "project");
    await writeFile(join(root, "brainforge/project.yaml"), `${PROJECT_YAML}artDirection: scribbled by hand\n`);
    const after = expectOk(await h.call("spec.list", {}, { project: root }));
    const projectAfter = after.files.find((f) => f.kind === "project");
    expect(projectAfter?.hash).not.toBe(projectBefore?.hash);
    const read = expectOk(await h.call("spec.read", { path: "brainforge/project.yaml" }, { project: root }));
    expect(read.text).toContain("scribbled by hand");
    const revs = h.registry.getOpen(root)?.db.query<{ source: string }, []>("SELECT source FROM spec_revisions WHERE path = 'brainforge/project.yaml' ORDER BY id").all() ?? [];
    expect(revs.map((r) => r.source)).toEqual(["initial", "external"]);
  });
});

describe("settings.inspect", () => {
  test("playbackFps source follows all four precedence levels", async () => {
    const root = await openGame();
    const projectPath = "brainforge/project.yaml";
    const assetPath = "brainforge/assets/cortex/asset.yaml";
    const fpsLeaf = async () => {
      const r = expectOk(await h.call("settings.inspect", { assetId: "cortex", deliverableId: "walk" }, { project: root }));
      return r.effective["animation.playbackFps"];
    };
    const asset = (extra: string, delivExtra = "") => `${ASSET_YAML}${extra}deliverables:\n  - id: walk\n    kind: animation\n${delivExtra}`;

    await put(root, projectPath, `${PROJECT_YAML}defaults:\n  animation:\n    playbackFps: 12\n`);
    await put(root, assetPath, asset(""));
    expect(await fpsLeaf()).toEqual({ value: 12, source: { file: projectPath, field: "defaults.animation.playbackFps", layer: "project-defaults" } });

    await put(root, projectPath, `${PROJECT_YAML}defaults:\n  animation:\n    playbackFps: 12\nfamilyDefaults:\n  character:\n    animation:\n      playbackFps: 16\n`);
    expect(await fpsLeaf()).toEqual({ value: 16, source: { file: projectPath, field: "familyDefaults.character.animation.playbackFps", layer: "family-defaults" } });

    await put(root, assetPath, asset("overrides:\n  animation:\n    playbackFps: 20\n"));
    expect(await fpsLeaf()).toEqual({ value: 20, source: { file: assetPath, field: "overrides.animation.playbackFps", layer: "asset" } });

    await put(root, assetPath, asset("overrides:\n  animation:\n    playbackFps: 20\n", "    overrides:\n      animation:\n        playbackFps: 24\n"));
    expect(await fpsLeaf()).toEqual({ value: 24, source: { file: assetPath, field: "deliverables[walk].overrides.animation.playbackFps", layer: "deliverable" } });

    // objects merge: a project-level key survives an asset override of a sibling key
    await put(root, projectPath, `${PROJECT_YAML}defaults:\n  processing:\n    resize: lanczos3\n    pad: 4\n`);
    await put(root, assetPath, `${ASSET_YAML}overrides:\n  processing:\n    pad: 8\n`);
    const merged = expectOk(await h.call("settings.inspect", { assetId: "cortex" }, { project: root })).effective;
    expect(merged["processing.pad"]?.value).toBe(8);
    expect(merged["processing.pad"]?.source.layer).toBe("asset");
    expect(merged["processing.resize"]?.source.layer).toBe("project-defaults");
    expect(merged["approval.promotion"]?.source.layer).toBe("built-in");
  });

  test("unknown asset is NOT_FOUND", async () => {
    const root = await openGame();
    const r = await h.call("settings.inspect", { assetId: "nope" }, { project: root });
    expect(r.ok === false && r.error.code).toBe("NOT_FOUND");
  });

  test("styles that disagree on a palette are reported as a conflict", async () => {
    const root = await openGame();
    await put(root, "brainforge/project.yaml", `${PROJECT_YAML}styleIds: [cranium, grim]\n`);
    await put(root, "brainforge/styles/cranium.yaml", "schema: brainforge.style.v2\nid: cranium\npalette: [coral, white]\n");
    await put(root, "brainforge/styles/grim.yaml", "schema: brainforge.style.v2\nid: grim\npalette: [grey, black]\n");
    const r = expectOk(await h.call("settings.inspect", {}, { project: root }));
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]?.field).toBe("palette");
    expect(r.conflicts[0]?.values.map((v) => v.file)).toEqual(["brainforge/styles/cranium.yaml", "brainforge/styles/grim.yaml"]);
    expect(r.effective["style.cranium.palette"]?.value).toEqual(["coral", "white"]);
    expect(r.effective["style.grim.palette"]?.value).toEqual(["grey", "black"]);
  });
});

describe("policy", () => {
  test("requested vs effective, hash check, human only", async () => {
    const root = await openGame();
    const initial = expectOk(await h.call("settings.inspect", {}, { project: root })).policy;
    expect(initial.effective).toEqual({ conceptLock: "human", productionReview: "agent_with_escalation", promotion: "human", activation: "human" });
    expect(initial.pendingRelaxation).toBe(false);
    expect(initial.diff).toEqual([]);

    await put(root, "brainforge/project.yaml", `${PROJECT_YAML}approval:\n  promotion: agent\n  productionReview: human\n`);
    const relaxed = expectOk(await h.call("settings.inspect", {}, { project: root })).policy;
    expect(relaxed.pendingRelaxation).toBe(true);
    expect(relaxed.effective.promotion).toBe("human");
    expect(relaxed.requested.promotion).toBe("agent");
    expect(relaxed.diff.map((d) => d.field).sort()).toEqual(["productionReview", "promotion"]);
    expect(relaxed.requestedPolicyHash).not.toBe(initial.requestedPolicyHash);

    const denied = await h.call("policy.authorize", { requestedPolicyHash: relaxed.requestedPolicyHash }, { project: root, context: agent });
    expect(denied.ok === false && denied.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");

    const stale = await h.call("policy.authorize", { requestedPolicyHash: initial.requestedPolicyHash }, { project: root });
    expect(stale.ok === false && stale.error.code).toBe("REVISION_CONFLICT");

    const confirmed = expectOk(await h.call("policy.authorize", { requestedPolicyHash: relaxed.requestedPolicyHash }, { project: root })).policy;
    expect(confirmed.effective.promotion).toBe("agent");
    expect(confirmed.pendingRelaxation).toBe(false);
    expect(confirmed.confirmedBy).toBe(human.actorId);
    const events = h.registry.getOpen(root)?.eventsAfter(0).events.map((e) => e.type) ?? [];
    expect(events).toContain("policy.confirmed");
  });
});

describe("reference.import", () => {
  test("copies a PNG into project or asset scope without altering the source", async () => {
    const root = await openGame();
    const srcDir = await tempGameDir();
    const png = makePng(8, 6, [255, 0, 0]);
    await writeFile(join(srcDir, "early.png"), png);

    const shared = expectOk(await h.call("reference.import", { sourcePath: join(srcDir, "early.png"), label: "Early Concept", scope: "project" }, { project: root }));
    expect(shared.path).toMatch(/^brainforge\/references\/early-concept-[0-9a-f]{6}\/early\.png$/);
    expect(shared).toMatchObject({ width: 8, height: 6, sha256: sha256(png) });
    expect(new Uint8Array(await readFile(join(root, shared.path)))).toEqual(new Uint8Array(png));
    expect(new Uint8Array(await readFile(join(srcDir, "early.png")))).toEqual(new Uint8Array(png));

    const missing = await h.call("reference.import", { sourcePath: join(srcDir, "early.png"), label: "x", scope: "asset", assetId: "ghost" }, { project: root });
    expect(missing.ok === false && missing.error.code).toBe("NOT_FOUND");

    await mkdir(join(root, "brainforge/assets/cortex"), { recursive: true });
    const scoped = expectOk(await h.call("reference.import", { contentBase64: png.toString("base64"), filename: "side.png", label: "Side", scope: "asset", assetId: "cortex" }, { project: root }));
    expect(scoped.path).toMatch(/^brainforge\/assets\/cortex\/references\/side-[0-9a-f]{6}\/side\.png$/);
    const rows = h.registry.getOpen(root)?.db.query<{ scope: string; asset_id: string | null }, []>("SELECT scope, asset_id FROM reference_records ORDER BY created_at").all() ?? [];
    expect(rows.map((r) => r.scope)).toEqual(["project", "asset"]);

    await writeFile(join(srcDir, "fake.png"), "not an image");
    const fake = await h.call("reference.import", { sourcePath: join(srcDir, "fake.png"), label: "fake", scope: "project" }, { project: root });
    expect(fake.ok === false && fake.error.code).toBe("INVALID_INPUT");
    const dir = await h.call("reference.import", { sourcePath: srcDir, label: "dir", scope: "project" }, { project: root });
    expect(dir.ok === false && dir.error.code).toBe("INVALID_INPUT");
  });
});

describe("project.snapshot", () => {
  test("is openable at a new path with DB, references and a literal relative current link", async () => {
    const root = await openGame();
    expectOk(await h.call("spec.write", { path: "brainforge/assets/cortex/asset.yaml", text: ASSET_YAML, expectedHash: null }, { project: root }));
    const png = makePng(4, 4, [0, 255, 0]);
    const ref = expectOk(await h.call("reference.import", { contentBase64: png.toString("base64"), filename: "r.png", label: "Ref", scope: "project" }, { project: root }));
    await put(root, "assets/brainforge/.releases/rel-1/manifest.json", "{}");
    await symlink(".releases/rel-1", join(root, "assets/brainforge/current"));
    await put(root, "brainforge/assets/cortex/work/runs/r1/inputs.json", "{\"a\":1}");
    await put(root, "brainforge/.state/staging/op1/partial.bin", "half");

    const parent = await tempGameDir();
    const dest = join(parent, "copy");
    const snap = expectOk(await h.call("project.snapshot", { destination: dest }, { project: root }));
    expect(snap.links).toBe(1);

    expect(await readlink(join(dest, "assets/brainforge/current"))).toBe(".releases/rel-1");
    expect(await readFile(join(dest, "assets/brainforge/current/manifest.json"), "utf8")).toBe("{}");
    expect(await readFile(join(dest, "brainforge/assets/cortex/work/runs/r1/inputs.json"), "utf8")).toBe("{\"a\":1}");
    expect(await lstat(join(dest, "brainforge/.gdignore"))).toBeTruthy();
    expect(await lstat(join(dest, "brainforge/.state/lease")).catch(() => null)).toBeNull();
    expect(await lstat(join(dest, "brainforge/.state/staging/op1")).catch(() => null)).toBeNull();
    expect(await lstat(join(dest, "brainforge/.state/project.sqlite-wal")).catch(() => null)).toBeNull();

    const opened = expectOk(await h.call("project.open", { path: dest }));
    expect(opened.project.root).toBe(dest.replace(parent, parent));
    expect(opened.project.needsRebind).toBe(true);
    const db = h.registry.getOpen(dest)?.db;
    expect(db?.query<{ reference_id: string }, []>("SELECT reference_id FROM reference_records").all().map((r) => r.reference_id)).toEqual([ref.referenceId]);
    expect(expectOk(await h.call("spec.list", {}, { project: dest })).files.map((f) => f.path)).toContain("brainforge/assets/cortex/asset.yaml");
    expect(expectOk(await h.call("project.close", {}, { project: dest })).state).toBe("closed");
  });

  test("refuses a symlink that escapes and leaves no partial copy", async () => {
    const root = await openGame();
    const outside = await tempGameDir();
    await symlink(outside, join(root, "brainforge/assets/evil"));
    const parent = await tempGameDir();
    const dest = join(parent, "copy");
    const r = await h.call("project.snapshot", { destination: dest }, { project: root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("evil");
    expect(await lstat(dest).catch(() => null)).toBeNull();

    const inside = await h.call("project.snapshot", { destination: join(root, "copy") }, { project: root });
    expect(inside.ok === false && inside.error.code).toBe("INVALID_INPUT");
  });
});

describe("asset.inspect and workflows", () => {
  test("asset directories and requirement flag", async () => {
    const root = await openGame();
    await put(root, "brainforge/project.yaml", `${PROJECT_YAML}requirements:\n  assets: [cortex]\n`);
    await put(root, "brainforge/assets/cortex/asset.yaml", ASSET_YAML);
    await put(root, "brainforge/assets/cortex/work/candidates/c1/original/a.png", "x");
    const r = expectOk(await h.call("asset.inspect", { assetId: "cortex" }, { project: root }));
    expect(r.summary.required).toBe(true);
    expect(r.directories.find((d) => d.path.endsWith("work/candidates"))).toEqual({ path: "brainforge/assets/cortex/work/candidates", exists: true, fileCount: 1 });
    expect(r.directories.find((d) => d.path.endsWith("versions"))?.exists).toBe(false);
    const missing = await h.call("asset.inspect", { assetId: "zzz" }, { project: root });
    expect(missing.ok === false && missing.error.code).toBe("NOT_FOUND");
  });

  test("workflow list/inspect work; preflight without a URL points at connection.set", async () => {
    const root = await openGame();
    const list = expectOk(await h.call("workflow.list", {}, { project: root }));
    expect(list.workflows.map((w) => w.id)).toContain("krea2-still");
    const wf = expectOk(await h.call("workflow.inspect", { workflowId: "krea2-still" }, { project: root }));
    expect(wf.graphHash).toMatch(/^[0-9a-f]{64}$/);
    expect(wf.execution.computeLocation.length).toBeGreaterThan(0);
    const nf = await h.call("workflow.inspect", { workflowId: "nope" }, { project: root });
    expect(nf.ok === false && nf.error.code).toBe("NOT_FOUND");
    h.setComfyUrl(undefined);
    const pre = await h.call("workflow.preflight", { workflowId: "krea2-still" }, { project: root });
    expect(pre.ok).toBe(false);
    if (!pre.ok) {
      expect(pre.error.code).toBe("WORKFLOW_UNAVAILABLE");
      expect(pre.error.recoveryActions[0]?.operation).toBe("connection.set");
    }
  });
});

describe("patchYamlField", () => {
  test("changes one value and preserves comments and untouched formatting", () => {
    const text = "# top comment\ndefaults:\n  animation:\n    playbackFps: 12 # chosen at M0\n  sizing: {width: 256, height: 256}\nname: Demo\n";
    const out = patchYamlField(text, "defaults.animation.playbackFps", 16);
    expect(out).toContain("# top comment");
    expect(out).toContain("playbackFps: 16 # chosen at M0");
    expect(out).toContain("{ width: 256, height: 256 }");
    const added = patchYamlField(text, "defaults.perspective", "side");
    expect(added).toContain("perspective: side");
    expect(added).toContain("# chosen at M0");
    expect(patchYamlField(text, "name", undefined)).not.toContain("name: Demo");
    expect(() => patchYamlField("a: [", "a", 1)).toThrow();
  });
});

describe("definition-less asset directories", () => {
  test("work-only asset dir is listed and inspectable until asset.yaml is created", async () => {
    const root = await openGame();
    await put(root, "brainforge/project.yaml", `${PROJECT_YAML}requirements:\n  assets: [cortex]\n`);
    await put(root, "brainforge/assets/cortex/work/feasibility/t1/receipt.json", "{}");
    await put(root, "brainforge/assets/Not_Kebab/work/x.json", "{}");
    h.registry.getOpen(root)?.transact(() => {
      h.registry.getOpen(root)?.db.query("INSERT INTO artifact_records (artifact_id, asset_id, kind, path, meta_json, created_at) VALUES ('a1', 'cortex', 'still', 'brainforge/assets/cortex/work/feasibility/t1/receipt.json', '{}', ?)").run(new Date().toISOString());
    });

    const list = expectOk(await h.call("asset.list", {}, { project: root }));
    expect(list.assets.map((a) => a.assetId)).toEqual(["cortex"]);
    expect(list.assets[0]).toMatchObject({ valid: false, required: true });
    expect(list.assets[0]?.problems.some((p) => p.message.includes("asset.yaml"))).toBe(true);

    const before = expectOk(await h.call("asset.inspect", { assetId: "cortex" }, { project: root }));
    expect(before.yamlPath).toBe("brainforge/assets/cortex/asset.yaml");
    expect(before.yamlHash).toBeUndefined();
    expect(before.registeredArtifacts).toBe(1);
    expect(before.directories.find((d) => d.path.endsWith("work/feasibility"))).toMatchObject({ exists: true, fileCount: 1 });

    const written = expectOk(await h.call("spec.write", { path: "brainforge/assets/cortex/asset.yaml", text: ASSET_YAML, expectedHash: null }, { project: root }));
    const after = expectOk(await h.call("asset.list", {}, { project: root }));
    expect(after.assets[0]).toMatchObject({ assetId: "cortex", valid: true, required: true });
    expect(expectOk(await h.call("asset.inspect", { assetId: "cortex" }, { project: root })).yamlHash).toBe(written.hash);
  });
});
