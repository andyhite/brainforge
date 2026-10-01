import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Document } from "yaml";
import type { FamilyProfile, Problem } from "@brainforge/contracts";
import { fieldName, isPlaceholder, normalizeField, setAt, type Path } from "./yaml-patch.ts";

export interface EditorContext {
  data: Record<string, unknown>;
  profile: FamilyProfile | undefined;
  problems: Problem[];
  /** Applies a patch to the draft text through the YAML document (comments survive). */
  patch: (fn: (doc: Document) => void) => void;
  disabled: boolean;
  assetId: string;
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

const idOf = (path: Path): string => `fe-${path.join("-").replace(/[^\w-]/g, "_")}`;

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
          <span aria-hidden="true">{p.severity === "warning" ? "▲ " : "✖ "}</span>
          <span className="sr-only">{p.severity === "warning" ? "Warning: " : "Error: "}</span>
          {p.message}
        </p>
      ))}
    </div>
  );
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
            {placeholderText ? <p className="field-warn"><span aria-hidden="true">▲ </span>Placeholder — replace the “REPLACE:” text with a concrete description.</p> : null}
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
            {placeholderText ? <p className="field-warn"><span aria-hidden="true">▲ </span>Placeholder — replace the “REPLACE:” text with a concrete description.</p> : null}
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
        <span className="row" style={{ gap: 8 }}>
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

/** Pick several of the given values (checkbox group). */
export function MultiPick({ path, label, options, hint, emptyText }: { path: Path; label: string; options: string[]; hint?: ReactNode; emptyText: string }) {
  const { data, patch, disabled, problems } = useEditor();
  const raw = getAt(data, path);
  const selected = Array.isArray(raw) ? raw.map(String) : [];
  const id = idOf(path);
  const mine = problemsFor(problems, path);
  const all = [...options, ...selected.filter((s) => !options.includes(s))];
  return (
    <fieldset className="pick-group" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend>{label}</legend>
      {all.length === 0 ? <p className="secondary">{emptyText}</p> : (
        <div className="row" style={{ gap: 12 }}>
          {all.map((option) => {
            const checked = selected.includes(option);
            return (
              <label key={option} className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => {
                    const next = e.target.checked ? [...selected, option] : selected.filter((s) => s !== option);
                    patch((doc) => setAt(doc, path, next.length === 0 ? undefined : next));
                  }}
                />
                {option}{options.includes(option) ? "" : " (unknown)"}
              </label>
            );
          })}
        </div>
      )}
      {hint ? <div id={`${id}-hint`} className="hint">{hint}</div> : null}
      <FieldProblems id={`${id}-problems`} problems={mine} />
    </fieldset>
  );
}

export function Group({ legend, hint, children }: { legend: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="recipe-group fam-group">
      <legend>{legend}</legend>
      {hint ? <p className="secondary" style={{ marginTop: 0 }}>{hint}</p> : null}
      {children}
    </fieldset>
  );
}
