import type { E2EContext, Json } from './context';

/**
 * hrCore — the shared HR machinery the later modules stand on.
 *
 *   - a forgotten check-out no longer locks somebody out: it is closed as a missing
 *     punch, the day is flagged, the employee is told, and today's check-in works
 *   - a night shift's session is NOT swept as forgotten while it is still within the
 *     open-session limit
 *   - an office worker with no site is refused (the refusal used to be unreachable)
 *   - suspicious punches are flagged, not refused
 *   - the month calendar classifies holidays, weekly offs, untracked and absent days
 *   - corrections are stored as UTC instants, so 09:00 IST is 03:30Z
 */
export async function run(ctx: E2EContext): Promise<void> {
  const { check, utcDb, adminAsBearer } = ctx;
  console.log('\nhr core');

  const rows = async (sql: string, params: unknown[] = []): Promise<Json[]> =>
    ((await utcDb.query(sql, params)) as [Json[], unknown])[0];

  const istDate = async (offsetDays: number): Promise<string> =>
    String(
      (
        await rows(
          "SELECT DATE_FORMAT(DATE_ADD(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30')), INTERVAL ? DAY), '%Y-%m-%d') AS d",
          [offsetDays],
        )
      )[0]?.d,
    );

  const today = await istDate(0);
  const twoDaysAgo = await istDate(-2);
  const yesterday = await istDate(-1);

  /* ------------------------------------------------ a forgotten check-out */
  const forgetful = await ctx.createSignedInHrEmployee({
    name: 'Core Forgetful',
    email: 'core.forgetful@example.test',
  });
  const remote = await adminAsBearer.call(
    'PATCH',
    `/admin/hr/users/${forgetful.id}/assignment`,
    { workMode: 'remote' },
  );
  check('core: a fixture is set to remote work', remote.status === 200, remote.json);

  // A day two days ago with a session that was never closed, started 50 hours ago.
  await utcDb.query(
    `INSERT INTO hr_attendance (user_id, work_date, work_mode, source, status, checked_in_at)
     VALUES (?, ?, 'remote', 'app', 'present', UTC_TIMESTAMP() - INTERVAL 50 HOUR)`,
    [forgetful.id, twoDaysAgo],
  );
  const staleDayId = Number(
    (await rows('SELECT id FROM hr_attendance WHERE user_id = ? AND work_date = ?', [forgetful.id, twoDaysAgo]))[0]?.id,
  );
  await utcDb.query(
    `INSERT INTO hr_attendance_sessions (attendance_id, user_id, started_at, source)
     VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL 50 HOUR, 'app')`,
    [staleDayId, forgetful.id],
  );

  const todayView = await forgetful.client.get('/hr/attendance/today');
  check('core: today responds for someone with a forgotten session', todayView.status === 200, todayView.json);
  check(
    'core: and does not show the stale session as running',
    todayView.json.day === null || todayView.json.day?.openSessionStartedAt === null,
    todayView.json.day,
  );
  check(
    'core: the missing punch is surfaced for a correction',
    todayView.json.missingPunch?.workDate === twoDaysAgo,
    todayView.json.missingPunch,
  );

  const swept = (
    await rows('SELECT ended_at, minutes, auto_closed FROM hr_attendance_sessions WHERE attendance_id = ?', [staleDayId])
  )[0];
  check(
    'core: the stale session is closed at zero minutes, not credited',
    swept?.ended_at !== null && Number(swept?.minutes) === 0 && Number(swept?.auto_closed) === 1,
    swept,
  );
  const sweptDay = (await rows('SELECT missing_punch, worked_minutes FROM hr_attendance WHERE id = ?', [staleDayId]))[0];
  check('core: the day is flagged as a missing punch', Number(sweptDay?.missing_punch) === 1, sweptDay);

  const notice = await rows(
    "SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'missing_punch'",
    [forgetful.id],
  );
  check('core: the employee is told about the missing check-out', Number(notice[0]?.c) === 1, notice);

  const checkInNow = await forgetful.client.post('/hr/attendance/check-in', {});
  check(
    'core: and can check in today (yesterday no longer locks them out)',
    checkInNow.status === 201 && checkInNow.json.alreadyCheckedIn === false,
    checkInNow.json,
  );

  const sweptAgain = await forgetful.client.get('/hr/attendance/today');
  const notices = await rows(
    "SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'missing_punch'",
    [forgetful.id],
  );
  check(
    'core: re-reading today does not notify twice',
    sweptAgain.status === 200 && Number(notices[0]?.c) === 1,
    notices,
  );

  /* ------------------------------------------------ correction stored in UTC */
  const correction = await forgetful.client.post('/hr/attendance/regularisations', {
    workDate: twoDaysAgo,
    checkInAt: '09:00',
    checkOutAt: '18:00',
    reason: 'Forgot to check out after the client visit',
  });
  check('core: a correction is raised for the missing punch', correction.status === 201, correction.json);
  check(
    'core: 09:00 company time is stored as 03:30 UTC',
    correction.json.request?.requestedCheckInAt === `${twoDaysAgo}T03:30:00.000Z`,
    correction.json.request?.requestedCheckInAt,
  );
  check(
    'core: and 18:00 as 12:30 UTC',
    correction.json.request?.requestedCheckOutAt === `${twoDaysAgo}T12:30:00.000Z`,
    correction.json.request?.requestedCheckOutAt,
  );

  const afterRaise = await forgetful.client.get('/hr/attendance/today');
  check(
    'core: a day with a correction waiting is no longer prompted',
    afterRaise.json.missingPunch === null,
    afterRaise.json.missingPunch,
  );

  const regPage = await forgetful.client.get('/hr/attendance/regularisations?page=1&pageSize=5');
  check(
    'core: the employee correction list is paginated',
    regPage.status === 200 && regPage.json.page === 1 && regPage.json.pageSize === 5 && Number(regPage.json.total) >= 1,
    regPage.json,
  );

  const decided = await adminAsBearer.post(
    `/admin/hr/regularisations/${Number(correction.json.request?.id)}/approve`,
    { note: 'Confirmed' },
  );
  check('core: the correction is approved', decided.status === 200, decided.json);
  check(
    'core: and records who decided',
    typeof decided.json.request?.reviewerName === 'string' && decided.json.request.reviewerName.length > 0,
    decided.json.request,
  );

  const fixedSession = (
    await rows(
      "SELECT DATE_FORMAT(started_at, '%Y-%m-%d %H:%i') AS s, DATE_FORMAT(ended_at, '%Y-%m-%d %H:%i') AS e, auto_closed FROM hr_attendance_sessions WHERE attendance_id = ?",
      [staleDayId],
    )
  )[0];
  check(
    'core: the corrected session starts at 03:30 UTC (09:00 IST)',
    fixedSession?.s === `${twoDaysAgo} 03:30` && fixedSession?.e === `${twoDaysAgo} 12:30`,
    fixedSession,
  );
  const fixedDay = (await rows('SELECT missing_punch, worked_minutes FROM hr_attendance WHERE id = ?', [staleDayId]))[0];
  check(
    'core: and the missing-punch flag clears with the correction',
    Number(fixedDay?.missing_punch) === 0 && Number(fixedDay?.worked_minutes) === 540,
    fixedDay,
  );
  const approvedNotice = await rows(
    "SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'regularisation_approved'",
    [forgetful.id],
  );
  check('core: the employee is told it was approved', Number(approvedNotice[0]?.c) === 1, approvedNotice);

  /* ------------------------------------------------ a night shift is left alone */
  const nightOwl = await ctx.createSignedInHrEmployee({
    name: 'Core Night Owl',
    email: 'core.night@example.test',
  });
  await adminAsBearer.call('PATCH', `/admin/hr/users/${nightOwl.id}/assignment`, { workMode: 'field' });
  await utcDb.query(
    `INSERT INTO hr_attendance (user_id, work_date, work_mode, source, status, checked_in_at)
     VALUES (?, ?, 'field', 'app', 'present', UTC_TIMESTAMP() - INTERVAL 6 HOUR)`,
    [nightOwl.id, yesterday],
  );
  const nightDayId = Number(
    (await rows('SELECT id FROM hr_attendance WHERE user_id = ? AND work_date = ?', [nightOwl.id, yesterday]))[0]?.id,
  );
  await utcDb.query(
    `INSERT INTO hr_attendance_sessions (attendance_id, user_id, started_at, source)
     VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL 6 HOUR, 'app')`,
    [nightDayId, nightOwl.id],
  );
  const nightToday = await nightOwl.client.get('/hr/attendance/today');
  check(
    "core: a session still inside the open limit shows as running on the day it started",
    nightToday.json.day?.workDate === yesterday && typeof nightToday.json.day?.openSessionStartedAt === 'string',
    nightToday.json.day,
  );
  const nightOut = await nightOwl.client.post('/hr/attendance/check-out', {});
  check(
    'core: and checks out against that day',
    nightOut.status === 200 && nightOut.json.day?.workDate === yesterday && Number(nightOut.json.day?.workedMinutes) >= 359,
    nightOut.json,
  );

  /* ------------------------------------------------ office worker with no site */
  const unplaced = await ctx.createSignedInHrEmployee({
    name: 'Core Unplaced',
    email: 'core.unplaced@example.test',
  });
  const refused = await unplaced.client.post('/hr/attendance/check-in', {});
  check(
    'core: an office worker with no site is refused, with a code the app can act on',
    refused.status === 409 && refused.json.code === 'no_site_assigned',
    refused.json,
  );

  /* ------------------------------------------------ flagged, not refused */
  const suspect = await ctx.createSignedInHrEmployee({
    name: 'Core Suspect',
    email: 'core.suspect@example.test',
  });
  await adminAsBearer.call('PATCH', `/admin/hr/users/${suspect.id}/assignment`, { workMode: 'remote' });
  const skewed = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const mockedIn = await suspect.client.post('/hr/attendance/check-in', {
    coordinate: { latitude: 10, longitude: 76, accuracyMetres: 900 },
    deviceTime: skewed,
    mocked: true,
  });
  check('core: a punch from a mock location is accepted', mockedIn.status === 201, mockedIn.json);
  const flags = (mockedIn.json.day?.sessions as Json[] | undefined)?.[0]?.flags as string[] | undefined;
  check(
    'core: and flagged mock location, clock skew and low accuracy',
    Boolean(flags?.includes('mock_location') && flags?.includes('clock_skew') && flags?.includes('low_accuracy')),
    flags,
  );
  check('core: the day is marked for review', mockedIn.json.day?.flagged === true, mockedIn.json.day);
  const cleanOut = await suspect.client.post('/hr/attendance/check-out', {
    deviceTime: new Date().toISOString(),
  });
  check('core: a clean check-out still works', cleanOut.status === 200, cleanOut.json);

  /* ------------------------------------------------ the month calendar */
  const shift = await adminAsBearer.post('/admin/hr/shifts', {
    name: 'Core calendar shift',
    startsAt: '09:00',
    endsAt: '18:00',
    breakMinutes: 60,
    graceMinutes: 10,
    halfDayMinutes: 240,
  });
  check('core: a shift is created for the calendar fixture', shift.status === 201, shift.json);
  const shiftId = Number(shift.json.shift?.id);

  const calendarUser = await ctx.createSignedInHrEmployee({
    name: 'Core Calendar',
    email: 'core.calendar@example.test',
  });
  await adminAsBearer.call('PATCH', `/admin/hr/users/${calendarUser.id}/assignment`, {
    workMode: 'remote',
    shiftId,
  });
  // Saturday and Sunday off for this shift, set directly so this section does not
  // depend on the shift API learning the field.
  await utcDb.query("UPDATE hr_shifts SET weekly_off_days = 'sat,sun' WHERE id = ?", [shiftId]);

  const month = today.slice(0, 7);
  const firstOfMonth = `${month}-01`;
  // A holiday on the first of the month unless that is today (then the 2nd, if past).
  const holidayDate = firstOfMonth;
  await utcDb.query(
    "INSERT INTO hr_holidays (holiday_date, name) VALUES (?, 'Core test holiday') ON DUPLICATE KEY UPDATE name = name",
    [holidayDate],
  );

  const calendar = await calendarUser.client.get(`/hr/attendance/calendar?month=${month}`);
  check('core: the month calendar responds', calendar.status === 200, calendar.json);
  const days = (calendar.json.days as Json[] | undefined) ?? [];
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  check('core: with every date of the month', days.length === daysInMonth, days.length);

  const byDate = new Map(days.map((day) => [String(day.date), day]));
  const holidayDay = byDate.get(holidayDate);
  check(
    'core: a holiday is a holiday (unless it is a weekly off, which wins only when not a holiday)',
    ['holiday', 'upcoming', 'present', 'checked_in', 'checked_out'].includes(String(holidayDay?.status)),
    holidayDay,
  );
  check(
    'core: holiday details travel with the day',
    holidayDay?.holiday?.name === 'Core test holiday',
    holidayDay?.holiday,
  );
  const weekend = days.find((day) => (day.weekday === 'sat' || day.weekday === 'sun') && day.date !== holidayDate);
  check('core: a Saturday or Sunday is a weekly off for this shift', weekend?.status === 'weekly_off', weekend);
  const pastWorkday = days.find(
    (day) => day.date < today && day.date !== holidayDate && day.weekday !== 'sat' && day.weekday !== 'sun',
  );
  if (pastWorkday) {
    check('core: a past working day with no attendance is absent', pastWorkday.status === 'absent', pastWorkday);

    // Tracking that began after it makes the same day untracked, not absent.
    await utcDb.query(
      "INSERT INTO hr_settings (setting_key, setting_value) VALUES ('attendance_tracked_from', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
      [today],
    );
    const tracked = await calendarUser.client.get(`/hr/attendance/calendar?month=${month}`);
    const sameDay = ((tracked.json.days as Json[] | undefined) ?? []).find((day) => day.date === pastWorkday.date);
    check('core: before attendance tracking began, the day is untracked', sameDay?.status === 'untracked', sameDay);
    await utcDb.query("DELETE FROM hr_settings WHERE setting_key = 'attendance_tracked_from'");
  } else {
    console.log('  (core: first working day of the month — absent/untracked checks skipped)');
  }
  const future = days.find((day) => day.date > today && day.status !== 'weekly_off' && day.status !== 'holiday');
  if (future) check('core: a future working day is upcoming', future.status === 'upcoming', future);

  const badMonth = await calendarUser.client.get('/hr/attendance/calendar?month=2026-13');
  check('core: a malformed month is refused', badMonth.status === 422 || badMonth.status === 400, badMonth.status);

  await utcDb.query("DELETE FROM hr_holidays WHERE name = 'Core test holiday'");

  /* ------------------------------------------------ notifications inbox */
  const inbox = await forgetful.client.get('/hr/notifications?page=1&pageSize=1');
  check(
    'core: the inbox is paginated and counts unread',
    inbox.status === 200 && (inbox.json.items as Json[] | undefined)?.length === 1 && Number(inbox.json.total) >= 2 &&
      Number(inbox.json.unread) >= 2,
    inbox.json,
  );
  const firstId = Number((inbox.json.items as Json[] | undefined)?.[0]?.id);
  const marked = await forgetful.client.post('/hr/notifications/read', { ids: [firstId] });
  check(
    'core: marking one read lowers the unread count by one',
    marked.status === 200 && Number(marked.json.unread) === Number(inbox.json.unread) - 1,
    marked.json,
  );
  const peek = await suspect.client.post('/hr/notifications/read', { ids: [firstId] });
  check(
    "core: someone else's notification cannot be marked",
    peek.status === 200 && Number(peek.json.changed) === 0,
    peek.json,
  );
  const allRead = await forgetful.client.post('/hr/notifications/read-all', {});
  const count = await forgetful.client.get('/hr/notifications/unread-count');
  check('core: read-all clears the badge', allRead.status === 200 && count.json.unread === 0, count.json);

  const telecallerPeek = await ctx.ravi.get('/hr/notifications');
  check('core: a telecalling token cannot read the HR inbox', telecallerPeek.status === 401, telecallerPeek.status);

  /* ------------------------------------------------ the day's status, from scratch */
  /*
   * Half day is decided from the totals every time: a short closed day is a half day
   * even when it started late, and stops being one when more sessions take it past the
   * threshold (the shift above allows 240 minutes for a half day).
   */
  const halfDayUser = await ctx.createSignedInHrEmployee({
    name: 'Core Half Day',
    email: 'core.halfday@example.test',
  });
  await adminAsBearer.call('PATCH', `/admin/hr/users/${halfDayUser.id}/assignment`, {
    workMode: 'remote',
    shiftId,
  });
  const shortLate = await adminAsBearer.put(`/admin/hr/attendance/${halfDayUser.id}/${twoDaysAgo}`, {
    sessions: [{ startAt: '11:00', endAt: '11:07' }],
    reason: 'Seven minutes, late',
  });
  check(
    'core: seven minutes worked after a late start is a half day, not a full one',
    shortLate.status === 200 && shortLate.json.day?.status === 'half_day' && Number(shortLate.json.day?.lateMinutes) > 0,
    shortLate.json.day,
  );
  const fullDay = await adminAsBearer.put(`/admin/hr/attendance/${halfDayUser.id}/${twoDaysAgo}`, {
    sessions: [
      { startAt: '09:00', endAt: '12:00' },
      { startAt: '13:00', endAt: '17:30' },
    ],
    reason: 'Morning and afternoon',
  });
  check(
    'core: a day taken past the half-day threshold by a later session is no longer a half day',
    fullDay.status === 200 && fullDay.json.day?.status === 'present' && Number(fullDay.json.day?.workedMinutes) === 450,
    fullDay.json.day,
  );

  /* ------------------------------------------------ full day, half day, absent */
  /*
   * Two thresholds: 7h or more is a full day, 3h30 or more a half day, less is absent.
   * The shift's `halfDayMinutes` is the full-day minimum; `absentMinutes` the half-day one.
   */
  const backwards = await adminAsBearer.patch(`/admin/hr/shifts/${shiftId}`, { halfDayMinutes: 420, absentMinutes: 480 });
  check(
    'core: a half-day minimum above the full-day minimum is refused',
    backwards.status === 422 && typeof backwards.json.errors?.absentMinutes === 'string',
    backwards.json,
  );
  const badCreate = await adminAsBearer.post('/admin/hr/shifts', {
    name: 'Core backwards shift',
    startsAt: '09:00',
    endsAt: '18:00',
    breakMinutes: 60,
    graceMinutes: 10,
    halfDayMinutes: 200,
    absentMinutes: 300,
  });
  check('core: and on a new shift too', badCreate.status === 422, badCreate.json);

  const thresholds = await adminAsBearer.patch(`/admin/hr/shifts/${shiftId}`, { halfDayMinutes: 420, absentMinutes: 210 });
  check(
    'core: a shift takes a full-day and a half-day minimum',
    thresholds.status === 200 && thresholds.json.shift?.halfDayMinutes === 420 && thresholds.json.shift?.absentMinutes === 210,
    thresholds.json,
  );

  const judge = async (sessions: Array<{ startAt: string; endAt: string }>) =>
    adminAsBearer.put(`/admin/hr/attendance/${halfDayUser.id}/${twoDaysAgo}`, { sessions, reason: 'Threshold check' });
  const underHalf = await judge([{ startAt: '09:00', endAt: '10:00' }]);
  check('core: under the half-day minimum is absent', underHalf.json.day?.status === 'absent', underHalf.json.day);
  const betweenTwo = await judge([{ startAt: '09:00', endAt: '13:00' }]);
  check('core: between the two minimums is a half day', betweenTwo.json.day?.status === 'half_day', betweenTwo.json.day);
  const overFull = await judge([{ startAt: '09:00', endAt: '17:00' }]);
  check('core: at or over the full-day minimum is a full day', overFull.json.day?.status === 'present', overFull.json.day);

  const viewDay = async () =>
    ((await adminAsBearer.get(`/admin/hr/employees/${halfDayUser.id}/attendance-days?from=${twoDaysAgo}&to=${twoDaysAgo}`))
      .json.days as Json[] | undefined)?.[0];
  await judge([{ startAt: '09:00', endAt: '12:00' }]);
  const absentDay = await viewDay();
  check('core: a three-hour day is absent under these minimums', absentDay?.record?.status === 'absent', absentDay?.record);
  check(
    'core: and the calendar counts it absent unless the date is a day off',
    ['absent', 'weekly_off', 'holiday'].includes(String(absentDay?.status)),
    absentDay?.status,
  );

  const relaxed = await adminAsBearer.patch(`/admin/hr/shifts/${shiftId}`, { absentMinutes: 120 });
  check(
    'core: lowering the half-day minimum re-judges the finished days on the shift',
    relaxed.status === 200 && Number(relaxed.json.rejudged) >= 1,
    relaxed.json,
  );
  const rejudgedDay = await viewDay();
  check('core: the three-hour day is now a half day', rejudgedDay?.record?.status === 'half_day', rejudgedDay?.record);

  const unchanged = await adminAsBearer.patch(`/admin/hr/shifts/${shiftId}`, { graceMinutes: 10 });
  check('core: an edit that leaves the thresholds alone re-judges nothing', unchanged.json.rejudged === 0, unchanged.json);

  /* ------------------------------------------------ the verdict waits for the day to end */
  /*
   * A check-out is not the end of the day: somebody may come back after lunch, or stay on
   * late to make up the hours. Short hours make a day half or absent only once it is over
   * — after midnight, judged by the scheduler's nightly pass.
   */
  const { judgeEndedDays } = await import('../../src/modules/hr/attendance/dayJudge');
  const { runHrSchedulerTick } = await import('../../src/modules/hr/scheduler/hrScheduler');
  const istNow = new Date(Date.now() + 330 * 60_000).toISOString().slice(11, 16);
  if (istNow >= '00:20') {
    const shortToday = await adminAsBearer.put(`/admin/hr/attendance/${halfDayUser.id}/${today}`, {
      sessions: [{ startAt: '00:05', endAt: '00:15' }],
      reason: 'Ten minutes today',
    });
    check(
      'core: ten minutes today, checked out, is not absent while the day is still going',
      shortToday.status === 200 && ['present', 'late'].includes(String(shortToday.json.day?.status)),
      shortToday.json.day,
    );
    check(
      'core: and the record says where the day stands: checked out, for now',
      shortToday.json.day?.liveStatus === 'checked_out',
      shortToday.json.day,
    );
    const todayView = (
      (await adminAsBearer.get(`/admin/hr/employees/${halfDayUser.id}/attendance-days?from=${today}&to=${today}`)).json
        .days as Json[] | undefined
    )?.[0];
    check(
      'core: the calendar reads it as checked out — or as the day off it is',
      ['checked_out', 'weekly_off', 'holiday'].includes(String(todayView?.status)),
      todayView?.status,
    );
    const stillToday = await judgeEndedDays();
    const [todayRow] = (await utcDb.query('SELECT status FROM hr_attendance WHERE user_id = ? AND work_date = ?', [
      halfDayUser.id,
      today,
    ])) as unknown as [Array<{ status: string }>];
    check(
      'core: and the pass leaves it alone until the day is over',
      ['present', 'late'].includes(String(todayRow[0]?.status)),
      { stillToday, row: todayRow[0] },
    );

    // The same ten minutes on a day that is over: move the record back five days.
    const fiveDaysAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 5 * 86_400_000).toISOString().slice(0, 10);
    await utcDb.query('UPDATE hr_attendance SET work_date = ? WHERE user_id = ? AND work_date = ?', [
      fiveDaysAgo,
      halfDayUser.id,
      today,
    ]);
    const statusOf = async () =>
      String(
        (
          (await utcDb.query('SELECT status FROM hr_attendance WHERE user_id = ? AND work_date = ?', [
            halfDayUser.id,
            fiveDaysAgo,
          ])) as unknown as [Array<{ status: string }>]
        )[0][0]?.status,
      );
    const judgedNow = await judgeEndedDays();
    check(
      'core: once the day is over, the pass judges its hours: ten minutes is absent',
      judgedNow >= 1 && (await statusOf()) === 'absent',
      { judgedNow, status: await statusOf() },
    );

    // The nightly job: the first tick of the company day judges; later ticks that day do not.
    await utcDb.query("UPDATE hr_attendance SET status = 'present' WHERE user_id = ? AND work_date = ?", [
      halfDayUser.id,
      fiveDaysAgo,
    ]);
    await utcDb.query(
      "INSERT INTO hr_settings (setting_key, setting_value) VALUES ('attendance_judged_on', '2000-01-01') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
    );
    const firstTick = await runHrSchedulerTick();
    check(
      'core: the first scheduler tick of the day gives ended days their verdict',
      firstTick.failures.length === 0 && firstTick.judgedDays >= 1 && (await statusOf()) === 'absent',
      { firstTick, status: await statusOf() },
    );
    const secondTick = await runHrSchedulerTick();
    const [marker] = (await utcDb.query("SELECT setting_value FROM hr_settings WHERE setting_key = 'attendance_judged_on'")) as unknown as [
      Array<{ setting_value: string }>,
    ];
    check(
      'core: and runs once a night — a later tick the same day does not run it again',
      secondTick.judgedDays === 0 && marker[0]?.setting_value === today,
      { secondTick, marker: marker[0] },
    );
  } else {
    console.log('  (core: just after midnight — the day-not-over checks are skipped)');
  }

  // Back to the shift the rest of the suite expects.
  const reset = await adminAsBearer.patch(`/admin/hr/shifts/${shiftId}`, { halfDayMinutes: 240, absentMinutes: 0 });
  check('core: the shift goes back to one threshold', reset.status === 200 && reset.json.shift?.absentMinutes === 0, reset.json);
}
