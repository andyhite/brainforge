import { useState } from "react";
import { Link } from "react-router-dom";
import type { EffectiveLeaf } from "@brainforge/contracts";
import { useOperation } from "../api/hooks.ts";
import { specRoute } from "../lib/use-project.ts";
import { Banner, gate, Status } from "./ui.tsx";

const LAYER_LABEL: Record<EffectiveLeaf["source"]["layer"], string> = {
  "project-defaults": "Project defaults",
  "family-defaults": "Asset-family defaults",
  asset: "This asset",
  deliverable: "This deliverable",
  "built-in": "Built-in default",
};

const FPS = /fps/i;

function show(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

export function EffectiveSettings({ assetId }: { assetId?: string }) {
  const query = useOperation("settings.inspect", assetId ? { assetId } : {});
  const [filter, setFilter] = useState("");

  const g = gate(query, "Loading effective settings…", false);
  if ("node" in g) return g.node;
  const { effective, conflicts } = g.data;
  const needle = filter.trim().toLowerCase();
  const rows = Object.entries(effective)
    .filter(([key]) => needle === "" || key.toLowerCase().includes(needle))
    .sort(([a], [b]) => a.localeCompare(b));
  const fpsLeaves = Object.entries(effective).filter(([key]) => FPS.test(key));

  return (
    <div className="stack">
      {conflicts.length > 0 ? (
        <Banner tone="warn" title="Conflicting values">
          <ul className="plain-list">
            {conflicts.map((conflict) => (
              <li key={conflict.field}>
                <span className="mono">{conflict.field}</span>:{" "}
                {conflict.values.map((entry) => `${entry.file} = ${show(entry.value)}`).join("; ")}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {fpsLeaves.map(([key, leaf]) => (
        <p key={key} className="secondary">
          Frame rate <span className="mono">{key}</span> = {show(leaf.value)} was inherited from {LAYER_LABEL[leaf.source.layer].toLowerCase()}{" "}
          ({leaf.source.layer === "built-in" ? <span>built-in default</span> : <Link to={specRoute(leaf.source.file)} className="mono">{leaf.source.file}</Link>}, <span className="mono">{leaf.source.field}</span>).
        </p>
      ))}
      <div className="field">
        <label htmlFor="effective-filter">Filter settings</label>
        <input id="effective-filter" type="text" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {rows.length === 0 ? (
        <p className="secondary">No settings match.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Source file</th><th scope="col">Source field</th><th scope="col">Comes from</th></tr>
            </thead>
            <tbody>
              {rows.map(([key, leaf]) => (
                <tr key={key} className={FPS.test(key) ? "highlight" : undefined}>
                  <th scope="row" className="mono">
                    {key}
                    {FPS.test(key) ? <> <Status tone="info">inherited frame-rate source</Status></> : null}
                  </th>
                  <td className="mono">{show(leaf.value)}</td>
                  <td>{leaf.source.layer === "built-in" ? <span className="mono">built-in default</span> : <Link to={specRoute(leaf.source.file)} className="mono">{leaf.source.file}</Link>}</td>
                  <td className="mono">{leaf.source.field}</td>
                  <td>{LAYER_LABEL[leaf.source.layer]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
