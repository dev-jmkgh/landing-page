'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LoadingOverlay, Loader } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import type { HrPaginated } from '@/lib/hr';
import { formatDateTime } from '@/lib/telecalling';
import {
  HR_DOCUMENT_CATEGORY_LABELS,
  documentTypeLabel,
  formatFileSize,
  hrRequestsApi,
  type HrDocument,
  type HrRequest,
} from '@/lib/hrRequests';
import { Pager } from '../../telecalling/shared';
import { isAbort, pageCount, readFailure } from '../leave/shared';
import { ShareDocumentForm, type ShareResult } from './ShareDocumentForm';

/**
 * Documents shared on one request, paged from `GET /documents?requestId`, and the form to
 * share another. Whatever is shared here is personal to the person who raised the
 * request (the server sets the owner from the request) and lands on its timeline.
 */

const PAGE_SIZE = 5;

export function RequestDocuments({
  request,
  onShared,
  onUnauthorized,
}: {
  request: HrRequest;
  onShared: (result: ShareResult) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [data, setData] = useState<HrPaginated<HrDocument> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);

    try {
      setData(
        await hrRequestsApi.listDocuments(
          { requestId: request.id, page, pageSize: PAGE_SIZE },
          controller.signal,
        ),
      );
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load the documents on this request.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [request.id, page, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  return (
    <section className="tc-card hrl-card" aria-labelledby={`${uid}-title`}>
      <div className="hrl-card__head">
        <h3 className="hrl-card__title" id={`${uid}-title`}>
          Documents
        </h3>
        {data ? <span className="tc-lead-card__count">{data.total}</span> : null}
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {data === null ? (
        loading ? <Loader inline size="sm" label="Loading documents…" /> : null
      ) : data.total === 0 ? (
        <p className="tc-muted">Nothing shared on this request yet.</p>
      ) : (
        <LoadingOverlay busy={loading}>
          <ul className="hrl-doc-list">
            {data.items.map((document) => (
              <li key={document.id} className="hrl-doc-list__item">
                <a
                  className="tc-link"
                  href={hrRequestsApi.documentDownloadUrl(document.id)}
                  target="_blank"
                  rel="noopener"
                >
                  <Icon name="file" size={15} />
                  {document.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="hrl-doc-list__meta">
                  {HR_DOCUMENT_CATEGORY_LABELS[document.category]} · {documentTypeLabel(document.mimeType)},{' '}
                  {formatFileSize(document.sizeBytes)} · {formatDateTime(document.createdAt)}
                  {document.uploadedByName ? ` · ${document.uploadedByName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </LoadingOverlay>
      )}

      {data && data.total > PAGE_SIZE ? (
        <Pager
          page={data.page}
          totalPages={pageCount(data)}
          total={data.total}
          noun="document"
          busy={loading}
          onChange={setPage}
        />
      ) : null}

      {sharing ? (
        <div className="hrl-card__section">
          <h4 className="tc-dialog__section-title">Share a document on this request</h4>
          <ShareDocumentForm
            layout="card"
            request={{
              id: request.id,
              employeeName: request.employeeName,
              employeeCode: request.employeeCode,
              category: request.category,
            }}
            onShared={(result) => {
              setSharing(false);
              // Newest first: the document just shared is at the top of page 1.
              if (page !== 1) setPage(1);
              else void load();
              onShared(result);
              // The form is gone; the button that opened it is where focus belongs.
              window.setTimeout(() => shareButtonRef.current?.focus(), 0);
            }}
            onCancel={() => {
              setSharing(false);
              window.setTimeout(() => shareButtonRef.current?.focus(), 0);
            }}
            onUnauthorized={onUnauthorized}
          />
        </div>
      ) : (
        <button
          ref={shareButtonRef}
          type="button"
          className="btn btn--outline btn--sm hrl-card__action"
          onClick={() => setSharing(true)}
        >
          <Icon name="upload" size={15} />
          Share a document on this request
        </button>
      )}
    </section>
  );
}
