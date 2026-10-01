import { mkdir, lstat, open, readFile, readlink, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { ExportManifest, type ExportOwnedFile } from "@brainforge/contracts";
import { buildSnapshot, validateSnapshot } from "./generic.ts";
import {
  ExportError, InjectedFault, copyInto, diffEntries, fsyncDirs, fsyncPath, hashEntries, isEnoent, removeVerifiedFiles, safeJoin,
  sha256Bytes, walkFiles,
} from "./fs.ts";
import { checkGodotRoot } from "./godot4.ts";
import type { CommitResult, ExpectedCurrent, ExportFaults, ExportInput, ExportIntent, PrepareResult, RecoverResult } from "./types.ts";

const RELEASES = ".releases";
const CURRENT = "current";
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10 * 60 * 1000;

const conflict = (message: string, reason: string, p?: string): ExportError => new ExportError("EXPORT_CONFLICT", message, { reason, ...(p ? { path: p } : {}) });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------- per-destination serialization

const queues = new Map<string, Promise<void>>();

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return false; // the in-process queue already serializes us, so our own pid means a dead holder
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLockFile(lockPath: string): Promise<() => Promise<void>> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          if ((JSON.parse(await readFile(lockPath, "utf8")) as { token?: string }).token === token) await unlink(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder: { pid?: number; createdAt?: number } = {};
    try {
      holder = JSON.parse(await readFile(lockPath, "utf8")) as typeof holder;
    } catch {
      // unreadable or half-written: judged by age below
    }
    const age = Date.now() - (holder.createdAt ?? (await stat(lockPath).catch(() => ({ mtimeMs: 0 }))).mtimeMs);
    if (holder.pid === undefined ? age > 1000 : !pidAlive(holder.pid) || age > LOCK_STALE_MS) {
      // Exactly one contender wins the rename; the rest retry against the fresh state.
      const stale = `${lockPath}.stale-${token}`;
      try {
        await rename(lockPath, stale);
        await unlink(stale);
      } catch {
        // someone else already took it
      }
      continue;
    }
    if (Date.now() > deadline) throw conflict(`another export is publishing to this destination (lock ${lockPath} held by pid ${holder.pid})`, "destination-locked", lockPath);
    await sleep(50);
  }
}

/** Serializes everything touching one destination: in-process queue plus an `O_EXCL` lock file with stale-lock recovery. */
async function withDestinationLock<T>(destinationAbs: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(destinationAbs);
  const previous = queues.get(key) ?? Promise.resolve();
  const { promise: gate, resolve: open_ } = Promise.withResolvers<void>();
  const tail = previous.then(() => gate);
  queues.set(key, tail);
  await previous;
  try {
    await ensureReleasesDir(key);
    const unlock = await acquireLockFile(path.join(key, RELEASES, ".lock"));
    try {
      return await fn();
    } finally {
      await unlock();
    }
  } finally {
    open_();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

async function ensureReleasesDir(destinationAbs: string): Promise<void> {
  await mkdir(destinationAbs, { recursive: true });
  const releases = path.join(destinationAbs, RELEASES);
  await mkdir(releases, { recursive: true });
  const st = await lstat(releases);
  if (!st.isDirectory()) throw conflict(`${releases} is not a directory`, "releases-not-directory", releases);
  if (st.dev !== (await stat(destinationAbs)).dev) throw conflict(`${releases} is on a different filesystem than ${destinationAbs}; atomic publication needs the same filesystem`, "cross-filesystem", releases);
}

// --------------------------------------------------------------------------- current / previous release

type CurrentState = { kind: "missing" } | { kind: "release"; exportId: string };

async function readCurrent(destinationAbs: string): Promise<CurrentState> {
  const link = path.join(destinationAbs, CURRENT);
  let st;
  try {
    st = await lstat(link);
  } catch (e) {
    if (isEnoent(e)) return { kind: "missing" };
    throw e;
  }
  if (!st.isSymbolicLink()) throw conflict(`${link} exists and is not a Brainforge-managed symlink; move it or choose another destination`, "unowned-current", link);
  const target = await readlink(link);
  const match = /^\.releases\/([A-Za-z0-9][A-Za-z0-9._-]*)\/?$/.exec(target);
  if (!match) throw conflict(`${link} points to "${target}", not a relative .releases/<export-id> inside this destination`, "unowned-symlink", link);
  const exportId = match[1]!;
  const release = path.join(destinationAbs, RELEASES, exportId);
  if (!(await stat(release).then((s) => s.isDirectory(), () => false))) throw conflict(`${link} points to ${target} which does not exist`, "dangling-current", link);
  return { kind: "release", exportId };
}

interface PreviousRelease {
  exportId: string;
  manifestSha256: string;
  releaseAbs: string;
  files: ExportOwnedFile[];
  unowned: ExportOwnedFile[];
  warnings: string[];
}

async function loadPrevious(destinationAbs: string, exportId: string, projectId: string, expected: ExpectedCurrent | undefined): Promise<PreviousRelease> {
  const releaseAbs = path.join(destinationAbs, RELEASES, exportId);
  const unknown = (why: string): ExportError => conflict(
    `current points to release ${exportId}, which is not a known committed export (${why}). It was preserved; restore the matching project snapshot or choose another destination`,
    "unknown-release",
    path.join(destinationAbs, CURRENT),
  );
  let text: string;
  try {
    text = await readFile(path.join(releaseAbs, "manifest.json"), "utf8");
  } catch (e) {
    if (isEnoent(e)) throw unknown("no manifest.json");
    throw e;
  }
  const parsed = ExportManifest.safeParse(JSON.parse(text));
  if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.exportId !== exportId) throw unknown("manifest is not this project's");
  const manifestSha256 = sha256Bytes(text);
  if (!expected) throw unknown("project state has no record of it");
  if (expected.exportId !== exportId || expected.manifestSha256 !== manifestSha256) throw unknown("it does not match the recorded export");

  const warnings: string[] = [];
  const { missing, modified } = await diffEntries(releaseAbs, parsed.data.ownedFiles);
  if (modified.length > 0) {
    throw conflict(`owned export file(s) were modified outside Brainforge: ${modified.slice(0, 5).join(", ")}${modified.length > 5 ? ` (+${modified.length - 5} more)` : ""}. They were preserved; restore or move them, then export again`, "owned-file-modified", modified[0]);
  }
  if (missing.length > 0) warnings.push(`${missing.length} previously exported file(s) were deleted outside Brainforge and will be regenerated: ${missing.slice(0, 3).join(", ")}`);

  const { files, symlinks } = await walkFiles(releaseAbs);
  if (symlinks.length > 0) throw conflict(`unowned symlink(s) inside current cannot be carried safely: ${symlinks.slice(0, 3).join(", ")}`, "unowned-symlink-in-current", symlinks[0]);
  const ownedPaths = new Set([...parsed.data.ownedFiles.map((f) => f.path), "manifest.json"]);
  const unowned = await hashEntries(releaseAbs, files.filter((f) => !ownedPaths.has(f)));
  return { exportId, manifestSha256, releaseAbs, files: parsed.data.ownedFiles, unowned, warnings };
}

const sameEntries = (a: ExportOwnedFile[], b: ExportOwnedFile[]): boolean =>
  a.length === b.length && a.every((f, i) => f.path === b[i]!.path && f.sha256 === b[i]!.sha256);

// --------------------------------------------------------------------------- prepare

/**
 * Steps 1-2 of publication: verifies the current export (ownership + hashes), stages the complete snapshot (new files plus
 * carried-over unowned files), validates, fsyncs and renames it to `.releases/<export-id>`. `current` is not touched.
 * Throws {@link ExportError} (`EXPORT_CONFLICT`, `EXPORT_BLOCKED`, `INVALID_INPUT`, `IO_ERROR`).
 */
export async function prepareExport(args: { destinationAbs: string; input: ExportInput; expectedCurrent?: ExpectedCurrent; faults?: ExportFaults }): Promise<PrepareResult> {
  const { destinationAbs, input, expectedCurrent, faults = {} } = args;
  if (input.preset === "godot4") {
    if (!input.godot) throw new ExportError("EXPORT_BLOCKED", "godot4 export requires a Godot target", { field: "godotProjectRoot" });
    const check = await checkGodotRoot({ godotProjectRootAbs: input.godot.projectRootAbs, destinationAbs });
    if (!check.ok) throw new ExportError("EXPORT_BLOCKED", check.blockers.map((b) => b.message).join("; "), { field: check.blockers[0]!.field });
    if (check.resRootPrefix !== input.godot.resRootPrefix.replace(/\/+$/, "")) {
      throw new ExportError("EXPORT_BLOCKED", `resRootPrefix ${input.godot.resRootPrefix} does not match the destination (${check.resRootPrefix})`, { field: "destination" });
    }
  }
  return withDestinationLock(destinationAbs, async () => {
    const warnings: string[] = [];
    const releaseRel = `${RELEASES}/${input.exportId}`;
    const staging = path.join(destinationAbs, RELEASES, `.staging-${input.exportId}`);
    const releaseAbs = path.join(destinationAbs, releaseRel);

    const current = await readCurrent(destinationAbs);
    let previous: PreviousRelease | undefined;
    if (current.kind === "release") {
      previous = await loadPrevious(destinationAbs, current.exportId, input.projectId, expectedCurrent);
      warnings.push(...previous.warnings);
      if (previous.exportId === input.exportId) throw conflict(`export ${input.exportId} is already current`, "export-id-reused");
    } else if (expectedCurrent) {
      warnings.push(`the recorded current export ${expectedCurrent.exportId} is gone (no ${CURRENT} pointer); publishing as a first export`);
    }
    for (const taken of [staging, releaseAbs]) {
      if (await lstat(taken).then(() => true, () => false)) throw conflict(`${taken} already exists; export ids must be unique`, "export-id-reused", taken);
    }

    await mkdir(staging);
    try {
      const outcome = await buildSnapshot(input, staging, faults);
      const owned = new Set(outcome.ownedFiles.map((f) => f.path));
      const carried: ExportOwnedFile[] = [];
      for (const file of previous?.unowned ?? []) {
        const parts = file.path.split("/");
        const clash = owned.has(file.path)
          || parts.slice(1).some((_, i) => owned.has(parts.slice(0, i + 1).join("/")))
          || [...owned].some((o) => o.startsWith(`${file.path}/`));
        if (clash) throw conflict(`an unowned file at ${file.path} would be overwritten by managed output; move it or rename the asset/deliverable`, "unowned-collision", file.path);
        const dest = safeJoin(staging, file.path);
        await copyInto(path.join(previous!.releaseAbs, file.path), dest);
        await fsyncPath(dest);
        carried.push(file);
      }
      if (carried.length > 0) {
        const copied = await diffEntries(staging, carried);
        if (copied.missing.length + copied.modified.length > 0) throw conflict("an unowned file changed while it was being carried over; retry the export", "unowned-changed");
        warnings.push(`carried ${carried.length} unowned file(s) from the previous export without taking ownership`);
      }
      await validateSnapshot(staging, outcome.manifestSha256);
      const { files } = await walkFiles(staging);
      const dirs = new Set<string>([staging]);
      for (const f of files) for (let d = path.dirname(path.join(staging, f)); d.length > staging.length; d = path.dirname(d)) dirs.add(d);
      await fsyncDirs(dirs);
      await rename(staging, releaseAbs);
      await fsyncPath(path.join(destinationAbs, RELEASES));

      const intent: ExportIntent = {
        exportId: input.exportId, projectId: input.projectId, preset: input.preset, releaseDir: releaseRel,
        manifestSha256: outcome.manifestSha256, files: outcome.ownedFiles, carried,
        ...(previous ? { previous: { exportId: previous.exportId, manifestSha256: previous.manifestSha256, files: previous.files, unowned: previous.unowned } } : {}),
      };
      return { intent, outcome: { ...outcome, warnings: [...warnings] }, warnings };
    } catch (e) {
      await rm(staging, { recursive: true, force: true }); // staging is a directory this call just created exclusively
      throw e;
    }
  });
}

// --------------------------------------------------------------------------- commit

async function retirePrevious(destinationAbs: string, previous: NonNullable<ExportIntent["previous"]>): Promise<string[]> {
  const warnings: string[] = [];
  const root = path.join(destinationAbs, RELEASES, previous.exportId);
  try {
    const entries = [...previous.files];
    const manifestStat = await stat(path.join(root, "manifest.json")).catch(() => undefined);
    if (manifestStat) entries.push({ path: "manifest.json", sha256: previous.manifestSha256, size: manifestStat.size });
    const { kept } = await removeVerifiedFiles(root, entries);
    for (const file of kept) warnings.push(`retained ${RELEASES}/${previous.exportId}/${file}: modified since export`);
    if (await lstat(root).then(() => true, () => false)) {
      warnings.push(`retired release ${RELEASES}/${previous.exportId} still holds files Brainforge does not own (${previous.unowned.length} unowned original(s) were carried into the new release)`);
    }
  } catch (e) {
    warnings.push(`could not fully retire ${RELEASES}/${previous.exportId}: ${(e as Error).message}`);
  }
  return warnings;
}

async function switchCurrent(destinationAbs: string, exportId: string): Promise<void> {
  const tmp = path.join(destinationAbs, `${CURRENT}.tmp-${exportId}`);
  await rm(tmp, { force: true });
  await symlink(`${RELEASES}/${exportId}`, tmp);
  try {
    await rename(tmp, path.join(destinationAbs, CURRENT));
  } catch (e) {
    await rm(tmp, { force: true });
    throw conflict(`cannot atomically replace ${CURRENT} (${(e as NodeJS.ErrnoException).code ?? "error"}): ${(e as Error).message}`, "atomic-rename-unsupported");
  }
  await fsyncPath(destinationAbs);
}

const releaseEntries = (intent: ExportIntent, manifestSize: number): ExportOwnedFile[] => [
  ...intent.files, ...intent.carried, { path: "manifest.json", sha256: intent.manifestSha256, size: manifestSize },
];

async function removePreparedRelease(destinationAbs: string, intent: ExportIntent): Promise<string[]> {
  const root = path.join(destinationAbs, RELEASES, intent.exportId);
  const manifestStat = await stat(path.join(root, "manifest.json")).catch(() => undefined);
  const { kept } = await removeVerifiedFiles(root, releaseEntries(intent, manifestStat?.size ?? -1));
  return kept.map((f) => `kept ${RELEASES}/${intent.exportId}/${f}: does not match the prepared hash`);
}

/**
 * Steps 2 (final recheck) and 3-5: re-verifies the prior current export and unowned files, atomically switches `current`
 * (the sole success boundary), then retires the previous release. Pre-switch failures leave the prior `current` untouched and
 * remove the prepared release; post-switch retirement problems are returned as warnings on a committed result.
 */
export async function commitExport(args: { destinationAbs: string; intent: ExportIntent; faults?: ExportFaults }): Promise<CommitResult> {
  const { destinationAbs, intent, faults = {} } = args;
  return withDestinationLock(destinationAbs, async () => {
    const releaseAbs = path.join(destinationAbs, RELEASES, intent.exportId);
    const current = await readCurrent(destinationAbs);
    if (current.kind === "release" && current.exportId === intent.exportId) {
      await validateSnapshot(releaseAbs, intent.manifestSha256);
      const warnings = intent.previous ? await retirePrevious(destinationAbs, intent.previous) : [];
      return { status: "already-committed", manifestSha256: intent.manifestSha256, publicRoot: CURRENT, warnings };
    }
    try {
      await verifyPrepared(destinationAbs, intent, current);
      if (faults.failBeforeSwitch) throw new InjectedFault("failBeforeSwitch");
    } catch (e) {
      if (!(e instanceof InjectedFault)) await removePreparedRelease(destinationAbs, intent).catch(() => []);
      throw e;
    }
    await switchCurrent(destinationAbs, intent.exportId);
    if (faults.failAfterSwitchBeforeRetire) throw new InjectedFault("failAfterSwitchBeforeRetire");
    const warnings = intent.previous ? await retirePrevious(destinationAbs, intent.previous) : [];
    return { status: "committed", manifestSha256: intent.manifestSha256, publicRoot: CURRENT, warnings };
  });
}

async function verifyPrepared(destinationAbs: string, intent: ExportIntent, current: CurrentState): Promise<void> {
  const releaseAbs = path.join(destinationAbs, RELEASES, intent.exportId);
  if (!(await stat(releaseAbs).then((s) => s.isDirectory(), () => false))) throw conflict(`prepared release ${intent.releaseDir} no longer exists`, "release-missing", releaseAbs);
  await validateSnapshot(releaseAbs, intent.manifestSha256);
  const carried = await diffEntries(releaseAbs, intent.carried);
  if (carried.missing.length + carried.modified.length > 0) throw conflict("carried unowned files in the prepared release changed", "release-modified");

  if (!intent.previous) {
    if (current.kind !== "missing") throw conflict(`${CURRENT} appeared after this export was prepared (points to ${current.exportId}); prepare again`, "current-changed");
    return;
  }
  if (current.kind !== "release" || current.exportId !== intent.previous.exportId) throw conflict(`${CURRENT} no longer points to ${intent.previous.exportId}; prepare again`, "current-changed");
  const previousRoot = path.join(destinationAbs, RELEASES, intent.previous.exportId);
  const manifestText = await readFile(path.join(previousRoot, "manifest.json"), "utf8");
  if (sha256Bytes(manifestText) !== intent.previous.manifestSha256) throw conflict("the previous manifest changed after this export was prepared", "current-changed");
  const { modified } = await diffEntries(previousRoot, intent.previous.files);
  if (modified.length > 0) throw conflict(`owned export file(s) were modified outside Brainforge after preparation: ${modified.slice(0, 5).join(", ")}`, "owned-file-modified", modified[0]);
  const { files } = await walkFiles(previousRoot);
  const owned = new Set([...intent.previous.files.map((f) => f.path), "manifest.json"]);
  const unowned = await hashEntries(previousRoot, files.filter((f) => !owned.has(f)));
  if (!sameEntries(unowned, intent.previous.unowned)) throw conflict("unowned files inside current changed after this export was prepared; prepare again so they are carried over unchanged", "unowned-changed");
}

// --------------------------------------------------------------------------- recovery

/**
 * Startup recovery for a recorded intent. If `current` resolves to the intent's release with the prepared manifest hash the
 * export is committed (the previous release is retired idempotently); otherwise the prepared-but-unswitched release is removed
 * strictly from the intent's file list after hash verification.
 */
export async function recoverExport(args: { destinationAbs: string; intent: ExportIntent }): Promise<RecoverResult> {
  const { destinationAbs, intent } = args;
  return withDestinationLock(destinationAbs, async () => {
    const current = await readCurrent(destinationAbs).catch((e: unknown): CurrentState | undefined => {
      if (e instanceof ExportError) return undefined;
      throw e;
    });
    if (current?.kind === "release" && current.exportId === intent.exportId) {
      const text = await readFile(path.join(destinationAbs, RELEASES, intent.exportId, "manifest.json"), "utf8");
      if (sha256Bytes(text) !== intent.manifestSha256) throw conflict(`${CURRENT} points to ${intent.exportId} but its manifest differs from the prepared one`, "manifest-mismatch");
      return { status: "committed", warnings: intent.previous ? await retirePrevious(destinationAbs, intent.previous) : [] };
    }
    const warnings = await removePreparedRelease(destinationAbs, intent);
    await rm(path.join(destinationAbs, RELEASES, `.staging-${intent.exportId}`), { recursive: true, force: true });
    return { status: "aborted", warnings };
  });
}
