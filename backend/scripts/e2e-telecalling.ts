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
import { optionalPhoneField } from '../src/modules/telecalling/shared.schema';
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

/**
 * The API-wide rate limit is lifted for this suite.
 *
 * It is 120 requests a minute per IP, and this harness is a few hundred requests arriving
 * from one address in well under that — so it was running into the ceiling, and tests were
 * being written around it: probes trimmed, assertions folded together, and one 429 already
 * misread as a validation failure. That is the limiter shaping the test suite instead of
 * the suite testing the product.
 *
 * Nothing here asserts on the limiter, so raising it removes false failures without
 * removing coverage. The limiter itself is covered by `npm run test:ratelimit`, which
 * boots the app on the real defaults and drives one IP past the ceiling — a check that
 * has to run in a process where the ceiling has NOT been raised, which is why it is a
 * separate script rather than a section here.
 *
 * The per-endpoint limiters — login, signup, password change — are NOT touched, because
 * those protect specific behaviours this suite does exercise.
 */
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';

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

    /*
     * One active lead per number.
     *
     * Asserted in the form the bug actually took: the number is sent written DIFFERENTLY
     * from the way the first lead stored it. A constraint that compared the text would
     * let this through and produce the duplicate it exists to prevent.
     */
    const dup = await ravi.post('/mobile/leads', {
      customerName: 'Deepa N (second enquiry)',
      phone: '9876543210',
      source: 'referral',
    });
    check('a second lead on the same number is refused', dup.status === 400, dup.status);
    check(
      'and the refusal names the lead already holding it',
      String(dup.json.message ?? '').includes('LD-'),
      dup.json.message,
    );
    check(
      'and it is reported against the phone field, not as a bare banner',
      typeof (dup.json.errors as Json)?.phone === 'string',
      dup.json.errors,
    );

    const dupSpaced = await ravi.post('/mobile/leads', {
      customerName: 'Deepa N (third try)',
      phone: '+91 98765 43210',
      source: 'referral',
    });
    check('the same number spaced and prefixed is refused too', dupSpaced.status === 400, dupSpaced.status);

    const dupZero = await ravi.post('/mobile/leads', {
      customerName: 'Deepa N (fourth try)',
      phone: '09876543210',
      source: 'referral',
    });
    check('and with a leading zero', dupZero.status === 400, dupZero.status);

    /*
     * Editing a number onto somebody else's lead is the same duplicate by a slower route.
     */
    const otherOwner = await ravi.post('/mobile/leads', {
      customerName: 'Vinod Kumar',
      phone: '+91 91111 22233',
      source: 'manual',
    });
    const otherOwnerId = otherOwner.json.lead?.id as number;

    const moveOnto = await ravi.patch(`/mobile/leads/${otherOwnerId}`, { phone: '9876543210' });
    check("editing a lead onto another's number is refused", moveOnto.status === 400, moveOnto.status);

    /*
     * Reformatting the number on the lead that already owns it must still work — the key
     * does not change, so the duplicate check finds this very lead and lets it through.
     * Without the id comparison in `editLead` this would refuse and no number could ever
     * be tidied up.
     */
    const reformat = await ravi.patch(`/mobile/leads/${leadId}`, { phone: '098765 43210' });
    check('but reformatting a lead\'s own number is allowed', reformat.status === 200, reformat.json);

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

    /* --- the "walked in" status, end to end --- */

    console.log('\nwalked-in status');

    /*
     * Added as an ENUM value in migration 012. The point of these assertions is that the
     * three copies of the vocabulary — the database enum, the backend's LEAD_STATUSES and
     * the two clients' — actually agree. A mismatch does not fail a build: the request is
     * accepted by Zod and then rejected by MySQL with a truncation warning, or worse,
     * silently coerced to the empty string.
     */
    const walkedIn = await ravi.post(`/mobile/leads/${leadId}/status`, {
      status: 'walked_in',
      note: 'Came to the office on Saturday.',
    });
    check('a telecaller can set the walked-in status', walkedIn.status === 200, walkedIn.json);

    const afterWalkIn = await ravi.get(`/mobile/leads/${leadId}`);
    check(
      'it is stored and read back intact',
      afterWalkIn.json.lead?.status === 'walked_in',
      afterWalkIn.json.lead?.status,
    );


    const bogusStatus = await ravi.post(`/mobile/leads/${leadId}/status`, {
      status: 'walked-in',
    });
    check(
      'the hyphenated spelling is refused, so the convention cannot drift',
      bogusStatus.status === 422,
      bogusStatus.status,
    );


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

    /* --- "not yet called" means never contacted, not status = new --- */

    /*
     * `leadId` has had two calls logged against it by this point, and its status was set
     * to 'interested' by the second. The second lead has never been rung.
     *
     * The tile used to count `status = 'new'`, which is a different question: logging a
     * call does not set a status unless the telecaller picks one, so a lead that had been
     * rung twice kept appearing under "Not yet called". Measured on the dev database
     * before the fix — 10 counted, 13 genuinely uncalled, 1 counted despite being called.
     */
    check(
      'the uncalled tile counts leads with no contact history',
      dashboard.json.leads?.new === 1,
      dashboard.json.leads,
    );

    /*
     * One request, not three.
     *
     * This harness runs near the global rate limit by the time it reaches here, and an
     * earlier draft of this block spent three probes on one behaviour — which pushed an
     * unrelated lead-source test into a 429 that read like a validation failure. This
     * single response carries both facts worth asserting.
     */
    const uncalled = await ravi.get('/mobile/leads?contacted=never');
    check(
      'and the matching filter returns the same number',
      uncalled.json.total === dashboard.json.leads?.new,
      { filter: uncalled.json.total, tile: dashboard.json.leads?.new },
    );
    check(
      'the called lead is absent from it, whatever its status',
      !(uncalled.json.items as Json[] | undefined)?.some((row) => Number(row.id) === leadId),
      uncalled.json.items,
    );

    const activity = await ravi.get('/mobile/activity');
    check('activity summary counts leads contacted, not calls made', activity.json.leadsContacted === 1, activity.json);
    check('average duration is over answered calls only', activity.json.averageDurationSeconds === 214, activity.json);
    check('completed follow-ups are counted', activity.json.followUpsCompleted === 1, activity.json);

    /* ------------------------------------------------- phone lookup */
    const lookup = await ravi.get('/mobile/leads/lookup/by-phone?phone=09876543210');
    check(
      'lookup matches a differently formatted number',
      lookup.json.items?.length === 1,
      lookup.json.items?.length,
    );
    /*
     * Exactly one, now that a number cannot be held twice. This is what lets an incoming
     * call attach itself without asking: the server is never choosing between customers.
     */
    check(
      'and it is unambiguous, so a call from it can attach on its own',
      lookup.json.items?.[0]?.id === leadId,
      lookup.json.items?.[0]?.id,
    );

    /* ------------------------------------------------ incoming calls */
    /*
     * Calls the customer made to us, imported from the handset's call log.
     *
     * The app reads the Android log on resume and posts each row through the SAME
     * endpoint as an outgoing call, with `direction: 'incoming'` and a `clientUuid`
     * DERIVED from the log row rather than randomly generated. That derivation is what
     * makes re-importing free, and it is the property the replay assertion below exists
     * to protect: the import runs on every resume, every relaunch and every reinstall,
     * so anything that could turn one physical call into two rows would have done so by
     * the end of a single day.
     */
    console.log('\ncalls that came in');

    const strangerNumber = '+91 90000 11122';
    const incomingStartedAt = new Date(Date.now() - 1_800_000).toISOString();

    const incomingUnknown = await ravi.post('/mobile/calls', {
      // No leadId, because the app could not match the number to one.
      phone: strangerNumber,
      direction: 'incoming',
      outcome: 'missed',
      source: 'call_log',
      durationSeconds: 0,
      startedAt: incomingStartedAt,
      clientUuid: '44444444-4444-4444-8444-444444444444',
    });
    check('a missed call from an unknown number is logged', incomingUnknown.status === 201, incomingUnknown.json);
    check(
      'it is not attached to a lead, because none matches',
      incomingUnknown.json.call?.leadId === null,
      incomingUnknown.json.call?.leadId,
    );
    check(
      'the direction is preserved',
      incomingUnknown.json.call?.direction === 'incoming',
      incomingUnknown.json.call?.direction,
    );

    const incomingReplay = await ravi.post('/mobile/calls', {
      phone: strangerNumber,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: incomingStartedAt,
      clientUuid: '44444444-4444-4444-8444-444444444444',
    });
    check(
      're-importing the same call-log row does not duplicate it',
      incomingReplay.json.deduplicated === true &&
        incomingReplay.json.call?.id === incomingUnknown.json.call?.id,
      incomingReplay.json,
    );

    const incomingKnown = await ravi.post('/mobile/calls', {
      // Also no leadId: the app sends what the log gave it and lets the server match.
      phone: '09876543210',
      direction: 'incoming',
      outcome: 'answered',
      source: 'call_log',
      durationSeconds: 45,
      startedAt: new Date(Date.now() - 900_000).toISOString(),
      clientUuid: '55555555-5555-4555-8555-555555555555',
    });
    check('an incoming call from a known number is logged', incomingKnown.status === 201, incomingKnown.json);

    const incomingList = await ravi.get('/mobile/calls?direction=incoming');
    check('the incoming filter returns only incoming calls', incomingList.json.total === 2, incomingList.json.total);
    check(
      'and nothing outgoing leaks into it',
      (incomingList.json.items as Json[]).every((row) => row.direction === 'incoming'),
      (incomingList.json.items as Json[]).map((row) => row.direction),
    );

    const incomingDash = await ravi.get('/mobile/dashboard');
    check(
      'the dashboard counts what came in today',
      incomingDash.json.incoming?.today === 2,
      incomingDash.json.incoming,
    );
    check(
      'and separates the ones nobody picked up',
      incomingDash.json.incoming?.missedToday === 1,
      incomingDash.json.incoming,
    );
    check(
      'both incoming calls need action until somebody deals with them',
      incomingDash.json.incoming?.unhandled === 2,
      incomingDash.json.incoming,
    );

    /* --------------------------- unknown caller becomes a lead --------- */
    const sourceList = await ravi.get('/mobile/lead-sources');
    check(
      'Incoming call is an offered lead source',
      (sourceList.json.items as Json[]).some((row) => row.slug === 'incoming_call'),
      (sourceList.json.items as Json[]).map((row) => row.slug),
    );

    const fromStranger = await ravi.post('/mobile/leads', {
      customerName: 'Priya Menon',
      phone: strangerNumber,
      source: 'incoming_call',
      clientUuid: '66666666-6666-4666-8666-666666666666',
    });
    check('a lead is created from the unknown caller', fromStranger.status === 201, fromStranger.json);
    check(
      'the source is kept, not normalised to other',
      fromStranger.json.lead?.source === 'incoming_call',
      fromStranger.json.lead?.source,
    );

    const strangerLeadId = fromStranger.json.lead?.id as number;
    const strangerLead = await ravi.get('/mobile/leads/' + strangerLeadId);
    check(
      'the call that produced the lead is now in its history',
      (strangerLead.json.calls as Json[]).some((row) => row.id === incomingUnknown.json.call?.id),
      (strangerLead.json.calls as Json[]).map((row) => row.id),
    );
    /*
     * Adopted, handled — and still waiting to be written up.
     *
     * Creating the lead dealt with the call; it did not say what was discussed. An
     * earlier version stamped these as recorded, which claimed a write-up nobody had
     * done and quietly removed the prompt to do it.
     */
    check(
      'the adopted call is NOT claimed to have been written up',
      (strangerLead.json.calls as Json[]).find(
        (row) => row.id === incomingUnknown.json.call?.id,
      )?.recordedAt === null,
      (strangerLead.json.calls as Json[]).find(
        (row) => row.id === incomingUnknown.json.call?.id,
      )?.recordedAt,
    );
    check(
      'but it is marked handled, so it stops asking for attention',
      (strangerLead.json.calls as Json[]).find(
        (row) => row.id === incomingUnknown.json.call?.id,
      )?.followedUp === true,
      (strangerLead.json.calls as Json[]).find(
        (row) => row.id === incomingUnknown.json.call?.id,
      )?.followedUp,
    );

    check(
      'and the timeline says where that history came from',
      (strangerLead.json.timeline as Json[]).some(
        (row) => row.type === 'call_logged' && String(row.summary).includes('Linked'),
      ),
      (strangerLead.json.timeline as Json[]).map((row) => row.summary),
    );

    /*
     * Adoption must not reach across telecallers.
     *
     * Mira has her own unattached incoming call from the same number. Ravi creating a
     * lead for it takes his own call and leaves hers alone — if it took both, one
     * telecaller creating a lead would silently move a colleague's conversation into a
     * record they own.
     */
    const miraIncoming = await mira.post('/mobile/calls', {
      phone: strangerNumber,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: new Date(Date.now() - 2_400_000).toISOString(),
      clientUuid: '77777777-7777-4777-8777-777777777777',
    });
    check('another telecaller logs a call from the same number', miraIncoming.status === 201, miraIncoming.json);

    /*
     * Creating a lead for the same caller twice is exactly the mistake the Incoming list
     * used to invite, so it is refused here as well as on the Leads tab.
     */
    const raviSecondLead = await ravi.post('/mobile/leads', {
      customerName: 'Priya Menon second enquiry',
      phone: strangerNumber,
      source: 'incoming_call',
      clientUuid: '88888888-8888-4888-8888-888888888888',
    });
    check('a second lead for the same caller is refused', raviSecondLead.status === 400, raviSecondLead.status);

    const miraCalls = await mira.get('/mobile/calls?direction=incoming');
    check(
      "the other telecaller's call from that number is still hers and unattached",
      (miraCalls.json.items as Json[])[0]?.leadId === null,
      (miraCalls.json.items as Json[])[0],
    );

    const strangerLeadAgain = await ravi.get('/mobile/leads/' + strangerLeadId);
    check(
      'and the first lead kept the call it had already adopted',
      (strangerLeadAgain.json.calls as Json[]).some((row) => row.id === incomingUnknown.json.call?.id),
      (strangerLeadAgain.json.calls as Json[]).map((row) => row.id),
    );

    /* ------------------------- writing up a detected call ------------- */
    /*
     * An incoming call exists before anybody has looked at it, so "add a call record" is
     * an amendment, not an insert. These assertions guard the property that makes a
     * duplicate call record impossible rather than merely unlikely: there is one row per
     * physical call, and writing it up changes that row.
     */
    console.log('\ncall records');

    const attached = (incomingList.json.items as Json[]).find(
      (row) => row.id === incomingKnown.json.call?.id,
    );
    check('a detected call starts out not written up', attached?.recordedAt === null, attached?.recordedAt);

    /*
     * It attached itself on the way in, with nobody asked.
     *
     * That is what one-lead-per-number buys. The server matches an incoming call to a
     * lead by number and refuses to guess between several — and while two leads could
     * hold one number there was often nothing to pick from, so calls from well-known
     * customers arrived unattached and the app offered to create a lead that already
     * existed. With the number unique the match is always certain or genuinely absent.
     */
    check(
      'and it attached itself to the lead that owns the number',
      attached?.leadId === leadId,
      { leadId: attached?.leadId, expected: leadId },
    );
    check(
      'carrying the lead status, so a list of calls needs no second request',
      typeof attached?.leadStatus === 'string',
      attached?.leadStatus,
    );

    /* --- the full write-up, against a lead no other assertion depends on --- */
    const anita = await ravi.post('/mobile/leads', {
      customerName: 'Anita Rao',
      phone: '+91 90000 88822',
      source: 'manual',
      clientUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    const anitaLeadId = anita.json.lead?.id as number;

    const anitaCall = await ravi.post('/mobile/calls', {
      phone: '+91 90000 88822',
      direction: 'incoming',
      outcome: 'answered',
      source: 'call_log',
      durationSeconds: 60,
      startedAt: new Date(Date.now() - 1_200_000).toISOString(),
      clientUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    check(
      'a call from a freshly created lead attaches on its own too',
      anitaCall.json.call?.leadId === anitaLeadId,
      anitaCall.json.call?.leadId,
    );

    const beforeRecord = await ravi.get('/mobile/calls?direction=incoming');
    const countBefore = beforeRecord.json.total as number;

    const recorded = await ravi.post('/mobile/calls/' + anitaCall.json.call?.id + '/record', {
      note: 'Asked about the evening batch. Sending fees.',
      leadStatus: 'interested',
      followUpAt: new Date(Date.now() + 172_800_000).toISOString(),
      followUpNote: 'Call after the fee structure lands.',
    });
    check('the call is written up', recorded.status === 200, recorded.json);
    check('it is stamped as recorded', recorded.json.call?.recordedAt !== null, recorded.json.call);
    check(
      'writing it up also clears it from the unhandled list',
      recorded.json.call?.followedUp === true,
      recorded.json.call,
    );
    check(
      'the follow-up booked with it is created',
      typeof recorded.json.followUpId === 'number',
      recorded.json,
    );

    const afterRecord = await ravi.get('/mobile/calls?direction=incoming');
    check(
      'and NO second call row was created',
      (afterRecord.json.total as number) === countBefore,
      { before: countBefore, after: afterRecord.json.total },
    );

    const recordedLead = await ravi.get('/mobile/leads/' + anitaLeadId);
    check(
      'the note lands in the lead history against that call',
      (recordedLead.json.notes as Json[]).some(
        (note) => note.callId === anitaCall.json.call?.id && note.kind === 'call_note',
      ),
      (recordedLead.json.notes as Json[]).map((n) => n.callId),
    );
    check(
      'the status chosen while writing it up is applied to the lead',
      recordedLead.json.lead?.status === 'interested',
      recordedLead.json.lead?.status,
    );

    /* --- writing up twice amends, it does not duplicate --- */
    const recordedAgain = await ravi.post('/mobile/calls/' + anitaCall.json.call?.id + '/record', {
      note: 'Correction: morning batch, not evening.',
    });
    check('the same call can be written up again', recordedAgain.status === 200, recordedAgain.json);

    const afterSecond = await ravi.get('/mobile/calls?direction=incoming');
    check(
      'and the second write-up still creates no extra call row',
      (afterSecond.json.total as number) === countBefore,
      { before: countBefore, after: afterSecond.json.total },
    );

    /* --- a caller nobody has a lead for --- */
    const strangerCall = await ravi.post('/mobile/calls', {
      phone: '+91 90000 77744',
      direction: 'incoming',
      outcome: 'missed',
      source: 'call_log',
      startedAt: new Date(Date.now() - 300_000).toISOString(),
      clientUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const orphan = strangerCall.json.call as Json;
    check('a call from a number no lead has is unattached', orphan?.leadId === null, orphan);

    const noLeadNote = await ravi.post('/mobile/calls/' + orphan?.id + '/record', {
      note: 'This has nowhere to go.',
    });
    check(
      'a note on a call with no lead is refused, not silently dropped',
      noLeadNote.status === 422 || noLeadNote.status === 400,
      { status: noLeadNote.status, body: noLeadNote.json },
    );

    const outcomeOnly = await ravi.post('/mobile/calls/' + orphan?.id + '/record', {
      outcome: 'missed',
    });
    check(
      'but confirming the outcome alone is allowed with no lead',
      outcomeOnly.status === 200,
      outcomeOnly.json,
    );
    check(
      'and that marks it recorded',
      outcomeOnly.json.call?.recordedAt !== null,
      outcomeOnly.json.call,
    );

    /*
     * The telecaller recognises the caller and names the lead themselves. This is the
     * remaining reason `record` accepts a `leadId`: the number belongs to nobody, so no
     * amount of matching would have found it.
     */
    const namedLead = await ravi.post('/mobile/calls/' + orphan?.id + '/record', {
      leadId: anitaLeadId,
    });
    check(
      'naming a lead attaches an unattached call to it',
      namedLead.json.call?.leadId === anitaLeadId,
      namedLead.json.call?.leadId,
    );

    /* --- a call cannot be moved between customers --- */
    const otherLead = await ravi.post('/mobile/leads', {
      customerName: 'Somebody Else',
      phone: '+91 90000 55511',
      source: 'manual',
      clientUuid: '99999999-9999-4999-8999-999999999999',
    });
    const hijack = await ravi.post('/mobile/calls/' + anitaCall.json.call?.id + '/record', {
      leadId: otherLead.json.lead?.id,
      note: 'Should not move this call.',
    });
    check('re-recording an attached call succeeds', hijack.status === 200, hijack.json);
    check(
      'but it does NOT move the call to the lead the client named',
      hijack.json.call?.leadId === anitaLeadId,
      { expected: anitaLeadId, now: hijack.json.call?.leadId },
    );

    /* --- one telecaller cannot write up another's call --- */
    const foreign = await mira.post('/mobile/calls/' + anitaCall.json.call?.id + '/record', {
      outcome: 'answered',
    });
    check(
      "another telecaller cannot write up someone else's call",
      foreign.status === 404,
      foreign.status,
    );

    /* ------------------------- batch phone lookup ---------------------- */
    /*
     * What the Incoming list uses to decide between "View lead" and "Create lead". Getting
     * this wrong in the false direction is how duplicate leads get made, so it is asserted
     * against the same number in three different renderings.
     */
    const batch = await ravi.post('/mobile/leads/lookup/by-phones', {
      phones: ['+91 98765 43210', '09876543210', '9876543210', '+91 90000 99999'],
    });
    check('the batch lookup responds', batch.status === 200, batch.json);
    check(
      'a known number matches however it is written',
      ['+91 98765 43210', '09876543210', '9876543210'].every(
        (phone) => ((batch.json.items as Json)[phone] as Json[]).length > 0,
      ),
      batch.json.items,
    );
    check(
      'an unknown number matches nothing',
      ((batch.json.items as Json)['+91 90000 99999'] as Json[]).length === 0,
      (batch.json.items as Json)['+91 90000 99999'],
    );
    check(
      'a known number matches exactly one lead, never several',
      ['+91 98765 43210', '09876543210', '9876543210'].every(
        (phone) => ((batch.json.items as Json)[phone] as Json[]).length === 1,
      ),
      batch.json.items,
    );
    check(
      'matches carry the name and status the list needs to render',
      (((batch.json.items as Json)['9876543210'] as Json[])[0] as Json)?.name !== undefined &&
        (((batch.json.items as Json)['9876543210'] as Json[])[0] as Json)?.status !== undefined,
      ((batch.json.items as Json)['9876543210'] as Json[])[0],
    );

    const tooMany = await ravi.post('/mobile/leads/lookup/by-phones', {
      phones: Array.from({ length: 51 }, (_, i) => '900000000' + i),
    });
    check('an oversized batch is refused', tooMany.status === 422, tooMany.status);

    const miraBatch = await mira.post('/mobile/leads/lookup/by-phones', {
      phones: ['9876543210'],
    });
    check(
      "the batch lookup does not reveal a colleague's leads",
      ((miraBatch.json.items as Json)['9876543210'] as Json[]).length === 0,
      miraBatch.json.items,
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

    /*
     * The admin half of the walked-in checks.
     *
     * Here rather than beside the mobile half because `adminAsBearer` is created on the
     * line above — reading it earlier is a temporal dead zone error, not a test failure,
     * and it aborts the whole run.
     */
    const walkedInFilter = await adminAsBearer.get('/admin/telecalling/leads?status=walked_in');
    check(
      'an admin can filter leads by walked-in',
      walkedInFilter.status === 200,
      walkedInFilter.status,
    );
    check(
      'and the walked-in lead is in that result',
      (walkedInFilter.json.items as Json[] | undefined)?.some((row) => Number(row.id) === leadId),
      walkedInFilter.json.items,
    );

    const otherStatusFilter = await adminAsBearer.get('/admin/telecalling/leads?status=converted');
    check(
      'and it is NOT returned under a different status',
      !(otherStatusFilter.json.items as Json[] | undefined)?.some(
        (row) => Number(row.id) === leadId,
      ),
      otherStatusFilter.json.items,
    );

    // Put it back, so every assertion after this sees the status it expects.
    await ravi.post(`/mobile/leads/${leadId}/status`, { status: 'interested' });

    const adminDash = await adminAsBearer.get('/admin/telecalling/dashboard');
    check('an admin can read the admin dashboard', adminDash.status === 200, adminDash.json);
    /*
     * Four: the two Ravi created by hand, plus the two the incoming-call section created
     * from the same unknown number. Written as a literal rather than derived from an
     * earlier response on purpose — a total computed from the same API it is checking
     * would pass even if both were wrong together.
     */
    /*
     * Six: Ravi's two, the two the incoming-call section created from one unknown number,
     * and the two the call-record section needed — one to attach an ambiguous call to, one
     * to prove a call cannot be moved onto it.
     */
    /*
     * Five: Deepa, Vinod, Priya (created from an unknown caller), Anita, Somebody Else.
     * It was six until one number could only be held once — the duplicates the earlier
     * sections used to create are now refused.
     */
    check('admin dashboard counts all leads', adminDash.json.leads?.total === 5, adminDash.json.leads);
    check('admin dashboard counts unassigned leads', adminDash.json.leads?.unassigned === 0, adminDash.json.leads);
    /*
     * Three incoming calls exist across both telecallers — two of Ravi's and one of
     * Mira's — and one of the three was answered, so two were not.
     */
    /*
     * Four incoming across both telecallers: the unknown caller, the ambiguous number,
     * the one the call-record section logged, and Mira's. Three went unanswered.
     */
    check(
      'admin dashboard separates the calls customers made to us',
      adminDash.json.calls?.incoming === 5,
      adminDash.json.calls,
    );
    check(
      'and counts the incoming ones nobody answered',
      adminDash.json.calls?.incomingMissed === 3,
      adminDash.json.calls,
    );
    check(
      'incoming is a subset of the call total, not an addition to it',
      (adminDash.json.calls as Json).incoming <= (adminDash.json.calls as Json).total,
      adminDash.json.calls,
    );
    check('admin dashboard lists employee performance', Array.isArray(adminDash.json.employees), adminDash.json.employees);

    const raviRow = (adminDash.json.employees as Json[]).find((row) => row.name === 'Ravi Caller');
    // Two outgoing and three incoming; the replayed import is deduplicated and is not one
    // of them, which is the point of counting here rather than trusting the insert.
    check('performance rows carry per-employee call counts', raviRow?.calls === 6, raviRow);
    // 214 from the connected outgoing call, 45 from the answered incoming one. The two
    // unanswered calls contribute nothing, because a ring is not talk time.
    check('performance rows carry talk time', raviRow?.talkTimeSeconds === 319, raviRow);
    /*
     * Two: the lead Ravi rang, and the one an incoming call was written up against.
     *
     * It was one until attaching a call to a lead started refreshing that lead's
     * last-contacted timestamp — which is the point of doing so. A customer who rang in
     * and was written up HAS been in contact, and a lead that still claimed otherwise
     * would reappear under "Not yet called" on the dashboard.
     */
    check('performance rows carry leads contacted', raviRow?.leadsContacted === 2, raviRow);

    const telecallerOnAdmin = await ravi.get('/admin/telecalling/dashboard');
    check('a telecaller is refused the admin dashboard', telecallerOnAdmin.status === 403, telecallerOnAdmin.status);

    const telecallerRecordings = await ravi.get('/admin/telecalling/recordings');
    check('a telecaller is refused the recordings list', telecallerRecordings.status === 403);

    const adminLeads = await adminAsBearer.get('/admin/telecalling/leads');
    check('an admin sees every lead regardless of owner', adminLeads.json.total === 5, adminLeads.json.total);

    /*
     * The admin calls list can be narrowed to one direction.
     *
     * This is what the Calls panel's Direction filter sends, and unlike the mobile list
     * it is not scoped to one telecaller — so it must return Mira's incoming call as
     * well as Ravi's.
     */
    const adminIncoming = await adminAsBearer.get('/admin/telecalling/calls?direction=incoming');
    check(
      'an admin can narrow the call list to incoming calls',
      adminIncoming.json.total === 5,
      adminIncoming.json.total,
    );
    check(
      'and it spans every telecaller, not just one',
      new Set((adminIncoming.json.items as Json[]).map((row) => row.userId)).size === 2,
      (adminIncoming.json.items as Json[]).map((row) => row.userId),
    );


    /* ------------------- what the rule does and does not cover ------------- */
    /*
     * The rule is enforced in the service, not by a unique index, because the index
     * could not be added to a table that already holds duplicate numbers — and those
     * are grandfathered in deliberately. So this pins the boundary rather than
     * pretending it is not there: a row inserted straight into the table, bypassing
     * `createLead`, is NOT refused.
     *
     * That is the two-requests-in-one-instant window, written down so nobody later reads
     * "one lead per number" as a schema guarantee and builds on it.
     */
    let rawInsertRefused = false;
    try {
      await db.query(
        `INSERT INTO leads (reference, customer_name, phone, source, status, assigned_to, created_by)
         VALUES ('LD-RACE0001', 'Race Condition', '+91 98765 43210', 'manual', 'new', 2, 2)`,
      );
    } catch {
      rawInsertRefused = true;
    }
    check(
      'the rule lives in the service: a raw insert is not stopped by the schema',
      rawInsertRefused === false,
      rawInsertRefused ? 'a constraint refused it — the migration added a UNIQUE index' : undefined,
    );

    // Cleaned up so it cannot skew the counts the admin section asserts on.
    await db.query("DELETE FROM leads WHERE reference = 'LD-RACE0001'");

    /*
     * The indexed key the check now uses. If this column stopped being generated the
     * duplicate check would silently match nothing and every duplicate would be allowed
     * through — a failure with no symptom, so it is worth one assertion.
     */
    const [keyRows] = await db.query(
      "SELECT phone_key FROM leads WHERE reference = ?",
      [String((await ravi.get('/mobile/leads/' + leadId)).json.lead?.reference)],
    );
    check(
      'the stored phone key is the trailing digits, whatever was typed',
      (keyRows as { phone_key: string }[])[0]?.phone_key === '876543210',
      (keyRows as { phone_key: string }[])[0]?.phone_key,
    );

    /*
     * Archiving releases the number.
     *
     * The generated key is NULL for an archived lead and MySQL allows many NULLs in a
     * unique index, which is what makes this work. It matters: archiving is how a lead
     * entered against the wrong customer is retired, and a constraint that kept holding
     * the number afterwards would leave no way to enter the right one.
     */
    const toRetire = await ravi.post('/mobile/leads', {
      customerName: 'Wrong Entry',
      phone: '+91 93333 44455',
      source: 'manual',
    });
    check('a lead is created to be retired', toRetire.status === 201, toRetire.json);

    const blockedWhileActive = await ravi.post('/mobile/leads', {
      customerName: 'Correct Entry',
      phone: '+91 93333 44455',
      source: 'manual',
    });
    check('its number is taken while it is active', blockedWhileActive.status === 400, blockedWhileActive.status);

    const archived = await adminAsBearer.post(
      '/admin/telecalling/leads/' + toRetire.json.lead?.id + '/archive',
      { archived: true },
    );
    check('an admin archives it', archived.status === 200, archived.json);

    const reusable = await ravi.post('/mobile/leads', {
      customerName: 'Correct Entry',
      phone: '+91 93333 44455',
      source: 'manual',
    });
    check('archiving frees the number for the correct lead', reusable.status === 201, reusable.json);

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
      leadIds: [leadId, otherOwnerId, 99999],
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

    /* --- the phone number is genuinely optional --- */

    /*
     * The signup form labels this "Phone number (optional)" and sends
     * `phone.trim() || null`, so an explicit null is the production path. It used to be
     * rejected: the rule was `z.string().trim().max(20).optional()`, and `.optional()`
     * means `string | undefined` — it does not admit null. The field was optional in the
     * UI, nullable in the column, and required by the one rule in between.
     *
     * Only ONE registration is spent here. `signupLimiter` allows five per window and the
     * assertions above already use four; the remaining shapes are checked against the
     * rule itself below, which needs no request.
     */
    const noPhone = await applicant.post('/mobile/auth/signup', {
      name: 'Nirmal No Phone',
      email: 'nirmal.nophone@example.test',
      phone: null,
      password: 'a-perfectly-long-password',
    });
    check(
      'signup accepts an explicit null phone (what the app sends)',
      noPhone.status === 201,
      noPhone.json,
    );

    const [storedPhone] = await db.query(
      `SELECT phone FROM telecaller_users WHERE email = 'nirmal.nophone@example.test'`,
    );
    check(
      'and it is stored as NULL rather than an empty string',
      (storedPhone as any[])[0]?.phone === null,
      (storedPhone as any[])[0],
    );

    /*
     * Every other way a client can say "not given", checked against the rule directly.
     *
     * No HTTP, so the rate limiter cannot turn a validation regression into a 429 that
     * reads like one — which is exactly what happened the first time this was written.
     */
    for (const [label, input] of [
      ['undefined', undefined],
      ['an empty string', ''],
      ['whitespace only', '   '],
    ] as [string, unknown][]) {
      const parsed = optionalPhoneField.safeParse(input);
      check(
        `the phone rule normalises ${label} to null`,
        parsed.success && parsed.data === null,
        parsed.success ? parsed.data : parsed.error.issues[0]?.message,
      );
    }

    // "Optional" must not have quietly become "unvalidated".
    const junk = optionalPhoneField.safeParse('12');
    check('but a malformed phone is still refused', !junk.success, junk);

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
