import { useState, type FormEvent } from "react";
import { Capability } from "@brainforge/contracts";
import type { AgentToken } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../../api/hooks.ts";
import { Banner, EmptyState, ErrorBanner, Modal, NetworkProblem, Status, formatTime } from "../../../components/ui.tsx";
import { useProjectRoot } from "../../../lib/project-context.tsx";

const RESERVED: readonly Capability[] = ["generate", "review", "concept-lock", "promote", "activate", "export"];
const ACTIVE = Capability.options.filter((c) => !RESERVED.includes(c));

function CapabilityBox({ capability, checked, onChange }: { capability: Capability; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = `token-cap-${capability}`;
  return (
    <div>
      <input type="checkbox" id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} /> <label htmlFor={id}>{capability}</label>
    </div>
  );
}

function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState<boolean | "failed">(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied("failed");
    }
  }
  return (
    <Modal open onOpenChange={() => undefined} dismissible={false} title="Agent token created" description="Give this secret to the agent.">
      <div className="stack">
        <Banner tone="warn" title="This secret is shown once and cannot be retrieved later. Copy it now." />
        <input readOnly aria-label="Agent token secret" value={secret} style={{ fontFamily: "var(--mono, monospace)" }} onFocus={(event) => event.currentTarget.select()} />
        <div className="row">
          <button type="button" onClick={() => void copy()}>Copy secret</button>
          {copied === true ? <Status tone="ok">Copied</Status> : null}
          {copied === "failed" ? <Status tone="bad">Copy failed; select the text and copy it manually</Status> : null}
        </div>
        <div className="row">
          <button type="button" className="primary" onClick={onClose}>I have stored it — close</button>
        </div>
      </div>
    </Modal>
  );
}

function RevokeTokenModal({ token, onClose }: { token: AgentToken; onClose: () => void }) {
  const revoke = useMutationOperation("token.revoke");
  const failure = revoke.data && !revoke.data.ok ? revoke.data.error : undefined;
  async function confirm() {
    const result = await revoke.mutateAsync({ input: { tokenId: token.tokenId }, project: null });
    if (result.ok) onClose();
  }
  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={`Revoke token “${token.name}”`} description="Agents using this token lose access immediately. This cannot be undone.">
      <div className="stack">
        {failure ? <ErrorBanner error={failure} /> : null}
        {revoke.error ? <NetworkProblem error={revoke.error} /> : null}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={revoke.isPending} onClick={() => void confirm()}>{revoke.isPending ? "Revoking…" : "Revoke token"}</button>
        </div>
      </div>
    </Modal>
  );
}

function IssueForm() {
  const { root } = useProjectRoot();
  const issue = useMutationOperation("token.issue");
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Capability[]>(["read"]);
  const [roots, setRoots] = useState("");
  const [secret, setSecret] = useState<string | undefined>();
  const [issuedName, setIssuedName] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const failure = issue.data && !issue.data.ok ? issue.data.error : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const rootList = roots.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    if (rootList.length === 0) { setProblem("Add at least one root."); return; }
    if (caps.length === 0) { setProblem("Select at least one capability."); return; }
    setProblem(undefined);
    const result = await issue.mutateAsync({ input: { name: name.trim(), capabilities: caps, roots: rootList }, project: null });
    if (result.ok) {
      setSecret(result.data.secret);
      setIssuedName(result.data.token.name);
      setName("");
      setRoots("");
      setCaps(["read"]);
    }
  }

  function closeSecret() {
    setSecret(undefined);
    issue.reset();
  }

  function toggle(capability: Capability, checked: boolean) {
    setCaps((prev) => (checked ? [...prev, capability] : prev.filter((c) => c !== capability)));
  }

  const reserved = Capability.options.filter((c) => RESERVED.includes(c));
  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      <h3>Issue token</h3>
      <div className="field">
        <label htmlFor="token-name">Name</label>
        <input id="token-name" required value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <fieldset>
        <legend>Capabilities</legend>
        {ACTIVE.map((c) => <CapabilityBox key={c} capability={c} checked={caps.includes(c)} onChange={(checked) => toggle(c, checked)} />)}
        <details>
          <summary>Reserved for later milestones</summary>
          {reserved.map((c) => <CapabilityBox key={c} capability={c} checked={caps.includes(c)} onChange={(checked) => toggle(c, checked)} />)}
        </details>
      </fieldset>
      <div className="field">
        <label htmlFor="token-roots">Roots (one absolute path per line)</label>
        <textarea id="token-roots" rows={3} value={roots} onChange={(event) => setRoots(event.target.value)} />
        {root ? (
          <div>
            <button type="button" onClick={() => setRoots((prev) => (prev.trim() === "" ? root : `${prev.replace(/\n+$/, "")}\n${root}`))}>Use selected project</button>
          </div>
        ) : null}
      </div>
      <p className="secondary">The agent reads the secret from the environment: set <code>BF_AGENT_TOKEN</code> to the secret and <code>BF_SERVER_URL</code> to this server’s address.</p>
      {problem ? <Banner tone="bad" title={problem} /> : null}
      {failure ? <ErrorBanner error={failure} /> : null}
      {issue.error ? <NetworkProblem error={issue.error} /> : null}
      {issuedName && !secret ? <div role="status"><Status tone="ok">Token “{issuedName}” issued.</Status></div> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={issue.isPending}>{issue.isPending ? "Issuing…" : "Issue token"}</button>
      </div>
      {secret ? <SecretModal secret={secret} onClose={closeSecret} /> : null}
    </form>
  );
}

export function TokensPanel() {
  const list = useOperation("token.list", {}, { project: null });
  const [revoking, setRevoking] = useState<AgentToken | undefined>();
  const tokens = list.data?.ok ? list.data.data.tokens : undefined;
  return (
    <section className="panel stack" aria-labelledby="tokens-h">
      <h2 id="tokens-h">Agent tokens</h2>
      {list.isPending ? <p className="secondary" role="status">Loading tokens…</p> : null}
      {list.error ? <NetworkProblem error={list.error} /> : null}
      {list.data && !list.data.ok ? <ErrorBanner error={list.data.error} /> : null}
      {tokens && tokens.length === 0 ? <EmptyState title="No tokens">Issue a token below to give an agent standing access.</EmptyState> : null}
      {tokens && tokens.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Capabilities</th><th>Roots</th><th>Created</th><th>Last used</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.tokenId}>
                  <td>{token.name}</td>
                  <td>{token.capabilities.join(", ")}</td>
                  <td>{token.roots.map((r) => <div key={r}><code>{r}</code></div>)}</td>
                  <td className="secondary">{formatTime(token.createdAt)}</td>
                  <td className="secondary">{formatTime(token.lastUsedAt)}</td>
                  <td>{token.revokedAt ? <Status tone="bad">Revoked {formatTime(token.revokedAt)}</Status> : <Status tone="ok">Active</Status>}</td>
                  <td>{token.revokedAt ? null : <button type="button" aria-label={`Revoke token ${token.name}`} onClick={() => setRevoking(token)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <IssueForm />
      {revoking ? <RevokeTokenModal token={revoking} onClose={() => setRevoking(undefined)} /> : null}
    </section>
  );
}
