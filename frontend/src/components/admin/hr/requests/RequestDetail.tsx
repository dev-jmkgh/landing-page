'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LoaderBlock } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { formatDateTime } from '@/lib/telecalling';
import {
  HR_REQUEST_CATEGORY_LABELS,
  HR_REQUEST_STATUS_LABELS,
  HR_REQUEST_STATUS_TONE,
  hrRequestsApi,
  isActiveRequest,
  type HrRequestDetail,
} from '@/lib/hrRequests';
import { Tag } from '../../telecalling/shared';
import { isAbort, readFailure } from '../leave/shared';
import { ProfileDiffTable, profileChanges } from './ProfileDiff';
import { RequestDocuments } from './RequestDocuments';
import { RequestStatusCard } from './RequestStatusCard';
import { RequestTimeline } from './RequestTimeline';

/**
 * One HR request: what was asked, the conversation, the decision, and the documents
 * shared on it.
 *
 * Re-read from the server after every action rather than patched locally — a status
 * change also writes a timeline entry, resolving a profile update rewrites `current`,
 * and a shared document adds a line — so what is on screen is always what the employee
 * sees. The timeline then opens on its last page, where the new entry is.
 */

export function RequestDetail({
  requestId,
  onBack,
  onChanged,
  onUnauthorized,
}: {
  requestId: number;
  onBack: () => void;
  /** Something changed: the queue and its badge should be re-read on the way back. */
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [detail, setDetail] = useState<HrRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after each action: remounts the timeline on its last page. */
  const [version, setVersion] = useState(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  const focusedOnce = useRef(false);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);

    try {
      setDetail(await hrRequestsApi.getRequest(requestId, controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load this request.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [requestId, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  /* The heading takes focus once the request is on screen, so a keyboard user lands in it. */
  useEffect(() => {
    if (detail && !focusedOnce.current) {
      focusedOnce.current = true;
      headingRef.current?.focus();
    }
  }, [detail]);

  /**
   * After any action: say what happened, tell the panel, re-read the request.
   *
   * `timeline` remounts the timeline on its last page — for a status change or a shared
   * document, which write an entry the timeline did not make itself. A reply does not
   * remount it: the timeline turns its own page, and focus stays in the reply box.
   *
   * After a status change the Status card is replaced (its actions change), so focus
   * would fall to the page; it goes to the request's heading instead, with the result
   * announced by the notice beneath it.
   */
  const afterAction = useCallback(
    (message: string, options: { timeline: boolean; focusHeading?: boolean }) => {
      setNotice(message);
      onChanged();
      void load().then(() => {
        if (options.timeline) setVersion((value) => value + 1);
        if (options.focusHeading) headingRef.current?.focus();
      });
    },
    [load, onChanged],
  );

  const afterReply = useCallback((message: string) => afterAction(message, { timeline: false }), [afterAction]);
  const afterStatus = useCallback(
    (message: string) => afterAction(message, { timeline: true, focusHeading: true }),
    [afterAction],
  );

  const changes = useMemo(
    () => (detail ? profileChanges(detail.request.payload, detail.current) : []),
    [detail],
  );

  const back = (
    <button type="button" className="btn btn--ghost btn--sm hrl-detail__back" onClick={onBack}>
      <Icon name="arrowLeft" size={15} />
      All requests
    </button>
  );

  if (detail === null) {
    return (
      <div className="hrl-detail">
        {back}
        {error ? (
          <div className="hrl-card__error">
            <FormAlert variant="error">{error}</FormAlert>
            <button type="button" className="btn btn--outline btn--sm" onClick={() => void load()}>
              <Icon name="refresh" size={15} />
              Try again
            </button>
          </div>
        ) : loading ? (
          <LoaderBlock label="Loading the request…" />
        ) : null}
      </div>
    );
  }

  const { request } = detail;
  const active = isActiveRequest(request.status);
  const profileUpdate = request.category === 'profile_update';

  return (
    <div className="hrl-detail" aria-busy={loading || undefined}>
      <div className="hrl-detail__head">
        {back}
        <div className="hrl-detail__identity">
          <p className="tc-dialog__eyebrow">
            Request #{request.id} · {HR_REQUEST_CATEGORY_LABELS[request.category]}
          </p>
          <h2 className="hrl-detail__title" ref={headingRef} tabIndex={-1}>
            {request.subject}
          </h2>
          <div className="hrl-detail__tags">
            <Tag tone={HR_REQUEST_STATUS_TONE[request.status]}>{HR_REQUEST_STATUS_LABELS[request.status]}</Tag>
            <span className="tc-muted">
              {request.employeeName} <span className="tc-mono">{request.employeeCode}</span> · raised{' '}
              {formatDateTime(request.createdAt)} · last activity {formatDateTime(request.lastActivityAt)}
            </span>
          </div>
        </div>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={15} />
          Refresh
        </button>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      <div className="hrl-detail__grid">
        <div className="hrl-detail__main">
          <section className="tc-card hrl-card" aria-labelledby={`${uid}-asked`}>
            <div className="hrl-card__head">
              <h3 className="hrl-card__title" id={`${uid}-asked`}>
                What was asked
              </h3>
            </div>
            {request.details ? (
              <p className="tc-prewrap hrl-detail__details">{request.details}</p>
            ) : (
              <p className="tc-muted">No details beyond the subject.</p>
            )}
          </section>

          {profileUpdate ? (
            <section className="tc-card hrl-card" aria-labelledby={`${uid}-diff`}>
              <div className="hrl-card__head">
                <h3 className="hrl-card__title" id={`${uid}-diff`}>
                  Requested changes
                </h3>
                {request.status === 'resolved' ? <Tag tone="good">Applied</Tag> : null}
              </div>
              <ProfileDiffTable
                changes={changes}
                applied={request.status === 'resolved'}
                caption={`Profile changes ${request.employeeName} asked for: current value and requested value`}
              />
              <p className="hrl-card__foot-note">
                {request.status === 'resolved'
                  ? 'These values were written to the record when the request was resolved.'
                  : active
                    ? '“Apply changes and resolve” writes the requested values to the employee’s record. Rejecting leaves it as it is.'
                    : 'Nothing was changed on the record.'}
              </p>
            </section>
          ) : null}

          <RequestTimeline
            key={`timeline-${version}`}
            requestId={request.id}
            employeeName={request.employeeName}
            initial={detail.comments}
            startAtEnd={version > 0}
            canComment={active}
            onCommented={afterReply}
            onUnauthorized={onUnauthorized}
          />
        </div>

        <aside className="hrl-detail__aside" aria-label="Decision and documents">
          <RequestStatusCard
            key={`status-${request.status}`}
            request={request}
            changes={changes}
            onChanged={afterStatus}
            onUnauthorized={onUnauthorized}
          />
          {/* Not keyed on `version`: it re-reads its own list after a share. */}
          <RequestDocuments
            request={request}
            onShared={(result) => afterAction(result.message, { timeline: true })}
            onUnauthorized={onUnauthorized}
          />
        </aside>
      </div>
    </div>
  );
}
