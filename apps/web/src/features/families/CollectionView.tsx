import { Link } from "react-router-dom";
import type { Branch, CollectionState } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { ActionLinks, Banner, Status, type Tone } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import "./families.css";
import { DeliverableThumb } from "../production/DeliverableThumb.tsx";

const STATE: Record<CollectionState["members"][number]["state"], { tone: Tone; text: string }> = {
  "no-version": { tone: "warn", text: "No version" },
  promoted: { tone: "info", text: "Promoted — not active" },
  active: { tone: "ok", text: "Active" },
};

interface Binding { bound: number; total: number; branches: string[] }

/** How many of a member's deliverables bind this environment's direction, read from its authored definition. */
function readBinding(spec: unknown, environmentId: string): Binding {
  const out: Binding = { bound: 0, total: 0, branches: [] };
  if (typeof spec !== "object" || spec === null || !("deliverables" in spec) || !Array.isArray(spec.deliverables)) return out;
  for (const d of spec.deliverables as unknown[]) {
    if (typeof d !== "object" || d === null) continue;
    out.total += 1;
    const roles = "referenceRoles" in d && typeof d.referenceRoles === "object" && d.referenceRoles !== null ? Object.values(d.referenceRoles) : [];
    const hit = roles.find((r) => typeof r === "object" && r !== null && "assetId" in r && r.assetId === environmentId && "role" in r && r.role === "direction");
    if (hit && typeof hit === "object" && "branchId" in hit) {
      out.bound += 1;
      if (typeof hit.branchId === "string" && !out.branches.includes(hit.branchId)) out.branches.push(hit.branchId);
    }
  }
  return out;
}

function MemberRow({ environmentId, member, direction }: { environmentId: string; member: CollectionState["members"][number]; direction: Branch | undefined }) {
  const inspect = useOperation("asset.inspect", { assetId: member.assetId });
  const info = inspect.data?.ok ? inspect.data.data : undefined;
  const binding = info ? readBinding(info.spec, environmentId) : undefined;
  const state = STATE[member.state];
  const mismatched = direction && binding ? binding.branches.filter((b) => b !== direction.branchId) : [];
  return (
    <tr>
      <th scope="row">
        <Link to={paths.asset(member.assetId)}>{info?.summary.name ?? member.assetId}</Link>
        <div className="member-sub">{member.assetId}{info?.summary.family ? ` · ${info.summary.family}` : ""}</div>
      </th>
      <td>{member.required ? <Status tone="info">Required</Status> : <Status tone="idle">Optional</Status>}</td>
      <td><Status tone={state.tone}>{state.text}</Status></td>
      <td>
        {member.activeVersionId ? "Active version" : member.latestVersionId ? "Latest version only" : "—"}
      </td>
      <td>
        {binding === undefined ? <span className="secondary">…</span> : binding.total === 0 ? <Status tone="idle">No deliverables</Status>
          : binding.bound === 0 ? <Status tone="warn">Does not follow it</Status>
            : mismatched.length > 0 ? <Status tone="warn">Follows another branch</Status>
              : binding.bound === binding.total ? <Status tone="ok">All {binding.total} follow it</Status>
                : <Status tone="info">{binding.bound} of {binding.total} follow it</Status>}
      </td>
      <td><Link to={paths.assetVersions(member.assetId)}>Versions</Link></td>
    </tr>
  );
}

/** An environment's members, its shared direction and what stops it from being complete. */
export function CollectionView({ assetId, collection, branches }: { assetId: string; collection: CollectionState | undefined; branches: Branch[] }) {
  const direction = branches.find((b) => b.isCurrent) ?? branches[0];
  return (
    <section className="collection" aria-labelledby="collection-title">
      <div className="collection-head">
        <h2 id="collection-title">Collection</h2>
        <Link className="button" to={`${paths.newAsset()}?memberOf=${encodeURIComponent(assetId)}`}>Create member asset…</Link>
      </div>
      <p className="secondary">An environment is a visual collection: its locked concept is the shared direction its members follow. Members stay ordinary assets with their own deliverables and versions.</p>

      <h3>Shared direction</h3>
      {direction ? (
        <div className="collection-direction">
          <DeliverableThumb candidateId={direction.conceptCandidateId} outputId={direction.conceptOutputId} label={`Locked concept of branch ${direction.name}`} />
          <div>
            <div><strong>{direction.name}</strong> {direction.isCurrent ? <Status tone="info">Current branch</Status> : null}</div>
            <Link to={paths.step(assetId, "concept", { candidate: direction.conceptCandidateId, output: direction.conceptOutputId })}>Open the locked concept</Link>
          </div>
        </div>
      ) : (
        <Banner tone="warn" title="No locked concept yet" actions={<Link className="button" to={paths.step(assetId, "concept")}>Go to concept</Link>}>
          Members cannot follow a direction until this environment has a locked concept.
        </Banner>
      )}

      <h3>Members</h3>
      {!collection || collection.members.length === 0 ? (
        <p className="secondary">No members are listed. Add them in the definition (Members) or create one with the button above.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Collection members and their production state</caption>
            <thead>
              <tr><th scope="col">Member</th><th scope="col">Requirement</th><th scope="col">Production</th><th scope="col">Version</th><th scope="col">Follows this direction</th><th scope="col"><span className="sr-only">Link</span></th></tr>
            </thead>
            <tbody>
              {collection.members.map((member) => <MemberRow key={member.assetId} environmentId={assetId} member={member} direction={direction} />)}
            </tbody>
          </table>
        </div>
      )}

      {collection ? (
        collection.complete ? (
          <p><Status tone="ok">Collection complete</Status> <span className="secondary">Every required member has an active version.</span></p>
        ) : (
          <div aria-live="polite">
            <Banner tone="warn" title="Collection is incomplete">
              The environment cannot go into the game until every required member has an active version (or you pin a specific version when promoting) and each member follows this environment’s locked concept.
            </Banner>
            <ul className="plain-list">
              {collection.blockers.map((blocker) => (
                <li key={`${blocker.code}-${blocker.message}`}>
                  <Banner tone="warn" title="Needs attention" actions={<ActionLinks actions={blocker.recoveryActions} />}>{blocker.message}</Banner>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
    </section>
  );
}
