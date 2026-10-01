import { z } from "zod";
import { OperationFailure, type HandlerMap } from "../runtime.ts";

const SystemStats = z.object({
  system: z.object({ comfyui_version: z.string().optional() }).passthrough().optional(),
  devices: z.array(z.object({ name: z.string().optional() }).passthrough()).optional(),
}).passthrough();

export const machineHandlers: HandlerMap = {
  "project.recent": async ({ runtime }) => ({ data: { projects: runtime.machine.recents() } }),

  "connection.set": async ({ runtime, input }) => {
    const warnings: string[] = [];
    if (input.comfyUrl === null) {
      runtime.machine.setComfyUrl(null);
    } else {
      let parsed: URL;
      try {
        parsed = new URL(input.comfyUrl);
      } catch {
        throw new OperationFailure("INVALID_INPUT", "comfyUrl is not a valid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new OperationFailure("INVALID_INPUT", "comfyUrl must use http or https");
      if (parsed.username || parsed.password) throw new OperationFailure("INVALID_INPUT", "comfyUrl must not embed credentials; machine settings never hold secrets in URLs");
      runtime.machine.setComfyUrl(parsed.origin + parsed.pathname.replace(/\/+$/, ""));
    }
    const effective = runtime.machine.comfyUrl();
    if (input.comfyUrl !== null && process.env.BF_COMFY_URL) warnings.push("BF_COMFY_URL is set in the environment and overrides the stored value.");
    if (!effective) return { data: { configured: false }, warnings };
    const host = new URL(effective).host;
    try {
      const res = await fetch(`${effective}/system_stats`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { data: { configured: true, host, reachable: false }, warnings: [...warnings, `ComfyUI answered HTTP ${res.status} to /system_stats.`] };
      const stats = SystemStats.safeParse(await res.json());
      const version = stats.success ? stats.data.system?.comfyui_version : undefined;
      const device = stats.success ? stats.data.devices?.[0]?.name : undefined;
      return { data: { configured: true, host, reachable: true, ...(version ? { comfyuiVersion: version } : {}), ...(device ? { device } : {}) }, warnings };
    } catch (e) {
      const reason = e instanceof Error ? e.name : "error";
      return { data: { configured: true, host, reachable: false }, warnings: [...warnings, `ComfyUI is not reachable at ${host} (${reason}). The URL was saved.`] };
    }
  },
};
