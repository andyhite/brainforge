import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isSeq } from "yaml";
import { KebabId, type AssetFamily, type FamilyProfile, type OperationError } from "@brainforge/contracts";
import { callOperation } from "../../api/client.ts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, EmptyState, ErrorBanner, NetworkProblem, PageHeader } from "../../components/ui.tsx";
import { useSpecFile } from "../../lib/spec-file.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { isDefinitionMissing } from "../assets/missing.ts";
import { FamilyEditor } from "./FamilyEditor.tsx";
import { ALPHA_SHORT, MOTION_TEXT, useFamilies } from "./useFamilies.tsx";
import { mutate, parseDraft, pushAt, setAt } from "./yaml-patch.ts";

interface Template { path: string; text: string; notes: string[] }

function FamilyCards({ profiles, value, onChange, memberOf }: { profiles: FamilyProfile[]; value: AssetFamily | undefined; onChange: (family: AssetFamily) => void; memberOf: string | undefined }) {
  const shown = memberOf ? profiles.filter((p) => p.collection === "member" || p.collection === "either") : profiles;
  return (
    <fieldset className="pick-group">
      <legend>Family</legend>
      <div className="family-cards" role="radiogroup" aria-label="Asset family">
        {shown.map((profile) => (
          <label key={profile.family} className={`family-card${value === profile.family ? " selected" : ""}`}>
            <input type="radio" name="family" value={profile.family} checked={value === profile.family} onChange={() => onChange(profile.family)} />
            <span className="family-card-title">{profile.label}</span>
            <span className="family-card-summary">{profile.summary}</span>
            <span className="family-card-facts">
              <span className="chip">{ALPHA_SHORT[profile.alpha]}</span>
              <span className="chip">{MOTION_TEXT[profile.motion]}</span>
              {profile.collection === "container" ? <span className="chip">Forms a collection</span> : null}
              {profile.collection === "member" ? <span className="chip">Can be a member</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Seeds the new member's deliverables with the environment's direction binding when it has a locked branch. */
function bindDirection(text: string, environmentId: string, branchId: string | undefined): string {
  if (!branchId) return text;
  return mutate(text, (doc) => {
    const list = doc.getIn(["deliverables"], true);
    if (!isSeq(list)) return;
    for (let i = 0; i < list.items.length; i += 1) {
      const kind = doc.getIn(["deliverables", i, "kind"]);
      if (kind === "reference-sheet" || kind === "animation") continue;
      setAt(doc, ["deliverables", i, "referenceRoles", "direction"], { assetId: environmentId, branchId, role: "direction" });
    }
  });
}

function EditStep({ template, memberOf, listInEnvironment }: { template: Template; memberOf: string | undefined; listInEnvironment: boolean }) {
  const { root } = useProjectRoot();
  const file = useSpecFile(template.path);
  const assetId = template.path.split("/").slice(-2, -1)[0] ?? "";
  const branches = useOperation("branch.list", { assetId: memberOf ?? "" }, { enabled: Boolean(memberOf) });
  const seeded = useRef(false);
  const [environmentNote, setEnvironmentNote] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | undefined>(undefined);
  const environmentDone = useRef(false);
  const branchList = branches.data?.ok ? branches.data.data.branches : undefined;
  const branchId = branchList?.find((b) => b.isCurrent)?.branchId ?? branchList?.[0]?.branchId;
  const ready = !file.loading && file.loadError === undefined && (memberOf === undefined || branchList !== undefined || branches.isError || (branches.data && !branches.data.ok));

  useEffect(() => {
    if (seeded.current || !ready || !file.missing) return;
    seeded.current = true;
    file.setDraft(memberOf ? bindDirection(template.text, memberOf, branchId) : template.text);
    // Seeds once, when the (missing) file has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, file.missing]);

  // After the first successful save, list the asset in its environment's collection.
  useEffect(() => {
    if (!file.savedHash || !memberOf || !listInEnvironment || environmentDone.current || root === undefined) return;
    environmentDone.current = true;
    const envPath = `brainforge/assets/${memberOf}/asset.yaml`;
    void (async () => {
      try {
        const read = await callOperation("spec.read", { project: root, input: { path: envPath } });
        if (!read.ok) { setEnvironmentNote({ tone: "bad", text: `Could not read ${envPath}: ${read.error.message}` }); return; }
        const current = parseDraft(read.data.text).data.collection;
        const listed = typeof current === "object" && current !== null && "members" in current && Array.isArray(current.members) && current.members.some((m: unknown) => typeof m === "object" && m !== null && "assetId" in m && m.assetId === assetId);
        if (listed) { setEnvironmentNote({ tone: "ok", text: `${memberOf} already lists ${assetId}.` }); return; }
        const next = mutate(read.data.text, (doc) => { pushAt(doc, ["collection", "members"], { assetId, required: true }); });
        const written = await callOperation("spec.write", { project: root, requestId: crypto.randomUUID(), input: { path: envPath, text: next, expectedHash: read.data.hash } });
        setEnvironmentNote(written.ok ? { tone: "ok", text: `Listed ${assetId} as a required member of ${memberOf}.` } : { tone: "bad", text: `Could not update ${memberOf}: ${written.error.message} Add the member there yourself.` });
      } catch (error) {
        setEnvironmentNote({ tone: "bad", text: error instanceof Error ? error.message : "Could not update the environment." });
      }
    })();
  }, [file.savedHash, memberOf, listInEnvironment, root, assetId]);

  if (!file.loading && !file.missing && file.loadError === undefined && !file.savedHash) {
    return <Banner tone="warn" title="This asset already has a definition" actions={<Link className="button" to={`/assets/${encodeURIComponent(assetId)}`}>Open {assetId}</Link>}>{template.path} exists, so the wizard will not overwrite it. Edit it from its asset page.</Banner>;
  }
  const saved = file.savedHash !== undefined && !file.dirty;
  return (
    <FamilyEditor
      file={file}
      assetId={assetId}
      banner={
        <>
          {template.notes.length > 0 && !(file.savedHash && !file.dirty) ? <Banner tone="info" title="Starter file">{template.notes.join(" ")}</Banner> : null}
          {memberOf && branchList !== undefined && !branchId ? <Banner tone="warn" title={`${memberOf} has no locked concept yet`}>Lock its concept, then pick the branch in each deliverable&rsquo;s “Reference roles”. Until then the member has no shared direction.</Banner> : null}
          {memberOf && branchId ? <Banner tone="info" title="Direction pre-filled">Deliverables are bound to {memberOf}&rsquo;s current locked branch as the shared direction. Change it under “Reference roles”.</Banner> : null}
        </>
      }
      afterSave={saved ? (
        <Banner tone="ok" title="Saved" actions={<Link className="button primary" to={`/assets/${encodeURIComponent(assetId)}`}>Open {assetId}</Link>}>
          <code>{template.path}</code> was created. Keep editing, or open the asset to explore concepts.
          {environmentNote ? <div role="status" className={`secondary`} style={{ marginTop: 4 }}>{environmentNote.tone === "ok" ? "✓ " : "▲ "}{environmentNote.text}</div> : null}
        </Banner>
      ) : null}
    />
  );
}

export function NewAssetWizard() {
  const { root } = useProjectRoot();
  const [params, setParams] = useSearchParams();
  const families = useFamilies();
  const list = useOperation("asset.list", {}, { enabled: root !== undefined });
  const memberOf = params.get("memberOf") ?? undefined;
  const [family, setFamily] = useState<AssetFamily | undefined>(undefined);
  const requestedFamily = params.get("family");
  const requestedProfile = families.profileOf(requestedFamily ?? undefined);
  useEffect(() => {
    if (requestedProfile) setFamily((current) => current ?? requestedProfile.family);
  }, [requestedProfile]);
  const [assetId, setAssetId] = useState(params.get("id") ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [listIn, setListIn] = useState(true);
  const [template, setTemplate] = useState<Template | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<OperationError | { message: string } | undefined>(undefined);
  const idCheck = KebabId.safeParse(assetId);
  const existing = list.data?.ok ? list.data.data.assets.find((a) => a.assetId === assetId) : undefined;
  const taken = existing !== undefined && !isDefinitionMissing(existing.problems);
  const idError = assetId !== "" && !idCheck.success ? "Use lowercase letters, digits and single hyphens, for example hero-knight." : taken ? "An asset with this id already exists." : null;
  const canSubmit = family !== undefined && idCheck.success && !taken && name.trim() !== "" && !busy;

  // A prefilled id (from the Definition step or a member shortcut) also becomes the starting display name.
  useEffect(() => {
    const prefilled = params.get("id");
    if (prefilled) setName((current) => (current === "" ? prefilled : current));
  }, [params]);

  if (root === undefined) return <><PageHeader title="New asset" /><EmptyState title="No project selected"><Link className="button primary" to="/projects/open">Open a project</Link></EmptyState></>;
  if (families.error) return <><PageHeader title="New asset" /><NetworkProblem error={{ message: families.error }} /></>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !family) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await callOperation("family.template", { project: root, input: { family, id: assetId, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) } });
      if (result.ok) setTemplate({ path: result.data.path, text: result.data.text, notes: result.data.notes });
      else setError(result.error);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setBusy(false);
    }
  };

  if (template) {
    return (
      <>
        <PageHeader title={`New ${family ?? "asset"}: ${name}`}>
          <button type="button" onClick={() => setTemplate(undefined)}>← Change family or id</button>
        </PageHeader>
        <EditStep key={template.path} template={template} memberOf={memberOf} listInEnvironment={listIn} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="New asset">
        <Link to="/assets">← All assets</Link>
      </PageHeader>
      {memberOf ? (
        <Banner tone="info" title={`Creating a member of ${memberOf}`} actions={<button type="button" onClick={() => setParams((p) => { const next = new URLSearchParams(p); next.delete("memberOf"); return next; })}>Make it standalone</button>}>
          Only families that can belong to a collection are offered. The new asset is bound to {memberOf}&rsquo;s locked direction.
        </Banner>
      ) : null}
      <form className="stack" onSubmit={(event) => void submit(event)} aria-label="New asset">
        {families.loading ? <p className="secondary" role="status">Loading families…</p> : <FamilyCards profiles={families.profiles} value={family} onChange={setFamily} memberOf={memberOf} />}
        <section className="panel" aria-labelledby="wiz-details">
          <h2 id="wiz-details" style={{ marginTop: 0 }}>Name it</h2>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="wiz-id">Asset id</label>
              <input id="wiz-id" value={assetId} onChange={(e) => { setAssetId(e.target.value); if (name === "" || name === assetId) setName(e.target.value); }} aria-invalid={idError !== null} aria-describedby="wiz-id-help" autoComplete="off" />
              <span id="wiz-id-help" className={idError ? "field-error" : "secondary"}>{idError ?? "Kebab-case; becomes the folder name and cannot change later."}</span>
            </div>
            <div className="field">
              <label htmlFor="wiz-name">Name</label>
              <input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="wiz-desc">Description <span className="secondary">(optional — the template marks it REPLACE: when empty)</span></label>
            <textarea id="wiz-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {memberOf ? (
            <label className="check"><input type="checkbox" checked={listIn} onChange={(e) => setListIn(e.target.checked)} /> Also list it as a required member of {memberOf} after saving</label>
          ) : null}
          {error ? ("code" in error ? <ErrorBanner error={error} /> : <Banner tone="bad" title="Request failed">{error.message}</Banner>) : null}
          <div className="row">
            <button type="submit" className="primary" disabled={!canSubmit}>{busy ? "Preparing…" : "Continue to the editor"}</button>
            {family === undefined ? <span className="secondary">Pick a family first.</span> : null}
          </div>
        </section>
      </form>
    </>
  );
}
