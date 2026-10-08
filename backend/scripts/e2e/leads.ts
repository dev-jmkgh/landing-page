import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import type { E2EContext, Json } from './context';

/**
 * Leads: the admin Lead View, its paged histories, latest-note enrichment and the new
 * list filters.
 *
 * Owned by the leads feature (key `leads`). Runs after the dashboard section; the rules
 * every section follows are in `context.ts`.
 *
 * Every fixture here is its own: emails `lv.*`, customer names starting `LeadView` (the
 * list assertions filter on that), lead numbers `+91 93412 770NN`. Rows inserted straight
 * into the database are calls, notes and follow-ups the API has no way to create on demand
 * — a legacy-shaped incoming call, an unattached call, a hundred open follow-ups, two
 * notes in one second. Dates moved into 2025 for the IST boundary checks are put back, the
 * hundred follow-ups are deleted, and the section's other open follow-ups are cancelled at
 * the end, so later sections start with none of ours in their queues.
 */
export async function run(ctx: E2EContext): Promise<void> {
  const { check, utcDb, adminAsBearer, adminId } = ctx;
  const ADMIN = '/admin/telecalling';

  const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
  const items = (response: { json: Json }): Json[] => list(response.json.items);
  const idsOf = (rows: Json[]): number[] => rows.map((row) => Number(row.id));
  const sameIds = (actual: number[], expected: number[]): boolean =>
    actual.length === expected.length && actual.every((id, index) => id === expected[index]);
  const sameSet = (actual: number[], expected: number[]): boolean =>
    sameIds([...actual].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  const insertedId = (result: unknown): number => Number((result as ResultSetHeader).insertId);
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  /** Newest first by `key`, ties broken by the higher id — the order every history uses. */
  const newestFirst = (rows: Json[], key: string): boolean =>
    rows.every((row, index) => {
      const next = rows[index + 1];
      if (!next) return true;
      const a = String(row[key]);
      const b = String(next[key]);
      return a > b || (a === b && Number(row.id) > Number(next.id));
    });
  /** The admin lead list's total for a query string (`&a=b...`), across every lead. */
  const totalOf = async (query: string): Promise<number> =>
    Number((await adminAsBearer.get(`${ADMIN}/leads?pageSize=1${query}`)).json.total);
  /** Today's IST calendar date — the company day every from/to filter means. */
  const istToday = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  /* ------------------------------------------------------------ fixtures */
  console.log('\nleads — Lead View fixtures');

  const caller = await ctx.createSignedInEmployee({
    name: 'LeadView Caller',
    email: 'lv.caller@example.test',
    role: 'telecaller',
  });
  const supervisor = await ctx.createSignedInEmployee({
    name: 'LeadView Supervisor',
    email: 'lv.supervisor@example.test',
    role: 'supervisor',
  });
  const manager = await ctx.createSignedInEmployee({
    name: 'LeadView Manager',
    email: 'lv.manager@example.test',
    role: 'manager',
  });

  /*
   * The lead under test: created by the supervisor with nobody assigned, then assigned by
   * the manager — so its creator and its assigner are two different named people. Created
   * with a clientUuid, which leaves the system note an offline-created lead carries.
   */
  const leadPhone = '+91 93412 77001';
  const createdLead = await supervisor.client.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Deepa',
    phone: leadPhone,
    source: 'manual',
    assignedTo: null,
    summaryNote: 'LV: a summary that any note a person writes outranks.',
    clientUuid: randomUUID(),
  });
  const leadId = Number(createdLead.json.lead?.id);
  check(
    'a supervisor creates a lead with nobody assigned',
    createdLead.status === 201 && createdLead.json.lead?.assignedTo === null,
    createdLead.json,
  );

  const assignedLead = await manager.client.post(`${ADMIN}/leads/${leadId}/assign`, {
    assignedTo: caller.id,
    reason: 'LV: hand it to the caller.',
  });
  check(
    'a manager assigns it to a telecaller',
    assignedLead.status === 200 && assignedLead.json.lead?.assignedTo === caller.id,
    assignedLead.json,
  );

  /* --- five calls: newest first they are busy, unattached-then-named, answered, incoming, missed --- */
  const missed = await caller.client.post('/mobile/calls', {
    leadId,
    phone: leadPhone,
    direction: 'outgoing',
    outcome: 'no_answer',
    source: 'call_log',
    durationSeconds: 6,
    startedAt: minutesAgo(60).toISOString(),
    clientUuid: randomUUID(),
  });
  const answered = await caller.client.post('/mobile/calls', {
    leadId,
    phone: leadPhone,
    direction: 'outgoing',
    outcome: 'answered',
    source: 'call_log',
    durationSeconds: 214,
    startedAt: minutesAgo(10).toISOString(),
    note: 'LV: Wants the weekend batch.',
    leadStatus: 'interested',
    followUpAt: inDays(1),
    followUpNote: 'LV: send the fee structure, then call.',
    clientUuid: randomUUID(),
  });
  const missedId = Number(missed.json.call?.id);
  const answeredId = Number(answered.json.call?.id);
  const callFollowUpId = Number(answered.json.followUpId);
  check(
    'the telecaller logs an unanswered call and an answered one with a note, a status and a follow-up',
    missed.status === 201 &&
      answered.status === 201 &&
      Number.isInteger(callFollowUpId) &&
      callFollowUpId > 0,
    { missed: missed.json, answered: answered.json },
  );

  // An incoming call verified on the company line, as the call log import leaves one.
  const [incomingInsert] = await utcDb.execute(
    `INSERT INTO calls
       (lead_id, user_id, phone, direction, outcome, channel, source, duration_seconds,
        started_at, followed_up, sim_match)
     VALUES (?, ?, ?, 'incoming', 'answered', 'device', 'call_log', 45, ?, 0, 'confirmed')`,
    [leadId, caller.id, leadPhone, minutesAgo(15)],
  );
  const incomingId = insertedId(incomingInsert);

  const firstWriteUp = await caller.client.post(`/mobile/calls/${incomingId}/record`, {
    note: 'LV: First write-up.',
    leadStatus: 'follow_up',
  });
  const secondWriteUp = await caller.client.post(`/mobile/calls/${incomingId}/record`, {
    note: 'LV: Correction to the write-up.',
  });
  check(
    'the incoming call is written up twice, the first time with a status',
    firstWriteUp.status === 200 && secondWriteUp.status === 200,
    { first: firstWriteUp.json, second: secondWriteUp.json },
  );

  // A call that matched no lead, which the telecaller then names onto this one.
  const [orphanInsert] = await utcDb.execute(
    `INSERT INTO calls
       (lead_id, user_id, phone, direction, outcome, channel, source, duration_seconds,
        started_at, followed_up)
     VALUES (NULL, ?, '+91 93412 77099', 'outgoing', 'answered', 'device', 'manual', 30, ?, 0)`,
    [caller.id, minutesAgo(5)],
  );
  const orphanId = insertedId(orphanInsert);
  const named = await caller.client.post(`/mobile/calls/${orphanId}/record`, { leadId });
  check(
    'an unattached call is named onto the lead',
    named.status === 200 && named.json.call?.leadId === leadId,
    named.json,
  );

  // The newest: busy, and nobody has rung back yet.
  const [busyInsert] = await utcDb.execute(
    `INSERT INTO calls
       (lead_id, user_id, phone, direction, outcome, channel, source, duration_seconds,
        started_at, followed_up)
     VALUES (?, ?, ?, 'outgoing', 'busy', 'device', 'call_log', 0, ?, 0)`,
    [leadId, caller.id, leadPhone, minutesAgo(2)],
  );
  const busyId = insertedId(busyInsert);

  /* --- notes the admin writes: one about a call, one with a status change, a requirement --- */
  const callRemark = await adminAsBearer.post(`${ADMIN}/leads/${leadId}/notes`, {
    body: 'LV: Admin remark on the call.',
    callId: answeredId,
  });
  check(
    "a note may name a call in the lead's own history",
    callRemark.status === 201 && callRemark.json.note?.callId === answeredId,
    callRemark.json,
  );

  const walkedIn = await adminAsBearer.post(`${ADMIN}/leads/${leadId}/status`, {
    status: 'walked_in',
    note: 'LV: Came to the office.',
  });
  const requirement = await adminAsBearer.post(`${ADMIN}/leads/${leadId}/notes`, {
    kind: 'requirement',
    body: 'LV: Needs the evening batch and a fee plan.',
  });
  const requirementId = Number(requirement.json.note?.id);
  check(
    'the admin changes the status with a note and records a requirement',
    walkedIn.status === 200 && requirement.status === 201,
    { walkedIn: walkedIn.json, requirement: requirement.json },
  );

  /* --- follow-ups: two open, one completed, one cancelled --- */
  const secondFollowUp = await adminAsBearer.post(`${ADMIN}/follow-ups`, {
    leadId,
    dueAt: inDays(2),
    note: 'LV: second look.',
  });
  const toComplete = await adminAsBearer.post(`${ADMIN}/follow-ups`, { leadId, dueAt: inDays(3) });
  const toCancel = await adminAsBearer.post(`${ADMIN}/follow-ups`, { leadId, dueAt: inDays(4) });
  const secondFollowUpId = Number(secondFollowUp.json.followUp?.id);
  const completedId = Number(toComplete.json.followUp?.id);
  const cancelledId = Number(toCancel.json.followUp?.id);
  const completed = await adminAsBearer.post(`${ADMIN}/follow-ups/${completedId}/complete`);
  const cancelled = await adminAsBearer.post(`${ADMIN}/follow-ups/${cancelledId}/cancel`);
  check(
    'three more follow-ups are booked; one is completed and then one cancelled',
    secondFollowUp.status === 201 &&
      completed.json.followUp?.state === 'completed' &&
      cancelled.json.followUp?.state === 'cancelled',
    { completed: completed.json, cancelled: cancelled.json },
  );

  /* ------------------------------------------------------- the Lead View */
  console.log('\nleads — the Lead View');

  const view = await adminAsBearer.get(`${ADMIN}/leads/${leadId}`);
  const lead = (view.json.lead ?? {}) as Json;
  check('an admin opens the Lead View', view.status === 200 && lead.id === leadId, {
    status: view.status,
    lead,
  });
  check(
    'it names who created the lead and who assigned it to whom',
    lead.createdBy === supervisor.id &&
      lead.createdByName === 'LeadView Supervisor' &&
      lead.assignedBy === manager.id &&
      lead.assignedByName === 'LeadView Manager' &&
      lead.assignedTo === caller.id &&
      lead.assignedToName === 'LeadView Caller',
    lead,
  );
  check('and carries the current status', lead.status === 'walked_in', lead.status);

  const viewer = (view.json.viewer ?? {}) as Json;
  check(
    'an admin may play recordings, archive and delete',
    viewer.role === 'admin' &&
      viewer.canPlayRecordings === true &&
      viewer.canArchive === true &&
      viewer.canDelete === true,
    viewer,
  );

  const summary = (view.json.callSummary ?? {}) as Json;
  check(
    'the call figures cover every call on the lead',
    summary.total === 5 &&
      summary.answered === 3 &&
      summary.unanswered === 2 &&
      summary.incoming === 1 &&
      summary.outgoing === 4 &&
      summary.talkTimeSeconds === 289 &&
      summary.pendingCallbacks === 1,
    summary,
  );

  const calls = (view.json.calls ?? {}) as Json;
  const callRows = list(calls.items);
  check(
    'the first page of calls comes paged, twenty to a page',
    calls.page === 1 &&
      calls.pageSize === 20 &&
      calls.total === 5 &&
      calls.totalPages === 1 &&
      callRows.length === 5,
    { ...calls, items: idsOf(callRows) },
  );
  check(
    'newest first, including the call that joined the lead afterwards',
    sameIds(idsOf(callRows), [busyId, orphanId, answeredId, incomingId, missedId]),
    { got: idsOf(callRows), expected: [busyId, orphanId, answeredId, incomingId, missedId] },
  );
  check(
    'the first and last call times are those of the oldest and newest calls',
    typeof summary.firstCallAt === 'string' &&
      summary.firstCallAt === callRows[4]?.startedAt &&
      summary.lastCallAt === callRows[0]?.startedAt,
    { firstCallAt: summary.firstCallAt, lastCallAt: summary.lastCallAt },
  );
  check(
    'each call keeps its ordinary call fields',
    callRows.every(
      (row) => row.userName === 'LeadView Caller' && row.leadId === leadId && row.leadStatus === 'walked_in',
    ),
    callRows.map((row) => ({ id: row.id, userName: row.userName, leadStatus: row.leadStatus })),
  );

  const entry = (id: number): Json => callRows.find((row) => Number(row.id) === id) ?? {};

  const answeredEntry = entry(answeredId);
  const answeredNotes = list(answeredEntry.notes);
  check(
    'an answered call carries its notes, oldest first',
    answeredNotes.length === 2 &&
      answeredNotes[0]?.kind === 'call_note' &&
      answeredNotes[0]?.body === 'LV: Wants the weekend batch.' &&
      answeredNotes[1]?.body === 'LV: Admin remark on the call.',
    answeredNotes,
  );
  check(
    'the follow-up booked on it',
    list(answeredEntry.followUps).length === 1 &&
      list(answeredEntry.followUps)[0]?.id === callFollowUpId &&
      list(answeredEntry.followUps)[0]?.callId === answeredId,
    answeredEntry.followUps,
  );
  check(
    'and the status it set, with who set it',
    answeredEntry.statusChange?.from === 'new' &&
      answeredEntry.statusChange?.to === 'interested' &&
      answeredEntry.statusChange?.userName === 'LeadView Caller' &&
      typeof answeredEntry.statusChange?.at === 'string',
    answeredEntry.statusChange,
  );

  const incomingEntry = entry(incomingId);
  check(
    'a call written up twice lists both write-ups in the order they were written',
    list(incomingEntry.notes).map((note) => note.body).join(' | ') ===
      'LV: First write-up. | LV: Correction to the write-up.',
    list(incomingEntry.notes).map((note) => note.body),
  );
  check(
    'with the status its write-up set and no follow-up of its own',
    incomingEntry.statusChange?.from === 'interested' &&
      incomingEntry.statusChange?.to === 'follow_up' &&
      list(incomingEntry.followUps).length === 0,
    { statusChange: incomingEntry.statusChange, followUps: incomingEntry.followUps },
  );
  check(
    'a call nothing was recorded against has empty lists and no status change',
    [missedId, busyId].every(
      (id) =>
        list(entry(id).notes).length === 0 &&
        list(entry(id).followUps).length === 0 &&
        entry(id).statusChange === null,
    ),
    [entry(missedId), entry(busyId)],
  );
  check(
    'the call named onto the lead is in its history, marked written up, with no notes',
    entry(orphanId).leadId === leadId &&
      typeof entry(orphanId).recordedAt === 'string' &&
      list(entry(orphanId).notes).length === 0,
    entry(orphanId),
  );

  const notes = (view.json.notes ?? {}) as Json;
  const noteRows = list(notes.items);
  check(
    'notes come paged, newest first, every kind including the system note',
    notes.page === 1 &&
      notes.pageSize === 20 &&
      notes.total === 7 &&
      noteRows.length === 7 &&
      Number(noteRows[0]?.id) === requirementId &&
      noteRows.some((note) => note.kind === 'system') &&
      newestFirst(noteRows, 'createdAt'),
    { ...notes, items: noteRows.map((note) => ({ id: note.id, kind: note.kind })) },
  );

  const followUps = (view.json.followUps ?? {}) as Json;
  const pending = list(followUps.pending);
  const closed = (followUps.closed ?? {}) as Json;
  check(
    'open follow-ups come whole, soonest first',
    sameIds(idsOf(pending), [callFollowUpId, secondFollowUpId]) &&
      pending.every((row) => row.state === 'pending') &&
      pending[0]?.callId === answeredId,
    pending.map((row) => ({ id: row.id, state: row.state, dueAt: row.dueAt })),
  );
  check(
    'closed ones come paged, newest first: the cancellation, then the completion',
    closed.page === 1 &&
      closed.pageSize === 20 &&
      closed.total === 2 &&
      sameIds(idsOf(list(closed.items)), [cancelledId, completedId]) &&
      list(closed.items)[0]?.state === 'cancelled' &&
      list(closed.items)[1]?.state === 'completed',
    { ...closed, items: list(closed.items).map((row) => ({ id: row.id, state: row.state })) },
  );

  const [activityRows] = (await utcDb.query(
    'SELECT id FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC, id DESC',
    [leadId],
  )) as [Json[], unknown];
  const activityIds = activityRows.map((row) => Number(row.id));
  const timeline = (view.json.timeline ?? {}) as Json;
  check(
    'the timeline comes paged, newest first',
    timeline.page === 1 &&
      timeline.pageSize === 20 &&
      timeline.total === activityIds.length &&
      activityIds.length > 5 &&
      sameIds(idsOf(list(timeline.items)), activityIds.slice(0, 20)),
    { total: timeline.total, expected: activityIds.length, got: idsOf(list(timeline.items)) },
  );

  const counts = (view.json.counts ?? {}) as Json;
  check(
    'the counts cover the whole history, system notes aside',
    counts.notes === 6 &&
      counts.followUps === 4 &&
      counts.pendingFollowUps === 2 &&
      counts.activities === activityIds.length,
    counts,
  );

  /* ---------------------------------------------------- history pages */
  console.log('\nleads — Lead View history, a page at a time');

  const callsFirst = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/calls?pageSize=2`);
  check(
    'calls page through the whole history',
    callsFirst.status === 200 &&
      callsFirst.json.page === 1 &&
      callsFirst.json.pageSize === 2 &&
      callsFirst.json.total === 5 &&
      callsFirst.json.totalPages === 3 &&
      sameIds(idsOf(items(callsFirst)), [busyId, orphanId]),
    callsFirst.json,
  );

  const callsSecond = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/calls?page=2&pageSize=2`);
  const secondAnswered = items(callsSecond).find((row) => Number(row.id) === answeredId) ?? {};
  check(
    'a later page is enriched the same way, for its own calls',
    sameIds(idsOf(items(callsSecond)), [answeredId, incomingId]) &&
      list(secondAnswered.notes).length === 2 &&
      secondAnswered.statusChange?.to === 'interested' &&
      list(secondAnswered.followUps)[0]?.id === callFollowUpId,
    callsSecond.json,
  );

  const callsLast = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/calls?page=3&pageSize=2`);
  check(
    'the last page holds the oldest call',
    callsLast.json.page === 3 && sameIds(idsOf(items(callsLast)), [missedId]),
    callsLast.json,
  );

  const callsBeyond = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/calls?page=40&pageSize=2`);
  check(
    'a page past the end answers with the last page, and says which page it is',
    callsBeyond.status === 200 &&
      callsBeyond.json.page === 3 &&
      sameIds(idsOf(items(callsBeyond)), [missedId]),
    callsBeyond.json,
  );

  const callsDefault = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/calls`);
  check(
    'twenty to a page unless asked otherwise',
    callsDefault.json.pageSize === 20 && items(callsDefault).length === 5,
    { pageSize: callsDefault.json.pageSize, items: items(callsDefault).length },
  );

  const notesFirst = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/notes?pageSize=3`);
  const notesLast = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/notes?page=3&pageSize=3`);
  check(
    'notes page newest first, in the order the Lead View opened with',
    notesFirst.status === 200 &&
      notesFirst.json.total === 7 &&
      notesFirst.json.totalPages === 3 &&
      sameIds(idsOf(items(notesFirst)), idsOf(noteRows.slice(0, 3))),
    notesFirst.json,
  );
  check(
    'and the system note the lead was created with is the last one',
    items(notesLast).length === 1 && items(notesLast)[0]?.kind === 'system',
    notesLast.json,
  );

  const closedFirst = await adminAsBearer.get(`${ADMIN}/leads/${leadId}/follow-ups?pageSize=1`);
  const closedSecond = await adminAsBearer.get(
    `${ADMIN}/leads/${leadId}/follow-ups?page=2&pageSize=1`,
  );
  check(
    'closed follow-ups page newest first and never include an open one',
    closedFirst.status === 200 &&
      closedFirst.json.total === 2 &&
      sameIds(idsOf(items(closedFirst)), [cancelledId]) &&
      sameIds(idsOf(items(closedSecond)), [completedId]),
    { first: closedFirst.json, second: closedSecond.json },
  );

  const activitySecond = await adminAsBearer.get(
    `${ADMIN}/leads/${leadId}/activity?page=2&pageSize=3`,
  );
  check(
    'the timeline pages newest first',
    activitySecond.status === 200 &&
      activitySecond.json.total === activityIds.length &&
      sameIds(idsOf(items(activitySecond)), activityIds.slice(3, 6)),
    { got: idsOf(items(activitySecond)), expected: activityIds.slice(3, 6) },
  );
  check(
    'each entry keeps its type, summary and meta as stored',
    items(activitySecond).every(
      (row) => typeof row.type === 'string' && typeof row.summary === 'string' && 'meta' in row,
    ),
    items(activitySecond),
  );

  for (const [query, label] of [
    [`/leads/${leadId}/calls?pageSize=51`, 'a page of more than fifty calls'],
    [`/leads/${leadId}/notes?pageSize=0`, 'an empty page of notes'],
    [`/leads/${leadId}/follow-ups?pageSize=many`, 'a page size that is not a number'],
    [`/leads/${leadId}/activity?page=0`, 'page zero of the timeline'],
  ] as const) {
    const refused = await adminAsBearer.get(`${ADMIN}${query}`);
    check(
      `${label} is refused with a 422`,
      refused.status === 422 && refused.json.code === 'validation_failed',
      { status: refused.status, json: refused.json },
    );
  }

  const missingView = await adminAsBearer.get(`${ADMIN}/leads/999999999`);
  check(
    'a lead that does not exist is a 404',
    missingView.status === 404 && missingView.json.code === 'not_found',
    { status: missingView.status, json: missingView.json },
  );
  for (const history of ['calls', 'notes', 'follow-ups', 'activity']) {
    const missingHistory = await adminAsBearer.get(`${ADMIN}/leads/999999999/${history}`);
    check(
      `and so is its ${history} history`,
      missingHistory.status === 404 && missingHistory.json.code === 'not_found',
      { status: missingHistory.status, json: missingHistory.json },
    );
  }
  const notAnId = await adminAsBearer.get(`${ADMIN}/leads/abc/calls`);
  check('a lead id that is not a number is a 404 too', notAnId.status === 404, notAnId.status);

  /* ------------------------------------------------------------- roles */
  console.log('\nleads — who may open the Lead View');

  const telecallerView = await caller.client.get(`${ADMIN}/leads/${leadId}`);
  check(
    'a telecaller is refused the Lead View, even of their own lead',
    telecallerView.status === 403,
    telecallerView.status,
  );
  for (const history of ['calls', 'notes', 'follow-ups', 'activity']) {
    const refused = await caller.client.get(`${ADMIN}/leads/${leadId}/${history}`);
    check(`and its ${history} history`, refused.status === 403, refused.status);
  }

  const supervisorView = await supervisor.client.get(`${ADMIN}/leads/${leadId}`);
  check(
    'a supervisor opens it, but may not play recordings, archive or delete',
    supervisorView.status === 200 &&
      supervisorView.json.viewer?.role === 'supervisor' &&
      supervisorView.json.viewer?.canPlayRecordings === false &&
      supervisorView.json.viewer?.canArchive === false &&
      supervisorView.json.viewer?.canDelete === false,
    supervisorView.json.viewer,
  );

  const managerView = await manager.client.get(`${ADMIN}/leads/${leadId}`);
  check(
    'a manager may play recordings and archive, but not delete',
    managerView.status === 200 &&
      managerView.json.viewer?.role === 'manager' &&
      managerView.json.viewer?.canPlayRecordings === true &&
      managerView.json.viewer?.canArchive === true &&
      managerView.json.viewer?.canDelete === false,
    managerView.json.viewer,
  );

  /* ------------------------------------------------ the app is unchanged */
  const mobileDetail = await caller.client.get(`/mobile/leads/${leadId}`);
  check(
    'the app lead detail keeps its own shape: plain lists, nothing from the Lead View',
    mobileDetail.status === 200 &&
      Array.isArray(mobileDetail.json.calls) &&
      Array.isArray(mobileDetail.json.notes) &&
      Array.isArray(mobileDetail.json.followUps) &&
      Array.isArray(mobileDetail.json.timeline) &&
      list(mobileDetail.json.calls).length === 5 &&
      !('viewer' in mobileDetail.json) &&
      !('callSummary' in mobileDetail.json) &&
      !('counts' in mobileDetail.json) &&
      !('createdByName' in ((mobileDetail.json.lead ?? {}) as Json)),
    Object.keys(mobileDetail.json),
  );

  /* ------------------------------------- the app pages a lead's history */
  const pagedDetail = await caller.client.get(`/mobile/leads/${leadId}?paged=1`);
  const appHistory = (pagedDetail.json.history ?? {}) as Json;
  check(
    "a paging build's lead detail carries short first pages and says how much of each history there is",
    pagedDetail.status === 200 &&
      appHistory.calls?.total === 5 &&
      appHistory.calls?.page === 1 &&
      appHistory.calls?.pageSize === 10 &&
      appHistory.notes?.total === list(pagedDetail.json.notes).length &&
      appHistory.timeline?.pageSize === 15 &&
      list(pagedDetail.json.timeline).length === Math.min(15, Number(appHistory.timeline?.total)) &&
      list(pagedDetail.json.followUps).every((row) => row.state === 'pending'),
    { history: appHistory, followUps: list(pagedDetail.json.followUps).map((row) => row.state) },
  );

  // Builds already installed cannot ask for a second page, so they keep the amounts they
  // always got instead of being cut off at the first ten entries.
  const legacyHistory = (mobileDetail.json.history ?? {}) as Json;
  check(
    'an older build (no ?paged=1) still gets the amounts it always did: 50 calls, 100 notes, 100 timeline entries',
    legacyHistory.calls?.pageSize === 50 &&
      legacyHistory.notes?.pageSize === 100 &&
      legacyHistory.timeline?.pageSize === 100 &&
      list(mobileDetail.json.timeline).length === Math.min(100, Number(legacyHistory.timeline?.total)),
    legacyHistory,
  );

  const appCallsFirst = await caller.client.get(`/mobile/leads/${leadId}/calls?pageSize=2`);
  const appCallsLast = await caller.client.get(`/mobile/leads/${leadId}/calls?page=3&pageSize=2`);
  check(
    "the app pages through a lead's calls, newest first",
    appCallsFirst.status === 200 &&
      items(appCallsFirst).length === 2 &&
      appCallsFirst.json.total === 5 &&
      appCallsFirst.json.totalPages === 3 &&
      newestFirst(items(appCallsFirst), 'startedAt') &&
      appCallsLast.status === 200 &&
      items(appCallsLast).length === 1 &&
      !idsOf(items(appCallsFirst)).includes(Number(items(appCallsLast)[0]?.id)),
    { first: idsOf(items(appCallsFirst)), last: idsOf(items(appCallsLast)), total: appCallsFirst.json.total },
  );

  const appNotes = await caller.client.get(`/mobile/leads/${leadId}/notes?pageSize=1`);
  const appTimeline = await caller.client.get(`/mobile/leads/${leadId}/timeline?pageSize=3`);
  check(
    'and its notes and timeline, each with the same total the detail gave',
    appNotes.status === 200 &&
      items(appNotes).length === Math.min(1, Number(appHistory.notes?.total)) &&
      appNotes.json.total === appHistory.notes?.total &&
      appTimeline.status === 200 &&
      items(appTimeline).length === Math.min(3, Number(appHistory.timeline?.total)) &&
      appTimeline.json.total === appHistory.timeline?.total &&
      newestFirst(items(appTimeline), 'createdAt'),
    { notes: appNotes.json.total, timeline: appTimeline.json.total },
  );

  const outsider = await ctx.createSignedInEmployee({
    name: 'LeadView Outsider',
    email: 'lv.outsider@example.test',
    role: 'telecaller',
  });
  for (const history of ['calls', 'notes', 'timeline']) {
    const hidden = await outsider.client.get(`/mobile/leads/${leadId}/${history}`);
    check(`another telecaller cannot page this lead's ${history} (404)`, hidden.status === 404, hidden.status);
  }
  const appTooBig = await caller.client.get(`/mobile/leads/${leadId}/calls?pageSize=51`);
  check('the app cannot ask for more than fifty at once (422)', appTooBig.status === 422, appTooBig.status);

  /* ------------------------- a duplicate number names only what you may see */
  const outsiderDuplicate = await outsider.client.post('/mobile/leads', {
    customerName: 'LV Outsider Copy',
    phone: leadPhone,
    source: 'manual',
    clientUuid: randomUUID(),
  });
  const outsiderText = JSON.stringify(outsiderDuplicate.json);
  check(
    "a telecaller entering a colleague's customer's number is refused without learning who that is",
    outsiderDuplicate.status === 400 &&
      typeof outsiderDuplicate.json.errors?.phone === 'string' &&
      !outsiderText.includes('LeadView Deepa') &&
      !outsiderText.includes('LD-'),
    outsiderDuplicate.json,
  );

  const ownDuplicate = await caller.client.post('/mobile/leads', {
    customerName: 'LV Own Copy',
    phone: leadPhone,
    source: 'manual',
    clientUuid: randomUUID(),
  });
  check(
    "the lead's own telecaller is told which lead already has the number",
    ownDuplicate.status === 400 && String(ownDuplicate.json.message).includes('LeadView Deepa'),
    ownDuplicate.json,
  );

  const mobileList = await caller.client.get('/mobile/leads');
  check(
    'and the app lead list carries no latest note',
    mobileList.status === 200 &&
      items(mobileList).length >= 1 &&
      items(mobileList).every((row) => !('latestNote' in row)),
    items(mobileList).map((row) => Object.keys(row).includes('latestNote')),
  );

  // Additive, not a change of shape: each follow-up says which call booked it, if one did.
  const appFollowUps = await caller.client.get(`/mobile/follow-ups?scope=all&leadId=${leadId}`);
  const appFollowUp = (id: number): Json | undefined =>
    items(appFollowUps).find((row) => Number(row.id) === id);
  check(
    "the app's follow-ups say which call booked them — the call's id, or null",
    appFollowUps.status === 200 &&
      appFollowUp(callFollowUpId)?.callId === answeredId &&
      appFollowUp(secondFollowUpId)?.callId === null &&
      items(appFollowUps).every((row) => 'callId' in row),
    items(appFollowUps).map((row) => ({ id: row.id, callId: row.callId })),
  );

  /* ---------------------------------------- an empty lead, a capped list */
  console.log('\nleads — an empty history, and the cap on open follow-ups');

  const busyLead = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Busy Lead',
    phone: '+91 93412 77002',
    source: 'manual',
    assignedTo: caller.id,
  });
  const busyLeadId = Number(busyLead.json.lead?.id);

  const emptyView = await adminAsBearer.get(`${ADMIN}/leads/${busyLeadId}`);
  const emptySummary = (emptyView.json.callSummary ?? {}) as Json;
  check(
    'a lead with no history opens with empty first pages, not errors',
    emptyView.status === 200 &&
      emptyView.json.calls?.total === 0 &&
      emptyView.json.calls?.page === 1 &&
      emptyView.json.calls?.totalPages === 1 &&
      list(emptyView.json.calls?.items).length === 0 &&
      emptyView.json.notes?.total === 0 &&
      emptyView.json.followUps?.closed?.total === 0 &&
      list(emptyView.json.followUps?.pending).length === 0,
    emptyView.json,
  );
  check(
    'and call figures of zero, with no first or last call',
    emptySummary.total === 0 &&
      emptySummary.answered === 0 &&
      emptySummary.talkTimeSeconds === 0 &&
      emptySummary.pendingCallbacks === 0 &&
      emptySummary.firstCallAt === null &&
      emptySummary.lastCallAt === null,
    emptySummary,
  );

  /*
   * A hundred and one open follow-ups, more than any real lead carries. Written straight
   * into the table — booking them over HTTP would spend a hundred requests on a guard.
   */
  const capRows: string[] = [];
  const capParams: (number | string | Date)[] = [];
  for (let index = 0; index < 101; index += 1) {
    capRows.push("(?, ?, ?, ?, 'pending', ?)");
    capParams.push(
      busyLeadId,
      caller.id,
      adminId,
      new Date(Date.now() + (index + 1) * 3_600_000),
      `LV cap ${index}`,
    );
  }
  await utcDb.query(
    `INSERT INTO follow_ups (lead_id, assigned_to, created_by, due_at, state, note)
     VALUES ${capRows.join(', ')}`,
    capParams,
  );
  const [capIdRows] = (await utcDb.query(
    "SELECT id FROM follow_ups WHERE lead_id = ? AND state = 'pending' ORDER BY due_at, id",
    [busyLeadId],
  )) as [Json[], unknown];
  const capIds = capIdRows.map((row) => Number(row.id));

  const cappedView = await adminAsBearer.get(`${ADMIN}/leads/${busyLeadId}`);
  const cappedPending = list(cappedView.json.followUps?.pending);
  check(
    'open follow-ups stop at a hundred, soonest first',
    cappedView.status === 200 &&
      capIds.length === 101 &&
      sameIds(idsOf(cappedPending), capIds.slice(0, 100)),
    { returned: cappedPending.length, inserted: capIds.length },
  );
  check(
    'and the count beside them says how many there really are',
    cappedView.json.counts?.pendingFollowUps === 101,
    cappedView.json.counts,
  );

  await utcDb.query('DELETE FROM follow_ups WHERE lead_id = ?', [busyLeadId]);

  /* -------------------------------------------- latest note on the list */
  console.log('\nleads — the latest note on the admin lead list');

  const quietLead = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Quiet',
    phone: '+91 93412 77003',
    source: 'manual',
    assignedTo: null,
    clientUuid: randomUUID(),
  });
  const summaryLead = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Summary',
    phone: '+91 93412 77004',
    source: 'manual',
    summaryNote: 'LV: Prefers calls after 6pm.',
  });
  // Devanagari and an emoji: more UTF-16 units than characters, so a cut by `.slice`
  // and a cut by the database disagree.
  const unicodeText = 'नमस्ते 😀 '.repeat(40);
  const unicodeLead = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Unicode',
    phone: '+91 93412 77005',
    source: 'manual',
    summaryNote: unicodeText,
  });
  const tieLead = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Tie',
    phone: '+91 93412 77006',
    source: 'manual',
    assignedTo: null,
  });
  const quietId = Number(quietLead.json.lead?.id);
  const summaryId = Number(summaryLead.json.lead?.id);
  const unicodeId = Number(unicodeLead.json.lead?.id);
  const tieId = Number(tieLead.json.lead?.id);
  check(
    'four more leads to read notes from',
    [quietLead, summaryLead, unicodeLead, tieLead].every((response) => response.status === 201),
    [quietLead, summaryLead, unicodeLead, tieLead].map((response) => response.json),
  );

  const listed = async (): Promise<Map<number, Json>> => {
    const response = await adminAsBearer.get(`${ADMIN}/leads?q=LeadView&pageSize=100`);
    return new Map(items(response).map((row) => [Number(row.id), row] as const));
  };

  let byId = await listed();
  const latestOf = (id: number): Json | null | undefined =>
    byId.get(id)?.latestNote as Json | null | undefined;

  const latestMain = latestOf(leadId);
  check(
    'the list shows the newest note a person wrote, with its author and time',
    latestMain?.source === 'note' &&
      latestMain?.noteId === requirementId &&
      latestMain?.kind === 'requirement' &&
      latestMain?.body === 'LV: Needs the evening batch and a fee plan.' &&
      latestMain?.userName === 'Asha Admin' &&
      latestMain?.callId === null &&
      latestMain?.truncated === false &&
      typeof latestMain?.createdAt === 'string',
    latestMain,
  );
  check(
    'which is the note the Lead View opens its notes with',
    latestMain?.noteId === Number(noteRows[0]?.id),
    { list: latestMain?.noteId, view: noteRows[0]?.id },
  );
  check(
    'a lead whose only note is a system note shows none — system notes never count',
    byId.has(quietId) && latestOf(quietId) === null,
    latestOf(quietId),
  );
  const latestSummary = latestOf(summaryId);
  check(
    'a lead with no notes shows its summary, which has no author, kind or time',
    latestSummary?.source === 'summary' &&
      latestSummary?.noteId === null &&
      latestSummary?.kind === null &&
      latestSummary?.body === 'LV: Prefers calls after 6pm.' &&
      latestSummary?.truncated === false &&
      latestSummary?.userName === null &&
      latestSummary?.callId === null &&
      latestSummary?.createdAt === null,
    latestSummary,
  );
  const storedUnicode = String(unicodeLead.json.lead?.summaryNote ?? '');
  const latestUnicode = latestOf(unicodeId);
  check(
    'a long summary is cut at 300 characters — characters, not UTF-16 units',
    latestUnicode?.source === 'summary' &&
      latestUnicode?.truncated === true &&
      Array.from(String(latestUnicode?.body ?? '')).length === 300 &&
      latestUnicode?.body === Array.from(storedUnicode).slice(0, 300).join(''),
    {
      characters: Array.from(String(latestUnicode?.body ?? '')).length,
      truncated: latestUnicode?.truncated,
    },
  );
  check(
    'every admin row carries the field, and it is never a system note',
    byId.size >= 5 &&
      [...byId.values()].every(
        (row) => 'latestNote' in row && (row.latestNote === null || row.latestNote?.kind !== 'system'),
      ),
    [...byId.values()].map((row) => row.latestNote?.kind ?? null),
  );

  const longNote = await adminAsBearer.post(`${ADMIN}/leads/${summaryId}/notes`, {
    body: 'x'.repeat(400),
  });
  const unicodeNote = await adminAsBearer.post(`${ADMIN}/leads/${unicodeId}/notes`, {
    body: unicodeText,
  });
  // Two notes in the same second; only the id can say which came last.
  const [tieFirst] = await utcDb.execute(
    `INSERT INTO lead_notes (lead_id, user_id, kind, body, created_at)
     VALUES (?, ?, 'note', 'LV: tie, written first.', '2026-01-05 10:00:00')`,
    [tieId, adminId],
  );
  const [tieSecond] = await utcDb.execute(
    `INSERT INTO lead_notes (lead_id, user_id, kind, body, created_at)
     VALUES (?, ?, 'requirement', 'LV: tie, written second.', '2026-01-05 10:00:00')`,
    [tieId, adminId],
  );
  const tieFirstId = insertedId(tieFirst);
  const tieSecondId = insertedId(tieSecond);

  byId = await listed();
  const latestLong = latestOf(summaryId);
  check(
    'a note outranks the summary, and one over 300 characters is cut and flagged',
    longNote.status === 201 &&
      latestLong?.source === 'note' &&
      latestLong?.kind === 'note' &&
      latestLong?.truncated === true &&
      latestLong?.body === 'x'.repeat(300),
    { source: latestLong?.source, truncated: latestLong?.truncated, length: String(latestLong?.body ?? '').length },
  );
  const latestUnicodeNote = latestOf(unicodeId);
  check(
    'the database cuts a note at the same character the summary cut fell on',
    unicodeNote.status === 201 &&
      latestUnicodeNote?.source === 'note' &&
      latestUnicodeNote?.truncated === true &&
      latestUnicodeNote?.body ===
        Array.from(String(unicodeNote.json.note?.body ?? '')).slice(0, 300).join(''),
    {
      characters: Array.from(String(latestUnicodeNote?.body ?? '')).length,
      truncated: latestUnicodeNote?.truncated,
    },
  );
  const latestTie = latestOf(tieId);
  check(
    'of two notes written in the same second, the later one is the latest',
    tieSecondId > tieFirstId &&
      latestTie?.noteId === tieSecondId &&
      latestTie?.body === 'LV: tie, written second.',
    latestTie,
  );
  const tieNotes = await adminAsBearer.get(`${ADMIN}/leads/${tieId}/notes?pageSize=1`);
  check(
    'and the Lead View opens its notes with that same one',
    Number(items(tieNotes)[0]?.id) === tieSecondId,
    tieNotes.json,
  );

  /* ------------------------------------- a note names only its own calls */
  console.log("\nleads — a note can only name a call in its own lead's history");

  const [beforeCount] = (await utcDb.query(
    'SELECT COUNT(*) AS n FROM lead_notes WHERE lead_id = ?',
    [summaryId],
  )) as [Json[], unknown];
  const foreignCall = await adminAsBearer.post(`${ADMIN}/leads/${summaryId}/notes`, {
    body: "LV: about another lead's call.",
    callId: answeredId,
  });
  const noSuchCall = await adminAsBearer.post(`${ADMIN}/leads/${summaryId}/notes`, {
    body: 'LV: about a call that never happened.',
    callId: 999_999_999,
  });
  const [afterCount] = (await utcDb.query(
    'SELECT COUNT(*) AS n FROM lead_notes WHERE lead_id = ?',
    [summaryId],
  )) as [Json[], unknown];
  check(
    'a note naming a call on a different lead is refused with a 400 against the field',
    foreignCall.status === 400 &&
      foreignCall.json.code === 'bad_request' &&
      typeof (foreignCall.json.errors as Json | undefined)?.callId === 'string',
    foreignCall.json,
  );
  check(
    'and one naming a call that does not exist, in the same words',
    noSuchCall.status === 400 && noSuchCall.json.message === foreignCall.json.message,
    noSuchCall.json,
  );
  check(
    'neither note was written',
    Number(beforeCount[0]?.n) === Number(afterCount[0]?.n),
    { before: beforeCount[0]?.n, after: afterCount[0]?.n },
  );

  const [otherCallRows] = (await utcDb.query(
    'SELECT id FROM calls WHERE lead_id IS NOT NULL AND lead_id <> ? ORDER BY id LIMIT 1',
    [leadId],
  )) as [Json[], unknown];
  const strangersCall = Number(otherCallRows[0]?.id ?? 999_999_999);
  const fromTheApp = await caller.client.post(`/mobile/leads/${leadId}/notes`, {
    body: "LV: from the app, about a stranger's call.",
    callId: strangersCall,
  });
  check(
    'the app is held to the same rule',
    fromTheApp.status === 400 && fromTheApp.json.message === foreignCall.json.message,
    fromTheApp.json,
  );

  /* ------------------------------------------- IST days on the lead list */
  console.log('\nleads — list dates are IST calendar days');

  const early = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Boundary Early',
    phone: '+91 93412 77007',
    source: 'manual',
  });
  const late = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Boundary Late',
    phone: '+91 93412 77008',
    source: 'manual',
  });
  const earlyId = Number(early.json.lead?.id);
  const lateId = Number(late.json.lead?.id);
  const [createdRows] = (await utcDb.query(
    'SELECT id, created_at FROM leads WHERE id IN (?, ?)',
    [earlyId, lateId],
  )) as [Json[], unknown];
  const originalCreated = new Map(createdRows.map((row) => [Number(row.id), row.created_at as Date]));

  /*
   * 00:30 IST on 15 Jan is 19:00 UTC on the 14th; 23:59:59 IST on the 14th is 18:29:59
   * UTC. A UTC-day filter puts both on the 14th.
   */
  await utcDb.execute("UPDATE leads SET created_at = '2025-01-14 19:00:00' WHERE id = ?", [earlyId]);
  await utcDb.execute("UPDATE leads SET created_at = '2025-01-14 18:29:59' WHERE id = ?", [lateId]);

  const boundary = async (range: string): Promise<number[]> =>
    idsOf(items(await adminAsBearer.get(`${ADMIN}/leads?q=${encodeURIComponent('LeadView Boundary')}${range}`)));
  const onFifteenth = await boundary('&from=2025-01-15&to=2025-01-15');
  const onFourteenth = await boundary('&from=2025-01-14&to=2025-01-14');
  const fromFifteenth = await boundary('&from=2025-01-15');
  const toFourteenth = await boundary('&to=2025-01-14');
  check(
    'a lead created at 00:30 IST belongs to that IST day, not the UTC one',
    sameIds(onFifteenth, [earlyId]),
    onFifteenth,
  );
  check(
    'and one created at 23:59:59 IST to the day before',
    sameIds(onFourteenth, [lateId]),
    onFourteenth,
  );
  check(
    'an open-ended range splits them on the same IST midnight',
    fromFifteenth.includes(earlyId) &&
      !fromFifteenth.includes(lateId) &&
      sameIds(toFourteenth, [lateId]),
    { fromFifteenth, toFourteenth },
  );

  // The dashboard's leads chart buckets the same IST days, so a bar opens exactly its rows.
  const createdChart = await adminAsBearer.get(
    `${ADMIN}/dashboard/analytics?from=2025-01-14&to=2025-01-15&granularity=day`,
  );
  const createdOn = (day: string): number =>
    Number(list(createdChart.json.leads).find((bucket) => bucket.bucket === day)?.created ?? NaN);
  const listedOnFourteenth = await totalOf('&from=2025-01-14&to=2025-01-14');
  const listedOnFifteenth = await totalOf('&from=2025-01-15&to=2025-01-15');
  check(
    "each day's bar on the leads chart counts the leads the list shows for that day",
    createdChart.status === 200 &&
      listedOnFourteenth >= 1 &&
      listedOnFifteenth >= 1 &&
      createdOn('2025-01-14') === listedOnFourteenth &&
      createdOn('2025-01-15') === listedOnFifteenth,
    {
      status: createdChart.status,
      chart: [createdOn('2025-01-14'), createdOn('2025-01-15')],
      list: [listedOnFourteenth, listedOnFifteenth],
    },
  );

  for (const [id, createdAt] of originalCreated) {
    await utcDb.execute('UPDATE leads SET created_at = ? WHERE id = ?', [createdAt, id]);
  }

  /* --------------------------------------------- converted in a range */
  console.log('\nleads — converted in a date range');

  const convertedEarly = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Converted Early',
    phone: '+91 93412 77009',
    source: 'manual',
    status: 'converted',
  });
  const convertedLate = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Converted Late',
    phone: '+91 93412 77010',
    source: 'manual',
    status: 'converted',
  });
  const neverConverted = await adminAsBearer.post(`${ADMIN}/leads`, {
    customerName: 'LeadView Converted Never',
    phone: '+91 93412 77011',
    source: 'manual',
  });
  const convertedEarlyId = Number(convertedEarly.json.lead?.id);
  const convertedLateId = Number(convertedLate.json.lead?.id);
  const neverConvertedId = Number(neverConverted.json.lead?.id);

  const converted = async (range: string): Promise<{ status: number; ids: number[] }> => {
    const response = await adminAsBearer.get(
      `${ADMIN}/leads?q=${encodeURIComponent('LeadView Converted')}${range}`,
    );
    return { status: response.status, ids: idsOf(items(response)) };
  };

  // Entered as converted, so converted now — one of today's conversions straight away.
  const convertedToday = await converted(`&convertedFrom=${istToday}&convertedTo=${istToday}`);
  check(
    "a lead entered as converted is one of today's conversions at once",
    convertedToday.status === 200 &&
      sameSet(convertedToday.ids, [convertedEarlyId, convertedLateId]),
    convertedToday,
  );

  const [convertedRows] = (await utcDb.query(
    'SELECT id, converted_at FROM leads WHERE id IN (?, ?)',
    [convertedEarlyId, convertedLateId],
  )) as [Json[], unknown];
  const originalConverted = new Map(
    convertedRows.map((row) => [Number(row.id), row.converted_at as Date | null]),
  );

  // 00:00:00 IST on 2 Feb, and the last second of 1 Feb IST.
  await utcDb.execute("UPDATE leads SET converted_at = '2025-02-01 18:30:00' WHERE id = ?", [
    convertedEarlyId,
  ]);
  await utcDb.execute("UPDATE leads SET converted_at = '2025-02-01 18:29:59' WHERE id = ?", [
    convertedLateId,
  ]);
  // A row no API path produces — a conversion date on a lead that is not converted — which
  // the conversions chart does not count, so neither may the list it opens.
  await utcDb.execute("UPDATE leads SET converted_at = '2025-02-01 20:00:00' WHERE id = ?", [
    neverConvertedId,
  ]);

  const onSecond =await converted('&convertedFrom=2025-02-02&convertedTo=2025-02-02');
  const onFirst = await converted('&convertedFrom=2025-02-01&convertedTo=2025-02-01');
  const sinceFirst = await converted('&convertedFrom=2025-02-01');
  const untilFirst = await converted('&convertedTo=2025-02-01');
  const lostAndConverted = await converted('&status=lost&convertedFrom=2025-02-01');
  check(
    'a lead converted at 00:00 IST is converted on that IST day',
    onSecond.status === 200 && sameIds(onSecond.ids, [convertedEarlyId]),
    onSecond,
  );
  check(
    'one converted a second earlier belongs to the day before',
    sameIds(onFirst.ids, [convertedLateId]),
    onFirst,
  );
  check(
    'either end can be open, and a lead that is not converted never matches',
    sameSet(sinceFirst.ids, [convertedEarlyId, convertedLateId]) &&
      sameIds(untilFirst.ids, [convertedLateId]) &&
      !sinceFirst.ids.includes(neverConvertedId),
    { sinceFirst, untilFirst },
  );
  check(
    'and the range combines with the other filters',
    lostAndConverted.status === 200 && lostAndConverted.ids.length === 0,
    lostAndConverted,
  );

  const badConverted = await adminAsBearer.get(`${ADMIN}/leads?convertedFrom=yesterday`);
  check(
    'a conversion date that is not a date is refused with a 422',
    badConverted.status === 422,
    badConverted.status,
  );

  /*
   * The conversions series is what opens this filter, so each of its bars must count the
   * rows the list shows for its day — overall, and for one employee's leads (the
   * Telecallers chart's "Converted" click-through), which is `assignedTo` on the list.
   */
  const conversionsChart = await adminAsBearer.get(
    `${ADMIN}/dashboard/analytics?from=2025-02-01&to=2025-02-02&granularity=day`,
  );
  const ownerConversionsChart = await adminAsBearer.get(
    `${ADMIN}/dashboard/analytics?from=2025-02-01&to=2025-02-02&granularity=day&userId=${adminId}`,
  );
  const convertedOn = (chart: { json: Json }, day: string): number =>
    Number(list(chart.json.leads).find((bucket) => bucket.bucket === day)?.converted ?? NaN);
  const listedFirst = await totalOf('&convertedFrom=2025-02-01&convertedTo=2025-02-01');
  const listedSecond = await totalOf('&convertedFrom=2025-02-02&convertedTo=2025-02-02');
  const ownerFirst = await totalOf(
    `&assignedTo=${adminId}&convertedFrom=2025-02-01&convertedTo=2025-02-01`,
  );
  const ownerSecond = await totalOf(
    `&assignedTo=${adminId}&convertedFrom=2025-02-02&convertedTo=2025-02-02`,
  );
  check(
    "each day's conversions bar counts the leads the list shows as converted that day",
    conversionsChart.status === 200 &&
      listedFirst >= 1 &&
      listedSecond >= 1 &&
      convertedOn(conversionsChart, '2025-02-01') === listedFirst &&
      convertedOn(conversionsChart, '2025-02-02') === listedSecond,
    {
      status: conversionsChart.status,
      chart: [convertedOn(conversionsChart, '2025-02-01'), convertedOn(conversionsChart, '2025-02-02')],
      list: [listedFirst, listedSecond],
    },
  );
  check(
    "and so does one employee's, against the list narrowed to their leads",
    ownerConversionsChart.status === 200 &&
      ownerFirst >= 1 &&
      convertedOn(ownerConversionsChart, '2025-02-01') === ownerFirst &&
      convertedOn(ownerConversionsChart, '2025-02-02') === ownerSecond,
    {
      chart: [
        convertedOn(ownerConversionsChart, '2025-02-01'),
        convertedOn(ownerConversionsChart, '2025-02-02'),
      ],
      list: [ownerFirst, ownerSecond],
    },
  );

  for (const [id, convertedAt] of originalConverted) {
    await utcDb.execute('UPDATE leads SET converted_at = ? WHERE id = ?', [convertedAt, id]);
  }
  await utcDb.execute('UPDATE leads SET converted_at = NULL WHERE id = ?', [neverConvertedId]);

  /* -------------------------------------------- anyone assigned, or nobody */
  console.log('\nleads — assigned to anyone, or to nobody');

  const tagged = await adminAsBearer.get(`${ADMIN}/leads?q=LeadView&pageSize=100`);
  const taggedAssigned = await adminAsBearer.get(
    `${ADMIN}/leads?q=LeadView&pageSize=100&assignedTo=assigned`,
  );
  const taggedUnassigned = await adminAsBearer.get(
    `${ADMIN}/leads?q=LeadView&pageSize=100&assignedTo=unassigned`,
  );
  check(
    "'assigned' lists every lead that has an owner, whoever it is",
    taggedAssigned.status === 200 &&
      items(taggedAssigned).length > 0 &&
      items(taggedAssigned).every((row) => row.assignedTo !== null) &&
      idsOf(items(taggedAssigned)).includes(leadId) &&
      new Set(items(taggedAssigned).map((row) => row.assignedTo)).size >= 2,
    items(taggedAssigned).map((row) => ({ id: row.id, assignedTo: row.assignedTo })),
  );
  check(
    'and it and the unassigned queue split the list between them',
    items(taggedUnassigned).every((row) => row.assignedTo === null) &&
      idsOf(items(taggedUnassigned)).includes(quietId) &&
      Number(taggedAssigned.json.total) + Number(taggedUnassigned.json.total) ===
        Number(tagged.json.total),
    {
      all: tagged.json.total,
      assigned: taggedAssigned.json.total,
      unassigned: taggedUnassigned.json.total,
    },
  );

  const badAssignee = await adminAsBearer.get(`${ADMIN}/leads?assignedTo=everyone`);
  check(
    'an owner filter that is neither an id nor a known word is refused with a 422',
    badAssignee.status === 422,
    badAssignee.status,
  );

  const mobileAll = await caller.client.get('/mobile/leads');
  const mobileAssigned = await caller.client.get('/mobile/leads?assignedTo=assigned');
  check(
    "'assigned' cannot widen what a telecaller sees",
    mobileAssigned.status === 200 &&
      mobileAssigned.json.total === mobileAll.json.total &&
      items(mobileAssigned).every((row) => row.assignedTo === caller.id),
    { all: mobileAll.json.total, assigned: mobileAssigned.json.total },
  );

  /* ------------------------------------- the lists match the dashboard */
  console.log('\nleads — each list counts the same leads as the card that opens it');

  const dashboard = await adminAsBearer.get(`${ADMIN}/dashboard`);
  const tiles = (dashboard.json.leads ?? {}) as Json;
  const parity: [string, unknown, number][] = [
    ['Total leads', tiles.total, await totalOf('')],
    ['Assigned', tiles.assigned, await totalOf('&assignedTo=assigned')],
    ['Unassigned', tiles.unassigned, await totalOf('&assignedTo=unassigned')],
    ['Not yet called', tiles.new, await totalOf('&contacted=never')],
    ['Converted', tiles.converted, await totalOf('&status=converted')],
    ['Lost', tiles.lost, await totalOf('&status=lost')],
    ['Walked in', tiles.walkedIn, await totalOf('&status=walked_in')],
  ];
  for (const [tile, card, listTotal] of parity) {
    check(
      `the ${tile} card and the list it opens count the same leads`,
      dashboard.status === 200 && typeof card === 'number' && card === listTotal,
      { card, list: listTotal },
    );
  }

  // The same over today's IST day — the range every card and list now share.
  const today =`&from=${istToday}&to=${istToday}`;
  const dashboardToday = await adminAsBearer.get(`${ADMIN}/dashboard?from=${istToday}&to=${istToday}`);
  const todayTiles = (dashboardToday.json.leads ?? {}) as Json;
  const todayTotal = await totalOf(today);
  const todayAssigned = await totalOf(`${today}&assignedTo=assigned`);
  check(
    "today's Total leads and Assigned cards match today's lists",
    dashboardToday.status === 200 &&
      todayTiles.total === todayTotal &&
      todayTiles.assigned === todayAssigned &&
      todayTotal > 0,
    { cards: todayTiles, total: todayTotal, assigned: todayAssigned },
  );

  /* ------------------------------------------------------------ tidy up */
  const leftovers = [callFollowUpId, secondFollowUpId];
  let tidied = 0;
  for (const id of leftovers) {
    const result = await adminAsBearer.post(`${ADMIN}/follow-ups/${id}/cancel`);
    if (result.json.followUp?.state === 'cancelled') tidied += 1;
  }
  check(
    "the section's open follow-ups are cancelled again",
    tidied === leftovers.length,
    { cancelled: tidied, open: leftovers.length },
  );
}
