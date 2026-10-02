import type { AssetVersion } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { activeOf } from "./state.tsx";

/** Select over one asset's versions (newest first). The empty option means "no pin"; its text may depend on the active version. */
export function VersionPicker({ assetId, id, label, value, onChange, disabled = false, emptyText, optionText, className }: {
  assetId: string; id: string; label: string; value: string | undefined; onChange: (versionId: string | undefined) => void; disabled?: boolean;
  emptyText: (active: AssetVersion | undefined) => string; optionText: (version: AssetVersion) => string; className?: string;
}) {
  const query = useOperation("version.list", { assetId });
  if (!query.data) return <span className="secondary" role="status">Loading versions…</span>;
  if (!query.data.ok) return <span className="secondary">Versions unavailable</span>;
  const { versions, active } = query.data.data;
  const ordered = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)} disabled={disabled || ordered.length === 0}>
        <option value="">{emptyText(activeOf(versions, active))}</option>
        {ordered.map((version) => <option key={version.versionId} value={version.versionId}>{optionText(version)}</option>)}
      </select>
    </div>
  );
}
