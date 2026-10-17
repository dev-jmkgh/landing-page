'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogs } from '@/components/admin/ConfirmDialog';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import type { HrPaginated } from '@/lib/hr';
import type { HrEmployeeOption } from '@/lib/hrLeave';
import {
  HR_DOCUMENT_CATEGORY_LABELS,
  documentTypeLabel,
  formatFileSize,
  hrRequestsApi,
  type HrDocument,
  type HrDocumentScope,
} from '@/lib/hrRequests';
import { DateTimeCell, EmptyPanel, Pager, Tag, TableSkeleton } from '../telecalling/shared';
import { EmployeePicker } from './leave/EmployeePicker';
import { isAbort, pageCount, readFailure, writeFailure } from './leave/shared';
import { AnnouncementCard } from './requests/AnnouncementCard';
import type { ShareResult } from './requests/ShareDocumentForm';
import { UploadDocumentDialog } from './requests/UploadDocumentDialog';

/**
 * Documents HR has shared — company-wide (a policy everyone can read) or personal (one
 * employee's letter, contract or payslip copy) — and announcements to everyone's inbox.
 *
 * Downloads are plain links to `GET /documents/:id/download`: a same-site GET, so the
 * admin session cookie travels with it and the browser handles the file (or the storage
 * redirect) itself. A new tab, so a refusal — a document removed meanwhile, a session
 * that ended — shows its message there instead of replacing this screen.
 *
 * Removing is a soft delete: the document disappears from every list and link at once,
 * but the record that the employee once had it remains.
 */

const PAGE_SIZE = 20;

const SCOPES: { key: HrDocumentScope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'company', label: 'Company-wide' },
  { key: 'personal', label: 'Personal' },
];

export function HrDocumentsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const dialogs = useDialogs();
  const [scope, setScope] = useState<HrDocumentScope>('all');
  const [employee, setEmployee] = useState<HrEmployeeOption | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<HrPaginated<HrDocument> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const next = search.trim();
    if (next === debounced) return undefined;
    const timer = window.setTimeout(() => {
      setDebounced(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, debounced]);

  /*
   * An employee filter means "what this person can see" under All (company-wide plus
   * theirs), and "only theirs" under Personal. Under Company-wide it would filter nothing,
   * so it is not sent there.
   */
  const query = useMemo(
    () => ({
      scope,
      userId: scope === 'company' ? undefined : employee?.id,
      q: debounced || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [scope, employee, debounced, page],
  );

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);

    try {
      const result = await hrRequestsApi.listDocuments(query, controller.signal);
      if (result.items.length === 0 && result.total > 0 && query.page > 1) {
        setPage(pageCount(result));
        return;
      }
      setData(result);
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load the documents.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [query, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const closeUpload = useCallback(() => setUploading(false), []);

  const handleShared = useCallback(
    (result: ShareResult) => {
      setUploading(false);
      setNotice(result.message);
      setError(null);
      // The new document is the newest, so it is at the top of page 1.
      if (page !== 1) setPage(1);
      else void load();
    },
    [load, page],
  );

  const remove = async (document: HrDocument) => {
    const who =
      document.scope === 'company' ? 'every employee' : (document.employeeName ?? 'the employee');
    const confirmed = await dialogs.confirm({
      title: `Remove “${document.title}”?`,
      message: `It disappears from ${who}'s documents in the HR app straight away, and links already opened stop working.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    setBusyId(document.id);
    setError(null);
    setNotice(null);

    try {
      await hrRequestsApi.removeDocument(document.id);
      setNotice(`“${document.title}” is removed.`);
      await load();
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can remove documents.',
        'The document could not be removed.',
      );
      if (message !== null) setError(message);
    } finally {
      setBusyId(null);
    }
  };

  const filtered = (employee !== null && scope !== 'company') || debounced !== '';

  const clearFilters = () => {
    setEmployee(null);
    setSearch('');
    setDebounced('');
    setPage(1);
  };

  const filterHint =
    employee && scope === 'all'
      ? `Showing what ${employee.name} can open: company-wide documents and their own.`
      : employee && scope === 'personal'
        ? `Showing documents shared with ${employee.name} only.`
        : employee && scope === 'company'
          ? 'Company-wide documents are the same for everyone; the employee filter does not apply.'
          : null;

  return (
    <>
      <div className="admin-toolbar">
        <div className="tc-segmented" role="group" aria-label="Who the documents are for">
          {SCOPES.map((option) => (
            <button
              key={option.key}
              type="button"
              className="tc-segmented__button"
              aria-pressed={scope === option.key}
              onClick={() => {
                if (option.key === scope) return;
                setScope(option.key);
                setPage(1);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="admin-filters">
          <div className="hrl-filter-picker">
            <EmployeePicker
              label="Employee"
              value={employee}
              onChange={(next) => {
                setEmployee(next);
                setPage(1);
              }}
              onUnauthorized={onUnauthorized}
              placeholder="Any employee"
              changeLabel="Clear"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hrd-search">
              Search
            </label>
            <input
              id="hrd-search"
              className="input"
              type="search"
              value={search}
              placeholder="Title or file name"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '12rem' }}
            />
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setNotice(null);
              setUploading(true);
            }}
          >
            <Icon name="upload" size={16} />
            Share a document
          </button>
        </div>
      </div>

      {filterHint ? <p className="hrl-filter-hint">{filterHint}</p> : null}

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {data === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {data.items.length === 0 ? (
            <EmptyPanel
              title={filtered ? 'No documents match' : 'No documents shared yet'}
              message={
                filtered
                  ? 'Nothing matches these filters. Clear them to see more.'
                  : 'Share a policy with everyone, or a letter with one employee. They open it from the HR app.'
              }
              actionLabel={filtered ? 'Clear filters' : 'Share a document'}
              onAction={filtered ? clearFilters : () => setUploading(true)}
            />
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.id}
              rowBusy={(row) => busyId === row.id}
              minWidth="66rem"
              caption="Shared documents, with who they are for, category, size and who shared them"
              columns={[
                {
                  /* No width: the title absorbs whatever space is left. */
                  key: 'document',
                  header: 'Document',
                  render: (row) => (
                    <CellStack
                      primary={
                        <a
                          className="tc-link"
                          href={hrRequestsApi.documentDownloadUrl(row.id)}
                          target="_blank"
                          rel="noopener"
                        >
                          {row.title}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      }
                      secondary={row.originalName}
                    >
                      <span className="tc-muted">
                        {documentTypeLabel(row.mimeType)} · {formatFileSize(row.sizeBytes)}
                      </span>
                    </CellStack>
                  ),
                },
                {
                  key: 'category',
                  header: 'Category',
                  width: '8rem',
                  nowrap: true,
                  render: (row) => HR_DOCUMENT_CATEGORY_LABELS[row.category] ?? row.category,
                },
                {
                  key: 'for',
                  header: 'Shared with',
                  width: '13rem',
                  render: (row) =>
                    row.scope === 'company' ? (
                      <Tag tone="progress">Everyone</Tag>
                    ) : (
                      <CellStack primary={row.employeeName ?? 'Former employee'}>
                        {row.requestId ? <span className="tc-muted">On request #{row.requestId}</span> : null}
                      </CellStack>
                    ),
                },
                {
                  key: 'shared',
                  header: 'Shared',
                  width: '10rem',
                  render: (row) => (
                    <CellStack
                      primary={<DateTimeCell value={row.createdAt} />}
                      secondary={row.uploadedByName ? `by ${row.uploadedByName}` : undefined}
                    />
                  ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  width: '13rem',
                  nowrap: true,
                  render: (row) => (
                    <CellActions>
                      <a
                        className="btn btn--outline btn--sm"
                        href={hrRequestsApi.documentDownloadUrl(row.id)}
                        target="_blank"
                        rel="noopener"
                        aria-label={`Download ${row.title} (opens in a new tab)`}
                      >
                        <Icon name="download" size={15} />
                        Download
                      </a>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busyId === row.id}
                        onClick={() => void remove(row)}
                        aria-label={`Remove ${row.title}`}
                      >
                        Remove
                      </button>
                    </CellActions>
                  ),
                },
              ]}
            />
          )}
        </LoadingOverlay>
      )}

      {data && data.items.length > 0 ? (
        <Pager
          page={data.page}
          totalPages={pageCount(data)}
          total={data.total}
          noun="document"
          busy={loading}
          onChange={setPage}
        />
      ) : null}

      <AnnouncementCard onUnauthorized={onUnauthorized} />

      {uploading ? (
        <UploadDocumentDialog onClose={closeUpload} onShared={handleShared} onUnauthorized={onUnauthorized} />
      ) : null}
    </>
  );
}
