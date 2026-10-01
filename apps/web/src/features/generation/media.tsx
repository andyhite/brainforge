import { useState } from "react";
import type { Candidate, CandidateOutput } from "@brainforge/contracts";

export type Backdrop = "checker" | "light" | "dark";
const BACKDROPS: Array<{ value: Backdrop; label: string }> = [
  { value: "checker", label: "Checkerboard" },
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
  return (
    <div role="group" aria-label="Preview background" className="viewer-tools" style={{ marginBottom: 0 }}>
      {BACKDROPS.map((item) => (
        <button key={item.value} type="button" aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{item.label}</button>
      ))}
    </div>
  );
}

export type OutputRole = CandidateOutput["role"];

/** Prefers the requested role, falling back to whichever output exists. */
export function pickOutput(candidate: Candidate, role: OutputRole): CandidateOutput | undefined {
  return candidate.outputs.find((output) => output.role === role) ?? candidate.outputs[0];
}

export function outputUrl(projectId: string, fileId: string, max?: number): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`;
  return max ? `${base}?max=${max}` : base;
}

export function RolePicker({ value, onChange }: { value: OutputRole; onChange: (next: OutputRole) => void }) {
  return (
    <div role="group" aria-label="Output shown" className="viewer-tools" style={{ marginBottom: 0 }}>
      <button type="button" aria-pressed={value === "matted"} onClick={() => onChange("matted")}>Matted (alpha)</button>
      <button type="button" aria-pressed={value === "untouched"} onClick={() => onChange("untouched")}>Untouched</button>
    </div>
  );
}
