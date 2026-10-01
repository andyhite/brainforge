import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Candidate, CandidateOutput, OperationError, ProcessingPlan, ProcessingRecipe, ProcessingWarning, RecipeRequest } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, Status } from "../../components/ui.tsx";
import { BackdropPicker, useBackdrop } from "../generation/media.tsx";
import { OutputCanvasPreview, SourceFramePreview } from "./PivotPreview.tsx";
import { FieldSource, NumberField, RecipeGroup } from "./recipe-fields.tsx";

const FPS_PRESETS = [12, 16];
const WARNING_LABEL: Record<ProcessingWarning["code"], string> = {
  CLIPPED: "Content is cut off by the canvas",
  EMPTY_FRAME: "A frame is empty",
  PIVOT_OUTSIDE: "Pivot is far from the figure",
  SCALE_CHANGED: "Scale differs from the character anchor",
  LOOP_DISCONTINUITY: "The loop seam is visible",
  ATLAS_PAGES: "The atlas needs several pages",
  SYMMETRY: "Mirror-repeat symmetry",
  OTHER: "Note",
};
const ms = (value: number) => `${Math.round(value * 10) / 10} ms`;

export function ProcessPanel({ candidate, sources, projectId }: { candidate: Candidate; sources: CandidateOutput[]; projectId: string }) {
  const navigate = useNavigate();
  const [backdrop, setBackdrop] = useBackdrop();
  const [sourceId, setSourceId] = useState((sources.find((s) => s.role === "matted") ?? sources[0])?.outputId ?? "");
  const [edits, setEdits] = useState<RecipeRequest>({});
  const [plan, setPlan] = useState<ProcessingPlan | undefined>(undefined);
  const [planError, setPlanError] = useState<OperationError | undefined>(undefined);
  const [stale, setStale] = useState(true);
  const [done, setDone] = useState<string | undefined>(undefined);
  const planOp = useMutationOperation("processing.plan");
  const startOp = useMutationOperation("processing.start");
  const sequence = useRef(0);
  const inspect = useOperation("output.inspect", { outputId: sourceId }, { enabled: sourceId !== "" });

  useEffect(() => {
    const mine = ++sequence.current;
    setStale(true);
    const timer = setTimeout(async () => {
      const result = await planOp.mutateAsync({ input: { candidateId: candidate.candidateId, outputId: sourceId, recipe: edits } }).catch(() => undefined);
      if (mine !== sequence.current) return;
      setStale(false);
      if (!result) return;
      if (result.ok) {
        setPlan(result.data.plan);
        setPlanError(undefined);
      } else {
        setPlanError(result.error);
      }
    }, plan ? 350 : 0);
    return () => clearTimeout(timer);
    // planOp is a stable mutation handle; the plan is re-requested only when the inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, sourceId, candidate.candidateId]);

  const recipe: ProcessingRecipe | undefined = plan ? { ...plan.recipe, ...edits } : undefined;
  const change = (patch: RecipeRequest) => {
    setDone(undefined);
    startOp.reset();
    setEdits((current) => ({ ...current, ...patch }));
  };
  const reset = (...keys: Array<keyof RecipeRequest>) => {
    setDone(undefined);
    setEdits((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key as keyof RecipeRequest))));
  };
  const sourceOf = (field: string) => plan?.sources[field];
  const isEdited = (field: keyof RecipeRequest) => field in edits;

  const source = sources.find((s) => s.outputId === sourceId);
  const frames = inspect.data?.ok ? inspect.data.data.output.frames : [];
  const blocked = (plan?.blockers.length ?? 0) > 0;
  const cannotRun = !plan ? "Waiting for the plan." : stale ? "Updating the plan…" : planError ? "The plan failed; fix the input above." : blocked ? "Resolve the blockers above." : undefined;

  const run = async () => {
    if (!plan) return;
    const result = await startOp.mutateAsync({ input: { planId: plan.planId, planHash: plan.planHash } });
    if (result.ok) {
      setDone(result.data.output.outputId);
      void navigate(`?output=${encodeURIComponent(result.data.output.outputId)}`, { preventScrollReset: true });
    }
  };

  return (
    <section className="panel" aria-labelledby="process-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="process-title" style={{ margin: 0 }}>Process into an export clip</h2>
        <BackdropPicker value={backdrop} onChange={setBackdrop} />
      </div>
      <p className="secondary">
        Each run makes a <strong>new, unapproved processed result</strong> next to this source. It never changes the source or an earlier processed result, and it does not inherit any approval. No ComfyUI request is made.
      </p>
      {sources.length > 1 ? (
        <div className="field">
          <label htmlFor="process-source">Source frames</label>
          <select id="process-source" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setEdits({}); setPlan(undefined); }}>
            {sources.map((item) => <option key={item.outputId} value={item.outputId}>{item.role === "matted" ? "Matted (alpha)" : "Untouched"} · {item.frameCount ?? "?"} frames</option>)}
          </select>
        </div>
      ) : null}
      {source ? <p className="secondary">Source: {source.frameCount ?? "?"} frames at {source.sourceFps ?? "?"} fps, {source.width}×{source.height} px.</p> : null}

      {planOp.error ? <NetworkProblem error={planOp.error} /> : null}
      {planError ? <ErrorBanner error={planError} /> : null}
      {!plan && !planError && !planOp.error ? <p className="secondary" role="status">Planning from the defaults…</p> : null}

      {plan && recipe ? (
        <div className="proc-layout">
          <div className="proc-form">
            <RecipeGroup title="Timing">
              <div className="field compact">
                <span id="fps-label" className="label">Playback rate</span>
                <div className="viewer-tools" role="group" aria-labelledby="fps-label" style={{ marginBottom: 0 }}>
                  {FPS_PRESETS.map((fps) => <button key={fps} type="button" aria-pressed={recipe.playbackFps === fps} onClick={() => change({ playbackFps: fps })}>{fps} fps</button>)}
                </div>
                <NumberField id="fps-custom" label="Custom fps" value={recipe.playbackFps} min={1} max={60} step={0.5} onCommit={(playbackFps) => playbackFps > 0 && change({ playbackFps })} />
                <FieldSource edited={isEdited("playbackFps")} source={sourceOf("playbackFps")} onReset={() => reset("playbackFps")} />
                <div className="hint">The duration is preserved; only the number of frames changes.</div>
              </div>
              <div className="field compact">
                <label htmlFor="closing">Closing frame</label>
                <select id="closing" value={recipe.closingFrame} onChange={(event) => change({ closingFrame: event.target.value === "keep" ? "keep" : "exclude-last" })}>
                  <option value="keep">Keep every source frame</option>
                  <option value="exclude-last">Drop the last frame (it repeats the first in a loop)</option>
                </select>
                <FieldSource edited={isEdited("closingFrame")} source={sourceOf("closingFrame")} onReset={() => reset("closingFrame")} />
              </div>
              <label className="check"><input type="checkbox" checked={recipe.loop} onChange={(event) => change({ loop: event.target.checked })} />Plays as a loop</label>
              <FieldSource edited={isEdited("loop")} source={sourceOf("loop")} onReset={() => reset("loop")} />
              <div className="row">
                <NumberField id="trim-start" label="First source frame (1-based)" integer min={1} max={plan.sourceFrameCount} value={(recipe.trim?.start ?? 0) + 1} onCommit={(n) => change({ trim: { start: Math.max(0, n - 1), endExclusive: recipe.trim?.endExclusive ?? plan.sourceFrameCount } })} />
                <NumberField id="trim-end" label="Last source frame (1-based)" integer min={1} max={plan.sourceFrameCount} value={recipe.trim?.endExclusive ?? plan.sourceFrameCount} onCommit={(n) => change({ trim: { start: recipe.trim?.start ?? 0, endExclusive: n } })} />
              </div>
              <FieldSource edited={isEdited("trim")} source={sourceOf("trim")} onReset={() => reset("trim")} />
            </RecipeGroup>

            <RecipeGroup title="Crop and size">
              <div className="row">
                {(["x", "y", "width", "height"] as const).map((key) => (
                  <NumberField key={key} id={`crop-${key}`} label={`Crop ${key} (source px)`} integer min={key === "width" || key === "height" ? 1 : 0} value={recipe.crop[key]} onCommit={(n) => change({ crop: { ...recipe.crop, [key]: n } })} />
                ))}
              </div>
              <FieldSource edited={isEdited("crop")} source={sourceOf("crop")} onReset={() => reset("crop")} />
              <div className="row">
                <NumberField id="out-width" label="Output width (px)" integer min={1} value={recipe.output.width} onCommit={(width) => change({ output: { ...recipe.output, width } })} />
                <NumberField id="out-height" label="Output height (px)" integer min={1} value={recipe.output.height} onCommit={(height) => change({ output: { ...recipe.output, height } })} />
              </div>
              <FieldSource edited={isEdited("output")} source={sourceOf("output")} onReset={() => reset("output")} />
              {recipe.scaleAnchor ? (
                <p className="secondary">
                  Scale comes from the branch's reference, not from this clip: {recipe.scaleAnchor.sourceStandingHeightPx} px standing height → {recipe.scaleAnchor.targetStandingHeightPx} px
                  (×{Math.round((recipe.scaleAnchor.targetStandingHeightPx / recipe.scaleAnchor.sourceStandingHeightPx) * 1000) / 1000}). <span className="mono">{sourceOf("scaleAnchor") ?? ""}</span>
                </p>
              ) : null}
              <div className="field compact">
                <label htmlFor="filter">Resize filter</label>
                <select id="filter" value={recipe.resizeFilter} onChange={(event) => change({ resizeFilter: event.target.value === "nearest" ? "nearest" : "lanczos3" })}>
                  <option value="lanczos3">Smooth (lanczos3)</option>
                  <option value="nearest">Hard pixels (nearest)</option>
                </select>
                <FieldSource edited={isEdited("resizeFilter")} source={sourceOf("resizeFilter")} onReset={() => reset("resizeFilter")} />
              </div>
            </RecipeGroup>

            <RecipeGroup title="Pivot">
              <div className="row">
                <NumberField id="pivot-x" label="Pivot x (0–1)" min={0} max={1} step={0.01} value={recipe.pivot.x} onCommit={(x) => x >= 0 && x <= 1 && change({ pivot: { ...recipe.pivot, x } })} />
                <NumberField id="pivot-y" label="Pivot y (0–1)" min={0} max={1} step={0.01} value={recipe.pivot.y} onCommit={(y) => y >= 0 && y <= 1 && change({ pivot: { ...recipe.pivot, y } })} />
              </div>
              <div className="hint">= {Math.round(plan.pivotPx.x * 10) / 10}, {Math.round(plan.pivotPx.y * 10) / 10} px on the {plan.canvas.width}×{plan.canvas.height} output, origin top-left.</div>
              <FieldSource edited={isEdited("pivot")} source={sourceOf("pivot")} onReset={() => reset("pivot")} />
            </RecipeGroup>

            <RecipeGroup title="Transparency">
              <div className="field compact">
                <label htmlFor="alpha">Background</label>
                <select id="alpha" value={recipe.alpha} onChange={(event) => change({ alpha: event.target.value === "matte" ? "matte" : event.target.value === "snap-near-opaque" ? "snap-near-opaque" : "preserve" })}>
                  <option value="preserve">Keep transparency as is</option>
                  <option value="snap-near-opaque">Keep transparency, make alpha 254+ fully opaque</option>
                  <option value="matte">Flatten onto a matte colour</option>
                </select>
                <FieldSource edited={isEdited("alpha")} source={sourceOf("alpha")} onReset={() => reset("alpha")} />
              </div>
              {recipe.alpha === "matte" ? (
                <div className="field compact">
                  <label htmlFor="matte-color">Matte colour</label>
                  <input id="matte-color" type="color" value={recipe.matteColor ?? "#808080"} onChange={(event) => change({ matteColor: event.target.value })} />
                  <div className="hint">Applied only because you chose it; the colour is never guessed from the picture.</div>
                </div>
              ) : null}
            </RecipeGroup>

            <RecipeGroup title="Packaging">
              <div className="field compact">
                <label htmlFor="packaging">Files to produce</label>
                <select id="packaging" value={recipe.packaging} onChange={(event) => change({ packaging: event.target.value === "atlas" ? "atlas" : event.target.value === "both" ? "both" : "frames" })}>
                  <option value="frames">Individual frames</option>
                  <option value="atlas">Atlas pages</option>
                  <option value="both">Frames and atlas pages</option>
                </select>
                <FieldSource edited={isEdited("packaging")} source={sourceOf("packaging")} onReset={() => reset("packaging")} />
              </div>
              {recipe.packaging !== "frames" ? (
                <div className="row">
                  <NumberField id="atlas-max" label="Page size limit (px)" integer min={64} max={4096} value={recipe.atlas.maxSize} onCommit={(maxSize) => change({ atlas: { ...recipe.atlas, maxSize } })} />
                  <NumberField id="atlas-pad" label="Gutter (px)" integer min={0} value={recipe.atlas.padding} onCommit={(padding) => change({ atlas: { ...recipe.atlas, padding } })} />
                  <NumberField id="atlas-ext" label="Edge extrusion (px)" integer min={0} value={recipe.atlas.extrude} onCommit={(extrude) => change({ atlas: { ...recipe.atlas, extrude } })} />
                </div>
              ) : null}
              {recipe.tileRepeat !== "none" ? <p className="secondary">Tile repeat: {recipe.tileRepeat}.</p> : null}
            </RecipeGroup>

            <RecipeGroup title="Frame corrections">
              <p className="secondary">Explicit, authored nudges in output pixels for individual exported frames. Nothing is corrected automatically.</p>
              {(recipe.frameOffsets ?? []).map((offset, row) => {
                const update = (patch: Partial<typeof offset>) => change({ frameOffsets: (recipe.frameOffsets ?? []).map((item, i) => (i === row ? { ...item, ...patch } : item)) });
                return (
                  <div className="row" key={row}>
                    <NumberField id={`off-i-${row}`} label="Output frame (1-based)" integer min={1} max={plan.frames.length} value={offset.index + 1} onCommit={(n) => update({ index: n - 1 })} />
                    <NumberField id={`off-x-${row}`} label="Shift x (px)" integer value={offset.dx} onCommit={(dx) => update({ dx })} />
                    <NumberField id={`off-y-${row}`} label="Shift y (px)" integer value={offset.dy} onCommit={(dy) => update({ dy })} />
                    <button type="button" aria-label={`Remove correction for frame ${offset.index + 1}`} onClick={() => {
                      const next = (recipe.frameOffsets ?? []).filter((_, i) => i !== row);
                      if (next.length === 0 && !plan.recipe.frameOffsets?.length) reset("frameOffsets");
                      else change({ frameOffsets: next });
                    }}>Remove</button>
                  </div>
                );
              })}
              <button type="button" onClick={() => change({ frameOffsets: [...(recipe.frameOffsets ?? []), { index: 0, dx: 0, dy: 0 }] })}>Add a frame correction</button>
              {isEdited("frameOffsets") ? <FieldSource edited source={undefined} onReset={() => reset("frameOffsets")} /> : null}
            </RecipeGroup>
          </div>

          <div className="proc-side">
            {projectId ? <SourceFramePreview projectId={projectId} frames={frames} recipe={recipe} backdrop={backdrop} onPivot={(pivot) => change({ pivot })} /> : null}
            {inspect.error ? <NetworkProblem error={inspect.error} /> : null}
            {inspect.data && !inspect.data.ok ? <ErrorBanner error={inspect.data.error} /> : null}
            <OutputCanvasPreview plan={plan} recipe={recipe} backdrop={backdrop} onPivot={(pivot) => change({ pivot })} />
            <PlanSummary plan={plan} stale={stale} />
          </div>
        </div>
      ) : null}

      {plan ? (
        <div className="stack" style={{ marginTop: 16 }}>
          {plan.blockers.length > 0 ? (
            <Banner tone="bad" title="This cannot run yet">
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {plan.blockers.map((blocker) => (
                  <li key={blocker.code}>{blocker.message}{blocker.recoveryActions.length > 0 ? <ul>{blocker.recoveryActions.map((action) => <li key={action.label}>{action.label}</li>)}</ul> : null}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {startOp.error ? <NetworkProblem error={startOp.error} /> : null}
          {startOp.data && !startOp.data.ok ? <ErrorBanner error={startOp.data.error} /> : null}
          {done ? <Banner tone="ok" title="New processed result created">It is unapproved. It is open in the player above; review it before using it.</Banner> : null}
          {cannotRun ? <p className="secondary" role="status">Cannot run: {cannotRun}</p> : null}
          <div className="row end">
            <button type="button" className="primary" disabled={cannotRun !== undefined || startOp.isPending} onClick={() => void run()}>
              {startOp.isPending ? "Processing…" : "Run processing → new unapproved result"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PlanSummary({ plan, stale }: { plan: ProcessingPlan; stale: boolean }) {
  const first = plan.frames[0];
  const last = plan.frames[plan.frames.length - 1];
  return (
    <section aria-label="What this will produce" aria-busy={stale}>
      <h3>What this will produce {stale ? <span className="secondary">(updating…)</span> : null}</h3>
      <dl className="kv">
        <dt>Frames</dt><dd>{plan.frames.length} from {plan.sourceFrameCount} source frames at {plan.sourceFps} fps</dd>
        <dt>Duration</dt><dd>{ms(plan.totalDurationMs)}{last && first && last.durationMs !== first.durationMs ? <span className="secondary"> (last frame {ms(last.durationMs)})</span> : null}</dd>
        <dt>Canvas</dt><dd>{plan.canvas.width}×{plan.canvas.height} px</dd>
        <dt>Content</dt><dd>{plan.foregroundBounds ? `${plan.foregroundBounds.width}×${plan.foregroundBounds.height} px at ${plan.foregroundBounds.x}, ${plan.foregroundBounds.y}` : "no foreground found"}</dd>
        <dt>Recipe</dt><dd className="mono">{plan.recipeHash.slice(0, 12)}…</dd>
      </dl>
      {plan.warnings.length === 0 ? <p><Status tone="ok">No warnings</Status></p> : (
        <ul className="plain-list" aria-label="Warnings">
          {plan.warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>
              <Status tone="warn">{WARNING_LABEL[warning.code]}</Status> {warning.message}
              {warning.frames.length > 0 ? <span className="secondary"> Frames {warning.frames.slice(0, 12).map((n) => n + 1).join(", ")}{warning.frames.length > 12 ? "…" : ""}.</span> : null}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>Frame map ({plan.frames.length})</summary>
        <div className="table-wrap" style={{ maxHeight: 240, overflow: "auto" }}>
          <table>
            <thead><tr><th>Export frame</th><th>Source frame</th><th>Shown for</th></tr></thead>
            <tbody>{plan.frames.map((frame) => <tr key={frame.index}><td>{frame.index + 1}</td><td>{frame.sourceFrame + 1}</td><td>{ms(frame.durationMs)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
