import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OperationContext, OperationData, OperationName, OperationResult } from "@brainforge/contracts";
import type { ComfyTransport } from "@brainforge/comfy";
import { encodePng } from "@brainforge/comfy/testing";
import { createIdempotencyStore, MIGRATIONS, type DurableIdempotencyStore } from "@brainforge/storage";
import { createProjectRegistry, executeOperation, projectHandlers, type MachineStore, type OperationRuntime, type OpenableProjectRegistry } from "../src/index.ts";

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

function memoryIdempotency(): DurableIdempotencyStore {
  const db = new Database(":memory:");
  db.exec(MIGRATIONS.map((m) => m.sql).join("\n"));
  return createIdempotencyStore(db);
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
  const registry = createProjectRegistry(options.comfy ? { generation: { comfy: options.comfy, pollIntervalMs: 15, tickIntervalMs: 15 } } : {});
  const recents: { root: string; name?: string }[] = [];
  let comfy: string | undefined;
  const machine: MachineStore = {
    idempotency: memoryIdempotency(),
    comfyUrl: () => comfy,
    setComfyUrl: (u) => { comfy = u ?? undefined; },
    recordRecent: (root, name) => { recents.push({ root, name }); },
    recents: () => recents.map((r) => ({ ...r, lastOpenedAt: new Date().toISOString() })),
  };
  const runtime: OperationRuntime = { projects: registry, machine, publicUrl: "http://127.0.0.1:3210", ...(options.comfy ? { comfy: options.comfy } : {}) };
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

/** A valid solid-colour RGB PNG. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  return Buffer.from(encodePng(width, height, 3, Uint8Array.from(Array.from({ length: width * height }, () => rgb).flat())));
}

/** A valid RGBA PNG whose pixels come from `pixel(x, y)`. */
export function makeRgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set(pixel(x, y), (y * width + x) * 4);
  return Buffer.from(encodePng(width, height, 4, px));
}
