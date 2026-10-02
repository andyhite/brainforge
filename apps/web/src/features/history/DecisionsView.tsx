import "../jobs/activity.css";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import type { HistoryExample, JudgmentSummary } from "@brainforge/contracts";
import { fileUrl, useOperation, type Envelope } from "../../api/hooks.ts";
import type { NetworkError } from "../../api/client.ts";
import { Art, gate, NetworkProblem, Status, timeAgo, formatTime } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { kindLabel } from "../../lib/steps.ts";
import { useProject } from "../../lib/use-project.ts";
import { PreferencesPanel } from "./PreferencesPanel.tsx";
import { whoLabel } from "../review/room-lib.ts";

const PAGE = 8;
const TIER: Record<HistoryExample["tier"], string> = {
  asset: "Same asset",
  "style-family": "Same style and family",
  family: "Same family",
};

/** Decisions and preferences share one scope (asset and step), so evidence for a preference comes from what is on screen. */
export function DecisionsView({ mode }: { mode: "decisions" | "preferences" }) {
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const assets = project.data?.assets ?? [];
  const assetId = params.get("asset") ?? assets[0]?.assetId ?? "";
  const stepId = params.get("step") ?? "";
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const nameOf = (id: string) => assets.find((asset) => asset.assetId === id)?.name ?? id;

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

  if (project.networkError) return <NetworkProblem error={project.networkError} />;

  const g = gate(examples, "Loading decisions…");
  const loaded = examples.data?.ok ? examples.data.data : undefined;
  const list = loaded?.examples ?? [];
  const projectId = project.data?.project.projectId;

  return (
    <div className="stack">
      <div className="dec-filters" role="group" aria-label="Scope of the decisions below">
        <div className="field compact">
          <label htmlFor="history-asset">Asset</label>
          <select id="history-asset" value={assetId} onChange={(e) => set({ asset: e.target.value, step: undefined, offset: undefined })}>
            {assets.length === 0 ? <option value="">No assets</option> : null}
            {assets.map((a) => <option key={a.assetId} value={a.assetId}>{a.name ?? a.assetId}</option>)}
          </select>
        </div>
        <div className="field compact">
          <label htmlFor="history-step">Deliverable</label>
          <select id="history-step" value={stepId} onChange={(e) => set({ step: e.target.value, offset: undefined })}>
            <option value="">All deliverables</option>
            {stepIds.map((id) => <option key={id} value={id}>{kindLabel(id)}</option>)}
          </select>
        </div>
      </div>

      {mode === "preferences" ? (
        <PreferencesPanel examples={list} styleIds={loaded?.scope.styleIds ?? []} />
      ) : (
        <>
          <section aria-labelledby="h-examples">
            <div className="section-head">
              <h2 id="h-examples">Past decisions</h2>
              {loaded ? <span className="aside" role="status">{loaded.total === 0 ? "None yet" : `${offset + 1}–${offset + list.length} of ${loaded.total}`} · {loaded.accepted} accepted · {loaded.rejected} rejected</span> : null}
            </div>
            <p className="secondary">What the same asset, then the same style and family, then the same family decided before. Only this page is loaded; it isn’t the complete log.</p>
            {assetId === "" ? <p className="secondary">This project has no assets yet, so there is no history.</p>
              : "node" in g ? g.node
              : (
                <>
                  <div className="dec-cols">
                    <ExampleGroup title="Accepted" outcome="accepted" examples={list} projectId={projectId} nameOf={nameOf} empty="Nothing accepted yet." />
                    <ExampleGroup title="Rejected" outcome="rejected" examples={list} projectId={projectId} nameOf={nameOf} empty="Nothing rejected yet." />
                  </div>
                  {(loaded?.total ?? 0) > PAGE ? (
                    <div className="dec-pager">
                      <button type="button" disabled={offset === 0} onClick={() => set({ offset: offset - PAGE <= 0 ? undefined : String(offset - PAGE) })}>Previous {PAGE}</button>
                      <button type="button" disabled={offset + PAGE >= (loaded?.total ?? 0)} onClick={() => set({ offset: String(offset + PAGE) })}>Next {PAGE}</button>
                    </div>
                  ) : null}
                </>
              )}
          </section>
          <Judgments query={judgments} />
        </>
      )}
    </div>
  );
}

function ExampleGroup({ title, outcome, examples, projectId, nameOf, empty }: {
  title: string; outcome: HistoryExample["outcome"]; examples: HistoryExample[]; projectId: string | undefined; nameOf: (id: string) => string; empty: string;
}) {
  const rows = examples.filter((e) => e.outcome === outcome);
  return (
    <section aria-label={`${title} decisions`}>
      <div className="section-head"><h3>{title}</h3><span className="count quiet">{rows.length}</span></div>
      {rows.length === 0 ? <p className="secondary">{empty}</p> : (
        <ul className="rows">
          {rows.map((e) => {
            const room = paths.step(e.assetId, e.stepId, { candidate: e.candidateId, output: e.outputId });
            return (
              <li key={e.decisionId} className="dec-record">
                <div className="dec-thumbs">
                  {e.visuals.map((v) => projectId ? (
                    <Link key={v.fileId} to={room} className="dec-art-link" aria-label={`Open ${e.candidateLabel} in the room`}>
                      <Art src={fileUrl(projectId, v.fileId, 128)} alt={`${nameOf(e.assetId)}, ${e.candidateLabel}: ${v.label}`} className="dec-art" />
                    </Link>
                  ) : null)}
                </div>
                <div className="dec-body">
                  <p><Link to={room}>{nameOf(e.assetId)} · {kindLabel(e.stepId)} · {e.candidateLabel}</Link></p>
                  <p className="secondary">
                    {e.decision.decision === "approve" ? "Approved" : "Rejected"} by {whoLabel(e.decision.actorId).toLowerCase()} · <time dateTime={e.decision.createdAt} title={formatTime(e.decision.createdAt)}>{timeAgo(e.decision.createdAt)}</time>
                  </p>
                  <p className="secondary">{e.decision.reasons.length > 0 ? e.decision.reasons.join("; ") : "No reasons recorded"}</p>
                  <p className="row">
                    <span className="chip">{TIER[e.tier]}</span>
                    {e.humanOverride ? <Status tone="info">Human override</Status> : null}
                  </p>
                </div>
                {e.matched.length > 0 || e.alternatives.length > 0 ? (
                  <details>
                    <summary>Why this was retrieved{e.alternatives.length > 0 ? ` · ${e.alternatives.length} ${e.alternatives.length === 1 ? "alternative" : "alternatives"}` : ""}</summary>
                    {e.matched.length > 0 ? <p className="secondary">Matched: {e.matched.join(", ")}</p> : null}
                    {e.alternatives.length > 0 ? (
                      <ul className="secondary">
                        {e.alternatives.map((a) => (
                          <li key={a.candidateId}><Link to={paths.step(e.assetId, e.stepId, { candidate: a.candidateId })}>{a.label}</Link> — {a.outcome}</li>
                        ))}
                      </ul>
                    ) : null}
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Judgments({ query }: { query: UseQueryResult<Envelope<"history.judgments">, NetworkError> }) {
  const g = gate(query, "Loading judgments…");
  const body = "node" in g ? g.node : <JudgmentBody summary={g.data.summary} />;
  return (
    <section aria-labelledby="h-judgments">
      <div className="section-head"><h2 id="h-judgments">Agent calls vs your decisions</h2></div>
      <p className="secondary">What agents decided and what a person decided afterwards. These are counts and cases, not a measure of your taste.</p>
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
      <dl className="dec-counts" aria-label="Judgment counts">
        {counts.map(([label, n]) => <div key={label}><dt>{label}</dt><dd>{n}</dd></div>)}
      </dl>
      {summary.cases.length === 0 ? <p className="secondary">No person has overridden an agent decision yet.</p> : (
        <div className="table-wrap"><table aria-label="Override cases">
          <thead><tr><th>Candidate</th><th>Deliverable</th><th>Agent said</th><th>You decided</th><th>Outcome</th></tr></thead>
          <tbody>
            {summary.cases.map((c) => (
              <tr key={`${c.candidateId}-${c.outputId}`}>
                <td><Link to={paths.step(c.assetId, c.stepId, { candidate: c.candidateId, output: c.outputId })}>Open in the room</Link></td>
                <td>{c.assetId} · {kindLabel(c.stepId)}</td>
                <td>{c.agentDecision.decision === "approve" ? "Approve" : "Reject"} <span className="secondary">by {whoLabel(c.agentDecision.actorId).toLowerCase()}{c.agentDecision.reasons.length > 0 ? ` — ${c.agentDecision.reasons.join("; ")}` : ""}</span></td>
                <td>{c.humanDecision.decision === "approve" ? "Approve" : "Reject"} <span className="secondary">by {whoLabel(c.humanDecision.actorId).toLowerCase()}{c.humanDecision.reasons.length > 0 ? ` — ${c.humanDecision.reasons.join("; ")}` : ""}</span></td>
                <td>{c.reversed ? <Status tone="warn">Reversed</Status> : <Status tone="ok">Same verdict</Status>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
