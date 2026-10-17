import type { ApiResponse, Client, E2EContext, Json } from './context';

/**
 * hrLeave — leave types, balances, applying, team and admin decisions, cancelling,
 * holidays, and the two places leave reaches attendance: the WFH day override and the
 * month calendar.
 *
 * Every fixture is this section's own: its own leave types (deactivated at the end, so
 * later sections' fresh employees do not inherit a tracked balance), its own holiday
 * (deleted at the end), its own shifts and people. Dates are computed from the company
 * clock, never hard-coded, so the section passes on any day of the year.
 */
export async function run(ctx: E2EContext): Promise<void> {
  console.log('\nhrLeave');
  const { check, adminAsBearer: admin, db } = ctx;

  /* ------------------------------------------------------------------ helpers */

  /** The company's today (IST, a fixed +05:30), like `companyToday()` in the app. */
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const addDays = (date: string, days: number) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

  const items = (response: ApiResponse): Json[] =>
    Array.isArray(response.json?.items) ? (response.json.items as Json[]) : [];

  let keySeq = 0;
  const clientKey = () => `leave-e2e-${Date.now().toString(36)}-${(keySeq += 1)}`;

  async function scalar(sql: string, params: unknown[] = []): Promise<number> {
    const [rows] = (await db.query(sql, params)) as unknown as [Json[], unknown];
    return Number(rows[0]?.c ?? 0);
  }

  async function balanceOf(client: Client, typeId: number, year: number): Promise<Json | undefined> {
    const response = await client.get(`/hr/leave/balances?year=${year}`);
    return items(response).find((balance) => balance.leaveType?.id === typeId);
  }

  /*
   * A Monday at least a week out whose fortnight stays inside one calendar year (a
   * request may not cross a year boundary, and balances are per year). Late in
   * December that is the first Monday of next year — still well inside the 365-day
   * window.
   */
  let mon1 = addDays(today, 7);
  while (weekday(mon1) !== 1) mon1 = addDays(mon1, 1);
  if (mon1.slice(0, 4) !== addDays(mon1, 13).slice(0, 4)) {
    mon1 = `${Number(mon1.slice(0, 4)) + 1}-01-01`;
    while (weekday(mon1) !== 1) mon1 = addDays(mon1, 1);
  }
  const tue1 = addDays(mon1, 1);
  const wed1 = addDays(mon1, 2); // the holiday
  const thu1 = addDays(mon1, 3);
  const fri1 = addDays(mon1, 4);
  const sun1 = addDays(mon1, 6); // the weekly off
  const mon2 = addDays(mon1, 7);
  const fri2 = addDays(mon1, 11);
  const year = Number(mon1.slice(0, 4));

  /* ------------------------------------------------------------------ fixtures */

  /*
   * Shifts are inserted directly: this section needs EXACT weekly offs (Sunday only for
   * most people, none at all for the WFH worker so "today" is always a working day for
   * them), and pins them here rather than relying on whatever the shift admin form
   * defaults to. Sites and assignments go through the admin API.
   */
  const insertShift = async (name: string, weeklyOff: string): Promise<number> => {
    const [result] = (await db.query(
      `INSERT INTO hr_shifts (name, starts_at, ends_at, break_minutes, grace_minutes, half_day_minutes, weekly_off_days)
       VALUES (?, '09:00:00', '18:00:00', 60, 10, 240, ?)`,
      [name, weeklyOff],
    )) as unknown as [{ insertId: number }, unknown];
    return result.insertId;
  };
  const weekdayShift = await insertShift('Leave e2e weekday shift', 'sun');
  const everyDayShift = await insertShift('Leave e2e every-day shift', '');

  const manager = await ctx.createSignedInHrEmployee({
    name: 'Lena Manager',
    email: 'lena.manager.leave@example.test',
    role: 'hr_manager',
  });
  const emp = await ctx.createSignedInHrEmployee({
    name: 'Leo Employee',
    email: 'leo.employee.leave@example.test',
    managerId: manager.id,
    joiningDate: '2024-01-01',
  });
  const wfhWorker = await ctx.createSignedInHrEmployee({
    name: 'Wanda Office',
    email: 'wanda.office.leave@example.test',
    managerId: manager.id,
    joiningDate: '2024-01-01',
  });
  const otherManager = await ctx.createSignedInHrEmployee({
    name: 'Omar Manager',
    email: 'omar.manager.leave@example.test',
    role: 'hr_manager',
  });
  const outsider = await ctx.createSignedInHrEmployee({
    name: 'Olive Outsider',
    email: 'olive.outsider.leave@example.test',
    managerId: otherManager.id,
    joiningDate: '2024-01-01',
  });
  const hrAdmin = await ctx.createSignedInHrEmployee({
    name: 'Hana Admin',
    email: 'hana.admin.leave@example.test',
    role: 'hr_admin',
  });

  for (const person of [emp, manager, outsider]) {
    const assigned = await admin.patch(`/admin/hr/users/${person.id}/assignment`, {
      workMode: 'remote',
      shiftId: weekdayShift,
    });
    check('a leave fixture is given the weekday shift', assigned.status === 200, assigned.json);
  }

  /* ------------------------------------------------------------------ leave types */

  const casual = await admin.post('/admin/hr/leave-types', {
    name: 'E2E Casual',
    code: 'e2ec',
    kind: 'leave',
    isPaid: true,
    annualQuota: 3,
    allowHalfDay: true,
    sortOrder: 900,
  });
  check('an admin creates a leave type with a quota', casual.status === 201, casual.json);
  check(
    'and the code is stored upper-case',
    casual.json?.leaveType?.code === 'E2EC' && casual.json?.leaveType?.annualQuota === 3,
    casual.json?.leaveType,
  );
  const casualId = Number(casual.json?.leaveType?.id ?? 0);

  const dupType = await admin.post('/admin/hr/leave-types', { name: 'E2E Casual again', code: 'E2EC' });
  check(
    'a duplicate leave type code is refused',
    dupType.status === 400 && typeof dupType.json?.errors?.code === 'string',
    dupType.json,
  );

  const quotaOnWfh = await admin.post('/admin/hr/leave-types', {
    name: 'E2E Remote',
    code: 'E2EW',
    kind: 'wfh',
    annualQuota: 5,
  });
  check('a work-from-home type cannot carry a quota', quotaOnWfh.status === 400, quotaOnWfh.json);

  const untracked = await admin.post('/admin/hr/leave-types', {
    name: 'E2E Untracked',
    code: 'E2EU',
    kind: 'leave',
    isPaid: false,
    annualQuota: null,
    allowHalfDay: false,
    sortOrder: 901,
  });
  check('an admin creates an untracked leave type', untracked.status === 201, untracked.json);
  const untrackedId = Number(untracked.json?.leaveType?.id ?? 0);

  const adminTypes = await admin.get('/admin/hr/leave-types');
  check(
    'the admin type list includes both',
    [casualId, untrackedId].every((id) => items(adminTypes).some((type) => type.id === id)),
    items(adminTypes).map((type) => type.code),
  );

  const hrTokenOnAdmin = await emp.client.get('/admin/hr/leave-types');
  check(
    'an HR token is refused on the admin leave routes',
    hrTokenOnAdmin.status === 401 || hrTokenOnAdmin.status === 403,
    hrTokenOnAdmin.status,
  );

  /* ------------------------------------------------------------------ holidays */

  const holiday = await admin.post('/admin/hr/holidays', { date: wed1, name: 'E2E Founders Day' });
  check('an admin adds a holiday', holiday.status === 201 && holiday.json?.holiday?.date === wed1, holiday.json);
  const holidayId = Number(holiday.json?.holiday?.id ?? 0);

  const dupHoliday = await admin.post('/admin/hr/holidays', { date: wed1, name: 'Second one' });
  check('a second holiday on the same date is refused', dupHoliday.status === 400, dupHoliday.json);

  const temp = await admin.post('/admin/hr/holidays', { date: fri2, name: 'E2E Temporary', isOptional: true });
  check('an optional holiday can be added', temp.status === 201 && temp.json?.holiday?.isOptional === true, temp.json);
  const tempId = Number(temp.json?.holiday?.id ?? 0);

  const renamed = await admin.patch(`/admin/hr/holidays/${tempId}`, { name: 'E2E Temporary renamed' });
  check('a holiday can be renamed', renamed.status === 200 && renamed.json?.holiday?.name === 'E2E Temporary renamed', renamed.json);

  const moveOnto = await admin.patch(`/admin/hr/holidays/${tempId}`, { date: wed1 });
  check('and cannot be moved onto another holiday', moveOnto.status === 400, moveOnto.json);

  const removed = await admin.del(`/admin/hr/holidays/${tempId}`);
  check('a holiday can be deleted', removed.status === 200, removed.json);

  const adminHolidays = await admin.get(`/admin/hr/holidays?year=${year}`);
  check(
    'the admin list shows the holiday and not the deleted one',
    items(adminHolidays).some((h) => h.id === holidayId) && !items(adminHolidays).some((h) => h.id === tempId),
    items(adminHolidays),
  );

  const appHolidays = await emp.client.get(`/hr/leave/holidays?year=${year}`);
  check(
    'an employee sees the holiday list for the year',
    appHolidays.status === 200 &&
      appHolidays.json?.year === year &&
      items(appHolidays).some((h) => h.date === wed1 && h.name === 'E2E Founders Day'),
    appHolidays.json,
  );

  /* ------------------------------------------------------------------ balances */

  const types = await emp.client.get('/hr/leave/types');
  check('an employee lists the active leave types', items(types).some((type) => type.id === casualId), items(types));
  const wfhTypeId = Number(items(types).find((type) => type.code === 'WFH')?.id ?? 0);
  check('the seeded work-from-home type is available', wfhTypeId > 0, items(types).map((type) => type.code));

  const fresh = await balanceOf(emp.client, casualId, year);
  check(
    'a tracked type shows its quota as the balance',
    fresh?.tracked === true && fresh?.entitled === 3 && fresh?.used === 0 && fresh?.pending === 0 && fresh?.available === 3,
    fresh,
  );
  const untrackedBalance = await balanceOf(emp.client, untrackedId, year);
  check(
    'an untracked type has NO balance — null, not zero',
    untrackedBalance?.tracked === false && untrackedBalance?.entitled === null && untrackedBalance?.available === null,
    untrackedBalance,
  );

  /* ------------------------------------------------------------------ preview */

  const weekPreview = await emp.client.get(
    `/hr/leave/preview?leaveTypeId=${casualId}&startDate=${mon1}&endDate=${sun1}`,
  );
  const excluded = Array.isArray(weekPreview.json?.excluded) ? (weekPreview.json.excluded as Json[]) : [];
  check('a week costs five working days (holiday and weekly off excluded)', weekPreview.json?.days === 5, weekPreview.json);
  check(
    'the preview names the holiday and the weekly off',
    excluded.some((e) => e.date === wed1 && e.reason === 'holiday') &&
      excluded.some((e) => e.date === sun1 && e.reason === 'weekly_off'),
    excluded,
  );
  check(
    'and reports the shortfall instead of refusing',
    weekPreview.status === 200 &&
      weekPreview.json?.balanceAfter === -2 &&
      Array.isArray(weekPreview.json?.problems) &&
      (weekPreview.json.problems as string[]).some((p) => p.includes('3 days')),
    weekPreview.json,
  );

  const okPreview = await emp.client.get(
    `/hr/leave/preview?leaveTypeId=${casualId}&startDate=${mon1}&endDate=${tue1}`,
  );
  check(
    'a two-day preview leaves one day and no problems',
    okPreview.json?.days === 2 && okPreview.json?.balanceAfter === 1 && (okPreview.json?.problems as unknown[])?.length === 0,
    okPreview.json,
  );

  /* ------------------------------------------------------------------ applying */

  const firstKey = clientKey();
  const first = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: mon1,
    endDate: tue1,
    reason: 'Family function out of town',
    clientKey: firstKey,
  });
  check('an employee applies for leave', first.status === 201, first.json);
  check(
    'the request is pending, costs two days and can be cancelled',
    first.json?.request?.status === 'pending' && first.json?.request?.days === 2 && first.json?.request?.canCancel === true,
    first.json?.request,
  );
  const firstId = Number(first.json?.request?.id ?? 0);

  const replay = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: mon1,
    endDate: tue1,
    reason: 'Family function out of town',
    clientKey: firstKey,
  });
  check(
    'a replayed client key returns the original request',
    replay.status === 200 && replay.json?.deduplicated === true && replay.json?.request?.id === firstId,
    replay.json,
  );
  check(
    'and creates no second row',
    (await scalar('SELECT COUNT(*) AS c FROM hr_leave_requests WHERE user_id = ?', [emp.id])) === 1,
  );
  check(
    'the manager is notified of the application',
    (await scalar(
      "SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'leave_submitted' AND entity_id = ?",
      [manager.id, firstId],
    )) === 1,
  );

  const overlap = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: tue1,
    endDate: thu1,
    reason: 'Overlapping on purpose',
    clientKey: clientKey(),
  });
  check(
    'an overlapping application is refused',
    overlap.status === 400 && String(overlap.json?.message).includes('overlaps'),
    overlap.json,
  );

  const wfhOverlap = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: wfhTypeId,
    startDate: mon1,
    endDate: mon1,
    reason: 'Working from home that day',
    clientKey: clientKey(),
  });
  check('an overlap across kinds (leave vs WFH) is refused too', wfhOverlap.status === 400, wfhOverlap.json);

  const exhausted = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: thu1,
    endDate: fri1,
    reason: 'More time off',
    clientKey: clientKey(),
  });
  check(
    'an application beyond the balance is refused with what is left',
    exhausted.status === 400 && String(exhausted.json?.message).includes('1 day of E2E Casual left'),
    exhausted.json,
  );

  /* --- half days --- */
  const halfRange = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: thu1,
    endDate: fri1,
    halfDay: 'first_half',
    reason: 'Half day over two dates',
    clientKey: clientKey(),
  });
  check(
    'a half day spanning two dates is refused',
    halfRange.status === 400 && typeof halfRange.json?.errors?.halfDay === 'string',
    halfRange.json,
  );

  const halfNotAllowed = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: thu1,
    endDate: thu1,
    halfDay: 'second_half',
    reason: 'Half day on a full-day type',
    clientKey: clientKey(),
  });
  check('a half day on a type that does not allow it is refused', halfNotAllowed.status === 400, halfNotAllowed.json);

  const morning = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: thu1,
    endDate: thu1,
    halfDay: 'first_half',
    reason: 'Doctor in the morning',
    clientKey: clientKey(),
  });
  check('a morning half day is accepted at half a day', morning.status === 201 && morning.json?.request?.days === 0.5, morning.json);
  const morningId = Number(morning.json?.request?.id ?? 0);

  const afternoon = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: thu1,
    endDate: thu1,
    halfDay: 'second_half',
    reason: 'School event in the afternoon',
    clientKey: clientKey(),
  });
  check(
    'the other half of the same date can be booked too',
    afternoon.status === 201 && afternoon.json?.request?.days === 0.5,
    afternoon.json,
  );
  const afternoonId = Number(afternoon.json?.request?.id ?? 0);

  const sameHalf = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: casualId,
    startDate: thu1,
    endDate: thu1,
    halfDay: 'first_half',
    reason: 'Same half again',
    clientKey: clientKey(),
  });
  check(
    'but the same half twice is an overlap',
    sameHalf.status === 400 && String(sameHalf.json?.message).includes('overlaps'),
    sameHalf.json,
  );

  /* --- date rules --- */
  const thisYear = Number(today.slice(0, 4));
  const acrossYears = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: `${thisYear}-12-31`,
    endDate: `${thisYear + 1}-01-01`,
    reason: 'New year break',
    clientKey: clientKey(),
  });
  check(
    'a request across a year boundary is refused',
    acrossYears.status === 400 && String(acrossYears.json?.message).includes('each year separately'),
    acrossYears.json,
  );

  const tooOld = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: addDays(today, -40),
    endDate: addDays(today, -40),
    reason: 'Long ago',
    clientKey: clientKey(),
  });
  check('a request starting more than 30 days back is refused', tooOld.status === 400, tooOld.json);

  const onWeeklyOff = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: sun1,
    endDate: sun1,
    reason: 'Sunday off',
    clientKey: clientKey(),
  });
  check(
    'a request covering only a weekly off is refused and says why',
    onWeeklyOff.status === 400 && String(onWeeklyOff.json?.message).includes('weekly off'),
    onWeeklyOff.json,
  );

  const notADate = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: `${year}-02-30`,
    endDate: `${year}-02-30`,
    reason: 'Impossible date',
    clientKey: clientKey(),
  });
  check('an impossible date is a validation error', notADate.status === 422, notADate.json);

  const afterApplying = await balanceOf(emp.client, casualId, year);
  check(
    'pending requests count against what is available',
    afterApplying?.used === 0 && afterApplying?.pending === 3 && afterApplying?.available === 0,
    afterApplying,
  );

  /* ------------------------------------------------------------------ team access */

  const notAManager = await emp.client.get('/hr/team/members');
  check('an employee without the manager role gets 403 on /team', notAManager.status === 403, notAManager.status);

  const members = await manager.client.get('/hr/team/members');
  const memberIds = items(members).map((member) => Number(member.id));
  check(
    "a manager's team is their direct reports",
    members.status === 200 && members.json?.total === 2 && memberIds.includes(emp.id) && memberIds.includes(wfhWorker.id),
    members.json,
  );
  check(
    'and excludes themselves and other teams',
    !memberIds.includes(manager.id) && !memberIds.includes(outsider.id),
    memberIds,
  );
  check(
    "each member carries today's status",
    items(members).every((member) => typeof member.today?.status === 'string'),
    items(members).map((member) => member.today),
  );

  const counts = await manager.client.get('/hr/team/approvals/count');
  check(
    'the approval count is the team pending work',
    counts.json?.leave === 3 && counts.json?.regularisations === 0,
    counts.json,
  );

  const queue = await manager.client.get('/hr/team/leave-requests');
  check(
    'the manager sees the request in the team queue',
    items(queue).some((request) => request.id === firstId) &&
      items(queue).every((request) => [emp.id, wfhWorker.id].includes(Number(request.userId))),
    items(queue).map((request) => request.id),
  );

  const otherQueue = await otherManager.client.get('/hr/team/leave-requests');
  check(
    "another manager's queue does not show it",
    otherQueue.status === 200 && !items(otherQueue).some((request) => request.id === firstId),
    items(otherQueue).map((request) => request.id),
  );

  const otherApproves = await otherManager.client.post(`/hr/team/leave-requests/${firstId}/approve`, {});
  check("a request from another team is 404 to a manager", otherApproves.status === 404, otherApproves.json);

  /* ------------------------------------------------------------------ manager decides */

  const approved = await manager.client.post(`/hr/team/leave-requests/${firstId}/approve`, { note: 'Enjoy' });
  check('the manager approves it', approved.status === 200 && approved.json?.request?.status === 'approved', approved.json);
  check(
    'recorded as a manager decision with their name',
    approved.json?.request?.reviewerType === 'manager' && approved.json?.request?.reviewerName === 'Lena Manager',
    approved.json?.request,
  );

  const approveTwice = await manager.client.post(`/hr/team/leave-requests/${firstId}/approve`, {});
  check('approving twice is refused', approveTwice.status === 400, approveTwice.json);

  const afterApproval = await balanceOf(emp.client, casualId, year);
  check(
    'the balance moves from pending to used',
    afterApproval?.used === 2 && afterApproval?.pending === 1 && afterApproval?.available === 0,
    afterApproval,
  );

  const inbox = await emp.client.get('/hr/notifications');
  check(
    'the employee is notified of the approval',
    items(inbox).some((n) => n.kind === 'leave_approved' && Number(n.entityId) === firstId),
    items(inbox).map((n) => `${n.kind}:${n.entityId}`),
  );
  check(
    'the manager decision is audited as an HR app action',
    (await scalar(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_leave_approved' AND entity_type = 'hr_leave_request'" +
        " AND entity_id = ? AND actor_label LIKE 'HR app:%'",
      [firstId],
    )) === 1,
  );

  /* --- a manager cannot decide their own --- */
  const ownRequest = await manager.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: fri1,
    endDate: fri1,
    reason: 'Manager needs a day',
    clientKey: clientKey(),
  });
  check('a manager can apply for their own leave', ownRequest.status === 201, ownRequest.json);
  const ownId = Number(ownRequest.json?.request?.id ?? 0);

  const selfApprove = await manager.client.post(`/hr/team/leave-requests/${ownId}/approve`, {});
  check('but cannot approve it themselves', selfApprove.status === 403, selfApprove.json);

  const adminApprovesManager = await hrAdmin.client.post(`/hr/team/leave-requests/${ownId}/approve`, {});
  check(
    "an hr_admin's team is everybody else, so they can decide it",
    adminApprovesManager.status === 200 && adminApprovesManager.json?.request?.status === 'approved',
    adminApprovesManager.json,
  );

  /* --- another team's request --- */
  const outsiderRequest = await outsider.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: mon2,
    endDate: mon2,
    reason: 'Outside the first team',
    clientKey: clientKey(),
  });
  check('an employee in another team applies', outsiderRequest.status === 201, outsiderRequest.json);
  const outsiderId = Number(outsiderRequest.json?.request?.id ?? 0);

  const crossTeam = await manager.client.post(`/hr/team/leave-requests/${outsiderId}/reject`, { note: 'No' });
  check("another team's request is 404 to this manager", crossTeam.status === 404, crossTeam.json);

  const ownManagerRejects = await otherManager.client.post(`/hr/team/leave-requests/${outsiderId}/reject`, {
    note: 'Team is short that day',
  });
  check(
    'their own manager can reject it',
    ownManagerRejects.status === 200 && ownManagerRejects.json?.request?.status === 'rejected',
    ownManagerRejects.json,
  );

  /* ------------------------------------------------------------------ admin path */

  const adminList = await admin.get(`/admin/hr/leave-requests?userId=${emp.id}&page=1&pageSize=2`);
  check(
    'the admin list filters by employee and paginates',
    adminList.status === 200 && adminList.json?.total === 3 && items(adminList).length === 2 && adminList.json?.pageSize === 2,
    adminList.json,
  );
  check(
    'pending requests come first',
    items(adminList)[0]?.status === 'pending',
    items(adminList).map((request) => request.status),
  );

  const adminCount = await admin.get('/admin/hr/leave-requests/count');
  check('the admin pending count responds', typeof adminCount.json?.pending === 'number' && adminCount.json.pending >= 2, adminCount.json);

  const rejected = await admin.post(`/admin/hr/leave-requests/${morningId}/reject`, { note: 'Clinic visit can move' });
  check(
    'an admin rejects a request with a note',
    rejected.status === 200 && rejected.json?.request?.status === 'rejected' && rejected.json?.request?.reviewNote === 'Clinic visit can move',
    rejected.json,
  );
  check(
    'and the employee is notified of the rejection',
    (await scalar(
      "SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'leave_rejected' AND entity_id = ?",
      [emp.id, morningId],
    )) === 1,
  );
  check(
    'and the admin decision is audited',
    (await scalar(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_leave_rejected' AND entity_id = ? AND actor_type <> 'system'",
      [morningId],
    )) === 1,
  );

  /* --- allocations override the quota, and an approval may not overdraw --- */
  const allocated = await admin.put('/admin/hr/leave-allocations', {
    userId: emp.id,
    leaveTypeId: casualId,
    year,
    days: 2,
    note: 'Pro-rated for the year',
  });
  check(
    'an admin sets a per-person allocation',
    allocated.status === 200 && allocated.json?.balance?.entitled === 2 && allocated.json?.balance?.allocation?.days === 2,
    allocated.json,
  );

  const overdraw = await admin.post(`/admin/hr/leave-requests/${afternoonId}/approve`, {});
  check(
    'approving past the entitlement is refused',
    overdraw.status === 400 && String(overdraw.json?.message).includes('entitlement'),
    overdraw.json,
  );

  const allocations = await admin.get(`/admin/hr/leave-allocations?userId=${emp.id}&year=${year}`);
  check(
    'the allocation list shows the override and its note',
    items(allocations).some(
      (balance) => balance.leaveType?.id === casualId && balance.allocation?.note === 'Pro-rated for the year',
    ),
    items(allocations),
  );

  const cleared = await admin.put('/admin/hr/leave-allocations', {
    userId: emp.id,
    leaveTypeId: casualId,
    year,
    days: null,
  });
  check(
    'removing the override falls back to the quota',
    cleared.status === 200 && cleared.json?.balance?.entitled === 3 && cleared.json?.balance?.allocation === null,
    cleared.json,
  );

  const adminApproves = await admin.post(`/admin/hr/leave-requests/${afternoonId}/approve`, {});
  check(
    'an admin approves within the entitlement',
    adminApproves.status === 200 && adminApproves.json?.request?.reviewerType === 'admin',
    adminApproves.json,
  );

  const afterAdmin = await balanceOf(emp.client, casualId, year);
  check(
    'the balance reflects both decisions',
    afterAdmin?.used === 2.5 && afterAdmin?.pending === 0 && afterAdmin?.available === 0.5,
    afterAdmin,
  );

  /* ------------------------------------------------------------------ calendar */

  const calendarDay = async (date: string): Promise<Json | undefined> => {
    const response = await emp.client.get(`/hr/attendance/calendar?month=${date.slice(0, 7)}`);
    const days = Array.isArray(response.json?.days) ? (response.json.days as Json[]) : [];
    return days.find((day) => day.date === date);
  };
  const leaveDay = await calendarDay(mon1);
  check('the calendar shows an approved leave day as on_leave', leaveDay?.status === 'on_leave', leaveDay);
  const holidayDay = await calendarDay(wed1);
  check('and the holiday as holiday', holidayDay?.status === 'holiday', holidayDay);

  /* ------------------------------------------------------------------ cancelling */

  const toWithdraw = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: mon2,
    endDate: mon2,
    reason: 'Might not need this',
    clientKey: clientKey(),
  });
  const withdrawId = Number(toWithdraw.json?.request?.id ?? 0);
  const withdrawn = await emp.client.post(`/hr/leave/requests/${withdrawId}/cancel`);
  check(
    'a pending request can be cancelled',
    withdrawn.status === 200 && withdrawn.json?.request?.status === 'cancelled' && withdrawn.json?.request?.canCancel === false,
    withdrawn.json,
  );

  const outsiderCancels = await outsider.client.post(`/hr/leave/requests/${firstId}/cancel`);
  check("another employee cannot cancel someone else's request", outsiderCancels.status === 404, outsiderCancels.status);
  const outsiderReads = await outsider.client.get(`/hr/leave/requests/${firstId}`);
  check("nor read it", outsiderReads.status === 404, outsiderReads.status);

  const ownRead = await emp.client.get(`/hr/leave/requests/${firstId}`);
  check('the owner reads their own request', ownRead.status === 200 && ownRead.json?.request?.id === firstId, ownRead.json);

  const cancelApproved = await emp.client.post(`/hr/leave/requests/${firstId}/cancel`);
  check(
    'an approved request that has not started can be cancelled',
    cancelApproved.status === 200 && cancelApproved.json?.request?.status === 'cancelled',
    cancelApproved.json,
  );
  check(
    'and the manager is told',
    (await scalar(
      "SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'leave_cancelled' AND entity_id = ?",
      [manager.id, firstId],
    )) === 1,
  );
  const afterCancel = await balanceOf(emp.client, casualId, year);
  check('the days go back to the balance', afterCancel?.used === 0.5 && afterCancel?.available === 2.5, afterCancel);

  const cancelTwice = await emp.client.post(`/hr/leave/requests/${firstId}/cancel`);
  check('cancelling twice is refused', cancelTwice.status === 400, cancelTwice.json);

  // A recent working day for the weekday shift (not a Sunday).
  let pastDay = addDays(today, -2);
  if (weekday(pastDay) === 0) pastDay = addDays(pastDay, -1);
  const pastRequest = await emp.client.post('/hr/leave/requests', {
    leaveTypeId: untrackedId,
    startDate: pastDay,
    endDate: pastDay,
    reason: 'Was unwell, applying after the fact',
    clientKey: clientKey(),
  });
  check('leave can be applied for a recent past day', pastRequest.status === 201, pastRequest.json);
  const pastId = Number(pastRequest.json?.request?.id ?? 0);
  await admin.post(`/admin/hr/leave-requests/${pastId}/approve`, {});
  const cancelPast = await emp.client.post(`/hr/leave/requests/${pastId}/cancel`);
  check(
    'an approved request that has already started cannot be cancelled',
    cancelPast.status === 400 && String(cancelPast.json?.message).includes('contact HR'),
    cancelPast.json,
  );

  const mine = await emp.client.get('/hr/leave/requests?page=1&pageSize=2');
  check(
    "an employee's own list paginates",
    mine.status === 200 && items(mine).length === 2 && Number(mine.json?.total) >= 5 && mine.json?.page === 1,
    { total: mine.json?.total, page: mine.json?.page, n: items(mine).length },
  );
  const mineCancelled = await emp.client.get('/hr/leave/requests?status=cancelled');
  check(
    'and filters by status',
    items(mineCancelled).length === 2 && items(mineCancelled).every((request) => request.status === 'cancelled'),
    items(mineCancelled).map((request) => request.status),
  );

  /* --- concurrency: the row lock and the client key under a race --- */
  /*
   * Two submissions of ONE client key at the same moment — a double tap that beat the
   * button's disabled state. Exactly one request, and both callers get it.
   */
  const racedKey = clientKey();
  const sameKeyBody = {
    leaveTypeId: untrackedId,
    startDate: addDays(mon1, 9),
    endDate: addDays(mon1, 9),
    reason: 'Sent twice at once',
    clientKey: racedKey,
  };
  const sameKey = await Promise.all([
    emp.client.post('/hr/leave/requests', sameKeyBody),
    emp.client.post('/hr/leave/requests', sameKeyBody),
  ]);
  const sameKeyStatuses = sameKey.map((response) => response.status).sort();
  check(
    'two simultaneous submissions of one client key make one request',
    sameKeyStatuses[0] === 200 &&
      sameKeyStatuses[1] === 201 &&
      sameKey[0]?.json?.request?.id === sameKey[1]?.json?.request?.id,
    sameKey.map((response) => [response.status, response.json?.request?.id, response.json?.deduplicated]),
  );
  await emp.client.post(`/hr/leave/requests/${Number(sameKey[0]?.json?.request?.id ?? 0)}/cancel`);

  /*
   * Two DIFFERENT applications at once, each for two days, with 2.5 left. Without the
   * row lock both read "2.5 left" and both pass; with it, the second waits, sees the
   * first, and is refused.
   */
  const race = await Promise.all([
    emp.client.post('/hr/leave/requests', {
      leaveTypeId: casualId,
      startDate: mon2,
      endDate: addDays(mon2, 1),
      reason: 'Race entry one',
      clientKey: clientKey(),
    }),
    emp.client.post('/hr/leave/requests', {
      leaveTypeId: casualId,
      startDate: addDays(mon2, 3),
      endDate: addDays(mon2, 4),
      reason: 'Race entry two',
      clientKey: clientKey(),
    }),
  ]);
  const raceStatuses = race.map((response) => response.status).sort();
  check(
    'two simultaneous applications cannot both spend the same remaining days',
    raceStatuses[0] === 201 && raceStatuses[1] === 400,
    race.map((response) => [response.status, response.json?.message]),
  );
  check(
    'and exactly one of them was written',
    (await scalar(
      "SELECT COUNT(*) AS c FROM hr_leave_requests WHERE user_id = ? AND leave_type_id = ? AND status = 'pending'",
      [emp.id, casualId],
    )) === 1,
  );
  const winner = race.find((response) => response.status === 201);
  await emp.client.post(`/hr/leave/requests/${Number(winner?.json?.request?.id ?? 0)}/cancel`);

  /* ------------------------------------------------------------------ WFH lifts the fence */

  const site = await admin.post('/admin/hr/locations', {
    name: 'Leave e2e office',
    latitude: 12.97,
    longitude: 77.59,
    radiusMetres: 150,
  });
  check('a site for the office worker', site.status === 201, site.json);
  const officeAssign = await admin.patch(`/admin/hr/users/${wfhWorker.id}/assignment`, {
    workMode: 'office',
    workLocationId: Number(site.json?.location?.id ?? 0),
    shiftId: everyDayShift,
  });
  check('the office worker is assigned the geofenced site', officeAssign.status === 200, officeAssign.json);

  const fenced = await wfhWorker.client.get('/hr/attendance/today');
  check(
    'before WFH the office worker is geofenced',
    fenced.json?.assignment?.geofenced === true && fenced.json?.assignment?.dayOverride === null,
    fenced.json?.assignment,
  );

  const wfh = await wfhWorker.client.post('/hr/leave/requests', {
    leaveTypeId: wfhTypeId,
    startDate: today,
    endDate: today,
    reason: 'Plumber visiting at home',
    clientKey: clientKey(),
  });
  check('an office worker applies to work from home today', wfh.status === 201, wfh.json);
  const wfhApproved = await manager.client.post(`/hr/team/leave-requests/${Number(wfh.json?.request?.id ?? 0)}/approve`, {});
  check('the manager approves it', wfhApproved.status === 200, wfhApproved.json);

  const lifted = await wfhWorker.client.get('/hr/attendance/today');
  check(
    "today's assignment shows the WFH override and no fence",
    lifted.json?.assignment?.dayOverride === 'wfh' && lifted.json?.assignment?.geofenced === false,
    lifted.json?.assignment,
  );
  const wfhIn = await wfhWorker.client.post('/hr/attendance/check-in', {});
  check('and a check-in with no coordinates succeeds', wfhIn.status === 201, wfhIn.json);

  const teamToday = await manager.client.get('/hr/team/members');
  const wanda = items(teamToday).find((member) => Number(member.id) === wfhWorker.id);
  check(
    'the team view shows them checked in, working from home',
    wanda?.today?.currentlyIn === true && wanda?.today?.leave?.kind === 'wfh' && wanda?.today?.status === 'checked_in',
    wanda?.today,
  );

  const wfhOut = await wfhWorker.client.post('/hr/attendance/check-out', {});
  check('and the check-out needs no coordinates either', wfhOut.status === 200, wfhOut.json);

  /* ------------------------------------------------------------------ team corrections */

  const correctionDay = addDays(today, -5);
  const correction = await wfhWorker.client.post('/hr/attendance/regularisations', {
    workDate: correctionDay,
    checkInAt: '09:00',
    checkOutAt: '18:00',
    reason: 'Phone was dead all day',
  });
  check('a team member raises a correction', correction.status === 201, correction.json);
  const correctionId = Number(correction.json?.request?.id ?? 0);

  const countsWithCorrection = await manager.client.get('/hr/team/approvals/count');
  check(
    'it shows in the team approval count',
    countsWithCorrection.json?.regularisations === 1 && countsWithCorrection.json?.leave === 0,
    countsWithCorrection.json,
  );

  const teamCorrections = await manager.client.get('/hr/team/regularisations');
  check(
    'and in the team correction queue',
    items(teamCorrections).some((r) => r.id === correctionId) && teamCorrections.json?.total === 1,
    teamCorrections.json,
  );

  const otherCorrects = await otherManager.client.post(`/hr/team/regularisations/${correctionId}/approve`, {});
  check("another team's correction is 404", otherCorrects.status === 404, otherCorrects.json);

  const corrected = await manager.client.post(`/hr/team/regularisations/${correctionId}/approve`, {
    note: 'Confirmed with the team',
  });
  check(
    'the manager approves the correction',
    corrected.status === 200 &&
      corrected.json?.request?.status === 'approved' &&
      corrected.json?.request?.reviewerName === 'Lena Manager',
    corrected.json,
  );
  check(
    'and the corrected day is written',
    (await scalar(
      "SELECT worked_minutes AS c FROM hr_attendance WHERE user_id = ? AND work_date = ? AND source = 'regularisation'",
      [wfhWorker.id, correctionDay],
    )) === 540,
  );
  check(
    'and the decision is audited as an HR app action',
    (await scalar(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_regularisation_approved' AND entity_id = ? AND actor_label LIKE 'HR app:%'",
      [correctionId],
    )) === 1,
  );

  /* ------------------------------------------------------------------ tidy up */

  const kindChange = await admin.patch(`/admin/hr/leave-types/${casualId}`, { kind: 'wfh', annualQuota: null });
  check('the kind of a used leave type cannot change', kindChange.status === 400, kindChange.json);

  for (const id of [casualId, untrackedId]) {
    const retired = await admin.patch(`/admin/hr/leave-types/${id}`, { isActive: false });
    check('a leave type can be retired', retired.status === 200 && retired.json?.leaveType?.isActive === false, retired.json);
  }
  const typesAfter = await emp.client.get('/hr/leave/types');
  check(
    'a retired type disappears from the app',
    !items(typesAfter).some((type) => type.id === casualId || type.id === untrackedId),
    items(typesAfter).map((type) => type.code),
  );
  check(
    'and the type-change audit trail exists',
    (await scalar(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_leave_type_updated' AND entity_id = ?",
      [casualId],
    )) >= 1,
  );

  const holidayGone = await admin.del(`/admin/hr/holidays/${holidayId}`);
  check('the section removes its holiday', holidayGone.status === 200, holidayGone.json);
}
