import { COMPANY_UTC_OFFSET } from '../attendance/attendance.schema';
import { addDays } from '../calendar/calendar.service';

/**
 * Company wall clock ↔ UTC instants, in Node.
 *
 * Shift times are wall-clock `HH:MM` in the company's zone (IST, a fixed +05:30), and
 * every DATETIME is UTC. Turning "09:00 on 2026-10-16" into an instant is done HERE, by
 * the fixed offset — never with `new Date('2026-10-16 09:00')`, which reads the string
 * in the server process's own zone and is right only on a server that happens to sit in
 * India.
 */

export const COMPANY_OFFSET_MS = (() => {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(COMPANY_UTC_OFFSET);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === '-' ? -minutes : minutes) * 60_000;
})();

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

/** `HH:MM` (plus `extraMinutes`) on a company date, as a UTC epoch. Rolls past midnight. */
export function companyInstant(date: string, time: string, extraMinutes = 0): number {
  return Date.parse(`${date}T00:00:00Z`) + (minutesOf(time) + extraMinutes) * 60_000 - COMPANY_OFFSET_MS;
}

/**
 * When a day's shift ends, as a UTC epoch. A shift that ends at or before it starts
 * crosses midnight, so it ends on the NEXT date. Null when the day has no shift.
 */
export function shiftEndInstant(workDate: string, startsAt: string | null, endsAt: string | null): number | null {
  if (!startsAt || !endsAt) return null;
  const overnight = minutesOf(endsAt) <= minutesOf(startsAt);
  return companyInstant(overnight ? addDays(workDate, 1) : workDate, endsAt);
}

/** An ISO UTC instant as company wall clock, `YYYY-MM-DD HH:MM` — for CSV readers. */
export function companyDateTime(isoValue: string | null): string | null {
  if (!isoValue) return null;
  const ms = Date.parse(isoValue);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + COMPANY_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}
