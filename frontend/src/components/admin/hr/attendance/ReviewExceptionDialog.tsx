'use client';

import { useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { formatDate } from '@/lib/telecalling';
import { attendanceAdminApi, type AttendanceException } from '@/lib/hr';
import { classifyWriteError, useStableClose } from '../people/shared';

/**
 * Marks an exception day as reviewed, with an optional note. ADMIN ONLY on the server.
 *
 * Reviewing changes nothing about the day itself — the hours stay as recorded. It records
 * that somebody looked at the evidence, so the day leaves the "waiting for review" list.
 * A new flagged punch on the same day reopens it, because the reviewer has not seen that.
 * To change the hours, correct the day instead.
 */
export function ReviewExceptionDialog({
  exception,
  onClose,
  onReviewed,
  onUnauthorized,
}: {
  exception: AttendanceException;
  onClose: () => void;
  onReviewed: (updated: AttendanceException | null, message: string) => void;
  onUnauthorized: () => void;
}) {
  const close = useStableClose(onClose);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const what = [exception.missingPunch ? 'a missing punch' : null, exception.flagged ? 'a flagged punch' : null]
    .filter(Boolean)
    .join(' and ');

  const submit = async () => {
    setError(null);
    if (note.trim().length > 500) {
      setError('Keep the note to 500 characters or fewer.');
      return;
    }

    setSaving(true);
    try {
      const updated = await attendanceAdminApi.reviewException(exception.attendanceId, note.trim() || null);
      onReviewed(
        updated,
        `${exception.employeeName}’s ${formatDate(exception.workDate)} is marked reviewed.`,
      );
    } catch (caught) {
      const outcome = classifyWriteError(caught);
      if (outcome.unauthorized) return onUnauthorized();
      setError(
        outcome.forbidden
          ? 'Only an administrator can mark exceptions reviewed.'
          : (outcome.fields.note ?? outcome.message),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Mark reviewed"
      label={`Mark ${exception.employeeName}’s ${formatDate(exception.workDate)} reviewed`}
      className="tc-dialog"
      dismissOnBackdrop={false}
    >
      <div className="tc-dialog__head">
        <p className="tc-dialog__eyebrow">Attendance exception</p>
        <h2 className="tc-dialog__title">Mark reviewed</h2>
        <p className="tc-dialog__sub">
          {exception.employeeName} · {exception.employeeCode} · {formatDate(exception.workDate)}
        </p>
      </div>

      <form
        className="hrp-dialog-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="tc-dialog__body">
          {error ? <FormAlert variant="error">{error}</FormAlert> : null}

          <p className="hrp-prose">
            This day has {what || 'something to review'}. Marking it reviewed records that you
            have looked at the evidence; the hours stay as they are. To change the hours, use
            Correct day instead.
          </p>

          <div className="field">
            <label className="field__label" htmlFor="hr-review-note">
              Note (optional)
            </label>
            <textarea
              id="hr-review-note"
              className="textarea tc-textarea--short"
              value={note}
              maxLength={500}
              aria-describedby="hr-review-note-hint"
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="field__hint" id="hr-review-note-hint">
              What you found, e.g. “Spoke to them — GPS was poor inside the warehouse.” Kept with
              the review in the audit log.
            </p>
          </div>
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving ? <ButtonSpinner /> : null}
            Mark reviewed
          </button>
        </div>
      </form>
    </Dialog>
  );
}
