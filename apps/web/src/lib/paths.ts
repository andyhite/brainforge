/** Every in-app URL is built here so navigation, Back and deep links agree on one shape. */

export interface StepLocation {
  /** Branch whose state the room shows; omit for the asset's current branch. */
  branch?: string;
  /** Candidate in focus; omit to let the room pick the one that needs you. */
  candidate?: string;
  /** Exact output in focus (approvals target outputs). */
  output?: string;
  /** Open side by side: the room starts comparing the first few candidates. */
  compare?: boolean;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

const seg = encodeURIComponent;

export const paths = {
  home: () => "/",
  openProject: () => "/projects/open",
  newAsset: () => "/assets/new",
  /** The asset sheet. `step` marks the cell to select (the one you came back from). */
  asset: (assetId: string, options: { branch?: string; step?: string } = {}) => `/assets/${seg(assetId)}${query({ branch: options.branch, step: options.step })}`,
  assetDefinition: (assetId: string, options: { section?: string } = {}) => `/assets/${seg(assetId)}/definition${query({ section: options.section })}`,
  assetVersions: (assetId: string, options: { version?: string } = {}) => `/assets/${seg(assetId)}/versions${query({ version: options.version })}`,
  /** One room per deliverable: review, compare, notes and generation for that step. */
  step: (assetId: string, stepId: string, location: StepLocation = {}) => `/assets/${seg(assetId)}/steps/${seg(stepId)}${query({ branch: location.branch, candidate: location.candidate, output: location.output, compare: location.compare ? "1" : undefined })}`,
  /** The room in queue mode: every candidate waiting for a decision, or only one asset's. Optionally opened on one candidate. */
  review: (options: { asset?: string; candidate?: string; output?: string } = {}) => `/review${query({ asset: options.asset, candidate: options.candidate, output: options.output })}`,
  releases: (options: { asset?: string } = {}) => `/releases${query({ asset: options.asset })}`,
  activity: (options: { view?: "jobs" | "decisions" | "preferences"; job?: string } = {}) => `/activity${query({ view: options.view, job: options.job })}`,
  settings: (section?: "connection" | "direction" | "agent") => (section ? `/settings/${section}` : "/settings"),
};
