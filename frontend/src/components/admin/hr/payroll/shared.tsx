'use client';

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

/** "1 employee" / "6 employees". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-IN')} ${count === 1 ? singular : pluralForm}`;
}
