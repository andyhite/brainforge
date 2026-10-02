import type { ComfyGraph } from "@brainforge/contracts";
import { loadWorkflow, workflowVersions } from "../workflow.ts";
import { generateImage } from "./png.ts";

export const FAULT_NAMES = [
  "submit-timeout-after-accept",
  "submit-timeout-before-accept",
  "view-truncate",
  "view-truncate-late",
  "view-500-once",
  "history-missing",
  "server-restart",
  "object-info-missing-node",
  "slow",
] as const;
export type FaultName = (typeof FAULT_NAMES)[number];

/** Fired once on the next matching request, then removed. The others stay armed until cleared. */
const ONE_SHOT: ReadonlySet<FaultName> = new Set(["submit-timeout-after-accept", "submit-timeout-before-accept", "view-500-once", "server-restart"]);

const BUNDLED_WORKFLOWS = ["krea2-still", "krea2-variation", "wan22-motion", "krea2-still-opaque", "krea2-variation-opaque", "wan22-motion-opaque", "krea2-construction-sheet", "krea2-construction-sheet-opaque"];
const STILL_SIZE = 512;
const SEQUENCE_SIZE = 128;
const SEQUENCE_MAX_FRAMES = 81;
/** Downloads that `view-truncate-late` serves intact before it starts cutting them short. */
const LATE_VIEWS = 4;

export interface FakeComfyOptions {
  /** Default 0 = any free port. */
  port?: number;
  /** Time a prompt spends `running` before completing. Default 300ms. */
  latencyMs?: number;
  /** Per-request delay while the `slow` fault is armed. Default 1500ms. */
  slowMs?: number;
  faults?: FaultName[];
}

interface ImageFile { filename: string; subfolder: string; type: string }
type QueueTuple = [number, string, ComfyGraph, Record<string, unknown>, string[]];

export interface FakePrompt {
  promptId: string;
  clientId?: string;
  identity?: string;
  extraData: Record<string, unknown>;
  graph: ComfyGraph;
  state: "pending" | "running" | "succeeded" | "deleted";
  /** 1-based order in which the server accepted it. */
  acceptedIndex: number;
}

interface Entry {
  prompt: FakePrompt;
  tuple: QueueTuple;
}

interface State {
  entries: Map<string, Entry>;
  pending: Entry[];
  running: Entry | undefined;
  history: Record<string, unknown>;
  files: Map<string, Uint8Array>;
  uploads: Set<string>;
  counters: Map<string, number>;
  accepted: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface FakeComfy {
  readonly url: string;
  readonly port: number;
  injectFault(name: FaultName): void;
  clearFault(name?: FaultName): void;
  faults(): FaultName[];
  prompts(): FakePrompt[];
  /** Prompts the server accepted (including ones whose response the client never saw). */
  submissionCount(): number;
  /** Requests received so far, optionally filtered; faulted/failed requests are included. */
  requestCount(method: string, path: string): number;
  setLatency(ms: number): void;
  hideNode(classType: string): void;
  hideModel(filename: string): void;
  /** Loses all prompts, queue, history, files and uploads, like a ComfyUI process restart. */
  restart(): void;
  stop(): Promise<void>;
}

type OptionList = [string[], Record<string, unknown>];
type ObjectInfo = Record<string, { input: { required: Record<string, unknown[]> }; output: string[]; api_node: boolean }>;

async function bundledObjectInfo(): Promise<{ classes: Set<string>; models: Map<string, Map<string, Set<string>>> }> {
  const classes = new Set<string>();
  const models = new Map<string, Map<string, Set<string>>>();
  for (const id of BUNDLED_WORKFLOWS) {
    for (const version of await workflowVersions(id)) {
      const wf = await loadWorkflow(id, version);
      for (const n of Object.values(wf.graph)) classes.add(n.class_type);
      for (const c of wf.requiredNodes) classes.add(c);
      for (const m of wf.requiredModels) {
        const cls = wf.graph[m.nodeId]?.class_type;
        if (!cls) continue;
        const fields = models.get(cls) ?? new Map<string, Set<string>>();
        const files = fields.get(m.field) ?? new Set<string>();
        files.add(m.filename);
        fields.set(m.field, files);
        models.set(cls, fields);
      }
    }
  }
  return { classes, models };
}

function emptyState(): State {
  return { entries: new Map(), pending: [], running: undefined, history: {}, files: new Map(), uploads: new Set(), counters: new Map(), accepted: 0, timer: undefined };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function invalid(message: string, nodeErrors: Record<string, unknown> = {}): Response {
  return json({ error: { type: "invalid_prompt", message, details: "", extra_info: {} }, node_errors: nodeErrors }, 400);
}

export async function createFakeComfy(options: FakeComfyOptions = {}): Promise<FakeComfy> {
  const bundled = await bundledObjectInfo();
  const faults = new Set<FaultName>(options.faults ?? []);
  const hiddenNodes = new Set<string>();
  const hiddenModels = new Set<string>();
  const requests: { method: string; path: string }[] = [];
  const hung: (() => void)[] = [];
  let latencyMs = options.latencyMs ?? 300;
  const slowMs = options.slowMs ?? 1500;
  let state = emptyState();

  const nodeHidden = (cls: string) => hiddenNodes.has(cls) || (faults.has("object-info-missing-node") && cls === "Krea2EditModelPatch");

  function loadImageOptions(): OptionList {
    return [["example.png", ...state.uploads], { image_upload: true }];
  }

  function objectInfo(): ObjectInfo {
    const info: ObjectInfo = {};
    for (const cls of bundled.classes) {
      if (nodeHidden(cls)) continue;
      const required: Record<string, unknown[]> = {};
      for (const [field, files] of bundled.models.get(cls) ?? []) {
        required[field] = [[...files].filter((f) => !hiddenModels.has(f)), {}];
      }
      if (cls === "LoadImage") required.image = loadImageOptions();
      info[cls] = { input: { required }, output: [], api_node: false };
    }
    return info;
  }

  function validate(graph: unknown): Response | ComfyGraph {
    if (!graph || typeof graph !== "object" || Array.isArray(graph) || Object.keys(graph).length === 0) return invalid("Prompt has no nodes");
    const g = graph as ComfyGraph;
    const info = objectInfo();
    let hasOutput = false;
    for (const [id, node] of Object.entries(g)) {
      if (typeof node?.class_type !== "string" || !info[node.class_type]) {
        return invalid(`Cannot execute because node ${node?.class_type} does not exist.`, { [id]: { class_type: node?.class_type, errors: [{ type: "missing_node_type" }] } });
      }
      if (node.class_type === "SaveImage") hasOutput = true;
      for (const [field, spec] of Object.entries(info[node.class_type]!.input.required)) {
        const value = node.inputs[field];
        const options = spec[0];
        if (Array.isArray(options) && typeof value === "string" && !options.includes(value)) {
          return invalid("Prompt outputs failed validation", { [id]: { class_type: node.class_type, errors: [{ type: "value_not_in_list", message: `Value not in list: ${field}: '${value}' not in list` }] } });
        }
      }
    }
    return hasOutput ? g : invalid("Prompt has no outputs");
  }

  /** The first numeric seed-like input in the graph; images are a pure function of it. */
  function seedOf(graph: ComfyGraph): number {
    for (const node of Object.values(graph)) {
      const s = node.inputs.seed ?? node.inputs.noise_seed;
      if (typeof s === "number") return s;
    }
    return 0;
  }
  /** The canvas the graph asks for through an empty latent node, so requested sizes show up in the fake's images. */
  function latentSize(graph: ComfyGraph): { width: number; height: number } | undefined {
    for (const node of Object.values(graph)) {
      if ((node.class_type === "EmptySD3LatentImage" || node.class_type === "EmptyLatentImage") && typeof node.inputs.width === "number" && typeof node.inputs.height === "number") {
        return { width: node.inputs.width, height: node.inputs.height };
      }
    }
    return undefined;
  }
  /** The canvas a WanFirstLastFrameToVideo node asks for: every frame of the returned sequence has exactly this size. */
  function videoSize(graph: ComfyGraph): { width: number; height: number } | undefined {
    for (const node of Object.values(graph)) {
      if (node.class_type === "WanFirstLastFrameToVideo" && typeof node.inputs.width === "number" && typeof node.inputs.height === "number") {
        return { width: node.inputs.width, height: node.inputs.height };
      }
    }
    return undefined;
  }

  function finish(entry: Entry) {
    const { graph } = entry.prompt;
    const seed = seedOf(graph);
    const frameCount = Math.min(
      SEQUENCE_MAX_FRAMES,
      Math.max(0, ...Object.values(graph).map((n) => (typeof n.inputs.length === "number" ? n.inputs.length : 0))),
    );
    const outputs: Record<string, { images: ImageFile[] }> = {};
    for (const [nodeId, node] of Object.entries(graph)) {
      if (node.class_type !== "SaveImage") continue;
      const prefix = String(node.inputs.filename_prefix ?? "ComfyUI");
      const slash = prefix.lastIndexOf("/");
      const subfolder = slash < 0 ? "" : prefix.slice(0, slash);
      const base = slash < 0 ? prefix : prefix.slice(slash + 1);
      const source = node.inputs.images;
      const matted = Array.isArray(source) && graph[String(source[0])]?.class_type === "JoinImageWithAlpha";
      const images: ImageFile[] = [];
      for (let frame = 0; frame < Math.max(1, frameCount); frame++) {
        const key = `${subfolder}/${base}`;
        const n = (state.counters.get(key) ?? 0) + 1;
        state.counters.set(key, n);
        const filename = `${base}_${String(n).padStart(5, "0")}_.png`;
        state.files.set(`output/${subfolder}/${filename}`, generateImage(seed, frameCount > 0 ? videoSize(graph) ?? SEQUENCE_SIZE : latentSize(graph) ?? STILL_SIZE, matted, frame));
        images.push({ filename, subfolder, type: "output" });
      }
      outputs[nodeId] = { images };
    }
    entry.prompt.state = "succeeded";
    state.history[entry.prompt.promptId] = {
      prompt: entry.tuple,
      outputs,
      status: { status_str: "success", completed: true, messages: [] },
    };
    state.running = undefined;
    pump();
  }

  function pump() {
    if (state.running || state.pending.length === 0) return;
    const entry = state.pending.shift()!;
    entry.prompt.state = "running";
    state.running = entry;
    state.timer = setTimeout(() => finish(entry), latencyMs);
  }

  let lateViews = 0;
  function fire(name: FaultName): boolean {
    if (!faults.has(name)) return false;
    if (ONE_SHOT.has(name)) faults.delete(name);
    return true;
  }

  function hang(): Promise<Response> {
    return new Promise<Response>((resolve) => { hung.push(() => resolve(new Response(null, { status: 499 }))); });
  }

  async function submit(req: Request): Promise<Response> {
    if (fire("submit-timeout-before-accept")) return hang();
    const body = (await req.json().catch(() => undefined)) as { prompt?: unknown; client_id?: string; extra_data?: Record<string, unknown> } | undefined;
    const graph = validate(body?.prompt);
    if (graph instanceof Response) return graph;
    const promptId = crypto.randomUUID();
    const extraData = body?.extra_data ?? {};
    const brainforge = extraData.brainforge as { identity?: unknown } | undefined;
    state.accepted++;
    const prompt: FakePrompt = {
      promptId,
      clientId: body?.client_id,
      identity: typeof brainforge?.identity === "string" ? brainforge.identity : undefined,
      extraData,
      graph,
      state: "pending",
      acceptedIndex: state.accepted,
    };
    const entry: Entry = { prompt, tuple: [state.accepted, promptId, graph, { ...extraData, client_id: body?.client_id }, Object.entries(graph).filter(([, n]) => n.class_type === "SaveImage").map(([id]) => id)] };
    state.entries.set(promptId, entry);
    state.pending.push(entry);
    pump();
    if (fire("submit-timeout-after-accept")) return hang();
    return json({ prompt_id: promptId, number: state.accepted, node_errors: {} });
  }

  function queueBody() {
    return { queue_running: state.running ? [state.running.tuple] : [], queue_pending: state.pending.map((e) => e.tuple) };
  }

  async function upload(req: Request): Promise<Response> {
    const form = await req.formData().catch(() => undefined);
    const image = form?.get("image");
    if (!(image instanceof File)) return json({ error: "no image" }, 400);
    const subfolder = String(form?.get("subfolder") ?? "");
    const type = String(form?.get("type") ?? "input");
    state.files.set(`${type}/${subfolder}/${image.name}`, new Uint8Array(await image.arrayBuffer()));
    state.uploads.add(subfolder ? `${subfolder}/${image.name}` : image.name);
    return json({ name: image.name, subfolder, type });
  }

  function view(url: URL): Response {
    if (fire("view-500-once")) return new Response("injected failure", { status: 500 });
    const bytes = state.files.get(`${url.searchParams.get("type") ?? "output"}/${url.searchParams.get("subfolder") ?? ""}/${url.searchParams.get("filename") ?? ""}`);
    if (!bytes) return new Response("file not found", { status: 404 });
    // `view-truncate-late` lets the first few downloads through, then cuts every later one short: a sequence that dies midway.
    const late = faults.has("view-truncate-late") && lateViews++ >= LATE_VIEWS;
    const body = faults.has("view-truncate") || late ? bytes.slice(0, Math.floor(bytes.length * 0.6)) : bytes;
    return new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } });
  }

  function history(id: string | undefined, url: URL): Response {
    if (faults.has("history-missing")) return json({});
    if (id) return json(id in state.history ? { [id]: state.history[id] } : {});
    const max = Number(url.searchParams.get("max_items") ?? Infinity);
    return json(Object.fromEntries(Object.entries(state.history).slice(-max)));
  }

  async function queueMutation(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { delete?: string[] };
    for (const id of body.delete ?? []) {
      const index = state.pending.findIndex((e) => e.prompt.promptId === id);
      if (index >= 0) state.pending.splice(index, 1)[0]!.prompt.state = "deleted";
    }
    return json({});
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    requests.push({ method: req.method, path: url.pathname });
    if (faults.has("slow")) await Bun.sleep(slowMs);
    if (fire("server-restart")) restart();
    const { pathname } = url;
    if (req.method === "GET") {
      if (pathname === "/system_stats") {
        return json({
          system: { os: "posix", comfyui_version: "0.36.0-fake", python_version: "3.12 (protocol fake)" },
          devices: [{ name: "fake-gpu (protocol test server)", type: "cuda", vram_total: 0 }],
        });
      }
      if (pathname === "/object_info") return json(objectInfo());
      if (pathname === "/queue") return json(queueBody());
      if (pathname === "/history") return history(undefined, url);
      if (pathname.startsWith("/history/")) return history(decodeURIComponent(pathname.slice("/history/".length)), url);
      if (pathname === "/view") return view(url);
    } else if (req.method === "POST") {
      if (pathname === "/prompt") return submit(req);
      if (pathname === "/upload/image") return upload(req);
      if (pathname === "/queue") return queueMutation(req);
    }
    return json({ error: `not found: ${req.method} ${pathname}` }, 404);
  }

  function restart() {
    clearTimeout(state.timer);
    state = emptyState();
  }

  const server = Bun.serve({ port: options.port ?? 0, hostname: "127.0.0.1", fetch: handle });
  const port = server.port ?? 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    injectFault(name) {
      if (name === "server-restart") restart();
      else {
        if (name === "view-truncate-late") lateViews = 0;
        faults.add(name);
      }
    },
    clearFault(name) {
      if (!name || name === "view-truncate-late") lateViews = 0;
      if (name) faults.delete(name); else faults.clear();
    },
    faults: () => [...faults],
    prompts: () => [...state.entries.values()].map((e) => ({ ...e.prompt })),
    submissionCount: () => state.accepted,
    requestCount: (method, path) => requests.filter((r) => r.method === method && r.path === path).length,
    setLatency(ms) { latencyMs = ms; },
    hideNode(cls) { hiddenNodes.add(cls); },
    hideModel(file) { hiddenModels.add(file); },
    restart,
    async stop() {
      clearTimeout(state.timer);
      for (const release of hung) release();
      await server.stop(true);
    },
  };
}
