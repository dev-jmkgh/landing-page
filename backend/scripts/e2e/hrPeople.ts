import type { E2EContext, Json } from './context';

/**
 * hrPeople — employee records and the organisation (departments, designations, the
 * directory, HR settings, shift weekly offs) plus the attendance-admin additions: the
 * paginated register with its day status, admin day corrections and the exceptions queue.
 *
 * Every fixture is this section's own: emails `ppl.hr.*@example.test`, department,
 * designation, shift and site names carrying a per-run tag. Employees are created
 * THROUGH the admin API (that is what is under test), so they take real `EMP-` codes —
 * allocated after the linear part's signups, which is the order a real system sees.
 * HR settings are restored to what they were before the section finishes, because the
 * leave and payroll sections after this one classify days with them.
 */

const PASSWORD = 'people-hr-section-password';

/** A list that arrives either bare or as a page (`{ items }`). */
function itemsOf(value: unknown): Json[] {
  if (Array.isArray(value)) return value as Json[];
  const items = (value as Json | null | undefined)?.items as unknown;
  return Array.isArray(items) ? (items as Json[]) : [];
}

/** A JSON column's value — parsed already on MySQL, text on MariaDB. */
function jsonColumn(value: unknown): Json | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Json;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

const sameSet = (left: unknown, right: unknown): boolean =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  JSON.stringify([...(left as string[])].sort()) === JSON.stringify([...(right as string[])].sort());

export async function run(ctx: E2EContext): Promise<void> {
  console.log('\nhr people and organisation');

  const { check, utcDb, adminAsBearer: admin, ravi, base, makeClient } = ctx;
  const cal = await import('../../src/modules/hr/calendar/calendar.service');

  /* ------------------------------------------------------------- helpers */

  // Through the UTC-pinned connection, like the app.
  const rows = async (statement: string, params: unknown[] = []): Promise<Json[]> => {
    const [result] = (await utcDb.query(statement, params)) as [Json[], unknown];
    return result;
  };
  const count = async (statement: string, params: unknown[] = []): Promise<number> =>
    Number((await rows(statement, params))[0]?.n ?? Number.NaN);

  /** Records the assertion, and stops the section when a fixture everything after needs failed. */
  const must = (label: string, condition: boolean, detail?: unknown): void => {
    check(label, condition, detail);
    if (!condition) throw new Error(`fixture failed: ${label} — ${JSON.stringify(detail)}`);
  };

  const today = cal.companyToday();
  const daysAgo = (n: number) => cal.addDays(today, -n);
  const tag = Date.now().toString(36).slice(-5).toUpperCase();

  const signIn = async (email: string) => {
    const client = makeClient(base);
    const login = await client.post('/hr/auth/login', {
      email,
      password: PASSWORD,
      device: { name: 'e2e-people', platform: 'android' },
    });
    const token = login.json.accessToken as unknown;
    if (typeof token === 'string') client.setToken(token);
    return { client, login };
  };

  /* ---------------------------------------------------------- departments */

  const deptAName = `HRP Finance ${tag}`;
  const deptBName = `HRP Operations ${tag}`;

  const deptA = await admin.post('/admin/hr/departments', { name: `  ${deptAName}  `, code: 'hrp-fin' });
  must('an admin creates a department', deptA.status === 201, deptA.json);
  const deptAId = Number(deptA.json.department?.id);
  check('its name is trimmed', deptA.json.department?.name === deptAName, deptA.json.department);
  check('its code is stored upper-cased', deptA.json.department?.code === 'HRP-FIN', deptA.json.department);
  check(
    'a new department is active with no employees',
    deptA.json.department?.isActive === true && deptA.json.department?.employeeCount === 0,
    deptA.json.department,
  );

  const dupDept = await admin.post('/admin/hr/departments', { name: deptAName.toLowerCase() });
  check(
    'a duplicate department name is refused whatever its case, against the name field',
    dupDept.status === 400 && typeof dupDept.json.errors?.name === 'string',
    dupDept.json,
  );

  const blankDept = await admin.post('/admin/hr/departments', { name: '   ' });
  check('a blank department name is refused', blankDept.status === 422, blankDept.json);

  const deptB = await admin.post('/admin/hr/departments', { name: deptBName });
  must('a second department is created', deptB.status === 201, deptB.json);
  const deptBId = Number(deptB.json.department?.id);
  check('a department without a code has a null code', deptB.json.department?.code === null, deptB.json.department);

  const renameClash = await admin.patch(`/admin/hr/departments/${deptBId}`, { name: deptAName });
  check('renaming onto another department’s name is refused', renameClash.status === 400, renameClash.json);

  const switchOff = await admin.patch(`/admin/hr/departments/${deptBId}`, { isActive: false, code: 'ops' });
  check(
    'a department can be switched off and given a code in one edit',
    switchOff.status === 200 &&
      switchOff.json.department?.isActive === false &&
      switchOff.json.department?.code === 'OPS',
    switchOff.json,
  );

  const intoInactive = await admin.post('/admin/hr/employees', {
    name: 'Nobody Placed',
    email: 'ppl.hr.nobody@example.test',
    password: PASSWORD,
    departmentId: deptBId,
  });
  check(
    'nobody new can be placed in a switched-off department',
    intoInactive.status === 400 && typeof intoInactive.json.errors?.departmentId === 'string',
    intoInactive.json,
  );

  const switchOn = await admin.patch(`/admin/hr/departments/${deptBId}`, { isActive: true });
  check('and it can be switched back on', switchOn.json.department?.isActive === true, switchOn.json);

  const emptyDeptPatch = await admin.patch(`/admin/hr/departments/${deptAId}`, {});
  check('an edit that changes nothing is refused', emptyDeptPatch.status === 422, emptyDeptPatch.json);

  const missingDept = await admin.patch('/admin/hr/departments/99999999', { name: 'Ghost Dept' });
  check('editing an unknown department is a 404', missingDept.status === 404, missingDept.status);

  const deptList = await admin.get('/admin/hr/departments');
  check(
    'the department list includes both, with counts',
    deptList.status === 200 &&
      [deptAId, deptBId].every((id) =>
        itemsOf(deptList.json).some((row) => row.id === id && typeof row.employeeCount === 'number'),
      ),
    deptList.json,
  );

  check(
    'creating a department is audited',
    (await count(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_department_created' AND entity_type = 'hr_department' AND entity_id = ?",
      [deptAId],
    )) === 1,
  );
  check(
    'and so is editing one',
    (await count(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_department_updated' AND entity_id = ?",
      [deptBId],
    )) === 2,
  );

  /* --------------------------------------------------------- designations */

  const desA = await admin.post('/admin/hr/designations', { name: `HRP Analyst ${tag}` });
  must('an admin creates a designation', desA.status === 201, desA.json);
  const desAId = Number(desA.json.designation?.id);
  check(
    'a designation has the department shape minus the code',
    desA.json.designation?.isActive === true &&
      desA.json.designation?.employeeCount === 0 &&
      !('code' in (desA.json.designation ?? {})),
    desA.json.designation,
  );

  const dupDes = await admin.post('/admin/hr/designations', { name: `hrp analyst ${tag}` });
  check('a duplicate designation is refused', dupDes.status === 400 && Boolean(dupDes.json.errors?.name), dupDes.json);

  const desB = await admin.post('/admin/hr/designations', { name: `HRP Lead ${tag}` });
  must('a second designation is created', desB.status === 201, desB.json);
  const desBId = Number(desB.json.designation?.id);

  const desRename = await admin.patch(`/admin/hr/designations/${desBId}`, { name: `HRP Team Lead ${tag}` });
  check(
    'a designation can be renamed',
    desRename.status === 200 && desRename.json.designation?.name === `HRP Team Lead ${tag}`,
    desRename.json,
  );

  const desList = await admin.get('/admin/hr/designations');
  check(
    'the designation list includes both',
    [desAId, desBId].every((id) => itemsOf(desList.json).some((row) => row.id === id)),
    desList.json,
  );

  /* ------------------------------------------------------ create employees */

  const highest = Number(
    (
      await rows(
        "SELECT MAX(CAST(SUBSTRING(employee_code, 5) AS UNSIGNED)) AS h FROM hr_users WHERE employee_code REGEXP '^EMP-[0-9]+$'",
      )
    )[0]?.h ?? 0,
  );
  const codeAt = (offset: number) => `EMP-${String(highest + offset).padStart(4, '0')}`;

  const priyaJoining = daysAgo(200);
  const priyaRes = await admin.post('/admin/hr/employees', {
    name: 'Priya   Pillai',
    email: 'PPL.HR.Priya@example.test',
    phone: '+91 98470 11001',
    password: PASSWORD,
    role: 'hr_manager',
    departmentId: deptAId,
    designationId: desAId,
    joiningDate: priyaJoining,
    employmentStatus: 'probation',
  });
  must('an admin creates an employee directly', priyaRes.status === 201, priyaRes.json);
  const priya = (priyaRes.json.employee ?? {}) as Json;
  const priyaId = Number(priya.id);

  check('the next EMP- code is allocated, as signup would', priya.employeeCode === codeAt(1), {
    got: priya.employeeCode,
    expected: codeAt(1),
  });
  check(
    'the account is approved, active and email-verified at once',
    priya.approvalStatus === 'approved' && priya.isActive === true && typeof priya.emailVerifiedAt === 'string',
    priya,
  );
  check('the name is tidied and the email lower-cased', priya.name === 'Priya Pillai' && priya.email === 'ppl.hr.priya@example.test', priya);
  check(
    'the employee record is stored',
    priya.departmentName === deptAName &&
      priya.designationName === `HRP Analyst ${tag}` &&
      priya.joiningDate === priyaJoining &&
      priya.employmentStatus === 'probation' &&
      priya.employmentType === 'full_time' &&
      priya.role === 'hr_manager',
    priya,
  );
  check('the response carries the assignment fields too', typeof priya.workMode === 'string' && 'shiftName' in priya, priya);

  const [priyaRow] = await rows('SELECT password_hash FROM hr_users WHERE id = ?', [priyaId]);
  check(
    'the password is stored hashed',
    typeof priyaRow?.password_hash === 'string' &&
      String(priyaRow.password_hash).startsWith('$2') &&
      priyaRow.password_hash !== PASSWORD,
  );
  check(
    'creating an employee is audited',
    (await count(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_employee_created' AND entity_type = 'hr_user' AND entity_id = ?",
      [priyaId],
    )) === 1,
  );

  const dupEmail = await admin.post('/admin/hr/employees', {
    name: 'Priya Again',
    email: 'ppl.hr.priya@EXAMPLE.test',
    password: PASSWORD,
  });
  check(
    'an email already used by an HR account is refused against the email field',
    dupEmail.status === 400 && typeof dupEmail.json.errors?.email === 'string',
    dupEmail.json,
  );

  const shortPassword = await admin.post('/admin/hr/employees', {
    name: 'Short Password',
    email: 'ppl.hr.short@example.test',
    password: 'short',
  });
  check(
    'a password the signup would refuse is refused here too',
    shortPassword.status === 422 && typeof shortPassword.json.errors?.password === 'string',
    shortPassword.json,
  );

  const ghostDept = await admin.post('/admin/hr/employees', {
    name: 'Ghost Department',
    email: 'ppl.hr.ghost@example.test',
    password: PASSWORD,
    departmentId: 99999999,
  });
  check(
    'a department that does not exist is refused',
    ghostDept.status === 400 && typeof ghostDept.json.errors?.departmentId === 'string',
    ghostDept.json,
  );

  const ghostManager = await admin.post('/admin/hr/employees', {
    name: 'Ghost Manager',
    email: 'ppl.hr.ghostmgr@example.test',
    password: PASSWORD,
    managerId: 99999999,
  });
  check(
    'a manager that does not exist is refused',
    ghostManager.status === 400 && typeof ghostManager.json.errors?.managerId === 'string',
    ghostManager.json,
  );

  const priyaSession = await signIn('ppl.hr.priya@example.test');
  must('an admin-created employee can sign in to the HR app', priyaSession.login.status === 200, priyaSession.login.json);
  const priyaClient = priyaSession.client;

  const priyaMe = await priyaClient.get('/hr/auth/me');
  check(
    '/hr/auth/me shows the department, designation and joining date',
    priyaMe.status === 200 &&
      priyaMe.json.employee?.departmentName === deptAName &&
      priyaMe.json.employee?.designationName === `HRP Analyst ${tag}` &&
      priyaMe.json.employee?.joiningDate === priyaJoining &&
      priyaMe.json.employee?.managerName === null,
    priyaMe.json,
  );

  const createMore = async (name: string, email: string, extra: Json) => {
    const response = await admin.post('/admin/hr/employees', { name, email, password: PASSWORD, ...extra });
    must(`fixture: employee ${name}`, response.status === 201, response.json);
    return Number(response.json.employee?.id);
  };

  const arunJoining = daysAgo(100);
  const arunRes = await admin.post('/admin/hr/employees', {
    name: 'Arun Nair',
    email: 'ppl.hr.arun@example.test',
    password: PASSWORD,
    departmentId: deptAId,
    designationId: desAId,
    managerId: priyaId,
    joiningDate: arunJoining,
  });
  must('an employee can be created reporting to another', arunRes.status === 201, arunRes.json);
  const arunId = Number(arunRes.json.employee?.id);
  check('codes keep counting up', arunRes.json.employee?.employeeCode === codeAt(2), arunRes.json.employee?.employeeCode);

  const arunSession = await signIn('ppl.hr.arun@example.test');
  must('the second employee signs in', arunSession.login.status === 200, arunSession.login.json);
  const arunClient = arunSession.client;

  const arunMe = await arunClient.get('/hr/auth/me');
  check(
    '/hr/auth/me shows the manager',
    arunMe.json.employee?.managerId === priyaId && arunMe.json.employee?.managerName === 'Priya Pillai',
    arunMe.json.employee,
  );

  const chitraId = await createMore('Chitra Menon', 'ppl.hr.chitra@example.test', {
    departmentId: deptBId,
    managerId: arunId,
    joiningDate: daysAgo(50),
  });
  const devId = await createMore('Dev Raj', 'ppl.hr.dev@example.test', {
    departmentId: deptBId,
    joiningDate: daysAgo(50),
  });

  /* ---------------------------------------------------------------- edits */

  const selfManager = await admin.patch(`/admin/hr/employees/${priyaId}`, { managerId: priyaId });
  check(
    'nobody can be their own manager',
    selfManager.status === 400 && typeof selfManager.json.errors?.managerId === 'string',
    selfManager.json,
  );

  const directCycle = await admin.patch(`/admin/hr/employees/${priyaId}`, { managerId: arunId });
  check(
    'a two-person loop in the reporting line is refused',
    directCycle.status === 400 && typeof directCycle.json.errors?.managerId === 'string',
    directCycle.json,
  );

  const deepCycle = await admin.patch(`/admin/hr/employees/${priyaId}`, { managerId: chitraId });
  check(
    'a loop through a chain of managers is refused too',
    deepCycle.status === 400 && typeof deepCycle.json.errors?.managerId === 'string',
    deepCycle.json,
  );
  check(
    'and the refused manager was not written',
    (await count('SELECT COUNT(*) AS n FROM hr_users WHERE id = ? AND manager_id IS NULL', [priyaId])) === 1,
  );

  const exitBeforeJoin = await admin.patch(`/admin/hr/employees/${arunId}`, { exitDate: daysAgo(150) });
  check(
    'an exit date before the joining date is refused',
    exitBeforeJoin.status === 400 && typeof exitBeforeJoin.json.errors?.exitDate === 'string',
    exitBeforeJoin.json,
  );

  const futureBirth = await admin.patch(`/admin/hr/employees/${arunId}`, { dateOfBirth: cal.addDays(today, 1) });
  check(
    'a date of birth in the future is refused',
    futureBirth.status === 400 && typeof futureBirth.json.errors?.dateOfBirth === 'string',
    futureBirth.json,
  );

  const badPhone = await admin.patch(`/admin/hr/employees/${arunId}`, { phone: 'not a phone' });
  check('a malformed phone is refused', badPhone.status === 422 && Boolean(badPhone.json.errors?.phone), badPhone.json);

  const noChange = await admin.patch(`/admin/hr/employees/${arunId}`, {});
  check('an empty edit is refused', noChange.status === 422, noChange.json);

  const ghostEdit = await admin.patch('/admin/hr/employees/99999999', { name: 'Ghost Person' });
  check('editing an unknown employee is a 404', ghostEdit.status === 404, ghostEdit.status);

  const edit = await admin.patch(`/admin/hr/employees/${arunId}`, {
    phone: '+91 98470 11002',
    address: '12  Marine   Drive, Kochi',
    employmentStatus: 'notice_period',
    designationId: desBId,
    emergencyContactName: 'Lakshmi Nair',
    emergencyContactPhone: '+91 98470 11003',
    dateOfBirth: '1994-05-17',
  });
  check('an admin edits an employee record', edit.status === 200, edit.json);
  check(
    'the edit is applied',
    edit.json.employee?.employmentStatus === 'notice_period' &&
      edit.json.employee?.address === '12 Marine Drive, Kochi' &&
      edit.json.employee?.designationName === `HRP Team Lead ${tag}` &&
      edit.json.employee?.dateOfBirth === '1994-05-17' &&
      edit.json.employee?.emergencyContactPhone === '+91 98470 11003',
    edit.json.employee,
  );
  check('no role notice when the role did not change', edit.json.notice === null, edit.json.notice);
  check(
    'the response says which fields changed',
    Array.isArray(edit.json.changed) && (edit.json.changed as string[]).includes('employmentStatus'),
    edit.json.changed,
  );

  const [editAudit] = await rows(
    "SELECT meta FROM audit_logs WHERE action = 'hr_employee_updated' AND entity_type = 'hr_user' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [arunId],
  );
  const editMeta = jsonColumn(editAudit?.meta);
  check(
    'the edit is audited with before and after of the changed fields',
    editMeta?.before?.employmentStatus === 'active' &&
      editMeta?.after?.employmentStatus === 'notice_period' &&
      editMeta?.before?.designationId === desAId &&
      editMeta?.after?.designationId === desBId,
    editMeta,
  );
  check('and only the changed fields', editMeta !== null && !('name' in (editMeta.before ?? {})), editMeta);

  const cleared = await admin.patch(`/admin/hr/employees/${arunId}`, { address: null });
  check('a field can be cleared with null', cleared.status === 200 && cleared.json.employee?.address === null, cleared.json);
  check('and leaving a field out leaves it alone', cleared.json.employee?.phone === '+91 98470 11002', cleared.json.employee);

  const roleChange = await admin.patch(`/admin/hr/employees/${arunId}`, { role: 'hr_manager' });
  check(
    'a role change says when it takes effect',
    roleChange.status === 200 &&
      roleChange.json.employee?.role === 'hr_manager' &&
      typeof roleChange.json.notice === 'string' &&
      (roleChange.json.notice as string).length > 0,
    roleChange.json,
  );

  const auditsBefore = await count(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_employee_updated' AND entity_id = ?",
    [arunId],
  );
  const sameRole = await admin.patch(`/admin/hr/employees/${arunId}`, { role: 'hr_manager' });
  check(
    'saving a value that is already set changes nothing and audits nothing',
    sameRole.status === 200 &&
      Array.isArray(sameRole.json.changed) &&
      (sameRole.json.changed as unknown[]).length === 0 &&
      (await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_employee_updated' AND entity_id = ?", [
        arunId,
      ])) === auditsBefore,
    sameRole.json,
  );

  const moveChitra = await admin.patch(`/admin/hr/employees/${chitraId}`, { managerId: priyaId });
  check('a legitimate change of manager is accepted', moveChitra.status === 200 && moveChitra.json.employee?.managerId === priyaId, moveChitra.json);

  /* ------------------------------------------------------------ directory */

  const dirA = await admin.get(`/admin/hr/employees?departmentId=${deptAId}`);
  check(
    'the directory filters by department, with a total',
    dirA.status === 200 && dirA.json.total === 2 && dirA.json.page === 1 && dirA.json.pageSize === 20,
    dirA.json,
  );
  check(
    'alphabetically',
    itemsOf(dirA.json).map((row) => row.name).join('|') === 'Arun Nair|Priya Pillai',
    itemsOf(dirA.json).map((row) => row.name),
  );

  const pageOne = await admin.get(`/admin/hr/employees?departmentId=${deptAId}&pageSize=1`);
  const pageTwo = await admin.get(`/admin/hr/employees?departmentId=${deptAId}&pageSize=1&page=2`);
  const pagedIds = [...itemsOf(pageOne.json), ...itemsOf(pageTwo.json)].map((row) => Number(row.id));
  check(
    'the directory paginates: one per page, the same total on each',
    itemsOf(pageOne.json).length === 1 &&
      itemsOf(pageTwo.json).length === 1 &&
      pageOne.json.total === 2 &&
      pageTwo.json.total === 2 &&
      sameSet(pagedIds, [arunId, priyaId]),
    { pageOne: pageOne.json, pageTwo: pageTwo.json },
  );

  const byManager = await admin.get(`/admin/hr/employees?managerId=${priyaId}`);
  check(
    'filtering by manager lists their direct reports',
    byManager.json.total === 2 && sameSet(itemsOf(byManager.json).map((row) => Number(row.id)), [arunId, chitraId]),
    byManager.json,
  );

  const byStatus = await admin.get(`/admin/hr/employees?departmentId=${deptAId}&employmentStatus=notice_period`);
  check(
    'filtering by employment status',
    byStatus.json.total === 1 && itemsOf(byStatus.json)[0]?.id === arunId,
    byStatus.json,
  );

  const byDesignation = await admin.get(`/admin/hr/employees?designationId=${desAId}`);
  check(
    'filtering by designation',
    byDesignation.json.total === 1 && itemsOf(byDesignation.json)[0]?.id === priyaId,
    byDesignation.json,
  );

  const bySearch = await admin.get('/admin/hr/employees?q=ppl.hr.dev&departmentId=&workMode=');
  check(
    'searching works, and blank filters mean "any"',
    bySearch.status === 200 && bySearch.json.total === 1 && itemsOf(bySearch.json)[0]?.id === devId,
    bySearch.json,
  );

  const inactive = await admin.get(`/admin/hr/employees?departmentId=${deptAId}&active=false`);
  check('filtering by account state', inactive.status === 200 && inactive.json.total === 0, inactive.json);

  const approved = await admin.get(`/admin/hr/employees?departmentId=${deptBId}&approval=approved`);
  check('filtering by approval', approved.json.total === 2, approved.json);

  const badFilter = await admin.get('/admin/hr/employees?workMode=space');
  check('an unknown work mode is refused', badFilter.status === 422, badFilter.status);
  const bigPage = await admin.get('/admin/hr/employees?pageSize=101');
  check('a page larger than 100 is refused', bigPage.status === 422, bigPage.status);

  /* --------------------------------------------------------------- detail */

  const detail = await admin.get(`/admin/hr/employees/${priyaId}`);
  check(
    'the employee detail carries the profile, the assignment and the direct-report count',
    detail.status === 200 &&
      detail.json.employee?.id === priyaId &&
      detail.json.employee?.departmentName === deptAName &&
      typeof detail.json.employee?.workMode === 'string' &&
      detail.json.directReports === 2,
    detail.json,
  );

  const ghostDetail = await admin.get('/admin/hr/employees/99999999');
  check('an unknown employee is a 404', ghostDetail.status === 404, ghostDetail.status);

  const counted = itemsOf((await admin.get('/admin/hr/departments')).json);
  check(
    'department headcounts follow the employees placed in them',
    counted.find((row) => row.id === deptAId)?.employeeCount === 2 &&
      counted.find((row) => row.id === deptBId)?.employeeCount === 2,
    counted.filter((row) => row.id === deptAId || row.id === deptBId),
  );

  /* ------------------------------------------------------------- settings */

  const original = await admin.get('/admin/hr/settings');
  must('the HR settings can be read', original.status === 200 && Array.isArray(original.json.settings?.defaultWeeklyOff), original.json);
  const originalSettings = original.json.settings as Json;

  const changed = await admin.patch('/admin/hr/settings', {
    defaultWeeklyOff: ['sat', 'sun'],
    attendanceTrackedFrom: '2026-01-01',
  });
  check(
    'an admin changes the HR settings',
    changed.status === 200 &&
      sameSet(changed.json.settings?.defaultWeeklyOff, ['sat', 'sun']) &&
      changed.json.settings?.attendanceTrackedFrom === '2026-01-01',
    changed.json,
  );
  const reread = await admin.get('/admin/hr/settings');
  check(
    'and they read back as saved',
    sameSet(reread.json.settings?.defaultWeeklyOff, ['sat', 'sun']) &&
      reread.json.settings?.attendanceTrackedFrom === '2026-01-01',
    reread.json,
  );

  const badWeekday = await admin.patch('/admin/hr/settings', { defaultWeeklyOff: ['funday'] });
  check('an unknown weekday is refused', badWeekday.status === 422, badWeekday.json);
  const badTracked = await admin.patch('/admin/hr/settings', { attendanceTrackedFrom: '2026-02-30' });
  check('a date that does not exist is refused', badTracked.status === 422, badTracked.json);
  const emptySettings = await admin.patch('/admin/hr/settings', {});
  check('an empty settings edit is refused', emptySettings.status === 422, emptySettings.json);

  const [settingsAudit] = await rows(
    "SELECT meta FROM audit_logs WHERE action = 'hr_settings_updated' AND entity_type = 'hr_settings' ORDER BY id DESC LIMIT 1",
  );
  check(
    'a settings change is audited with before and after',
    jsonColumn(settingsAudit?.meta)?.after?.attendanceTrackedFrom === '2026-01-01',
    settingsAudit,
  );

  const restored = await admin.patch('/admin/hr/settings', {
    defaultWeeklyOff: originalSettings.defaultWeeklyOff,
    attendanceTrackedFrom: originalSettings.attendanceTrackedFrom ?? null,
  });
  must(
    'the settings are restored for the sections after this one',
    restored.status === 200 &&
      sameSet(restored.json.settings?.defaultWeeklyOff, originalSettings.defaultWeeklyOff) &&
      (restored.json.settings?.attendanceTrackedFrom ?? null) === (originalSettings.attendanceTrackedFrom ?? null),
    restored.json,
  );

  /* -------------------------------------------------- shift weekly offs */

  // 10:00 starts, so the seeded 09:00 General shift stays first in the list.
  const shiftBody = { startsAt: '10:00', endsAt: '18:00', breakMinutes: 60, graceMinutes: 10, halfDayMinutes: 240 };

  const dayShift = await admin.post('/admin/hr/shifts', { name: `HRP Day ${tag}`, ...shiftBody, weeklyOffDays: ['sat', 'sun'] });
  must('a shift is created with its weekly offs', dayShift.status === 201, dayShift.json);
  const dayShiftId = Number(dayShift.json.shift?.id);
  check(
    'the weekly offs come back Sunday-first',
    JSON.stringify(dayShift.json.shift?.weeklyOffDays) === JSON.stringify(['sun', 'sat']),
    dayShift.json.shift,
  );

  const noOffs = await admin.patch(`/admin/hr/shifts/${dayShiftId}`, { weeklyOffDays: [] });
  check(
    'a shift can be set to have no weekly off at all',
    noOffs.status === 200 && Array.isArray(noOffs.json.shift?.weeklyOffDays) && noOffs.json.shift.weeklyOffDays.length === 0,
    noOffs.json,
  );
  const renamed = await admin.patch(`/admin/hr/shifts/${dayShiftId}`, { name: `HRP Day Shift ${tag}` });
  check(
    'an edit that does not mention weekly offs leaves them alone',
    renamed.status === 200 && Array.isArray(renamed.json.shift?.weeklyOffDays) && renamed.json.shift.weeklyOffDays.length === 0,
    renamed.json,
  );
  check(
    'and the column holds the empty set',
    (await count("SELECT COUNT(*) AS n FROM hr_shifts WHERE id = ? AND weekly_off_days = ''", [dayShiftId])) === 1,
  );

  const restShift = await admin.post('/admin/hr/shifts', {
    name: `HRP Rest ${tag}`,
    ...shiftBody,
    weeklyOffDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  });
  must('a shift resting every day is accepted (a fixture)', restShift.status === 201, restShift.json);
  const restShiftId = Number(restShift.json.shift?.id);

  const defaultShift = await admin.post('/admin/hr/shifts', { name: `HRP Default ${tag}`, ...shiftBody });
  check(
    'a shift created without weekly offs rests on Sunday',
    defaultShift.status === 201 && JSON.stringify(defaultShift.json.shift?.weeklyOffDays) === JSON.stringify(['sun']),
    defaultShift.json,
  );
  if (defaultShift.status === 201) {
    await admin.patch(`/admin/hr/shifts/${Number(defaultShift.json.shift?.id)}`, { isActive: false });
  }

  const badShift = await admin.post('/admin/hr/shifts', { name: `HRP Bad ${tag}`, ...shiftBody, weeklyOffDays: ['someday'] });
  check('an unknown weekday on a shift is refused', badShift.status === 422, badShift.json);

  const shiftList = await admin.get('/admin/hr/shifts');
  check(
    'every listed shift carries its weekly offs',
    itemsOf(shiftList.json).length > 0 && itemsOf(shiftList.json).every((row) => Array.isArray(row.weeklyOffDays)),
    itemsOf(shiftList.json).map((row) => row.weeklyOffDays),
  );

  /* ------------------------------------------------------------- register */

  /*
   * Fixtures for one date (today):
   *   Priya — remote, a shift with NO weekly off, no punch     → absent
   *   Arun  — remote, no shift, checks in (mocked location)    → present, currently in, flagged
   *   Chitra — remote, a shift resting every day               → weekly_off
   *   Dev   — remote, a working shift, approved casual leave   → on_leave
   * Remote, because an office worker without a site is refused at check-in.
   */
  const site = await admin.post('/admin/hr/locations', {
    name: `HRP Site ${tag}`,
    latitude: 9.9312,
    longitude: 76.2673,
    radiusMetres: 150,
  });
  must('fixture: a work location', site.status === 201, site.json);
  const siteId = Number(site.json.location?.id);

  const assign = async (id: number, body: Json, label: string) => {
    const response = await admin.call('PATCH', `/admin/hr/users/${id}/assignment`, body);
    must(`fixture: assign ${label}`, response.status === 200, response.json);
  };
  await assign(priyaId, { workMode: 'remote', workLocationId: siteId, shiftId: dayShiftId }, 'Priya');
  await assign(arunId, { workMode: 'remote' }, 'Arun');
  await assign(chitraId, { workMode: 'remote', shiftId: restShiftId }, 'Chitra');
  await assign(devId, { workMode: 'remote', shiftId: dayShiftId }, 'Dev');

  await utcDb.query(
    `INSERT INTO hr_leave_requests
       (user_id, leave_type_id, start_date, end_date, half_day, days, reason, status,
        reviewer_type, reviewer_name, reviewed_at)
     SELECT ?, id, ?, ?, 'none', 1, 'People section fixture', 'approved', 'admin', 'e2e', UTC_TIMESTAMP()
       FROM hr_leave_types WHERE code = 'CL'`,
    [devId, today, today],
  );

  const arunIn = await arunClient.post('/hr/attendance/check-in', { mocked: true, deviceTime: new Date().toISOString() });
  must('fixture: Arun checks in, reporting a mock location', arunIn.status === 201, arunIn.json);
  check('a mocked punch flags the day', arunIn.json.day?.flagged === true, arunIn.json.day);

  const holidayToday =
    (await count('SELECT COUNT(*) AS n FROM hr_holidays WHERE holiday_date = ? AND is_optional = 0', [today])) > 0;
  if (holidayToday) console.log('  (today is a holiday in this database: day-status checks that assume a working day are skipped)');

  const register = await admin.get(`/admin/hr/attendance?departmentId=${deptAId}`);
  check(
    'the register is a page for one date',
    register.status === 200 &&
      register.json.date === today &&
      register.json.total === 2 &&
      register.json.page === 1 &&
      register.json.pageSize === 20,
    register.json,
  );
  const regItems = itemsOf(register.json);
  const arunReg = regItems.find((row) => row.userId === arunId);
  const priyaReg = regItems.find((row) => row.userId === priyaId);
  check(
    'each row carries department, designation and the new day fields',
    regItems.every(
      (row) =>
        row.departmentName === deptAName &&
        'designationName' in row &&
        typeof row.missingPunch === 'boolean' &&
        typeof row.flagged === 'boolean' &&
        'leaveTypeName' in row &&
        typeof row.dayStatus === 'string' &&
        typeof row.status === 'string',
    ),
    regItems,
  );
  check(
    'the employee who checked in today reads checked in, in right now, and flagged',
    arunReg?.dayStatus === 'checked_in' && arunReg?.currentlyIn === true && arunReg?.flagged === true && arunReg?.missingPunch === false,
    arunReg,
  );
  if (!holidayToday) {
    check(
      'the one with no punch on a working day is yet to check in — not absent while the day is going',
      priyaReg?.dayStatus === 'yet_to_check_in',
      priyaReg,
    );
  }

  const regPage1 = await admin.get(`/admin/hr/attendance?departmentId=${deptAId}&pageSize=1`);
  const regPage2 = await admin.get(`/admin/hr/attendance?departmentId=${deptAId}&pageSize=1&page=2`);
  check(
    'the register paginates',
    itemsOf(regPage1.json).length === 1 &&
      itemsOf(regPage2.json).length === 1 &&
      regPage1.json.total === 2 &&
      sameSet([...itemsOf(regPage1.json), ...itemsOf(regPage2.json)].map((row) => Number(row.userId)), [arunId, priyaId]),
    { one: regPage1.json, two: regPage2.json },
  );
  check('checked-in people come first', itemsOf(regPage1.json)[0]?.userId === arunId, itemsOf(regPage1.json));

  const regFilter = async (query: string) => admin.get(`/admin/hr/attendance?${query}`);
  const idsOf = (response: { json: Json }) => itemsOf(response.json).map((row) => Number(row.userId));

  const currentlyIn = await regFilter(`departmentId=${deptAId}&status=currently_in`);
  check('status=currently_in', currentlyIn.json.total === 1 && sameSet(idsOf(currentlyIn), [arunId]), currentlyIn.json);

  const presentOnly = await regFilter(`departmentId=${deptAId}&status=present`);
  check('status=present names nobody today: verdicts wait for the day to end', presentOnly.json.total === 0, presentOnly.json);
  const checkedOutToday = await regFilter(`departmentId=${deptAId}&status=checked_out`);
  check('status=checked_out does not list somebody still in', checkedOutToday.json.total === 0, checkedOutToday.json);

  if (!holidayToday) {
    const absentA = await regFilter(`departmentId=${deptAId}&status=absent`);
    check('status=absent names nobody today either', absentA.json.total === 0, absentA.json);
    const yetToCheckIn = await regFilter(`departmentId=${deptAId}&status=yet_to_check_in`);
    check(
      'status=yet_to_check_in names the one with no punch',
      yetToCheckIn.json.total === 1 &&
        sameSet(idsOf(yetToCheckIn), [priyaId]) &&
        itemsOf(yetToCheckIn.json)[0]?.dayStatus === 'yet_to_check_in',
      yetToCheckIn.json,
    );

    const weeklyOff = await regFilter(`departmentId=${deptBId}&status=weekly_off`);
    check(
      'status=weekly_off follows the shift’s rest days',
      weeklyOff.json.total === 1 &&
        sameSet(idsOf(weeklyOff), [chitraId]) &&
        itemsOf(weeklyOff.json)[0]?.dayStatus === 'weekly_off',
      weeklyOff.json,
    );

    const onLeave = await regFilter(`departmentId=${deptBId}&status=on_leave`);
    check(
      'status=on_leave, with the leave type named',
      onLeave.json.total === 1 &&
        sameSet(idsOf(onLeave), [devId]) &&
        itemsOf(onLeave.json)[0]?.dayStatus === 'on_leave' &&
        itemsOf(onLeave.json)[0]?.leaveTypeName === 'Casual leave',
      onLeave.json,
    );

    const notInB = await regFilter(`departmentId=${deptBId}&status=yet_to_check_in`);
    check(
      'yet to check in excludes people on leave and on their weekly off',
      notInB.status === 200 && notInB.json.total === 0,
      notInB.json,
    );
  }

  const bySite = await regFilter(`locationId=${siteId}`);
  check('the register filters by assigned site', bySite.json.total === 1 && sameSet(idsOf(bySite), [priyaId]), bySite.json);

  const bySearchReg = await regFilter('q=ppl.hr.chitra');
  check('the register searches', bySearchReg.json.total === 1 && sameSet(idsOf(bySearchReg), [chitraId]), bySearchReg.json);

  const future = cal.addDays(today, 3);
  const futureAbsent = await regFilter(`departmentId=${deptAId}&date=${future}&status=absent`);
  check('nobody is absent on a day that has not happened', futureAbsent.status === 200 && futureAbsent.json.total === 0, futureAbsent.json);
  const futureReg = await regFilter(`userId=${priyaId}&date=${future}`);
  check('a future day is upcoming', itemsOf(futureReg.json)[0]?.dayStatus === 'upcoming', futureReg.json);

  // A forgotten check-out two days ago, already closed by the system (a missing punch).
  const missedDate = daysAgo(2);
  const [missedInsert] = (await utcDb.query(
    `INSERT INTO hr_attendance (user_id, work_date, work_mode, source, status, missing_punch, checked_in_at)
     VALUES (?, ?, 'remote', 'app', 'present', 1, UTC_TIMESTAMP() - INTERVAL 2 DAY)`,
    [chitraId, missedDate],
  )) as [{ insertId: number }, unknown];
  const missedDayId = Number(missedInsert.insertId);
  await utcDb.query(
    `INSERT INTO hr_attendance_sessions (attendance_id, user_id, started_at, ended_at, minutes, source, auto_closed)
     VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL 2 DAY, UTC_TIMESTAMP() - INTERVAL 2 DAY, 0, 'app', 1)`,
    [missedDayId, chitraId],
  );
  const notOut = await regFilter(`departmentId=${deptBId}&date=${missedDate}&status=not_checked_out`);
  check(
    'status=not_checked_out finds a missing punch',
    notOut.json.total === 1 && sameSet(idsOf(notOut), [chitraId]) && itemsOf(notOut.json)[0]?.missingPunch === true,
    notOut.json,
  );

  const badStatus = await regFilter('status=sleeping');
  check('an unknown register status is refused', badStatus.status === 422, badStatus.status);
  const badDate = await regFilter('date=2026-02-30');
  check('a register date that does not exist is refused', badDate.status === 422, badDate.status);

  /* ---------------------------------------------------- admin corrections */

  const d3 = daysAgo(3);
  const firstFix = await admin.put(`/admin/hr/attendance/${priyaId}/${d3}`, {
    sessions: [
      { startAt: '14:00', endAt: '18:30' },
      { startAt: '10:00', endAt: '13:00' },
    ],
    reason: 'Phone was off all day; hours confirmed by her lead',
  });
  check('an admin corrects a day', firstFix.status === 200, firstFix.json);
  check(
    'the day is marked as an admin correction, with the hours recomputed from the sessions',
    firstFix.json.day?.source === 'admin' &&
      firstFix.json.day?.workedMinutes === 450 &&
      firstFix.json.day?.breakMinutes === 60 &&
      firstFix.json.day?.status === 'present' &&
      firstFix.json.day?.lateMinutes === 0,
    firstFix.json.day,
  );
  check(
    'every session is an admin session',
    Array.isArray(firstFix.json.day?.sessions) &&
      (firstFix.json.day.sessions as Json[]).length === 2 &&
      (firstFix.json.day.sessions as Json[]).every((session) => session.source === 'admin'),
    firstFix.json.day?.sessions,
  );

  const [fixedDay] = await rows(
    'SELECT id, source, note, worked_minutes FROM hr_attendance WHERE user_id = ? AND work_date = ?',
    [priyaId, d3],
  );
  const fixedDayId = Number(fixedDay?.id);
  check(
    'the day row carries the reason as its note',
    fixedDay?.source === 'admin' && fixedDay?.note === 'Phone was off all day; hours confirmed by her lead' && Number(fixedDay?.worked_minutes) === 450,
    fixedDay,
  );
  const fixedStarts = (
    await rows(
      "SELECT DATE_FORMAT(started_at, '%H:%i') AS s FROM hr_attendance_sessions WHERE attendance_id = ? ORDER BY started_at",
      [fixedDayId],
    )
  ).map((row) => row.s);
  check(
    'wall-clock times are stored as UTC (10:00 IST is 04:30Z)',
    JSON.stringify(fixedStarts) === JSON.stringify(['04:30', '08:30']),
    fixedStarts,
  );

  const secondFix = await admin.put(`/admin/hr/attendance/${priyaId}/${d3}`, {
    sessions: [{ startAt: '11:00', endAt: '12:30' }],
    reason: 'Second look: only the late morning was worked',
  });
  check(
    'a second correction REPLACES the sessions, and lateness is re-derived',
    secondFix.status === 200 &&
      secondFix.json.day?.workedMinutes === 90 &&
      (secondFix.json.day?.sessions as Json[] | undefined)?.length === 1 &&
      secondFix.json.day?.lateMinutes === 50 &&
      /*
       * Ninety minutes is under the shift's half-day threshold, so the day is a half day
       * even though it started late — lateness stays on the row as late_minutes.
       */
      secondFix.json.day?.status === 'half_day',
    secondFix.json.day,
  );
  check(
    'and the old sessions are gone from the database',
    (await count('SELECT COUNT(*) AS n FROM hr_attendance_sessions WHERE attendance_id = ?', [fixedDayId])) === 1,
  );

  const [fixAudit] = await rows(
    "SELECT meta FROM audit_logs WHERE action = 'hr_attendance_corrected' AND entity_type = 'hr_attendance' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [fixedDayId],
  );
  const fixMeta = jsonColumn(fixAudit?.meta);
  check(
    'the correction is audited with the session lists before and after',
    Array.isArray(fixMeta?.before?.sessions) &&
      fixMeta.before.sessions.length === 2 &&
      Array.isArray(fixMeta?.after?.sessions) &&
      fixMeta.after.sessions.length === 1 &&
      fixMeta?.reason === 'Second look: only the late morning was worked',
    fixMeta,
  );

  const correction = (sessions: Json[], reason = 'Correcting a missed punch') => ({ sessions, reason });

  const futureFix = await admin.put(`/admin/hr/attendance/${priyaId}/${cal.addDays(today, 1)}`, correction([{ startAt: '10:00', endAt: '11:00' }]));
  check('a future day cannot be corrected', futureFix.status === 400, futureFix.json);

  const overlap = await admin.put(
    `/admin/hr/attendance/${priyaId}/${d3}`,
    correction([
      { startAt: '10:00', endAt: '12:00' },
      { startAt: '11:00', endAt: '13:00' },
    ]),
  );
  check(
    'overlapping sessions are refused, against the session that overlaps',
    overlap.status === 422 && typeof overlap.json.errors?.['sessions.1.startAt'] === 'string',
    overlap.json,
  );

  const backwards = await admin.put(`/admin/hr/attendance/${priyaId}/${d3}`, correction([{ startAt: '12:00', endAt: '11:00' }]));
  check('a session ending before it starts is refused', backwards.status === 422, backwards.json);

  const openPast = await admin.put(`/admin/hr/attendance/${priyaId}/${d3}`, correction([{ startAt: '10:00', endAt: null }]));
  check('a past day cannot be left with a session running', openPast.status === 400, openPast.json);

  const shortReason = await admin.put(`/admin/hr/attendance/${priyaId}/${d3}`, correction([{ startAt: '10:00', endAt: '11:00' }], 'no'));
  check('a correction needs a reason', shortReason.status === 422 && Boolean(shortReason.json.errors?.reason), shortReason.json);

  const tooMany = await admin.put(
    `/admin/hr/attendance/${priyaId}/${d3}`,
    correction(Array.from({ length: 11 }, (_, i) => ({ startAt: `${String(i + 8).padStart(2, '0')}:00`, endAt: `${String(i + 8).padStart(2, '0')}:30` }))),
  );
  check('at most ten sessions a day', tooMany.status === 422, tooMany.json);

  const ghostFix = await admin.put(`/admin/hr/attendance/99999999/${d3}`, correction([{ startAt: '10:00', endAt: '11:00' }]));
  check('correcting an unknown employee is a 404', ghostFix.status === 404, ghostFix.status);

  const badFixDate = await admin.put(`/admin/hr/attendance/${priyaId}/2026-13-01`, correction([{ startAt: '10:00', endAt: '11:00' }]));
  check('a date that does not exist is refused', badFixDate.status === 400, badFixDate.json);

  const raviFix = await ravi.put(`/admin/hr/attendance/${priyaId}/${d3}`, correction([{ startAt: '10:00', endAt: '11:00' }]));
  check('a telecaller cannot correct attendance', raviFix.status === 403, raviFix.status);

  for (const ago of [4, 5]) {
    const extra = await admin.put(`/admin/hr/attendance/${priyaId}/${daysAgo(ago)}`, correction([{ startAt: '10:00', endAt: '18:00' }]));
    must(`fixture: a corrected day ${ago} days ago`, extra.status === 200, extra.json);
  }

  /* -------------------------------------- one employee's attendance and calendar */

  const history = await admin.get(`/admin/hr/employees/${priyaId}/attendance?from=${daysAgo(10)}&to=${today}`);
  check(
    'an employee’s days are listed newest first, with their sessions',
    history.status === 200 &&
      history.json.total === 3 &&
      itemsOf(history.json).map((day) => day.workDate).join(',') === [d3, daysAgo(4), daysAgo(5)].join(',') &&
      (itemsOf(history.json)[0]?.sessions as Json[] | undefined)?.length === 1,
    history.json,
  );

  const histPage1 = await admin.get(`/admin/hr/employees/${priyaId}/attendance?from=${daysAgo(10)}&to=${today}&pageSize=2`);
  const histPage2 = await admin.get(`/admin/hr/employees/${priyaId}/attendance?from=${daysAgo(10)}&to=${today}&pageSize=2&page=2`);
  check(
    'and paginated',
    itemsOf(histPage1.json).map((day) => day.workDate).join(',') === [d3, daysAgo(4)].join(',') &&
      itemsOf(histPage2.json).map((day) => day.workDate).join(',') === daysAgo(5) &&
      histPage2.json.total === 3,
    { one: histPage1.json, two: histPage2.json },
  );

  const defaultRange = await admin.get(`/admin/hr/employees/${priyaId}/attendance`);
  check(
    'the default range is the current month',
    defaultRange.status === 200 && defaultRange.json.from === `${today.slice(0, 7)}-01` && defaultRange.json.to === today,
    { from: defaultRange.json.from, to: defaultRange.json.to },
  );

  const reversedRange = await admin.get(`/admin/hr/employees/${priyaId}/attendance?from=${today}&to=${daysAgo(5)}`);
  check('a reversed range is refused', reversedRange.status === 400, reversedRange.json);

  const month = d3.slice(0, 7);
  const calendar = await admin.get(`/admin/hr/employees/${priyaId}/calendar?month=${month}`);
  const monthDays = cal.eachDate(cal.monthBounds(month).start, cal.monthBounds(month).end).length;
  check(
    'an employee’s month calendar covers every date',
    calendar.status === 200 && calendar.json.month === month && Array.isArray(calendar.json.days) && calendar.json.days.length === monthDays,
    { month: calendar.json.month, length: calendar.json.days?.length },
  );
  check(
    'and classifies the corrected day',
    (calendar.json.days as Json[] | undefined)?.find((day) => day.date === d3)?.status === 'half_day',
    (calendar.json.days as Json[] | undefined)?.find((day) => day.date === d3),
  );

  const badMonth = await admin.get(`/admin/hr/employees/${priyaId}/calendar?month=2026-13`);
  check('an impossible month is refused', badMonth.status === 422, badMonth.status);
  const ghostCalendar = await admin.get('/admin/hr/employees/99999999/calendar');
  check('an unknown employee’s calendar is a 404', ghostCalendar.status === 404, ghostCalendar.status);

  /* The attendance view's days: the calendar month, with each day's record and punches beside it. */
  const monthView = await admin.get(`/admin/hr/employees/${priyaId}/attendance-days?month=${month}`);
  const viewDays = (monthView.json.days as Json[] | undefined) ?? [];
  const viewD3 = viewDays.find((day) => day.date === d3);
  check(
    'the attendance view covers every date of the month, classified like the calendar',
    monthView.status === 200 &&
      monthView.json.month === month &&
      viewDays.length === monthDays &&
      viewDays.every((day, index) => day.status === (calendar.json.days as Json[])[index]?.status),
    { status: monthView.status, length: viewDays.length },
  );
  check(
    'with the corrected day’s record and its session beside it',
    viewD3?.record?.workDate === d3 &&
      Array.isArray(viewD3?.record?.sessions) &&
      (viewD3.record.sessions as Json[]).length === 1 &&
      viewD3.record.sessions[0].source === 'admin',
    viewD3,
  );
  check(
    'and no record on a date nothing was punched',
    viewDays.every((day) => day.record === null || day.record.workDate === day.date) &&
      viewDays.some((day) => day.record === null),
    viewDays.filter((day) => day.record !== null).map((day) => day.date),
  );
  // Against the records in the same response, so the check holds whatever date it runs on.
  const records = viewDays.map((day) => day.record).filter(Boolean) as Json[];
  const closedSessions = records.reduce(
    (sum, record) => sum + (record.sessions as Json[]).filter((session) => session.endedAt !== null).length,
    0,
  );
  const attended = records.filter((record) => ['present', 'late', 'half_day'].includes(String(record.status))).length;
  check(
    'the month’s totals agree with the records',
    records.length >= 1 &&
      Number(monthView.json.summary?.totalSessions) === closedSessions &&
      Number(monthView.json.summary?.daysPresent) === attended,
    { summary: monthView.json.summary, closedSessions, attended },
  );
  check(
    'and name the shift they are on, for the timeline',
    monthView.json.shift === null ||
      (typeof monthView.json.shift?.startsAt === 'string' && typeof monthView.json.shift?.name === 'string'),
    monthView.json.shift,
  );
  const badViewMonth = await admin.get(`/admin/hr/employees/${priyaId}/attendance-days?month=2026-13`);
  check('the attendance view refuses an impossible month', badViewMonth.status === 422, badViewMonth.status);
  const ghostView = await admin.get('/admin/hr/employees/99999999/attendance-days');
  check('and an unknown employee is a 404', ghostView.status === 404, ghostView.status);
  const raviView = await ravi.get(`/admin/hr/employees/${priyaId}/attendance-days`);
  check('a telecaller cannot read the attendance view', raviView.status === 403, raviView.status);

  /* A week: what the table and punch views page through. */
  const weekFrom = daysAgo(6);
  const weekView = await admin.get(`/admin/hr/employees/${priyaId}/attendance-days?from=${weekFrom}&to=${today}`);
  const weekDays = (weekView.json.days as Json[] | undefined) ?? [];
  check(
    'the attendance view serves a week as a range of dates',
    weekView.status === 200 &&
      weekView.json.month === null &&
      weekView.json.from === weekFrom &&
      weekView.json.to === today &&
      weekDays.length === 7 &&
      weekDays[0]?.date === weekFrom &&
      weekDays[6]?.date === today,
    { status: weekView.status, from: weekView.json.from, to: weekView.json.to, length: weekDays.length },
  );
  check(
    'with the same verdicts as the month for the dates they share',
    weekDays
      .filter((day) => String(day.date).slice(0, 7) === month)
      .every((day) => viewDays.find((other) => other.date === day.date)?.status === day.status),
    weekDays.map((day) => `${day.date}:${day.status}`),
  );
  const halfRange = await admin.get(`/admin/hr/employees/${priyaId}/attendance-days?from=${weekFrom}`);
  check('a range needs both ends', halfRange.status === 422 && Boolean(halfRange.json.errors?.to), halfRange.json);
  const backwardsRange = await admin.get(`/admin/hr/employees/${priyaId}/attendance-days?from=${today}&to=${weekFrom}`);
  check('a reversed range is refused', backwardsRange.status === 422, backwardsRange.status);
  const longRange = await admin.get(
    `/admin/hr/employees/${priyaId}/attendance-days?from=${daysAgo(40)}&to=${today}`,
  );
  check('a range longer than 31 days is refused', longRange.status === 422, longRange.status);

  /* Each session carries where and how it was punched — what the day drawer shows. */
  const arunDay = await admin.get(`/admin/hr/employees/${arunId}/attendance-days?from=${today}&to=${today}`);
  const arunPunch = (arunDay.json.days as Json[] | undefined)?.[0]?.record?.sessions?.[0] as Json | undefined;
  check(
    'a session carries its punch evidence: flags, device time, coordinates and site',
    arunDay.status === 200 &&
      (arunDay.json.days as Json[])[0]?.record?.workMode === 'remote' &&
      Array.isArray(arunPunch?.inFlags) &&
      (arunPunch!.inFlags as string[]).includes('mock_location') &&
      typeof arunPunch?.inDeviceAt === 'string' &&
      'inLatitude' in (arunPunch ?? {}) &&
      'inAccuracyMetres' in (arunPunch ?? {}) &&
      'inLocationName' in (arunPunch ?? {}),
    arunPunch,
  );

  /* ------------------------------------------------------------ exceptions */

  const flaggedQueue = await admin.get(`/admin/hr/attendance/exceptions?type=flagged&reviewed=false&userId=${arunId}`);
  const flaggedItem = itemsOf(flaggedQueue.json)[0];
  check(
    'the exceptions queue shows the flagged punch',
    flaggedQueue.status === 200 && flaggedQueue.json.total === 1 && flaggedItem?.workDate === today && flaggedItem?.flagged === true,
    flaggedQueue.json,
  );
  check(
    'with the evidence: the session flags, device time and employee',
    Array.isArray(flaggedItem?.sessions?.[0]?.inFlags) &&
      (flaggedItem.sessions[0].inFlags as string[]).includes('mock_location') &&
      typeof flaggedItem.sessions[0].inDeviceAt === 'string' &&
      'inDistanceMetres' in flaggedItem.sessions[0] &&
      'inAccuracyMetres' in flaggedItem.sessions[0] &&
      flaggedItem.employeeName === 'Arun Nair' &&
      flaggedItem.employeeCode === codeAt(2),
    flaggedItem,
  );
  const flaggedId = Number(flaggedItem?.attendanceId);

  const wholeQueue = await admin.get('/admin/hr/attendance/exceptions?reviewed=false&pageSize=1');
  check(
    'the queue paginates',
    wholeQueue.status === 200 && itemsOf(wholeQueue.json).length === 1 && Number(wholeQueue.json.total) >= 2 && wholeQueue.json.pageSize === 1,
    wholeQueue.json,
  );

  const reviewed = await admin.post(`/admin/hr/attendance/exceptions/${flaggedId}/review`, { note: 'Checked with Arun: indoor GPS' });
  check(
    'an admin reviews the flagged day',
    reviewed.status === 200 && reviewed.json.exception?.reviewed === true && reviewed.json.exception?.review?.note === 'Checked with Arun: indoor GPS',
    reviewed.json,
  );

  const afterReview = await admin.get(`/admin/hr/attendance/exceptions?type=flagged&reviewed=false&userId=${arunId}`);
  check('and it leaves the unreviewed queue', afterReview.status === 200 && afterReview.json.total === 0, afterReview.json);
  const reviewedQueue = await admin.get(`/admin/hr/attendance/exceptions?type=flagged&reviewed=true&userId=${arunId}`);
  check(
    'and appears among the reviewed',
    reviewedQueue.json.total === 1 && itemsOf(reviewedQueue.json)[0]?.attendanceId === flaggedId,
    reviewedQueue.json,
  );

  const reviewAgain = await admin.post(`/admin/hr/attendance/exceptions/${flaggedId}/review`, {});
  check('reviewing it twice is refused', reviewAgain.status === 400, reviewAgain.json);
  check(
    'the review is audited',
    (await count(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hr_attendance_exception_reviewed' AND entity_type = 'hr_attendance' AND entity_id = ?",
      [flaggedId],
    )) === 1,
  );

  const missingQueue = await admin.get(`/admin/hr/attendance/exceptions?type=missing_punch&userId=${chitraId}`);
  check(
    'missing punches are listed too, with the auto-closed session',
    missingQueue.json.total === 1 &&
      itemsOf(missingQueue.json)[0]?.attendanceId === missedDayId &&
      itemsOf(missingQueue.json)[0]?.sessions?.[0]?.autoClosed === true,
    missingQueue.json,
  );

  const cleanReview = await admin.post(`/admin/hr/attendance/exceptions/${fixedDayId}/review`, {});
  check('a day with nothing to review is refused', cleanReview.status === 400, cleanReview.json);
  const ghostReview = await admin.post('/admin/hr/attendance/exceptions/99999999/review', {});
  check('an unknown day is a 404', ghostReview.status === 404, ghostReview.status);

  /* ------------------------------------------- the HR token is refused here */

  const refusals: Array<[string, string, unknown?]> = [
    ['GET', '/admin/hr/departments'],
    ['POST', '/admin/hr/departments', { name: 'Not Allowed Dept' }],
    ['PATCH', `/admin/hr/departments/${deptAId}`, { name: 'Not Allowed' }],
    ['GET', '/admin/hr/designations'],
    ['POST', '/admin/hr/designations', { name: 'Not Allowed Desig' }],
    ['PATCH', `/admin/hr/designations/${desAId}`, { name: 'Not Allowed' }],
    ['GET', '/admin/hr/employees'],
    ['GET', `/admin/hr/employees/${priyaId}`],
    ['POST', '/admin/hr/employees', { name: 'Self Made', email: 'ppl.hr.self@example.test', password: PASSWORD }],
    ['PATCH', `/admin/hr/employees/${priyaId}`, { role: 'hr_admin' }],
    ['GET', `/admin/hr/employees/${priyaId}/attendance`],
    ['GET', `/admin/hr/employees/${priyaId}/calendar`],
    ['GET', `/admin/hr/employees/${priyaId}/attendance-days`],
    ['GET', '/admin/hr/settings'],
    ['PATCH', '/admin/hr/settings', { defaultWeeklyOff: [] }],
    ['GET', `/admin/hr/attendance?status=absent&departmentId=${deptAId}`],
    ['PUT', `/admin/hr/attendance/${priyaId}/${d3}`, correction([{ startAt: '10:00', endAt: '18:00' }])],
    ['GET', '/admin/hr/attendance/exceptions'],
    ['POST', `/admin/hr/attendance/exceptions/${missedDayId}/review`, {}],
    ['PATCH', `/admin/hr/shifts/${dayShiftId}`, { weeklyOffDays: ['mon'] }],
  ];
  const leaked: string[] = [];
  for (const [method, path, body] of refusals) {
    const response = await priyaClient.call(method, path, body);
    if (response.status !== 401 && response.status !== 403) leaked.push(`${method} ${path} → ${response.status}`);
  }
  check('an HR token is refused on every new admin route', leaked.length === 0, leaked);
  check(
    'and the refused writes changed nothing',
    (await count("SELECT COUNT(*) AS n FROM hr_users WHERE id = ? AND role = 'hr_manager'", [priyaId])) === 1 &&
      (await count('SELECT COUNT(*) AS n FROM hr_users WHERE email = ?', ['ppl.hr.self@example.test'])) === 0,
  );

  const raviRead = await ravi.get('/admin/hr/employees');
  check('a telecaller cannot read the HR directory', raviRead.status === 403, raviRead.status);
  const raviSettings = await ravi.patch('/admin/hr/settings', { defaultWeeklyOff: [] });
  check('nor change HR settings', raviSettings.status === 403, raviSettings.status);

  /* ------------------------------------------------------------- tidy up */

  const arunOut = await arunClient.post('/hr/attendance/check-out', {});
  check('fixture: Arun checks out again', arunOut.status === 200, arunOut.json);
}
