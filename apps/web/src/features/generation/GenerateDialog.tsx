import { Fragment, useState } from "react";
import type { Candidate, GenerationPlan } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, formatTime, Modal, NetworkProblem, Status } from "../../components/ui.tsx";
import { pickOutput } from "./media.tsx";

export interface GenerateRequest { mode: "fresh" | "variation"; parentCandidateId?: string }

export function GenerateDialog({ assetId, candidates, initial, onClose, onGrantBudget }: {
  assetId: string; candidates: Candidate[]; initial: GenerateRequest; onClose: () => void; onGrantBudget: () => void;
}) {
  const plan = useMutationOperation("generation.plan");
  const start = useMutationOperation("generation.start");
  const [mode, setMode] = useState(initial.mode);
  const [parentId, setParentId] = useState(initial.parentCandidateId ?? candidates[0]?.candidateId ?? "");
  const [count, setCount] = useState(4);
  const [instructions, setInstructions] = useState("");
  const [planned, setPlanned] = useState<GenerationPlan | undefined>(undefined);
  const [budgetId, setBudgetId] = useState("");
  const [started, setStarted] = useState<{ jobs: number } | undefined>(undefined);

  const parent = candidates.find((candidate) => candidate.candidateId === parentId);
  const parentOutput = parent ? pickOutput(parent, "matted") : undefined;
  const variationMissingParent = mode === "variation" && (!parent || !parentOutput);

  const makePlan = async () => {
    const result = await plan.mutateAsync({
      input: {
        assetId, stepId: "concept", mode, count,
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
  const startReason = !planned ? "Plan first." : blocked ? "Resolve the blockers above." : noBudget ? "No active budget covers this plan." : !budgetId ? "Choose a budget." : undefined;

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={mode === "variation" ? "Generate variations" : "Generate concepts"} description="You will see the exact plan before anything is submitted.">
      {started ? (
        <div className="stack">
          <Banner tone="ok" title="Generation started">{started.jobs} {started.jobs === 1 ? "job is" : "jobs are"} queued. Candidates appear in the grid as each finishes; progress is on the Jobs page.</Banner>
          <div className="row end"><button type="button" className="primary" onClick={onClose}>Close</button></div>
        </div>
      ) : (
        <div className="stack">
          {planned ? null : (
            <form onSubmit={(event) => { event.preventDefault(); void makePlan(); }} className="stack">
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontSize: 13, fontWeight: 600 }}>Mode</legend>
                <div className="row">
                  <label><input type="radio" name="gen-mode" checked={mode === "fresh"} onChange={() => setMode("fresh")} />Fresh batch from the asset definition</label>
                  <label><input type="radio" name="gen-mode" checked={mode === "variation"} disabled={candidates.length === 0} onChange={() => setMode("variation")} />Variation of a candidate</label>
                </div>
              </fieldset>
              {mode === "variation" ? (
                <div className="field">
                  <label htmlFor="gen-parent">Base candidate</label>
                  <select id="gen-parent" value={parentId} onChange={(event) => setParentId(event.target.value)}>
                    {candidates.map((candidate) => <option key={candidate.candidateId} value={candidate.candidateId}>{candidate.label}{candidate.seed !== undefined ? ` · seed ${candidate.seed}` : ""}</option>)}
                  </select>
                  <div className="hint">Continues from this candidate's matted output through the identity-edit workflow.</div>
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="gen-count">Candidates</label>
                <input id="gen-count" type="number" min={1} max={8} value={count} onChange={(event) => setCount(Number(event.target.value))} />
                <div className="hint">One start submits this many candidates to the GPU. The plan shows the batch limit.</div>
              </div>
              <div className="field">
                <label htmlFor="gen-instr">Iteration instructions (optional)</label>
                <textarea id="gen-instr" rows={3} maxLength={4000} value={instructions} onChange={(event) => setInstructions(event.target.value)} style={{ width: "100%" }} />
                <div className="hint">Affect this run only; they never become authored requirements.</div>
              </div>
              {plan.error ? <NetworkProblem error={plan.error} /> : null}
              {plan.data && !plan.data.ok ? <ErrorBanner error={plan.data.error} /> : null}
              <div className="row end">
                <button type="button" onClick={onClose}>Cancel</button>
                <button type="submit" className="primary" disabled={plan.isPending || variationMissingParent || count < 1 || count > 8}>{plan.isPending ? "Planning…" : "Show plan"}</button>
              </div>
            </form>
          )}
          {planned ? (
            <>
              <PlanView plan={planned} />
              {blocked ? (
                <Banner tone="bad" title="This plan cannot start">
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {planned.blockers.map((blocker) => (
                      <li key={blocker.code}>
                        {blocker.message}
                        {blocker.recoveryActions.length > 0 ? <ul>{blocker.recoveryActions.map((action) => <li key={action.label}>{action.label}</li>)}</ul> : null}
                      </li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              <section aria-label="Budget">
                <h3>Budget</h3>
                {noBudget ? (
                  <Banner tone="warn" title="No active budget" actions={<button type="button" onClick={() => { onClose(); onGrantBudget(); }}>Grant a budget</button>}>
                    Starting spends GPU time, so it needs a budget you granted. Nothing was submitted.
                  </Banner>
                ) : (
                  <div className="field">
                    <label htmlFor="gen-budget">Spend from</label>
                    <select id="gen-budget" value={budgetId} onChange={(event) => setBudgetId(event.target.value)}>
                      {planned.budgets.map((budget) => (
                        <option key={budget.budgetId} value={budget.budgetId}>
                          {budget.remainingStarts} starts and {budget.remainingCandidateSubmissions} submissions left · expires {formatTime(budget.expiresAt)}
                        </option>
                      ))}
                    </select>
                    {selectedBudget && selectedBudget.remainingCandidateSubmissions < planned.count ? <div className="hint" role="alert">Only {selectedBudget.remainingCandidateSubmissions} submissions remain; this plan needs {planned.count}.</div> : null}
                  </div>
                )}
              </section>
              {start.error ? <NetworkProblem error={start.error} /> : null}
              {start.data && !start.data.ok ? <ErrorBanner error={start.data.error} /> : null}
              {startReason ? <p className="secondary" role="status">Cannot start: {startReason}</p> : null}
              <div className="row end">
                <button type="button" onClick={() => { setPlanned(undefined); plan.reset(); start.reset(); }}>Edit</button>
                <button type="button" onClick={onClose}>Cancel</button>
                <button type="button" className="primary" disabled={startReason !== undefined || start.isPending} onClick={() => void begin()}>
                  {start.isPending ? "Starting…" : `Start ${planned.count} ${planned.count === 1 ? "candidate" : "candidates"}`}
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function PlanView({ plan }: { plan: GenerationPlan }) {
  return (
    <div className="stack">
      <dl className="kv" aria-label="Plan summary">
        <dt>Mode</dt><dd>{plan.mode}{plan.parentCandidateId ? ` from ${plan.parentCandidateId}` : ""} · {plan.count} {plan.count === 1 ? "candidate" : "candidates"}</dd>
        <dt>Workflow</dt><dd className="mono">{plan.workflow.id} v{plan.workflow.version} <span className="secondary">graph {plan.workflow.graphHash.slice(0, 12)}</span></dd>
        <dt>Plan hash</dt><dd className="mono">{plan.planHash.slice(0, 16)}…</dd>
        <dt>Runs on</dt><dd>{plan.execution.computeLocation}{plan.preflight.comfyHost ? <span className="secondary"> ({plan.preflight.comfyHost})</span> : null}</dd>
        <dt>Cost</dt><dd>{plan.execution.costDescription}</dd>
        <dt>External services</dt><dd>{plan.execution.externalServices.length > 0 ? plan.execution.externalServices.join(", ") : "none"}</dd>
        <dt>Credentials</dt><dd>{plan.execution.credentialKeys.length > 0 ? plan.execution.credentialKeys.join(", ") : "none"}</dd>
        <dt>Preflight</dt>
        <dd>
          {plan.preflight.ok ? <Status tone="ok">Nodes and models present</Status> : <Status tone="bad">Not ready</Status>}
          {plan.preflight.missingNodes.length > 0 ? <div>Missing nodes: <span className="mono">{plan.preflight.missingNodes.join(", ")}</span></div> : null}
          {plan.preflight.missingModels.length > 0 ? <div>Missing models: <span className="mono">{plan.preflight.missingModels.join(", ")}</span></div> : null}
        </dd>
        <dt>Limits</dt><dd>up to {plan.limits.maxBatchCandidates} candidates per start · {plan.limits.maxConcurrentGenerations} at a time · {plan.limits.maxAttemptsPerStep} starts per step</dd>
      </dl>
      <section aria-label="Prompt">
        <h3>Exact prompt</h3>
        <pre className="plan-prompt">{plan.prompt}</pre>
        <details>
          <summary>Where each part comes from ({plan.promptSources.length})</summary>
          <ul>
            {plan.promptSources.map((part, index) => (
              <li key={`${part.label}-${index}`}><strong>{part.label}</strong> <span className="mono secondary">{part.source}</span><div>{part.text}</div></li>
            ))}
          </ul>
        </details>
        {plan.iterationInstructions ? <p className="secondary">Iteration instructions (this run only): {plan.iterationInstructions}</p> : null}
      </section>
      <section aria-label="Seeds">
        <h3>Submissions and seeds</h3>
        <div className="table-wrap">
          <table>
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
      </section>
      <details>
        <summary>Pinned inputs</summary>
        <dl className="kv">
          {Object.entries(plan.inputs.specHashes).map(([file, hash]) => <Fragment key={file}><dt className="mono">{file}</dt><dd className="mono">{hash.slice(0, 16)}…</dd></Fragment>)}
          {plan.inputs.references.map((reference) => <Fragment key={reference.id}><dt>Reference {reference.role}</dt><dd className="mono">{reference.id} · {reference.sha256.slice(0, 16)}…</dd></Fragment>)}
        </dl>
      </details>
    </div>
  );
}
