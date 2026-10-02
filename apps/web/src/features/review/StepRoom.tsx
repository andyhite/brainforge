import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Candidate } from "@brainforge/contracts";
import { PageHeader } from "../../components/ui.tsx";
import { useReviewQueue } from "../../lib/attention.ts";
import { paths } from "../../lib/paths.ts";
import { useProject } from "../../lib/use-project.ts";
import { Room } from "./Room.tsx";

/** `/assets/:assetId/steps/:stepId`: one room per deliverable (and the concept): review, compare, notes, decisions, processing and generation. */
export function StepRoomPage() {
  const { assetId = "", stepId = "" } = useParams();
  const [params] = useSearchParams();
  const project = useProject();
  const queue = useReviewQueue();
  const [notice, setNotice] = useState<string | undefined>();
  const branch = params.get("branch") ?? undefined;
  const waiting = queue.items.map((item) => item.candidate).filter((c) => c.assetId === assetId && c.stepId === stepId);

  if (project.root === undefined) return <div className="room-host"><div className="room-empty"><PageHeader title="Room" /><p>No project is open. <Link to={paths.openProject()}>Open a project</Link>.</p></div></div>;
  return (
    <Room
      key={`${assetId}/${stepId}`}
      mode="step"
      assetId={assetId}
      stepId={stepId}
      branchParam={branch}
      candidateParam={params.get("candidate") ?? undefined}
      waiting={waiting}
      advance={false}
      notice={notice}
      onNotice={setNotice}
      hrefFor={(candidate: Candidate, outputId?: string) => paths.step(assetId, stepId, { ...(branch ? { branch } : {}), candidate: candidate.candidateId, ...(outputId ? { output: outputId } : {}) })}
    />
  );
}
