import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Document } from "yaml";
import type { AssetFamily, FamilyProfile, Problem } from "@brainforge/contracts";
import { callOperation } from "../../api/client.ts";
import { useOperation } from "../../api/hooks.ts";
import { BLOCKED_TEXT, ConflictDialog, draftSyntaxProblems, ExternalChangeBanner, SaveBar, SpecEditor } from "../../components/SpecEditor.tsx";
import { Banner, ErrorBanner, ProblemList, Status } from "../../components/ui.tsx";
import type { SpecFile } from "../../lib/spec-file.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { specRoute } from "../../lib/use-project.ts";
import { DeliverableCard, newDeliverable } from "./DeliverableCard.tsx";
import { Ctx, ListField, NumberField, RequiredTextField, SelectField, TextField, Group, problemsFor, FieldProblems, useEditor, getAt, type EditorContext } from "./fields.tsx";
import { ALPHA_TEXT, MOTION_TEXT, splitProblems, useFamilies } from "./useFamilies.tsx";
import { mutate, parseDraft, pushAt, removeAt, setAt } from "./yaml-patch.ts";

/** Debounced `spec.validate` of the draft: the same schema and family rules the server applies on save. */
export function useValidation(path: string, text: string, enabled: boolean): { problems: Problem[] | undefined; pending: boolean } {
  const { root } = useProjectRoot();
  const [result, setResult] = useState<{ text: string; problems: Problem[] } | undefined>(undefined);
  useEffect(() => {
    if (!enabled || root === undefined || text.trim() === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void callOperation("spec.validate", { project: root, input: { path, text } })
        .then((envelope) => { if (!cancelled && envelope.ok) setResult({ text, problems: envelope.data.problems }); })
        .catch(() => undefined);
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, text, enabled, root]);
  return { problems: result?.problems, pending: result === undefined || result.text !== text };
}

function ProblemSummary({ problems, pending, file }: { problems: Problem[]; pending: boolean; file: SpecFile }) {
  const { errors, warnings } = splitProblems(problems);
  return (
    <section aria-label="Validation">
      <div className="panel fam-validation">
        <div className="row" aria-live="polite">
          {errors.length > 0 ? <Status tone="bad">{errors.length} {errors.length === 1 ? "error" : "errors"}</Status> : <Status tone="ok">No errors</Status>}
          {warnings.length > 0 ? <Status tone="warn">{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</Status> : null}
          <span className="secondary">{pending ? "Checking…" : file.dirty ? "Checked against the schema and family rules." : "As last read from disk."}</span>
        </div>
      </div>
      {problems.length > 0 ? (
        <details open={errors.length > 0} className="panel" style={{ marginTop: 8 }}>
          <summary>All problems ({problems.length})</summary>
          <ProblemList problems={problems} blocked={errors.length > 0 ? BLOCKED_TEXT : "Warnings never block exploring the concept; they name what a production step still needs."} />
        </details>
      ) : null}
    </section>
  );
}

function IdentityPanel({ profiles }: { profiles: FamilyProfile[] }) {
  const { data, patch, disabled, profile } = useEditor();
  const identity = typeof data.identity === "object" && data.identity !== null ? Object.keys(data.identity) : [];
  const [newKey, setNewKey] = useState("");
  return (
    <section className="panel" aria-labelledby="fe-identity">
      <h3 id="fe-identity" style={{ marginTop: 0 }}>Identity</h3>
      <div className="grid-2">
        <RequiredTextField path={["name"]} label="Name" />
        <SelectField
          path={["family"]}
          label="Family"
          options={profiles.map((p) => ({ value: p.family, label: p.label }))}
          hint={profile ? `${ALPHA_TEXT[profile.alpha]}. ${MOTION_TEXT[profile.motion]}.` : undefined}
        />
      </div>
      <RequiredTextField path={["description"]} label="Description" area />
      <Group legend="Identity requirements" hint="Plain-language, concrete visible features, one per key. All of these are sent to the image model.">
        {identity.map((key) => (
          <div key={key} className="fam-identity-row">
            <TextField path={["identity", key]} label={key} area compact />
            <button type="button" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, ["identity", key]))} aria-label={`Remove ${key}`}>Remove</button>
          </div>
        ))}
        <div className="row">
          <div className="field compact" style={{ marginBottom: 0 }}>
            <label htmlFor="fe-identity-new">New requirement</label>
            <input id="fe-identity-new" type="text" value={newKey} disabled={disabled} placeholder="for example silhouette" onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (newKey.trim() !== "" && !identity.includes(newKey.trim())) { patch((doc) => setAt(doc, ["identity", newKey.trim()], "REPLACE: concrete visible features")); setNewKey(""); } } }} />
          </div>
          <button type="button" disabled={disabled || newKey.trim() === "" || identity.includes(newKey.trim())} onClick={() => { patch((doc) => setAt(doc, ["identity", newKey.trim()], "REPLACE: concrete visible features")); setNewKey(""); }}>Add requirement</button>
        </div>
      </Group>
      <TextField path={["notes"]} label="Notes" area hint="For people only — never sent to the image model." />
    </section>
  );
}

function StylePanel() {
  const { profile } = useEditor();
  const packaging = profile !== undefined && ["ui", "icon", "item", "equipment", "prop"].includes(profile.family);
  return (
    <section className="panel" aria-labelledby="fe-style">
      <h3 id="fe-style" style={{ marginTop: 0 }}>Style and references</h3>
      <div className="grid-2">
        <ListField path={["styleIds"]} label="Style ids" hint="Comma separated; each matches a file under brainforge/styles/." />
        <ListField path={["references"]} label="Reference ids" hint="Comma separated imported reference ids." />
        {packaging ? (
          <SelectField
            path={["export", "sprites"]}
            label="Still packaging on export"
            emptyLabel="Individual PNGs (default)"
            options={[{ value: "individual", label: "Individual PNGs" }, { value: "atlas", label: "One packed atlas" }, { value: "both", label: "PNGs and atlas" }]}
            hint="Animations are packaged by their processing recipe."
          />
        ) : null}
      </div>
      <p className="secondary" style={{ marginBottom: 0 }}>Per-asset overrides stay in the YAML tab.</p>
    </section>
  );
}

function AttachmentsPanel({ description }: { description: string }) {
  const { data, patch, disabled } = useEditor();
  const rows = Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : [];
  const deliverables = (Array.isArray(data.deliverables) ? (data.deliverables as Array<{ id?: string }>) : []).map((d) => String(d.id ?? "")).filter(Boolean);
  return (
    <section className="panel" aria-labelledby="fe-attach">
      <h3 id="fe-attach" style={{ marginTop: 0 }}>Attachment points</h3>
      <p className="secondary">{description} Points are pixels of the chosen deliverable&rsquo;s canvas; they are art metadata, not inventory or sockets. Draw them on an output to check.</p>
      {rows.length === 0 ? <p className="secondary">No attachment points.</p> : null}
      <ul className="plain-list">
        {rows.map((row, i) => (
          <li key={i} className="panel fam-row">
            <div className="grid-2">
              <TextField path={["attachments", i, "name"]} label="Name" compact hint="Kebab-case, for example grip-hand." />
              <SelectField path={["attachments", i, "deliverable"]} label="On deliverable" compact emptyLabel="Any / first" options={deliverables.map((d) => ({ value: d, label: d }))} />
              <NumberField path={["attachments", i, "x"]} label="x" unit="px" compact />
              <NumberField path={["attachments", i, "y"]} label="y" unit="px" compact />
            </div>
            <button type="button" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, ["attachments", i]))}>Remove {String(row.name ?? "point")}</button>
          </li>
        ))}
      </ul>
      <button type="button" disabled={disabled} onClick={() => patch((doc) => { pushAt(doc, ["attachments"], { name: `point-${rows.length + 1}`, x: 0, y: 0, ...(deliverables[0] ? { deliverable: deliverables[0] } : {}) }); })}>Add attachment point</button>
    </section>
  );
}

function CollectionPanel({ description }: { description: string }) {
  const { data, patch, disabled, assetId, problems } = useEditor();
  const collection = (typeof data.collection === "object" && data.collection !== null ? data.collection : {}) as { members?: Array<{ assetId?: string; required?: boolean }> };
  const members = collection.members ?? [];
  const list = useOperation("asset.list", {});
  const known = list.data?.ok ? list.data.data.assets.filter((a) => a.assetId !== assetId && (a.family === "background" || a.family === "tile" || a.family === "prop" || a.family === undefined)) : [];
  return (
    <section className="panel" aria-labelledby="fe-collection">
      <h3 id="fe-collection" style={{ marginTop: 0 }}>Members</h3>
      <p className="secondary">{description} Backgrounds, tiles and props listed here follow this environment&rsquo;s locked direction. There is no level graph.</p>
      <ul className="plain-list">
        {members.map((member, i) => (
          <li key={i} className="panel fam-row">
            <div className="grid-2">
              <SelectField path={["collection", "members", i, "assetId"]} label="Member asset" compact emptyLabel="Choose an asset…" options={known.map((a) => ({ value: a.assetId, label: `${a.name ?? a.assetId} (${a.family ?? "no family"})` }))} hint="An asset that does not exist yet can be created with the shortcut below." />
              <div className="field compact">
                <label className="check" htmlFor={`fe-member-req-${i}`}>
                  <input id={`fe-member-req-${i}`} type="checkbox" checked={member.required !== false} disabled={disabled} onChange={(e) => patch((doc) => setAt(doc, ["collection", "members", i, "required"], e.target.checked))} />
                  Required for the environment to be complete
                </label>
              </div>
            </div>
            <button type="button" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, ["collection", "members", i]))}>Remove {member.assetId ?? "member"}</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" disabled={disabled} onClick={() => patch((doc) => { pushAt(doc, ["collection", "members"], { assetId: "", required: true }); })}>Add member</button>
        <Link className="button" to={`/assets/new?memberOf=${encodeURIComponent(assetId)}`}>Create member asset…</Link>
      </div>
      <FieldProblems id="fe-collection-problems" problems={problemsFor(problems, ["collection"])} />
      <div style={{ marginTop: 12 }}><TextField path={["collection", "styleId"]} label="Collection style id" compact hint="Optional shared style for the members." /></div>
    </section>
  );
}

function DeliverablesPanel({ profile }: { profile: FamilyProfile | undefined }) {
  const { data, patch, disabled } = useEditor();
  const list = Array.isArray(data.deliverables) ? (data.deliverables as Array<{ id?: string }>) : [];
  const kinds = profile?.allowedKinds ?? ["still"];
  const [kind, setKind] = useState(kinds[0] ?? "still");
  const [id, setId] = useState("");
  useEffect(() => { if (!kinds.includes(kind)) setKind(kinds[0] ?? "still"); }, [kinds, kind]);
  const taken = list.some((d) => d.id === id);
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && !taken;
  const add = () => {
    if (!valid) return;
    patch((doc) => { pushAt(doc, ["deliverables"], newDeliverable(kind, id, profile)); });
    setId("");
  };
  return (
    <section className="panel" aria-labelledby="fe-deliverables">
      <h3 id="fe-deliverables" style={{ marginTop: 0 }}>Deliverables</h3>
      <p className="secondary">Each deliverable becomes one production step. {profile?.motion === "none" ? `${profile.label} assets are static; there are no motion controls.` : profile?.motion === "optional" ? "Motion is optional: add an Animation deliverable only if the asset animates." : ""}</p>
      {list.length === 0 ? <p className="secondary">No deliverables yet: the concept can still be explored, but nothing can be produced or promoted.</p> : null}
      <ol className="plain-list fam-deliverables" aria-label="Deliverables">
        {list.map((_, i) => <DeliverableCard key={i} index={i} count={list.length} />)}
      </ol>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field compact" style={{ marginBottom: 0 }}>
          <label htmlFor="fe-add-kind">New deliverable kind</label>
          <select id="fe-add-kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={disabled}>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div className="field compact" style={{ marginBottom: 0 }}>
          <label htmlFor="fe-add-id">New deliverable id</label>
          <input id="fe-add-id" type="text" value={id} disabled={disabled} autoComplete="off" aria-describedby="fe-add-id-hint" onChange={(e) => setId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        </div>
        <button type="button" className="primary" disabled={disabled || !valid} onClick={add}>Add deliverable</button>
      </div>
      <div id="fe-add-id-hint" className="secondary" style={{ marginTop: 4 }}>{id !== "" && !valid ? (taken ? "That id is already used." : "Use lowercase letters, digits and single hyphens.") : "Kebab-case, for example walk-cycle."}</div>
    </section>
  );
}

type Tab = "form" | "yaml";

/**
 * Schema-driven asset editor. The form edits the same draft text as the YAML tab through YAML document patches, so
 * comments and unrelated formatting survive and either tab can be used at any time.
 */
export function FamilyEditor({ file, assetId, banner, afterSave }: { file: SpecFile; assetId: string; banner?: ReactNode; afterSave?: ReactNode }) {
  const families = useFamilies();
  const [tab, setTab] = useState<Tab>("form");
  const parsed = useMemo(() => parseDraft(file.draft), [file.draft]);
  const family = typeof parsed.data.family === "string" ? parsed.data.family : undefined;
  const profile = families.profileOf(family as AssetFamily | undefined);
  const syntax = useMemo(() => draftSyntaxProblems(file.path, file.draft), [file.path, file.draft]);
  const validation = useValidation(file.path, file.draft, syntax.length === 0 && !file.loading);
  const fallback = file.problems;
  const server = validation.problems ?? fallback;
  const problems = [...syntax, ...server.filter((p) => !syntax.some((s) => s.message.includes(p.message)))];
  const draftRef = useRef(file.draft);
  draftRef.current = file.draft;

  const ctx: EditorContext = {
    data: parsed.data,
    profile,
    problems,
    patch: (fn: (doc: Document) => void) => file.setDraft(mutate(draftRef.current, fn)),
    disabled: file.loading || parsed.syntaxError !== undefined,
    assetId,
  };

  if (file.loadError) {
    return "code" in file.loadError ? <ErrorBanner error={file.loadError} /> : <Banner tone="bad" title="Cannot load file">{file.loadError.message}</Banner>;
  }
  const sections = profile?.editorSections ?? [];
  const attachments = sections.find((s) => s.id === "attachments");
  const collection = sections.find((s) => s.id === "collection");
  return (
    <div className="stack fam-editor">
      {banner}
      <ExternalChangeBanner file={file} />
      <div className="viewer-tools" role="group" aria-label="Editor view">
        <button type="button" aria-pressed={tab === "form"} onClick={() => setTab("form")}>Form</button>
        <button type="button" aria-pressed={tab === "yaml"} onClick={() => setTab("yaml")}>YAML</button>
      </div>
      {tab === "yaml" ? (
        <SpecEditor file={file} onOpenFile={specRoute} />
      ) : (
        <Ctx.Provider value={ctx}>
          <SaveBar file={file} />
          {file.saveError && !file.conflict ? ("code" in file.saveError ? <ErrorBanner error={file.saveError} /> : <Banner tone="bad" title="Save failed">{file.saveError.message}</Banner>) : null}
          {afterSave}
          <ProblemSummary problems={problems} pending={validation.pending && file.dirty} file={file} />
          {parsed.syntaxError !== undefined ? (
            <Banner tone="bad" title="The YAML has a syntax error" actions={<button type="button" onClick={() => setTab("yaml")}>Open the YAML tab</button>}>
              {parsed.syntaxError} The form is read-only until it parses again.
            </Banner>
          ) : null}
          {profile ? (
            <p className="secondary" style={{ margin: 0 }}><strong>{profile.label}.</strong> {profile.summary}</p>
          ) : null}
          <IdentityPanel profiles={families.profiles} />
          <StylePanel />
          {attachments ? <AttachmentsPanel description={attachments.description} /> : null}
          {collection ? <CollectionPanel description={collection.description} /> : null}
          <DeliverablesPanel profile={profile} />
        </Ctx.Provider>
      )}
      <ConflictDialog file={file} />
    </div>
  );
}
