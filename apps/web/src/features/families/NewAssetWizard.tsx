import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isSeq } from "yaml";
import { KebabId, type AssetFamily, type FamilyProfile, type OperationError } from "@brainforge/contracts";
import { callOperation } from "../../api/client.ts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, EmptyState, ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { paths } from "../../lib/paths.ts";
import { useSpecFile } from "../../lib/spec-file.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { isDefinitionMissing } from "../assets/missing.ts";
import { FamilyEditor } from "./FamilyEditor.tsx";
import { ALPHA_SHORT, MOTION_TEXT, useFamilies } from "./useFamilies.tsx";
import { mutate, parseDraft, pushAt, setAt } from "./yaml-patch.ts";
import "./families.css";

interface Template { path: string; text: string; notes: string[] }

function FamilyCards({ profiles, value, onChange, memberOf }: { profiles: FamilyProfile[]; value: AssetFamily | undefined; onChange: (family: AssetFamily) => void; memberOf: string | undefined }) {
  const shown = memberOf ? profiles.filter((p) => p.collection === "member" || p.collection === "either") : profiles;
  return (
    <fieldset className="pick-group">
      <legend>Family</legend>
      <div className="family-cards rows" role="radiogroup" aria-label="Asset family">
        {shown.map((profile) => {
          const on = value === profile.family;
          return (
            <label key={profile.family} className={`family-card${on ? " selected" : ""}`}>
              <input type="radio" name="family" value={profile.family} checked={on} onChange={() => onChange(profile.family)} />
              <span className="family-card-mark" aria-hidden="true">{on ? <Icon name="check" /> : null}</span>
              <span className="family-card-title">{profile.label}</span>
              <span className="family-card-fact">{ALPHA_SHORT[profile.alpha]}</span>
              <span className={`family-card-summary${on ? " open" : ""}`}>{profile.summary}</span>
              {on ? (
                <span className="family-card-facts">
                  <span>{MOTION_TEXT[profile.motion]}</span>
                  {profile.collection === "container" ? <span>Forms a collection</span> : null}
                  {profile.collection === "member" ? <span>Can be a member</span> : null}
                </span>
              ) : null}
            </label>
          );
        })}
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
    return <Banner tone="warn" title="This asset already has a definition" actions={<Link className="button" to={paths.asset(assetId)}>Open {assetId}</Link>}>A definition file already exists, so the wizard will not overwrite it. Edit it from the asset’s Definition tab.</Banner>;
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
        <Banner tone="ok" title="Saved" actions={<Link className="button primary" to={paths.asset(assetId)}>Open {assetId}</Link>}>
          The definition was created. Keep editing, or open the asset to explore concepts.
          {environmentNote ? <div role="status" className="secondary"><Status tone={environmentNote.tone === "ok" ? "ok" : "warn"}>{environmentNote.text}</Status></div> : null}
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

  const shell = (children: ReactNode) => <div className="page narrow">{children}</div>;
  if (root === undefined) return shell(<><PageHeader title="New asset" /><EmptyState title="No project selected"><Link className="button primary" to={paths.openProject()}>Open a project</Link></EmptyState></>);
  if (families.error) return shell(<><PageHeader title="New asset" /><NetworkProblem error={{ message: families.error }} /></>);

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

  const step = template ? 3 : family === undefined ? 1 : 2;
  const steps = (
    <ol className="wiz-steps" aria-label="Steps">
      {["Choose a family", "Name it", "Review and save"].map((label, i) => (
        <li key={label} aria-current={step === i + 1 ? "step" : undefined}>{step > i + 1 ? <Icon name="check" /> : <span aria-hidden="true">{i + 1}.</span>} {label}</li>
      ))}
    </ol>
  );

  if (template) {
    return shell(
      <>
        <PageHeader title={`New ${families.profileOf(family)?.label.toLowerCase() ?? "asset"}: ${name}`} lede="This is the starter file for the family you picked. Edit what you want, then save to create the asset.">
          <button type="button" className="ghost" onClick={() => setTemplate(undefined)}>Change family or id</button>
        </PageHeader>
        {steps}
        <EditStep key={template.path} template={template} memberOf={memberOf} listInEnvironment={listIn} />
      </>,
    );
  }

  const selected = families.profileOf(family);
  return shell(
    <>
      <PageHeader title="New asset" lede="Pick what kind of art this is. The family sets which deliverables, backgrounds and motion the asset starts with." />
      {steps}
      {memberOf ? (
        <Banner tone="info" title={`Creating a member of ${memberOf}`} actions={<button type="button" onClick={() => setParams((p) => { const next = new URLSearchParams(p); next.delete("memberOf"); return next; })}>Make it standalone</button>}>
          Only families that can belong to a collection are offered. The new asset is bound to {memberOf}&rsquo;s locked direction.
        </Banner>
      ) : null}
      <form onSubmit={(event) => void submit(event)} aria-label="New asset">
        {families.loading ? <p className="secondary" role="status">Loading families…</p> : <FamilyCards profiles={families.profiles} value={family} onChange={setFamily} memberOf={memberOf} />}
        <section className="wiz-block" aria-labelledby="wiz-details">
          <h2 id="wiz-details">Name it</h2>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="wiz-name">Name</label>
              <input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="wiz-id">Folder name</label>
              <input id="wiz-id" value={assetId} onChange={(e) => { setAssetId(e.target.value); if (name === "" || name === assetId) setName(e.target.value); }} aria-invalid={idError !== null} aria-describedby="wiz-id-help" autoComplete="off" />
              <span id="wiz-id-help" className={idError ? "field-error" : "hint"}>{idError ?? "Lowercase words joined by hyphens, like hero-knight. It names the asset’s folder and can’t change later."}</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="wiz-desc">Description <span className="secondary">(optional; you can write it in the next step)</span></label>
            <textarea id="wiz-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {memberOf ? (
            <label className="check"><input type="checkbox" checked={listIn} onChange={(e) => setListIn(e.target.checked)} /> Also list it as a required member of {memberOf} after saving</label>
          ) : null}
          {error ? ("code" in error ? <ErrorBanner error={error} /> : <Banner tone="bad" title="Request failed">{error.message}</Banner>) : null}
          <div className="wiz-actions">
            <button type="submit" className="primary" disabled={!canSubmit}>{busy ? "Preparing…" : "Continue"}</button>
            <span className="secondary">{selected ? `${selected.label}: ${selected.summary}` : "Pick a family first."}</span>
          </div>
        </section>
      </form>
    </>,
  );
}
