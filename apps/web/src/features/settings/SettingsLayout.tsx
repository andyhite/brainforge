import { Outlet } from "react-router-dom";
import { PageHeader, SubNav } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import "./settings.css";

const SECTIONS = [
  { to: paths.settings(), label: "Project", end: true },
  { to: paths.settings("direction"), label: "Art direction" },
  { to: paths.settings("connection"), label: "Connection" },
  { to: paths.settings("agent"), label: "Agent setup" },
] as const;

export function SettingsLayout() {
  return (
    <div className="page settings">
      <PageHeader title="Settings" />
      <SubNav label="Settings sections" items={SECTIONS} />
      <div className="settings-body">
        <Outlet />
      </div>
    </div>
  );
}
