import type { UseQueryResult } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import type { HistoryExample, JudgmentSummary } from "@brainforge/contracts";
import { fileUrl, useOperation, type Envelope } from "../../api/hooks.ts";
import type { NetworkError } from "../../api/client.ts";
import { ErrorBanner, formatTime, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { PreferencesPanel } from "./PreferencesPanel.tsx";

const PAGE = 8;
const TIER: Record<HistoryExample["tier"], string> = {
  asset: "Same asset",
  "style-family": "Same style and family",
  family: "Same family",
};

export function HistoryPage() {
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const assets = project.data?.assets ?? [];
  const assetId = params.get("asset") ?? assets[0]?.assetId ?? "";
  const stepId = params.get("step") ?? "";
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);

  const set = (changes: Record<string, string | undefined>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, value);
    }
    return next;
  });

  const steps = useOperation("step.list", { assetId }, { enabled: assetId !== "" });
  const stepIds = steps.data?.ok ? steps.data.data.steps.map((s) => s.stepId) : [];
  const examples = useOperation("history.examples", { assetId, limit: PAGE, offset, ...(stepId ? { stepId } : {}) }, { enabled: assetId !== "" });
  const judgments = useOperation("history.judgments", assetId ? { assetId } : {}, { enabled: project.root !== undefined });

  if (project.root === undefined) return <><PageHeader title="History" /><p>No project selected. <Link to="/projects/open">Open a project</Link>.</p></>;
  if (project.networkError) return <><PageHeader title="History" /><NetworkProblem error={project.networkError} /></>;

  const loaded = examples.data?.ok ? examples.data.data : undefined;
  const list = loaded?.examples ?? [];
  const projectId = project.data?.project.projectId;

  return (
    <>
      <PageHeader title="History" />
      <div className="stack">
        <div className="row">
          <div className="field compact">
            <label htmlFor="history-asset">Asset</label>
            <select id="history-asset" value={assetId} onChange={(e) => set({ asset: e.target.value, step: undefined, offset: undefined })}>
              {assets.length === 0 ? <option value="">No assets</option> : null}
              {assets.map((a) => <option key={a.assetId} value={a.assetId}>{a.name ?? a.assetId}</option>)}
            </select>
          </div>
          <div className="field compact">
            <label htmlFor="history-step">Step</label>
            <select id="history-step" value={stepId} onChange={(e) => set({ step: e.target.value, offset: undefined })}>
              <option value="">All steps</option>
              {stepIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
        </div>

        <section aria-labelledby="h-examples" className="stack">
          <h2 id="h-examples">Examples</h2>
          <p className="secondary">Past decisions the same asset, then the same style and family, then the same family produced. Retrieved by rule (tier, step, human override, newest) — nothing is inferred or invented.</p>
          {assetId === "" ? <p className="secondary">This project has no assets yet, so there is no history to retrieve.</p>
            : examples.error ? <NetworkProblem error={examples.error} />
            : !examples.data ? <p className="secondary" role="status">Loading examples…</p>
            : !examples.data.ok ? <ErrorBanner error={examples.data.error} />
            : (
              <>
                <p className="secondary" role="status">
                  {loaded?.total === 0 ? "No decided outputs match yet." : `Showing ${offset + 1}–${offset + list.length} of ${loaded?.total ?? 0}`}
                  {" · "}{loaded?.accepted ?? 0} accepted · {loaded?.rejected ?? 0} rejected
                  {loaded ? ` · scope: ${loaded.scope.family}${loaded.scope.styleIds.length > 0 ? `, styles ${loaded.scope.styleIds.join(", ")}` : ""}` : ""}
                </p>
                <div className="grid-2">
                  <ExampleGroup title="Accepted" outcome="accepted" examples={list} projectId={projectId} empty="No accepted outputs yet." />
                  <ExampleGroup title="Rejected" outcome="rejected" examples={list} projectId={projectId} empty="No rejected outputs yet." />
                </div>
                {(loaded?.total ?? 0) > PAGE ? (
                  <div className="row">
                    <button type="button" disabled={offset === 0} onClick={() => set({ offset: offset - PAGE <= 0 ? undefined : String(offset - PAGE) })}>Previous {PAGE}</button>
                    <button type="button" disabled={offset + PAGE >= (loaded?.total ?? 0)} onClick={() => set({ offset: String(offset + PAGE) })}>Next {PAGE}</button>
                  </div>
                ) : null}
              </>
            )}
        </section>

        <Judgments query={judgments} />

        <PreferencesPanel examples={list} styleIds={loaded?.scope.styleIds ?? []} />
      </div>
    </>
  );
}

function ExampleGroup({ title, outcome, examples, projectId, empty }: { title: string; outcome: HistoryExample["outcome"]; examples: HistoryExample[]; projectId: string | undefined; empty: string }) {
  const rows = examples.filter((e) => e.outcome === outcome);
  return (
    <section aria-label={`${title} examples`}>
      <h3>{title} ({rows.length})</h3>
      {rows.length === 0 ? <p className="secondary">{empty}</p> : (
        <ul className="plain stack">
          {rows.map((e) => (
            <li key={e.decisionId} className="panel">
              <div className="row">
                {e.visuals.map((v) => projectId ? (
                  <a key={v.fileId} href={fileUrl(projectId, v.fileId)} target="_blank" rel="noreferrer">
                    <img className="thumb" src={fileUrl(projectId, v.fileId)} alt={`${e.candidateLabel}: ${v.label}`} />
                  </a>
                ) : null)}
              </div>
              <p style={{ margin: "8px 0 0" }}>
                <Link to={`/assets/${encodeURIComponent(e.assetId)}/candidates/${encodeURIComponent(e.candidateId)}?output=${encodeURIComponent(e.outputId)}`}>{e.candidateLabel}</Link>
                <span className="secondary"> · {e.assetId} · {e.stepId}</span>
              </p>
              <p className="secondary" style={{ margin: "4px 0 0" }}>
                <strong>{TIER[e.tier]}</strong>{e.matched.length > 0 ? ` — matched: ${e.matched.join(", ")}` : ""}
              </p>
              <p className="secondary" style={{ margin: "4px 0 0" }}>
                {e.decision.decision === "approve" ? "Approved" : "Rejected"} by {e.decision.actorId} ({e.decision.actorType}) · {formatTime(e.decision.createdAt)}
                {e.decision.reasons.length > 0 ? ` — ${e.decision.reasons.join("; ")}` : " — no reasons recorded"}
              </p>
              {e.humanOverride ? <p style={{ margin: "4px 0 0" }}><Status tone="info">Human override</Status></p> : null}
              {e.alternatives.length > 0 ? (
                <details>
                  <summary>{e.alternatives.length} {e.alternatives.length === 1 ? "alternative" : "alternatives"}</summary>
                  <ul className="secondary">
                    {e.alternatives.map((a) => (
                      <li key={a.candidateId}><Link to={`/assets/${encodeURIComponent(e.assetId)}/candidates/${encodeURIComponent(a.candidateId)}`}>{a.label}</Link> — {a.outcome}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Judgments({ query }: { query: UseQueryResult<Envelope<"history.judgments">, NetworkError> }) {
  let body;
  if (query.error) body = <NetworkProblem error={query.error} />;
  else if (!query.data) body = <p className="secondary" role="status">Loading judgments…</p>;
  else if (!query.data.ok) body = <ErrorBanner error={query.data.error} />;
  else body = <JudgmentBody summary={query.data.data.summary} />;
  return (
    <section aria-labelledby="h-judgments" className="stack">
      <h2 id="h-judgments">Agent judgments vs human decisions</h2>
      <p className="secondary">A record of what agents decided and what a human decided afterwards. These are counts and cases, not a measure of your taste.</p>
      {body}
    </section>
  );
}

function JudgmentBody({ summary }: { summary: JudgmentSummary }) {
  const counts: Array<[string, number]> = [
    ["Agent decisions", summary.agentDecisions],
    ["Agent approvals", summary.agentApprovals],
    ["Agent rejections", summary.agentRejections],
    ["Human decisions", summary.humanDecisions],
    ["Human overrides of an agent", summary.overrides],
    ["Overrides that reversed the verdict", summary.reversals],
    ["Escalations", summary.escalations],
    ["Escalations still pending", summary.pendingEscalations],
  ];
  return (
    <>
      <dl className="kv" aria-label="Judgment counts">
        {counts.map(([label, n]) => <div key={label} style={{ display: "contents" }}><dt>{label}</dt><dd>{n}</dd></div>)}
      </dl>
      {summary.cases.length === 0 ? <p className="secondary">No human override of an agent decision has been recorded yet.</p> : (
        <table aria-label="Override cases">
          <thead><tr><th>Candidate</th><th>Step</th><th>Agent said</th><th>Human decided</th><th>Outcome</th></tr></thead>
          <tbody>
            {summary.cases.map((c) => (
              <tr key={`${c.candidateId}-${c.outputId}`}>
                <td><Link to={`/assets/${encodeURIComponent(c.assetId)}/candidates/${encodeURIComponent(c.candidateId)}?output=${encodeURIComponent(c.outputId)}`}>{c.candidateId}</Link></td>
                <td>{c.assetId} · {c.stepId}</td>
                <td>{c.agentDecision.decision === "approve" ? "Approve" : "Reject"} <span className="secondary">by {c.agentDecision.actorId}{c.agentDecision.reasons.length > 0 ? ` — ${c.agentDecision.reasons.join("; ")}` : ""}</span></td>
                <td>{c.humanDecision.decision === "approve" ? "Approve" : "Reject"} <span className="secondary">by {c.humanDecision.actorId}{c.humanDecision.reasons.length > 0 ? ` — ${c.humanDecision.reasons.join("; ")}` : ""}</span></td>
                <td>{c.reversed ? <Status tone="warn">Reversed</Status> : <Status tone="ok">Same verdict</Status>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
