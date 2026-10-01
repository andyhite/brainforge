import type { AssetSpec, Deliverable, Problem } from "@brainforge/contracts";
import { profileFor } from "./profiles.ts";

export const PLACEHOLDER = "REPLACE:";
const MAX_PIXELS = 8192;

export type Locate = (path: readonly (string | number)[]) => { line: number; column: number } | undefined;

/** Value of a dotted path into any value, or undefined. */
function valueAt(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const key of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

/** Required fields (per the family profile) that the deliverable lacks. `animation.loop` must be written, not defaulted. */
export function missingFields(spec: AssetSpec, d: Deliverable, rawDeliverable?: unknown): string[] {
  const required = profileFor(spec.family).requiredFields[d.kind] ?? [];
  return required.filter((path) => {
    if (path === "animation.loop") return rawDeliverable !== undefined && valueAt(rawDeliverable, path) === undefined;
    const v = valueAt(d, path);
    return v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "string" && v.trim() === "");
  });
}

/** Step-level blockers for one deliverable: required production fields the family needs. Never blocks other steps or the concept. */
export function deliverableProblems(spec: AssetSpec, d: Deliverable): string[] {
  // Sheets without regions and animations without motion text already have their own specific step messages.
  return missingFields(spec, d).filter((f) => f !== "regions" && f !== "animation.motion").map((f) => `${spec.family} ${d.kind} "${d.id}" needs ${f}.`);
}

function placeholders(value: unknown, path: string, out: { path: string }[]): void {
  if (typeof value === "string") {
    if (value.includes(PLACEHOLDER)) out.push({ path });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => placeholders(v, `${path}[${i}]`, out));
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) placeholders(v, path ? `${path}.${k}` : k, out);
  }
}

/** Placeholders still in a spec, as field paths. */
export function findPlaceholders(spec: AssetSpec): string[] {
  const found: { path: string }[] = [];
  placeholders(spec, "", found);
  return found.map((f) => f.path);
}

/**
 * Family rules for a parsed asset: errors make the file invalid (wrong kind for the family, misplaced collection or
 * attachments, impossible sizes), warnings are reported without blocking (missing production fields, unfinished
 * `REPLACE:` placeholders). Every problem names its field.
 */
export function validateFamily(file: string, spec: AssetSpec, raw: unknown, locate: Locate): Problem[] {
  const profile = profileFor(spec.family);
  const out: Problem[] = [];
  const at = (path: readonly (string | number)[], field: string, message: string, severity?: "warning"): void => {
    out.push({ file, ...locate(path), field, message, ...(severity ? { severity } : {}) });
  };

  if (spec.collection && profile.collection !== "container" && profile.collection !== "either") {
    at(["collection"], "collection", `Only environment assets form collections; a ${spec.family} is ${profile.collection === "member" ? "a member of one (the environment lists it), not a container" : "never part of one"}.`);
  }
  if (spec.collection) {
    const seen: string[] = [];
    spec.collection.members.forEach((m, i) => {
      if (m.assetId === spec.id) at(["collection", "members", i, "assetId"], `collection.members[${i}].assetId`, `An environment cannot list itself as a member ("${m.assetId}").`);
      else if (seen.includes(m.assetId)) at(["collection", "members", i, "assetId"], `collection.members[${i}].assetId`, `Member "${m.assetId}" is listed more than once.`);
      seen.push(m.assetId);
    });
  }

  if (spec.attachments.length > 0 && spec.family !== "equipment" && spec.family !== "prop") {
    at(["attachments"], "attachments", `Attachment points are only for equipment and props, not ${spec.family} assets.`);
  }
  const ids = spec.deliverables.map((d) => d.id);
  spec.attachments.forEach((a, i) => {
    if (a.deliverable !== undefined && !ids.includes(a.deliverable)) at(["attachments", i, "deliverable"], `attachments[${i}].deliverable`, `Attachment "${a.name}" names deliverable "${a.deliverable}", which this asset does not define.`);
  });

  const rawList: unknown = valueAt(raw, "deliverables");
  const rawDeliverables: unknown[] = Array.isArray(rawList) ? rawList : [];
  spec.deliverables.forEach((d, i) => {
    const base = `deliverables[${i}]`;
    if (!profile.allowedKinds.includes(d.kind)) {
      const motionless = d.kind === "animation" && profile.motion === "none";
      at(["deliverables", i, "kind"], `${base}.kind`, motionless
        ? `A ${spec.family} is static and declares no animation deliverables; "${d.id}" cannot be an animation.`
        : `Deliverable kind "${d.kind}" is not allowed for a ${spec.family}; allowed: ${profile.allowedKinds.join(", ")}.`);
    }
    if (d.animation && profile.motion === "none") at(["deliverables", i, "animation"], `${base}.animation`, `A ${spec.family} is static; remove the animation block from "${d.id}".`);

    for (const path of missingFields(spec, d, rawDeliverables[i])) {
      at(["deliverables", i, ...path.split(".")], `${base}.${path}`, `${spec.family} ${d.kind} "${d.id}" needs ${path} before it can be produced.`, "warning");
    }

    const out_ = d.output;
    if (out_) {
      if ((out_.width === undefined) !== (out_.height === undefined)) at(["deliverables", i, "output"], `${base}.output`, "output needs both width and height, or neither.");
      for (const axis of ["width", "height"] as const) {
        const v = out_[axis];
        if (v !== undefined && v > MAX_PIXELS) at(["deliverables", i, "output", axis], `${base}.output.${axis}`, `output.${axis} ${v} is above the supported ${MAX_PIXELS} pixels.`);
      }
    }
    const slice = d.ui?.nineSlice;
    if (slice && out_?.width !== undefined && slice.left + slice.right >= out_.width) {
      at(["deliverables", i, "ui", "nineSlice"], `${base}.ui.nineSlice`, `Nine-slice left (${slice.left}) + right (${slice.right}) must leave a stretchable centre inside output.width ${out_.width}.`);
    }
    if (slice && out_?.height !== undefined && slice.top + slice.bottom >= out_.height) {
      at(["deliverables", i, "ui", "nineSlice"], `${base}.ui.nineSlice`, `Nine-slice top (${slice.top}) + bottom (${slice.bottom}) must leave a stretchable centre inside output.height ${out_.height}.`);
    }

    const env = d.environment;
    if (env?.seamlessAxes && env.connections) {
      const axes: readonly string[] = env.seamlessAxes;
      const { west, east, north, south } = env.connections;
      if (axes.includes("x") && west !== east) at(["deliverables", i, "environment", "connections"], `${base}.environment.connections`, `A tile that is seamless on x repeats onto itself, so its west (${west ?? "unset"}) and east (${east ?? "unset"}) connection labels must match.`);
      if (axes.includes("y") && north !== south) at(["deliverables", i, "environment", "connections"], `${base}.environment.connections`, `A tile that is seamless on y repeats onto itself, so its north (${north ?? "unset"}) and south (${south ?? "unset"}) connection labels must match.`);
    }
  });

  const found: { path: string }[] = [];
  placeholders(spec, "", found);
  for (const { path } of found) at(path.split(/[.[\]]+/).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s)), path, `Unfinished placeholder: replace the "${PLACEHOLDER}" text in ${path} before generating.`, "warning");
  return out;
}
