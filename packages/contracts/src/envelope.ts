import { z } from "zod";

export const RecoveryAction = z.object({ label: z.string(), operation: z.string().optional(), input: z.unknown().optional(), url: z.string().optional() });
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const NextAction = z.object({ label: z.string(), operation: z.string().optional(), input: z.unknown().optional(), url: z.string().optional() });
export type NextAction = z.infer<typeof NextAction>;
