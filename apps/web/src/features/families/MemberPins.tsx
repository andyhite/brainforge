import { Link } from "react-router-dom";
import type { PromotionMemberRow } from "@brainforge/contracts";
import { Status } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { VersionPicker } from "../production/VersionPicker.tsx";
import "./families.css";

/** The member versions an environment aggregate would pin, with a picker per member for explicit overrides. */
export function MemberPins({ members, pins, onPin, busy }: { members: PromotionMemberRow[]; pins: Record<string, string>; onPin: (assetId: string, versionId: string | undefined) => void; busy: boolean }) {
  if (members.length === 0) return null;
  return (
    <section className="member-pins" aria-labelledby="member-pins">
      <h3 id="member-pins">Member versions this release pins</h3>
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
                  <Link to={paths.assetVersions(row.assetId)}>{row.assetId}</Link>
                  {row.message ? <div className="member-sub">{row.message}</div> : null}
                </th>
                <td>{row.required ? "Required" : "Optional"}</td>
                <td>
                  {row.versionNumber !== undefined ? <>v{row.versionNumber}{row.obsolete ? <> <Status tone="warn">Out of date</Status></> : null}</> : <Status tone={row.required ? "bad" : "idle"}>{row.required ? "None; blocks the plan" : "Not included"}</Status>}
                </td>
                <td>{row.source === "explicit" ? <Status tone="info">Explicit pin</Status> : row.source === "active" ? <Status tone="idle">Active version</Status> : "—"}</td>
                <td>{row.versionNumber === undefined ? "—" : row.directionMatches ? <Status tone="ok">Matches</Status> : <Status tone="bad">Direction mismatch</Status>}</td>
                <td>
                  <VersionPicker
                    assetId={row.assetId} id={`pin-${row.assetId}`} label={`Version of ${row.assetId} to pin`} className="field compact" value={pins[row.assetId]} disabled={busy} onChange={(versionId) => onPin(row.assetId, versionId)}
                    emptyText={() => (row.required ? "Active version (default)" : "Leave out (optional)")}
                    optionText={(v) => `v${v.versionNumber} · ${v.state}${v.matchesCurrent ? "" : " · obsolete"}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
