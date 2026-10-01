import { useState } from "react";
import { Link } from "react-router-dom";
import type { HistoryExample, OperationError, Preference } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, Status, type Tone } from "../../components/ui.tsx";

const STATUS: Record<Preference["status"], { tone: Tone; label: string }> = {
  proposed: { tone: "warn", label: "Proposed — waiting for you" },
  confirmed: { tone: "ok", label: "Confirmed — in force" },
  rejected: { tone: "idle", label: "Rejected" },
};

const CONSEQUENCE = "Confirmed preferences become requirements and make earlier approvals stale: outputs approved before this wording existed will need a fresh review. Old runs are not changed and no policy is edited.";

export function PreferencesPanel({ examples, styleIds }: { examples: HistoryExample[]; styleIds: string[] }) {
  const query = useOperation("preference.list", {});
  const preferences = query.data?.ok ? [...query.data.data.preferences].sort((a, b) => Number(b.status === "proposed") - Number(a.status === "proposed")) : [];
  const waiting = preferences.filter((p) => p.status === "proposed").length;
  const byDecision = new Map(examples.map((e) => [e.decisionId, e]));
  return (
    <section aria-labelledby="h-prefs" className={`history-section${waiting > 0 ? " history-attention" : ""}`}>
      <h2 id="h-prefs">Preferences{waiting > 0 ? ` — ${waiting} waiting for you` : ""}</h2>
      <p className="secondary history-note">Short statements of visual direction, each backed by decisions. A preference counts only after a human confirms it.</p>
      {query.error ? <NetworkProblem error={query.error} /> : !query.data ? <p className="secondary" role="status">Loading preferences…</p> : !query.data.ok ? <ErrorBanner error={query.data.error} /> : preferences.length === 0 ? (
        <p className="secondary">No preferences proposed yet. Propose one below, or an agent can propose from the examples it retrieved.</p>
      ) : (
        <ul className="plain history-records" aria-label="Preferences">
          {preferences.map((p) => <PreferenceCard key={p.preferenceId} preference={p} byDecision={byDecision} />)}
        </ul>
      )}
      <ProposeForm examples={examples} styleIds={styleIds} />
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
        {preference.scope === "style" ? `Style ${preference.styleId ?? "?"}` : "Whole project"} · proposed by {preference.proposedBy} ({preference.proposedByType}) · {formatTime(preference.proposedAt)}
        {preference.corrected ? ` · corrected from “${preference.proposedText}”` : ""}
        {preference.decidedBy ? ` · ${preference.status} by ${preference.decidedBy}${preference.decidedAt ? ` · ${formatTime(preference.decidedAt)}` : ""}` : ""}
        {preference.note ? ` — ${preference.note}` : ""}
      </p>
      <div className="row" role="list" aria-label="Evidence decisions">
        <span className="secondary">Evidence:</span>
        {preference.evidenceIds.map((e) => {
          const hit = byDecision.get(e);
          return hit
            ? <span role="listitem" key={e} className="chip"><Link to={`/assets/${encodeURIComponent(hit.assetId)}/candidates/${encodeURIComponent(hit.candidateId)}?output=${encodeURIComponent(hit.outputId)}`}>{hit.candidateLabel}</Link> ({hit.outcome})</span>
            : <code role="listitem" key={e} className="chip" title="Pick this asset or step in the filters above to link it to its candidate">{e}</code>;
        })}
      </div>
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
            {rejecting ? <button type="button" onClick={() => setRejecting(false)}>Cancel</button> : null}
          </div>
          {rejecting && reason.trim() === "" ? <p className="secondary" role="status">Disabled: enter a reason to reject.</p> : null}
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
      <h3>Propose a preference</h3>
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
        <legend>Evidence (decisions listed under Decision examples)</legend>
        {examples.length === 0 ? <p className="secondary">No examples loaded for this asset and step, so there is nothing to cite yet.</p> : (
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
        <button type="submit" className="primary" disabled={propose.isPending || missing !== undefined}>Propose</button>
        {missing ? <span className="secondary" role="status">Disabled: {missing}</span> : null}
        {done ? <span role="status"><Status tone="ok">Proposed. It is listed above and waits for confirmation.</Status></span> : null}
      </div>
    </form>
  );
}
