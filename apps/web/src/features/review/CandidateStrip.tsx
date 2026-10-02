import { Link } from "react-router-dom";
import type { Candidate } from "@brainforge/contracts";
import { fileUrl } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { candidateMark, defaultOutput } from "./room-lib.ts";

interface Props {
  candidates: Candidate[];
  currentId: string | undefined;
  projectId: string | undefined;
  /** Jobs still making candidates for this step. */
  running: number;
  concept: boolean;
  /** Concept candidates a branch is locked on. */
  lockedIds?: string[];
  /** While comparing, a thumbnail adds or removes a candidate from the comparison instead of opening it. */
  comparing: boolean;
  compareIds: string[];
  maxCompare: number;
  onToggleCompare: (candidateId: string) => void;
  hrefFor: (candidate: Candidate) => string;
  onAdd: () => void;
  canAdd: boolean;
}

/** Every candidate of the step on this branch as a 64px take: current ringed, rejected struck, favorites starred, locked concepts latched. */
export function CandidateStrip({ candidates, currentId, projectId, running, concept, lockedIds = [], comparing, compareIds, maxCompare, onToggleCompare, hrefFor, onAdd, canAdd }: Props) {
  const noun = concept ? "Concepts" : "Candidates";
  return (
    <nav className="takes" aria-label={noun}>
      <span className="take-label">{noun}</span>
      <ul className="plain takes-list">
        {candidates.map((c) => {
          const output = defaultOutput(c);
          const mark = candidateMark(c);
          const locked = lockedIds.includes(c.candidateId);
          const current = c.candidateId === currentId;
          const inCompare = compareIds.includes(c.candidateId);
          const label = `${c.label}${locked ? ", locked" : ""}${c.favorite ? ", favorite" : ""}${mark ? `, ${mark}` : ""}${comparing ? (inCompare ? ", in the comparison" : "") : current ? ", showing" : ""}`;
          const face = (
            <>
              {output && projectId ? <img src={fileUrl(projectId, output.fileId, 128)} alt="" loading="lazy" decoding="async" /> : null}
              {c.favorite ? <span className="mark fav" aria-hidden="true"><Icon name="star-fill" size="sm" /></span> : null}
              {locked || mark ? <span className="mark" aria-hidden="true"><Icon name={locked ? "lock" : mark === "approved" ? "check" : "close"} size="sm" /></span> : null}
            </>
          );
          const className = `take checker${(comparing ? inCompare : current) ? " current" : ""}${mark === "rejected" ? " void" : ""}`;
          return (
            <li key={c.candidateId}>
              {comparing ? (
                <button type="button" className={className} aria-pressed={inCompare} aria-label={label} title={c.label} disabled={!inCompare && compareIds.length >= maxCompare} onClick={() => onToggleCompare(c.candidateId)}>{face}</button>
              ) : (
                <Link className={className} to={hrefFor(c)} replace aria-label={label} aria-current={current ? "true" : undefined} title={c.label}>{face}</Link>
              )}
            </li>
          );
        })}
        {Array.from({ length: running }, (_, i) => (
          <li key={`running-${i}`}><span className="take running" aria-hidden="true"><Icon name="clock" /></span></li>
        ))}
        <li>
          <button type="button" className="take add" aria-label={concept ? "Generate more concepts" : "Generate more candidates"} title={canAdd ? undefined : "This deliverable can’t be generated yet"} disabled={!canAdd} onClick={onAdd}><Icon name="plus" /></button>
        </li>
      </ul>
      {running > 0 ? <span className="take-note" role="status">{running} generating…</span> : null}
      {comparing ? <span className="take-note">Choose up to {maxCompare} to compare.</span> : null}
    </nav>
  );
}
