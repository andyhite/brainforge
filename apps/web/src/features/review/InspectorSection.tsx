import { useState, type ReactNode } from "react";

/** Native disclosure for inspector tools. Children mount on first open and stay mounted, so drafts survive collapsing while untouched tools cost no queries. */
export function InspectorSection({ id, title, meta, open, onOpenChange, children }: {
  id: string;
  title: string;
  meta?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return (
    <details id={id} className="review-section" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary><span>{title}</span>{meta !== undefined ? <span className="review-section-meta">{meta}</span> : null}</summary>
      {seen ? <div className="review-section-body">{children}</div> : null}
    </details>
  );
}
