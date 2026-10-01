import { NavLink, Outlet } from "react-router-dom";
import { PageHeader } from "../../components/ui.tsx";
import "./settings.css";

export function SettingsLayout() {
  return (
    <div className="settings-page">
      <PageHeader title="Settings" />
      <div className="settings-split">
        <nav className="settings-nav" aria-label="Settings sections">
          <NavLink to="/settings" end>Project</NavLink>
          <NavLink to="/settings/connection">ComfyUI connection</NavLink>
          <NavLink to="/settings/direction">Direction &amp; policy</NavLink>
          <NavLink to="/settings/agent">Agent setup</NavLink>
        </nav>
        <div className="settings-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
