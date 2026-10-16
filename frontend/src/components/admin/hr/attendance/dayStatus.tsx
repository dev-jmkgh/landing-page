'use client';

import { Tag } from '@/components/admin/telecalling/shared';
import {
  ATTENDANCE_SOURCE_LABELS,
  ATTENDANCE_STATUS_LABELS,
  DAY_STATUS_LABELS,
  DAY_STATUS_TONE,
  PUNCH_FLAG_HINTS,
  PUNCH_FLAG_LABELS,
  type AttendanceSource,
  type AttendanceStatus,
  type CalendarDayStatus,
  type PunchFlag,
} from '@/lib/hr';

/**
 * How a day reads, on every HR attendance screen: the register, an employee's history
 * and calendar, the exceptions queue. One component so "Late" is the same colour and the
 * same word wherever it appears.
 */

const ATTENDANCE_TONE: Record<AttendanceStatus, 'good' | 'warn' | 'bad' | 'progress'> = {
  present: 'good',
  late: 'warn',
  half_day: 'warn',
  absent: 'bad',
  on_leave: 'progress',
};

/** The classifier's verdict for the day. */
export function DayStatusTag({ status }: { status: CalendarDayStatus }) {
  return <Tag tone={DAY_STATUS_TONE[status]}>{DAY_STATUS_LABELS[status]}</Tag>;
}

/** The attendance roll-up's own status, for a day that has a row. */
export function AttendanceStatusTag({ status }: { status: AttendanceStatus }) {
  return <Tag tone={ATTENDANCE_TONE[status]}>{ATTENDANCE_STATUS_LABELS[status]}</Tag>;
}

/**
 * The things about a day a reviewer should notice: a forgotten check-out the system
 * closed, a punch flagged for review, and a day somebody corrected.
 *
 * Words, not icons: "Missing punch" in a cell needs no legend, and a screen reader says
 * the same thing a sighted reader sees.
 */
export function DayMarkers({
  missingPunch,
  flagged,
  source,
}: {
  missingPunch: boolean;
  flagged: boolean;
  source?: AttendanceSource | null;
}) {
  if (!missingPunch && !flagged && (!source || source === 'app')) return null;

  return (
    <span className="hrp-markers">
      {missingPunch ? (
        <span title="Nobody checked out, so the system closed the session with no hours. A correction puts the real time in.">
          <Tag tone="bad">Missing punch</Tag>
        </span>
      ) : null}
      {flagged ? (
        <span title="A punch on this day was flagged — see Exceptions for why.">
          <Tag tone="warn">Flagged</Tag>
        </span>
      ) : null}
      {source && source !== 'app' ? (
        <span className="tc-muted">{ATTENDANCE_SOURCE_LABELS[source]}</span>
      ) : null}
    </span>
  );
}

/** Why a punch was flagged, one tag per reason, each with its explanation on hover. */
export function FlagTags({ flags }: { flags: PunchFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="hrp-markers">
      {flags.map((flag) => (
        <span key={flag} title={PUNCH_FLAG_HINTS[flag]}>
          <Tag tone="warn">{PUNCH_FLAG_LABELS[flag]}</Tag>
        </span>
      ))}
    </span>
  );
}
