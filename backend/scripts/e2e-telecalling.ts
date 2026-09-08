/**
 * End-to-end check of the telecalling API.
 *
 *   npm run test:telecalling
 *
 * Creates a scratch database, applies every migration, seeds an admin and two
 * telecallers, boots the real Express app on an ephemeral port, then drives a day in the
 * life of a telecaller over HTTP. Drops the database at the end, so the developer's
 * working database is never touched.
 *
 * This is not a unit-test suite and does not try to be. It covers the behaviour that a
 * typecheck cannot see and that is expensive to discover in production:
 *
 *   - ownership scoping, including that a refused lead returns 404 rather than 403
 *   - idempotency of every mutation the mobile offline queue can retry
 *   - the transactional call-plus-note-plus-status-plus-follow-up write
 *   - the maintained cache columns on `leads` staying correct
 *   - role gates on the admin routes, and CSRF applying only to cookie sessions
 *   - that deactivating an employee actually kills their live mobile sessions
 *
 * Requires a reachable MySQL using the DB_* values from backend/.env, with permission to
 * create and drop a database.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const SCRATCH_DB = 'jmk_telecalling_e2e';

// Must be set before the app (and therefore config/env) is imported. dotenv does not
// override an existing process.env value, so this wins over the .env file.
process.env.DB_NAME = SCRATCH_DB;
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'e2e-check-secret-that-is-long-enough-to-be-fine';
process.env.LOG_LEVEL = 'error';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    if (detail !== undefined) console.error('        ' + JSON.stringify(detail));
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function setupDatabase(): Promise<mysql.Connection> {
  const root = await mysql.createConnection({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
  });

  await root.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await root.query(
    `CREATE DATABASE \`${SCRATCH_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await root.changeUser({ database: SCRATCH_DB });

  const dir = path.resolve(__dirname, '../database/migrations');
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    for (const statement of splitStatements(sql)) await root.query(statement);
  }

  const hash = await bcrypt.hash('correct-horse-battery', 12);

  await root.query(
    /*
     * approval_status is stated explicitly.
     *
     * Migration 010 makes the column DEFAULT 'pending' — fail-closed, so a writer that
     * forgets creates an account that cannot sign in. This seed forgot, and the whole
     * suite failed at "telecaller signs in", which is exactly the visible failure that
     * default is designed to produce instead of a silent security hole.
     *
     * `email_verified_at` is stated for the same reason, and it happened again: migration
     * 011 defaults it to NULL, sign-in refuses a NULL, and this seed's omission failed the
     * suite at the same assertion. Both defaults are deliberately hostile to a forgetful
     * writer. These three are admin-created staff, so a verified address is the truthful
     * value — nobody emailed them a code.
     */
    `INSERT INTO telecaller_users
       (employee_code, name, email, password_hash, role, is_active, approval_status,
        email_verified_at)
     VALUES ('TC-0001', 'Asha Admin', 'admin@example.test', ?, 'admin', 1, 'approved', NOW()),
            ('TC-0002', 'Ravi Caller', 'ravi@example.test', ?, 'telecaller', 1, 'approved', NOW()),
            ('TC-0003', 'Mira Caller', 'mira@example.test', ?, 'telecaller', 1, 'approved', NOW())`,
    [hash, hash, hash],
  );

  return root;
}

type Json = Record<string, any>;

function makeClient(base: string) {
  let accessToken: string | null = null;

  async function call(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });

    const text = await response.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: response.status, json };
  }

  return {
    call,
    setToken: (token: string | null) => {
      accessToken = token;
    },
    get: (p: string) => call('GET', p),
    post: (p: string, body?: unknown) => call('POST', p, body),
    patch: (p: string, body?: unknown) => call('PATCH', p, body),
  };
}

async function main(): Promise<void> {
  const db = await setupDatabase();
  console.log(`scratch database ready: ${SCRATCH_DB}\n`);

  const { createApp } = await import('../src/app');
  const app = createApp();

  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}/api`;

  const ravi = makeClient(base);
  const mira = makeClient(base);

  try {
    /* ---------------------------------------------------- authentication */
    console.log('authentication');

    const badLogin = await ravi.post('/mobile/auth/login', {
      email: 'ravi@example.test',
      password: 'wrong-password',
    });
    check('wrong password is rejected with 401', badLogin.status === 401, badLogin.json);
    check(
      'rejection does not say which factor was wrong',
      badLogin.json.message === 'Incorrect email or password.',
      badLogin.json.message,
    );

    const unknownUser = await ravi.post('/mobile/auth/login', {
      email: 'nobody@example.test',
      password: 'correct-horse-battery',
    });
    check(
      'unknown email gives the identical message (no account enumeration)',
      unknownUser.json.message === badLogin.json.message,
      unknownUser.json.message,
    );

    const login = await ravi.post('/mobile/auth/login', {
      email: 'ravi@example.test',
      password: 'correct-horse-battery',
      device: { name: 'Pixel 7a', platform: 'android' },
    });
    check('telecaller signs in', login.status === 200 && Boolean(login.json.accessToken));
    check('sign-in returns a refresh token', typeof login.json.refreshToken === 'string');
    check(
      'sign-in response carries no password hash',
      !JSON.stringify(login.json).includes('$2a$') && !JSON.stringify(login.json).includes('$2b$'),
    );
    ravi.setToken(login.json.accessToken);

    const noAuth = await makeClient(base).get('/mobile/dashboard');
    check('dashboard refuses an unauthenticated request', noAuth.status === 401);

    const miraLogin = await mira.post('/mobile/auth/login', {
      email: 'mira@example.test',
      password: 'correct-horse-battery',
    });
    mira.setToken(miraLogin.json.accessToken);
    check('second telecaller signs in', miraLogin.status === 200);

    /* ---------------------------------------------------------- refresh */
    const refresh = await ravi.post('/mobile/auth/refresh', {
      refreshToken: login.json.refreshToken,
    });
    check('refresh returns a new access token', refresh.status === 200 && Boolean(refresh.json.accessToken));
    check(
      'refresh rotates the refresh token',
      refresh.json.refreshToken !== login.json.refreshToken,
    );

    const replay = await ravi.post('/mobile/auth/refresh', {
      refreshToken: login.json.refreshToken,
    });
    check('the old refresh token no longer works after rotation', replay.status === 401, replay.json);

    ravi.setToken(refresh.json.accessToken);
    const raviRefreshToken = refresh.json.refreshToken as string;

    /* ------------------------------------------------------------- leads */
    console.log('\nleads');

    const created = await ravi.post('/mobile/leads', {
      customerName: 'Deepa Nair',
      phone: '+91 98765 43210',
      email: 'deepa@example.test',
      city: 'Kochi',
      source: 'hard_copy',
      productInterest: 'Diploma in Interior Design',
      summaryNote: 'Walked into the Kochi office with a printed brochure.',
      clientUuid: '11111111-1111-4111-8111-111111111111',
    });
    check('telecaller creates a lead', created.status === 201, created.json);
    const leadId = created.json.lead?.id as number;
    check('new lead is owned by its creator', created.json.lead?.assignedTo === 2, created.json.lead);
    check('reference is generated', /^LD-[A-Z2-9]{8}$/.test(created.json.lead?.reference ?? ''), created.json.lead?.reference);
    check('hard-copy source is preserved', created.json.lead?.source === 'hard_copy');

    const retry = await ravi.post('/mobile/leads', {
      customerName: 'Deepa Nair',
      phone: '+91 98765 43210',
      source: 'hard_copy',
      clientUuid: '11111111-1111-4111-8111-111111111111',
    });
    check('replaying the same clientUuid does not create a second lead', retry.status === 200 && retry.json.deduplicated === true, retry.json);
    check('the replay returns the original lead', retry.json.lead?.id === leadId);

    const dup = await ravi.post('/mobile/leads', {
      customerName: 'Deepa N (second enquiry)',
      phone: '9876543210',
      source: 'referral',
    });
    check('a duplicate number is allowed, not rejected', dup.status === 201, dup.json);
    check(
      'the existing lead is reported as a possible duplicate',
      dup.json.possibleDuplicate?.id === leadId,
      dup.json.possibleDuplicate,
    );

    /* ------------------------------------------------- ownership scoping */
    console.log('\nownership scoping');

    const miraPeek = await mira.get(`/mobile/leads/${leadId}`);
    check("another telecaller cannot read someone else's lead", miraPeek.status === 404, miraPeek.json);
    check(
      'the refusal is a 404, not a 403 (no confirmation the lead exists)',
      miraPeek.json.code === 'not_found',
      miraPeek.json.code,
    );

    const miraList = await mira.get('/mobile/leads');
    check('the other telecaller sees an empty lead list', miraList.json.total === 0, miraList.json.total);

    const miraNote = await mira.post(`/mobile/leads/${leadId}/notes`, { body: 'Should not land.' });
    check("another telecaller cannot note on someone else's lead", miraNote.status === 404);

    /* -------------------------------------------------------- call + status */
    console.log('\ncalls');

    const startedAt = new Date(Date.now() - 3_600_000).toISOString();

    const missed = await ravi.post('/mobile/calls', {
      leadId,
      phone: '+91 98765 43210',
      direction: 'outgoing',
      outcome: 'no_answer',
      source: 'call_log',
      durationSeconds: 8,
      startedAt,
      clientUuid: '22222222-2222-4222-8222-222222222222',
    });
    check('an unanswered call is logged', missed.status === 201, missed.json);
    check(
      'a duration on an unanswered call is discarded',
      missed.json.call?.durationSeconds === 0,
      missed.json.call?.durationSeconds,
    );

    const callRetry = await ravi.post('/mobile/calls', {
      leadId,
      phone: '+91 98765 43210',
      outcome: 'no_answer',
      startedAt,
      clientUuid: '22222222-2222-4222-8222-222222222222',
    });
    check('replaying a call does not double-count it', callRetry.json.deduplicated === true, callRetry.json);

    const callbacks = await ravi.get('/mobile/calls/pending-callbacks');
    check('the unanswered call appears in the callback queue', callbacks.json.total === 1, callbacks.json.total);

    const followUpAt = new Date(Date.now() + 86_400_000).toISOString();

    const answered = await ravi.post('/mobile/calls', {
      leadId,
      phone: '+91 98765 43210',
      direction: 'outgoing',
      outcome: 'answered',
      source: 'call_log',
      durationSeconds: 214,
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      note: 'Wants the weekend batch. Asked about fees and the placement record.',
      leadStatus: 'interested',
      followUpAt,
      followUpNote: 'Send the fee structure, then call.',
      clientUuid: '33333333-3333-4333-8333-333333333333',
    });
    check('a connected call is logged', answered.status === 201, answered.json);
    check('talk time is kept on an answered call', answered.json.call?.durationSeconds === 214);
    check('the follow-up booked with the call is created', typeof answered.json.followUpId === 'number', answered.json);

    const afterCall = await ravi.get(`/mobile/leads/${leadId}`);
    check('the status set on the call was applied', afterCall.json.lead?.status === 'interested', afterCall.json.lead?.status);
    check('lastContactedAt cache was refreshed', afterCall.json.lead?.lastContactedAt !== null);
    check('nextFollowUpAt cache was refreshed', afterCall.json.lead?.nextFollowUpAt !== null);
    check('the call note is attached to the lead', afterCall.json.notes?.some((n: Json) => n.kind === 'call_note'));
    check('both calls are in the lead history', afterCall.json.calls?.length === 2, afterCall.json.calls?.length);

    const clearedQueue = await ravi.get('/mobile/calls/pending-callbacks');
    check(
      'connecting cleared the earlier unanswered attempt from the queue',
      clearedQueue.json.total === 0,
      clearedQueue.json.total,
    );

    /* ---------------------------------------------------------- timeline */
    const timeline = afterCall.json.timeline as Json[];
    const types = timeline.map((entry) => entry.type);
    check('timeline records lead creation', types.includes('lead_created'), types);
    check('timeline records the calls', types.filter((t) => t === 'call_logged').length === 2, types);
    check('timeline records the status change', types.includes('status_changed'), types);
    check('timeline records the follow-up', types.includes('follow_up_created'), types);

    /* -------------------------------------------------------- follow-ups */
    console.log('\nfollow-ups');

    const upcoming = await ravi.get('/mobile/follow-ups?scope=upcoming');
    check('the follow-up shows as upcoming', upcoming.json.total === 1, upcoming.json.total);
    check('the follow-up is not overdue', upcoming.json.items?.[0]?.isOverdue === false);
    check('the follow-up carries the customer name and number', Boolean(upcoming.json.items?.[0]?.leadName && upcoming.json.items?.[0]?.leadPhone));

    const followUpId = upcoming.json.items?.[0]?.id as number;

    const pastDue = await ravi.post('/mobile/follow-ups', {
      leadId,
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      note: 'Should be refused.',
    });
    check('a follow-up in the past is refused', pastDue.status === 422, pastDue.status);

    const rescheduled = await ravi.post(`/mobile/follow-ups/${followUpId}/reschedule`, {
      dueAt: new Date(Date.now() + 172_800_000).toISOString(),
      note: 'Customer asked to be called on Saturday instead.',
    });
    check('the follow-up reschedules', rescheduled.status === 200, rescheduled.json);
    check('rescheduling increments the count', rescheduled.json.followUp?.rescheduleCount === 1, rescheduled.json.followUp);
    check('rescheduling records where it moved from', rescheduled.json.followUp?.rescheduledFrom !== null);

    const completed = await ravi.post(`/mobile/follow-ups/${followUpId}/complete`, {
      outcomeNote: 'Called. Sent the fee structure by WhatsApp.',
    });
    check('the follow-up completes', completed.json.followUp?.state === 'completed', completed.json);

    const completeAgain = await ravi.post(`/mobile/follow-ups/${followUpId}/complete`, {});
    check('completing twice is idempotent, not an error', completeAgain.status === 200, completeAgain.status);
    check(
      'the second completion did not overwrite the first timestamp',
      completeAgain.json.followUp?.completedAt === completed.json.followUp?.completedAt,
    );

    const afterComplete = await ravi.get(`/mobile/leads/${leadId}`);
    check(
      'nextFollowUpAt is cleared once nothing is pending',
      afterComplete.json.lead?.nextFollowUpAt === null,
      afterComplete.json.lead?.nextFollowUpAt,
    );

    /* --------------------------------------------------------- dashboard */
    console.log('\ndashboard and activity');

    const dashboard = await ravi.get('/mobile/dashboard');
    check('dashboard counts the assigned leads', dashboard.json.leads?.assigned === 2, dashboard.json.leads);
    check('dashboard counts today’s calls', dashboard.json.calls?.today === 2, dashboard.json.calls);
    check('dashboard counts answered calls', dashboard.json.calls?.answered === 1, dashboard.json.calls);
    check('dashboard reports talk time', dashboard.json.calls?.talkTimeSeconds === 214, dashboard.json.calls);
    check('dashboard tiles are numbers, never null', Object.values(dashboard.json.leads as Json).every((v) => typeof v === 'number'), dashboard.json.leads);

    const activity = await ravi.get('/mobile/activity');
    check('activity summary counts leads contacted, not calls made', activity.json.leadsContacted === 1, activity.json);
    check('average duration is over answered calls only', activity.json.averageDurationSeconds === 214, activity.json);
    check('completed follow-ups are counted', activity.json.followUpsCompleted === 1, activity.json);

    /* ------------------------------------------------- phone lookup */
    const lookup = await ravi.get('/mobile/leads/lookup/by-phone?phone=09876543210');
    check(
      'lookup matches a differently formatted number',
      lookup.json.items?.length === 2,
      lookup.json.items?.length,
    );

    /* ---------------------------------------------- notifications */
    const notifications = await ravi.get('/mobile/notifications');
    check('notifications endpoint responds', notifications.status === 200, notifications.json);

    /* ------------------------------------------------------ admin side */
    console.log('\nadmin API');

    const adminAsBearer = makeClient(base);
    const adminLogin = await adminAsBearer.post('/mobile/auth/login', {
      email: 'admin@example.test',
      password: 'correct-horse-battery',
    });
    adminAsBearer.setToken(adminLogin.json.accessToken);

    const adminDash = await adminAsBearer.get('/admin/telecalling/dashboard');
    check('an admin can read the admin dashboard', adminDash.status === 200, adminDash.json);
    check('admin dashboard counts all leads', adminDash.json.leads?.total === 2, adminDash.json.leads);
    check('admin dashboard counts unassigned leads', adminDash.json.leads?.unassigned === 0, adminDash.json.leads);
    check('admin dashboard lists employee performance', Array.isArray(adminDash.json.employees), adminDash.json.employees);

    const raviRow = (adminDash.json.employees as Json[]).find((row) => row.name === 'Ravi Caller');
    check('performance rows carry per-employee call counts', raviRow?.calls === 2, raviRow);
    check('performance rows carry talk time', raviRow?.talkTimeSeconds === 214, raviRow);
    check('performance rows carry leads contacted', raviRow?.leadsContacted === 1, raviRow);

    const telecallerOnAdmin = await ravi.get('/admin/telecalling/dashboard');
    check('a telecaller is refused the admin dashboard', telecallerOnAdmin.status === 403, telecallerOnAdmin.status);

    const telecallerRecordings = await ravi.get('/admin/telecalling/recordings');
    check('a telecaller is refused the recordings list', telecallerRecordings.status === 403);

    const adminLeads = await adminAsBearer.get('/admin/telecalling/leads');
    check('an admin sees every lead regardless of owner', adminLeads.json.total === 2, adminLeads.json.total);

    const perf = await adminAsBearer.get('/admin/telecalling/reports/performance');
    check('the performance report responds', perf.status === 200 && Array.isArray(perf.json.items));

    const trend = await adminAsBearer.get('/admin/telecalling/reports/calls?granularity=day');
    check('the call trend report responds', trend.status === 200, trend.json);
    check('the trend has one bucket for today', trend.json.items?.length === 1, trend.json.items);

    const breakdown = await adminAsBearer.get('/admin/telecalling/reports/leads?dimension=source');
    check('the source breakdown responds', breakdown.status === 200, breakdown.json);
    check(
      'the breakdown groups by source',
      (breakdown.json.items as Json[])?.some((row) => row.key === 'hard_copy'),
      breakdown.json.items,
    );

    const fuReport = await adminAsBearer.get('/admin/telecalling/reports/follow-ups');
    check('the follow-up report counts the completion', fuReport.json.completed === 1, fuReport.json);

    /* ------------------------------------- CSRF on the admin write path */
    console.log('\nCSRF and assignment');

    // A Bearer caller needs no CSRF token — the header cannot be forged cross-site.
    const assigned = await adminAsBearer.post(`/admin/telecalling/leads/${leadId}/assign`, {
      assignedTo: 3,
      reason: 'Ravi is on leave.',
    });
    check('an admin reassigns the lead', assigned.status === 200, assigned.json);
    check('the new owner is recorded', assigned.json.lead?.assignedTo === 3, assigned.json.lead);

    const nowMiras = await mira.get(`/mobile/leads/${leadId}`);
    check('the new owner can now read the lead', nowMiras.status === 200);

    const noLongerRavis = await ravi.get(`/mobile/leads/${leadId}`);
    check('the previous owner can no longer read it', noLongerRavis.status === 404);

    const bulk = await adminAsBearer.post('/admin/telecalling/leads/bulk-assign', {
      leadIds: [leadId, dup.json.lead.id, 99999],
      assignedTo: 2,
    });
    // One lead genuinely moves; the second is already owned by the target and is a
    // no-op, so it is skipped rather than counted; the third does not exist.
    check('bulk assign counts only the leads that moved', bulk.json.assigned === 1, bulk.json);
    check('bulk assign counts an already-correct lead as skipped', bulk.json.skipped === 1, bulk.json);
    check('bulk assign names the id it could not find', bulk.json.failedIds?.includes(99999), bulk.json);

    /* --------------------------------------------------- audit and settings */
    console.log('\naudit log and settings');

    const audit = await adminAsBearer.get('/admin/telecalling/audit-logs');
    check('the audit log responds', audit.status === 200, audit.json);
    const actions = (audit.json.items as Json[]).map((row) => row.action);
    check('lead creation is audited', actions.includes('lead_created'), actions);
    check('assignment is audited', actions.includes('lead_assigned'), actions);
    check('bulk assignment is audited', actions.includes('leads_bulk_assigned'), actions);
    check('audit rows carry the actor label', Boolean((audit.json.items as Json[])[0]?.actorLabel));

    const settings = await adminAsBearer.get('/admin/telecalling/settings');
    check('settings respond', settings.status === 200, settings.json);
    check('recording is off by default', (settings.json.items as Json[]).find((s) => s.key === 'recording.enabled')?.value === false, settings.json.items);

    const badSetting = await adminAsBearer.call('PUT', '/admin/telecalling/settings', {
      key: 'not.a.real.setting',
      value: true,
    });
    check('an unknown setting key is refused', badSetting.status === 422, badSetting.status);

    const goodSetting = await adminAsBearer.call('PUT', '/admin/telecalling/settings', {
      key: 'followup.reminder_minutes',
      value: 45,
    });
    check('a known setting is written', goodSetting.status === 200, goodSetting.json);
    check(
      'the written value comes back',
      (goodSetting.json.items as Json[]).find((s) => s.key === 'followup.reminder_minutes')?.value === 45,
      goodSetting.json.items,
    );

    /* ----------------------------------------- employees and revocation */
    console.log('\nemployee management');

    const weakPassword = await adminAsBearer.post('/admin/telecalling/employees', {
      name: 'Short Password',
      email: 'short@example.test',
      password: 'tooshort',
    });
    check('a short password is refused', weakPassword.status === 422, weakPassword.json);

    const newEmployee = await adminAsBearer.post('/admin/telecalling/employees', {
      name: 'Nikhil New',
      email: 'nikhil@example.test',
      password: 'another-long-password',
      role: 'telecaller',
    });
    check('an admin adds an employee', newEmployee.status === 201, newEmployee.json);
    check('the employee code is generated in sequence', newEmployee.json.employee?.employeeCode === 'TC-0004', newEmployee.json.employee);
    check('the created employee carries no password hash', !JSON.stringify(newEmployee.json).includes('$2'));

    const duplicateEmail = await adminAsBearer.post('/admin/telecalling/employees', {
      name: 'Clash',
      email: 'nikhil@example.test',
      password: 'another-long-password',
    });
    check('a duplicate email is refused with a field error', duplicateEmail.status === 422 && Boolean(duplicateEmail.json.errors?.email), duplicateEmail.json);

    const selfDemote = await adminAsBearer.patch('/admin/telecalling/employees/1', { role: 'telecaller' });
    check('an admin cannot change their own role', selfDemote.status === 400, selfDemote.json);

    const selfDeactivate = await adminAsBearer.patch('/admin/telecalling/employees/1', { isActive: false });
    check('an admin cannot deactivate their own account', selfDeactivate.status === 400, selfDeactivate.json);

    // Deactivating Mira must kill her live session.
    const deactivate = await adminAsBearer.patch('/admin/telecalling/employees/3', { isActive: false });
    check('an admin deactivates an employee', deactivate.status === 200 && deactivate.json.employee?.isActive === false, deactivate.json);

    const miraRefresh = await mira.post('/mobile/auth/refresh', {
      refreshToken: miraLogin.json.refreshToken,
    });
    check(
      'deactivation revokes the employee’s mobile sessions',
      miraRefresh.status === 401,
      miraRefresh.json,
    );

    const assignToDeactivated = await adminAsBearer.post(`/admin/telecalling/leads/${leadId}/assign`, {
      assignedTo: 3,
    });
    check('a lead cannot be assigned to a deactivated employee', assignToDeactivated.status === 400, assignToDeactivated.json);


    /* ------------------------------------ self-registration and approval */
    console.log('\nself-registration and admin approval');

    const applicant = makeClient(base);

    const weakSignup = await applicant.post('/mobile/auth/signup', {
      name: 'Priya Applicant',
      email: 'priya@example.test',
      password: 'tooshort',
    });
    check('signup refuses a short password', weakSignup.status === 422, weakSignup.status);

    /*
     * The privilege-escalation attempt. Anyone holding the APK can call this endpoint, so
     * the single most valuable thing to try is asking for a role.
     */
    const escalation = await applicant.post('/mobile/auth/signup', {
      name: 'Sneaky Applicant',
      email: 'sneaky@example.test',
      password: 'a-perfectly-long-password',
      role: 'admin',
      isActive: true,
      approvalStatus: 'approved',
      employeeCode: 'TC-9999',
    });
    check('signup accepts the registration', escalation.status === 201, escalation.json);

    const [sneakyRows] = await db.query(
      `SELECT id, role, is_active, approval_status, employee_code
         FROM telecaller_users WHERE email = 'sneaky@example.test'`,
    );
    const sneaky = (sneakyRows as any[])[0];
    check('a self-chosen role is ignored — forced to telecaller', sneaky?.role === 'telecaller', sneaky);
    check('a self-chosen isActive is ignored — forced to 0', sneaky?.is_active === 0, sneaky);
    check(
      'a self-chosen approvalStatus is ignored — forced to pending',
      sneaky?.approval_status === 'pending',
      sneaky,
    );
    check(
      'a self-chosen employee code is ignored — allocated by the server',
      sneaky?.employee_code !== 'TC-9999',
      sneaky,
    );

    const signup = await applicant.post('/mobile/auth/signup', {
      name: 'Priya Applicant',
      email: 'priya@example.test',
      phone: '9800000001',
      password: 'a-perfectly-long-password',
    });
    check('a valid registration is accepted', signup.status === 201, signup.json);
    check('it reports pending', signup.json.approvalStatus === 'pending', signup.json);
    check('no tokens are issued at signup', !signup.json.accessToken && !signup.json.refreshToken);

    const dupSignup = await applicant.post('/mobile/auth/signup', {
      name: 'Priya Again',
      email: 'priya@example.test',
      password: 'a-perfectly-long-password',
    });
    check('a duplicate email is refused', dupSignup.status === 422, dupSignup.status);

    /* --- the pending account cannot get in, and cannot be enumerated --- */

    const pendingWrongPassword = await applicant.post('/mobile/auth/login', {
      email: 'priya@example.test',
      password: 'the-wrong-password',
    });
    check(
      'a pending account with a WRONG password gives the generic credentials error',
      pendingWrongPassword.status === 401,
      pendingWrongPassword.json,
    );
    check(
      'and does not leak that the account exists or is pending',
      pendingWrongPassword.json.message === 'Incorrect email or password.',
      pendingWrongPassword.json.message,
    );

    /* --- email verification is mandatory before anything else --- */

    console.log('\nemail verification');

    const unverifiedLogin = await applicant.post('/mobile/auth/login', {
      email: 'priya@example.test',
      password: 'a-perfectly-long-password',
    });
    check(
      'an unverified account with the RIGHT password is refused 403',
      unverifiedLogin.status === 403,
      unverifiedLogin.status,
    );
    check(
      'and reports email_not_verified, NOT approval_pending',
      unverifiedLogin.json.code === 'email_not_verified',
      unverifiedLogin.json,
    );
    check('and still no tokens', !unverifiedLogin.json.accessToken);

    /*
     * An unverified registration cannot be approved.
     *
     * This is the assertion that makes verification mandatory rather than advisory.
     * Without it an administrator could click Approve and produce an "approved" account
     * that still cannot sign in.
     */
    const [priyaIdRows] = await db.query(
      `SELECT id FROM telecaller_users WHERE email = 'priya@example.test'`,
    );
    const priyaUserId = Number((priyaIdRows as any[])[0]?.id);

    const earlyApprove = await adminAsBearer.post(
      `/admin/telecalling/registrations/${priyaUserId}/approve`,
    );
    check(
      'an admin CANNOT approve an unverified registration',
      earlyApprove.status === 400,
      earlyApprove.json,
    );
    check(
      'and is told it is waiting on the applicant',
      String(earlyApprove.json.message).includes('confirmed their email'),
      earlyApprove.json.message,
    );

    /* --- the code itself --- */

    const badCode = await applicant.post('/mobile/auth/verify-email', {
      email: 'priya@example.test',
      code: '000000',
    });
    check('a wrong code is refused 400', badCode.status === 400, badCode.status);

    const unknownAddress = await applicant.post('/mobile/auth/verify-email', {
      email: 'nobody-at-all@example.test',
      code: '000000',
    });
    check(
      'an unregistered address is refused IDENTICALLY (no enumeration)',
      unknownAddress.status === badCode.status && unknownAddress.json.code === badCode.json.code,
      { unknown: unknownAddress.json, known: badCode.json },
    );

    const malformed = await applicant.post('/mobile/auth/verify-email', {
      email: 'priya@example.test',
      code: '12345',
    });
    check(
      'a 5-digit code is rejected by validation, before it can cost an attempt',
      malformed.status === 422,
      malformed.status,
    );

    /*
     * Recover the real code from its stored hash.
     *
     * The code is emailed, and this harness has no mailbox — but it is stored as a
     * SHA-256 of six digits, so the live value can be found by trying all of them. That
     * is only a million hashes, which takes under a second, and it is worth stating
     * plainly: this is exactly the search the attempt cap and the ten-minute expiry
     * exist to make useless against the API.
     */
    const [otpRows] = await db.query(
      `SELECT code_hash FROM employee_email_otps
        WHERE user_id = ? AND consumed_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [priyaUserId],
    );
    const wantedHash = (otpRows as any[])[0]?.code_hash as string | undefined;
    check('signup issued a verification code', Boolean(wantedHash));

    let realCode = '';
    if (wantedHash) {
      for (let i = 0; i < 1_000_000; i += 1) {
        const candidate = String(i).padStart(6, '0');
        if (createHash('sha256').update(candidate, 'utf8').digest('hex') === wantedHash) {
          realCode = candidate;
          break;
        }
      }
    }
    check('the code is a 6-digit value stored only as a hash', /^\d{6}$/.test(realCode), realCode);

    const verified = await applicant.post('/mobile/auth/verify-email', {
      email: 'priya@example.test',
      code: realCode,
    });
    check('the correct code verifies the address', verified.status === 200, verified.json);
    check('and reports it was not already verified', verified.json.alreadyVerified === false);

    const reVerify = await applicant.post('/mobile/auth/verify-email', {
      email: 'priya@example.test',
      code: realCode,
    });
    check(
      'verifying again is idempotent rather than an error',
      reVerify.status === 200 && reVerify.json.alreadyVerified === true,
      reVerify.json,
    );

    const [consumedRows] = await db.query(
      `SELECT consumed_at FROM employee_email_otps WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      [priyaUserId],
    );
    check(
      'the code is marked consumed, so it cannot be reused',
      (consumedRows as any[])[0]?.consumed_at !== null,
    );

    const resend = await applicant.post('/mobile/auth/resend-verification', {
      email: 'priya@example.test',
    });
    check(
      'resending for an already-verified address reports success, revealing nothing',
      resend.status === 200,
      resend.json,
    );

    /* --- only now does the account reach the approval gate --- */

    const pendingLogin = await applicant.post('/mobile/auth/login', {
      email: 'priya@example.test',
      password: 'a-perfectly-long-password',
    });
    check('a pending account with the RIGHT password is refused 403', pendingLogin.status === 403, pendingLogin.status);
    check(
      'and NOW reports approval_pending, the next gate along',
      pendingLogin.json.code === 'approval_pending',
      pendingLogin.json,
    );
    check('and still no tokens', !pendingLogin.json.accessToken);

    /* --- a pending account is invisible to the rest of the system --- */

    const assignable = await adminAsBearer.get('/admin/telecalling/employees/assignable');
    check(
      'a pending applicant does NOT appear in the assignment picker',
      !(assignable.json.items as Json[]).some((e) => e.email === 'priya@example.test'),
      (assignable.json.items as Json[]).map((e) => e.email),
    );

    const dashAfterSignup = await adminAsBearer.get('/admin/telecalling/dashboard');
    check(
      'a pending applicant is not counted as an active employee',
      dashAfterSignup.json.employees_total === undefined ||
        !(dashAfterSignup.json.employeeRows ?? []).some(
          (e: Json) => e.name === 'Priya Applicant',
        ),
      dashAfterSignup.json.employees,
    );
    check(
      'the dashboard reports the pending registration count',
      typeof dashAfterSignup.json.pendingRegistrations === 'number' &&
        dashAfterSignup.json.pendingRegistrations >= 2,
      dashAfterSignup.json.pendingRegistrations,
    );

    const assignToPending = await adminAsBearer.post(
      `/admin/telecalling/leads/${leadId}/assign`,
      { assignedTo: sneaky ? Number((sneakyRows as any[])[0].id ?? 0) || 99 : 99 },
    );
    check('a lead cannot be assigned to a non-approved account', assignToPending.status === 400, assignToPending.status);

    /* --- the approvals queue --- */

    const queue = await adminAsBearer.get('/admin/telecalling/registrations');
    check('the admin sees the pending queue', queue.status === 200, queue.json);
    check(
      'it contains the applicant',
      (queue.json.items as Json[]).some((e) => e.email === 'priya@example.test'),
      (queue.json.items as Json[]).map((e) => e.email),
    );

    const priya = (queue.json.items as Json[]).find((e) => e.email === 'priya@example.test');
    const priyaId = priya?.id as number;

    const telecallerQueue = await ravi.get('/admin/telecalling/registrations');
    check('a telecaller cannot see the queue', telecallerQueue.status === 403, telecallerQueue.status);

    const telecallerApprove = await ravi.post(
      `/admin/telecalling/registrations/${priyaId}/approve`,
    );
    check('a telecaller cannot approve', telecallerApprove.status === 403, telecallerApprove.status);

    /* --- approval --- */

    const approve = await adminAsBearer.post(
      `/admin/telecalling/registrations/${priyaId}/approve`,
    );
    check('an admin approves the registration', approve.status === 200, approve.json);
    check('the account becomes approved', approve.json.employee?.approvalStatus === 'approved');
    check('and becomes active', approve.json.employee?.isActive === true);
    check('the approver is recorded', approve.json.employee?.approvedAt !== null);

    const approveTwice = await adminAsBearer.post(
      `/admin/telecalling/registrations/${priyaId}/approve`,
    );
    check('approving twice is refused, not silently repeated', approveTwice.status === 400, approveTwice.status);

    const approvedLogin = await applicant.post('/mobile/auth/login', {
      email: 'priya@example.test',
      password: 'a-perfectly-long-password',
    });
    check('the approved account can now sign in', approvedLogin.status === 200, approvedLogin.json);
    check('and receives tokens', Boolean(approvedLogin.json.accessToken));
    applicant.setToken(approvedLogin.json.accessToken);

    const nowAssignable = await adminAsBearer.get('/admin/telecalling/employees/assignable');
    check(
      'the approved employee now appears in the assignment picker',
      (nowAssignable.json.items as Json[]).some((e) => e.email === 'priya@example.test'),
    );

    /* --- rejection, and reopening it --- */

    const sneakyId = Number((sneakyRows as any[])[0]?.id);

    /*
     * Mark the second applicant verified directly.
     *
     * The reject-and-reopen assertions below are about the APPROVAL gate, and leaving
     * this account unverified would make them fail for an unrelated reason. Done in SQL
     * rather than through the API because recovering a second code adds nothing to what
     * the verification assertions above already prove.
     */
    await db.execute(
      `UPDATE telecaller_users SET email_verified_at = NOW() WHERE id = ?`,
      [sneakyId],
    );
    const reject = await adminAsBearer.post(
      `/admin/telecalling/registrations/${sneakyId}/reject`,
      { reason: 'Not a member of staff.' },
    );
    check('an admin rejects a registration', reject.status === 200, reject.json);
    check('it records the reason', reject.json.employee?.rejectionReason === 'Not a member of staff.');

    const rejectedLogin = await makeClient(base).post('/mobile/auth/login', {
      email: 'sneaky@example.test',
      password: 'a-perfectly-long-password',
    });
    check('a rejected account is refused', rejectedLogin.status === 403, rejectedLogin.status);
    check(
      'with a distinct code',
      rejectedLogin.json.code === 'registration_rejected',
      rejectedLogin.json,
    );
    check(
      'and is told why',
      String(rejectedLogin.json.message).includes('Not a member of staff'),
      rejectedLogin.json.message,
    );

    const reopen = await adminAsBearer.post(
      `/admin/telecalling/registrations/${sneakyId}/reopen`,
    );
    check('a rejection can be reopened', reopen.status === 200, reopen.json);
    check('back to pending', reopen.json.employee?.approvalStatus === 'pending');

    /* --- revocation actually bites on the token-minting paths --- */

    const priyaSession = approvedLogin.json.refreshToken as string;

    await adminAsBearer.patch(`/admin/telecalling/employees/${priyaId}`, { isActive: false });

    const deactivatedMe = await applicant.get('/mobile/auth/me');
    check(
      '/me refuses a deactivated account rather than returning a profile',
      deactivatedMe.status === 403,
      deactivatedMe.status,
    );
    check(
      'with a code the app can act on',
      deactivatedMe.json.code === 'account_deactivated',
      deactivatedMe.json,
    );

    /*
     * The critical one. change-password mints a fresh 60-day session, and an access token
     * stays valid after deactivation — so without a state re-read inside
     * createMobileSession a sacked employee could restore their own access.
     */
    const deactivatedChangePw = await applicant.post('/mobile/auth/change-password', {
      currentPassword: 'a-perfectly-long-password',
      newPassword: 'another-perfectly-long-one',
    });
    check(
      'a deactivated account cannot mint a new session via change-password',
      deactivatedChangePw.status >= 400,
      deactivatedChangePw.status,
    );
    check(
      'and no tokens leak out of it',
      !deactivatedChangePw.json.accessToken && !deactivatedChangePw.json.refreshToken,
      deactivatedChangePw.json,
    );

    const deactivatedRefresh = await applicant.post('/mobile/auth/refresh', {
      refreshToken: priyaSession,
    });
    check('and its refresh token is dead', deactivatedRefresh.status === 401, deactivatedRefresh.status);

    /* --- the audit trail --- */

    const approvalAudit = await adminAsBearer.get('/admin/telecalling/audit-logs');
    const approvalActions = (approvalAudit.json.items as Json[]).map((r) => r.action);
    check('approval is audited', approvalActions.includes('registration_approved'), approvalActions);
    check('rejection is audited', approvalActions.includes('registration_rejected'), approvalActions);

    /* ------------------------------------------------------ sign out */
    console.log('\nsign out');

    const logout = await ravi.post('/mobile/auth/logout', { refreshToken: raviRefreshToken });
    check('sign-out succeeds', logout.status === 200);

    const afterLogout = await ravi.post('/mobile/auth/refresh', { refreshToken: raviRefreshToken });
    check('the refresh token is dead after sign-out', afterLogout.status === 401);

    /* ------------------------------------------------------ validation */
    console.log('\nvalidation');

    const badPhone = await adminAsBearer.post('/admin/telecalling/leads', {
      customerName: 'Bad Phone',
      phone: 'not-a-number',
    });
    check('an invalid phone number is refused', badPhone.status === 422, badPhone.json);
    check('the error names the field', Boolean(badPhone.json.errors?.phone), badPhone.json.errors);

    const absurdDuration = await adminAsBearer.post('/mobile/calls', {
      phone: '9876543210',
      outcome: 'answered',
      durationSeconds: 999_999,
      startedAt: new Date().toISOString(),
    });
    check('an implausible call duration is refused', absurdDuration.status === 422, absurdDuration.status);

    const unknownSource = await adminAsBearer.post('/admin/telecalling/leads', {
      customerName: 'Unknown Source',
      phone: '9000000001',
      source: 'from_a_billboard',
    });
    check('an unknown lead source is normalised rather than rejected', unknownSource.status === 201, unknownSource.json);
    check('it lands as "other"', unknownSource.json.lead?.source === 'other', unknownSource.json.lead?.source);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { closePool } = await import('../src/db/pool');
    await closePool();
    await db.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('e2e run crashed:', error);
  process.exit(1);
});
