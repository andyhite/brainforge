import type { ComfyGraph } from "@brainforge/contracts";

export class ComfyHttpError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
  }
}

/** A downloaded output was oversized, cut short, or not a complete image. The remote result still exists; retry the download, do not regenerate. */
export class ComfyDownloadError extends Error {
  constructor(message: string, readonly ref: ImageRef, readonly reason: "truncated" | "too-large") {
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

/**
 * The seam between the scheduler and ComfyUI. `ComfyClient` is the real implementation; tests use the
 * protocol-faithful fake in `@brainforge/comfy/testing`. Semantics callers rely on:
 * - `submit` throwing a ComfyHttpError WITHOUT `status` means the outcome is ambiguous (the prompt may be queued).
 * - `findByIdentity` throws when queue or history could not be read; an empty result is only meaningful then.
 * - `deleteQueued` removes only the named pending prompt and never interrupts running work.
 * - Only idempotent GETs are retried (network error/5xx, bounded); `/prompt`, `/upload/image` and `/queue` POSTs are attempted once.
 * - `view` throws ComfyDownloadError when the body is oversized, short, or not a complete PNG; the remote result still exists, so retry the download, never regenerate.
 */
export interface ComfyTransport {
  readonly baseUrl: string;
  systemStats(): Promise<SystemStats>;
  objectInfo(): Promise<Record<string, NodeInfo>>;
  uploadImage(bytes: Uint8Array, filename: string, subfolder: string): Promise<ImageRef>;
  submit(graph: ComfyGraph, clientId: string, extraData: Record<string, unknown>): Promise<string>;
  queue(): Promise<{ queue_running: QueueTuple[]; queue_pending: QueueTuple[] }>;
  history(promptId?: string): Promise<Record<string, HistoryEntry>>;
  view(ref: ImageRef): Promise<Uint8Array>;
  deleteQueued(promptId: string): Promise<void>;
  findByIdentity(identity: string): Promise<IdentityMatch[]>;
  waitForHistory(promptId: string, opts: { intervalMs?: number; deadline: number; signal?: AbortSignal }): Promise<HistoryEntry>;
}

export interface ComfyClientOptions {
  /** Timeout for JSON calls (default 15s); passed positionally as the constructor's second argument. */
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
  /** Extra attempts for idempotent GETs only (default 2). */
  getRetries?: number;
  retryDelayMs?: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Verifies that `bytes` is one complete PNG: signature, IHDR first, every chunk CRC valid, IEND last with no
 * trailing bytes. Returns a problem description, or undefined when complete.
 */
export function pngProblem(bytes: Uint8Array): string | undefined {
  if (bytes.length < 33 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return "not a PNG (bad signature)";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let first = true;
  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) return "truncated chunk header";
    const len = view.getUint32(pos);
    const end = pos + 12 + len;
    if (end > bytes.length) return "truncated chunk data";
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (first && type !== "IHDR") return "IHDR is not the first chunk";
    first = false;
    if (Bun.hash.crc32(bytes.subarray(pos + 4, pos + 8 + len)) !== view.getUint32(pos + 8 + len)) return `bad CRC in ${type} chunk`;
    pos = end;
    if (type === "IEND") return pos === bytes.length ? undefined : "trailing bytes after IEND";
  }
  return "missing IEND chunk";
}

export class ComfyClient implements ComfyTransport {
  readonly baseUrl: string;
  private readonly opts: Required<ComfyClientOptions>;
  constructor(baseUrl: string, private readonly jsonTimeoutMs = 15_000, opts: ComfyClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.opts = { downloadTimeoutMs: 120_000, maxDownloadBytes: 64 * 1024 * 1024, getRetries: 2, retryDelayMs: 250, ...opts };
  }

  /** One HTTP exchange, no retry. A network failure/timeout throws a ComfyHttpError without `status`. */
  private async once(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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

  /** Network errors and 5xx are retried for GET only; POSTs (/prompt, /upload/image, /queue) are attempted exactly once. */
  private async req(path: string, init?: RequestInit, timeoutMs = this.jsonTimeoutMs): Promise<Response> {
    const idempotent = (init?.method ?? "GET") === "GET";
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(path, init, timeoutMs);
      } catch (e) {
        const retryable = e instanceof ComfyHttpError && (e.status === undefined || e.status >= 500);
        if (!idempotent || !retryable || attempt >= this.opts.getRetries) throw e;
        await Bun.sleep(this.opts.retryDelayMs * 2 ** attempt);
      }
    }
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

  /** Submit one prompt, exactly once. Throws ComfyHttpError; one without `status` is an AMBIGUOUS submission. */
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

  /** Downloads one image with the long timeout and size cap; a short or corrupt body throws ComfyDownloadError (retried like any GET). */
  async view(ref: ImageRef): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
    const path = `/view?${q}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.download(path, ref);
      } catch (e) {
        const retryable = e instanceof ComfyDownloadError || (e instanceof ComfyHttpError && (e.status === undefined || e.status >= 500));
        if (!retryable || attempt >= this.opts.getRetries) throw e;
        await Bun.sleep(this.opts.retryDelayMs * 2 ** attempt);
      }
    }
  }

  private async download(path: string, ref: ImageRef): Promise<Uint8Array> {
    const res = await this.once(path, undefined, this.opts.downloadTimeoutMs);
    const cap = this.opts.maxDownloadBytes;
    const declared = Number(res.headers.get("content-length"));
    if (declared > cap) throw new ComfyDownloadError(`${ref.filename} is ${declared} bytes, over the ${cap} byte cap`, ref, "too-large");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      if (!res.body) throw new ComfyDownloadError(`${ref.filename}: empty response body`, ref, "truncated");
      const reader = res.body.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        total += r.value.length;
        if (total > cap) {
          await reader.cancel();
          throw new ComfyDownloadError(`${ref.filename} exceeds the ${cap} byte cap`, ref, "too-large");
        }
        chunks.push(r.value);
      }
    } catch (e) {
      if (e instanceof ComfyDownloadError) throw e;
      throw new ComfyDownloadError(`Download of ${ref.filename} interrupted after ${total} bytes: ${(e as Error).message}`, ref, "truncated");
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    if (Number.isFinite(declared) && res.headers.has("content-length") && declared !== total) {
      throw new ComfyDownloadError(`${ref.filename}: got ${total} of ${declared} bytes`, ref, "truncated");
    }
    const problem = pngProblem(bytes);
    if (problem) throw new ComfyDownloadError(`${ref.filename} is not a complete image: ${problem}`, ref, "truncated");
    return bytes;
  }

  /** Delete one queued (not running) prompt. Never calls global /interrupt. Single attempt (POST). */
  async deleteQueued(promptId: string): Promise<void> {
    await this.req("/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
  }

  /** Find prompts carrying our identity in the running/pending queue and in history. Throws if either read fails. */
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
