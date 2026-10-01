import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ProjectEventsProvider, useLiveState, type LiveState } from "../api/events.tsx";
import { useMutationOperation, useOperation } from "../api/hooks.ts";
import { useProjectRoot } from "../lib/project-context.tsx";
import { useProject } from "../lib/use-project.ts";
import { Banner, Status, type Tone } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/assets", label: "Assets", end: false },
  { to: "/jobs", label: "Jobs", end: false },
  { to: "/review", label: "Review", end: false },
  { to: "/library", label: "Library", end: false },
  { to: "/settings", label: "Settings", end: false },
];

const LIVE_LABEL: Record<LiveState, { tone: Tone; text: string } | undefined> = {
  idle: undefined,
  connecting: { tone: "info", text: "Connecting to live updates…" },
  live: { tone: "ok", text: "Live" },
  reconnecting: { tone: "warn", text: "Reconnecting — view may be stale" },
  resync: { tone: "info", text: "Resyncing from the server" },
};

function LiveIndicator() {
  const state = useLiveState();
  const label = LIVE_LABEL[state];
  if (!label) return null;
  return <span role="status" aria-live="polite"><Status tone={label.tone}>{label.text}</Status></span>;
}

function ProjectSwitcher() {
  const { root, select } = useProjectRoot();
  const navigate = useNavigate();
  const recent = useOperation("project.recent", {}, { project: null });
  const roots = new Set<string>();
  if (root) roots.add(root);
  if (recent.data?.ok) for (const item of recent.data.data.projects) roots.add(item.root);
  const names = new Map<string, string>();
  if (recent.data?.ok) for (const item of recent.data.data.projects) if (item.name) names.set(item.root, item.name);
  return (
    <div className="row" style={{ gap: 8 }}>
      <label htmlFor="project-switcher" className="sr-only">Project</label>
      <select
        id="project-switcher"
        style={{ width: "min(360px, 60vw)" }}
        value={root ?? ""}
        onChange={(event) => {
          if (event.target.value === "__open__") navigate("/projects/open");
          else select(event.target.value || undefined);
        }}
      >
        {root ? null : <option value="">No project selected</option>}
        {[...roots].map((item) => <option key={item} value={item}>{names.get(item) ? `${names.get(item)} — ${item}` : item}</option>)}
        <option value="__open__">Open another directory…</option>
      </select>
    </div>
  );
}

export function Layout() {
  const project = useProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const summary = project.data?.project;
  const reopen = useMutationOperation("project.open");
  const notOpen = project.envelope?.ok === false && project.envelope.error.code === "PROJECT_NOT_OPEN";
  const reopenedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    // The backend forgets open projects when it restarts; re-opening the user's explicitly selected directory is safe.
    if (!notOpen || !project.root || reopenedFor.current === project.root) return;
    reopenedFor.current = project.root;
    void reopen.mutateAsync({ input: { path: project.root }, project: null }).catch(() => undefined);
  }, [notOpen, project.root, reopen]);

  return (
    <ProjectEventsProvider projectId={summary?.projectId}>
      <div className={`shell${inspectorOpen ? " with-inspector" : ""}`}>
        <header className="topbar">
          <button type="button" className="menu-toggle" aria-expanded={menuOpen} aria-controls="primary-nav" onClick={() => setMenuOpen((open) => !open)}>
            Menu
          </button>
          <span className="brand">Brainforge</span>
          <ProjectSwitcher />
          {summary ? (
            <Status tone={summary.state === "open" ? "ok" : "warn"}>
              {summary.state === "open" ? "Open" : summary.state === "closing" ? "Closing" : "Closed"}
            </Status>
          ) : null}
          <span className="spacer" />
          <LiveIndicator />
          <button type="button" aria-expanded={inspectorOpen} aria-controls="inspector" onClick={() => setInspectorOpen((open) => !open)}>
            {inspectorOpen ? "Hide inspector" : "Inspector"}
          </button>
        </header>
        <nav id="primary-nav" className={`nav${menuOpen ? " open" : ""}`} aria-label="Primary">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="main" id="main" tabIndex={-1}>
          <div className="main-inner">
            <Outlet />
          </div>
        </main>
        {inspectorOpen ? (
          <aside id="inspector" className="inspector" aria-label="Inspector">
            <h2>Project</h2>
            {summary ? (
              <dl className="kv">
                <dt>Directory</dt><dd className="mono">{summary.root}</dd>
                <dt>Name</dt><dd>{summary.name}</dd>
                <dt>ID</dt><dd className="mono">{summary.projectId}</dd>
                <dt>Revision</dt><dd>{summary.revision}</dd>
                <dt>State</dt><dd>{summary.state}</dd>
                <dt>Writable</dt><dd>{summary.writable ? "yes" : "no — read-only"}</dd>
              </dl>
            ) : <p className="secondary">No project open.</p>}
            <button type="button" onClick={() => setInspectorOpen(false)} style={{ marginTop: 16 }}>Close inspector</button>
          </aside>
        ) : null}
      </div>
    </ProjectEventsProvider>
  );
}
