import "./settings.css";
import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ConflictDialog, ExternalChangeBanner, SaveBar, SpecEditor } from "../../components/SpecEditor.tsx";
import { EffectiveSettings } from "../../components/EffectiveSettings.tsx";
import { PolicyPanel } from "../../components/PolicyPanel.tsx";
import { Banner, ErrorBanner, Seg } from "../../components/ui.tsx";
import { Ctx, CheckField, ListField, NumberField, SelectField, TextField, type EditorContext } from "../families/fields.tsx";
import { mutate, parseDraft } from "../families/yaml-patch.ts";
import { specRoute } from "../../lib/use-project.ts";
import { useSpecFile, type SpecFile } from "../../lib/spec-file.ts";

const PROJECT_FILE = "brainforge/project.yaml";
const REVIEW_OPTIONS = [
  { value: "human", label: "A person" },
  { value: "agent", label: "An agent" },
  { value: "agent_with_escalation", label: "An agent, escalating to a person" },
];

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
  const parsed = useMemo(() => parseDraft(file.draft), [file.draft]);
  if (parsed.syntaxError !== undefined) {
    return <Banner tone="warn" title="Fields unavailable">The YAML has syntax errors. Fix the YAML view first, then come back to the fields.</Banner>;
  }
  const ctx: EditorContext = {
    data: parsed.data,
    profile: undefined,
    problems: [],
    patch: (fn) => file.setDraft(mutate(file.draft, fn)),
    disabled: false,
    assetId: "",
    open: new Set(),
    setOpen: () => {},
  };
  return (
    <Ctx.Provider value={ctx}>
      <form className="settings-stack" onSubmit={(event) => event.preventDefault()}>
        <Section title="Direction" hint="What this project looks like. Styles listed here are applied to every asset.">
          <TextField required path={["name"]} label="Project name" />
          <ListField path={["styleIds"]} label="Style ids" hint="Comma separated; each matches a file under brainforge/styles/." />
          <TextField required area path={["artDirection"]} label="Art direction" />
        </Section>
        <Section title="Defaults" hint="Used by every asset unless the asset or its family overrides them.">
          <NumberField required min={0} path={["defaults", "sizing", "width"]} label="Canvas width (px)" />
          <NumberField required min={0} path={["defaults", "sizing", "height"]} label="Canvas height (px)" />
          <NumberField min={0} path={["defaults", "sizing", "subjectHeightPx"]} label="Subject height (px)" hint="Optional. Standing height of characters and creatures." />
          <NumberField min={0} path={["defaults", "sizing", "displayScale"]} label="Display scale" hint="Optional." />
          <NumberField required min={0} path={["defaults", "animation", "playbackFps"]} label="Playback frame rate (fps)" hint="Cannot be cleared once set; edit project.yaml directly to remove it." />
        </Section>
        <Section title="Export" hint="Where finished files go in your game project.">
          <SelectField path={["export", "preset"]} label="Export preset" emptyLabel="(not set)" options={[{ value: "generic", label: "Generic files" }, { value: "godot4", label: "Godot 4" }]} />
          <TextField required path={["export", "destination"]} label="Destination" hint="Relative to the game root." />
          <TextField path={["export", "godotProjectRoot"]} label="Godot project root" hint="Relative to the game root. Empty means “.”." />
        </Section>
        <Section title="Approvals" hint="Who approves each step. Changes are requests until a human confirms them below.">
          <SelectField path={["approval", "conceptLock"]} label="Concept lock" emptyLabel="(not set)" options={REVIEW_OPTIONS} />
          <SelectField path={["approval", "productionReview"]} label="Production review" emptyLabel="(not set)" options={REVIEW_OPTIONS} />
          <SelectField path={["approval", "promotion"]} label="Promotion" emptyLabel="(not set)" options={REVIEW_OPTIONS} />
          <SelectField path={["approval", "activation"]} label="Activation" emptyLabel="(not set)" options={REVIEW_OPTIONS} />
        </Section>
        <Section title="Automation" hint="Limits for unattended generation work.">
          <NumberField required min={0} path={["automation", "maxConcurrentGenerations"]} label="Max concurrent generations" />
          <NumberField required min={0} path={["automation", "maxBatchCandidates"]} label="Max batch candidates" />
          <CheckField path={["automation", "autoRegenerate"]} label="Regenerate automatically" hint="Retry failed steps without asking, within the attempt limit." />
        </Section>
      </form>
    </Ctx.Provider>
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
        <h2>Art direction</h2>
        {file === PROJECT_FILE ? (
          <Seg label="Editor view" value={view} options={[{ value: "fields", label: "Fields" }, { value: "yaml", label: "YAML" }]} onChange={setView} />
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
        <summary>Where each setting comes from</summary>
        <EffectiveSettings />
      </details>
    </div>
  );
}
