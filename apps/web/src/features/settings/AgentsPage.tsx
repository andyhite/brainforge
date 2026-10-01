import { PageHeader } from "../../components/ui.tsx";
import { AuthorizationInbox } from "./agents/AuthorizationInbox.tsx";
import { TokensPanel } from "./agents/TokensPanel.tsx";

export function AgentsPage() {
  return (
    <div className="stack">
      <PageHeader title="Agents" />
      <AuthorizationInbox />
      <TokensPanel />
    </div>
  );
}
