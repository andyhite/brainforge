import { NavLink, Outlet } from "react-router-dom";
import { PageHeader } from "../../components/ui.tsx";

export function SettingsLayout() {
  return (
    <div>
      <PageHeader title="Settings" />
      <nav className="tabs-nav" aria-label="Settings sections">
        <NavLink to="/settings" end>Project</NavLink>
        <NavLink to="/settings/connection">Connection</NavLink>
        <NavLink to="/settings/direction">Direction &amp; defaults</NavLink>
        <NavLink to="/settings/agent">Agent setup</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
