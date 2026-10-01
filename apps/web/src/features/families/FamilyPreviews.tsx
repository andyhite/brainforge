import { useQueries } from "@tanstack/react-query";
import { AssetSpec, type Deliverable } from "@brainforge/contracts";
import { callOperation } from "../../api/client.ts";
import { fileUrl, useOperation } from "../../api/hooks.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { useProject } from "../../lib/use-project.ts";
import { outputUrl } from "../generation/media.tsx";
import { AttachmentMarkers, BackgroundPreview, NineSlicePreview, StateCompare, TilePreview, VariantsGallery, type PreviewImage, type StateEntry } from "./previews.tsx";

export interface Sibling { deliverableId: string; candidateId: string; outputId?: string | undefined }

/** Selected output of every deliverable (current branch), unless the caller already knows them (a version's manifest). */
function useSiblings(assetId: string, given: Sibling[] | undefined): Sibling[] {
  const branches = useOperation("branch.list", { assetId }, { enabled: given === undefined });
  const list = branches.data?.ok ? branches.data.data.branches : [];
  const branchId = list.find((b) => b.isCurrent)?.branchId ?? list[0]?.branchId;
  const steps = useOperation("step.list", { assetId, ...(branchId ? { branchId } : {}) }, { enabled: given === undefined && branchId !== undefined });
  if (given) return given;
  if (!steps.data?.ok) return [];
  return steps.data.data.steps.filter((s) => s.selected && s.stepId !== "concept").map((s) => ({ deliverableId: s.stepId, candidateId: s.selected!.candidateId, outputId: s.selected!.outputId }));
}

/** Asset-viewer previews that fit the asset's family and the deliverable's declared metadata. Never level authoring. */
export function FamilyPreviews({ assetId, deliverableId, candidateId, outputId, siblings: givenSiblings, parts = "all" }: { assetId: string; deliverableId: string; candidateId: string; outputId: string; siblings?: Sibling[]; parts?: "all" | "deliverable" | "set" }) {
  const { root } = useProjectRoot();
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const inspect = useOperation("asset.inspect", { assetId }, { enabled: root !== undefined });
  const siblingList = useSiblings(assetId, givenSiblings);
  const shown = useOperation("candidate.inspect", { candidateId }, { enabled: root !== undefined });
  const output = shown.data?.ok ? shown.data.data.candidate.outputs.find((o) => o.outputId === outputId) : undefined;
  const detail = useOperation("output.inspect", { outputId }, { enabled: root !== undefined && output?.recipeHash !== undefined && output.mediaKind === "image" });

  const others = siblingList.filter((s) => s.deliverableId !== deliverableId);
  const candidates = useQueries({
    queries: others.map((s) => ({
      queryKey: ["op", "candidate.inspect", root ?? null, { candidateId: s.candidateId }],
      queryFn: ({ signal }: { signal: AbortSignal }) => callOperation("candidate.inspect", { project: root, input: { candidateId: s.candidateId }, signal }),
      enabled: root !== undefined,
      retry: false,
    })),
  });

  const parsed = inspect.data?.ok ? AssetSpec.safeParse(inspect.data.data.spec) : undefined;
  if (!parsed?.success || !projectId || !output || output.mediaKind !== "image") return null;
  const spec = parsed.data;
  const deliverable: Deliverable | undefined = spec.deliverables.find((d) => d.id === deliverableId);
  if (!deliverable) return null;

  const image: PreviewImage = { src: fileUrl(projectId, output.fileId), width: output.width, height: output.height, alt: `${spec.name}, ${deliverableId}` };
  const env = deliverable.environment;
  const family = spec.family;
  const symmetryWarning = detail.data?.ok ? detail.data.data.output.warnings.find((w) => w.code === "SYMMETRY")?.message : undefined;
  const mirrored = detail.data?.ok && detail.data.data.output.recipe && detail.data.data.output.recipe.tileRepeat !== "none" ? detail.data.data.output.recipe.tileRepeat : undefined;
  const symmetry = symmetryWarning ?? (mirrored ? `SYMMETRY WARNING: ${mirrored} reflects one half of the image onto the other, so the outer edges match. The picture becomes mirror-symmetric on that axis. This is not evidence that the original art tiles; check the seams visually.` : undefined);

  const entries: StateEntry[] = [];
  const base = `/assets/${encodeURIComponent(assetId)}/candidates/`;
  for (const d of spec.deliverables) {
    if (d.id === deliverableId) {
      entries.push({ key: d.id, label: d.ui?.state ?? d.id, deliverableId: d.id, src: outputUrl(projectId, output.fileId, 320), width: output.width, height: output.height, link: undefined, current: true });
      continue;
    }
    const at = others.findIndex((s) => s.deliverableId === d.id);
    const envelope = at >= 0 ? candidates[at]?.data : undefined;
    const sibling = at >= 0 ? others[at] : undefined;
    const cand = envelope?.ok ? envelope.data.candidate : undefined;
    const out = cand ? (cand.outputs.find((o) => o.outputId === sibling?.outputId) ?? cand.outputs.find((o) => o.stage === "processed") ?? cand.outputs[0]) : undefined;
    entries.push({ key: d.id, label: d.ui?.state ?? d.id, deliverableId: d.id, src: out ? outputUrl(projectId, out.fileId, 320) : undefined, width: out?.width ?? 128, height: out?.height ?? 128, link: cand ? `${base}${encodeURIComponent(cand.candidateId)}` : undefined, current: false });
  }
  const stateful = spec.deliverables.filter((d) => d.ui?.state !== undefined).length;
  const stills = entries.filter((e) => spec.deliverables.find((d) => d.id === e.deliverableId)?.kind !== "animation");

  const isTile = family === "tile" || deliverable.kind === "tile" || env?.tileSize !== undefined;
  const isBackground = !isTile && (family === "background" || (family === "environment" && (env?.seamlessAxes !== undefined || env?.parallax !== undefined)));
  const own = parts !== "set";
  const set = parts !== "deliverable";
  return (
    <>
      {own && isTile ? <TilePreview image={image} tileSize={env?.tileSize} seamlessAxes={env?.seamlessAxes ? [...env.seamlessAxes] : undefined} connections={env?.connections} symmetry={symmetry} /> : null}
      {own && isBackground ? <BackgroundPreview image={image} seamlessAxes={env?.seamlessAxes ? [...env.seamlessAxes] : undefined} parallax={env?.parallax} relativeScale={env?.relativeScale} layer={env?.layer} /> : null}
      {own && deliverable.ui?.nineSlice ? <NineSlicePreview image={image} slice={deliverable.ui.nineSlice} declared={{ width: deliverable.output?.width, height: deliverable.output?.height }} /> : null}
      {set && stateful >= 2 && stills.length >= 2 ? <StateCompare entries={stills.filter((e) => spec.deliverables.find((d) => d.id === e.deliverableId)?.ui?.state !== undefined)} /> : null}
      {set && stateful < 2 && !isTile && !isBackground && ["icon", "item", "equipment", "prop", "ui"].includes(family) && stills.length >= 2 ? <VariantsGallery entries={stills} title={family === "icon" ? "Icon variants and states" : "Variants and states"} /> : null}
      {own && (family === "equipment" || family === "prop") && spec.attachments.length > 0 ? (
        <AttachmentMarkers
          image={image}
          canvas={{ width: deliverable.output?.width ?? output.width, height: deliverable.output?.height ?? output.height }}
          points={spec.attachments.map((a) => ({ name: a.name, x: a.x, y: a.y, deliverable: a.deliverable }))}
          deliverableId={deliverableId}
        />
      ) : null}
    </>
  );
}
