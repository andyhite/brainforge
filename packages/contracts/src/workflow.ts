import { z } from "zod";

export const ComfyNode = z.object({
  class_type: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});
export type ComfyNode = z.infer<typeof ComfyNode>;
export type ComfyGraph = Record<string, ComfyNode>;

/** Binds a named request value to a graph node input. */
export const InputBinding = z.object({
  name: z.string(),
  nodeId: z.string(),
  field: z.string(),
  type: z.enum(["string", "integer", "number", "seed", "image"]),
  required: z.boolean().default(false),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** Additional graph inputs that receive the same value. */
  alsoTo: z.array(z.object({ nodeId: z.string(), field: z.string() })).default([]),
});
export type InputBinding = z.infer<typeof InputBinding>;

export const OutputBinding = z.object({
  /** Logical name of the produced output. */
  role: z.string(),
  nodeId: z.string(),
  kind: z.enum(["still", "frame-sequence"]),
  fps: z.number().optional(),
});
export type OutputBinding = z.infer<typeof OutputBinding>;

export const RequiredModel = z.object({
  nodeId: z.string(),
  field: z.string(),
  filename: z.string(),
});

export const Execution = z.object({
  computeLocation: z.string(),
  externalServices: z.array(z.string()),
  credentialKeys: z.array(z.string()),
  costDescription: z.string(),
  upperBoundPerRunUsd: z.number().optional(),
});
export type Execution = z.infer<typeof Execution>;

export const WorkflowDescriptor = z.object({
  schema: z.literal("brainforge.comfy-workflow.v2"),
  id: z.string(),
  version: z.number().int().positive(),
  description: z.string().optional(),
  graph: z.record(z.string(), ComfyNode),
  inputBindings: z.array(InputBinding),
  outputBindings: z.array(OutputBinding).min(1),
  requiredNodes: z.array(z.string()),
  requiredModels: z.array(RequiredModel),
  execution: Execution,
  notes: z.array(z.string()).default([]),
});
export type WorkflowDescriptor = z.infer<typeof WorkflowDescriptor>;
