import type { ApiResponse, E2EContext, Json } from './context';

/**
 * hrCompOff — compensatory leave (migration 038): a day off earned by working a full day
 * on a weekly off or holiday, applied for in one request that names the day worked, and
 * decided by HR administrators only.
 *
 * The worked days are attendance rows written straight in — punching on a past date is
 * not something the app can do — on a shift this section inserts with a weekly off chosen
 * so that a date three days ago was one. Its own holiday is removed at the end and the
 * validity setting is put back.
 */

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export async function run(ctx: E2EContext): Promise<void> {
  console.log('\nhr compensatory leave');

  const { check, utcDb, adminAsBearer: admin } = ctx;
  const cal = await import('../../src/modules/hr/calendar/calendar.service');

  /* ------------------------------------------------------------- helpers */

  const rows = async (statement: string, params: unknown[] = []): Promise<Json[]> => {
    const [result] = (await utcDb.query(statement, params)) as [Json[], unknown];
    return result;
  };
  const count = async (statement: string, params: unknown[] = []): Promise<number> =>
    Number((await rows(statement, params))[0]?.n ?? Number.NaN);
  const must = (label: string, condition: boolean, detail?: unknown): void => {
    check(label, condition, detail);
    if (!condition) throw new Error(`fixture failed: ${label} — ${JSON.stringify(detail)}`);
  };
  const items = (response: ApiResponse): Json[] =>
    Array.isArray(response.json?.items) ? (response.json.items as Json[]) : [];
  const problems = (response: ApiResponse): string[] =>
    Array.isArray(response.json?.problems) ? (response.json.problems as string[]) : [];
  const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

  let keySeq = 0;
  const clientKey = () => `compoff-e2e-${Date.now().toString(36)}-${(keySeq += 1)}`;
  const tag = Date.now().toString(36).slice(-5);

  const today = cal.companyToday();
  const offDay = cal.addDays(today, -3); // a weekly off, worked in full
  const offWeekday = weekday(offDay);
  const workDay = cal.addDays(today, -4); // a working day, worked in full: earns nothing
  const holidayDay = cal.addDays(today, -5); // a holiday, worked in full
  const shortDay = cal.addDays(today, -10); // a weekly off, worked short
  const lapsedDay = cal.addDays(today, -38); // a weekly off, worked in full, too long ago
  let takeDay = cal.addDays(today, 1);
  while (weekday(takeDay) === offWeekday) takeDay = cal.addDays(takeDay, 1);
  let takeDay2 = cal.addDays(takeDay, 1);
  while (weekday(takeDay2) === offWeekday) takeDay2 = cal.addDays(takeDay2, 1);

  /* ------------------------------------------------------------ fixtures */

  const savedValidity = (await rows("SELECT setting_value FROM hr_settings WHERE setting_key = 'comp_off_validity_days'"))[0];
  await utcDb.query("DELETE FROM hr_settings WHERE setting_key = 'comp_off_validity_days'");

  const [shiftInsert] = (await utcDb.query(
    `INSERT INTO hr_shifts (name, starts_at, ends_at, break_minutes, grace_minutes, half_day_minutes, absent_minutes, weekly_off_days)
     VALUES (?, '09:00:00', '18:00:00', 60, 10, 480, 240, ?)`,
    [`Comp-off e2e shift ${tag}`, WEEKDAY_NAMES[offWeekday]],
  )) as unknown as [{ insertId: number }, unknown];
  const shiftId = Number(shiftInsert.insertId);

  const boss = await ctx.createSignedInHrEmployee({
    name: 'Cora Manager',
    email: `cora.manager.${tag}@example.test`,
    role: 'hr_manager',
  });
  const worker = await ctx.createSignedInHrEmployee({
    name: 'Kiran Weekender',
    email: `kiran.weekender.${tag}@example.test`,
    managerId: boss.id,
    joiningDate: '2024-01-01',
  });
  const hrBoss = await ctx.createSignedInHrEmployee({
    name: 'Hema HR Admin',
    email: `hema.hradmin.${tag}@example.test`,
    role: 'hr_admin',
  });
  for (const person of [worker, boss]) {
    const assigned = await admin.patch(`/admin/hr/users/${person.id}/assignment`, { workMode: 'remote', shiftId });
    must('a comp-off fixture is given the shift', assigned.status === 200, assigned.json);
  }

  const holiday = await admin.post('/admin/hr/holidays', { date: holidayDay, name: `Comp-off E2E Holiday ${tag}` });
  const ownHolidayId = holiday.status === 201 ? Number(holiday.json.holiday?.id) : 0;
  must(
    'the holiday worked on exists',
    ownHolidayId > 0 ||
      (await count('SELECT COUNT(*) AS n FROM hr_holidays WHERE holiday_date = ? AND is_optional = 0', [holidayDay])) === 1,
    holiday.json,
  );

  const attendance = (date: string, minutes: number) => [
    worker.id,
    date,
    shiftId,
    `${date} 03:30:00`,
    `${date} 03:30:00`,
    minutes,
    'present',
    'remote',
    'app',
  ];
  await utcDb.query(
    `INSERT INTO hr_attendance
       (user_id, work_date, shift_id, checked_in_at, checked_out_at, worked_minutes, status, work_mode, source)
     VALUES ?`,
    [
      [
        attendance(offDay, 540),
        attendance(workDay, 540),
        attendance(holidayDay, 500),
        attendance(shortDay, 300),
        attendance(lapsedDay, 540),
      ],
    ],
  );
  // Check-out times that match the minutes, so nothing reads the rows as inconsistent.
  await utcDb.query(
    `UPDATE hr_attendance SET checked_out_at = DATE_ADD(checked_in_at, INTERVAL worked_minutes MINUTE)
      WHERE user_id = ? AND shift_id = ?`,
    [worker.id, shiftId],
  );

  try {
    /* ------------------------------------------------------- the type */
    const types = await worker.client.get('/hr/leave/types');
    const compOff = items(types).find((type) => type.isCompOff === true);
    must('the migration adds the compensatory leave type', compOff !== undefined, items(types));
    const compOffId = Number(compOff!.id);
    check(
      'it is leave, whole days only, with no quota',
      compOff!.kind === 'leave' && compOff!.allowHalfDay === false && compOff!.annualQuota === null,
      compOff,
    );

    /* -------------------------------------------- what has been earned */
    const days = await worker.client.get('/hr/leave/comp-off/days');
    const earned = items(days);
    check(
      'the earned days are the weekly off and the holiday worked in full, oldest first',
      days.status === 200 && earned.map((day) => day.date).join(',') === `${holidayDay},${offDay}`,
      days.json,
    );
    check(
      'each says why it counts, the hours, and when it must be used by',
      earned[1]?.reason === 'weekly_off' &&
        earned[1]?.workedMinutes === 540 &&
        earned[1]?.requiredMinutes === 480 &&
        earned[1]?.useBy === cal.addDays(offDay, 30) &&
        earned[0]?.reason === 'holiday' &&
        typeof earned[0]?.holidayName === 'string' &&
        days.json.validityDays === 30,
      earned,
    );

    const balanceOf = async () =>
      items(await worker.client.get('/hr/leave/balances')).find((balance) => balance.leaveType?.id === compOffId);
    const fresh = await balanceOf();
    check(
      'the balance is the days earned and not used',
      fresh?.tracked === true && fresh?.available === 2 && fresh?.entitled === 2 && fresh?.used === 0 && fresh?.pending === 0,
      fresh,
    );
    const workerDash = await worker.client.get('/hr/dashboard');
    const bossDash = await boss.client.get('/hr/dashboard');
    check(
      'the dashboard shows it to somebody who has earned some, and not to somebody who has not',
      ((workerDash.json.leave?.balances as Json[] | undefined) ?? []).some((b) => b.leaveType?.id === compOffId) &&
        !((bossDash.json.leave?.balances as Json[] | undefined) ?? []).some((b) => b.leaveType?.id === compOffId),
      { worker: workerDash.json.leave, boss: bossDash.json.leave },
    );

    /* --------------------------------------------- admin cannot quota it */
    const allocation = await admin.put('/admin/hr/leave-allocations', {
      userId: worker.id,
      leaveTypeId: compOffId,
      year: Number(today.slice(0, 4)),
      days: 5,
    });
    check('compensatory leave cannot be allocated', allocation.status === 400, allocation.json);
    for (const [label, patch] of [
      ['a quota', { annualQuota: 5 }],
      ['half days', { allowHalfDay: true }],
      ['another kind', { kind: 'wfh' }],
    ] as const) {
      const refused = await admin.patch(`/admin/hr/leave-types/${compOffId}`, patch);
      check(`compensatory leave cannot be given ${label}`, refused.status === 400, refused.json);
    }

    /* ------------------------------------------------------- refusals */
    const apply = (body: Json) =>
      worker.client.post('/hr/leave/requests', {
        leaveTypeId: compOffId,
        startDate: takeDay,
        endDate: takeDay,
        reason: 'Worked the weekend release',
        clientKey: clientKey(),
        ...body,
      });
    const preview = (query: string) =>
      worker.client.get(`/hr/leave/preview?leaveTypeId=${compOffId}&${query}`);

    const unnamed = await apply({});
    check(
      'an application must name the day worked',
      unnamed.status === 400 && typeof unnamed.json.errors?.compOffEarnedOn === 'string',
      unnamed.json,
    );
    const working = await apply({ compOffEarnedOn: workDay });
    check(
      'a working day earns nothing',
      working.status === 400 && /working day/.test(String(working.json.errors?.compOffEarnedOn)),
      working.json,
    );
    const short = await apply({ compOffEarnedOn: shortDay });
    check(
      'a weekly off worked short of a full day earns nothing, and says the hours',
      short.status === 400 && /5h was worked/.test(String(short.json.errors?.compOffEarnedOn)) && /8h/.test(String(short.json.errors?.compOffEarnedOn)),
      short.json,
    );
    const lapsed = await apply({ compOffEarnedOn: lapsedDay });
    check(
      'a day worked longer ago than the validity has lapsed',
      lapsed.status === 400 && /had to be taken by/.test(String(lapsed.json.errors?.compOffEarnedOn)),
      lapsed.json,
    );
    const before = await preview(`startDate=${workDay}&compOffEarnedOn=${offDay}`);
    check(
      'the day off must come after the day worked',
      problems(before).some((problem) => problem.includes('after the day worked')),
      before.json,
    );
    const late = await preview(`startDate=${cal.addDays(offDay, 31)}&compOffEarnedOn=${offDay}`);
    check(
      'and within the validity',
      problems(late).some((problem) => problem.includes('must be taken by')),
      late.json,
    );
    const twoDays = await apply({ compOffEarnedOn: offDay, endDate: takeDay2 });
    check('one day worked is one day off', twoDays.status === 400 && /one day for each day worked/.test(String(twoDays.json.message)), twoDays.json);
    const half = await apply({ compOffEarnedOn: offDay, halfDay: 'first_half' });
    check('and never a half day', half.status === 400 && typeof half.json.errors?.halfDay === 'string', half.json);

    const good = await preview(`startDate=${takeDay}&compOffEarnedOn=${offDay}`);
    check(
      'a valid preview costs one day and leaves one',
      good.status === 200 && good.json.days === 1 && good.json.balanceAfter === 1 && problems(good).length === 0,
      good.json,
    );

    /* ------------------------------------------------------- applying */
    const applied = await apply({ compOffEarnedOn: offDay });
    must('an employee applies for compensatory leave', applied.status === 201, applied.json);
    const requestId = Number(applied.json.request?.id);
    check(
      'the request names the day worked',
      applied.json.request?.compOffEarnedOn === offDay && applied.json.request?.leaveType?.isCompOff === true,
      applied.json.request,
    );
    check(
      'HR administrators are told, not the manager',
      (await count(
        "SELECT COUNT(*) AS n FROM hr_notifications WHERE user_id = ? AND kind = 'leave_submitted' AND entity_id = ?",
        [hrBoss.id, requestId],
      )) === 1 &&
        (await count(
          "SELECT COUNT(*) AS n FROM hr_notifications WHERE user_id = ? AND kind = 'leave_submitted' AND entity_id = ?",
          [boss.id, requestId],
        )) === 0,
    );

    const twice = await apply({ compOffEarnedOn: offDay, startDate: takeDay2, endDate: takeDay2 });
    check(
      'the same day worked cannot be used twice',
      twice.status === 400 && /already been used/.test(String(twice.json.errors?.compOffEarnedOn)),
      twice.json,
    );
    const left = await worker.client.get('/hr/leave/comp-off/days');
    check(
      'and it leaves the list of days to use',
      items(left).map((day) => day.date).join(',') === holidayDay,
      left.json,
    );
    const pendingBalance = await balanceOf();
    check(
      'the balance shows it pending',
      pendingBalance?.available === 1 && pendingBalance?.pending === 1 && pendingBalance?.entitled === 2,
      pendingBalance,
    );

    /* ------------------------------------------------------- who decides */
    const managerQueue = await boss.client.get('/hr/team/leave-requests?status=pending');
    check(
      "it is not in the team manager's queue",
      managerQueue.status === 200 && !items(managerQueue).some((request) => request.id === requestId),
      managerQueue.json,
    );
    const managerApprove = await boss.client.post(`/hr/team/leave-requests/${requestId}/approve`, {});
    check('and the team manager cannot decide it', managerApprove.status === 403, managerApprove.json);
    const hrQueue = await hrBoss.client.get('/hr/team/leave-requests?status=pending');
    check(
      "it is in an HR administrator's queue",
      items(hrQueue).some((request) => request.id === requestId),
      hrQueue.json,
    );
    const approved = await hrBoss.client.post(`/hr/team/leave-requests/${requestId}/approve`, {});
    check(
      'an HR administrator approves it',
      approved.status === 200 && approved.json.request?.status === 'approved',
      approved.json,
    );
    const usedBalance = await balanceOf();
    check('the balance shows it used', usedBalance?.used === 1 && usedBalance?.available === 1, usedBalance);

    /* ---------------------------- rejected and cancelled days are free again */
    const second = await apply({ compOffEarnedOn: holidayDay, startDate: takeDay2, endDate: takeDay2 });
    must('a second application, for the holiday worked', second.status === 201, second.json);
    const secondId = Number(second.json.request?.id);
    const rejected = await admin.post(`/admin/hr/leave-requests/${secondId}/reject`, { note: 'Not this week' });
    check('the admin portal can reject it', rejected.status === 200, rejected.json);
    const afterReject = await worker.client.get('/hr/leave/comp-off/days');
    check(
      'a rejected request gives the day worked back',
      items(afterReject).map((day) => day.date).join(',') === holidayDay,
      afterReject.json,
    );

    const third = await apply({ compOffEarnedOn: holidayDay, startDate: takeDay2, endDate: takeDay2 });
    must('the holiday can be applied for again', third.status === 201, third.json);
    const thirdId = Number(third.json.request?.id);

    // Its attendance is corrected down before anybody decides: approval must look again.
    await utcDb.query('UPDATE hr_attendance SET worked_minutes = 300 WHERE user_id = ? AND work_date = ?', [
      worker.id,
      holidayDay,
    ]);
    const stale = await admin.post(`/admin/hr/leave-requests/${thirdId}/approve`, {});
    check(
      'approval re-checks the day worked and refuses when it no longer counts',
      stale.status === 400 && /cannot be approved/.test(String(stale.json.message)),
      stale.json,
    );
    await utcDb.query('UPDATE hr_attendance SET worked_minutes = 500 WHERE user_id = ? AND work_date = ?', [
      worker.id,
      holidayDay,
    ]);

    const cancelled = await worker.client.post(`/hr/leave/requests/${thirdId}/cancel`, {});
    check('the employee can withdraw it', cancelled.status === 200, cancelled.json);
    const afterCancel = await worker.client.get('/hr/leave/comp-off/days');
    check(
      'and the day worked is free again',
      items(afterCancel).map((day) => day.date).join(',') === holidayDay,
      afterCancel.json,
    );

    /* ------------------------------------------------------ the setting */
    const badSetting = await admin.patch('/admin/hr/settings', { compOffValidityDays: 0 });
    check('the validity must be at least a day', badSetting.status === 422, badSetting.json);
    const longer = await admin.patch('/admin/hr/settings', { compOffValidityDays: 45 });
    check(
      'an admin can lengthen the validity',
      longer.status === 200 && longer.json.settings?.compOffValidityDays === 45,
      longer.json,
    );
    const revived = await worker.client.get('/hr/leave/comp-off/days');
    check(
      'and a day that had lapsed under 30 days counts again under 45',
      items(revived).some((day) => day.date === lapsedDay) && revived.json.validityDays === 45,
      revived.json,
    );
  } finally {
    await utcDb.query("DELETE FROM hr_settings WHERE setting_key = 'comp_off_validity_days'");
    if (savedValidity) {
      await utcDb.query("INSERT INTO hr_settings (setting_key, setting_value) VALUES ('comp_off_validity_days', ?)", [
        savedValidity.setting_value,
      ]);
    }
    if (ownHolidayId > 0) await admin.del(`/admin/hr/holidays/${ownHolidayId}`);
  }
}
