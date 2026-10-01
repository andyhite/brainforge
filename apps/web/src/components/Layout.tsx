import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ProjectEventsProvider, useLiveState, type LiveState } from "../api/events.tsx";
import { useMutationOperation, useOperation } from "../api/hooks.ts";
import { useProjectRoot } from "../lib/project-context.tsx";
import { useProject } from "../lib/use-project.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Status, type Tone } from "./ui.tsx";

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Workbench", icon: "workbench" },
  { to: "/review", label: "Review", icon: "review" },
  { to: "/library", label: "Releases", icon: "releases" },
  { to: "/jobs", label: "Activity", icon: "activity" },
];

type Theme = "system" | "light" | "dark";

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem("brainforge.appearance");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

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
    <div className="project-switcher">
      <label htmlFor="project-switcher" className="sr-only">Project</label>
      <select
        id="project-switcher"
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
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const location = useLocation();
  const summary = project.data?.project;
  const path = location.pathname;
  const workspace = /^\/assets\/[^/]+(?:\/candidates\/[^/]+)?$/.test(path) && path !== "/assets/new";
  const section = path === "/review" || path.includes("/candidates/")
    ? "/review"
    : path === "/library" || path === "/export"
      ? "/library"
      : path === "/jobs" || path === "/history"
        ? "/jobs"
        : path.startsWith("/settings") || path === "/projects/open" ? "/settings" : "/";
  const sections = section === "/library"
    ? [{ to: "/library", label: "Production versions" }, { to: "/export", label: "Export" }]
    : section === "/jobs"
      ? [{ to: "/jobs", label: "Jobs" }, { to: "/history", label: "History & preferences" }]
      : section === "/" && !workspace
        ? [{ to: "/", label: "Project readiness" }, { to: "/assets", label: "All assets" }]
        : [];

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("brainforge.appearance", theme); } catch { /* The selected appearance still applies when storage is unavailable. */ }
  }, [theme]);
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
      <div className={`shell${workspace ? " workspace-shell" : ""}`}>
        <a className="skip-link" href="#main">Skip to workspace</a>
        <header className="topbar">
          <Link className="brand" to="/" aria-label="Brainforge workbench">
            <span className="brand-symbol"><Icon name="workbench" /></span>
            Brainforge
          </Link>
          <ProjectSwitcher />
          {summary && summary.state !== "open" ? <Status tone="warn">{summary.state === "closing" ? "Closing" : "Closed"}</Status> : null}
          {summary && !summary.writable ? <Status tone="warn">Read-only</Status> : null}
          <span className="spacer" />
          <LiveIndicator />
          <div className="appearance-control">
            <label htmlFor="appearance">Appearance</label>
            <select id="appearance" value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <details className="project-details">
            <summary>Project details</summary>
            <div className="project-details-body">
              <h2>{summary?.name ?? "No project open"}</h2>
              {summary ? (
                <dl className="kv">
                  <dt>Directory</dt><dd className="mono">{summary.root}</dd>
                  <dt>ID</dt><dd className="mono">{summary.projectId}</dd>
                  <dt>Revision</dt><dd>{summary.revision}</dd>
                  <dt>State</dt><dd>{summary.state}</dd>
                  <dt>Writable</dt><dd>{summary.writable ? "Yes" : "No — read-only"}</dd>
                </dl>
              ) : <p className="secondary">Open a game directory to begin.</p>}
              <Link to="/settings">Project settings</Link>
            </div>
          </details>
        </header>
        <div className="navigation-bar">
          <nav className="nav" aria-label="Primary">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} aria-current={section === item.to ? "page" : undefined}>
                <Icon name={item.icon} />
                {item.label}
              </Link>
            ))}
          </nav>
          <Link className="settings-link" to="/settings" aria-current={section === "/settings" ? "page" : undefined}>
            <Icon name="settings" /><span>Settings</span>
          </Link>
        </div>
        {sections.length > 0 ? (
          <nav className="section-nav" aria-label={`${NAV.find((item) => item.to === section)?.label ?? "Project"} views`}>
            {sections.map((item) => <NavLink key={item.to} to={item.to} end={item.to === "/"}>{item.label}</NavLink>)}
          </nav>
        ) : null}
        <main className={`main${workspace ? " is-workspace" : ""}`} id="main" tabIndex={-1}>
          <div className="main-inner"><Outlet /></div>
        </main>
      </div>
    </ProjectEventsProvider>
  );
}
