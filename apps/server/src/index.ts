import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertHandlersComplete, createComfyResolver, createMachineStore, createProjectRegistry, machineHandlers, projectHandlers, type HandlerMap, type OperationRuntime,
} from "@brainforge/core";
import { createApp, MAX_BODY_BYTES } from "./app.ts";

const port = Number(process.env.BF_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`BF_PORT must be a port number, got ${JSON.stringify(process.env.BF_PORT)}`);
  process.exit(1);
}

const serverRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(serverRoot, "../..");

let version = "0.0.0";
try {
  const pkg: unknown = JSON.parse(readFileSync(resolve(serverRoot, "package.json"), "utf8"));
  if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") version = pkg.version;
} catch {
  // Bundled builds may not ship package.json; the version is informational only.
}

const machine = createMachineStore();
const comfy = createComfyResolver(machine);
const workflowsDir = resolve(repoRoot, "packages/comfy/workflows");
const projects = createProjectRegistry({ generation: { comfy, workflowsDir } });
const runtime: OperationRuntime = {
  projects,
  machine,
  workflowsDir,
  publicUrl: `http://127.0.0.1:${port}`,
  comfy,
};
const handlers: HandlerMap = { ...projectHandlers, ...machineHandlers };
assertHandlersComplete(handlers);

const app = createApp({ runtime, handlers, port, version, webDist: resolve(repoRoot, "apps/web/dist") });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: app.fetch,
  // SSE streams send a heartbeat every 15 s; the default 10 s idle timeout would cut them.
  idleTimeout: 120,
  maxRequestBodySize: MAX_BODY_BYTES + 64 * 1024,
});

console.log(`Brainforge server listening on ${runtime.publicUrl}`);
console.log(`Open this in your browser: ${runtime.publicUrl}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: closing projects and stopping`);
  try {
    await server.stop(true);
    await projects.closeAll();
    machine.close();
  } catch (e) {
    console.error("Shutdown error:", e instanceof Error ? e.message : "unknown");
    process.exit(1);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
