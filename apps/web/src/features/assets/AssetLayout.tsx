import { useState } from "react";
import { Link, Outlet, useParams, useSearchParams } from "react-router-dom";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { gate, MenuButton, MiniSheet, Modal, OpResult, SubNav, timeAgo, type MenuEntry } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useReviewQueue } from "../../lib/attention.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { assetNext, progress, RANK, type NextItem } from "../../lib/next.ts";
import { paths } from "../../lib/paths.ts";
import { CompareBranches } from "../branches/CompareBranches.tsx";
import { ContinueDialog } from "../branches/ContinueDialog.tsx";
import { rebaseSource } from "../branches/shared.tsx";
import { useFamilies } from "../families/useFamilies.tsx";
import type { AssetVersion, Branch } from "@brainforge/contracts";
import { isDefinitionMissing } from "./missing.ts";
import { activeOf, newestPromoted } from "../production/state.tsx";
import { ActivateDialog, isRestore } from "../production/ActivateDialog.tsx";
import { PromotePanel } from "../production/PromotePanel.tsx";
import "./sheet.css";

export interface AssetView {
  enabled: boolean;
  branches: Branch[];
  current: Branch | undefined;
  viewed: Branch | undefined;
  loaded: boolean;
  branchId: string | undefined;
  /** Set only when the viewed branch is not the current one: the only case that needs `?branch=` in links. */
  branchParam: string | undefined;
}

/** Which branch the page shows: `?branch=` when it names a real one, else the asset's current branch. */
export function useAssetView(assetId: string): AssetView {
  const { root } = useProjectRoot();
  const [params] = useSearchParams();
  const enabled = root !== undefined && assetId !== "";
  const query = useOperation("branch.list", { assetId }, { enabled });
  const branches = query.data?.ok ? query.data.data.branches : [];
  const current = branches.find((branch) => branch.isCurrent);
  const viewed = branches.find((branch) => branch.branchId === params.get("branch")) ?? current ?? branches[0];
  return {
    enabled, branches, current, viewed,
    loaded: query.data !== undefined,
    branchId: viewed?.branchId,
    branchParam: viewed && current && viewed.branchId !== current.branchId ? viewed.branchId : undefined,
  };
}

type Dialog = "current" | "compare" | "rebase" | undefined;

function BranchMenu({ assetId, view }: { assetId: string; view: AssetView }) {
  const [, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(undefined);
  const select = useMutationOperation("branch.select");
  const { branches, current, viewed } = view;
  const concepts = useOperation("candidate.list", { assetId, stepId: "concept" }, { enabled: view.enabled && branches.length > 0 });
  const source = useOperation("candidate.inspect", { candidateId: viewed?.sourceCandidateId ?? "" }, { enabled: viewed?.sourceCandidateId !== undefined });
  if (!viewed) return null;

  const labels = new Map((concepts.data?.ok ? concepts.data.data.candidates : []).map((candidate) => [candidate.candidateId, candidate.label]));
  const names = new Map(branches.map((branch) => [branch.branchId, branch.name]));
  const view$ = (branchId: string, isCurrent: boolean) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (isCurrent) next.delete("branch"); else next.set("branch", branchId);
    return next;
  });
  const sourceStep = source.data?.ok ? source.data.data.candidate.stepId : undefined;
  const notCurrent = current !== undefined && viewed.branchId !== current.branchId;

  const items: MenuEntry[] = [
    ...branches.map((branch): MenuEntry => ({
      label: branch.name,
      checked: branch.branchId === viewed.branchId,
      description: [
        `locked from ${labels.get(branch.conceptCandidateId) ?? "a concept"}`,
        timeAgo(branch.lockedAt),
        branch.inputMode === "saved" ? "saved inputs" : undefined,
        branch.parentBranchId && names.get(branch.parentBranchId) ? `continued from ${names.get(branch.parentBranchId)}` : undefined,
        branch.isCurrent ? "current" : undefined,
      ].filter(Boolean).join(" · "),
      onSelect: () => view$(branch.branchId, branch.isCurrent),
    })),
    "separator",
    ...(notCurrent ? [{ label: "Make this branch current…", icon: "branch", onSelect: () => setDialog("current") } satisfies MenuEntry] : []),
    ...(branches.length > 1 ? [{ label: "Compare branches…", icon: "compare", onSelect: () => setDialog("compare") } satisfies MenuEntry] : []),
    ...(viewed.inputMode === "saved" ? [{ label: "Rebase onto the current files…", icon: "refresh", description: "Keeps this branch; makes a new one on today’s files", onSelect: () => setDialog("rebase") } satisfies MenuEntry] : []),
    ...(viewed.sourceCandidateId && sourceStep ? [{ label: "Open the candidate this branch came from", icon: "arrow-right", to: paths.step(assetId, sourceStep, { candidate: viewed.sourceCandidateId, ...(view.branchParam ? { branch: view.branchParam } : {}) }) } satisfies MenuEntry] : []),
  ];
  // Current and viewed first so a long list never pushes them out of the six the comparison allows.
  const compared = [...new Set([current?.branchId, viewed.branchId, ...branches.map((branch) => branch.branchId)].filter((id): id is string => id !== undefined))].slice(0, 6);
  const close = () => { setDialog(undefined); select.reset(); };
  const makeCurrent = async () => {
    const result = await select.mutateAsync({ input: { assetId, branchId: viewed.branchId } });
    if (result.ok) { close(); view$(viewed.branchId, true); }
  };

  return (
    <>
      <MenuButton
        label={`Branch “${viewed.name}”`}
        triggerClassName="branch-btn"
        trigger={<><Icon name="branch" size="sm" />Branch “{viewed.name}”<Icon name="chevron-down" size="sm" /></>}
        items={items}
      />
      {branches.length > 1 ? <span className="faint">{branches.length - 1} other {branches.length === 2 ? "branch" : "branches"}</span> : null}

      <Modal open={dialog === "current"} onOpenChange={(open) => { if (!open) close(); }} title={`Make “${viewed.name}” the current branch?`} description="Home, review and promotion work on the current branch. Nothing is promoted or activated by this.">
        <div className="stack">
          {current ? <p>Today the current branch is <strong>{current.name}</strong>. Both keep all of their work.</p> : null}
          <div aria-live="polite">
            <OpResult m={select} />
          </div>
          <div className="row end">
            <button type="button" onClick={close}>Cancel</button>
            <button type="button" className="primary" disabled={select.isPending} onClick={() => void makeCurrent()}>{select.isPending ? "Working…" : "Make current"}</button>
          </div>
        </div>
      </Modal>

      <Modal wide open={dialog === "compare"} onOpenChange={(open) => { if (!open) close(); }} title="Compare branches" description="Every deliverable side by side, and how each branch’s saved inputs differ.">
        {dialog === "compare" ? <CompareBranches assetId={assetId} branchIds={compared} /> : null}
      </Modal>

      {dialog === "rebase" ? <ContinueDialog assetId={assetId} {...rebaseSource(viewed)} fixedMode="current" onClose={close} /> : null}
    </>
  );
}

/** The current branch's steps and the asset's completeness entry. The Next card and the head share these cached queries. */
function useAssetSteps(assetId: string, view: AssetView, definitionProblem: "missing" | "invalid" | undefined) {
  const completeness = useOperation("project.completeness", {}, { enabled: view.enabled });
  // Next work is about the current branch, whichever branch is being viewed.
  const currentBranch = view.current?.branchId;
  const steps = useOperation("step.list", { assetId, ...(currentBranch ? { branchId: currentBranch } : {}) }, { enabled: view.enabled && view.loaded && definitionProblem === undefined });
  return {
    list: steps.data?.ok ? steps.data.data.steps : undefined,
    entry: completeness.data?.ok ? completeness.data.data.requiredAssets.find((item) => item.assetId === assetId) : undefined,
  };
}

/** "Next for <asset>": the one primary action. Promotion and activation open their own confirmation here. */
function NextCard({ assetId, name, view, definitionProblem }: { assetId: string; name: string; view: AssetView; definitionProblem: "missing" | "invalid" | undefined }) {
  const queue = useReviewQueue();
  const { list, entry } = useAssetSteps(assetId, view, definitionProblem);
  const versions = useOperation("version.list", { assetId }, { enabled: view.enabled && definitionProblem === undefined });
  const [promoting, setPromoting] = useState(false);
  const [activating, setActivating] = useState<AssetVersion | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const work: NextItem | undefined = definitionProblem
    ? {
      key: `${assetId}:definition`, rank: 0, unlocks: 0, stepIds: [], candidateIds: [], tone: "warn",
      title: definitionProblem === "missing" ? `${name} has no definition yet` : `${name}’s definition has problems`,
      reason: "Nothing can be generated until the definition is valid.", action: "Open definition", to: paths.assetDefinition(assetId),
    }
    : assetNext({ assetId, name, steps: list, queue: queue.items, ...(entry ? { completeness: entry } : {}) });
  // The same gate Releases offers: a promoted version newer than the active one.
  const saved = versions.data?.ok ? versions.data.data : undefined;
  const pending = saved ? newestPromoted(saved.versions, saved.active.versionId) : undefined;
  const active = saved ? activeOf(saved.versions, saved.active) : undefined;
  const next: NextItem | undefined = work ?? (pending ? {
    key: `${assetId}:activate`, rank: RANK.activate, unlocks: 0, stepIds: [], candidateIds: [],
    title: `Version ${pending.versionNumber} is promoted, not active`,
    reason: `${active ? `Version ${active.versionNumber} is the one in use.` : "No version is active yet."} Activating doesn’t change the game until you export.`,
    action: `Activate version ${pending.versionNumber}…`, to: paths.assetVersions(assetId, { version: pending.versionId }),
  } : undefined);
  const kind = next?.key.split(":")[1];
  const activateTarget = kind === "activate" ? pending : undefined;

  return (
    <aside className="nextcard" aria-label={`Next for ${name}`}>
      <div className="line">
        <p>{next?.title ?? (list ? "Nothing needs you right now" : "Looking at what’s next…")}</p>
        {!next || next.waiting ? null
          : activateTarget ? <button type="button" className="primary" onClick={() => setActivating(activateTarget)}>Activate version {activateTarget.versionNumber}…</button>
          : kind === "promote" ? <button type="button" className="primary" onClick={() => setPromoting(true)}>Promote…</button>
          : <Link className="button primary" to={next.to}>{next.action}<Icon name="arrow-right" size="sm" /></Link>}
      </div>
      {next?.reason ? <p className="reason">{next.reason}</p> : null}
      {done ? <p className="reason" role="status">{done}</p> : null}
      {promoting ? (
        <Modal wide open onOpenChange={(open) => { if (!open) setPromoting(false); }} title={`Promote ${name}`} description="See exactly what will be bundled first. Nothing is promoted until you start it, and promoting doesn’t activate or export.">
          <PromotePanel assetId={assetId} branchId={undefined} activeVersionId={saved?.active.versionId} showHeading={false} onActivate={(version) => { setPromoting(false); setActivating(version); }} />
        </Modal>
      ) : null}
      {activating && saved ? (
        <ActivateDialog
          key={activating.versionId} version={activating} restore={isRestore(activating, saved.versions, saved.active)} active={saved.active}
          open onOpenChange={(open) => { if (!open) setActivating(undefined); }} onDone={setDone}
        />
      ) : null}
    </aside>
  );
}

/** How far the asset is: one cell per required deliverable on the current branch. */
function AssetProgress({ assetId, view, definitionProblem }: { assetId: string; view: AssetView; definitionProblem: "missing" | "invalid" | undefined }) {
  const { list, entry } = useAssetSteps(assetId, view, definitionProblem);
  const sheet = list ? progress(list) : undefined;
  if (!sheet || sheet.total === 0) return null;
  return (
    <div className="progress">
      <MiniSheet cells={sheet.cells} label={`${sheet.approved} of ${sheet.total} required deliverables approved`} />
      <span>
        <strong>{sheet.approved} of {sheet.total}</strong> required approved
        {entry ? (entry.activeVersionNumber !== undefined ? ` · version ${entry.activeVersionNumber} active` : " · no active version yet") : ""}
      </span>
    </div>
  );
}

function Crumbs({ name }: { name: string }) {
  return <nav className="crumbs" aria-label="Breadcrumb"><Link to={paths.home()}>Home</Link><Icon name="chevron-right" size="sm" /><span aria-current="page">{name}</span></nav>;
}

export function AssetLayout() {
  const { assetId = "" } = useParams();
  const view = useAssetView(assetId);
  const families = useFamilies();
  const inspect = useOperation("asset.inspect", { assetId }, { enabled: view.enabled });

  if (!view.enabled) return <div className="page"><h1>Asset</h1><p>No project selected. <Link to={paths.openProject()}>Open a project</Link>.</p></div>;
  const g = gate(inspect, "Loading asset…");
  if ("node" in g) return <div className="page"><Crumbs name="Asset" />{g.node}</div>;

  const { summary } = g.data;
  const name = summary.name ?? summary.assetId;
  const definitionProblem = summary.valid ? undefined : isDefinitionMissing(summary.problems) ? "missing" : "invalid";
  const profile = families.profileOf(summary.family);
  const tab = (to: string) => view.branchParam ? `${to}${to.includes("?") ? "&" : "?"}branch=${encodeURIComponent(view.branchParam)}` : to;

  return (
    <div className="page">
      <Crumbs name={name} />
      <section className="asset-head">
        <div className="asset-id">
          <h1>{name}</h1>
          <div className="meta">
            {summary.family ? <><span>{profile?.label ?? summary.family}</span><span className="sep" /></> : null}
            <span>{summary.required ? "Required" : "Optional"}</span>
            {view.viewed ? <><span className="sep" /><BranchMenu assetId={assetId} view={view} /></> : view.loaded ? <><span className="sep" /><span className="faint">No concept locked yet</span></> : null}
          </div>
          <AssetProgress assetId={assetId} view={view} definitionProblem={definitionProblem} />
          {view.branchParam && view.current ? (
            <p className="viewing" role="status">
              <Icon name="eye" size="sm" />
              <span>Viewing “{view.viewed?.name}”, not the current branch.</span>
              <Link to={paths.asset(assetId)}>Back to “{view.current.name}”</Link>
            </p>
          ) : null}
        </div>
        <NextCard assetId={assetId} name={name} view={view} definitionProblem={definitionProblem} />
        <SubNav label={`${name} views`} items={[
          { to: tab(paths.asset(assetId)), label: "Sheet", end: true },
          { to: tab(paths.assetDefinition(assetId)), label: "Definition" },
          { to: tab(paths.assetVersions(assetId)), label: "Versions" },
        ]} />
      </section>
      <Outlet />
    </div>
  );
}
