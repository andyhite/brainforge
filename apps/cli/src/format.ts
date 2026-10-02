import { styleText } from "node:util";

/** Human-readable rendering of CLI envelopes. Every field of the envelope survives; colour is cosmetic only. */

type Style = Parameters<typeof styleText>[0];
type Obj = Record<string, unknown>;

let color = false;
export function setColor(on: boolean): void {
  color = on;
}
const c = (style: Style, s: string): string => (color ? styleText(style, s) : s);
const dim = (s: string) => c("dim", s);

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isMultiline = (v: unknown): v is string => typeof v === "string" && /[\n\r]/.test(v);
function isLeaf(v: unknown): boolean {
  if (isMultiline(v)) return false;
  return typeof v !== "object" || v === null || (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
}

function scalar(v: unknown): string {
  if (Array.isArray(v)) return dim("[]");
  if (isObj(v)) return dim("{}");
  if (v === null || v === undefined) return dim(String(v));
  if (typeof v === "number") return c("yellow", String(v));
  if (typeof v === "boolean") return c("magenta", String(v));
  if (v === "") return dim('""');
  return String(v);
}


/** YAML-like tree: aligned cyan keys, bullets for list items, multi-line strings as a gutter block. */
export function tree(v: unknown, pad = ""): string[] {
  if (isMultiline(v)) return v.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => `${pad}${dim("│")} ${l}`);
  if (isLeaf(v)) return [`${pad}${scalar(v)}`];
  if (Array.isArray(v)) {
    return v.flatMap((item) => {
      if (isLeaf(item)) return [`${pad}${dim("•")} ${scalar(item)}`];
      const lines = tree(item, `${pad}  `);
      lines[0] = `${pad}${dim("•")} ${lines[0]!.slice(pad.length + 2)}`;
      return lines;
    });
  }
  const entries = Object.entries(v as Obj);
  const width = Math.max(0, ...entries.filter(([, x]) => isLeaf(x)).map(([k]) => k.length));
  return entries.flatMap(([k, x]) => {
    const key = c("cyan", `${k}:`);
    if (isLeaf(x)) return [`${pad}${key}${" ".repeat(width - k.length)} ${scalar(x)}`];
    return [`${pad}${key}`, ...tree(x, `${pad}  `)];
  });
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", c("bold", title), ...lines];
}

/** Actions render as their label plus, when runnable, a copy-pasteable command. */
function actions(title: string, list: unknown): string[] {
  if (!Array.isArray(list)) return list === undefined ? [] : section(title, tree(list, "  "));
  return section(title, list.flatMap((a) => {
    if (!isObj(a)) return [`  ${c("green", "→")} ${scalar(a)}`];
    const { label, operation, input, url, ...rest } = a;
    const lines = [`  ${c("green", "→")} ${label === undefined ? "" : String(label)}`];
    if (typeof operation === "string") {
      const arg = input === undefined ? "" : ` --input '${JSON.stringify(input)}'`;
      lines.push(`    ${dim(`$ brainforge ${operation}${arg}`)}`);
    } else if (input !== undefined) lines.push(...tree({ input }, "    "));
    if (url !== undefined) lines.push(`    ${c("underline", String(url))}`);
    if (Object.keys(rest).length > 0) lines.push(...tree(rest, "    "));
    return lines;
  }));
}

function visuals(list: unknown): string[] {
  if (!Array.isArray(list)) return list === undefined ? [] : section("Images", tree(list, "  "));
  return section("Images", list.flatMap((f) => {
    if (!isObj(f)) return tree([f], "  ");
    const { fileId, role, label, path, error, ...rest } = f;
    return [
      `  ${String(label ?? fileId)} ${dim(`${String(role ?? "")} ${String(fileId ?? "")}`.trim())}`,
      error !== undefined ? `    ${c("red", `✗ ${String(error)}`)}` : `    ${String(path)}`,
      ...(Object.keys(rest).length > 0 ? tree(rest, "    ") : []),
    ];
  }));
}

/** Renders an `OperationResult` envelope (plus CLI-added `visualFiles`); `body` overrides the default data tree. */
export function renderEnvelope(envelope: unknown, body?: (data: unknown) => string[]): string {
  if (!isObj(envelope)) return `${tree(envelope).join("\n")}\n`;
  const { ok, data, error, requestId, nextActions, warnings, visualFiles, revision, jobId, ...rest } = envelope;
  const lines: string[] = [];
  if (ok === false) {
    const e = isObj(error) ? error : {};
    const { code, message, details, recoveryActions, ...more } = e;
    lines.push(`${c(["bold", "red"], `✗ ${String(code ?? "ERROR")}`)} ${String(message ?? "")}`);
    const extra = { ...(details === undefined ? {} : isObj(details) ? details : { details }), ...more };
    if (Object.keys(extra).length > 0) lines.push(...section("Details", tree(extra, "  ")));
    lines.push(...actions("Try", recoveryActions));
  } else {
    const empty = data === undefined || (isObj(data) && Object.keys(data).length === 0);
    lines.push(...(empty ? [c("green", "✓ done")] : body ? body(data) : tree(data)));
  }
  const meta = { revision, jobId, ...rest };
  const metaLines = Object.entries(meta).filter(([, v]) => v !== undefined);
  if (metaLines.length > 0) lines.push("", ...tree(Object.fromEntries(metaLines)));
  if (Array.isArray(warnings)) lines.push(...section("Warnings", warnings.flatMap((w) => (typeof w === "string" ? [`  ${c("yellow", "⚠")} ${w}`] : tree([w], "  ")))));
  lines.push(...visuals(visualFiles));
  lines.push(...actions("Next", nextActions));
  if (requestId !== undefined && requestId !== "") lines.push("", dim(`requestId ${String(requestId)}`));
  return `${lines.join("\n")}\n`;
}

const table = (rows: [string, string][], pad = "  "): string[] => {
  const width = Math.max(0, ...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${pad}${c("cyan", k.padEnd(width))}  ${v}`);
};

function badges(flags: Obj): string {
  const out = [];
  if (flags.mutating === true) out.push(c("yellow", "mutating"));
  if (flags.humanOnly === true) out.push(c("red", "human-only"));
  return out.length === 0 ? "" : ` ${dim("[")}${out.join(dim(", "))}${dim("]")}`;
}


/** Operations grouped by namespace, one line each (full summary via `<op> --help`). */
function operationLines(list: unknown): string[] {
  const ops = (Array.isArray(list) ? list : []).filter(isObj);
  const width = Math.max(0, ...ops.map((o) => String(o.name).length));
  const groups = new Map<string, Obj[]>();
  for (const op of ops) {
    const ns = String(op.name).split(".")[0]!;
    groups.set(ns, [...(groups.get(ns) ?? []), op]);
  }
  return [...groups].flatMap(([ns, members], i) => [
    ...(i === 0 ? [] : [""]),
    `  ${c("bold", ns)}`,
    ...members.map((op) => `    ${c("cyan", String(op.name).padEnd(width))}  ${String(op.summary ?? "").match(/^.*?[.!?](?=\s|$)/)?.[0] ?? String(op.summary ?? "")}${badges(op)}`),
  ]);
}

/** Top-level `--help`: usage, every operation, options. */
export function renderHelp(data: unknown): string[] {
  if (!isObj(data)) return tree(data);
  const rows = (v: unknown) => (isObj(v) ? table(Object.entries(v).map(([k, x]) => [k, String(x)])) : tree(v, "  "));
  return [
    `${c("bold", "Usage:")} ${String(data.usage)}`,
    "",
    String(data.summary),
    ...section(`Operations ${dim("(details and input schema: brainforge <operation> --help)")}`, operationLines(data.operations)),
    ...section("Options", rows(data.options)),
    ...section("Environment", rows(data.environment)),
    ...section("Examples", Array.isArray(data.examples) ? data.examples.map((e) => `  ${dim("$")} ${String(e)}`) : []),
  ];
}

function schemaType(s: unknown): string {
  if (!isObj(s)) return "any";
  if (Array.isArray(s.enum)) return s.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) return union.map(schemaType).join(" | ");
  if (s.type === "array") return `${schemaType(s.items)}[]`;
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return typeof s.type === "string" ? s.type : "any";
}

/** Property table for an object JSON Schema, recursing into nested object properties. */
function schemaProps(s: Obj, pad: string): string[] {
  const props = isObj(s.properties) ? Object.entries(s.properties) : [];
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const width = Math.max(0, ...props.map(([k]) => k.length));
  return props.flatMap(([k, p]) => {
    const prop = isObj(p) ? p : {};
    const req = required.has(k);
    const parts = [c(req ? ["bold", "cyan"] : "cyan", k.padEnd(width)), c("magenta", schemaType(prop))];
    if (req) parts.push(c("yellow", "required"));
    if (prop.default !== undefined) parts.push(dim(`= ${JSON.stringify(prop.default)}`));
    if (typeof prop.description === "string") parts.push(dim(prop.description));
    const nested = prop.type === "object" ? prop : prop.type === "array" && isObj(prop.items) && prop.items.type === "object" ? prop.items : undefined;
    return [`${pad}${parts.join("  ")}`, ...(nested ? schemaProps(nested, `${pad}  `) : [])];
  });
}

/** `<op> --help`: summary, flags, and the input schema as a property table. */
export function renderOperationHelp(data: unknown): string[] {
  if (!isObj(data)) return tree(data);
  const { name, summary, needsProjectNote, inputSchema, ...flags } = data;
  const tags = [flags.mutating === true ? c("yellow", "mutating") : dim("read-only")];
  if (flags.humanOnly === true) tags.push(c("red", "human-only"));
  if (flags.needsProject === true) tags.push(dim("needs project"));
  const schema = isObj(inputSchema) ? inputSchema : {};
  const input = isObj(schema.properties)
    ? (Object.keys(schema.properties).length === 0 ? [`  ${dim("(no input)")}`] : schemaProps(schema, "  "))
    : tree(inputSchema, "  ");
  return [
    `${c(["bold", "cyan"], String(name))}  ${tags.join(dim(" · "))}`,
    "",
    String(summary),
    ...(flags.needsProject === true ? ["", dim(`Note: ${String(needsProjectNote)}`)] : []),
    ...section("Input", input),
  ];
}
