import { useState } from "react";
import { Link } from "react-router-dom";
import type { Candidate, StepState } from "@brainforge/contracts";
import { Icon } from "../../components/Icon.tsx";
import { ActionLinks } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { STEP_STATE_TEXT, kindLabel } from "../../lib/steps.ts";
import { upstreamPending, plural } from "../../lib/next.ts";
import { OutputArt } from "../../components/OutputArt.tsx";
import { GenerateDialog, type GenerateRequest } from "./GenerateDialog.tsx";
import "./generation.css";

/** The newest candidate with a rejected output: the natural thing to vary. */
function newestRejected(candidates: Candidate[]): Candidate | undefined {
  return candidates
    .filter((candidate) => candidate.approvals.some((approval) => approval.state === "rejected"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The room's stage for a deliverable with nothing to review yet: why generation can or can't start, and how to start it. */
export function GenerateStage({ assetId, step, steps, candidates }: { assetId: string; step: StepState; steps: StepState[]; candidates: Candidate[] }) {
  const [dialog, setDialog] = useState<GenerateRequest | undefined>(undefined);

  const byId = new Map(steps.map((item) => [item.stepId, item]));
  const deps = step.dependsOn;
  const waiting = upstreamPending(step, steps);
  const otherBlockers = step.blockers.filter((blocker) => blocker.code !== "DEPENDENCY_NOT_APPROVED");
  const running = step.counts.activeJobs > 0;
  const canPlan = step.state !== "blocked" && step.state !== "complete" && otherBlockers.length === 0 && !running;
  const rejected = newestRejected(candidates);

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

        <div className="row">
          {canPlan ? (
            <button type="button" className="primary" onClick={() => setDialog(rejected ? { mode: "variation", parentCandidateId: rejected.candidateId } : { mode: "fresh" })}>Plan generation…</button>
          ) : null}
        </div>
        {canPlan && rejected ? <p className="secondary">Starts from {rejected.label}, which you rejected. You can switch to a fresh batch in the plan.</p> : null}
      </section>

      {dialog ? (
        <GenerateDialog
          assetId={assetId} stepId={step.stepId} stepKind={step.kind} branchId={step.branchId} candidates={candidates} initial={dialog}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  );
}
