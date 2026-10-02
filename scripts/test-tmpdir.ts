// Preloaded by the `test` scripts of packages whose tests make temp dirs: every temp file of the run lands under one
// directory, removed after the last test file. `bun test` fires neither `exit` nor `beforeExit`, so a preloaded
// (global) afterAll is the cleanup point. os.tmpdir() reads TMPDIR on every call, and spawned children inherit it.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bf-test-"));
process.env.TMPDIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
