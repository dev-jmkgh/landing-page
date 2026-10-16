'use client';

import { useId, useRef, useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { formatDateTime } from '@/lib/telecalling';
import {
  HR_REQUEST_STATUS_LABELS,
  HR_REQUEST_STATUS_TONE,
  PROFILE_UPDATE_LABELS,
  hrRequestsApi,
  isActiveRequest,
  type HrRequest,
  type ProfileUpdateField,
  type ProfileUpdatePayload,
} from '@/lib/hrRequests';
import { Tag } from '../../telecalling/shared';
import { HrDialog, writeFailure } from '../leave/shared';
import { ProfileDiffTable, type ProfileChange } from './ProfileDiff';

/**
 * Moving a request: Start (open → in progress), Resolve, Reject.
 *
 * The note is the employee's explanation and travels to them verbatim; a rejection
 * cannot be sent without one (the server refuses it too). Resolving is final — the
 * request closes and nothing more can be written on it — so it is confirmed.
 *
 * RESOLVING A PROFILE UPDATE CHANGES THE EMPLOYEE'S RECORD. The button says so ("Apply
 * changes and resolve"), and the confirmation lists exactly what will be written, field
 * by field, before anything is. That write and the status change happen in one
 * transaction on the server, audited with before and after.
 */

const NOTE_MAX = 1000;

type Action = 'in_progress' | 'resolved' | 'rejected';

export function RequestStatusCard({
  request,
  changes,
  onChanged,
  onUnauthorized,
}: {
  request: HrRequest;
  /** The profile-update diff, for the confirmation. Empty for other categories. */
  changes: ProfileChange[];
  onChanged: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const active = isActiveRequest(request.status);
  const profileUpdate = request.category === 'profile_update';
  const resolveLabel = profileUpdate ? 'Apply changes and resolve' : 'Resolve';

  const run = async (status: Action) => {
    const trimmed = note.trim();
    if (trimmed.length > NOTE_MAX) {
      setNoteError(`Keep the note to ${NOTE_MAX} characters or fewer.`);
      noteRef.current?.focus();
      return;
    }
    if (status === 'rejected' && !trimmed) {
      setNoteError(`Say why the request is being declined — ${request.employeeName} reads this as the reason.`);
      noteRef.current?.focus();
      return;
    }
    // Final, like resolving: the request closes and nothing more can be written on it.
    if (
      status === 'rejected' &&
      !window.confirm(
        `Reject “${request.subject}”?\n\n${request.employeeName} is notified with your note, and the request is closed.` +
          (request.category === 'profile_update' ? ' Their record is not changed.' : ''),
      )
    ) {
      return;
    }

    setBusy(status);
    setError(null);
    setNoteError(null);

    try {
      const result = await hrRequestsApi.changeStatus(request.id, status, trimmed);
      setNote('');
      setConfirming(false);
      onChanged(describe(status, request, result.applied?.after ?? null));
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can move a request. You can read it, but not change it.',
        'The request could not be updated.',
      );
      if (message === null) return;
      setConfirming(false);
      setError(message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="tc-card hrl-card" aria-labelledby={`${uid}-title`}>
      <div className="hrl-card__head">
        <h3 className="hrl-card__title" id={`${uid}-title`}>
          Status
        </h3>
        <Tag tone={HR_REQUEST_STATUS_TONE[request.status]}>{HR_REQUEST_STATUS_LABELS[request.status]}</Tag>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {!active ? (
        <dl className="admin-detail">
          {request.status === 'cancelled' ? (
            <div className="admin-detail__row">
              <dt className="admin-detail__label">Cancelled</dt>
              <dd>By {request.employeeName}, who withdrew it.</dd>
            </div>
          ) : (
            <>
              <div className="admin-detail__row">
                <dt className="admin-detail__label">{request.status === 'resolved' ? 'Resolved by' : 'Rejected by'}</dt>
                <dd>{request.resolvedByName ?? 'Not recorded'}</dd>
              </div>
              <div className="admin-detail__row">
                <dt className="admin-detail__label">On</dt>
                <dd>{request.resolvedAt ? `${formatDateTime(request.resolvedAt)} IST` : 'Not recorded'}</dd>
              </div>
              <div className="admin-detail__row">
                <dt className="admin-detail__label">Note</dt>
                <dd className="tc-prewrap">{request.resolutionNote ?? <span className="tc-muted">None given</span>}</dd>
              </div>
            </>
          )}
        </dl>
      ) : (
        <>
          <div className={`field${noteError ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={`${uid}-note`}>
              Note to {request.employeeName}
            </label>
            <textarea
              ref={noteRef}
              id={`${uid}-note`}
              className="textarea tc-textarea--short"
              maxLength={NOTE_MAX}
              value={note}
              disabled={busy !== null}
              placeholder="Optional when starting or resolving; required to reject."
              aria-invalid={noteError ? true : undefined}
              aria-describedby={`${uid}-note-hint`}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(null);
              }}
            />
            <p
              className={noteError ? 'field__error' : 'field__hint'}
              id={`${uid}-note-hint`}
              role={noteError ? 'alert' : undefined}
            >
              {noteError ?? 'Sent with the change and kept on the timeline.'}
            </p>
          </div>

          <div className="hrl-status-actions">
            {request.status === 'open' ? (
              <button
                type="button"
                className="btn btn--outline"
                onClick={() => void run('in_progress')}
                disabled={busy !== null}
                aria-busy={busy === 'in_progress' || undefined}
              >
                {busy === 'in_progress' ? <ButtonSpinner /> : <Icon name="clock" size={16} />}
                Start
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
            >
              <Icon name="check" size={16} />
              {resolveLabel}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void run('rejected')}
              disabled={busy !== null}
              aria-busy={busy === 'rejected' || undefined}
            >
              {busy === 'rejected' ? <ButtonSpinner /> : null}
              Reject
            </button>
          </div>
          <p className="hrl-card__foot-note">
            {request.status === 'open'
              ? 'Start tells the employee it has been picked up. Resolving or rejecting closes the request.'
              : 'Resolving or rejecting closes the request; nothing more can be added after that.'}
          </p>
        </>
      )}

      {confirming ? (
        <HrDialog
          title={profileUpdate ? 'Apply changes and resolve' : 'Resolve this request'}
          eyebrow={`Request #${request.id}`}
          sub={`${request.employeeName} · ${request.employeeCode}`}
          onClose={() => setConfirming(false)}
          wide={profileUpdate}
        >
          <div className="tc-dialog__body">
            {profileUpdate ? (
              <>
                <p>
                  These values are written to {request.employeeName}&apos;s record now, replacing
                  what is there. Fields not listed are left as they are.
                </p>
                <ProfileDiffTable
                  changes={changes}
                  applied={false}
                  caption={`Changes to ${request.employeeName}'s record`}
                />
              </>
            ) : (
              <p>
                “{request.subject}” is marked resolved and closed. {request.employeeName} is
                notified, and nothing more can be written on it.
              </p>
            )}
            {note.trim() ? (
              <dl className="tc-facts">
                <dt>Your note</dt>
                <dd>
                  <span className="tc-prewrap">{note.trim()}</span>
                </dd>
              </dl>
            ) : (
              <p className="tc-dialog__note">No note will be sent. Add one in the Status card if you want to explain.</p>
            )}
          </div>
          <div className="tc-dialog__foot">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setConfirming(false)}
              disabled={busy !== null}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void run('resolved')}
              disabled={busy !== null}
              aria-busy={busy === 'resolved' || undefined}
            >
              {busy === 'resolved' ? <ButtonSpinner /> : null}
              {resolveLabel}
            </button>
          </div>
        </HrDialog>
      ) : null}
    </section>
  );
}

/** The success line after a move. */
function describe(status: Action, request: HrRequest, applied: ProfileUpdatePayload | null): string {
  if (status === 'in_progress') {
    return `Marked in progress. ${request.employeeName} is told it has been picked up.`;
  }
  if (status === 'rejected') {
    return `Rejected. ${request.employeeName} is notified with your note.`;
  }
  if (applied && Object.keys(applied).length > 0) {
    const fields = (Object.keys(applied) as ProfileUpdateField[])
      .map((field) => PROFILE_UPDATE_LABELS[field]?.toLowerCase() ?? field)
      .join(', ');
    return `Resolved, and ${request.employeeName}'s record is updated (${fields}). They are notified in the HR app.`;
  }
  return `Resolved. ${request.employeeName} is notified in the HR app.`;
}
