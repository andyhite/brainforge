import { useState } from "react";
import { Link } from "react-router-dom";
import type { Candidate, StepState } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { ActionLinks, formatTime, Modal, timeAgo } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { STEP_STATE_TEXT, kindLabel } from "../../lib/steps.ts";
import { upstreamPending } from "../../lib/next.ts";
import { BudgetPanel } from "./BudgetPanel.tsx";
import { OutputArt } from "../../components/OutputArt.tsx";
import { GenerateDialog, type GenerateRequest } from "./GenerateDialog.tsx";
import "./generation.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The newest candidate with a rejected output: the natural thing to vary. */
function newestRejected(candidates: Candidate[]): Candidate | undefined {
  return candidates
    .filter((candidate) => candidate.approvals.some((approval) => approval.state === "rejected"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The room's stage for a deliverable with nothing to review yet: why generation can or can't start, and how to start it. */
export function GenerateStage({ assetId, step, steps, candidates }: { assetId: string; step: StepState; steps: StepState[]; candidates: Candidate[] }) {
  const [dialog, setDialog] = useState<GenerateRequest | undefined>(undefined);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const budgets = useOperation("budget.list", { assetId, includeInactive: true });

  const byId = new Map(steps.map((item) => [item.stepId, item]));
  const deps = step.dependsOn;
  const waiting = upstreamPending(step, steps);
  const otherBlockers = step.blockers.filter((blocker) => blocker.code !== "DEPENDENCY_NOT_APPROVED");
  const running = step.counts.activeJobs > 0;
  const canPlan = step.state !== "blocked" && step.state !== "complete" && otherBlockers.length === 0 && !running;
  const rejected = newestRejected(candidates);

  const mine = budgets.data?.ok ? budgets.data.data.budgets.filter((budget) => budget.stepId === step.stepId) : undefined;
  const active = mine?.filter((budget) => budget.status === "active").sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
  const latest = mine?.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const name = kindLabel(step.stepId);
  const headline = running ? "Generating…" : canPlan ? "Ready to generate" : "Can’t generate yet";

  return (
    <div className="gen-stage">
      <section className="gen-cell" aria-labelledby="gen-stage-title">
        <h2 id="gen-stage-title">{headline}</h2>

        {running ? (
          <p role="status">{plural(step.counts.activeJobs, "job")} running. <Link to={paths.activity()}>Follow progress in Activity</Link>. Results appear here as they finish.</p>
        ) : null}

        {deps.length > 0 ? (
          <div className="gen-block">
            <h3>{waiting.length > 0 ? "Needs these first" : "Starts from"}</h3>
            <ul className="gen-deps" aria-label="Upstream deliverables">
              {deps.map((id) => {
                const dep = byId.get(id);
                const done = dep?.state === "complete";
                const sel = dep?.selected;
                return (
                  <li key={id}>
                    <Link className="gen-dep" to={paths.step(assetId, id, { branch: step.branchId })}>
                      {sel ? <OutputArt candidateId={sel.candidateId} outputId={sel.outputId} max={160} alt="" className="gen-dep-art" /> : <div className="art empty gen-dep-art" aria-hidden="true" />}
                      <span className="gen-dep-name">{kindLabel(id)}</span>
                      <span className="secondary"><Icon name={done ? "ok" : "clock"} /> {dep ? (done ? "Approved" : STEP_STATE_TEXT[dep.state]) : ""}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {waiting.length > 0 ? <p className="secondary">Approve {waiting.length === 1 ? "it" : "them"} first; {name.toLowerCase()} is generated from the approved result.</p> : null}
          </div>
        ) : null}

        {otherBlockers.length > 0 ? (
          <ul className="gen-blockers" aria-label="What is in the way">
            {otherBlockers.map((blocker) => (
              <li key={blocker.code}>
                <Icon name="warn" />
                <div>
                  <div>{blocker.message}</div>
                  {blocker.recoveryActions.length > 0 ? <div className="row"><ActionLinks actions={blocker.recoveryActions} /></div> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="gen-block">
          {!mine ? (
            <p className="secondary" role="status">Checking budget…</p>
          ) : active ? (
            <p>
              {active.usedStarts} of {plural(active.maxStarts, "start")} used · {plural(Math.max(0, active.maxCandidateSubmissions - active.usedCandidateSubmissions), "candidate")} left · expires{" "}
              <time dateTime={active.expiresAt} title={formatTime(active.expiresAt)}>{timeAgo(active.expiresAt)}</time>
            </p>
          ) : latest ? (
            <p>
              {latest.status === "exhausted" ? "The last budget is used up" : latest.status === "revoked" ? "The last budget was revoked" : "The last budget expired"}{" "}
              <time dateTime={latest.expiresAt} title={formatTime(latest.expiresAt)}>({timeAgo(latest.expiresAt)})</time>. Generation only starts under a budget you grant.
            </p>
          ) : (
            <p>No budget yet — generation only starts under a budget you grant.</p>
          )}
        </div>

        <div className="row">
          {canPlan ? (
            <button type="button" className="primary" onClick={() => setDialog(rejected ? { mode: "variation", parentCandidateId: rejected.candidateId } : { mode: "fresh" })}>Plan generation…</button>
          ) : null}
          <button type="button" onClick={() => setBudgetOpen(true)}>Budget…</button>
        </div>
        {canPlan && rejected ? <p className="secondary">Starts from {rejected.label}, which you rejected. You can switch to a fresh batch in the plan.</p> : null}
      </section>

      {dialog ? (
        <GenerateDialog
          assetId={assetId} stepId={step.stepId} stepKind={step.kind} branchId={step.branchId} candidates={candidates} initial={dialog}
          onClose={() => setDialog(undefined)} onGrantBudget={() => { setGrantOpen(true); setBudgetOpen(true); }}
        />
      ) : null}
      {budgetOpen ? (
        <Modal open wide onOpenChange={(open) => { if (!open) { setBudgetOpen(false); setGrantOpen(false); } }} title={`Budget for ${name.toLowerCase()}`} description="The limit you set on generating this deliverable.">
          <BudgetPanel assetId={assetId} stepId={step.stepId} grantOpen={grantOpen} onGrantOpen={setGrantOpen} />
        </Modal>
      ) : null}
    </div>
  );
}
