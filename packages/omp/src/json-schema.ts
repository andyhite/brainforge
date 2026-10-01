import type { z } from "zod";

/** The zod-compatible builder surface (pi.zod in omp, real zod in unit tests). */
export type ZodBuilder = typeof z;
type Schema = z.ZodType;

interface Node {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  enum?: unknown;
  const?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  $ref?: unknown;
  description?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Converts the registry's JSON Schema into a schema built only with the host builder.
 * Unrepresentable parts degrade to `unknown()`; the server remains final authority.
 */
export function jsonSchemaToZod(zod: ZodBuilder, root: unknown): Schema {
  const convert = (node: unknown, depth: number): Schema => {
    if (!isNode(node) || depth > 24) return zod.unknown();
    let built: Schema;
    try {
      built = build(node, depth);
    } catch {
      built = zod.unknown();
    }
    return typeof node.description === "string" ? built.describe(node.description) : built;
  };

  const resolveRef = (ref: string): unknown => {
    if (!ref.startsWith("#/")) return undefined;
    let current: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      if (!isNode(current)) return undefined;
      current = Reflect.get(current, part.replaceAll("~1", "/").replaceAll("~0", "~"));
    }
    return current;
  };

  const build = (node: Node, depth: number): Schema => {
    if (typeof node.$ref === "string") return convert(resolveRef(node.$ref), depth + 1);
    if ("const" in node) {
      const value = node.const;
      if (value === null) return zod.null();
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return zod.literal(value);
      return zod.unknown();
    }
    if (Array.isArray(node.enum)) {
      const values: unknown[] = node.enum;
      if (values.length > 0 && values.every((v): v is string => typeof v === "string")) {
        const [first, ...rest] = values;
        return zod.enum([first as string, ...(rest as string[])]);
      }
      return zod.unknown();
    }
    const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
    if (union) {
      const members = union.map((member) => convert(member, depth + 1));
      if (members.length === 0) return zod.unknown();
      if (members.length === 1) return members[0]!;
      return zod.union([members[0]!, members[1]!, ...members.slice(2)]);
    }
    switch (node.type) {
      case "string": {
        let s = zod.string();
        const min = num(node.minLength);
        const max = num(node.maxLength);
        if (min !== undefined) s = s.min(min);
        if (max !== undefined) s = s.max(max);
        if (typeof node.pattern === "string") s = s.regex(new RegExp(node.pattern));
        return s;
      }
      case "integer":
      case "number": {
        let n = node.type === "integer" ? zod.number().int() : zod.number();
        const min = num(node.minimum);
        const max = num(node.maximum);
        if (min !== undefined) n = n.min(min);
        if (max !== undefined) n = n.max(max);
        return n;
      }
      case "boolean":
        return zod.boolean();
      case "null":
        return zod.null();
      case "array": {
        let a = zod.array(convert(node.items, depth + 1));
        const min = num(node.minItems);
        const max = num(node.maxItems);
        if (min !== undefined) a = a.min(min);
        if (max !== undefined) a = a.max(max);
        return a;
      }
      case "object": {
        if (isNode(node.properties)) {
          const required = new Set(Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === "string") : []);
          const shape: Record<string, Schema> = {};
          for (const [key, child] of Object.entries(node.properties)) {
            const converted = convert(child, depth + 1);
            shape[key] = required.has(key) ? converted : converted.optional();
          }
          return zod.object(shape);
        }
        if (isNode(node.additionalProperties)) return zod.record(zod.string(), convert(node.additionalProperties, depth + 1));
        return zod.record(zod.string(), zod.unknown());
      }
      default:
        return zod.unknown();
    }
  };

  return convert(root, 0);
}
