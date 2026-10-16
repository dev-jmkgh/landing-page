'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ButtonSpinner, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import type { HrPaginated } from '@/lib/hr';
import { formatDateTime } from '@/lib/telecalling';
import {
  HR_REQUEST_STATUS_LABELS,
  hrRequestsApi,
  type HrRequestComment,
} from '@/lib/hrRequests';
import { Pager, Tag } from '../../telecalling/shared';
import { isAbort, pageCount, readFailure, writeFailure } from '../leave/shared';

/**
 * A request's timeline — what the employee wrote, HR's replies, every status change —
 * oldest first, one server page at a time, with the reply box beneath it.
 *
 * Oldest first because it is a conversation: it reads top to bottom. It opens on the
 * first page; after HR adds anything (a reply, a status change, a shared document) it
 * moves to the LAST page, where the new entry is, so the administrator sees what they
 * just did rather than the opening message again.
 */

const PAGE_SIZE = 20;
const COMMENT_MAX = 2000;

const AUTHOR_LABELS: Record<HrRequestComment['authorType'], string> = {
  employee: 'Employee',
  admin: 'HR',
  system: 'System',
};

export function RequestTimeline({
  requestId,
  employeeName,
  initial,
  startAtEnd,
  canComment,
  onCommented,
  onUnauthorized,
}: {
  requestId: number;
  employeeName: string;
  /** The first page, as the request detail brought it. */
  initial: HrPaginated<HrRequestComment>;
  /** Open on the last page — set after an action, so its entry is in view. */
  startAtEnd: boolean;
  /** Only while the request is open or in progress. */
  canComment: boolean;
  onCommented: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  const goTo = useCallback(
    async (page: number) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      setError(null);

      try {
        setData(await hrRequestsApi.comments(requestId, { page, pageSize: PAGE_SIZE }, controller.signal));
      } catch (caught) {
        if (isAbort(caught)) return;
        const message = readFailure(caught, onUnauthorized, 'Could not load the timeline.');
        if (message !== null) setError(message);
      } finally {
        if (abort.current === controller) setLoading(false);
      }
    },
    [requestId, onUnauthorized],
  );

  // Once, on mount: the detail brought page 1 and the last page may be another.
  const [startedAtEnd] = useState(startAtEnd);
  useEffect(() => {
    if (!startedAtEnd) return;
    // The detail's first page is the same size as these (20), so page numbers agree.
    const last = pageCount({ total: initial.total, pageSize: PAGE_SIZE });
    if (last > 1) void goTo(last);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  const send = async () => {
    const text = body.trim();
    if (!text) {
      setSendError('Write a reply first.');
      boxRef.current?.focus();
      return;
    }
    if (text.length > COMMENT_MAX) {
      setSendError(`Keep the reply to ${COMMENT_MAX} characters or fewer.`);
      return;
    }

    setSending(true);
    setSendError(null);

    try {
      const result = await hrRequestsApi.addComment(requestId, text);
      setBody('');
      /*
       * The new entry is the last one: turn to the last page here rather than being
       * remounted, so focus stays in the reply box for a follow-up message.
       */
      if (!result.deduplicated) {
        void goTo(pageCount({ total: data.total + 1, pageSize: PAGE_SIZE }));
      }
      onCommented(
        result.deduplicated
          ? 'That reply was already sent.'
          : `Reply sent. ${employeeName} is notified in the HR app.`,
      );
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can reply to requests.',
        'The reply could not be sent.',
      );
      if (message !== null) setSendError(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="tc-card hrl-card" aria-labelledby={`${uid}-title`}>
      <div className="hrl-card__head">
        <h3 className="hrl-card__title" id={`${uid}-title`}>
          Timeline
        </h3>
        <span className="tc-lead-card__count">{data.total}</span>
      </div>

      {error ? (
        <div className="hrl-card__error">
          <FormAlert variant="error">{error}</FormAlert>
          <button type="button" className="btn btn--outline btn--sm" onClick={() => void goTo(data.page)}>
            <Icon name="refresh" size={15} />
            Try again
          </button>
        </div>
      ) : null}

      {data.total === 0 ? (
        <p className="tc-muted">Nothing has been written on this request yet.</p>
      ) : (
        <LoadingOverlay busy={loading}>
          <ol className="hrl-timeline" aria-label="Timeline, oldest first">
            {data.items.map((entry) => (
              <TimelineEntry key={entry.id} entry={entry} />
            ))}
          </ol>
        </LoadingOverlay>
      )}

      {data.total > data.pageSize ? (
        <Pager
          page={data.page}
          totalPages={pageCount(data)}
          total={data.total}
          noun="entry"
          nounPlural="entries"
          busy={loading}
          onChange={(page) => void goTo(page)}
        />
      ) : null}

      {canComment ? (
        <form
          className="hrl-reply"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className={`field${sendError ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={`${uid}-reply`}>
              Reply to {employeeName}
            </label>
            <textarea
              ref={boxRef}
              id={`${uid}-reply`}
              className="textarea tc-textarea--short"
              maxLength={COMMENT_MAX}
              value={body}
              disabled={sending}
              placeholder="Ask for what you need, or say what happens next."
              aria-invalid={sendError ? true : undefined}
              aria-describedby={`${uid}-reply-hint`}
              onChange={(event) => {
                setBody(event.target.value);
                setSendError(null);
              }}
            />
            <p
              className={sendError ? 'field__error' : 'field__hint'}
              id={`${uid}-reply-hint`}
              role={sendError ? 'alert' : undefined}
            >
              {sendError ?? `They see it in the HR app and are notified. ${COMMENT_MAX - body.length} characters left.`}
            </p>
          </div>
          <button type="submit" className="btn btn--primary" disabled={sending} aria-busy={sending || undefined}>
            {sending ? <ButtonSpinner /> : null}
            Send reply
          </button>
        </form>
      ) : (
        <p className="hrl-card__foot-note">
          This request is closed, so nothing more can be added to its timeline.
        </p>
      )}
    </section>
  );
}

function TimelineEntry({ entry }: { entry: HrRequestComment }) {
  const statusChange = entry.statusTo !== null;

  return (
    <li className={`hrl-timeline__item hrl-timeline__item--${entry.authorType}`}>
      <div className="hrl-timeline__meta">
        <Tag tone={entry.authorType === 'admin' ? 'progress' : 'neutral'}>{AUTHOR_LABELS[entry.authorType]}</Tag>
        {entry.authorName ? <span className="hrl-timeline__author">{entry.authorName}</span> : null}
        <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
      </div>
      {statusChange && entry.statusTo ? (
        <p className="hrl-timeline__status">
          {entry.statusFrom ? (
            <>
              Moved from {HR_REQUEST_STATUS_LABELS[entry.statusFrom]} to{' '}
              <strong>{HR_REQUEST_STATUS_LABELS[entry.statusTo]}</strong>
            </>
          ) : (
            <>
              Marked <strong>{HR_REQUEST_STATUS_LABELS[entry.statusTo]}</strong>
            </>
          )}
        </p>
      ) : null}
      {entry.body ? <p className="tc-prewrap hrl-timeline__body">{entry.body}</p> : null}
    </li>
  );
}
