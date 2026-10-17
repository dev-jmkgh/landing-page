import type { Client, E2EContext, Json } from './context';

/**
 * hrPayroll — salary structures, payroll runs, payslips, the PDF and the CSV.
 *
 * The fixture month is LAST month (company calendar), because a run may only be
 * processed once its period has ended. Its attendance, leave and holidays are written
 * straight into the tables, and every expected figure is recomputed here from those
 * fixtures — independently of the server's calendar code — down to the paisa:
 *
 *   alpha    joined long ago. Weekly off Sunday. One paid leave day (CL), one unpaid
 *            leave day (LWP), one half day worked, one absent day that falls on an
 *            OPTIONAL holiday (not a day off), one company holiday, present otherwise.
 *            Basic 30000 + HRA 12000 prorated, Conveyance 1600 fixed; PF 1800, PT 200.
 *   bravo    joined on the 16th, present every working day since — proration for the
 *            days before joining, which are NOT loss of pay. Odd amounts so the half-up
 *            rounding of a paisa is exercised.
 *   charlie  employed, no structure — left out, counted as missing a structure.
 *   delta    structure effective after the period — left out.
 *   echo     exited before the period — not a candidate at all.
 *
 * Fixtures are this section's own: emails `payroll.*`, codes `PRL-*`, names
 * "Payroll * Fixture", one shift, two holidays (removed at the end). The section leaves
 * an APPROVED run for last month behind — approved runs cannot be deleted, by design.
 */

/** Indian digit grouping, written here rather than imported so the PDF check is independent. */
function inr(paise: number): string {
  const digits = String(Math.floor(paise / 100));
  const fraction = String(paise % 100).padStart(2, '0');
  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  return `${[...groups, lastThree].join(',')}.${fraction}`;
}

const decimal = (paise: number) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

/** full × paid / period, half up, in integer arithmetic. */
function halfUp(fullPaise: number, paidTenths: number, periodTenths: number): number {
  if (paidTenths >= periodTenths) return fullPaise;
  const n = BigInt(fullPaise) * BigInt(paidTenths);
  const d = BigInt(periodTenths);
  return Number((2n * n + d) / (2n * d));
}

/**
 * Structural checks a strict PDF reader would make: the header, the trailer, that
 * startxref points at the xref table, that every xref entry is 20 bytes and points at
 * "<n> 0 obj", and that every stream's /Length is its true byte count.
 */
function pdfProblems(body: Buffer): string[] {
  const problems: string[] = [];
  const text = body.toString('latin1');
  if (!text.startsWith('%PDF-1.4')) problems.push('does not start with %PDF-1.4');
  if (!text.trimEnd().endsWith('%%EOF')) problems.push('does not end with %%EOF');

  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!tail) return [...problems, 'no startxref'];
  const xrefAt = Number(tail[1]);
  if (!text.startsWith('xref', xrefAt)) problems.push(`startxref ${xrefAt} does not point at the xref table`);

  const table = /^xref\n0 (\d+)\n([\s\S]*?)trailer\n<<([^>]*)>>/.exec(text.slice(xrefAt));
  if (!table) return [...problems, 'xref table unreadable'];
  const size = Number(table[1]);
  const entries = table[2] ?? '';
  if (entries.length !== size * 20) problems.push(`xref entries are ${entries.length} bytes, expected ${size * 20}`);
  for (let index = 0; index < size; index += 1) {
    const entry = entries.slice(index * 20, index * 20 + 20);
    const match = /^(\d{10}) (\d{5}) ([nf]) \n$/.exec(entry);
    if (!match) {
      problems.push(`xref entry ${index} malformed: ${JSON.stringify(entry)}`);
      continue;
    }
    if (index === 0) continue;
    const offset = Number(match[1]);
    if (!text.startsWith(`${index} 0 obj`, offset)) problems.push(`object ${index} is not at ${offset}`);
  }
  if (!new RegExp(`/Size ${size}\\b`).test(table[3] ?? '')) problems.push('trailer /Size does not match');
  if (!/\/Root 1 0 R/.test(table[3] ?? '')) problems.push('trailer has no /Root');

  const streams = /<< \/Length (\d+) >>\nstream\n/g;
  for (let match = streams.exec(text); match; match = streams.exec(text)) {
    const start = match.index + match[0].length;
    const length = Number(match[1]);
    if (!text.startsWith('\nendstream', start + length)) problems.push(`stream at ${start} has a wrong /Length`);
  }
  return problems;
}

export async function run(ctx: E2EContext): Promise<void> {
  const { check, utcDb, adminAsBearer: admin, ravi, base, makeClient } = ctx;
  console.log('\nhr payroll');

  const { addDays, companyToday, eachDate, monthBounds } = await import('../../src/modules/hr/calendar/calendar.service');

  /* ------------------------------------------------------------- helpers */
  const rows = async (sql: string, params: unknown[] = []): Promise<Json[]> =>
    ((await utcDb.query(sql, params)) as [Json[], unknown])[0];
  const must = (label: string, condition: boolean, detail?: unknown): void => {
    check(label, condition, detail);
    if (!condition) throw new Error(`fixture failed: ${label} — ${JSON.stringify(detail)}`);
  };
  const items = (response: { json: Json }): Json[] =>
    Array.isArray(response.json.items) ? (response.json.items as Json[]) : [];
  const isSunday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

  const today = companyToday();
  const thisMonth = today.slice(0, 7);
  const [year, month] = thisMonth.split('-').map(Number) as [number, number];
  const period = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
  const { start, end } = monthBounds(period);
  const dates = eachDate(start, end);
  const monthName = new Date(`${start}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const periodLabel = `${monthName} ${period.slice(0, 4)}`;

  /*
   * Attendance tracking is judged from the HR setting; clear it for this section so the
   * fixtures mean what they say (and put it back afterwards).
   */
  const savedTracking = await rows(
    "SELECT setting_value FROM hr_settings WHERE setting_key = 'attendance_tracked_from'",
  );
  await utcDb.query("DELETE FROM hr_settings WHERE setting_key = 'attendance_tracked_from'");

  try {
    /* -------------------------------------------- no earlier run in the way */
    for (const wanted of [period, thisMonth]) {
      const existing = (await rows('SELECT id, status FROM hr_payroll_runs WHERE period = ?', [wanted]))[0];
      if (!existing) continue;
      must(`payroll: no approved run for ${wanted} exists before the section`, existing.status !== 'approved', existing);
      await admin.del(`/admin/hr/payroll/runs/${Number(existing.id)}`);
    }

    /* ------------------------------------------------------------ fixtures */
    const longAgo = `${year - 1}-01-01`;
    const alpha = await ctx.createSignedInHrEmployee({
      name: 'Payroll Alpha Fixture',
      email: 'payroll.alpha@example.test',
      joiningDate: longAgo,
      code: 'PRL-0001',
    });
    const bravoJoined = `${period}-16`;
    const bravo = await ctx.createSignedInHrEmployee({
      name: 'Payroll Bravo Fixture',
      email: 'payroll.bravo@example.test',
      joiningDate: bravoJoined,
      code: 'PRL-0002',
    });
    const charlie = await ctx.createSignedInHrEmployee({
      name: 'Payroll Charlie Fixture',
      email: 'payroll.charlie@example.test',
      code: 'PRL-0003',
    });
    const delta = await ctx.createSignedInHrEmployee({
      name: 'Payroll Delta Fixture',
      email: 'payroll.delta@example.test',
      joiningDate: longAgo,
      code: 'PRL-0004',
    });
    const echo = await ctx.createSignedInHrEmployee({
      name: 'Payroll Echo Fixture',
      email: 'payroll.echo@example.test',
      joiningDate: longAgo,
      code: 'PRL-0005',
    });
    await utcDb.query("UPDATE hr_users SET exit_date = ?, is_active = 0, employment_status = 'exited' WHERE id = ?", [
      `${year - 1}-06-30`,
      echo.id,
    ]);

    const shift = await admin.post('/admin/hr/shifts', {
      name: 'Payroll fixture shift',
      startsAt: '09:00',
      endsAt: '18:00',
      breakMinutes: 60,
      graceMinutes: 10,
      halfDayMinutes: 240,
      weeklyOffDays: ['sun'],
    });
    must('payroll: a shift is created for the fixtures', shift.status === 201, shift.json);
    const shiftId = Number(shift.json.shift?.id);
    // Set in SQL as well, so the section does not depend on the shift API's field.
    await utcDb.query("UPDATE hr_shifts SET weekly_off_days = 'sun' WHERE id = ?", [shiftId]);
    for (const person of [alpha, bravo]) {
      const assigned = await admin.call('PATCH', `/admin/hr/users/${person.id}/assignment`, { workMode: 'remote', shiftId });
      must('payroll: a fixture is given the shift, working remotely', assigned.status === 200, assigned.json);
    }

    /* Holidays: one company holiday after the 16th, one OPTIONAL holiday before it. */
    const existingHolidays = new Set(
      (await rows("SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS d FROM hr_holidays WHERE holiday_date BETWEEN ? AND ?", [start, end])).map(
        (row) => String(row.d),
      ),
    );
    const free = (date: string) => !isSunday(date) && !existingHolidays.has(date);
    const holidayDate = dates.find((date) => date >= `${period}-17` && free(date));
    const optionalDate = dates.find((date) => date >= `${period}-03` && date < bravoJoined && free(date));
    must('payroll: free dates for the holiday fixtures', Boolean(holidayDate && optionalDate), { holidayDate, optionalDate });
    await utcDb.query(
      "INSERT INTO hr_holidays (holiday_date, name, is_optional) VALUES (?, 'Payroll test holiday', 0), (?, 'Payroll optional holiday', 1)",
      [holidayDate, optionalDate],
    );
    const offDates = new Set(
      (
        await rows(
          "SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS d FROM hr_holidays WHERE holiday_date BETWEEN ? AND ? AND is_optional = 0",
          [start, end],
        )
      ).map((row) => String(row.d)),
    );

    /* Leave types seeded by migration 028. */
    const types = new Map(
      (await rows("SELECT id, code, kind, is_paid FROM hr_leave_types WHERE code IN ('CL', 'LWP')")).map((row) => [
        String(row.code),
        row,
      ]),
    );
    const casual = types.get('CL');
    const unpaid = types.get('LWP');
    must(
      'payroll: CL is paid leave and LWP is unpaid leave',
      casual?.kind === 'leave' && Number(casual?.is_paid) === 1 && unpaid?.kind === 'leave' && Number(unpaid?.is_paid) === 0,
      [casual, unpaid],
    );

    /* Alpha's month. */
    const alphaWorking = dates.filter((date) => !offDates.has(date) && !isSunday(date));
    const assignable = alphaWorking.filter((date) => date !== optionalDate);
    const [paidLeaveDay, unpaidLeaveDay, halfDayDay, ...alphaPresent] = assignable as [string, string, string, ...string[]];
    const absentDay = optionalDate!;

    const attendanceRow = (userId: number, date: string, status: 'present' | 'half_day') => [
      userId,
      date,
      `${date} 03:30:00`,
      status === 'present' ? `${date} 12:30:00` : `${date} 06:30:00`,
      status === 'present' ? 480 : 180,
      status,
      'remote',
      'app',
    ];
    await utcDb.query(
      `INSERT INTO hr_attendance
         (user_id, work_date, checked_in_at, checked_out_at, worked_minutes, status, work_mode, source)
       VALUES ?`,
      [[...alphaPresent.map((date) => attendanceRow(alpha.id, date, 'present')), attendanceRow(alpha.id, halfDayDay, 'half_day')]],
    );
    await utcDb.query(
      `INSERT INTO hr_leave_requests
         (user_id, leave_type_id, start_date, end_date, half_day, days, reason, status,
          reviewer_type, reviewer_name, reviewed_at)
       VALUES (?, ?, ?, ?, 'none', 1, 'Payroll fixture paid leave', 'approved', 'admin', 'E2E', UTC_TIMESTAMP()),
              (?, ?, ?, ?, 'none', 1, 'Payroll fixture unpaid leave', 'approved', 'admin', 'E2E', UTC_TIMESTAMP())`,
      [alpha.id, Number(casual?.id), paidLeaveDay, paidLeaveDay, alpha.id, Number(unpaid?.id), unpaidLeaveDay, unpaidLeaveDay],
    );

    /* Bravo: present every working day from joining. */
    const bravoEmployed = dates.filter((date) => date >= bravoJoined);
    const bravoWorking = bravoEmployed.filter((date) => !offDates.has(date) && !isSunday(date));
    await utcDb.query(
      `INSERT INTO hr_attendance
         (user_id, work_date, checked_in_at, checked_out_at, worked_minutes, status, work_mode, source)
       VALUES ?`,
      [bravoWorking.map((date) => attendanceRow(bravo.id, date, 'present'))],
    );

    /* ------------------------------------------------- who may touch payroll */
    const supervisor = await ctx.createSignedInEmployee({
      name: 'Payroll Supervisor Fixture',
      email: 'payroll.supervisor@example.test',
      role: 'supervisor',
    });
    const refusals: Array<[string, Client, number[]]> = [
      ['the telecaller ravi', ravi, [403]],
      ['a supervisor', supervisor.client, [403]],
      ['an HR app token', alpha.client, [401, 403]],
    ];
    for (const [who, client, expected] of refusals) {
      const list = await client.get('/admin/hr/payroll/runs');
      check(`payroll: ${who} cannot list payroll runs`, expected.includes(list.status), list.status);
      const read = await client.get(`/admin/hr/payroll/structures?userId=${alpha.id}`);
      check(`payroll: ${who} cannot read salary structures`, expected.includes(read.status), read.status);
      const create = await client.post('/admin/hr/payroll/runs', { period });
      check(`payroll: ${who} cannot create a run`, expected.includes(create.status), create.status);
    }

    /* ---------------------------------------------------------- structures */
    const alphaStructure = await admin.post('/admin/hr/payroll/structures', {
      userId: alpha.id,
      effectiveFrom: longAgo,
      note: 'Payroll fixture',
      components: [
        { label: 'Basic', kind: 'earning', amount: 30000, prorated: true },
        { label: 'HRA', kind: 'earning', amount: 12000, prorated: true },
        { label: 'Conveyance', kind: 'earning', amount: 1600, prorated: false },
        { label: 'Provident fund', kind: 'deduction', amount: 1800 },
        { label: 'Professional tax', kind: 'deduction', amount: 200 },
      ],
    });
    must('payroll: a salary structure is created', alphaStructure.status === 201, alphaStructure.json);
    const alphaStructureId = Number(alphaStructure.json.structure?.id);
    check(
      'payroll: the structure reports full-month totals',
      alphaStructure.json.structure?.totals?.earnings === 43600 &&
        alphaStructure.json.structure?.totals?.deductions === 2000 &&
        alphaStructure.json.structure?.totals?.net === 41600,
      alphaStructure.json.structure?.totals,
    );
    check(
      'payroll: components keep their order and a deduction is never prorated',
      (alphaStructure.json.structure?.components as Json[] | undefined)?.map((c) => c.label).join('|') ===
        'Basic|HRA|Conveyance|Provident fund|Professional tax' &&
        (alphaStructure.json.structure?.components as Json[] | undefined)?.[3]?.prorated === false,
      alphaStructure.json.structure?.components,
    );

    const duplicate = await admin.post('/admin/hr/payroll/structures', {
      userId: alpha.id,
      effectiveFrom: longAgo,
      components: [{ label: 'Basic', kind: 'earning', amount: 1 }],
    });
    check(
      'payroll: a second structure from the same date is refused',
      duplicate.status === 400 && typeof duplicate.json.errors?.effectiveFrom === 'string',
      duplicate.json,
    );
    const noEarnings = await admin.post('/admin/hr/payroll/structures', {
      userId: alpha.id,
      effectiveFrom: `${year - 1}-02-01`,
      components: [{ label: 'PF', kind: 'deduction', amount: 100 }],
    });
    check('payroll: a structure without earnings is refused', noEarnings.status === 422, noEarnings.json);
    const overDeducted = await admin.post('/admin/hr/payroll/structures', {
      userId: alpha.id,
      effectiveFrom: `${year - 1}-02-01`,
      components: [
        { label: 'Basic', kind: 'earning', amount: 100 },
        { label: 'PF', kind: 'deduction', amount: 101 },
      ],
    });
    check('payroll: deductions above earnings are refused', overDeducted.status === 422, overDeducted.json);
    const tooPrecise = await admin.post('/admin/hr/payroll/structures', {
      userId: alpha.id,
      effectiveFrom: `${year - 1}-02-01`,
      components: [{ label: 'Basic', kind: 'earning', amount: 100.005 }],
    });
    check('payroll: an amount finer than a paisa is refused', tooPrecise.status === 422, tooPrecise.json);
    const nobody = await admin.post('/admin/hr/payroll/structures', {
      userId: 987654321,
      effectiveFrom: longAgo,
      components: [{ label: 'Basic', kind: 'earning', amount: 100 }],
    });
    check(
      'payroll: a structure for an unknown employee is refused',
      nobody.status === 400 && typeof nobody.json.errors?.userId === 'string',
      nobody.json,
    );

    const bravoStructure = await admin.post('/admin/hr/payroll/structures', {
      userId: bravo.id,
      effectiveFrom: bravoJoined,
      components: [
        { label: 'Basic', kind: 'earning', amount: 25333.33 },
        { label: 'Internet', kind: 'earning', amount: 999.99, prorated: false },
        { label: 'Professional tax', kind: 'deduction', amount: 200 },
      ],
    });
    must('payroll: a structure for the mid-month joiner', bravoStructure.status === 201, bravoStructure.json);
    // Delta's structure starts after the period, so it is not in force for it.
    const deltaStructure = await admin.post('/admin/hr/payroll/structures', {
      userId: delta.id,
      effectiveFrom: `${thisMonth}-01`,
      components: [{ label: 'Basic', kind: 'earning', amount: 20000 }],
    });
    must('payroll: a future-dated structure', deltaStructure.status === 201, deltaStructure.json);
    const echoStructure = await admin.post('/admin/hr/payroll/structures', {
      userId: echo.id,
      effectiveFrom: longAgo,
      components: [{ label: 'Basic', kind: 'earning', amount: 20000 }],
    });
    must('payroll: a structure for the leaver', echoStructure.status === 201, echoStructure.json);

    const history = await admin.get(`/admin/hr/payroll/structures?userId=${alpha.id}`);
    check(
      "payroll: an employee's structure history lists it, paginated",
      history.status === 200 && Number(history.json.total) === 1 && items(history)[0]?.id === alphaStructureId &&
        history.json.page === 1,
      history.json,
    );

    const setUp = await admin.get('/admin/hr/payroll/employees?q=Payroll%20Alpha%20Fixture');
    const alphaRow = items(setUp).find((row) => row.user?.id === alpha.id);
    check(
      'payroll: the employee list shows the structure in force today',
      setUp.status === 200 && alphaRow?.currentStructure?.id === alphaStructureId && alphaRow?.upcomingStructure === null,
      setUp.json,
    );
    const notSetUp = await admin.get('/admin/hr/payroll/employees?q=Payroll&setUp=false&pageSize=100');
    check(
      'payroll: "not set up" lists the employee with no structure and not the others',
      items(notSetUp).some((row) => row.user?.id === charlie.id) &&
        !items(notSetUp).some((row) => row.user?.id === alpha.id),
      items(notSetUp).map((row) => row.user?.name),
    );

    /* -------------------------------------------- the current month: refused */
    const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
    const future = await admin.post('/admin/hr/payroll/runs', { period: nextMonth });
    check(
      'payroll: a run for a month that has not started is refused',
      future.status === 400 && typeof future.json.errors?.period === 'string',
      future.json,
    );
    const malformed = await admin.post('/admin/hr/payroll/runs', { period: `${year}-13` });
    check('payroll: a malformed period is refused', malformed.status === 422, malformed.json);

    const current = await admin.post('/admin/hr/payroll/runs', { period: thisMonth });
    must('payroll: a draft run for the current month can be created', current.status === 201, current.json);
    const currentId = Number(current.json.run?.id);

    /*
     * The current period is CALCULATED while it runs — figures so far, the rest still to
     * come — but cannot be approved until it has ended and been calculated again.
     */
    const early = await admin.post(`/admin/hr/payroll/runs/${currentId}/process`);
    check(
      'payroll: the current period can be calculated while it is still running',
      early.status === 200 && early.json.run?.status === 'processed',
      early.json,
    );
    check(
      'payroll: and the figures are marked provisional, calculated up to today',
      early.json.run?.provisional === true && early.json.run?.calculatedThrough === today,
      early.json.run,
    );
    check(
      'payroll: everybody left out is named, with the reason',
      Array.isArray(early.json.run?.exclusions) &&
        (early.json.run.exclusions as Json[]).some(
          (entry) => entry.userId === charlie.id && entry.reason === 'no_structure',
        ),
      early.json.run?.exclusions,
    );
    const currentSlip = items(
      await admin.get(`/admin/hr/payroll/runs/${currentId}/payslips?q=${encodeURIComponent('PRL-0001')}`),
    )[0];
    const lastDayOfMonth = monthBounds(thisMonth).end;
    check(
      'payroll: days after today are still to come, not paid and not loss of pay',
      today < lastDayOfMonth ? Number(currentSlip?.remainingDays) > 0 : Number(currentSlip?.remainingDays) >= 0,
      currentSlip && { remaining: currentSlip.remainingDays, lop: currentSlip.lopDays, paid: currentSlip.paidDays },
    );
    const earlyApprove = await admin.post(`/admin/hr/payroll/runs/${currentId}/approve`);
    check(
      'payroll: a period still running cannot be approved',
      earlyApprove.status === 400 && /runs until/.test(String(earlyApprove.json.message)),
      earlyApprove.json,
    );
    const dropCurrent = await admin.del(`/admin/hr/payroll/runs/${currentId}`);
    check('payroll: an unapproved pay period can be deleted', dropCurrent.status === 200, dropCurrent.json);

    /* --- a common pay cycle: 26th to 25th --- */
    const cycle = await admin.patch('/admin/hr/settings', { payrollCycleStartDay: 26 });
    check(
      'payroll: the pay cycle start day is a setting',
      cycle.status === 200 && cycle.json.settings?.payrollCycleStartDay === 26,
      cycle.json,
    );
    const cycleRun = await admin.post('/admin/hr/payroll/runs', { period: '2001-03' });
    check(
      'payroll: a period then runs from the 26th of the month before to the 25th',
      cycleRun.status === 201 &&
        cycleRun.json.run?.periodStart === '2001-02-26' &&
        cycleRun.json.run?.periodEnd === '2001-03-25',
      cycleRun.json.run,
    );
    if (cycleRun.json.run?.id) await admin.del(`/admin/hr/payroll/runs/${Number(cycleRun.json.run.id)}`);
    const badCycle = await admin.patch('/admin/hr/settings', { payrollCycleStartDay: 31 });
    check('payroll: a start day past the 28th is refused', badCycle.status === 422, badCycle.json);
    const resetCycle = await admin.patch('/admin/hr/settings', { payrollCycleStartDay: 1 });
    must('payroll: the cycle goes back to the calendar month', resetCycle.json.settings?.payrollCycleStartDay === 1, resetCycle.json);

    /* ------------------------------------------------ last month: process */
    const created = await admin.post('/admin/hr/payroll/runs', { period, note: 'Payroll fixture run' });
    must('payroll: a run for last month is created as a draft', created.status === 201 && created.json.run?.status === 'draft', created.json);
    const runId = Number(created.json.run?.id);
    check(
      'payroll: the run covers the whole month',
      created.json.run?.periodStart === start && created.json.run?.periodEnd === end,
      created.json.run,
    );
    const again = await admin.post('/admin/hr/payroll/runs', { period });
    check('payroll: a second run for the same month is refused', again.status === 400, again.json);

    const draftApprove = await admin.post(`/admin/hr/payroll/runs/${runId}/approve`);
    check('payroll: a draft cannot be approved', draftApprove.status === 400, draftApprove.json);

    const processed = await admin.post(`/admin/hr/payroll/runs/${runId}/process`);
    must('payroll: last month is processed', processed.status === 200 && processed.json.run?.status === 'processed', processed.json);
    check(
      'payroll: people with no structure in force are counted, not paid',
      Number(processed.json.missingStructure) >= 2,
      processed.json.missingStructure,
    );
    check(
      'payroll: a past period is not provisional and covers every day',
      processed.json.run?.provisional === false && processed.json.run?.calculatedThrough === end,
      processed.json.run,
    );

    const payslipOf = async (code: string): Promise<Json | undefined> => {
      const page = await admin.get(`/admin/hr/payroll/runs/${runId}/payslips?q=${encodeURIComponent(code)}`);
      return items(page)[0];
    };

    /* ---- alpha: expected figures, recomputed */
    const days = dates.length;
    const alphaHolidays = dates.filter((date) => offDates.has(date)).length;
    const alphaWeeklyOffs = dates.filter((date) => !offDates.has(date) && isSunday(date)).length;
    const alphaPresentDays = alphaPresent.length + 0.5;
    const alphaAbsentDays = 1.5; // the optional-holiday day, and the unworked half of the half day
    const alphaLopDays = 2.5; // 1 unpaid leave + 1.5 absent
    const alphaPaidTenths = days * 10 - 25;
    const basic = halfUp(3_000_000, alphaPaidTenths, days * 10);
    const hra = halfUp(1_200_000, alphaPaidTenths, days * 10);
    const alphaGross = basic + hra + 160_000;
    const alphaLop = 3_000_000 - basic + (1_200_000 - hra);
    const alphaNet = alphaGross - 200_000;

    const slip = await payslipOf('PRL-0001');
    must('payroll: alpha has a payslip', Boolean(slip), slip);
    check(
      'payroll: alpha day counts are exact',
      slip?.daysInPeriod === days &&
        slip?.unemployedDays === 0 &&
        slip?.weeklyOffDays === alphaWeeklyOffs &&
        slip?.holidayDays === alphaHolidays &&
        slip?.presentDays === alphaPresentDays &&
        slip?.paidLeaveDays === 1 &&
        slip?.unpaidLeaveDays === 1 &&
        slip?.absentDays === alphaAbsentDays &&
        slip?.untrackedDays === 0,
      { slip, expected: { days, alphaWeeklyOffs, alphaHolidays, alphaPresentDays, alphaAbsentDays } },
    );
    check(
      'payroll: an optional holiday is a working day (alpha was absent on it)',
      slip?.absentDays === alphaAbsentDays,
      { absentDay, absent: slip?.absentDays },
    );
    check(
      'payroll: alpha LOP days and paid days',
      slip?.lopDays === alphaLopDays && slip?.paidDays === days - alphaLopDays,
      { lop: slip?.lopDays, paid: slip?.paidDays },
    );
    check(
      'payroll: alpha gross, LOP amount, deductions and net pay to the paisa',
      slip?.grossEarnings === alphaGross / 100 &&
        slip?.lopAmount === alphaLop / 100 &&
        slip?.totalDeductions === 2000 &&
        slip?.netPay === alphaNet / 100,
      { slip: [slip?.grossEarnings, slip?.lopAmount, slip?.totalDeductions, slip?.netPay], expected: [alphaGross, alphaLop, 200_000, alphaNet] },
    );
    const lines = (slip?.lines as Json[] | undefined) ?? [];
    check(
      'payroll: alpha lines — prorated, fixed and deductions',
      lines.length === 5 &&
        lines[0]?.label === 'Basic' && lines[0]?.fullAmount === 30000 && lines[0]?.amount === basic / 100 &&
        lines[1]?.label === 'HRA' && lines[1]?.amount === hra / 100 &&
        lines[2]?.label === 'Conveyance' && lines[2]?.amount === 1600 &&
        lines[3]?.kind === 'deduction' && lines[3]?.amount === 1800 &&
        lines[4]?.kind === 'deduction' && lines[4]?.amount === 200,
      lines,
    );
    check(
      'payroll: the payslip snapshots the employee',
      slip?.employeeName === 'Payroll Alpha Fixture' && slip?.employeeCode === 'PRL-0001' && slip?.departmentName === null,
      slip,
    );

    /* ---- bravo: joined on the 16th */
    const bravoUnemployed = days - bravoEmployed.length;
    const bravoPaidTenths = bravoEmployed.length * 10;
    const bravoBasic = halfUp(2_533_333, bravoPaidTenths, days * 10);
    const bravoGross = bravoBasic + 99_999;
    const bravoSlip = await payslipOf('PRL-0002');
    must('payroll: bravo has a payslip', Boolean(bravoSlip), bravoSlip);
    check(
      'payroll: bravo — days before joining are not employed, and not loss of pay',
      bravoSlip?.unemployedDays === bravoUnemployed &&
        bravoSlip?.lopDays === 0 &&
        bravoSlip?.paidDays === bravoEmployed.length &&
        bravoSlip?.presentDays === bravoWorking.length &&
        bravoSlip?.absentDays === 0,
      { bravoSlip, bravoUnemployed, employed: bravoEmployed.length, working: bravoWorking.length },
    );
    check(
      'payroll: bravo — proration rounds half up to the paisa, LOP amount stays zero',
      bravoSlip?.grossEarnings === bravoGross / 100 &&
        bravoSlip?.lopAmount === 0 &&
        bravoSlip?.netPay === (bravoGross - 20_000) / 100 &&
        ((bravoSlip?.lines as Json[] | undefined)?.[0]?.amount ?? null) === bravoBasic / 100,
      { got: [bravoSlip?.grossEarnings, bravoSlip?.lopAmount, bravoSlip?.netPay], basicPaise: bravoBasic },
    );

    /* ---- the ones left out */
    const leftOut = await rows(
      'SELECT COUNT(*) AS c FROM hr_payslips WHERE run_id = ? AND user_id IN (?, ?, ?)',
      [runId, charlie.id, delta.id, echo.id],
    );
    check(
      'payroll: no structure, a future structure, or no employed day — no payslip',
      Number(leftOut[0]?.c) === 0,
      leftOut,
    );

    /* ---- the run's totals are its payslips' totals */
    const sums = (
      await rows(
        'SELECT COUNT(*) AS n, SUM(gross_earnings) AS g, SUM(total_deductions) AS d, SUM(net_pay) AS t FROM hr_payslips WHERE run_id = ?',
        [runId],
      )
    )[0];
    const runAfter = processed.json.run as Json | undefined;
    check(
      'payroll: the run rolls up its payslips',
      Number(runAfter?.employeeCount) === Number(sums?.n) &&
        runAfter?.totalGross === Number(sums?.g) &&
        runAfter?.totalDeductions === Number(sums?.d) &&
        runAfter?.totalNet === Number(sums?.t),
      { runAfter, sums },
    );

    /* ---- not visible to the employee yet */
    const beforeList = await alpha.client.get('/hr/payslips');
    check(
      'payroll: a processed (unapproved) payslip is not in the employee list',
      beforeList.status === 200 && !items(beforeList).some((row) => row.id === slip?.id),
      beforeList.json,
    );
    const beforeOne = await alpha.client.get(`/hr/payslips/${Number(slip?.id)}`);
    check('payroll: nor readable by id', beforeOne.status === 404, beforeOne.status);
    const beforeLink = await alpha.client.post(`/hr/payslips/${Number(slip?.id)}/link`);
    check('payroll: nor downloadable', beforeLink.status === 404, beforeLink.status);

    /* ---- no free days: before attendance tracking began is loss of pay too */
    await utcDb.query(
      "INSERT INTO hr_settings (setting_key, setting_value) VALUES ('attendance_tracked_from', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
      [addDays(end, 1)],
    );
    const untrackedRun = await admin.post(`/admin/hr/payroll/runs/${runId}/process`);
    const untrackedSlip = await payslipOf('PRL-0001');
    check(
      'payroll: days before attendance tracking began are not paid for nothing — absences stay loss of pay',
      untrackedRun.status === 200 &&
        untrackedSlip?.untrackedDays === 0 &&
        untrackedSlip?.absentDays === alphaAbsentDays &&
        untrackedSlip?.lopDays === alphaLopDays &&
        untrackedSlip?.netPay === slip?.netPay,
      { untracked: untrackedSlip?.untrackedDays, absent: untrackedSlip?.absentDays, lop: untrackedSlip?.lopDays },
    );
    await utcDb.query("DELETE FROM hr_settings WHERE setting_key = 'attendance_tracked_from'");

    /* ---- paying in full: an administrator's decision, with a reason, recorded */
    const fullPay = await admin.put(`/admin/hr/payroll/runs/${runId}/full-pay/${alpha.id}`, {
      reason: 'Approved by management for September',
    });
    const fullSlip = await payslipOf('PRL-0001');
    check(
      'payroll: an administrator can pay an employee in full — the loss of pay is waived',
      fullPay.status === 200 &&
        fullPay.json.run?.status === 'processed' &&
        fullSlip?.lopDays === 0 &&
        fullSlip?.lopWaivedDays === alphaLopDays &&
        fullSlip?.lopAmount === 0 &&
        fullSlip?.paidDays === days &&
        fullSlip?.grossEarnings === 43600 &&
        fullSlip?.netPay === 43600 - 2000 &&
        fullSlip?.fullPayReason === 'Approved by management for September',
      { status: fullPay.status, slip: fullSlip && [fullSlip.lopDays, fullSlip.lopWaivedDays, fullSlip.paidDays, fullSlip.grossEarnings, fullSlip.netPay] },
    );
    check(
      'payroll: the absences still show — only their loss of pay is waived',
      fullSlip?.absentDays === alphaAbsentDays && fullSlip?.unpaidLeaveDays === 1,
      fullSlip,
    );
    const fullAgain = await admin.post(`/admin/hr/payroll/runs/${runId}/process`);
    const fullAgainSlip = await payslipOf('PRL-0001');
    check(
      'payroll: paying in full survives a recalculation',
      fullAgain.status === 200 && fullAgainSlip?.lopWaivedDays === alphaLopDays && fullAgainSlip?.lopDays === 0,
      fullAgainSlip,
    );
    check(
      'payroll: and is audited, with the reason',
      Number(
        (
          await rows(
            "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_payroll_full_pay_set' AND entity_id = ? AND summary LIKE '%Approved by management%'",
            [runId],
          )
        )[0]?.c,
      ) === 1,
    );
    const fullCsv = (await admin.getRaw(`/admin/hr/payroll/runs/${runId}/export.csv`)).body.toString('utf8');
    const fullCsvLines = fullCsv.replace(/^﻿/, '').split('\r\n');
    check(
      'payroll: the CSV says how much was waived and why, in columns added at the end',
      fullCsvLines[0]?.endsWith('LOP waived days,Paid in full because') === true &&
        (fullCsvLines.find((line) => line.startsWith('PRL-0001,')) ?? '').endsWith(
          `,${alphaLopDays === Math.trunc(alphaLopDays) ? alphaLopDays : alphaLopDays.toFixed(1)},Approved by management for September`,
        ),
      fullCsvLines.slice(0, 2),
    );
    const shortReason = await admin.put(`/admin/hr/payroll/runs/${runId}/full-pay/${alpha.id}`, { reason: 'ok' });
    check('payroll: paying in full needs a reason', shortReason.status === 422 && Boolean(shortReason.json.errors?.reason), shortReason.json);
    const notOnPayroll = await admin.put(`/admin/hr/payroll/runs/${runId}/full-pay/99999999`, { reason: 'Not on this payroll' });
    check("payroll: nor can somebody with no payslip in the period be paid in full", notOnPayroll.status === 404, notOnPayroll.status);
    const supervisorFull = await supervisor.client.put(`/admin/hr/payroll/runs/${runId}/full-pay/${alpha.id}`, {
      reason: 'A supervisor trying',
    });
    check('payroll: a supervisor cannot pay anybody in full', supervisorFull.status === 403, supervisorFull.status);

    const undoFull = await admin.del(`/admin/hr/payroll/runs/${runId}/full-pay/${alpha.id}`);
    const undoneSlip = await payslipOf('PRL-0001');
    check(
      'payroll: withdrawing it puts the loss of pay back',
      undoFull.status === 200 &&
        undoneSlip?.lopDays === alphaLopDays &&
        undoneSlip?.lopWaivedDays === 0 &&
        undoneSlip?.fullPayReason === null &&
        undoneSlip?.netPay === slip?.netPay,
      undoneSlip,
    );
    const undoTwice = await admin.del(`/admin/hr/payroll/runs/${runId}/full-pay/${alpha.id}`);
    check('payroll: withdrawing it twice is refused', undoTwice.status === 400, undoTwice.json);

    /* ---- re-processing is idempotent */
    const reprocessed = await admin.post(`/admin/hr/payroll/runs/${runId}/process`);
    const slipAgain = await payslipOf('PRL-0001');
    check(
      'payroll: re-processing gives the same totals',
      reprocessed.status === 200 &&
        reprocessed.json.run?.totalNet === runAfter?.totalNet &&
        reprocessed.json.run?.totalGross === runAfter?.totalGross &&
        reprocessed.json.run?.employeeCount === runAfter?.employeeCount,
      reprocessed.json,
    );
    check(
      'payroll: and the same payslip figures',
      slipAgain?.netPay === slip?.netPay && slipAgain?.lopDays === slip?.lopDays && slipAgain?.grossEarnings === slip?.grossEarnings,
      slipAgain,
    );
    const lineCount = await rows(
      'SELECT COUNT(*) AS c FROM hr_payslip_lines l JOIN hr_payslips p ON p.id = l.payslip_id WHERE p.run_id = ? AND p.user_id = ?',
      [runId, alpha.id],
    );
    check('payroll: the old payslip lines were replaced, not duplicated', Number(lineCount[0]?.c) === 5, lineCount);
    const slipId = Number(slipAgain?.id);

    /* ---- the structure is now part of the record */
    const keep = await admin.del(`/admin/hr/payroll/structures/${alphaStructureId}`);
    check('payroll: a structure used for a payslip cannot be deleted', keep.status === 400, keep.json);

    /* ---- CSV */
    const csv = await admin.getRaw(`/admin/hr/payroll/runs/${runId}/export.csv`);
    const csvText = csv.body.toString('utf8');
    check(
      'payroll: the CSV export is UTF-8 with a BOM',
      csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') ?? '') &&
        csv.body[0] === 0xef && csv.body[1] === 0xbb && csv.body[2] === 0xbf,
      { status: csv.status, type: csv.headers.get('content-type') },
    );
    const csvLines = csvText.replace(/^﻿/, '').split('\r\n');
    const alphaCsv = csvLines.find((line) => line.startsWith('PRL-0001,'))?.split(',');
    check(
      'payroll: the CSV has a header and alpha’s row with the same figures',
      csvLines[0]?.startsWith('Employee code,Employee name,') === true &&
        alphaCsv?.[1] === 'Payroll Alpha Fixture' &&
        alphaCsv?.[13] === '2.5' &&
        alphaCsv?.[14] === String(days - alphaLopDays) &&
        alphaCsv?.[15] === decimal(alphaGross) &&
        alphaCsv?.[16] === decimal(alphaLop) &&
        alphaCsv?.[17] === '2000.00' &&
        alphaCsv?.[18] === decimal(alphaNet),
      { header: csvLines[0], alphaCsv },
    );
    check(
      'payroll: one CSV row per payslip',
      csvLines.filter((line) => line.length > 0).length === Number(runAfter?.employeeCount) + 1,
      csvLines.length,
    );

    /* ---- the PDF, admin side, before approval */
    const adminPdf = await admin.getRaw(`/admin/hr/payroll/payslips/${slipId}/pdf`);
    const adminPdfText = adminPdf.body.toString('latin1');
    check(
      'payroll: an administrator can open a draft payslip PDF',
      adminPdf.status === 200 && adminPdf.headers.get('content-type') === 'application/pdf',
      { status: adminPdf.status, type: adminPdf.headers.get('content-type') },
    );
    const problems = pdfProblems(adminPdf.body);
    check('payroll: the PDF is structurally valid (header, xref offsets, stream lengths, trailer)', problems.length === 0, problems);
    check(
      'payroll: the PDF carries the company, the month, the net pay and the footer',
      adminPdfText.includes('JMK Global Holdings') &&
        adminPdfText.includes(`Payslip for ${periodLabel}`) &&
        adminPdfText.includes(`INR ${inr(alphaNet)}`) &&
        adminPdfText.includes('PRL-0001') &&
        adminPdfText.includes('This is a system-generated payslip.') &&
        /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/.test(adminPdfText),
      adminPdfText.slice(0, 400),
    );

    /* ---- approve */
    const approved = await admin.post(`/admin/hr/payroll/runs/${runId}/approve`);
    must('payroll: the run is approved', approved.status === 200 && approved.json.run?.status === 'approved', approved.json);
    check(
      'payroll: the approval records who approved it',
      typeof approved.json.run?.approvedByName === 'string' && typeof approved.json.run?.approvedAt === 'string',
      approved.json.run,
    );
    const notices = await rows(
      "SELECT user_id, entity_type, entity_id FROM hr_notifications WHERE kind = 'payslip_published' AND user_id IN (?, ?, ?)",
      [alpha.id, bravo.id, charlie.id],
    );
    check(
      'payroll: each payslip owner is notified, pointing at their payslip',
      notices.length === 2 &&
        notices.some((row) => Number(row.user_id) === alpha.id && row.entity_type === 'hr_payslip' && Number(row.entity_id) === slipId) &&
        !notices.some((row) => Number(row.user_id) === charlie.id),
      notices,
    );

    const twice = await admin.post(`/admin/hr/payroll/runs/${runId}/approve`);
    check('payroll: approving twice is refused', twice.status === 400, twice.json);
    const frozenFull = await admin.put(`/admin/hr/payroll/runs/${runId}/full-pay/${alpha.id}`, {
      reason: 'Too late, it is approved',
    });
    check('payroll: an approved period cannot pay anybody in full', frozenFull.status === 400, frozenFull.json);
    const frozen = await admin.post(`/admin/hr/payroll/runs/${runId}/process`);
    check('payroll: an approved run cannot be re-processed', frozen.status === 400, frozen.json);
    const undeletable = await admin.del(`/admin/hr/payroll/runs/${runId}`);
    check('payroll: an approved run cannot be deleted', undeletable.status === 400, undeletable.json);
    const stillKept = await admin.del(`/admin/hr/payroll/structures/${alphaStructureId}`);
    check('payroll: its structures still cannot be deleted', stillKept.status === 400, stillKept.json);
    const unused = await admin.del(`/admin/hr/payroll/structures/${Number(deltaStructure.json.structure?.id)}`);
    check('payroll: an unused structure can be deleted', unused.status === 200, unused.json);

    const runsPage = await admin.get('/admin/hr/payroll/runs?page=1&pageSize=1');
    check(
      'payroll: the run list is paginated, newest period first',
      runsPage.status === 200 && items(runsPage).length === 1 && runsPage.json.pageSize === 1 && Number(runsPage.json.total) >= 1,
      runsPage.json,
    );

    /* ---- the employee side, after approval */
    const list = await alpha.client.get('/hr/payslips');
    const summary = items(list).find((row) => row.id === slipId);
    check(
      'payroll: after approval the employee sees the payslip',
      list.status === 200 && summary?.period === period && summary?.netPay === alphaNet / 100 &&
        summary?.lopDays === alphaLopDays && typeof summary?.approvedAt === 'string',
      list.json,
    );
    const byYear = await alpha.client.get(`/hr/payslips?year=${period.slice(0, 4)}&page=1&pageSize=5`);
    const otherYear = await alpha.client.get('/hr/payslips?year=2001');
    check(
      'payroll: the list filters by year and paginates',
      items(byYear).some((row) => row.id === slipId) && byYear.json.pageSize === 5 && Number(otherYear.json.total) === 0,
      { byYear: byYear.json, otherYear: otherYear.json },
    );
    const one = await alpha.client.get(`/hr/payslips/${slipId}`);
    check(
      'payroll: the employee reads the payslip with its lines',
      one.status === 200 && one.json.payslip?.netPay === alphaNet / 100 && (one.json.payslip?.lines as Json[] | undefined)?.length === 5,
      one.json,
    );
    const snoop = await bravo.client.get(`/hr/payslips/${slipId}`);
    check("payroll: another employee gets 404 for someone else's payslip", snoop.status === 404, snoop.status);
    const snoopLink = await bravo.client.post(`/hr/payslips/${slipId}/link`);
    check("payroll: and cannot get a link to it", snoopLink.status === 404, snoopLink.status);
    const missing = await alpha.client.get('/hr/payslips/999999999');
    check('payroll: an unknown payslip is 404', missing.status === 404, missing.status);

    const link = await alpha.client.post(`/hr/payslips/${slipId}/link`);
    check(
      'payroll: the employee gets a short-lived download link',
      link.status === 200 && /^\/hr\/files\/.+/.test(String(link.json.path)) && typeof link.json.expiresAt === 'string',
      link.json,
    );
    const download = await makeClient(base).getRaw(String(link.json.path ?? '/hr/files/none'));
    check(
      'payroll: following the link serves application/pdf starting %PDF-',
      download.status === 200 &&
        download.headers.get('content-type') === 'application/pdf' &&
        download.body.subarray(0, 5).toString('latin1') === '%PDF-',
      { status: download.status, type: download.headers.get('content-type') },
    );
    check(
      'payroll: named payslip-<period>-<code>.pdf',
      (download.headers.get('content-disposition') ?? '').includes(`payslip-${period}-PRL-0001.pdf`),
      download.headers.get('content-disposition'),
    );
    const downloadProblems = pdfProblems(download.body);
    check('payroll: the downloaded PDF is structurally valid too', downloadProblems.length === 0, downloadProblems);
    const garbage = await makeClient(base).getRaw('/hr/files/not-a-token');
    check('payroll: a garbage file token is 404', garbage.status === 404, garbage.status);
  } finally {
    await utcDb.query("DELETE FROM hr_holidays WHERE name IN ('Payroll test holiday', 'Payroll optional holiday')");
    const saved = savedTracking[0];
    if (saved) {
      await utcDb.query(
        "INSERT INTO hr_settings (setting_key, setting_value) VALUES ('attendance_tracked_from', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
        [saved.setting_value ?? null],
      );
    }
  }
}
