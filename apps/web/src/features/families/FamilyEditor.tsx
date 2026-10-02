import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Document } from "yaml";
import type { AssetFamily, FamilyProfile, Problem } from "@brainforge/contracts";
import { callOperation } from "../../api/client.ts";
import { useOperation } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { BLOCKED_TEXT, ConflictDialog, draftSyntaxProblems, ExternalChangeBanner, SaveBar, SpecEditor } from "../../components/SpecEditor.tsx";
import { Banner, ErrorBanner, ProblemList, Status, type LocateProblem } from "../../components/ui.tsx";
import type { SpecFile } from "../../lib/spec-file.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { groupByKind } from "../../lib/steps.ts";
import { specRoute } from "../../lib/use-project.ts";
import { DeliverableRow, KIND_LABEL, newDeliverable, problemPlace } from "./DeliverableRow.tsx";
import { Ctx, ListField, NumberField, ProblemFlag, RequiredTextField, SelectField, TextField, Group, idOf, problemsFor, FieldProblems, useEditor, type EditorContext } from "./fields.tsx";
import { ALPHA_TEXT, MOTION_TEXT, splitProblems, useFamilies } from "./useFamilies.tsx";
import { isPlaceholder, mutate, normalizeField, parseDraft, pushAt, removeAt, setAt, type Path } from "./yaml-patch.ts";
import "./families.css";

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

export function ProblemSummary({ problems, pending, file, locate }: { problems: Problem[]; pending: boolean; file: SpecFile; locate?: LocateProblem }) {
  const { errors, warnings } = splitProblems(problems);
  return (
    <section aria-label="Validation" className="fam-validation">
      <div className="row" aria-live="polite">
        {errors.length > 0 ? <Status tone="bad">{errors.length} {errors.length === 1 ? "thing to fix" : "things to fix"}</Status> : <Status tone="ok">Valid</Status>}
        {warnings.length > 0 ? <Status tone="warn">{warnings.length} to finish before generating</Status> : null}
        <span className="secondary">{pending ? "Checking…" : file.dirty ? "Checked against the schema and family rules." : "As last read from disk."}</span>
      </div>
      {problems.length > 0 ? (
        <details open={errors.length > 0} className="fam-problems">
          <summary>Details ({problems.length})</summary>
          <ProblemList problems={problems} locate={locate} blocked={errors.length > 0 ? BLOCKED_TEXT : "Nothing here blocks the concept. Finish these before you generate."} />
        </details>
      ) : null}
    </section>
  );
}

/** The top-level fields each part owns: its problem flag counts them, and a Checks entry on one opens the part. */
const PART_FIELDS = {
  identity: [["name"], ["family"], ["description"], ["identity"], ["notes"]],
  style: [["styleIds"], ["references"], ["export"]],
  attachments: [["attachments"]],
  collection: [["collection"]],
} satisfies Record<string, Path[]>;
type PartName = keyof typeof PART_FIELDS;

/** One part of the definition: text to read, and its fields in place after Edit. `name` is its `?section=` value and its key in the editor's open set. */
function Part({ name, title, read, children }: { name: PartName; title: string; read: ReactNode; children: ReactNode }) {
  const { open, setOpen, problems } = useEditor();
  const isOpen = open.has(name);
  const id = `def-${name}`;
  return (
    <section className="spec-part" id={id} tabIndex={-1} aria-labelledby={`${id}-title`}>
      <div className="spec-head">
        <h3 id={`${id}-title`}>{title}</h3>
        {isOpen ? null : <ProblemFlag problems={PART_FIELDS[name].flatMap((path) => problemsFor(problems, path))} />}
        <button type="button" className="sm spec-edit-button" aria-expanded={isOpen} aria-controls={isOpen ? `${id}-fields` : undefined} onClick={() => setOpen(name, !isOpen)}>
          {isOpen ? "Done" : <><Icon name="edit" size="sm" />Edit</>}
        </button>
      </div>
      {isOpen ? <div className="panel spec-fields" id={`${id}-fields`}>{children}</div> : <div className="panel spec-text">{read}</div>}
    </section>
  );
}

function IdentityPart({ profiles }: { profiles: FamilyProfile[] }) {
  const { data } = useEditor();
  const description = typeof data.description === "string" ? data.description : "";
  const notes = typeof data.notes === "string" ? data.notes : "";
  const identity = typeof data.identity === "object" && data.identity !== null ? Object.entries(data.identity) : [];
  return (
    <Part
      name="identity"
      title="Identity"
      read={
        <>
          {description === "" ? <p className="faint">No description yet.</p> : <p className={`spec-lede${isPlaceholder(description) ? " placeholder" : ""}`}>{description}</p>}
          {identity.length > 0 ? (
            <dl className="spec-kv">
              {identity.map(([key, value]) => (
                <Fragment key={key}>
                  <dt>{key}</dt>
                  <dd className={isPlaceholder(value) ? "placeholder" : undefined}>{String(value ?? "")}</dd>
                </Fragment>
              ))}
            </dl>
          ) : null}
          {notes === "" ? null : (
            <details className="spec-notes">
              <summary>Notes <span>for people, never sent to the image model</span></summary>
              <p>{notes}</p>
            </details>
          )}
        </>
      }
    >
      <IdentityFields profiles={profiles} />
    </Part>
  );
}

function IdentityFields({ profiles }: { profiles: FamilyProfile[] }) {
  const { data, patch, disabled, profile, problems } = useEditor();
  const identity = typeof data.identity === "object" && data.identity !== null ? Object.keys(data.identity) : [];
  const [newKey, setNewKey] = useState("");
  const key = newKey.trim();
  const add = () => {
    if (key === "" || identity.includes(key)) return;
    patch((doc) => setAt(doc, ["identity", key], "REPLACE: concrete visible features"));
    setNewKey("");
  };
  return (
    <>
      <RequiredTextField path={["description"]} label="Description" area />
      <Group legend="Identity requirements" hint="Plain-language, concrete visible features, one per key. All of these are sent to the image model.">
        {identity.map((name) => (
          <div key={name} className="fam-identity-row">
            <TextField path={["identity", name]} label={name} area compact />
            <button type="button" className="ghost sm" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, ["identity", name]))} aria-label={`Remove ${name}`}>Remove</button>
          </div>
        ))}
        <div className="fam-add">
          <div className="field compact">
            <label htmlFor="fe-identity-new">New requirement</label>
            <input id="fe-identity-new" type="text" value={newKey} disabled={disabled} placeholder="for example silhouette" onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          </div>
          <button type="button" disabled={disabled || key === "" || identity.includes(key)} onClick={add}>Add requirement</button>
        </div>
      </Group>
      <TextField path={["notes"]} label="Notes" area hint="For people only — never sent to the image model." />
      <details className="spec-more">
        <summary>Name and family<ProblemFlag problems={[...problemsFor(problems, ["name"]), ...problemsFor(problems, ["family"])]} /></summary>
        <div className="spec-more-body grid-2">
          <RequiredTextField path={["name"]} label="Name" />
          <SelectField
            path={["family"]}
            label="Family"
            options={profiles.map((p) => ({ value: p.family, label: p.label }))}
            hint={profile ? `${ALPHA_TEXT[profile.alpha]}. ${MOTION_TEXT[profile.motion]}.` : undefined}
          />
        </div>
      </details>
    </>
  );
}

const PACKAGING: Record<string, string> = { individual: "Individual PNGs", atlas: "One packed atlas", both: "PNGs and atlas" };

function StylePart() {
  const { data, profile } = useEditor();
  const packaging = profile !== undefined && ["ui", "icon", "item", "equipment", "prop"].includes(profile.family);
  const styles = Array.isArray(data.styleIds) ? data.styleIds.map(String) : [];
  const references = Array.isArray(data.references) ? data.references.map(String) : [];
  const exported = typeof data.export === "object" && data.export !== null && "sprites" in data.export ? data.export.sprites : undefined;
  return (
    <Part
      name="style"
      title="Style and references"
      read={
        <dl className="spec-kv">
          <dt>Styles</dt>
          <dd>{styles.length > 0 ? <code>{styles.join(", ")}</code> : <span className="faint">None</span>}</dd>
          <dt>Reference ids</dt>
          <dd>{references.length > 0 ? <code>{references.join(", ")}</code> : <span className="faint">None</span>}</dd>
          {packaging ? (
            <>
              <dt>Still packaging</dt>
              <dd>{typeof exported === "string" ? (PACKAGING[exported] ?? exported) : "Individual PNGs (default)"}</dd>
            </>
          ) : null}
        </dl>
      }
    >
      <div className="grid-2">
        <ListField path={["styleIds"]} label="Style ids" hint="Comma separated; each matches a file under brainforge/styles/." />
        <ListField path={["references"]} label="Reference ids" hint="Comma separated imported reference ids." />
        {packaging ? (
          <SelectField
            path={["export", "sprites"]}
            label="Still packaging on export"
            emptyLabel="Individual PNGs (default)"
            options={Object.entries(PACKAGING).map(([value, label]) => ({ value, label }))}
            hint="Animations are packaged by their processing recipe."
          />
        ) : null}
      </div>
      <p className="secondary">Other per-asset overrides live in the YAML.</p>
    </Part>
  );
}

function AttachmentsPart({ description }: { description: string }) {
  const { data, patch, disabled } = useEditor();
  const rows = Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : [];
  const deliverables = (Array.isArray(data.deliverables) ? (data.deliverables as Array<{ id?: string }>) : []).map((d) => String(d.id ?? "")).filter(Boolean);
  return (
    <Part
      name="attachments"
      title="Attachment points"
      read={rows.length === 0 ? <p className="faint">No attachment points.</p> : (
        <ul className="spec-list">
          {rows.map((row, i) => (
            <li key={i}>
              <code>{String(row.name ?? "unnamed")}</code> <span className="mono">{String(row.x ?? "?")}, {String(row.y ?? "?")}</span>{" "}
              <span className="faint">on {typeof row.deliverable === "string" ? <code>{row.deliverable}</code> : "the first deliverable"}</span>
            </li>
          ))}
        </ul>
      )}
    >
      <p className="secondary">{description} Points are pixels of the chosen deliverable&rsquo;s canvas; they are art metadata, not inventory or sockets. Draw them on an output to check.</p>
      {rows.length === 0 ? <p className="secondary">No attachment points.</p> : null}
      <ul className="plain-list">
        {rows.map((row, i) => (
          <li key={i} className="fam-row">
            <div className="grid-2">
              <TextField path={["attachments", i, "name"]} label="Name" compact hint="Kebab-case, for example grip-hand." />
              <SelectField path={["attachments", i, "deliverable"]} label="On deliverable" compact emptyLabel="Any / first" options={deliverables.map((d) => ({ value: d, label: d }))} />
              <NumberField path={["attachments", i, "x"]} label="x" unit="px" compact />
              <NumberField path={["attachments", i, "y"]} label="y" unit="px" compact />
            </div>
            <button type="button" className="ghost sm" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, ["attachments", i]))}>Remove {String(row.name ?? "point")}</button>
          </li>
        ))}
      </ul>
      <button type="button" disabled={disabled} onClick={() => patch((doc) => { pushAt(doc, ["attachments"], { name: `point-${rows.length + 1}`, x: 0, y: 0, ...(deliverables[0] ? { deliverable: deliverables[0] } : {}) }); })}>Add attachment point</button>
    </Part>
  );
}

function CollectionPart({ description }: { description: string }) {
  const { data, patch, disabled, assetId, problems } = useEditor();
  const collection = (typeof data.collection === "object" && data.collection !== null ? data.collection : {}) as { members?: Array<{ assetId?: string; required?: boolean }>; styleId?: unknown };
  const members = collection.members ?? [];
  const list = useOperation("asset.list", {});
  const known = list.data?.ok ? list.data.data.assets.filter((a) => a.assetId !== assetId && (a.family === "background" || a.family === "tile" || a.family === "prop" || a.family === undefined)) : [];
  return (
    <Part
      name="collection"
      title="Members"
      read={
        <>
          {members.length === 0 ? <p className="faint">No members yet.</p> : (
            <ul className="spec-list">
              {members.map((member, i) => <li key={i}><code>{member.assetId || "not chosen"}</code>{member.required === false ? <span className="faint"> optional</span> : null}</li>)}
            </ul>
          )}
          {typeof collection.styleId === "string" ? <p className="secondary">Shared style <code>{collection.styleId}</code></p> : null}
        </>
      }
    >
      <p className="secondary">{description} Backgrounds, tiles and props listed here follow this environment&rsquo;s locked direction. There is no level graph.</p>
      <ul className="plain-list">
        {members.map((member, i) => (
          <li key={i} className="fam-row">
            <div className="grid-2">
              <SelectField path={["collection", "members", i, "assetId"]} label="Member asset" compact emptyLabel="Choose an asset…" options={known.map((a) => ({ value: a.assetId, label: `${a.name ?? a.assetId} (${a.family ?? "no family"})` }))} hint="An asset that does not exist yet can be created with the shortcut below." />
              <div className="field compact">
                <label className="check" htmlFor={`fe-member-req-${i}`}>
                  <input id={`fe-member-req-${i}`} type="checkbox" checked={member.required !== false} disabled={disabled} onChange={(e) => patch((doc) => setAt(doc, ["collection", "members", i, "required"], e.target.checked))} />
                  Required for the environment to be complete
                </label>
              </div>
            </div>
            <button type="button" className="ghost sm" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, ["collection", "members", i]))}>Remove {member.assetId ?? "member"}</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" disabled={disabled} onClick={() => patch((doc) => { pushAt(doc, ["collection", "members"], { assetId: "", required: true }); })}>Add member</button>
        <Link className="button" to={`/assets/new?memberOf=${encodeURIComponent(assetId)}`}>Create member asset…</Link>
      </div>
      <FieldProblems id="fe-collection-problems" problems={problemsFor(problems, ["collection"])} />
      <div><TextField path={["collection", "styleId"]} label="Collection style id" compact hint="Optional shared style for the members." /></div>
    </Part>
  );
}

/** Deliverables in the Sheet's groups, reference sheets first, so the definition reads in the order the art does. */
function Deliverables({ profile }: { profile: FamilyProfile | undefined }) {
  const { data } = useEditor();
  const list = Array.isArray(data.deliverables) ? (data.deliverables as Array<{ kind?: unknown; required?: unknown }>) : [];
  const items = list.map((d, index) => ({ index, kind: typeof d.kind === "string" ? d.kind : "still", required: d.required !== false }));
  const groups = [
    ...groupByKind(items.filter((item) => item.kind.startsWith("reference")), (item) => item.kind),
    ...groupByKind(items.filter((item) => !item.kind.startsWith("reference")), (item) => item.kind),
  ];
  return (
    <div id="def-deliverables" tabIndex={-1} className="spec-deliverables">
      {list.length === 0 ? <p className="secondary">No deliverables yet: the concept can still be explored, but nothing can be produced or promoted.</p> : null}
      {groups.map((group) => {
        const required = group.items.filter((item) => item.required).length;
        const optional = group.items.length - required;
        const siblings = group.items.map((item) => item.index);
        const mixed = new Set(group.items.map((item) => item.kind)).size > 1;
        const titleId = `def-group-${group.kind}`;
        return (
          <section key={group.kind} className="spec-part" aria-labelledby={titleId}>
            <div className="spec-head">
              <h3 id={titleId}>{group.title}</h3>
              <span className="n">{[required > 0 ? `${required} required` : "", optional > 0 ? `${optional} optional` : ""].filter(Boolean).join(" · ")}</span>
            </div>
            <ol className="spec-rows">
              {group.items.map((item) => <DeliverableRow key={item.index} index={item.index} siblings={siblings} showKind={mixed} />)}
            </ol>
          </section>
        );
      })}
      <AddDeliverable profile={profile} />
    </div>
  );
}

function AddDeliverable({ profile }: { profile: FamilyProfile | undefined }) {
  const { data, patch, disabled, setOpen } = useEditor();
  const list = Array.isArray(data.deliverables) ? (data.deliverables as Array<{ id?: string }>) : [];
  const kinds = profile?.allowedKinds ?? ["still"];
  const [kind, setKind] = useState(kinds[0] ?? "still");
  const [id, setId] = useState("");
  useEffect(() => { if (!kinds.includes(kind)) setKind(kinds[0] ?? "still"); }, [kinds, kind]);
  const taken = list.some((d) => d.id === id);
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && !taken;
  const add = () => {
    if (!valid) return;
    let index = -1;
    patch((doc) => { index = pushAt(doc, ["deliverables"], newDeliverable(kind, id, profile)); });
    setOpen(`deliverable:${id}`, true);
    setId("");
    // Straight to what the new deliverable should show.
    requestAnimationFrame(() => document.getElementById(`fe-deliverables-${index}-description`)?.focus());
  };
  return (
    <details className="spec-add">
      <summary>Add a deliverable</summary>
      <p className="secondary">Each deliverable becomes one production step. {profile?.motion === "none" ? `${profile.label} assets are static; there are no motion controls.` : profile?.motion === "optional" ? "Motion is optional: add an Animation deliverable only if the asset animates." : ""}</p>
      <div className="fam-add">
        <div className="field compact">
          <label htmlFor="fe-add-kind">Kind</label>
          <select id="fe-add-kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={disabled}>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select>
        </div>
        <div className="field compact">
          <label htmlFor="fe-add-id">Id</label>
          <input id="fe-add-id" type="text" value={id} disabled={disabled} autoComplete="off" aria-describedby="fe-add-id-hint" onChange={(e) => setId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        </div>
        <button type="button" disabled={disabled || !valid} onClick={add}>Add deliverable</button>
      </div>
      <div id="fe-add-id-hint" className="hint">{id !== "" && !valid ? (taken ? "That id is already used." : "Use lowercase letters, digits and single hyphens.") : "Kebab-case, for example walk-cycle."}</div>
    </details>
  );
}

type Tab = "overview" | "yaml";

/**
 * Schema-driven asset editor. The overview reads the definition as text and opens one part's fields in place; those
 * fields edit the same draft text as the YAML tab through YAML document patches, so comments and unrelated formatting
 * survive and either tab can be used at any time.
 */
export function FamilyEditor({ file, assetId, banner, afterSave, aside }: { file: SpecFile; assetId: string; banner?: ReactNode; afterSave?: ReactNode; aside?: (state: { problems: Problem[]; pending: boolean; locate: LocateProblem }) => ReactNode }) {
  const families = useFamilies();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>("overview");
  // Parts showing their fields. A ?section= link arrives with that part open.
  const [open, setOpenParts] = useState<ReadonlySet<string>>(() => {
    const section = params.get("section");
    return new Set(section === null ? [] : [section]);
  });
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
    open,
    setOpen: (part, value) => setOpenParts((current) => {
      if (current.has(part) === value) return current;
      const next = new Set(current);
      if (value) next.add(part);
      else next.delete(part);
      return next;
    }),
  };

  // A Checks entry names the row or part that owns its field, and opens it there with the field focused.
  const reveal = (keys: string[], field: string, fallback: string) => {
    setTab("overview");
    for (const key of keys) ctx.setOpen(key, true);
    requestAnimationFrame(() => {
      const target = document.getElementById(idOf(field.replace(/\[(\d+)\]/g, ".$1").split("."))) ?? document.querySelector<HTMLElement>(fallback);
      for (let details = target?.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
  };
  const locate: LocateProblem = (problem) => {
    const field = normalizeField(problem.field ?? "");
    const row = /^deliverables\[(\d+)\]/.exec(field);
    if (row) {
      const index = Number(row[1]);
      const raw = Array.isArray(parsed.data.deliverables) ? (parsed.data.deliverables[index] as { id?: unknown } | undefined) : undefined;
      const id = typeof raw?.id === "string" ? raw.id : "";
      if (id === "") return undefined;
      const rest = field.slice(row[0].length).replace(/^\./, "");
      const keys = [`deliverable:${id}`, ...(problemPlace(field, index) === "more" ? [`more:${id}`] : [])];
      return { label: rest === "" ? id : `${id} · ${rest}`, go: () => reveal(keys, field, `#${CSS.escape(`def-d-${id}`)} .spec-toggle`) };
    }
    const part = (Object.keys(PART_FIELDS) as PartName[]).find((name) => PART_FIELDS[name].some((path) => problemsFor([problem], path).length > 0));
    return part === undefined ? undefined : { label: field, go: () => reveal([part], field, `#def-${part}`) };
  };

  if (file.loadError) {
    return "code" in file.loadError ? <ErrorBanner error={file.loadError} /> : <Banner tone="bad" title="Cannot load file">{file.loadError.message}</Banner>;
  }
  const pending = validation.pending && file.dirty;
  const sections = profile?.editorSections ?? [];
  const attachments = sections.find((s) => s.id === "attachments");
  const collection = sections.find((s) => s.id === "collection");
  const main = (
    <div className="fam-editor">
      {banner}
      <ExternalChangeBanner file={file} />
      <div className="fam-editor-bar">
        <span className="seg" role="group" aria-label="Editor view">
          <button type="button" aria-pressed={tab === "overview"} onClick={() => setTab("overview")}>Overview</button>
          <button type="button" aria-pressed={tab === "yaml"} onClick={() => setTab("yaml")}>YAML</button>
        </span>
        {profile ? <span className="secondary"><strong>{profile.label}.</strong> {profile.summary}</span> : null}
      </div>
      {tab === "yaml" ? (
        <SpecEditor file={file} onOpenFile={specRoute} />
      ) : (
        <Ctx.Provider value={ctx}>
          <SaveBar file={file} />
          {file.saveError && !file.conflict ? ("code" in file.saveError ? <ErrorBanner error={file.saveError} /> : <Banner tone="bad" title="Save failed">{file.saveError.message}</Banner>) : null}
          {afterSave}
          {aside ? null : <ProblemSummary problems={problems} pending={pending} file={file} locate={locate} />}
          {parsed.syntaxError !== undefined ? (
            <Banner tone="bad" title="The YAML has a syntax error" actions={<button type="button" onClick={() => setTab("yaml")}>Edit as YAML</button>}>
              {parsed.syntaxError} The overview is read-only until it parses again.
            </Banner>
          ) : null}
          <div className="spec">
            <IdentityPart profiles={families.profiles} />
            <StylePart />
            {attachments ? <AttachmentsPart description={attachments.description} /> : null}
            {collection ? <CollectionPart description={collection.description} /> : null}
            <Deliverables profile={profile} />
          </div>
        </Ctx.Provider>
      )}
      <ConflictDialog file={file} />
    </div>
  );
  if (!aside) return main;
  return (
    <div className="def-grid">
      <div className="def-main">{main}</div>
      <div className="def-side">{aside({ problems, pending, locate })}</div>
    </div>
  );
}
