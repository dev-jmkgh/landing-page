import { randomUUID } from 'node:crypto';
import type { SqlParam } from '../../src/db/pool';
import type { ApiResponse, E2EContext, Json } from './context';

/**
 * Calls: the company-line check on incoming calls, the call list's notes and summary,
 * My Activity's call list and call detail, and idempotent call write-ups.
 *
 * Owned by the calls feature (key `calls`). Runs after the foundation section; the rules
 * every section follows are in `context.ts`.
 *
 * Every fixture here is its own: emails `calls.*`, company numbers `+9196660912NN`, lead
 * and caller numbers `+91 96660 911NN`. The calls with fixed March 2026 instants pin the
 * IST day boundaries without depending on the clock. Rows written straight into the
 * database (legacy calls, a stray note, a recording, audit rows) are removed again or
 * belong to this section's own employees, and the pending follow-ups it books are
 * cancelled at the end.
 */
export async function run(ctx: E2EContext): Promise<void> {
  const { check, db, utcDb, adminAsBearer } = ctx;

  const uuid = () => randomUUID();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  /** A whole-minute instant `days` from now, so a stored due time reads back exactly. */
  const inDays = (days: number) =>
    new Date(Math.floor((Date.now() + days * 86_400_000) / 60_000) * 60_000).toISOString();
  const items = (response: ApiResponse): Json[] => (response.json.items as Json[] | undefined) ?? [];
  const idsOf = (response: ApiResponse): number[] => items(response).map((row) => Number(row.id));
  const sameIds = (actual: number[], expected: number[]) =>
    actual.length === expected.length &&
    [...actual].sort((a, b) => a - b).join(',') === [...expected].sort((a, b) => a - b).join(',');

  async function count(sql: string, params: SqlParam[]): Promise<number> {
    const [rows] = (await db.query(sql, params)) as [Json[], unknown];
    return Number(rows[0]?.n ?? -1);
  }

  async function insertLegacyCall(row: {
    userId: number;
    leadId: number | null;
    phone: string;
    outcome: string;
    startedAt: Date;
    clientUuid: string;
  }): Promise<number> {
    // What an app build from before the company-SIM check left behind: incoming, and
    // nothing to say which SIM took it (`sim_match` NULL).
    const [result] = await utcDb.execute(
      `INSERT INTO calls
         (client_uuid, lead_id, user_id, phone, direction, outcome, channel, source,
          duration_seconds, started_at, followed_up)
       VALUES (?, ?, ?, ?, 'incoming', ?, 'device', 'call_log', 0, ?, 0)`,
      [row.clientUuid, row.leadId, row.userId, row.phone, row.outcome, row.startedAt],
    );
    return (result as { insertId: number }).insertId;
  }

  const callLoggedFor = (leadId: number, callId: number) =>
    count(
      `SELECT COUNT(*) AS n FROM lead_activities
        WHERE lead_id = ? AND type = 'call_logged'
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.callId')) AS UNSIGNED) = ?`,
      [leadId, callId],
    );

  /* ================================================================ fixtures */
  const t1 = await ctx.createSignedInEmployee({
    name: 'Calls Tele One',
    email: 'calls.one@example.test',
    role: 'telecaller',
    companyPhone: '+919666091201',
  });
  const t2 = await ctx.createSignedInEmployee({
    name: 'Calls Tele Two',
    email: 'calls.two@example.test',
    role: 'telecaller',
    companyPhone: '+919666091202',
  });
  const t3 = await ctx.createSignedInEmployee({
    name: 'Calls Tele Three',
    email: 'calls.three@example.test',
    role: 'telecaller',
    companyPhone: '+919666091204',
  });
  const noNumber = await ctx.createSignedInEmployee({
    name: 'Calls No Number',
    email: 'calls.nonumber@example.test',
    role: 'telecaller',
  });
  const sup = await ctx.createSignedInEmployee({
    name: 'Calls Supervisor',
    email: 'calls.supervisor@example.test',
    role: 'supervisor',
  });

  const T1_LINE = { match: 'confirmed', confirmedFor: '9666091201' };
  const T2_LINE = { match: 'confirmed', confirmedFor: '9666091202' };
  const T3_LINE = { match: 'confirmed', confirmedFor: '9666091204' };

  const missedAlerts = (userId: number) =>
    count("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'missed_call'", [
      userId,
    ]);
  const callsOf = (userId: number) =>
    count('SELECT COUNT(*) AS n FROM calls WHERE user_id = ?', [userId]);

  /* ======================================== incoming calls and the company line */
  console.log('\ncalls — incoming calls and the company line');

  const alertsBefore = await missedAlerts(t1.id);

  const noLine = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(50),
    clientUuid: uuid(),
  });
  check(
    'an incoming call with no line evidence is set aside with a 200 — never a 4xx',
    noLine.status === 200 &&
      noLine.json.ignored === true &&
      noLine.json.reason === 'line_unverified' &&
      noLine.json.call === null &&
      noLine.json.deduplicated === false &&
      noLine.json.followUpId === null,
    { status: noLine.status, json: noLine.json },
  );
  check(
    'and nothing was stored, and no missed-call alert went out',
    (await callsOf(t1.id)) === 0 && (await missedAlerts(t1.id)) === alertsBefore,
    { calls: await callsOf(t1.id), alerts: await missedAlerts(t1.id) },
  );

  const verifiedUuid = uuid();
  const verifiedStartedAt = minutesAgo(45);
  const verified = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: verifiedStartedAt,
    clientUuid: verifiedUuid,
    line: { ...T1_LINE, slot: 1, label: 'Office SIM' },
  });
  const verifiedCall = (verified.json.call ?? {}) as Json;
  check(
    'a call verified on the company SIM is stored (201), not ignored',
    verified.status === 201 && verified.json.ignored === false && verified.json.reason === null,
    { status: verified.status, json: verified.json },
  );
  check(
    'stamped with the company number from the employee record, and how it was verified',
    verifiedCall.receivedOnPhone === '+919666091201' && verifiedCall.simMatch === 'confirmed',
    verifiedCall,
  );
  check(
    'and only a verified missed call raises a missed-call alert',
    (await missedAlerts(t1.id)) === alertsBefore + 1,
    { before: alertsBefore, after: await missedAlerts(t1.id) },
  );

  const sneakyManual = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'answered',
    durationSeconds: 30,
    startedAt: minutesAgo(44),
    clientUuid: uuid(),
  });
  check(
    'leaving out `source` (so it reads as typed in) does not get round the check',
    sneakyManual.status === 200 &&
      sneakyManual.json.ignored === true &&
      sneakyManual.json.reason === 'line_unverified',
    sneakyManual.json,
  );

  const sneakyCloud = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'answered',
    channel: 'cloud',
    durationSeconds: 30,
    startedAt: minutesAgo(43),
    clientUuid: uuid(),
  });
  check(
    'and neither does claiming the cloud channel',
    sneakyCloud.status === 200 && sneakyCloud.json.ignored === true,
    sneakyCloud.json,
  );

  const stale = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(42),
    clientUuid: uuid(),
    line: { match: 'confirmed', confirmedFor: '9666091299' },
  });
  check(
    'a SIM chosen against a number that is no longer the company one is set aside as stale',
    stale.status === 200 && stale.json.ignored === true && stale.json.reason === 'stale_confirmation',
    stale.json,
  );

  const colleagueClientUuid = uuid();
  const colleagueSim = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(41),
    clientUuid: colleagueClientUuid,
    line: { match: 'number', confirmedFor: '9666091201', simNumber: '9666091202' },
  });
  check(
    "a call that reached a colleague's company SIM is set aside, not stored for either of them",
    colleagueSim.status === 200 &&
      colleagueSim.json.reason === 'other_employee_line' &&
      (await count('SELECT COUNT(*) AS n FROM calls WHERE client_uuid = ?', [colleagueClientUuid])) === 0,
    colleagueSim.json,
  );

  const otherSim = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(40),
    clientUuid: uuid(),
    line: { match: 'number', confirmedFor: '9666091201', simNumber: '9666091299' },
  });
  check(
    'a SIM whose own number is not the company number is set aside',
    otherSim.status === 200 && otherSim.json.reason === 'not_company_line',
    otherSim.json,
  );

  const noCompanyNumber = await noNumber.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(39),
    clientUuid: uuid(),
    line: { match: 'confirmed', confirmedFor: '9666091201' },
  });
  check(
    'an employee with no company number on file has nothing to verify against',
    noCompanyNumber.status === 200 && noCompanyNumber.json.reason === 'no_company_number',
    noCompanyNumber.json,
  );

  const malformed = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(38),
    clientUuid: uuid(),
    line: { match: 'provider', confirmedFor: '9666091201' },
  });
  check(
    'evidence a handset may not give (a provider match) is unusable — set aside, still a 200',
    malformed.status === 200 && malformed.json.ignored === true && malformed.json.reason === 'line_unverified',
    { status: malformed.status, json: malformed.json },
  );

  const lenient = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91151',
    direction: 'incoming',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 12,
    startedAt: minutesAgo(37),
    clientUuid: uuid(),
    line: { ...T1_LINE, slot: -1, label: 'x'.repeat(90), simNumber: '12' },
  });
  check(
    'odd informational fields (slot -1, a long label, an unreadable SIM number) do not cost the call',
    lenient.status === 201 && (lenient.json.call as Json | null)?.simMatch === 'confirmed',
    { status: lenient.status, json: lenient.json },
  );

  const byNumber = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91151',
    direction: 'incoming',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 20,
    startedAt: minutesAgo(36),
    clientUuid: uuid(),
    line: { match: 'number', confirmedFor: '9666091201', simNumber: '919666091201' },
  });
  check(
    "a SIM whose own number matches is recorded as matched by number (+91 prefix and all)",
    byNumber.status === 201 && (byNumber.json.call as Json | null)?.simMatch === 'number',
    byNumber.json,
  );

  const outgoingPlain = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91153',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 15,
    startedAt: minutesAgo(35),
    clientUuid: uuid(),
    line: T1_LINE,
  });
  check(
    'an outgoing call needs no line evidence, and any sent is not recorded against it',
    outgoingPlain.status === 201 &&
      (outgoingPlain.json.call as Json | null)?.simMatch === null &&
      (outgoingPlain.json.call as Json | null)?.receivedOnPhone === null,
    outgoingPlain.json.call,
  );

  const batch = await t1.client.post('/mobile/calls/batch', {
    calls: [
      {
        phone: '+91 96660 91151',
        direction: 'incoming',
        outcome: 'missed',
        source: 'call_log',
        startedAt: minutesAgo(34),
        clientUuid: uuid(),
        line: T1_LINE,
      },
      {
        phone: '+91 96660 91151',
        direction: 'incoming',
        outcome: 'missed',
        source: 'call_log',
        startedAt: minutesAgo(33),
        clientUuid: uuid(),
      },
      {
        phone: '+91 96660 91153',
        direction: 'outgoing',
        outcome: 'no_answer',
        source: 'call_log',
        startedAt: minutesAgo(32),
        clientUuid: uuid(),
      },
    ],
  });
  check(
    'a batch counts the calls set aside separately from those stored',
    batch.status === 200 &&
      batch.json.accepted === 2 &&
      batch.json.duplicates === 0 &&
      batch.json.ignored === 1 &&
      Array.isArray(batch.json.failures) &&
      (batch.json.failures as unknown[]).length === 0,
    batch.json,
  );

  /* --- replays --- */
  const replay = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: verifiedStartedAt,
    clientUuid: verifiedUuid,
    line: T1_LINE,
  });
  check(
    'a replay is answered 200 with the stored call, not ignored',
    replay.status === 200 &&
      replay.json.deduplicated === true &&
      replay.json.ignored === false &&
      replay.json.reason === null &&
      (replay.json.call as Json | null)?.id === verifiedCall.id,
    replay.json,
  );

  const crossReplay = await t2.client.post('/mobile/calls', {
    phone: '+91 96660 91150',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: verifiedStartedAt,
    clientUuid: verifiedUuid,
    line: T2_LINE,
  });
  check(
    "replaying a colleague's call id says it is already stored and shows nothing of it",
    crossReplay.status === 200 &&
      crossReplay.json.deduplicated === true &&
      crossReplay.json.call === null &&
      crossReplay.json.ignored === false,
    crossReplay.json,
  );

  /* --- legacy rows: kept, hidden by default, upgradable by their owner --- */
  const legacyA = await insertLegacyCall({
    userId: t1.id,
    leadId: null,
    phone: '+91 96660 91160',
    outcome: 'missed',
    startedAt: new Date(Date.now() - 31 * 60_000),
    clientUuid: uuid(),
  });
  const legacyB = await insertLegacyCall({
    userId: t1.id,
    leadId: null,
    phone: '+91 96660 91161',
    outcome: 'missed',
    startedAt: new Date(Date.now() - 30 * 60_000),
    clientUuid: uuid(),
  });

  const t1Incoming = await t1.client.get('/mobile/calls?direction=incoming&pageSize=100');
  check(
    "an unverified legacy call is not in the employee's incoming list",
    t1Incoming.status === 200 &&
      !idsOf(t1Incoming).includes(legacyA) &&
      !idsOf(t1Incoming).includes(legacyB) &&
      items(t1Incoming).every((row) => row.simMatch !== null),
    idsOf(t1Incoming),
  );
  check(
    'and every call in the list says which line took it',
    items(t1Incoming).length > 0 &&
      items(t1Incoming).every((row) => 'receivedOnPhone' in row && 'simMatch' in row),
    items(t1Incoming)[0],
  );

  const ownUnverified = await t1.client.get('/mobile/calls?direction=incoming&line=unverified');
  check(
    'the employee can still ask for their own unverified calls explicitly',
    sameIds(idsOf(ownUnverified), [legacyA, legacyB]),
    idsOf(ownUnverified),
  );

  const queue = await t1.client.get('/mobile/calls/pending-callbacks?pageSize=100');
  const queueWide = await t1.client.get('/mobile/calls/pending-callbacks?pageSize=100&line=all');
  check(
    'nor in the callback queue — not even when the request asks for every line',
    queue.status === 200 &&
      !idsOf(queue).includes(legacyA) &&
      !idsOf(queueWide).includes(legacyB) &&
      idsOf(queue).includes(Number(verifiedCall.id)),
    { queue: idsOf(queue), wide: idsOf(queueWide) },
  );

  const adminIncoming = await adminAsBearer.get(
    `/admin/telecalling/calls?userId=${t1.id}&direction=incoming&pageSize=100`,
  );
  const adminUnverified = await adminAsBearer.get(
    `/admin/telecalling/calls?userId=${t1.id}&line=unverified&pageSize=100`,
  );
  const adminAll = await adminAsBearer.get(
    `/admin/telecalling/calls?userId=${t1.id}&line=all&pageSize=100`,
  );
  check(
    "an admin's call monitor leaves them out by default",
    adminIncoming.status === 200 &&
      !idsOf(adminIncoming).includes(legacyA) &&
      idsOf(adminIncoming).includes(Number(verifiedCall.id)),
    idsOf(adminIncoming),
  );
  check(
    'and shows exactly them under line=unverified',
    sameIds(idsOf(adminUnverified), [legacyA, legacyB]) &&
      items(adminUnverified).every((row) => row.direction === 'incoming' && row.simMatch === null),
    idsOf(adminUnverified),
  );
  check(
    'and both kinds under line=all',
    idsOf(adminAll).includes(legacyA) && idsOf(adminAll).includes(Number(verifiedCall.id)),
    idsOf(adminAll),
  );

  const badLine = await adminAsBearer.get('/admin/telecalling/calls?line=personal');
  check('an unknown line value is refused (422)', badLine.status === 422, badLine.status);

  const t1Activity = await t1.client.get('/mobile/activity/calls?limit=50');
  check(
    'and My activity never lists them',
    t1Activity.status === 200 &&
      !idsOf(t1Activity).includes(legacyA) &&
      !idsOf(t1Activity).includes(legacyB),
    idsOf(t1Activity),
  );

  const upgraded = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91160',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(31),
    clientUuid: await clientUuidOf(legacyA),
    line: T1_LINE,
  });
  check(
    "the owner's re-sent call with good evidence upgrades the legacy row in place",
    upgraded.status === 200 &&
      upgraded.json.deduplicated === true &&
      (upgraded.json.call as Json | null)?.id === legacyA &&
      (upgraded.json.call as Json | null)?.simMatch === 'confirmed' &&
      (upgraded.json.call as Json | null)?.receivedOnPhone === '+919666091201',
    upgraded.json,
  );
  const afterUpgrade = await t1.client.get('/mobile/calls?direction=incoming&pageSize=100');
  check(
    'after which it is listed like any verified call',
    idsOf(afterUpgrade).includes(legacyA),
    idsOf(afterUpgrade),
  );

  const notTheirs = await t2.client.post('/mobile/calls', {
    phone: '+91 96660 91161',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(30),
    clientUuid: await clientUuidOf(legacyB),
    line: T2_LINE,
  });
  const legacyBMatch = await simMatchOf(legacyB);
  check(
    "a colleague's replay of it upgrades nothing and sees nothing",
    notTheirs.status === 200 &&
      notTheirs.json.deduplicated === true &&
      notTheirs.json.call === null &&
      legacyBMatch === null,
    { json: notTheirs.json, simMatch: legacyBMatch },
  );

  const oldBuildReplay = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91161',
    direction: 'incoming',
    outcome: 'missed',
    startedAt: minutesAgo(30),
    clientUuid: await clientUuidOf(legacyB),
  });
  check(
    "an older build's replay of its own legacy call drains (200) and leaves it unverified",
    oldBuildReplay.status === 200 &&
      oldBuildReplay.json.deduplicated === true &&
      (oldBuildReplay.json.call as Json | null)?.id === legacyB &&
      (await simMatchOf(legacyB)) === null,
    oldBuildReplay.json,
  );

  /* --- a new lead adopts verified calls from its number, never legacy ones --- */
  const legacyC = await insertLegacyCall({
    userId: t1.id,
    leadId: null,
    phone: '+91 96660 91170',
    outcome: 'missed',
    startedAt: new Date(Date.now() - 29 * 60_000),
    clientUuid: uuid(),
  });
  const verifiedC = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91170',
    direction: 'incoming',
    outcome: 'missed',
    source: 'call_log',
    startedAt: minutesAgo(28),
    clientUuid: uuid(),
    line: T1_LINE,
  });
  const adoptingLead = await t1.client.post('/mobile/leads', {
    customerName: 'Calls Adopting Lead',
    phone: '+91 96660 91170',
    source: 'incoming_call',
  });
  const adoptingLeadId = Number(adoptingLead.json.lead?.id);
  const adoptingView = await t1.client.get(`/mobile/leads/${adoptingLeadId}`);
  const adoptedIds = ((adoptingView.json.calls as Json[] | undefined) ?? []).map((row) => Number(row.id));
  check(
    'creating a lead adopts the verified call from its number',
    adoptingLead.status === 201 && adoptedIds.includes(Number(verifiedC.json.call?.id)),
    { lead: adoptingLead.status, adoptedIds },
  );
  check(
    'but leaves the unverified legacy call where it was',
    !adoptedIds.includes(legacyC) &&
      (await count('SELECT COUNT(*) AS n FROM calls WHERE id = ? AND lead_id IS NULL', [legacyC])) === 1,
    adoptedIds,
  );

  // An adopted call the employee answered is contact: the new lead must not open under
  // "not yet called" (a work list) as though nobody had spoken to the customer.
  const answeredOrphan = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91171',
    direction: 'incoming',
    outcome: 'answered',
    durationSeconds: 95,
    source: 'call_log',
    startedAt: minutesAgo(20),
    clientUuid: uuid(),
    line: T1_LINE,
  });
  const contactedLead = await t1.client.post('/mobile/leads', {
    customerName: 'Calls Contacted Lead',
    phone: '+91 96660 91171',
    source: 'incoming_call',
  });
  const contactedView = await t1.client.get(`/mobile/leads/${Number(contactedLead.json.lead?.id)}`);
  check(
    'a lead that adopts an answered call opens as contacted, with that call as its last contact',
    answeredOrphan.status === 201 &&
      contactedLead.status === 201 &&
      typeof contactedView.json.lead?.lastContactedAt === 'string' &&
      Math.abs(Date.parse(contactedView.json.lead.lastContactedAt) - Date.parse(minutesAgo(20))) < 120_000,
    { lead: contactedView.json.lead?.lastContactedAt, call: answeredOrphan.status },
  );

  /*
   * A follow-up booked on a call and then moved to ANOTHER customer's lead belongs to that
   * customer now. Saving the call's write-up again must not re-time it (it is someone
   * else's work), and must book this customer a follow-up of their own.
   */
  const moveFromLead = await adminAsBearer.post('/admin/telecalling/leads', {
    customerName: 'Calls Move From',
    phone: '+91 96660 91172',
    source: 'manual',
    assignedTo: t1.id,
  });
  const moveToLead = await adminAsBearer.post('/admin/telecalling/leads', {
    customerName: 'Calls Move To',
    phone: '+91 96660 91173',
    source: 'manual',
    assignedTo: t2.id,
  });
  const moveFromId = Number(moveFromLead.json.lead?.id);
  const moveToId = Number(moveToLead.json.lead?.id);
  const movedFirstDue = inDays(3);
  const bookedCall = await t1.client.post('/mobile/calls', {
    leadId: moveFromId,
    phone: '+91 96660 91172',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'manual',
    durationSeconds: 60,
    startedAt: minutesAgo(15),
    followUpAt: movedFirstDue,
    clientUuid: uuid(),
  });
  const bookedCallId = Number(bookedCall.json.call?.id);
  const bookedFollowUpId = Number(bookedCall.json.followUpId);
  const movedAway = await adminAsBearer.post(`/admin/telecalling/follow-ups/${bookedFollowUpId}/move`, {
    leadId: moveToId,
    assignedTo: t2.id,
    reason: 'Calls: this belongs to the other customer.',
  });
  const reSaved = await t1.client.post(`/mobile/calls/${bookedCallId}/record`, {
    followUpAt: inDays(5),
    clientUuid: uuid(),
  });
  const [movedRows] = (await utcDb.query('SELECT lead_id, due_at FROM follow_ups WHERE id = ?', [
    bookedFollowUpId,
  ])) as [Json[], unknown];
  const reSavedDetail = await t1.client.get(`/mobile/calls/${bookedCallId}`);
  check(
    "re-saving a call's write-up leaves a follow-up moved to another lead alone and books this lead its own",
    movedAway.status === 200 &&
      reSaved.status === 200 &&
      typeof reSaved.json.followUpId === 'number' &&
      reSaved.json.followUpId !== bookedFollowUpId &&
      Number(movedRows[0]?.lead_id) === moveToId &&
      Math.abs(new Date(movedRows[0]?.due_at).getTime() - Date.parse(movedFirstDue)) < 120_000 &&
      reSavedDetail.json.followUp?.id === reSaved.json.followUpId &&
      reSavedDetail.json.followUp?.leadId === moveFromId,
    {
      move: movedAway.status,
      reSaved: reSaved.json,
      moved: movedRows[0],
      detailFollowUp: reSavedDetail.json.followUp,
    },
  );

  /* ================================================== the admin call list */
  console.log('\ncalls — the call list: outcomes, IST days, summary, notes');

  // Fixed instants either side of the IST day boundaries (IST = UTC+5:30).
  const fixed = async (body: Json) =>
    t3.client.post('/mobile/calls', { source: 'call_log', clientUuid: uuid(), ...body });

  const c1 = await fixed({
    phone: '+91 96660 91131',
    direction: 'outgoing',
    outcome: 'answered',
    durationSeconds: 120,
    startedAt: '2026-03-10T19:00:00.000Z', // 00:30 IST on 11 March
  });
  const c2 = await fixed({
    phone: '+91 96660 91132',
    direction: 'outgoing',
    outcome: 'no_answer',
    startedAt: '2026-03-11T18:29:59.000Z', // 23:59:59 IST on 11 March
  });
  const c3 = await fixed({
    phone: '+91 96660 91133',
    direction: 'outgoing',
    outcome: 'busy',
    startedAt: '2026-03-11T18:30:00.000Z', // 00:00 IST on 12 March
  });
  const c4 = await fixed({
    phone: '+91 96660 91134',
    direction: 'outgoing',
    outcome: 'answered',
    durationSeconds: 60,
    startedAt: '2026-03-10T18:29:59.000Z', // 23:59:59 IST on 10 March
  });
  const c5 = await fixed({
    phone: '+91 96660 91135',
    direction: 'incoming',
    outcome: 'rejected',
    startedAt: '2026-03-11T05:00:00.000Z', // 10:30 IST on 11 March
    line: T3_LINE,
  });
  const id1 = Number(c1.json.call?.id);
  const id2 = Number(c2.json.call?.id);
  const id3 = Number(c3.json.call?.id);
  const id4 = Number(c4.json.call?.id);
  const id5 = Number(c5.json.call?.id);
  check(
    'the fixed-instant calls are stored',
    [c1, c2, c3, c4, c5].every((r) => r.status === 201),
    [c1, c2, c3, c4, c5].map((r) => r.status),
  );

  const callsQuery = (query: string) =>
    adminAsBearer.get(`/admin/telecalling/calls?userId=${t3.id}&pageSize=100${query}`);

  const day11 = await callsQuery('&from=2026-03-11&to=2026-03-11');
  check(
    'a day filter is the IST day: 00:30 and 23:59:59 IST are in, 00:00 the next day is not',
    sameIds(idsOf(day11), [id1, id2, id5]),
    idsOf(day11),
  );
  const day10 = await callsQuery('&from=2026-03-10&to=2026-03-10');
  const day12 = await callsQuery('&from=2026-03-12&to=2026-03-12');
  check(
    'and the calls either side land on the IST day they happened',
    sameIds(idsOf(day10), [id4]) && sameIds(idsOf(day12), [id3]),
    { day10: idsOf(day10), day12: idsOf(day12) },
  );
  check(
    "the list's summary covers exactly the filtered calls",
    day11.json.total === 3 &&
      day11.json.summary?.answered === 1 &&
      day11.json.summary?.unanswered === 2 &&
      day11.json.summary?.talkTimeSeconds === 120,
    { total: day11.json.total, summary: day11.json.summary },
  );

  const allOfT3 = await callsQuery('');
  check(
    'and the whole list: answered + unanswered = total, talk time from answered calls only',
    allOfT3.json.total === 5 &&
      allOfT3.json.summary?.answered === 2 &&
      allOfT3.json.summary?.unanswered === 3 &&
      allOfT3.json.summary?.talkTimeSeconds === 180,
    { total: allOfT3.json.total, summary: allOfT3.json.summary },
  );

  const unanswered = await callsQuery('&outcome=unanswered');
  check(
    'outcome=unanswered is every unanswered outcome at once, not a value that matches nothing',
    unanswered.status === 200 && sameIds(idsOf(unanswered), [id2, id3, id5]),
    idsOf(unanswered),
  );
  const incomingUnanswered = await callsQuery('&direction=incoming&outcome=unanswered');
  const answeredOnly = await callsQuery('&outcome=answered');
  check(
    'it combines with direction, and single outcomes still filter as before',
    sameIds(idsOf(incomingUnanswered), [id5]) && sameIds(idsOf(answeredOnly), [id1, id4]),
    { incomingUnanswered: idsOf(incomingUnanswered), answered: idsOf(answeredOnly) },
  );

  const badOutcome = await adminAsBearer.get('/admin/telecalling/calls?outcome=nope');
  check(
    'an unknown outcome is refused (422), never read as "no filter"',
    badOutcome.status === 422 && badOutcome.json.code === 'validation_failed',
    badOutcome.json,
  );

  const mobileList = await t3.client.get('/mobile/calls?pageSize=100');
  check(
    'the mobile list carries the summary too, and no notes (those are for the admin list)',
    mobileList.json.total === 5 &&
      mobileList.json.summary?.answered === 2 &&
      items(mobileList).every((row) => !('latestNote' in row) && !('noteCount' in row)),
    { total: mobileList.json.total, summary: mobileList.json.summary },
  );

  const telecallerMonitor = await t1.client.get('/admin/telecalling/calls');
  check('a telecaller is refused the admin call list', telecallerMonitor.status === 403, telecallerMonitor.status);

  /* --- notes on the admin list --- */
  const noteLead = await t1.client.post('/mobile/leads', {
    customerName: 'Calls Lead One',
    phone: '+91 96660 91101',
    source: 'manual',
  });
  const noteLeadId = Number(noteLead.json.lead?.id);
  const noted = await t1.client.post('/mobile/calls', {
    leadId: noteLeadId,
    phone: '+91 96660 91101',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 75,
    startedAt: minutesAgo(27),
    note: 'First word on this call.',
    clientUuid: uuid(),
  });
  const notedId = Number(noted.json.call?.id);
  const secondNote = await t1.client.post(`/mobile/calls/${notedId}/record`, {
    note: 'Second word on this call.',
    clientUuid: uuid(),
  });

  const strayLead = await t1.client.post('/mobile/leads', {
    customerName: 'Calls Lead Two',
    phone: '+91 96660 91102',
    source: 'manual',
  });
  const strayLeadId = Number(strayLead.json.lead?.id);
  // A note on ANOTHER lead pointing at this call — once possible through the notes API.
  const [strayInsert] = await utcDb.execute(
    "INSERT INTO lead_notes (lead_id, user_id, kind, body, call_id) VALUES (?, ?, 'note', 'Stray note.', ?)",
    [strayLeadId, t1.id, notedId],
  );
  const strayNoteId = (strayInsert as { insertId: number }).insertId;

  const notedRows = await adminAsBearer.get(`/admin/telecalling/calls?leadId=${noteLeadId}`);
  const notedRow = items(notedRows).find((row) => Number(row.id) === notedId);
  check(
    'an admin call row carries its newest note, who wrote it, and how many notes it has',
    secondNote.status === 200 &&
      notedRow?.latestNote?.body === 'Second word on this call.' &&
      notedRow?.latestNote?.kind === 'call_note' &&
      notedRow?.latestNote?.authorName === 'Calls Tele One' &&
      typeof notedRow?.latestNote?.createdAt === 'string' &&
      notedRow?.noteCount === 2,
    notedRow,
  );
  check(
    "a note on another lead that points at the call is not counted against it",
    notedRow?.noteCount === 2,
    notedRow?.noteCount,
  );

  const unattachedRow = items(adminIncoming).find((row) => Number(row.id) === Number(verifiedCall.id));
  check(
    'a call with no lead has no note and a count of nought',
    unattachedRow !== undefined && unattachedRow.latestNote === null && unattachedRow.noteCount === 0,
    unattachedRow,
  );

  await utcDb.execute('DELETE FROM lead_notes WHERE id = ?', [strayNoteId]);

  /* ======================================= recordings and the audit log: IST days */
  console.log('\ncalls — recordings and the audit log use the IST day');

  const [recordingInsert] = await utcDb.execute(
    `INSERT INTO call_recordings
       (call_id, lead_id, user_id, storage_key, mime_type, size_bytes, duration_seconds, origin, created_at)
     VALUES (?, NULL, ?, 'e2e-calls/boundary-recording.mp3', 'audio/mpeg', 1, 120, 'cloud', '2026-03-10 19:00:00')`,
    [id1, t3.id],
  );
  const recordingId = (recordingInsert as { insertId: number }).insertId;

  const recordings11 = await adminAsBearer.get(
    `/admin/telecalling/recordings?userId=${t3.id}&from=2026-03-11&to=2026-03-11`,
  );
  const recordings10 = await adminAsBearer.get(
    `/admin/telecalling/recordings?userId=${t3.id}&from=2026-03-10&to=2026-03-10`,
  );
  check(
    'a recording that arrived at 00:30 IST is filed under that IST day, not the UTC one',
    recordings11.status === 200 &&
      idsOf(recordings11).includes(recordingId) &&
      !idsOf(recordings10).includes(recordingId),
    { day11: idsOf(recordings11), day10: idsOf(recordings10) },
  );

  await utcDb.execute(
    `INSERT INTO audit_logs (actor_type, action, entity_type, summary, created_at)
     VALUES ('system', 'calls_e2e_boundary', 'call', 'Boundary probe A', '2026-03-10 19:00:00'),
            ('system', 'calls_e2e_boundary', 'call', 'Boundary probe B', '2026-03-11 18:29:59'),
            ('system', 'calls_e2e_boundary', 'call', 'Boundary probe C', '2026-03-11 18:30:00')`,
  );
  const auditDay = async (day: string) =>
    Number(
      (
        await adminAsBearer.get(
          `/admin/telecalling/audit-logs?action=calls_e2e_boundary&from=${day}&to=${day}`,
        )
      ).json.total ?? -1,
    );
  const audit10 = await auditDay('2026-03-10');
  const audit11 = await auditDay('2026-03-11');
  const audit12 = await auditDay('2026-03-12');
  check(
    'the audit log filter is the IST day at both ends',
    audit10 === 0 && audit11 === 2 && audit12 === 1,
    { audit10, audit11, audit12 },
  );

  await utcDb.execute("DELETE FROM audit_logs WHERE action = 'calls_e2e_boundary'");
  await utcDb.execute('DELETE FROM call_recordings WHERE id = ?', [recordingId]);

  /* ============================================== My activity: the call list */
  console.log('\ncalls — My activity call list');

  const supCall = await sup.client.post('/mobile/calls', {
    phone: '+91 96660 91190',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 9,
    startedAt: minutesAgo(26),
    clientUuid: uuid(),
  });
  const supCallId = Number(supCall.json.call?.id);

  const full = await t1.client.get('/mobile/activity/calls?limit=50&withCounts=true');
  const fullRows = items(full);
  const fullIds = idsOf(full);
  const newestFirst = fullRows.every((row, index) => {
    const next = fullRows[index + 1];
    if (!next) return true;
    const a = Date.parse(String(row.startedAt));
    const b = Date.parse(String(next.startedAt));
    return a > b || (a === b && Number(row.id) > Number(next.id));
  });
  check(
    'My activity lists only my own calls, newest first',
    full.status === 200 &&
      fullRows.length > 0 &&
      fullRows.every((row) => Number(row.userId) === t1.id) &&
      newestFirst,
    fullRows.map((row) => ({ id: row.id, userId: row.userId, startedAt: row.startedAt })),
  );
  check(
    'each row carries its client id and note count, and no unverified incoming call',
    fullRows.every(
      (row) =>
        'clientUuid' in row &&
        typeof row.noteCount === 'number' &&
        (row.direction === 'outgoing' || row.simMatch !== null),
    ),
    fullRows[0],
  );
  const notedListRow = fullRows.find((row) => Number(row.id) === notedId);
  check(
    "a row's latest note shows what was written last, and by whom",
    notedListRow?.latestNote?.body === 'Second word on this call.' &&
      notedListRow?.latestNote?.userName === 'Calls Tele One' &&
      notedListRow?.noteCount === 2,
    notedListRow,
  );

  const counts = (full.json.counts ?? {}) as Json;
  check(
    'the chip counts add up both ways and match the list',
    counts.all === fullRows.length &&
      counts.all === counts.outgoing + counts.incoming &&
      counts.all === counts.linked + counts.unlinked,
    counts,
  );

  const chip = async (query: string) => t1.client.get(`/mobile/activity/calls?limit=50&${query}`);
  const [outgoingChip, incomingChip, linkedChip, unlinkedChip] = await Promise.all([
    chip('direction=outgoing'),
    chip('direction=incoming'),
    chip('linked=true'),
    chip('linked=false'),
  ]);
  check(
    'each filter returns only its own calls, as many as its chip says',
    items(outgoingChip).every((row) => row.direction === 'outgoing') &&
      items(outgoingChip).length === counts.outgoing &&
      items(incomingChip).every((row) => row.direction === 'incoming') &&
      items(incomingChip).length === counts.incoming &&
      items(linkedChip).every((row) => row.leadId !== null) &&
      items(linkedChip).length === counts.linked &&
      items(unlinkedChip).every((row) => row.leadId === null) &&
      items(unlinkedChip).length === counts.unlinked,
    {
      counts,
      outgoing: items(outgoingChip).length,
      incoming: items(incomingChip).length,
      linked: items(linkedChip).length,
      unlinked: items(unlinkedChip).length,
    },
  );

  const searched = await chip('q=Calls%20Lead%20One');
  check(
    'search finds calls by the lead name',
    idsOf(searched).includes(notedId) &&
      items(searched).every((row) => row.leadName === 'Calls Lead One'),
    idsOf(searched),
  );
  const answeredChip = await chip('outcome=answered');
  check(
    'and the outcome filter applies',
    items(answeredChip).length > 0 && items(answeredChip).every((row) => row.outcome === 'answered'),
    items(answeredChip).map((row) => row.outcome),
  );

  const othersView = await t2.client.get('/mobile/activity/calls?limit=50');
  check(
    "another telecaller sees none of mine",
    othersView.status === 200 && !idsOf(othersView).some((id) => fullIds.includes(id)),
    idsOf(othersView),
  );
  const supView = await sup.client.get('/mobile/activity/calls?limit=50');
  const supFloor = await sup.client.get('/mobile/calls?pageSize=100');
  check(
    'a supervisor sees only their own calls here, though the floor list shows everyone',
    sameIds(idsOf(supView), [supCallId]) && idsOf(supFloor).some((id) => fullIds.includes(id)),
    { activity: idsOf(supView), floorHasMine: idsOf(supFloor).some((id) => fullIds.includes(id)) },
  );

  /* --- keyset paging --- */
  const paged: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await t1.client.get(`/mobile/activity/calls?limit=2${query}`);
    paged.push(...idsOf(page));
    cursor = typeof page.json.nextCursor === 'string' ? page.json.nextCursor : null;
    pages += 1;
  } while (cursor !== null && pages < 40);
  check(
    'paging two at a time visits every call exactly once, in order',
    paged.join(',') === fullIds.join(',') && new Set(paged).size === paged.length,
    { paged, fullIds },
  );

  const firstPage = await t1.client.get('/mobile/activity/calls?limit=2&withCounts=true');
  const firstCursor = String(firstPage.json.nextCursor ?? '');
  const arrived = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91153',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 5,
    startedAt: new Date().toISOString(),
    clientUuid: uuid(),
  });
  const arrivedId = Number(arrived.json.call?.id);
  const secondPage = await t1.client.get(
    `/mobile/activity/calls?limit=2&withCounts=true&cursor=${encodeURIComponent(firstCursor)}`,
  );
  check(
    'a call arriving at the top while paging neither repeats nor shifts the next page',
    firstCursor !== '' &&
      !idsOf(secondPage).some((id) => idsOf(firstPage).includes(id)) &&
      !idsOf(secondPage).includes(arrivedId) &&
      idsOf(secondPage).join(',') === fullIds.slice(2, 4).join(','),
    { first: idsOf(firstPage), second: idsOf(secondPage), arrivedId },
  );
  check(
    'counts come only with a first page',
    typeof firstPage.json.counts === 'object' && secondPage.json.counts === undefined,
    { first: firstPage.json.counts, second: secondPage.json.counts },
  );
  const refreshed = await t1.client.get('/mobile/activity/calls?limit=2');
  check('and a fresh first page starts with it', idsOf(refreshed)[0] === arrivedId, idsOf(refreshed));

  const garbage = await t1.client.get('/mobile/activity/calls?cursor=not-a-real-cursor');
  check(
    'a cursor the server did not issue is refused with a plain message (422)',
    garbage.status === 422 &&
      garbage.json.errors?.cursor === 'Could not load more calls. Pull down to refresh.' &&
      !/sql|syntax|select/i.test(JSON.stringify(garbage.json)),
    garbage.json,
  );
  const tooBig = await t1.client.get('/mobile/activity/calls?limit=51');
  const zero = await t1.client.get('/mobile/activity/calls?limit=0');
  const reversed = await t1.client.get('/mobile/activity/calls?from=2026-03-12&to=2026-03-11');
  check(
    'page size is bounded (1–50) and a reversed range is refused',
    tooBig.status === 422 && zero.status === 422 && reversed.status === 422,
    { tooBig: tooBig.status, zero: zero.status, reversed: reversed.status },
  );

  const t3Day11 = await t3.client.get('/mobile/activity/calls?from=2026-03-11&to=2026-03-11');
  const t3Day10 = await t3.client.get('/mobile/activity/calls?from=2026-03-10&to=2026-03-10');
  check(
    'My activity days are IST days too',
    sameIds(idsOf(t3Day11), [id1, id2, id5]) && sameIds(idsOf(t3Day10), [id4]),
    { day11: idsOf(t3Day11), day10: idsOf(t3Day10) },
  );

  /* ================================================================ call detail */
  console.log('\ncalls — call detail');

  const detail = await t1.client.get(`/mobile/calls/${notedId}`);
  const detailNotes = (detail.json.notes as Json[] | undefined) ?? [];
  check(
    "a call's detail lists its notes newest first, with the total beside them",
    detail.status === 200 &&
      Number(detail.json.call?.id) === notedId &&
      detailNotes.map((note) => note.body).join(' | ') ===
        'Second word on this call. | First word on this call.' &&
      detailNotes.every((note) => Number(note.callId) === notedId) &&
      detail.json.notesTotal === 2 &&
      detail.json.call?.noteCount === 2,
    { notes: detailNotes.map((note) => note.body), total: detail.json.notesTotal },
  );
  check(
    'a call filed against a lead offers no lead matches',
    Array.isArray(detail.json.matches) && (detail.json.matches as unknown[]).length === 0,
    detail.json.matches,
  );

  const plainDetail = await t1.client.get(`/mobile/calls/${Number(outgoingPlain.json.call?.id)}`);
  check(
    'an unlinked call whose number matches nobody: no notes, no follow-up, no matches',
    plainDetail.status === 200 &&
      plainDetail.json.notesTotal === 0 &&
      ((plainDetail.json.notes as unknown[] | undefined) ?? [1]).length === 0 &&
      plainDetail.json.followUp === null &&
      ((plainDetail.json.matches as unknown[] | undefined) ?? [1]).length === 0,
    plainDetail.json,
  );

  const t2Lead = await t2.client.post('/mobile/leads', {
    customerName: 'Calls Colleague Lead',
    phone: '+91 96660 91180',
    source: 'manual',
  });
  const t2LeadId = Number(t2Lead.json.lead?.id);
  const toColleagueCustomer = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91180',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 11,
    startedAt: minutesAgo(25),
    clientUuid: uuid(),
  });
  const colleagueCallId = Number(toColleagueCustomer.json.call?.id);
  const ownMatches = await t1.client.get(`/mobile/calls/${colleagueCallId}`);
  const supMatches = await sup.client.get(`/mobile/calls/${colleagueCallId}`);
  check(
    "a telecaller is never offered a colleague's customer to file a call against",
    toColleagueCustomer.json.call?.leadId === null &&
      ((ownMatches.json.matches as unknown[] | undefined) ?? [1]).length === 0,
    ownMatches.json.matches,
  );
  check(
    'while a supervisor, who can see every lead, is',
    supMatches.status === 200 &&
      ((supMatches.json.matches as Json[] | undefined) ?? []).some(
        (match) =>
          Number(match.id) === t2LeadId &&
          match.name === 'Calls Colleague Lead' &&
          typeof match.reference === 'string' &&
          typeof match.status === 'string',
      ),
    supMatches.json.matches,
  );

  const foreignDetail = await t2.client.get(`/mobile/calls/${notedId}`);
  const junkDetail = await t1.client.get('/mobile/calls/not-a-number');
  const missingDetail = await t1.client.get('/mobile/calls/999999999');
  check(
    "someone else's call, a junk id and a missing id are all a plain 404",
    foreignDetail.status === 404 &&
      foreignDetail.json.code === 'not_found' &&
      junkDetail.status === 404 &&
      missingDetail.status === 404,
    [foreignDetail.status, junkDetail.status, missingDetail.status],
  );
  const queueStillWorks = await t1.client.get('/mobile/calls/pending-callbacks');
  check(
    'the callback queue still answers — the detail route did not swallow its path',
    queueStillWorks.status === 200 && Array.isArray(queueStillWorks.json.items),
    queueStillWorks.status,
  );

  /* =========================================== writing a call up, idempotently */
  console.log('\ncalls — idempotent write-ups');

  const writeLead = await t1.client.post('/mobile/leads', {
    customerName: 'Calls Lead Three',
    phone: '+91 96660 91103',
    source: 'manual',
  });
  const writeLeadId = Number(writeLead.json.lead?.id);
  const writeCall = await t1.client.post('/mobile/calls', {
    leadId: writeLeadId,
    phone: '+91 96660 91103',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 140,
    startedAt: minutesAgo(24),
    clientUuid: uuid(),
  });
  const writeCallId = Number(writeCall.json.call?.id);

  const notesOn = (callId: number) =>
    count("SELECT COUNT(*) AS n FROM lead_notes WHERE call_id = ? AND kind = 'call_note'", [callId]);
  const pendingOn = (callId: number) =>
    count("SELECT COUNT(*) AS n FROM follow_ups WHERE call_id = ? AND state = 'pending'", [callId]);

  const keyOne = uuid();
  const firstDue = inDays(3);
  const writeUp = {
    note: 'Written up once.',
    followUpAt: firstDue,
    followUpNote: 'Ring back with the fee details.',
    clientUuid: keyOne,
  };
  const first = await t1.client.post(`/mobile/calls/${writeCallId}/record`, writeUp);
  const firstFollowUpId = Number(first.json.followUpId);
  check(
    'a write-up applies and books its follow-up',
    first.status === 200 &&
      first.json.deduplicated === false &&
      Number.isInteger(firstFollowUpId) &&
      firstFollowUpId > 0 &&
      first.json.call?.recordedAt !== null,
    first.json,
  );

  const again = await t1.client.post(`/mobile/calls/${writeCallId}/record`, writeUp);
  check(
    'the same write-up sent again is acknowledged and applies nothing',
    again.status === 200 &&
      again.json.deduplicated === true &&
      again.json.followUpId === null &&
      (await notesOn(writeCallId)) === 1 &&
      (await pendingOn(writeCallId)) === 1,
    { json: again.json, notes: await notesOn(writeCallId), pending: await pendingOn(writeCallId) },
  );
  check(
    "and the call stays on the lead's timeline exactly once",
    (await callLoggedFor(writeLeadId, writeCallId)) === 1,
    await callLoggedFor(writeLeadId, writeCallId),
  );

  const movedDue = inDays(4);
  const moved = await t1.client.post(`/mobile/calls/${writeCallId}/record`, {
    followUpAt: movedDue,
    clientUuid: uuid(),
  });
  const afterMove = await t1.client.get(`/mobile/calls/${writeCallId}`);
  check(
    'saving the call again with a new time moves its follow-up instead of booking another',
    moved.status === 200 &&
      moved.json.deduplicated === false &&
      Number(moved.json.followUpId) === firstFollowUpId &&
      (await pendingOn(writeCallId)) === 1 &&
      Number(afterMove.json.followUp?.id) === firstFollowUpId &&
      Date.parse(String(afterMove.json.followUp?.dueAt)) === Date.parse(movedDue) &&
      afterMove.json.followUp?.rescheduleCount === 1 &&
      afterMove.json.followUp?.note === 'Ring back with the fee details.',
    { moved: moved.json, followUp: afterMove.json.followUp },
  );
  const [moveRows] = (await db.query(
    `SELECT COUNT(*) AS n FROM lead_activities
      WHERE lead_id = ? AND type = 'follow_up_rescheduled'
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.callId')) AS UNSIGNED) = ?`,
    [writeLeadId, writeCallId],
  )) as [Json[], unknown];
  check(
    'and the timeline says it was moved',
    Number(moveRows[0]?.n) === 1,
    moveRows[0],
  );

  const latestKey = uuid();
  const sameTime = await t1.client.post(`/mobile/calls/${writeCallId}/record`, {
    followUpAt: movedDue,
    clientUuid: latestKey,
  });
  const afterSameTime = await t1.client.get(`/mobile/calls/${writeCallId}`);
  check(
    'saving it with the same time leaves the follow-up exactly as it was',
    sameTime.status === 200 &&
      Number(sameTime.json.followUpId) === firstFollowUpId &&
      afterSameTime.json.followUp?.rescheduleCount === 1,
    afterSameTime.json.followUp,
  );

  const supersededReplay = await t1.client.post(`/mobile/calls/${writeCallId}/record`, writeUp);
  const afterSuperseded = await t1.client.get(`/mobile/calls/${writeCallId}`);
  check(
    'the first write-up replayed after later saves is still recognised (by its note) and applies nothing',
    supersededReplay.status === 200 &&
      supersededReplay.json.deduplicated === true &&
      (await notesOn(writeCallId)) === 1 &&
      Date.parse(String(afterSuperseded.json.followUp?.dueAt)) === Date.parse(movedDue),
    { json: supersededReplay.json, followUp: afterSuperseded.json.followUp },
  );

  /*
   * The latest save carried no note, so only the call's own slot (`record_client_uuid`)
   * remembers its key — the note path above cannot be what recognises this replay. The
   * stamp is pinned to a known instant first: an applied write-up restamps `recorded_at`,
   * so an unchanged stamp proves the replay wrote nothing to the row.
   */
  await utcDb.execute("UPDATE calls SET recorded_at = '2026-01-01 00:00:00' WHERE id = ?", [
    writeCallId,
  ]);
  const latestReplay = await t1.client.post(`/mobile/calls/${writeCallId}/record`, {
    followUpAt: movedDue,
    clientUuid: latestKey,
  });
  const [stampRows] = (await utcDb.query('SELECT recorded_at FROM calls WHERE id = ?', [
    writeCallId,
  ])) as [Json[], unknown];
  const stamp = stampRows[0]?.recorded_at;
  const afterLatestReplay = await t1.client.get(`/mobile/calls/${writeCallId}`);
  check(
    "a note-less write-up replayed is recognised by the call's own key and writes nothing",
    latestReplay.status === 200 &&
      latestReplay.json.deduplicated === true &&
      latestReplay.json.followUpId === null &&
      stamp instanceof Date &&
      stamp.toISOString() === '2026-01-01T00:00:00.000Z' &&
      afterLatestReplay.json.followUp?.rescheduleCount === 1 &&
      (await pendingOn(writeCallId)) === 1,
    { json: latestReplay.json, stamp, followUp: afterLatestReplay.json.followUp },
  );

  const reusedKey = await t1.client.post(`/mobile/calls/${notedId}/record`, { clientUuid: keyOne });
  const reusedLatest = await t1.client.post(`/mobile/calls/${notedId}/record`, {
    clientUuid: latestKey,
  });
  check(
    "a write-up key already used on another call is refused, not applied twice",
    reusedKey.status === 400 &&
      reusedKey.json.code === 'bad_request' &&
      reusedLatest.status === 400 &&
      (await notesOn(notedId)) === 2,
    { byNote: reusedKey.json, byCall: reusedLatest.json },
  );

  const raceCall = await t1.client.post('/mobile/calls', {
    leadId: writeLeadId,
    phone: '+91 96660 91103',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 30,
    startedAt: minutesAgo(23),
    clientUuid: uuid(),
  });
  const raceCallId = Number(raceCall.json.call?.id);
  const raceBody = { note: 'Saved twice at once.', clientUuid: uuid() };
  const raced = await Promise.all([
    t1.client.post(`/mobile/calls/${raceCallId}/record`, raceBody),
    t1.client.post(`/mobile/calls/${raceCallId}/record`, raceBody),
  ]);
  check(
    'two deliveries of one write-up racing each other apply it once',
    raced.every((response) => response.status === 200) &&
      raced.filter((response) => response.json.deduplicated === false).length === 1 &&
      (await notesOn(raceCallId)) === 1,
    { results: raced.map((response) => response.json.deduplicated), notes: await notesOn(raceCallId) },
  );

  /* --- "call logged" only when a call first joins a lead --- */
  const unlinkedIncoming = await t1.client.post('/mobile/calls', {
    phone: '+91 96660 91152',
    direction: 'incoming',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 25,
    startedAt: minutesAgo(22),
    clientUuid: uuid(),
    line: T1_LINE,
  });
  const unlinkedId = Number(unlinkedIncoming.json.call?.id);
  const linking = await t1.client.post(`/mobile/calls/${unlinkedId}/record`, {
    leadId: writeLeadId,
    note: 'This was the customer from lead three.',
    clientUuid: uuid(),
  });
  check(
    'writing up an unlinked call files it under the lead and logs it there once',
    linking.status === 200 &&
      linking.json.call?.leadId === writeLeadId &&
      (await callLoggedFor(writeLeadId, unlinkedId)) === 1,
    { json: linking.json, logged: await callLoggedFor(writeLeadId, unlinkedId) },
  );
  await t1.client.post(`/mobile/calls/${unlinkedId}/record`, {
    note: 'A further thought.',
    clientUuid: uuid(),
  });
  check(
    'a later save of the same call does not log it again',
    (await callLoggedFor(writeLeadId, unlinkedId)) === 1 && (await notesOn(unlinkedId)) === 2,
    { logged: await callLoggedFor(writeLeadId, unlinkedId), notes: await notesOn(unlinkedId) },
  );

  /* --- an unanswered outgoing call stays a callback until one is booked --- */
  const callbackLead = await t1.client.post('/mobile/leads', {
    customerName: 'Calls Lead Four',
    phone: '+91 96660 91104',
    source: 'manual',
  });
  const callbackLeadId = Number(callbackLead.json.lead?.id);
  const unanswered1 = await t1.client.post('/mobile/calls', {
    leadId: callbackLeadId,
    phone: '+91 96660 91104',
    direction: 'outgoing',
    outcome: 'no_answer',
    source: 'call_log',
    startedAt: minutesAgo(21),
    clientUuid: uuid(),
  });
  const unansweredId = Number(unanswered1.json.call?.id);
  const inQueue = async () =>
    idsOf(await t1.client.get('/mobile/calls/pending-callbacks?pageSize=100')).includes(unansweredId);
  const queuedAtFirst = await inQueue();
  const noteOnly = await t1.client.post(`/mobile/calls/${unansweredId}/record`, {
    note: 'No answer. Will try again.',
    clientUuid: uuid(),
  });
  const queuedAfterNote = await inQueue();
  const withFollowUp = await t1.client.post(`/mobile/calls/${unansweredId}/record`, {
    followUpAt: inDays(1),
    clientUuid: uuid(),
  });
  const queuedAfterFollowUp = await inQueue();
  check(
    'an unanswered outgoing call stays in the callback queue when only a note is added',
    queuedAtFirst && noteOnly.status === 200 && noteOnly.json.call?.followedUp === false && queuedAfterNote,
    { queuedAtFirst, queuedAfterNote, followedUp: noteOnly.json.call?.followedUp },
  );
  check(
    'and leaves it once the write-up books the callback as a follow-up',
    withFollowUp.status === 200 && withFollowUp.json.call?.followedUp === true && !queuedAfterFollowUp,
    { followedUp: withFollowUp.json.call?.followedUp, queuedAfterFollowUp },
  );

  /* --- by the call's client id --- */
  const byClientCallUuid = uuid();
  const byClientCall = await t1.client.post('/mobile/calls', {
    leadId: callbackLeadId,
    phone: '+91 96660 91104',
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 48,
    startedAt: minutesAgo(20),
    clientUuid: byClientCallUuid,
  });
  const byClientCallId = Number(byClientCall.json.call?.id);
  const byClientBody = { note: 'Written up before the phone knew the id.', clientUuid: uuid() };
  const byClient = await t1.client.post(`/mobile/calls/by-client/${byClientCallUuid}/record`, byClientBody);
  check(
    'a call can be written up by its own client id',
    byClient.status === 200 &&
      byClient.json.deduplicated === false &&
      Number(byClient.json.call?.id) === byClientCallId &&
      byClient.json.call?.recordedAt !== null,
    byClient.json,
  );
  const byClientAgain = await t1.client.post(`/mobile/calls/by-client/${byClientCallUuid}/record`, byClientBody);
  check(
    'idempotently',
    byClientAgain.status === 200 && byClientAgain.json.deduplicated === true && (await notesOn(byClientCallId)) === 1,
    byClientAgain.json,
  );
  const [byColleague, byJunk, byUnknown] = await Promise.all([
    t2.client.post(`/mobile/calls/by-client/${byClientCallUuid}/record`, { outcome: 'answered' }),
    t1.client.post('/mobile/calls/by-client/not-a-uuid/record', { outcome: 'answered' }),
    t1.client.post(`/mobile/calls/by-client/${uuid()}/record`, { outcome: 'answered' }),
  ]);
  check(
    "a colleague's call, a junk id and an unknown id are all a 404",
    byColleague.status === 404 && byJunk.status === 404 && byUnknown.status === 404,
    [byColleague.status, byJunk.status, byUnknown.status],
  );

  const supervisorKey = uuid();
  const bySupervisor = await sup.client.post(`/mobile/calls/by-client/${byClientCallUuid}/record`, {
    outcome: 'answered',
    clientUuid: supervisorKey,
  });
  const [supRows] = (await db.query('SELECT record_client_uuid FROM calls WHERE id = ?', [
    byClientCallId,
  ])) as [Json[], unknown];
  check(
    "a supervisor may write up a telecaller's call, and it really applies to the row",
    bySupervisor.status === 200 &&
      bySupervisor.json.deduplicated === false &&
      supRows[0]?.record_client_uuid === supervisorKey,
    { json: bySupervisor.json, row: supRows[0] },
  );

  /* ============================================ the Lead View's call helpers */
  console.log("\ncalls — a lead's call history, summary and status changes");

  const callRepo = await import('../../src/modules/telecalling/calls/call.repository');
  const activityRepo = await import('../../src/modules/telecalling/activity/activity.repository');

  const viewLead = await t1.client.post('/mobile/leads', {
    customerName: 'Calls Lead Five',
    phone: '+91 96660 91105',
    source: 'manual',
  });
  const viewLeadId = Number(viewLead.json.lead?.id);
  const onViewLead = async (body: Json) =>
    t1.client.post('/mobile/calls', {
      phone: '+91 96660 91105',
      source: 'call_log',
      clientUuid: uuid(),
      ...body,
    });

  const lv1 = await onViewLead({ leadId: viewLeadId, direction: 'outgoing', outcome: 'no_answer', startedAt: minutesAgo(19) });
  const lv2 = await onViewLead({
    leadId: viewLeadId,
    direction: 'outgoing',
    outcome: 'answered',
    durationSeconds: 100,
    startedAt: minutesAgo(18),
    leadStatus: 'interested',
  });
  const lv3 = await onViewLead({
    direction: 'incoming',
    outcome: 'answered',
    durationSeconds: 40,
    startedAt: minutesAgo(17),
    line: T1_LINE,
  });
  const lvLegacy = await insertLegacyCall({
    userId: t1.id,
    leadId: viewLeadId,
    phone: '+91 96660 91105',
    outcome: 'missed',
    startedAt: new Date(Date.now() - 16 * 60_000),
    clientUuid: uuid(),
  });
  const lv4 = await onViewLead({ leadId: viewLeadId, direction: 'outgoing', outcome: 'busy', startedAt: minutesAgo(15) });
  const lv1Id = Number(lv1.json.call?.id);
  const lv2Id = Number(lv2.json.call?.id);
  const lv3Id = Number(lv3.json.call?.id);
  const lv4Id = Number(lv4.json.call?.id);

  check(
    'an incoming call from the lead attaches to it on the way in',
    lv3.json.call?.leadId === viewLeadId,
    lv3.json.call?.leadId,
  );

  const pageOne = await callRepo.listLeadCallsPage(viewLeadId, 1, 2);
  const pageThree = await callRepo.listLeadCallsPage(viewLeadId, 3, 2);
  const pastEnd = await callRepo.listLeadCallsPage(viewLeadId, 99, 2);
  check(
    "a lead's call history pages newest first, legacy calls included",
    pageOne.total === 5 &&
      pageOne.totalPages === 3 &&
      pageOne.page === 1 &&
      pageOne.pageSize === 2 &&
      pageOne.items.map((call) => call.id).join(',') === [lv4Id, lvLegacy].join(',') &&
      pageThree.items.map((call) => call.id).join(',') === String(lv1Id),
    { one: pageOne.items.map((call) => call.id), three: pageThree.items.map((call) => call.id) },
  );
  check(
    'and a page past the end is the last page',
    pastEnd.page === 3 && pastEnd.items.map((call) => call.id).join(',') === String(lv1Id),
    { page: pastEnd.page, ids: pastEnd.items.map((call) => call.id) },
  );

  const summary = await callRepo.leadCallSummary(viewLeadId);
  check(
    "the lead's call summary counts every call in its history",
    summary.total === 5 &&
      summary.answered === 2 &&
      summary.unanswered === 3 &&
      summary.incoming === 2 &&
      summary.outgoing === 3 &&
      summary.talkTimeSeconds === 140,
    summary,
  );
  check(
    'but counts as pending callbacks only what a callback queue would show',
    summary.pendingCallbacks === 1 &&
      summary.firstCallAt === lv1.json.call?.startedAt &&
      summary.lastCallAt === lv4.json.call?.startedAt,
    summary,
  );

  const emptySummary = await callRepo.leadCallSummary(strayLeadId);
  check(
    'a lead with no calls has a summary of noughts',
    emptySummary.total === 0 &&
      emptySummary.answered === 0 &&
      emptySummary.talkTimeSeconds === 0 &&
      emptySummary.pendingCallbacks === 0 &&
      emptySummary.firstCallAt === null &&
      emptySummary.lastCallAt === null,
    emptySummary,
  );

  // A later status change on lv2, and a first one on lv3, both made by writing them up.
  await t1.client.post(`/mobile/calls/${lv3Id}/record`, { leadStatus: 'walked_in', clientUuid: uuid() });
  await t1.client.post(`/mobile/calls/${lv2Id}/record`, { leadStatus: 'converted', clientUuid: uuid() });

  const changes = await activityRepo.listCallStatusChanges(viewLeadId, [lv1Id, lv2Id, lv3Id, lv4Id]);
  const lv2Change = changes.get(lv2Id);
  const lv3Change = changes.get(lv3Id);
  check(
    'the status change made on a call is found for that call, and only that call',
    changes.size === 2 &&
      !changes.has(lv1Id) &&
      !changes.has(lv4Id) &&
      lv2Change?.from === 'new' &&
      lv2Change?.to === 'interested' &&
      lv2Change?.userName === 'Calls Tele One' &&
      typeof lv2Change?.at === 'string',
    Object.fromEntries(changes),
  );
  check(
    'the first change on a call is the one returned, and a write-up records its own',
    lv3Change?.from === 'interested' && lv3Change?.to === 'walked_in',
    lv3Change,
  );
  const noChanges = await activityRepo.listCallStatusChanges(viewLeadId, []);
  const otherLeadChanges = await activityRepo.listCallStatusChanges(strayLeadId, [lv2Id]);
  check(
    'an empty page asks nothing, and another lead never sees these',
    noChanges.size === 0 && otherLeadChanges.size === 0,
    { empty: noChanges.size, other: otherLeadChanges.size },
  );

  /* ================================================================== cleanup */
  // Later sections start from no pending work of ours.
  await utcDb.execute(
    `UPDATE follow_ups SET state = 'cancelled'
      WHERE state = 'pending' AND assigned_to IN (?, ?, ?, ?, ?)`,
    [t1.id, t2.id, t3.id, noNumber.id, sup.id],
  );

  /* ---------------------------------------------------------------- helpers */
  async function clientUuidOf(callId: number): Promise<string> {
    const [rows] = (await db.query('SELECT client_uuid FROM calls WHERE id = ?', [callId])) as [
      Json[],
      unknown,
    ];
    return String(rows[0]?.client_uuid ?? '');
  }

  async function simMatchOf(callId: number): Promise<string | null> {
    const [rows] = (await db.query('SELECT sim_match FROM calls WHERE id = ?', [callId])) as [
      Json[],
      unknown,
    ];
    return (rows[0]?.sim_match as string | null | undefined) ?? null;
  }
}
