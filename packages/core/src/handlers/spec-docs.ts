import { z } from "zod";
import { AssetSpec, ProjectSpec, StyleSpec } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import { classifyAuthoredPath, parseAuthored, readAuthoredFile } from "../authored.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";
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

  "spec.validate": async ({ input, project }) => {
    const open = requireOpen(project);
    const c = classifyAuthoredPath(input.path);
    if (!c) {
      throw new OperationFailure("INVALID_INPUT", `${input.path} is not an authored file location`, {
        allowed: ["brainforge/project.yaml", "brainforge/styles/<style-id>.yaml", "brainforge/assets/<asset-id>/asset.yaml"],
      });
    }
    const parsed = parseAuthored(c.kind, c.path, c.id, input.text);
    const current = await readAuthoredFile(open.root, c.path);
    return {
      data: { path: c.path, kind: c.kind, valid: parsed.valid, problems: parsed.problems, textHash: sha256(input.text), currentHash: current?.hash ?? null },
    };
  },
};
