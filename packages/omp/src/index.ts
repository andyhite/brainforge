import { z } from "zod";
import { jsonSchemaToZod } from "./json-schema.ts";
import { callOperation } from "@brainforge/cli/client";
import { OPERATIONS, OPERATION_NAMES, type OperationResult } from "@brainforge/contracts";

/** Minimal structural view of the oh-my-pi ExtensionAPI surface used here (omp://extensions.md). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface ToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: ToolParams, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<ToolResult>;
}

export interface ToolParams {
  project?: string;
  requestId?: string;
  input?: unknown;
}

export interface ExtensionApiLike {
  zod: typeof z;
  registerTool(tool: ToolDefinitionLike): void;
  setLabel?(label: string): void;
}

export function toolName(operation: string): string {
  return `brainforge_${operation.replaceAll(/[.-]/g, "_")}`;
}

/** Single place where an OperationResult becomes an agent-visible tool result. Image blocks land here in later milestones. */
export function toToolResult(envelope: OperationResult): ToolResult {
  if (envelope.ok) {
    const lines = [JSON.stringify(envelope.data, null, 2)];
    if (envelope.warnings.length > 0) lines.push(`Warnings: ${envelope.warnings.join("; ")}`);
    if (envelope.nextActions.length > 0) lines.push(`Next actions: ${JSON.stringify(envelope.nextActions)}`);
    if (envelope.jobId) lines.push(`Job: ${envelope.jobId}`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: true, envelope } };
  }
  const { code, message, recoveryActions } = envelope.error;
  const lines = [`ERROR ${code}: ${message}`];
  if (recoveryActions.length > 0) lines.push(`Recovery actions: ${JSON.stringify(recoveryActions)}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { ok: false, code, message, recoveryActions, requestId: envelope.requestId, envelope },
  };
}

/** Operations whose input schema could not be built with the host builder and use a loose record instead. */
export const schemaFallbacks: string[] = [];

export default function brainforge(pi: ExtensionApiLike): void {
  const zod = pi.zod;
  pi.setLabel?.("Brainforge");
  schemaFallbacks.length = 0;
  for (const operation of OPERATION_NAMES) {
    const def = OPERATIONS[operation];
    let inputSchema: z.ZodType;
    try {
      inputSchema = jsonSchemaToZod(zod, z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }));
    } catch {
      schemaFallbacks.push(operation);
      inputSchema = zod.record(zod.string(), zod.unknown());
    }
    const notes = [
      def.summary,
      def.needsProject ? "Requires `project`: the absolute game directory (never inferred)." : "Machine-level: do not pass `project`.",
      def.mutating ? "Mutating: reuse the same `requestId` when retrying; it makes the call idempotent." : "Read-only.",
      def.humanOnly ? "Human-only: agents are denied; use authorization.request to ask." : "",
      operation === "spec.write" ? "Pass `expectedHash` (sha256 of the current file from spec.read/spec.list), or null to create a new file exclusively; a stale hash returns SPEC_CONFLICT." : "",
    ];
    pi.registerTool({
      name: toolName(operation),
      label: `Brainforge ${operation}`,
      description: notes.filter(Boolean).join(" "),
      parameters: zod.object({
        project: zod.string().optional().describe("Absolute game directory for project-scoped operations."),
        requestId: zod.string().optional().describe("Idempotency key; generated from the tool call when omitted."),
        input: inputSchema.describe(`Operation input for ${operation}.`),
      }),
      async execute(toolCallId, params, signal) {
        const options: Parameters<typeof callOperation>[1] = {
          input: params.input ?? {},
          requestId: params.requestId ?? `omp-${toolCallId}`.slice(0, 128),
        };
        if (params.project !== undefined) options.project = params.project;
        if (signal) options.signal = signal;
        return toToolResult(await callOperation(operation, options));
      },
    });
  }
}
