import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ERROR_EXIT_CODE, OPERATIONS, OPERATION_NAMES, ErrorCode, Visual, isOperationName, type OperationResult } from "@brainforge/contracts";
import { DEFAULT_TIMEOUT_MS, callOperation, failure, fetchProjectFile, type CallOptions } from "./client.ts";
import { renderEnvelope, renderHelp, renderOperationHelp, setColor } from "./format.ts";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  /** True when stdout is a terminal; picks the default output format. */
  isTTY: boolean;
}

interface Parsed {
  op?: string;
  project?: string;
  input?: string;
  inputFile?: string;
  requestId?: string;
  timeoutS?: string;
  help: boolean;
  format?: Format;
}
type Format = "json" | "text";

const VALUE_FLAGS: Record<string, true> = { "--project": true, "--input": true, "--input-file": true, "--request-id": true, "--timeout": true };

export function parseArgs(argv: string[]): (Parsed & { error?: undefined }) | { error: string; format?: Format } {
  const out: Parsed = { help: false };
  let error: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let flag = arg;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      flag = arg.slice(0, arg.indexOf("="));
      inline = arg.slice(arg.indexOf("=") + 1);
    }
    if (flag === "--") continue;
    if (flag === "--json" || flag === "--text") { out.format = flag === "--json" ? "json" : "text"; continue; }
    if (flag === "--help" || flag === "-h") { out.help = true; continue; }
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined) { error ??= `Flag ${flag} requires a value.`; break; }
      if (flag === "--project") out.project = value;
      else if (flag === "--input") out.input = value;
      else if (flag === "--input-file") out.inputFile = value;
      else if (flag === "--request-id") out.requestId = value;
      else out.timeoutS = value;
      continue;
    }
    // Keep scanning after a parse error so a later --json/--text still selects the error's format.
    if (arg.startsWith("--")) { error ??= `Unknown flag ${arg}.`; continue; }
    if (out.op !== undefined) { error ??= `Unexpected extra argument "${arg}".`; continue; }
    out.op = arg;
  }
  if (error !== undefined) return out.format ? { error, format: out.format } : { error };
  return out;
}

export function exitCodeFor(result: OperationResult): number {
  if (result.ok) return 0;
  const parsed = ErrorCode.safeParse(result.error.code);
  return parsed.success ? ERROR_EXIT_CODE[parsed.data] : 6;
}

let outputFormat: Format = "json";

/** JSON: indented envelope. Text: rendered envelope; `body` replaces the generic data tree. */
function emit(io: CliIo, value: unknown, body?: (data: unknown) => string[]): void {
  io.stdout(outputFormat === "json" ? `${JSON.stringify(value, null, 2)}\n` : renderEnvelope(value, body));
}

/** Longest edge of the derivative fetched for each visual; sized for model image input. */
const VISUAL_MAX_EDGE_PX = 1568;
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const VisualsData = z.object({ visuals: z.array(Visual).min(1) });
const ExampleVisualsData = z.object({ examples: z.array(z.object({ visuals: z.array(Visual) })).min(1) });

interface VisualFile { fileId: string; role: string; label: string; path?: string; error?: string }

/**
 * Saves a model-sized derivative of every image in `data.visuals` (or `data.examples[].visuals`) to a fresh temp
 * directory so a file-reading agent can look at it. Failures are listed per visual, never dropped silently.
 */
async function saveVisuals(data: unknown, options: CallOptions): Promise<VisualFile[]> {
  const direct = VisualsData.safeParse(data);
  const examples = ExampleVisualsData.safeParse(data);
  const visuals = direct.success ? direct.data.visuals : examples.success ? examples.data.examples.flatMap((e) => e.visuals) : [];
  if (visuals.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "brainforge-visuals-"));
  const files: VisualFile[] = [];
  for (const [index, { fileId, role, label, mediaType }] of visuals.entries()) {
    const entry: VisualFile = { fileId, role, label };
    files.push(entry);
    if (IMAGE_EXT[mediaType] === undefined) {
      entry.error = `${mediaType} is not an image`;
      continue;
    }
    const fetched = await fetchProjectFile(fileId, { ...options, maxEdgePx: VISUAL_MAX_EDGE_PX });
    if ("error" in fetched) {
      entry.error = fetched.error;
      continue;
    }
    const ext = IMAGE_EXT[fetched.mediaType];
    if (ext === undefined) {
      entry.error = `server returned ${fetched.mediaType}`;
      continue;
    }
    entry.path = join(dir, `${String(index + 1).padStart(2, "0")}.${ext}`);
    writeFileSync(entry.path, fetched.bytes);
  }
  return files;
}

/** Runs the CLI; stdout receives exactly one JSON document, diagnostics go to stderr. Returns the exit code. */
export async function run(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  outputFormat = args.format ?? (io.isTTY ? "text" : "json");
  setColor(outputFormat === "text" && io.isTTY && !env.NO_COLOR);
  if (args.error !== undefined) {
    emit(io, failure("", "INVALID_INPUT", args.error, [{ label: "Usage: brainforge <operation> [--project <dir>] --input '<json>'   (brainforge --help for operations)" }]));
    return 2;
  }

  if (args.help && args.op === undefined) {
    emit(io, {
      ok: true,
      data: {
        usage: "brainforge <operation> [options]",
        summary: "Run Brainforge operations through the local server.",
        options: {
          "--help, -h": "Show this help with every operation, or an operation's input JSON Schema when an operation is given.",
          "--input <json|->": "JSON input (default {}); use - to read stdin.",
          "--input-file <path>": "Read JSON input from a file instead of --input.",
          "--project <absolute dir>": "Override discovery of the nearest ancestor containing brainforge/project.yaml.",
          "--request-id <id>": "Set the idempotency key; reuse it with identical input when retrying.",
          "--timeout <seconds>": `Stop waiting after this many seconds (default ${DEFAULT_TIMEOUT_MS / 1000}); does not cancel server work.`,
          "--json": "Force the JSON envelope on stdout (default when stdout is not a terminal).",
          "--text": "Force human-readable text on stdout (default when stdout is a terminal). The last of --json/--text wins.",
        },
        environment: { BF_SERVER_URL: "Server URL (default http://127.0.0.1:3210).", NO_COLOR: "Disable colour in text output." },
        examples: [
          "brainforge spec.read --help",
          `brainforge spec.read --input '{"path":"brainforge/project.yaml"}'`,
        ],
        operations: OPERATION_NAMES.map((name) => ({
          name,
          summary: OPERATIONS[name].summary,
          mutating: OPERATIONS[name].mutating,
          needsProject: OPERATIONS[name].needsProject,
          humanOnly: OPERATIONS[name].humanOnly,
        })),
      },
      nextActions: [],
      warnings: [],
    }, renderHelp);
    return 0;
  }

  if (args.op === undefined) {
    emit(io, failure("", "INVALID_INPUT", "Missing operation name.", [{ label: "List operations: brainforge --help" }]));
    return 2;
  }
  if (!isOperationName(args.op)) {
    emit(io, failure("", "INVALID_INPUT", `Unknown operation "${args.op}".`, [{ label: "List operations: brainforge --help" }]));
    return 2;
  }

  if (args.help) {
    const def = OPERATIONS[args.op];
    emit(io, {
      ok: true,
      data: {
        name: args.op,
        summary: def.summary,
        mutating: def.mutating,
        needsProjectNote: "project defaults to the nearest ancestor of the working directory containing brainforge/project.yaml",
        humanOnly: def.humanOnly,
        needsProject: def.needsProject,
        inputSchema: z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }),
      },
      nextActions: [],
      warnings: [],
    }, renderOperationHelp);
    return 0;
  }

  const requestId = args.requestId ?? crypto.randomUUID();
  let rawInput: string | undefined;
  if (args.input !== undefined && args.inputFile !== undefined) {
    emit(io, failure(requestId, "INVALID_INPUT", "Use only one of --input and --input-file."));
    return 2;
  }
  try {
    if (args.inputFile !== undefined) rawInput = readFileSync(args.inputFile, "utf8");
    else if (args.input === "-") rawInput = await io.readStdin();
    else rawInput = args.input;
  } catch (error) {
    emit(io, failure(requestId, "INVALID_INPUT", `Cannot read input: ${error instanceof Error ? error.message : String(error)}`));
    return 2;
  }

  let input: unknown = {};
  if (rawInput !== undefined && rawInput.trim() !== "") {
    try {
      input = JSON.parse(rawInput);
    } catch (error) {
      emit(io, failure(requestId, "INVALID_INPUT", `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
      return 2;
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (args.timeoutS !== undefined) {
    const seconds = Number(args.timeoutS);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      emit(io, failure(requestId, "INVALID_INPUT", `--timeout must be a positive number of seconds, got "${args.timeoutS}".`));
      return 2;
    }
    timeoutMs = seconds * 1000;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  io.stderr(`bf ${args.op} requestId=${requestId}\n`);
  const callOptions: Parameters<typeof callOperation>[1] = { input, requestId, timeoutMs, signal: controller.signal };
  if (args.project !== undefined) callOptions.project = args.project;
  const serverUrl = env.BF_SERVER_URL?.trim();
  if (serverUrl) callOptions.serverUrl = serverUrl;
  const result = await callOperation(args.op, callOptions);
  const { requestId: _requestId, input: _input, ...fetchOptions } = callOptions;
  const visualFiles = result.ok ? await saveVisuals(result.data, fetchOptions) : [];
  process.off("SIGINT", onSigint);
  emit(io, visualFiles.length > 0 ? { ...result, visualFiles } : result);
  return exitCodeFor(result);
}
