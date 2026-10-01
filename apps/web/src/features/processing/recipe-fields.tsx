import { useEffect, useState, type ReactNode } from "react";

/** Number input that keeps the user's partial typing ("0.") while committing every valid value immediately. */
export function NumberField({ id, label, value, onCommit, min, max, step = 1, integer = false }: {
  id: string; label: string; value: number; onCommit: (next: number) => void; min?: number; max?: number; step?: number; integer?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft((current) => (current.trim() !== "" && Number(current) === value ? current : String(value)));
  }, [value]);
  return (
    <div className="field compact">
      <label htmlFor={id}>{label}</label>
      <input
        id={id} type="number" inputMode="decimal" value={draft} min={min} max={max} step={step}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = Number(text);
          if (text.trim() === "" || !Number.isFinite(next)) return;
          if (integer && !Number.isInteger(next)) return;
          onCommit(next);
        }}
      />
    </div>
  );
}

/** Where a recipe field's value came from, with a way back to the default once the user changed it. */
export function FieldSource({ edited, source, onReset }: { edited: boolean; source: string | undefined; onReset: () => void }) {
  return (
    <div className="hint field-source">
      {edited
        ? <>Edited here. <button type="button" className="link" onClick={onReset}>Use the default again</button></>
        : <>Source: <span className="mono">{source ?? "built-in default"}</span></>}
    </div>
  );
}

export function RecipeGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="recipe-group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}
