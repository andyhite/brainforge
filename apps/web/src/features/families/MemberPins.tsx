import { Link } from "react-router-dom";
import type { PromotionMemberRow } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Status } from "../../components/ui.tsx";

function Picker({ row, pinned, onPin, busy }: { row: PromotionMemberRow; pinned: string | undefined; onPin: (versionId: string | undefined) => void; busy: boolean }) {
  const versions = useOperation("version.list", { assetId: row.assetId });
  const list = versions.data?.ok ? versions.data.data.versions : [];
  const id = `pin-${row.assetId}`;
  return (
    <div className="field compact" style={{ marginBottom: 0 }}>
      <label htmlFor={id} className="sr-only">Version of {row.assetId} to pin</label>
      <select id={id} value={pinned ?? ""} disabled={busy || versions.isPending} onChange={(e) => onPin(e.target.value === "" ? undefined : e.target.value)}>
        <option value="">{row.required ? "Active version (default)" : "Leave out (optional)"}</option>
        {list.map((v) => <option key={v.versionId} value={v.versionId}>v{v.versionNumber} · {v.state}{v.matchesCurrent ? "" : " · obsolete"}</option>)}
      </select>
    </div>
  );
}

/** The member versions an environment aggregate would pin, with a picker per member for explicit overrides. */
export function MemberPins({ members, pins, onPin, busy }: { members: PromotionMemberRow[]; pins: Record<string, string>; onPin: (assetId: string, versionId: string | undefined) => void; busy: boolean }) {
  if (members.length === 0) return null;
  return (
    <section aria-labelledby="member-pins" style={{ marginTop: 16 }}>
      <h3 id="member-pins">Member versions this aggregate pins</h3>
      <p className="secondary">Required members default to their active version; pick another to pin it explicitly. Optional members are only included when you pick a version. Changing a pin makes a new plan.</p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Member versions pinned by this promotion plan</caption>
          <thead>
            <tr><th scope="col">Member</th><th scope="col">Requirement</th><th scope="col">Pinned version</th><th scope="col">Source</th><th scope="col">Direction</th><th scope="col">Pick</th></tr>
          </thead>
          <tbody>
            {members.map((row) => (
              <tr key={row.assetId}>
                <th scope="row">
                  <Link to={`/assets/${encodeURIComponent(row.assetId)}?step=versions`}>{row.assetId}</Link>
                  {row.message ? <div className="secondary" style={{ fontWeight: 400 }}>{row.message}</div> : null}
                </th>
                <td>{row.required ? "Required" : "Optional"}</td>
                <td>
                  {row.versionNumber !== undefined ? <>v{row.versionNumber}{row.obsolete ? <> <Status tone="warn">Obsolete</Status></> : null}</> : <Status tone={row.required ? "bad" : "idle"}>{row.required ? "None — blocks" : "Not included"}</Status>}
                </td>
                <td>{row.source === "explicit" ? <Status tone="info">Explicit pin</Status> : row.source === "active" ? <Status tone="idle">Active version</Status> : "—"}</td>
                <td>{row.versionNumber === undefined ? "—" : row.directionMatches ? <Status tone="ok">Matches</Status> : <Status tone="bad">Direction mismatch</Status>}</td>
                <td><Picker row={row} pinned={pins[row.assetId]} busy={busy} onPin={(versionId) => onPin(row.assetId, versionId)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
