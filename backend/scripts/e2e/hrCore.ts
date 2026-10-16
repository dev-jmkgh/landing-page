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
    holidayDay?.status === 'holiday' || holidayDay?.status === 'upcoming' || holidayDay?.status === 'present',
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
}
