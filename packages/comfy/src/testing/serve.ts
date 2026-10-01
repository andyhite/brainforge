import { createFakeComfy, FAULT_NAMES, type FaultName } from "./fake.ts";

const args = Bun.argv.slice(2);
const faults: FaultName[] = [];
let port = 8199;
let latencyMs: number | undefined;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = args[++i];
  if (flag === "--port") port = Number(value);
  else if (flag === "--latency") latencyMs = Number(value);
  else if (flag === "--fault" && (FAULT_NAMES as readonly string[]).includes(value ?? "")) faults.push(value as FaultName);
  else {
    console.error(`usage: serve.ts [--port <n>] [--latency <ms>] [--fault <${FAULT_NAMES.join("|")}>]...`);
    process.exit(2);
  }
}

const fake = await createFakeComfy({ port, latencyMs, faults });
console.log(`fake ComfyUI (protocol test server, no GPU) listening on ${fake.url}${faults.length ? ` faults=${faults.join(",")}` : ""}`);
