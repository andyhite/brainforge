import { EmptyState, PageHeader } from "../../components/ui.tsx";

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
