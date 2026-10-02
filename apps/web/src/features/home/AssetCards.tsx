import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { OperationData, Problem } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { OutputArt } from "../../components/OutputArt.tsx";
import { Art, MiniSheet } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { plural, progress } from "../../lib/next.ts";
import { splitProblems, useFamilies } from "../families/useFamilies.tsx";
import { isDefinitionMissing } from "../assets/missing.ts";

type Completeness = OperationData<"project.completeness">["requiredAssets"][number];

/** An asset as the grid sees it: a listed asset, or a required one whose folder doesn't exist yet. */
export interface CardAsset {
  assetId: string;
  name?: string | undefined;
  family?: string | undefined;
  required: boolean;
  valid: boolean;
  problems: Problem[];
  completeness?: Completeness | undefined;
  /** Version the current committed export put into the game, if any. */
  exportedVersionId?: string | undefined;
  tag?: { text: string; tone?: "warn" | "bad" | undefined } | undefined;
}

/** The locked concept of the current branch, else the newest concept candidate: the asset's face wherever it's shown. */
export function useConceptArt(assetId: string, ready = true) {
  const branches = useOperation("branch.list", { assetId }, { enabled: ready });
  const settled = branches.data !== undefined || branches.error !== null;
  const current = branches.data?.ok ? branches.data.data.branches.find((branch) => branch.isCurrent) : undefined;
  const newest = useOperation("candidate.list", { assetId, stepId: "concept", limit: 1 }, { enabled: ready && settled && current === undefined });
  const first = newest.data?.ok ? newest.data.data.candidates[0] : undefined;
  const candidate: { candidateId: string; outputId?: string } | undefined = current ? { candidateId: current.conceptCandidateId, outputId: current.conceptOutputId } : first ? { candidateId: first.candidateId } : undefined;
  return { candidate, loading: !ready || !settled || (current === undefined && newest.isLoading) };
}

function ConceptArt({ asset, tag, ready }: { asset: CardAsset; tag: ReactNode; ready: boolean }) {
  const { candidate, loading } = useConceptArt(asset.assetId, ready);
  const alt = `${asset.name ?? asset.assetId} concept`;
  if (candidate) return <OutputArt candidateId={candidate.candidateId} {...(candidate.outputId ? { outputId: candidate.outputId } : {})} alt={alt}>{tag}</OutputArt>;
  if (loading) return <Art>{tag}</Art>;
  return <div className="art empty">No concept yet{tag}</div>;
}

function Tag({ tag }: { tag: CardAsset["tag"] }) {
  return tag ? <span className={`tag${tag.tone ? ` ${tag.tone}` : ""}`}>{tag.text}</span> : null;
}

/** One card owns its own queries so a slow asset never holds the grid back. */
export function AssetCard({ asset }: { asset: CardAsset }) {
  const families = useFamilies();
  const missing = asset.completeness?.state === "no-definition" || isDefinitionMissing(asset.problems);
  const usable = asset.valid && !missing;
  const steps = useOperation("step.list", { assetId: asset.assetId }, { enabled: usable });
  const list = steps.data?.ok ? steps.data.data.steps : undefined;
  const label = families.profileOf(asset.family)?.label ?? asset.family;
  const name = asset.name ?? asset.assetId;
  const warnings = splitProblems(asset.problems).warnings.length;
  const active = asset.completeness?.activeVersionNumber;
  const exportedIsActive = asset.exportedVersionId !== undefined && asset.exportedVersionId === asset.completeness?.activeVersionId;
  const tag = <Tag tag={asset.tag} />;

  let state: ReactNode;
  if (missing) state = "Definition missing";
  else if (!asset.valid) state = "Definition has problems";
  else if (exportedIsActive) state = <><Icon name="check" size="sm" />Version {active} in the game</>;
  else if (asset.exportedVersionId !== undefined) state = active !== undefined ? `In the game · version ${active} not exported yet` : "In the game";
  else if (active !== undefined) state = `Version ${active} active · not exported yet`;
  else if (steps.error) state = "Couldn’t load progress";
  else if (!list) state = " ";
  else {
    const p = progress(list);
    if (p.concept && p.concept.state !== "complete") state = p.concept.counts.candidates > 0 ? `${plural(p.concept.counts.candidates, "concept")} · nothing produced yet` : "Ready for concepts";
    else if (p.total > 0) state = <><MiniSheet cells={p.cells} label={`${p.approved} of ${p.total} approved`} />{p.approved} of {p.total} approved</>;
    else state = "Concept locked";
  }

  return (
    <li>
      <Link className="asset-card" to={missing ? paths.assetDefinition(asset.assetId) : paths.asset(asset.assetId)}>
        <ConceptArt asset={asset} tag={tag} ready={usable} />
        <div className="line">
          <span className="name" title={name}>{name}</span>
          <span className="fam">{[label, asset.required ? undefined : "optional"].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="state">{state}{warnings > 0 ? ` · ${plural(warnings, "warning")}` : ""}</div>
      </Link>
    </li>
  );
}

