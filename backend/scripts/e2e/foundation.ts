import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SqlParam } from '../../src/db/pool';
import type { E2EContext, Json } from './context';

/**
 * The shared foundation every feature builds on: the company clock, the new vocabulary
 * and phone fields, the error envelope, CORS, the PATCH null-wipe fix, conversion dates,
 * the company line, the row locks, who a new follow-up is assigned to, follow-ups linked
 * to the call they were booked on, and the schema the migrations created.
 *
 * Runs first among the section files. Every fixture here is its own: emails `fdn.*`,
 * lead numbers `+91 96660 900NN`, company numbers `+9196660901NN`. Pending follow-ups it
 * books are cancelled again at the end, so later sections start from no work of ours.
 */
/**
 * A JSON column's value. MySQL hands it over already parsed; MariaDB, where JSON is an
 * alias for LONGTEXT, hands over the text. A parsed string such as `08:00` is not JSON
 * text, so a value that does not parse is returned as it came.
 */
function jsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function run(ctx: E2EContext): Promise<void> {
  const { check, db, utcDb, adminAsBearer, adminId, raviId, miraId, base, makeClient } = ctx;

  /* ------------------------------------------------------------ the clock */
  console.log('\nfoundation — company time');

  const time = await import('../../src/modules/telecalling/companyTime');
  const { HttpError } = await import('../../src/utils/httpError');

  check(
    'the IST date of 23:59:59 IST is that day',
    time.companyDate(new Date('2026-10-05T18:29:59Z')) === '2026-10-05',
    time.companyDate(new Date('2026-10-05T18:29:59Z')),
  );
  check(
    'and 00:00 IST is already the next day, though UTC has not turned over',
    time.companyDate(new Date('2026-10-05T18:30:00Z')) === '2026-10-06',
    time.companyDate(new Date('2026-10-05T18:30:00Z')),
  );
  check(
    'an IST day starts at 18:30 UTC the evening before',
    time.companyDayStart('2026-10-06').toISOString() === '2026-10-05T18:30:00.000Z',
    time.companyDayStart('2026-10-06').toISOString(),
  );
  check(
    'and ends (exclusively) where the next one starts',
    time.companyDayEnd('2026-10-06').toISOString() === '2026-10-06T18:30:00.000Z',
    time.companyDayEnd('2026-10-06').toISOString(),
  );
  check(
    'an IST wall-clock time becomes the right instant',
    time.companyInstant('2026-10-06', '08:00').toISOString() === '2026-10-06T02:30:00.000Z',
    time.companyInstant('2026-10-06', '08:00').toISOString(),
  );
  check(
    'calendar arithmetic crosses month, leap-day and year ends',
    time.addDays('2026-02-28', 1) === '2026-03-01' &&
      time.addDays('2024-02-28', 1) === '2024-02-29' &&
      time.addDays('2026-01-01', -1) === '2025-12-31',
    [time.addDays('2026-02-28', 1), time.addDays('2024-02-28', 1), time.addDays('2026-01-01', -1)],
  );
  check(
    'an inclusive span counts both ends',
    time.daysInclusive('2026-10-01', '2026-10-31') === 31 &&
      time.daysInclusive('2026-10-06', '2026-10-06') === 1,
    [time.daysInclusive('2026-10-01', '2026-10-31'), time.daysInclusive('2026-10-06', '2026-10-06')],
  );

  let malformedRefused = false;
  try {
    time.companyDayStart('2026-02-30');
  } catch {
    malformedRefused = true;
  }
  check('an impossible calendar date is refused, not rolled over', malformedRefused);

  const rangeParams: SqlParam[] = [];
  const conditions = time.companyRangeConditions(
    'c.started_at',
    { from: '2026-10-01', to: '2026-10-06' },
    rangeParams,
  );
  check(
    'a date range becomes half-open instant bounds',
    conditions.join(' | ') === 'c.started_at >= ? | c.started_at < ?' &&
      (rangeParams[0] as Date | undefined)?.toISOString() === '2026-09-30T18:30:00.000Z' &&
      (rangeParams[1] as Date | undefined)?.toISOString() === '2026-10-06T18:30:00.000Z',
    { conditions, params: rangeParams },
  );

  const openParams: SqlParam[] = [];
  check(
    'an open range adds no clause and binds nothing',
    time.companyRangeClause('c.started_at', {}, openParams) === '' && openParams.length === 0,
    openParams,
  );

  const todayParams: SqlParam[] = [];
  const today = time.companyTodayCondition('f.due_at', todayParams, new Date('2026-10-05T19:00:00Z'));
  check(
    '"today" is the IST day around the given instant',
    today === '(f.due_at >= ? AND f.due_at < ?)' &&
      (todayParams[0] as Date | undefined)?.toISOString() === '2026-10-05T18:30:00.000Z' &&
      (todayParams[1] as Date | undefined)?.toISOString() === '2026-10-06T18:30:00.000Z',
    { today, params: todayParams },
  );

  const formatted = time.formatCompanyDateTime('2026-10-08T09:00:00Z');
  check(
    'timeline times are written on the IST clock',
    formatted.includes('08 Oct') && formatted.includes('02:30'),
    formatted,
  );

  check(
    'a column is read on the IST clock with a numeric offset (no timezone tables needed)',
    time.localSql('c.started_at') === "CONVERT_TZ(c.started_at, '+00:00', '+05:30')",
    time.localSql('c.started_at'),
  );

  /* --- chart frames --- */
  const days = time.bucketFrames('2026-10-01', '2026-10-06', 'day');
  check(
    'daily frames cover every day of the range, empty ones included',
    days.length === 6 && days[0]?.bucket === '2026-10-01' && days[5]?.bucket === '2026-10-06',
    days,
  );

  const hours = time.bucketFrames('2026-10-06', '2026-10-06', 'hour');
  check(
    'hourly frames are the 24 IST hours of the day',
    hours.length === 24 &&
      hours[0]?.bucket === '2026-10-06T00:00' &&
      hours[23]?.bucket === '2026-10-06T23:00',
    hours.map((frame) => frame.bucket),
  );

  const weeks = time.bucketFrames('2026-09-30', '2026-10-13', 'week');
  check(
    'weekly frames are keyed by Monday and clamped to the range',
    weeks.length === 3 &&
      weeks.every((frame) => new Date(`${frame.bucket}T00:00:00Z`).getUTCDay() === 1) &&
      weeks[0]?.bucket === '2026-09-28' &&
      weeks[0]?.from === '2026-09-30' &&
      weeks[0]?.to === '2026-10-04' &&
      weeks[2]?.to === '2026-10-13',
    weeks,
  );

  const months = time.bucketFrames('2026-01-15', '2026-03-10', 'month');
  check(
    'monthly frames are keyed by the first and clamped at both ends',
    months.length === 3 &&
      months[0]?.bucket === '2026-01-01' &&
      months[0]?.from === '2026-01-15' &&
      months[1]?.to === '2026-02-28' &&
      months[2]?.to === '2026-03-10',
    months,
  );

  check(
    'auto granularity: a day is hourly, a month daily, a quarter weekly, a long range monthly',
    time.resolveGranularity('auto', 1) === 'hour' &&
      time.resolveGranularity('auto', 45) === 'day' &&
      time.resolveGranularity('auto', 46) === 'week' &&
      time.resolveGranularity('auto', 270) === 'week' &&
      time.resolveGranularity('auto', 271) === 'month',
    [1, 45, 46, 270, 271].map((span) => time.resolveGranularity('auto', span)),
  );
  check(
    'an hourly request longer than two days falls back to daily',
    time.resolveGranularity('hour', 2) === 'hour' && time.resolveGranularity('hour', 3) === 'day',
    [time.resolveGranularity('hour', 2), time.resolveGranularity('hour', 3)],
  );
  check(
    'a request that would draw more than 400 frames is made coarser',
    time.resolveGranularity('day', 401) === 'week',
    time.resolveGranularity('day', 401),
  );

  let tooLong: unknown = null;
  try {
    time.resolveGranularity('auto', 12_000);
  } catch (error) {
    tooLong = error;
  }
  check(
    'a range too long even for monthly frames is refused with a 400',
    tooLong instanceof HttpError && tooLong.status === 400,
    tooLong instanceof Error ? tooLong.message : tooLong,
  );

  /* --- the same buckets, computed by MySQL --- */
  const [bucketRows] = (await utcDb.query(
    `SELECT ${time.bucketSql('t.at', 'hour')} AS h, ${time.bucketSql('t.at', 'day')} AS d,
            ${time.bucketSql('t.at', 'week')} AS w, ${time.bucketSql('t.at', 'month')} AS m
       FROM (SELECT CAST(? AS DATETIME) AS at UNION ALL SELECT CAST(? AS DATETIME)) t`,
    // 00:30 IST on Monday 5 Oct, then 23:59 IST on Sunday 4 Oct.
    ['2026-10-04 19:00:00', '2026-10-04 18:29:00'],
  )) as [Json[], unknown];
  check(
    'MySQL buckets a UTC instant into its IST hour, day, ISO week and month',
    bucketRows[0]?.h === '2026-10-05T00:00' &&
      bucketRows[0]?.d === '2026-10-05' &&
      bucketRows[0]?.w === '2026-10-05' &&
      bucketRows[0]?.m === '2026-10-01' &&
      bucketRows[1]?.d === '2026-10-04' &&
      bucketRows[1]?.w === '2026-09-28',
    bucketRows,
  );

  /* ------------------------------------------------------- vocabulary */
  console.log('\nfoundation — vocabulary and phone fields');

  const shared = await import('../../src/modules/telecalling/shared.schema');

  check(
    'the new activity types and the completed-today scope are in the vocabulary',
    (shared.ACTIVITY_TYPES as readonly string[]).includes('follow_up_moved') &&
      (shared.ACTIVITY_TYPES as readonly string[]).includes('follow_up_reassigned') &&
      (shared.FOLLOW_UP_SCOPES as readonly string[]).includes('completed_today'),
  );
  check(
    '"not answered" is one closed SQL list',
    shared.UNANSWERED_SQL_LIST === "'missed','rejected','busy','unreachable','no_answer'",
    shared.UNANSWERED_SQL_LIST,
  );

  const [lineRows] = (await utcDb.query(
    `SELECT ${shared.companyLineSql('x')} AS company
       FROM (SELECT 'outgoing' AS direction, NULL AS sim_match, 1 AS n
             UNION ALL SELECT 'incoming', NULL, 2
             UNION ALL SELECT 'incoming', 'confirmed', 3) x
      ORDER BY x.n`,
  )) as [Json[], unknown];
  check(
    'the company line is outgoing, or incoming verified on the company SIM — never unverified incoming',
    lineRows.map((row) => Number(row.company)).join(',') === '1,0,1',
    lineRows,
  );
  check(
    'and the predicate can be written for an unaliased calls table',
    shared.companyLineSql('') === "(direction = 'outgoing' OR sim_match IS NOT NULL)",
    shared.companyLineSql(''),
  );

  const keys = ['+91 98765 00002', '919876500002', '09876500002', '98765-00002'].map(
    shared.companyPhoneKey,
  );
  check(
    'a company number is matched on its ten digits however it is written',
    keys.every((key) => key === '9876500002'),
    keys,
  );
  const notMobile = ['5876500002', '98765', '+91 98765 000021', '0091 98765 00002'].map(
    shared.companyPhoneKey,
  );
  check(
    'a landline, a short number or a stray digit is not a SIM',
    notMobile.every((key) => key === null),
    notMobile,
  );

  const goodPhone = shared.companyPhoneField.safeParse('98765 00002');
  check(
    'a company number is stored canonical, +91 and ten digits',
    goodPhone.success && goodPhone.data === '+919876500002',
    goodPhone.success ? goodPhone.data : goodPhone.error.issues,
  );
  const badPhone = shared.companyPhoneField.safeParse('12345');
  const missingPhone = shared.companyPhoneField.safeParse(undefined);
  check(
    'and a wrong or missing one is refused in plain words',
    !badPhone.success &&
      badPhone.error.issues[0]?.message === 'Enter a 10-digit mobile number.' &&
      !missingPhone.success &&
      missingPhone.error.issues[0]?.message === 'Enter your company SIM number.',
    {
      bad: badPhone.success ? badPhone.data : badPhone.error.issues[0]?.message,
      missing: missingPhone.success ? missingPhone.data : missingPhone.error.issues[0]?.message,
    },
  );

  const cleared = ['', null].map((value) => shared.optionalCompanyPhoneField.safeParse(value));
  const optionalBad = shared.optionalCompanyPhoneField.safeParse('abc');
  check(
    'an optional company number clears on "" or null, and still refuses a bad one by name',
    cleared.every((result) => result.success && result.data === null) &&
      !optionalBad.success &&
      optionalBad.error.issues[0]?.message === 'Enter a 10-digit mobile number.',
    {
      cleared: cleared.map((result) => (result.success ? result.data : result.error.issues)),
      bad: optionalBad.success ? optionalBad.data : optionalBad.error.issues,
    },
  );

  /* ---------------------------------------------------- error envelope */
  console.log('\nfoundation — error envelope and CORS');

  /*
   * No route raises these yet, so the error handler is checked on a minimal app of its
   * own: a 409 must carry its details, and a lost lock race must read as "try again",
   * never as a 500.
   */
  const express = (await import('express')).default;
  const { asyncHandler, errorHandler } = await import('../../src/middleware/errorHandler');
  const { conflict } = await import('../../src/utils/httpError');

  const probe = express();
  probe.get(
    '/conflict',
    asyncHandler(async () => {
      throw conflict('Already taken.', 'duplicate_thing', { conflict: { id: 7 } });
    }),
  );
  for (const [pathname, errno, code] of [
    ['/deadlock', 1213, 'ER_LOCK_DEADLOCK'],
    ['/lock-wait', 1205, 'ER_LOCK_WAIT_TIMEOUT'],
    ['/api/mobile/deadlock', 1213, 'ER_LOCK_DEADLOCK'],
  ] as const) {
    probe.get(
      pathname,
      asyncHandler(async () => {
        throw Object.assign(new Error('driver error text that must not reach a client'), {
          errno,
          code,
        });
      }),
    );
  }
  probe.use(errorHandler);

  const probeServer = await new Promise<Server>((resolve) => {
    const listener = probe.listen(0, () => resolve(listener));
  });

  try {
    const probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;
    const probeClient = makeClient(probeBase);

    const clash = await probeClient.get('/conflict');
    check(
      'a conflict is a 409 with its code and details in the envelope',
      clash.status === 409 &&
        clash.json.success === false &&
        clash.json.code === 'duplicate_thing' &&
        clash.json.message === 'Already taken.' &&
        (clash.json.details as Json | undefined)?.conflict?.id === 7,
      clash.json,
    );

    for (const pathname of ['/deadlock', '/lock-wait']) {
      const lost = await probeClient.get(pathname);
      check(
        `a lost lock race (${pathname.slice(1)}) is a 409 try_again, not a 500`,
        lost.status === 409 &&
          lost.json.code === 'try_again' &&
          !JSON.stringify(lost.json).includes('driver error'),
        { status: lost.status, json: lost.json },
      );
    }

    /*
     * The phone's offline queue deletes anything refused with a 4xx (other than 401/429),
     * installed builds included, so a lock race on a mobile route must be a status it
     * retries: 503 with Retry-After, still with the try_again code.
     */
    const mobileLost = await fetch(`${probeBase}/api/mobile/deadlock`);
    const mobileLostJson = (await mobileLost.json()) as Json;
    check(
      'a lost lock race on a mobile route is a 503 try_again with Retry-After, which the app retries',
      mobileLost.status === 503 &&
        mobileLost.headers.get('retry-after') === '1' &&
        mobileLostJson.code === 'try_again' &&
        !JSON.stringify(mobileLostJson).includes('driver error'),
      { status: mobileLost.status, json: mobileLostJson },
    );
  } finally {
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));
  }

  /* --- CORS --- */
  const { config } = await import('../../src/config/env');
  const allowedOrigin = config.corsOrigins[0] ?? 'http://localhost:3000';
  const preflight = await makeClient(base).call('OPTIONS', '/admin/telecalling/settings', undefined, {
    Origin: allowedOrigin,
    'Access-Control-Request-Method': 'DELETE',
    'Access-Control-Request-Headers': 'content-type,x-csrf-token',
  });
  const allowed = (preflight.headers.get('access-control-allow-methods') ?? '').split(',');
  check(
    'a browser preflight from the admin origin is told PUT and DELETE are allowed',
    allowed.includes('PUT') && allowed.includes('DELETE'),
    { status: preflight.status, allowed },
  );

  /* ---------------------------------------------------- PATCH null-wipe */
  console.log('\nfoundation — partial updates leave absent fields alone');

  const wipeLead = await adminAsBearer.post('/admin/telecalling/leads', {
    customerName: 'Foundation Null Wipe',
    phone: '+91 96660 90003',
    alternatePhone: '+91 96660 90103',
    email: 'fdn.lead@example.test',
    address: '1 Test Street',
    city: 'Kochi',
    productInterest: 'Diagnostic lab setup',
    summaryNote: 'Everything here must survive a rename.',
    source: 'manual',
  });
  check('a fully filled lead is created', wipeLead.status === 201, wipeLead.json);
  const wipeLeadId = Number(wipeLead.json.lead?.id);

  const renamed = await adminAsBearer.patch(`/admin/telecalling/leads/${wipeLeadId}`, {
    customerName: 'Foundation Null Wipe Renamed',
  });
  const renamedLead = (renamed.json.lead ?? {}) as Json;
  check(
    'renaming a lead leaves every field the request did not mention',
    renamed.status === 200 &&
      renamedLead.customerName === 'Foundation Null Wipe Renamed' &&
      renamedLead.alternatePhone === '+91 96660 90103' &&
      renamedLead.email === 'fdn.lead@example.test' &&
      renamedLead.address === '1 Test Street' &&
      renamedLead.city === 'Kochi' &&
      renamedLead.productInterest === 'Diagnostic lab setup' &&
      renamedLead.summaryNote === 'Everything here must survive a rename.',
    renamed.json,
  );

  const clearedCity = await adminAsBearer.patch(`/admin/telecalling/leads/${wipeLeadId}`, {
    city: null,
    email: '',
  });
  check(
    'an explicit null or empty string still clears a field — and only that field',
    clearedCity.status === 200 &&
      clearedCity.json.lead?.city === null &&
      clearedCity.json.lead?.email === null &&
      clearedCity.json.lead?.address === '1 Test Street',
    clearedCity.json.lead,
  );

  const emptyPatch = await adminAsBearer.patch(`/admin/telecalling/leads/${wipeLeadId}`, {});
  check(
    'an empty update is refused rather than silently clearing fields',
    emptyPatch.status === 422,
    { status: emptyPatch.status, json: emptyPatch.json },
  );

  const patchee = await ctx.createSignedInEmployee({
    name: 'Foundation Patch',
    email: 'fdn.patch@example.test',
    role: 'telecaller',
  });
  const withPhone = await adminAsBearer.patch(`/admin/telecalling/employees/${patchee.id}`, {
    phone: '9666090200',
  });
  const promoted = await adminAsBearer.patch(`/admin/telecalling/employees/${patchee.id}`, {
    role: 'supervisor',
  });
  check(
    "changing an employee's role no longer erases their phone number",
    withPhone.status === 200 &&
      promoted.status === 200 &&
      promoted.json.employee?.role === 'supervisor' &&
      promoted.json.employee?.phone === '9666090200',
    { withPhone: withPhone.json.employee?.phone, promoted: promoted.json.employee },
  );
  const phoneCleared = await adminAsBearer.patch(`/admin/telecalling/employees/${patchee.id}`, {
    phone: null,
  });
  check(
    'and an explicit null still clears it',
    phoneCleared.status === 200 && phoneCleared.json.employee?.phone === null,
    phoneCleared.json.employee,
  );

  /* ------------------------------------------------------ conversions */
  const convertedLead = await adminAsBearer.post('/admin/telecalling/leads', {
    customerName: 'Foundation Converted',
    phone: '+91 96660 90005',
    source: 'manual',
    status: 'converted',
  });
  check(
    'a lead entered already converted gets a conversion date',
    convertedLead.status === 201 &&
      typeof convertedLead.json.lead?.convertedAt === 'string' &&
      Math.abs(Date.parse(String(convertedLead.json.lead?.convertedAt)) - Date.now()) < 120_000,
    convertedLead.json.lead,
  );
  check(
    'while a new one does not',
    wipeLead.json.lead?.convertedAt === null,
    wipeLead.json.lead?.convertedAt,
  );

  /* ---------------------------------------------------- company line */
  console.log('\nfoundation — company line and row locks');

  const raviProfile = await adminAsBearer.get(`/admin/telecalling/employees/${raviId}`);
  check(
    'an employee record carries the company number and SIM status',
    raviProfile.json.employee?.companyPhone === '+919876500002' &&
      raviProfile.json.employee?.companySim === null,
    raviProfile.json.employee,
  );

  const employees = await import('../../src/modules/telecalling/employees/employee.repository');

  const raviLine = await employees.findEmployeeCompanyLine(raviId);
  const adminLine = await employees.findEmployeeCompanyLine(adminId);
  const nobodyLine = await employees.findEmployeeCompanyLine(999_999);
  check(
    'the company line is read from the employee row',
    raviLine?.companyPhone === '+919876500002' &&
      raviLine?.companyPhoneKey === '9876500002' &&
      adminLine?.companyPhone === null &&
      adminLine?.companyPhoneKey === null &&
      nobodyLine === null,
    { raviLine, adminLine, nobodyLine },
  );

  const holder = await employees.companyPhoneHolder('9876500002');
  const notSelf = await employees.companyPhoneHolder('9876500002', raviId);
  const released = await employees.companyPhoneHolder('9876500003');
  check(
    "a live employee holds their number; it never clashes with their own row; a leaver's is free",
    holder?.id === raviId && holder?.employeeCode === 'TC-0002' && notSelf === null && released === null,
    { holder, notSelf, released },
  );

  const [claimRows] = (await utcDb.query(
    'SELECT company_phone_key, company_phone_claim FROM telecaller_users WHERE id = ?',
    [miraId],
  )) as [Json[], unknown];
  check(
    "deactivating an employee releases the number's claim but keeps the number on file",
    claimRows[0]?.company_phone_key === '9876500003' && claimRows[0]?.company_phone_claim === null,
    claimRows[0],
  );

  let duplicateRefused = false;
  try {
    await utcDb.query(
      `INSERT INTO telecaller_users
         (employee_code, name, email, password_hash, role, is_active, approval_status, company_phone)
       VALUES ('FX-DUPLICATE', 'Duplicate Claim', 'fdn.duplicate@example.test', 'x', 'telecaller', 1, 'approved', '+919876500002')`,
    );
    // Not expected — but if it landed, take it back out so it cannot skew anything later.
    await utcDb.query("DELETE FROM telecaller_users WHERE employee_code = 'FX-DUPLICATE'");
  } catch (error) {
    duplicateRefused = (error as { code?: string }).code === 'ER_DUP_ENTRY';
  }
  check('the database refuses a second live employee on the same company number', duplicateRefused);

  /* --- locks --- */
  const { withTransaction } = await import('../../src/db/pool');

  const locked = await withTransaction(async (connection) => ({
    ravi: await employees.lockAssignableEmployeeTx(connection, raviId),
    mira: await employees.lockAssignableEmployeeTx(connection, miraId),
    nobody: await employees.lockAssignableEmployeeTx(connection, 999_999),
    one: await employees.lockEmployeeForUpdateTx(connection, raviId),
    many: await employees.lockEmployeesForUpdateTx(connection, [miraId, adminId, raviId, miraId]),
  }));
  check(
    'a share-locked read says who can take work: an active employee can, a deactivated one cannot',
    locked.ravi?.assignable === true &&
      locked.mira?.assignable === false &&
      locked.mira?.isActive === false &&
      locked.nobody === null,
    locked,
  );
  check(
    'exclusive locks return the rows in ascending id order, each once',
    locked.one?.employeeCode === 'TC-0002' &&
      locked.many.map((row) => row.id).join(',') ===
        [adminId, raviId, miraId].sort((a, b) => a - b).join(','),
    locked.many,
  );

  /* ------------------------------------------- who owes a new follow-up */
  console.log('\nfoundation — who a new follow-up is assigned to');

  const caller = await ctx.createSignedInEmployee({
    name: 'Foundation Caller',
    email: 'fdn.caller@example.test',
    role: 'telecaller',
    companyPhone: '+919666090101',
  });
  const leaver = await ctx.createSignedInEmployee({
    name: 'Foundation Leaver',
    email: 'fdn.leaver@example.test',
    role: 'telecaller',
    companyPhone: '+919666090102',
  });
  const cover = await ctx.createSignedInEmployee({
    name: 'Foundation Cover',
    email: 'fdn.cover@example.test',
    role: 'telecaller',
    companyPhone: '+919666090103',
  });

  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  const callerLead = await caller.client.post('/mobile/leads', {
    customerName: 'Foundation Lead',
    phone: '+91 96660 90001',
    source: 'manual',
  });
  const leadId = Number(callerLead.json.lead?.id);
  const leaverLead = await leaver.client.post('/mobile/leads', {
    customerName: 'Foundation Orphan',
    phone: '+91 96660 90002',
    source: 'manual',
  });
  const orphanLeadId = Number(leaverLead.json.lead?.id);
  check(
    'each telecaller creates a lead of their own',
    callerLead.status === 201 && leaverLead.status === 201,
    { caller: callerLead.json, leaver: leaverLead.json },
  );

  const own = await caller.client.post('/mobile/follow-ups', {
    leadId,
    dueAt: inDays(1),
    note: 'Foundation: booked by the telecaller.',
  });
  check(
    'a telecaller books a follow-up for themselves',
    own.status === 201 && own.json.followUp?.assignedTo === caller.id,
    own.json,
  );
  check(
    "and it carries the lead's owner and no call",
    own.json.followUp?.leadAssignedTo === caller.id &&
      own.json.followUp?.leadAssignedToName === 'Foundation Caller' &&
      own.json.followUp?.callId === null,
    own.json.followUp,
  );

  const ignoredChoice = await caller.client.post('/mobile/follow-ups', {
    leadId,
    dueAt: inDays(1.5),
    assignedTo: cover.id,
  });
  check(
    'a telecaller cannot hand a follow-up to someone else',
    ignoredChoice.status === 201 && ignoredChoice.json.followUp?.assignedTo === caller.id,
    ignoredChoice.json.followUp,
  );

  const toOwner = await adminAsBearer.post('/admin/telecalling/follow-ups', {
    leadId,
    dueAt: inDays(2),
  });
  check(
    "an admin's follow-up with no assignee goes to the lead's owner",
    toOwner.status === 201 && toOwner.json.followUp?.assignedTo === caller.id,
    toOwner.json,
  );

  const chosen = await adminAsBearer.post('/admin/telecalling/follow-ups', {
    leadId,
    dueAt: inDays(2.5),
    assignedTo: cover.id,
  });
  check(
    "an admin's explicit choice is honoured",
    chosen.status === 201 && chosen.json.followUp?.assignedTo === cover.id,
    chosen.json,
  );

  const toLeaver = await adminAsBearer.post('/admin/telecalling/follow-ups', {
    leadId,
    dueAt: inDays(3),
    assignedTo: miraId,
  });
  check(
    'an explicit deactivated assignee is refused with the long-standing 400',
    toLeaver.status === 400 && toLeaver.json.message === 'That employee is deactivated.',
    toLeaver.json,
  );

  const toNobody = await adminAsBearer.post('/admin/telecalling/follow-ups', {
    leadId,
    dueAt: inDays(3),
    assignedTo: 999_999,
  });
  check(
    'and so is one that does not exist',
    toNobody.status === 400 && toNobody.json.message === 'The chosen employee does not exist.',
    toNobody.json,
  );

  // The leaver goes, holding no follow-ups yet — their access token stays valid.
  await utcDb.execute('UPDATE telecaller_users SET is_active = 0 WHERE id = ?', [leaver.id]);

  const fallback = await adminAsBearer.post('/admin/telecalling/follow-ups', {
    leadId: orphanLeadId,
    dueAt: inDays(2),
  });
  check(
    "when the lead's owner has left, an admin's follow-up falls to the admin, not the leaver",
    fallback.status === 201 && fallback.json.followUp?.assignedTo === adminId,
    fallback.json,
  );

  const lateWrite = await leaver.client.post('/mobile/follow-ups', {
    leadId: orphanLeadId,
    dueAt: inDays(2),
    note: 'Foundation: written after the account was switched off.',
  });
  check(
    'a deactivated telecaller still inside their token window books it unassigned — kept, not refused',
    lateWrite.status === 201 && lateWrite.json.followUp?.assignedTo === null,
    lateWrite.json,
  );

  const orphanView = await adminAsBearer.get(`/admin/telecalling/leads/${orphanLeadId}`);
  check(
    'and the timeline says nobody is assigned to it yet',
    ((orphanView.json.timeline?.items as Json[] | undefined) ?? []).some(
      (row) =>
        row.type === 'follow_up_created' && String(row.summary).includes('not assigned to anyone yet'),
    ),
    ((orphanView.json.timeline?.items as Json[] | undefined) ?? []).map((row) => row.summary),
  );

  const [strandedRows] = (await utcDb.query(
    `SELECT COUNT(*) AS stranded
       FROM follow_ups f
       JOIN telecaller_users u ON u.id = f.assigned_to
      WHERE u.is_active = 0 AND f.state = 'pending'`,
  )) as [Json[], unknown];
  check(
    'no pending follow-up is assigned to a deactivated employee',
    Number(strandedRows[0]?.stranded) === 0,
    strandedRows[0],
  );

  /* -------------------------------------- follow-ups booked on a call */
  console.log('\nfoundation — follow-ups linked to their call');

  const loggedCall = await caller.client.post('/mobile/calls', {
    leadId,
    phone: '+91 96660 90001',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'manual',
    durationSeconds: 42,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    followUpAt: inDays(4),
    followUpNote: 'Foundation: booked with the call.',
    clientUuid: randomUUID(),
  });
  const loggedCallId = Number(loggedCall.json.call?.id);
  const loggedFollowUpId = Number(loggedCall.json.followUpId);
  check(
    'a call logged with a follow-up books it',
    loggedCall.status === 201 && Number.isInteger(loggedFollowUpId) && loggedFollowUpId > 0,
    loggedCall.json,
  );

  const followUps = await import('../../src/modules/telecalling/followups/followUp.repository');

  const forCall = await followUps.findFollowUpForCall(loggedCallId, leadId);
  check(
    'and the follow-up records the call it was booked on',
    forCall?.id === loggedFollowUpId && forCall?.callId === loggedCallId && forCall?.assignedTo === caller.id,
    forCall,
  );

  const callerLeadView = await caller.client.get(`/mobile/leads/${leadId}`);
  check(
    "the lead's timeline entry for it names the call too",
    ((callerLeadView.json.timeline as Json[] | undefined) ?? []).some(
      (row) =>
        row.type === 'follow_up_created' &&
        Number((row.meta as Json | null)?.followUpId) === loggedFollowUpId &&
        Number((row.meta as Json | null)?.callId) === loggedCallId,
    ),
    ((callerLeadView.json.timeline as Json[] | undefined) ?? []).filter(
      (row) => row.type === 'follow_up_created',
    ),
  );

  const byCall = await followUps.listCallFollowUps(leadId, [loggedCallId, 999_999]);
  const noCalls = await followUps.listCallFollowUps(leadId, []);
  check(
    "a page of a lead's calls gets its follow-ups in one read, keyed by call",
    byCall.size === 1 && byCall.get(loggedCallId)?.[0]?.id === loggedFollowUpId && noCalls.size === 0,
    { keys: [...byCall.keys()], first: byCall.get(loggedCallId)?.[0]?.id },
  );

  const pendingForCall = await withTransaction((connection) =>
    followUps.findPendingFollowUpForCallTx(connection, loggedCallId, leadId),
  );
  check(
    "the call's pending follow-up can be locked for a re-save to move",
    pendingForCall?.id === loggedFollowUpId &&
      pendingForCall?.leadId === leadId &&
      Math.abs(Date.parse(pendingForCall?.dueAt ?? '') - Date.parse(inDays(4))) < 120_000,
    pendingForCall,
  );

  const plainCall = await caller.client.post('/mobile/calls', {
    leadId,
    phone: '+91 96660 90001',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'manual',
    durationSeconds: 15,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    clientUuid: randomUUID(),
  });
  const writeUp = await caller.client.post(`/mobile/calls/${Number(plainCall.json.call?.id)}/record`, {
    note: 'Foundation: written up afterwards.',
    followUpAt: inDays(5),
  });
  const writeUpFollowUp = await followUps.findFollowUpForCall(Number(plainCall.json.call?.id), leadId);
  check(
    'a follow-up booked while writing a call up is linked to that call',
    writeUp.status === 200 &&
      typeof writeUp.json.followUpId === 'number' &&
      writeUpFollowUp?.id === writeUp.json.followUpId &&
      writeUpFollowUp?.assignedTo === caller.id,
    { writeUp: writeUp.json, linked: writeUpFollowUp },
  );

  const statusChange = await adminAsBearer.post(`/admin/telecalling/leads/${leadId}/status`, {
    status: 'follow_up',
    followUpAt: inDays(6),
  });
  const statusFollowUp = statusChange.json.followUpId as number | undefined;
  const statusFollowUps = await adminAsBearer.get(
    `/admin/telecalling/follow-ups?leadId=${leadId}&scope=pending&pageSize=100`,
  );
  check(
    "a follow-up booked with a status change goes to the lead's owner",
    statusChange.status === 200 &&
      ((statusFollowUps.json.items as Json[] | undefined) ?? []).some(
        (row) => row.id === statusFollowUp && row.assignedTo === caller.id,
      ),
    { statusChange: statusChange.json, items: statusFollowUps.json.items },
  );

  /* --- completed today --- */
  const done = await caller.client.post(`/mobile/follow-ups/${Number(own.json.followUp?.id)}/complete`, {});
  const completedToday = await adminAsBearer.get(
    `/admin/telecalling/follow-ups?leadId=${leadId}&scope=completed_today`,
  );
  const completedTodayIds = ((completedToday.json.items as Json[] | undefined) ?? []).map(
    (row) => row.id,
  );
  check(
    'a follow-up completed now is in the completed-today list, and nothing pending is',
    done.status === 200 &&
      completedToday.status === 200 &&
      completedTodayIds.includes(own.json.followUp?.id) &&
      ((completedToday.json.items as Json[] | undefined) ?? []).every((row) => row.state === 'completed'),
    { done: done.status, items: completedToday.json.items },
  );

  /* --- a reassigned lead takes its pending follow-ups along --- */
  const reassigned = await adminAsBearer.post(`/admin/telecalling/leads/${leadId}/assign`, {
    assignedTo: cover.id,
    reason: 'Foundation: covering.',
  });
  const movedFollowUps = await adminAsBearer.get(
    `/admin/telecalling/follow-ups?leadId=${leadId}&scope=pending&pageSize=100`,
  );
  const movedItems = (movedFollowUps.json.items as Json[] | undefined) ?? [];
  /*
   * Six were pending on the lead by now: the telecaller's second booking, the admin's two
   * (one to the owner, one to the cover), and the ones booked with the logged call, the
   * write-up and the status change. The first booking was completed above.
   */
  check(
    'reassigning a lead moves every one of its pending follow-ups to the new owner',
    reassigned.status === 200 &&
      reassigned.json.lead?.assignedTo === cover.id &&
      movedItems.length === 6 &&
      movedItems.every((row) => row.assignedTo === cover.id && row.leadAssignedTo === cover.id),
    movedItems.map((row) => ({ id: row.id, assignedTo: row.assignedTo })),
  );

  const reassignedView = await adminAsBearer.get(`/admin/telecalling/leads/${leadId}`);
  check(
    'and the timeline names who it came from',
    ((reassignedView.json.timeline?.items as Json[] | undefined) ?? []).some(
      (row) => row.type === 'lead_reassigned' && String(row.summary).includes('from Foundation Caller'),
    ),
    ((reassignedView.json.timeline?.items as Json[] | undefined) ?? []).map((row) => row.summary),
  );

  /* ------------------------------------------- creating a lead from an import */
  console.log('\nfoundation — createLead options');

  const leadSchema = await import('../../src/modules/telecalling/leads/lead.schema');
  const leadService = await import('../../src/modules/telecalling/leads/lead.service');

  const importActor = {
    id: adminId,
    name: 'Asha Admin',
    email: 'admin@example.test',
    role: 'admin' as const,
    via: 'bearer' as const,
  };
  const imported = await leadService.createLead(
    leadSchema.createLeadSchema.parse({
      customerName: 'Foundation Imported',
      phone: '+91 96660 90004',
      source: 'manual',
      assignedTo: cover.id,
      clientUuid: randomUUID(),
    }),
    importActor,
    null,
    { origin: { kind: 'import', importId: 4242, sheetRow: 7 }, notifyAssignee: false, audit: false },
  );
  const importedId = imported.lead.id;

  const [importTrace] = (await utcDb.query(
    `SELECT
       (SELECT summary FROM lead_activities WHERE lead_id = ? AND type = 'lead_created' LIMIT 1) AS summary,
       (SELECT meta FROM lead_activities WHERE lead_id = ? AND type = 'lead_created' LIMIT 1) AS meta,
       (SELECT body FROM lead_notes WHERE lead_id = ? AND kind = 'system' LIMIT 1) AS note,
       (SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'lead' AND entity_id = ?) AS audits,
       (SELECT COUNT(*) FROM notifications WHERE lead_id = ?) AS notices`,
    [importedId, importedId, importedId, importedId, importedId],
  )) as [Json[], unknown];
  const trace = importTrace[0] ?? {};
  const traceMeta = jsonColumn(trace.meta) as Json | null;
  check(
    'an imported lead says it came from a spreadsheet, and its row, in words a telecaller reads',
    imported.lead.assignedTo === cover.id &&
      String(trace.summary).includes('added this lead from a spreadsheet') &&
      trace.note === 'Added from a spreadsheet by Asha Admin (row 7).',
    trace,
  );
  check(
    'and carries the import and sheet row for the trace back',
    Number(traceMeta?.importId) === 4242 && Number(traceMeta?.sheetRow) === 7,
    traceMeta,
  );
  check(
    'an import can leave the per-lead audit row and assignment notice to its own summary',
    Number(trace.audits) === 0 && Number(trace.notices) === 0,
    { audits: trace.audits, notices: trace.notices },
  );

  /* ------------------------------------------------ revoke in a transaction */
  console.log('\nfoundation — revoking sessions inside a transaction');

  const auth = await import('../../src/modules/telecalling/auth/mobileAuth.service');
  const sessionHolder = await ctx.createSignedInEmployee({
    name: 'Foundation Sessions',
    email: 'fdn.sessions@example.test',
    role: 'telecaller',
  });

  let rolledBack = false;
  try {
    await withTransaction(async (connection) => {
      await auth.revokeAllMobileSessionsTx(connection, sessionHolder.id);
      throw new Error('roll this back');
    });
  } catch {
    rolledBack = true;
  }
  const survived = await makeClient(base).post('/mobile/auth/refresh', {
    refreshToken: sessionHolder.refreshToken,
  });
  check(
    'a revocation inside a transaction that rolls back revokes nothing',
    rolledBack && survived.status === 200,
    survived.status,
  );

  const revoked = await withTransaction((connection) =>
    auth.revokeAllMobileSessionsTx(connection, sessionHolder.id),
  );
  const afterRevoke = await makeClient(base).post('/mobile/auth/refresh', {
    refreshToken: survived.json.refreshToken,
  });
  check(
    'one that commits revokes every live session',
    revoked >= 1 && afterRevoke.status === 401,
    { revoked, status: afterRevoke.status },
  );

  /* ------------------------------------------------------- the schema */
  console.log('\nfoundation — migrations 020 to 026');

  const [tableRows] = (await utcDb.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('follow_up_moves', 'report_runs', 'lead_imports', 'lead_import_rows')`,
  )) as [Json[], unknown];
  check(
    'the new tables exist',
    tableRows.length === 4,
    tableRows.map((row) => row.name),
  );

  const expectedIndexes = [
    'idx_lead_notes_call',
    'idx_follow_ups_call',
    'uq_calls_record_client_uuid',
    'idx_calls_user_direction_started',
    'uq_telecaller_users_company_phone',
    'idx_calls_direction_started',
    'idx_calls_started_cover',
    'idx_follow_ups_due',
    'idx_follow_ups_state_completed',
    'idx_follow_ups_created',
    'idx_leads_status_converted',
  ];
  const [indexRows] = (await utcDb.query(
    `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN (${expectedIndexes.map(() => '?').join(', ')})`,
    expectedIndexes,
  )) as [Json[], unknown];
  const presentIndexes = new Set(indexRows.map((row) => String(row.name)));
  check(
    'every new index exists',
    expectedIndexes.every((name) => presentIndexes.has(name)),
    expectedIndexes.filter((name) => !presentIndexes.has(name)),
  );

  const [ruleRows] = (await utcDb.query(
    `SELECT CONSTRAINT_NAME AS name, DELETE_RULE AS rule
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND CONSTRAINT_NAME IN ('fk_follow_ups_call', 'fk_follow_up_moves_follow_up', 'fk_lead_import_rows_lead')`,
  )) as [Json[], unknown];
  const rules = Object.fromEntries(ruleRows.map((row) => [String(row.name), String(row.rule)]));
  check(
    'losing a call keeps its follow-up, and move history goes with its follow-up',
    rules.fk_follow_ups_call === 'SET NULL' &&
      rules.fk_follow_up_moves_follow_up === 'CASCADE' &&
      rules.fk_lead_import_rows_lead === 'SET NULL',
    rules,
  );

  const [settingRows] = (await utcDb.query(
    "SELECT setting_key AS k, setting_value AS v FROM system_settings WHERE setting_key LIKE 'report.%'",
  )) as [Json[], unknown];
  const settings = Object.fromEntries(settingRows.map((row) => [String(row.k), jsonColumn(row.v)]));
  check(
    'the daily email is on at 08:00 by default',
    settings['report.daily_email_enabled'] === true && settings['report.daily_email_time'] === '08:00',
    settings,
  );

  /*
   * One scheduled run per report and date, any number of manual ones. Written with a
   * report type nothing else uses, and removed again, so the report section starts clean.
   */
  const runInsert = `INSERT INTO report_runs
       (report_type, report_date, trigger_kind, claim_token, claimed_at, lease_expires_at)
     VALUES ('foundation_check', '2026-10-05', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`;
  let secondScheduledRefused = false;
  try {
    await utcDb.execute(runInsert, ['scheduled', randomUUID()]);
    await utcDb.execute(runInsert, ['manual', randomUUID()]);
    await utcDb.execute(runInsert, ['manual', randomUUID()]);
    try {
      await utcDb.execute(runInsert, ['scheduled', randomUUID()]);
    } catch (error) {
      secondScheduledRefused = (error as { code?: string }).code === 'ER_DUP_ENTRY';
    }
  } finally {
    await utcDb.execute("DELETE FROM report_runs WHERE report_type = 'foundation_check'");
  }
  check(
    'the database allows one scheduled report run per date and any number of manual ones',
    secondScheduledRefused,
  );

  /* ------------------------------------------------------------ tidy up */
  /*
   * Cancel every follow-up this section left pending, through the API so the lead caches
   * are refreshed the normal way. Later sections then start with none of ours in their
   * queues — including the unassigned one.
   */
  const leftovers = (
    (await db.query(
      "SELECT id FROM follow_ups WHERE lead_id IN (?, ?, ?, ?) AND state = 'pending'",
      [leadId, orphanLeadId, wipeLeadId, importedId],
    )) as [Json[], unknown]
  )[0];
  let cancelled = 0;
  for (const row of leftovers) {
    const result = await adminAsBearer.post(`/admin/telecalling/follow-ups/${Number(row.id)}/cancel`);
    if (result.json.followUp?.state === 'cancelled') cancelled += 1;
  }
  check(
    "the section's pending follow-ups are cancelled again",
    cancelled === leftovers.length,
    { cancelled, pending: leftovers.length },
  );
}
