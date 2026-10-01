import type { Branch } from "@brainforge/contracts";
import { formatTime } from "../../components/ui.tsx";

/** Branch choice is URL state (`?branch=`); the parent owns it. */
export function BranchSwitcher({ branches, value, onChange }: { branches: Branch[]; value: string | undefined; onChange: (branchId: string) => void }) {
  if (branches.length === 0) {
    return <p className="secondary">No concept is locked yet. Lock one from the concept candidates to start production; steps after the concept stay blocked until then.</p>;
  }
  const current = branches.find((branch) => branch.branchId === value);
  return (
    <div className="field" style={{ maxWidth: 420 }}>
      <label htmlFor="branch-switch">Branch</label>
      <select id="branch-switch" value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        {branches.map((branch) => <option key={branch.branchId} value={branch.branchId}>{branch.name}</option>)}
      </select>
      {current ? <div className="hint">Locked by {current.lockedBy} ({current.lockedByType}) · {formatTime(current.lockedAt)}. A branch is a concept choice, not a production version.</div> : null}
    </div>
  );
}
