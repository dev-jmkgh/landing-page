import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import type { Actor } from '../../src/modules/telecalling/actor';
import type { E2EContext, Json } from './context';

/**
 * The daily telecalling email: its status, preview, manual send and run history, the
 * schedule that sends it once a day, and the figures it reports.
 *
 * Owned by the report feature (key `report`). Runs after the people section; the rules
 * every section follows are in `context.ts`. Mail is off for the whole run, so a send is
 * asserted through its `report_runs` row — and every service-level send here is given a
 * sender of its own as well, so nothing can reach a mail server even if the harness's
 * blanking were undone.
 *
 * Fixtures are this section's own: emails `rpt.*`, lead numbers `+91 96661 000NN`,
 * company numbers `+9196661001NN`, report days in January 2026 (no other section writes
 * there). Day totals are asserted as deltas over a baseline read before the fixtures
 * went in. Everything it wrote is removed at the end.
 */

type Sent = { recipients: string[]; subject: string; html: string; text: string; type?: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A stand-in mail transport that records what it was asked to send. */
function capturingSender(result: 'sent' | 'failed' = 'sent', delayMs = 0) {
  const sent: Sent[] = [];
  const send = async (
    recipients: readonly string[],
    input: { subject: string; html: string; text: string; type?: string },
  ) => {
    sent.push({
      recipients: [...recipients],
      subject: input.subject,
      html: input.html,
      text: input.text,
      type: input.type,
    });
    if (delayMs > 0) await sleep(delayMs);
    return result === 'sent'
      ? { result: 'sent' as const, delivered: recipients.length, total: recipients.length }
      : { result: 'failed' as const, delivered: 0, total: recipients.length };
  };
  return { sent, send };
}

export async function run(ctx: E2EContext): Promise<void> {
  const { check, utcDb, adminAsBearer, adminId, ravi, base, makeClient } = ctx;

  const service = await import('../../src/modules/telecalling/reports/dailyReport.service');
  const repository = await import('../../src/modules/telecalling/reports/dailyReport.repository');
  const scheduler = await import('../../src/modules/telecalling/reports/dailyReport.scheduler');
  const time = await import('../../src/modules/telecalling/companyTime');
  const { config } = await import('../../src/config/env');
  const mailer = await import('../../src/services/mailer');
  const email = await import('../../src/services/email');
  const text = await import('../../src/utils/text');
  const { HttpError } = await import('../../src/utils/httpError');

  const API = '/admin/telecalling';
  const at = (iso: string) => new Date(iso);
  const ids = { leads: [] as number[], calls: [] as number[], followUps: [] as number[], users: [] as number[] };

  async function insert(sql: string, params: (string | number | null)[]): Promise<number> {
    const [result] = await utcDb.execute(sql, params);
    return (result as ResultSetHeader).insertId;
  }

  async function scheduledRows(date: string): Promise<Json[]> {
    const [rows] = (await utcDb.query(
      `SELECT id, status, attempts, failure_reason, error, finished_at, recipient_count, delivered_count,
              JSON_UNQUOTE(JSON_EXTRACT(summary, '$.audience')) AS audience,
              JSON_UNQUOTE(JSON_EXTRACT(summary, '$.report.reportDate')) AS summary_date
         FROM report_runs
        WHERE report_type = 'telecalling_daily' AND report_date = ? AND trigger_kind = 'scheduled'`,
      [date],
    )) as [Json[], unknown];
    return rows;
  }

  async function runRowCount(): Promise<number> {
    const [rows] = (await utcDb.query(
      "SELECT COUNT(*) AS total FROM report_runs WHERE report_type = 'telecalling_daily'",
    )) as [Json[], unknown];
    return Number(rows[0]?.total ?? -1);
  }

  async function putSetting(key: string, value: unknown) {
    return adminAsBearer.put(`${API}/settings`, { key, value });
  }

  try {
    /* ------------------------------------------------- mail is off, no clock */
    console.log('\ndaily report — configuration, mailer and schedule maths');

    check(
      'mail is off for the whole run, so no report can reach a real inbox',
      config.smtp.enabled === false,
      config.smtp.enabled,
    );
    check(
      'the report goes to ADMIN_EMAILS, and a leftover TELECALLING_REPORT_EMAILS line is ignored',
      process.env.TELECALLING_REPORT_EMAILS === 'leftover-report-list@example.test' &&
        config.telecallingReport.recipients.length === 1 &&
        config.telecallingReport.recipients[0] === 'owner@example.test',
      config.telecallingReport,
    );
    check(
      'the scheduler switch is off here, and createApp started no clock',
      config.telecallingReport.schedulerEnabled === false &&
        service.isDailyReportSchedulerRunning() === false,
      { enabled: config.telecallingReport.schedulerEnabled, running: service.isDailyReportSchedulerRunning() },
    );

    /* --- the mailer refactor --- */
    check(
      'addresses are masked for status screens the way the logs mask them',
      JSON.stringify(mailer.maskAddresses(['owner@example.test', 'no-at-sign'])) ===
        JSON.stringify(['ow***@example.test', '***']),
      mailer.maskAddresses(['owner@example.test', 'no-at-sign']),
    );
    const message = { subject: 'Report e2e', html: '<p>x</p>', text: 'x', type: 'e2e' };
    const fanOut = await mailer.sendToEach(['a@example.test', 'b@example.test'], message);
    check(
      'one message per recipient: with mail off every send is skipped, and the count says so',
      fanOut.result === 'skipped' && fanOut.delivered === 0 && fanOut.total === 2,
      fanOut,
    );
    const nobody = await mailer.sendToEach([], message);
    check(
      'a send to nobody fails rather than reporting success',
      nobody.result === 'failed' && nobody.total === 0,
      nobody,
    );
    check(
      'admin notifications keep their old result (skipped with mail off)',
      (await mailer.sendAdminNotification(message)) === 'skipped',
    );

    /* --- formatDuration, for the email --- */
    const durations = [0, 45, 60, 204, 3600, 7500, 12.4, -5].map(text.formatDuration);
    check(
      'talk time reads 45s, 3m 24s, 2h 5m — and never -5s or 12.4s',
      JSON.stringify(durations) ===
        JSON.stringify(['0s', '45s', '1m', '3m 24s', '1h 0m', '2h 5m', '12s', '0s']),
      durations,
    );
    const callService = (await import('../../src/modules/telecalling/calls/call.service')) as {
      formatDuration?: (seconds: number) => string;
    };
    if (typeof callService.formatDuration === 'function') {
      const legacy = callService.formatDuration;
      const sample = [0, 1, 59, 60, 61, 3599, 3600, 3661, 7325, 86_399];
      check(
        'and it prints exactly what the call timeline has always printed',
        sample.every((seconds) => legacy(seconds) === text.formatDuration(seconds)),
        sample.map((seconds) => [legacy(seconds), text.formatDuration(seconds)]),
      );
    }

    /* --- the IST day the report is built on --- */
    check(
      'an IST day runs from 18:30Z the evening before to 18:30Z, and 18:30Z is the next day',
      time.companyDayStart('2026-01-14').toISOString() === '2026-01-13T18:30:00.000Z' &&
        time.companyDayEnd('2026-01-14').toISOString() === '2026-01-14T18:30:00.000Z' &&
        time.companyDate(at('2026-01-13T18:29:59Z')) === '2026-01-13' &&
        time.companyDate(at('2026-01-13T18:30:00Z')) === '2026-01-14',
      {
        start: time.companyDayStart('2026-01-14').toISOString(),
        end: time.companyDayEnd('2026-01-14').toISOString(),
      },
    );

    /* --- when a report is due --- */
    const due = (iso: string, sendAt = '08:00') => service.dueScheduledDate(at(iso), sendAt);
    check(
      'a day is not due a second before its send time (07:59:59 IST)',
      due('2026-01-15T02:29:59Z') === null,
      due('2026-01-15T02:29:59Z'),
    );
    check(
      "at 08:00 IST on the 15th the 14th's report is due",
      due('2026-01-15T02:30:00Z')?.reportDate === '2026-01-14' &&
        due('2026-01-15T02:30:00Z')?.dueAt.toISOString() === '2026-01-15T02:30:00.000Z',
      due('2026-01-15T02:30:00Z'),
    );
    check(
      'the catch-up window closes twelve hours later, exclusively',
      due('2026-01-15T14:29:59Z')?.reportDate === '2026-01-14' && due('2026-01-15T14:30:00Z') === null,
      { last: due('2026-01-15T14:29:59Z'), closed: due('2026-01-15T14:30:00Z') },
    );
    check(
      'and 01:30 IST — before the send time — has nothing due',
      due('2026-01-14T20:00:00Z') === null,
      due('2026-01-14T20:00:00Z'),
    );
    check(
      'a late send time whose window crosses midnight still finds its day',
      due('2026-01-16T04:30:00Z', '23:30')?.reportDate === '2026-01-14',
      due('2026-01-16T04:30:00Z', '23:30'),
    );
    const beforeTime = service.nextScheduledRun(at('2026-01-15T02:29:00Z'), '08:00');
    const afterTime = service.nextScheduledRun(at('2026-01-15T02:30:00Z'), '08:00');
    check(
      "the next run is yesterday's report this morning, or today's tomorrow once 08:00 has passed",
      beforeTime.reportDate === '2026-01-14' &&
        beforeTime.dueAt.toISOString() === '2026-01-15T02:30:00.000Z' &&
        afterTime.reportDate === '2026-01-15' &&
        afterTime.dueAt.toISOString() === '2026-01-16T02:30:00.000Z',
      { beforeTime, afterTime },
    );

    /* --- what the schedule does with a day that already has a run --- */
    const now = at('2026-03-01T03:00:00Z');
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    const stored = (overrides: Json) => ({
      status: 'failed' as const,
      attempts: 1,
      failureReason: null,
      leaseExpiresAt: minutesAgo(5),
      finishedAt: minutesAgo(60),
      claimedAt: minutesAgo(61),
      ...overrides,
    });
    const decide = (overrides: Json, mailUsable = false) =>
      service.decideScheduledRun(stored(overrides) as Parameters<typeof service.decideScheduledRun>[0], now, mailUsable);
    const decisions = {
      sent: decide({ status: 'sent' }),
      partial: decide({ status: 'partial' }),
      skippedNoMail: decide({ status: 'skipped', failureReason: 'mail_not_configured' }),
      skippedWithMail: decide({ status: 'skipped', failureReason: 'mail_not_configured' }, true),
      skippedExhausted: decide({ status: 'skipped', failureReason: 'mail_not_configured', attempts: 3 }, true),
      rejectedRecently: decide({ failureReason: 'mail_rejected', finishedAt: minutesAgo(29) }),
      rejectedLongAgo: decide({ failureReason: 'mail_rejected', finishedAt: minutesAgo(30) }),
      rejectedExhausted: decide({ failureReason: 'mail_rejected', attempts: 3 }),
      generationFailed: decide({ failureReason: 'generation_failed' }),
      noRecipients: decide({ failureReason: 'no_recipients' }),
      interrupted: decide({ failureReason: 'interrupted' }),
      claimedLive: decide({ status: 'claimed', leaseExpiresAt: new Date(now.getTime() + 60_000) }),
      claimedDead: decide({ status: 'claimed' }),
      sendingLive: decide({ status: 'sending', leaseExpiresAt: new Date(now.getTime() + 60_000) }),
      sendingDead: decide({ status: 'sending' }),
    };
    check(
      'sent or partly sent is final; a skipped day is picked up only where mail works',
      decisions.sent === 'done' &&
        decisions.partial === 'done' &&
        decisions.skippedNoMail === 'done' &&
        decisions.skippedWithMail === 'reclaim' &&
        decisions.skippedExhausted === 'done',
      decisions,
    );
    check(
      'a safe failure is retried after 30 minutes, three attempts at most; an interrupted send never',
      decisions.rejectedRecently === 'later' &&
        decisions.rejectedLongAgo === 'reclaim' &&
        decisions.rejectedExhausted === 'done' &&
        decisions.generationFailed === 'reclaim' &&
        decisions.noRecipients === 'reclaim' &&
        decisions.interrupted === 'done',
      decisions,
    );
    check(
      "a live lease is left alone; a dead claim is taken over; a dead send is closed, not resent",
      decisions.claimedLive === 'busy' &&
        decisions.claimedDead === 'reclaim' &&
        decisions.sendingLive === 'busy' &&
        decisions.sendingDead === 'interrupt',
      decisions,
    );

    /* -------------------------------------------------------------- settings */
    console.log('\ndaily report — settings');

    const settings = await adminAsBearer.get(`${API}/settings`);
    const settingValue = (items: unknown, key: string) =>
      (items as Json[] | undefined)?.find((item) => item.key === key)?.value as unknown;
    check(
      'the email is on at 08:00 by default',
      settings.status === 200 &&
        settingValue(settings.json.items, 'report.daily_email_enabled') === true &&
        settingValue(settings.json.items, 'report.daily_email_time') === '08:00',
      settings.json.items,
    );

    const badHour = await putSetting('report.daily_email_time', '25:00');
    check(
      'an impossible send time is refused with a 400 that says what to type',
      badHour.status === 400 &&
        String(badHour.json.message).includes('HH:MM') &&
        typeof badHour.json.errors?.value === 'string',
      { status: badHour.status, json: badHour.json },
    );
    const unpadded = await putSetting('report.daily_email_time', '7:30');
    const numeric = await putSetting('report.daily_email_time', 730);
    check(
      'so is an unpadded time, or a number',
      unpadded.status === 400 && numeric.status === 400 && String(numeric.json.message).includes('HH:MM'),
      { unpadded: unpadded.status, numeric: numeric.json },
    );
    const goodTime = await putSetting('report.daily_email_time', '07:30');
    check(
      'a valid time saves and reads back',
      goodTime.status === 200 && settingValue(goodTime.json.items, 'report.daily_email_time') === '07:30',
      { status: goodTime.status, json: goodTime.json },
    );
    const padded = await putSetting('report.daily_email_time', ' 09:15 ');
    check(
      'surrounding spaces are trimmed before it is stored',
      padded.status === 200 && settingValue(padded.json.items, 'report.daily_email_time') === '09:15',
      settingValue(padded.json.items, 'report.daily_email_time'),
    );
    const timeAudit = await adminAsBearer.get(`${API}/audit-logs?action=setting_changed&pageSize=1`);
    check(
      'and the audit log records the value that was stored',
      (timeAudit.json.items as Json[] | undefined)?.[0]?.meta?.value === '09:15',
      timeAudit.json.items,
    );

    const yes = await putSetting('report.daily_email_enabled', 'yes');
    const one = await putSetting('report.daily_email_enabled', 1);
    check(
      'the switch takes only true or false — "yes" or 1 is refused in plain words',
      yes.status === 400 &&
        one.status === 400 &&
        yes.json.message === 'This setting can only be switched on or off.',
      { yes: yes.json, one: one.status },
    );
    const switchedOn = await putSetting('report.daily_email_enabled', true);
    check('true saves', switchedOn.status === 200, switchedOn.json);

    const unknownKey = await putSetting('not.a.real.setting', 1);
    check('an unknown setting key is still a 422', unknownKey.status === 422, unknownKey.status);
    const otherKey = await putSetting('followup.reminder_minutes', 30);
    check(
      'existing settings keep accepting what they always did',
      otherKey.status === 200 && settingValue(otherKey.json.items, 'followup.reminder_minutes') === 30,
      otherKey.json,
    );
    const raviWrites = await ravi.put(`${API}/settings`, { key: 'report.daily_email_enabled', value: false });
    check('a telecaller cannot change them', raviWrites.status === 403, raviWrites.status);

    await putSetting('report.daily_email_time', '08:00');

    /* -------------------------------------------------------------- fixtures */
    console.log('\ndaily report — the figures for one IST day');

    const caller = await ctx.createSignedInEmployee({
      name: 'Report Caller',
      email: 'rpt.caller@example.test',
      role: 'telecaller',
      companyPhone: '+919666100101',
    });
    const leaver = await ctx.createSignedInEmployee({
      name: 'Report Leaver',
      email: 'rpt.leaver@example.test',
      role: 'telecaller',
      companyPhone: '+919666100102',
    });
    const idle = await ctx.createSignedInEmployee({
      name: 'Report Idle',
      email: 'rpt.idle@example.test',
      role: 'telecaller',
      companyPhone: '+919666100103',
    });
    const manager = await ctx.createSignedInEmployee({
      name: 'Report Manager',
      email: 'rpt.manager@example.test',
      role: 'manager',
    });
    const supervisor = await ctx.createSignedInEmployee({
      name: 'Report Supervisor',
      email: 'rpt.supervisor@example.test',
      role: 'supervisor',
    });
    ids.users.push(caller.id, leaver.id, idle.id, manager.id, supervisor.id);

    const reportAt = at('2026-01-15T02:31:00Z');
    // A tuple, not a mapped array, so each baseline is typed as present.
    const [base13, base14, base15] = await Promise.all([
      service.generateDailyReport('2026-01-13', { now: reportAt }),
      service.generateDailyReport('2026-01-14', { now: reportAt }),
      service.generateDailyReport('2026-01-15', { now: reportAt }),
    ]);

    /*
     * IST day 2026-01-14 is 2026-01-13T18:30Z to 2026-01-14T18:30Z. Each fixture sits on
     * or next to an edge, so a UTC-day implementation gets every figure wrong.
     */
    const leadOne = await insert(
      `INSERT INTO leads (reference, customer_name, phone, source, status, assigned_to, assigned_at, created_at)
       VALUES ('LD-RPT00001', 'Report Lead One', '+91 96661 00001', 'referral', 'new', ?, '2026-01-13 20:00:00', '2026-01-13 20:00:00')`,
      [caller.id],
    );
    const leadTwo = await insert(
      `INSERT INTO leads (reference, customer_name, phone, source, status, assigned_to, assigned_at, created_at, converted_at)
       VALUES ('LD-RPT00002', 'Report Lead Two', '+91 96661 00002', 'website', 'converted', ?, '2026-01-10 05:00:00', '2026-01-10 05:00:00', '2026-01-14 06:00:00')`,
      [caller.id],
    );
    ids.leads.push(leadOne, leadTwo);

    const callSql = `INSERT INTO calls
        (user_id, lead_id, phone, direction, outcome, duration_seconds, started_at, source, sim_match, received_on_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'call_log', ?, ?)`;
    const fixtureCalls: [number, number | null, string, string, string, number, string, string | null, string | null][] = [
      // 00:00:00 IST on the 14th — in.
      [caller.id, leadOne, '+91 96661 00001', 'outgoing', 'answered', 120, '2026-01-13 18:30:00', null, null],
      // 23:59:59 IST on the 14th, verified on the company SIM — in.
      [caller.id, null, '+91 96661 00009', 'incoming', 'missed', 0, '2026-01-14 18:29:59', 'confirmed', '+919666100101'],
      // Mid-day, by the employee who is about to leave — in.
      [leaver.id, null, '+91 96661 00008', 'outgoing', 'busy', 0, '2026-01-14 05:00:00', null, null],
      // 23:59:59 IST on the 13th — out (the 13th's).
      [caller.id, leadOne, '+91 96661 00001', 'outgoing', 'answered', 60, '2026-01-13 18:29:59', null, null],
      // 00:00:00 IST on the 15th — out (the 15th's).
      [caller.id, leadOne, '+91 96661 00001', 'outgoing', 'answered', 30, '2026-01-14 18:30:00', null, null],
      // Unverified incoming calls on the 14th: possibly personal, in no figure at all.
      [caller.id, leadTwo, '+91 96661 00002', 'incoming', 'answered', 300, '2026-01-14 08:00:00', null, null],
      [caller.id, null, '+91 96661 00007', 'incoming', 'missed', 0, '2026-01-14 09:00:00', null, null],
    ];
    for (const params of fixtureCalls) ids.calls.push(await insert(callSql, params));

    const followUpSql = `INSERT INTO follow_ups
        (lead_id, assigned_to, created_by, due_at, state, completed_at, completed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const fixtureFollowUps: [number, number, number, string, string, string | null, number | null, string][] = [
      // Booked and done on time on the 14th.
      [leadOne, caller.id, caller.id, '2026-01-14 10:00:00', 'completed', '2026-01-14 09:00:00', caller.id, '2026-01-14 04:00:00'],
      // Booked at 23:30 IST on the 13th, done late on the 14th.
      [leadTwo, caller.id, caller.id, '2026-01-14 12:00:00', 'completed', '2026-01-14 13:00:00', caller.id, '2026-01-13 18:00:00'],
      // Booked on the 14th and cancelled: a booking, but nothing was due.
      [leadOne, caller.id, caller.id, '2026-01-14 11:00:00', 'cancelled', null, null, '2026-01-14 05:00:00'],
      // Booked on the 14th, due that afternoon, never done.
      [leadOne, caller.id, caller.id, '2026-01-14 15:00:00', 'pending', null, null, '2026-01-14 06:00:00'],
    ];
    for (const params of fixtureFollowUps) ids.followUps.push(await insert(followUpSql, params));

    await utcDb.execute('UPDATE telecaller_users SET is_active = 0 WHERE id = ?', [leaver.id]);

    const day14 = await service.generateDailyReport('2026-01-14', { now: reportAt });
    const day13 = await service.generateDailyReport('2026-01-13', { now: reportAt });
    const day15 = await service.generateDailyReport('2026-01-15', { now: reportAt });

    const callDelta = (field: keyof typeof day14.calls) => day14.calls[field] - base14.calls[field];
    check(
      'the day counts the three company-line calls inside its IST bounds',
      callDelta('total') === 3 &&
        callDelta('answered') === 1 &&
        callDelta('notAnswered') === 2 &&
        callDelta('outgoing') === 2 &&
        callDelta('incoming') === 1 &&
        callDelta('incomingMissed') === 1 &&
        callDelta('talkTimeSeconds') === 120,
      { after: day14.calls, before: base14.calls },
    );
    check(
      'and the calls a second either side land on the neighbouring days',
      day13.calls.total - base13.calls.total === 1 && day15.calls.total - base15.calls.total === 1,
      { day13: day13.calls.total - base13.calls.total, day15: day15.calls.total - base15.calls.total },
    );
    check(
      'unverified incoming calls are in no figure — not the count, the talk time or the leads reached',
      callDelta('incoming') === 1 &&
        callDelta('talkTimeSeconds') === 120 &&
        day14.leads.contacted - base14.leads.contacted === 1,
      { calls: day14.calls, contacted: day14.leads.contacted },
    );
    check(
      'leads: one created at 01:30 IST, one reached, one called, one converted that day',
      day14.leads.created - base14.leads.created === 1 &&
        day14.leads.contacted - base14.leads.contacted === 1 &&
        day14.leads.attempted - base14.leads.attempted === 1 &&
        day14.leads.converted - base14.leads.converted === 1,
      { after: day14.leads, before: base14.leads },
    );
    const sourceTotal = (rows: typeof day14.leads.bySource, key: string) =>
      rows.find((row) => row.key === key)?.total ?? 0;
    check(
      'new leads by source carry the source label',
      sourceTotal(day14.leads.bySource, 'referral') - sourceTotal(base14.leads.bySource, 'referral') === 1 &&
        day14.leads.bySource.find((row) => row.key === 'referral')?.label === 'Referral',
      day14.leads.bySource,
    );
    const followUpDelta = (field: keyof typeof day14.followUps) =>
      day14.followUps[field] - base14.followUps[field];
    check(
      'follow-ups: three booked, three due (the cancelled one is not), two completed — one on time, one late',
      followUpDelta('scheduled') === 3 &&
        followUpDelta('due') === 3 &&
        followUpDelta('completed') === 2 &&
        followUpDelta('completedOnTime') === 1 &&
        followUpDelta('completedLate') === 1,
      { after: day14.followUps, before: base14.followUps },
    );
    check(
      "the 23:30 IST booking on the 13th is the 13th's",
      day13.followUps.scheduled - base13.followUps.scheduled === 1,
      day13.followUps.scheduled - base13.followUps.scheduled,
    );
    const [livePending] = (await utcDb.query(
      "SELECT COUNT(*) AS total FROM follow_ups WHERE state = 'pending'",
    )) as [Json[], unknown];
    check(
      'pending follow-ups are the live truth, and the unfinished one is overdue as at generation',
      day14.followUps.pending === Number(livePending[0]?.total) && followUpDelta('overdue') === 1,
      { pending: day14.followUps.pending, live: livePending[0]?.total, overdue: followUpDelta('overdue') },
    );
    check(
      'the callback backlog gains the two unanswered company-line calls, not the unverified one',
      day14.backlog.pendingCallbacks - base14.backlog.pendingCallbacks === 2,
      { after: day14.backlog, before: base14.backlog },
    );
    check(
      "the day's window and partial flag describe a finished IST day",
      day14.window.start === '2026-01-13T18:30:00.000Z' &&
        day14.window.end === '2026-01-14T18:30:00.000Z' &&
        day14.window.timeZone === 'Asia/Kolkata' &&
        day14.partial === false &&
        day14.generatedAt === reportAt.toISOString(),
      { window: day14.window, partial: day14.partial, generatedAt: day14.generatedAt },
    );

    const row = (id: number) => day14.employees.find((employee) => employee.userId === id);
    const callerRow = row(caller.id);
    check(
      "the caller's row: two calls (one out, one in), the dashboard's own definitions",
      callerRow?.calls === 2 &&
        callerRow.answered === 1 &&
        callerRow.missed === 1 &&
        callerRow.outgoing === 1 &&
        callerRow.incoming === 1 &&
        callerRow.incomingMissed === 1 &&
        callerRow.talkTimeSeconds === 120 &&
        callerRow.leadsContacted === 1 &&
        callerRow.followUpsCompleted === 2 &&
        callerRow.followUpsPending === 1 &&
        callerRow.leadsConverted === 1,
      callerRow,
    );
    check(
      'a deactivated employee is listed only because they worked that day',
      row(leaver.id)?.calls === 1 && row(leaver.id)?.isActive === false,
      row(leaver.id),
    );
    check(
      'an active telecaller with no calls is listed, so the quiet day is visible',
      row(idle.id)?.calls === 0 && row(idle.id)?.isActive === true,
      row(idle.id),
    );
    check(
      'staff who are not telecallers and did nothing are not',
      row(manager.id) === undefined && row(supervisor.id) === undefined,
    );
    const order = [caller.id, leaver.id, idle.id].map((id) =>
      day14.employees.findIndex((employee) => employee.userId === id),
    );
    check(
      'busiest first',
      order.every((index) => index >= 0) && order[0]! < order[1]! && order[1]! < order[2]!,
      order,
    );

    const twoDaysLater = await service.generateDailyReport('2026-01-14', { now: at('2026-01-16T02:31:00Z') });
    check(
      'overdue-by-employee uses the dashboard threshold, as at generation',
      day14.overdueAlertHours === 24 &&
        !day14.overdueByEmployee.some((group) => group.userId === caller.id) &&
        twoDaysLater.overdueByEmployee.find((group) => group.userId === caller.id)?.overdue === 1,
      { at15: day14.overdueByEmployee, at16: twoDaysLater.overdueByEmployee },
    );

    /* -------------------------------------------------------------- the email */
    console.log('\ndaily report — the email');

    const rendered = service.renderDailyReportEmail(day14);
    check(
      'the subject is the date and nothing else',
      rendered.subject === 'Telecalling daily report — Wed, 14 Jan 2026',
      rendered.subject,
    );
    check(
      'the real email keeps the logo as an attachment reference',
      rendered.html.includes('cid:jmk-logo') && !rendered.html.includes('data:image/png'),
    );
    check(
      'it names the employees, in both parts',
      rendered.html.includes('Report Caller') && rendered.text.includes('Report Caller'),
    );
    check(
      'and no customer — not a lead name, not a phone number',
      !['Report Lead One', 'Report Lead Two', '96661 00001', '9666100001'].some(
        (secret) => rendered.html.includes(secret) || rendered.text.includes(secret),
      ),
    );
    check(
      'what needs attention leads the email',
      rendered.html.includes('Needs attention') &&
        rendered.html.indexOf('Needs attention') < rendered.html.indexOf('Team'),
    );
    check(
      'the text part mirrors it, with the team as a table',
      rendered.text.includes('DAILY TELECALLING REPORT') &&
        rendered.text.includes('Wednesday, 14 January 2026') &&
        rendered.text.includes('TEAM') &&
        rendered.text.includes('FU done/pending'),
    );
    check(
      'it links to the dashboard',
      rendered.html.includes(`${config.appUrl}/admin/telecalling/?section=dashboard`),
    );

    /* A synthetic report: hostile names, a big team, a partial day. */
    const hostile = {
      ...day14,
      partial: true,
      employees: Array.from({ length: email.TEAM_TABLE_LIMIT + 5 }, (_, index) => ({
        ...(callerRow ?? day14.employees[0]!),
        userId: 900_000 + index,
        name: index === 0 ? '<script>alert(1)</script> Ann' : `Teammate ${index}`,
        calls: 100 - index,
      })),
    };
    const hostileEmail = email.dailyTelecallingReportEmail(hostile, { dashboardUrl: 'https://example.test/admin/' });
    check(
      'names are escaped — a script tag in a name is text, not markup',
      hostileEmail.html.includes('&lt;script&gt;') && !hostileEmail.html.includes('<script'),
    );
    check(
      'the team table stops at fifty and says how many more there are',
      hostileEmail.html.includes('And 5 more employees') &&
        hostileEmail.text.includes('And 5 more employees') &&
        !hostileEmail.html.includes(`Teammate ${email.TEAM_TABLE_LIMIT}<`),
    );
    check(
      'a day that is not over says so, in the subject too',
      hostileEmail.subject.endsWith('(so far)') && hostileEmail.html.includes('not over yet'),
      hostileEmail.subject,
    );

    /* ------------------------------------------------------------ the schedule */
    console.log('\ndaily report — the schedule');

    const early = await service.runDueDailyReport({ now: at('2026-01-15T02:29:00Z') });
    check(
      'a minute before 08:00 IST nothing is due, and nothing is written',
      early.kind === 'not_due' && (await scheduledRows('2026-01-14')).length === 0,
      early,
    );

    const first = await service.runDueDailyReport({ now: reportAt });
    check(
      "at 08:01 IST the 14th's report runs — skipped, because this server has no mail",
      first.kind === 'ran' &&
        first.run.reportDate === '2026-01-14' &&
        first.run.trigger === 'scheduled' &&
        first.run.status === 'skipped' &&
        first.run.failureReason === 'mail_not_configured' &&
        first.run.attempts === 1 &&
        first.run.recipientCount === 1 &&
        first.run.deliveredCount === 0 &&
        first.run.toMe === false &&
        typeof first.run.error === 'string',
      first,
    );
    const again = await service.runDueDailyReport({ now: at('2026-01-15T02:36:00Z') });
    const rows14 = await scheduledRows('2026-01-14');
    check(
      'the next tick finds it done, and there is one scheduled row for the day',
      again.kind === 'already_done' && rows14.length === 1,
      { again, rows: rows14 },
    );
    check(
      'the row keeps a copy of what was to be sent',
      rows14[0]?.audience === 'recipients' && rows14[0]?.summary_date === '2026-01-14',
      rows14[0],
    );

    await putSetting('report.daily_email_time', '09:00');
    const moved = await service.runDueDailyReport({ now: at('2026-01-15T03:31:00Z') });
    await putSetting('report.daily_email_time', '08:00');
    check(
      'moving the send time after a day was sent does not send it again',
      moved.kind === 'already_done' && (await scheduledRows('2026-01-14')).length === 1,
      moved,
    );

    /* --- two servers at once --- */
    const raced = await Promise.all([
      service.runDueDailyReport({ now: at('2026-01-16T02:31:00Z') }),
      service.runDueDailyReport({ now: at('2026-01-16T02:31:00Z') }),
    ]);
    const kinds = raced.map((outcome) => outcome.kind).sort();
    check(
      'two servers ticking at once: one runs the day, the other stands down',
      kinds.filter((kind) => kind === 'ran').length === 1 &&
        kinds.every((kind) => kind === 'ran' || kind === 'in_progress' || kind === 'already_done') &&
        (await scheduledRows('2026-01-15')).length === 1,
      kinds,
    );

    /* --- retry after a refusal --- */
    const refusing = capturingSender('failed');
    const t0 = at('2026-01-17T02:31:00Z');
    const refused = await service.runDueDailyReport({ now: t0, send: refusing.send });
    check(
      'a refusal by the mail server fails the run, retryably',
      refused.kind === 'ran' &&
        refused.run.status === 'failed' &&
        refused.run.failureReason === 'mail_rejected' &&
        refused.run.attempts === 1 &&
        refusing.sent.length === 1 &&
        JSON.stringify(refusing.sent[0]?.recipients) === JSON.stringify(['owner@example.test']),
      { refused, sent: refusing.sent.map((entry) => entry.recipients) },
    );
    const delivering = capturingSender('sent');
    const tooSoon = await service.runDueDailyReport({
      now: new Date(t0.getTime() + 10 * 60_000),
      send: delivering.send,
    });
    check(
      'ten minutes later it is not tried again yet',
      tooSoon.kind === 'retry_later' && delivering.sent.length === 0,
      tooSoon,
    );
    const retried = await service.runDueDailyReport({
      now: new Date(t0.getTime() + 31 * 60_000),
      send: delivering.send,
    });
    check(
      'after the 30-minute gap it is, on the same row, and delivered',
      retried.kind === 'ran' &&
        retried.run.status === 'sent' &&
        retried.run.attempts === 2 &&
        retried.run.deliveredCount === 1 &&
        retried.run.failureReason === null &&
        retried.run.error === null &&
        delivering.sent.length === 1 &&
        (await scheduledRows('2026-01-16')).length === 1,
      retried,
    );
    const delivered = delivering.sent[0];
    check(
      'what was handed to the mail server: the dated subject, the logo by reference, no script, a text part',
      delivered?.type === 'telecalling-daily-report' &&
        (delivered?.subject.includes('16 Jan 2026') ?? false) &&
        (delivered?.html.includes('cid:jmk-logo') ?? false) &&
        !(delivered?.html.includes('<script') ?? true) &&
        (delivered?.text.includes('TEAM') ?? false),
      { subject: delivered?.subject, type: delivered?.type },
    );
    const afterSent = await service.runDueDailyReport({
      now: new Date(t0.getTime() + 32 * 60_000),
      send: delivering.send,
    });
    check(
      'and once delivered it is done',
      afterSent.kind === 'already_done' && delivering.sent.length === 1,
      afterSent,
    );

    /* --- a server that died at various points --- */
    const leftRun = (date: string, status: string, lease: string, extra: { attempts?: number; finished?: string; reason?: string } = {}) =>
      insert(
        `INSERT INTO report_runs
           (report_type, report_date, trigger_kind, status, attempts, claim_token, claimed_by,
            claimed_at, lease_expires_at, finished_at, failure_reason)
         VALUES ('telecalling_daily', ?, 'scheduled', ?, ?, ?, 'e2e-dead-server', ?, ?, ?, ?)`,
        [
          date,
          status,
          extra.attempts ?? 1,
          randomUUID(),
          lease,
          lease,
          extra.finished ?? null,
          extra.reason ?? null,
        ],
      );

    await leftRun('2026-01-17', 'claimed', '2026-01-18 02:35:00');
    const takeover = capturingSender('sent');
    const tookOver = await service.runDueDailyReport({ now: at('2026-01-18T02:40:00Z'), send: takeover.send });
    check(
      'a claim whose owner died before sending is taken over and delivered',
      tookOver.kind === 'ran' &&
        tookOver.run.status === 'sent' &&
        tookOver.run.attempts === 2 &&
        takeover.sent.length === 1,
      tookOver,
    );

    await leftRun('2026-01-18', 'sending', '2026-01-19 02:35:00');
    const careful = capturingSender('sent');
    const interrupted = await service.runDueDailyReport({ now: at('2026-01-19T02:40:00Z'), send: careful.send });
    const rows18 = await scheduledRows('2026-01-18');
    check(
      'a run that died mid-send is closed as interrupted and NOT sent again',
      interrupted.kind === 'interrupted' &&
        rows18[0]?.status === 'failed' &&
        rows18[0]?.failure_reason === 'interrupted' &&
        rows18[0]?.finished_at instanceof Date &&
        careful.sent.length === 0,
      { interrupted, row: rows18[0] },
    );
    const stillNot = await service.runDueDailyReport({ now: at('2026-01-19T03:40:00Z'), send: careful.send });
    check(
      'not even an hour later',
      stillNot.kind === 'already_done' && careful.sent.length === 0,
      stillNot,
    );

    await leftRun('2026-01-24', 'sending', '2026-01-25 02:45:00');
    await leftRun('2026-01-25', 'claimed', '2026-01-26 02:50:00');
    const busySending = await service.runDueDailyReport({ now: at('2026-01-25T02:40:00Z'), send: careful.send });
    const busyClaimed = await service.runDueDailyReport({ now: at('2026-01-26T02:40:00Z'), send: careful.send });
    check(
      'a run another server holds a live lease on is left alone',
      busySending.kind === 'in_progress' &&
        busyClaimed.kind === 'in_progress' &&
        (await scheduledRows('2026-01-24'))[0]?.status === 'sending' &&
        (await scheduledRows('2026-01-25'))[0]?.status === 'claimed' &&
        careful.sent.length === 0,
      { busySending, busyClaimed },
    );

    await leftRun('2026-01-26', 'failed', '2026-01-27 02:41:00', {
      attempts: 3,
      finished: '2026-01-27 02:31:00',
      reason: 'mail_rejected',
    });
    const exhausted = await service.runDueDailyReport({ now: at('2026-01-27T04:00:00Z'), send: careful.send });
    check(
      'three attempts are the most a day gets',
      exhausted.kind === 'already_done' && careful.sent.length === 0,
      exhausted,
    );

    /* --- the catch-up window, the switch, and a server that has mail --- */
    const late = await service.runDueDailyReport({ now: at('2026-01-21T14:31:00Z') });
    check(
      'a server back at 20:01 IST does not send the day it missed',
      late.kind === 'not_due' && (await scheduledRows('2026-01-20')).length === 0,
      late,
    );

    await putSetting('report.daily_email_enabled', false);
    const off = await service.runDueDailyReport({ now: at('2026-01-22T02:31:00Z') });
    await putSetting('report.daily_email_enabled', true);
    check(
      'switched off, nothing runs and nothing is written',
      off.kind === 'disabled' && (await scheduledRows('2026-01-21')).length === 0,
      off,
    );

    const noMail = await service.runDueDailyReport({ now: at('2026-01-23T02:31:00Z') });
    const withMail = capturingSender('sent');
    const pickedUp = await service.runDueDailyReport({
      now: at('2026-01-23T02:36:00Z'),
      mailConfigured: true,
      send: withMail.send,
    });
    check(
      'a day skipped for want of mail is sent by a server that has mail — nobody had received it',
      noMail.kind === 'ran' &&
        noMail.run.status === 'skipped' &&
        pickedUp.kind === 'ran' &&
        pickedUp.run.status === 'sent' &&
        pickedUp.run.attempts === 2 &&
        withMail.sent.length === 1,
      { noMail, pickedUp },
    );

    const unaddressed = capturingSender('sent');
    const nowhere = await service.runDueDailyReport({
      now: at('2026-01-24T02:31:00Z'),
      recipients: [],
      send: unaddressed.send,
    });
    check(
      'with nobody to send to, the run fails as such and nothing is attempted',
      nowhere.kind === 'ran' &&
        nowhere.run.status === 'failed' &&
        nowhere.run.failureReason === 'no_recipients' &&
        nowhere.run.recipientCount === 0 &&
        unaddressed.sent.length === 0,
      nowhere,
    );
    const addressed = await service.runDueDailyReport({ now: at('2026-01-24T03:05:00Z'), send: unaddressed.send });
    check(
      'and once a recipient exists the next attempt delivers it',
      addressed.kind === 'ran' && addressed.run.status === 'sent' && addressed.run.attempts === 2,
      addressed,
    );

    /* --- the clock itself --- */
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      let ticks = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const clock = scheduler.startTelecallingReportScheduler({
        firstDelayMs: 0,
        tickMs: 15,
        run: async () => {
          ticks += 1;
          if (ticks === 1) await gate;
          if (ticks === 2) throw new Error('a tick that fails');
          return { kind: 'not_due' as const };
        },
      });
      check(
        'a started clock is reported as running in this process',
        service.isDailyReportSchedulerRunning() === true &&
          scheduler.startTelecallingReportScheduler() === clock,
      );
      await sleep(150);
      check('while one tick is running, the next ones are skipped rather than stacked', ticks === 1, ticks);
      release();
      await sleep(150);
      check('a failing tick neither crashes nor stops the clock', ticks >= 3, ticks);
      await clock.stop();
      const stoppedAt = ticks;
      await sleep(80);
      check(
        'stopped, it ticks no more and says so',
        ticks === stoppedAt && service.isDailyReportSchedulerRunning() === false,
        { ticks, stoppedAt },
      );

      let finished = false;
      const slow = scheduler.startTelecallingReportScheduler({
        firstDelayMs: 0,
        tickMs: 60_000,
        run: async () => {
          await sleep(120);
          finished = true;
          return { kind: 'not_due' as const };
        },
      });
      await sleep(30);
      await slow.stop();
      check('stop() waits for the tick in flight to finish', finished);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    check('and no tick ever left a rejection unhandled', rejections.length === 0, rejections.map(String));

    /* ------------------------------------------------------------- preview */
    console.log('\ndaily report — preview, send and status over HTTP');

    const runsBeforePreview = await runRowCount();
    const preview = await adminAsBearer.get(`${API}/reports/daily-email/preview?date=2026-01-14`);
    check(
      "an administrator previews the 14th: today's figures, the dated subject",
      preview.status === 200 &&
        preview.json.report?.reportDate === '2026-01-14' &&
        Number(preview.json.report?.calls?.total) === day14.calls.total &&
        String(preview.json.email?.subject).includes('Wed, 14 Jan 2026'),
      { status: preview.status, subject: preview.json.email?.subject, total: preview.json.report?.calls?.total },
    );
    check(
      'the preview inlines the logo so it renders in an iframe — no attachment reference left',
      String(preview.json.email?.html).includes('data:image/png;base64') &&
        !String(preview.json.email?.html).includes('cid:'),
    );
    check(
      'and a preview writes nothing',
      (await runRowCount()) === runsBeforePreview,
    );

    const todayIst = time.companyDate(new Date());
    const yesterday = time.addDays(todayIst, -1);
    const defaultPreview = await adminAsBearer.get(`${API}/reports/daily-email/preview`);
    check(
      'left out, the day is yesterday',
      defaultPreview.status === 200 && defaultPreview.json.report?.reportDate === yesterday,
      defaultPreview.json.report?.reportDate,
    );
    const todayPreview = await adminAsBearer.get(`${API}/reports/daily-email/preview?date=${todayIst}`);
    check(
      'today can be previewed, marked as unfinished',
      todayPreview.status === 200 &&
        todayPreview.json.report?.partial === true &&
        String(todayPreview.json.email?.subject).endsWith('(so far)'),
      { status: todayPreview.status, subject: todayPreview.json.email?.subject },
    );
    const future = await adminAsBearer.get(`${API}/reports/daily-email/preview?date=2099-01-01`);
    const impossible = await adminAsBearer.get(`${API}/reports/daily-email/preview?date=2026-02-30`);
    check(
      'a day that has not started is a 400; an impossible date a 422',
      future.status === 400 &&
        future.json.message === 'That day has not started yet.' &&
        impossible.status === 422 &&
        typeof impossible.json.errors?.date === 'string',
      { future: future.json, impossible: impossible.json },
    );

    const anonymous = makeClient(base);
    const gates = await Promise.all([
      ravi.get(`${API}/reports/daily-email/preview?date=2026-01-14`),
      manager.client.get(`${API}/reports/daily-email/preview?date=2026-01-14`),
      supervisor.client.get(`${API}/reports/daily-email/preview?date=2026-01-14`),
      anonymous.get(`${API}/reports/daily-email/preview?date=2026-01-14`),
      ravi.get(`${API}/reports/daily-email`),
      manager.client.get(`${API}/reports/daily-email`),
      ravi.post(`${API}/reports/daily-email/send`, { date: yesterday }),
      manager.client.post(`${API}/reports/daily-email/send`, { date: yesterday }),
      anonymous.post(`${API}/reports/daily-email/send`, { date: yesterday }),
    ]);
    check(
      'administrators only: a telecaller, a manager and a supervisor get 403, nobody signed in 401',
      gates.map((response) => response.status).join(',') === '403,403,403,401,403,403,403,403,401',
      gates.map((response) => response.status),
    );

    /* ---------------------------------------------------------------- send */
    // Yesterday's scheduled run, so a manual send can be shown not to touch it.
    const scheduledYesterday = await service.runDueDailyReport({
      now: time.companyInstant(todayIst, '08:01'),
    });
    const sendRunsBefore = await runRowCount();

    const sent = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: yesterday });
    check(
      "an administrator sends yesterday's report by hand: a manual run, skipped with mail off",
      sent.status === 200 &&
        sent.json.delivery === 'skipped' &&
        sent.json.run?.trigger === 'manual' &&
        sent.json.run?.status === 'skipped' &&
        sent.json.run?.reportDate === yesterday &&
        sent.json.run?.toMe === false &&
        sent.json.run?.recipientCount === 1 &&
        String(sent.json.run?.requestedByLabel).includes('admin@example.test'),
      { status: sent.status, json: sent.json },
    );
    const resent = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: yesterday });
    check(
      'pressing it again straight away is refused as a double send',
      resent.status === 400 && String(resent.json.message).includes('was sent a moment ago'),
      resent.json,
    );
    const defaulted = await adminAsBearer.post(`${API}/reports/daily-email/send`, {});
    check(
      'with no date the day is yesterday — the same guard catches it',
      defaulted.status === 400 &&
        String(defaulted.json.message).includes(email.formatReportDay(yesterday)),
      defaulted.json,
    );

    const toMe = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: yesterday, toMe: true });
    check(
      'a test to oneself is not blocked by the send to everyone — and is a run of its own',
      toMe.status === 200 &&
        toMe.json.run?.toMe === true &&
        toMe.json.run?.trigger === 'manual' &&
        toMe.json.run?.recipientCount === 1 &&
        toMe.json.run?.status === 'skipped' &&
        toMe.json.run?.id !== sent.json.run?.id,
      { status: toMe.status, json: toMe.json },
    );
    const toMeAgain = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: yesterday, toMe: true });
    check(
      'but a second test straight away is',
      toMeAgain.status === 400 && String(toMeAgain.json.message).includes('sent to you a moment ago'),
      toMeAgain.json,
    );

    const scheduledAfter = await scheduledRows(yesterday);
    check(
      'manual sends never touch the scheduled run for the day',
      scheduledYesterday.kind === 'ran' &&
        scheduledAfter.length === 1 &&
        scheduledAfter[0]?.status === 'skipped' &&
        Number(scheduledAfter[0]?.attempts) === 1 &&
        (await runRowCount()) === sendRunsBefore + 2,
      { scheduledYesterday, scheduledAfter },
    );

    const sendToday = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: todayIst });
    const sendFuture = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: '2099-01-01' });
    const sendAncient = await adminAsBearer.post(`${API}/reports/daily-email/send`, {
      date: time.addDays(todayIst, -400),
    });
    const sendImpossible = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: '2026-02-30' });
    const sendBadFlag = await adminAsBearer.post(`${API}/reports/daily-email/send`, { date: yesterday, toMe: 'yes' });
    check(
      "today or a future day is refused — it has not finished; so is a day over a year old",
      sendToday.status === 400 &&
        String(sendToday.json.message).startsWith('Choose a day that has finished.') &&
        sendFuture.status === 400 &&
        sendAncient.status === 400 &&
        String(sendAncient.json.message).includes('within the last year'),
      { today: sendToday.json, future: sendFuture.status, ancient: sendAncient.json },
    );
    check(
      'an impossible date or a non-boolean toMe is a 422',
      sendImpossible.status === 422 && sendBadFlag.status === 422,
      { impossible: sendImpossible.status, flag: sendBadFlag.json },
    );

    const audit = await adminAsBearer.get(`${API}/audit-logs?action=daily_report_sent_manually&pageSize=10`);
    const auditItems = (audit.json.items as Json[] | undefined) ?? [];
    check(
      'both manual sends are audited against their runs, the test marked as such',
      auditItems.some(
        (item) => item.entityType === 'report_run' && item.entityId === sent.json.run?.id && item.meta?.toMe === false,
      ) &&
        auditItems.some((item) => item.entityId === toMe.json.run?.id && item.meta?.toMe === true),
      auditItems.map((item) => ({ entityId: item.entityId, meta: item.meta })),
    );

    /* --- who a send actually reaches, through the service with a stand-in sender --- */
    const admin: Actor = {
      id: adminId,
      name: 'Asha Admin',
      email: 'admin@example.test',
      role: 'admin',
      via: 'bearer',
    };
    const twoDaysAgo = time.addDays(todayIst, -2);
    const threeDaysAgo = time.addDays(todayIst, -3);
    const reach = capturingSender('sent');
    const selfTest = await service.sendDailyReportNow({ date: twoDaysAgo, toMe: true }, admin, { send: reach.send });
    const everyone = await service.sendDailyReportNow({ date: twoDaysAgo }, admin, { send: reach.send });
    check(
      "a test reaches only the administrator who asked; a real send the configured list",
      selfTest.delivery === 'sent' &&
        selfTest.run.toMe === true &&
        everyone.delivery === 'sent' &&
        everyone.run.toMe === false &&
        JSON.stringify(reach.sent.map((entry) => entry.recipients)) ===
          JSON.stringify([['admin@example.test'], ['owner@example.test']]),
      reach.sent.map((entry) => entry.recipients),
    );

    let noAddress: unknown = null;
    try {
      await service.sendDailyReportNow({ date: threeDaysAgo, toMe: true }, { ...admin, email: '' }, { send: reach.send });
    } catch (error) {
      noAddress = error;
    }
    check(
      'a test needs an address to go to',
      noAddress instanceof HttpError && noAddress.status === 400 && reach.sent.length === 2,
      noAddress instanceof Error ? noAddress.message : noAddress,
    );

    const slowServer = capturingSender('sent', 300);
    const pending = await service.sendDailyReportNow({ date: threeDaysAgo }, admin, {
      send: slowServer.send,
      waitMs: 50,
    });
    check(
      'a mail server slower than the wait answers "pending" while it is still sending',
      pending.delivery === 'pending' && ['claimed', 'sending'].includes(pending.run.status),
      pending,
    );
    let settled = await repository.findReportRun(pending.run.id);
    for (let waited = 0; settled?.status !== 'sent' && waited < 5_000; waited += 100) {
      await sleep(100);
      settled = await repository.findReportRun(pending.run.id);
    }
    check(
      'and the run settles in the background once it is done',
      settled?.status === 'sent' && slowServer.sent.length === 1,
      settled?.status,
    );

    /* -------------------------------------------------------------- status */
    const status = await adminAsBearer.get(`${API}/reports/daily-email`);
    const statusConfig = (status.json.config ?? {}) as Json;
    check(
      'the status says who receives it (masked), that mail is off and this server runs no clock',
      status.status === 200 &&
        statusConfig.enabled === true &&
        statusConfig.sendAt === '08:00' &&
        statusConfig.timeZone === 'Asia/Kolkata' &&
        statusConfig.covers === 'previous_day' &&
        statusConfig.schedulerActive === false &&
        statusConfig.mailConfigured === false &&
        statusConfig.recipientCount === 1 &&
        JSON.stringify(statusConfig.recipients) === JSON.stringify(['ow***@example.test']),
      { status: status.status, config: statusConfig },
    );
    check(
      'and when the next report is due',
      typeof status.json.next?.reportDate === 'string' &&
        !Number.isNaN(Date.parse(String(status.json.next?.dueAt))),
      status.json.next,
    );

    const total = await runRowCount();
    const runs = (status.json.runs ?? {}) as Json;
    check(
      'the run history is one page — ten by default — with the full count beside it',
      runs.page === 1 &&
        runs.pageSize === 10 &&
        runs.total === total &&
        runs.totalPages === Math.ceil(total / 10) &&
        Array.isArray(runs.items) &&
        runs.items.length === Math.min(10, total),
      { page: runs.page, pageSize: runs.pageSize, total: runs.total, count: (runs.items as Json[] | undefined)?.length },
    );

    const everything = await adminAsBearer.get(`${API}/reports/daily-email?pageSize=50`);
    const all = (everything.json.runs?.items as Json[] | undefined) ?? [];
    const sorted = all.every((item, index) => {
      const previous = all[index - 1];
      if (!previous) return true;
      return (
        String(previous.reportDate) > String(item.reportDate) ||
        (previous.reportDate === item.reportDate && Number(previous.id) > Number(item.id))
      );
    });
    check(
      'newest report day first, the latest run of a day before the earlier ones',
      everything.status === 200 && all.length === Math.min(50, total) && sorted,
      all.slice(0, 6).map((item) => [item.reportDate, item.id]),
    );
    check(
      'it carries the scheduled run for the 14th, and no claim token anywhere',
      all.some((item) => item.reportDate === '2026-01-14' && item.trigger === 'scheduled') &&
        !JSON.stringify(everything.json).includes('laim_token') &&
        !JSON.stringify(everything.json).includes('claimToken'),
    );

    const secondPage = await adminAsBearer.get(`${API}/reports/daily-email?page=2&pageSize=2`);
    const pageItems = (secondPage.json.runs?.items as Json[] | undefined) ?? [];
    check(
      'page two of two-per-page is the third and fourth runs',
      secondPage.status === 200 &&
        pageItems.length === 2 &&
        pageItems[0]?.id === all[2]?.id &&
        pageItems[1]?.id === all[3]?.id &&
        secondPage.json.runs?.totalPages === Math.ceil(total / 2),
      pageItems.map((item) => item.id),
    );
    const tooBig = await adminAsBearer.get(`${API}/reports/daily-email?pageSize=51`);
    const zero = await adminAsBearer.get(`${API}/reports/daily-email?pageSize=0`);
    const pageZero = await adminAsBearer.get(`${API}/reports/daily-email?page=0`);
    check(
      'a page larger than 50, or a page or size of zero, is refused',
      tooBig.status === 422 && zero.status === 422 && pageZero.status === 422,
      [tooBig.status, zero.status, pageZero.status],
    );

    await putSetting('report.daily_email_enabled', false);
    const offStatus = await adminAsBearer.get(`${API}/reports/daily-email`);
    await putSetting('report.daily_email_enabled', true);
    check(
      'switched off, there is no next report',
      offStatus.status === 200 && offStatus.json.config?.enabled === false && offStatus.json.next === null,
      { config: offStatus.json.config, next: offStatus.json.next },
    );
  } finally {
    /* -------------------------------------------------------------- tidy up */
    /*
     * Everything this section wrote goes again, so the import section after it starts from
     * the database the earlier sections left. The settings are back to their defaults.
     */
    await putSetting('report.daily_email_enabled', true).catch(() => undefined);
    await putSetting('report.daily_email_time', '08:00').catch(() => undefined);
    await utcDb.execute("DELETE FROM report_runs WHERE report_type = 'telecalling_daily'");
    if (ids.followUps.length > 0) {
      await utcDb.query('DELETE FROM follow_ups WHERE id IN (?)', [ids.followUps]);
    }
    if (ids.calls.length > 0) await utcDb.query('DELETE FROM calls WHERE id IN (?)', [ids.calls]);
    if (ids.leads.length > 0) await utcDb.query('DELETE FROM leads WHERE id IN (?)', [ids.leads]);
    if (ids.users.length > 0) {
      await utcDb.query('UPDATE telecaller_users SET is_active = 0 WHERE id IN (?)', [ids.users]);
    }
  }

  const [leftovers] = (await utcDb.query(
    "SELECT (SELECT COUNT(*) FROM report_runs WHERE report_type = 'telecalling_daily') AS runs, (SELECT COUNT(*) FROM leads WHERE reference LIKE 'LD-RPT%') AS leads",
  )) as [Json[], unknown];
  check(
    "the section's runs and fixtures are removed again",
    Number(leftovers[0]?.runs) === 0 && Number(leftovers[0]?.leads) === 0,
    leftovers[0],
  );
}
