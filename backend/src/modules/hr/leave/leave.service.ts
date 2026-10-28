import { query, withTransaction, type RowDataPacket } from '../../../db/pool';
import { HttpError, badRequest, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import type { Reviewer } from '../attendance/regularisation.service';
import {
  companyToday,
  countLeaveDays,
  daysBetween,
  type HalfDay,
  type LeaveDayCount,
} from '../calendar/calendar.service';
import { notifyHr } from '../notifications/hrNotifications.repository';
import { getHrSettings } from '../settings/hrSettings';
import { compOffUseBy, earns, freeCompOffDays, workedOffDay, type WorkedOffDay } from './compOff.service';
import {
  allocationsFor,
  claimedCompOffDays,
  findLeaveType,
  findOverlap,
  findRequestByClientKey,
  findRequestRow,
  insertRequest,
  listLeaveTypes,
  lockEmployee,
  markCancelled,
  markDecision,
  nextApprovedRow,
  countPendingRequests,
  roundDays,
  toLeaveRequest,
  usageFor,
  type Db,
  type LeaveRequestRow,
} from './leave.repository';
import {
  LEAVE_RULES,
  type LeaveBalance,
  type LeaveBalanceWithAllocation,
  type LeaveRequest,
  type LeaveType,
} from './leave.schema';

/**
 * Leave: balances, applying, deciding and withdrawing.
 *
 * THE BALANCE IS DERIVED, NEVER STORED (migration 028). Entitlement — the person's
 * allocation for the year, else the type's annual quota — minus approved days, minus
 * pending days, computed whenever it is asked for. A cancelled or re-decided request
 * therefore cannot leave a balance that disagrees with the requests behind it.
 *
 * THE DAY COUNT COMES FROM THE CALENDAR. `countLeaveDays` is the same classifier the
 * attendance month view and payroll use, so a request, a payslip and a report can never
 * disagree about whether the 14th was a working day.
 *
 * Refusals are thrown as `HttpError`s with copy written for the employee — they render
 * verbatim in the app.
 */

/* -------------------------------------------------------------------------- */
/* Copy helpers                                                                */
/* -------------------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-19` → `19 Oct 2026`. Built by hand: the server's locale is not the reader's. */
export function humanDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

export function humanRange(start: string, end: string): string {
  return start === end ? humanDate(start) : `${humanDate(start)} – ${humanDate(end)}`;
}

/** `1` → `1 day`, `0.5` → `0.5 days`, `2` → `2 days`. */
export function dayCount(days: number): string {
  const value = roundDays(days);
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} ${value === 1 ? 'day' : 'days'}`;
}

function halfLabel(halfDay: HalfDay): string {
  return halfDay === 'first_half' ? ' (first half)' : halfDay === 'second_half' ? ' (second half)' : '';
}

/** `450` → `7h 30m`, `480` → `8h`. */
function hoursText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** ` for working on 5 Oct 2026`, for a compensatory leave's notifications. */
function earnedLabel(earnedOn: string | null): string {
  return earnedOn ? ` for working on ${humanDate(earnedOn)}` : '';
}

/* -------------------------------------------------------------------------- */
/* Balances                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The entitlement that applies, or null for an untracked type.
 *
 * Only real leave has a balance. Work from home and field work are arrangements, not
 * time off, and are never counted against anything — whatever quota a type row carries.
 */
function entitlementFor(type: LeaveType, allocation: { days: number } | undefined): number | null {
  if (type.kind !== 'leave') return null;
  if (allocation) return allocation.days;
  return type.annualQuota;
}

/**
 * COMPENSATORY LEAVE HAS NO QUOTA. Its `available` is the worked weekly offs and holidays
 * still free to use (`freeCompOffDays`); `used` and `pending` are the year's requests like
 * any type's; and `entitled` is the three together — every day earned that is used,
 * asked for, or still usable — so `entitled - used - pending = available` holds for it
 * as it does for every other balance.
 */
async function computeBalances(
  userId: number,
  year: number,
  types: LeaveType[],
  db?: Db,
): Promise<LeaveBalanceWithAllocation[]> {
  const allocations = await allocationsFor(userId, year, db);
  const usage = await usageFor(userId, year, db);
  const free = types.some((type) => type.isCompOff) ? (await freeCompOffDays(userId, db)).length : 0;

  return types.map((type) => {
    if (type.isCompOff) {
      const { used, pending } = usage.get(type.id) ?? { used: 0, pending: 0 };
      return {
        leaveType: type,
        year,
        tracked: true,
        entitled: roundDays(used + pending + free),
        used,
        pending,
        available: free,
        allocation: null,
      };
    }
    const allocation = type.kind === 'leave' ? allocations.get(type.id) : undefined;
    const entitled = entitlementFor(type, allocation);
    const { used, pending } = usage.get(type.id) ?? { used: 0, pending: 0 };
    const tracked = entitled !== null;
    return {
      leaveType: type,
      year,
      tracked,
      entitled,
      used,
      pending,
      // May be negative if HR lowered an allocation below what was already approved.
      // That is the truth about the account, so it is reported rather than clamped.
      available: tracked ? roundDays(entitled - used - pending) : null,
      allocation: allocation ?? null,
    };
  });
}

/**
 * The employee's balance for every ACTIVE leave type (kind 'leave') in `year`.
 *
 * Exported for the dashboard. Untracked types are included with `tracked: false` and null
 * `entitled` / `available`; a caller that wants only real balances filters on `tracked`.
 */
export async function balancesFor(userId: number, year: number): Promise<LeaveBalance[]> {
  const types = await listLeaveTypes({ activeOnly: true, kind: 'leave' });
  const balances = await computeBalances(userId, year, types);
  return balances.map(({ allocation: _allocation, ...balance }) => balance);
}

/** The admin view: the same balances, each with the per-person override behind it. */
export async function balancesWithAllocationsFor(
  userId: number,
  year: number,
  types?: LeaveType[],
): Promise<LeaveBalanceWithAllocation[]> {
  return computeBalances(userId, year, types ?? (await listLeaveTypes({ activeOnly: true, kind: 'leave' })));
}

/** How many of the employee's own requests are waiting for a decision. For the dashboard. */
export async function pendingLeaveCount(userId: number): Promise<number> {
  return countPendingRequests({ userId });
}

/** The next approved leave, wfh or field day that has not ended, or null. For the dashboard. */
export async function nextApprovedLeave(
  userId: number,
): Promise<{ id: number; startDate: string; endDate: string; typeName: string; kind: LeaveType['kind'] } | null> {
  const row = await nextApprovedRow(userId);
  if (!row) return null;
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    typeName: row.type_name,
    kind: row.type_kind,
  };
}

export async function findLeaveRequest(id: number): Promise<LeaveRequest | null> {
  const row = await findRequestRow(id);
  return row ? toLeaveRequest(row) : null;
}

/* -------------------------------------------------------------------------- */
/* The rules                                                                   */
/* -------------------------------------------------------------------------- */

type Problem = {
  field: 'leaveTypeId' | 'startDate' | 'endDate' | 'halfDay' | 'compOffEarnedOn' | 'form';
  message: string;
};

type DraftRequest = {
  leaveTypeId: number;
  startDate: string;
  endDate: string;
  halfDay: HalfDay;
  /** Compensatory leave only; ignored for every other type. */
  compOffEarnedOn?: string | null;
};

type StaticAssessment = {
  type: LeaveType | null;
  count: LeaveDayCount;
  problems: Problem[];
};

/** Says, in plain words, why a range costs nothing. */
function nothingToApplyFor(start: string, end: string, count: LeaveDayCount): string {
  const phrases: string[] = [];
  const reasons = new Set(count.excluded.map((entry) => entry.reason));
  if (reasons.has('weekly_off')) phrases.push('a weekly off');
  if (reasons.has('holiday')) phrases.push('a holiday');
  if (reasons.has('not_employed')) phrases.push('outside your employment dates');
  const list =
    phrases.length <= 1 ? (phrases[0] ?? 'not a working day') : `${phrases.slice(0, -1).join(', ')} or ${phrases.at(-1)}`;

  if (start === end) {
    const holiday = count.excluded.find((entry) => entry.reason === 'holiday')?.name;
    return `${humanDate(start)} is ${list}${holiday ? ` (${holiday})` : ''}, so there is nothing to apply for.`;
  }
  return `Every date from ${humanRange(start, end)} is ${list}, so there is nothing to apply for.`;
}

/**
 * Why a day worked does not earn compensatory leave, or null when it does. Worded for
 * either reader — the employee applying, or the administrator approving.
 */
function whyNotEarned(day: WorkedOffDay): string | null {
  const date = humanDate(day.date);
  if (day.reason === null) return `${date} was a working day, so it does not earn compensatory leave.`;
  if (day.date >= companyToday()) return `${date} is not over yet, so its hours are not final.`;
  if (day.workedMinutes === null) {
    return `There is no finished attendance on ${date} (no check-in, or no check-out). An attendance correction comes first.`;
  }
  if (day.requiredMinutes === null) {
    return `${date} was worked without a shift, so there is no full day to measure it against. Please contact HR.`;
  }
  if (!day.over) return `The shift worked on ${date} has not ended yet, so its hours are not final.`;
  if (!earns(day)) {
    return `${hoursText(day.workedMinutes)} was worked on ${date}. Compensatory leave needs a full day on the shift: ${hoursText(
      day.requiredMinutes,
    )}.`;
  }
  return null;
}

/**
 * The compensatory leave rules that need no lock: the day worked is named and earned it,
 * and the day off is one whole day after it and within the validity. Whether the day
 * worked is still unclaimed is `assessState`'s question, asked under the lock. (Half days
 * are refused by the type's `allowHalfDay`, which the migration sets off for good.)
 */
async function compOffProblems(userId: number, draft: DraftRequest, today: string): Promise<Problem[]> {
  const earnedOn = draft.compOffEarnedOn ?? null;
  if (!earnedOn) return [{ field: 'compOffEarnedOn', message: 'Choose the weekly off or holiday you worked.' }];

  const problems: Problem[] = [];
  if (draft.startDate !== draft.endDate) {
    problems.push({
      field: 'endDate',
      message: 'Compensatory leave is one day for each day worked. Apply for each day separately.',
    });
  }

  const { compOffValidityDays } = await getHrSettings();
  const useBy = compOffUseBy(earnedOn, compOffValidityDays);
  if (useBy < today) {
    problems.push({
      field: 'compOffEarnedOn',
      message: `Compensatory leave for ${humanDate(earnedOn)} had to be taken by ${humanDate(useBy)}.`,
    });
    return problems;
  }

  const why = whyNotEarned(await workedOffDay(userId, earnedOn));
  if (why) {
    problems.push({ field: 'compOffEarnedOn', message: why });
  } else if (draft.startDate <= earnedOn) {
    problems.push({
      field: 'startDate',
      message: `Compensatory leave is taken after the day worked. Choose a date after ${humanDate(earnedOn)}.`,
    });
  } else if (draft.startDate > useBy) {
    problems.push({
      field: 'startDate',
      message: `Compensatory leave for ${humanDate(earnedOn)} must be taken by ${humanDate(useBy)}.`,
    });
  }
  return problems;
}

/**
 * The checks that need no lock: the type, the dates, the half-day rule, and the day
 * count. Every problem is collected rather than stopping at the first, so the preview
 * can show them all at once.
 */
async function assessStatic(userId: number, draft: DraftRequest): Promise<StaticAssessment> {
  const problems: Problem[] = [];
  const { startDate: start, endDate: end, halfDay } = draft;
  const today = companyToday();

  const type = await findLeaveType(draft.leaveTypeId);
  if (!type || !type.isActive) {
    problems.push({ field: 'leaveTypeId', message: 'Choose a leave type from the list.' });
  }

  const span = daysBetween(start, end) + 1;
  if (end < start) {
    problems.push({ field: 'endDate', message: 'The end date cannot be before the start date.' });
  } else {
    if (span > LEAVE_RULES.maxSpanDays) {
      problems.push({
        field: 'endDate',
        message: `One request can cover at most ${LEAVE_RULES.maxSpanDays} days. Split longer leave into separate requests.`,
      });
    }
    /*
     * One year per request, because a balance is a calendar year's: a request from
     * 28 December to 3 January would otherwise be charged entirely to the old year.
     */
    if (start.slice(0, 4) !== end.slice(0, 4)) {
      problems.push({ field: 'endDate', message: 'Apply for each year separately.' });
    }
  }

  if (daysBetween(start, today) > LEAVE_RULES.maxBackdateDays) {
    problems.push({
      field: 'startDate',
      message: `Leave can be applied for at most ${LEAVE_RULES.maxBackdateDays} days back. Please contact HR for anything older.`,
    });
  }
  if (daysBetween(today, start) > LEAVE_RULES.maxAheadDays) {
    problems.push({ field: 'startDate', message: 'Leave can be applied for at most a year ahead.' });
  }

  if (halfDay !== 'none') {
    if (start !== end) {
      problems.push({ field: 'halfDay', message: 'A half day must start and end on the same date.' });
    } else if (type && !type.allowHalfDay) {
      problems.push({ field: 'halfDay', message: `${type.name} cannot be taken as a half day.` });
    }
  }

  if (type?.isCompOff) problems.push(...(await compOffProblems(userId, draft, today)));

  // Only counted for a range the calendar can walk; the problems above already explain
  // anything else.
  let count: LeaveDayCount = { days: 0, excluded: [] };
  if (end >= start && span <= LEAVE_RULES.maxSpanDays) {
    count = await countLeaveDays(userId, start, end, halfDay);
    if (count.days === 0) {
      problems.push({ field: 'startDate', message: nothingToApplyFor(start, end, count) });
    }
  }

  return { type, count, problems };
}

type StateAssessment = {
  problems: Problem[];
  tracked: boolean;
  /** Before this request. Null when untracked. */
  available: number | null;
};

/**
 * The checks that depend on what else exists — other requests and the balance. Inside an
 * application these run on the locked connection; the preview runs them on the pool.
 */
async function assessState(
  db: Db,
  userId: number,
  type: LeaveType,
  draft: DraftRequest,
  days: number,
): Promise<StateAssessment> {
  const problems: Problem[] = [];

  const overlap = await findOverlap(db, userId, draft.startDate, draft.endDate, draft.halfDay);
  if (overlap) {
    problems.push({
      field: 'startDate',
      message: `This overlaps your ${overlap.status} ${overlap.type_name} request for ${humanRange(
        overlap.start_date,
        overlap.end_date,
      )}${halfLabel(overlap.half_day)}.`,
    });
  }

  // Compensatory leave's balance is the days worked and not yet used; what matters is
  // that THIS day worked is one of them. Read under the lock, so two requests sent at once
  // cannot both name it (the unique key on `comp_off_claim` is the last word if they do).
  if (type.isCompOff) {
    const earnedOn = draft.compOffEarnedOn ?? null;
    const free = await freeCompOffDays(userId, db);
    if (earnedOn) {
      const claimed = await claimedCompOffDays(db, userId, earnedOn, earnedOn);
      if (claimed.has(earnedOn)) {
        problems.push({
          field: 'compOffEarnedOn',
          message: `${humanDate(earnedOn)} has already been used for compensatory leave.`,
        });
      }
    }
    return { problems, tracked: true, available: free.length };
  }

  const year = Number(draft.startDate.slice(0, 4));
  const [balance] = await computeBalances(userId, year, [type], db);
  const tracked = balance?.tracked ?? false;
  const available = balance?.available ?? null;

  // Pending requests count against what is left, so two applications cannot together
  // promise days that only one of them can have.
  if (tracked && available !== null && days > 0 && roundDays(available - days) < 0) {
    problems.push({
      field: 'form',
      message: `You have ${dayCount(Math.max(0, available))} of ${type.name} left.`,
    });
  }

  return { problems, tracked, available };
}

function refusal(problems: Problem[]): HttpError {
  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem.field !== 'form' && !fieldErrors[problem.field]) fieldErrors[problem.field] = problem.message;
  }
  return new HttpError(400, problems[0]?.message ?? 'That request cannot be made.', {
    code: 'bad_request',
    fieldErrors,
    details: { problems: problems.map((problem) => problem.message) },
  });
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

export type LeavePreview = {
  days: number;
  excluded: LeaveDayCount['excluded'];
  tracked: boolean;
  /** What would be left after this request, or null for an untracked type. */
  balanceAfter: number | null;
  /** Every reason the application would be refused. Empty means it would be accepted. */
  problems: string[];
};

/**
 * The same checks as an application, reported rather than thrown, so the app can say
 * "3 working days · 2 left after this" — or exactly what is wrong — before submitting.
 */
export async function previewLeave(userId: number, draft: DraftRequest): Promise<LeavePreview> {
  const assessment = await assessStatic(userId, draft);
  const problems = [...assessment.problems];

  let tracked = false;
  let balanceAfter: number | null = null;

  if (assessment.type) {
    const state = await assessState(null, userId, assessment.type, draft, assessment.count.days);
    problems.push(...state.problems);
    tracked = state.tracked;
    balanceAfter = state.available === null ? null : roundDays(state.available - assessment.count.days);
  }

  return {
    days: assessment.count.days,
    excluded: assessment.count.excluded,
    tracked,
    balanceAfter,
    problems: problems.map((problem) => problem.message),
  };
}

/* -------------------------------------------------------------------------- */
/* Applying                                                                    */
/* -------------------------------------------------------------------------- */

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/** The duplicate was on the compensatory leave claim, not on the client key. */
function isDuplicateClaim(error: unknown): boolean {
  return isDuplicateKey(error) && String((error as { message?: string }).message).includes('uq_hr_leave_requests_comp_off');
}

/**
 * Compensatory leave is decided by HR administrators, not by the employee's manager — so
 * they are told when one is asked for. The admin portal's queue shows it as well.
 */
async function hrAdminIds(exceptUserId: number): Promise<number[]> {
  const rows = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM hr_users
      WHERE role = 'hr_admin' AND is_active = 1 AND approval_status = 'approved'
        AND deleted_at IS NULL AND id <> ?
      ORDER BY id ASC
      LIMIT 50`,
    [exceptUserId],
  );
  return rows.map((row) => row.id);
}

export type ApplyResult = { request: LeaveRequest; deduplicated: boolean };

/**
 * Raises a request.
 *
 * ORDER MATTERS:
 *
 *   1. The client key first. A retry of a request that already succeeded must get that
 *      request back — not "this overlaps your pending request", which is what every
 *      other check would now say about it.
 *   2. The static checks, with no lock held.
 *   3. In ONE transaction that first locks the employee's row: the client key again (a
 *      concurrent retry may have committed while this waited), the overlap and balance
 *      checks, and the insert. Two applications at once therefore cannot both pass on
 *      the same remaining days.
 */
export async function applyForLeave(
  userId: number,
  input: DraftRequest & { reason: string; clientKey: string },
): Promise<ApplyResult> {
  const replay = await findRequestByClientKey(userId, input.clientKey);
  if (replay) return { request: toLeaveRequest(replay), deduplicated: true };

  const assessment = await assessStatic(userId, input);
  if (assessment.problems.length > 0 || !assessment.type) throw refusal(assessment.problems);
  const type = assessment.type;
  const days = assessment.count.days;
  const compOffEarnedOn = type.isCompOff ? (input.compOffEarnedOn ?? null) : null;

  let outcome: { id: number; deduplicated: boolean };
  try {
    outcome = await withTransaction(async (connection) => {
      const exists = await lockEmployee(connection, userId);
      if (!exists) throw notFound('Your account could not be found. Please sign in again.');

      const raced = await findRequestByClientKey(userId, input.clientKey, connection);
      if (raced) return { id: raced.id, deduplicated: true };

      const state = await assessState(connection, userId, type, input, days);
      if (state.problems.length > 0) throw refusal(state.problems);

      const id = await insertRequest(connection, {
        userId,
        leaveTypeId: type.id,
        startDate: input.startDate,
        endDate: input.endDate,
        halfDay: input.halfDay,
        days,
        reason: input.reason,
        clientKey: input.clientKey,
        compOffEarnedOn,
      });
      return { id, deduplicated: false };
    });
  } catch (error) {
    if (isDuplicateClaim(error) && compOffEarnedOn) {
      throw refusal([
        { field: 'compOffEarnedOn', message: `${humanDate(compOffEarnedOn)} has already been used for compensatory leave.` },
      ]);
    }
    // The unique (user, client_key) key is the last word on a replay that raced past
    // both reads above.
    if (isDuplicateKey(error)) {
      const winner = await findRequestByClientKey(userId, input.clientKey);
      if (winner) return { request: toLeaveRequest(winner), deduplicated: true };
    }
    throw error;
  }

  const row = (await findRequestRow(outcome.id))!;
  if (!outcome.deduplicated) {
    logger.info('HR leave requested', { userId, id: outcome.id, type: type.code, days });
    if (type.isCompOff) {
      await notifyHr({
        userIds: await hrAdminIds(userId),
        kind: 'leave_submitted',
        title: `${type.name} request from ${row.employee_name}`,
        body: `${humanDate(row.start_date)}${earnedLabel(row.comp_off_earned_on)}. Waiting for an HR administrator's decision.`,
        entityType: 'leave_request',
        entityId: row.id,
      });
    } else if (row.manager_id) {
      await notifyHr({
        userIds: [row.manager_id],
        kind: 'leave_submitted',
        title: `${type.name} request from ${row.employee_name}`,
        body: `${humanRange(row.start_date, row.end_date)}${halfLabel(row.half_day)} · ${dayCount(days)}. Waiting for your decision.`,
        entityType: 'leave_request',
        entityId: row.id,
      });
    }
  }
  return { request: toLeaveRequest(row), deduplicated: outcome.deduplicated };
}

/* -------------------------------------------------------------------------- */
/* Withdrawing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The employee withdraws their own request: any pending one, or an approved one that
 * has not started. Leave already begun is HR's to adjust — it may already be on a
 * payslip — so the app sends them there rather than rewriting history.
 */
export async function cancelLeave(userId: number, id: number): Promise<LeaveRequest> {
  const current = await findRequestRow(id);
  if (!current || current.user_id !== userId) throw notFound('Leave request not found.');

  const was = await markCancelled(id, userId);
  const after = (await findRequestRow(id))!;

  if (!was) {
    if (after.status === 'cancelled') throw badRequest('That request is already cancelled.');
    if (after.status === 'approved') {
      throw badRequest('This leave has already started, so it can no longer be cancelled here. Please contact HR.');
    }
    throw badRequest('That request has already been decided.');
  }

  logger.info('HR leave cancelled', { userId, id, was });

  // The manager who approved it is planning around it; a pending one simply leaves
  // their queue.
  if (was === 'approved' && after.manager_id) {
    await notifyHr({
      userIds: [after.manager_id],
      kind: 'leave_cancelled',
      title: `${after.employee_name} cancelled approved ${after.type_name}`,
      body: `${humanRange(after.start_date, after.end_date)}${halfLabel(after.half_day)} is no longer booked off.`,
      entityType: 'leave_request',
      entityId: id,
    });
  }

  return toLeaveRequest(after);
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Approves or rejects a pending request. Shared by the admin portal and team managers;
 * WHO may decide is the caller's check, this enforces only the rules of the decision.
 *
 * Approval re-checks the balance, inside a transaction holding the employee's row lock:
 * the entitlement may have been lowered since the request was raised, or another
 * request approved in the meantime, and an approval must never take approved days past
 * the entitlement. Other PENDING requests are not counted here — they have not been
 * granted, and each faces this same check when it is.
 *
 * Both outcomes are guarded `WHERE status = 'pending'`, so two deciders cannot both win;
 * the loser is told the request has already been decided.
 */
export async function decideLeave(
  id: number,
  decision: 'approve' | 'reject',
  reviewer: Reviewer,
  note: string | null,
): Promise<LeaveRequest> {
  const current = await findRequestRow(id);
  if (!current) throw notFound('Leave request not found.');

  if (decision === 'approve') {
    await withTransaction(async (connection) => {
      await lockEmployee(connection, current.user_id);

      const row = await findRequestRow(id, connection);
      if (!row || row.status !== 'pending') throw badRequest('That request has already been decided.');

      const type = await findLeaveType(row.leave_type_id, connection);
      if (type?.isCompOff) {
        /*
         * The day worked must still have earned it: its attendance may have been corrected
         * since. Its lapse is not re-checked — the request was raised in time, and the day
         * off was checked to fall within the validity then.
         */
        const why = row.comp_off_earned_on
          ? whyNotEarned(await workedOffDay(row.user_id, row.comp_off_earned_on))
          : 'The request does not say which weekly off or holiday was worked.';
        if (why) throw badRequest(`This cannot be approved. ${why}`);
      } else if (type) {
        const year = Number(row.start_date.slice(0, 4));
        const [balance] = await computeBalances(row.user_id, year, [type], connection);
        if (balance?.tracked && balance.entitled !== null) {
          const days = roundDays(Number(row.days));
          const left = roundDays(balance.entitled - balance.used);
          if (roundDays(left - days) < 0) {
            throw badRequest(
              `Approving this would take ${row.employee_name} past their ${type.name} entitlement: ${dayCount(
                Math.max(0, left),
              )} left of ${dayCount(balance.entitled)}, and this request is ${dayCount(days)}.`,
            );
          }
        }
      }

      const moved = await markDecision(connection, id, 'approved', reviewer, note);
      if (!moved) throw badRequest('That request has already been decided.');
    });
  } else {
    const moved = await markDecision(null, id, 'rejected', reviewer, note);
    if (!moved) throw badRequest('That request has already been decided.');
  }

  const after = (await findRequestRow(id))!;
  const range = `${humanRange(after.start_date, after.end_date)}${halfLabel(after.half_day)}${earnedLabel(
    after.comp_off_earned_on,
  )}`;

  await notifyHr({
    userIds: [after.user_id],
    kind: decision === 'approve' ? 'leave_approved' : 'leave_rejected',
    title: decision === 'approve' ? `${after.type_name} approved` : `${after.type_name} not approved`,
    body:
      decision === 'approve'
        ? `Your request for ${range} was approved${note ? `: ${note}` : '.'}`
        : `Your request for ${range} was not approved${note ? `: ${note}` : '.'}`,
    entityType: 'leave_request',
    entityId: id,
  });

  logger.info(`HR leave ${decision === 'approve' ? 'approved' : 'rejected'}`, {
    id,
    userId: after.user_id,
    reviewerType: reviewer.type,
  });

  return toLeaveRequest(after);
}

/** The raw row, for callers (team routes) that need the owner before deciding. */
export async function findLeaveRequestRow(id: number): Promise<LeaveRequestRow | null> {
  return findRequestRow(id);
}
