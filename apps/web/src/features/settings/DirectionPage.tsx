import "./settings.css";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { parseDocument, type Document } from "yaml";
import { ConflictDialog, ExternalChangeBanner, SaveBar, SpecEditor } from "../../components/SpecEditor.tsx";
import { EffectiveSettings } from "../../components/EffectiveSettings.tsx";
import { PolicyPanel } from "../../components/PolicyPanel.tsx";
import { Banner, ErrorBanner } from "../../components/ui.tsx";
import { readField, readString, readStringList, splitList, writeField, type FieldPath } from "../../lib/yaml-fields.ts";
import { specRoute } from "../../lib/use-project.ts";
import { useSpecFile, type SpecFile } from "../../lib/spec-file.ts";

const PROJECT_FILE = "brainforge/project.yaml";
const REVIEW_OPTIONS = ["human", "agent", "agent_with_escalation"];

interface FieldProps {
  id: string;
  label: string;
  path: FieldPath;
  draft: string;
  doc: Document;
  file: SpecFile;
  hint?: string;
}

function TextField({ id, label, path, draft, file, doc, hint, optional, multiline }: FieldProps & { optional?: boolean; multiline?: boolean }) {
  const value = readString(doc, path);
  const onChange = (next: string) => file.setDraft(writeField(draft, path, optional && next === "" ? undefined : next));
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} rows={4} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input id={id} type="text" value={value} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint ? <span className="secondary">{hint}</span> : null}
    </div>
  );
}

function NumberField({ id, label, path, draft, file, doc, hint, required }: FieldProps & { required?: boolean }) {
  const value = readString(doc, path);
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | undefined>(undefined);
  // Follow the file when it changes from elsewhere (YAML view, reload), but not while an invalid entry is on screen.
  useEffect(() => {
    if (!error) setText(value);
  }, [value, error]);
  const onChange = (next: string) => {
    setText(next);
    const parsed = Number(next);
    if (next.trim() === "" || Number.isNaN(parsed)) {
      if (required && value !== "") {
        setError(`Required. The file keeps its last valid value (${value}).`);
        return;
      }
      setError(undefined);
      if (value !== "") file.setDraft(writeField(draft, path, undefined));
      return;
    }
    setError(undefined);
    file.setDraft(writeField(draft, path, parsed));
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" min={0} step="any" value={text} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => onChange(event.target.value)} />
      {error ? <span id={`${id}-error`} role="alert" className="secondary" style={{ color: "var(--danger)" }}>✖ {error}</span> : null}
      {hint ? <span className="secondary">{hint}</span> : null}
    </div>
  );
}

function SelectField({ id, label, path, draft, file, doc, hint, options }: FieldProps & { options: string[] }) {
  const value = readString(doc, path);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => file.setDraft(writeField(draft, path, event.target.value === "" ? undefined : event.target.value))}>
        {value === "" ? <option value="">(not set)</option> : null}
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      {hint ? <span className="secondary">{hint}</span> : null}
    </div>
  );
}

function ListField({ id, label, path, draft, file, doc, hint }: FieldProps) {
  const items = readStringList(doc, path);
  const [text, setText] = useState(items.join("\n"));
  // Re-sync only when the draft changed from elsewhere (YAML view, reload), not while typing.
  useEffect(() => {
    setText((current) => (splitList(current).join("\n") === items.join("\n") ? current : items.join("\n")));
  }, [items.join("\n")]);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={3}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          file.setDraft(writeField(draft, path, splitList(event.target.value)));
        }}
      />
      {hint ? <span className="secondary">{hint}</span> : null}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <fieldset className="settings-section">
      <legend><strong>{title}</strong></legend>
      <p className="secondary">{hint}</p>
      <div className="settings-fields">{children}</div>
    </fieldset>
  );
}

function FieldsForm({ file }: { file: SpecFile }) {
  const draft = file.draft;
  const doc = useMemo(() => parseDocument(draft), [draft]);
  if (doc.errors.length > 0) {
    return <Banner tone="warn" title="Fields unavailable">The YAML has syntax errors. Fix the YAML view first, then come back to the fields.</Banner>;
  }
  const common = { draft, file, doc };
  const autoRegenerate = readField(doc, ["automation", "autoRegenerate"]) === true;
  return (
    <form className="settings-stack" onSubmit={(event) => event.preventDefault()}>
      <Section title="Direction" hint="What this project looks like. Styles listed here are applied to every asset.">
        <TextField {...common} id="dir-name" label="Project name" path={["name"]} />
        <ListField {...common} id="dir-styles" label="Style ids" path={["styleIds"]} hint="Comma or one per line." />
        <TextField {...common} id="dir-art" label="Art direction" path={["artDirection"]} multiline />
      </Section>
      <Section title="Defaults" hint="Used by every asset unless the asset or its family overrides them.">
        <NumberField {...common} required id="dir-width" label="Canvas width (px)" path={["defaults", "sizing", "width"]} />
        <NumberField {...common} required id="dir-height" label="Canvas height (px)" path={["defaults", "sizing", "height"]} />
        <NumberField {...common} id="dir-subject" label="Subject height (px)" path={["defaults", "sizing", "subjectHeightPx"]} hint="Optional. Standing height of characters and creatures." />
        <NumberField {...common} id="dir-scale" label="Display scale" path={["defaults", "sizing", "displayScale"]} hint="Optional." />
        <NumberField {...common} required id="dir-fps" label="Playback frame rate (fps)" path={["defaults", "animation", "playbackFps"]} hint="Cannot be cleared once set; edit project.yaml directly to remove it." />
      </Section>
      <Section title="Export" hint="Where finished files go in your game project.">
        <SelectField {...common} id="dir-preset" label="Export preset" path={["export", "preset"]} options={["generic", "godot4"]} />
        <TextField {...common} id="dir-dest" label="Destination" path={["export", "destination"]} hint="Relative to the game root." />
        <TextField {...common} id="dir-godot" label="Godot project root" path={["export", "godotProjectRoot"]} optional hint="Relative to the game root. Empty means “.”." />
      </Section>
      <Section title="Approvals" hint="Who approves each step. Changes are requests until a human confirms them below.">
        <SelectField {...common} id="dir-concept" label="Concept lock" path={["approval", "conceptLock"]} options={REVIEW_OPTIONS} />
        <SelectField {...common} id="dir-review" label="Production review" path={["approval", "productionReview"]} options={REVIEW_OPTIONS} />
        <SelectField {...common} id="dir-promotion" label="Promotion" path={["approval", "promotion"]} options={REVIEW_OPTIONS} />
        <SelectField {...common} id="dir-activation" label="Activation" path={["approval", "activation"]} options={REVIEW_OPTIONS} />
      </Section>
      <Section title="Automation" hint="Limits for unattended generation work.">
        <NumberField {...common} required id="dir-attempts" label="Max attempts per step" path={["automation", "maxAttemptsPerStep"]} />
        <NumberField {...common} required id="dir-concurrent" label="Max concurrent generations" path={["automation", "maxConcurrentGenerations"]} />
        <NumberField {...common} required id="dir-batch" label="Max batch candidates" path={["automation", "maxBatchCandidates"]} />
        <div className="field">
          <label htmlFor="dir-auto">
            <input id="dir-auto" type="checkbox" checked={autoRegenerate} onChange={(event) => file.setDraft(writeField(draft, ["automation", "autoRegenerate"], event.target.checked))} />{" "}
            Regenerate automatically
          </label>
          <span className="secondary">Retry failed steps without asking, within the attempt limit.</span>
        </div>
      </Section>
    </form>
  );
}

export function DirectionPage() {
  const [params, setParams] = useSearchParams();
  const file = params.get("file") ?? PROJECT_FILE;
  const requestedView = params.get("view") === "yaml" ? "yaml" : "fields";
  const view = file === PROJECT_FILE ? requestedView : "yaml";
  const spec = useSpecFile(file);

  const setView = (next: "fields" | "yaml") => {
    const nextParams = new URLSearchParams(params);
    nextParams.set("view", next);
    setParams(nextParams, { replace: true });
  };

  return (
    <div className="settings-stack">
      <div className="settings-head">
        <h2>Direction, defaults &amp; policy</h2>
        {file === PROJECT_FILE ? (
          <div className="row" role="group" aria-label="Editor view">
            <button type="button" aria-pressed={view === "fields"} onClick={() => setView("fields")}>Fields</button>
            <button type="button" aria-pressed={view === "yaml"} onClick={() => setView("yaml")}>YAML</button>
          </div>
        ) : (
          <span className="secondary mono">{file}</span>
        )}
      </div>
      <ConflictDialog file={spec} />
      {view === "fields" ? (
        <>
          <SaveBar file={spec} />
          <ExternalChangeBanner file={spec} />
          {spec.loadError ? (
            "code" in spec.loadError ? <ErrorBanner error={spec.loadError} /> : <Banner tone="bad" title="Cannot load file">{spec.loadError.message}</Banner>
          ) : spec.loading ? <p className="secondary">Loading {file}…</p> : <FieldsForm file={spec} />}
        </>
      ) : (
        <SpecEditor file={spec} onOpenFile={specRoute} />
      )}
      <PolicyPanel />
      <details>
        <summary>Effective settings (where each value comes from)</summary>
        <EffectiveSettings />
      </details>
    </div>
  );
}
