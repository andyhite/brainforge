import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AssetSpec, ProjectSpec, StyleSpec, type AuthoredKind } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import { parseAuthored } from "../src/index.ts";
import { SPEC_EXAMPLES } from "../src/handlers/spec-examples.ts";
import { ASSET_YAML, agent, createHarness, expectOk, initializedGame, put } from "./helpers.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

const KINDS: AuthoredKind[] = ["project", "style", "asset"];
const SCHEMAS = { project: ProjectSpec, style: StyleSpec, asset: AssetSpec };

function pathFor(kind: AuthoredKind): string {
  const ex = SPEC_EXAMPLES[kind];
  const id = kind === "project" ? "project" : kind === "style" ? "cranium" : "cortex";
  return ex.pathPattern.replace("<id>", id);
}

describe("spec examples", () => {
  for (const kind of KINDS) {
    test(`${kind}: minimal and full examples pass the authored parser`, () => {
      const ex = SPEC_EXAMPLES[kind];
      const id = kind === "project" ? "project" : kind === "style" ? "cranium" : "cortex";
      for (const text of [ex.minimal, ex.full]) {
        const file = parseAuthored(kind, pathFor(kind), id, text);
        expect(file.problems).toEqual([]);
        expect(file.valid).toBe(true);
      }
    });

    test(`${kind}: spec.schema works without a project and exposes top-level keys`, async () => {
      const data = expectOk(await h.call("spec.schema", { kind }));
      expect(data.pathPattern).toBe(SPEC_EXAMPLES[kind].pathPattern);
      expect(data.conventions.length).toBeGreaterThan(0);
      const schema = data.jsonSchema as { properties?: Record<string, unknown> };
      for (const key of Object.keys(SCHEMAS[kind].shape)) expect(schema.properties).toHaveProperty(key);
    });

    test(`${kind}: conventions state what is sent to the model`, async () => {
      const data = expectOk(await h.call("spec.schema", { kind }));
      expect(data.conventions.some((c) => c.includes("sent to model: yes"))).toBe(true);
      expect(data.conventions.some((c) => c.includes("sent to model: no"))).toBe(true);
      expect(data.conventions.some((c) => c.includes("plan.prompt"))).toBe(true);
      if (kind !== "style") expect(data.conventions.some((c) => c.startsWith("notes: sent to model: no"))).toBe(true);
      if (kind === "style") expect(data.conventions.some((c) => c.startsWith("description: sent to model: no"))).toBe(true);
    });

    test(`${kind}: examples carry notes where the schema has them`, () => {
      const ex = SPEC_EXAMPLES[kind];
      if (kind !== "style") expect(ex.full).toContain("\nnotes:");
    });
  }
});

describe("spec.validate", () => {
  const assetPath = "brainforge/assets/cortex/asset.yaml";

  test("reports field-level problems for a bad minimal asset", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    const text = "schema: brainforge.asset.v2\nid: cortex\n";
    const r = expectOk(await h.call("spec.validate", { path: assetPath, text }, { project: root }));
    expect(r.valid).toBe(false);
    expect(r.kind).toBe("asset");
    expect(r.problems.map((p) => p.field).sort()).toEqual(["description", "family", "name"]);
    expect(r.textHash).toBe(sha256(text));
    expect(r.currentHash).toBeNull();
  });

  test("full example is valid; nothing is written, revised, or recorded", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    await put(root, assetPath, ASSET_YAML);
    const open = h.registry.getOpen(root);
    const count = (): number => open?.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM spec_revisions").get()?.n ?? -1;
    const revisionBefore = open?.revision();
    const countBefore = count();

    const r = expectOk(await h.call("spec.validate", { path: assetPath, text: SPEC_EXAMPLES.asset.full }, { project: root, context: agent }));
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.currentHash).toBe(sha256(ASSET_YAML));

    expect(await readFile(join(root, assetPath), "utf8")).toBe(ASSET_YAML);
    expect(open?.revision()).toBe(revisionBefore);
    expect(count()).toBe(countBefore);
  });

  test("reports an id that differs from the directory name", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    const r = expectOk(await h.call("spec.validate", { path: "brainforge/assets/other/asset.yaml", text: SPEC_EXAMPLES.asset.minimal }, { project: root }));
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => p.field === "id" && p.message.includes("other"))).toBe(true);
  });

  test("rejects paths that are not authored locations", async () => {
    const root = await initializedGame(h);
    expectOk(await h.call("project.open", { path: root }));
    const r = await h.call("spec.validate", { path: "notes/readme.yaml", text: "a: 1\n" }, { project: root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });
});
