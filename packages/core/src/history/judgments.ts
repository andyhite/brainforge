import type { JudgmentSummary } from "@brainforge/contracts";
import type { AuthoredSet } from "../authored.ts";
import type { OpenProject } from "../project-runtime.ts";
import { toDecision, type DecisionRow } from "../review/authority.ts";
import { OperationFailure } from "../runtime.ts";
import { assetFacts } from "./examples.ts";

/** Agent decisions set against the human overrides that replaced them. Counts and cases only. */
export function judgmentSummary(open: OpenProject, set: AuthoredSet, input: { assetId?: string; styleId?: string }): JudgmentSummary {
  if (input.assetId !== undefined && !set.assets.some((a) => a.fileId === input.assetId) && !set.bareAssetDirs.includes(input.assetId)) {
    throw new OperationFailure("NOT_FOUND", `No asset ${input.assetId}`, undefined, [{ label: "List assets", operation: "asset.list" }]);
  }
  if (input.styleId !== undefined && !set.styles.some((s) => s.fileId === input.styleId)) {
    throw new OperationFailure("NOT_FOUND", `No style ${input.styleId}`);
  }
  // A style reaches an asset through the project's styleIds or the asset's own.
  const inScope = (assetId: string): boolean =>
    (input.assetId === undefined || assetId === input.assetId)
    && (input.styleId === undefined || (assetFacts(set, assetId)?.styleIds.includes(input.styleId) ?? false));

  const rows = open.db.query<DecisionRow, []>("SELECT * FROM review_decisions ORDER BY created_at, rowid").all().filter((r) => inScope(r.asset_id));
  const byId = new Map(rows.map((r) => [r.decision_id, r]));
  const agent = rows.filter((r) => r.actor_type === "agent");
  const cases: JudgmentSummary["cases"] = [];
  for (const human of rows) {
    const earlier = human.kind === "override" && human.actor_type === "human" && human.supersedes_decision_id !== null ? byId.get(human.supersedes_decision_id) : undefined;
    if (earlier?.actor_type !== "agent") continue;
    cases.push({
      candidateId: human.candidate_id, outputId: human.output_id, assetId: human.asset_id, stepId: human.step_id,
      agentDecision: toDecision(earlier), humanDecision: toDecision(human), reversed: earlier.decision !== human.decision,
    });
  }
  cases.reverse();
  const escalations = open.db.query<{ asset_id: string; status: string }, []>("SELECT asset_id, status FROM review_escalations").all().filter((e) => inScope(e.asset_id));
  return {
    scope: { ...(input.assetId === undefined ? {} : { assetId: input.assetId }), ...(input.styleId === undefined ? {} : { styleId: input.styleId }) },
    agentDecisions: agent.length,
    agentApprovals: agent.filter((r) => r.decision === "approve").length,
    agentRejections: agent.filter((r) => r.decision === "reject").length,
    humanDecisions: rows.filter((r) => r.actor_type === "human").length,
    overrides: cases.length,
    reversals: cases.filter((c) => c.reversed).length,
    escalations: escalations.length,
    pendingEscalations: escalations.filter((e) => e.status === "pending").length,
    cases,
  };
}
