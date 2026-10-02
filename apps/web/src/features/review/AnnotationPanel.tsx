import { useEffect, useState, type RefObject } from "react";
import type { Annotation, CandidateOutput, FrameRange, Geometry, OperationError } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, timeAgo } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { whoLabel } from "./room-lib.ts";

const describe = (g: Geometry): string => (g.kind === "whole" ? "Whole image" : g.kind === "pin" ? "Pin" : "Rectangle");
/** UI frame numbers are one-based; stored ranges are zero-based source frames. */
export const rangeLabel = (r: FrameRange): string => (r.start === r.end ? `source frame ${r.start + 1}` : `source frames ${r.start + 1}–${r.end + 1}`);

export interface FrameContext {
  /** Zero-based source frame showing in the player. */
  sourceFrame: number;
  lastSourceFrame: number;
}

interface PanelProps {
  candidateId: string;
  output: CandidateOutput;
  /** Notes on exactly this output's bytes (matching hash), already filtered by the caller. */
  annotations: Annotation[];
  selectedId: string | undefined;
  onSelect: (annotationId: string | undefined) => void;
  draft: Geometry | undefined;
  onDraftChange: (geometry: Geometry | undefined) => void;
  formRef: RefObject<HTMLTextAreaElement | null>;
  /** Present for frame-sequence outputs: notes then carry a source-frame range. */
  frame?: FrameContext;
  /** Notes made on other outputs of this candidate and so not shown here. */
  elsewhere: number;
}

/** The numbered notes of the output on the stage, with the form for a note being placed. */
export function AnnotationPanel({ candidateId, output, annotations, selectedId, onSelect, draft, onDraftChange, formRef, frame, elsewhere }: PanelProps) {
  return (
    <section className="notes" id="room-notes" aria-labelledby="notes-title">
      <div className="notes-head"><h2 id="notes-title">Notes</h2><span className="n">{annotations.length}</span></div>
      {draft ? <DraftForm candidateId={candidateId} output={output} draft={draft} onDraftChange={onDraftChange} formRef={formRef} onCreated={onSelect} frame={frame} /> : null}
      {annotations.length === 0 && !draft ? <p className="secondary">No notes on this output. Use Note on the stage to pin something, mark a rectangle or comment on the whole image. Notes never carry over to a different output.</p> : null}
      {annotations.length > 0 ? (
        <ol className="plain" aria-label="Notes">
          {annotations.map((a, i) => <NoteItem key={a.annotationId} annotation={a} index={i + 1} selected={a.annotationId === selectedId} onSelect={onSelect} />)}
        </ol>
      ) : null}
      {elsewhere > 0 ? <p className="secondary">{elsewhere} {elsewhere === 1 ? "note was" : "notes were"} made on another output and {elsewhere === 1 ? "is" : "are"} not shown here.</p> : null}
    </section>
  );
}

const pct = (v: number) => Math.round(v * 1000) / 10;

function DraftForm({ candidateId, output, draft, onDraftChange, formRef, onCreated, frame }: { candidateId: string; output: CandidateOutput; draft: Geometry; onDraftChange: (g: Geometry | undefined) => void; formRef: RefObject<HTMLTextAreaElement | null>; onCreated: (id: string) => void; frame: FrameContext | undefined }) {
  const create = useMutationOperation("annotation.create");
  const [text, setText] = useState("");
  const [required, setRequired] = useState(false);
  const [error, setError] = useState<OperationError | undefined>();
  // Defaults to the frame showing when the note was started; the range is edited by the reviewer.
  const [range, setRange] = useState<FrameRange>({ start: frame?.sourceFrame ?? 0, end: frame?.sourceFrame ?? 0 });

  const setField = (field: "x" | "y" | "width" | "height", value: number) => {
    if (draft.kind === "pin" && (field === "x" || field === "y")) onDraftChange({ ...draft, [field]: Math.min(1, Math.max(0, value / 100)) });
    else if (draft.kind === "rect") onDraftChange({ ...draft, [field]: Math.min(1, Math.max(0, value / 100)) });
  };
  const save = async () => {
    if (text.trim() === "") return;
    setError(undefined);
    const result = await create.mutateAsync({ input: { candidateId, outputId: output.outputId, geometry: draft, ...(frame ? { frameRange: range } : {}), text: text.trim(), requiresRevision: required } });
    if (!result.ok) return setError(result.error);
    setText("");
    setRequired(false);
    onDraftChange(undefined);
    onCreated(result.data.annotation.annotationId);
  };

  return (
    <form
      className="note-draft"
      aria-label="New note"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDraftChange(undefined);
      }}
    >
      <h3>New note · {describe(draft).toLowerCase()}</h3>
      <div className="field compact">
        <label htmlFor="note-text" className="sr-only">Note</label>
        <textarea id="note-text" ref={formRef} rows={3} value={text} placeholder="What should change?" onChange={(e) => setText(e.target.value)} maxLength={4000} />
      </div>
      <label><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Blocks approval until it is revised</label>
      {frame ? (
        <fieldset className="range-fields" aria-label="Source frames this note applies to">
          <legend>Applies to source frames 1 to {frame.lastSourceFrame + 1}</legend>
          <label>from
            <input type="number" min={1} max={frame.lastSourceFrame + 1} value={range.start + 1} onChange={(e) => setRange({ start: Math.max(0, Number(e.target.value) - 1), end: Math.max(range.end, Number(e.target.value) - 1) })} />
          </label>
          <label>to
            <input type="number" min={1} max={frame.lastSourceFrame + 1} value={range.end + 1} onChange={(e) => setRange({ start: Math.min(range.start, Number(e.target.value) - 1), end: Math.max(0, Number(e.target.value) - 1) })} />
          </label>
        </fieldset>
      ) : null}
      {draft.kind !== "whole" ? (
        <details>
          <summary>Position</summary>
          <fieldset className="range-fields" aria-label="Position in percent of the image">
            <legend>Percent of the image. Drag, or use the arrow keys on the image.</legend>
            {(draft.kind === "pin" ? (["x", "y"] as const) : (["x", "y", "width", "height"] as const)).map((field) => (
              <label key={field}>{field}
                <input type="number" min={0} max={100} step="any" value={pct(draft.kind === "pin" ? draft[field as "x" | "y"] : draft.kind === "rect" ? draft[field] : 0)} onChange={(e) => setField(field, Number(e.target.value))} />
              </label>
            ))}
          </fieldset>
        </details>
      ) : null}
      <div className="row">
        <button type="submit" disabled={text.trim() === "" || create.isPending || (draft.kind === "rect" && (draft.width === 0 || draft.height === 0))}>Add note</button>
        <button type="button" className="ghost" onClick={() => onDraftChange(undefined)}>Cancel</button>
        <kbd aria-label="Escape cancels">Esc</kbd>
      </div>
      {error ? <ErrorBanner error={error} /> : null}
    </form>
  );
}

function NoteItem({ annotation: a, index, selected, onSelect }: { annotation: Annotation; index: number; selected: boolean; onSelect: (id: string | undefined) => void }) {
  const update = useMutationOperation("annotation.update");
  const remove = useMutationOperation("annotation.delete");
  const [editing, setEditing] = useState(false);
  /** The version the user was looking at when they began editing or deleting; live refreshes must not silently rebase it. */
  const [seenVersion, setSeenVersion] = useState(a.version);
  const [text, setText] = useState(a.text);
  const [required, setRequired] = useState(a.requiresRevision);
  const [conflict, setConflict] = useState<{ text: string; required: boolean } | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<OperationError | undefined>();

  useEffect(() => {
    if (!editing) {
      setText(a.text);
      setRequired(a.requiresRevision);
    }
  }, [a.text, a.requiresRevision, editing]);

  const save = async (expectedVersion: number) => {
    setError(undefined);
    const result = await update.mutateAsync({ input: { annotationId: a.annotationId, expectedVersion, text: text.trim(), requiresRevision: required } });
    if (result.ok) {
      setEditing(false);
      setConflict(undefined);
    } else if (result.error.code === "REVISION_CONFLICT") {
      setConflict({ text: text.trim(), required });
    } else setError(result.error);
  };
  const del = async () => {
    setError(undefined);
    const result = await remove.mutateAsync({ input: { annotationId: a.annotationId, expectedVersion: seenVersion } });
    if (!result.ok) {
      setConfirmDelete(false);
      setError(result.error);
    } else onSelect(undefined);
  };

  return (
    <li className={`note${selected ? " selected" : ""}`} aria-current={selected ? "true" : undefined}>
      <button type="button" className={`num${a.requiresRevision ? " req" : ""}`} onClick={() => onSelect(selected ? undefined : a.annotationId)} aria-label={`Note ${index}, ${describe(a.geometry).toLowerCase()}${selected ? ", selected" : ""}`}>{index}</button>
      <div>
        {conflict ? (
          <div className="banner warn" role="alert">
            <Icon name="warn" />
            <div className="body">
              <strong>This note changed since you opened it</strong>
              <div>Current text: <q>{a.text}</q> (v{a.version}{a.requiresRevision ? ", blocks approval" : ""})</div>
              <div>Your edit: <q>{conflict.text}</q></div>
              <div className="row">
                <button type="button" className="sm" onClick={() => void save(a.version)} disabled={update.isPending}>Reapply my edit on top</button>
                <button type="button" className="sm ghost" onClick={() => { setConflict(undefined); setEditing(false); }}>Discard my edit</button>
              </div>
            </div>
          </div>
        ) : null}
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); void save(seenVersion); }} className="note-edit" aria-label={`Edit note ${index}`}>
            <label htmlFor={`edit-${a.annotationId}`} className="sr-only">Note text</label>
            <textarea id={`edit-${a.annotationId}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
            <label><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Blocks approval until it is revised</label>
            <div className="row">
              <button type="submit" className="sm" disabled={text.trim() === "" || update.isPending}>Save</button>
              <button type="button" className="sm ghost" onClick={() => { setEditing(false); setConflict(undefined); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <p>{a.text}</p>
            <div className="by">
              {a.requiresRevision ? <span className="flag"><Icon name="alert" size="sm" />Blocks approval</span> : null}
              {whoLabel(a.createdBy)}{a.frameRange ? ` · ${rangeLabel(a.frameRange)}` : ""} · {describe(a.geometry).toLowerCase()}{a.requiresRevision ? "" : " · doesn’t block approval"}
              <span className="faint"> · <time dateTime={a.updatedAt} title={formatTime(a.updatedAt)}>{timeAgo(a.updatedAt)}</time>{a.version > 1 ? ` · edited (v${a.version})` : ""}</span>
            </div>
            {selected ? (
              <div className="row note-actions">
                <button type="button" className="sm ghost" onClick={() => { setSeenVersion(a.version); setEditing(true); }}>Edit</button>
                {confirmDelete ? (
                  <>
                    <button type="button" className="sm danger" onClick={() => void del()} disabled={remove.isPending}>Delete this note</button>
                    <button type="button" className="sm ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
                  </>
                ) : <button type="button" className="sm ghost" onClick={() => { setSeenVersion(a.version); setConfirmDelete(true); }}>Delete…</button>}
              </div>
            ) : null}
          </>
        )}
        {error ? <ErrorBanner error={error} /> : null}
      </div>
    </li>
  );
}
