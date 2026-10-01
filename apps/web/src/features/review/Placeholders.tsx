import { EmptyState, PageHeader } from "../../components/ui.tsx";

export function ReviewPage() {
  return (
    <div>
      <PageHeader title="Review" />
      <EmptyState title="Nothing to review yet">
        <p>The review queue shows candidates that wait for a human decision, escalated agent reviews, and revision-required notes.</p>
        <p>It arrives with concept generation in milestone M2 and the review decisions in M3. No generation exists in this build, so there is nothing to approve.</p>
      </EmptyState>
    </div>
  );
}

export function LibraryPage() {
  return (
    <div>
      <PageHeader title="Library" />
      <EmptyState title="No promoted versions yet">
        <p>The Library lists immutable production versions per asset and separates promoted, active, and exported.</p>
        <p>Promotion arrives in milestone M6, activation in M7, and export in M8.</p>
      </EmptyState>
    </div>
  );
}
