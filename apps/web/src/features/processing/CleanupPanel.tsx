import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Candidate, CandidateOutput, OperationData } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem } from "../../components/ui.tsx";

type Exported = OperationData<"candidate.export-cleanup">;

const label = (output: CandidateOutput) => `${output.stage === "source" ? "Source" : "Processed"} · ${output.role === "matted" ? "matted" : "untouched"} · ${output.frameCount ?? "?"} frames${output.playbackFps ? ` at ${output.playbackFps} fps` : ""}`;

/** Parses "1, 4-6" (1-based, as shown in the player) into sorted unique zero-based indices. Throws a message naming the bad token. */
function parseFrames(text: string, count: number): number[] {
  const indices = new Set<number>();
  for (const token of text.split(/[,\s]+/).filter((part) => part !== "")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!range) throw new Error(`"${token}" is not a frame number or range such as 4-6.`);
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < 1 || to < from || to > count) throw new Error(`"${token}" is outside frames 1 to ${count}.`);
    for (let n = from; n <= to; n++) indices.add(n - 1);
  }
  if (indices.size === 0) throw new Error("List at least one frame to replace.");
  return [...indices].sort((a, b) => a - b);
}

export function CleanupPanel({ candidate, frameOutputs, assetId }: { candidate: Candidate; frameOutputs: CandidateOutput[]; assetId: string }) {
  const exportOp = useMutationOperation("candidate.export-cleanup");
  const importOp = useMutationOperation("candidate.import-cleanup");
  const navigate = useNavigate();
  const requested = useSearchParams()[0].get("output");
  const preferred = frameOutputs.find((o) => o.outputId === requested) ?? frameOutputs.find((o) => o.role === "matted" && o.stage === "source") ?? frameOutputs[0];
  const [outputId, setOutputId] = useState(preferred?.outputId ?? "");
  const output = frameOutputs.find((o) => o.outputId === outputId);
  const [stage, setStage] = useState<"source" | "processed">(output?.stage ?? "source");
  useEffect(() => {
    const shown = frameOutputs.find((o) => o.outputId === requested);
    if (!shown) return;
    setOutputId(shown.outputId);
    setStage(shown.stage);
    setExported(undefined);
    // Follow the player only when the shown output changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);
  const [exported, setExported] = useState<Exported | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [directory, setDirectory] = useState("");
  const [frameText, setFrameText] = useState("");
  const [pattern, setPattern] = useState("frame-{n}.png");
  const [notes, setNotes] = useState("");
  const [effort, setEffort] = useState("");
  const [inputError, setInputError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<{ candidateId: string; label: string } | undefined>(undefined);

  const count = output?.frameCount ?? 1;
  let mapping: Array<{ index: number; file: string }> = [];
  let mappingError: string | undefined;
  if (frameText.trim() !== "" && directory.trim() !== "") {
    try {
      mapping = parseFrames(frameText, count).map((index) => ({ index, file: `${directory.trim().replace(/\/+$/, "")}/${pattern.replace("{n}", String(index).padStart(4, "0"))}` }));
    } catch (error) {
      mappingError = error instanceof Error ? error.message : String(error);
    }
  }

  const doExport = async () => {
    if (!output) return;
    setCopied(false);
    const result = await exportOp.mutateAsync({ input: { candidateId: candidate.candidateId, outputId: output.outputId, stage } });
    if (result.ok) {
      setExported(result.data);
      setDirectory(result.data.directory);
    }
  };

  const doImport = async () => {
    if (!output) return;
    setInputError(undefined);
    if (mappingError || mapping.length === 0) {
      setInputError(mappingError ?? "Enter the directory and the frames you corrected.");
      return;
    }
    const minutes = effort.trim() === "" ? undefined : Number(effort);
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes < 0)) {
      setInputError("Effort must be a number of minutes, zero or more.");
      return;
    }
    const result = await importOp.mutateAsync({
      input: { parentCandidateId: candidate.candidateId, parentOutputId: output.outputId, stage, frames: mapping, notes: notes.trim(), ...(minutes === undefined ? {} : { effortMinutes: minutes }) },
    });
    if (result.ok) {
      setCreated({ candidateId: result.data.candidate.candidateId, label: result.data.candidate.label });
      void navigate(`/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(result.data.candidate.candidateId)}?output=${encodeURIComponent(result.data.output.outputId)}`);
    }
  };

  return (
    <section className="panel" aria-labelledby="cleanup-title">
      <h2 id="cleanup-title" style={{ margin: 0 }}>External cleanup</h2>
      <p className="secondary">
        Export frames, fix them in your own editor, then import them as a <strong>new unapproved candidate</strong> linked to this one. The originals stay untouched and nothing is approved automatically.
      </p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="cleanup-output">Frames to work on</label>
          <select id="cleanup-output" value={outputId} onChange={(event) => { const next = frameOutputs.find((o) => o.outputId === event.target.value); setOutputId(event.target.value); if (next) setStage(next.stage); setExported(undefined); }}>
            {frameOutputs.map((item) => <option key={item.outputId} value={item.outputId}>{label(item)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cleanup-stage">Stage</label>
          <select id="cleanup-stage" value={stage} onChange={(event) => setStage(event.target.value === "processed" ? "processed" : "source")}>
            <option value="source">Source — then run processing on the corrected frames</option>
            <option value="processed">Processed — final export frames, never rescaled again</option>
          </select>
        </div>
      </div>

      <h3>1. Export</h3>
      <div className="row">
        <button type="button" disabled={!output || exportOp.isPending} onClick={() => void doExport()}>{exportOp.isPending ? "Exporting…" : "Export for cleanup"}</button>
      </div>
      {exportOp.error ? <NetworkProblem error={exportOp.error} /> : null}
      {exportOp.data && !exportOp.data.ok ? <ErrorBanner error={exportOp.data.error} /> : null}
      {exported ? (
        <div role="status" className="stack">
          <p>
            Wrote {exported.sidecar.frameCount} frames ({exported.sidecar.canvas.width}×{exported.sidecar.canvas.height}) and <span className="mono">sidecar.json</span> to
            <span className="mono block"> {exported.directory}</span>
          </p>
          <div className="row">
            <button type="button" onClick={() => void navigator.clipboard.writeText(exported.directory).then(() => setCopied(true))}>Copy path</button>
            {copied ? <span className="secondary">Copied (relative to the game folder).</span> : null}
          </div>
          <p className="secondary">Edit PNGs in place or save them elsewhere with the same names. Keep each file the same size; do not rename or crop.</p>
        </div>
      ) : null}

      <h3>2. Import corrected frames</h3>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void doImport(); }}>
        <div className="field">
          <label htmlFor="cleanup-dir">Folder with the corrected PNGs</label>
          <input id="cleanup-dir" type="text" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="/absolute/path or a path relative to the game folder" style={{ width: "100%" }} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="cleanup-frames">Frames you corrected (1-based)</label>
            <input id="cleanup-frames" type="text" value={frameText} onChange={(event) => setFrameText(event.target.value)} placeholder="3, 8-10" aria-describedby="cleanup-frames-hint" />
            <div className="hint" id="cleanup-frames-hint">Out of {count}. Frames you do not list are copied unchanged from the parent.</div>
          </div>
          <div className="field">
            <label htmlFor="cleanup-pattern">File name pattern</label>
            <input id="cleanup-pattern" type="text" value={pattern} onChange={(event) => setPattern(event.target.value)} aria-describedby="cleanup-pattern-hint" />
            <div className="hint" id="cleanup-pattern-hint"><span className="mono">{"{n}"}</span> becomes the zero-based frame number padded to four digits, as in the exported names.</div>
          </div>
        </div>
        {mappingError ? <p role="alert" className="field-error">{mappingError}</p> : null}
        {mapping.length > 0 ? (
          <details open>
            <summary>File mapping ({mapping.length}) — check before importing</summary>
            <div className="table-wrap" style={{ maxHeight: 220, overflow: "auto" }}>
              <table>
                <thead><tr><th>Frame</th><th>File</th></tr></thead>
                <tbody>{mapping.map((row) => <tr key={row.index}><td>{row.index + 1} <span className="secondary">(index {row.index})</span></td><td className="mono">{row.file}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        ) : null}
        <div className="field">
          <label htmlFor="cleanup-notes">What you changed</label>
          <textarea id="cleanup-notes" rows={3} maxLength={4000} value={notes} onChange={(event) => setNotes(event.target.value)} style={{ width: "100%" }} />
        </div>
        <div className="field">
          <label htmlFor="cleanup-effort">Time spent (minutes, optional)</label>
          <input id="cleanup-effort" type="number" min={0} step={1} value={effort} onChange={(event) => setEffort(event.target.value)} />
        </div>
        {inputError ? <p role="alert" className="field-error">{inputError}</p> : null}
        {importOp.error ? <NetworkProblem error={importOp.error} /> : null}
        {importOp.data && !importOp.data.ok ? <ErrorBanner error={importOp.data.error} /> : null}
        {created ? <Banner tone="ok" title="Imported as a new candidate">{created.label} is unapproved and linked to this candidate. <Link to={`/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(created.candidateId)}`}>Open it</Link></Banner> : null}
        <div className="row end">
          <button type="submit" className="primary" disabled={!output || importOp.isPending}>{importOp.isPending ? "Importing…" : "Import as a new candidate"}</button>
        </div>
      </form>
    </section>
  );
}
