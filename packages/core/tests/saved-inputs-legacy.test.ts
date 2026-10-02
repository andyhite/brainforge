import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { sha256 } from "@brainforge/storage";
import type { AuthoredSet } from "../src/authored.ts";
import { savedInputs } from "../src/branches/basis.ts";
import { PROJECT_MINIMAL } from "../src/handlers/spec-examples.ts";

test("a retained project.yaml that still names the removed maxAttemptsPerStep stays usable, with its text and hash intact", () => {
  const legacy = `${PROJECT_MINIMAL}automation:\n  maxAttemptsPerStep: 3\n  maxBatchCandidates: 2\n`;
  const hash = sha256(legacy);
  const db = new Database(":memory:");
  db.exec("CREATE TABLE spec_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, sha256 TEXT NOT NULL, text TEXT NOT NULL)");
  db.query("INSERT INTO spec_revisions (path, sha256, text) VALUES ('brainforge/project.yaml', ?, ?)").run(hash, legacy);
  const current: AuthoredSet = { project: undefined, styles: [], assets: [], bareAssetDirs: [], all: () => [] };

  const { set, unavailable } = savedInputs(db, current, { "brainforge/project.yaml": hash });

  expect(unavailable).toEqual([]);
  expect(set.project?.hash).toBe(hash);
  expect(set.project?.text).toBe(legacy);
  expect(set.project?.valid).toBe(true);
  expect(set.project?.spec?.automation.maxBatchCandidates).toBe(2);
});
