import { z } from "zod";
import { AssetSpec, ProjectSpec, StyleSpec } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import { parseAuthored, readAuthoredFile } from "../authored.ts";
import type { HandlerMap } from "../runtime.ts";
import { authoredPath } from "./common.ts";
import { SPEC_EXAMPLES } from "./spec-examples.ts";

const SCHEMAS = { project: ProjectSpec, style: StyleSpec, asset: AssetSpec } as const;

/** Read-only, side-effect-free documentation and dry-run validation of authored files. */
export const specDocHandlers: HandlerMap = {
  "spec.schema": async ({ input }) => {
    const ex = SPEC_EXAMPLES[input.kind];
    return {
      data: {
        kind: input.kind,
        pathPattern: ex.pathPattern,
        jsonSchema: z.toJSONSchema(SCHEMAS[input.kind], { io: "input", unrepresentable: "any" }),
        minimalExample: ex.minimal,
        fullExample: ex.full,
        conventions: [...ex.conventions],
      },
    };
  },

  "spec.validate": async ({ input, project: open }) => {
    const c = authoredPath(input.path);
    const parsed = parseAuthored(c.kind, c.path, c.id, input.text);
    const current = await readAuthoredFile(open.root, c.path);
    return {
      data: { path: c.path, kind: c.kind, valid: parsed.valid, problems: parsed.problems, textHash: sha256(input.text), currentHash: current?.hash ?? null },
    };
  },
};
