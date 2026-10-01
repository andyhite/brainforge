import type { ExampleTier, HistoryExample } from "@brainforge/contracts";
import type { StepId } from "@brainforge/contracts";
import type { AuthoredSet } from "../authored.ts";
import { stylesFor } from "../generation/prompt.ts";
import type { OpenProject } from "../project-runtime.ts";
import { toDecision, type DecisionRow } from "../review/authority.ts";
import { outputVisuals } from "../review/records.ts";
import { OperationFailure } from "../runtime.ts";

const TIER_RANK: Record<ExampleTier, number> = { asset: 0, "style-family": 1, family: 2 };

export interface ExampleScope { assetId: string; styleIds: string[]; family: string }

/** Family and effective style ids of an asset, from its authored YAML. Undefined when the definition is missing or invalid. */
export interface AssetFacts { family: string; styleIds: string[] }

export function assetFacts(set: AuthoredSet, assetId: string): AssetFacts | undefined {
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  return spec ? { family: spec.family, styleIds: stylesFor(set, spec).map((s) => s.fileId) } : undefined;
}

interface Ranked {
  row: DecisionRow; seq: number; tier: ExampleTier; stepMatch: boolean; override: boolean; bytesChanged: boolean; label: string; outcome: "accepted" | "rejected";
}

/**
 * Pages of `limit` that keep up to half accepted and half rejected, filling the remainder from the side with more
 * left, each page in rank order; concatenated they are the one ordering that offset pagination slices.
 */
export function balancedOrder<T extends { outcome: "accepted" | "rejected" }>(ranked: readonly T[], limit: number): T[] {
  const left = [...ranked];
  const out: T[] = [];
  while (left.length > 0) {
    const accepted = left.filter((e) => e.outcome === "accepted");
    const rejected = left.filter((e) => e.outcome === "rejected");
    const reserve = Math.floor(limit / 2);
    const page = new Set<T>([...accepted.slice(0, reserve), ...rejected.slice(0, reserve)]);
    const restA = accepted.slice(reserve);
    const restR = rejected.slice(reserve);
    while (page.size < limit && (restA.length > 0 || restR.length > 0)) {
      const larger = restA.length >= restR.length ? restA : restR;
      const next = larger.shift();
      if (next) page.add(next);
    }
    const taken = left.filter((e) => page.has(e));
    out.push(...taken);
    for (const e of taken) left.splice(left.indexOf(e), 1);
  }
  return out;
}

export async function historyExamples(
  open: OpenProject, set: AuthoredSet, input: { assetId: string; stepId?: StepId; limit: number; offset: number },
): Promise<{ examples: HistoryExample[]; total: number; accepted: number; rejected: number; scope: ExampleScope }> {
  const target = assetFacts(set, input.assetId);
  if (!target && !set.assets.some((a) => a.fileId === input.assetId) && !set.bareAssetDirs.includes(input.assetId)) {
    throw new OperationFailure("NOT_FOUND", `No asset ${input.assetId}`, undefined, [{ label: "List assets", operation: "asset.list" }]);
  }
  const scope: ExampleScope = { assetId: input.assetId, styleIds: target?.styleIds ?? [], family: target?.family ?? "unknown" };

  // The standing decision of an output is its latest row; an override replaces a decision.
  const standing = open.db.query<DecisionRow & { seq: number; cand_label: string; current_hash: string | null }, []>(
    `SELECT d.*, d.rowid AS seq, c.label AS cand_label, o.sha256 AS current_hash FROM review_decisions d
       JOIN candidates c ON c.candidate_id = d.candidate_id
       LEFT JOIN candidate_outputs o ON o.output_id = d.output_id
      WHERE NOT EXISTS (SELECT 1 FROM review_decisions n WHERE n.output_id = d.output_id AND (n.created_at > d.created_at OR (n.created_at = d.created_at AND n.rowid > d.rowid)))`,
  ).all();

  const factsByAsset = new Map<string, AssetFacts | undefined>();
  const ranked: Ranked[] = [];
  for (const row of standing) {
    let facts = factsByAsset.get(row.asset_id);
    if (!factsByAsset.has(row.asset_id)) { facts = assetFacts(set, row.asset_id); factsByAsset.set(row.asset_id, facts); }
    let tier: ExampleTier | undefined;
    if (row.asset_id === input.assetId) tier = "asset";
    else if (facts && target && facts.family === target.family) tier = facts.styleIds.some((s) => target.styleIds.includes(s)) ? "style-family" : "family";
    if (!tier) continue;
    ranked.push({
      row, seq: row.seq, tier, stepMatch: input.stepId !== undefined && row.step_id === input.stepId,
      override: row.kind === "override" && row.actor_type === "human", bytesChanged: row.current_hash !== null && row.current_hash !== row.output_hash,
      label: row.cand_label, outcome: row.decision === "approve" ? "accepted" : "rejected",
    });
  }
  // One example per judged candidate and outcome: a still decided as matted + untouched is one case, not two.
  const bestOutput = new Map<string, Ranked>();
  for (const r of ranked) {
    const key = `${r.row.candidate_id}:${r.outcome}`;
    const known = bestOutput.get(key);
    const roleOf = (e: Ranked): number => (open.db.query<{ role: string }, [string]>("SELECT role FROM candidate_outputs WHERE output_id = ?").get(e.row.output_id)?.role === "matted" ? 0 : 1);
    if (!known || roleOf(r) < roleOf(known)) bestOutput.set(key, r);
  }
  const ordered = [...bestOutput.values()].sort((a, b) =>
    TIER_RANK[a.tier] - TIER_RANK[b.tier]
    || Number(b.stepMatch) - Number(a.stepMatch)
    || Number(b.override) - Number(a.override)
    || (a.row.created_at < b.row.created_at ? 1 : a.row.created_at > b.row.created_at ? -1 : 0)
    || b.seq - a.seq);

  const full = balancedOrder(ordered, input.limit);
  const page = full.slice(input.offset, input.offset + input.limit);
  const examples: HistoryExample[] = [];
  for (const r of page) {
    const reasons = [r.tier === "asset" ? "same asset" : r.tier === "style-family" ? `same style (${scope.styleIds.join(", ")}) and family ${scope.family}` : `same family (${scope.family})`];
    if (r.stepMatch) reasons.push(`same step (${r.row.step_id})`);
    if (r.override) reasons.push("human override of an earlier decision");
    if (r.bytesChanged) reasons.push("decided against bytes that have since changed");
    const siblings = open.db.query<{ candidate_id: string; label: string }, [string, string, string]>(
      "SELECT candidate_id, label FROM candidates WHERE asset_id = ? AND step_id = ? AND candidate_id != ? ORDER BY created_at DESC, rowid DESC LIMIT 6",
    ).all(r.row.asset_id, r.row.step_id, r.row.candidate_id);
    examples.push({
      decisionId: r.row.decision_id, outcome: r.outcome, tier: r.tier, matched: reasons, assetId: r.row.asset_id, stepId: r.row.step_id,
      candidateId: r.row.candidate_id, outputId: r.row.output_id, candidateLabel: r.label, decision: toDecision(r.row), humanOverride: r.override,
      visuals: await outputVisuals(open, r.row.candidate_id, [r.row.output_id]),
      alternatives: siblings.map((s) => ({ candidateId: s.candidate_id, label: s.label, outcome: candidateOutcome(open, s.candidate_id) })),
    });
  }
  return { examples, total: full.length, accepted: ordered.filter((e) => e.outcome === "accepted").length, rejected: ordered.filter((e) => e.outcome === "rejected").length, scope };
}

/** What stands for a candidate: accepted if any of its outputs is, else rejected if any is, else undecided. */
function candidateOutcome(open: OpenProject, candidateId: string): "accepted" | "rejected" | "undecided" {
  const rows = open.db.query<{ decision: "approve" | "reject" }, [string]>(
    `SELECT d.decision FROM review_decisions d WHERE d.candidate_id = ?
        AND NOT EXISTS (SELECT 1 FROM review_decisions n WHERE n.output_id = d.output_id AND (n.created_at > d.created_at OR (n.created_at = d.created_at AND n.rowid > d.rowid)))`,
  ).all(candidateId);
  if (rows.some((r) => r.decision === "approve")) return "accepted";
  return rows.some((r) => r.decision === "reject") ? "rejected" : "undecided";
}
