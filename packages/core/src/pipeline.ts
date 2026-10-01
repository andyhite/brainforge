import type { AssetSpec, Deliverable } from "@brainforge/contracts";

export interface PipelineNode {
  /** `concept` or a deliverable id. */
  id: string;
  kind: string;
  required: boolean;
  /** Declared `dependsOn` only; nothing is imposed by family. */
  dependsOn: string[];
  /** Structural faults of THIS step (duplicate id, unknown dependency, cycle, reserved name). They block this step and nothing else. */
  problems: string[];
  /** The authored deliverable; absent for the concept node. */
  deliverable?: Deliverable;
}

export interface PipelinePlan {
  /** Concept first, then deliverables in dependency order (authored order breaks ties). */
  nodes: PipelineNode[];
  byId: ReadonlyMap<string, PipelineNode>;
  /** Asset-level notes about ignored deliverables (a deliverable named `concept`). Not tied to a step. */
  reserved: string[];
}

/** Ids of the deliverables reachable from `id` through `dependsOn`, excluding `id` itself unless it is on a cycle. */
function reachable(id: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(id) ?? [])];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return seen;
}

/**
 * The step graph of one asset: the concept step plus one node per authored deliverable, joined by the declared
 * `dependsOn` edges and nothing else. A static prop that authors only a still yields concept → still; no sheet,
 * animation or reference step appears unless the asset asks for it. Faults are recorded on the nodes they affect.
 */
export function buildPipeline(spec: AssetSpec | undefined): PipelinePlan {
  const concept: PipelineNode = { id: "concept", kind: "concept", required: true, dependsOn: [], problems: [] };
  const authored = spec?.deliverables ?? [];

  const nodes = new Map<string, PipelineNode>();
  const reserved: string[] = [];
  for (const d of authored) {
    if (d.id === "concept") {
      reserved.push('A deliverable named "concept" is ignored: that id belongs to the concept step. Rename it.');
      continue;
    }
    const existing = nodes.get(d.id);
    if (existing) {
      existing.problems.push(`Deliverable id "${d.id}" is defined more than once; ids must be unique.`);
      continue;
    }
    const problems: string[] = [];
    if (d.kind === "reference-sheet" && (d.regions?.length ?? 0) === 0) {
      problems.push(`Reference sheet "${d.id}" needs at least one region (id, x, y, width, height in source pixels).`);
    }
    if (d.kind !== "reference-sheet" && d.regions !== undefined) {
      problems.push(`Only reference-sheet deliverables take regions; "${d.id}" is ${d.kind}.`);
    }
    nodes.set(d.id, { id: d.id, kind: d.kind, required: d.required, dependsOn: [...new Set(d.dependsOn)], problems, deliverable: d });
  }
  for (const node of nodes.values()) {
    for (const dep of node.dependsOn) {
      if (dep === "concept") node.problems.push('"concept" is not a deliverable; every deliverable already builds on the locked concept, so remove it from dependsOn.');
      else if (!nodes.has(dep)) node.problems.push(`dependsOn names "${dep}", which is not a deliverable of this asset.`);
    }
  }

  const edges = new Map([...nodes].map(([id, n]) => [id, n.dependsOn.filter((dep) => nodes.has(dep))]));
  for (const node of nodes.values()) {
    const downstream = reachable(node.id, edges);
    if (!downstream.has(node.id)) continue;
    const cycle = [...downstream].filter((other) => reachable(other, edges).has(node.id));
    node.problems.push(`Dependency cycle: ${[node.id, ...cycle.filter((c) => c !== node.id), node.id].join(" → ")}.`);
  }

  // Kahn's algorithm, stable on authored order; cyclic nodes follow in authored order.
  const ordered: PipelineNode[] = [];
  const placed = new Set<string>();
  for (let progress = true; progress;) {
    progress = false;
    for (const node of nodes.values()) {
      if (placed.has(node.id) || !(edges.get(node.id) ?? []).every((dep) => placed.has(dep))) continue;
      placed.add(node.id);
      ordered.push(node);
      progress = true;
    }
  }
  for (const node of nodes.values()) if (!placed.has(node.id)) ordered.push(node);

  const all = [concept, ...ordered];
  return { nodes: all, byId: new Map(all.map((n) => [n.id, n])), reserved };
}
