import type { OperationResult } from "./operations.ts";
import { z } from "zod";

export const RecoveryAction = z.object({ label: z.string(), operation: z.string().optional(), input: z.unknown().optional(), url: z.string().optional() });
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const NextAction = z.object({ label: z.string(), operation: z.string().optional(), input: z.unknown().optional(), url: z.string().optional() });
export type NextAction = z.infer<typeof NextAction>;

/** Shape check for an operation envelope received over the wire; the server stays the authority on the contents. */
export function isOperationResult(value: unknown): value is OperationResult<unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return true;
  if (value.ok !== false || !("error" in value)) return false;
  const e = value.error;
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" && "message" in e && typeof e.message === "string";
}
