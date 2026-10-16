import type { Lookups } from './filters';
import type { ReportFilters } from './ReportFilterBar';

/** What the Reports section hands each report tab. */
export type ReportProps = {
  filters: ReportFilters;
  /** Changes filters and returns to the first page. */
  onFilters: (patch: Partial<ReportFilters>) => void;
  page: number;
  onPage: (next: number) => void;
  lookups: Lookups;
  onUnauthorized: () => void;
  /** Resets every filter this section holds to its default. */
  onClear: () => void;
  /** True when a filter beyond the defaults is narrowing the report. */
  narrowed: boolean;
};
