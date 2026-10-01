import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveIn, sha256 } from "@brainforge/storage";
import { discoverAuthored } from "../authored.ts";
import { authoredSetFor } from "../branches/basis.ts";
import { captureBasis, createBranch, lockInputs } from "../branches/create.ts";
import { compareBranches } from "../branches/compare.ts";
import { planBranch } from "../branches/plan.ts";
import { branchRow, toBranch, type BranchRow } from "../branches/records.ts";
import { policyView } from "../policy.ts";
import { candidateRow, outputRows } from "../review/records.ts";
import { stepRequirementsHash } from "../review/requirements.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";

export const branchHandlers: HandlerMap = {
  "concept.lock": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const cand = candidateRow(open.db, input.candidateId);
    if (cand.asset_id !== input.assetId) throw new OperationFailure("INVALID_INPUT", `Candidate ${cand.candidate_id} belongs to ${cand.asset_id}, not ${input.assetId}`);
    if (cand.step_id !== "concept") {
      throw new OperationFailure("INVALID_INPUT", `Candidate ${cand.candidate_id} is a ${cand.step_id} candidate; only a concept candidate can be locked`, undefined, [
        { label: "List concept candidates", operation: "candidate.list", input: { assetId: input.assetId, stepId: "concept" } },
      ]);
    }
    const output = outputRows(open.db, cand.candidate_id).find((o) => o.output_id === input.outputId);
    if (!output) throw new OperationFailure("NOT_FOUND", `Candidate ${cand.candidate_id} has no output ${input.outputId}`, undefined, [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId: cand.candidate_id } }]);

    if (context.actorType !== "human") {
      const view = await policyView(open);
      if (view.effective.conceptLock !== "agent") {
        if (view.requested.conceptLock === "agent") {
          throw new OperationFailure("POLICY_PENDING", "Policy requests that agents may lock concepts, but a human has not confirmed that change. Ask the user to confirm it in Settings.", { requestedPolicyHash: view.requestedPolicyHash });
        }
        throw new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", `Only the user may lock a concept under the current approval policy (conceptLock: ${view.effective.conceptLock}). Tell the user which candidate and output you recommend and ask them to lock it.`);
      }
    }

    const abs = await resolveIn(open.root, output.path).catch(() => undefined);
    const bytes = abs ? await readFile(abs).catch(() => undefined) : undefined;
    if (!bytes || sha256(bytes) !== output.sha256) {
      throw new OperationFailure("OUTPUT_MISSING", `Output ${output.output_id} is missing or no longer matches its recorded hash, so it cannot be locked`, { outputId: output.output_id, path: output.path });
    }

    const live = await discoverAuthored(open.root);
    const asset = live.assets.find((a) => a.fileId === input.assetId);
    if (!asset?.valid) {
      throw new OperationFailure("STEP_BLOCKED", `${asset?.path ?? `brainforge/assets/${input.assetId}/asset.yaml`} is missing or invalid, so a concept cannot be locked against it`, { problems: asset?.problems ?? [] }, [
        { label: "Read the asset definition", operation: "spec.read", input: { path: asset?.path ?? `brainforge/assets/${input.assetId}/asset.yaml` } },
      ]);
    }
    // `saved` locks the concept against the authored versions it was generated from; `current` against the files now.
    const inputs = lockInputs(open, live, cand, input.inputMode);
    const requirementsHash = stepRequirementsHash(open, inputs.set, input.assetId, "concept");
    const now = new Date().toISOString();
    const branchId = `br_${randomBytes(6).toString("hex")}`;
    const { value: row, revision } = open.transact(() => {
      const n = open.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM branches WHERE asset_id = ?").get(input.assetId)?.n ?? 0;
      const name = input.name ?? `Branch ${n + 1}`;
      open.db.query(
        `INSERT INTO branches (branch_id, asset_id, name, concept_candidate_id, concept_output_id, concept_output_hash, requirements_hash, locked_by, locked_by_type, lock_reason, locked_at,
                               source_candidate_id, source_output_id, input_mode, spec_hashes_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(branchId, input.assetId, name, cand.candidate_id, output.output_id, output.sha256, requirementsHash, context.actorId, context.actorType, input.reason ?? null, now,
        cand.candidate_id, output.output_id, input.inputMode, JSON.stringify(inputs.specHashes));
      open.db.query("UPDATE branches SET basis_json = ? WHERE branch_id = ?").run(JSON.stringify(captureBasis(open, live, input.assetId, branchId)), branchId);
      return branchRow(open.db, branchId);
    }, [{ type: "branch.created", data: { branchId, assetId: input.assetId, candidateId: cand.candidate_id, outputId: output.output_id, lockedByType: context.actorType, inputMode: input.inputMode }, actorId: context.actorId }]);
    return {
      data: { branch: toBranch(open.db, row) }, revision,
      nextActions: [{ label: "See the pipeline for this branch", operation: "step.list", input: { assetId: input.assetId, branchId } }],
    };
  },

  "branch.list": async ({ input, project }) => {
    const { db } = requireOpen(project);
    const rows = db.query<BranchRow, [string]>("SELECT * FROM branches WHERE asset_id = ? ORDER BY locked_at, rowid").all(input.assetId);
    return { data: { branches: rows.map((r) => toBranch(db, r)) } };
  },

  "branch.plan": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const { plan } = await planBranch(open, context, input);
    const blocked = plan.blockers.length > 0;
    return {
      data: { plan },
      nextActions: blocked ? plan.blockers.flatMap((b) => b.recoveryActions)
        : plan.authorization.operation === "concept.lock"
          ? [{ label: `Lock this concept${plan.authorization.allowed ? "" : " (needs the user)"}`, operation: "concept.lock", input: { assetId: plan.assetId, candidateId: plan.source.candidateId, outputId: plan.source.outputId, inputMode: plan.inputMode } }]
          : [{ label: plan.kind === "rebase" ? "Create the rebased branch" : "Create the branch", operation: "branch.create", input: { candidateId: plan.source.candidateId, outputId: plan.source.outputId, inputMode: plan.inputMode, planHash: plan.planHash } }],
    };
  },

  "branch.create": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const { branchId, revision } = await open.mutate(() => createBranch(open, context, input));
    return {
      data: { branch: toBranch(open.db, branchRow(open.db, branchId)) }, revision,
      nextActions: [{ label: "See the pipeline for this branch", operation: "step.list", input: { assetId: branchRow(open.db, branchId).asset_id, branchId } }],
    };
  },

  "branch.compare": async ({ input, project }) => {
    const open = requireOpen(project);
    return { data: { comparison: await compareBranches(open, input) } };
  },

  "branch.select": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const branch = branchRow(open.db, input.branchId);
    if (branch.asset_id !== input.assetId) throw new OperationFailure("INVALID_INPUT", `Branch ${branch.branch_id} belongs to ${branch.asset_id}, not ${input.assetId}`, undefined, [{ label: "List branches", operation: "branch.list", input: { assetId: input.assetId } }]);
    const { revision } = open.transact(() => {
      open.db.query(
        `INSERT INTO current_branches (asset_id, branch_id, selected_by, selected_at, reason) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET branch_id = excluded.branch_id, selected_by = excluded.selected_by, selected_at = excluded.selected_at, reason = excluded.reason`,
      ).run(input.assetId, branch.branch_id, context.actorId, new Date().toISOString(), input.reason ?? null);
    }, [{ type: "branch.selected", data: { assetId: input.assetId, branchId: branch.branch_id }, actorId: context.actorId }]);
    const rows = open.db.query<BranchRow, [string]>("SELECT * FROM branches WHERE asset_id = ? ORDER BY locked_at, rowid").all(input.assetId);
    return {
      data: { branches: rows.map((r) => toBranch(open.db, r)) }, revision,
      nextActions: [{ label: "See the pipeline for the current branch", operation: "step.list", input: { assetId: input.assetId } }],
    };
  },


  "candidate.select": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const branch = branchRow(open.db, input.branchId);
    if (input.deliverableId === "concept") {
      throw new OperationFailure("INVALID_INPUT", "The concept is chosen with concept.lock, not candidate.select", undefined, [{ label: "Lock a concept", operation: "concept.lock" }]);
    }
    const set = authoredSetFor(open.db, await discoverAuthored(open.root), branch.branch_id);
    const spec = set.assets.find((a) => a.fileId === branch.asset_id)?.spec;
    if (!spec?.deliverables.some((d) => d.id === input.deliverableId)) {
      throw new OperationFailure("INVALID_INPUT", `Asset ${branch.asset_id} has no deliverable ${input.deliverableId}`, { deliverables: spec?.deliverables.map((d) => d.id) ?? [] });
    }
    const cand = candidateRow(open.db, input.candidateId);
    if (cand.asset_id !== branch.asset_id || cand.step_id !== input.deliverableId || cand.branch_id !== branch.branch_id) {
      throw new OperationFailure("INVALID_INPUT", `Candidate ${cand.candidate_id} was not generated for ${input.deliverableId} on branch ${branch.branch_id}`, {
        candidate: { assetId: cand.asset_id, stepId: cand.step_id, branchId: cand.branch_id },
      });
    }
    if (input.outputId !== undefined && !outputRows(open.db, cand.candidate_id).some((o) => o.output_id === input.outputId)) {
      throw new OperationFailure("NOT_FOUND", `Candidate ${cand.candidate_id} has no output ${input.outputId}`);
    }
    const { revision } = open.transact(() => {
      open.db.query(
        `INSERT INTO branch_selections (branch_id, deliverable_id, candidate_id, output_id, selected_by, selected_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (branch_id, deliverable_id) DO UPDATE SET candidate_id = excluded.candidate_id, output_id = excluded.output_id, selected_by = excluded.selected_by, selected_at = excluded.selected_at`,
      ).run(branch.branch_id, input.deliverableId, cand.candidate_id, input.outputId ?? null, context.actorId, new Date().toISOString());
    }, [{ type: "candidate.changed", data: { candidateId: cand.candidate_id, branchId: branch.branch_id, deliverableId: input.deliverableId, selected: true }, actorId: context.actorId }]);
    return {
      data: { branch: toBranch(open.db, branch) }, revision,
      nextActions: [{ label: "Review the selected output", operation: "review.material", input: { candidateId: cand.candidate_id } }],
    };
  },
};
