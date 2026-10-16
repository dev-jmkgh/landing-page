'use client';

import { useEffect, type ReactNode } from 'react';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { pageCount, type HrPaginated } from '@/lib/hr';
import { EmptyPanel, Pager, TableSkeleton } from '../../telecalling/shared';
import { RestrictedPanel, ResultsHead, type ServerData } from './shared';

/**
 * Everything around a report's table: the refusal banner, the first-load skeleton, the
 * heading with the download, the empty state, the refetch overlay and the pager.
 *
 * The same on every tab, so the five reports load, fail and page identically.
 */
export function ReportFrame<P extends HrPaginated<unknown>>({
  result,
  noun,
  nounPlural,
  caption,
  download,
  empty,
  onClear,
  onPage,
  page,
  restricted,
  children,
}: {
  result: ServerData<P>;
  noun: string;
  nounPlural?: string;
  caption: (data: P) => ReactNode;
  download: ReactNode;
  empty: { title: string; message: string };
  /** Offered on the empty state when filters are narrowing the report. */
  onClear?: () => void;
  onPage: (next: number) => void;
  page: number;
  /** What a role that may not read this report is told on a 403. */
  restricted: { title: string; message: string };
  children: (data: P) => ReactNode;
}) {
  const data = result.data;

  // A page past the end — a pasted link, or rows that left the filter since — goes back to
  // the first page rather than claiming the report is empty.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) onPage(1);
  }, [data, page, onPage]);

  if (result.status === 403) return <RestrictedPanel title={restricted.title} message={restricted.message} />;

  return (
    <>
      {result.error ? (
        <FormAlert variant="error">
          {result.error}
          {/* A refused filter is fixed by changing it; retrying only helps a failure. */}
          {result.status !== 400 && result.status !== 422 ? (
            <>
              {' '}
              <button type="button" className="tc-alert-action" onClick={result.reload}>
                Try again
              </button>
            </>
          ) : null}
        </FormAlert>
      ) : null}

      {data ? (
        <>
          <ResultsHead actions={download}>{caption(data)}</ResultsHead>
          {data.items.length === 0 ? (
            <EmptyPanel
              title={empty.title}
              message={empty.message}
              actionLabel={onClear ? 'Clear filters' : undefined}
              onAction={onClear}
            />
          ) : (
            <LoadingOverlay busy={result.loading} label="Updating the report…">
              <div>
                {children(data)}
                <Pager
                  page={data.page}
                  totalPages={pageCount(data)}
                  total={data.total}
                  noun={noun}
                  nounPlural={nounPlural}
                  busy={result.loading}
                  onChange={onPage}
                />
              </div>
            </LoadingOverlay>
          )}
        </>
      ) : result.loading ? (
        <TableSkeleton rows={8} />
      ) : result.error ? null : (
        <EmptyPanel title="Nothing to show" message="The report could not be loaded." actionLabel="Try again" onAction={result.reload} />
      )}
    </>
  );
}
