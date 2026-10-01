import { ComfyClient, type ComfyTransport } from "@brainforge/comfy";
import type { MachineStore, OperationRuntime } from "../runtime.ts";

/** One client per configured URL; resolves lazily so a changed machine setting takes effect on the next call. */
export function createComfyResolver(machine: Pick<MachineStore, "comfyUrl">): () => ComfyTransport | undefined {
  let cached: ComfyClient | undefined;
  return () => {
    const url = machine.comfyUrl();
    if (!url) return undefined;
    if (cached?.baseUrl !== url.replace(/\/+$/, "")) cached = new ComfyClient(url);
    return cached;
  };
}

/** The runtime's injected transport, else a client for the stored / `BF_COMFY_URL` address. */
export function transportOf(runtime: Pick<OperationRuntime, "comfy" | "machine">): ComfyTransport | undefined {
  if (runtime.comfy) return runtime.comfy();
  const url = runtime.machine.comfyUrl();
  return url ? new ComfyClient(url) : undefined;
}
