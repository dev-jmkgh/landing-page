import type { ApiResponse, Client, E2EContext, Json } from './context';

/**
 * hrReports — the employee dashboard, the admin HR dashboard, the reports and their CSV
 * exports, the HR audit trail, and the HR scheduler tick (reminders + missing-punch
 * sweep).
 *
 * Every fixture is this section's own (fresh HR employees, a department, shifts, a
 * payroll run in the year 2000 that no other section touches) and every count is a
 * delta or scoped to those fixtures — earlier sections have written plenty of rows.
 * Shift times for the reminders are computed from the company clock (IST, +05:30) at
 * run time, so the section passes at any hour except the first one after midnight IST,
 * where a "started 30 minutes ago" shift would belong to yesterday; those assertions
 * are skipped there with a note rather than failed.
 */
export async function run(ctx: E2EContext): Promise<void> {
  console.log('\nhrReports');
  const { check, adminAsBearer: admin, utcDb } = ctx;

  /* ------------------------------------------------------------------ helpers */

  const tag = Date.now().toString(36);
  const istNow = () => new Date(Date.now() + 330 * 60_000);
  /** The company's today, like `companyToday()` in the app. */
  const today = istNow().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const addDays = (date: string, days: number) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const hhmm = (minutes: number) => {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  const items = (response: ApiResponse): Json[] =>
    Array.isArray(response.json?.items) ? (response.json.items as Json[]) : [];

  /** Writes through the UTC-pinned connection, like the app. Returns the insert id. */
  async function insert(sql: string, params: unknown[] = []): Promise<number> {
    const [result] = (await utcDb.query(sql, params)) as unknown as [{ insertId: number }, unknown];
    return Number(result.insertId);
  }
  async function scalar(sql: string, params: unknown[] = []): Promise<number> {
    const [rows] = (await utcDb.query(sql, params)) as unknown as [Json[], unknown];
    return Number(rows[0]?.c ?? 0);
  }
  async function row(sql: string, params: unknown[] = []): Promise<Json | undefined> {
    const [rows] = (await utcDb.query(sql, params)) as unknown as [Json[], unknown];
    return rows[0];
  }

  /** A CSV download, split into lines with the BOM and line endings checked. */
  async function csv(client: Client, path: string) {
    const raw = await client.getRaw(path);
    const bom = raw.body[0] === 0xef && raw.body[1] === 0xbb && raw.body[2] === 0xbf;
    const text = raw.body.subarray(bom ? 3 : 0).toString('utf8');
    // Every line break is CRLF, and the file ends with one.
    const crlf = text.endsWith('\r\n') && !/(^|[^\r])\n/.test(text);
    const lines = text.split('\r\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return {
      status: raw.status,
      contentType: raw.headers.get('content-type') ?? '',
      disposition: raw.headers.get('content-disposition') ?? '',
      bom,
      crlf,
      lines,
    };
  }

  const dashboardOf = async (client: Client) => (await client.get('/hr/dashboard')).json ?? {};
  const adminDashboard = async () => (await admin.get('/admin/hr/dashboard')).json ?? {};

  /* ============================================================ fixtures */

  const deptName = `=Reports ${tag}`; // starts with '=' on purpose: the CSV must neutralise it
  const departmentId = await insert('INSERT INTO hr_departments (name) VALUES (?)', [deptName]);

  const fresh = await ctx.createSignedInHrEmployee({
    // A comma on purpose: the CSV must quote it.
    name: `Report Fresh, ${tag}`,
    email: `rpt.fresh.${tag}@example.test`,
  });
  const puncher = await ctx.createSignedInHrEmployee({
    name: `Report Puncher ${tag}`,
    email: `rpt.punch.${tag}@example.test`,
  });
  await utcDb.query('UPDATE hr_users SET department_id = ? WHERE id IN (?, ?)', [
    departmentId,
    fresh.id,
    puncher.id,
  ]);

  /* ============================================== the employee dashboard */
  console.log('\nhrReports: employee dashboard');

  const first = await fresh.client.get('/hr/dashboard');
  const d0 = first.json ?? {};
  check('the employee dashboard answers', first.status === 200 && d0.success === true, first.json);
  check('it is for the company date', d0.today?.date === today, d0.today?.date);
  check('a fresh employee has no day recorded', d0.today?.day === null, d0.today?.day);
  check(
    'no shift or site is invented for an unassigned employee',
    d0.today?.assignment?.shift === null && d0.today?.assignment?.location === null,
    d0.today?.assignment,
  );
  check('no missing punch', d0.today?.missingPunch === null, d0.today?.missingPunch);
  const freshBalances: Json[] = Array.isArray(d0.leave?.balances) ? d0.leave.balances : [];
  check(
    'only TRACKED leave appears as a balance — never an untracked type shown as 0',
    Array.isArray(d0.leave?.balances) &&
      freshBalances.length <= 4 &&
      freshBalances.every(
        (balance) =>
          balance.tracked === true &&
          typeof balance.entitled === 'number' &&
          balance.leaveType?.kind === 'leave' &&
          Math.abs(balance.available - (balance.entitled - balance.used - balance.pending)) < 0.001,
      ),
    d0.leave?.balances,
  );
  check('no pending leave', d0.leave?.pendingRequests === 0, d0.leave);
  check('no next approved leave', d0.leave?.nextApproved === null, d0.leave?.nextApproved);
  check('no open requests', d0.requests?.open === 0, d0.requests);
  check(
    'an empty inbox',
    d0.notifications?.unread === 0 && Array.isArray(d0.notifications?.latest) && d0.notifications.latest.length === 0,
    d0.notifications,
  );
  check('no payslip', d0.payslip?.latest === null, d0.payslip);
  check(
    'upcoming holidays are a short list from today on',
    Array.isArray(d0.holidays?.upcoming) &&
      d0.holidays.upcoming.length <= 3 &&
      (d0.holidays.upcoming as Json[]).every((holiday) => String(holiday.date) >= today),
    d0.holidays,
  );
  check('an ordinary employee gets team: null', d0.team === null, d0.team);

  const adminOnHrRoute = await admin.get('/hr/dashboard');
  check('an admin token is refused on the HR app dashboard', adminOnHrRoute.status === 401, adminOnHrRoute.status);
  const anonymous = await ctx.makeClient(ctx.base).get('/hr/dashboard');
  check('so is no token at all', anonymous.status === 401, anonymous.status);

  /* --- it moves with leave, requests, notifications and an approved payslip --- */

  const leaveType = await row(
    `SELECT id, name FROM hr_leave_types
      WHERE kind = 'leave' AND is_active = 1 AND is_paid = 1
      ORDER BY sort_order ASC, id ASC LIMIT 1`,
  );
  const leaveTypeId = Number(leaveType?.id ?? 0);
  await utcDb.query(
    'INSERT INTO hr_leave_allocations (user_id, leave_type_id, year, days, note) VALUES (?, ?, ?, 12, ?)',
    [fresh.id, leaveTypeId, year, 'e2e allocation'],
  );
  // Pending today (always inside this year); approved tomorrow and the day after, unless
  // that crosses into next year, in which case today.
  await insert(
    `INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days, reason, status)
     VALUES (?, ?, ?, ?, 1.0, 'e2e pending', 'pending')`,
    [fresh.id, leaveTypeId, today, today],
  );
  const inYear = addDays(today, 2).slice(0, 4) === String(year);
  const approvedStart = inYear ? addDays(today, 1) : today;
  const approvedEnd = inYear ? addDays(today, 2) : today;
  const approvedDays = inYear ? 2 : 1;
  await insert(
    `INSERT INTO hr_leave_requests
       (user_id, leave_type_id, start_date, end_date, days, reason, status, reviewer_type, reviewer_name, reviewed_at)
     VALUES (?, ?, ?, ?, ?, 'e2e approved', 'approved', 'admin', 'E2E', UTC_TIMESTAMP())`,
    [fresh.id, leaveTypeId, approvedStart, approvedEnd, approvedDays],
  );
  for (const status of ['open', 'in_progress', 'resolved']) {
    await insert(
      `INSERT INTO hr_requests (user_id, category, subject, status) VALUES (?, 'other', ?, ?)`,
      [fresh.id, `Report request ${status}`, status],
    );
  }
  await insert(
    `INSERT INTO hr_notifications (user_id, kind, title, body) VALUES (?, 'announcement', ?, 'e2e')`,
    [fresh.id, `Report notice ${tag}`],
  );
  // An approved run in 2000 (nobody else's period) and a later, NOT approved one.
  const approvedRunId = await insert(
    `INSERT INTO hr_payroll_runs
       (period, period_start, period_end, status, employee_count, total_gross, total_deductions,
        total_net, approved_at, approved_by_name)
     VALUES ('2000-01', '2000-01-01', '2000-01-31', 'approved', 1, 1000.00, 99.50, 900.50,
             UTC_TIMESTAMP(), 'E2E')`,
  );
  const processedRunId = await insert(
    `INSERT INTO hr_payroll_runs
       (period, period_start, period_end, status, employee_count, total_gross, total_deductions, total_net)
     VALUES ('2000-02', '2000-02-01', '2000-02-29', 'processed', 1, 5000.00, 0, 5000.00)`,
  );
  const payslipId = await insert(
    `INSERT INTO hr_payslips (run_id, user_id, employee_code, employee_name, days_in_period,
                              gross_earnings, total_deductions, net_pay)
     VALUES (?, ?, 'HX-RPT', 'Report Fresh', 31, 1000.00, 99.50, 900.50)`,
    [approvedRunId, fresh.id],
  );
  await insert(
    `INSERT INTO hr_payslips (run_id, user_id, employee_code, employee_name, days_in_period,
                              gross_earnings, total_deductions, net_pay)
     VALUES (?, ?, 'HX-RPT', 'Report Fresh', 29, 5000.00, 0, 5000.00)`,
    [processedRunId, fresh.id],
  );

  const d1 = await dashboardOf(fresh.client);
  check('pending leave is counted', d1.leave?.pendingRequests === 1, d1.leave);
  check(
    'the next approved leave is shown',
    d1.leave?.nextApproved?.startDate === approvedStart &&
      d1.leave?.nextApproved?.endDate === approvedEnd &&
      d1.leave?.nextApproved?.typeName === leaveType?.name,
    d1.leave?.nextApproved,
  );
  const tracked = (Array.isArray(d1.leave?.balances) ? (d1.leave.balances as Json[]) : []).find(
    (balance) => balance.leaveType?.id === leaveTypeId,
  );
  check(
    'an allocation makes the type a tracked balance: entitled − used − pending',
    tracked?.tracked === true &&
      tracked?.entitled === 12 &&
      tracked?.used === approvedDays &&
      tracked?.pending === 1 &&
      tracked?.available === 12 - approvedDays - 1,
    tracked,
  );
  check('open and in-progress requests count, resolved ones do not', d1.requests?.open === 2, d1.requests);
  check(
    'the new notification is unread and on top',
    d1.notifications?.unread === 1 && d1.notifications?.latest?.[0]?.title === `Report notice ${tag}`,
    d1.notifications,
  );
  check(
    'the latest APPROVED payslip is shown — a processed later run is not',
    d1.payslip?.latest?.id === payslipId &&
      d1.payslip?.latest?.period === '2000-01' &&
      d1.payslip?.latest?.netPay === 900.5,
    d1.payslip,
  );

  /* --- a team manager gets the team block --- */

  const manager = await ctx.createSignedInHrEmployee({
    name: `Report Manager ${tag}`,
    email: `rpt.manager.${tag}@example.test`,
    role: 'hr_manager',
  });
  const member = await ctx.createSignedInHrEmployee({
    name: `Report Member ${tag}`,
    email: `rpt.member.${tag}@example.test`,
    managerId: manager.id,
  });
  await insert(
    `INSERT INTO hr_leave_requests (user_id, leave_type_id, start_date, end_date, days, reason, status)
     VALUES (?, ?, ?, ?, 1.0, 'e2e team pending', 'pending')`,
    [member.id, leaveTypeId, today, today],
  );
  await insert(
    `INSERT INTO hr_regularisations (user_id, work_date, requested_check_in_at, reason, status)
     VALUES (?, ?, UTC_TIMESTAMP(), 'e2e team correction', 'pending')`,
    [member.id, addDays(today, -1)],
  );
  const managerDash = await dashboardOf(manager.client);
  check(
    'a team manager sees what waits on them',
    managerDash.team?.leave === 1 &&
      managerDash.team?.regularisations === 1 &&
      managerDash.team?.pendingApprovals === 2,
    managerDash.team,
  );
  const memberDash = await dashboardOf(member.client);
  check('their report gets team: null', memberDash.team === null, memberDash.team);

  /* ===================================================== the admin dashboard */
  console.log('\nhrReports: admin dashboard');

  const remote = await admin.call('PATCH', `/admin/hr/users/${puncher.id}/assignment`, { workMode: 'remote' });
  check('the puncher is set to remote work', remote.status === 200, remote.json);

  const beforeResponse = await admin.get('/admin/hr/dashboard');
  const before = beforeResponse.json ?? {};
  check('the admin dashboard answers', beforeResponse.status === 200 && before.success === true, before);
  check('for today', before.date === today && before.isToday === true, { date: before.date });
  check(
    'with fourteen days of trend ending today',
    Array.isArray(before.trend) && before.trend.length === 14 && before.trend[13]?.date === today,
    before.trend?.length,
  );
  check(
    'and a headcount by department that includes the fixtures',
    (before.headcount?.byDepartment as Json[] | undefined)?.some(
      (group) => group.departmentId === departmentId && group.count === 2,
    ) ?? false,
    before.headcount,
  );
  check(
    'an admin sees the payroll block',
    before.payroll !== null && typeof before.payroll?.lastApproved?.period === 'string',
    before.payroll,
  );

  const punch = await puncher.client.post('/hr/attendance/check-in', {});
  check('a remote worker checks in', punch.status === 201, punch.json);

  const after = await adminDashboard();
  check(
    'present goes up by exactly one after a check-in',
    after.today?.present === Number(before.today?.present ?? NaN) + 1,
    { before: before.today?.present, after: after.today?.present },
  );
  check(
    'and so does "in right now"',
    after.today?.currentlyIn === Number(before.today?.currentlyIn ?? NaN) + 1,
    { before: before.today?.currentlyIn, after: after.today?.currentlyIn },
  );
  check(
    "and today's trend point",
    after.trend?.[13]?.present === Number(before.trend?.[13]?.present ?? NaN) + 1,
    { before: before.trend?.[13], after: after.trend?.[13] },
  );
  check('the headcount does not move', after.headcount?.total === before.headcount?.total, after.headcount);

  const pastDay = await admin.get(`/admin/hr/dashboard?date=${addDays(today, -3)}`);
  check(
    'a past date answers, without the live figures',
    pastDay.status === 200 &&
      pastDay.json?.isToday === false &&
      pastDay.json?.today?.currentlyIn === null &&
      pastDay.json?.today?.notCheckedOut === null,
    pastDay.json?.today,
  );
  const unrealDate = await admin.get('/admin/hr/dashboard?date=2026-02-30');
  check('an impossible date is a 400', unrealDate.status === 400, unrealDate.json);

  /* --- every figure is the total of the screen it opens, with the same filters --- */

  const totalOf = async (path: string): Promise<unknown> => (await admin.get(path)).json?.total;
  const register = (status: string, date?: string) =>
    totalOf(`/admin/hr/attendance?status=${status}${date ? `&date=${date}` : ''}&pageSize=1`);
  const pairs: Array<[string, unknown, unknown]> = [
    ['headcount → employees, active', after.headcount?.total, await totalOf('/admin/hr/employees?active=true&approval=approved&pageSize=1')],
    ['present', after.today?.present, await register('present')],
    ['late', after.today?.late, await register('late')],
    ['half day', after.today?.halfDay, await register('half_day')],
    ['absent', after.today?.absent, await register('absent')],
    ['on leave', after.today?.onLeave, await register('on_leave')],
    ['not yet in', after.today?.notYetIn, await register('yet_to_check_in')],
    ['weekly off', after.today?.weeklyOff, await register('weekly_off')],
    ['work from home', after.today?.wfh, await register('wfh')],
    ['field work', after.today?.field, await register('field')],
    ['in right now', after.today?.currentlyIn, await register('currently_in')],
    ['not checked out', after.today?.notCheckedOut, await register('not_checked_out')],
    [
      'missing punches → exceptions',
      after.today?.missingPunches,
      await totalOf(
        `/admin/hr/attendance/exceptions?type=missing_punch&from=${after.today?.missingPunchesSince}&to=${today}&pageSize=1`,
      ),
    ],
    [
      'flagged → exceptions',
      after.today?.flaggedUnreviewed,
      await totalOf(`/admin/hr/attendance/exceptions?type=flagged&reviewed=false&to=${today}&pageSize=1`),
    ],
  ];
  const mismatched = pairs.filter(([, figure, total]) => typeof figure !== 'number' || figure !== total);
  check('every dashboard figure is the total of the filtered screen it opens', mismatched.length === 0, mismatched);
  check(
    'the missing-punch figure covers the seven days ending the date',
    after.today?.missingPunchesSince === addDays(today, -6),
    after.today?.missingPunchesSince,
  );

  const presentToday = await admin.get('/admin/hr/attendance?status=present&pageSize=100');
  check(
    'the register filtered to present lists whoever checked in on time today',
    ((presentToday.json?.items as Json[] | undefined) ?? []).some(
      (row) => row.userId === puncher.id && row.dayStatus === 'checked_in',
    ),
    presentToday.json?.items,
  );
  const inNow = await admin.get('/admin/hr/attendance?status=currently_in&pageSize=100');
  check(
    'and filtered to in right now, them too',
    ((inNow.json?.items as Json[] | undefined) ?? []).some((row) => row.userId === puncher.id),
    inNow.json?.items,
  );

  const pastDate = addDays(today, -3);
  check(
    "a past day's figures match that day's register",
    pastDay.json?.today?.absent === (await register('absent', pastDate)) &&
      pastDay.json?.today?.onLeave === (await register('on_leave', pastDate)) &&
      pastDay.json?.today?.present === (await register('present', pastDate)),
    pastDay.json?.today,
  );
  check(
    "and today's trend point is today's figures",
    after.trend?.[13]?.present === after.today?.present &&
      after.trend?.[13]?.late === after.today?.late &&
      after.trend?.[13]?.onLeave === after.today?.onLeave,
    { trend: after.trend?.[13], today: after.today },
  );

  const supervisor = await ctx.createSignedInEmployee({
    name: `Report Supervisor ${tag}`,
    email: `rpt.supervisor.${tag}@example.test`,
    role: 'supervisor',
  });
  const supervisorDash = await supervisor.client.get('/admin/hr/dashboard');
  check(
    'a supervisor reads the dashboard — but salary totals are null for them',
    supervisorDash.status === 200 && supervisorDash.json?.payroll === null,
    { status: supervisorDash.status, payroll: supervisorDash.json?.payroll },
  );
  const supervisorRegister = await supervisor.client.get('/admin/hr/attendance?status=present&pageSize=1');
  check('a supervisor can open the filtered register a figure links to', supervisorRegister.status === 200, supervisorRegister.status);
  const telecallerDash = await ctx.ravi.get('/admin/hr/dashboard');
  check('a telecaller is refused', telecallerDash.status === 403, telecallerDash.status);
  const hrTokenDash = await fresh.client.get('/admin/hr/dashboard');
  check('an HR app token is refused', hrTokenDash.status === 401, hrTokenDash.status);

  /* ================================================================ reports */
  console.log('\nhrReports: reports and CSV');

  const from = addDays(today, -6);
  const range = `from=${from}&to=${today}`;

  /* --- attendance summary --- */

  const attPage1 = await admin.get(`/admin/hr/reports/attendance?${range}&departmentId=${departmentId}&pageSize=1`);
  const attPage2 = await admin.get(
    `/admin/hr/reports/attendance?${range}&departmentId=${departmentId}&pageSize=1&page=2`,
  );
  check(
    'the attendance report pages over employees',
    attPage1.status === 200 &&
      attPage1.json?.total === 2 &&
      items(attPage1).length === 1 &&
      attPage1.json?.page === 1 &&
      attPage1.json?.pageSize === 1 &&
      items(attPage2).length === 1 &&
      items(attPage2)[0]?.userId !== items(attPage1)[0]?.userId,
    { total: attPage1.json?.total, p1: items(attPage1)[0]?.userId, p2: items(attPage2)[0]?.userId },
  );
  const attOne = await admin.get(`/admin/hr/reports/attendance?${range}&userId=${puncher.id}`);
  const attRow = items(attOne)[0] ?? {};
  const statusSum = ['present', 'late', 'halfDay', 'absent', 'onLeave', 'holidays', 'weeklyOffs', 'upcoming', 'untracked', 'notEmployed']
    .map((key) => Number(attRow[key] ?? NaN))
    .reduce((sum, value) => sum + value, 0);
  check(
    "the puncher's summary covers seven days, today attended",
    attOne.json?.total === 1 && attRow.days === 7 && attRow.attended >= 1 && statusSum === 7,
    attRow,
  );

  const attCsv = await csv(admin, `/admin/hr/reports/attendance?${range}&departmentId=${departmentId}&format=csv`);
  check(
    'the attendance CSV is a UTF-8 attachment with a BOM and CRLF lines',
    attCsv.status === 200 &&
      attCsv.contentType.startsWith('text/csv') &&
      /attachment/.test(attCsv.disposition) &&
      /\.csv/.test(attCsv.disposition) &&
      attCsv.bom &&
      attCsv.crlf,
    { status: attCsv.status, type: attCsv.contentType, disposition: attCsv.disposition, bom: attCsv.bom },
  );
  check(
    'with a header and one row per employee',
    attCsv.lines[0]?.startsWith('Employee code,Name,Department') === true && attCsv.lines.length === 3,
    attCsv.lines,
  );
  check(
    'a cell that would run as a formula is neutralised',
    attCsv.lines.slice(1).every((line) => line.includes(`'=Reports ${tag}`)),
    attCsv.lines.slice(1),
  );
  const attCsvOne = await csv(admin, `/admin/hr/reports/attendance?${range}&userId=${puncher.id}&format=csv`);
  check('filtered to one employee, the CSV has exactly one row', attCsvOne.lines.length === 2, attCsvOne.lines);
  const attCsvNone = await csv(admin, `/admin/hr/reports/attendance?${range}&departmentId=999999999&format=csv`);
  check(
    'nothing matching is a header-only file, not an error',
    attCsvNone.status === 200 && attCsvNone.bom && attCsvNone.lines.length === 1,
    { status: attCsvNone.status, lines: attCsvNone.lines },
  );

  /* --- day by day --- */

  const dailyP1 = await admin.get(`/admin/hr/reports/attendance/daily?${range}&userId=${puncher.id}&pageSize=5`);
  const dailyP2 = await admin.get(
    `/admin/hr/reports/attendance/daily?${range}&userId=${puncher.id}&pageSize=5&page=2`,
  );
  check(
    'the daily report has one row per day and pages through them',
    dailyP1.json?.total === 7 && items(dailyP1).length === 5 && items(dailyP2).length === 2,
    { total: dailyP1.json?.total, p1: items(dailyP1).length, p2: items(dailyP2).length },
  );
  const todayRow = items(dailyP2)[1] ?? {};
  check(
    'the last row is today, checked in — no verdict until the day is over — with a first check-in',
    todayRow.date === today && todayRow.status === 'checked_in' && typeof todayRow.firstIn === 'string',
    todayRow,
  );
  const dailyDept = await admin.get(`/admin/hr/reports/attendance/daily?${range}&departmentId=${departmentId}`);
  check('two employees over seven days is fourteen rows', dailyDept.json?.total === 14, dailyDept.json?.total);
  const dailyCsv = await csv(admin, `/admin/hr/reports/attendance/daily?${range}&userId=${puncher.id}&format=csv`);
  check(
    'the daily CSV has a header and seven rows',
    dailyCsv.status === 200 && dailyCsv.bom && dailyCsv.lines[0]?.startsWith('Date,Weekday,Employee code') === true &&
      dailyCsv.lines.length === 8,
    dailyCsv.lines,
  );

  /* --- ranges --- */

  const tooLong = await admin.get(`/admin/hr/reports/attendance?from=${addDays(today, -100)}&to=${today}`);
  check(
    'an attendance range over 93 days is a 400 that says why',
    tooLong.status === 400 && /93 days/.test(String(tooLong.json?.message)),
    tooLong.json,
  );
  const dailyTooLong = await admin.get(
    `/admin/hr/reports/attendance/daily?from=${addDays(today, -40)}&to=${today}&userId=${puncher.id}`,
  );
  check(
    'the daily report on screen is limited to 31 days',
    dailyTooLong.status === 400 && /31 days/.test(String(dailyTooLong.json?.message)),
    dailyTooLong.json,
  );
  const dailyCsvLonger = await csv(
    admin,
    `/admin/hr/reports/attendance/daily?from=${addDays(today, -40)}&to=${today}&userId=${puncher.id}&format=csv`,
  );
  check(
    'while its CSV takes up to 93 (41 days → 41 rows)',
    dailyCsvLonger.status === 200 && dailyCsvLonger.lines.length === 42,
    { status: dailyCsvLonger.status, lines: dailyCsvLonger.lines.length },
  );
  const inverted = await admin.get(`/admin/hr/reports/attendance?from=${today}&to=${addDays(today, -1)}`);
  check('a range that ends before it starts is a 400', inverted.status === 400, inverted.json);
  const impossible = await admin.get('/admin/hr/reports/attendance?from=2026-02-30&to=2026-03-02');
  check('an impossible date is a 400', impossible.status === 400, impossible.json);
  const csvTooLong = await admin.getRaw(
    `/admin/hr/reports/attendance?from=${addDays(today, -100)}&to=${today}&format=csv`,
  );
  check('a CSV over the limit is refused before any file starts', csvTooLong.status === 400, csvTooLong.status);

  /* --- leave --- */

  const leaveRep = await admin.get(`/admin/hr/reports/leave?year=${year}&userId=${fresh.id}`);
  const leaveRow = items(leaveRep)[0] ?? {};
  const leaveCells: Json[] = Array.isArray(leaveRow.types) ? leaveRow.types : [];
  const cell = leaveCells.find((entry) => entry.leaveTypeId === leaveTypeId);
  check(
    'the leave report shows the tracked balance the app shows',
    leaveRep.status === 200 &&
      leaveRep.json?.total === 1 &&
      cell?.tracked === true &&
      cell?.entitled === 12 &&
      cell?.used === approvedDays &&
      cell?.pending === 1 &&
      cell?.available === 12 - approvedDays - 1,
    cell,
  );
  check(
    'untracked types carry no entitlement, and untracked usage is reported',
    leaveCells
      .filter((entry) => entry.tracked === false)
      .every((entry) => entry.entitled === null && entry.available === null) &&
      typeof leaveRow.untrackedUsage?.wfh === 'number' &&
      typeof leaveRow.untrackedUsage?.unpaid === 'number',
    { cells: leaveCells, untracked: leaveRow.untrackedUsage },
  );
  const leaveDept = await admin.get(`/admin/hr/reports/leave?year=${year}&departmentId=${departmentId}&pageSize=1`);
  check(
    'the leave report pages over employees',
    leaveDept.json?.total === 2 && items(leaveDept).length === 1,
    { total: leaveDept.json?.total, items: items(leaveDept).length },
  );
  const leaveCsv = await csv(admin, `/admin/hr/reports/leave?year=${year}&userId=${fresh.id}&format=csv`);
  check(
    'the leave CSV is one row per type for the employee',
    leaveCsv.status === 200 && leaveCsv.bom && leaveCsv.lines.length === 1 + leaveCells.length && leaveCells.length > 0,
    { lines: leaveCsv.lines.length, types: leaveCells.length },
  );

  /* --- employee directory --- */

  const dir = await admin.get(`/admin/hr/reports/employees?departmentId=${departmentId}&pageSize=1`);
  check(
    'the directory pages',
    dir.status === 200 && dir.json?.total === 2 && items(dir).length === 1,
    { total: dir.json?.total, items: items(dir).length },
  );
  const dirSearch = await admin.get(`/admin/hr/reports/employees?q=${encodeURIComponent(`Report Fresh, ${tag}`)}`);
  check(
    'and searches',
    dirSearch.json?.total === 1 && items(dirSearch)[0]?.userId === fresh.id && items(dirSearch)[0]?.departmentName === deptName,
    items(dirSearch)[0],
  );
  const dirCsv = await csv(admin, `/admin/hr/reports/employees?departmentId=${departmentId}&format=csv`);
  check(
    'the directory CSV has a header and both employees',
    dirCsv.status === 200 && dirCsv.bom && dirCsv.lines[0]?.startsWith('Employee code,Name,Email') === true &&
      dirCsv.lines.length === 3,
    dirCsv.lines,
  );
  check(
    'a value with a comma is quoted (RFC 4180)',
    dirCsv.lines.some((line) => line.includes(`"Report Fresh, ${tag}"`)),
    dirCsv.lines,
  );
  const dirSupervisor = await supervisor.client.get(`/admin/hr/reports/employees?departmentId=${departmentId}`);
  check('a supervisor may read reports', dirSupervisor.status === 200, dirSupervisor.status);
  const dirHr = await fresh.client.get('/admin/hr/reports/employees');
  check('an HR app token may not', dirHr.status === 401, dirHr.status);

  /* --- payroll by year: admin only --- */

  const pay = await admin.get('/admin/hr/reports/payroll?year=2000');
  const periods = items(pay).map((run) => run.period);
  check(
    'the payroll report lists the year’s runs',
    pay.status === 200 && periods.includes('2000-01') && periods.includes('2000-02') && items(pay).length <= 12,
    periods,
  );
  check(
    'and totals only the APPROVED ones',
    pay.json?.approvedTotals?.runs === 1 && pay.json?.approvedTotals?.net === 900.5 &&
      pay.json?.approvedTotals?.gross === 1000,
    pay.json?.approvedTotals,
  );
  const payCsv = await csv(admin, '/admin/hr/reports/payroll?year=2000&format=csv');
  check('its CSV has one row per run', payCsv.status === 200 && payCsv.bom && payCsv.lines.length === 3, payCsv.lines);
  const paySupervisor = await supervisor.client.get('/admin/hr/reports/payroll?year=2000');
  check('a supervisor may NOT read payroll', paySupervisor.status === 403, paySupervisor.status);

  /* ============================================================ audit trail */
  console.log('\nhrReports: audit trail');

  const assignmentAudit = await admin.get('/admin/hr/audit?action=hr_assignment_updated&pageSize=100');
  check(
    'the HR audit trail lists an hr_ action',
    assignmentAudit.status === 200 && items(assignmentAudit).some((entry) => entry.entityId === puncher.id),
    items(assignmentAudit).slice(0, 3),
  );
  check(
    'with the full record shape',
    items(assignmentAudit).every(
      (entry) =>
        typeof entry.id === 'number' &&
        typeof entry.actorType === 'string' &&
        typeof entry.summary === 'string' &&
        typeof entry.createdAt === 'string' &&
        'meta' in entry &&
        'ipAddress' in entry,
    ),
    items(assignmentAudit)[0],
  );
  const exportAudit = await admin.get('/admin/hr/audit?action=hr_report_exported');
  check('CSV exports are themselves audited', Number(exportAudit.json?.total ?? 0) >= 1, exportAudit.json?.total);

  const allHr = await admin.get('/admin/hr/audit?pageSize=100');
  check(
    'every row in it is an hr_ entity',
    items(allHr).length > 0 && items(allHr).every((entry) => String(entry.entityType).startsWith('hr_')),
    items(allHr).map((entry) => entry.entityType),
  );
  const telecallingSide = await admin.get('/admin/telecalling/audit-logs?action=registration_approved');
  const hrSide = await admin.get('/admin/hr/audit?action=registration_approved');
  check(
    'telecalling actions are excluded',
    items(telecallingSide).length > 0 && hrSide.json?.total === 0,
    { telecalling: items(telecallingSide).length, hr: hrSide.json?.total },
  );

  // The escaped underscore: 'hrx_probe' would match an unescaped LIKE 'hr_%'.
  for (const entityType of ['hr_probe', 'hrx_probe', 'hr', 'lead']) {
    await insert(
      `INSERT INTO audit_logs (actor_type, action, entity_type, summary) VALUES ('system', 'e2e_probe', ?, ?)`,
      [entityType, `Report probe ${tag}`],
    );
  }
  const probe = await admin.get(`/admin/hr/audit?q=${encodeURIComponent(`Report probe ${tag}`)}`);
  check(
    'the underscore in hr_ is escaped: hrx_ and bare hr are not HR rows',
    probe.json?.total === 1 && items(probe)[0]?.entityType === 'hr_probe',
    items(probe).map((entry) => entry.entityType),
  );
  const probeToday = await admin.get(
    `/admin/hr/audit?q=${encodeURIComponent(`Report probe ${tag}`)}&from=${today}&to=${today}`,
  );
  const probeTomorrow = await admin.get(
    `/admin/hr/audit?q=${encodeURIComponent(`Report probe ${tag}`)}&from=${addDays(today, 1)}`,
  );
  check(
    'the date filter is the company day',
    probeToday.json?.total === 1 && probeTomorrow.json?.total === 0,
    { today: probeToday.json?.total, tomorrow: probeTomorrow.json?.total },
  );
  const auditPaged = await admin.get('/admin/hr/audit?pageSize=1');
  check(
    'the audit trail pages',
    items(auditPaged).length === 1 && Number(auditPaged.json?.total ?? 0) >= 2 && auditPaged.json?.pageSize === 1,
    { total: auditPaged.json?.total, items: items(auditPaged).length },
  );
  const auditSupervisor = await supervisor.client.get('/admin/hr/audit');
  check('a supervisor may not read the audit trail', auditSupervisor.status === 403, auditSupervisor.status);
  const auditHr = await fresh.client.get('/admin/hr/audit');
  check('nor may an HR app token', auditHr.status === 401, auditHr.status);

  /* ============================================================== scheduler */
  console.log('\nhrReports: scheduler');

  const { runHrSchedulerTick } = await import('../../src/modules/hr/scheduler/hrScheduler');

  /* --- a forgotten check-out from two days ago, for the sweep --- */

  const stale = await ctx.createSignedInHrEmployee({
    name: `Report Stale ${tag}`,
    email: `rpt.stale.${tag}@example.test`,
  });
  const staleDate = addDays(today, -2);
  const staleDayId = await insert(
    `INSERT INTO hr_attendance (user_id, work_date, status, work_mode, source)
     VALUES (?, ?, 'present', 'remote', 'app')`,
    [stale.id, staleDate],
  );
  const staleSessionId = await insert(
    `INSERT INTO hr_attendance_sessions (attendance_id, user_id, started_at, source)
     VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL 40 HOUR, 'app')`,
    [staleDayId, stale.id],
  );

  /* --- shifts relative to now, in IST --- */

  const ist = istNow();
  const minutesNow = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const holidayToday = await scalar(
    'SELECT COUNT(*) AS c FROM hr_holidays WHERE holiday_date = ? AND is_optional = 0',
    [today],
  );
  const remindersTestable = minutesNow >= 60 && holidayToday === 0;
  if (!remindersTestable) {
    console.log(
      `  (note) reminder assertions skipped: IST ${hhmm(minutesNow)}${holidayToday ? ', today is a holiday' : ''} — a shift that started 30 minutes ago would belong to yesterday`,
    );
  }

  const createShift = async (label: string, startsAt: string, endsAt: string): Promise<number> => {
    const created = await admin.post('/admin/hr/shifts', {
      name: `Report ${label} ${tag}`,
      startsAt,
      endsAt,
      breakMinutes: 0,
      graceMinutes: 0,
      halfDayMinutes: 0,
      weeklyOffDays: [],
    });
    check(`the "${label}" shift is created`, created.status === 201, created.json);
    const id = Number(created.json?.shift?.id ?? 0);
    // Belt and braces: no weekly off, so "today" is a working day whatever the weekday.
    await utcDb.query("UPDATE hr_shifts SET weekly_off_days = '' WHERE id = ?", [id]);
    return id;
  };
  const assign = async (userId: number, shiftId: number) => {
    const response = await admin.call('PATCH', `/admin/hr/users/${userId}/assignment`, {
      workMode: 'remote',
      shiftId,
    });
    check('a shift is assigned (remote, no site needed)', response.status === 200, response.json);
  };
  const remindersFor = (userId: number, kind: string) =>
    scalar('SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = ?', [userId, kind]);

  const late = await ctx.createSignedInHrEmployee({ name: `Report Late ${tag}`, email: `rpt.late.${tag}@example.test` });
  const punctual = await ctx.createSignedInHrEmployee({
    name: `Report Punctual ${tag}`,
    email: `rpt.punctual.${tag}@example.test`,
  });
  const overtime = await ctx.createSignedInHrEmployee({
    name: `Report Overtime ${tag}`,
    email: `rpt.overtime.${tag}@example.test`,
  });
  const early = await ctx.createSignedInHrEmployee({ name: `Report Early ${tag}`, email: `rpt.early.${tag}@example.test` });

  if (remindersTestable) {
    // Started 30 minutes ago, eight hours long (it may run past midnight — that is fine).
    const startedShift = await createShift('started', hhmm(minutesNow - 30), hhmm(minutesNow - 30 + 480));
    // Started an hour ago and ended forty minutes ago.
    const endedShift = await createShift('ended', hhmm(minutesNow - 60), hhmm(minutesNow - 40));
    await assign(late.id, startedShift);
    await assign(punctual.id, startedShift);
    await assign(overtime.id, endedShift);
    if (minutesNow + 60 < 1440) {
      await assign(early.id, await createShift('later', hhmm(minutesNow + 60), hhmm(minutesNow + 120)));
    }

    const punctualIn = await punctual.client.post('/hr/attendance/check-in', {});
    check('the punctual employee checks in', punctualIn.status === 201, punctualIn.json);

    const beforeOvertime = await adminDashboard();
    const overtimeIn = await overtime.client.post('/hr/attendance/check-in', {});
    check('the overtime employee checks in after their shift ended', overtimeIn.status === 201, overtimeIn.json);
    const afterOvertime = await adminDashboard();
    check(
      'a session open past its shift end counts as not checked out, not as in',
      afterOvertime.today?.notCheckedOut === Number(beforeOvertime.today?.notCheckedOut ?? NaN) + 1 &&
        afterOvertime.today?.currentlyIn === beforeOvertime.today?.currentlyIn,
      { before: beforeOvertime.today, after: afterOvertime.today },
    );
  }

  const missingBefore = Number((await adminDashboard()).today?.missingPunches ?? NaN);

  const tick1 = await runHrSchedulerTick();
  const tick2 = await runHrSchedulerTick();
  check('the scheduler tick runs without failures', tick1.failures.length === 0 && tick2.failures.length === 0, {
    tick1,
    tick2,
  });

  /* --- the sweep --- */

  check('the tick swept the stale session', tick1.closedSessions >= 1, tick1);
  const swept = await row(
    'SELECT ended_at = started_at AS zero, minutes, auto_closed FROM hr_attendance_sessions WHERE id = ?',
    [staleSessionId],
  );
  check(
    'closed at its own start — zero minutes, marked auto-closed',
    Number(swept?.zero) === 1 && Number(swept?.minutes) === 0 && Number(swept?.auto_closed) === 1,
    swept,
  );
  check(
    'the day became a missing punch',
    (await scalar('SELECT missing_punch AS c FROM hr_attendance WHERE id = ?', [staleDayId])) === 1,
  );
  check(
    'the employee was told, once',
    (await remindersFor(stale.id, 'missing_punch')) === 1,
  );
  const staleDash = await dashboardOf(stale.client);
  check(
    "their dashboard prompts for that day's correction",
    staleDash.today?.missingPunch?.workDate === staleDate,
    staleDash.today?.missingPunch,
  );
  const missingAfter = Number((await adminDashboard()).today?.missingPunches ?? NaN);
  check('the admin dashboard counts it', missingAfter >= missingBefore + 1, { missingBefore, missingAfter });

  /* --- the reminders --- */

  if (remindersTestable) {
    check(
      'exactly one check-in reminder for the employee whose shift began 30 minutes ago, across two ticks',
      (await remindersFor(late.id, 'check_in_reminder')) === 1,
    );
    check(
      'keyed to today, so tomorrow can remind again',
      (await scalar(
        "SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND dedupe_key = ?",
        [late.id, `check_in:${today}`],
      )) === 1,
    );
    check(
      'none for the employee who already checked in',
      (await remindersFor(punctual.id, 'check_in_reminder')) === 0,
    );
    if (minutesNow + 60 < 1440) {
      check('none for a shift that has not started', (await remindersFor(early.id, 'check_in_reminder')) === 0);
    }
    check(
      'exactly one check-out reminder for a session open 40 minutes past its shift end',
      (await remindersFor(overtime.id, 'check_out_reminder')) === 1,
    );
    check(
      'none for a session still inside its shift',
      (await remindersFor(punctual.id, 'check_out_reminder')) === 0,
    );
    const inbox = await late.client.get('/hr/notifications');
    check(
      'the reminder reaches the HR app inbox',
      items(inbox).some((entry) => entry.kind === 'check_in_reminder' && typeof entry.title === 'string'),
      items(inbox).slice(0, 2),
    );
  }
}
