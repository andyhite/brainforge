import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

export type Path = ReadonlyArray<string | number>;

/** Parses, applies `fn` to the document and returns the new text. Comments and unrelated formatting are preserved. */
export function mutate(text: string, fn: (doc: Document) => void): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return text;
  fn(doc);
  return String(doc);
}

export function parseDraft(text: string): { data: Record<string, unknown>; syntaxError: string | undefined } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { data: {}, syntaxError: doc.errors[0]?.message };
  const value: unknown = doc.toJS();
  return { data: typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}, syntaxError: undefined };
}

/** Dotted field name as the server reports it: `deliverables[0].environment.tileSize`. */
export function fieldName(path: Path): string {
  let out = "";
  for (const part of path) out += typeof part === "number" ? `[${part}]` : out === "" ? part : `.${part}`;
  return out;
}

/** Accepts `a.0.b` as well as `a[0].b`. */
export function normalizeField(field: string): string {
  return field.replace(/\.(\d+)(?=\.|$|\[)/g, "[$1]");
}

function isFlowable(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number");
}

/**
 * Sets `path` to `value`; `undefined` removes the key and prunes parent maps/lists the removal left empty
 * (never a deliverable itself or a top-level key).
 */
export function setAt(doc: Document, path: Path, value: unknown): void {
  if (value === undefined) {
    doc.deleteIn([...path]);
    for (let depth = path.length - 1; depth >= 1; depth -= 1) {
      const parentPath = path.slice(0, depth);
      if (parentPath[0] === "deliverables" && depth <= 2) break;
      const node = doc.getIn([...parentPath], true);
      if ((isMap(node) || isSeq(node)) && node.items.length === 0) doc.deleteIn([...parentPath]);
      else break;
    }
    return;
  }
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    const node = doc.createNode(value);
    if (isSeq(node) && isFlowable(value)) node.flow = true;
    doc.setIn([...path], node);
    return;
  }
  doc.setIn([...path], value);
}

/** Appends `value` to the sequence at `path` (creating it) and returns its index. */
export function pushAt(doc: Document, path: Path, value: unknown): number {
  const node = doc.getIn([...path], true);
  if (isSeq(node)) {
    node.add(doc.createNode(value));
    return node.items.length - 1;
  }
  doc.setIn([...path], doc.createNode([value]));
  return 0;
}

export function removeAt(doc: Document, path: Path): void {
  doc.deleteIn([...path]);
  const parentPath = path.slice(0, -1);
  const parent = doc.getIn([...parentPath], true);
  // An emptied list of a pruneable block disappears; the deliverables list keeps existing (an empty list is valid).
  if (isSeq(parent) && parent.items.length === 0 && parentPath.length > 1) doc.deleteIn([...parentPath]);
}

export function moveAt(doc: Document, listPath: Path, from: number, to: number): void {
  const list = doc.getIn([...listPath], true);
  if (!isSeq(list) || to < 0 || to >= list.items.length) return;
  const [item] = list.items.splice(from, 1);
  if (item !== undefined) list.items.splice(to, 0, item);
}

/** Replaces `from` by `to` in every `dependsOn`/reference of the deliverables (id renames keep their links). */
export function renameDeliverableRefs(doc: Document, from: string, to: string): void {
  const list = doc.getIn(["deliverables"], true);
  if (!isSeq(list)) return;
  list.items.forEach((item, index) => {
    const depends = doc.getIn(["deliverables", index, "dependsOn"], true);
    if (isSeq(depends)) depends.items.forEach((entry) => { if (isScalar(entry) && entry.value === from) entry.value = to; });
    for (const key of ["startReference", "endReference"]) {
      const ref = doc.getIn(["deliverables", index, "animation", key], true);
      if (isScalar(ref) && ref.value === from) ref.value = to;
    }
    const roles = doc.getIn(["deliverables", index, "referenceRoles"], true);
    if (isMap(roles)) {
      roles.items.forEach((pair) => {
        const binding = pair.value;
        if (isMap(binding) && binding.get("deliverableId") === from) binding.set("deliverableId", to);
      });
    }
  });
  const attachments = doc.getIn(["attachments"], true);
  if (isSeq(attachments)) {
    attachments.items.forEach((entry) => { if (isMap(entry) && entry.get("deliverable") === from) entry.set("deliverable", to); });
  }
}

export const PLACEHOLDER = "REPLACE:";
export const isPlaceholder = (value: unknown): boolean => typeof value === "string" && value.includes(PLACEHOLDER);
