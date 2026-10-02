import { Link, useParams, useSearchParams } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { ErrorBanner, NetworkProblem } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { paths } from "../../lib/paths.ts";
import { DefinitionStep } from "./DefinitionStep.tsx";

/** Definition tab: what this asset is. Title, tabs and the next-action card come from AssetLayout. */
export function AssetDefinition() {
  const { assetId = "" } = useParams();
  const [params] = useSearchParams();
  const { root } = useProjectRoot();
  const query = useOperation("asset.inspect", { assetId }, { enabled: root !== undefined && assetId !== "" });

  if (root === undefined) return <p>No project is open. <Link to={paths.openProject()}>Open a project</Link>.</p>;
  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary" role="status">Loading definition…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;

  return (
    <>
      <h2 className="sr-only">What this asset is</h2>
      <DefinitionStep inspect={query.data.data} autoCreate={params.get("create") === "1"} />
    </>
  );
}
