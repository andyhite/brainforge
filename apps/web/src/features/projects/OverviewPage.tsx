import { Link } from "react-router-dom";
import { parse } from "yaml";
import type { Problem } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, EmptyState, ErrorBanner, NetworkProblem, NextActions, PageHeader, ProblemList, Status } from "../../components/ui.tsx";
import { BLOCKED_TEXT } from "../../components/SpecEditor.tsx";
import { specRoute, useProject } from "../../lib/use-project.ts";
import { isDefinitionMissing } from "../assets/missing.ts";
import { AssetIndex } from "../assets/AssetIndex.tsx";

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
    else next = { label: "Review assets", to: "/assets", why: report ? "Definitions are in place." : "Readiness is not available yet; definitions are valid." };
  }

  const taskLink = (assetId: string, state: string) => {
    const id = encodeURIComponent(assetId);
    if (state === "no-definition") return `/assets/${id}?step=definition&create=1`;
    if (state === "invalid-definition") return `/assets/${id}?step=definition`;
    if (state === "no-promoted-version" || state === "not-activated" || state === "obsolete-version") return `/assets/${id}?step=versions`;
    if (state === "open-feedback") return `/review?asset=${id}`;
    return `/assets/${id}`;
  };

  return (
    <div className="stack">
      <div className="wb-head">
        <h1>{summary.name}</h1>
        <span className="mono secondary">{summary.root}</span>
      </div>

      {summary.state === "closing" ? <Banner tone="warn" title="Closing — background work continues, not yet safe to move">The directory is still in use until tracked work finishes.</Banner> : null}
      {!summary.writable ? <Banner tone="warn" title="Read-only">This project cannot be changed (for example a newer schema). See Settings → Project.</Banner> : null}

      <section className="wb-next" aria-label="Next action">
        <p><strong>Next:</strong> {next.why}</p>
        <Link className="button primary" to={next.to}>{next.label}</Link>
      </section>
      <NextActions actions={project.envelope?.ok ? project.envelope.nextActions : []} />

      {allProblems.length > 0 ? (
        <section aria-labelledby="problems-title">
          <h2 id="problems-title">Project and specification problems</h2>
          <ProblemList problems={allProblems} blocked={BLOCKED_TEXT} onOpenFile={specRoute} />
        </section>
      ) : null}

      <div className="wb-home">
        <section className="wb-readiness" aria-labelledby="req-title">
          <h2 id="req-title">Required assets</h2>
          {report ? (
            <>
              <p>
                {report.counts.required === 0 ? <Status tone="idle">None declared</Status> : (
                  <Status tone={report.complete ? "ok" : "warn"}>{report.counts.complete} of {report.counts.required} complete</Status>
                )}
              </p>
              <ul aria-label="Required assets">
                {report.requiredAssets.map((asset) => (
                  <li key={asset.assetId}>
                    <Link to={taskLink(asset.assetId, asset.state)}>{asset.name ?? asset.assetId}</Link>
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
          <h2>Attention</h2>
          {report ? (
            <ul>
              <li>
                <span>Needs reassessment</span>
                <Status tone={report.counts.assetsNeedingReassessment > 0 ? "warn" : "idle"}>{report.counts.assetsNeedingReassessment === 0 ? "None" : `${report.counts.assetsNeedingReassessment} asset(s)`}</Status>
              </li>
              <li>
                <Link to="/review">Waiting for review</Link>
                <Status tone={report.counts.awaitingReview + report.counts.needsRevision > 0 ? "warn" : "idle"}>{report.counts.awaitingReview} awaiting · {report.counts.escalated} escalated · {report.counts.needsRevision} with unresolved notes</Status>
              </li>
              <li>
                <Link to="/export">Export</Link>
                <Status tone={report.export.status === "current" ? "ok" : report.export.status === "failed" || report.export.status === "out-of-date" ? "warn" : "idle"}>{report.export.status.replaceAll("-", " ")}</Status>
                <span className="secondary" style={{ flexBasis: "100%" }}>{report.export.detail}</span>
              </li>
            </ul>
          ) : completeness.error ? <NetworkProblem error={completeness.error} />
          : completeness.data && !completeness.data.ok ? <ErrorBanner error={completeness.data.error} extra={<button type="button" onClick={() => void completeness.refetch()}>Retry</button>} />
          : <p className="secondary" role="status">Loading readiness…</p>}
          <p className="secondary">Changed requirements return affected approvals to review; history is kept.</p>
        </section>
        <AssetIndex />
      </div>
    </div>
  );
}
