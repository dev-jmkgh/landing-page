import type { E2EContext, Json } from './context';

/**
 * hrAccount — what an administrator does to an employee's ACCOUNT: setting a new password
 * for somebody who lost theirs, and deleting an employee (migration 038).
 *
 * Deleting is a SOFT delete, and the user's rule for it is that a deleted employee is
 * never in the current or any upcoming payroll — so the delete is checked against a real
 * calculated pay period, not only against the employee list. Everything else the delete
 * closes (leave, corrections, requests, the reporting line, sessions) is checked here too.
 *
 * Fixtures are this section's own: `acct.*@example.test`, created through the admin API
 * so the section knows their passwords. A pay period for the current month is reused if
 * an earlier section left one, and removed at the end only if this section made it.
 */

const PASSWORD = 'account-section-password-1';
const NEW_PASSWORD = 'Reset-by-admin-2026';

export async function run(ctx: E2EContext): Promise<void> {
  console.log('\nhr account: password reset and delete');

  const { check, utcDb, adminAsBearer: admin, base, makeClient } = ctx;
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
  const items = (response: { json: Json }): Json[] =>
    Array.isArray(response.json?.items) ? (response.json.items as Json[]) : [];

  const today = cal.companyToday();
  const thisMonth = today.slice(0, 7);
  const tag = Date.now().toString(36).slice(-5);

  const signIn = async (email: string, password: string) => {
    const client = makeClient(base);
    const login = await client.post('/hr/auth/login', {
      email,
      password,
      device: { name: 'e2e-account', platform: 'android' },
    });
    const token = login.json.accessToken as unknown;
    if (typeof token === 'string') client.setToken(token);
    return { client, login, refreshToken: String(login.json.refreshToken ?? '') };
  };

  const createEmployee = async (name: string, email: string, extra: Json = {}): Promise<number> => {
    const created = await admin.post('/admin/hr/employees', {
      name,
      email,
      password: PASSWORD,
      joiningDate: '2024-01-01',
      ...extra,
    });
    must(`an account fixture is created: ${name}`, created.status === 201, created.json);
    return Number(created.json.employee?.id);
  };

  const supervisor = await ctx.createSignedInEmployee({
    name: 'Account Supervisor Fixture',
    email: `acct.supervisor.${tag}@example.test`,
    role: 'supervisor',
  });

  /* ------------------------------------------------------- password reset */

  const resetEmail = `acct.reset.${tag}@example.test`;
  const resetId = await createEmployee('Rhea Resetme', resetEmail);
  const before = await signIn(resetEmail, PASSWORD);
  must('the employee can sign in before the reset', before.login.status === 200, before.login.json);

  const weak = await admin.post(`/admin/hr/employees/${resetId}/password`, { password: 'short' });
  check('a password the signup rules refuse is refused here too', weak.status === 422, weak.json);

  const bySupervisor = await supervisor.client.post(`/admin/hr/employees/${resetId}/password`, {
    password: NEW_PASSWORD,
  });
  check('a supervisor cannot reset a password', bySupervisor.status === 403, bySupervisor.json);

  const nobody = await admin.post('/admin/hr/employees/987654321/password', { password: NEW_PASSWORD });
  check('resetting an unknown employee is 404', nobody.status === 404, nobody.json);

  const reset = await admin.post(`/admin/hr/employees/${resetId}/password`, { password: NEW_PASSWORD });
  check(
    'an admin sets a new password, and the phone signed in with the old one is signed out',
    reset.status === 200 && Number(reset.json.sessionsRevoked) >= 1,
    reset.json,
  );

  const oldRefresh = await makeClient(base).post('/hr/auth/refresh', { refreshToken: before.refreshToken });
  check('the old session can no longer refresh', oldRefresh.status === 401, oldRefresh.json);

  const oldPassword = await signIn(resetEmail, PASSWORD);
  check('the old password no longer works', oldPassword.login.status === 401, oldPassword.login.json);

  const newPassword = await signIn(resetEmail, NEW_PASSWORD);
  check('the new password works', newPassword.login.status === 200, newPassword.login.json);

  check(
    'the reset is audited once',
    (await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_password_reset' AND entity_id = ?", [
      resetId,
    ])) === 1,
  );
  check(
    'and the password itself is in no audit row',
    (await count('SELECT COUNT(*) AS n FROM audit_logs WHERE summary LIKE ? OR CAST(meta AS CHAR) LIKE ?', [
      `%${NEW_PASSWORD}%`,
      `%${NEW_PASSWORD}%`,
    ])) === 0,
  );

  /* --------------------------------------------------------------- delete */

  const doomedEmail = `acct.doomed.${tag}@example.test`;
  const doomedName = `Dev Doomed ${tag}`;
  const doomedId = await createEmployee(doomedName, doomedEmail, { role: 'hr_manager' });
  const reportId = await createEmployee(`Riya Report ${tag}`, `acct.report.${tag}@example.test`, {
    managerId: doomedId,
  });
  const doomed = await signIn(doomedEmail, PASSWORD);
  must('the employee to delete is signed in', doomed.login.status === 200, doomed.login.json);

  // Work that is still open for them, written straight in: each kind is under test elsewhere.
  const typeId = Number(
    (await rows("SELECT id FROM hr_leave_types WHERE kind = 'leave' AND is_comp_off = 0 ORDER BY id LIMIT 1"))[0]?.id,
  );
  must('a leave type exists for the fixtures', typeId > 0, typeId);
  const leaveRow = (start: string, status: 'pending' | 'approved') => [
    doomedId,
    typeId,
    start,
    start,
    'none',
    1,
    'Account section fixture',
    status,
    status === 'approved' ? 'admin' : null,
    status === 'approved' ? 'E2E Admin' : null,
  ];
  const pendingDay = cal.addDays(today, 10);
  const futureDay = cal.addDays(today, 20);
  const pastDay = cal.addDays(today, -20);
  await utcDb.query(
    `INSERT INTO hr_leave_requests
       (user_id, leave_type_id, start_date, end_date, half_day, days, reason, status, reviewer_type, reviewer_name)
     VALUES ?`,
    [[leaveRow(pendingDay, 'pending'), leaveRow(futureDay, 'approved'), leaveRow(pastDay, 'approved')]],
  );
  await utcDb.query(
    `INSERT INTO hr_regularisations (user_id, work_date, requested_check_out_at, reason, status)
     VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL 2 DAY, 'Forgot to check out', 'pending')`,
    [doomedId, cal.addDays(today, -2)],
  );
  await utcDb.query(
    `INSERT INTO hr_requests (user_id, category, subject, status) VALUES (?, 'letter', 'Experience letter', 'open')`,
    [doomedId],
  );

  // A calculated pay period with a payslip for them.
  const structure = await admin.post('/admin/hr/payroll/structures', {
    userId: doomedId,
    effectiveFrom: '2024-01-01',
    components: [{ label: 'Basic', kind: 'earning', amount: 20000 }],
  });
  must('the employee to delete has a salary structure', structure.status === 201, structure.json);

  const existingRun = (await rows('SELECT id, status FROM hr_payroll_runs WHERE period = ?', [thisMonth]))[0];
  let runId = existingRun ? Number(existingRun.id) : 0;
  const ownRun = !existingRun;
  if (ownRun) {
    const created = await admin.post('/admin/hr/payroll/runs', { period: thisMonth });
    must('a pay period for the current month is created', created.status === 201, created.json);
    runId = Number(created.json.run?.id);
  }
  must('the current pay period is not approved', existingRun?.status !== 'approved', existingRun);

  try {
    const processed = await admin.post(`/admin/hr/payroll/runs/${runId}/process`);
    must('the current pay period is calculated', processed.status === 200, processed.json);
    const slipsBefore = await count('SELECT COUNT(*) AS n FROM hr_payslips WHERE run_id = ? AND user_id = ?', [
      runId,
      doomedId,
    ]);
    must('and the employee to delete has a payslip in it', slipsBefore === 1, slipsBefore);
    const headcountBefore = Number(processed.json.run?.employeeCount);

    /* who may delete */
    const supervisorDelete = await supervisor.client.del(`/admin/hr/employees/${doomedId}`);
    check('a supervisor cannot delete an employee', supervisorDelete.status === 403, supervisorDelete.json);
    const unknownDelete = await admin.del('/admin/hr/employees/987654321');
    check('deleting an unknown employee is 404', unknownDelete.status === 404, unknownDelete.json);

    /* the delete */
    const deleted = await admin.del(`/admin/hr/employees/${doomedId}`);
    check('an admin deletes the employee', deleted.status === 200 && deleted.json.alreadyDeleted === false, deleted.json);
    check(
      'the response counts what the delete closed',
      deleted.json.leaveCancelled === 2 &&
        deleted.json.correctionsClosed === 1 &&
        deleted.json.requestsClosed === 1 &&
        deleted.json.reportsUnassigned === 1 &&
        deleted.json.payslipsRemoved === 1 &&
        Number(deleted.json.sessionsRevoked) >= 1,
      deleted.json,
    );

    const account = (await rows('SELECT deleted_at, deleted_by_name, is_active FROM hr_users WHERE id = ?', [doomedId]))[0];
    check(
      'the row stays, marked deleted and switched off',
      account?.deleted_at !== null && Number(account?.is_active) === 0 && typeof account?.deleted_by_name === 'string',
      account,
    );

    const leave = await rows(
      "SELECT DATE_FORMAT(start_date, '%Y-%m-%d') AS d, status FROM hr_leave_requests WHERE user_id = ? ORDER BY start_date",
      [doomedId],
    );
    const statusOn = (date: string) => leave.find((row) => row.d === date)?.status;
    check(
      'pending leave and approved leave not yet started are cancelled; leave already taken stays approved',
      statusOn(pendingDay) === 'cancelled' && statusOn(futureDay) === 'cancelled' && statusOn(pastDay) === 'approved',
      leave,
    );
    check(
      'their pending attendance correction is closed',
      (await count("SELECT COUNT(*) AS n FROM hr_regularisations WHERE user_id = ? AND status = 'pending'", [doomedId])) === 0,
    );
    check(
      'their open HR request is closed',
      (await count("SELECT COUNT(*) AS n FROM hr_requests WHERE user_id = ? AND status IN ('open','in_progress')", [
        doomedId,
      ])) === 0,
    );
    check(
      'the person who reported to them now has no manager',
      (await rows('SELECT manager_id FROM hr_users WHERE id = ?', [reportId]))[0]?.manager_id === null,
    );

    /* payroll — the user's rule */
    check(
      'their payslip is gone from the current pay period',
      (await count('SELECT COUNT(*) AS n FROM hr_payslips WHERE run_id = ? AND user_id = ?', [runId, doomedId])) === 0,
    );
    const runAfter = (await rows('SELECT employee_count FROM hr_payroll_runs WHERE id = ?', [runId]))[0];
    check(
      "and the period's headcount is recomputed without them",
      Number(runAfter?.employee_count) === headcountBefore - 1,
      { before: headcountBefore, after: runAfter?.employee_count },
    );
    const recalculated = await admin.post(`/admin/hr/payroll/runs/${runId}/process`);
    check(
      'calculating the period again leaves them out — not even as excluded',
      recalculated.status === 200 &&
        (await count('SELECT COUNT(*) AS n FROM hr_payslips WHERE run_id = ? AND user_id = ?', [runId, doomedId])) === 0 &&
        !((recalculated.json.run?.exclusions as Json[] | undefined) ?? []).some((entry) => entry.userId === doomedId),
      recalculated.json.run?.exclusions,
    );
    const payrollList = await admin.get(`/admin/hr/payroll/employees?q=${encodeURIComponent(doomedName)}`);
    check(
      'the payroll employee list no longer shows them',
      payrollList.status === 200 && !items(payrollList).some((row) => row.user?.id === doomedId),
      payrollList.json,
    );

    /* the directory, the record, and the app */
    const directory = await admin.get(`/admin/hr/employees?q=${encodeURIComponent(doomedName)}`);
    check('the employee directory no longer lists them', directory.status === 200 && Number(directory.json.total) === 0, directory.json);
    const record = await admin.get(`/admin/hr/employees/${doomedId}`);
    check(
      'their record is still readable, marked deleted, for history',
      record.status === 200 && typeof record.json.employee?.deletedAt === 'string',
      record.json.employee,
    );
    const history = await admin.get(`/admin/hr/employees/${doomedId}/attendance`);
    check('and so is their attendance history', history.status === 200, history.json);

    const edit = await admin.patch(`/admin/hr/employees/${doomedId}`, { name: 'Renamed After Delete' });
    check('a deleted record cannot be edited', edit.status === 409 && edit.json.code === 'employee_deleted', edit.json);
    const resetDeleted = await admin.post(`/admin/hr/employees/${doomedId}/password`, { password: NEW_PASSWORD });
    check(
      'a deleted employee cannot be given a password',
      resetDeleted.status === 409 && resetDeleted.json.code === 'employee_deleted',
      resetDeleted.json,
    );
    const switchOn = await admin.post(`/admin/hr/users/${doomedId}/active`, { active: true });
    check('a deleted employee cannot be switched back on', switchOn.status === 409, switchOn.json);
    const asManager = await admin.patch(`/admin/hr/employees/${reportId}`, { managerId: doomedId });
    check(
      'nobody can be given a deleted manager',
      asManager.status === 400 && typeof asManager.json.errors?.managerId === 'string',
      asManager.json,
    );

    const refresh = await makeClient(base).post('/hr/auth/refresh', { refreshToken: doomed.refreshToken });
    check('their app session cannot refresh', refresh.status === 401, refresh.json);
    const login = await signIn(doomedEmail, PASSWORD);
    check(
      'and they cannot sign in again',
      login.login.status === 403 && login.login.json.code === 'account_deactivated',
      login.login.json,
    );

    const again = await admin.del(`/admin/hr/employees/${doomedId}`);
    check(
      'deleting them again changes nothing',
      again.status === 200 && again.json.alreadyDeleted === true && again.json.leaveCancelled === 0,
      again.json,
    );
    check(
      'and the delete is audited once',
      (await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_employee_deleted' AND entity_id = ?", [
        doomedId,
      ])) === 1,
    );
  } finally {
    if (ownRun && runId > 0) await admin.del(`/admin/hr/payroll/runs/${runId}`);
  }
}
