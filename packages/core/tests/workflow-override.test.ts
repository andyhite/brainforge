import { afterEach, describe, expect, test } from "bun:test";
import { put } from "./helpers.ts";
import { generationFixture, type GenerationFixture } from "./generation-fixture.ts";

const asset = (assetOverrides: string, sheetOverrides: string): string => `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager with an exposed brain.
${assetOverrides}deliverables:
  - id: construction-sheet
    kind: reference-sheet
    description: Construction sheet.
${sheetOverrides}    regions:
      - { id: front, x: 0, y: 0, width: 512, height: 768 }
  - id: idle-rest
    kind: pose
    description: Resting stance.
    dependsOn: [construction-sheet]
`;

const open: GenerationFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.dispose();
});

async function game(yaml: string): Promise<GenerationFixture> {
  const f = await generationFixture({ fake: { latencyMs: 5 } });
  open.push(f);
  await put(f.root, "brainforge/assets/cortex/asset.yaml", yaml);
  return f;
}

describe("authored workflow overrides", () => {
  test("a deliverable override selects the sheet workflow only; a missing workflow blocks only that step", async () => {
    const f = await game(asset("", "    overrides:\n      workflows:\n        variation: krea2-construction-sheet\n"));
    expect((await f.plan({ stepId: "construction-sheet" })).workflow.id).toBe("krea2-construction-sheet");
    await put(f.root, "brainforge/assets/cortex/asset.yaml", asset("", "    overrides:\n      workflows:\n        variation: not-installed\n"));
    const sheet = await f.plan({ stepId: "construction-sheet" });
    expect(sheet.blockers.map((b) => b.code)).toContain("WORKFLOW_UNAVAILABLE");

    const pose = await f.plan({ stepId: "idle-rest" });
    expect(pose.workflow.id).toBe("krea2-variation");
    expect(pose.blockers.map((b) => b.code)).not.toContain("WORKFLOW_UNAVAILABLE");

    const concept = await f.plan();
    expect(concept.workflow.id).toBe("krea2-still");
  });

  test("deliverable beats asset; the alpha-specific key applies only to opaque output", async () => {
    const f = await game(asset("overrides:\n  workflows:\n    variation: asset-level\n", "    overrides:\n      workflows:\n        variation: sheet-level\n        variationOpaque: sheet-opaque\n"));
    expect((await f.plan({ stepId: "construction-sheet" })).workflow.id).toBe("sheet-level");
    expect((await f.plan({ stepId: "idle-rest" })).workflow.id).toBe("asset-level");

    await put(f.root, "brainforge/assets/cortex/asset.yaml", asset("", "    output: { alpha: opaque }\n    overrides:\n      workflows:\n        variation: sheet-level\n        variationOpaque: sheet-opaque\n"));
    expect((await f.plan({ stepId: "construction-sheet" })).workflow.id).toBe("sheet-opaque");
  });
});

