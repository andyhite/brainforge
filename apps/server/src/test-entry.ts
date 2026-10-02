/**
 * Test-only server entry for `scripts/recovery-smoke.ts`. It builds the same app as `index.ts` but wires the
 * constructor-level crash seams (`runtime.faults`, the scheduler's `beforeCandidatePublication`) to files in a
 * control directory that only the harness writes. The release entry (`index.ts`) never imports this file, and the
 * seams themselves are plain constructor arguments: no environment variable, HTTP request or agent input can set them.
 *
 *   bun apps/server/src/test-entry.ts --port <n> --control <dir>     (needs BF_COMFY_URL and BF_CONFIG_DIR in the environment)
 *
 * Control directory protocol:
 *   faults.json            {"promotion"?: ..., "export"?: ...}  read on every use, so the harness can arm/disarm live
 *   hold-<point>           while this file exists the server blocks at <point>
 *   reached-<point>        written by the server when it blocks at <point>
 * Points: after-receipt (remote result received, candidate not yet published), processing-after-staging.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertHandlersComplete, createComfyResolver, createMachineStore, createProjectRegistry, machineHandlers, projectHandlers,
  type HandlerMap, type OperationRuntime,
} from "@brainforge/core";
import { createApp, MAX_BODY_BYTES } from "./app.ts";

function flag(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  return i >= 0 ? Bun.argv[i + 1] : undefined;
}

function die(message: string): never {
  console.error(`test-entry: ${message}`);
  process.exit(2);
}

const port = Number(flag("port"));
const control = flag("control") ?? die("--control <dir> is required");
if (!Number.isInteger(port) || port < 1 || port > 65535) die("--port <n> is required");
if (port === 3210 || port === 3211) die(`port ${port} belongs to a real server`);
const comfyUrl = process.env.BF_COMFY_URL;
if (!comfyUrl) die("BF_COMFY_URL (the protocol-test fake) is required");
const comfyHost = new URL(comfyUrl);
if (!["127.0.0.1", "localhost"].includes(comfyHost.hostname) || comfyHost.port === "8188") die(`refusing ComfyUI URL ${comfyUrl}: the harness only talks to its own loopback fake`);
if (!process.env.BF_CONFIG_DIR) die("BF_CONFIG_DIR must point at a temporary directory");

type Faults = NonNullable<OperationRuntime["faults"]>;

function armed(): Pick<Faults, "promotion" | "export"> {
  try {
    return JSON.parse(readFileSync(join(control, "faults.json"), "utf8")) as Pick<Faults, "promotion" | "export">;
  } catch {
    return {};
  }
}

async function holdAt(point: string): Promise<void> {
  const hold = join(control, `hold-${point}`);
  if (!existsSync(hold)) return;
  writeFileSync(join(control, `reached-${point}`), `${new Date().toISOString()} pid=${process.pid}\n`);
  while (existsSync(hold)) await Bun.sleep(25);
}

const machine = createMachineStore();
const comfy = createComfyResolver(machine);
const projects = createProjectRegistry({
  generation: { comfy, pollIntervalMs: 100, tickIntervalMs: 100, beforeCandidatePublication: () => holdAt("after-receipt") },
});
const faults: Faults = {
  get promotion() { return armed().promotion; },
  get export() { return armed().export; },
  get processing() { return existsSync(join(control, "hold-processing-after-staging")) ? { afterStaging: () => holdAt("processing-after-staging") } : undefined; },
};
const runtime: OperationRuntime = { projects, machine, publicUrl: `http://127.0.0.1:${port}`, comfy, faults };
const handlers: HandlerMap = { ...projectHandlers, ...machineHandlers };
assertHandlersComplete(handlers);

const app = createApp({ runtime, handlers, port, version: "test" });
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, idleTimeout: 120, maxRequestBodySize: MAX_BODY_BYTES + 64 * 1024 });
console.log(`Brainforge TEST server listening on ${runtime.publicUrl} (comfy ${comfyUrl}, control ${control})`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop(true);
    await projects.closeAll();
    machine.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
