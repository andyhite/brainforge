import "./home.css";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { Job, NextAction, OperationData } from "@brainforge/contracts";
import { callOperation, runRecoveryOperation } from "../../api/client.ts";
import { useOperation } from "../../api/hooks.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { OutputArt } from "../../components/OutputArt.tsx";
import { Art, Banner, EmptyState, ErrorBanner, MiniSheet, NetworkProblem, NextActions, Status, timeAgo, type CellState } from "../../components/ui.tsx";
import { useReviewQueue, useJobAttention } from "../../lib/attention.ts";
import { assetNext, RANK, type NextItem } from "../../lib/next.ts";
import { paths } from "../../lib/paths.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { specRoute, useProject, type InspectData } from "../../lib/use-project.ts";
import { OpenProjectPage } from "../projects/OpenProjectPage.tsx";
import { useCurrentExport } from "../production/state.tsx";
import { AssetCard, useConceptArt, type CardAsset } from "./AssetCards.tsx";

type Report = OperationData<"project.completeness">;
type RequiredAsset = Report["requiredAssets"][number];
type Filter = "all" | "needs" | "progress" | "game";

/** One thing the user could do next, from any source. */
interface HomeItem {
  key: string;
  rank: number;
  unlocks: number;
  title: string;
  reason: string;
  action: string;
  to: string;
  candidateIds: string[];
  /** Show the newest concepts of this asset as thumbnails (lock a concept). */
  conceptsOf?: string;
  /** Show this asset's concept as the thumbnail. */
  artOf?: string;
  tone?: "warn" | "bad" | undefined;
  icon?: IconName;
  waiting?: boolean | undefined;
  /** Failed downloads the server lets us collect again; the button runs exactly these actions. */
  retry?: Job[];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const SHOWN = 5;

const STAGE_TITLE: Record<NonNullable<Job["error"]>["stage"], string> = {
  upload: "couldn’t start", submit: "couldn’t start", execute: "didn’t finish", download: "didn’t download", publish: "couldn’t be saved",
};
const STAGE_REASON: Record<NonNullable<Job["error"]>["stage"], string> = {
  upload: "A reference image couldn’t be sent to ComfyUI.",
  submit: "ComfyUI rejected the request.",
  execute: "ComfyUI stopped before it finished.",
  download: "ComfyUI finished them but the files arrived incomplete.",
  publish: "The result came back but couldn’t be saved into the project.",
};

function collectAction(job: Job) {
  return job.availableActions.find((action) => action.operation === "job.retry" && (action.input as { mode?: string } | undefined)?.mode === "collect");
}

/** Failed jobs grouped by asset + step: one item per problem, with the retry when every job offers it. */
function jobItems(jobs: Job[], names: Map<string, string>): HomeItem[] {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) groups.set(`${job.assetId}:${job.stepId}`, [...(groups.get(`${job.assetId}:${job.stepId}`) ?? []), job]);
  return [...groups.entries()].map(([key, group]) => {
    const first = group[0]!;
    const stage = first.error?.stage;
    const asset = names.get(first.assetId) ?? first.assetId;
    const subject = first.stepId === "concept" ? `${plural(group.length, `${asset} concept`)}` : `${asset} ${first.stepId}`;
    const retryable = group.every((job) => collectAction(job) !== undefined);
    return {
      key: `jobs:${key}`, rank: RANK.recover, unlocks: 0,
      title: `${subject} ${stage ? STAGE_TITLE[stage] : "need a look"}`,
      reason: retryable ? `${stage ? STAGE_REASON[stage] : ""} Retrying fetches the same results; no new generation.` : stage ? STAGE_REASON[stage] : "Brainforge couldn’t confirm whether ComfyUI finished this one.",
      action: "See what failed", to: paths.activity({ job: first.jobId }), candidateIds: [],
      tone: retryable ? "warn" : "bad", icon: retryable ? "refresh" : "alert",
      ...(retryable ? { retry: group } : {}),
    } satisfies HomeItem;
  });
}

function RetryDownloads({ jobs, primary }: { jobs: Job[]; primary: boolean }) {
  const { root } = useProjectRoot();
  const queryClient = useQueryClient();
  const [done, setDone] = useState<number | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const run = async () => {
    setFailure(undefined);
    try {
      for (const [index, job] of jobs.entries()) {
        setDone(index);
        const action = collectAction(job);
        if (!action?.operation) continue;
        const result = await runRecoveryOperation(action.operation, root, action.input);
        if (!result.ok) { setFailure(result.error.message); return; }
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Request failed");
    } finally {
      setDone(undefined);
      void queryClient.invalidateQueries({ queryKey: ["op"] });
    }
  };
  return (
    <>
      <button type="button" className={primary ? "primary lg" : ""} onClick={() => void run()} disabled={done !== undefined}>
        {done === undefined ? "Retry downloads" : `Retrying ${done + 1} of ${jobs.length}…`}
      </button>
      {failure ? <span role="alert" className="status bad"><Icon name="bad" /><span>{failure}</span></span> : null}
    </>
  );
}

function LockThumbs({ assetId }: { assetId: string }) {
  const list = useOperation("candidate.list", { assetId, stepId: "concept", limit: 3 });
  const candidates = list.data?.ok ? list.data.data.candidates : [];
  return <>{candidates.map((candidate) => <OutputArt key={candidate.candidateId} candidateId={candidate.candidateId} alt={`${candidate.label}`} max={128} />)}</>;
}

function AssetThumb({ assetId, glyph }: { assetId: string; glyph: ReactNode }) {
  const { candidate, loading } = useConceptArt(assetId);
  if (candidate) return <OutputArt candidateId={candidate.candidateId} {...(candidate.outputId ? { outputId: candidate.outputId } : {})} alt="" max={128} />;
  return loading ? <Art /> : <>{glyph}</>;
}

function Thumbs({ item, lead }: { item: HomeItem; lead: boolean }) {
  const glyph = <span className={`glyph${item.tone ? ` ${item.tone}` : ""}`}><Icon name={item.icon ?? "layers"} {...lead ? { size: "lg" as const } : {}} /></span>;
  return (
    <div className="thumbs">
      {item.candidateIds.length > 0
        ? item.candidateIds.slice(0, 3).map((id) => <OutputArt key={id} candidateId={id} alt="" max={128} />)
        : item.conceptsOf ? <LockThumbs assetId={item.conceptsOf} />
        : item.artOf ? <AssetThumb assetId={item.artOf} glyph={glyph} />
        : glyph}
    </div>
  );
}

function Row({ item, lead }: { item: HomeItem; lead: boolean }) {
  const size = lead ? " lg" : "";
  return (
    <li className={lead ? "lead" : undefined}>
      <Thumbs item={item} lead={lead} />
      <div>
        <div className="what">{item.title}</div>
        <div className="why">{item.reason}</div>
      </div>
      <div className="do">
        {item.waiting ? <Status tone="info">In progress</Status>
          : item.retry ? <RetryDownloads jobs={item.retry} primary={lead} />
          : <Link className={`button${lead ? ` primary${size}` : ""}`} to={item.to}>{item.action}{lead ? <Icon name="arrow-right" size="sm" /> : null}</Link>}
      </div>
    </li>
  );
}

function fromNext(next: NextItem, optional: boolean, assetId: string): HomeItem {
  const kind = next.key.split(":")[1];
  // ponytail: optional assets rank 25 lower (after redo, before generate); the game doesn't wait on them. Upgrade: weight by unlocks.
  return {
    key: next.key, rank: optional && next.rank >= RANK.lock && next.rank < RANK.wait ? next.rank + 25 : next.rank, unlocks: next.unlocks,
    title: next.title, reason: next.reason, action: next.action, to: next.to, candidateIds: next.candidateIds, tone: next.tone, waiting: next.waiting,
    // Failures and definition problems keep their glyph; everything else shows whose work it is.
    ...(kind === "lock" ? { conceptsOf: assetId } : kind === "definition" || next.tone === "bad" ? {} : { artOf: assetId }),
  };
}

function tagFor(next: NextItem | undefined): CardAsset["tag"] {
  if (!next || next.waiting) return undefined;
  const kind = next.key.split(":")[1];
  switch (kind) {
    case "review": return { text: `${next.candidateIds.length} for you` };
    case "lock": return { text: "Lock a concept" };
    case "definition": return { text: "Needs a definition", tone: "warn" };
    case "failed": return { text: "Failed", tone: "bad" };
    case "redo": case "obsolete": return { text: "Out of date", tone: "warn" };
    case "finish": return { text: "Finish a deliverable" };
    case "generate": return { text: "Ready to generate" };
    case "promote": return { text: "Ready to promote" };
    case "activate": return { text: "Ready to activate" };
    default: return undefined;
  }
}

function exportWords(report: Report): ReactNode {
  const { status, committedAt } = report.export;
  const text = status === "out-of-date" ? "Last export is out of date" : status === "not-exported" ? "Not exported yet" : status === "failed" ? "Last export failed" : status === "in-progress" ? "Export in progress" : `Exported ${timeAgo(committedAt)}`;
  return <Link to={paths.releases()}>{text}</Link>;
}

function cellFor(asset: RequiredAsset, waiting: Set<string>): CellState {
  if (asset.state === "complete") return "done";
  if (waiting.has(asset.assetId)) return "wait";
  if (["no-definition", "invalid-definition", "obsolete-version", "needs-reassessment", "open-feedback"].includes(asset.state)) return "block";
  return "todo";
}

const SPEC_FILE = /^brainforge\/assets\/[^/]+\/asset\.yaml$/;

function ProjectHome({ data, nextActions }: { data: InspectData; nextActions: NextAction[] }) {
  const { root } = useProjectRoot();
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState(false);
  const report = useOperation("project.completeness", {});
  const queue = useReviewQueue();
  const jobs = useJobAttention();
  const settings = useOperation("settings.inspect", {});
  const summary = data.project;
  const completeness = report.data?.ok ? report.data.data : undefined;
  const exported = useCurrentExport();

  const cards: CardAsset[] = data.assets.map((asset) => ({ ...asset, completeness: completeness?.requiredAssets.find((item) => item.assetId === asset.assetId), exportedVersionId: exported.exportedVersionId(asset.assetId) }));
  // Required assets whose folder doesn't exist yet still need a card to author them.
  for (const required of completeness?.requiredAssets ?? []) {
    if (!cards.some((card) => card.assetId === required.assetId)) cards.push({ assetId: required.assetId, name: required.name, required: true, valid: false, problems: [], completeness: required });
  }
  const names = new Map(cards.map((card) => [card.assetId, card.name ?? card.assetId]));

  const stepQueries = useQueries({
    queries: cards.map((card) => ({
      queryKey: ["op", "step.list", root ?? null, { assetId: card.assetId }],
      queryFn: ({ signal }: { signal: AbortSignal }) => callOperation("step.list", { project: root, input: { assetId: card.assetId }, signal }),
      enabled: card.valid && root !== undefined,
      retry: false,
    })),
  });

  const jobGroups = jobItems(jobs.attention, names);
  const jobAssets = new Set(jobs.attention.map((job) => job.assetId));
  const nextByAsset = new Map<string, NextItem>();
  const items: HomeItem[] = [...jobGroups];
  cards.forEach((card, index) => {
    const envelope = stepQueries[index]?.data;
    const next = assetNext({ assetId: card.assetId, name: names.get(card.assetId)!, steps: envelope?.ok ? envelope.data.steps : undefined, queue: queue.items, completeness: card.completeness });
    if (!next) return;
    nextByAsset.set(card.assetId, next);
    // The job item carries the retry; never show the same failure twice.
    if (next.rank === RANK.recover && jobAssets.has(card.assetId)) return;
    items.push(fromNext(next, !card.required, card.assetId));
  });

  const badSpec = data.specs.find((spec) => !spec.valid && !SPEC_FILE.test(spec.path));
  const specFile = badSpec?.path ?? summary.problems[0]?.file ?? (summary.specValid ? undefined : "brainforge/project.yaml");
  if (specFile) {
    const count = badSpec?.problems.length ?? summary.problems.length;
    items.push({ key: "spec", rank: RANK.definition, unlocks: 0, title: "Your project files have problems", reason: `${specFile}${count > 0 ? ` has ${plural(count, "problem")}` : " is invalid"}. Nothing can be generated until they’re fixed.`, action: "Fix project files", to: specRoute(specFile), candidateIds: [], tone: "warn", icon: "alert" });
  }
  const policy = settings.data?.ok ? settings.data.data.policy : undefined;
  if (policy && policy.diff.length > 0) {
    items.push({ key: "policy", rank: RANK.definition + 1, unlocks: 0, title: "Confirm the approval policy", reason: policy.pendingRelaxation ? "The requested approval policy is more permissive than the confirmed one." : "The requested approval policy differs from the confirmed one.", action: "Review policy", to: paths.settings("direction"), candidateIds: [], tone: "warn", icon: "lock" });
  }
  if (completeness && (completeness.export.status === "out-of-date" || completeness.export.status === "failed")) {
    items.push({ key: "export", rank: 70, unlocks: 0, title: completeness.export.status === "failed" ? "The last export failed" : "The last export is out of date", reason: completeness.export.detail, action: "Open releases", to: paths.releases(), candidateIds: [], tone: completeness.export.status === "failed" ? "bad" : "warn", icon: "package" });
  }
  items.sort((a, b) => a.rank - b.rank || b.unlocks - a.unlocks);

  const loadingNext = !queue.loaded || !jobs.loaded || !completeness || stepQueries.some((query) => query.isLoading);
  const visible = expanded ? items : items.slice(0, SHOWN);

  const waiting = new Set(queue.items.map((item) => item.candidate.assetId));
  const required = completeness?.requiredAssets ?? [];
  const inGame = (card: CardAsset) => card.exportedVersionId !== undefined;
  const needsYou = (card: CardAsset) => {
    const next = nextByAsset.get(card.assetId);
    return jobAssets.has(card.assetId) || (next !== undefined && !next.waiting);
  };
  const filters: Array<{ value: Filter; label: string; match: (card: CardAsset) => boolean }> = [
    { value: "all", label: "All", match: () => true },
    { value: "needs", label: "Needs you", match: needsYou },
    { value: "progress", label: "In progress", match: (card) => !inGame(card) },
    { value: "game", label: "In the game", match: inGame },
  ];
  const param = params.get("filter");
  const filter = filters.find((item) => item.value === param) ?? filters[0]!;
  const choose = (value: Filter) => setParams((previous) => { const next = new URLSearchParams(previous); if (value === "all") next.delete("filter"); else next.set("filter", value); return next; }, { replace: true });
  const shown = cards.filter(filter.match).map((card) => {
    const failed = jobs.attention.filter((job) => job.assetId === card.assetId);
    // Same tone as the Up next row: amber when every failure can be collected again, red otherwise.
    const tone = failed.every((job) => collectAction(job) !== undefined) ? "warn" as const : "bad" as const;
    const tag = failed.length > 0 ? { text: `${failed.length} failed`, tone } : tagFor(nextByAsset.get(card.assetId));
    return { ...card, tag };
  });

  return (
    <div className="page home">
      <section className="home-head">
        <div>
          <h1>{summary.name}</h1>
          <div className="sum">
            {completeness ? (
              <>
                {required.length > 0 ? <MiniSheet large cells={required.map((asset) => cellFor(asset, waiting))} label={`${completeness.counts.complete} of ${completeness.counts.required} required assets done`} /> : null}
                <span>{required.length === 0 ? "No required assets declared" : <><strong>{completeness.counts.complete} of {completeness.counts.required}</strong> required assets are done</>}</span>
                <span className="faint">·</span>
                <span>{exportWords(completeness)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="actions">
          <Link className="button" to={paths.newAsset()}><Icon name="plus" size="sm" />New asset</Link>
        </div>
      </section>

      {summary.state === "closing" ? <Banner tone="warn" title="Closing — background work continues, not yet safe to move">The directory is still in use until tracked work finishes.</Banner> : null}
      {!summary.writable ? <Banner tone="warn" title="Read-only">This project can’t be changed (for example a newer schema). See Settings → Project.</Banner> : null}
      {report.error ? <NetworkProblem error={report.error} /> : report.data && !report.data.ok ? <ErrorBanner error={report.data.error} extra={<button type="button" onClick={() => void report.refetch()}>Retry</button>} /> : null}

      <section className="home-next" aria-labelledby="next-title">
        <div className="section-head"><h2 id="next-title">Up next</h2><span className="aside">Ordered by what unblocks the most work</span></div>
        {items.length > 0 ? (
          <ul className="rows">
            {visible.map((item, index) => <Row key={item.key} item={item} lead={index === 0} />)}
            {items.length > SHOWN ? (
              <li className="more"><button type="button" className="link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show ${items.length - SHOWN} more`}</button></li>
            ) : null}
          </ul>
        ) : (
          <div className="rows"><p className="home-calm" role="status">{loadingNext ? "Checking what needs you…" : "Nothing needs you right now."}</p></div>
        )}
        {loadingNext && items.length > 0 ? <p className="sr-only" role="status">Still checking for more…</p> : null}
        <NextActions actions={nextActions} />
      </section>

      <section aria-labelledby="assets-title">
        <div className="section-head">
          <h2 id="assets-title">Assets</h2>
          <div className="asset-filters" role="group" aria-label="Filter assets">
            {filters.map((item) => (
              <button key={item.value} type="button" className="chip" aria-pressed={filter.value === item.value} onClick={() => choose(item.value)}>
                {item.label} <span className="n">{cards.filter(item.match).length}</span>
              </button>
            ))}
          </div>
        </div>
        {cards.length === 0 ? (
          <EmptyState title="No assets yet">
            <p>Assets are the characters, icons and UI pieces your game needs. Start with the first one.</p>
            <Link className="button" to={paths.newAsset()}>New asset</Link>
          </EmptyState>
        ) : shown.length === 0 ? <p className="home-none">Nothing here right now.</p> : (
          <ul className="asset-grid">{shown.map((card) => <AssetCard key={card.assetId} asset={card} />)}</ul>
        )}
      </section>
    </div>
  );
}

export function HomePage() {
  const project = useProject();
  if (!project.root) return <OpenProjectPage />;
  if (project.networkError) return <div className="page"><NetworkProblem error={project.networkError} /></div>;
  if (project.loading) return <div className="page"><p className="home-none" role="status">Loading project…</p></div>;
  if (project.envelope && !project.envelope.ok) {
    return (
      <div className="page narrow">
        <h1>Can’t open this project</h1>
        <ErrorBanner error={project.envelope.error} />
        <p className="mono home-none">{project.root}</p>
        <Link className="button primary" to={paths.openProject()}>Open or start a project</Link>
      </div>
    );
  }
  return project.data ? <ProjectHome data={project.data} nextActions={project.envelope?.ok ? project.envelope.nextActions : []} /> : null;
}
