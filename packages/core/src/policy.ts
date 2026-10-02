import { ApprovalPolicy, type PolicyView, type ReviewPolicy } from "@brainforge/contracts";
import { paths } from "@brainforge/storage";
import { readAuthoredFile } from "./authored.ts";
import { normalizedHash } from "./operations.ts";
import { OperationFailure, type ProjectHandle } from "./runtime.ts";

/** Built-in policy used until a human confirms a snapshot. */
export const DEFAULT_POLICY: ApprovalPolicy = { conceptLock: "human", productionReview: "agent_with_escalation", promotion: "human", activation: "human" };

/** Higher is more permissive for non-humans. */
const PERMISSIVENESS: Record<ReviewPolicy, number> = { human: 0, agent_with_escalation: 1, agent: 2 };

const FIELDS = ["conceptLock", "productionReview", "promotion", "activation"] as const;

export const policyHash = (policy: ApprovalPolicy): string => normalizedHash(policy);

/**
 * Why an agent may not act under the effective `field` policy: POLICY_PENDING when project.yaml requests a
 * relaxation a human has not confirmed yet, else HUMAN_AUTHORIZATION_REQUIRED. `tail` tells the agent what to hand the user.
 */
export function agentDenial(view: PolicyView, field: "productionReview" | "promotion" | "activation", verb: string, tail: string): { code: "POLICY_PENDING" | "HUMAN_AUTHORIZATION_REQUIRED"; message: string } {
  const requested = view.requested[field];
  const pending = requested !== view.effective[field] && view.pendingRelaxation && (requested === "agent" || requested === "agent_with_escalation");
  return pending
    ? { code: "POLICY_PENDING", message: `Policy requests that agents may ${verb} (${field}: ${requested}), but a human has not confirmed that change. Ask the user to confirm it in Settings.` }
    : { code: "HUMAN_AUTHORIZATION_REQUIRED", message: `Only the user may ${verb} under the current approval policy (${field}: ${view.effective[field]}). ${tail}` };
}

interface SnapshotRow { policy_json: string; confirmed_by: string; confirmed_at: string }

/** Latest human-authorized snapshot, if any. */
export function latestPolicySnapshot(project: ProjectHandle): { policy: ApprovalPolicy; confirmedBy: string; confirmedAt: string } | undefined {
  const row = project.db.query<SnapshotRow, []>("SELECT policy_json, confirmed_by, confirmed_at FROM policy_snapshots ORDER BY id DESC LIMIT 1").get();
  if (!row) return undefined;
  return { policy: ApprovalPolicy.parse(JSON.parse(row.policy_json)), confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at };
}

/** Requested (project.yaml) versus effective (last human-confirmed snapshot, else the built-in default). */
export async function policyView(project: ProjectHandle): Promise<PolicyView> {
  const snapshot = latestPolicySnapshot(project);
  const effective = snapshot?.policy ?? DEFAULT_POLICY;
  const file = await readAuthoredFile(project.root, paths.projectYaml());
  const requested = file?.kind === "project" && file.spec ? file.spec.approval : effective;
  const diff = FIELDS.filter((f) => requested[f] !== effective[f]).map((f) => ({ field: f, requested: requested[f], effective: effective[f] }));
  return {
    requested,
    effective,
    requestedPolicyHash: policyHash(requested),
    diff,
    pendingRelaxation: FIELDS.some((f) => PERMISSIVENESS[requested[f]] > PERMISSIVENESS[effective[f]]),
    confirmedBy: snapshot?.confirmedBy,
    confirmedAt: snapshot?.confirmedAt,
  };
}

/** Human confirmation of the exact requested policy. REVISION_CONFLICT when project.yaml changed since inspection. */
export async function authorizePolicy(project: ProjectHandle, requestedPolicyHash: string, actorId: string): Promise<{ view: PolicyView; revision: number }> {
  const before = await policyView(project);
  const file = await readAuthoredFile(project.root, paths.projectYaml());
  if (!file || file.kind !== "project" || !file.spec) {
    throw new OperationFailure("STEP_BLOCKED", "project.yaml is missing or invalid, so there is no requested policy to confirm", { problems: file?.problems ?? [] });
  }
  if (before.requestedPolicyHash !== requestedPolicyHash) {
    throw new OperationFailure("REVISION_CONFLICT", "The requested policy changed since you inspected it", { currentRequestedPolicyHash: before.requestedPolicyHash }, [
      { label: "Inspect current settings", operation: "settings.inspect" },
    ]);
  }
  const confirmedAt = new Date().toISOString();
  const { revision } = project.transact(() => {
    project.db.query("INSERT INTO policy_snapshots (policy_hash, policy_json, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)")
      .run(before.requestedPolicyHash, JSON.stringify(before.requested), actorId, confirmedAt);
  }, [{ type: "policy.confirmed", data: { policyHash: before.requestedPolicyHash, policy: before.requested, diff: before.diff }, actorId }]);
  return { view: await policyView(project), revision };
}
