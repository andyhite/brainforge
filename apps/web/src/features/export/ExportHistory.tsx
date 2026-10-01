import type { ExportRecord } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem, Status, formatTime, type Tone } from "../../components/ui.tsx";

const STATE: Record<ExportRecord["state"], { tone: Tone; text: string }> = {
  committed: { tone: "ok", text: "Committed" },
  prepared: { tone: "warn", text: "Prepared — not switched" },
  failed: { tone: "bad", text: "Failed" },
};

function ExportInspect({ exportId }: { exportId: string }) {
  const query = useOperation("export.inspect", { exportId });
  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary" role="status">Loading export…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;
  const { export: record, manifest, conflicts } = query.data.data;
  return (
    <div className="panel" role="region" aria-label={`Export ${exportId.slice(0, 8)} details`} style={{ marginTop: 12 }}>
      <h3>Export {record.exportId.slice(0, 8)}</h3>
      <dl className="kv">
        <dt>Preset</dt><dd>{record.preset}</dd>
        <dt>Stable path</dt><dd className="mono">{record.publicRoot}</dd>
        <dt>Backing release</dt><dd className="mono">{record.releasePath}</dd>
        <dt>Created by</dt><dd>{record.createdBy}</dd>
        <dt>Assets</dt><dd>{record.selection.map((item) => item.assetId).join(", ") || "none"}</dd>
        {manifest ? <><dt>Owned files</dt><dd>{manifest.ownedFiles.length}</dd></> : null}
      </dl>
      {record.error ? <Banner tone="bad" title="Why it failed">{record.error}</Banner> : null}
      {conflicts.length > 0 ? (
        <Banner tone="warn" title={`${conflicts.length} owned ${conflicts.length === 1 ? "file was" : "files were"} changed outside Brainforge`}>
          They are preserved, and the next export is blocked until you restore or move them.
          <ul aria-label="Conflicting files">{conflicts.map((item) => <li key={item.path}><code>{item.path}</code> — {item.reason}</li>)}</ul>
        </Banner>
      ) : record.state === "committed" ? <p><Status tone="ok">Every owned file matches its recorded hash</Status></p> : null}
      {manifest ? (
        <details>
          <summary>Owned files ({manifest.ownedFiles.length})</summary>
          <ul className="plain-list mono">{manifest.ownedFiles.map((file) => <li key={file.path}>{file.path} <span className="secondary">{file.size} B</span></li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

export function ExportHistory({ selected, onSelect: setSelected }: { selected: string | undefined; onSelect: (exportId: string | undefined) => void }) {
  const query = useOperation("export.list", { limit: 20 });
  return (
    <section className="panel" id="export-history" aria-labelledby="export-history-title">
      <h2 id="export-history-title">Export history</h2>
      {query.error ? <NetworkProblem error={query.error} /> : !query.data ? <p className="secondary" role="status">Loading history…</p> : !query.data.ok ? <ErrorBanner error={query.data.error} /> : query.data.data.exports.length === 0 ? (
        <p className="secondary">Nothing has been exported yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Exports, newest first</caption>
            <thead>
              <tr><th scope="col">Export</th><th scope="col">State</th><th scope="col">Preset</th><th scope="col">When</th><th scope="col">Notes</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {query.data.data.exports.map((record) => {
                const state = STATE[record.state];
                return (
                  <tr key={record.exportId} aria-current={record.current ? "true" : undefined}>
                    <th scope="row" className="mono">{record.exportId.slice(0, 8)}</th>
                    <td>
                      <span className="row" style={{ gap: 8 }}>
                        <Status tone={state.tone}>{state.text}</Status>
                        {record.current ? <Status tone="info">Current</Status> : null}
                      </span>
                    </td>
                    <td>{record.preset}</td>
                    <td>{formatTime(record.committedAt ?? record.createdAt)}</td>
                    <td>
                      {record.error ? <div>{record.error}</div> : null}
                      {record.warnings.map((warning) => <div key={warning} className="secondary">{warning}</div>)}
                      {!record.error && record.warnings.length === 0 ? "—" : null}
                    </td>
                    <td>
                      <button type="button" aria-expanded={selected === record.exportId} onClick={() => setSelected(selected === record.exportId ? undefined : record.exportId)}>
                        {selected === record.exportId ? "Hide details" : "Inspect"}<span className="sr-only"> export {record.exportId.slice(0, 8)}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div aria-live="polite">{selected ? <ExportInspect key={selected} exportId={selected} /> : null}</div>
    </section>
  );
}
