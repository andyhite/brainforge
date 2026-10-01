import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { stringify } from "yaml";
import { AssetFamily, KebabId } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { ErrorBanner, NetworkProblem } from "../../components/ui.tsx";

export function CreateAssetForm({ primary }: { primary: boolean }) {
  const navigate = useNavigate();
  const write = useMutationOperation("spec.write");
  const [assetId, setAssetId] = useState("");
  const [name, setName] = useState("");
  const [family, setFamily] = useState<AssetFamily>("character");
  const [description, setDescription] = useState("");
  const idCheck = KebabId.safeParse(assetId);
  const idError = assetId !== "" && !idCheck.success ? "Use lowercase letters, digits and single hyphens, for example hero-knight." : null;
  const canSubmit = idCheck.success && name.trim() !== "" && description.trim() !== "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const text = stringify({ schema: "brainforge.asset.v2", id: assetId, name: name.trim(), family, description: description.trim() });
    const result = await write.mutateAsync({ input: { path: `brainforge/assets/${assetId}/asset.yaml`, text, expectedHash: null } }).catch(() => undefined);
    if (result?.ok) navigate(`/assets/${assetId}`);
  };

  const result = write.data;
  return (
    <form className="stack" onSubmit={(event) => void submit(event)} aria-label="Create asset definition">
      <div className="grid-2">
        <div className="field">
          <label htmlFor="assets-new-id">Asset id</label>
          <input id="assets-new-id" value={assetId} onChange={(e) => setAssetId(e.target.value)} aria-invalid={idError !== null} aria-describedby="assets-new-id-help" autoComplete="off" />
          <span id="assets-new-id-help" className="secondary">{idError ?? "Kebab-case; becomes the folder name."}</span>
        </div>
        <div className="field">
          <label htmlFor="assets-new-name">Name</label>
          <input id="assets-new-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="assets-new-family">Family</label>
          <select id="assets-new-family" value={family} onChange={(e) => setFamily(AssetFamily.parse(e.target.value))}>
            {AssetFamily.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="assets-new-description">Description</label>
          <input id="assets-new-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      {write.error ? <NetworkProblem error={write.error} /> : null}
      {result && !result.ok ? <ErrorBanner error={result.error} extra={result.error.code === "SPEC_CONFLICT" ? <p>An asset with this id already exists.</p> : undefined} /> : null}
      <div className="row">
        <button type="submit" className={primary ? "primary" : undefined} disabled={write.isPending || !canSubmit}>
          {write.isPending ? "Creating…" : "Create asset definition"}
        </button>
      </div>
    </form>
  );
}
