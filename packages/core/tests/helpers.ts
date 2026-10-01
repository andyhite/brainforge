import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OperationContext, OperationData, OperationName, OperationResult } from "@brainforge/contracts";
import type { ComfyTransport } from "@brainforge/comfy";
import { createProjectRegistry, executeOperation, projectHandlers, type IdempotencyStore, type MachineStore, type OperationRuntime, type OpenableProjectRegistry } from "../src/index.ts";

export const human: OperationContext = { actorId: "human:local", actorType: "human" };
export const agent: OperationContext = { actorId: "agent:local", actorType: "agent" };

export const PROJECT_YAML = `schema: brainforge.project.v2
id: demo
name: Demo
export:
  preset: generic
  destination: assets/brainforge
`;

export const ASSET_YAML = `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager with an exposed brain.
`;

function memoryIdempotency(): IdempotencyStore {
  const rows = new Map<string, { hash: string; result?: string }>();
  return {
    reserve(k) {
      const key = `${k.actorId}\0${k.requestId}`;
      const row = rows.get(key);
      if (!row) { rows.set(key, { hash: k.payloadHash }); return { kind: "new" }; }
      if (row.hash !== k.payloadHash) return { kind: "conflict" };
      return row.result === undefined ? { kind: "in-flight" } : { kind: "replay", resultJson: row.result };
    },
    complete(k, json) { const row = rows.get(`${k.actorId}\0${k.requestId}`); if (row) row.result = json; },
    release(k) { const key = `${k.actorId}\0${k.requestId}`; if (rows.get(key)?.result === undefined) rows.delete(key); },
  };
}

export interface Harness {
  runtime: OperationRuntime;
  registry: OpenableProjectRegistry;
  recents: { root: string; name?: string }[];
  setComfyUrl(url: string | undefined): void;
  call<K extends OperationName>(name: K, input: unknown, opts?: { project?: string; context?: OperationContext; requestId?: string }): Promise<OperationResult<OperationData<K>>>;
}

let counter = 0;

export interface HarnessOptions {
  /** Injected ComfyUI transport. With it, the registry also runs the generation scheduler (fast polling). */
  comfy?: () => ComfyTransport | undefined;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const registry = createProjectRegistry(options.comfy ? { generation: { comfy: options.comfy, workflowsDir: join(import.meta.dir, "../../comfy/workflows"), pollIntervalMs: 15, tickIntervalMs: 15 } } : {});
  const recents: { root: string; name?: string }[] = [];
  let comfy: string | undefined;
  const machine: MachineStore = {
    idempotency: memoryIdempotency(),
    comfyUrl: () => comfy,
    setComfyUrl: (u) => { comfy = u ?? undefined; },
    recordRecent: (root, name) => { recents.push({ root, name }); },
    recents: () => recents.map((r) => ({ ...r, lastOpenedAt: new Date().toISOString() })),
  };
  const workflowsDir = join(import.meta.dir, "../../comfy/workflows");
  const runtime: OperationRuntime = { projects: registry, machine, workflowsDir, publicUrl: "http://127.0.0.1:3210", ...(options.comfy ? { comfy: options.comfy } : {}) };
  return {
    runtime, registry, recents,
    setComfyUrl: (u) => { comfy = u; },
    call: (name, input, opts = {}) =>
      executeOperation(runtime, projectHandlers, opts.context ?? human, name, { requestId: opts.requestId ?? `req-${++counter}`, project: opts.project, input } as never),
  };
}

export async function tempGameDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "bf-core-")));
}

export async function put(root: string, rel: string, text: string | Uint8Array): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
}

/** A game dir initialized through project.init with a project.yaml. */
export async function initializedGame(h: Harness): Promise<string> {
  const root = await tempGameDir();
  const r = await h.call("project.init", { path: root, confirm: true });
  if (!r.ok) throw new Error(JSON.stringify(r));
  await put(root, "brainforge/project.yaml", PROJECT_YAML);
  return root;
}

export function expectOk<T>(r: OperationResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(width: number, height: number, colorType: 2 | 6, rows: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A valid solid-colour RGB PNG. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  return encodePng(width, height, 2, Buffer.concat(Array.from({ length: height }, () => row)));
}

/** A valid RGBA PNG whose pixels come from `pixel(x, y)`. */
export function makeRgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(rows, y * (1 + width * 4) + 1 + x * 4);
  }
  return encodePng(width, height, 6, rows);
}
