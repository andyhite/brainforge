import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import type { Candidate, GenerationPlan } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { ActionLinks, Banner, ErrorBanner, formatTime, Modal, NetworkProblem, Seg, Status } from "../../components/ui.tsx";
import { outputUrl, pickOutput } from "./media.tsx";
import { MotionPlanView } from "../processing/MotionPlanView.tsx";
import { paths } from "../../lib/paths.ts";
import { useProject } from "../../lib/use-project.ts";
import "./generation.css";

export interface GenerateRequest { mode: "fresh" | "variation"; parentCandidateId?: string }

export function GenerateDialog({ assetId, stepId = "concept", stepKind, branchId, candidates, initial, onClose, onGrantBudget }: {
  assetId: string; stepId?: string; stepKind?: string; branchId?: string; candidates: Candidate[]; initial: GenerateRequest; onClose: () => void; onGrantBudget: () => void;
}) {
  const stepNoun = stepId === "concept" ? "concepts" : stepId;
  const plan = useMutationOperation("generation.plan");
  const start = useMutationOperation("generation.start");
  const [mode, setMode] = useState(initial.mode);
  const [parentId, setParentId] = useState(initial.parentCandidateId ?? candidates[0]?.candidateId ?? "");
  const animation = stepKind === "animation";
  const [count, setCount] = useState(animation ? 1 : 4);
  const [instructions, setInstructions] = useState("");
  const [planned, setPlanned] = useState<GenerationPlan | undefined>(undefined);
  const [budgetId, setBudgetId] = useState("");
  const [started, setStarted] = useState<{ jobs: number } | undefined>(undefined);

  const project = useProject();
  const projectId = project.data?.project.projectId;
  const parent = candidates.find((candidate) => candidate.candidateId === parentId);
  const parentOutput = parent ? pickOutput(parent, "matted") : undefined;
  const variationMissingParent = mode === "variation" && (!parent || !parentOutput);

  const makePlan = async () => {
    const result = await plan.mutateAsync({
      input: {
        assetId, stepId, mode, count, ...(branchId ? { branchId } : {}),
        ...(mode === "variation" && parent && parentOutput ? { parentCandidateId: parent.candidateId, parentOutputId: parentOutput.outputId } : {}),
        ...(instructions.trim() ? { iterationInstructions: instructions.trim() } : {}),
      },
    });
    if (result.ok) {
      setPlanned(result.data.plan);
      setBudgetId(result.data.plan.budgets[0]?.budgetId ?? "");
      start.reset();
    }
  };

  const begin = async () => {
    if (!planned || !budgetId) return;
    const result = await start.mutateAsync({ input: { planId: planned.planId, planHash: planned.planHash, budgetId } });
    if (result.ok) setStarted({ jobs: result.data.jobs.length });
  };

  const blocked = (planned?.blockers.length ?? 0) > 0;
  const noBudget = planned !== undefined && planned.budgets.length === 0;
  const selectedBudget = planned?.budgets.find((budget) => budget.budgetId === budgetId);
  const startReason = !planned ? "Plan first." : blocked ? "Resolve the blockers above." : noBudget ? "No budget covers this plan." : !budgetId ? "Choose a budget." : undefined;

  return (
    <Modal open wide onOpenChange={(open) => { if (!open) onClose(); }} title={`Plan generation: ${stepNoun}`} description="You see the exact plan before anything is submitted. Nothing starts until you press Start generation.">
      {started ? (
        <div className="stack">
          <Banner tone="ok" title="Generation started">
            {started.jobs} {started.jobs === 1 ? "job is" : "jobs are"} queued. Each candidate appears in the candidate strip in this room as it finishes. Follow progress in <Link to={paths.activity()}>Activity</Link>.
          </Banner>
          <div className="row end"><button type="button" className="primary" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <div className="stack">
          {planned ? null : (
            <form onSubmit={(event) => { event.preventDefault(); void makePlan(); }} className="stack">
              <div className="field">
                <span className="label" id="gen-mode-label">What to make</span>
                <Seg label="What to make" value={mode} options={[
                  { value: "fresh", label: "Fresh batch", title: "New candidates from the asset definition" },
                  { value: "variation", label: animation ? "Variation (not for motion)" : "Variation of a candidate", title: animation ? "Variations aren’t available for motion" : candidates.length === 0 ? "No candidate to vary yet" : undefined },
                ]} onChange={(next) => { if (next === "fresh" || (candidates.length > 0 && !animation)) setMode(next); }} />
              </div>
              {mode === "variation" ? (
                <div className="field">
                  <span className="label" id="gen-parent-label">Start from</span>
                  <ul className="gen-parents" aria-labelledby="gen-parent-label">
                    {candidates.map((candidate) => {
                      const output = pickOutput(candidate, "matted");
                      return (
                        <li key={candidate.candidateId}>
                          <button type="button" aria-pressed={candidate.candidateId === parentId} onClick={() => setParentId(candidate.candidateId)}>
                            <span className="art checker">{output && projectId ? <img src={outputUrl(projectId, output.fileId, 128)} alt="" /> : null}</span>
                            <span>{candidate.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="hint">Continues from this candidate’s transparent image.</div>
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="gen-count">How many candidates</label>
                <input id="gen-count" type="number" min={1} max={8} value={count} onChange={(event) => setCount(Number(event.target.value))} />
                <div className="hint">{animation ? "Each candidate is one run with the same guides and motion but a different random seed. " : "Each one counts against your budget. "}The plan shows the limit.</div>
              </div>
              <div className="field">
                <label htmlFor="gen-instr">Instructions for this run (optional)</label>
                <textarea id="gen-instr" rows={3} maxLength={4000} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
                <div className="hint">Used for this run only. They never change the asset definition.</div>
              </div>
              {plan.error ? <NetworkProblem error={plan.error} /> : null}
              {plan.data && !plan.data.ok ? <ErrorBanner error={plan.data.error} /> : null}
              <div className="row end">
                <button type="button" className="ghost" onClick={onClose}>Cancel</button>
                <button type="submit" className="primary" disabled={plan.isPending || variationMissingParent || count < 1 || count > 8}>{plan.isPending ? "Planning…" : "Plan"}</button>
              </div>
            </form>
          )}
          {planned ? (
            <>
              <PlanView plan={planned} candidates={candidates} />
              {blocked ? (
                <Banner tone="bad" title="This plan can’t start yet">
                  <ul className="plan-blockers">
                    {planned.blockers.map((blocker) => (
                      <li key={blocker.code}>
                        {blocker.message}
                        {blocker.recoveryActions.length > 0 ? <div className="row"><ActionLinks actions={blocker.recoveryActions} /></div> : null}
                      </li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              <section aria-label="Budget" className="plan-budget">
                <h3>Budget</h3>
                {noBudget ? (
                  <Banner tone="warn" title="No budget covers this plan" actions={<button type="button" onClick={() => { onClose(); onGrantBudget(); }}>Grant a budget…</button>}>
                    Generation only starts under a budget you grant. Nothing was submitted.
                  </Banner>
                ) : (
                  <div className="field">
                    <label htmlFor="gen-budget">Spend from</label>
                    <select id="gen-budget" value={budgetId} onChange={(event) => setBudgetId(event.target.value)}>
                      {planned.budgets.map((budget) => (
                        <option key={budget.budgetId} value={budget.budgetId}>
                          {budget.remainingStarts} {budget.remainingStarts === 1 ? "start" : "starts"} and {budget.remainingCandidateSubmissions} candidates left · expires {formatTime(budget.expiresAt)}
                        </option>
                      ))}
                    </select>
                    {selectedBudget && selectedBudget.remainingCandidateSubmissions < planned.count ? <div className="hint" role="alert">Only {selectedBudget.remainingCandidateSubmissions} candidates remain; this plan needs {planned.count}.</div> : null}
                  </div>
                )}
              </section>
              {start.error ? <NetworkProblem error={start.error} /> : null}
              {start.data && !start.data.ok ? <ErrorBanner error={start.data.error} /> : null}
              {startReason ? <p className="secondary" role="status">Can’t start: {startReason}</p> : null}
              <div className="row end">
                <button type="button" className="ghost" onClick={() => { setPlanned(undefined); plan.reset(); start.reset(); }}>Change plan</button>
                <button type="button" className="ghost" onClick={onClose}>Cancel</button>
                <button type="button" className="primary" disabled={startReason !== undefined || start.isPending} onClick={() => void begin()}>
                  {start.isPending ? "Starting…" : "Start generation"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function PlanView({ plan, candidates }: { plan: GenerationPlan; candidates: Candidate[] }) {
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const dimensions = plan.submissions.flatMap((submission) => {
    const { width, height } = submission.values;
    return typeof width === "number" && typeof height === "number" ? [`${width}×${height}`] : [];
  })[0];
  const parentLabel = plan.parentCandidateId ? candidates.find((candidate) => candidate.candidateId === plan.parentCandidateId)?.label : undefined;
  return (
    <div className="plan stack">
      <dl className="kv" aria-label="Plan summary">
        <dt>Makes</dt>
        <dd>
          {plan.count} {plan.count === 1 ? "candidate" : "candidates"}{dimensions ? ` at ${dimensions} px` : ""}
          {plan.mode === "variation" ? ` · a variation of ${parentLabel ?? "the chosen candidate"}` : " · fresh from the definition"}
        </dd>
        <dt>Runs on</dt><dd>{plan.execution.computeLocation}{plan.preflight.comfyHost ? <span className="secondary"> ({plan.preflight.comfyHost})</span> : null}</dd>
        <dt>Cost</dt><dd>{plan.execution.costDescription}</dd>
        <dt>Generator</dt>
        <dd>
          {plan.preflight.ok ? <Status tone="ok">Nodes and models present</Status> : <Status tone="bad">Not ready</Status>}
          {plan.preflight.missingNodes.length > 0 ? <div>Missing nodes: <span className="mono">{plan.preflight.missingNodes.join(", ")}</span></div> : null}
          {plan.preflight.missingModels.length > 0 ? <div>Missing models: <span className="mono">{plan.preflight.missingModels.join(", ")}</span></div> : null}
        </dd>
        <dt>Limits</dt><dd>Up to {plan.limits.maxBatchCandidates} candidates per start · {plan.limits.maxConcurrentGenerations} at a time · {plan.limits.maxAttemptsPerStep} starts per deliverable</dd>
      </dl>
      {plan.notes.length > 0 ? <ul className="plan-notes">{plan.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
      {plan.motion && projectId ? <MotionPlanView motion={plan.motion} projectId={projectId} /> : null}
      {plan.inputs.references.length > 0 && projectId ? (
        <section aria-label="References used">
          <h3>References used</h3>
          <ul className="plan-refs">
            {plan.inputs.references.map((reference) => (
              <li key={`${reference.role}-${reference.id}`}>
                <div className="art checker"><img src={outputUrl(projectId, reference.id, 240)} alt={`Reference for role ${reference.role}`} /></div>
                <div className="secondary">{reference.role}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Prompt">
        <h3>Prompt</h3>
        <details>
          <summary>Read the exact prompt</summary>
          <pre className="plan-prompt">{plan.prompt}</pre>
          <h4>Where each part comes from ({plan.promptSources.length})</h4>
          <ul>
            {plan.promptSources.map((part, index) => (
              <li key={`${part.label}-${index}`}><strong>{part.label}</strong> <span className="mono secondary">{part.source}</span><div>{part.text}</div></li>
            ))}
          </ul>
        </details>
        {plan.iterationInstructions ? <p className="secondary">Your instructions for this run only: {plan.iterationInstructions}</p> : null}
      </section>
      <details>
        <summary>Technical details</summary>
        <dl className="kv">
          <dt>Workflow</dt><dd className="mono">{plan.workflow.id} v{plan.workflow.version} <span className="secondary">graph {plan.workflow.graphHash.slice(0, 12)}</span></dd>
          <dt>Plan hash</dt><dd className="mono">{plan.planHash.slice(0, 16)}…</dd>
          <dt>External services</dt><dd>{plan.execution.externalServices.length > 0 ? plan.execution.externalServices.join(", ") : "none"}</dd>
          <dt>Credentials</dt><dd>{plan.execution.credentialKeys.length > 0 ? plan.execution.credentialKeys.join(", ") : "none"}</dd>
          {Object.entries(plan.inputs.specHashes).map(([file, hash]) => <Fragment key={file}><dt className="mono">{file}</dt><dd className="mono">{hash.slice(0, 16)}…</dd></Fragment>)}
          {plan.inputs.references.map((reference) => <Fragment key={reference.id}><dt>Reference {reference.role}</dt><dd className="mono">{reference.id} · {reference.sha256.slice(0, 16)}…</dd></Fragment>)}
        </dl>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Submissions and seeds</caption>
            <thead><tr><th>Label</th><th>Seed</th><th>Values</th></tr></thead>
            <tbody>
              {plan.submissions.map((submission) => (
                <tr key={submission.submissionId}>
                  <td>{submission.label}</td><td className="mono">{submission.seed}</td>
                  <td className="mono">{Object.entries(submission.values).filter(([key]) => key !== "prompt").map(([key, value]) => `${key}=${String(value)}`).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
