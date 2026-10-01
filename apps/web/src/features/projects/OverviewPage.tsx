import { Link } from "react-router-dom";
import { parse } from "yaml";
import type { Problem } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, EmptyState, ErrorBanner, NetworkProblem, NextActions, PageHeader, ProblemList, Status } from "../../components/ui.tsx";
import { BLOCKED_TEXT } from "../../components/SpecEditor.tsx";
import { specRoute, useProject } from "../../lib/use-project.ts";
import { isDefinitionMissing } from "../assets/missing.ts";

interface NextStep {
  label: string;
  to: string;
  why: string;
}

function requiredAssetIds(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const doc: unknown = parse(text);
    if (typeof doc !== "object" || doc === null || !("requirements" in doc)) return [];
    const requirements = doc.requirements;
    if (typeof requirements !== "object" || requirements === null || !("assets" in requirements) || !Array.isArray(requirements.assets)) return [];
    return requirements.assets.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function OverviewPage() {
  const project = useProject();
  const projectYaml = useOperation("spec.read", { path: "brainforge/project.yaml" }, { enabled: project.data !== undefined });
  const settings = useOperation("settings.inspect", {}, { enabled: project.data !== undefined });
  const completeness = useOperation("project.completeness", {}, { enabled: project.data !== undefined });

  if (!project.root) {
    return (
      <div>
        <PageHeader title="Overview" />
        <EmptyState title="No project selected">
          <p>Open the game directory you want to make assets for. Brainforge reads <code>brainforge/project.yaml</code> there.</p>
          <Link className="button primary" to="/projects/open">Open a project</Link>
        </EmptyState>
      </div>
    );
  }
  if (project.networkError) return <NetworkProblem error={project.networkError} />;
  if (project.loading) return <p role="status">Loading project…</p>;
  if (project.envelope && !project.envelope.ok) {
    return (
      <div>
        <PageHeader title="Overview" />
        <ErrorBanner error={project.envelope.error} />
        <p className="mono secondary">{project.root}</p>
        <Link className="button primary" to="/projects/open">Open or initialize a project</Link>
      </div>
    );
  }
  const data = project.data;
  if (!data) return null;

  const summary = data.project;
  const required = requiredAssetIds(projectYaml.data?.ok ? projectYaml.data.data.text : undefined);
  const byId = Object.fromEntries(data.assets.map((asset) => [asset.assetId, asset]));
  const requiredStates = required.map((id) => ({ id, asset: byId[id] }));
  const requiredValid = requiredStates.filter((item) => item.asset?.valid).length;
  const missing = requiredStates.filter((item) => !item.asset);
  const invalid = requiredStates.filter((item) => item.asset && !item.asset.valid && !isDefinitionMissing(item.asset.problems));
  const undefinedRequired = missing[0]?.id ?? requiredStates.find((item) => item.asset && isDefinitionMissing(item.asset.problems))?.id ?? data.assets.find((asset) => isDefinitionMissing(asset.problems))?.assetId;
  const invalidSpecs = data.specs.filter((spec) => !spec.valid);
  const policy = settings.data?.ok ? settings.data.data.policy : undefined;

  const allProblems: Problem[] = [...summary.problems];
  for (const spec of invalidSpecs) for (const problem of spec.problems) if (!allProblems.some((p) => p.file === problem.file && p.line === problem.line && p.message === problem.message)) allProblems.push({ file: spec.path, ...problem });
  const report = completeness.data?.ok ? completeness.data.data : undefined;

  let next: NextStep;
  const firstBad = invalidSpecs[0];
  if (firstBad) next = { label: "Fix invalid YAML", to: specRoute(firstBad.path), why: `${firstBad.path} has ${firstBad.problems.length} problem(s).` };
  else if (!summary.specValid) next = { label: "Fix invalid YAML", to: "/settings/direction?view=yaml", why: "project.yaml is invalid." };
  else if (policy && policy.diff.length > 0) next = { label: "Confirm policy", to: "/settings/direction", why: policy.pendingRelaxation ? "The requested approval policy is more permissive than the confirmed one." : "The requested approval policy differs from the confirmed one." };
  else if (data.assets.length === 0 && missing.length === 0) next = { label: "Author asset YAML", to: "/assets", why: "No assets are defined yet." };
  else if (undefinedRequired) next = { label: "Author asset YAML", to: `/assets/${encodeURIComponent(undefinedRequired)}?step=definition&create=1`, why: `Required asset ${undefinedRequired} has no definition yet.` };
  else {
    const open = report?.requiredAssets.find((a) => a.state !== "complete");
    if (open) next = { label: "Open " + (open.name ?? open.assetId), to: `/assets/${encodeURIComponent(open.assetId)}`, why: `${open.name ?? open.assetId}: ${open.reasons[0] ?? open.state.replaceAll("-", " ")}.` };
    else if (report && report.counts.awaitingReview > 0) next = { label: "Open the review queue", to: "/review", why: `${report.counts.awaitingReview} output(s) are waiting for a decision.` };
    else if (report && report.complete && report.export.status !== "current") next = { label: "Export", to: "/export", why: report.export.detail };
    else next = { label: "Review assets", to: "/assets", why: "Definitions are in place." };
  }

  return (
    <div>
      <PageHeader title="Overview" />
      <p style={{ marginBottom: 16 }}><strong>{summary.name}</strong> <span className="mono secondary">{summary.root}</span></p>

      {summary.state === "closing" ? <Banner tone="warn" title="Closing — background work continues, not yet safe to move">The directory is still in use until tracked work finishes.</Banner> : null}
      {!summary.writable ? <Banner tone="warn" title="Read-only">This project cannot be changed (for example a newer schema). See Settings → Project.</Banner> : null}

      <section className="panel" aria-labelledby="next-title">
        <h2 id="next-title">Next action</h2>
        <p style={{ marginBottom: 12 }}>{next.why}</p>
        <Link className="button primary" to={next.to}>{next.label}</Link>
        <NextActions actions={project.envelope?.ok ? project.envelope.nextActions : []} />
      </section>

      {allProblems.length > 0 ? (
        <section className="panel" aria-labelledby="problems-title">
          <h2 id="problems-title">Project problems</h2>
          <ProblemList problems={allProblems} blocked={BLOCKED_TEXT} onOpenFile={specRoute} />
        </section>
      ) : null}

      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="panel" aria-labelledby="req-title" style={{ marginTop: 0 }}>
          <h2 id="req-title">Required assets complete</h2>
          {report ? (
            <>
              <p>
                {report.counts.required === 0 ? <Status tone="idle">None declared</Status> : (
                  <Status tone={report.complete ? "ok" : "warn"}>{report.counts.complete} of {report.counts.required} complete</Status>
                )}
              </p>
              <ul className="plain-list" aria-label="Required assets">
                {report.requiredAssets.map((asset) => (
                  <li key={asset.assetId} className="row" style={{ justifyContent: "space-between" }}>
                    <Link to={`/assets/${encodeURIComponent(asset.assetId)}`}>{asset.name ?? asset.assetId}</Link>
                    <span className="secondary">{asset.state === "complete" ? `Version ${asset.activeVersionNumber} active` : `${asset.state.replaceAll("-", " ")}${asset.reasons[0] ? ` — ${asset.reasons[0]}` : ""}`}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              {required.length === 0 ? <p><Status tone="idle">None declared</Status></p> : <p><Status tone={requiredValid === required.length ? "info" : "warn"}>{requiredValid} of {required.length} required definitions are valid</Status></p>}
              {missing.length > 0 ? <p className="secondary">Missing definition: {missing.map((item) => item.id).join(", ")}</p> : null}
              {invalid.length > 0 ? <p className="secondary">Invalid definition: {invalid.map((item) => item.id).join(", ")}</p> : null}
            </>
          )}
        </section>
        <section className="panel" aria-labelledby="reassess-title" style={{ marginTop: 0 }}>
          <h2 id="reassess-title">Needs reassessment</h2>
          {report ? (
            <p><Status tone={report.counts.assetsNeedingReassessment > 0 ? "warn" : "idle"}>{report.counts.assetsNeedingReassessment === 0 ? "Nothing needs reassessment" : `${report.counts.assetsNeedingReassessment} asset(s) need reassessment`}</Status></p>
          ) : <p className="secondary" role="status">Loading…</p>}
          <p className="secondary">Changed requirements return affected approvals to review; history is kept.</p>
        </section>
        <section className="panel" aria-labelledby="waiting-title" style={{ marginTop: 0 }}>
          <h2 id="waiting-title">Waiting for review</h2>
          {report ? (
            <>
              <p><Status tone={report.counts.awaitingReview + report.counts.needsRevision > 0 ? "warn" : "idle"}>{report.counts.awaitingReview} awaiting a decision</Status></p>
              <p className="secondary">{report.counts.escalated} escalated to a human · {report.counts.needsRevision} with unresolved required notes</p>
              <Link to="/review">Open the review queue</Link>
            </>
          ) : <p className="secondary" role="status">Loading…</p>}
        </section>
        <section className="panel" aria-labelledby="export-title" style={{ marginTop: 0 }}>
          <h2 id="export-title">Export status</h2>
          {report ? (
            <>
              <p><Status tone={report.export.status === "current" ? "ok" : report.export.status === "failed" || report.export.status === "out-of-date" ? "warn" : "idle"}>{report.export.status.replaceAll("-", " ")}</Status></p>
              <p className="secondary">{report.export.detail}</p>
              <Link to="/export">Open export</Link>
            </>
          ) : <p className="secondary" role="status">Loading…</p>}
        </section>
      </div>
    </div>
  );
}
