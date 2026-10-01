import { NavLink, Outlet } from "react-router-dom";
import { PageHeader } from "../../components/ui.tsx";
import { usePendingAuthorizationCount } from "./agents/usePending.ts";

export function SettingsLayout() {
  const pending = usePendingAuthorizationCount();
  return (
    <div>
      <PageHeader title="Settings" />
      <nav className="tabs-nav" aria-label="Settings sections">
        <NavLink to="/settings" end>Project</NavLink>
        <NavLink to="/settings/connection">Connection</NavLink>
        <NavLink to="/settings/direction">Direction &amp; defaults</NavLink>
        <NavLink to="/settings/agents">
          Agents &amp; access{pending > 0 ? <span className="badge" style={{ marginLeft: 8 }} aria-label={`${pending} pending requests`}>{pending}</span> : null}
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
