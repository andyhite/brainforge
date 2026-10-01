import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ActiveSelection, AssetVersion, OperationError } from "@brainforge/contracts";
import { callOperation, newRequestId } from "../../api/client.ts";
import { Banner, ErrorBanner, Modal } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";

/** Activating an older version than the active one is a restore. */
export function isRestore(version: AssetVersion, versions: AssetVersion[], active: ActiveSelection): boolean {
  const current = versions.find((item) => item.versionId === active.versionId);
  return current !== undefined && version.versionNumber < current.versionNumber;
}

/** Activation of one immutable version. Obsolete versions need an explicit acknowledgement. */
export function ActivateDialog({ version, restore, active, open, onOpenChange, onDone }: {
  version: AssetVersion; restore: boolean; active: ActiveSelection; open: boolean; onOpenChange: (open: boolean) => void; onDone: (message: string) => void;
}) {
  const { root } = useProjectRoot();
  const queryClient = useQueryClient();
  const ackId = useId();
  const reasonId = useId();
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OperationError | undefined>(undefined);
  const [network, setNetwork] = useState<string | undefined>(undefined);
  const [requestId, setRequestId] = useState(newRequestId);
  const obsolete = !version.matchesCurrent;
  const verb = restore ? "Restore this version" : "Activate";

  const submit = async () => {
    setBusy(true);
    setNetwork(undefined);
    setFailure(undefined);
    try {
      const result = await callOperation("version.activate", {
        project: root, requestId,
        input: { versionId: version.versionId, expectedRevision: active.revision, acknowledgeObsolete: obsolete && ack, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      });
      setRequestId(newRequestId());
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: ["op"] });
        onOpenChange(false);
        onDone(`Version ${version.versionNumber} is now active${result.data.event.kind === "restore" ? " (restored)" : ""}.`);
      } else {
        setFailure(result.error);
        if (result.error.code === "REVISION_CONFLICT") void queryClient.invalidateQueries({ queryKey: ["op"] });
      }
    } catch (error) {
      // No envelope arrived: keep the request id so retrying cannot activate twice.
      setNetwork(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`${verb} — version ${version.versionNumber}`} description="Activation only changes which immutable version is current. It does not export and never deletes other versions.">
      {obsolete ? (
        <Banner tone="warn" title="Obsolete: requirements changed">
          This version was built against earlier requirements. It stays available, but it does not count as currently complete.
        </Banner>
      ) : null}
      {obsolete ? (
        <div className="field" style={{ marginTop: 16 }}>
          <label className="check" htmlFor={ackId}>
            <input id={ackId} type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
            I understand this version no longer matches current requirements and does not count as currently complete
          </label>
        </div>
      ) : null}
      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor={reasonId}>Reason (optional)</label>
        <input id={reasonId} type="text" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
      </div>
      <div aria-live="polite">
        {failure ? (
          failure.code === "REVISION_CONFLICT"
            ? <Banner tone="warn" title="Someone else changed the active version" actions={<button type="button" onClick={() => onOpenChange(false)}>Close and refresh</button>}>The list has been refreshed with the current active version. Review it, then try again.</Banner>
            : <ErrorBanner error={failure} />
        ) : null}
        {network ? <Banner tone="bad" title="No response from the server">{network} Retrying reuses the same request, so it cannot activate twice.</Banner> : null}
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
        <button type="button" className="primary" disabled={busy || (obsolete && !ack)} onClick={() => void submit()}>{busy ? "Working…" : verb}</button>
      </div>
      {obsolete && !ack ? <p className="secondary">Tick the acknowledgement to enable “{verb}”.</p> : null}
    </Modal>
  );
}
