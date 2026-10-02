import { useQueries } from "@tanstack/react-query";
import { useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { callOperation } from "../api/client.ts";
import { useOperation } from "../api/hooks.ts";
import { paths } from "../lib/paths.ts";
import { useProjectRoot } from "../lib/project-context.tsx";
import { kindLabel, STEP_STATE_TEXT } from "../lib/steps.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { useModalDialog } from "./ui.tsx";

interface Entry { key: string; group: "Assets" | "Deliverables"; title: string; sub: string; icon: IconName; to: string; haystack: string }

/** ⌘K: jump to any asset or any deliverable by name. Replaces a permanently visible asset tree. */
export function JumpPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { root } = useProjectRoot();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const close = () => { onOpenChange(false); setText(""); };
  const dialog = useModalDialog(open, close);
  const [active, setActive] = useState(0);
  const assets = useOperation("asset.list", {}, { enabled: open && root !== undefined });
  const list = assets.data?.ok ? assets.data.data.assets : [];
  // Same query key shape as useOperation, so the sheet and the palette share one cache entry per asset.
  const steps = useQueries({
    queries: list.map((asset) => ({
      queryKey: ["op", "step.list", root ?? null, { assetId: asset.assetId }],
      queryFn: ({ signal }: { signal: AbortSignal }) => callOperation("step.list", { project: root, input: { assetId: asset.assetId }, signal }),
      enabled: open,
      retry: false,
    })),
  });

  const entries = useMemo(() => {
    const out: Entry[] = [];
    list.forEach((asset, index) => {
      const name = asset.name ?? asset.assetId;
      const family = asset.family ? kindLabel(asset.family) : "Asset";
      out.push({ key: `a:${asset.assetId}`, group: "Assets", title: name, sub: family, icon: "sheet", to: paths.asset(asset.assetId), haystack: `${name} ${asset.assetId} ${family}`.toLowerCase() });
      const result = steps[index]?.data;
      if (!result?.ok) return;
      for (const step of result.data.steps) {
        out.push({
          key: `s:${asset.assetId}:${step.stepId}`, group: "Deliverables", title: step.stepId, sub: `${name} · ${kindLabel(step.kind)} · ${STEP_STATE_TEXT[step.state]}`,
          icon: step.kind === "animation" ? "film" : step.kind === "concept" ? "spark" : "image", to: paths.step(asset.assetId, step.stepId),
          haystack: `${step.stepId} ${name} ${asset.assetId} ${step.kind} ${STEP_STATE_TEXT[step.state]}`.toLowerCase(),
        });
      }
    });
    return out;
  }, [list, steps]);

  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  // Every token must match somewhere; names that start with or contain the tokens rank first.
  const score = (entry: Entry) => tokens.reduce((sum, token) => sum + (entry.title.toLowerCase().startsWith(token) ? 3 : entry.title.toLowerCase().includes(token) ? 2 : 0), 0);
  const found = tokens.length === 0 ? entries.filter((entry) => entry.group === "Assets") : entries.filter((entry) => tokens.every((token) => entry.haystack.includes(token)));
  const matches = (tokens.length === 0 ? found : [...found].sort((a, b) => score(b) - score(a) || (a.group === b.group ? 0 : a.group === "Assets" ? -1 : 1))).slice(0, 60);

  const current = Math.min(active, Math.max(0, matches.length - 1));

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    close();
    navigate(entry.to);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + matches.length) % Math.max(1, matches.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(matches[current]);
    } else if (event.key === "Escape") {
      // type=search would spend the first Escape clearing the text; the palette closes at once, as it always did.
      event.preventDefault();
      close();
    }
  };
  return (
    <dialog {...dialog} className="dialog palette" aria-label="Jump to an asset or deliverable">
      <div className="palette-body">
          <Icon name="search" className="search-icon" />
          <input
            type="search" autoFocus value={text} placeholder="Jump to an asset or deliverable…" aria-label="Search assets and deliverables"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={matches[current] ? `palette-${matches[current].key}` : undefined}
            onChange={(event) => { setText(event.target.value); setActive(0); }} onKeyDown={onKey}
          />
          {matches.length === 0 ? (
            <p className="palette-empty">{assets.isPending ? "Loading assets…" : text ? `Nothing matches “${text}”.` : "This project has no assets yet."}</p>
          ) : (
            <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results">
              {matches.map((entry, index) => (
                <li key={entry.key} role="presentation">
                  {index === 0 || matches[index - 1]?.group !== entry.group ? <div className="palette-group" role="presentation">{entry.group}</div> : null}
                  <a
                    id={`palette-${entry.key}`} role="option" aria-selected={index === current} className="palette-item" href={entry.to}
                    onMouseMove={() => setActive(index)} onClick={(event) => { event.preventDefault(); go(entry); }}
                  >
                    <span className="glyph"><Icon name={entry.icon} /></span>
                    <span className="title">{entry.title}</span>
                    <span className="sub">{entry.sub}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="palette-foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>
          </div>
      </div>
    </dialog>
  );
}
