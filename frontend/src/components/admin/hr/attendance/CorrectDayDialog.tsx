'use client';

import { useEffect, useRef, useState } from 'react';
import { ButtonSpinner, LoaderBlock } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { ApiError } from '@/lib/api';
import { formatDate, todayIso } from '@/lib/telecalling';
import {
  attendanceAdminApi,
  companyClock,
  minutesAsHours,
  peopleApi,
  type AttendanceDay,
  type AttendanceSession,
} from '@/lib/hr';
import { classifyWriteError, isAbort, useStableClose } from '../people/shared';

/**
 * Corrects one employee's day directly. ADMIN ONLY on the server.
 *
 * The day's sessions are REPLACED by the ones entered here — a correction states what the
 * day was, and keeping an original session beside a corrected one would count it twice.
 * The server marks the day "corrected by an administrator" with the reason as its note,
 * re-derives lateness and totals from the new sessions, and keeps the replaced sessions
 * in the audit row.
 *
 * Times are the company's wall clock (IST) on that date, whatever zone the browser is in;
 * the server converts them to UTC the same way an approved employee request does.
 */

const MAX_SESSIONS = 10;

type Row = {
  /** Stable React key; never sent. */
  key: number;
  startAt: string;
  /** '' means "still checked in" — allowed only for today's last session. */
  endAt: string;
  /** The system closed it because nobody checked out: the end time is not real. */
  autoClosed: boolean;
};

let nextKey = 1;

function rowsFrom(sessions: AttendanceSession[]): Row[] {
  return sessions.map((session) => ({
    key: nextKey++,
    startAt: companyClock(session.startedAt),
    // A system-closed session's end is the moment of the sweep, not when they left —
    // left blank so the administrator has to say when that was.
    endAt: session.autoClosed ? '' : companyClock(session.endedAt),
    autoClosed: session.autoClosed,
  }));
}

function blankRow(): Row {
  return { key: nextKey++, startAt: '', endAt: '', autoClosed: false };
}

function minutesOf(hhmm: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Field errors as the server keys them: `sessions.<index>.startAt` / `.endAt`. */
function validate(rows: Row[], reason: string, isToday: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const nowMinutes = minutesOf(companyClock(new Date().toISOString()));

  rows.forEach((row, index) => {
    const start = minutesOf(row.startAt);
    const end = row.endAt ? minutesOf(row.endAt) : null;
    if (start === null) errors[`sessions.${index}.startAt`] = 'Enter the check-in time.';
    if (row.endAt === '' && !(isToday && index === rows.length - 1)) {
      errors[`sessions.${index}.endAt`] = isToday
        ? 'Only the last session of today can still be running.'
        : 'Enter the check-out time.';
    }
    if (start !== null && end !== null && end <= start) {
      errors[`sessions.${index}.endAt`] = 'The check-out must be after the check-in.';
    }
    if (isToday && nowMinutes !== null) {
      if (start !== null && start > nowMinutes) {
        errors[`sessions.${index}.startAt`] = 'That time has not happened yet today.';
      }
      if (end !== null && end > nowMinutes) {
        errors[`sessions.${index}.endAt`] = 'That time has not happened yet today.';
      }
    }
  });

  // Overlaps, checked in time order like the server so the message lands on the later one.
  const ordered = rows
    .map((row, index) => ({ index, start: minutesOf(row.startAt), end: row.endAt ? minutesOf(row.endAt) : null }))
    .filter((row) => row.start !== null)
    .sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  ordered.forEach((row, position) => {
    const previous = ordered[position - 1];
    if (!previous) return;
    if (previous.end === null || (row.start ?? 0) < previous.end) {
      errors[`sessions.${row.index}.startAt`] ??= 'Sessions cannot overlap.';
    }
  });

  const trimmed = reason.trim();
  if (trimmed.length < 5) errors.reason = 'Say why this day is being corrected (at least 5 characters).';
  if (trimmed.length > 500) errors.reason = 'Keep the reason to 500 characters or fewer.';

  return errors;
}

export function CorrectDayDialog({
  employee,
  date,
  day,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  employee: { userId: number; name: string; employeeCode: string };
  /** `YYYY-MM-DD`, the company date being corrected. */
  date: string;
  /**
   * The day as already loaded, when the caller has it. Without it the dialog reads the
   * day itself, so the current sessions are what the form starts from.
   */
  day?: AttendanceDay | null;
  onClose: () => void;
  onSaved: (day: AttendanceDay | null, message: string) => void;
  onUnauthorized: () => void;
}) {
  const close = useStableClose(onClose);
  const isToday = date === todayIso();

  const [rows, setRows] = useState<Row[] | null>(
    day === undefined ? null : day && day.sessions.length > 0 ? rowsFrom(day.sessions) : [blankRow()],
  );
  const [original, setOriginal] = useState<AttendanceDay | null>(day ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const inputs = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    if (day !== undefined) return undefined;
    const controller = new AbortController();

    peopleApi
      .employeeAttendance(employee.userId, { from: date, to: date, page: 1, pageSize: 1 }, controller.signal)
      .then((result) => {
        const found = result.items[0] ?? null;
        setOriginal(found);
        setRows(found && found.sessions.length > 0 ? rowsFrom(found.sessions) : [blankRow()]);
      })
      .catch((caught: unknown) => {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
        setLoadError(
          caught instanceof ApiError ? caught.message : 'Could not load the day’s sessions.',
        );
        // The form still works from a blank session: the correction replaces them anyway.
        setRows([blankRow()]);
      });

    return () => controller.abort();
  }, [day, employee.userId, date, onUnauthorized]);

  useEffect(() => {
    if (!focusNext.current) return;
    const target = inputs.current.get(focusNext.current);
    focusNext.current = null;
    target?.focus();
  });

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => (current ?? []).map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addRow = () => {
    const row = blankRow();
    focusNext.current = `${row.key}-start`;
    setRows((current) => [...(current ?? []), row]);
  };

  const removeRow = (key: number) => {
    setRows((current) => {
      const next = (current ?? []).filter((row) => row.key !== key);
      return next.length > 0 ? next : [blankRow()];
    });
    window.setTimeout(() => addButton.current?.focus(), 0);
  };

  const total = (rows ?? []).reduce((sum, row) => {
    const start = minutesOf(row.startAt);
    const end = row.endAt ? minutesOf(row.endAt) : null;
    return start !== null && end !== null && end > start ? sum + (end - start) : sum;
  }, 0);

  const submit = async () => {
    if (!rows) return;
    setBanner(null);

    const local = validate(rows, reason, isToday);
    setErrors(local);
    if (Object.keys(local).length > 0) {
      setBanner('Check the highlighted times.');
      return;
    }

    setSaving(true);
    try {
      const saved = await attendanceAdminApi.correctDay(employee.userId, date, {
        sessions: rows.map((row) => ({ startAt: row.startAt, endAt: row.endAt || null })),
        reason: reason.trim(),
      });
      onSaved(
        saved,
        `${employee.name}’s attendance for ${formatDate(date)} was corrected${
          saved?.workedMinutes !== null && saved?.workedMinutes !== undefined
            ? ` — ${minutesAsHours(saved.workedMinutes)} worked`
            : ''
        }.`,
      );
    } catch (caught) {
      const outcome = classifyWriteError(caught);
      if (outcome.unauthorized) return onUnauthorized();
      if (outcome.forbidden) {
        setBanner('Only an administrator can correct attendance.');
        return;
      }
      setErrors(outcome.fields);
      // Messages with no input of their own — the day, the list as a whole — go up top.
      const general = [outcome.fields.sessions, outcome.fields.date, outcome.fields.form].filter(
        (message): message is string => Boolean(message),
      );
      setBanner(general.length > 0 ? general.join(' ') : outcome.message);
    } finally {
      setSaving(false);
    }
  };

  const errorFor = (index: number, field: 'startAt' | 'endAt') => errors[`sessions.${index}.${field}`];

  return (
    <Dialog
      open
      onClose={close}
      title="Correct attendance"
      label={`Correct ${employee.name}’s attendance for ${formatDate(date)}`}
      className="tc-dialog"
      dismissOnBackdrop={false}
    >
      <div className="tc-dialog__head">
        <p className="tc-dialog__eyebrow">Correct attendance</p>
        <h2 className="tc-dialog__title">
          {employee.name} · {formatDate(date)}
        </h2>
        <p className="tc-dialog__sub">{employee.employeeCode}</p>
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
          {banner ? <FormAlert variant="error">{banner}</FormAlert> : null}
          {loadError ? <FormAlert variant="info">{loadError} Start from the times below.</FormAlert> : null}

          {rows === null ? (
            <LoaderBlock label="Loading the day…" minHeight="8rem" />
          ) : (
            <>
              <section className="tc-dialog__section" aria-labelledby="hr-correct-sessions">
                <h3 className="tc-dialog__section-title" id="hr-correct-sessions">
                  Sessions
                </h3>
                <p className="tc-dialog__note">
                  Check-in and check-out pairs, India Standard Time.{' '}
                  {original && original.sessions.length > 0
                    ? `These replace the ${original.sessions.length} ${
                        original.sessions.length === 1 ? 'session' : 'sessions'
                      } recorded now.`
                    : 'Nothing is recorded for this day yet.'}
                  {isToday ? ' Leave today’s last check-out empty if they are still in.' : ''}
                </p>

                <ol className="hrp-sessions">
                  {rows.map((row, index) => {
                    const startError = errorFor(index, 'startAt');
                    const endError = errorFor(index, 'endAt');
                    const startId = `hr-correct-${row.key}-start`;
                    const endId = `hr-correct-${row.key}-end`;
                    return (
                      <li key={row.key} className="hrp-sessions__row">
                        <span className="hrp-sessions__label">Session {index + 1}</span>
                        <div className={`field${startError ? ' field--invalid' : ''}`}>
                          <label className="field__label" htmlFor={startId}>
                            Check-in
                          </label>
                          <input
                            ref={(element) => {
                              if (element) inputs.current.set(`${row.key}-start`, element);
                              else inputs.current.delete(`${row.key}-start`);
                            }}
                            id={startId}
                            className="input"
                            type="time"
                            value={row.startAt}
                            aria-invalid={startError ? true : undefined}
                            aria-describedby={startError ? `${startId}-error` : undefined}
                            onChange={(event) => update(row.key, { startAt: event.target.value })}
                          />
                          {startError ? (
                            <p className="field__error" id={`${startId}-error`} role="alert">
                              {startError}
                            </p>
                          ) : null}
                        </div>
                        <div className={`field${endError ? ' field--invalid' : ''}`}>
                          <label className="field__label" htmlFor={endId}>
                            Check-out
                          </label>
                          <input
                            id={endId}
                            className="input"
                            type="time"
                            value={row.endAt}
                            aria-invalid={endError ? true : undefined}
                            aria-describedby={
                              endError ? `${endId}-error` : row.autoClosed ? `${endId}-hint` : undefined
                            }
                            onChange={(event) => update(row.key, { endAt: event.target.value })}
                          />
                          {endError ? (
                            <p className="field__error" id={`${endId}-error`} role="alert">
                              {endError}
                            </p>
                          ) : row.autoClosed && !row.endAt ? (
                            <p className="field__hint" id={`${endId}-hint`}>
                              Never recorded — the system closed it. Enter when they left.
                            </p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm hrp-sessions__remove"
                          onClick={() => removeRow(row.key)}
                          disabled={rows.length === 1}
                          aria-label={`Remove session ${index + 1}`}
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ol>

                <div className="hrp-sessions__foot">
                  <button
                    ref={addButton}
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={addRow}
                    disabled={rows.length >= MAX_SESSIONS}
                  >
                    Add a session
                  </button>
                  <span className="tc-muted" aria-live="polite">
                    {total > 0 ? `${minutesAsHours(total)} across the closed sessions` : ''}
                  </span>
                </div>
              </section>

              <section className="tc-dialog__section">
                <div className={`field${errors.reason ? ' field--invalid' : ''}`}>
                  <label className="field__label" htmlFor="hr-correct-reason">
                    Reason
                    <span className="field__required" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <textarea
                    id="hr-correct-reason"
                    className="textarea tc-textarea--short"
                    value={reason}
                    maxLength={500}
                    required
                    aria-invalid={errors.reason ? true : undefined}
                    aria-describedby={errors.reason ? 'hr-correct-reason-error' : 'hr-correct-reason-hint'}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  {errors.reason ? (
                    <p className="field__error" id="hr-correct-reason-error" role="alert">
                      {errors.reason}
                    </p>
                  ) : (
                    <p className="field__hint" id="hr-correct-reason-hint">
                      Kept as the day’s note and in the audit log, with the sessions this replaces.
                    </p>
                  )}
                </div>
              </section>
            </>
          )}
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving || rows === null}
            aria-busy={saving || undefined}
          >
            {saving ? <ButtonSpinner /> : null}
            Save correction
          </button>
        </div>
      </form>
    </Dialog>
  );
}
