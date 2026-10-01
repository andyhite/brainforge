import { parseDocument, type Document } from "yaml";

export type FieldPath = readonly string[];

/** Plain JS value at `path` (undefined when absent). */
export function readField(doc: Document, path: FieldPath): unknown {
  const node = doc.getIn([...path], true);
  if (node === undefined || node === null) return undefined;
  if (typeof node === "object" && "toJS" in node && typeof node.toJS === "function") return node.toJS(doc);
  return node;
}

export function readString(doc: Document, path: FieldPath): string {
  const value = readField(doc, path);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

export function readStringList(doc: Document, path: FieldPath): string[] {
  const value = readField(doc, path);
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Returns the full new text with `path` set to `value`, or removed when `value` is undefined.
 * Parsing and re-stringifying the document preserves comments and unrelated formatting.
 */
export function writeField(text: string, path: FieldPath, value: string | number | boolean | string[] | undefined): string {
  const doc = parseDocument(text);
  if (value === undefined) doc.deleteIn([...path]);
  else if (Array.isArray(value)) doc.setIn([...path], doc.createNode(value));
  else doc.setIn([...path], value);
  return String(doc);
}

/** Splits comma/newline separated text into trimmed, non-empty items. */
export function splitList(text: string): string[] {
  return text.split(/[\n,]/).map((item) => item.trim()).filter((item) => item !== "");
}
