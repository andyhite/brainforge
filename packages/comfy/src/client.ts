import type { ComfyGraph } from "@brainforge/contracts";

export class ComfyHttpError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
  }
}

export interface ImageRef { filename: string; subfolder: string; type: string }

export interface SystemStats {
  system?: { os?: string; comfyui_version?: string; python_version?: string };
  devices?: { name: string; type: string; vram_total?: number }[];
}
export interface NodeInfo {
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> };
  api_node?: boolean;
  is_api_node?: boolean;
}
export type QueueTuple = [number, string, unknown, { brainforge?: { identity?: string } } | undefined, ...unknown[]];
export interface HistoryEntry {
  prompt?: QueueTuple;
  outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
}

/** History/queue entries are matched by the identity Brainforge stamps in `extra_data`. */
export interface IdentityMatch { promptId: string; where: "running" | "pending" | "history" }

export class ComfyClient {
  readonly baseUrl: string;
  constructor(baseUrl: string, private readonly timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ComfyHttpError(`ComfyUI unreachable at ${this.baseUrl}${path}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      throw new ComfyHttpError(`ComfyUI ${init?.method ?? "GET"} ${path} -> ${res.status}`, res.status, body);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.req(path, init)).json() as Promise<T>;
  }

  systemStats() { return this.json<SystemStats>("/system_stats"); }
  objectInfo() { return this.json<Record<string, NodeInfo>>("/object_info"); }

  async uploadImage(bytes: Uint8Array, filename: string, subfolder: string): Promise<ImageRef> {
    const form = new FormData();
    form.set("image", new Blob([bytes as BlobPart], { type: "image/png" }), filename);
    form.set("subfolder", subfolder);
    form.set("type", "input");
    form.set("overwrite", "true");
    const r = await this.json<{ name: string; subfolder: string; type: string }>("/upload/image", { method: "POST", body: form });
    return { filename: r.name, subfolder: r.subfolder, type: r.type };
  }

  /** Submit one prompt. Throws ComfyHttpError; a thrown network error is an AMBIGUOUS submission. */
  async submit(graph: ComfyGraph, clientId: string, extraData: Record<string, unknown>): Promise<string> {
    const r = await this.json<{ prompt_id?: string; node_errors?: Record<string, unknown> }>("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId, extra_data: extraData }),
    });
    if (!r.prompt_id) throw new ComfyHttpError("ComfyUI returned no prompt_id", undefined, r);
    return r.prompt_id;
  }

  queue() { return this.json<{ queue_running: QueueTuple[]; queue_pending: QueueTuple[] }>("/queue"); }
  history(promptId?: string) { return this.json<Record<string, HistoryEntry>>(promptId ? `/history/${encodeURIComponent(promptId)}` : "/history?max_items=200"); }

  async view(ref: ImageRef): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
    return new Uint8Array(await (await this.req(`/view?${q}`)).arrayBuffer());
  }

  /** Delete one queued (not running) prompt. Never calls global /interrupt. */
  async deleteQueued(promptId: string): Promise<void> {
    await this.req("/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
  }

  /** Find prompts carrying our identity. Zero results proves nothing about a lost submission being absent only if queue/history were read successfully. */
  async findByIdentity(identity: string): Promise<IdentityMatch[]> {
    const [q, h] = await Promise.all([this.queue(), this.history()]);
    const out: IdentityMatch[] = [];
    const has = (extra: QueueTuple[3] | undefined) => extra?.brainforge?.identity === identity;
    for (const t of q.queue_running) if (has(t[3])) out.push({ promptId: t[1], where: "running" });
    for (const t of q.queue_pending) if (has(t[3])) out.push({ promptId: t[1], where: "pending" });
    for (const [id, e] of Object.entries(h)) if (has(e?.prompt?.[3])) out.push({ promptId: id, where: "history" });
    return out;
  }

  /** Poll history until the prompt finishes; returns its entry. */
  async waitForHistory(promptId: string, opts: { intervalMs?: number; deadline: number; signal?: AbortSignal }): Promise<HistoryEntry> {
    for (;;) {
      if (opts.signal?.aborted) throw new ComfyHttpError("aborted");
      const h = await this.history(promptId);
      const e = h[promptId];
      if (e?.status?.completed === true || e?.status?.status_str === "error") return e;
      if (Date.now() > opts.deadline) throw new ComfyHttpError(`Timed out waiting for prompt ${promptId}`);
      await Bun.sleep(opts.intervalMs ?? 2000);
    }
  }
}

export function outputImages(entry: HistoryEntry, nodeId: string): ImageRef[] {
  const imgs = entry.outputs?.[nodeId]?.images;
  return (imgs ?? []).map((i) => ({ filename: i.filename, subfolder: i.subfolder ?? "", type: i.type ?? "output" }));
}
