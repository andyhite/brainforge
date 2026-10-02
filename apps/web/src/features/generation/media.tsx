import { useState } from "react";
import type { Candidate, CandidateOutput } from "@brainforge/contracts";
import { Seg } from "../../components/ui.tsx";


export type Backdrop = "checker" | "light" | "dark";
const BACKDROPS: Array<{ value: Backdrop; label: string }> = [
  { value: "checker", label: "Checker" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const STORAGE_KEY = "bf:backdrop";

export function useBackdrop(): [Backdrop, (next: Backdrop) => void] {
  const [value, setValue] = useState<Backdrop>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "checker" ? stored : "checker";
  });
  return [value, (next) => { localStorage.setItem(STORAGE_KEY, next); setValue(next); }];
}

/** Transparency must stay visible: the choice is explicit and never composited into the file. */
export function BackdropPicker({ value, onChange }: { value: Backdrop; onChange: (next: Backdrop) => void }) {
  return <Seg label="Preview background" value={value} options={BACKDROPS} onChange={onChange} />;
}

export type OutputRole = CandidateOutput["role"];

/** Prefers the requested role, falling back to whichever output exists. */
export function pickOutput(candidate: Candidate, role: OutputRole): CandidateOutput | undefined {
  return candidate.outputs.find((output) => output.role === role) ?? candidate.outputs[0];
}
