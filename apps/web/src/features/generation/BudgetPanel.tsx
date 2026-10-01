import { useState } from "react";
import type { Budget } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, Status, type Tone } from "../../components/ui.tsx";

const STATUS_TONE: Record<Budget["status"], Tone> = { active: "ok", exhausted: "warn", expired: "idle", revoked: "idle" };

function localDatetimeValue(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function GrantForm({ assetId, onDone }: { assetId: string; onDone: () => void }) {
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
        assetId, stepId: "concept", maxStarts, maxCandidateSubmissions: maxSubmissions, expiresAt: expiryDate.toISOString(),
        ...(cap !== undefined && Number.isFinite(cap) ? { spendCapUsd: cap } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
    if (result.ok) onDone();
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Grant a generation budget">
      <p className="secondary">A budget is a bounded authorization to spend GPU time on this asset's concept step. Only you can grant one; generation stops when it is used up or expires.</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="bg-starts">Maximum starts (batches)</label>
          <input id="bg-starts" type="number" min={1} max={50} value={maxStarts} onChange={(event) => setMaxStarts(Number(event.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="bg-subs">Maximum candidate submissions</label>
          <input id="bg-subs" type="number" min={1} max={200} value={maxSubmissions} onChange={(event) => setMaxSubmissions(Number(event.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="bg-exp">Expires</label>
          <input id="bg-exp" type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} aria-invalid={invalidExpiry} />
          {invalidExpiry ? <div className="hint" role="alert">Choose a time in the future.</div> : null}
        </div>
        <div className="field">
          <label htmlFor="bg-cap">Spend cap in USD (optional)</label>
          <input id="bg-cap" type="number" min={0} step="0.01" value={spendCap} onChange={(event) => setSpendCap(event.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="bg-note">Note (optional)</label>
        <input id="bg-note" type="text" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {grant.error ? <NetworkProblem error={grant.error} /> : null}
      {grant.data && !grant.data.ok ? <ErrorBanner error={grant.data.error} /> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={grant.isPending || invalidExpiry || maxStarts < 1 || maxSubmissions < 1}>{grant.isPending ? "Granting…" : "Grant budget"}</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function RevokeRow({ budget }: { budget: Budget }) {
  const revoke = useMutationOperation("budget.revoke");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <button type="button" className="danger" onClick={() => setOpen(true)}>Revoke</button>;
  return (
    <form
      className="row"
      onSubmit={(event) => { event.preventDefault(); void revoke.mutateAsync({ input: { budgetId: budget.budgetId, reason: reason.trim() } }).then((result) => { if (result.ok) setOpen(false); }); }}
    >
      <label className="sr-only" htmlFor={`revoke-${budget.budgetId}`}>Reason for revoking</label>
      <input id={`revoke-${budget.budgetId}`} type="text" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (required)" />
      <button type="submit" className="danger" disabled={reason.trim() === "" || revoke.isPending}>Confirm revoke</button>
      <button type="button" onClick={() => setOpen(false)}>Keep</button>
      {revoke.data && !revoke.data.ok ? <span role="alert">{revoke.data.error.message}</span> : null}
    </form>
  );
}

export function BudgetPanel({ assetId, grantOpen, onGrantOpen }: { assetId: string; grantOpen: boolean; onGrantOpen: (open: boolean) => void }) {
  const [showInactive, setShowInactive] = useState(false);
  const query = useOperation("budget.list", { assetId, includeInactive: showInactive });
  return (
    <section className="panel" id="budgets" aria-labelledby="budgets-title">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h2 id="budgets-title" style={{ margin: 0 }}>Generation budgets</h2>
        <div className="row">
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />Show expired and revoked</label>
          {grantOpen ? null : <button type="button" onClick={() => onGrantOpen(true)}>Grant budget</button>}
        </div>
      </div>
      {grantOpen ? <GrantForm assetId={assetId} onDone={() => onGrantOpen(false)} /> : null}
      {query.error ? <NetworkProblem error={query.error} /> : null}
      {!query.data && !query.error ? <p className="secondary" role="status">Loading budgets…</p> : null}
      {query.data && !query.data.ok ? <ErrorBanner error={query.data.error} /> : null}
      {query.data?.ok && query.data.data.budgets.length === 0 ? (
        <p className="secondary">{showInactive ? "No budgets have been granted for this asset." : "No active budget. Generation cannot start until you grant one."}</p>
      ) : null}
      {query.data?.ok && query.data.data.budgets.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Generation budgets</caption>
            <thead><tr><th>Status</th><th>Starts</th><th>Submissions</th><th>Spend</th><th>Expires</th><th>Note</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {query.data.data.budgets.map((budget) => (
                <tr key={budget.budgetId}>
                  <td><Status tone={STATUS_TONE[budget.status]}>{budget.status}</Status></td>
                  <td>{budget.usedStarts} of {budget.maxStarts} used · {Math.max(0, budget.maxStarts - budget.usedStarts)} left</td>
                  <td>{budget.usedCandidateSubmissions} of {budget.maxCandidateSubmissions} used · {Math.max(0, budget.maxCandidateSubmissions - budget.usedCandidateSubmissions)} left</td>
                  <td>{budget.spendCapUsd !== undefined ? `$${budget.spentUsd.toFixed(2)} of $${budget.spendCapUsd.toFixed(2)}` : budget.spentUsd > 0 ? `$${budget.spentUsd.toFixed(2)}` : "no cap"}</td>
                  <td>{formatTime(budget.expiresAt)}</td>
                  <td>{budget.note ?? "—"}<div className="secondary">by {budget.createdBy}</div></td>
                  <td>{budget.status === "active" ? <RevokeRow budget={budget} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
