import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ExportPlan, ExportRecord, OperationError } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, Modal } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
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
    <span className="rel-path">
      <code>{path}</code>
      <button type="button" className="sm" onClick={() => void copy()}>Copy path</button>
      <span role="status" className="secondary">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed. Select the path and copy it yourself." : ""}</span>
    </span>
  );
}

/** Export: plan → exact plan view → confirm. Mounted only while open, so it plans on open. Exporting never changes promotion or activation. */
export function ExportDialog({ assets, onClose, onInspect }: {
  assets: Array<{ assetId: string; name?: string | undefined }>; onClose: () => void; onInspect: (exportId: string) => void;
}) {
  const { root } = useProjectRoot();
  const planM = useMutationOperation("export.plan");
  const startM = useMutationOperation("export.start");
  const [subset, setSubset] = useState<string[] | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [plan, setPlan] = useState<ExportPlan | undefined>(undefined);
  const planning = planM.isPending;
  const [planError, setPlanError] = useState<OperationError | undefined>(undefined);
  const [startError, setStartError] = useState<OperationError | undefined>(undefined);
  const network = planM.error?.message ?? startM.error?.message;
  const starting = startM.isPending;
  const [done, setDone] = useState<ExportRecord | undefined>(undefined);
  const generation = useRef(0);
  const doneRef = useRef<HTMLDivElement>(null);

  const runPlan = useCallback(async () => {
    const mine = ++generation.current;
    setPlanError(undefined);
    try {
      const result = await planM.mutateAsync({
        input: { ...(subset ? { assetIds: subset } : {}), ...(Object.keys(pins).length > 0 ? { versions: pins } : {}), confirmEmpty },
      });
      if (mine !== generation.current) return;
      if (result.ok) setPlan(result.data.plan);
      else setPlanError(result.error);
    } catch {
      // Network loss: shown via `network`.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutateAsync is stable
  }, [root, subset, pins, confirmEmpty]);

  useEffect(() => { if (root) void runPlan(); }, [root, runPlan]);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const start = async () => {
    if (!plan) return;
    setStartError(undefined);
    try {
      const result = await startM.mutateAsync({ input: { planId: plan.planId, planHash: plan.planHash } });
      if (result.ok) {
        setDone(result.data.export);
        void runPlan();
      } else setStartError(result.error);
    } catch {
      // Network loss: shown via `network`; the mutation keeps its request id for the retry.
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

  const blocked = !plan || plan.blockers.length > 0;
  const reasons = !plan ? ["There is no plan yet."] : plan.blockers.map((blocker) => blocker.message);
  const publicAbs = plan && plan.publicRoot && root ? joinPath(root, plan.publicRoot) : undefined;
  const stale = startError !== undefined && (startError.code === "REVISION_CONFLICT" || /plan/i.test(startError.message));

  return (
    <Modal wide open onOpenChange={(open) => { if (!open) onClose(); }} title="Export to the game" description="Copies the active version of each asset into your game folder. It doesn’t promote or activate anything, and files you own there are never overwritten.">
      <div className="rel-export">
        {plan ? (
          plan.destination !== "" ? (
            <p className="rel-note">
              Destination <code>{plan.destination}</code> · your game reads <code>{plan.publicRoot}</code>
              {plan.preset === "godot4" ? <> (<code>{plan.resRoot ?? "res://"}</code>)</> : null}
              {" · "}<Link to={paths.settings("direction")}>Export settings</Link>
            </p>
          ) : (
            <Banner tone="warn" title="No export destination is set" actions={<Link className="button" to={paths.settings("direction")}>Edit export settings</Link>}>
              Set <code>export.destination</code> in the project settings so Brainforge knows where the game reads its assets.
            </Banner>
          )
        ) : null}

        <details className="rel-choose">
          <summary>Choose what to export</summary>
          <ExportSelection assets={assets} subset={subset} onSubset={changeSubset} pins={pins} onPin={changePin} defaultIds={plan?.selection.map((row) => row.assetId) ?? []} />
        </details>

        <div aria-live="polite" className="rel-live">
          {planError ? <ErrorBanner error={planError} /> : null}
          {network ? <Banner tone="bad" title="No response from the server">{network} Starting again reuses the same request, so it can’t export twice.</Banner> : null}
          {startError ? (
            startError.code === "EXPORT_CONFLICT" ? (
              <Banner tone="bad" title="Export conflict: nothing was changed" actions={<button type="button" onClick={() => void runPlan()}>Plan again</button>}>
                {startError.message}
                <div className="secondary">The previous export is still what your game reads. Restore or move the file named above, or choose another export destination in the project settings, then plan again.</div>
              </Banner>
            ) : stale ? (
              <Banner tone="warn" title="The plan changed" actions={<button type="button" onClick={() => void runPlan()}>Plan again</button>}>Something it depends on changed after you planned. Nothing was exported. Review a fresh plan before starting.</Banner>
            ) : <ErrorBanner error={startError} />
          ) : null}
        </div>
        <div aria-live="polite" ref={doneRef} tabIndex={-1}>
          {done && root ? (
            <Banner tone="ok" title={done.warnings.length > 0 ? "Exported, with warnings" : "Exported"}>
              <p>Your game reads these files at <code>{done.publicRoot}</code>. Promotion and activation weren’t changed.</p>
              <p className="row"><CopyPath path={joinPath(root, done.publicRoot)} /></p>
              {done.warnings.map((warning) => <div key={warning}>{warning}</div>)}
            </Banner>
          ) : null}
        </div>

        {plan ? <ExportPlanView plan={plan} onConfirmEmpty={() => setConfirmEmpty(true)} onInspect={onInspect} /> : planning ? <p className="secondary" role="status">Planning export…</p> : null}

        <div className="rel-decision">
          <div className="row end">
            <button type="button" onClick={() => void runPlan()} disabled={planning || starting}>{planning ? "Planning…" : "Plan again"}</button>
            <button type="button" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
            <button type="button" className="primary" disabled={blocked || starting || planning} aria-describedby="export-why" onClick={() => void start()}>
              {starting ? "Exporting…" : "Export to the game"}
            </button>
          </div>
          <div id="export-why" className="rel-why" aria-live="polite">
            {blocked ? (
              <>
                Can’t export yet:
                <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              </>
            ) : <>{publicAbs ? <>Writes to <code>{publicAbs}</code>. </> : null}Your game switches to the new snapshot in one step. Files you own there are kept; only files an earlier export wrote are retired.</>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
