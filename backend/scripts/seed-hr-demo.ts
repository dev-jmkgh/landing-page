/**
 * Fills the HR tables with realistic demo data.
 *
 *   SEED_DEMO_PASSWORD=<12+ chars> DB_NAME=jmk_demo npm run db:seed:hr
 *
 * Every HR screen — the app's dashboard, leave balances, the holiday calendar, payslips,
 * a manager's approvals; the admin portal's register, queues, reports and payroll — needs
 * data before it shows whether it works. An empty database makes most of them look broken
 * rather than empty.
 *
 * What it covers, because ad-hoc data entry never reaches these cases:
 *   - a reporting line (an HR admin, a team manager with three direct reports, an employee
 *     reporting to nobody) so team approvals have something to approve
 *   - every attendance shape across last month: on time, late, a half day, a split day
 *     with two sessions, a missing check-out, a punch flagged for review, and absences
 *   - leave that is approved (paid and unpaid), pending, rejected and cancelled, a
 *     work-from-home day, quotas on some types and none on others (untracked)
 *   - holidays, weekly offs, a pending registration, open / in-progress / resolved HR
 *     requests including a profile update, and read and unread notifications
 *   - salary structures for everyone, and LAST MONTH's payroll processed and approved
 *     through the real payroll service, so payslips exist with genuine loss of pay
 *
 * Re-runnable: it deletes every HR row first (hr_users cascades to nearly everything).
 * It never touches the telecalling, website or admin tables.
 *
 * Refuses to run when NODE_ENV is production, or against the database named in
 * `.env.production`, or against any database whose name does not contain "demo" or
 * "e2e" — it is a wipe, and the only safe default is to refuse.
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV is production. This script deletes every HR row.');
  process.exit(1);
}

const targetDb = process.env.DB_NAME ?? '';

try {
  const productionDb = /^DB_NAME=(.*)$/m.exec(readFileSync('.env.production', 'utf8'))?.[1]?.trim();
  if (productionDb && productionDb === targetDb) {
    console.error(`Refusing to run: "${targetDb}" is the database named in .env.production.`);
    process.exit(1);
  }
} catch {
  // No .env.production on this machine — the name check below still applies.
}

if (!/demo|e2e/i.test(targetDb)) {
  console.error(`Refusing to run against "${targetDb || '(unset)'}".`);
  console.error('This script DELETES every HR row. Point DB_NAME at a demo database, e.g.');
  console.error('    DB_NAME=jmk_demo npm run db:seed:hr');
  process.exit(1);
}

const password = process.env.SEED_DEMO_PASSWORD ?? crypto.randomBytes(9).toString('base64url');
if (password.length < 12) {
  console.error('SEED_DEMO_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/** The company calendar is IST, a fixed +05:30. */
const IST_MINUTES = 330;

function istToday(): string {
  return new Date(Date.now() + IST_MINUTES * 60_000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** `HH:MM` IST on `date` as the UTC wall clock the DATETIME columns hold. */
function utcAt(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const instant = new Date(`${date}T00:00:00Z`).getTime() + (h * 60 + m - IST_MINUTES) * 60_000;
  return new Date(instant).toISOString().slice(0, 19).replace('T', ' ');
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const today = istToday();
const thisMonth = today.slice(0, 7);
const lastMonthStart = (() => {
  const [y, m] = thisMonth.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 10);
})();
const lastMonth = lastMonthStart.slice(0, 7);
const lastMonthEnd = addDays(`${thisMonth}-01`, -1);
const year = Number(today.slice(0, 4));

/* -------------------------------------------------------------------------- */
/* Seed                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: targetDb,
    timezone: 'Z',
  });
  await db.query("SET time_zone = '+00:00'");

  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0] as any;

  console.log(`Seeding HR demo data into ${targetDb}…`);

  /* ---- wipe (hr_users cascades to attendance, leave, requests, payroll…) ---- */
  await q('DELETE FROM hr_payroll_runs');
  await q('DELETE FROM hr_users');
  await q('DELETE FROM hr_holidays');
  await q('DELETE FROM hr_departments');
  await q('DELETE FROM hr_designations');
  await q('DELETE FROM hr_work_locations');
  await q("DELETE FROM hr_shifts WHERE name <> 'General shift'");
  await q('UPDATE hr_leave_types SET annual_quota = NULL');
  await q('DELETE FROM hr_settings');
  await q("DELETE FROM audit_logs WHERE entity_type LIKE 'hr\\_%'");

  /* ---- organisation ---- */
  const dept: Record<string, number> = {};
  for (const [name, code] of [
    ['Operations', 'OPS'],
    ['Sales', 'SAL'],
    ['Finance', 'FIN'],
    ['Human Resources', 'HR'],
    ['Technology', 'TECH'],
  ] as const) {
    dept[name] = (await q('INSERT INTO hr_departments (name, code) VALUES (?, ?)', [name, code])).insertId;
  }
  const desig: Record<string, number> = {};
  for (const name of ['Executive', 'Senior Executive', 'Team Lead', 'Manager', 'Accountant', 'HR Executive']) {
    desig[name] = (await q('INSERT INTO hr_designations (name) VALUES (?)', [name])).insertId;
  }

  /* ---- sites, shifts ---- */
  const siteId = (
    await q(
      `INSERT INTO hr_work_locations (name, address, latitude, longitude, radius_metres)
       VALUES ('JMK Head Office', 'Demo address — replace with the real site', 13.0827, 80.2707, 200)`,
    )
  ).insertId;
  const general = (await q("SELECT id FROM hr_shifts WHERE name = 'General shift'"))[0]?.id as number;
  await q("UPDATE hr_shifts SET weekly_off_days = 'sun' WHERE id = ?", [general]);
  const sixDay = (
    await q(
      `INSERT INTO hr_shifts (name, starts_at, ends_at, break_minutes, grace_minutes, half_day_minutes, weekly_off_days)
       VALUES ('Sales shift', '10:00:00', '19:00:00', 60, 15, 240, 'sun')`,
    )
  ).insertId;

  /* ---- settings, holidays, quotas ---- */
  await q(
    "INSERT INTO hr_settings (setting_key, setting_value) VALUES ('attendance_tracked_from', ?), ('default_weekly_off', 'sun')",
    [lastMonthStart],
  );
  const holidays: Array<[string, string, number]> = [
    [`${year}-01-26`, 'Republic Day', 0],
    [`${year}-05-01`, 'May Day', 0],
    [`${year}-08-15`, 'Independence Day', 0],
    [`${year}-10-02`, 'Gandhi Jayanti', 0],
    [`${year}-12-25`, 'Christmas', 0],
    [`${year}-11-14`, 'Children’s Day', 1],
  ];
  // One holiday inside last month, so the payslip shows a holiday that is not a weekly off.
  let lastMonthHoliday = `${lastMonth}-17`;
  while (weekday(lastMonthHoliday) === 0) lastMonthHoliday = addDays(lastMonthHoliday, 1);
  holidays.push([lastMonthHoliday, 'Company foundation day', 0]);
  // And one coming up, so "upcoming holidays" is never empty in a demo.
  let upcoming = addDays(today, 10);
  while (weekday(upcoming) === 0) upcoming = addDays(upcoming, 1);
  holidays.push([upcoming, 'Regional festival', 0]);
  for (const [date, name, optional] of holidays) {
    await q(
      'INSERT INTO hr_holidays (holiday_date, name, is_optional) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [date, name, optional],
    );
  }
  await q("UPDATE hr_leave_types SET annual_quota = 12 WHERE code IN ('CL', 'SL')");
  await q("UPDATE hr_leave_types SET annual_quota = 15 WHERE code = 'EL'");
  const leaveType = async (code: string) =>
    (await q('SELECT id FROM hr_leave_types WHERE code = ?', [code]))[0]?.id as number;
  const CL = await leaveType('CL');
  const SL = await leaveType('SL');
  const LWP = await leaveType('LWP');
  const WFH = await leaveType('WFH');

  /* ---- people ---- */
  const hash = await bcrypt.hash(password, 10);
  const people: Record<string, number> = {};
  let code = 0;
  const person = async (input: {
    key: string;
    name: string;
    email: string;
    phone: string;
    role?: 'employee' | 'hr_manager' | 'hr_admin';
    department: string;
    designation: string;
    manager?: string;
    joining: string;
    workMode?: 'office' | 'remote' | 'field';
    shift?: number;
    approval?: 'approved' | 'pending';
  }) => {
    code += 1;
    const approved = (input.approval ?? 'approved') === 'approved';
    const result = await q(
      `INSERT INTO hr_users
         (employee_code, name, email, email_verified_at, phone, password_hash, role, is_active,
          approval_status, registered_at, approved_at, work_mode, work_location_id, shift_id,
          department_id, designation_id, manager_id, joining_date, employment_type, employment_status,
          date_of_birth, address, emergency_contact_name, emergency_contact_phone)
       VALUES (?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, UTC_TIMESTAMP() - INTERVAL 40 DAY, ?, ?, ?, ?, ?, ?, ?, ?,
               'full_time', 'active', '1994-06-12', 'Chennai, Tamil Nadu', 'Family contact', '+91 98400 00000')`,
      [
        `EMP-${String(code).padStart(4, '0')}`,
        input.name,
        input.email,
        input.phone,
        hash,
        input.role ?? 'employee',
        approved ? 1 : 0,
        input.approval ?? 'approved',
        approved ? new Date() : null,
        input.workMode ?? 'office',
        (input.workMode ?? 'office') === 'office' ? siteId : null,
        input.shift ?? general,
        dept[input.department],
        desig[input.designation],
        input.manager ? people[input.manager] : null,
        input.joining,
      ],
    );
    people[input.key] = result.insertId;
  };

  await person({ key: 'anita', name: 'Anita Sharma', email: 'anita.hr@jmkdemo.test', phone: '+91 98400 11001', role: 'hr_admin', department: 'Human Resources', designation: 'Manager', joining: '2021-04-01' });
  await person({ key: 'vikram', name: 'Vikram Rao', email: 'vikram.lead@jmkdemo.test', phone: '+91 98400 11002', role: 'hr_manager', department: 'Operations', designation: 'Team Lead', manager: 'anita', joining: '2022-01-10' });
  await person({ key: 'kavya', name: 'Kavya Iyer', email: 'kavya@jmkdemo.test', phone: '+91 98400 11003', department: 'Operations', designation: 'Executive', manager: 'vikram', joining: '2023-07-03', workMode: 'remote' });
  await person({ key: 'arjun', name: 'Arjun Menon', email: 'arjun@jmkdemo.test', phone: '+91 98400 11004', department: 'Operations', designation: 'Senior Executive', manager: 'vikram', joining: '2022-11-14' });
  await person({ key: 'sneha', name: 'Sneha Pillai', email: 'sneha@jmkdemo.test', phone: '+91 98400 11005', department: 'Sales', designation: 'Executive', manager: 'vikram', joining: addDays(lastMonthStart, 9), workMode: 'field', shift: sixDay });
  await person({ key: 'farhan', name: 'Farhan Ali', email: 'farhan@jmkdemo.test', phone: '+91 98400 11006', department: 'Finance', designation: 'Accountant', manager: 'anita', joining: '2020-02-17', workMode: 'remote' });
  await person({ key: 'meena', name: 'Meena Joseph', email: 'meena.new@jmkdemo.test', phone: '+91 98400 11007', department: 'Technology', designation: 'Executive', joining: today, approval: 'pending' });

  /* ---- attendance for last month and this month so far ---- */
  type Day = { in: string[]; out: (string | null)[]; flags?: string; autoClosed?: boolean };
  const pattern = (key: string, date: string, index: number): Day | null => {
    if (key === 'meena') return null;
    // A few absences per person, deterministic by name and date.
    const seed = (key.charCodeAt(0) + index * 7) % 23;
    if (seed === 0) return null;
    if (key === 'arjun' && index % 11 === 5) return { in: ['10:05'], out: ['18:10'] }; // late
    if (key === 'kavya' && index % 13 === 4) return { in: ['09:00'], out: ['12:30'] }; // half day
    if (key === 'vikram' && index % 9 === 3) return { in: ['09:00', '14:00'], out: ['13:00', '18:30'] }; // split
    if (key === 'arjun' && index === 8) return { in: ['09:02'], out: [null], autoClosed: true }; // missing check-out
    if (key === 'sneha' && index % 10 === 6) return { in: ['10:01'], out: ['19:05'], flags: 'mock_location' };
    return key === 'sneha' ? { in: ['09:58'], out: ['19:02'] } : { in: ['08:56'], out: ['18:04'] };
  };

  const holidaySet = new Set(holidays.filter((h) => h[2] === 0).map((h) => h[0]));
  for (const [key, userId] of Object.entries(people)) {
    const joined = (await q("SELECT DATE_FORMAT(joining_date, '%Y-%m-%d') AS j, work_mode FROM hr_users WHERE id = ?", [userId]))[0];
    let index = 0;
    for (let date = lastMonthStart; date < today; date = addDays(date, 1)) {
      index += 1;
      if (weekday(date) === 0 || holidaySet.has(date) || date < joined.j) continue;
      const day = pattern(key, date, index);
      if (!day) continue;
      const late = day.in[0]! > '09:10' ? Math.max(0, (Number(day.in[0]!.slice(0, 2)) * 60 + Number(day.in[0]!.slice(3))) - (key === 'sneha' ? 615 : 550)) : 0;
      const attendance = await q(
        `INSERT INTO hr_attendance (user_id, work_date, work_mode, source, status, late_minutes, shift_id, shift_starts_at, shift_ends_at)
         VALUES (?, ?, ?, 'app', ?, ?, ?, ?, ?)`,
        [userId, date, joined.work_mode, late > 0 ? 'late' : 'present', late, key === 'sneha' ? sixDay : general,
         key === 'sneha' ? '10:00:00' : '09:00:00', key === 'sneha' ? '19:00:00' : '18:00:00'],
      );
      for (let s = 0; s < day.in.length; s += 1) {
        const started = utcAt(date, day.in[s]!);
        const ended = day.out[s] ? utcAt(date, day.out[s]!) : started;
        await q(
          `INSERT INTO hr_attendance_sessions
             (attendance_id, user_id, started_at, ended_at, minutes, source, auto_closed, in_flags,
              in_lat, in_lng, in_accuracy_metres)
           VALUES (?, ?, ?, ?, TIMESTAMPDIFF(MINUTE, ?, ?), 'app', ?, ?, 13.0828, 80.2709, 35)`,
          [attendance.insertId, userId, started, ended, started, ended, day.autoClosed ? 1 : 0, day.flags ?? ''],
        );
      }
      // The day roll-up, as the service derives it.
      await q(
        `UPDATE hr_attendance a SET
           a.checked_in_at = (SELECT MIN(started_at) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id),
           a.checked_out_at = (SELECT MAX(ended_at) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id),
           a.worked_minutes = (SELECT SUM(minutes) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id),
           a.break_minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE,
             (SELECT MIN(started_at) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id),
             (SELECT MAX(ended_at) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id))
             - (SELECT SUM(minutes) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id)),
           a.missing_punch = EXISTS (SELECT 1 FROM hr_attendance_sessions s WHERE s.attendance_id = a.id AND s.auto_closed = 1),
           a.flagged = EXISTS (SELECT 1 FROM hr_attendance_sessions s WHERE s.attendance_id = a.id AND s.in_flags <> ''),
           a.status = CASE WHEN a.status = 'present' AND (SELECT SUM(minutes) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id) < 240
                           AND NOT EXISTS (SELECT 1 FROM hr_attendance_sessions s WHERE s.attendance_id = a.id AND s.auto_closed = 1)
                           THEN 'half_day' ELSE a.status END
         WHERE a.id = ?`,
        [attendance.insertId],
      );
    }
  }

  /* ---- leave ---- */
  const leave = async (
    key: string,
    typeId: number,
    start: string,
    end: string,
    days: number,
    status: 'pending' | 'approved' | 'rejected' | 'cancelled',
    reason: string,
    halfDay: 'none' | 'first_half' | 'second_half' = 'none',
  ) => {
    // Never on a day the person has attendance for: the demo must not contradict itself.
    await q('DELETE FROM hr_attendance WHERE user_id = ? AND work_date BETWEEN ? AND ?', [people[key], start, end]);
    await q(
      `INSERT INTO hr_leave_requests
         (user_id, leave_type_id, start_date, end_date, half_day, days, reason, status,
          reviewed_by, reviewer_type, reviewer_name, reviewed_at, review_note, cancelled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() - INTERVAL 20 DAY)`,
      [
        people[key], typeId, start, end, halfDay, days, reason, status,
        status === 'approved' || status === 'rejected' ? people.vikram : null,
        status === 'approved' || status === 'rejected' ? 'manager' : null,
        status === 'approved' || status === 'rejected' ? 'Vikram Rao' : null,
        status === 'approved' || status === 'rejected' ? new Date() : null,
        status === 'rejected' ? 'Quarter-end close — please pick another week.' : null,
        status === 'cancelled' ? new Date() : null,
      ],
    );
  };
  const workday = (date: string) => {
    let d = date;
    while (weekday(d) === 0 || holidaySet.has(d)) d = addDays(d, 1);
    return d;
  };
  const kavyaLeave = workday(`${lastMonth}-08`);
  await leave('kavya', CL, kavyaLeave, kavyaLeave, 1, 'approved', 'Family function');
  const arjunUnpaid = workday(`${lastMonth}-22`);
  await leave('arjun', LWP, arjunUnpaid, arjunUnpaid, 1, 'approved', 'Personal work');
  const sickHalf = workday(`${lastMonth}-25`);
  await leave('kavya', SL, sickHalf, sickHalf, 0.5, 'approved', 'Doctor’s appointment', 'first_half');
  const future = workday(addDays(today, 6));
  await leave('arjun', CL, future, future, 1, 'pending', 'Bank and registration work');
  await leave('kavya', CL, workday(addDays(today, 14)), workday(addDays(today, 14)), 1, 'pending', 'Travel home');
  await leave('farhan', SL, workday(addDays(today, 3)), workday(addDays(today, 3)), 1, 'rejected', 'Planned check-up');
  await leave('sneha', WFH, workday(addDays(today, 2)), workday(addDays(today, 2)), 1, 'approved', 'Home visit for paperwork');
  await leave('vikram', CL, workday(addDays(today, 20)), workday(addDays(today, 20)), 1, 'cancelled', 'Plans changed');

  /* ---- HR requests ---- */
  const request = async (key: string, category: string, subject: string, details: string, status: string, payload: object | null = null) => {
    const r = await q(
      `INSERT INTO hr_requests (user_id, category, subject, details, payload, status, last_activity_at, created_at,
         resolved_by_name, resolved_at, resolution_note)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() - INTERVAL 2 DAY, UTC_TIMESTAMP() - INTERVAL 6 DAY, ?, ?, ?)`,
      [people[key], category, subject, details, payload ? JSON.stringify(payload) : null, status,
       status === 'resolved' ? 'HR team' : null, status === 'resolved' ? new Date() : null,
       status === 'resolved' ? 'Letter shared in Documents.' : null],
    );
    await q(
      `INSERT INTO hr_request_comments (request_id, author_type, author_id, author_name, body, created_at)
       VALUES (?, 'employee', ?, (SELECT name FROM hr_users WHERE id = ?), ?, UTC_TIMESTAMP() - INTERVAL 6 DAY)`,
      [r.insertId, people[key], people[key], details],
    );
    if (status !== 'open') {
      await q(
        `INSERT INTO hr_request_comments (request_id, author_type, author_name, body, status_from, status_to, created_at)
         VALUES (?, 'admin', 'HR team', 'Picked up — we will update you here.', 'open', 'in_progress', UTC_TIMESTAMP() - INTERVAL 3 DAY)`,
        [r.insertId],
      );
    }
  };
  await request('kavya', 'profile_update', 'Update my emergency contact', 'My emergency contact has changed.', 'open',
    { emergencyContactName: 'R. Iyer', emergencyContactPhone: '+91 98400 22334' });
  await request('arjun', 'letter', 'Employment letter for bank loan', 'Please share an employment verification letter.', 'in_progress');
  await request('farhan', 'payroll', 'Form 16 for last year', 'Need Form 16 for tax filing.', 'resolved');

  /* ---- salary structures ---- */
  const structures: Record<string, Array<[string, 'earning' | 'deduction', number, number]>> = {
    anita: [['Basic', 'earning', 60000, 1], ['HRA', 'earning', 24000, 1], ['Special allowance', 'earning', 16000, 1], ['Provident fund', 'deduction', 1800, 0], ['Professional tax', 'deduction', 200, 0], ['TDS', 'deduction', 9500, 0]],
    vikram: [['Basic', 'earning', 42000, 1], ['HRA', 'earning', 16800, 1], ['Special allowance', 'earning', 9200, 1], ['Provident fund', 'deduction', 1800, 0], ['Professional tax', 'deduction', 200, 0], ['TDS', 'deduction', 3800, 0]],
    kavya: [['Basic', 'earning', 22000, 1], ['HRA', 'earning', 8800, 1], ['Conveyance', 'earning', 1600, 0], ['Provident fund', 'deduction', 1800, 0], ['Professional tax', 'deduction', 200, 0]],
    arjun: [['Basic', 'earning', 26000, 1], ['HRA', 'earning', 10400, 1], ['Conveyance', 'earning', 1600, 0], ['Provident fund', 'deduction', 1800, 0], ['Professional tax', 'deduction', 200, 0]],
    sneha: [['Basic', 'earning', 20000, 1], ['HRA', 'earning', 8000, 1], ['Field allowance', 'earning', 3000, 1], ['Provident fund', 'deduction', 1800, 0], ['Professional tax', 'deduction', 200, 0]],
    farhan: [['Basic', 'earning', 30000, 1], ['HRA', 'earning', 12000, 1], ['Special allowance', 'earning', 5000, 1], ['Provident fund', 'deduction', 1800, 0], ['Professional tax', 'deduction', 200, 0], ['TDS', 'deduction', 1200, 0]],
  };
  for (const [key, lines] of Object.entries(structures)) {
    const s = await q(
      "INSERT INTO hr_salary_structures (user_id, effective_from, note, created_by_name) VALUES (?, '2024-04-01', 'Annual revision', 'HR team')",
      [people[key]],
    );
    let order = 0;
    for (const [label, kind, amount, prorated] of lines) {
      order += 10;
      await q(
        'INSERT INTO hr_salary_components (structure_id, label, kind, amount, prorated, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        [s.insertId, label, kind, amount, prorated, order],
      );
    }
  }

  /* ---- a few notifications ---- */
  await q(
    `INSERT INTO hr_notifications (user_id, kind, title, body, created_at, read_at) VALUES
       (?, 'announcement', 'Office closed for maintenance', 'The office will open at 11:00 on Saturday.', UTC_TIMESTAMP() - INTERVAL 5 DAY, UTC_TIMESTAMP()),
       (?, 'leave_approved', 'Leave approved', 'Your casual leave was approved.', UTC_TIMESTAMP() - INTERVAL 18 DAY, NULL)`,
    [people.kavya, people.kavya],
  );

  await db.end();

  /* ---- last month's payroll, through the real service ---- */
  process.env.DB_NAME = targetDb;
  const payroll = (await import('../src/modules/hr/payroll/payroll.service')) as Record<string, unknown>;
  const { closePool } = await import('../src/db/pool');
  try {
    const seedPayroll = payroll.seedDemoRun as ((period: string) => Promise<string>) | undefined;
    if (typeof seedPayroll === 'function') {
      console.log(await seedPayroll(lastMonth));
    } else {
      console.log('  (payroll service has no seedDemoRun — process last month in the admin portal)');
    }
  } finally {
    await closePool();
  }

  console.log('');
  console.log('HR demo data ready. Sign in to the HR app with any of:');
  console.log('  anita.hr@jmkdemo.test     HR admin (sees every employee as team)');
  console.log('  vikram.lead@jmkdemo.test  team manager (Kavya, Arjun, Sneha report to him)');
  console.log('  kavya@jmkdemo.test        employee, remote');
  console.log('  arjun@jmkdemo.test        employee, office (geofenced site)');
  console.log('  sneha@jmkdemo.test        employee, field, joined mid last month');
  console.log('  farhan@jmkdemo.test       employee, remote, Finance');
  console.log('  meena.new@jmkdemo.test    pending registration (cannot sign in)');
  console.log(`Password for all: ${process.env.SEED_DEMO_PASSWORD ? '(SEED_DEMO_PASSWORD)' : password}`);
}

main().catch((error) => {
  console.error('HR demo seed failed:', error);
  process.exit(1);
});
