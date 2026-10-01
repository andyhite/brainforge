import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const LEASE_REL = "brainforge/.state/lease";

export class ProjectLeaseError extends Error {
  constructor(message: string, readonly holderPid?: number) {
    super(message);
  }
}

interface LeaseRecord { pid: number; startedAt: string; processStart?: string; token: string }

export interface ProjectLease {
  path: string;
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The OS-reported start time of a pid; guards against a recycled pid looking like a live holder. */
function processStart(pid: number): string | undefined {
  try {
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const text = out.stdout.toString().trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function readLease(path: string): LeaseRecord | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (v && typeof v === "object" && "pid" in v && typeof v.pid === "number" && "token" in v && typeof v.token === "string") {
      const startedAt = "startedAt" in v && typeof v.startedAt === "string" ? v.startedAt : "";
      const ps = "processStart" in v && typeof v.processStart === "string" ? v.processStart : undefined;
      return { pid: v.pid, startedAt, processStart: ps, token: v.token };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isStale(rec: LeaseRecord | undefined): boolean {
  if (!rec) return true; // unreadable/partial lease file: no live owner can be identified
  if (!processAlive(rec.pid)) return true;
  if (rec.processStart) {
    const now = processStart(rec.pid);
    if (now && now !== rec.processStart) return true;
  }
  return false;
}

/** Exclusive per-project OS-process lease. A dead holder's lease is taken over; a live one is a clear error. */
export function acquireProjectLease(gameRoot: string): ProjectLease {
  const path = join(gameRoot, LEASE_REL);
  mkdirSync(dirname(path), { recursive: true });
  const record: LeaseRecord = { pid: process.pid, startedAt: new Date().toISOString(), processStart: processStart(process.pid), token: randomUUID() };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      return {
        path,
        release() {
          if (readLease(path)?.token === record.token) rmSync(path, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readLease(path);
    if (!isStale(holder)) {
      throw new ProjectLeaseError(
        holder?.pid === process.pid
          ? `Project ${gameRoot} is already open in this process.`
          : `Project ${gameRoot} is open in another Brainforge process (pid ${holder?.pid}). Close it there first.`,
        holder?.pid,
      );
    }
    rmSync(path, { force: true });
  }
  throw new ProjectLeaseError(`Could not acquire the project lease at ${path}; another process is racing for it.`);
}
