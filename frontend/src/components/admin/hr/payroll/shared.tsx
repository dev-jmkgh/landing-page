'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { RUN_STAGE_LABELS, RUN_STAGE_TONE, runStage, runStageLabel, type PayrollRun } from '@/lib/hrPayroll';
import { Tag } from '../../telecalling/shared';

/**
 * Pieces shared by the payroll screens (pay periods, one period, salary structures).
 *
 * Kept to what at least two of them use; anything used once lives with its screen.
 */

/**
 * Where a pay period is — "Not calculated yet", "Calculated so far · to 16 Oct", "Ready
 * to approve", "Approved · published" — coloured the same way in the list and on the
 * period itself. Worked out from the run by `runStage`; the API status is unchanged.
 *
 * `compact` leaves the date off, for the list, whose status column says it on the line
 * beneath — a badge does not wrap, and the full label would push the column wide.
 */
export function RunStatusTag({ run, compact = false }: { run: PayrollRun; compact?: boolean }) {
  const stage = runStage(run);
  return <Tag tone={RUN_STAGE_TONE[stage]}>{compact ? RUN_STAGE_LABELS[stage] : runStageLabel(run)}</Tag>;
}

/**
 * A close handler whose identity never changes.
 *
 * `Dialog` re-runs its open effect — which moves focus to the panel — whenever `onClose`
 * changes identity. Every payroll dialog re-renders as it is used (a select changes, a
 * button goes busy), so an inline handler would pull focus out of the control being
 * used on every change. The latest handler lives in a ref and `Dialog` gets one stable
 * function. The same fix as `useStableClose` in the people screens.
 */
export function useStableClose(onClose: () => void): () => void {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  });
  return useCallback(() => ref.current(), []);
}

/** An aborted request is a request somebody replaced, not a failure to report. */
export function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

/**
 * How a failed READ is handled, in one place so every payroll list treats it the same.
 *
 * - 401: the session is gone — the shell signs out.
 * - 403: this account is not an administrator. Payroll is admin-only for reads too
 *   (salary is sensitive), so for a supervisor this is the expected answer, not a fault:
 *   the panel swaps to a calm "restricted" state instead of an error banner.
 *
 * Returns the message to show for anything else, or null when it was handled.
 *
 * Writes do NOT come through here. A 403 on a write is the CSRF check ("Your session
 * could not be verified…"), whose message is the useful thing to show — and an account
 * that reached a write has already passed the admin-only reads.
 */
export function readFailure(
  caught: unknown,
  handlers: { onUnauthorized: () => void; onRestricted: () => void },
  fallback: string,
): string | null {
  if (caught instanceof ApiError && caught.status === 401) {
    handlers.onUnauthorized();
    return null;
  }
  if (caught instanceof ApiError && caught.status === 403) {
    handlers.onRestricted();
    return null;
  }
  return caught instanceof ApiError ? caught.message : fallback;
}

/**
 * Shown instead of the panel to anyone below administrator.
 *
 * Deliberately not an error: nothing is broken, and there is nothing to retry. It says
 * plainly who can open payroll, so a supervisor knows whom to ask rather than reporting
 * a fault.
 */
export function RestrictedState() {
  return (
    <div className="table-wrap">
      <div className="empty-state" role="status">
        <span className="empty-state__icon" aria-hidden="true">
          <Icon name="shield" size={24} />
        </span>
        <p style={{ fontWeight: 600, color: 'var(--ink-700)' }}>
          Payroll is restricted to administrators.
        </p>
        <p>
          Salary structures, pay periods and payslips can only be opened by an administrator
          account. Ask an administrator if you need a figure from payroll.
        </p>
      </div>
    </div>
  );
}

/**
 * "Are you sure?" for the payroll actions that cannot be taken back — approving a run,
 * deleting one, deleting a structure, re-processing.
 *
 * On the shared `Dialog`, which traps Tab, closes on Escape and moves focus in on open.
 * What the shell does not do is give focus back when the dialog is closed by the PARENT
 * (Cancel, or the action finishing) rather than by its own close button, so this keeps
 * the element that opened it and returns focus there on unmount — if that element still
 * exists. After a delete it may not; the screen that remains moves focus itself.
 *
 * The opener is read during the first render, before the shell's effect moves focus into
 * the dialog: by the time any effect here ran, `activeElement` would be the dialog.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  danger = false,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  /** Styles the confirm button as destructive (delete). */
  danger?: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  // Restore focus when this unmounts, however it was closed.
  useRestoreFocus(opener);

  const close = useStableClose(() => {
    if (!busy) onCancel();
  });

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      className="tc-confirm-dialog"
      dismissOnBackdrop={!busy}
    >
      <div className="dialog__body">
        <h2 className="dialog__title tc-confirm-dialog__title">{title}</h2>
        <div className="hr-pay-confirm__text">{children}</div>

        {error ? (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <FormAlert variant="error">{error}</FormAlert>
          </div>
        ) : null}

        <div className="tc-confirm-dialog__actions">
          <button type="button" className="btn btn--outline" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn btn--primary hr-pay-btn--danger' : 'btn btn--primary'}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onConfirm}
          >
            {busy ? <ButtonSpinner /> : null}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Puts focus back on `element` when the calling component unmounts, if it is still in
 * the document. The element is fixed at the first render: it is "whoever opened me".
 *
 * Only when focus has nowhere better to be. If the screen moved focus on purpose as the
 * dialog closed — to a heading, because the button that opened it is about to disappear
 * (an approved run has no Approve button) — that choice stands.
 */
export function useRestoreFocus(element: HTMLElement | null) {
  const [target] = useState(element);
  useEffect(
    () => () => {
      window.setTimeout(() => {
        if (!target || !target.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        target.focus();
      }, 0);
    },
    [target],
  );
}

/** "1 employee" / "6 employees". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-IN')} ${count === 1 ? singular : pluralForm}`;
}
