import { useState } from "react";
import { useOperation } from "../../api/hooks.ts";
import { ContinueDialog } from "./ContinueDialog.tsx";
import { DifferencesTable, rebaseSource } from "./shared.tsx";

/** The promotion blocker's detail: what differs between the branch's saved basis and the current files, and the rebase action. */
export function BasisMismatch({ assetId, branchId }: { assetId: string; branchId: string }) {
  const [open, setOpen] = useState(false);
  const branches = useOperation("branch.list", { assetId });
  const branch = branches.data?.ok ? branches.data.data.branches.find((item) => item.branchId === branchId) : undefined;
  const source = branch ? rebaseSource(branch) : undefined;
  const plan = useOperation("branch.plan", { candidateId: source?.candidateId ?? "", ...(source?.outputId ? { outputId: source.outputId } : {}), inputMode: "current" }, { enabled: source !== undefined });
  const differences = plan.data?.ok ? plan.data.data.plan.differences : undefined;
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {differences ? <DifferencesTable differences={differences} /> : <p className="secondary" role="status">{plan.data && !plan.data.ok ? plan.data.error.message : "Loading the differences…"}</p>}
      {source ? <div><button type="button" className="primary" onClick={() => setOpen(true)}>Rebase to current inputs…</button></div> : null}
      {open && source ? <ContinueDialog assetId={assetId} candidateId={source.candidateId} outputId={source.outputId} fixedMode="current" onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
