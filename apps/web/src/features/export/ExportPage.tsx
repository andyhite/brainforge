import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ExportPlan, ExportRecord, OperationError } from "@brainforge/contracts";
import { callOperation, newRequestId } from "../../api/client.ts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, EmptyState, ErrorBanner, NetworkProblem, PageHeader } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { ExportHistory } from "./ExportHistory.tsx";
import { ExportPlanView } from "./ExportPlanView.tsx";
import { ExportSelection } from "./ExportSelection.tsx";

function joinPath(root: string, relative: string): string {
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\.?\/+/, "")}`;
}

function CopyPath({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="row" style={{ gap: 8 }}>
      <code>{path}</code>
      <button type="button" onClick={() => void copy()}>Copy path</button>
      <span role="status" className="secondary">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the path and copy it manually" : ""}</span>
    </span>
  );
}

function SettingsPanel({ plan }: { plan: ExportPlan | undefined }) {
  const hasSettings = plan !== undefined && plan.destination !== "";
  return (
    <section className="panel" aria-labelledby="export-settings-title">
      <h2 id="export-settings-title">Export settings</h2>
      {hasSettings ? (
        <dl className="kv">
          <dt>Preset</dt><dd>{plan.preset}</dd>
          <dt>Destination</dt><dd className="mono">{plan.destination}</dd>
          <dt>Stable public path</dt><dd className="mono">{plan.publicRoot}</dd>
          {plan.preset === "godot4" ? <><dt>Godot project root</dt><dd className="mono">{plan.godotProjectRoot ?? "."}</dd><dt>Resources load from</dt><dd className="mono">{plan.resRoot ?? "—"}</dd></> : null}
        </dl>
      ) : (
        <>
          <p className="secondary">These come from the <code>export</code> block of <code>brainforge/project.yaml</code>:</p>
          <pre><code>{"export:\n  preset: generic        # or godot4\n  destination: assets/brainforge\n  godotProjectRoot: .    # godot4 only"}</code></pre>
        </>
      )}
      <p className="secondary">Exports are copies of immutable promoted versions. Exporting never changes promotion or activation, and files you own in the destination are never overwritten.</p>
      <div className="row">
        <Link className="button" to="/settings/direction">Edit export settings</Link>
        <Link className="button" to="/settings/direction?view=yaml">Edit project.yaml</Link>
      </div>
    </section>
  );
}

export function ExportPage() {
  const { root } = useProjectRoot();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const initialAsset = params.get("asset");
  const assets = useOperation("asset.list", {}, { enabled: root !== undefined });
  const [subset, setSubset] = useState<string[] | null>(initialAsset ? [initialAsset] : null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [plan, setPlan] = useState<ExportPlan | undefined>(undefined);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<OperationError | undefined>(undefined);
  const [startError, setStartError] = useState<OperationError | undefined>(undefined);
  const [network, setNetwork] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [done, setDone] = useState<ExportRecord | undefined>(undefined);
  const pending = useRef<{ planId: string; planHash: string; requestId: string } | undefined>(undefined);
  const generation = useRef(0);
  const doneRef = useRef<HTMLDivElement>(null);
  const [inspectId, setInspectId] = useState<string | undefined>(undefined);
  const showInspect = (exportId: string) => {
    setInspectId(exportId);
    requestAnimationFrame(() => document.getElementById("export-history")?.scrollIntoView({ block: "start" }));
  };

  const runPlan = useCallback(async () => {
    const mine = ++generation.current;
    setPlanning(true);
    setPlanError(undefined);
    setNetwork(undefined);
    try {
      const result = await callOperation("export.plan", {
        project: root,
        input: { ...(subset ? { assetIds: subset } : {}), ...(Object.keys(pins).length > 0 ? { versions: pins } : {}), confirmEmpty },
      });
      if (mine !== generation.current) return;
      if (result.ok) {
        setPlan(result.data.plan);
        pending.current = undefined;
      } else setPlanError(result.error);
    } catch (error) {
      if (mine === generation.current) setNetwork(error instanceof Error ? error.message : "Request failed");
    } finally {
      if (mine === generation.current) setPlanning(false);
    }
  }, [root, subset, pins, confirmEmpty]);

  useEffect(() => { if (root) void runPlan(); }, [root, runPlan]);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const start = async () => {
    if (!plan) return;
    // One request id per plan: a retry after a lost response returns the same export instead of publishing twice.
    if (pending.current?.planId !== plan.planId || pending.current.planHash !== plan.planHash) {
      pending.current = { planId: plan.planId, planHash: plan.planHash, requestId: newRequestId() };
    }
    const { requestId } = pending.current;
    setStarting(true);
    setStartError(undefined);
    setNetwork(undefined);
    try {
      const result = await callOperation("export.start", { project: root, requestId, input: { planId: plan.planId, planHash: plan.planHash, requestId } });
      if (result.ok) {
        pending.current = undefined;
        setDone(result.data.export);
        void queryClient.invalidateQueries({ queryKey: ["op"] });
        void runPlan();
      } else {
        pending.current = undefined;
        setStartError(result.error);
      }
    } catch (error) {
      setNetwork(error instanceof Error ? error.message : "Request failed");
    } finally {
      setStarting(false);
    }
  };

  const changeSubset = (next: string[] | null) => {
    setSubset(next);
    // A pin would pull its asset back into the export, so excluding an asset also drops its pin.
    if (next) setPins((current) => Object.fromEntries(Object.entries(current).filter(([assetId]) => next.includes(assetId))));
    setConfirmEmpty(false);
    setDone(undefined);
  };
  const changePin = (assetId: string, versionId: string | undefined) => {
    setPins((current) => {
      const next = { ...current };
      if (versionId) next[assetId] = versionId;
      else delete next[assetId];
      return next;
    });
    // A pin only applies to an asset in the selection, so pinning from the default view makes the selection explicit.
    if (versionId && subset === null) setSubset([...new Set([...(plan?.selection.map((row) => row.assetId) ?? []), assetId])]);
    setConfirmEmpty(false);
    setDone(undefined);
  };

  if (!root) {
    return (
      <div>
        <PageHeader title="Export" />
        <EmptyState title="No project selected"><Link className="button primary" to="/projects/open">Open a project</Link></EmptyState>
      </div>
    );
  }

  const blocked = !plan || plan.blockers.length > 0;
  const reasons = !plan ? ["There is no plan yet."] : plan.blockers.map((blocker) => blocker.message);
  const publicAbs = plan && plan.publicRoot ? joinPath(root, plan.publicRoot) : undefined;
  const stale = startError !== undefined && (startError.code === "REVISION_CONFLICT" || /plan/i.test(startError.message));

  return (
    <div className="stack">
      <PageHeader title="Export">
        <Link to="/library">Library</Link>
      </PageHeader>
      <SettingsPanel plan={plan} />
      <ExportSelection
        assets={assets.data?.ok ? assets.data.data.assets : []}
        subset={subset} onSubset={changeSubset} pins={pins} onPin={changePin}
        defaultIds={plan?.selection.map((row) => row.assetId) ?? []}
      />
      <section className="panel" aria-labelledby="export-plan-title">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="export-plan-title" style={{ margin: 0 }}>Export plan</h2>
          <button type="button" onClick={() => { setDone(undefined); void runPlan(); }} disabled={planning || starting}>{planning ? "Planning…" : "Plan again"}</button>
        </div>
        <div aria-live="polite" style={{ marginTop: 12 }}>
          {planError ? <ErrorBanner error={planError} /> : null}
          {network ? <Banner tone="bad" title="No response from the server">{network} Starting the export again reuses the same request, so it cannot publish twice.</Banner> : null}
          {startError ? (
            startError.code === "EXPORT_CONFLICT" ? (
              <Banner tone="bad" title="Export conflict — nothing was changed" actions={<button type="button" onClick={() => void runPlan()}>Plan again</button>}>
                {startError.message}
                <div className="secondary">The previous export is still what <code>current</code> resolves to. Files you own in the destination are never overwritten: restore or move the file named above, or choose another <code>export.destination</code>, then plan again.</div>
              </Banner>
            ) : stale ? (
              <Banner tone="warn" title="The plan changed" actions={<button type="button" onClick={() => void runPlan()}>Plan again</button>}>Something it depends on changed after you planned. Nothing was exported. Review a fresh plan before starting.</Banner>
            ) : <ErrorBanner error={startError} />
          ) : null}
          {assets.error ? <NetworkProblem error={assets.error} /> : null}
        </div>
        <div aria-live="polite" ref={doneRef} tabIndex={-1}>
          {done ? (
            <Banner tone="ok" title={done.warnings.length > 0 ? "Exported — with warnings" : "Exported"}>
              <p>Your game reads these files at the stable path <code>{done.publicRoot}</code>. Promotion and activation were not changed.</p>
              <p className="row" style={{ gap: 8 }}><strong>Open exported files:</strong> <CopyPath path={joinPath(root, done.publicRoot)} /></p>
              {done.warnings.map((warning) => <div key={warning}>{warning}</div>)}
            </Banner>
          ) : null}
        </div>
        {plan ? <ExportPlanView plan={plan} onConfirmEmpty={() => setConfirmEmpty(true)} onInspect={showInspect} /> : planning ? <p className="secondary" role="status">Planning export…</p> : null}
        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" className="primary" disabled={blocked || starting || planning} aria-describedby="export-why" onClick={() => void start()}>
            {starting ? "Exporting…" : "Start export"}
          </button>
          {publicAbs ? <span className="secondary">Will publish to <code>{publicAbs}</code></span> : null}
        </div>
        <div id="export-why" aria-live="polite">
          {blocked ? (
            <div className="secondary" style={{ marginTop: 8 }}>
              Start is disabled because:
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
          ) : (
            <p className="secondary" style={{ marginTop: 8 }}>
              Publishing switches <code>current</code> to the new snapshot in one step. Files you own in the destination are kept and never overwritten; only files this export wrote earlier are retired.
            </p>
          )}
        </div>
      </section>
      <ExportHistory selected={inspectId} onSelect={setInspectId} />
    </div>
  );
}
