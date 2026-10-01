import { useEffect, useState, type RefObject } from "react";
import type { Annotation, CandidateOutput, FrameRange, Geometry, OperationError } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime } from "../../components/ui.tsx";
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
}

export function AnnotationPanel({ candidateId, output, annotations, selectedId, onSelect, draft, onDraftChange, formRef, frame }: PanelProps) {
  return (
    <div className="stack">
      {draft ? <DraftForm candidateId={candidateId} output={output} draft={draft} onDraftChange={onDraftChange} formRef={formRef} onCreated={onSelect} frame={frame} /> : (
        <p className="secondary">Choose Pin or Rectangle and click or drag on the image, use “Note on whole image”, or focus the image and press Enter to place a pin at the centre.</p>
      )}
      <h3>Notes on this {output.stage === "processed" ? "processed" : output.role === "matted" ? "matted" : "untouched"} output ({annotations.length})</h3>
      {annotations.length === 0 ? <p className="secondary">No notes on this output. Notes never carry over to a different output.</p> : (
        <ol className="plain stack" aria-label="Notes">
          {annotations.map((a, i) => <NoteItem key={a.annotationId} annotation={a} index={i + 1} selected={a.annotationId === selectedId} onSelect={onSelect} />)}
        </ol>
      )}
    </div>
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
      className="panel stack"
      aria-label="New note"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDraftChange(undefined);
      }}
    >
      <h3>New note — {describe(draft)}</h3>
      {draft.kind !== "whole" ? (
        <fieldset className="row" aria-label="Position in percent of the image">
          <legend className="secondary">Position (% of image; drag or use the arrow keys on the image)</legend>
          {(draft.kind === "pin" ? (["x", "y"] as const) : (["x", "y", "width", "height"] as const)).map((field) => (
            <label key={field} className="secondary">{field}{" "}
              <input type="number" min={0} max={100} step="any" style={{ width: 84 }} value={pct(draft.kind === "pin" ? draft[field as "x" | "y"] : draft.kind === "rect" ? draft[field] : 0)} onChange={(e) => setField(field, Number(e.target.value))} />
            </label>
          ))}
        </fieldset>
      ) : null}
      {frame ? (
        <fieldset className="row" aria-label="Source frames this note applies to">
          <legend className="secondary">Applies to source frames (1 to {frame.lastSourceFrame + 1}); the note stays on source frames even if the clip is resampled</legend>
          <label className="secondary">from{" "}
            <input type="number" min={1} max={frame.lastSourceFrame + 1} style={{ width: 72 }} value={range.start + 1} onChange={(e) => setRange({ start: Math.max(0, Number(e.target.value) - 1), end: Math.max(range.end, Number(e.target.value) - 1) })} />
          </label>
          <label className="secondary">to{" "}
            <input type="number" min={1} max={frame.lastSourceFrame + 1} style={{ width: 72 }} value={range.end + 1} onChange={(e) => setRange({ start: Math.min(range.start, Number(e.target.value) - 1), end: Math.max(0, Number(e.target.value) - 1) })} />
          </label>
        </fieldset>
      ) : null}
      <div className="field">
        <label htmlFor="note-text">Note</label>
        <textarea id="note-text" ref={formRef} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
      </div>
      <label className="row"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Requires revision</label>
      <div className="row">
        <button type="submit" className="primary" disabled={text.trim() === "" || create.isPending || (draft.kind === "rect" && (draft.width === 0 || draft.height === 0))}>Add note</button>
        <button type="button" onClick={() => onDraftChange(undefined)}>Cancel (Esc)</button>
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
      <div className="row">
        <button type="button" className="note-number" onClick={() => onSelect(a.annotationId)} aria-label={`Select note ${index}, ${describe(a.geometry)}`}>{index}</button>
        <span className="secondary">{describe(a.geometry)}{a.frameRange ? ` · ${rangeLabel(a.frameRange)}` : ""} · {a.createdBy} · {formatTime(a.updatedAt)} · v{a.version}</span>
        {a.requiresRevision ? <span className="status warn"><span aria-hidden="true">▲</span><span>Requires revision</span></span> : null}
      </div>
      {conflict ? (
        <div className="banner warn" role="alert">
          <span aria-hidden="true">▲</span>
          <div className="body">
            <strong>This note changed since you opened it</strong>
            <div>Current text: <q>{a.text}</q> (v{a.version}{a.requiresRevision ? ", requires revision" : ""})</div>
            <div>Your edit: <q>{conflict.text}</q></div>
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" onClick={() => void save(a.version)} disabled={update.isPending}>Reapply my edit on top of the current version</button>
              <button type="button" onClick={() => { setConflict(undefined); setEditing(false); }}>Discard my edit</button>
            </div>
          </div>
        </div>
      ) : null}
      {editing ? (
        <form onSubmit={(e) => { e.preventDefault(); void save(seenVersion); }} className="stack" aria-label={`Edit note ${index}`}>
          <div className="field">
            <label htmlFor={`edit-${a.annotationId}`}>Note text</label>
            <textarea id={`edit-${a.annotationId}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
          </div>
          <label className="row"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Requires revision</label>
          <div className="row">
            <button type="submit" className="primary" disabled={text.trim() === "" || update.isPending}>Save</button>
            <button type="button" onClick={() => { setEditing(false); setConflict(undefined); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{a.text}</p>
          <div className="row">
            <button type="button" onClick={() => { setSeenVersion(a.version); setEditing(true); }}>Edit</button>
            {confirmDelete ? (
              <>
                <button type="button" onClick={() => void del()} disabled={remove.isPending}>Confirm delete</button>
                <button type="button" onClick={() => setConfirmDelete(false)}>Keep</button>
              </>
            ) : <button type="button" onClick={() => { setSeenVersion(a.version); setConfirmDelete(true); }}>Delete</button>}
          </div>
        </>
      )}
      {error ? <ErrorBanner error={error} /> : null}
    </li>
  );
}
