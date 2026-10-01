import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  acquireProjectLease, appendEvents, openProjectDb, readEventsAfter, type ProjectDb, type ProjectLease, type StoredEvent,
} from "@brainforge/storage";
import { OperationFailure, type IdempotencyStore, type ProjectHandle, type ProjectRegistry } from "./runtime.ts";
import { readAuthoredFile } from "./authored.ts";

export type ProjectState = "open" | "closing";

/** A registered project: the seam handle plus lifecycle and snapshot coordination used by core handlers. */
export interface OpenProject extends ProjectHandle {
  readonly state: ProjectState;
  /** The recorded root differed from the actual location when this project was opened. */
  readonly needsRebind: boolean;
  readonly upgradeInstruction?: string;
  /** True while a snapshot holds the project quiesced; `transact` refuses to start. */
  readonly quiesced: boolean;
  /** Count of nonterminal jobs/publication intents. Later milestones install a real probe. */
  trackedWork(): number;
  setTrackedWorkProbe(probe: () => number): void;
  /** Run an async mutation that may await between file I/O and `transact`. Blocks while a snapshot is quiesced. */
  mutate<T>(fn: () => Promise<T>): Promise<T>;
  /** Wait for in-flight mutations, block new ones, and run `fn` (snapshot). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export interface OpenableProjectRegistry extends ProjectRegistry {
  open(root: string): Promise<OpenProject>;
  /** `closing` while tracked work is nonterminal; `closed` after checkpoint, lease release and unregister. */
  close(root: string): Promise<"closing" | "closed">;
  /** Graceful shutdown of every open project: checkpoint and release leases. */
  closeAll(): Promise<void>;
  /** Re-attempt completion of projects in `closing` state whose tracked work finished. */
  settleClosing(): Promise<void>;
  getOpen(root: string): OpenProject | undefined;
}

export function isOpenableRegistry(reg: ProjectRegistry): reg is OpenableProjectRegistry {
  return "open" in reg && typeof reg.open === "function" && "close" in reg && typeof reg.close === "function";
}

function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "project";
}

/** Gate that lets many mutations run together but gives a snapshot sole access. */
class MutationGate {
  private active = 0;
  private exclusiveHeld = false;
  private waiters: (() => void)[] = [];
  private idle: (() => void)[] = [];

  get blocked(): boolean {
    return this.exclusiveHeld;
  }

  async enter(): Promise<void> {
    while (this.exclusiveHeld) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }

  leave(): void {
    this.active--;
    if (this.active === 0) for (const r of this.idle.splice(0)) r();
  }

  async acquireExclusive(): Promise<void> {
    while (this.exclusiveHeld) await new Promise<void>((r) => this.waiters.push(r));
    this.exclusiveHeld = true;
    while (this.active > 0) await new Promise<void>((r) => this.idle.push(r));
  }

  releaseExclusive(): void {
    this.exclusiveHeld = false;
    for (const r of this.waiters.splice(0)) r();
  }
}

type Listener = (event: StoredEvent) => void;

class Project implements OpenProject {
  state: ProjectState = "open";
  quiesced = false;
  readonly idempotency: IdempotencyStore;
  private readonly listeners = new Set<Listener>();
  private readonly gate = new MutationGate();
  private probe: () => number = () => 0;
  closed = false;

  constructor(
    readonly root: string,
    readonly projectId: string,
    private readonly store: ProjectDb,
    readonly lease: ProjectLease,
    readonly needsRebind: boolean,
  ) {
    const base = store.idempotency;
    // After close the DB is gone; the executor still records the closing request's result, which is moot.
    this.idempotency = {
      reserve: (key) => base.reserve(key),
      complete: (key, json) => { if (!this.closed) base.complete(key, json); },
      release: (key) => { if (!this.closed) base.release(key); },
    };
  }

  get db() { return this.store.db; }
  get writable() { return this.store.writable; }
  get upgradeInstruction() { return this.store.upgradeInstruction; }

  private lastRevision = 0;

  revision(): number {
    if (this.closed) return this.lastRevision;
    this.lastRevision = this.db.query<{ revision: number }, []>("SELECT revision FROM project_revision WHERE id = 1").get()?.revision ?? 0;
    return this.lastRevision;
  }

  transact<T>(fn: () => T, events: { type: string; data: unknown; actorId?: string }[] = []): { value: T; revision: number } {
    if (this.closed) throw new OperationFailure("PROJECT_NOT_OPEN", `Project ${this.root} is closed`);
    if (!this.writable) throw new OperationFailure("IO_ERROR", this.upgradeInstruction ?? "Project is read-only");
    if (this.quiesced) throw new OperationFailure("IO_ERROR", "Project is quiesced for a snapshot; retry shortly");
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    let value: T;
    let stored: StoredEvent[];
    let revision: number;
    try {
      value = fn();
      db.query("UPDATE project_revision SET revision = revision + 1 WHERE id = 1").run();
      stored = appendEvents(db, events);
      revision = this.revision();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    for (const event of stored) {
      for (const l of this.listeners) {
        try { l(event); } catch { /* a failing subscriber must not affect the committed mutation */ }
      }
    }
    return { value, revision };
  }

  eventsAfter(after: number, limit?: number) {
    return readEventsAfter(this.db, after, limit);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  trackedWork(): number {
    return this.probe();
  }

  setTrackedWorkProbe(probe: () => number): void {
    this.probe = probe;
  }

  async mutate<T>(fn: () => Promise<T>): Promise<T> {
    await this.gate.enter();
    try {
      return await fn();
    } finally {
      this.gate.leave();
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.gate.acquireExclusive();
    this.quiesced = true;
    try {
      return await fn();
    } finally {
      this.quiesced = false;
      this.gate.releaseExclusive();
    }
  }

  finalize(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.store.close(); } finally { this.lease.release(); }
  }
}

function readMeta(project: ProjectDb, key: string): string | undefined {
  return project.db.query<{ value: string }, [string]>("SELECT value FROM project_meta WHERE key = ?").get(key)?.value;
}

function writeMeta(project: ProjectDb, key: string, value: string): void {
  project.db.query("INSERT INTO project_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function createProjectRegistry(): OpenableProjectRegistry {
  const open = new Map<string, Project>();
  const pending = new Map<string, Promise<Project>>();

  const lookup = (path: string): Project | undefined => {
    const direct = open.get(path);
    if (direct) return direct;
    try {
      return open.get(realpathSync(path));
    } catch {
      return undefined;
    }
  };

  async function doOpen(root: string): Promise<Project> {
    const lease = acquireProjectLease(root);
    let store: ProjectDb | undefined;
    try {
      store = openProjectDb(root);
      const storedRoot = readMeta(store, "root");
      const needsRebind = storedRoot !== undefined && storedRoot !== root;
      const yaml = await readAuthoredFile(root, "brainforge/project.yaml");
      const fromYaml = yaml?.kind === "project" ? yaml.spec?.id : undefined;
      const projectId = fromYaml ?? readMeta(store, "project_id") ?? slug(basename(root));
      if (store.writable) {
        writeMeta(store, "root", root);
        writeMeta(store, "project_id", projectId);
      }
      return new Project(root, projectId, store, lease, needsRebind);
    } catch (e) {
      try { store?.close(); } finally { lease.release(); }
      throw e;
    }
  }

  return {
    get: (path) => lookup(path),
    getOpen: (path) => lookup(path),
    list: () => [...open.values()],
    async open(path) {
      const root = await realpath(path);
      const existing = open.get(root);
      if (existing) return existing;
      let inflight = pending.get(root);
      if (!inflight) {
        inflight = doOpen(root).then((p) => { open.set(root, p); return p; }).finally(() => { pending.delete(root); });
        pending.set(root, inflight);
      }
      return inflight;
    },
    async close(path) {
      const project = lookup(path);
      if (!project) return "closed";
      if (project.trackedWork() > 0) {
        project.state = "closing";
        return "closing";
      }
      await project.exclusive(async () => {
        project.finalize();
      });
      open.delete(project.root);
      return "closed";
    },
    async settleClosing() {
      for (const p of [...open.values()]) {
        if (p.state === "closing" && p.trackedWork() === 0) {
          await p.exclusive(async () => { p.finalize(); });
          open.delete(p.root);
        }
      }
    },
    async closeAll() {
      for (const p of [...open.values()]) {
        await p.exclusive(async () => { p.finalize(); });
        open.delete(p.root);
      }
    },
  };
}

export function isOpenProject(handle: ProjectHandle): handle is OpenProject {
  return "mutate" in handle && typeof handle.mutate === "function" && "exclusive" in handle;
}
