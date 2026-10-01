import { PageHeader } from "../../components/ui.tsx";

export function AgentSetupPage() {
  return (
    <div className="stack">
      <PageHeader title="Agent setup" />
      <section className="panel stack" aria-labelledby="mcp-title">
        <h2 id="mcp-title">Connect an MCP client</h2>
        <p>Agents use the Brainforge MCP server (stdio). Run this command from the game directory so it can find <code>brainforge/project.yaml</code>:</p>
        <pre><code>bun &lt;path to brainforge checkout&gt;/apps/mcp/src/main.ts</code></pre>
        <p>
          It talks to this server at <code>BF_SERVER_URL</code>, which defaults to <code>http://127.0.0.1:3210</code>.
        </p>
        <p>
          The <code>brainforge</code> skill lives in <code>skills/brainforge</code> of the checkout and is symlinked into <code>~/.agents/skills</code>.
          See the brainforge skill for client-specific setup.
        </p>
      </section>
    </div>
  );
}
