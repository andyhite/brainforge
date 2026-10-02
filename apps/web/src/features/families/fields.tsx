import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Document } from "yaml";
import type { FamilyProfile, Problem } from "@brainforge/contracts";
import { fieldName, isPlaceholder, normalizeField, setAt, type Path } from "./yaml-patch.ts";
import { Icon } from "../../components/Icon.tsx";

export interface EditorContext {
  data: Record<string, unknown>;
  profile: FamilyProfile | undefined;
  problems: Problem[];
  /** Applies a patch to the draft text through the YAML document (comments survive). */
  patch: (fn: (doc: Document) => void) => void;
  disabled: boolean;
  assetId: string;
  /** Parts showing their fields instead of their text: "identity", "style", "deliverable:<id>", … */
  open: ReadonlySet<string>;
  setOpen: (part: string, open: boolean) => void;
}

export const Ctx = createContext<EditorContext | undefined>(undefined);
export function useEditor(): EditorContext {
  const value = useContext(Ctx);
  if (!value) throw new Error("Editor field used outside FamilyEditor");
  return value;
}

export function getAt(data: unknown, path: Path): unknown {
  let cur: unknown = data;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export const idOf = (path: Path): string => `fe-${path.join("-").replace(/[^\w-]/g, "_")}`;

/** Problems that belong to this exact field or anything beneath it. */
export function problemsFor(problems: Problem[], path: Path): Problem[] {
  const name = fieldName(path);
  return problems.filter((p) => {
    if (!p.field) return false;
    const field = normalizeField(p.field);
    return field === name || field.startsWith(`${name}.`) || field.startsWith(`${name}[`);
  });
}

export function FieldProblems({ id, problems }: { id: string; problems: Problem[] }) {
  // The placeholder itself is highlighted in the input; its warning is listed in the summary.
  const shown = problems.filter((p) => !p.message.startsWith("Unfinished placeholder"));
  if (shown.length === 0) return null;
  return (
    <div id={id}>
      {shown.map((p, i) => (
        <p key={i} className={p.severity === "warning" ? "field-warn" : "field-error"}>
          <Icon name={p.severity === "warning" ? "warn" : "bad"} />{" "}
          <span className="sr-only">{p.severity === "warning" ? "Warning: " : "Error: "}</span>
          {p.message}
        </p>
      ))}
    </div>
  );
}

/** The count of problems inside a part that is not showing its fields: "2 to fix", else "1 to finish". */
export function ProblemFlag({ problems }: { problems: Problem[] }) {
  const errors = problems.filter((p) => p.severity !== "warning").length;
  if (problems.length === 0) return null;
  return errors > 0
    ? <span className="spec-flag bad"><Icon name="bad" size="sm" />{errors} to fix</span>
    : <span className="spec-flag warn"><Icon name="warn" size="sm" />{problems.length} to finish</span>;
}

interface FieldBase {
  path: Path;
  label: string;
  hint?: ReactNode;
  compact?: boolean;
  /** Problems are matched on this path instead (for fields that share one error). */
  errorPath?: Path;
}

function Wrap({ path, label, hint, compact, errorPath, children, labelFor = true }: FieldBase & { children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode; labelFor?: boolean }) {
  const { problems } = useEditor();
  const id = idOf(path);
  const mine = problemsFor(problems, errorPath ?? path);
  const describedBy = [hint ? `${id}-hint` : "", mine.length > 0 ? `${id}-problems` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field${compact ? " compact" : ""}`}>
      {labelFor ? <label htmlFor={id}>{label}</label> : <span className="label-text">{label}</span>}
      {children({ id, describedBy, invalid: mine.some((p) => p.severity !== "warning") })}
      {hint ? <div id={`${id}-hint`} className="hint">{hint}</div> : null}
      <FieldProblems id={`${id}-problems`} problems={mine} />
    </div>
  );
}

export function TextField({ path, area, placeholder, ...base }: FieldBase & { area?: boolean; placeholder?: string }) {
  const { data, patch, disabled } = useEditor();
  const raw = getAt(data, path);
  const value = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
  const placeholderText = isPlaceholder(value);
  return (
    <Wrap path={path} {...base}>
      {({ id, describedBy, invalid }) => {
        const common = {
          id,
          value,
          disabled,
          placeholder,
          "aria-invalid": invalid || undefined,
          "aria-describedby": describedBy,
          className: placeholderText ? "is-placeholder" : undefined,
          autoComplete: "off",
        };
        const onChange = (next: string) => patch((doc) => setAt(doc, path, next === "" ? undefined : next));
        return (
          <>
            {area ? <textarea rows={3} {...common} onChange={(e) => onChange(e.target.value)} /> : <input type="text" {...common} onChange={(e) => onChange(e.target.value)} />}
            {placeholderText ? <p className="field-warn"><Icon name="warn" />{" "}Placeholder — replace the “REPLACE:” text with a concrete description.</p> : null}
          </>
        );
      }}
    </Wrap>
  );
}

/** Text that must stay present (an empty value is written as an empty string so validation can name it). */
export function RequiredTextField(props: FieldBase & { area?: boolean }) {
  const { data, patch, disabled } = useEditor();
  const raw = getAt(data, props.path);
  const value = typeof raw === "string" ? raw : "";
  const placeholderText = isPlaceholder(value);
  return (
    <Wrap {...props}>
      {({ id, describedBy, invalid }) => {
        const common = { id, value, disabled, "aria-invalid": invalid || undefined, "aria-describedby": describedBy, className: placeholderText ? "is-placeholder" : undefined, autoComplete: "off" };
        const onChange = (next: string) => patch((doc) => setAt(doc, props.path, next));
        return (
          <>
            {props.area ? <textarea rows={3} {...common} onChange={(e) => onChange(e.target.value)} /> : <input type="text" {...common} onChange={(e) => onChange(e.target.value)} />}
            {placeholderText ? <p className="field-warn"><Icon name="warn" />{" "}Placeholder — replace the “REPLACE:” text with a concrete description.</p> : null}
          </>
        );
      }}
    </Wrap>
  );
}

export function NumberField({ path, min, step, unit, ...base }: FieldBase & { min?: number; step?: number; unit?: string }) {
  const { data, patch, disabled } = useEditor();
  const raw = getAt(data, path);
  const value = typeof raw === "number" ? raw : undefined;
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    const parsed = text.trim() === "" ? undefined : Number(text);
    if (parsed !== value && !(Number.isNaN(parsed) && value === undefined)) setText(value === undefined ? "" : String(value));
    // Only external changes resync; typing commits below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Wrap path={path} {...base}>
      {({ id, describedBy, invalid }) => (
        <span className="row">
          <input
            id={id}
            type="number"
            inputMode="decimal"
            value={text}
            min={min}
            step={step ?? "any"}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(e) => {
              setText(e.target.value);
              const trimmed = e.target.value.trim();
              if (trimmed === "") patch((doc) => setAt(doc, path, undefined));
              else if (Number.isFinite(Number(trimmed))) patch((doc) => setAt(doc, path, Number(trimmed)));
            }}
          />
          {unit ? <span className="secondary">{unit}</span> : null}
        </span>
      )}
    </Wrap>
  );
}

export function SelectField({ path, options, emptyLabel, onPick, ...base }: FieldBase & { options: Array<{ value: string; label: string }>; emptyLabel?: string; onPick?: (value: string, doc: Document) => void }) {
  const { data, patch, disabled } = useEditor();
  const raw = getAt(data, path);
  const value = typeof raw === "string" ? raw : "";
  const known = options.some((o) => o.value === value);
  return (
    <Wrap path={path} {...base}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            const next = e.target.value;
            patch((doc) => {
              setAt(doc, path, next === "" ? undefined : next);
              onPick?.(next, doc);
            });
          }}
        >
          {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
          {!known && value !== "" ? <option value={value}>{value} (not offered here)</option> : null}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Wrap>
  );
}

export function CheckField({ path, label, hint, onToggle, fallback = false }: { path: Path; label: string; hint?: ReactNode; fallback?: boolean; onToggle?: (value: boolean, doc: Document) => void }) {
  const { data, patch, disabled, problems } = useEditor();
  const raw = getAt(data, path);
  const id = idOf(path);
  const mine = problemsFor(problems, path);
  return (
    <div className="field compact">
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" checked={raw === undefined ? fallback : raw === true} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => patch((doc) => { setAt(doc, path, e.target.checked); onToggle?.(e.target.checked, doc); })} />
        {label}
      </label>
      {hint ? <div id={`${id}-hint`} className="hint">{hint}</div> : null}
      <FieldProblems id={`${id}-problems`} problems={mine} />
    </div>
  );
}

/** Comma/newline separated list of strings. */
export function ListField({ path, ...base }: FieldBase) {
  const { data, patch, disabled } = useEditor();
  const raw = getAt(data, path);
  const items = Array.isArray(raw) ? raw.map(String) : [];
  const [text, setText] = useState(items.join(", "));
  const joined = items.join(", ");
  useEffect(() => {
    const current = text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).join(", ");
    if (current !== joined) setText(joined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (
    <Wrap path={path} {...base}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          type="text"
          value={text}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            setText(e.target.value);
            const list = e.target.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
            patch((doc) => setAt(doc, path, list.length === 0 ? undefined : list));
          }}
        />
      )}
    </Wrap>
  );
}

/** Several of the given values: the chosen ones as removable chips, the rest in one Add select. */
export function MultiPick({ path, label, options, hint, emptyText }: { path: Path; label: string; options: string[]; hint?: ReactNode; emptyText: string }) {
  const { data, patch, disabled, problems } = useEditor();
  const raw = getAt(data, path);
  const selected = Array.isArray(raw) ? raw.map(String) : [];
  const id = idOf(path);
  const mine = problemsFor(problems, path);
  const rest = options.filter((option) => !selected.includes(option));
  return (
    <fieldset className="field" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend>{label}</legend>
      {options.length === 0 && selected.length === 0 ? <p className="secondary">{emptyText}</p> : (
        <div className="picks">
          {selected.map((value) => (
            <span key={value} className="pick">
              <code>{value}</code>
              {options.includes(value) ? null : <span className="faint">not in this asset</span>}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${value}`}
                onClick={(event) => {
                  const picks = event.currentTarget.closest(".picks");
                  const at = selected.indexOf(value);
                  patch((doc) => { const next = selected.filter((s) => s !== value); setAt(doc, path, next.length === 0 ? undefined : next); });
                  // The chip leaves with its button: focus moves to the next chip's, else to the Add select.
                  requestAnimationFrame(() => (picks?.querySelectorAll<HTMLElement>(".pick button")[at] ?? document.getElementById(id))?.focus());
                }}
              >
                <Icon name="close" size="sm" />
              </button>
            </span>
          ))}
          {rest.length > 0 ? (
            <select id={id} aria-label={`Add to ${label}`} value="" disabled={disabled} onChange={(e) => { const added = e.target.value; if (added !== "") patch((doc) => setAt(doc, path, [...selected, added])); }}>
              <option value="">{selected.length === 0 ? "Choose…" : "Add…"}</option>
              {rest.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : null}
        </div>
      )}
      {hint ? <div id={`${id}-hint`} className="hint">{hint}</div> : null}
      <FieldProblems id={`${id}-problems`} problems={mine} />
    </fieldset>
  );
}

export function Group({ legend, hint, children }: { legend: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="fam-group">
      <legend>{legend}</legend>
      {hint ? <p className="secondary">{hint}</p> : null}
      {children}
    </fieldset>
  );
}
