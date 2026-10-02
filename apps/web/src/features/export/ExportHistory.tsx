import type { ExportRecord } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, gate, Status, formatTime, timeAgo, type Tone } from "../../components/ui.tsx";
import { whoLabel } from "../review/room-lib.ts";

const STATE: Record<ExportRecord["state"], { tone: Tone; text: string }> = {
  committed: { tone: "ok", text: "Exported" },
  prepared: { tone: "warn", text: "Prepared, not switched" },
  failed: { tone: "bad", text: "Failed" },
};

function ExportInspect({ exportId }: { exportId: string }) {
  const query = useOperation("export.inspect", { exportId });
  const g = gate(query, "Loading export…");
  if ("node" in g) return g.node;
  const { export: record, manifest, conflicts } = g.data;
  return (
    <div className="rel-detail" role="region" aria-label={`Export ${exportId.slice(0, 8)} details`}>
      <dl className="kv">
        <dt>Layout</dt><dd>{record.preset}</dd>
        <dt>Stable path</dt><dd className="mono">{record.publicRoot}</dd>
        <dt>Backing release</dt><dd className="mono">{record.releasePath}</dd>
        <dt>Created by</dt><dd>{whoLabel(record.createdBy)}</dd>
        <dt>Assets</dt><dd>{record.selection.map((item) => item.assetId).join(", ") || "none"}</dd>
        {manifest ? <><dt>Owned files</dt><dd>{manifest.ownedFiles.length}</dd></> : null}
      </dl>
      {record.error ? <Banner tone="bad" title="Why it failed">{record.error}</Banner> : null}
      {conflicts.length > 0 ? (
        <Banner tone="warn" title={`${conflicts.length} owned ${conflicts.length === 1 ? "file was" : "files were"} changed outside Brainforge`}>
          They are kept, and the next export is blocked until you restore or move them.
          <ul aria-label="Conflicting files">{conflicts.map((item) => <li key={item.path}><code>{item.path}</code>: {item.reason}</li>)}</ul>
        </Banner>
      ) : record.state === "committed" ? <p><Status tone="ok">Every file this export wrote still matches</Status></p> : null}
      {manifest ? (
        <details>
          <summary>Files this export owns ({manifest.ownedFiles.length})</summary>
          <ul className="plain-list mono rel-files">{manifest.ownedFiles.map((file) => <li key={file.path}>{file.path} <span className="secondary">{file.size} B</span></li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

/** Past exports, newest first. Exported files are copies; the current export is what the stable path resolves to. */
export function ExportHistory({ selected, onSelect: setSelected }: { selected: string | undefined; onSelect: (exportId: string | undefined) => void }) {
  const query = useOperation("export.list", { limit: 20 });
  const g = gate(query, "Loading past exports…");
  if ("node" in g) return g.node;
  if (g.data.exports.length === 0) return <p className="secondary">Nothing has been exported yet.</p>;
  return (
    <>
      <ul className="rows rel-history" aria-label="Exports, newest first">
        {g.data.exports.map((record) => {
          const state = STATE[record.state];
          const open = selected === record.exportId;
          return (
            <li key={record.exportId} aria-current={record.current ? "true" : undefined}>
              <div className="rel-history-row">
                <Status tone={state.tone}>{state.text}</Status>
                {record.current ? <span className="stamp">Current</span> : null}
                <span className="rel-meta">
                  <time dateTime={record.committedAt ?? record.createdAt} title={formatTime(record.committedAt ?? record.createdAt)}>{timeAgo(record.committedAt ?? record.createdAt)}</time>
                  {" · "}{record.selection.length} {record.selection.length === 1 ? "asset" : "assets"} · {record.preset}
                  {record.error ? ` · ${record.error}` : ""}
                </span>
                <button type="button" className="sm" aria-expanded={open} onClick={() => setSelected(open ? undefined : record.exportId)}>
                  {open ? "Hide details" : "Details"}<span className="sr-only"> for export {record.exportId.slice(0, 8)}</span>
                </button>
              </div>
              {record.warnings.map((warning) => <div key={warning} className="rel-meta">{warning}</div>)}
              {open ? <ExportInspect key={record.exportId} exportId={record.exportId} /> : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
