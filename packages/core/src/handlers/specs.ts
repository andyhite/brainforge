import { randomBytes } from "node:crypto";
import { readFile, stat, realpath, rm } from "node:fs/promises";
import { basename } from "node:path";
import { decodeImage } from "@brainforge/media";
import { paths, resolveIn, sha256, writeFileAtomic } from "@brainforge/storage";
import { discoverAuthored, observeAuthored, readAuthoredFile, specInfo, writeAuthored } from "../authored.ts";
import { EffectiveLookupError, computeEffective } from "../effective.ts";
import { confirmedPreferences } from "../preferences/store.ts";
import { authorizePolicy, policyView } from "../policy.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { authoredPath } from "./common.ts";

const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;

function hasImageMagic(b: Uint8Array): boolean {
  const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP";
  return png || jpeg || webp;
}

function referenceSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "ref";
}

export const specHandlers: HandlerMap = {
  "spec.list": async ({ project: open }) => {
    const set = await discoverAuthored(open.root);
    observeAuthored(open, set.all());
    return { data: { files: set.all().map(specInfo) } };
  },

  "spec.read": async ({ input, project: open }) => {
    const c = authoredPath(input.path);
    const file = await readAuthoredFile(open.root, c.path);
    if (!file) throw new OperationFailure("NOT_FOUND", `${c.path} does not exist`, { path: c.path }, [{ label: "Create it with spec.write (expectedHash null)", operation: "spec.write" }]);
    observeAuthored(open, [file]);
    return { data: { path: file.path, kind: file.kind, text: file.text, hash: file.hash, problems: file.problems } };
  },

  "spec.write": async ({ input, project: open, context }) => {
    const result = await open.mutate(() => writeAuthored(open, { ...input, actorId: context.actorId }));
    const errors = result.problems.filter((p) => p.severity !== "warning").length;
    const advisories = result.problems.length - errors;
    return {
      data: result, revision: open.revision(),
      warnings: [
        ...(errors > 0 ? [`Saved with ${errors} problem(s); work that depends on this file is blocked until they are fixed.`] : []),
        ...(advisories > 0 ? [`${advisories} warning(s): unfinished or missing production fields (see problems); they block only the steps that need them.`] : []),
      ],
      nextActions: result.problems.length > 0 ? [{ label: "Review problems", operation: "spec.read", input: { path: result.path } }] : [],
    };
  },

  "settings.inspect": async ({ input, project: open }) => {
    const set = await discoverAuthored(open.root);
    observeAuthored(open, set.all());
    try {
      const { effective, conflicts } = computeEffective(set, { ...input, preferences: confirmedPreferences(open.db) });
      return { data: { effective, conflicts, policy: await policyView(open) } };
    } catch (e) {
      if (e instanceof EffectiveLookupError) {
        throw new OperationFailure(input.assetId === undefined ? "INVALID_INPUT" : "NOT_FOUND", e.message);
      }
      throw e;
    }
  },

  "policy.authorize": async ({ input, project: open, context }) => {
    const { view, revision } = await open.mutate(() => authorizePolicy(open, input.requestedPolicyHash, context.actorId));
    return { data: { policy: view }, revision };
  },

  "reference.list": async ({ input, project: open }) => {
    const rows = open.db
      .query<{ reference_id: string; scope: "project" | "asset"; asset_id: string | null; label: string; path: string; sha256: string; width: number | null; height: number | null; imported_by: string | null; created_at: string }, [string | null, string | null]>(
        "SELECT reference_id, scope, asset_id, label, path, sha256, width, height, imported_by, created_at FROM reference_records WHERE (?1 IS NULL OR scope = 'project' OR asset_id = ?2) ORDER BY created_at DESC, reference_id",
      )
      .all(input.assetId ?? null, input.assetId ?? null);
    return {
      data: {
        references: rows.map((r) => ({
          referenceId: r.reference_id, scope: r.scope, label: r.label, path: r.path, sha256: r.sha256, createdAt: r.created_at,
          ...(r.asset_id ? { assetId: r.asset_id } : {}), ...(r.width !== null ? { width: r.width } : {}), ...(r.height !== null ? { height: r.height } : {}), ...(r.imported_by ? { importedBy: r.imported_by } : {}),
        })),
      },
    };
  },

  "reference.import": async ({ input, project: open, context }) => {
    if (input.scope === "asset" && input.assetId) {
      const known = (await readAuthoredFile(open.root, paths.assetYaml(input.assetId))) ?? (await stat(await resolveIn(open.root, paths.asset(input.assetId))).then((s) => s.isDirectory(), () => false));
      if (!known) throw new OperationFailure("NOT_FOUND", `Asset ${input.assetId} does not exist`, { assetId: input.assetId });
    }

    let bytes: Uint8Array;
    let filename: string;
    if (input.sourcePath !== undefined) {
      const real = await realpath(input.sourcePath).catch(() => undefined);
      if (!real) throw new OperationFailure("NOT_FOUND", `Source file ${input.sourcePath} does not exist`);
      const info = await stat(real);
      if (!info.isFile()) throw new OperationFailure("INVALID_INPUT", `${input.sourcePath} is not a regular file`);
      if (info.size > MAX_REFERENCE_BYTES) throw new OperationFailure("INVALID_INPUT", `${input.sourcePath} exceeds the ${MAX_REFERENCE_BYTES}-byte reference limit`);
      bytes = await readFile(real);
      filename = input.filename ?? basename(input.sourcePath);
    } else {
      bytes = Buffer.from(input.contentBase64 ?? "", "base64");
      filename = input.filename ?? "";
    }
    if (/[\\/\0]/.test(filename) || filename === "." || filename === "..") throw new OperationFailure("INVALID_INPUT", `Unsafe file name ${JSON.stringify(filename)}`);
    if (!hasImageMagic(bytes)) throw new OperationFailure("INVALID_INPUT", "Reference must be a PNG, JPEG or WebP image (file signature not recognized)");
    let width: number;
    let height: number;
    try {
      ({ width, height } = await decodeImage(bytes, filename));
    } catch (e) {
      throw new OperationFailure("INVALID_INPUT", `Reference image could not be decoded: ${e instanceof Error ? e.message : String(e)}`);
    }

    const referenceId = `${referenceSlug(input.label)}-${randomBytes(3).toString("hex")}`;
    const rel = input.scope === "asset" && input.assetId ? paths.assetReference(input.assetId, referenceId, filename) : paths.projectReference(referenceId, filename);
    const hash = sha256(bytes);
    const abs = await resolveIn(open.root, rel);
    const data = { referenceId, scope: input.scope, assetId: input.assetId, path: rel, sha256: hash, label: input.label, width, height };

    const { revision } = await open.mutate(async () => {
      await writeFileAtomic(abs, bytes);
      try {
        return open.transact(() => {
          open.db.query("INSERT INTO reference_records (reference_id, scope, asset_id, label, path, sha256, width, height, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(referenceId, input.scope, input.assetId ?? null, input.label, rel, hash, width, height, context.actorId, new Date().toISOString());
        }, [{ type: "reference.imported", data, actorId: context.actorId }]);
      } catch (e) {
        await rm(abs, { force: true });
        throw e;
      }
    });
    return { data, revision };
  },
};
