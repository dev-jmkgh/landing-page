import type { ResultSetHeader } from 'mysql2/promise';
import type { E2EContext, Json } from './context';

/**
 * People: moving follow-ups, handover, the deactivation guard, company numbers on
 * employees and registrations, and the handset's company-SIM report.
 *
 * Owned by the people feature (key `people`). Runs after the leads section; the rules
 * every section follows are in `context.ts`.
 *
 * Every fixture here is its own: emails `ppl.*`, employee codes `PPL-*` (never `TC-`, so
 * the sequence the API allocates is untouched), lead numbers `+91 96662 0NNNN`, company
 * numbers `+9196662100NN`. Pending follow-ups it books are cancelled again at the end, so
 * later sections start from no work of ours.
 */

/**
 * A JSON column's value. MySQL hands it over already parsed; MariaDB, where JSON is an
 * alias for LONGTEXT, hands over the text.
 */
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

/** A list that arrives either bare or as a page (`{ items }`). */
function itemsOf(value: unknown): Json[] {
  if (Array.isArray(value)) return value as Json[];
  const items = (value as Json | null | undefined)?.items as unknown;
  return Array.isArray(items) ? (items as Json[]) : [];
}

const ids = (list: Json[]): number[] => list.map((row) => Number(row.id));

/** The password every account this section creates through the API is given. */
const STAFF_PASSWORD = 'people-section-password';

export async function run(ctx: E2EContext): Promise<void> {
  const { check, utcDb, adminAsBearer: admin, adminId, ravi, base, makeClient } = ctx;

  const time = await import('../../src/modules/telecalling/companyTime');
  const { signupSchema } = await import('../../src/modules/telecalling/auth/mobileAuth.routes');

  /* ------------------------------------------------------------- helpers */

  // Through the UTC-pinned connection, like the app: Dates bind and read as UTC.
  const rows = async (statement: string, params: unknown[] = []): Promise<Json[]> => {
    const [result] = (await utcDb.query(statement, params)) as [Json[], unknown];
    return result;
  };
  const count = async (statement: string, params: unknown[] = []): Promise<number> =>
    Number((await rows(statement, params))[0]?.n ?? Number.NaN);
  const placeholders = (list: unknown[]) => list.map(() => '?').join(', ');

  /** Records the assertion, and stops the section when a fixture everything after needs failed. */
  const must = (label: string, condition: boolean, detail?: unknown): void => {
    check(label, condition, detail);
    if (!condition) throw new Error(`fixture failed: ${label} — ${JSON.stringify(detail)}`);
  };

  const today = time.companyDate();
  const istDate = (days: number) => time.addDays(today, days);
  /** An IST wall-clock time `days` from today, as the admin screens send it. */
  const istAt = (days: number, hhmm: string) => `${istDate(days)}T${hhmm}:00+05:30`;
  const iso = (value: string) => new Date(value).toISOString();

  /** Every employee this section creates, for the "nobody switched off holds work" query. */
  const mine: number[] = [];
  /** Every lead this section creates, for the clean-up. */
  const myLeads: number[] = [];

  const signIn = async (email: string, password = STAFF_PASSWORD) => {
    const client = makeClient(base);
    const login = await client.post('/mobile/auth/login', { email, password });
    const token = login.json.accessToken as unknown;
    if (typeof token === 'string') client.setToken(token);
    return { client, login, refreshToken: String(login.json.refreshToken ?? '') };
  };

  const createStaff = async (input: {
    code: string;
    name: string;
    email: string;
    role?: 'admin' | 'manager' | 'supervisor' | 'telecaller';
    companyPhone?: string | null;
    phone?: string | null;
  }) => {
    const response = await admin.post('/admin/telecalling/employees', {
      name: input.name,
      email: input.email,
      password: STAFF_PASSWORD,
      role: input.role ?? 'telecaller',
      employeeCode: input.code,
      ...(input.companyPhone !== undefined ? { companyPhone: input.companyPhone } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
    });
    const id = Number(response.json.employee?.id);
    if (response.status === 201 && Number.isInteger(id)) mine.push(id);
    return { response, id, employee: (response.json.employee ?? {}) as Json };
  };

  const createLead = async (name: string, phone: string, assignedTo: number | null): Promise<number> => {
    const response = await admin.post('/admin/telecalling/leads', {
      customerName: name,
      phone,
      source: 'manual',
      assignedTo,
    });
    const id = Number(response.json.lead?.id);
    must(`fixture: lead "${name}"`, response.status === 201 && Number.isInteger(id), response.json);
    myLeads.push(id);
    return id;
  };

  const book = async (leadId: number, assignedTo: number, dueAt: string): Promise<number> => {
    const response = await admin.post('/admin/telecalling/follow-ups', { leadId, assignedTo, dueAt });
    const id = Number(response.json.followUp?.id);
    must(
      `fixture: a follow-up on lead ${leadId} for employee ${assignedTo}`,
      response.status === 201 && response.json.followUp?.assignedTo === assignedTo && Number.isInteger(id),
      response.json,
    );
    return id;
  };

  const move = (id: number, body: Json) => admin.post(`/admin/telecalling/follow-ups/${id}/move`, body);
  const leadOf = async (id: number): Promise<Json> =>
    ((await admin.get(`/admin/telecalling/leads/${id}`)).json.lead ?? {}) as Json;
  const timelineOf = async (leadId: number): Promise<Json[]> =>
    itemsOf((await admin.get(`/admin/telecalling/leads/${leadId}/activity?pageSize=50`)).json);
  const followUpRow = async (id: number): Promise<Json> =>
    (await rows(
      'SELECT id, lead_id, assigned_to, state, due_at, reschedule_count, note FROM follow_ups WHERE id = ?',
      [id],
    ))[0] ?? {};
  const dueOf = (row: Json): string | null =>
    row.due_at instanceof Date ? row.due_at.toISOString() : null;
  const latestAudit = async (action: string, entityId: number): Promise<Json | null> =>
    jsonColumn(
      (await rows(
        'SELECT meta FROM audit_logs WHERE action = ? AND entity_id = ? ORDER BY id DESC LIMIT 1',
        [action, entityId],
      ))[0]?.meta,
    );

  /*
   * THE INVARIANT: no pending follow-up is held by a switched-off account. Asserted after
   * every deactivation, both for this section's own employees and as "no worse than when
   * the section started" for the whole database — earlier sections own their own rows.
   */
  const strandedSql = `SELECT COUNT(*) AS n
                         FROM follow_ups f
                         JOIN telecaller_users u ON u.id = f.assigned_to
                        WHERE u.is_active = 0 AND f.state = 'pending'`;
  const strandedAtStart = await count(strandedSql);
  const assertNoneStranded = async (label: string) => {
    const everywhere = await count(strandedSql);
    const ours = mine.length > 0 ? await count(`${strandedSql} AND u.id IN (${placeholders(mine)})`, mine) : 0;
    check(label, ours === 0 && everywhere <= strandedAtStart, { ours, everywhere, atStart: strandedAtStart });
  };

  /* ------------------------------------------------ staff and their numbers */
  console.log('\npeople — staff added by an administrator');

  const e1 = await createStaff({ code: 'PPL-E1', name: 'People One', email: 'ppl.one@example.test', companyPhone: '96662 10001' });
  must('an admin adds a telecaller with a company SIM number', e1.response.status === 201, e1.response.json);
  check('the company number is stored canonical', e1.employee.companyPhone === '+919666210001', e1.employee);
  check('the explicit employee code is kept', e1.employee.employeeCode === 'PPL-E1', e1.employee.employeeCode);
  check('a new employee has no company-SIM confirmation yet', e1.employee.companySim === null, e1.employee.companySim);

  const verified = (await rows(
    `SELECT email_verified_at IS NOT NULL AS verified,
            ABS(TIMESTAMPDIFF(MINUTE, email_verified_at, UTC_TIMESTAMP())) AS drift
       FROM telecaller_users WHERE id = ?`,
    [e1.id],
  ))[0];
  check(
    'an admin-created employee is stored email-verified, on the UTC clock',
    Number(verified?.verified) === 1 && Number(verified?.drift) <= 5,
    verified,
  );

  const one = await signIn('ppl.one@example.test');
  check(
    'and can sign in to the app straight away (no "confirm your email" dead end)',
    one.login.status === 200 && typeof one.login.json.accessToken === 'string',
    one.login.json,
  );

  const e2 = await createStaff({ code: 'PPL-E2', name: 'People Two', email: 'ppl.two@example.test', companyPhone: '+91 96662 10002' });
  must('fixture: a second telecaller', e2.response.status === 201, e2.response.json);
  const two = await signIn('ppl.two@example.test');
  must('fixture: the second telecaller signs in', two.login.status === 200, two.login.json);

  const e3 = await createStaff({ code: 'PPL-E3', name: 'People Three', email: 'ppl.three@example.test', companyPhone: '096662 10003' });
  must('fixture: a third telecaller', e3.response.status === 201, e3.response.json);
  const three = await signIn('ppl.three@example.test');
  must('fixture: the third telecaller signs in', three.login.status === 200, three.login.json);

  const noSim = await admin.post('/admin/telecalling/employees', {
    name: 'People No Sim',
    email: 'ppl.nosim@example.test',
    password: STAFF_PASSWORD,
    role: 'telecaller',
    employeeCode: 'PPL-NOSIM',
  });
  check(
    'a telecaller cannot be added without a company SIM number',
    noSim.status === 422 && typeof noSim.json.errors?.companyPhone === 'string',
    noSim.json,
  );

  const badSim = await createStaff({ code: 'PPL-BAD', name: 'People Bad Sim', email: 'ppl.badsim@example.test', companyPhone: '12345' });
  check(
    'nor with a number that is not a 10-digit mobile',
    badSim.response.status === 422 && typeof badSim.response.json.errors?.companyPhone === 'string',
    badSim.response.json,
  );

  const takenSim = await createStaff({ code: 'PPL-TAKEN', name: 'People Taken', email: 'ppl.taken@example.test', companyPhone: '+919666210001' });
  check(
    "nor with another employee's company number — and the refusal names who holds it",
    takenSim.response.status === 422 && String(takenSim.response.json.errors?.companyPhone ?? '').includes('People One'),
    takenSim.response.json,
  );

  const sup = await createStaff({ code: 'PPL-SUP', name: 'People Supervisor', email: 'ppl.sup@example.test', role: 'supervisor' });
  check('other roles may be added without a company number', sup.response.status === 201 && sup.employee.companyPhone === null, sup.response.json);
  const supervisor = await signIn('ppl.sup@example.test');
  const mgr = await createStaff({ code: 'PPL-MGR', name: 'People Manager', email: 'ppl.mgr@example.test', role: 'manager' });
  const manager = await signIn('ppl.mgr@example.test');
  must(
    'fixture: a supervisor and a manager sign in',
    mgr.response.status === 201 && supervisor.login.status === 200 && manager.login.status === 200,
    { mgr: mgr.response.json, supervisor: supervisor.login.json, manager: manager.login.json },
  );

  // Two admins giving out one number at the same moment: the claim's unique index decides.
  const [raceA, raceB] = await Promise.all([
    createStaff({ code: 'PPL-RA', name: 'People Race A', email: 'ppl.race.a@example.test', companyPhone: '+919666210021' }),
    createStaff({ code: 'PPL-RB', name: 'People Race B', email: 'ppl.race.b@example.test', companyPhone: '+919666210021' }),
  ]);
  const raceStatuses = [raceA.response.status, raceB.response.status].sort((a, b) => a - b);
  const raceLoser = raceA.response.status === 201 ? raceB.response : raceA.response;
  check(
    'one company number given out twice at once: one wins, the other gets a field error, never a 500',
    raceStatuses[0] === 201 && raceStatuses[1] === 422 && typeof raceLoser.json.errors?.companyPhone === 'string',
    { statuses: raceStatuses, loser: raceLoser.json },
  );

  /* ------------------------------------------------ moving one follow-up */
  console.log('\npeople — moving a follow-up');

  const l1 = await createLead('People Lead One', '+91 96662 00001', e1.id);
  const l2 = await createLead('People Lead Two', '+91 96662 00002', e2.id);
  const l3 = await createLead('People Lead Three', '+91 96662 00003', e1.id);
  const archived = await admin.post(`/admin/telecalling/leads/${l3}/archive`, { archived: true });
  must('fixture: lead three is archived', archived.status === 200, archived.json);

  const originalDue = istAt(2, '10:00');
  const f = await book(l1, e1.id, originalDue);
  /** Moves of F that changed something — each must leave one history row and one audit entry. */
  let fMoves = 0;

  const timed = await move(f, { dueAt: istAt(3, '14:30') });
  if (timed.status === 200 && timed.json.changed === true) fMoves += 1;
  check('a follow-up moves to a new time', timed.status === 200 && timed.json.changed === true, timed.json);
  check(
    'the IST wall-clock time lands on the right instant',
    timed.json.followUp?.dueAt === iso(istAt(3, '14:30')) && String(timed.json.followUp?.dueAt).endsWith('T09:00:00.000Z'),
    timed.json.followUp?.dueAt,
  );
  check(
    'it counts as a reschedule and records where it came from',
    timed.json.followUp?.rescheduleCount === 1 && timed.json.followUp?.rescheduledFrom === iso(originalDue),
    timed.json.followUp,
  );
  check(
    'the response says what changed, current to new, and nothing else',
    timed.json.changes?.dueAt?.from === iso(originalDue) &&
      timed.json.changes?.dueAt?.to === iso(istAt(3, '14:30')) &&
      timed.json.changes?.assignedTo === undefined &&
      timed.json.changes?.leadId === undefined,
    timed.json.changes,
  );
  check(
    "the lead's next-follow-up time follows it",
    (await leadOf(l1)).nextFollowUpAt === iso(istAt(3, '14:30')),
    (await leadOf(l1)).nextFollowUpAt,
  );
  check(
    "and the lead's timeline says it was rescheduled",
    (await timelineOf(l1)).some((row) => row.type === 'follow_up_rescheduled' && row.meta?.followUpId === f),
    (await timelineOf(l1)).map((row) => row.type),
  );

  const seconds = await move(f, { dueAt: `${istDate(3)}T14:31:45+05:30` });
  if (seconds.status === 200 && seconds.json.changed === true) fMoves += 1;
  check(
    'seconds nobody can see are cut to the whole minute',
    seconds.status === 200 && seconds.json.followUp?.dueAt === iso(istAt(3, '14:31')),
    seconds.json.followUp?.dueAt ?? seconds.json,
  );

  const retried = await move(f, { dueAt: `${istDate(3)}T14:31:45+05:30` });
  check(
    'repeating a move that already applied is a no-op, not an error',
    retried.status === 200 && retried.json.changed === false && retried.json.followUp?.rescheduleCount === 2,
    retried.json,
  );

  const stale = await move(f, {
    dueAt: istAt(3, '16:00'),
    expected: { dueAt: iso(originalDue), assignedTo: e1.id, leadId: l1 },
  });
  check(
    'a move made against a stale picture is refused with the current values',
    stale.status === 409 &&
      stale.json.code === 'follow_up_changed' &&
      stale.json.details?.current?.id === f &&
      stale.json.details?.current?.dueAt === iso(istAt(3, '14:31')),
    stale.json,
  );

  const past = await move(f, { dueAt: new Date(Date.now() - 3_600_000).toISOString() });
  check('a new time in the past is refused on the field', past.status === 422 && typeof past.json.errors?.dueAt === 'string', past.json);

  const tooFar = await move(f, { dueAt: new Date(Date.now() + 3 * 365 * 86_400_000).toISOString() });
  check('and so is one years away', tooFar.status === 422 && typeof tooFar.json.errors?.dueAt === 'string', tooFar.json);

  const nothing = await move(f, { reason: 'No actual change asked for' });
  check('a move must change something', nothing.status === 422, nothing.json);

  // A lead change, against an up-to-date picture.
  const toL2 = await move(f, {
    leadId: l2,
    reason: 'Same customer, filed on the other lead',
    expected: { dueAt: iso(istAt(3, '14:31')), assignedTo: e1.id, leadId: l1 },
  });
  if (toL2.status === 200 && toL2.json.changed === true) fMoves += 1;
  check('a follow-up moves to another lead', toL2.status === 200 && toL2.json.followUp?.leadId === l2, toL2.json);
  check(
    'the customer it left now has nothing booked, and the screen is told',
    toL2.json.sourceLeadPendingFollowUps === 0 && (await leadOf(l1)).nextFollowUpAt === null,
    { reported: toL2.json.sourceLeadPendingFollowUps, cache: (await leadOf(l1)).nextFollowUpAt },
  );
  check(
    'the lead it moved onto shows it as its next follow-up',
    (await leadOf(l2)).nextFollowUpAt === toL2.json.followUp?.dueAt,
    (await leadOf(l2)).nextFollowUpAt,
  );
  check(
    'both leads tell the story on their timelines',
    (await timelineOf(l1)).some((row) => row.type === 'follow_up_moved' && row.meta?.followUpId === f) &&
      (await timelineOf(l2)).some((row) => row.type === 'follow_up_moved' && row.meta?.followUpId === f),
    { from: (await timelineOf(l1)).map((row) => row.type), to: (await timelineOf(l2)).map((row) => row.type) },
  );
  const notifiedLeads = (await rows('SELECT DISTINCT lead_id FROM notifications WHERE follow_up_id = ?', [f])).map((row) =>
    Number(row.lead_id),
  );
  check(
    'every notification about it now opens the lead it is on',
    notifiedLeads.length === 1 && notifiedLeads[0] === l2,
    notifiedLeads,
  );

  const ontoArchived = await move(f, { leadId: l3 });
  const afterArchived = await followUpRow(f);
  check(
    'a follow-up cannot be moved onto an archived lead',
    ontoArchived.status === 422 && typeof ontoArchived.json.errors?.leadId === 'string',
    ontoArchived.json,
  );
  check('and the refused move changed nothing', Number(afterArchived.lead_id) === l2, afterArchived);

  // Nobody switched off can be given work, through either door.
  const offThree = await admin.patch(`/admin/telecalling/employees/${e3.id}`, { isActive: false });
  must('fixture: an employee holding no follow-ups is switched off', offThree.status === 200, offThree.json);
  await assertNoneStranded('nobody switched off holds a pending follow-up (after a plain deactivation)');

  const toInactive = await move(f, { assignedTo: e3.id });
  check(
    'a follow-up cannot be moved to a deactivated employee — a field error in the move dialog',
    toInactive.status === 422 && String(toInactive.json.errors?.assignedTo ?? '').includes('People Three'),
    toInactive.json,
  );
  const reassignInactive = await admin.patch(`/admin/telecalling/follow-ups/${f}`, { assignedTo: e3.id });
  check(
    'and the inline reassign keeps the 400 its clients already handle',
    reassignInactive.status === 400 && reassignInactive.json.message === 'That employee is deactivated.',
    reassignInactive.json,
  );

  // The same-day rule.
  const f2 = await book(l2, e2.id, istAt(3, '11:00'));
  const doubled = await move(f, { assignedTo: e2.id });
  check(
    'a move that would give one employee two calls to one customer on one day is refused',
    doubled.status === 409 &&
      doubled.json.code === 'duplicate_follow_up' &&
      doubled.json.details?.conflict?.id === f2 &&
      doubled.json.details?.conflict?.assignedTo === e2.id,
    doubled.json,
  );
  check('and the follow-up stays with who had it', Number((await followUpRow(f)).assigned_to) === e1.id, await followUpRow(f));

  const f3 = await book(l2, e2.id, istAt(3, '12:00'));
  const sameDay = await move(f3, { dueAt: istAt(3, '13:00') });
  check(
    'the rule applies only when a move changes the lead, employee or day — re-timing within the day is fine',
    sameDay.status === 200 && sameDay.json.changed === true,
    sameDay.json,
  );
  await admin.post(`/admin/telecalling/follow-ups/${f3}/cancel`);

  // A new holder: the follow-up, its notifications and its list entries go with it.
  const handed = await move(f, { assignedTo: e2.id, dueAt: istAt(4, '12:00') });
  if (handed.status === 200 && handed.json.changed === true) fMoves += 1;
  check(
    'a follow-up moves to another employee and another day at once',
    handed.status === 200 && handed.json.followUp?.assignedTo === e2.id && handed.json.changes?.assignedTo?.to === e2.id,
    handed.json,
  );
  const twoUpcoming = ids(itemsOf((await two.client.get('/mobile/follow-ups?scope=upcoming&pageSize=100')).json));
  const oneUpcoming = ids(itemsOf((await one.client.get('/mobile/follow-ups?scope=upcoming&pageSize=100')).json));
  check('the new holder sees it in their app', twoUpcoming.includes(f), twoUpcoming);
  check('the old holder no longer does', !oneUpcoming.includes(f), oneUpcoming);
  const twoNotes = itemsOf((await two.client.get('/mobile/notifications?pageSize=100')).json);
  check(
    'the new holder is told',
    twoNotes.some((row) => row.followUpId === f && row.title === 'Follow-up assigned to you'),
    twoNotes.map((row) => [row.title, row.followUpId]),
  );
  const oneAboutF = (await rows(
    'SELECT COUNT(*) AS total, SUM(read_at IS NULL) AS unread FROM notifications WHERE follow_up_id = ? AND user_id = ?',
    [f, e1.id],
  ))[0];
  check(
    "and the old holder's notifications about it stop counting as unread work",
    Number(oneAboutF?.total) > 0 && Number(oneAboutF?.unread ?? 0) === 0,
    oneAboutF,
  );

  // With the lead.
  const beforeTransfer = await two.client.get(`/mobile/leads/${l1}`);
  const transferred = await move(f, { leadId: l1, assignedTo: e2.id, transferLead: true });
  if (transferred.status === 200 && transferred.json.changed === true) fMoves += 1;
  const afterTransfer = await two.client.get(`/mobile/leads/${l1}`);
  check(
    'moving a follow-up can transfer the lead to its holder',
    transferred.status === 200 && transferred.json.leadTransferred === true && (await leadOf(l1)).assignedTo === e2.id,
    { response: transferred.json, owner: (await leadOf(l1)).assignedTo },
  );
  check(
    'so the holder can now open the lead in the app',
    beforeTransfer.status === 404 && afterTransfer.status === 200,
    { before: beforeTransfer.status, after: afterTransfer.status },
  );

  // An overdue follow-up handed on keeps its time — the dialog sends it back unchanged.
  const overdue = await book(l2, e2.id, istAt(2, '09:00'));
  await rows('UPDATE follow_ups SET due_at = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE id = ?', [overdue]);
  const overdueDue = dueOf(await followUpRow(overdue));
  const keptTime = await move(overdue, { dueAt: overdueDue, assignedTo: e1.id });
  check(
    'an overdue follow-up handed on with its own time is not refused as "in the past"',
    keptTime.status === 200 &&
      keptTime.json.followUp?.assignedTo === e1.id &&
      keptTime.json.followUp?.dueAt === overdueDue &&
      keptTime.json.changes?.dueAt === undefined,
    keptTime.json,
  );
  await admin.post(`/admin/telecalling/follow-ups/${overdue}/cancel`);

  // Completed is final.
  const completed = await admin.post(`/admin/telecalling/follow-ups/${f2}/complete`);
  must('fixture: a follow-up is completed', completed.status === 200 && completed.json.followUp?.state === 'completed', completed.json);
  const moveDone = await move(f2, { dueAt: istAt(5, '10:00') });
  check(
    'a completed follow-up cannot be moved',
    moveDone.status === 409 && moveDone.json.code === 'follow_up_not_pending',
    moveDone.json,
  );
  const reassignDone = await admin.patch(`/admin/telecalling/follow-ups/${f2}`, { assignedTo: e1.id });
  check(
    'nor reassigned inline any more (it used to be, silently)',
    reassignDone.status === 409 && reassignDone.json.code === 'follow_up_not_pending',
    reassignDone.json,
  );

  // The inline reassign is a move underneath.
  const inline = await admin.patch(`/admin/telecalling/follow-ups/${f}`, { assignedTo: e1.id });
  if (inline.status === 200) fMoves += 1;
  check('the inline reassign moves a pending follow-up', inline.status === 200 && inline.json.followUp?.assignedTo === e1.id, inline.json);
  check(
    'and the timeline calls it a reassignment, not a reschedule',
    (await timelineOf(l1)).some((row) => row.type === 'follow_up_reassigned' && row.meta?.followUpId === f),
    (await timelineOf(l1)).map((row) => row.type),
  );
  const noted = await admin.patch(`/admin/telecalling/follow-ups/${f}`, { note: 'People: bring the brochure.' });
  check(
    'a note on its own is edited in place and leaves the holder alone',
    noted.status === 200 && noted.json.followUp?.note === 'People: bring the brochure.' && noted.json.followUp?.assignedTo === e1.id,
    noted.json,
  );
  const emptyEdit = await admin.patch(`/admin/telecalling/follow-ups/${f}`, {});
  check('an edit with nothing in it is refused', emptyEdit.status === 422, emptyEdit.json);

  // Who may move.
  const byTelecaller = await ravi.post(`/admin/telecalling/follow-ups/${f}/move`, { dueAt: istAt(4, '15:00') });
  check('a telecaller cannot move follow-ups through the admin API', byTelecaller.status === 403, byTelecaller.json);
  const bySupervisor = await supervisor.client.post(`/admin/telecalling/follow-ups/${f}/move`, { dueAt: istAt(4, '15:00') });
  if (bySupervisor.status === 200 && bySupervisor.json.changed === true) fMoves += 1;
  check('a supervisor can', bySupervisor.status === 200 && bySupervisor.json.changed === true, bySupervisor.json);

  // The record of it.
  const history = await rows("SELECT kind, batch_id FROM follow_up_moves WHERE follow_up_id = ?", [f]);
  check(
    'every move that changed something left one history row, written with the move',
    history.length === fMoves && fMoves === 7 && history.every((row) => row.kind === 'move' && row.batch_id === null),
    { rows: history.length, moves: fMoves },
  );
  const audited = await rows("SELECT meta FROM audit_logs WHERE action = 'follow_up_moved' AND entity_id = ?", [f]);
  check(
    'and one audit entry, saying where it was and where it went',
    audited.length === fMoves &&
      audited.every((row) => {
        const meta = jsonColumn(row.meta);
        return Boolean(meta?.from) && Boolean(meta?.to);
      }),
    audited.map((row) => jsonColumn(row.meta)),
  );
  const auditPage = itemsOf((await admin.get('/admin/telecalling/audit-logs?action=follow_up_moved&pageSize=100')).json);
  check(
    'the audit log lists the moves',
    auditPage.some((row) => row.entityId === f),
    auditPage.map((row) => row.entityId),
  );

  /* -------------------------------------------- the deactivation guard */
  console.log('\npeople — deactivating someone who still has work');

  const four = await ctx.createSignedInEmployee({
    name: 'People Four',
    email: 'ppl.four@example.test',
    role: 'telecaller',
    companyPhone: '+919666210004',
    code: 'PPL-E4',
  });
  mine.push(four.id);
  const l4a = await createLead('People Lead Four A', '+91 96662 00041', four.id);
  const l4b = await createLead('People Lead Four B', '+91 96662 00042', four.id);
  const fa = await book(l4a, four.id, istAt(2, '09:00'));
  const fb = await book(l4a, four.id, istAt(2, '10:00'));
  const fc = await book(l4b, four.id, istAt(3, '10:00'));
  await rows('UPDATE follow_ups SET due_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ?', [fa]);

  const checkFour = await admin.get(`/admin/telecalling/employees/${four.id}/deactivation-check`);
  const pendingFour = (checkFour.json.pendingFollowUps ?? {}) as Json;
  check(
    'the deactivation check counts the pending follow-ups by when they fall due',
    checkFour.status === 200 &&
      pendingFour.total === 3 &&
      pendingFour.overdue === 1 &&
      pendingFour.overdue + pendingFour.dueToday + pendingFour.upcoming === pendingFour.total,
    checkFour.json,
  );
  check(
    'and says the employee cannot be deactivated yet, and why',
    checkFour.json.canDeactivate === false &&
      checkFour.json.blockers?.[0]?.code === 'pending_follow_ups' &&
      checkFour.json.openLeads === 2,
    checkFour.json,
  );
  const checkSelf = await admin.get(`/admin/telecalling/employees/${adminId}/deactivation-check`);
  check(
    'it also says an admin cannot deactivate themselves',
    ((checkSelf.json.blockers ?? []) as Json[]).some((row) => row.code === 'self') && checkSelf.json.canDeactivate === false,
    checkSelf.json,
  );

  const refusedFour = await admin.patch(`/admin/telecalling/employees/${four.id}`, { isActive: false });
  check(
    'switching off someone with pending follow-ups is refused with the numbers',
    refusedFour.status === 409 &&
      refusedFour.json.code === 'pending_follow_ups' &&
      refusedFour.json.details?.pendingFollowUps?.total === 3 &&
      String(refusedFour.json.message).includes('3'),
    refusedFour.json,
  );
  check('and they are still active', Number((await rows('SELECT is_active FROM telecaller_users WHERE id = ?', [four.id]))[0]?.is_active) === 1);
  const stillSignedIn = await makeClient(base).post('/mobile/auth/refresh', { refreshToken: four.refreshToken });
  check('and still signed in — a refused deactivation revokes nothing', stillSignedIn.status === 200, stillSignedIn.json);
  // Refreshing rotated the token: the new one is what deactivation has to revoke.
  const fourRefresh = String(stillSignedIn.json.refreshToken ?? four.refreshToken);

  const refusedRename = await admin.patch(`/admin/telecalling/employees/${four.id}`, { isActive: false, name: 'People Renamed' });
  check(
    'a refused deactivation writes none of the other fields sent with it',
    refusedRename.status === 409 &&
      (await rows('SELECT name FROM telecaller_users WHERE id = ?', [four.id]))[0]?.name === 'People Four',
    refusedRename.json,
  );

  const supCheck = await supervisor.client.get(`/admin/telecalling/employees/${four.id}/deactivation-check`);
  const supHandover = await supervisor.client.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, { toEmployeeId: e2.id });
  const mgrCheck = await manager.client.get(`/admin/telecalling/employees/${four.id}/deactivation-check`);
  check(
    'the check and the handover are for managers and above',
    supCheck.status === 403 && supHandover.status === 403 && mgrCheck.status === 200,
    { supCheck: supCheck.status, supHandover: supHandover.status, mgrCheck: mgrCheck.status },
  );

  // Hand over the overdue one, re-dated, to someone who can take it.
  const partial = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, {
    toEmployeeId: e2.id,
    followUpIds: [fa],
    schedule: { mode: 'overdue_to', dueAt: istAt(1, '11:00') },
  });
  const faRow = await followUpRow(fa);
  check(
    'a selected follow-up is handed over and the rest stay',
    partial.status === 200 &&
      partial.json.moved === 1 &&
      partial.json.remainingPending === 2 &&
      Array.isArray(partial.json.skipped) &&
      partial.json.skipped.length === 0 &&
      String(partial.json.batchId ?? '').length === 36,
    partial.json,
  );
  check(
    'an overdue one is re-dated to the chosen IST time, as a reschedule',
    Number(faRow.assigned_to) === e2.id &&
      dueOf(faRow) === iso(istAt(1, '11:00')) &&
      String(dueOf(faRow)).endsWith('T05:30:00.000Z') &&
      Number(faRow.reschedule_count) === 1,
    faRow,
  );
  check(
    "the lead's next-follow-up time is refreshed",
    (await leadOf(l4a)).nextFollowUpAt === iso(istAt(1, '11:00')),
    (await leadOf(l4a)).nextFollowUpAt,
  );
  check(
    'the lead says who handed it over and why it moved',
    (await timelineOf(l4a)).some(
      (row) => row.type === 'follow_up_moved' && row.meta?.followUpId === fa && row.meta?.batchId === partial.json.batchId,
    ),
    (await timelineOf(l4a)).map((row) => [row.type, row.meta?.followUpId]),
  );
  check(
    'and the handover is in the move history under its batch',
    (await count("SELECT COUNT(*) AS n FROM follow_up_moves WHERE batch_id = ? AND kind = 'handover' AND follow_up_id = ?", [
      partial.json.batchId,
      fa,
    ])) === 1,
  );

  const toInactiveHandover = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, { toEmployeeId: e3.id });
  const toSelfHandover = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, { toEmployeeId: four.id });
  const toNobodyHandover = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, { toEmployeeId: 999_999 });
  check(
    'follow-ups cannot be handed to a deactivated employee, to the same employee, or to nobody',
    toInactiveHandover.status === 400 && toSelfHandover.status === 400 && toNobodyHandover.status === 400,
    { inactive: toInactiveHandover.json, self: toSelfHandover.json, nobody: toNobodyHandover.json },
  );
  const pastSchedule = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, {
    toEmployeeId: e2.id,
    schedule: { mode: 'all_to', dueAt: new Date(Date.now() - 3_600_000).toISOString() },
  });
  const emptySelection = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, {
    toEmployeeId: e2.id,
    followUpIds: [],
  });
  check(
    'a handover re-dating into the past, or selecting nothing, is refused',
    pastSchedule.status === 422 && emptySelection.status === 422,
    { past: pastSchedule.json, empty: emptySelection.json },
  );

  const notMovable = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, {
    toEmployeeId: e2.id,
    followUpIds: [f2, f, 999_999],
  });
  const skipReasons = new Map(((notMovable.json.skipped ?? []) as Json[]).map((row) => [Number(row.followUpId), row.reason]));
  check(
    'selected follow-ups it cannot move are reported, each with its reason, and nothing moves',
    notMovable.status === 200 &&
      notMovable.json.moved === 0 &&
      notMovable.json.remainingPending === 2 &&
      skipReasons.get(f2) === 'not_pending' &&
      skipReasons.get(f) === 'not_assigned_to_employee' &&
      skipReasons.get(999_999) === 'not_found',
    notMovable.json,
  );

  // The rest, times kept.
  const rest = await admin.post(`/admin/telecalling/employees/${four.id}/handover-follow-ups`, { toEmployeeId: e2.id });
  const fbRow = await followUpRow(fb);
  const fcRow = await followUpRow(fc);
  check(
    'the original body still hands over everything that is left',
    rest.status === 200 && rest.json.moved === 2 && rest.json.remainingPending === 0,
    rest.json,
  );
  check(
    'with their times kept',
    dueOf(fbRow) === iso(istAt(2, '10:00')) && dueOf(fcRow) === iso(istAt(3, '10:00')) && Number(fbRow.reschedule_count) === 0,
    { fb: fbRow, fc: fcRow },
  );
  check(
    'each moved follow-up says so on its own lead',
    (await timelineOf(l4b)).some((row) => row.type === 'follow_up_reassigned' && row.meta?.followUpId === fc),
    (await timelineOf(l4b)).map((row) => row.type),
  );
  check(
    'and the batch shares one id in the move history',
    (await count('SELECT COUNT(*) AS n FROM follow_up_moves WHERE batch_id = ?', [rest.json.batchId])) === 2,
  );
  const fourNotices = await rows(
    "SELECT title, follow_up_id FROM notifications WHERE user_id = ? AND body = 'Previously with People Four' ORDER BY id",
    [e2.id],
  );
  check(
    'the receiving employee gets ONE notification per handover, not one per follow-up',
    fourNotices.length === 2 &&
      fourNotices[0]?.title === '1 follow-up assigned to you' &&
      Number(fourNotices[0]?.follow_up_id) === fa &&
      fourNotices[1]?.title === '2 follow-ups assigned to you' &&
      fourNotices[1]?.follow_up_id === null,
    fourNotices,
  );
  const handoverAudit = await latestAudit('follow_ups_handed_over', four.id);
  check(
    'the audit entry records which follow-ups moved, under the batch id',
    handoverAudit?.batchId === rest.json.batchId &&
      JSON.stringify([...((handoverAudit?.followUpIds ?? []) as number[])].sort((a, b) => a - b)) ===
        JSON.stringify([fb, fc].sort((a, b) => a - b)),
    handoverAudit,
  );

  const offFour = await admin.patch(`/admin/telecalling/employees/${four.id}`, { isActive: false });
  check('with nothing left, the deactivation goes through', offFour.status === 200 && offFour.json.employee?.isActive === false, offFour.json);
  const signedOut = await makeClient(base).post('/mobile/auth/refresh', { refreshToken: fourRefresh });
  check('and signs them out everywhere', signedOut.status === 401, signedOut.json);
  const fourAudit = await latestAudit('employee_deactivated', four.id);
  check(
    'the audit entry records that nothing was left behind',
    fourAudit?.pendingFollowUpsAtDeactivation === 0 && Number(fourAudit?.sessionsRevoked) >= 1,
    fourAudit,
  );
  check(
    'no follow-up was lost on the way',
    (await count(
      `SELECT COUNT(*) AS n FROM follow_ups WHERE id IN (?, ?, ?) AND state = 'pending' AND assigned_to = ?`,
      [fa, fb, fc, e2.id],
    )) === 3,
  );
  await assertNoneStranded('nobody switched off holds a pending follow-up (after the guarded deactivation)');

  const lateBooking = await four.client.post('/mobile/follow-ups', { leadId: l4a, dueAt: istAt(2, '12:00') });
  check(
    'a switched-off telecaller still inside their token window books it unassigned — kept, not refused',
    lateBooking.status === 201 && lateBooking.json.followUp?.assignedTo === null,
    lateBooking.json,
  );
  await assertNoneStranded('and that still leaves nobody switched off holding work');
  const implicit = await admin.post('/admin/telecalling/follow-ups', { leadId: l4a, dueAt: istAt(2, '13:00') });
  check(
    "an admin's follow-up on a leaver's lead falls to the admin, never the leaver",
    implicit.status === 201 && implicit.json.followUp?.assignedTo === adminId,
    implicit.json,
  );

  /* ------------------------------------- deactivating in one step */
  console.log('\npeople — deactivating with a handover, in one step');

  const six = await ctx.createSignedInEmployee({
    name: 'People Six',
    email: 'ppl.six@example.test',
    role: 'telecaller',
    companyPhone: '+919666210006',
    code: 'PPL-E6',
  });
  mine.push(six.id);
  const l6a = await createLead('People Lead Six A', '+91 96662 00061', six.id);
  const l6b = await createLead('People Lead Six B', '+91 96662 00062', six.id);
  const g1 = await book(l6a, six.id, istAt(2, '10:00'));
  const g2 = await book(l6b, six.id, istAt(5, '10:00'));
  // Their cover already has a call booked with lead B's customer that day.
  const clash = await book(l6b, e2.id, istAt(5, '15:00'));

  const byManager = await manager.client.post(`/admin/telecalling/employees/${six.id}/deactivate`, {});
  check('deactivating is for admins only', byManager.status === 403, byManager.json);
  const selfDeactivate = await admin.post(`/admin/telecalling/employees/${adminId}/deactivate`, {});
  check('nobody can deactivate themselves', selfDeactivate.status === 400, selfDeactivate.json);
  const handToSelf = await admin.post(`/admin/telecalling/employees/${six.id}/deactivate`, { handover: { toEmployeeId: six.id } });
  check('nor hand their work to themselves', handToSelf.status === 400, handToSelf.json);

  const bare = await admin.post(`/admin/telecalling/employees/${six.id}/deactivate`, {});
  check(
    'without a handover, pending follow-ups refuse it',
    bare.status === 409 && bare.json.code === 'pending_follow_ups' && bare.json.details?.pendingFollowUps?.total === 2,
    bare.json,
  );

  const blocked = await admin.post(`/admin/telecalling/employees/${six.id}/deactivate`, { handover: { toEmployeeId: e2.id } });
  check(
    'a handover that would leave a same-day duplicate behind refuses the whole thing, naming it',
    blocked.status === 409 &&
      blocked.json.code === 'pending_follow_ups' &&
      ((blocked.json.details?.skipped ?? []) as Json[]).some(
        (row) => row.followUpId === g2 && row.reason === 'duplicate' && row.conflictWithId === clash,
      ),
    blocked.json,
  );
  check(
    'and nothing was moved or switched off',
    Number((await rows('SELECT is_active FROM telecaller_users WHERE id = ?', [six.id]))[0]?.is_active) === 1 &&
      Number((await followUpRow(g1)).assigned_to) === six.id &&
      (await count('SELECT COUNT(*) AS n FROM follow_up_moves WHERE follow_up_id IN (?, ?)', [g1, g2])) === 0,
    { g1: await followUpRow(g1) },
  );

  await admin.post(`/admin/telecalling/follow-ups/${clash}/cancel`);
  const atomic = await admin.post(`/admin/telecalling/employees/${six.id}/deactivate`, {
    handover: { toEmployeeId: e2.id, transferLeads: true },
    reason: 'Moved to another branch',
  });
  check(
    'deactivating with a handover moves everything and switches them off together',
    atomic.status === 200 &&
      atomic.json.handedOver === 2 &&
      atomic.json.leadsTransferred === 2 &&
      atomic.json.employee?.isActive === false &&
      Number(atomic.json.sessionsRevoked) >= 1 &&
      String(atomic.json.batchId ?? '').length === 36,
    atomic.json,
  );
  check(
    'the follow-ups and the leads are with the cover now',
    (await count("SELECT COUNT(*) AS n FROM follow_ups WHERE id IN (?, ?) AND state = 'pending' AND assigned_to = ?", [g1, g2, e2.id])) ===
      2 && (await count('SELECT COUNT(*) AS n FROM leads WHERE id IN (?, ?) AND assigned_to = ?', [l6a, l6b, e2.id])) === 2,
  );
  check(
    'recorded as a deactivation batch in the move history',
    (await count("SELECT COUNT(*) AS n FROM follow_up_moves WHERE batch_id = ? AND kind = 'deactivation'", [atomic.json.batchId])) === 2,
  );
  const sixAudit = await latestAudit('employee_deactivated', six.id);
  check(
    'the audit entry carries the handover and the reason',
    sixAudit?.handedOver === 2 && sixAudit?.batchId === atomic.json.batchId && sixAudit?.reason === 'Moved to another branch',
    sixAudit,
  );
  const sixOut = await makeClient(base).post('/mobile/auth/refresh', { refreshToken: six.refreshToken });
  check('and their sessions are gone', sixOut.status === 401, sixOut.json);
  const again = await admin.post(`/admin/telecalling/employees/${six.id}/deactivate`, { handover: { toEmployeeId: e2.id } });
  check(
    'a repeated click is answered, not refused, and does nothing',
    again.status === 200 && again.json.handedOver === 0 && again.json.batchId === null,
    again.json,
  );
  await assertNoneStranded('nobody switched off holds a pending follow-up (after the one-step deactivation)');

  /* ------------------------------------- deactivation racing a booking */
  console.log('\npeople — a deactivation racing a new follow-up');

  const raceLead = await createLead('People Race Lead', '+91 96662 00071', e2.id);
  const racers: number[] = [];
  const outcomes: string[] = [];
  for (let round = 1; round <= 10; round += 1) {
    const [inserted] = await utcDb.execute<ResultSetHeader>(
      `INSERT INTO telecaller_users
         (employee_code, name, email, email_verified_at, password_hash, role, is_active,
          approval_status, approved_at)
       VALUES (?, ?, ?, UTC_TIMESTAMP(), 'not-a-usable-hash', 'telecaller', 1, 'approved', UTC_TIMESTAMP())`,
      [`PPL-RACE-${round}`, `People Racer ${round}`, `ppl.racer${round}@example.test`],
    );
    const racer = inserted.insertId;
    racers.push(racer);
    mine.push(racer);

    const [switchOff, booking] = await Promise.all([
      admin.patch(`/admin/telecalling/employees/${racer}`, { isActive: false }),
      admin.post('/admin/telecalling/follow-ups', { leadId: raceLead, assignedTo: racer, dueAt: istAt(6, '10:00') }),
    ]);
    const switchedOffFirst = switchOff.status === 200 && booking.status === 400;
    const bookedFirst = booking.status === 201 && switchOff.status === 409 && switchOff.json.code === 'pending_follow_ups';
    outcomes.push(
      switchedOffFirst
        ? 'switched off first'
        : bookedFirst
          ? 'booked first'
          : `unexpected: deactivate ${switchOff.status} ${String(switchOff.json.code)}, book ${booking.status} ${String(booking.json.code)}`,
    );
  }
  check(
    'every round ends one way: switched off and the booking refused, or booked and the switch-off refused',
    outcomes.every((outcome) => outcome === 'switched off first' || outcome === 'booked first'),
    outcomes,
  );
  check(
    'and no round leaves a switched-off employee holding a pending follow-up',
    (await count(`${strandedSql} AND u.id IN (${placeholders(racers)})`, racers)) === 0,
  );

  /* ------------------------------------- company numbers on employees */
  console.log('\npeople — company numbers on employee records');

  const e7 = await createStaff({
    code: 'PPL-E7',
    name: 'People Seven',
    email: 'ppl.seven@example.test',
    phone: '+91 96662 20007',
    companyPhone: '96662 10007',
  });
  must('fixture: an employee with a personal and a company number', e7.response.status === 201, e7.response.json);
  const phone7 = e7.employee.phone as unknown;
  const kept = (employee: Json | undefined) =>
    employee?.phone === phone7 && employee?.companyPhone === '+919666210007';

  const nullingSteps: [string, Json][] = [
    ['switched off', { isActive: false }],
    ['switched back on', { isActive: true }],
    ['made a supervisor', { role: 'supervisor' }],
    ['made a telecaller again', { role: 'telecaller' }],
  ];
  const nullingResults: Json[] = [];
  for (const [, body] of nullingSteps) {
    const response = await admin.patch(`/admin/telecalling/employees/${e7.id}`, body);
    nullingResults.push({ status: response.status, phone: response.json.employee?.phone, companyPhone: response.json.employee?.companyPhone });
  }
  check(
    'a partial update leaves both phone numbers alone, every time',
    typeof phone7 === 'string' &&
      nullingResults.every((result) => result.status === 200 && kept(result)),
    { phone7, nullingResults },
  );
  const emptyPatch = await admin.patch(`/admin/telecalling/employees/${e7.id}`, {});
  check('an update with nothing in it is refused', emptyPatch.status === 422, emptyPatch.json);
  const clearPersonal = await admin.patch(`/admin/telecalling/employees/${e7.id}`, { phone: null });
  check(
    'an explicit null still clears the personal number, and only that',
    clearPersonal.status === 200 && clearPersonal.json.employee?.phone === null && clearPersonal.json.employee?.companyPhone === '+919666210007',
    clearPersonal.json.employee,
  );
  await assertNoneStranded('nobody switched off holds a pending follow-up (after the switch-off and back)');

  const holder = await createStaff({ code: 'PPL-H', name: 'People Holder', email: 'ppl.holder@example.test', companyPhone: '96662 10011' });
  const other = await createStaff({ code: 'PPL-O', name: 'People Other', email: 'ppl.other@example.test', companyPhone: '96662 10012' });
  must('fixture: two employees with company numbers', holder.response.status === 201 && other.response.status === 201, {
    holder: holder.response.json,
    other: other.response.json,
  });
  const grab = await admin.patch(`/admin/telecalling/employees/${other.id}`, { companyPhone: '+91 96662 10011' });
  check(
    "a company number another live employee holds cannot be given out, and the refusal names them",
    grab.status === 422 && String(grab.json.errors?.companyPhone ?? '').includes('People Holder'),
    grab.json,
  );
  const holderOff = await admin.patch(`/admin/telecalling/employees/${holder.id}`, { isActive: false });
  must('fixture: the holder is switched off', holderOff.status === 200, holderOff.json);
  const reissue = await admin.patch(`/admin/telecalling/employees/${other.id}`, { companyPhone: '96662 10011' });
  check(
    "a leaver's number is free to give to someone else",
    reissue.status === 200 && reissue.json.employee?.companyPhone === '+919666210011',
    reissue.json,
  );
  const comeback = await admin.patch(`/admin/telecalling/employees/${holder.id}`, { isActive: true });
  check(
    'switching the leaver back on is refused against the number, not a 500',
    comeback.status === 422 && String(comeback.json.errors?.companyPhone ?? '').includes('People Other'),
    comeback.json,
  );
  check('and they stay switched off', Number((await rows('SELECT is_active FROM telecaller_users WHERE id = ?', [holder.id]))[0]?.is_active) === 0);
  const comebackNewNumber = await admin.patch(`/admin/telecalling/employees/${holder.id}`, { isActive: true, companyPhone: '96662 10013' });
  check(
    'giving them a new number with the reactivation works',
    comebackNewNumber.status === 200 &&
      comebackNewNumber.json.employee?.isActive === true &&
      comebackNewNumber.json.employee?.companyPhone === '+919666210013',
    comebackNewNumber.json,
  );

  /* ------------------------------------- registrations */
  console.log('\npeople — company numbers on registrations');

  const [r1Insert] = await utcDb.execute<ResultSetHeader>(
    `INSERT INTO telecaller_users
       (employee_code, name, email, email_verified_at, password_hash, role, is_active,
        approval_status, registered_at)
     VALUES ('PPL-R1', 'People Applicant', 'ppl.r1@example.test', UTC_TIMESTAMP(), 'not-a-usable-hash',
             'telecaller', 0, 'pending', UTC_TIMESTAMP())`,
  );
  const r1 = r1Insert.insertId;
  mine.push(r1);

  const approveBare = await admin.post(`/admin/telecalling/registrations/${r1}/approve`, {});
  check(
    'a registration with no company number on record cannot be approved without one',
    approveBare.status === 400 && String(approveBare.json.message).includes('company SIM number'),
    approveBare.json,
  );
  const approveTaken = await admin.post(`/admin/telecalling/registrations/${r1}/approve`, { companyPhone: '+919666210001' });
  check(
    "nor with another employee's number",
    approveTaken.status === 422 && String(approveTaken.json.errors?.companyPhone ?? '').includes('People One'),
    approveTaken.json,
  );
  const approveJunk = await admin.post(`/admin/telecalling/registrations/${r1}/approve`, { companyPhone: '12345' });
  check('nor with a number that is not a mobile number', approveJunk.status === 422, approveJunk.json);
  const activatePending = await admin.patch(`/admin/telecalling/employees/${r1}`, { isActive: true });
  check(
    'a pending registration cannot be switched on as a shortcut around approval',
    activatePending.status === 400 &&
      Number((await rows('SELECT is_active FROM telecaller_users WHERE id = ?', [r1]))[0]?.is_active) === 0,
    activatePending.json,
  );
  const pendingCheck = await admin.get(`/admin/telecalling/employees/${r1}/deactivation-check`);
  const pendingDeactivate = await admin.post(`/admin/telecalling/employees/${r1}/deactivate`, {});
  check(
    'nor deactivated — it has a decision waiting, not a switch',
    ((pendingCheck.json.blockers ?? []) as Json[]).some((row) => row.code === 'not_approved') && pendingDeactivate.status === 400,
    { check: pendingCheck.json, deactivate: pendingDeactivate.json },
  );
  const approved = await admin.post(`/admin/telecalling/registrations/${r1}/approve`, { companyPhone: '96662 10031' });
  check(
    'approving with a company number saves it with the approval',
    approved.status === 200 &&
      approved.json.employee?.companyPhone === '+919666210031' &&
      approved.json.employee?.isActive === true &&
      approved.json.employee?.approvalStatus === 'approved',
    approved.json,
  );

  // Sign-up, current and older app builds. The schema first, sparing the sign-up limiter.
  const parse = (body: Json) => signupSchema.safeParse({ name: 'People Schema', email: 'ppl.schema@example.test', password: STAFF_PASSWORD, ...body });
  const spaced = parse({ companyPhone: '98765 43210' });
  const legacy = parse({ phone: '09876543211' });
  const neither = parse({});
  const junk = parse({ companyPhone: '12345' });
  check(
    'sign-up stores the company number canonical',
    spaced.success && spaced.data.companyPhone === '+919876543210',
    spaced.success ? spaced.data : spaced.error.issues,
  );
  check(
    "an older app's only number is taken as the company number",
    legacy.success && legacy.data.companyPhone === '+919876543211',
    legacy.success ? legacy.data : legacy.error.issues,
  );
  check(
    "with neither, the refusal sits under the phone field an older form can show",
    !neither.success && neither.error.issues.some((issue) => issue.path.join('.') === 'phone'),
    neither.success ? neither.data : neither.error.issues,
  );
  check(
    'a company number that is not a mobile number is refused under its own name',
    !junk.success && junk.error.issues.some((issue) => issue.path.join('.') === 'companyPhone'),
    junk.success ? junk.data : junk.error.issues,
  );

  const applicant = makeClient(base);
  const signUp = (body: Json) => applicant.post('/mobile/auth/signup', { password: STAFF_PASSWORD, ...body });
  const r2Signup = await signUp({ name: 'People Signup', email: 'ppl.r2@example.test', companyPhone: '96662 10032' });
  const r2 = Number((await rows('SELECT id, company_phone FROM telecaller_users WHERE email = ?', ['ppl.r2@example.test']))[0]?.id);
  if (Number.isInteger(r2)) mine.push(r2);
  check(
    'a sign-up with a company number is accepted and stored canonical',
    r2Signup.status === 201 &&
      (await rows('SELECT company_phone FROM telecaller_users WHERE id = ?', [r2]))[0]?.company_phone === '+919666210032',
    r2Signup.json,
  );
  const r2Clash = await signUp({ name: 'People Signup Clash', email: 'ppl.r2.clash@example.test', companyPhone: '+91 96662 10032' });
  check(
    'a second sign-up with the same number gets a field error, not a 500',
    r2Clash.status === 422 && typeof r2Clash.json.errors?.companyPhone === 'string',
    r2Clash.json,
  );
  const legacySignup = await signUp({ name: 'People Legacy', email: 'ppl.legacy@example.test', phone: '09666210033' });
  const legacyRow = (await rows('SELECT id, company_phone FROM telecaller_users WHERE email = ?', ['ppl.legacy@example.test']))[0];
  if (legacyRow) mine.push(Number(legacyRow.id));
  check(
    "an older app's sign-up keeps working, its number taken as the company number",
    legacySignup.status === 201 && legacyRow?.company_phone === '+919666210033',
    { response: legacySignup.json, row: legacyRow },
  );
  const legacyClash = await signUp({ name: 'People Legacy Clash', email: 'ppl.legacy.clash@example.test', phone: '9666210033' });
  check(
    'and its clash is reported under the field that older form shows',
    legacyClash.status === 422 && typeof legacyClash.json.errors?.phone === 'string',
    legacyClash.json,
  );
  const noNumber = await signUp({ name: 'People No Number', email: 'ppl.nonumber@example.test' });
  check(
    'a sign-up with no number at all is refused',
    noNumber.status === 422 && typeof noNumber.json.errors?.phone === 'string',
    noNumber.json,
  );

  // The admin form invites rejecting with no reason, and sends `reason: null` when it is.
  await signUp({ name: 'People Blank Reason', email: 'ppl.blankreason@example.test', companyPhone: '96662 10091' });
  const blankReasonId = Number(
    (await rows('SELECT id FROM telecaller_users WHERE email = ?', ['ppl.blankreason@example.test']))[0]?.id,
  );
  if (Number.isInteger(blankReasonId)) mine.push(blankReasonId);
  const blankReason = await admin.post(`/admin/telecalling/registrations/${blankReasonId}/reject`, {
    reason: null,
  });
  check(
    'a registration can be rejected without a reason (reason: null), as the admin form offers',
    blankReason.status === 200 && blankReason.json.employee?.rejectionReason === null,
    blankReason.json,
  );

  const grabPending = await admin.patch(`/admin/telecalling/employees/${e7.id}`, { companyPhone: '96662 10032' });
  check("a pending applicant's number is claimed too", grabPending.status === 422, grabPending.json);
  const rejected = await admin.post(`/admin/telecalling/registrations/${r2}/reject`, { reason: 'Applied twice' });
  must('fixture: the applicant is rejected', rejected.status === 200, rejected.json);
  const reissueRejected = await admin.patch(`/admin/telecalling/employees/${e7.id}`, { companyPhone: '96662 10032' });
  check(
    "a rejected applicant's number is free again",
    reissueRejected.status === 200 && reissueRejected.json.employee?.companyPhone === '+919666210032',
    reissueRejected.json,
  );
  const reopened = await admin.post(`/admin/telecalling/registrations/${r2}/reopen`);
  check(
    'reopening a registration whose number has been given out is refused, naming who has it',
    reopened.status === 400 &&
      String(reopened.json.message).includes('People Seven') &&
      (await rows('SELECT approval_status FROM telecaller_users WHERE id = ?', [r2]))[0]?.approval_status === 'rejected',
    reopened.json,
  );

  /* ------------------------------------- the handset's company-SIM report */
  console.log("people — the handset's company-SIM report");

  const sim = await ctx.createSignedInEmployee({
    name: 'People Sim',
    email: 'ppl.sim@example.test',
    role: 'telecaller',
    companyPhone: '+919666210041',
    code: 'PPL-SIM',
  });
  mine.push(sim.id);
  const missing = async () =>
    ids(itemsOf((await admin.get('/admin/telecalling/employees?companySim=missing&q=ppl.sim&pageSize=100')).json));
  check('a telecaller whose phone has not confirmed the SIM is on the "missing" list', (await missing()).includes(sim.id), await missing());

  const confirmBody = { status: 'confirmed', method: 'confirmed', confirmedFor: '9666210041', simCount: 2, slot: 1, label: 'Jio', deviceName: 'Pixel 7' };
  const confirmed = await sim.client.put('/mobile/profile/company-sim', confirmBody);
  check(
    'the phone reports which SIM is the company SIM',
    confirmed.status === 200 &&
      confirmed.json.employee?.companySim?.status === 'confirmed' &&
      confirmed.json.employee?.companySim?.method === 'confirmed' &&
      confirmed.json.employee?.companySim?.slot === 1 &&
      confirmed.json.employee?.companySim?.label === 'Jio' &&
      confirmed.json.employee?.companySim?.device === 'Pixel 7',
    confirmed.json,
  );
  const replayed = await sim.client.put('/mobile/profile/company-sim', confirmBody);
  const confirmAudits = () =>
    count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'company_sim_confirmed' AND entity_id = ?", [sim.id]);
  check('re-sending the same report changes nothing and is audited once', replayed.status === 200 && (await confirmAudits()) === 1, {
    replay: replayed.status,
    audits: await confirmAudits(),
  });
  const me = await sim.client.get('/mobile/auth/me');
  check(
    'the profile carries the company number and the SIM confirmation',
    me.status === 200 && me.json.employee?.companyPhone === '+919666210041' && me.json.employee?.companySim?.status === 'confirmed',
    me.json,
  );
  const listed = itemsOf((await admin.get('/admin/telecalling/employees?q=ppl.sim&pageSize=100')).json).find((row) => row.id === sim.id);
  check(
    'and so does the admin employee list',
    listed?.companyPhone === '+919666210041' && listed?.companySim?.status === 'confirmed',
    listed,
  );
  check('a confirmed telecaller is off the "missing" list', !(await missing()).includes(sim.id), await missing());

  const staleReport = await sim.client.put('/mobile/profile/company-sim', { ...confirmBody, confirmedFor: '9666210099' });
  check(
    'a report made against a different number is refused so the phone asks again',
    staleReport.status === 409 && staleReport.json.code === 'company_number_changed',
    staleReport.json,
  );
  const noMethod = await sim.client.put('/mobile/profile/company-sim', { status: 'confirmed', confirmedFor: '9666210041', simCount: 1 });
  check('a confirmation must say how the SIM was identified', noMethod.status === 422 && typeof noMethod.json.errors?.method === 'string', noMethod.json);

  const declined = await sim.client.put('/mobile/profile/company-sim', { status: 'declined', confirmedFor: '9666210041', simCount: 1, label: 'Airtel', slot: 0 });
  check(
    '"not in this phone" is stored without a slot or label',
    declined.status === 200 &&
      declined.json.employee?.companySim?.status === 'declined' &&
      declined.json.employee?.companySim?.slot === null &&
      declined.json.employee?.companySim?.label === null &&
      (await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'company_sim_declined' AND entity_id = ?", [sim.id])) === 1,
    declined.json,
  );
  check('and puts them back on the "missing" list', (await missing()).includes(sim.id), await missing());

  const renumbered = await admin.patch(`/admin/telecalling/employees/${sim.id}`, { companyPhone: '96662 10042' });
  check(
    'a new company number clears the confirmation made for the old one',
    renumbered.status === 200 && renumbered.json.employee?.companyPhone === '+919666210042' && renumbered.json.employee?.companySim === null,
    renumbered.json,
  );
  const oldNumber = await sim.client.put('/mobile/profile/company-sim', confirmBody);
  check(
    'and a confirmation for the old number is refused',
    oldNumber.status === 409 && oldNumber.json.code === 'company_number_changed',
    oldNumber.json,
  );
  const reconfirmed = await sim.client.put('/mobile/profile/company-sim', { ...confirmBody, confirmedFor: '9666210042' });
  check(
    'confirming against the new number works and is audited',
    reconfirmed.status === 200 && reconfirmed.json.employee?.companySim?.status === 'confirmed' && (await confirmAudits()) === 2,
    reconfirmed.json,
  );
  const noNumberYet = await admin.put('/mobile/profile/company-sim', { ...confirmBody, confirmedFor: '9666210041' });
  check(
    'an employee with no company number on file is told to ask for one',
    noNumberYet.status === 400 && String(noNumberYet.json.message).includes('company number'),
    noNumberYet.json,
  );

  /* ------------------------------------- follow-up lists on the IST day */
  console.log('\npeople — follow-up lists on the company day');

  const istToday = time.companyDate();
  const dayStart = time.companyDayStart(istToday);
  const minute = 60_000;
  const insertFollowUp = async (fields: { dueAt: Date; state: 'pending' | 'completed'; completedAt?: Date | null }) => {
    const [inserted] = await utcDb.execute<ResultSetHeader>(
      `INSERT INTO follow_ups (lead_id, assigned_to, created_by, due_at, state, completed_at, completed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        l2,
        e2.id,
        adminId,
        fields.dueAt,
        fields.state,
        fields.completedAt ?? null,
        fields.state === 'completed' ? e2.id : null,
      ],
    );
    return inserted.insertId;
  };
  // A minute either side of IST midnight — the edges a UTC-day window gets wrong.
  const dueJustAfter = await insertFollowUp({ dueAt: new Date(dayStart.getTime() + minute), state: 'pending' });
  const dueJustBefore = await insertFollowUp({ dueAt: new Date(dayStart.getTime() - minute), state: 'pending' });
  const doneJustAfter = await insertFollowUp({
    dueAt: new Date(dayStart.getTime() - 86_400_000),
    state: 'completed',
    completedAt: new Date(dayStart.getTime() + minute),
  });
  const doneJustBefore = await insertFollowUp({
    dueAt: new Date(dayStart.getTime() - 86_400_000),
    state: 'completed',
    completedAt: new Date(dayStart.getTime() - minute),
  });

  const listIds = async (query: string) =>
    ids(itemsOf((await admin.get(`/admin/telecalling/follow-ups?leadId=${l2}&pageSize=100&${query}`)).json));
  const todayIds = await listIds('scope=today');
  check(
    '"today" is the IST day: 00:01 IST is in, 23:59 IST yesterday is out',
    todayIds.includes(dueJustAfter) && !todayIds.includes(dueJustBefore),
    { todayIds, dueJustAfter, dueJustBefore },
  );
  const overdueIds = await listIds('scope=overdue');
  check(
    'and both are overdue, by the instant',
    overdueIds.includes(dueJustAfter) && overdueIds.includes(dueJustBefore),
    overdueIds,
  );
  const completedTodayIds = await listIds('scope=completed_today');
  check(
    '"completed today" is the IST day too',
    completedTodayIds.includes(doneJustAfter) && !completedTodayIds.includes(doneJustBefore) && completedTodayIds.includes(f2),
    { completedTodayIds, doneJustAfter, doneJustBefore, f2 },
  );
  check(
    'newest completion first',
    completedTodayIds.indexOf(f2) >= 0 && completedTodayIds.indexOf(f2) < completedTodayIds.indexOf(doneJustAfter),
    completedTodayIds,
  );
  const rangeIds = await listIds(`scope=all&from=${istToday}&to=${istToday}`);
  check(
    'a from/to filter reads its days on the IST clock',
    rangeIds.includes(dueJustAfter) && !rangeIds.includes(dueJustBefore),
    rangeIds,
  );
  const mobileDone = ids(itemsOf((await two.client.get('/mobile/follow-ups?scope=completed_today&pageSize=100')).json));
  check(
    'the app has the "completed today" list as well, for its own follow-ups',
    mobileDone.includes(f2) && mobileDone.includes(doneJustAfter) && !mobileDone.includes(doneJustBefore),
    mobileDone,
  );

  // A dashboard card and the list it opens count the same rows.
  const dashboard = await admin.get('/admin/telecalling/dashboard');
  const totalOf = async (scope: string) =>
    Number((await admin.get(`/admin/telecalling/follow-ups?scope=${scope}&pageSize=1`)).json.total ?? Number.NaN);
  const parity = {
    today: [dashboard.json.followUps?.today, await totalOf('today')],
    overdue: [dashboard.json.followUps?.overdue, await totalOf('overdue')],
    completed: [dashboard.json.followUps?.completed, await totalOf('completed_today')],
  };
  check(
    'the "Due today", "Overdue" and "Completed today" cards match their lists',
    dashboard.status === 200 &&
      Object.values(parity).every(([card, list]) => Number(card) === list) &&
      Number(parity.today[1]) >= 1 &&
      Number(parity.completed[1]) >= 2,
    parity,
  );

  await rows(`DELETE FROM follow_ups WHERE id IN (?, ?, ?, ?)`, [dueJustAfter, dueJustBefore, doneJustAfter, doneJustBefore]);

  /* ------------------------------------- password change after deactivation */
  console.log('\npeople — a switched-off account changing its password');

  const hashBefore = (await rows('SELECT password_hash FROM telecaller_users WHERE id = ?', [e3.id]))[0]?.password_hash as unknown;
  const changePw = await three.client.post('/mobile/auth/change-password', {
    currentPassword: STAFF_PASSWORD,
    newPassword: 'people-section-password-changed',
  });
  const hashAfter = (await rows('SELECT password_hash FROM telecaller_users WHERE id = ?', [e3.id]))[0]?.password_hash as unknown;
  check(
    'a switched-off account is refused with the code the app acts on',
    changePw.status === 403 && changePw.json.code === 'account_deactivated' && !changePw.json.accessToken,
    changePw.json,
  );
  check(
    'before anything is changed: the password is untouched and nothing is audited',
    typeof hashBefore === 'string' &&
      hashBefore === hashAfter &&
      (await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'employee_password_changed' AND entity_id = ?", [e3.id])) === 0,
  );

  /* ------------------------------------------------------------- tidy up */
  // Cancel every follow-up this section left pending, so later sections start from none.
  await rows(
    `UPDATE follow_ups SET state = 'cancelled' WHERE state = 'pending' AND lead_id IN (${placeholders(myLeads)})`,
    myLeads,
  );
  check(
    "the section's open follow-ups are cancelled again",
    (await count(`SELECT COUNT(*) AS n FROM follow_ups WHERE state = 'pending' AND lead_id IN (${placeholders(myLeads)})`, myLeads)) === 0,
  );
}
