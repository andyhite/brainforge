import type { AssetVersion } from "@brainforge/contracts";
import { VersionPicker } from "../production/VersionPicker.tsx";

const VERSION_WORDS: Record<AssetVersion["state"], string> = { active: "active", promoted: "promoted, not active", superseded: "replaced" };

/** Narrow the export to some assets, or pin a specific promoted version instead of the active one. Pins show up in the plan, never silently. */
export function ExportSelection({ assets, subset, onSubset, pins, onPin, defaultIds }: {
  assets: Array<{ assetId: string; name?: string | undefined }>;
  subset: string[] | null;
  onSubset: (next: string[] | null) => void;
  pins: Record<string, string>;
  onPin: (assetId: string, versionId: string | undefined) => void;
  /** Assets the default selection would include (from the last plan). */
  defaultIds: string[];
}) {
  const explicit = subset !== null;
  return (
    <div className="rel-select">
      <p className="rel-note">By default every asset with an active version is exported. Choose assets to export only some, or use a promoted version instead of the active one.</p>
      <label className="check">
        <input type="checkbox" checked={explicit} onChange={(event) => onSubset(event.target.checked ? defaultIds : null)} />
        Choose specific assets
      </label>
      {assets.length === 0 ? <p className="secondary">No assets are defined yet.</p> : (
        <div className="table-wrap">
          <table className="rel-pick">
            <caption className="sr-only">Assets and the version to export</caption>
            <thead>
              <tr>
                {explicit ? <th scope="col">Include</th> : null}
                <th scope="col">Asset</th>
                <th scope="col">Version</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const included = !explicit || subset.includes(asset.assetId);
                return (
                  <tr key={asset.assetId} data-included={included}>
                    {explicit ? (
                      <td>
                        <input
                          type="checkbox" aria-label={`Include ${asset.name ?? asset.assetId}`} checked={subset.includes(asset.assetId)}
                          onChange={(event) => onSubset(event.target.checked ? [...subset, asset.assetId] : subset.filter((id) => id !== asset.assetId))}
                        />
                      </td>
                    ) : null}
                    <th scope="row">{asset.name ?? asset.assetId}</th>
                    <td>{included || pins[asset.assetId] ? (
                      <VersionPicker
                        assetId={asset.assetId} id={`export-pin-${asset.assetId}`} label={`Version of ${asset.assetId} to export`} value={pins[asset.assetId]} onChange={(versionId) => onPin(asset.assetId, versionId)}
                        emptyText={(active) => (active ? `Active version (v${active.versionNumber})` : "Active version (none)")}
                        optionText={(version) => `Use v${version.versionNumber} (${VERSION_WORDS[version.state]})`}
                      />
                    ) : <span className="secondary">Not included</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
