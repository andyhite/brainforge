import { useState } from "react";
import type { Budget } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { ErrorBanner, formatTime, NetworkProblem, timeAgo } from "../../components/ui.tsx";
import { whoLabel } from "../review/room-lib.ts";
import "./generation.css";

const STATUS_TEXT: Record<Budget["status"], string> = { active: "Active", exhausted: "Used up", expired: "Expired", revoked: "Revoked" };

function localDatetimeValue(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function GrantForm({ assetId, stepId, onDone }: { assetId: string; stepId: string; onDone: () => void }) {
  const grant = useMutationOperation("budget.grant");
  const [maxStarts, setMaxStarts] = useState(3);
  const [maxSubmissions, setMaxSubmissions] = useState(12);
  const [expires, setExpires] = useState(() => localDatetimeValue(new Date(Date.now() + 24 * 3_600_000)));
  const [spendCap, setSpendCap] = useState("");
  const [note, setNote] = useState("");
  const expiryDate = new Date(expires);
  const invalidExpiry = Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() <= Date.now();

  const submit = async () => {
    const cap = spendCap.trim() === "" ? undefined : Number(spendCap);
    const result = await grant.mutateAsync({
      input: {
        assetId, stepId, maxStarts, maxCandidateSubmissions: maxSubmissions, expiresAt: expiryDate.toISOString(),
        ...(cap !== undefined && Number.isFinite(cap) ? { spendCapUsd: cap } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
    if (result.ok) onDone();
  };

  return (
    <form className="budget-grant stack" onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Grant a generation budget">
      <p className="secondary">A budget is the limit you set on generation for this deliverable. Brainforge never starts generating without one, and stops when it is used up or expires. Only you can grant it.</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="bg-starts">Starts</label>
          <input id="bg-starts" type="number" min={1} max={50} value={maxStarts} onChange={(event) => setMaxStarts(Number(event.target.value))} />
          <div className="hint">A start sends one batch of candidates to be generated.</div>
        </div>
        <div className="field">
          <label htmlFor="bg-subs">Candidates</label>
          <input id="bg-subs" type="number" min={1} max={200} value={maxSubmissions} onChange={(event) => setMaxSubmissions(Number(event.target.value))} />
          <div className="hint">Every candidate in every batch counts, whether or not you keep it.</div>
        </div>
        <div className="field">
          <label htmlFor="bg-exp">Expires</label>
          <input id="bg-exp" type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} aria-invalid={invalidExpiry} />
          {invalidExpiry ? <div className="hint" role="alert">Choose a time in the future.</div> : <div className="hint">Unused starts and candidates are lost after this.</div>}
        </div>
        <div className="field">
          <label htmlFor="bg-cap">Spend cap in USD (optional)</label>
          <input id="bg-cap" type="number" min={0} step="0.01" value={spendCap} onChange={(event) => setSpendCap(event.target.value)} />
          <div className="hint">Leave empty when generation costs you nothing extra.</div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="bg-note">Note (optional)</label>
        <input id="bg-note" type="text" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {grant.error ? <NetworkProblem error={grant.error} /> : null}
      {grant.data && !grant.data.ok ? <ErrorBanner error={grant.data.error} /> : null}
      <div className="row end">
        <button type="button" className="ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="primary" disabled={grant.isPending || invalidExpiry || maxStarts < 1 || maxSubmissions < 1}>{grant.isPending ? "Granting…" : "Grant budget"}</button>
      </div>
    </form>
  );
}

function RevokeRow({ budget }: { budget: Budget }) {
  const revoke = useMutationOperation("budget.revoke");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <button type="button" className="danger sm" onClick={() => setOpen(true)}>Revoke…</button>;
  return (
    <form
      className="budget-revoke row"
      onSubmit={(event) => { event.preventDefault(); void revoke.mutateAsync({ input: { budgetId: budget.budgetId, reason: reason.trim() } }).then((result) => { if (result.ok) setOpen(false); }); }}
    >
      <label className="sr-only" htmlFor={`revoke-${budget.budgetId}`}>Why are you revoking this budget?</label>
      <input id={`revoke-${budget.budgetId}`} type="text" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why? (required)" />
      <button type="submit" className="danger sm" disabled={reason.trim() === "" || revoke.isPending}>Revoke budget</button>
      <button type="button" className="ghost sm" onClick={() => setOpen(false)}>Keep it</button>
      {revoke.data && !revoke.data.ok ? <span role="alert">{revoke.data.error.message}</span> : null}
    </form>
  );
}

function usage(budget: Budget): string {
  const parts = [
    `${budget.usedStarts} of ${budget.maxStarts} starts used`,
    `${budget.usedCandidateSubmissions} of ${budget.maxCandidateSubmissions} candidates used`,
  ];
  if (budget.spendCapUsd !== undefined) parts.push(`$${budget.spentUsd.toFixed(2)} of $${budget.spendCapUsd.toFixed(2)} spent`);
  else if (budget.spentUsd > 0) parts.push(`$${budget.spentUsd.toFixed(2)} spent`);
  return parts.join(" · ");
}

export function BudgetPanel({ assetId, stepId = "concept", grantOpen, onGrantOpen }: { assetId: string; stepId?: string; grantOpen: boolean; onGrantOpen: (open: boolean) => void }) {
  const [showInactive, setShowInactive] = useState(false);
  const query = useOperation("budget.list", { assetId, includeInactive: showInactive });
  const budgets = query.data?.ok ? query.data.data.budgets.filter((budget) => budget.stepId === stepId) : [];
  return (
    <section className="budget-panel stack" id="budgets" aria-label="Generation budgets">
      <div className="row budget-bar">
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />Show expired and revoked</label>
        {grantOpen ? null : <button type="button" onClick={() => onGrantOpen(true)}>Grant a budget…</button>}
      </div>
      {grantOpen ? <GrantForm assetId={assetId} stepId={stepId} onDone={() => onGrantOpen(false)} /> : null}
      {query.error ? <NetworkProblem error={query.error} /> : null}
      {!query.data && !query.error ? <p className="secondary" role="status">Loading budgets…</p> : null}
      {query.data && !query.data.ok ? <ErrorBanner error={query.data.error} /> : null}
      {query.data?.ok && budgets.length === 0 ? (
        <p className="secondary">{showInactive ? "No budget has been granted for this deliverable." : "No active budget. Generation only starts under a budget you grant."}</p>
      ) : null}
      {query.data?.ok && budgets.length > 0 ? (
        <ul className="rows" aria-label="Budgets">
          {budgets.map((budget) => (
            <li key={budget.budgetId} className="budget-row">
              <span className="stamp"><Icon name={budget.status === "active" ? "ok" : budget.status === "exhausted" ? "warn" : "idle"} />{STATUS_TEXT[budget.status]}</span>
              <div className="budget-main">
                <div>{usage(budget)}</div>
                <div className="secondary">
                  {budget.status === "revoked" && budget.revokedAt ? "Revoked " : budget.status === "expired" ? "Expired " : "Expires "}
                  <time dateTime={budget.status === "revoked" && budget.revokedAt ? budget.revokedAt : budget.expiresAt} title={formatTime(budget.status === "revoked" && budget.revokedAt ? budget.revokedAt : budget.expiresAt)}>{timeAgo(budget.status === "revoked" && budget.revokedAt ? budget.revokedAt : budget.expiresAt)}</time>
                  {budget.note ? ` · ${budget.note}` : ""} · granted by {whoLabel(budget.createdBy).toLowerCase()}
                </div>
              </div>
              {budget.status === "active" ? <RevokeRow budget={budget} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
