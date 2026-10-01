import { useEffect, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
import type { OperationData, OperationInput } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { outputUrl } from "../generation/media.tsx";
import "./review.css";
import { ErrorBanner, NetworkProblem, Status, type Tone } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { ApprovalBadge } from "./ApprovalBadge.tsx";

type Filter = NonNullable<OperationInput<"review.list">["filter"]>;
type Item = OperationData<"review.list">["items"][number];

const PAGE = 50;
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "awaiting", label: "Awaiting" },
  { id: "escalated", label: "Escalated" },
  { id: "needs-revision", label: "Needs revision" },
  { id: "overridden", label: "Overridden" },
  { id: "decided", label: "Decided" },
  { id: "all", label: "All" },
];
const KIND: Record<Item["kind"], { tone: Tone; label: string }> = {
  "awaiting-review": { tone: "idle", label: "Awaiting review" },
  escalated: { tone: "warn", label: "Escalated to a human" },
  "needs-revision": { tone: "warn", label: "Needs revision" },
  overridden: { tone: "info", label: "Human override" },
  decided: { tone: "ok", label: "Decided" },
};

/** Decision queue. Filter, asset, step and page live in the URL so reload and back keep them. */
export function ReviewQueue() {
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const assetId = params.get("asset") ?? "";
  const stepId = params.get("step") ?? "";
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const assets = project.data?.assets ?? [];
  const filter = FILTERS.find((f) => f.id === params.get("filter"))?.id ?? "awaiting";
  const set = (changes: Record<string, string | undefined>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, value);
    }
    return next;
  });

  const steps = useOperation("step.list", { assetId }, { enabled: assetId !== "" });
  const stepIds = steps.data?.ok ? steps.data.data.steps.map((s) => s.stepId).filter((id) => id !== "concept") : [];
  const selected = params.get("selected") ?? "";
  const queueSearch = new URLSearchParams(params);
  queueSearch.delete("selected");
  const list = useOperation("review.list", {
    filter, limit: PAGE, offset,
    ...(assetId ? { assetId } : {}),
    ...(stepId ? { stepId } : {}),
  });

  const total = list.data?.ok ? list.data.data.total : 0;
  const items = list.data?.ok ? list.data.data.items : [];
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + items.length;

  return (
    <section aria-labelledby="q-decide" className="stack">
      <h2 id="q-decide">Decision queue</h2>
      <div className="row" role="group" aria-label="Queue filter">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`chip${f.id === filter ? " active" : ""}`} aria-pressed={f.id === filter} onClick={() => set({ filter: f.id === "awaiting" ? undefined : f.id, offset: undefined })}>{f.label}</button>
        ))}
      </div>
      <div className="row">
        <div className="field compact">
          <label htmlFor="queue-asset">Asset</label>
          <select id="queue-asset" value={assetId} onChange={(e) => set({ asset: e.target.value, step: undefined, offset: undefined })}>
            <option value="">All assets</option>
            {assets.map((a) => <option key={a.assetId} value={a.assetId}>{a.name ?? a.assetId}</option>)}
          </select>
        </div>
        <div className="field compact">
          <label htmlFor="queue-step">Step</label>
          <select id="queue-step" value={stepId} disabled={assetId === ""} onChange={(e) => set({ step: e.target.value, offset: undefined })}>
            <option value="">{assetId === "" ? "Choose an asset first" : "All steps"}</option>
            {stepIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
      </div>

      {list.error ? <NetworkProblem error={list.error} /> : !list.data ? <p className="secondary" role="status">Loading queue…</p> : !list.data.ok ? <ErrorBanner error={list.data.error} /> : (
        <>
          <p className="secondary" role="status">{total === 0 ? "Nothing matches this filter." : `Showing ${first}–${last} of ${total}`}</p>
          {items.length > 0 ? (
            <ul className="plain stack" aria-label="Review queue">
              {items.map((item) => <QueueRow key={`${item.candidate.candidateId}-${item.kind}`} item={item} selected={item.candidate.candidateId === selected} queueSearch={queueSearch} projectId={project.data?.project.projectId} />)}
            </ul>
          ) : filter === "awaiting" ? <p className="secondary">No deliverable candidates are waiting for a decision. Concept candidates are chosen with Lock concept, not here.</p> : null}
          {total > PAGE ? (
            <div className="row">
              <button type="button" disabled={offset === 0} onClick={() => set({ offset: offset - PAGE <= 0 ? undefined : String(offset - PAGE) })}>Previous {PAGE}</button>
              <button type="button" disabled={offset + PAGE >= total} onClick={() => set({ offset: String(offset + PAGE) })}>Next {PAGE}</button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function QueueRow({ item, selected, queueSearch, projectId }: { item: Item; selected: boolean; queueSearch: URLSearchParams; projectId: string | undefined }) {
  const { candidate, escalation, kind } = item;
  const k = KIND[kind];
  const ref = useRef<HTMLLIElement>(null);
  // Coming back from a candidate keeps its row in view.
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const out = candidate.outputs.find((o) => o.stage === "processed") ?? candidate.outputs.find((o) => o.role === "matted") ?? candidate.outputs[0];
  const back = new URLSearchParams(queueSearch);
  back.set("selected", candidate.candidateId);
  const to = `/assets/${encodeURIComponent(candidate.assetId)}/candidates/${encodeURIComponent(candidate.candidateId)}?panel=decision&return=${encodeURIComponent(`/review?${back.toString()}`)}`;
  return (
    <li ref={ref} className={`queue-row${selected ? " selected" : ""}`} aria-current={selected ? "true" : undefined}>
      <span className="thumb-box">{out && projectId ? <img src={outputUrl(projectId, out.fileId, 144)} alt="" loading="lazy" /> : null}</span>
      <div className="queue-row-main">
        <div className="row"><strong>{candidate.label}</strong><Status tone={k.tone}>{k.label}</Status></div>
        <p className="secondary">
          {candidate.assetId} · {candidate.stepId} · {candidate.openRevisionCount} open {candidate.openRevisionCount === 1 ? "revision" : "revisions"}
          {escalation ? ` · escalated by ${escalation.escalatedBy}: ${escalation.reason}` : ""}
        </p>
        <ApprovalBadge approval={candidate.approvals.find((a) => a.state !== "none") ?? candidate.approvals[0]} compact />
      </div>
      <Link className="button" to={to}>{kind === "awaiting-review" || kind === "escalated" ? "Open and decide" : "Open"}</Link>
    </li>
  );
}
