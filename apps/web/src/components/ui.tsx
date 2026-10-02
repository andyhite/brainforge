import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { Link, NavLink } from "react-router-dom";
import { callOperation } from "../api/client.ts";
import { useProjectRoot } from "../lib/project-context.tsx";
import { paths } from "../lib/paths.ts";
import type { NextAction, OperationError, OperationName, OperationResult, Problem, RecoveryAction } from "@brainforge/contracts";
import { Icon, type IconName } from "./Icon.tsx";

export type Tone = "ok" | "warn" | "bad" | "info" | "idle";

/** Status is always icon plus text, never colour alone. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status ${tone}`}>
      <Icon name={tone} />
      <span>{children}</span>
    </span>
  );
}

export function Banner({ tone, title, children, actions }: { tone: Exclude<Tone, "idle">; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon name={tone} />
      <div className="body">
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
        {actions ? <div className="row" style={{ marginTop: 10 }}>{actions}</div> : null}
      </div>
    </div>
  );
}

export function NetworkProblem({ error }: { error: { message: string } }) {
  return <Banner tone="bad" title="Can’t reach the Brainforge server">{error.message} Start it with <code>bun run server</code>, then retry.</Banner>;
}

interface QueryLike<D> { error: { message: string } | null; data: OperationResult<D> | undefined }

/** The query gate: a node to render while there is no ok data (offline, loading, server error), else the data. */
export function gate<D>(q: QueryLike<D>, loading: string, status = true): { node: ReactNode } | { data: D } {
  if (q.error) return { node: <NetworkProblem error={q.error} /> };
  if (!q.data) return { node: <p className="secondary" role={status ? "status" : undefined}>{loading}</p> };
  if (!q.data.ok) return { node: <ErrorBanner error={q.data.error} /> };
  return { data: q.data.data };
}

/** The tail of a mutation: offline or the server's own error, nothing otherwise. */
export function OpResult({ m }: { m: { error: { message: string } | null; data?: OperationResult | undefined } }) {
  return (
    <>
      {m.error ? <NetworkProblem error={m.error} /> : null}
      {m.data && !m.data.ok ? <ErrorBanner error={m.data.error} /> : null}
    </>
  );
}

/** Runs server-described actions in order, stopping at the first failure. `busy.step` is the action running now. */
export function useRunAction() {
  const queryClient = useQueryClient();
  const { root } = useProjectRoot();
  const [busy, setBusy] = useState<{ label: string; step: number } | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const run = async (label: string, actions: Array<RecoveryAction | NextAction>) => {
    setFailure(undefined);
    try {
      for (const [step, action] of actions.entries()) {
        if (!action.operation) continue;
        setBusy({ label, step });
        // Operation name and input arrive from the server, not from client logic.
        const result = await callOperation(action.operation as OperationName, { project: root, input: action.input as never });
        if (!result.ok) { setFailure(result.error.message); return; }
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(undefined);
      void queryClient.invalidateQueries({ queryKey: ["op"] });
    }
  };
  return { busy, failure, run };
}

/** An action with something to run; the rest is guidance, shown as words. */
export const isRunnable = (action: RecoveryAction | NextAction): boolean => Boolean(action.url || (action.operation && action.input !== undefined));

/** Actions whose point is their answer (a plan, a list): run in place they would show nothing, so they open the page that shows it. */
function pageFor(action: RecoveryAction | NextAction): string | undefined {
  const input: unknown = action.input;
  const assetId = typeof input === "object" && input !== null && "assetId" in input && typeof input.assetId === "string" ? input.assetId : undefined;
  if (!assetId) return undefined;
  if (action.operation === "promotion.plan") return paths.assetVersions(assetId, { plan: true });
  if (action.operation === "version.list") return paths.assetVersions(assetId);
  return undefined;
}

/** Server-provided next or recovery actions, run as the server described them or opened where their answer shows. */
export function ActionLinks({ actions, primary }: { actions: Array<RecoveryAction | NextAction>; primary?: boolean }) {
  const { busy, failure, run } = useRunAction();
  const runnable = actions.filter(isRunnable);
  const words = actions.filter((action) => !isRunnable(action));
  if (actions.length === 0) return null;
  return (
    <>
      {runnable.map((action, index) => {
        const page = pageFor(action);
        return action.url ? (
          <a key={`${action.label}-${action.url}`} className={`button sm${primary && index === 0 ? " primary" : ""}`} href={action.url}>{action.label}</a>
        ) : page ? (
          <Link key={action.label} className={`button sm${primary && index === 0 ? " primary" : ""}`} to={page}>{action.label}</Link>
        ) : (
          <button key={action.label} type="button" className={`sm${primary && index === 0 ? " primary" : ""}`} onClick={() => void run(action.label, [action])} disabled={busy !== undefined}>{busy?.label === action.label ? "Working…" : action.label}</button>
        );
      })}
      {words.map((action) => <div key={action.label} className="secondary">{action.label}</div>)}
      {failure ? <span role="alert" className="status bad"><Icon name="bad" /><span>{failure}</span></span> : null}
    </>
  );
}

/** Operation error with the server's own recovery actions: nothing is re-derived client-side. */
export function ErrorBanner({ error, extra }: { error: OperationError; extra?: ReactNode }) {
  const words = error.code.replaceAll("_", " ").toLowerCase();
  return (
    <Banner tone="bad" title={words.charAt(0).toUpperCase() + words.slice(1)} actions={<><ActionLinks actions={error.recoveryActions} />{extra}</>}>
      <div>{error.message}</div>
    </Banner>
  );
}

/** Plan blockers as warn banners; the server's recovery actions run, and the ones with nothing to run read as words. */
export function Blockers<B extends { code: string; message: string; recoveryActions: RecoveryAction[] }>({ items, label, title, actions, children }: {
  items: B[]; label: string; title?: string; actions?: (blocker: B) => ReactNode; children?: (blocker: B) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="rel-blockers plain-list" aria-label={label}>
      {items.map((blocker) => (
        <li key={`${blocker.code}-${blocker.message}`}>
          <Banner tone="warn" title={title ?? blocker.code.replaceAll(/[-_]/g, " ").toLowerCase()} actions={<>{actions?.(blocker)}<ActionLinks actions={blocker.recoveryActions} /></>}>
            {blocker.message}
            {children?.(blocker)}
          </Banner>
        </li>
      ))}
    </ul>
  );
}

export function NextActions({ actions }: { actions: NextAction[] }) {
  if (actions.length === 0) return null;
  return (
    <ul className="secondary" style={{ margin: 0, paddingLeft: 18 }} aria-label="Suggested next actions">
      {actions.map((action) => (
        <li key={action.label}>{action.url ? <a href={action.url}>{action.label}</a> : action.label}</li>
      ))}
    </ul>
  );
}

/** Where a problem's field lives in the current editor, as a label and a way to go there. */
export type LocateProblem = (problem: Problem) => { label: string; go: () => void } | undefined;

export function ProblemList({ problems, blocked, onOpenFile, locate }: { problems: Problem[]; blocked?: string; onOpenFile?: (file: string) => string; locate?: LocateProblem }) {
  if (problems.length === 0) return null;
  return (
    <div>
      {blocked ? <p className="secondary" style={{ margin: "8px 0" }}>{blocked}</p> : null}
      <ul className="problem-list" aria-label="Problems">
        {problems.map((problem, index) => {
          const target = locate?.(problem);
          return (
            <li key={`${problem.file ?? ""}-${problem.line ?? ""}-${problem.column ?? ""}-${index}`}>
              <Status tone={problem.severity === "warning" ? "warn" : "bad"}>{problem.severity === "warning" ? "Warning" : "Error"}</Status>
              <span>
                {target ? <button type="button" className="link mono" onClick={target.go}>{target.label}</button> : (
                  <>
                    {problem.file ? (onOpenFile ? <Link to={onOpenFile(problem.file)} className="mono">{problem.file}</Link> : <code>{problem.file}</code>) : null}
                    {problem.line !== undefined ? <span className="mono"> {problem.line}:{problem.column ?? 1}</span> : null}
                    {problem.field ? <span className="mono"> · {problem.field}</span> : null}
                  </>
                )}
                <br />
                {problem.message}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PageHeader({ title, lede, children }: { title: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="page-lede">{lede}</p> : null}
      </div>
      {children ? <div className="page-header-actions">{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <div className="empty-state-body">{children}</div>
    </div>
  );
}

/**
 * Opens the dialog modally while `open`; Esc or a click on the backdrop calls `onClose`, and closing returns focus
 * to whatever opened it. Spread the result onto the `<dialog>`.
 */
export function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  // A drag that starts inside and ends on the backdrop also clicks the dialog itself; only a press that began there closes.
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);
  return {
    ref,
    onCancel: (event: SyntheticEvent) => { event.preventDefault(); onClose(); },
    onPointerDown: (event: ReactMouseEvent) => { pressedBackdrop.current = event.target === event.currentTarget; },
    onClick: (event: ReactMouseEvent) => { if (pressedBackdrop.current && event.target === event.currentTarget) onClose(); },
  };
}

/** Native modal dialog: Esc and a click on the backdrop close it; focus is trapped and restored by the browser. */
export function Modal({ open, onOpenChange, title, description, children, wide = false }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; children: ReactNode; wide?: boolean;
}) {
  const id = useId();
  const dialog = useModalDialog(open, () => onOpenChange(false));
  return (
    <dialog {...dialog} className={`dialog${wide ? " wide" : ""}`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      {open ? (
        <div className="dialog-body">
          <h2 className="dialog-title" id={`${id}-title`}>{title}</h2>
          <div className="dialog-description" id={`${id}-description`}>{description}</div>
          <button type="button" className="icon-button sm dialog-close" aria-label="Close" onClick={() => onOpenChange(false)}><Icon name="close" /></button>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

interface MenuItem {
  label: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  /** In-app route. */
  to?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Marks the current choice in a menu of alternatives. */
  checked?: boolean;
}
export type MenuEntry = MenuItem | "separator" | { heading: string };

/** Button that opens a small menu. Arrow keys move, Escape closes and returns focus to the button. */
export function MenuButton({ trigger, label, items, align = "start", className = "", triggerClassName = "" }: {
  trigger: ReactNode; label: string; items: MenuEntry[]; align?: "start" | "end"; className?: string; triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    host.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(host.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (at + 1) % entries.length
      : event.key === "ArrowUp" ? (at - 1 + entries.length) % entries.length
        : event.key === "Home" ? 0
          : event.key === "End" ? entries.length - 1 : undefined;
    if (event.key === "Tab") setOpen(false);
    if (next === undefined || entries.length === 0) return;
    event.preventDefault();
    entries[next]?.focus();
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className={`menu-host${className ? ` ${className}` : ""}`} ref={host}>
      <button ref={button} type="button" className={triggerClassName} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}>
        {trigger}
      </button>
      {open ? (
        <div className="menu" role="menu" id={menuId} aria-label={label} data-align={align} onKeyDown={move}>
          {items.map((entry, index) => {
            if (entry === "separator") return <div key={`sep-${index}`} className="menu-sep" role="separator" />;
            if ("heading" in entry) return <div key={`h-${entry.heading}`} className="menu-label">{entry.heading}</div>;
            const role = entry.checked === undefined ? "menuitem" : "menuitemradio";
            const body = (
              <>
                {entry.icon ? <Icon name={entry.icon} /> : entry.checked !== undefined ? <span style={{ width: 16, display: "inline-grid" }}>{entry.checked ? <Icon name="check" /> : null}</span> : null}
                <span style={{ minWidth: 0 }}>{entry.label}{entry.description ? <span className="menu-desc">{entry.description}</span> : null}</span>
              </>
            );
            const className = `menu-item${entry.danger ? " danger" : ""}`;
            return entry.to && !entry.disabled ? (
              <Link key={index} role={role} aria-checked={entry.checked} className={`button ${className}`} to={entry.to} onClick={() => setOpen(false)}>{body}</Link>
            ) : (
              <button key={index} type="button" role={role} aria-checked={entry.checked} className={className} disabled={entry.disabled} onClick={() => { close(); entry.onSelect?.(); }}>{body}</button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Secondary navigation between views of one place (asset tabs, settings sections). */
export function SubNav({ label, items }: { label: string; items: ReadonlyArray<{ to: string; label: ReactNode; end?: boolean }> }) {
  return (
    <nav className="subtabs" aria-label={label}>
      {items.map((item) => <NavLink key={item.to} to={item.to} end={item.end}>{item.label}</NavLink>)}
    </nav>
  );
}

/** Segmented control: one pressed choice among a few. */
export function Seg<T extends string>({ label, value, options, onChange, className = "" }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>; onChange: (value: T) => void; className?: string;
}) {
  return (
    <div className={`seg${className ? ` ${className}` : ""}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} title={option.title} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/** One output on a transparency checker, contained and never cropped. */
export function Art({ src, alt = "", pixel = false, className = "", children }: { src?: string; alt?: string; pixel?: boolean; className?: string; children?: ReactNode }) {
  return (
    <div className={`art checker${pixel ? " pixel" : ""}${className ? ` ${className}` : ""}`}>
      {src ? <img src={src} alt={alt} loading="lazy" decoding="async" /> : null}
      {children}
    </div>
  );
}

export type CellState = "done" | "wait" | "block" | "bad" | "todo";

/** One tiny cell per deliverable: progress read as a pattern. Filled done, ringed waiting for you, amber blocked, red failed, hollow to do. */
export function MiniSheet({ cells, label, large = false }: { cells: readonly CellState[]; label: string; large?: boolean }) {
  return (
    <span className={`mini${large ? " lg" : ""}`} role="img" aria-label={label}>
      {cells.map((cell, index) => <b key={index} className={cell === "todo" ? undefined : cell} />)}
    </span>
  );
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12], ["year", Number.POSITIVE_INFINITY]];

/** "just now", "5 minutes ago", "yesterday"; the exact time belongs in a title attribute. */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  let value = (at - now) / 1000;
  if (Math.abs(value) < 45) return "just now";
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return RELATIVE.format(Math.round(value), unit);
    value /= size;
  }
  return formatTime(iso);
}
