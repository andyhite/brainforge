import { useId, useState } from "react";
import type { ActiveSelection, AssetVersion, OperationError } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, Modal } from "../../components/ui.tsx";
import { activeOf } from "./state.tsx";

/** Activating an older version than the active one is a restore. */
export function isRestore(version: AssetVersion, versions: AssetVersion[], active: ActiveSelection): boolean {
  const current = activeOf(versions, active);
  return current !== undefined && version.versionNumber < current.versionNumber;
}

/** Activation of one immutable version. Obsolete versions need an explicit acknowledgement. */
export function ActivateDialog({ version, restore, active, open, onOpenChange, onDone }: {
  version: AssetVersion; restore: boolean; active: ActiveSelection; open: boolean; onOpenChange: (open: boolean) => void; onDone: (message: string) => void;
}) {
  const activate = useMutationOperation("version.activate");
  const ackId = useId();
  const reasonId = useId();
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const busy = activate.isPending;
  const [failure, setFailure] = useState<OperationError | undefined>(undefined);
  const network = activate.error?.message;
  const obsolete = !version.matchesCurrent;
  const verb = restore ? "Restore this version" : "Activate";

  const submit = async () => {
    setFailure(undefined);
    try {
      const result = await activate.mutateAsync({
        input: { versionId: version.versionId, expectedRevision: active.revision, acknowledgeObsolete: obsolete && ack, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      });
      if (result.ok) {
        onOpenChange(false);
        onDone(`Version ${version.versionNumber} is now active${result.data.event.kind === "restore" ? " (restored)" : ""}.`);
      } else setFailure(result.error);
    } catch {
      // No envelope arrived: the mutation keeps its request id, so retrying cannot activate twice.
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`${verb}: version ${version.versionNumber}`} description="Activating only changes which version counts as current. It doesn’t export anything and never deletes other versions.">
      {obsolete ? (
        <Banner tone="warn" title="Out of date: its requirements changed">
          This version was built before the asset’s requirements changed. You can still use it, but it won’t count as complete.
        </Banner>
      ) : null}
      {obsolete ? (
        <div className="field">
          <label className="check" htmlFor={ackId}>
            <input id={ackId} type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
            I understand this version no longer matches the current requirements and won’t count as complete
          </label>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={reasonId}>Reason (optional)</label>
        <input id={reasonId} type="text" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
      </div>
      <div aria-live="polite">
        {failure ? (
          failure.code === "REVISION_CONFLICT"
            ? <Banner tone="warn" title="The active version changed meanwhile" actions={<button type="button" onClick={() => onOpenChange(false)}>Close and refresh</button>}>The list now shows the current active version. Review it, then try again.</Banner>
            : <ErrorBanner error={failure} />
        ) : null}
        {network ? <Banner tone="bad" title="No response from the server">{network} Retrying reuses the same request, so it can’t activate twice.</Banner> : null}
      </div>
      <div className="row end">
        <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
        <button type="button" className="primary" disabled={busy || (obsolete && !ack)} onClick={() => void submit()}>{busy ? "Working…" : verb}</button>
      </div>
      {obsolete && !ack ? <p className="secondary">Tick the box to enable “{verb}”.</p> : null}
    </Modal>
  );
}
