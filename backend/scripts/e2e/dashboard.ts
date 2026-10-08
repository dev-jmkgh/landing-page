import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import type { ApiResponse, Client, E2EContext, Json } from './context';

/**
 * Dashboard: IST day boundaries on the tiles, the company line on every call figure, the
 * headcount card, and the analytics endpoint behind the charts.
 *
 * Owned by the dashboard feature (key `dashboard`). Runs after the calls section; the
 * rules every section follows are in `context.ts`.
 *
 * Fixtures are this section's own and are removed again at the end: staff `dash.*`, lead
 * numbers `+91 96660 922NN`, company numbers `+9196660921NN`. Calls, leads and follow-ups
 * are written straight into the database at FIXED instants either side of IST midnight,
 * on days nobody else writes to (31 Aug – 3 Sep 2025), so every boundary assertion is
 * exact and none depends on the hour the suite runs. Figures for the whole floor are
 * asserted as deltas; one fixture employee's figures exactly.
 */

/** Monday 1 September 2025: a new IST day, ISO week and month all begin at 00:00 on it. */
const X = '2025-09-01';
/** Sunday 31 August: the day, the ISO week and the month before. */
const XP = '2025-08-31';
const XN = '2025-09-02';
const XNN = '2025-09-03';

const E1_PHONE = '+919666092101';
const E2_PHONE = '+919666092102';

const CALL_FIELDS = [
  'total',
  'answered',
  'notAnswered',
  'outgoing',
  'incoming',
  'incomingNotAnswered',
  'talkTimeSeconds',
  'averageDurationSeconds',
] as const;

const FOLLOW_UP_FIELDS = [
  'total',
  'completed',
  'completedOnTime',
  'completedLate',
  'overdue',
  'upcoming',
  'cancelled',
] as const;

/** An IST wall-clock moment, as an instant. */
function ist(date: string, clock: string): Date {
  return new Date(`${date}T${clock}+05:30`);
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function sumOf(items: Json[], key: string): number {
  return items.reduce((total, item) => total + Number(item?.[key] ?? 0), 0);
}

/** `?a=1&b=2` from the entries that are set. */
function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Every field named in `expected` has exactly that value in `actual`. */
function matches(actual: Json | undefined | null, expected: Record<string, unknown>): boolean {
  if (actual === undefined || actual === null) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** `after.group.key - before.group.key`; NaN — never a pass — when either is missing. */
function delta(after: ApiResponse, before: ApiResponse, group: string, key: string): number {
  return Number(after.json[group]?.[key] ?? Number.NaN) - Number(before.json[group]?.[key] ?? Number.NaN);
}

export async function run(ctx: E2EContext): Promise<void> {
  const { check, utcDb, base, makeClient } = ctx;

  const time = await import('../../src/modules/telecalling/companyTime');
  const shared = await import('../../src/modules/telecalling/shared.schema');
  const repo = await import('../../src/modules/telecalling/dashboard/dashboard.repository');
  const service = await import('../../src/modules/telecalling/dashboard/dashboard.service');

  const D = time.companyDate();
  const Y = time.addDays(D, -1);
  const monthAgo = time.addDays(D, -29);
  const todayStart = time.companyDayStart(D);
  /** An instant `seconds` after (or before) 00:00 IST today. */
  const at = (seconds: number) => new Date(todayStart.getTime() + seconds * 1000);
  /** The current IST hour as a chart bucket key. */
  const istHour = () =>
    `${new Date(Date.now() + time.COMPANY_OFFSET_MINUTES * 60_000).toISOString().slice(0, 13)}:00`;

  /** True when each frame starts the day after the previous one ended. */
  const contiguous = (frames: Json[]) =>
    frames.every((frame, index) => {
      if (index === 0) return true;
      const previous = frames[index - 1]?.to;
      return (
        typeof previous === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(previous) &&
        frame.from === time.addDays(previous, 1)
      );
    });

  const analytics = (client: Client, params: Record<string, string | number | undefined>) =>
    client.get(`/admin/telecalling/dashboard/analytics${qs(params)}`);
  const dashboard = (client: Client, params: Record<string, string | number | undefined> = {}) =>
    client.get(`/admin/telecalling/dashboard${qs(params)}`);

  /* ------------------------------------------------------------ fixtures */

  const fixtures = { calls: [] as number[], leads: [] as number[] };

  async function insertCall(call: {
    userId: number;
    startedAt: Date;
    outcome: string;
    direction?: 'outgoing' | 'incoming';
    durationSeconds?: number;
    leadId?: number | null;
    simMatch?: string | null;
    receivedOnPhone?: string | null;
  }): Promise<number> {
    const [result] = (await utcDb.execute(
      `INSERT INTO calls
         (lead_id, user_id, phone, direction, outcome, channel, source, duration_seconds,
          started_at, sim_match, received_on_phone)
       VALUES (?, ?, '+91 96660 92290', ?, ?, 'device', 'manual', ?, ?, ?, ?)`,
      [
        call.leadId ?? null,
        call.userId,
        call.direction ?? 'outgoing',
        call.outcome,
        call.durationSeconds ?? 0,
        call.startedAt,
        call.simMatch ?? null,
        call.receivedOnPhone ?? null,
      ],
    )) as [ResultSetHeader, unknown];
    fixtures.calls.push(result.insertId);
    return result.insertId;
  }

  async function insertLead(lead: {
    reference: string;
    name: string;
    phone: string;
    status: string;
    assignedTo: number;
    createdAt?: Date;
    convertedAt?: Date | null;
    archived?: boolean;
  }): Promise<number> {
    const createdAt = lead.createdAt ?? new Date();
    const [result] = (await utcDb.execute(
      `INSERT INTO leads
         (reference, customer_name, phone, source, status, assigned_to, assigned_at, created_by,
          converted_at, is_archived, created_at)
       VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
      [
        lead.reference,
        lead.name,
        lead.phone,
        lead.status,
        lead.assignedTo,
        createdAt,
        lead.assignedTo,
        lead.convertedAt ?? null,
        lead.archived ? 1 : 0,
        createdAt,
      ],
    )) as [ResultSetHeader, unknown];
    fixtures.leads.push(result.insertId);
    return result.insertId;
  }

  /** Follow-ups go with their lead when the fixtures are removed. */
  async function insertFollowUp(followUp: {
    leadId: number;
    assignedTo: number;
    dueAt: Date;
    state?: 'pending' | 'completed' | 'cancelled';
    completedAt?: Date;
  }): Promise<void> {
    const state = followUp.state ?? 'pending';
    await utcDb.execute(
      `INSERT INTO follow_ups
         (lead_id, assigned_to, created_by, due_at, state, completed_at, completed_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Dashboard fixture.')`,
      [
        followUp.leadId,
        followUp.assignedTo,
        followUp.assignedTo,
        followUp.dueAt,
        state,
        followUp.completedAt ?? null,
        state === 'completed' ? followUp.assignedTo : null,
      ],
    );
  }

  /** Deletes every fixture row; returns how many are still there (0 when clean). */
  async function removeFixtures(): Promise<number> {
    const marks = (ids: number[]) => ids.map(() => '?').join(', ');
    if (fixtures.calls.length > 0) {
      await utcDb.query(`DELETE FROM calls WHERE id IN (${marks(fixtures.calls)})`, fixtures.calls);
    }
    if (fixtures.leads.length > 0) {
      // Their follow-ups, notes, timeline rows and notifications cascade with them.
      await utcDb.query(`DELETE FROM leads WHERE id IN (${marks(fixtures.leads)})`, fixtures.leads);
    }

    const [rows] = (await utcDb.query(
      `SELECT
         (SELECT COUNT(*) FROM calls WHERE id IN (${fixtures.calls.length > 0 ? marks(fixtures.calls) : 'NULL'})) +
         (SELECT COUNT(*) FROM leads WHERE id IN (${fixtures.leads.length > 0 ? marks(fixtures.leads) : 'NULL'})) +
         (SELECT COUNT(*) FROM follow_ups WHERE lead_id IN (${fixtures.leads.length > 0 ? marks(fixtures.leads) : 'NULL'})) AS remaining`,
      [...fixtures.calls, ...fixtures.leads, ...fixtures.leads],
    )) as [Json[], unknown];
    return Number(rows[0]?.remaining ?? -1);
  }

  try {
    /* ---------------------------------------------------------- headcount */
    console.log('\ndashboard — the headcount card');

    // A fresh admin of our own, so this section never rides on a token minted long ago.
    const admin = await ctx.createSignedInEmployee({
      name: 'Dash Admin',
      email: 'dash.admin@example.test',
      role: 'admin',
    });
    const adminClient = admin.client;

    const beforeHire = await dashboard(adminClient);
    const headcountBefore = (beforeHire.json.headcount ?? {}) as Json;
    check(
      'the dashboard sends the headcount under its own key',
      beforeHire.status === 200 &&
        typeof headcountBefore.total === 'number' &&
        typeof headcountBefore.active === 'number',
      { status: beforeHire.status, headcount: beforeHire.json.headcount },
    );
    check(
      'and the performance rows still arrive as employees, so neither overwrites the other',
      Array.isArray(beforeHire.json.employees),
      typeof beforeHire.json.employees,
    );

    const e1 = await ctx.createSignedInEmployee({
      name: 'Dash Caller One',
      email: 'dash.one@example.test',
      role: 'telecaller',
      companyPhone: E1_PHONE,
    });
    const e2 = await ctx.createSignedInEmployee({
      name: 'Dash Caller Two',
      email: 'dash.two@example.test',
      role: 'telecaller',
      companyPhone: E2_PHONE,
    });
    const supervisor = await ctx.createSignedInEmployee({
      name: 'Dash Supervisor',
      email: 'dash.supervisor@example.test',
      role: 'supervisor',
    });

    const afterHire = await dashboard(adminClient);
    const headcountAfter = (afterHire.json.headcount ?? {}) as Json;
    check(
      'three approved, active hires raise both headcount figures by three',
      Number(headcountAfter.total) - Number(headcountBefore.total) === 3 &&
        Number(headcountAfter.active) - Number(headcountBefore.active) === 3,
      { before: headcountBefore, after: headcountAfter },
    );

    const activeStaff = await adminClient.get(
      '/admin/telecalling/employees?approval=approved&active=true&pageSize=1',
    );
    const approvedStaff = await adminClient.get('/admin/telecalling/employees?approval=approved&pageSize=1');
    check(
      'the headcount is the employees list the card opens: active and approved, of all approved',
      activeStaff.json.total === headcountAfter.active && approvedStaff.json.total === headcountAfter.total,
      { active: activeStaff.json.total, approved: approvedStaff.json.total, headcount: headcountAfter },
    );

    const performanceRows = list(afterHire.json.employees);
    check(
      'every performance row splits its calls by direction, and the parts add up',
      performanceRows.length > 0 &&
        performanceRows.every(
          (row) =>
            typeof row.outgoing === 'number' &&
            typeof row.incoming === 'number' &&
            typeof row.incomingMissed === 'number' &&
            row.outgoing + row.incoming === row.calls &&
            row.incomingMissed <= row.incoming,
        ),
      performanceRows.map((row) => [row.name, row.calls, row.outgoing, row.incoming, row.incomingMissed]),
    );

    /* ------------------------------------------------- access and refusals */
    console.log('\ndashboard — analytics: who may read them, and what is refused');

    const anonymous = await makeClient(base).get('/admin/telecalling/dashboard/analytics');
    check('the analytics refuse an unauthenticated request', anonymous.status === 401, anonymous.status);

    const asTelecaller = await analytics(e1.client, {});
    check('a telecaller is refused the analytics', asTelecaller.status === 403, asTelecaller.status);

    const asSupervisor = await analytics(supervisor.client, { from: D, to: D });
    check('a supervisor may read them', asSupervisor.status === 200, {
      status: asSupervisor.status,
      json: asSupervisor.json,
    });

    const reversed = await analytics(adminClient, { from: D, to: time.addDays(D, -6) });
    check(
      'a reversed range is refused with a 422 that names the start date',
      reversed.status === 422 &&
        reversed.json.code === 'validation_failed' &&
        typeof reversed.json.errors?.from === 'string',
      reversed.json,
    );

    const unknownGranularity = await analytics(adminClient, { granularity: 'fortnight' });
    check(
      'so is a granularity that does not exist',
      unknownGranularity.status === 422 && typeof unknownGranularity.json.errors?.granularity === 'string',
      unknownGranularity.json,
    );

    const impossibleDate = await analytics(adminClient, { from: '2026-02-30', to: D });
    check(
      'and a date that is not on the calendar',
      impossibleDate.status === 422 && typeof impossibleDate.json.errors?.from === 'string',
      impossibleDate.json,
    );

    const notAnId = await analytics(adminClient, { userId: 'everyone' });
    check(
      'and an employee filter that is not an id',
      notAnId.status === 422 && typeof notAnId.json.errors?.userId === 'string',
      notAnId.json,
    );

    const tooLong = await analytics(adminClient, { from: '1990-01-01', to: D });
    check(
      'a range too long to chart even by month is a 400 that says so',
      tooLong.status === 400 &&
        tooLong.json.message === 'That period is too long to chart. Choose a shorter range.',
      tooLong.json,
    );

    /* -------------------------------------------------- frames and shape */
    console.log('\ndashboard — analytics: frames and granularity');

    const weekAgo = time.addDays(D, -6);
    const lastWeek = await analytics(adminClient, { from: weekAgo, to: D, granularity: 'day' });
    const lastWeekCalls = list(lastWeek.json.calls);
    const lastWeekLeads = list(lastWeek.json.leads);
    const lastWeekStatuses = list(lastWeek.json.leadsByStatus);
    check(
      'seven days by day: the effective range and granularity come back, one frame per day',
      lastWeek.status === 200 &&
        lastWeek.json.timezone === '+05:30' &&
        lastWeek.json.granularity === 'day' &&
        lastWeek.json.range?.from === weekAgo &&
        lastWeek.json.range?.to === D &&
        lastWeekCalls.length === 7 &&
        lastWeekLeads.length === 7,
      {
        status: lastWeek.status,
        range: lastWeek.json.range,
        granularity: lastWeek.json.granularity,
        calls: lastWeekCalls.length,
        leads: lastWeekLeads.length,
      },
    );
    check(
      'quiet days are there as zeros, in order, each frame covering its own day',
      lastWeekCalls.every(
        (frame, index) =>
          frame.bucket === time.addDays(weekAgo, index) &&
          frame.from === frame.bucket &&
          frame.to === frame.bucket &&
          lastWeekLeads[index]?.bucket === frame.bucket,
      ),
      lastWeekCalls.map((frame) => [frame.bucket, frame.from, frame.to]),
    );
    check(
      'every lead status is listed, in vocabulary order, zeros included',
      lastWeekStatuses.map((row) => row.status).join(',') === shared.LEAD_STATUSES.join(','),
      lastWeekStatuses,
    );
    check(
      'every figure is a number, never null',
      lastWeekCalls.every((frame) => CALL_FIELDS.every((key) => typeof frame[key] === 'number')) &&
        lastWeekLeads.every(
          (frame) => typeof frame.created === 'number' && typeof frame.converted === 'number',
        ) &&
        lastWeekStatuses.every((row) => typeof row.count === 'number') &&
        FOLLOW_UP_FIELDS.every((key) => typeof lastWeek.json.followUps?.[key] === 'number'),
      { call: lastWeekCalls[0], lead: lastWeekLeads[0], followUps: lastWeek.json.followUps },
    );
    check(
      'in every frame, answered + not answered and outgoing + incoming each make the total',
      lastWeekCalls.every(
        (frame) =>
          frame.answered + frame.notAnswered === frame.total &&
          frame.outgoing + frame.incoming === frame.total &&
          frame.incomingNotAnswered <= frame.incoming,
      ),
      lastWeekCalls,
    );
    const lastWeekDue = (lastWeek.json.followUps ?? {}) as Json;
    check(
      'and the follow-up slices add up to the follow-ups due',
      lastWeekDue.completed + lastWeekDue.overdue + lastWeekDue.upcoming + lastWeekDue.cancelled ===
        lastWeekDue.total && lastWeekDue.completedOnTime + lastWeekDue.completedLate === lastWeekDue.completed,
      lastWeekDue,
    );

    const byWeek = await analytics(adminClient, { from: monthAgo, to: D, granularity: 'week' });
    const byDay = await analytics(adminClient, { from: monthAgo, to: D, granularity: 'day' });
    const weekFrames = list(byWeek.json.calls);
    const dayFrames = list(byDay.json.calls);
    check(
      'weekly frames are keyed by Monday, the first clamped to the start of the range and the last to its end',
      byWeek.json.granularity === 'week' &&
        weekFrames.length > 0 &&
        weekFrames.every((frame) => new Date(`${String(frame.bucket)}T00:00:00Z`).getUTCDay() === 1) &&
        weekFrames[0]?.bucket === time.mondayOf(monthAgo) &&
        weekFrames[0]?.from === monthAgo &&
        weekFrames[weekFrames.length - 1]?.to === D &&
        contiguous(weekFrames),
      weekFrames.map((frame) => [frame.bucket, frame.from, frame.to]),
    );
    check(
      'and they hold exactly what the daily frames hold',
      dayFrames.length === 30 &&
        ['total', 'answered', 'notAnswered', 'incoming', 'talkTimeSeconds'].every(
          (key) => sumOf(weekFrames, key) === sumOf(dayFrames, key),
        ) &&
        sumOf(list(byWeek.json.leads), 'created') === sumOf(list(byDay.json.leads), 'created') &&
        sumOf(list(byWeek.json.leads), 'converted') === sumOf(list(byDay.json.leads), 'converted'),
      { week: sumOf(weekFrames, 'total'), day: sumOf(dayFrames, 'total'), days: dayFrames.length },
    );

    const longAgo = time.addDays(D, -299);
    const byMonth = await analytics(adminClient, { from: longAgo, to: D });
    const monthFrames = list(byMonth.json.calls);
    check(
      'three hundred days chart by month on auto: frames keyed by the 1st and clamped at both ends',
      byMonth.json.granularity === 'month' &&
        monthFrames.length > 0 &&
        monthFrames.every((frame) => /^\d{4}-\d{2}-01$/.test(String(frame.bucket))) &&
        monthFrames[0]?.from === longAgo &&
        monthFrames[monthFrames.length - 1]?.to === D &&
        contiguous(monthFrames),
      monthFrames.map((frame) => [frame.bucket, frame.from, frame.to]),
    );

    const hourBefore = istHour();
    const todayHourly = await analytics(adminClient, { from: D, to: D });
    const hourAfter = istHour();
    const todayFrames = list(todayHourly.json.calls);
    const lastTodayFrame = String(todayFrames[todayFrames.length - 1]?.bucket ?? '');
    // A later hour is kept only when it already holds something (a handset clock running
    // fast) — another section's row must not make this check depend on what they wrote.
    const lastTodayLeads = list(todayHourly.json.leads)[todayFrames.length - 1];
    const lastFrameHoldsRows =
      Number(todayFrames[todayFrames.length - 1]?.total ?? 0) > 0 ||
      Number(lastTodayLeads?.created ?? 0) > 0 ||
      Number(lastTodayLeads?.converted ?? 0) > 0;
    check(
      'one day charts by hour on auto, from 00:00 IST to the current IST hour',
      todayHourly.json.granularity === 'hour' &&
        todayFrames[0]?.bucket === `${D}T00:00` &&
        todayFrames.every(
          (frame) => String(frame.bucket).startsWith(`${D}T`) && frame.from === D && frame.to === D,
        ) &&
        lastTodayFrame >= hourBefore &&
        (lastTodayFrame <= hourAfter || lastFrameHoldsRows),
      { granularity: todayHourly.json.granularity, first: todayFrames[0]?.bucket, last: lastTodayFrame, hourBefore, hourAfter },
    );

    const quarter = await analytics(adminClient, { from: time.addDays(D, -89), to: D });
    check(
      'ninety days chart by week on auto, thirty by day',
      quarter.json.granularity === 'week' && byDay.json.granularity === 'day',
      [quarter.json.granularity, byDay.json.granularity],
    );

    const hourlyThreeDays = await analytics(adminClient, {
      from: time.addDays(D, -2),
      to: D,
      granularity: 'hour',
    });
    check(
      'an hourly request over three days falls back to daily rather than failing',
      hourlyThreeDays.status === 200 &&
        hourlyThreeDays.json.granularity === 'day' &&
        list(hourlyThreeDays.json.calls).length === 3,
      { status: hourlyThreeDays.status, granularity: hourlyThreeDays.json.granularity },
    );

    const dailyTooMany = await analytics(adminClient, {
      from: time.addDays(D, -400),
      to: D,
      granularity: 'day',
    });
    check(
      'a daily request that would need over 400 frames is drawn weekly instead',
      dailyTooMany.status === 200 &&
        dailyTooMany.json.granularity === 'week' &&
        list(dailyTooMany.json.calls).length <= time.MAX_CHART_FRAMES,
      { status: dailyTooMany.status, granularity: dailyTooMany.json.granularity },
    );

    const openEnded = await analytics(adminClient, { from: time.addDays(D, -3) });
    check(
      'with no end date the range runs to today',
      openEnded.json.range?.from === time.addDays(D, -3) && openEnded.json.range?.to === D,
      openEnded.json.range,
    );

    const future = time.addDays(D, 5);
    const fromFuture = await analytics(adminClient, { from: future });
    check(
      'a start in the future with no end charts that one day, never a reversed range',
      fromFuture.status === 200 &&
        fromFuture.json.range?.from === future &&
        fromFuture.json.range?.to === future,
      { status: fromFuture.status, range: fromFuture.json.range },
    );
    const futureFrames = list(fromFuture.json.calls);
    check(
      'and draws all 24 of its hours as zero-filled frames — none of them is cut off at the current hour',
      fromFuture.json.granularity === 'hour' &&
        futureFrames.length === 24 &&
        list(fromFuture.json.leads).length === 24 &&
        futureFrames.every(
          (frame, index) =>
            frame.bucket === `${future}T${String(index).padStart(2, '0')}:00` &&
            frame.from === future &&
            frame.to === future &&
            typeof frame.total === 'number',
        ),
      {
        granularity: fromFuture.json.granularity,
        frames: futureFrames.length,
        first: futureFrames[0]?.bucket,
        last: futureFrames[futureFrames.length - 1]?.bucket,
      },
    );

    /* ------------------------------- IST boundaries, fixed instants (E1) */
    console.log('\ndashboard — IST day boundaries and the company line, at fixed instants');

    const xBefore = await dashboard(adminClient, { from: X, to: X });
    const windowBefore = await dashboard(adminClient, { from: XP, to: XN });

    const leadNew = await insertLead({
      reference: 'LD-DASH0001',
      name: 'Dash Lead New',
      phone: '+91 96660 92211',
      status: 'new',
      assignedTo: e1.id,
      createdAt: ist(X, '00:00:00'),
    });
    const leadConverted = await insertLead({
      reference: 'LD-DASH0002',
      name: 'Dash Lead Converted',
      phone: '+91 96660 92212',
      status: 'converted',
      assignedTo: e1.id,
      createdAt: ist(XP, '23:59:59'),
      convertedAt: ist(X, '00:00:00'),
    });
    await insertLead({
      reference: 'LD-DASH0003',
      name: 'Dash Lead Archived',
      phone: '+91 96660 92213',
      status: 'interested',
      assignedTo: e1.id,
      createdAt: ist(X, '12:00:00'),
      archived: true,
    });

    // The first and the last second of X, and the seconds either side of it.
    await insertCall({
      userId: e1.id,
      leadId: leadNew,
      outcome: 'answered',
      durationSeconds: 60,
      startedAt: ist(X, '00:00:00'),
    });
    await insertCall({ userId: e1.id, outcome: 'busy', startedAt: ist(X, '23:59:59') });
    await insertCall({
      userId: e1.id,
      leadId: leadConverted,
      outcome: 'answered',
      durationSeconds: 45,
      startedAt: ist(XP, '23:59:59'),
    });
    await insertCall({ userId: e1.id, outcome: 'no_answer', startedAt: ist(XN, '00:00:00') });
    // An incoming call verified on the company SIM, and an older one nobody could verify.
    await insertCall({
      userId: e1.id,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: ist(X, '10:00:00'),
      simMatch: 'confirmed',
      receivedOnPhone: E1_PHONE,
    });
    const legacyId = await insertCall({
      userId: e1.id,
      direction: 'incoming',
      outcome: 'answered',
      durationSeconds: 30,
      startedAt: ist(X, '11:00:00'),
      simMatch: null,
    });

    await insertFollowUp({
      leadId: leadNew,
      assignedTo: e1.id,
      dueAt: ist(X, '12:00:00'),
      state: 'completed',
      completedAt: ist(X, '11:00:00'),
    });
    await insertFollowUp({
      leadId: leadNew,
      assignedTo: e1.id,
      dueAt: ist(X, '13:00:00'),
      state: 'completed',
      completedAt: ist(X, '15:00:00'),
    });
    await insertFollowUp({ leadId: leadNew, assignedTo: e1.id, dueAt: ist(X, '14:00:00'), state: 'cancelled' });
    await insertFollowUp({ leadId: leadNew, assignedTo: e1.id, dueAt: ist(X, '16:00:00') });
    await insertFollowUp({
      leadId: leadConverted,
      assignedTo: e1.id,
      dueAt: ist(X, '00:00:30'),
      state: 'completed',
      completedAt: ist(X, '00:00:20'),
    });
    await insertFollowUp({ leadId: leadConverted, assignedTo: e1.id, dueAt: ist(XP, '23:59:30') });
    await insertFollowUp({ leadId: leadNew, assignedTo: e1.id, dueAt: ist(time.addDays(D, 10), '12:00:00') });

    const xAfter = await dashboard(adminClient, { from: X, to: X });
    const windowAfter = await dashboard(adminClient, { from: XP, to: XN });
    check(
      'the day tiles count the first and the last second of the IST day, and nothing either side',
      delta(xAfter, xBefore, 'calls', 'total') === 3 &&
        delta(xAfter, xBefore, 'calls', 'answered') === 1 &&
        delta(xAfter, xBefore, 'calls', 'missed') === 2 &&
        delta(xAfter, xBefore, 'calls', 'talkTimeSeconds') === 60,
      { before: xBefore.json.calls, after: xAfter.json.calls },
    );
    check(
      'only the incoming call verified on the company SIM counts as incoming',
      delta(xAfter, xBefore, 'calls', 'incoming') === 1 &&
        delta(xAfter, xBefore, 'calls', 'incomingMissed') === 1,
      { before: xBefore.json.calls, after: xAfter.json.calls },
    );
    check(
      "a lead created at 00:00 IST is that day's; one created a second earlier, or archived, is not",
      delta(xAfter, xBefore, 'leads', 'total') === 1 && delta(xAfter, xBefore, 'leads', 'converted') === 0,
      { before: xBefore.json.leads, after: xAfter.json.leads },
    );
    check(
      'across the three days every fixture call and lead counts once',
      delta(windowAfter, windowBefore, 'calls', 'total') === 5 &&
        delta(windowAfter, windowBefore, 'calls', 'answered') === 2 &&
        delta(windowAfter, windowBefore, 'calls', 'talkTimeSeconds') === 105 &&
        delta(windowAfter, windowBefore, 'leads', 'total') === 2 &&
        delta(windowAfter, windowBefore, 'leads', 'converted') === 1,
      {
        before: { calls: windowBefore.json.calls, leads: windowBefore.json.leads },
        after: { calls: windowAfter.json.calls, leads: windowAfter.json.leads },
      },
    );

    const e1Days = await analytics(adminClient, { from: XP, to: XN, granularity: 'day', userId: e1.id });
    const e1DayCalls = list(e1Days.json.calls);
    check(
      "one employee's calls by IST day: 23:59:59 stays on its day and 00:00:00 starts the next",
      e1Days.status === 200 &&
        e1DayCalls.length === 3 &&
        matches(e1DayCalls[0], {
          bucket: XP,
          total: 1,
          answered: 1,
          notAnswered: 0,
          outgoing: 1,
          incoming: 0,
          talkTimeSeconds: 45,
          averageDurationSeconds: 45,
        }) &&
        matches(e1DayCalls[1], {
          bucket: X,
          total: 3,
          answered: 1,
          notAnswered: 2,
          outgoing: 2,
          incoming: 1,
          incomingNotAnswered: 1,
          talkTimeSeconds: 60,
          averageDurationSeconds: 60,
        }) &&
        matches(e1DayCalls[2], { bucket: XN, total: 1, answered: 0, notAnswered: 1, outgoing: 1, incoming: 0 }),
      e1DayCalls,
    );
    const e1DayLeads = list(e1Days.json.leads);
    check(
      'leads count on the IST day they were created, conversions on the day they were converted',
      matches(e1DayLeads[0], { bucket: XP, created: 1, converted: 0 }) &&
        matches(e1DayLeads[1], { bucket: X, created: 1, converted: 1 }) &&
        matches(e1DayLeads[2], { bucket: XN, created: 0, converted: 0 }),
      e1DayLeads,
    );
    const e1Statuses = Object.fromEntries(
      list(e1Days.json.leadsByStatus).map((row) => [String(row.status), Number(row.count)]),
    );
    check(
      "the status breakdown counts the employee's leads created in the range, leaving out the archived one",
      e1Statuses.new === 1 &&
        e1Statuses.converted === 1 &&
        e1Statuses.interested === 0 &&
        sumOf(list(e1Days.json.leadsByStatus), 'count') === 2,
      e1Statuses,
    );
    check(
      'follow-ups due in the range, by what became of them',
      matches(e1Days.json.followUps, {
        total: 6,
        completed: 3,
        completedOnTime: 2,
        completedLate: 1,
        overdue: 2,
        upcoming: 0,
        cancelled: 1,
      }),
      e1Days.json.followUps,
    );

    const e1OnX = await analytics(adminClient, { from: X, to: X, granularity: 'day', userId: e1.id });
    check(
      'a follow-up due at 00:00:30 IST is due that day; one due at 23:59:30 the evening before is not',
      matches(e1OnX.json.followUps, {
        total: 5,
        completed: 3,
        completedOnTime: 2,
        completedLate: 1,
        overdue: 1,
        upcoming: 0,
        cancelled: 1,
      }),
      e1OnX.json.followUps,
    );

    const e1Open = await analytics(adminClient, { from: X, userId: e1.id });
    check(
      'with no end date, follow-ups due in the future count as upcoming, though the frames stop at today',
      e1Open.json.range?.to === D && matches(e1Open.json.followUps, { total: 6, upcoming: 1, overdue: 1 }),
      { range: e1Open.json.range, followUps: e1Open.json.followUps },
    );

    const e1Hours = await analytics(adminClient, { from: X, to: X, granularity: 'hour', userId: e1.id });
    const e1HourCalls = list(e1Hours.json.calls);
    const e1HourLeads = list(e1Hours.json.leads);
    check(
      'by hour, a past day has all 24 IST hours, with the boundary calls in the first and the last',
      e1Hours.json.granularity === 'hour' &&
        e1HourCalls.length === 24 &&
        matches(e1HourCalls[0], { bucket: `${X}T00:00`, total: 1, answered: 1 }) &&
        matches(e1HourCalls[10], { bucket: `${X}T10:00`, incoming: 1, incomingNotAnswered: 1 }) &&
        matches(e1HourCalls[23], { bucket: `${X}T23:00`, total: 1, notAnswered: 1 }) &&
        sumOf(e1HourCalls, 'total') === 3,
      e1HourCalls.filter((frame) => frame.total > 0),
    );
    check(
      'and the unverified incoming call at 11:00 is not in it — it is not on the company line',
      matches(e1HourCalls[11], { bucket: `${X}T11:00`, total: 0, incoming: 0, talkTimeSeconds: 0 }),
      e1HourCalls[11],
    );
    check(
      'a lead created, and another converted, at 00:00:00 IST land in the first hour',
      matches(e1HourLeads[0], { created: 1, converted: 1 }) && sumOf(e1HourLeads, 'created') === 1,
      e1HourLeads.filter((frame) => frame.created > 0 || frame.converted > 0),
    );

    const e1Weeks = await analytics(adminClient, { from: XP, to: XN, granularity: 'week', userId: e1.id });
    const e1WeekCalls = list(e1Weeks.json.calls);
    check(
      'by ISO week, Sunday 23:59:59 IST closes one week and Monday 00:00:00 IST opens the next',
      e1WeekCalls.length === 2 &&
        matches(e1WeekCalls[0], { bucket: '2025-08-25', from: XP, to: XP, total: 1 }) &&
        matches(e1WeekCalls[1], { bucket: X, from: X, to: XN, total: 4 }),
      e1WeekCalls,
    );

    const e1Months = await analytics(adminClient, { from: XP, to: XN, granularity: 'month', userId: e1.id });
    const e1MonthCalls = list(e1Months.json.calls);
    check(
      'by month, the last second of August IST stays in August',
      e1MonthCalls.length === 2 &&
        matches(e1MonthCalls[0], { bucket: '2025-08-01', from: XP, to: XP, total: 1 }) &&
        matches(e1MonthCalls[1], { bucket: '2025-09-01', from: X, to: XN, total: 4 }) &&
        matches(list(e1Months.json.leads)[1], { created: 1, converted: 1 }),
      { calls: e1MonthCalls, leads: e1Months.json.leads },
    );

    /* --------------------------------------------- the Reports call trend */
    console.log('\ndashboard — the Reports call trend on IST periods');

    const trendPeriods = async (granularity: string) => {
      const trend = await adminClient.get(
        `/admin/telecalling/reports/calls${qs({ granularity, from: XP, to: XN, userId: e1.id })}`,
      );
      return list(trend.json.items);
    };
    const trendDays = await trendPeriods('day');
    check(
      'daily periods are IST days, and the unverified call is not in them',
      trendDays.map((point) => `${point.period}:${point.calls}`).join(',') === `${XP}:1,${X}:3,${XN}:1` &&
        matches(trendDays[1], { answered: 1, missed: 2, talkTimeSeconds: 60 }),
      trendDays,
    );
    const trendWeeks = await trendPeriods('week');
    check(
      'weekly periods keep their ISO labels and split at Monday 00:00 IST',
      trendWeeks.map((point) => `${point.period}:${point.calls}`).join(',') === '2025-W35:1,2025-W36:4',
      trendWeeks,
    );
    const trendMonths = await trendPeriods('month');
    check(
      'monthly periods split at 00:00 IST on the 1st',
      trendMonths.map((point) => `${point.period}:${point.calls}`).join(',') === '2025-08:1,2025-09:4',
      trendMonths,
    );

    /* ------------------------------- performance rows and activity summary */
    console.log('\ndashboard — performance rows and the activity summary');

    const expectedRow = {
      calls: 3,
      answered: 1,
      missed: 2,
      outgoing: 2,
      incoming: 1,
      incomingMissed: 1,
      talkTimeSeconds: 60,
      averageDurationSeconds: 60,
      followUpsCompleted: 3,
      followUpsPending: 3,
      leadsAssigned: 2,
      leadsContacted: 1,
      leadsConverted: 1,
      conversionRate: 50,
    };
    const dashboardRow = list(xAfter.json.employees).find((row) => row.userId === e1.id);
    check(
      "the dashboard's performance row counts the employee's IST day, company line only",
      matches(dashboardRow, expectedRow),
      dashboardRow,
    );
    const performanceReport = await adminClient.get(
      `/admin/telecalling/reports/performance${qs({ from: X, to: X })}`,
    );
    const reportRow = list(performanceReport.json.items).find((row) => row.userId === e1.id);
    check('and the Reports screen shows the same row', matches(reportRow, expectedRow), reportRow);

    const instantRows = await repo.employeePerformance({
      start: time.companyDayStart(X),
      end: time.companyDayEnd(X),
    });
    const instantRow = instantRows.find((row) => row.userId === e1.id) as Json | undefined;
    check(
      'an instant window covering the IST day gives the same row as the calendar date',
      matches(instantRow, expectedRow),
      instantRow,
    );
    const morningRows = await repo.employeePerformance({ start: ist(X, '05:00:00'), end: ist(X, '12:00:00') });
    const morningRow = morningRows.find((row) => row.userId === e1.id) as Json | undefined;
    check(
      'and a narrower window counts only its own instants',
      matches(morningRow, {
        calls: 1,
        outgoing: 0,
        incoming: 1,
        incomingMissed: 1,
        followUpsCompleted: 1,
        leadsConverted: 0,
      }),
      morningRow,
    );
    const instantBreakdown = await repo.leadBreakdown('status', {
      start: time.companyDayStart(X),
      end: time.companyDayEnd(X),
    });
    check(
      'the lead breakdown takes an instant window too',
      instantBreakdown.some((row) => row.key === 'new' && row.total >= 1),
      instantBreakdown,
    );

    const overdueAt3pm = (await repo.overdueByEmployee(0, ist(X, '15:00:00'))).find(
      (group) => group.userId === e1.id,
    );
    const overdueAt5pm = (await repo.overdueByEmployee(0, ist(X, '17:00:00'))).find(
      (group) => group.userId === e1.id,
    );
    check(
      'overdue can be measured as at a given moment, for a report about a day gone by',
      overdueAt3pm?.overdue === 1 &&
        overdueAt5pm?.overdue === 2 &&
        overdueAt5pm?.oldestDueAt === ist(XP, '23:59:30').toISOString(),
      { at3pm: overdueAt3pm, at5pm: overdueAt5pm },
    );

    const expectedSummary = {
      calls: 3,
      outgoingCalls: 2,
      incomingCalls: 1,
      answered: 1,
      missed: 2,
      talkTimeSeconds: 60,
      averageDurationSeconds: 60,
      followUpsCompleted: 3,
      followUpsPending: 3,
      leadsContacted: 1,
      leadsConverted: 1,
    };
    const profile = await adminClient.get(`/admin/telecalling/employees/${e1.id}${qs({ from: X, to: X })}`);
    check(
      "the employee page's summary counts the IST day and splits calls into made and received",
      matches(profile.json.summary, expectedSummary),
      profile.json.summary,
    );
    const ownActivity = await e1.client.get(`/mobile/activity${qs({ from: X, to: X })}`);
    check(
      "and the app's My activity says the same",
      ownActivity.status === 200 && matches(ownActivity.json, expectedSummary),
      ownActivity.json,
    );

    /* ------------------------------ the unverified call, made verified */
    console.log('\ndashboard — an unverified incoming call is in no figure');

    await utcDb.execute("UPDATE calls SET sim_match = 'confirmed', received_on_phone = ? WHERE id = ?", [
      E1_PHONE,
      legacyId,
    ]);
    const verifiedCharts = await analytics(adminClient, { from: X, to: X, granularity: 'day', userId: e1.id });
    const verifiedTiles = await dashboard(adminClient, { from: X, to: X });
    const verifiedSummary = await e1.client.get(`/mobile/activity${qs({ from: X, to: X })}`);
    const verifiedRow = list(verifiedTiles.json.employees).find((row) => row.userId === e1.id);
    check(
      'the same row counts everywhere once it is verified on the company SIM — so the line is what kept it out',
      matches(list(verifiedCharts.json.calls)[0], { total: 4, incoming: 2, talkTimeSeconds: 90 }) &&
        delta(verifiedTiles, xAfter, 'calls', 'incoming') === 1 &&
        delta(verifiedTiles, xAfter, 'calls', 'talkTimeSeconds') === 30 &&
        matches(verifiedRow, { calls: 4, incoming: 2 }) &&
        matches(verifiedSummary.json, { calls: 4, incomingCalls: 2 }),
      {
        charts: list(verifiedCharts.json.calls)[0],
        tiles: verifiedTiles.json.calls,
        row: verifiedRow,
        summary: verifiedSummary.json,
      },
    );

    await utcDb.execute('DELETE FROM calls WHERE id = ?', [legacyId]);
    fixtures.calls = fixtures.calls.filter((id) => id !== legacyId);
    const afterLegacy = await analytics(adminClient, { from: X, to: X, granularity: 'day', userId: e1.id });
    check(
      'and with the row gone the day is back to its three verified calls',
      matches(list(afterLegacy.json.calls)[0], { total: 3, incoming: 1, talkTimeSeconds: 60 }),
      list(afterLegacy.json.calls)[0],
    );

    /* ----------------------------------- a call the app logs, end to end */
    console.log('\ndashboard — a call the app logs lands on its IST day');

    const posted = await e1.client.post('/mobile/calls', {
      phone: '+91 96660 92299',
      direction: 'outgoing',
      outcome: 'answered',
      source: 'manual',
      durationSeconds: 30,
      startedAt: `${XNN}T00:15:00+05:30`,
      clientUuid: randomUUID(),
    });
    const postedId = Number(posted.json.call?.id);
    if (Number.isInteger(postedId) && postedId > 0) fixtures.calls.push(postedId);
    check('the app logs a call made at 00:15 IST', posted.status === 201 && postedId > 0, posted.json);

    const aroundPosted = await analytics(adminClient, {
      from: XN,
      to: XNN,
      granularity: 'day',
      userId: e1.id,
    });
    check(
      'it counts on that IST day, not on the UTC date it still was',
      matches(list(aroundPosted.json.calls)[0], { bucket: XN, total: 1 }) &&
        matches(list(aroundPosted.json.calls)[1], { bucket: XNN, total: 1, answered: 1, talkTimeSeconds: 30 }),
      list(aroundPosted.json.calls),
    );

    /* ------------------------------------------------------------ all time */
    console.log('\ndashboard — all time');

    const [firstRows] = (await utcDb.query(
      `SELECT (SELECT c.started_at FROM calls c WHERE ${shared.companyLineSql('c')}
                ORDER BY c.started_at LIMIT 1) AS first_call,
              (SELECT l.created_at FROM leads l WHERE l.is_archived = 0
                ORDER BY l.created_at LIMIT 1) AS first_lead`,
    )) as [Json[], unknown];
    const firsts = [firstRows[0]?.first_call, firstRows[0]?.first_lead].filter(
      (value): value is Date => value instanceof Date,
    );
    const firstDay =
      firsts.length > 0 ? time.companyDate(new Date(Math.min(...firsts.map((value) => value.getTime())))) : D;

    const allTime = await analytics(adminClient, {});
    check(
      'with no range the charts run from the IST day of the first company-line call or lead to today',
      allTime.status === 200 &&
        allTime.json.range?.to === D &&
        allTime.json.range?.from === (firstDay > D ? D : firstDay),
      { range: allTime.json.range, firstDay },
    );

    const e1AllTime = await analytics(adminClient, { userId: e1.id });
    check(
      "for one employee, from their own first call or lead, with every company-line call of theirs in a frame",
      e1AllTime.json.range?.from === XP &&
        e1AllTime.json.range?.to === D &&
        e1AllTime.json.granularity === 'month' &&
        sumOf(list(e1AllTime.json.calls), 'total') === 6 &&
        sumOf(list(e1AllTime.json.leads), 'created') === 2,
      {
        range: e1AllTime.json.range,
        granularity: e1AllTime.json.granularity,
        calls: sumOf(list(e1AllTime.json.calls), 'total'),
        leads: sumOf(list(e1AllTime.json.leads), 'created'),
      },
    );

    const ancientId = await insertCall({
      userId: e1.id,
      outcome: 'answered',
      durationSeconds: 10,
      startedAt: ist('1990-01-01', '10:00:00'),
    });
    const withAncient = await analytics(adminClient, { userId: e1.id });
    const reach = (time.MAX_CHART_FRAMES - 2) * 28;
    check(
      'a call stamped decades ago by a reset handset clock caps the all-time start instead of failing it',
      withAncient.status === 200 &&
        withAncient.json.range?.from === time.addDays(D, -(reach - 1)) &&
        withAncient.json.granularity === 'month' &&
        list(withAncient.json.calls).length <= time.MAX_CHART_FRAMES,
      { status: withAncient.status, range: withAncient.json.range, frames: list(withAncient.json.calls).length },
    );
    await utcDb.execute('DELETE FROM calls WHERE id = ?', [ancientId]);
    fixtures.calls = fixtures.calls.filter((id) => id !== ancientId);

    /* --------------------------------------------------------- conversions */
    console.log('\ndashboard — conversions');

    const beforeConversion = await dashboard(adminClient, { from: D, to: D });
    const convertedToday = await adminClient.post('/admin/telecalling/leads', {
      customerName: 'Dash Converted Today',
      phone: '+91 96660 92215',
      source: 'manual',
      status: 'converted',
      assignedTo: e1.id,
    });
    const convertedTodayId = Number(convertedToday.json.lead?.id);
    if (Number.isInteger(convertedTodayId) && convertedTodayId > 0) fixtures.leads.push(convertedTodayId);
    const afterConversion = await dashboard(adminClient, { from: D, to: D });
    const e1Today = await analytics(adminClient, { from: D, to: D, granularity: 'day', userId: e1.id });
    check(
      'a lead entered as converted is a conversion today: in its bucket, the status breakdown and the tiles',
      convertedToday.status === 201 &&
        matches(list(e1Today.json.leads)[0], { bucket: D, created: 1, converted: 1 }) &&
        list(e1Today.json.leadsByStatus).some((row) => row.status === 'converted' && row.count === 1) &&
        delta(afterConversion, beforeConversion, 'leads', 'total') === 1 &&
        delta(afterConversion, beforeConversion, 'leads', 'converted') === 1,
      {
        lead: convertedToday.json.lead,
        buckets: e1Today.json.leads,
        before: beforeConversion.json.leads,
        after: afterConversion.json.leads,
      },
    );

    /* ------------------------------------------------- today, in IST (E2) */
    console.log('\ndashboard — "today" is the IST day');

    const allBefore = await dashboard(adminClient);
    const todayBefore = await dashboard(adminClient, { from: D, to: D });

    const leadToday = await insertLead({
      reference: 'LD-DASH0004',
      name: 'Dash Lead Today',
      phone: '+91 96660 92214',
      status: 'new',
      assignedTo: e2.id,
    });
    // 00:00:10 IST today, and 23:59:50 IST yesterday — the same UTC date at this hour.
    await insertCall({ userId: e2.id, leadId: leadToday, outcome: 'answered', durationSeconds: 20, startedAt: at(10) });
    await insertCall({ userId: e2.id, leadId: leadToday, outcome: 'answered', durationSeconds: 30, startedAt: at(-10) });
    await insertCall({
      userId: e2.id,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: at(60),
      simMatch: 'confirmed',
      receivedOnPhone: E2_PHONE,
    });
    await insertCall({ userId: e2.id, direction: 'incoming', outcome: 'missed', startedAt: at(120), simMatch: null });
    await insertFollowUp({ leadId: leadToday, assignedTo: e2.id, dueAt: at(30) });
    await insertFollowUp({ leadId: leadToday, assignedTo: e2.id, dueAt: at(-30) });
    await insertFollowUp({
      leadId: leadToday,
      assignedTo: e2.id,
      dueAt: at(40),
      state: 'completed',
      completedAt: at(45),
    });
    await insertFollowUp({
      leadId: leadToday,
      assignedTo: e2.id,
      dueAt: at(-40),
      state: 'completed',
      completedAt: at(-50),
    });

    const allAfter = await dashboard(adminClient);
    check(
      "the admin's Due today and Completed today are the IST day's: 00:00:30 is today, 23:59:30 yesterday is not",
      delta(allAfter, allBefore, 'followUps', 'today') === 1 &&
        delta(allAfter, allBefore, 'followUps', 'completed') === 1 &&
        delta(allAfter, allBefore, 'followUps', 'overdue') === 2,
      { before: allBefore.json.followUps, after: allAfter.json.followUps },
    );
    check(
      'the all-time call tiles count every company-line call and leave the unverified one out',
      delta(allAfter, allBefore, 'calls', 'total') === 3 &&
        delta(allAfter, allBefore, 'calls', 'incoming') === 1 &&
        delta(allAfter, allBefore, 'calls', 'incomingMissed') === 1,
      { before: allBefore.json.calls, after: allAfter.json.calls },
    );
    const todayAfter = await dashboard(adminClient, { from: D, to: D });
    check(
      "today's range starts at 00:00 IST: the 00:00:10 call is in it and the 23:59:50 one is not",
      delta(todayAfter, todayBefore, 'calls', 'total') === 2 &&
        delta(todayAfter, todayBefore, 'calls', 'answered') === 1 &&
        delta(todayAfter, todayBefore, 'calls', 'talkTimeSeconds') === 20 &&
        delta(todayAfter, todayBefore, 'calls', 'incoming') === 1,
      { before: todayBefore.json.calls, after: todayAfter.json.calls },
    );

    const phoneDashboard = await e2.client.get('/mobile/dashboard');
    check(
      "the app's Today tiles count the IST day's calls on the company line",
      matches(phoneDashboard.json.calls, { today: 2, answered: 1, missed: 1, talkTimeSeconds: 20 }),
      phoneDashboard.json.calls,
    );
    check(
      'its incoming tiles and callback queue leave the unverified call out',
      matches(phoneDashboard.json.incoming, { today: 1, missedToday: 1, unhandled: 1 }) &&
        phoneDashboard.json.pendingCallbacks === 1,
      { incoming: phoneDashboard.json.incoming, pendingCallbacks: phoneDashboard.json.pendingCallbacks },
    );
    check(
      "and its follow-ups due today are the IST day's",
      matches(phoneDashboard.json.followUps, { today: 1, overdue: 2, upcoming: 0 }),
      phoneDashboard.json.followUps,
    );

    const e2TodayActivity = await e2.client.get(`/mobile/activity${qs({ from: D, to: D })}`);
    const e2YesterdayActivity = await e2.client.get(`/mobile/activity${qs({ from: Y, to: Y })}`);
    check(
      'My activity for today and for yesterday splits at 00:00 IST, each call made or received',
      matches(e2TodayActivity.json, {
        calls: 2,
        outgoingCalls: 1,
        incomingCalls: 1,
        answered: 1,
        talkTimeSeconds: 20,
      }) &&
        matches(e2YesterdayActivity.json, { calls: 1, outgoingCalls: 1, incomingCalls: 0, talkTimeSeconds: 30 }),
      { today: e2TodayActivity.json, yesterday: e2YesterdayActivity.json },
    );

    const e2Hours = await analytics(adminClient, { from: D, to: D, userId: e2.id });
    check(
      "today's hourly chart has 00:00:10 and 00:01 in the first IST hour, and not the unverified call",
      e2Hours.json.granularity === 'hour' &&
        matches(list(e2Hours.json.calls)[0], { bucket: `${D}T00:00`, total: 2, incoming: 1 }) &&
        sumOf(list(e2Hours.json.calls), 'total') === 2,
      list(e2Hours.json.calls).filter((frame) => frame.total > 0),
    );

    /* ------------------------------- the hourly chart stops at the hour */
    console.log("\ndashboard — today's hourly chart stops at the current hour");

    const early = await service.dashboardAnalytics(
      { from: XN, to: XN, granularity: 'hour', userId: e1.id },
      ist(XN, '05:15:00'),
    );
    check(
      'at 05:15 IST the day is charted to 05:00 — the empty hours still ahead are not drawn',
      early.granularity === 'hour' &&
        early.calls.length === 6 &&
        early.leads.length === 6 &&
        early.calls[5]?.bucket === `${XN}T05:00` &&
        early.calls[0]?.total === 1,
      early.calls.map((frame) => [frame.bucket, frame.total]),
    );
    const lateData = await service.dashboardAnalytics(
      { from: X, to: X, granularity: 'hour', userId: e1.id },
      ist(X, '05:15:00'),
    );
    check(
      'but an hour ahead that already holds a call is kept, so the bars still add up to the tiles',
      lateData.calls.length === 24 && lateData.calls.reduce((total, frame) => total + frame.total, 0) === 3,
      lateData.calls.filter((frame) => frame.total > 0).map((frame) => [frame.bucket, frame.total]),
    );

    /* --------------------------------- the charts add up to the tiles */
    console.log('\ndashboard — the charts add up to the tiles');

    const ranges: [string, { from: string; to: string }][] = [
      ['the last 30 days', { from: monthAgo, to: D }],
      ['the fixture days', { from: XP, to: XN }],
      ['today', { from: D, to: D }],
    ];
    for (const [name, range] of ranges) {
      const tiles = await dashboard(adminClient, range);
      const charts = await analytics(adminClient, range);
      const frames = list(charts.json.calls);
      const statusRows = list(charts.json.leadsByStatus);
      const byStatus = Object.fromEntries(statusRows.map((row) => [String(row.status), Number(row.count)]));
      const callTiles = (tiles.json.calls ?? {}) as Json;
      const leadTiles = (tiles.json.leads ?? {}) as Json;

      check(
        `${name} (${String(charts.json.granularity)}): the call bars add up to the call tiles`,
        tiles.status === 200 &&
          charts.status === 200 &&
          sumOf(frames, 'total') === callTiles.total &&
          sumOf(frames, 'answered') === callTiles.answered &&
          sumOf(frames, 'notAnswered') === callTiles.missed &&
          sumOf(frames, 'incoming') === callTiles.incoming &&
          sumOf(frames, 'incomingNotAnswered') === callTiles.incomingMissed &&
          sumOf(frames, 'talkTimeSeconds') === callTiles.talkTimeSeconds,
        {
          tiles: callTiles,
          charts: Object.fromEntries(
            ['total', 'answered', 'notAnswered', 'incoming', 'incomingNotAnswered', 'talkTimeSeconds'].map(
              (key) => [key, sumOf(frames, key)],
            ),
          ),
        },
      );
      check(
        `${name}: leads created and the status breakdown add up to the lead tiles`,
        sumOf(list(charts.json.leads), 'created') === leadTiles.total &&
          sumOf(statusRows, 'count') === leadTiles.total &&
          byStatus.converted === leadTiles.converted &&
          byStatus.walked_in === leadTiles.walkedIn &&
          byStatus.lost === leadTiles.lost,
        { tiles: leadTiles, created: sumOf(list(charts.json.leads), 'created'), byStatus },
      );
    }

    const e1Chart = list(
      (await analytics(adminClient, { from: X, to: X, granularity: 'day', userId: e1.id })).json.calls,
    )[0];
    const e1Row = list((await dashboard(adminClient, { from: X, to: X })).json.employees).find(
      (row) => row.userId === e1.id,
    );
    check(
      "one employee's chart is that employee's performance row",
      e1Chart !== undefined &&
        e1Row !== undefined &&
        e1Chart.total === e1Row.calls &&
        e1Chart.answered === e1Row.answered &&
        e1Chart.notAnswered === e1Row.missed &&
        e1Chart.outgoing === e1Row.outgoing &&
        e1Chart.incoming === e1Row.incoming &&
        e1Chart.incomingNotAnswered === e1Row.incomingMissed &&
        e1Chart.talkTimeSeconds === e1Row.talkTimeSeconds,
      { chart: e1Chart, row: e1Row },
    );

    /* ------------------------------- a chart opens the rows it counted */
    /*
     * The lists' own filters belong to the calls, leads and follow-ups features; these
     * checks hold the two sides to one definition — same IST day bounds, same company
     * line, same scopes — which is what makes a click-through trustworthy.
     */
    console.log('\ndashboard — a chart or a card opens the rows it counted');

    const listTotal = async (client: Client, path: string, params: Record<string, string | number | undefined>) => {
      const response = await client.get(`${path}${qs({ ...params, pageSize: 1 })}`);
      return { status: response.status, total: response.json.total as unknown };
    };

    const barCalls = await listTotal(adminClient, '/admin/telecalling/calls', { userId: e1.id, from: X, to: X });
    const barUnanswered = await listTotal(adminClient, '/admin/telecalling/calls', {
      userId: e1.id,
      from: X,
      to: X,
      outcome: 'unanswered',
    });
    check(
      "the calls list for a bar's day and employee holds the bar's calls, and its not-answered segment the not-answered ones",
      barCalls.total === 3 && barUnanswered.total === 2,
      { calls: barCalls, unanswered: barUnanswered },
    );

    const monthUnanswered = await listTotal(adminClient, '/admin/telecalling/calls', {
      from: monthAgo,
      to: D,
      outcome: 'unanswered',
    });
    const monthCharts = await analytics(adminClient, { from: monthAgo, to: D, granularity: 'day' });
    check(
      'over the last 30 days the not-answered list holds exactly the not-answered segments',
      monthUnanswered.total === sumOf(list(monthCharts.json.calls), 'notAnswered'),
      { list: monthUnanswered, chart: sumOf(list(monthCharts.json.calls), 'notAnswered') },
    );

    const todayTiles = await dashboard(adminClient, { from: D, to: D });
    const todayCallList = await adminClient.get(`/admin/telecalling/calls${qs({ from: D, to: D, pageSize: 1 })}`);
    const todayIncoming = await listTotal(adminClient, '/admin/telecalling/calls', {
      from: D,
      to: D,
      direction: 'incoming',
    });
    const todayLeadList = await listTotal(adminClient, '/admin/telecalling/leads', { from: D, to: D });
    check(
      "today's call, incoming and lead cards open lists of their size, and the calls list's summary line equals the cards",
      todayCallList.json.total === todayTiles.json.calls?.total &&
        todayCallList.json.summary?.answered === todayTiles.json.calls?.answered &&
        todayCallList.json.summary?.unanswered === todayTiles.json.calls?.missed &&
        todayCallList.json.summary?.talkTimeSeconds === todayTiles.json.calls?.talkTimeSeconds &&
        todayIncoming.total === todayTiles.json.calls?.incoming &&
        todayLeadList.total === todayTiles.json.leads?.total,
      {
        tiles: { calls: todayTiles.json.calls, leads: todayTiles.json.leads?.total },
        calls: { total: todayCallList.json.total, summary: todayCallList.json.summary },
        incoming: todayIncoming,
        leads: todayLeadList,
      },
    );

    const bucketLeads = await listTotal(adminClient, '/admin/telecalling/leads', { assignedTo: e1.id, from: X, to: X });
    const bucketConversions = await listTotal(adminClient, '/admin/telecalling/leads', {
      assignedTo: e1.id,
      status: 'converted',
      convertedFrom: X,
      convertedTo: X,
    });
    check(
      "the leads list holds a bucket's new lead (created 00:00 IST) and, by conversion date, its conversion",
      bucketLeads.total === 1 && bucketConversions.total === 1,
      { created: bucketLeads, converted: bucketConversions },
    );

    const completedSlice = await listTotal(adminClient, '/admin/telecalling/follow-ups', {
      assignedTo: e1.id,
      scope: 'completed',
      from: X,
      to: X,
    });
    const overdueSlice = await listTotal(adminClient, '/admin/telecalling/follow-ups', {
      assignedTo: e1.id,
      scope: 'overdue',
      from: X,
      to: X,
    });
    const upcomingSlice = await listTotal(adminClient, '/admin/telecalling/follow-ups', {
      assignedTo: e1.id,
      scope: 'upcoming',
      from: X,
    });
    check(
      'each follow-up slice opens its own rows: completed, overdue and not yet due',
      completedSlice.total === 3 && overdueSlice.total === 1 && upcomingSlice.total === 1,
      { completed: completedSlice, overdue: overdueSlice, upcoming: upcomingSlice },
    );

    const dueTodayList = await listTotal(adminClient, '/admin/telecalling/follow-ups', {
      assignedTo: e2.id,
      scope: 'today',
    });
    const doneTodayList = await listTotal(adminClient, '/admin/telecalling/follow-ups', {
      assignedTo: e2.id,
      scope: 'completed_today',
    });
    const overdueList = await listTotal(adminClient, '/admin/telecalling/follow-ups', {
      assignedTo: e2.id,
      scope: 'overdue',
    });
    check(
      'Due today, Completed today and Overdue open lists of the same rows the cards count',
      dueTodayList.total === 1 && doneTodayList.total === 1 && overdueList.total === 2,
      { today: dueTodayList, completedToday: doneTodayList, overdue: overdueList },
    );

    const callbackList = await e2.client.get('/mobile/calls/pending-callbacks');
    check(
      "the app's callback tile and its list agree, with the unverified call in neither",
      callbackList.status === 200 && callbackList.json.total === phoneDashboard.json.pendingCallbacks,
      { list: callbackList.json.total, tile: phoneDashboard.json.pendingCallbacks },
    );

    /* -------------------------------------------- headcount, active vs total */
    const beforeLeave = await dashboard(adminClient);
    await utcDb.execute('UPDATE telecaller_users SET is_active = 0 WHERE id = ?', [supervisor.id]);
    const afterLeave = await dashboard(adminClient);
    check(
      'a deactivated employee leaves the active headcount and stays in the total',
      delta(afterLeave, beforeLeave, 'headcount', 'active') === -1 &&
        delta(afterLeave, beforeLeave, 'headcount', 'total') === 0,
      { before: beforeLeave.json.headcount, after: afterLeave.json.headcount },
    );
  } finally {
    /* ------------------------------------------------------------ tidy up */
    // Later sections count calls, leads and follow-ups too; none of ours may linger.
    const remaining = await removeFixtures();
    check("the section's calls, leads and follow-ups are removed again", remaining === 0, remaining);
  }
}
