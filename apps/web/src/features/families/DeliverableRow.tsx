import type { MouseEvent, ReactNode } from "react";
import type { Document } from "yaml";
import type { FamilyProfile } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { CheckField, FieldProblems, Group, MultiPick, NumberField, ProblemFlag, SelectField, TextField, getAt, problemsFor, useEditor } from "./fields.tsx";
import { fieldName, isPlaceholder, moveAt, normalizeField, pushAt, removeAt, renameDeliverableRefs, setAt, type Path } from "./yaml-patch.ts";

interface Raw {
  id?: string;
  kind?: string;
  required?: boolean;
  description?: unknown;
  referenceStrength?: unknown;
  dependsOn?: string[];
  animation?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  regions?: Array<Record<string, unknown>>;
  referenceRoles?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export const KIND_LABEL: Record<string, string> = {
  view: "View", pose: "Pose", expression: "Expression", still: "Still", variant: "Variant", animation: "Animation", tile: "Tile", "ui-state": "UI state", "reference-sheet": "Reference sheet",
};

const sectionFields = (profile: FamilyProfile | undefined): string[] => profile?.editorSections.flatMap((s) => s.fields) ?? [];
const offers = (profile: FamilyProfile | undefined, prefix: string): boolean => profile === undefined || sectionFields(profile).some((f) => f.startsWith(`deliverables[].${prefix}`));
const sectionHint = (profile: FamilyProfile | undefined, ...ids: string[]): string | undefined => profile?.editorSections.find((s) => ids.includes(s.id))?.description;

/** Where a problem on deliverable `index` shows: at the row's foot, beside a field up front, or under More. */
export function problemPlace(field: string, index: number): "row" | "front" | "more" {
  const base: Path = ["deliverables", index];
  if (field === fieldName(base) || field === fieldName([...base, "animation"])) return "row";
  const front = [["description"], ["animation", "motion"], ["regions"]].map((rest) => fieldName([...base, ...rest]));
  return front.some((f) => field === f || field.startsWith(`${f}.`) || field.startsWith(`${f}[`)) ? "front" : "more";
}

/** What a new deliverable of `kind` starts with. */
export function newDeliverable(kind: string, id: string, profile: FamilyProfile | undefined): Record<string, unknown> {
  const base: Record<string, unknown> = { id, kind, description: "REPLACE: what this deliverable shows" };
  if (kind === "animation") base.animation = { motion: "REPLACE: the motion in one concrete sentence", loop: true };
  if (kind === "tile" || (profile?.requiredFields[kind] ?? []).includes("environment.tileSize")) base.environment = { tileSize: { width: 64, height: 64 } };
  if (kind === "ui-state") base.ui = { state: "normal" };
  if (kind === "reference-sheet") base.regions = [{ id: "front", x: 0, y: 0, width: 512, height: 768, view: "front view, facing the camera" }];
  return base;
}

function Regions({ base, regions }: { base: Path; regions: Array<Record<string, unknown>> }) {
  const { patch, disabled, problems } = useEditor();
  return (
    <Group legend="Reference-sheet regions" hint="Named source-pixel rectangles of the sheet. Each becomes a separately hashed crop that other deliverables can bind by region id.">
      <ul className="plain-list">
        {regions.map((_, i) => (
          <li key={i} className="fam-row">
            <div className="grid-2">
              <TextField path={[...base, i, "id"]} label="Region id" compact />
              <TextField path={[...base, i, "view"]} label="View phrase" compact hint="A concrete picture phrase sent to the model for this region." />
              <NumberField path={[...base, i, "x"]} label="x" min={0} unit="px" compact />
              <NumberField path={[...base, i, "y"]} label="y" min={0} unit="px" compact />
              <NumberField path={[...base, i, "width"]} label="Width" min={1} unit="px" compact />
              <NumberField path={[...base, i, "height"]} label="Height" min={1} unit="px" compact />
            </div>
            <button type="button" className="ghost sm" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, [...base, i]))}>Remove region {String(regions[i]?.id ?? i + 1)}</button>
          </li>
        ))}
      </ul>
      <button type="button" disabled={disabled} onClick={() => patch((doc) => { pushAt(doc, base, { id: `region-${regions.length + 1}`, x: 0, y: 0, width: 512, height: 768 }); })}>Add region</button>
      <FieldProblems id={`fe-${base.join("-")}-problems`} problems={problemsFor(problems, base)} />
    </Group>
  );
}

function DirectionBinding({ path, value }: { path: Path; value: { assetId?: string; branchId?: string } }) {
  const { patch, disabled, assetId } = useEditor();
  const assets = useOperation("asset.list", {});
  const environments = assets.data?.ok ? assets.data.data.assets.filter((a) => a.family === "environment" && a.assetId !== assetId) : [];
  const branches = useOperation("branch.list", { assetId: value.assetId ?? "" }, { enabled: Boolean(value.assetId) });
  const list = branches.data?.ok ? branches.data.data.branches : [];
  const id = `fe-${path.join("-")}`;
  return (
    <div className="grid-2">
      <div className="field compact">
        <label htmlFor={`${id}-asset`}>Environment asset</label>
        <select id={`${id}-asset`} value={value.assetId ?? ""} disabled={disabled} onChange={(e) => patch((doc) => setAt(doc, path, { assetId: e.target.value, branchId: "", role: "direction" }))}>
          <option value="">Choose an environment…</option>
          {value.assetId && !environments.some((a) => a.assetId === value.assetId) ? <option value={value.assetId}>{value.assetId}</option> : null}
          {environments.map((a) => <option key={a.assetId} value={a.assetId}>{a.name ?? a.assetId}</option>)}
        </select>
      </div>
      <div className="field compact">
        <label htmlFor={`${id}-branch`}>Locked branch</label>
        <select id={`${id}-branch`} value={value.branchId ?? ""} disabled={disabled || !value.assetId} aria-describedby={`${id}-branch-hint`} onChange={(e) => patch((doc) => setAt(doc, path, { assetId: value.assetId, branchId: e.target.value, role: "direction" }))}>
          <option value="">{value.assetId ? (list.length === 0 ? "No locked branch yet" : "Choose a branch…") : "Pick an environment first"}</option>
          {value.branchId && !list.some((b) => b.branchId === value.branchId) ? <option value={value.branchId}>{value.branchId}</option> : null}
          {list.map((b) => <option key={b.branchId} value={b.branchId}>{b.name}{b.isCurrent ? " (current)" : ""}</option>)}
        </select>
        <div id={`${id}-branch-hint`} className="hint">The branch&rsquo;s locked concept output is pinned by id and hash when a plan is made.</div>
      </div>
    </div>
  );
}

function ReferenceRoles({ base, others, roles }: { base: Path; others: Array<{ id: string; regions: string[] }>; roles: Record<string, unknown> }) {
  const { patch, disabled } = useEditor();
  const entries = Object.entries(roles);
  return (
    <Group legend="Reference roles" hint="Named inputs bound to another deliverable of this asset (a region of an approved sheet) or to an environment's locked direction.">
      {entries.length === 0 ? <p className="secondary">No bindings: the branch&rsquo;s locked concept output is the reference.</p> : null}
      <ul className="plain-list">
        {entries.map(([role, binding]) => {
          const value = (typeof binding === "object" && binding !== null ? binding : {}) as Record<string, unknown>;
          const cross = "assetId" in value || "role" in value;
          const path = [...base, role];
          const target = others.find((o) => o.id === value.deliverableId);
          return (
            <li key={role} className="fam-row">
              <div className="grid-2">
                <div className="field compact">
                  <label htmlFor={`fe-${path.join("-")}-type`}>Role “{role}” binds to</label>
                  <select
                    id={`fe-${path.join("-")}-type`}
                    value={cross ? "direction" : "deliverable"}
                    disabled={disabled}
                    onChange={(e) => patch((doc) => setAt(doc, path, e.target.value === "direction" ? { assetId: "", branchId: "", role: "direction" } : { deliverableId: others[0]?.id ?? "", outputRole: "" }))}
                  >
                    <option value="deliverable">A deliverable of this asset</option>
                    <option value="direction">An environment&rsquo;s direction (cross-asset)</option>
                  </select>
                </div>
              </div>
              {cross ? <DirectionBinding path={path} value={value as { assetId?: string; branchId?: string }} /> : (
                <div className="grid-2">
                  <SelectField path={[...path, "deliverableId"]} label="Deliverable" compact emptyLabel="Choose a deliverable…" options={others.map((o) => ({ value: o.id, label: o.id }))} hint="It must also be listed in “Depends on”." />
                  {target && target.regions.length > 0
                    ? <SelectField path={[...path, "outputRole"]} label="Region" compact emptyLabel="Choose a region…" options={target.regions.map((r) => ({ value: r, label: r }))} />
                    : <TextField path={[...path, "outputRole"]} label="Output role" compact hint="The region id of a reference sheet." />}
                </div>
              )}
              <button type="button" className="ghost sm" disabled={disabled} onClick={() => patch((doc) => removeAt(doc, path))}>Remove role {role}</button>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <button type="button" disabled={disabled} onClick={() => patch((doc) => setAt(doc, [...base, entries.some(([r]) => r === "direction") ? `role-${entries.length + 1}` : "direction"], { assetId: "", branchId: "", role: "direction" }))}>Add environment direction</button>
        <button type="button" disabled={disabled || others.length === 0} onClick={() => patch((doc) => setAt(doc, [...base, `role-${entries.length + 1}`], { deliverableId: others[0]?.id ?? "", outputRole: "" }))}>Add deliverable binding</button>
      </div>
    </Group>
  );
}

/**
 * One deliverable: what it asks for, as text, and its fields in place once opened. Prompt text comes first; id, kind,
 * dependencies, timing, reference and output share one disclosure. `siblings` are the YAML indices of the deliverables
 * in the same group, so Move up and Move down stay inside what the reader sees.
 */
export function DeliverableRow({ index, siblings, showKind }: { index: number; siblings: readonly number[]; showKind: boolean }) {
  const { data, profile, patch, disabled, problems, open, setOpen } = useEditor();
  const list = Array.isArray(data.deliverables) ? (data.deliverables as Raw[]) : [];
  const d = list[index] ?? {};
  const base: Path = ["deliverables", index];
  const id = String(d.id ?? "");
  const part = `deliverable:${id}`;
  const isOpen = open.has(part);
  const kind = d.kind ?? "still";
  const others = list.map((item, i) => ({ id: String(item.id ?? ""), regions: (item.regions ?? []).map((r) => String(r.id ?? "")), i })).filter((o) => o.i !== index && o.id !== "");
  const required = profile?.requiredFields[kind] ?? [];
  const reqPrefix = (prefix: string) => required.some((f) => f.startsWith(prefix));
  const showAnimation = kind === "animation" || d.animation !== undefined || reqPrefix("animation");
  const showEnv = d.environment !== undefined || offers(profile, "environment") || reqPrefix("environment");
  const showUi = d.ui !== undefined || offers(profile, "ui") || reqPrefix("ui");
  const envField = (name: string) => d.environment?.[name] !== undefined || offers(profile, `environment.${name}`) || required.includes(`environment.${name}`);
  const kinds = profile?.allowedKinds ?? Object.keys(KIND_LABEL);
  const own = problemsFor(problems, base);
  const hasNine = d.ui?.nineSlice !== undefined;
  const motionNone = profile?.motion === "none";
  const description = typeof d.description === "string" ? d.description : "";
  const anim = d.animation ?? {};
  const motion = typeof anim.motion === "string" ? anim.motion : "";

  // Problems on the deliverable itself print at the foot; the rest belong to a field, up front or under More.
  const moreProblems = own.filter((p) => problemPlace(normalizeField(p.field ?? ""), index) === "more");
  // More's open state lives with the editor's, keyed by id, so it survives a move. A row opened with a problem
  // under More opens More too; a later fix never folds it away under the pointer.
  const moreKey = `more:${id}`;
  const toggle = () => {
    setOpen(part, !isOpen);
    if (!isOpen && moreProblems.length > 0) setOpen(moreKey, true);
  };
  const more = ["dependencies", ...(showAnimation ? ["timing"] : []), ...(kind !== "reference-sheet" ? ["reference"] : []), ...(showEnv ? ["tiles"] : []), ...(showUi ? ["UI state"] : []), "output"];

  const out = d.output ?? {};
  const tile = d.environment?.tileSize;
  const uiState = d.ui?.state;
  const facts: ReactNode[] = [];
  if (anim.loop === true) facts.push("Loops");
  if (anim.loop === false) facts.push("Plays once");
  if (typeof anim.sourceFrameCount === "number") facts.push(`${anim.sourceFrameCount} frames`);
  if (typeof anim.playbackFps === "number") facts.push(`${anim.playbackFps} fps`);
  if (d.regions && d.regions.length > 0) facts.push(<>{d.regions.length} regions: <code>{d.regions.map((r) => String(r.id ?? "")).join(", ")}</code></>);
  if (typeof out.width === "number" && typeof out.height === "number") facts.push(<span className="mono">{out.width} × {out.height}</span>);
  if (typeof tile === "object" && tile !== null && "width" in tile && "height" in tile && typeof tile.width === "number" && typeof tile.height === "number") facts.push(<><span className="mono">{tile.width} × {tile.height}</span> tiles</>);
  if (typeof uiState === "string") facts.push(`${uiState} state`);
  if (typeof d.referenceStrength === "number") facts.push(`reference strength ${d.referenceStrength}`);
  if (d.dependsOn && d.dependsOn.length > 0) facts.push(<>after <code>{d.dependsOn.join(", ")}</code></>);

  const position = siblings.indexOf(index);
  const above = siblings[position - 1];
  const below = siblings[position + 1];
  const sub = [showKind || isOpen ? (KIND_LABEL[kind] ?? kind) : "", d.required === false ? "optional" : ""].filter(Boolean).join(" · ");
  const editId = `fe-deliverables-${index}-edit`;

  return (
    <li className={`spec-row${isOpen ? " open" : ""}`} id={id === "" ? undefined : `def-d-${id}`}>
      {/* The whole head opens the row, except a click that only finishes selecting its text; the button is the keyboard path. */}
      <div className="spec-row-head" onClick={(event: MouseEvent) => { if (!(event.target instanceof Element && event.target.closest("button")) && window.getSelection()?.isCollapsed !== false) toggle(); }}>
        <button type="button" className="spec-toggle" aria-expanded={isOpen} aria-controls={isOpen ? editId : undefined} onClick={toggle}>
          <code>{id === "" ? "no id" : id}</code>
          {sub === "" ? null : <span className="spec-sub">{sub}</span>}
        </button>
        {isOpen ? null : (
          <div className="spec-read">
            {description === "" ? <p className="faint">No description yet.</p> : <p className={`spec-desc${isPlaceholder(description) ? " placeholder" : ""}`}>{description}</p>}
            {motion === "" ? null : <p className={`spec-motion${isPlaceholder(motion) ? " placeholder" : ""}`}><span>Motion</span> {motion}</p>}
            {facts.length === 0 ? null : <p className="spec-facts">{facts.map((fact, i) => <span key={i}>{fact}</span>)}</p>}
          </div>
        )}
        <span className="spec-mark">
          {isOpen ? null : <ProblemFlag problems={own} />}
          <Icon name={isOpen ? "chevron-up" : "chevron-down"} />
        </span>
      </div>

      {isOpen ? (
        <div className="spec-edit" id={editId}>
          <TextField path={[...base, "description"]} label="Description" area hint="What this deliverable shows, in concrete visible terms." />
          {showAnimation ? <TextField path={[...base, "animation", "motion"]} label="Motion" area hint="The motion in one concrete sentence." /> : null}
          {kind === "reference-sheet" || d.regions !== undefined ? <Regions base={[...base, "regions"]} regions={d.regions ?? []} /> : null}

          <details className="spec-more" open={open.has(moreKey)} onToggle={(e) => setOpen(moreKey, e.currentTarget.open)}>
            <summary>
              Id, kind, required, {more.slice(0, -1).join(", ")} and {more.at(-1)}
              <ProblemFlag problems={moreProblems} />
            </summary>
            <div className="spec-more-body">
              <div className="grid-2">
                <IdField index={index} />
                <SelectField
                  path={[...base, "kind"]}
                  label="Kind"
                  compact
                  options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }))}
                  hint={motionNone ? `${profile?.label} assets are static: no animation kind.` : profile?.motion === "optional" ? "Pick Animation to add the optional motion." : undefined}
                  onPick={(next, doc) => {
                    if (next === "animation" && d.animation === undefined) setAt(doc, [...base, "animation"], { motion: "REPLACE: the motion in one concrete sentence", loop: true });
                    if (next === "reference-sheet" && d.regions === undefined) setAt(doc, [...base, "regions"], [{ id: "front", x: 0, y: 0, width: 512, height: 768, view: "front view, facing the camera" }]);
                  }}
                />
              </div>
              <CheckField path={[...base, "required"]} fallback label="Required for completeness" hint="Optional deliverables never block promotion." />
              <MultiPick path={[...base, "dependsOn"]} label="Depends on" options={others.map((o) => o.id)} emptyText="No other deliverables to depend on yet." hint="Dependencies are produced and approved first." />

              {showAnimation ? (
                <Group legend="Timing" hint="Loop, frame rates and the poses it starts and ends on.">
                  <div className="grid-2">
                    <LoopField path={[...base, "animation", "loop"]} />
                    <NumberField path={[...base, "animation", "sourceFps"]} label="Source fps" min={1} compact />
                    <NumberField path={[...base, "animation", "playbackFps"]} label="Playback fps" min={1} compact />
                    <NumberField path={[...base, "animation", "sourceFrameCount"]} label="Frame count" min={1} step={1} compact hint="The workflow needs 4n+1 frames (for example 33)." />
                    <SelectField path={[...base, "animation", "startReference"]} label="Start reference" compact emptyLabel="Concept / none" options={others.map((o) => ({ value: o.id, label: o.id }))} />
                    <SelectField path={[...base, "animation", "endReference"]} label="End reference" compact emptyLabel="Same as start / none" options={others.map((o) => ({ value: o.id, label: o.id }))} />
                  </div>
                </Group>
              ) : null}

              {kind !== "reference-sheet" ? (
                <>
                  <Group legend="Reference">
                    <NumberField path={[...base, "referenceStrength"]} label="Reference strength" min={0} step={0.5} compact hint="0–20. Lower lets the pose change more. Leave empty for the workflow default." />
                  </Group>
                  <ReferenceRoles base={[...base, "referenceRoles"]} others={others} roles={(d.referenceRoles ?? {}) as Record<string, unknown>} />
                </>
              ) : null}

              {showEnv ? (
                <Group legend="Environment and tile" hint={sectionHint(profile, "environment", "tile") ?? "Intended use as a layer or tile; not level placement."}>
                  <div className="grid-2">
                    {envField("layer") ? <TextField path={[...base, "environment", "layer"]} label="Layer" compact hint="A project layer id such as far, mid, near." /> : null}
                    {envField("relativeScale") ? <NumberField path={[...base, "environment", "relativeScale"]} label="Relative scale" min={0} compact /> : null}
                    {envField("pivot") ? <><NumberField path={[...base, "environment", "pivot", "x"]} label="Pivot x" compact /><NumberField path={[...base, "environment", "pivot", "y"]} label="Pivot y" compact /></> : null}
                    {envField("tileSize") ? <><NumberField path={[...base, "environment", "tileSize", "width"]} label="Tile width" min={1} step={1} unit="px" compact errorPath={[...base, "environment", "tileSize"]} /><NumberField path={[...base, "environment", "tileSize", "height"]} label="Tile height" min={1} step={1} unit="px" compact /></> : null}
                    {envField("parallax") ? <><NumberField path={[...base, "environment", "parallax", "x"]} label="Parallax x" step={0.1} compact hint="1 moves with the camera, 0 stays." /><NumberField path={[...base, "environment", "parallax", "y"]} label="Parallax y" step={0.1} compact /></> : null}
                  </div>
                  {envField("connections") ? (
                    <fieldset className="fam-group">
                      <legend>Connection labels</legend>
                      <p className="secondary">Matching labels declare which tiles may meet. They do not prove the edges match pixel for pixel — check the seams visually.</p>
                      <div className="grid-2">
                        {(["north", "east", "south", "west"] as const).map((side) => <TextField key={side} path={[...base, "environment", "connections", side]} label={side[0]!.toUpperCase() + side.slice(1)} compact />)}
                      </div>
                      <FieldProblems id={`fe-conn-${index}`} problems={problemsFor(problems, [...base, "environment", "connections"])} />
                    </fieldset>
                  ) : null}
                  {envField("seamlessAxes") ? (
                    <fieldset className="field">
                      <legend>Seamless axes</legend>
                      <div className="row">
                        {(["x", "y"] as const).map((axis) => {
                          const current = Array.isArray(d.environment?.seamlessAxes) ? (d.environment?.seamlessAxes as string[]) : [];
                          return (
                            <label key={axis} className="check">
                              <input
                                type="checkbox"
                                checked={current.includes(axis)}
                                disabled={disabled}
                                onChange={(e) => {
                                  const next = (["x", "y"] as const).filter((a) => (a === axis ? e.target.checked : current.includes(a)));
                                  patch((doc) => setAt(doc, [...base, "environment", "seamlessAxes"], d.environment?.seamlessAxes === undefined && next.length === 0 ? undefined : next));
                                }}
                              />
                              Repeats on {axis}
                            </label>
                          );
                        })}
                      </div>
                      <div className="hint">A seamless axis must have equal opposite connection labels. Wrap is previewed on the output page.</div>
                      <FieldProblems id={`fe-seam-${index}`} problems={problemsFor(problems, [...base, "environment", "seamlessAxes"])} />
                    </fieldset>
                  ) : null}
                </Group>
              ) : null}

              {showUi ? (
                <Group legend="UI state and nine-slice" hint={sectionHint(profile, "ui") ?? "State name and stretch margins in pixels of the output."}>
                  <TextField path={[...base, "ui", "state"]} label="State" compact hint="For example normal, hover, pressed, disabled." />
                  {offers(profile, "ui.nineSlice") ? (
                    <>
                      <div className="field compact">
                        <label className="check" htmlFor={`fe-nine-toggle-${index}`}>
                          <input id={`fe-nine-toggle-${index}`} type="checkbox" checked={hasNine} disabled={disabled} onChange={(e) => patch((doc) => setAt(doc, [...base, "ui", "nineSlice"], e.target.checked ? { left: 16, top: 16, right: 16, bottom: 16 } : undefined))} />
                          Use nine-slice margins
                        </label>
                        <div className="hint">Corners stay fixed; edges and centre stretch.</div>
                      </div>
                      {hasNine ? (
                        <div className="grid-2">
                          {(["left", "top", "right", "bottom"] as const).map((side) => <NumberField key={side} path={[...base, "ui", "nineSlice", side]} label={side[0]!.toUpperCase() + side.slice(1)} min={0} step={1} unit="px" compact errorPath={[...base, "ui", "nineSlice"]} />)}
                        </div>
                      ) : null}
                      <FieldProblems id={`fe-nine-${index}`} problems={problemsFor(problems, [...base, "ui", "nineSlice"])} />
                    </>
                  ) : null}
                </Group>
              ) : null}

              <Group legend="Output" hint={sectionHint(profile, "output")}>
                <div className="grid-2">
                  <SelectField
                    path={[...base, "output", "alpha"]}
                    label="Background"
                    compact
                    emptyLabel={profile ? `Family default (${profile.alpha === "matte" ? "transparent" : profile.alpha === "opaque" ? "opaque" : "per deliverable"})` : "Family default"}
                    options={[{ value: "transparent", label: "Transparent (background removed)" }, { value: "opaque", label: "Opaque (full frame)" }]}
                  />
                  <NumberField path={[...base, "output", "width"]} label="Width" min={1} step={1} unit="px" compact errorPath={[...base, "output"]} />
                  <NumberField path={[...base, "output", "height"]} label="Height" min={1} step={1} unit="px" compact />
                </div>
              </Group>

              <div className="row spec-actions">
                <button type="button" id={`${editId}-up`} className="ghost sm" disabled={disabled || above === undefined} onClick={() => { if (above === undefined) return; patch((doc) => moveAt(doc, ["deliverables"], index, above)); focusMoved(above, "up"); }}>Move up</button>
                <button type="button" id={`${editId}-down`} className="ghost sm" disabled={disabled || below === undefined} onClick={() => { if (below === undefined) return; patch((doc) => moveAt(doc, ["deliverables"], index, below)); focusMoved(below, "down"); }}>Move down</button>
                <button type="button" className="danger sm" disabled={disabled} onClick={() => { patch((doc) => removeAt(doc, base)); setOpen(part, false); setOpen(moreKey, false); }}>Remove {id === "" ? "deliverable" : id}</button>
              </div>
            </div>
          </details>
          <FieldProblems id={`fe-d-${index}`} problems={own.filter((p) => problemPlace(normalizeField(p.field ?? ""), index) === "row")} />
        </div>
      ) : null}
    </li>
  );
}

/** Rows are keyed by index, so a moved row's controls remount at its new index: put focus back on its move buttons. */
function focusMoved(at: number, button: "up" | "down") {
  requestAnimationFrame(() => {
    const preferred = document.getElementById(`fe-deliverables-${at}-edit-${button}`);
    const other = document.getElementById(`fe-deliverables-${at}-edit-${button === "up" ? "down" : "up"}`);
    (preferred instanceof HTMLButtonElement && !preferred.disabled ? preferred : other)?.focus();
  });
}

function LoopField({ path }: { path: Path }) {
  const { data, patch, disabled } = useEditor();
  const raw = getAt(data, path);
  const id = `fe-${path.join("-")}`;
  return (
    <div className="field compact">
      <label htmlFor={id}>Playback</label>
      <select id={id} value={raw === true ? "loop" : raw === false ? "once" : ""} disabled={disabled} aria-describedby={`${id}-hint`} onChange={(e) => patch((doc) => setAt(doc, path, e.target.value === "" ? undefined : e.target.value === "loop"))}>
        <option value="">Not set</option>
        <option value="loop">Loops</option>
        <option value="once">Plays once</option>
      </select>
      <div id={`${id}-hint`} className="hint">Cycles loop; effects and one-shot motions play once. Write it explicitly.</div>
    </div>
  );
}

function IdField({ index }: { index: number }) {
  const { data, patch, disabled, problems, setOpen } = useEditor();
  const list = Array.isArray(data.deliverables) ? (data.deliverables as Raw[]) : [];
  const current = String(list[index]?.id ?? "");
  const path: Path = ["deliverables", index, "id"];
  const mine = problemsFor(problems, path);
  const id = `fe-deliverables-${index}-id`;
  return (
    <div className="field compact">
      <label htmlFor={id}>Id</label>
      <input
        id={id}
        type="text"
        value={current}
        disabled={disabled}
        autoComplete="off"
        aria-invalid={mine.some((p) => p.severity !== "warning") || undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          const next = e.target.value;
          patch((doc: Document) => {
            setAt(doc, path, next);
            if (current !== "") renameDeliverableRefs(doc, current, next);
          });
          // The row and its More stay open under the new id.
          setOpen(`deliverable:${current}`, false);
          setOpen(`more:${current}`, false);
          setOpen(`deliverable:${next}`, true);
          setOpen(`more:${next}`, true);
        }}
      />
      <div id={`${id}-hint`} className="hint">Kebab-case, unique in this asset. It becomes the step name.</div>
      <FieldProblems id={`${id}-problems`} problems={mine} />
    </div>
  );
}
