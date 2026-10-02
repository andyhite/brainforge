import { useOperation } from "../../api/hooks.ts";
import { Banner, gate, Status, formatTime } from "../../components/ui.tsx";
import { FamilyPreviews } from "../families/FamilyPreviews.tsx";
import { whoLabel } from "../review/room-lib.ts";
import "./releases.css";

function show(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Everything about one saved version: what it holds, how it differs from today’s requirements, who activated it. Rendered inside a disclosure. */
export function VersionDetail({ versionId }: { versionId: string }) {
  const query = useOperation("version.inspect", { versionId });
  const g = gate(query, "Loading details…");
  if ("node" in g) return g.node;
  const { version, manifest, differences, activations } = g.data;
  const siblings = manifest.deliverables.map((d) => ({ deliverableId: d.deliverableId, candidateId: d.candidateId, outputId: d.outputId }));
  return (
    <div className="rel-detail">
      <h4>Deliverables</h4>
      <ul className="plain-list">
        {manifest.deliverables.map((item) => (
          <li key={item.deliverableId}>
            <strong>{item.deliverableId}</strong> <span className="secondary">{item.kind}{item.required ? "" : " · optional"} · {item.files.length} {item.files.length === 1 ? "file" : "files"}</span>
            {item.reusedFromVersionId ? <> <Status tone="info">Reused from an earlier version</Status></> : null}
          </li>
        ))}
      </ul>

      <h4>Previews</h4>
      <p className="secondary">Checks drawn from this version’s exact files and the metadata the asset declares.</p>
      {manifest.deliverables.map((item) => (
        <details key={item.deliverableId}>
          <summary>{item.deliverableId} · {item.kind}</summary>
          <FamilyPreviews assetId={manifest.assetId} deliverableId={item.deliverableId} candidateId={item.candidateId} outputId={item.outputId} parts="deliverable" siblings={siblings} />
        </details>
      ))}
      {manifest.deliverables[0] ? <FamilyPreviews assetId={manifest.assetId} deliverableId={manifest.deliverables[0].deliverableId} candidateId={manifest.deliverables[0].candidateId} outputId={manifest.deliverables[0].outputId} parts="set" siblings={siblings} /> : null}

      {manifest.members && manifest.members.length > 0 ? (
        <>
          <h4>Pinned member versions</h4>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Member versions pinned by this environment aggregate</caption>
              <thead><tr><th scope="col">Member</th><th scope="col">Version</th><th scope="col">Source</th><th scope="col">Family</th><th scope="col">Required</th></tr></thead>
              <tbody>
                {manifest.members.map((m) => <tr key={m.assetId}><th scope="row">{m.assetId}</th><td>v{m.versionNumber} <span className="mono secondary">{m.versionId.slice(0, 8)}</span></td><td>{m.source}</td><td>{m.family}</td><td>{m.required ? "Required" : "Optional"}</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h4>Differences from the current requirements</h4>
      {differences.length === 0 ? <p className="secondary">None: this version matches the current requirements.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Fields that differ between this version and the current requirements</caption>
            <thead><tr><th scope="col">Field</th><th scope="col">This version</th><th scope="col">Now</th></tr></thead>
            <tbody>
              {differences.map((diff) => (
                <tr key={diff.field}><th scope="row" className="mono">{diff.field}</th><td className="mono">{show(diff.version)}</td><td className="mono">{show(diff.current)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Activation history</h4>
      {activations.length === 0 ? <p className="secondary">Never activated.</p> : (
        <ol className="plain-list" aria-label="Activation history">
          {activations.map((event) => (
            <li key={event.eventId}>
              {whoLabel(event.actorId)} {event.kind === "restore" ? "restored" : "activated"} this version
              <span className="secondary"> · <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                {event.acknowledgedObsolete ? " · acknowledged it was out of date" : ""}{event.reason ? ` · ${event.reason}` : ""}</span>
            </li>
          ))}
        </ol>
      )}

      <h4>Record</h4>
      <dl className="kv">
        <dt>Version id</dt><dd className="mono">{manifest.versionId}</dd>
        <dt>Branch</dt><dd className="mono">{manifest.branchId}</dd>
        <dt>Requirements hash</dt><dd className="mono">{manifest.requirementsHash}</dd>
        <dt>Created</dt><dd>{formatTime(manifest.createdAt)} by {whoLabel(manifest.createdBy).toLowerCase()}</dd>
        <dt>Review decisions</dt><dd>{manifest.reviewDecisionIds.length}</dd>
        <dt>Directory</dt><dd className="mono">{version.directory}</dd>
      </dl>

      <h4>Files ({manifest.files.length})</h4>
      {manifest.files.length === 0 ? <Banner tone="warn" title="No files listed" /> : (
        <div className="table-wrap">
          <table className="rel-files">
            <caption className="sr-only">Files in this version with SHA-256 hashes</caption>
            <thead><tr><th scope="col">Path</th><th scope="col">Type</th><th scope="col">Size</th><th scope="col">SHA-256</th></tr></thead>
            <tbody>
              {manifest.files.map((file) => (
                <tr key={file.path}><th scope="row" className="mono">{file.path}</th><td>{file.mediaType}</td><td className="rel-num">{file.size.toLocaleString()} B</td><td className="mono rel-hash">{file.sha256}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
