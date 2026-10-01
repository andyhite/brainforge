import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OPERATIONS, OPERATION_NAMES, Visual, type OperationName, type OperationResult } from "@brainforge/contracts";
import { callOperation, failure, fetchProjectFile, findProjectRoot, resolveServerUrl, type FetchedFile } from "@brainforge/cli/client";

export interface McpOptions {
  /** Working directory used for project discovery. */
  cwd: string;
  /** Absolute game directory override (the `--project` flag of the MCP binary). */
  project?: string;
  serverUrl?: string;
}

const TOOL_TO_OPERATION: Record<string, OperationName> = Object.fromEntries(OPERATION_NAMES.map((name) => [name.replaceAll(".", "_"), name]));

const InputSchemaShape = z.object({ properties: z.record(z.string(), z.unknown()).optional(), required: z.array(z.string()).optional() }).passthrough();
const CallArguments = z.record(z.string(), z.unknown());

const EXTRA_PROPERTIES = {
  project: { type: "string", description: "Optional absolute game directory. Default: the nearest ancestor of the MCP server's working directory containing brainforge/project.yaml." },
  requestId: { type: "string", minLength: 1, maxLength: 128, description: "Idempotency key for mutating tools. Reuse the same value when retrying the same call." },
};

function describeOperation(name: OperationName): string {
  const def = OPERATIONS[name];
  const notes = ["The project comes from the working directory by default."];
  notes.push(def.mutating ? "Mutating: pass a requestId and reuse it on retry." : "Read-only and safe to call.");
  if (name === "spec.schema") notes.push("Call this first for any YAML kind you have not written: returns JSON Schema, minimal and full examples, and conventions.");
  if (name === "spec.validate") notes.push("Dry run: iterate until problems is empty instead of writing drafts to see errors; returns currentHash for spec_write.");
  if (name === "spec.write") notes.push("Validate first with spec_validate; expectedHash = currentHash from spec_validate/spec_read/spec_list, or null to create a new file. On SPEC_CONFLICT re-read, merge, retry.");
  if (def.humanOnly) notes.push("Human-only: you will be refused. Ask the user to do this in the Brainforge web UI.");
  return `${def.summary} ${notes.join(" ")}`;
}

function buildTool(name: OperationName): Tool {
  const def = OPERATIONS[name];
  const shape = InputSchemaShape.parse(z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }));
  return {
    name: name.replaceAll(".", "_"),
    description: describeOperation(name),
    inputSchema: { ...shape, type: "object", properties: { ...shape.properties, ...EXTRA_PROPERTIES } },
  };
}

export const TOOLS: Tool[] = OPERATION_NAMES.map(buildTool);

/**
 * Single place that shapes an OperationResult for MCP clients. Image content blocks for review
 * material are added here in later milestones.
 */
export function toToolResult(envelope: OperationResult): CallToolResult {
  if (envelope.ok) {
    const payload = { data: envelope.data, nextActions: envelope.nextActions, warnings: envelope.warnings };
    const text = JSON.stringify(
      { ...payload, ...(envelope.revision !== undefined ? { revision: envelope.revision } : {}), ...(envelope.jobId !== undefined ? { jobId: envelope.jobId } : {}) },
      null,
      2,
    );
    return { content: [{ type: "text", text }], structuredContent: { ...payload } };
  }
  const { error } = envelope;
  const lines = [`ERROR ${error.code}: ${error.message}`];
  if (error.recoveryActions.length > 0) {
    lines.push("Recovery:");
    for (const action of error.recoveryActions) {
      lines.push(`- ${action.label}${action.operation ? ` (${action.operation.replaceAll(".", "_")})` : ""}${action.input !== undefined ? ` ${JSON.stringify(action.input)}` : ""}`);
    }
  }
  if (error.details !== undefined) lines.push("Details:", JSON.stringify(error.details, null, 2));
  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { error: { code: error.code, message: error.message, recoveryActions: error.recoveryActions, details: error.details ?? null } },
  };
}

/** Longest edge of the derivative requested from the files route; sized for model image input. */
export const VISUAL_MAX_EDGE_PX = 1568;
export const MAX_VISUALS_PER_RESULT = 6;
export const MAX_VISUAL_BYTES_TOTAL = 8 * 1024 * 1024;

const VisualsData = z.object({ visuals: z.array(Visual).min(1) });
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

export type VisualFetcher = (fileId: string) => Promise<FetchedFile | { error: string }>;

/**
 * Appends image content blocks for `data.visuals` after the (unchanged) JSON text block, plus a text
 * note listing what was attached and, explicitly, anything skipped (cap, byte budget, non-image, failed fetch).
 */
export async function attachVisuals(envelope: OperationResult, result: CallToolResult, fetchVisual: VisualFetcher): Promise<CallToolResult> {
  if (!envelope.ok) return result;
  const parsed = VisualsData.safeParse(envelope.data);
  if (!parsed.success) return result;
  const { visuals } = parsed.data;
  const notes: string[] = [];
  const images: CallToolResult["content"] = [];
  let totalBytes = 0;
  let budgetExhausted = false;
  for (const [index, visual] of visuals.entries()) {
    const label = `visual ${index + 1}/${visuals.length} fileId=${visual.fileId} role=${visual.role} "${visual.label}"`;
    if (images.length >= MAX_VISUALS_PER_RESULT) {
      notes.push(`NOT ATTACHED (limit of ${MAX_VISUALS_PER_RESULT} images per result): ${label}. Original: fileId ${visual.fileId}.`);
      continue;
    }
    if (!IMAGE_TYPES.test(visual.mediaType)) {
      notes.push(`NOT ATTACHED (${visual.mediaType} is not an image type this tool can inline): ${label}.`);
      continue;
    }
    if (budgetExhausted) {
      notes.push(`NOT ATTACHED (total size limit of ${MAX_VISUAL_BYTES_TOTAL} bytes reached): ${label}.`);
      continue;
    }
    const fetched = await fetchVisual(visual.fileId);
    if ("error" in fetched) {
      notes.push(`NOT ATTACHED (fetch failed: ${fetched.error}): ${label}.`);
      continue;
    }
    if (totalBytes + fetched.bytes.length > MAX_VISUAL_BYTES_TOTAL) {
      budgetExhausted = true;
      notes.push(`NOT ATTACHED (total size limit of ${MAX_VISUAL_BYTES_TOTAL} bytes would be exceeded): ${label}.`);
      continue;
    }
    if (!IMAGE_TYPES.test(fetched.mediaType)) {
      notes.push(`NOT ATTACHED (server returned ${fetched.mediaType}): ${label}.`);
      continue;
    }
    totalBytes += fetched.bytes.length;
    images.push({ type: "image", data: Buffer.from(fetched.bytes).toString("base64"), mimeType: fetched.mediaType });
    notes.push(`Attached image block #${images.length}: ${label} (derivative, longest edge <= ${VISUAL_MAX_EDGE_PX}px; the original is fileId ${visual.fileId}).`);
  }
  return { ...result, content: [...result.content, { type: "text", text: notes.join("\n") }, ...images] };
}

export function buildInstructions(options: McpOptions): string {
  const root = options.project ?? findProjectRoot(options.cwd);
  const serverUrl = resolveServerUrl(options.serverUrl);
  return [
    root === undefined
      ? `Working project: none found (no brainforge/project.yaml at or above ${options.cwd}). Pass project=<absolute game dir> on each call or restart in the game directory.`
      : `Working project root: ${root}`,
    `Brainforge server: ${serverUrl} (you act as an agent; human-only decisions are refused).`,
    "Tool names: one tool per operation, dots become underscores (spec.write -> spec_write). omp shows them as mcp__brainforge_<op> (call by writing JSON to xd://mcp__brainforge_<op>); Claude Code shows mcp__brainforge__<op>.",
    "Quickstart:",
    "1. project_inspect, then asset_list, to see the project and its assets.",
    "2. Before writing a YAML kind you have not written, call spec_schema {kind}: JSON Schema, minimal and full examples, conventions.",
    "3. Draft the file, then spec_validate {path,text} until problems is empty. Never write a draft just to see errors.",
    "4. spec_write with expectedHash = currentHash from spec_validate (null to create a new file); reuse requestId when retrying.",
    "5. On SPEC_CONFLICT: spec_read, merge the current text with your change, retry with the new hash.",
    "6. Human-only actions (policy confirmation, ComfyUI connection) must be done by the user in the Brainforge web UI.",
    "7. Concept generation: budgets are granted ONLY by the human in the web UI (budget_list shows them; you cannot grant one). generation_plan -> inspect/show the plan (counts, blockers, budget) -> generation_start with its planHash. Then poll job_inspect until terminal; unresolved jobs are never resubmitted automatically and job_cancel only works on queued jobs.",
    "8. Review: candidate_inspect / revision_inspect return the actual images as image content blocks (model-sized derivatives; the text lists each original fileId and anything not attached). revision_list status=open finds work waiting for you. After acting (editing specs, starting a variation) call revision_respond. NEVER revision_resolve or revision_waive unless the user told you to and policy allows.",
    "9. Human-only actions (policy confirmation, ComfyUI connection, granting budgets) must be done by the user in the Brainforge web UI; ask them.",
    "10. Concepts become production through concept_lock {assetId,candidateId,outputId}, which obeys the effective approval.conceptLock policy (usually the user locks in the web UI). If refused (HUMAN_AUTHORIZATION_REQUIRED / POLICY_PENDING), tell the user exactly which candidate and output to lock; do not retry. Never lock a concept the user did not choose. candidate_select is a choice, NOT approval.",
    "11. step_list {assetId,branchId} shows what is ready. Deliverable generation (generation_plan/start with a deliverable stepId) needs a branchId and every dependsOn deliverable approved; blockers name the unmet dependency. Motion (kind animation) generation arrives in M4: expect WORKFLOW_UNAVAILABLE.",
    "12. Review loop: review_list -> review_material {candidateId} (the visuals, including sheet region crops, arrive as image content blocks) -> judge the images against the deliverable description, requirements and exact prompt -> review_decide {candidateId,outputIds,requirementsHash (from review_material, never a stale one),decision,reasons (concrete; required to reject)}. When unsure call review_escalate {candidateId,outputIds,reason}: never guess; an escalation is not approval. Your decisions are recorded as agent decisions; never claim human approval. review_override is human-only. If review_material says you.canDecide is false, ask the user.",
    "The YAML text IS the image prompt (description, identity values, perspective, palette, artDirection; notes are never sent). Read plan.prompt from generation_plan and fix the YAML before generation_start.",
    "The `brainforge` skill has the YAML format reference, references/generation-review.md and references/branches-review.md.",
  ].join("\n");
}

export function createServer(options: McpOptions): Server {
  const server = new Server({ name: "brainforge", version: "0.0.0" }, { capabilities: { tools: {} }, instructions: buildInstructions(options) });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const operation = Object.hasOwn(TOOL_TO_OPERATION, request.params.name) ? TOOL_TO_OPERATION[request.params.name] : undefined;
    if (operation === undefined) {
      return toToolResult(failure("", "INVALID_INPUT", `Unknown tool "${request.params.name}".`));
    }
    const args = CallArguments.parse(request.params.arguments ?? {});
    const { project, requestId, ...input } = args;
    const callOptions: Parameters<typeof callOperation>[1] = { input, cwd: options.cwd, agent: "mcp", signal: extra.signal };
    if (typeof project === "string" && project !== "") callOptions.project = project;
    else if (options.project !== undefined) callOptions.project = options.project;
    if (typeof requestId === "string" && requestId !== "") callOptions.requestId = requestId;
    if (options.serverUrl !== undefined) callOptions.serverUrl = options.serverUrl;
    const envelope = await callOperation(operation, callOptions);
    const result = toToolResult(envelope);
    const { requestId: _ignored, input: _input, ...fetchOptions } = callOptions;
    return attachVisuals(envelope, result, (fileId) => fetchProjectFile(fileId, { ...fetchOptions, maxEdgePx: VISUAL_MAX_EDGE_PX }));
  });
  return server;
}
