import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ProjectEventsProvider, useLiveState, type LiveState } from "../api/events.tsx";
import { useMutationOperation, useOperation } from "../api/hooks.ts";
import { useJobAttention, useReviewQueue } from "../lib/attention.ts";
import { paths } from "../lib/paths.ts";
import { useProjectRoot } from "../lib/project-context.tsx";
import { useProject } from "../lib/use-project.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { JumpPalette } from "./JumpPalette.tsx";
import { MenuButton, type MenuEntry } from "./ui.tsx";

type Theme = "system" | "light" | "dark";
const THEME_STORAGE = "brainforge.appearance";
const THEMES: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: "system", label: "Match the system", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Only an unhealthy connection earns space in the top bar; "live" is the silent default. */
const LIVE_PROBLEM: Partial<Record<LiveState, string>> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting: this view may be out of date",
  resync: "Catching up with the server…",
};

function LiveStatus() {
  const text = LIVE_PROBLEM[useLiveState()];
  if (!text) return null;
  return <span className="live-status" role="status" aria-live="polite"><Icon name="refresh" size="sm" />{text}</span>;
}

function ActivityStatus({ current }: { current: boolean }) {
  const { running, attention } = useJobAttention();
  const label = attention.length > 0
    ? `${attention.length} ${attention.length === 1 ? "job needs" : "jobs need"} attention`
    : running.length > 0 ? `${running.length} generating` : "Activity";
  return (
    <Link className="activity-status" to={paths.activity()} aria-current={current ? "page" : undefined} title="Jobs, decisions and preferences">
      {attention.length > 0 ? <span className="dot" aria-hidden="true" /> : running.length > 0 ? <span className="dot running" aria-hidden="true" /> : <Icon name="activity" size="sm" />}
      <span className="label">{label}</span>
    </Link>
  );
}

function ProjectMenu() {
  const { root, select } = useProjectRoot();
  const project = useProject();
  const navigate = useNavigate();
  const recent = useOperation("project.recent", {}, { project: null });
  const summary = project.data?.project;
  const others = recent.data?.ok ? recent.data.data.projects.filter((item) => item.root !== root) : [];
  const items: MenuEntry[] = [];
  if (summary) items.push({ heading: summary.root }, { label: "Project settings", icon: "settings", to: paths.settings() }, "separator");
  if (others.length > 0) {
    items.push({ heading: "Switch project" });
    for (const item of others.slice(0, 6)) {
      items.push({ label: item.name ?? item.root.split("/").pop() ?? item.root, description: item.root, icon: "folder", onSelect: () => { select(item.root); navigate(paths.home()); } });
    }
    items.push("separator");
  }
  items.push({ label: "Open or create a project…", icon: "plus", to: paths.openProject() });
  const name = summary?.name ?? (root ? root.split("/").pop() : undefined) ?? "Open a project";
  return (
    <MenuButton
      className="project-menu" label={`Project: ${name}`} items={items}
      trigger={<><Icon name="sheet" className="mark" /><span className="name">{name}</span>{summary && !summary.writable ? <span className="status warn"><Icon name="lock" size="sm" />Read-only</span> : null}<Icon name="chevron-down" size="sm" className="chev" /></>}
    />
  );
}

function ThemeMenu({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const icon = THEMES.find((item) => item.value === theme)?.icon ?? "monitor";
  return (
    <MenuButton
      label="Appearance" align="end" triggerClassName="icon-button"
      trigger={<Icon name={icon} />}
      items={[{ heading: "Appearance" }, ...THEMES.map((item) => ({ label: item.label, checked: item.value === theme, onSelect: () => onChange(item.value) }))]}
    />
  );
}

export function Layout() {
  const project = useProject();
  const location = useLocation();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [jumpOpen, setJumpOpen] = useState(false);
  const queue = useReviewQueue();
  const summary = project.data?.project;
  const path = location.pathname;
  const room = path === "/review" || /^\/assets\/[^/]+\/steps\/[^/]+$/.test(path);
  const tab = path === "/review" ? "review" : path.startsWith("/releases") ? "releases" : path === "/" || path.startsWith("/assets") ? "home" : undefined;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_STORAGE, theme); } catch { /* The selected appearance still applies when storage is unavailable. */ }
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && summary) {
        event.preventDefault();
        setJumpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [summary]);

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
      <div className="shell">
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="topbar">
          <ProjectMenu />
          {summary ? (
            <nav className="tabs" aria-label="Primary">
              <Link to={paths.home()} aria-current={tab === "home" ? "page" : undefined}>Home</Link>
              <Link to={paths.review()} aria-current={tab === "review" ? "page" : undefined}>
                Review{queue.total > 0 ? <span className="count" aria-label={`${queue.total} waiting`}>{queue.total}</span> : null}
              </Link>
              <Link to={paths.releases()} aria-current={tab === "releases" ? "page" : undefined}>Releases</Link>
            </nav>
          ) : null}
          <div className="top-end">
            <LiveStatus />
            {summary ? <ActivityStatus current={path.startsWith("/activity")} /> : null}
            {summary ? (
              <button type="button" className="jump" onClick={() => setJumpOpen(true)} aria-keyshortcuts="Meta+K">
                <Icon name="search" size="sm" /><span className="jump-label">Jump to…</span><kbd>⌘K</kbd>
              </button>
            ) : null}
            <ThemeMenu theme={theme} onChange={setTheme} />
            <Link className="button icon-button" to={paths.settings()} aria-label="Settings" aria-current={path.startsWith("/settings") ? "page" : undefined}><Icon name="settings" /></Link>
          </div>
        </header>
        <main className={`main${room ? " is-room" : ""}`} id="main" tabIndex={-1}>
          <Outlet />
        </main>
        {summary ? <JumpPalette open={jumpOpen} onOpenChange={setJumpOpen} /> : null}
      </div>
    </ProjectEventsProvider>
  );
}
