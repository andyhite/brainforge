import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { StepState } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Status } from "../../components/ui.tsx";
import { depths, STATE_TEXT, STATE_TONE } from "../pipeline/steps.ts";
import { useFamilies } from "../families/useFamilies.tsx";
import { isDefinitionMissing } from "./missing.ts";
import "./workbench.css";

type Filter = "all" | "required" | "optional" | "attention";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All assets" }, { id: "required", label: "Required" }, { id: "optional", label: "Optional" }, { id: "attention", label: "Needs attention" },
];

function StepItem({ step, href, active, names }: { step: StepState; href: string; active: boolean; names: Map<string, StepState> }) {
  const blocker = step.state === "blocked" ? step.blockers[0]?.message : undefined;
  return (
    <li className="nav-item" data-active={active || undefined}>
      <Link to={href} aria-current={active ? "step" : undefined}>
        <span className="nav-label">{step.stepId}{step.stepId !== "concept" && !step.required ? <span className="secondary"> · optional</span> : null}</span>
        <Status tone={STATE_TONE[step.state]}>{STATE_TEXT[step.state]}</Status>
      </Link>
      {step.dependsOn.length > 0 ? <div className="nav-note">after {step.dependsOn.map((id) => names.get(id)?.stepId ?? id).join(", ")}</div> : null}
      {blocker ? <div className="nav-note nav-blocker">{blocker}</div> : null}
      {step.needsReassessment ? <div className="nav-note"><Status tone="warn">Needs reassessment</Status></div> : null}
    </li>
  );
}

/** Task tree of the selected asset: definition and references first, then the real dependency levels of its steps, then versions. */
function AssetTasks({ assetId, branchId, activeStep }: { assetId: string; branchId: string | undefined; activeStep: string | undefined }) {
  const inspect = useOperation("asset.inspect", { assetId });
  const steps = useOperation("step.list", { assetId, ...(branchId ? { branchId } : {}) });
  const base = `/assets/${encodeURIComponent(assetId)}`;
  const branchQuery = branchId ? `&branch=${encodeURIComponent(branchId)}` : "";
  const info = inspect.data?.ok ? inspect.data.data : undefined;
  const referenceCount = info?.directories.find((dir) => dir.path.replaceAll("\\", "/").endsWith("/references") || dir.path === "references")?.fileCount ?? 0;
  const list = steps.data?.ok ? steps.data.data.steps : [];
  const names = new Map(list.map((step) => [step.stepId, step]));
  const link = (step: string) => `${base}?step=${encodeURIComponent(step)}${branchQuery}`;
  const defTone = info ? (info.summary.valid ? "ok" : info.yamlHash === undefined ? "warn" : "bad") : "idle";
  const defText = info ? (info.summary.valid ? "Valid" : info.yamlHash === undefined ? "Missing" : "Invalid") : "…";
  return (
    <div className="nav-tree">
      <h3>Define</h3>
      <ul>
        <li className="nav-item" data-active={activeStep === "definition" || undefined}>
          <Link to={link("definition")} aria-current={activeStep === "definition" ? "step" : undefined}><span className="nav-label">Definition</span><Status tone={defTone}>{defText}</Status></Link>
        </li>
        <li className="nav-item" data-active={activeStep === "references" || undefined}>
          <Link to={link("references")} aria-current={activeStep === "references" ? "step" : undefined}><span className="nav-label">References</span>{referenceCount > 0 ? <Status tone="ok">{referenceCount} imported</Status> : <Status tone="idle">None yet</Status>}</Link>
        </li>
      </ul>
      <h3>Produce</h3>
      {steps.error ? <p className="nav-note">Steps unavailable.</p> : !steps.data ? <p className="nav-note" role="status">Loading steps…</p> : list.length === 0 ? <p className="nav-note">Steps appear once the definition is valid.</p> : (
        <ol aria-label="Steps in dependency order">
          {depths(list).map((level, index) => (
            <li key={index} className="nav-level" style={{ "--depth": Math.min(index, 3) } as CSSProperties}>
              {level.length > 1 ? <div className="nav-note">{level.length} independent steps</div> : null}
              <ul>{level.map((step) => <StepItem key={step.stepId} step={step} names={names} href={link(step.stepId)} active={activeStep === step.stepId} />)}</ul>
            </li>
          ))}
        </ol>
      )}
      <h3>Release</h3>
      <ul>
        <li className="nav-item" data-active={activeStep === "versions" || undefined}>
          <Link to={link("versions")} aria-current={activeStep === "versions" ? "step" : undefined}><span className="nav-label">Versions &amp; promotion</span></Link>
        </li>
      </ul>
    </div>
  );
}

/** Searchable asset list; only the selected asset expands into its task tree. Pass the viewed branch so every link keeps it. */
export function AssetNavigator({ assetId, branchId, activeStep }: { assetId: string; branchId?: string; activeStep?: string }) {
  const list = useOperation("asset.list", {});
  const completeness = useOperation("project.completeness", {});
  const families = useFamilies();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState(true);
  const assets = list.data?.ok ? list.data.data.assets : [];
  const readiness = new Map((completeness.data?.ok ? completeness.data.data.requiredAssets : []).map((asset) => [asset.assetId, asset.state]));
  const needle = query.trim().toLowerCase();
  const shown = assets.filter((asset) => {
    if (asset.assetId === assetId) return true;
    if (needle && !`${asset.name ?? ""} ${asset.assetId} ${asset.family}`.toLowerCase().includes(needle)) return false;
    if (filter === "required") return asset.required;
    if (filter === "optional") return !asset.required;
    if (filter === "attention") return !asset.valid || (readiness.has(asset.assetId) && readiness.get(asset.assetId) !== "complete");
    return true;
  });
  return (
    <nav className="asset-navigator" aria-label="Assets and tasks" data-collapsed={collapsed}>
      <button type="button" className="nav-toggle" aria-expanded={!collapsed} aria-controls="asset-navigator-body" onClick={() => setCollapsed((value) => !value)}>
        {collapsed ? "Show assets and steps" : "Hide assets and steps"}
      </button>
      <div className="nav-body" id="asset-navigator-body">
        <div className="nav-search">
          <label className="sr-only" htmlFor="asset-search">Search assets</label>
          <input id="asset-search" type="search" placeholder="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} />
          <label className="sr-only" htmlFor="asset-filter">Filter assets</label>
          <select id="asset-filter" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
            {FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div className="nav-actions">
          <Link to="/assets/new">New asset</Link>
          <Link to="/assets">All assets</Link>
        </div>
        {list.error ? <p className="nav-note" role="alert">Assets unavailable: {list.error.message}</p> : null}
        {!list.data && !list.error ? <p className="nav-note" role="status">Loading assets…</p> : null}
        {list.data && !list.data.ok ? <p className="nav-note" role="alert">{list.data.error.message}</p> : null}
        <ul className="nav-assets" aria-label="Assets">
          {shown.map((asset) => {
            const selected = asset.assetId === assetId;
            const state = readiness.get(asset.assetId);
            return (
              <li key={asset.assetId} className="nav-asset" data-selected={selected || undefined}>
                <Link to={`/assets/${encodeURIComponent(asset.assetId)}${selected && branchId ? `?branch=${encodeURIComponent(branchId)}` : ""}`} aria-current={selected ? "page" : undefined} className="nav-asset-link">
                  <span className="nav-label">{asset.name ?? asset.assetId}</span>
                  {!asset.valid ? <Status tone={isDefinitionMissing(asset.problems) ? "warn" : "bad"}>{isDefinitionMissing(asset.problems) ? "No definition" : "Invalid"}</Status>
                    : state ? <Status tone={state === "complete" ? "ok" : "warn"}>{state === "complete" ? "Done" : state.replaceAll("-", " ")}</Status> : null}
                </Link>
                <div className="nav-note">{families.profileOf(asset.family)?.label ?? asset.family} · {asset.required ? "required" : "optional"}</div>
                {selected ? <AssetTasks assetId={assetId} branchId={branchId} activeStep={activeStep} /> : null}
              </li>
            );
          })}
        </ul>
        {list.data?.ok && shown.length === 0 ? <p className="nav-note">No assets match.</p> : null}
      </div>
    </nav>
  );
}
