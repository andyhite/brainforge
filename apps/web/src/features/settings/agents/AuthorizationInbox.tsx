import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuthorizationRequest as Request } from "@brainforge/contracts";
import { AuthorizationStatus } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../../api/hooks.ts";
import { Banner, EmptyState, ErrorBanner, Modal, NetworkProblem, Status, formatTime, type Tone } from "../../../components/ui.tsx";

const STATUS_TONE: Record<AuthorizationStatus, Tone> = {
  pending: "warn", granted: "ok", denied: "bad", revoked: "bad", expired: "idle", withdrawn: "idle",
};

function defaultExpiry(): string {
  const date = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Dialog = { kind: "grant" | "deny" | "revoke"; request: Request };

function GrantModal({ request, onClose, onDone }: { request: Request; onClose: () => void; onDone: (text: string) => void }) {
  const grant = useMutationOperation("authorization.grant");
  const [selected, setSelected] = useState<Set<string>>(new Set(request.requested.capabilities));
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [error, setError] = useState<string | undefined>();
  const failure = grant.data && !grant.data.ok ? grant.data.error : undefined;
  const projectRoot = request.requested.scope === "project" ? request.requested.projectRoot : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const when = new Date(expiry);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) { setError("Choose an expiry in the future."); return; }
    const capabilities = request.requested.capabilities.filter((c) => selected.has(c));
    if (capabilities.length === 0) { setError("Select at least one capability."); return; }
    setError(undefined);
    const result = await grant.mutateAsync({
      input: { authorizationRequestId: request.authorizationRequestId, capabilities, expiresAt: when.toISOString(), ...(projectRoot ? { projectRoot } : {}) },
      project: null,
    });
    if (result.ok) onDone(`Granted ${capabilities.join(", ")} to ${request.requester.name} until ${formatTime(when.toISOString())}.`);
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={`Grant access to ${request.requester.name}`} description="Granting is limited to what was requested; you can only narrow it.">
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <fieldset>
          <legend>Capabilities to grant (you can only narrow the request)</legend>
          {request.requested.capabilities.map((capability) => (
            <div key={capability}>
              <input
                type="checkbox"
                id={`grant-cap-${capability}`}
                checked={selected.has(capability)}
                onChange={(event) => setSelected((prev) => { const next = new Set(prev); if (event.target.checked) next.add(capability); else next.delete(capability); return next; })}
              />{" "}
              <label htmlFor={`grant-cap-${capability}`}>{capability}</label>
            </div>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="grant-expiry">Expires (required)</label>
          <input id="grant-expiry" type="datetime-local" required value={expiry} onChange={(event) => setExpiry(event.target.value)} />
        </div>
        {projectRoot ? (
          <div className="field">
            <span id="grant-root-label">Project root</span>
            <code aria-labelledby="grant-root-label">{projectRoot}</code>
          </div>
        ) : null}
        {error ? <Banner tone="bad" title={error} /> : null}
        {failure ? <ErrorBanner error={failure} /> : null}
        {grant.error ? <NetworkProblem error={grant.error} /> : null}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={grant.isPending}>{grant.isPending ? "Granting…" : "Grant access"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ReasonModal({ kind, request, onClose, onDone }: { kind: "deny" | "revoke"; request: Request; onClose: () => void; onDone: (text: string) => void }) {
  const deny = useMutationOperation("authorization.deny");
  const revoke = useMutationOperation("authorization.revoke");
  const mutation = kind === "deny" ? deny : revoke;
  const [reason, setReason] = useState("");
  const failure = mutation.data && !mutation.data.ok ? mutation.data.error : undefined;
  const verb = kind === "deny" ? "Deny" : "Revoke";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = { authorizationRequestId: request.authorizationRequestId, reason: reason.trim() };
    const result = kind === "deny" ? await deny.mutateAsync({ input, project: null }) : await revoke.mutateAsync({ input, project: null });
    if (result.ok) onDone(`${kind === "deny" ? "Denied" : "Revoked"} the request from ${request.requester.name}.`);
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={`${verb} ${request.requester.name}`} description={kind === "deny" ? "The agent will see the reason you give." : "Ends the active grant immediately."}>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor={`${kind}-reason`}>Reason (required)</label>
          <textarea id={`${kind}-reason`} required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        {failure ? <ErrorBanner error={failure} /> : null}
        {mutation.error ? <NetworkProblem error={mutation.error} /> : null}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={mutation.isPending || reason.trim() === ""}>{mutation.isPending ? `${verb === "Deny" ? "Denying" : "Revoking"}…` : verb}</button>
        </div>
      </form>
    </Modal>
  );
}

function RequestRow({ request, focused, onAction }: { request: Request; focused: boolean; onAction: (dialog: Dialog) => void }) {
  const ref = useRef<HTMLTableRowElement>(null);
  const [open, setOpen] = useState(focused);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "center" });
    ref.current?.focus();
  }, [focused]);
  const { requested, granted } = request;
  return (
    <tr ref={ref} tabIndex={-1} className={focused ? "highlight" : undefined} id={`request-${request.authorizationRequestId}`}>
      <td>
        <strong>{request.requester.name}</strong>
        <div className="secondary"><code>{request.requester.actorId}</code></div>
      </td>
      <td><Status tone={STATUS_TONE[request.status]}>{request.status}</Status></td>
      <td>
        {requested.capabilities.join(", ")}
        <div className="secondary">{requested.scope}{requested.projectRoot ? <> · <code>{requested.projectRoot}</code></> : null}</div>
      </td>
      <td>
        <div>{requested.reason}</div>
        {request.reason ? <div className="secondary">{request.status === "denied" ? "Denied" : request.status === "revoked" ? "Revoked" : "Note"}: {request.reason}</div> : null}
      </td>
      <td className="secondary">
        <div>Created {formatTime(request.createdAt)}</div>
        <div>Expires {formatTime(request.expiresAt)}</div>
        {granted ? <div>Granted: {granted.capabilities.join(", ")} until {formatTime(granted.expiresAt)}</div> : null}
        {request.decidedBy ? <div>By {request.decidedBy} {formatTime(request.decidedAt)}</div> : null}
      </td>
      <td>
        <div className="row">
          {request.status === "pending" ? (
            <>
              <button type="button" onClick={() => onAction({ kind: "grant", request })}>Grant…</button>
              <button type="button" onClick={() => onAction({ kind: "deny", request })}>Deny…</button>
            </>
          ) : null}
          {request.status === "granted" ? <button type="button" onClick={() => onAction({ kind: "revoke", request })}>Revoke…</button> : null}
        </div>
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>Inspect</summary>
          <pre className="secondary">{JSON.stringify(request, null, 2)}</pre>
        </details>
      </td>
    </tr>
  );
}

function RequestTable({ requests, focusId, onAction }: { requests: Request[]; focusId: string | null; onAction: (dialog: Dialog) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Requester</th><th>Status</th><th>Requested</th><th>Reason</th><th>Times</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <RequestRow key={request.authorizationRequestId} request={request} focused={request.authorizationRequestId === focusId} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuthorizationInbox() {
  const [params] = useSearchParams();
  const focusId = params.get("request");
  const [status, setStatus] = useState<AuthorizationStatus | "">("");
  const [dialog, setDialog] = useState<Dialog | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const list = useOperation("authorization.list", status ? { status } : {}, { project: null, refetchInterval: 10000 });
  const listed = list.data?.ok ? list.data.data.requests : undefined;
  const inList = focusId !== null && listed?.some((r) => r.authorizationRequestId === focusId) === true;
  const inspect = useOperation("authorization.inspect", { authorizationRequestId: focusId ?? "" }, { project: null, enabled: focusId !== null && listed !== undefined && !inList });
  const extra = inspect.data?.ok ? inspect.data.data.request : undefined;
  const extraFailure = inspect.data && !inspect.data.ok ? inspect.data.error : undefined;

  return (
    <section className="panel stack" aria-labelledby="inbox-h">
      <h2 id="inbox-h">Authorization inbox</h2>
      <p className="secondary">Agents ask for access here. Only you can grant, deny or revoke.</p>
      <div className="field">
        <label htmlFor="inbox-status">Status</label>
        <select id="inbox-status" value={status} onChange={(event) => setStatus(AuthorizationStatus.safeParse(event.target.value).data ?? "")}>
          <option value="">All</option>
          {AuthorizationStatus.options.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {success ? <div role="status"><Status tone="ok">{success}</Status></div> : null}
      {extra ? (
        <div className="stack">
          <p className="secondary">Linked request (outside the current filter):</p>
          <RequestTable requests={[extra]} focusId={focusId} onAction={setDialog} />
        </div>
      ) : null}
      {extraFailure ? <ErrorBanner error={extraFailure} /> : null}
      {list.isPending ? <p className="secondary" role="status">Loading requests…</p> : null}
      {list.error ? <NetworkProblem error={list.error} /> : null}
      {list.data && !list.data.ok ? <ErrorBanner error={list.data.error} /> : null}
      {listed && listed.length === 0 ? <EmptyState title="No requests">Nothing matches this filter. Agents create requests with authorization.request.</EmptyState> : null}
      {listed && listed.length > 0 ? <RequestTable requests={listed} focusId={focusId} onAction={setDialog} /> : null}
      {dialog?.kind === "grant" ? (
        <GrantModal request={dialog.request} onClose={() => setDialog(undefined)} onDone={(text) => { setSuccess(text); setDialog(undefined); }} />
      ) : null}
      {dialog && dialog.kind !== "grant" ? (
        <ReasonModal kind={dialog.kind} request={dialog.request} onClose={() => setDialog(undefined)} onDone={(text) => { setSuccess(text); setDialog(undefined); }} />
      ) : null}
    </section>
  );
}
