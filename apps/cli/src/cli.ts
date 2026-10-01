import { readFileSync } from "node:fs";
import { z } from "zod";
import { ERROR_EXIT_CODE, OPERATIONS, OPERATION_NAMES, ErrorCode, isOperationName, type OperationResult } from "@brainforge/contracts";
import { DEFAULT_TIMEOUT_MS, callOperation, failure } from "./client.ts";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
}

interface Parsed {
  op?: string;
  project?: string;
  input?: string;
  inputFile?: string;
  requestId?: string;
  timeoutS?: string;
  list: boolean;
  help: boolean;
}

const VALUE_FLAGS: Record<string, true> = { "--project": true, "--input": true, "--input-file": true, "--request-id": true, "--timeout": true };

export function parseArgs(argv: string[]): Parsed | { error: string } {
  const out: Parsed = { list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let flag = arg;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      flag = arg.slice(0, arg.indexOf("="));
      inline = arg.slice(arg.indexOf("=") + 1);
    }
    if (flag === "--") continue;
    if (flag === "--json") continue;
    if (flag === "--list") { out.list = true; continue; }
    if (flag === "--help" || flag === "-h") { out.help = true; continue; }
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined) return { error: `Flag ${flag} requires a value.` };
      if (flag === "--project") out.project = value;
      else if (flag === "--input") out.input = value;
      else if (flag === "--input-file") out.inputFile = value;
      else if (flag === "--request-id") out.requestId = value;
      else out.timeoutS = value;
      continue;
    }
    if (arg.startsWith("--")) return { error: `Unknown flag ${arg}.` };
    if (out.op !== undefined) return { error: `Unexpected extra argument "${arg}".` };
    out.op = arg;
  }
  return out;
}

export function exitCodeFor(result: OperationResult): number {
  if (result.ok) return 0;
  const parsed = ErrorCode.safeParse(result.error.code);
  return parsed.success ? ERROR_EXIT_CODE[parsed.data] : 6;
}

function emit(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

/** Runs the CLI; stdout receives exactly one JSON document, diagnostics go to stderr. Returns the exit code. */
export async function run(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    emit(io, failure("", "INVALID_INPUT", args.error, [{ label: "Usage: bf <operation> [--project <dir>] --input '<json>'   (bf --list for operations)" }]));
    return 2;
  }

  if (args.list) {
    emit(io, {
      ok: true,
      data: {
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
    });
    return 0;
  }

  if (args.op === undefined) {
    emit(io, failure("", "INVALID_INPUT", "Missing operation name.", [{ label: "List operations: bf --list" }]));
    return 2;
  }
  if (!isOperationName(args.op)) {
    emit(io, failure("", "INVALID_INPUT", `Unknown operation "${args.op}".`, [{ label: "List operations: bf --list" }]));
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
    });
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
  process.off("SIGINT", onSigint);
  emit(io, result);
  return exitCodeFor(result);
}
