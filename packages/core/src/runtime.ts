import type { Database } from "bun:sqlite";
import type {
  ErrorCode, NextAction, OperationContext, OperationData, OperationName, ParsedOperationInput, RecoveryAction,
} from "@brainforge/contracts";
import type { ComfyTransport } from "@brainforge/comfy";

/** Typed failure raised by handlers; executeOperation converts it to the error envelope. */
export class OperationFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly recoveryActions: RecoveryAction[] = [],
  ) {
    super(message);
  }
}

/** Durable idempotency: identical retry returns the stored result; a changed payload is IDEMPOTENCY_CONFLICT. */
export interface IdempotencyStore {
  /** Reserve (actor, request). Returns the stored terminal result for an identical completed retry. */
  reserve(key: { actorId: string; requestId: string; operation: string; payloadHash: string }): { kind: "new" } | { kind: "replay"; resultJson: string } | { kind: "in-flight" } | { kind: "conflict" };
  complete(key: { actorId: string; requestId: string }, resultJson: string): void;
  /** Validation/authorization failures are never cached: release the reservation. */
  release(key: { actorId: string; requestId: string }): void;
}

/** An opened project. Implemented in `project-runtime.ts`; handlers for project-scoped operations receive it. */
export interface ProjectHandle {
  /** Canonical absolute game directory (realpath). */
  readonly root: string;
  readonly projectId: string;
  readonly db: Database;
  /** False when the DB schema is newer than this build understands (read-only with upgrade instruction). */
  readonly writable: boolean;
  readonly idempotency: IdempotencyStore;
  /** Current committed project revision. */
  revision(): number;
  /**
   * Run `fn` in one immediate transaction, bump the project revision once, append the events, and
   * return the result. Never do network or encoding inside `fn`.
   */
  transact<T>(fn: () => T, events?: { type: string; data: unknown; actorId?: string }[]): { value: T; revision: number };
  /** Events with sequence greater than `after`, oldest first. `resync` when history before `after` was not retained. */
  eventsAfter(after: number, limit?: number): { events: { sequence: number; type: string; at: string; data: unknown }[]; resync: boolean };
  /** Subscribe to newly committed events (used by SSE). Returns an unsubscribe function. */
  subscribe(listener: (event: { sequence: number; type: string; at: string; data: unknown }) => void): () => void;
}

export interface ProjectRegistry {
  /** Opened project by canonical or symlinked path, or undefined. */
  get(root: string): ProjectHandle | undefined;
  list(): ProjectHandle[];
}

/** Machine-level state under `~/.config/brainforge/` (override with `BF_CONFIG_DIR`). Implemented by `LocalMachineStore` in machine-store.ts. */
export interface MachineStore {
  readonly idempotency: IdempotencyStore;
  /** Configured ComfyUI base URL (env `BF_COMFY_URL` overrides the stored value), if any. */
  comfyUrl(): string | undefined;
  setComfyUrl(url: string | null): void;
  recordRecent(root: string, name?: string): void;
  recents(): { root: string; name?: string; lastOpenedAt: string }[];
}

export interface OperationRuntime {
  projects: ProjectRegistry;
  machine: MachineStore;
  /** Bundled workflow YAML directory (packages/comfy/workflows). */
  workflowsDir: string;
  /** Public base URL used in human-facing links, e.g. `http://127.0.0.1:3210`. */
  publicUrl: string;
  /** ComfyUI transport for the current machine setting; absent means "build one from `machine.comfyUrl()`". Tests inject a fake here. */
  comfy?: () => ComfyTransport | undefined;
}

export interface HandlerArgs<K extends OperationName> {
  context: OperationContext;
  requestId: string;
  input: ParsedOperationInput<K>;
  /** Present iff the operation `needsProject`. */
  project: ProjectHandle | undefined;
  runtime: OperationRuntime;
}

export interface HandlerOutput<K extends OperationName> {
  data: OperationData<K>;
  nextActions?: NextAction[];
  warnings?: string[];
  /** Revision after the mutation, when a project transaction committed. */
  revision?: number;
}

export type OperationHandler<K extends OperationName> = (args: HandlerArgs<K>) => Promise<HandlerOutput<K>>;
export type HandlerMap = { [K in OperationName]?: OperationHandler<K> };
