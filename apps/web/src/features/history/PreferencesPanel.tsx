import "../jobs/activity.css";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { HistoryExample, OperationError, Preference } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, Status, type Tone } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { whoLabel } from "../review/room-lib.ts";

const STATUS: Record<Preference["status"], { tone: Tone; label: string }> = {
  proposed: { tone: "warn", label: "Waiting for you" },
  confirmed: { tone: "ok", label: "In force" },
  rejected: { tone: "idle", label: "Rejected" },
};

const CONSEQUENCE = "Confirming makes this a requirement and makes earlier approvals stale: outputs approved before this wording existed will need a fresh review. Old runs are not changed and no policy is edited.";

const roomOf = (hit: HistoryExample) => paths.step(hit.assetId, hit.stepId, { candidate: hit.candidateId, output: hit.outputId });

export function PreferencesPanel({ examples, styleIds }: { examples: HistoryExample[]; styleIds: string[] }) {
  const query = useOperation("preference.list", {});
  const preferences = query.data?.ok ? [...query.data.data.preferences].sort((a, b) => Number(b.status === "proposed") - Number(a.status === "proposed")) : [];
  const waiting = preferences.filter((p) => p.status === "proposed").length;
  const byDecision = new Map(examples.map((e) => [e.decisionId, e]));
  return (
    <section aria-labelledby="h-prefs">
      <div className="section-head">
        <h2 id="h-prefs">Preferences</h2>
        {waiting > 0 ? <span className="count">{waiting}</span> : null}
        <span className="aside">Only a person can confirm or reject a preference.</span>
      </div>
      <p className="secondary">Short statements of visual direction, each backed by past decisions. A preference counts only after you confirm it.</p>
      {query.error ? <NetworkProblem error={query.error} /> : !query.data ? <p className="secondary" role="status">Loading preferences…</p> : !query.data.ok ? <ErrorBanner error={query.data.error} /> : preferences.length === 0 ? (
        <p className="secondary">No preferences yet. Propose one below, or an agent can propose one from the decisions it retrieved.</p>
      ) : (
        <ul className="rows" aria-label="Preferences">
          {preferences.map((p) => <PreferenceCard key={p.preferenceId} preference={p} byDecision={byDecision} />)}
        </ul>
      )}
      <details className="pref-propose" open={query.data?.ok === true && preferences.length === 0}>
        <summary>Propose a preference…</summary>
        <ProposeForm examples={examples} styleIds={styleIds} />
      </details>
    </section>
  );
}

function PreferenceCard({ preference, byDecision }: { preference: Preference; byDecision: Map<string, HistoryExample> }) {
  const confirm = useMutationOperation("preference.confirm");
  const reject = useMutationOperation("preference.reject");
  const [text, setText] = useState(preference.text);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [refusal, setRefusal] = useState<OperationError | undefined>();
  const s = STATUS[preference.status];
  const edited = text.trim() !== preference.proposedText.trim();
  const busy = confirm.isPending || reject.isPending;
  const id = preference.preferenceId;

  const run = async (kind: "confirm" | "reject") => {
    setRefusal(undefined);
    const result = kind === "confirm"
      ? await confirm.mutateAsync({ input: { preferenceId: id, ...(edited ? { text: text.trim() } : {}) } })
      : await reject.mutateAsync({ input: { preferenceId: id, reason: reason.trim() } });
    if (!result.ok) setRefusal(result.error);
  };

  return (
    <li className="pref-item" data-status={preference.status}>
      <div className="pref-head">
        <strong>{preference.text}</strong>
        <Status tone={s.tone}>{s.label}</Status>
      </div>
      <p className="secondary">
        {preference.scope === "style" ? `Style ${preference.styleId ?? "?"}` : "Whole project"} · proposed by {whoLabel(preference.proposedBy).toLowerCase()} · {formatTime(preference.proposedAt)}
        {preference.corrected ? ` · corrected from “${preference.proposedText}”` : ""}
        {preference.decidedBy ? ` · ${preference.status} by ${whoLabel(preference.decidedBy).toLowerCase()}${preference.decidedAt ? ` · ${formatTime(preference.decidedAt)}` : ""}` : ""}
        {preference.note ? ` — ${preference.note}` : ""}
      </p>
      {preference.evidenceIds.length > 0 ? (
        <div className="row" role="list" aria-label="Evidence decisions">
          <span className="secondary">Evidence:</span>
          {preference.evidenceIds.map((e) => {
            const hit = byDecision.get(e);
            return hit
              ? <span role="listitem" key={e} className="chip"><Link to={roomOf(hit)}>{hit.candidateLabel}</Link> ({hit.outcome})</span>
              : <code role="listitem" key={e} className="chip" title="Pick this asset or deliverable in the filters above to link it to its candidate">{e}</code>;
          })}
        </div>
      ) : null}
      {preference.status === "proposed" ? (
        <div className="pref-form">
          <div className="field">
            <label htmlFor={`pref-text-${id}`}>Wording to confirm (editing it marks the preference as corrected)</label>
            <textarea id={`pref-text-${id}`} rows={2} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
          </div>
          <p className="secondary">{CONSEQUENCE}</p>
          {rejecting ? (
            <div className="field">
              <label htmlFor={`pref-reason-${id}`}>Reason for rejecting (required)</label>
              <input id={`pref-reason-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          ) : null}
          {refusal ? <ErrorBanner error={refusal} /> : null}
          <div className="row">
            <button type="button" className="primary" disabled={busy || text.trim() === ""} onClick={() => void run("confirm")}>{edited ? "Confirm corrected wording" : "Confirm"}</button>
            <button type="button" disabled={busy || (rejecting && reason.trim() === "")} title={rejecting && reason.trim() === "" ? "Enter a reason to reject" : undefined} onClick={() => (rejecting ? void run("reject") : setRejecting(true))}>{rejecting ? "Confirm reject" : "Reject…"}</button>
            {rejecting ? <button type="button" className="ghost" onClick={() => setRejecting(false)}>Cancel</button> : null}
          </div>
          {rejecting && reason.trim() === "" ? <p className="secondary" role="status">Enter a reason to reject.</p> : null}
        </div>
      ) : null}
    </li>
  );
}

function ProposeForm({ examples, styleIds }: { examples: HistoryExample[]; styleIds: string[] }) {
  const propose = useMutationOperation("preference.propose");
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"project" | "style">("project");
  const [styleId, setStyleId] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [error, setError] = useState<OperationError | undefined>();
  const [done, setDone] = useState(false);
  const missing = text.trim() === "" ? "Write the preference." : evidence.length === 0 ? "Choose at least one decision as evidence." : scope === "style" && styleId === "" ? "Choose a style." : undefined;

  return (
    <form
      className="pref-form"
      aria-label="Propose a preference"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        setDone(false);
        const result = await propose.mutateAsync({ input: { text: text.trim(), scope, ...(scope === "style" ? { styleId } : {}), evidenceIds: evidence } });
        if (!result.ok) return setError(result.error);
        setText("");
        setEvidence([]);
        setDone(true);
      }}
    >
      <div className="field">
        <label htmlFor="pref-new-text">Preference</label>
        <textarea id="pref-new-text" rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="row">
        <div className="field compact">
          <label htmlFor="pref-new-scope">Applies to</label>
          <select id="pref-new-scope" value={scope} onChange={(e) => setScope(e.target.value === "style" ? "style" : "project")}>
            <option value="project">Whole project</option>
            <option value="style">One style</option>
          </select>
        </div>
        {scope === "style" ? (
          <div className="field compact">
            <label htmlFor="pref-new-style">Style</label>
            <select id="pref-new-style" value={styleId} onChange={(e) => setStyleId(e.target.value)}>
              <option value="">Choose a style</option>
              {styleIds.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ) : null}
      </div>
      <fieldset>
        <legend>Evidence: decisions for the asset and deliverable chosen above</legend>
        {examples.length === 0 ? <p className="secondary">No decisions loaded for this scope, so there is nothing to cite yet.</p> : (
          <ul className="plain">
            {examples.map((e) => (
              <li key={e.decisionId}>
                <label className="check">
                  <input type="checkbox" checked={evidence.includes(e.decisionId)} onChange={() => setEvidence((cur) => (cur.includes(e.decisionId) ? cur.filter((d) => d !== e.decisionId) : [...cur, e.decisionId]))} />
                  <span>{e.candidateLabel} <span className="secondary">({e.outcome}, {e.assetId} · {e.stepId})</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error ? <ErrorBanner error={error} /> : null}
      <div className="row">
        <button type="submit" disabled={propose.isPending || missing !== undefined}>Propose</button>
        {missing ? <span className="secondary" role="status">{missing}</span> : null}
        {done ? <span role="status"><Status tone="ok">Proposed. It is listed above and waits for your confirmation.</Status></span> : null}
      </div>
    </form>
  );
}
