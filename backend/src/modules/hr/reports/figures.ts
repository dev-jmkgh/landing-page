import { query, type RowDataPacket } from '../../../db/pool';
import type { LeaveKind } from '../calendar/calendar.service';
import type { LeaveBalance, LeaveType } from '../leave/leave.schema';
import { balancesWithAllocationsFor } from '../leave/leave.service';

/**
 * Leave figures for the leave REPORT, which needs many people's balances at once.
 *
 * The balances themselves come from `leave.service` — the one implementation of the
 * rule (allocation else quota, approved and pending days of requests starting in the
 * year, only `kind='leave'` ever tracked) — so the report, the app's balance screen and
 * the approval check cannot disagree. This file only chooses WHICH types a year's report
 * covers and fans the per-person call out with bounded concurrency.
 */

interface LeaveTypeRow extends RowDataPacket {
  id: number;
  name: string;
  code: string;
  kind: LeaveKind;
  is_paid: number;
  annual_quota: string | null;
  allow_half_day: number;
  is_active: number;
  sort_order: number;
}

/**
 * The types a year's report covers: every active type, plus any retired type that still
 * has approved or pending requests starting in that year — deactivating a type must not
 * make the days already taken against it vanish from the report.
 */
export async function leaveTypesForYear(year: number): Promise<LeaveType[]> {
  const rows = await query<LeaveTypeRow>(
    `SELECT t.id, t.name, t.code, t.kind, t.is_paid, t.annual_quota, t.allow_half_day,
            t.is_active, t.sort_order
       FROM hr_leave_types t
      WHERE t.is_active = 1
         OR EXISTS (SELECT 1 FROM hr_leave_requests r
                     WHERE r.leave_type_id = t.id AND r.status IN ('approved','pending')
                       AND r.start_date BETWEEN ? AND ?)
      ORDER BY t.sort_order ASC, t.name ASC, t.id ASC`,
    [`${year}-01-01`, `${year}-12-31`],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    kind: row.kind,
    isPaid: Number(row.is_paid) === 1,
    annualQuota: row.annual_quota === null ? null : Number(row.annual_quota),
    allowHalfDay: Number(row.allow_half_day) === 1,
    isActive: Number(row.is_active) === 1,
    sortOrder: Number(row.sort_order),
  }));
}

/**
 * How many people's balances are read at once. Each is two small indexed queries; ten
 * in flight keeps an export of the whole company from taking every pooled connection
 * away from the requests other people are making meanwhile.
 */
const BALANCE_CONCURRENCY = 10;

/** Balances for every type in `types`, tracked or not, for each person. */
export async function leaveBalancesForUsers(
  userIds: number[],
  year: number,
  types: LeaveType[],
): Promise<Map<number, LeaveBalance[]>> {
  const result = new Map<number, LeaveBalance[]>();
  const ids = [...new Set(userIds)];
  for (let start = 0; start < ids.length; start += BALANCE_CONCURRENCY) {
    const chunk = ids.slice(start, start + BALANCE_CONCURRENCY);
    const balances = await Promise.all(chunk.map((id) => balancesWithAllocationsFor(id, year, types)));
    chunk.forEach((id, index) => {
      // The allocation note is the admin balance screen's business, not a report column.
      result.set(
        id,
        balances[index]!.map(({ allocation: _allocation, ...balance }) => balance),
      );
    });
  }
  return result;
}
