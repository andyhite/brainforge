import { useMemo } from "react";
import type { AssetFamily, FamilyProfile } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";

/** The built-in family catalog (family.list needs no project). */
export function useFamilies(): { profiles: FamilyProfile[]; profileOf: (family: string | undefined) => FamilyProfile | undefined; loading: boolean; error: string | undefined } {
  const query = useOperation("family.list", {}, { project: null });
  return useMemo(() => {
    const profiles = query.data?.ok ? query.data.data.families : [];
    return {
      profiles,
      profileOf: (family: string | undefined) => profiles.find((profile) => profile.family === family),
      loading: query.isPending,
      error: query.error ? query.error.message : query.data && !query.data.ok ? query.data.error.message : undefined,
    };
  }, [query.data, query.error, query.isPending]);
}

export const ALPHA_TEXT: Record<FamilyProfile["alpha"], string> = {
  matte: "Transparent cut-out (background removed)",
  opaque: "Opaque full frame",
  "per-deliverable": "Transparent or opaque per deliverable",
};
export const ALPHA_SHORT: Record<FamilyProfile["alpha"], string> = { matte: "Transparent cut-out", opaque: "Opaque frame", "per-deliverable": "Alpha per deliverable" };
export const MOTION_TEXT: Record<FamilyProfile["motion"], string> = {
  typical: "Motion is typical",
  optional: "Optional animation",
  none: "Static — no motion",
};

/** Short family-aware hint shown next to the family label in lists. */
export function familyHint(profile: FamilyProfile | undefined): string {
  if (!profile) return "";
  return `${ALPHA_TEXT[profile.alpha]} · ${MOTION_TEXT[profile.motion]}`;
}

export function FamilyChip({ family, profile }: { family: AssetFamily | string | undefined; profile?: FamilyProfile | undefined }) {
  if (!family) return <span className="secondary">—</span>;
  return <span className="chip family-chip" title={profile ? `${profile.summary}\n${familyHint(profile)}` : undefined}>{profile?.label ?? family}</span>;
}

/** Warnings (REPLACE: placeholders, missing production fields) never make a file invalid; only errors count. */
export function splitProblems<T extends { severity?: "error" | "warning" | undefined }>(problems: T[]): { errors: T[]; warnings: T[] } {
  return { errors: problems.filter((p) => p.severity !== "warning"), warnings: problems.filter((p) => p.severity === "warning") };
}
