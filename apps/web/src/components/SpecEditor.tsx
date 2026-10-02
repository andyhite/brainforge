import { useMemo, useRef } from "react";
import { parseDocument } from "yaml";
import type { Problem } from "@brainforge/contracts";
import type { SpecFile } from "../lib/spec-file.ts";
import { Banner, ErrorBanner, Modal, ProblemList, Status } from "./ui.tsx";
import "../features/families/families.css";

export const BLOCKED_TEXT = "While this file is invalid, new work that depends on it is blocked. Existing previews and history stay readable.";

/** Live syntax problems from the draft itself (before the server sees it). */
export function draftSyntaxProblems(path: string, text: string): Problem[] {
  if (text.trim() === "") return [];
  const doc = parseDocument(text, { prettyErrors: true });
  return doc.errors.map((error) => ({
    file: path,
    ...(error.linePos?.[0] ? { line: error.linePos[0].line, column: error.linePos[0].col } : {}),
    message: `YAML syntax: ${(error.message.split("\n")[0] ?? error.message).replace(/ at line \d+, column \d+:?$/, "")}`,
  }));
}

export function ConflictDialog({ file }: { file: SpecFile }) {
  const conflict = file.conflict;
  return (
    <Modal
      open={conflict !== undefined}
      onOpenChange={(open) => { if (!open) file.closeConflict(); }}
      title="This file changed on disk"
      description={`Someone else saved ${file.path} after you opened it. Your draft is kept; nothing has been overwritten.`}
    >
      {conflict ? (
        <div className="stack">
          <div className="diff-cols">
            <div>
              <h3>Yours (unsaved draft)</h3>
              <pre tabIndex={0} aria-label="Your draft text">{conflict.mine}</pre>
            </div>
            <div>
              <h3>Currently on disk</h3>
              <pre tabIndex={0} aria-label="Text currently on disk">{conflict.disk.hash === null ? "(file no longer exists)" : conflict.disk.text}</pre>
            </div>
          </div>
          {file.saveError && "code" in file.saveError ? <ErrorBanner error={file.saveError} /> : null}
          <div className="row end">
            <button type="button" onClick={file.resolveLoadDisk}>Load disk version</button>
            <button type="button" className="primary" onClick={() => void file.resolveKeepMine()} disabled={file.saving}>
              Keep mine and retry on top of disk version
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

export function SaveBar({ file }: { file: SpecFile }) {
  return (
    <div className="save-bar" role="group" aria-label="Save changes">
      <span className="save-state" aria-live="polite">
        {file.dirty ? <Status tone="warn">Unsaved changes</Status> : file.savedHash ? <Status tone="ok">Saved</Status> : <Status tone="idle">No changes</Status>}
        {file.missing ? <span className="secondary">This file does not exist yet; saving creates it.</span> : null}
      </span>
      <button type="button" className="ghost" onClick={file.discardDraft} disabled={!file.dirty || file.saving}>Discard changes</button>
      <button type="button" className="primary" onClick={() => void file.save()} disabled={!file.dirty || file.saving}>
        {file.saving ? "Saving…" : file.missing ? "Create file" : "Save"}
      </button>
    </div>
  );
}

export function ExternalChangeBanner({ file }: { file: SpecFile }) {
  if (!file.externalChange) return null;
  return (
    <Banner
      tone="warn"
      title="This file changed on disk while you have unsaved edits"
      actions={
        <>
          <button type="button" onClick={file.dismissExternalChange}>Keep my draft</button>
          <button type="button" onClick={file.loadDisk}>Load disk version</button>
        </>
      }
    >
      Keeping your draft leaves it untouched; saving later will show both versions side by side before anything is replaced.
    </Banner>
  );
}

/** Accessible YAML text editor with a line/column problem list. */
export function SpecEditor({ file, onOpenFile }: { file: SpecFile; onOpenFile?: (path: string) => string }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const syntax = useMemo(() => draftSyntaxProblems(file.path, file.draft), [file.path, file.draft]);
  // Local syntax errors carry exact line/column; keep server problems that are not the same syntax error.
  const all = [...syntax, ...file.problems.filter((p) => !syntax.some((s) => s.message.includes(p.message)))];

  const goTo = (problem: Problem) => {
    const element = area.current;
    if (!element || problem.line === undefined) return;
    const lines = file.draft.split("\n");
    let offset = 0;
    for (let index = 0; index < problem.line - 1 && index < lines.length; index += 1) offset += (lines[index]?.length ?? 0) + 1;
    offset += Math.max(0, (problem.column ?? 1) - 1);
    element.focus();
    element.setSelectionRange(offset, offset);
  };

  if (file.loadError) {
    return "code" in file.loadError ? <ErrorBanner error={file.loadError} /> : <Banner tone="bad" title="Cannot load file">{file.loadError.message}</Banner>;
  }
  return (
    <div>
      <ExternalChangeBanner file={file} />
      <SaveBar file={file} />
      {file.saveError && !file.conflict ? ("code" in file.saveError ? <ErrorBanner error={file.saveError} /> : <Banner tone="bad" title="Save failed">{file.saveError.message}</Banner>) : null}
      <div className="editor-wrap">
        <label htmlFor={`editor-${file.path}`} className="sr-only">YAML text of {file.path}</label>
        <textarea
          id={`editor-${file.path}`}
          ref={area}
          className="editor-area"
          spellCheck={false}
          value={file.draft}
          disabled={file.loading}
          onChange={(event) => file.setDraft(event.target.value)}
          aria-describedby={`problems-${file.path}`}
        />
      </div>
      <div id={`problems-${file.path}`} className="spec-problems">
        {all.length === 0 ? (
          <Status tone="ok">No problems</Status>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 4 }}>
              {all.some((p) => p.severity !== "warning") ? <Status tone="bad">{all.filter((p) => p.severity !== "warning").length} error{all.filter((p) => p.severity !== "warning").length === 1 ? "" : "s"}</Status> : null}
              {all.some((p) => p.severity === "warning") ? <Status tone="warn">{all.filter((p) => p.severity === "warning").length} warning{all.filter((p) => p.severity === "warning").length === 1 ? "" : "s"}</Status> : null}
              <span className="secondary">{file.dirty ? "Syntax is checked live; schema checks run when saved." : "As last read from disk."}</span>
            </div>
            <ProblemList problems={all} blocked={BLOCKED_TEXT} {...(onOpenFile ? { onOpenFile } : {})} />
            <div className="row" style={{ marginTop: 8 }}>
              {all.filter((p) => p.line !== undefined).slice(0, 5).map((p, index) => (
                <button key={`${p.line}-${index}`} type="button" onClick={() => goTo(p)}>Go to line {p.line}:{p.column ?? 1}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
