import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { runRecoveryOperation } from "../api/client.ts";
import { useProjectRoot } from "../lib/project-context.tsx";
import type { NextAction, OperationError, Problem, RecoveryAction } from "@brainforge/contracts";
export type Tone = "ok" | "warn" | "bad" | "info" | "idle";

const ICONS: Record<Tone, string> = { ok: "✓", warn: "▲", bad: "✖", info: "●", idle: "○" };

/** Status is always icon plus text, never colour alone. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status ${tone}`}>
      <span aria-hidden="true">{ICONS[tone]}</span>
      <span>{children}</span>
    </span>
  );
}

export function Banner({ tone, title, children, actions }: { tone: Exclude<Tone, "idle">; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <span aria-hidden="true">{ICONS[tone]}</span>
      <div className="body">
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
        {actions ? <div className="row" style={{ marginTop: 8 }}>{actions}</div> : null}
      </div>
    </div>
  );
}

export function NetworkProblem({ error }: { error: { message: string } }) {
  return <Banner tone="bad" title="Cannot reach the server">{error.message} The server may not be running; start it and reload.</Banner>;
}

function ActionLinks({ actions }: { actions: Array<RecoveryAction | NextAction> }) {
  const queryClient = useQueryClient();
  const { root } = useProjectRoot();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const visible = actions.filter((action) => action.url || (action.operation && action.input !== undefined));
  if (visible.length === 0) return null;
  const run = async (action: RecoveryAction | NextAction) => {
    if (!action.operation) return;
    setBusy(action.label);
    setFailure(undefined);
    try {
      const result = await runRecoveryOperation(action.operation, root, action.input);
      if (result.ok) void queryClient.invalidateQueries({ queryKey: ["op"] });
      else setFailure(result.error.message);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      {visible.map((action) =>
        action.url ? (
          <a key={`${action.label}-${action.url}`} className="button" href={action.url}>{action.label}</a>
        ) : (
          <button key={action.label} type="button" onClick={() => void run(action)} disabled={busy !== undefined}>{busy === action.label ? "Working…" : action.label}</button>
        ),
      )}
      {failure ? <span role="alert">{failure}</span> : null}
    </>
  );
}

/** Operation error with the server's own recovery actions: nothing is re-derived client-side. */
export function ErrorBanner({ error, extra }: { error: OperationError; extra?: ReactNode }) {
  const guidance = error.recoveryActions.filter((action) => !action.url && !(action.operation && action.input !== undefined));
  return (
    <Banner tone="bad" title={`${error.code.replaceAll("_", " ").toLowerCase()}`} actions={<><ActionLinks actions={error.recoveryActions} />{extra}</>}>
      <div>{error.message}</div>
      {guidance.length > 0 ? (
        <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
          {guidance.map((action) => <li key={action.label}>{action.label}</li>)}
        </ul>
      ) : null}
    </Banner>
  );
}

export function NextActions({ actions }: { actions: NextAction[] }) {
  if (actions.length === 0) return null;
  return (
    <ul className="secondary" style={{ paddingLeft: 20 }} aria-label="Suggested next actions">
      {actions.map((action) => (
        <li key={action.label}>{action.url ? <a href={action.url}>{action.label}</a> : action.label}</li>
      ))}
    </ul>
  );
}

export function ProblemList({ problems, blocked, onOpenFile }: { problems: Problem[]; blocked?: string; onOpenFile?: (file: string) => string }) {
  if (problems.length === 0) return null;
  return (
    <div>
      {blocked ? <p className="secondary" style={{ margin: "8px 0" }}>{blocked}</p> : null}
      <ul className="problem-list" aria-label="Problems">
        {problems.map((problem, index) => (
          <li key={`${problem.file ?? ""}-${problem.line ?? ""}-${problem.column ?? ""}-${index}`}>
            <Status tone="bad">Problem</Status>
            <span>
              {problem.file ? (onOpenFile ? <Link to={onOpenFile(problem.file)} className="mono">{problem.file}</Link> : <code>{problem.file}</code>) : null}
              {problem.line !== undefined ? <span className="mono"> {problem.line}:{problem.column ?? 1}</span> : null}
              {problem.field ? <span className="mono"> · {problem.field}</span> : null}
              <br />
              {problem.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
      <h1 style={{ margin: 0 }}>{title}</h1>
      {children ? <div className="row">{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <div className="secondary" style={{ fontSize: 15 }}>{children}</div>
    </div>
  );
}

/** Radix dialog with focus trap and focus restoration to the opener. */
export function Modal({ open, onOpenChange, title, description, children, dismissible = true }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; dismissible?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    if (open) return;
    // Dialogs are opened by state, not a Trigger: remember the last focused control so closing returns there.
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) opener.current = event.target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next || dismissible) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="secondary" style={{ marginBottom: 16 }}>{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
