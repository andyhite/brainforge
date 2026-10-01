import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Candidate } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { ErrorBanner, Modal, NetworkProblem } from "../../components/ui.tsx";
import { pickOutput } from "../generation/media.tsx";

/** Locks one exact concept output as a branch. States plainly what that does and does not do. */
export function LockConceptButton({ assetId, candidate }: { assetId: string; candidate: Candidate }) {
  const [open, setOpen] = useState(false);
  const output = pickOutput(candidate, "matted");
  return (
    <>
      <button type="button" disabled={!output} onClick={() => setOpen(true)} aria-label={`Lock ${candidate.label} as concept`}>Lock as concept</button>
      {open && output ? <LockDialog assetId={assetId} candidate={candidate} outputId={output.outputId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function LockDialog({ assetId, candidate, outputId, onClose }: { assetId: string; candidate: Candidate; outputId: string; onClose: () => void }) {
  const lock = useMutationOperation("concept.lock");
  const navigate = useNavigate();
  const [name, setName] = useState(candidate.label);
  const [reason, setReason] = useState("");

  const submit = async () => {
    const result = await lock.mutateAsync({
      input: { assetId, candidateId: candidate.candidateId, outputId, ...(name.trim() ? { name: name.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) },
    });
    if (result.ok) {
      onClose();
      void navigate(`/assets/${encodeURIComponent(assetId)}?step=concept&branch=${encodeURIComponent(result.data.branch.branchId)}`);
    }
  };

  return (
    <Modal open onOpenChange={(next) => { if (!next) onClose(); }} title={`Lock ${candidate.label} as the concept`} description="This choice starts production for this asset.">
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>Pins this exact output and the current requirements (definition, direction, palette).</li>
          <li>Creates a branch that the required reference steps build on.</li>
          <li>It is <strong>not</strong> a production version and does not export or activate anything.</li>
          <li>The other candidates stay available; you can lock another concept as a separate branch.</li>
        </ul>
        <div className="field">
          <label htmlFor="lock-name">Branch name</label>
          <input id="lock-name" type="text" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="lock-reason">Reason (optional)</label>
          <textarea id="lock-reason" rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} style={{ width: "100%" }} />
        </div>
        {lock.error ? <NetworkProblem error={lock.error} /> : null}
        {lock.data && !lock.data.ok ? <ErrorBanner error={lock.data.error} /> : null}
        <div className="row end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={lock.isPending}>{lock.isPending ? "Locking…" : "Lock concept"}</button>
        </div>
      </form>
    </Modal>
  );
}
