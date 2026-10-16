import type { ApiResponse, Client, E2EContext, Json } from './context';

/**
 * hrRequests — HR requests, shared documents and announcements (spec 4.3).
 *
 *   - every category can be raised; a client-key replay returns the original
 *   - a profile update is validated, one may be open at a time, and RESOLVING it writes
 *     the new values to the employee record (seen through /hr/auth/me) with an audit row
 *   - both sides comment; status changes leave timeline entries; rejection needs a note;
 *     cancel only while open or in progress; another employee's request is a 404
 *   - documents: PDF/PNG accepted, a PNG renamed .pdf and a text file refused; personal
 *     vs company-wide visibility; a five-minute link serves the exact bytes; somebody
 *     else's document, a garbage or expired token and a removed document are all 404
 *   - an announcement to one department reaches only its members
 *   - the HR inbox paginates and marks read
 *
 * Files stored by this section (local driver: under UPLOAD_DIR/hr-documents/) are
 * deleted again at the end, whether or not the checks passed.
 */

type Upload = { name: string; bytes: Buffer; type: string };

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

const MINIMAL_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01]),
]);

function form(file: Upload | null, fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  if (file) body.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  return body;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function run(ctx: E2EContext): Promise<void> {
  const { check, utcDb, adminAsBearer, ravi } = ctx;
  console.log('\nhr requests');

  const rows = async (sql: string, params: unknown[] = []): Promise<Json[]> =>
    ((await utcDb.query(sql, params)) as [Json[], unknown])[0];

  const upload = (client: Client, file: Upload | null, fields: Record<string, string>): Promise<ApiResponse> =>
    client.callForm('POST', '/admin/hr/documents', form(file, fields));

  const notices = (userId: number, kind: string): Promise<Json[]> =>
    rows('SELECT id, entity_type, entity_id, title, body FROM hr_notifications WHERE user_id = ? AND kind = ? ORDER BY id', [
      userId,
      kind,
    ]);

  /* ------------------------------------------------------------- fixtures */
  const alice = await ctx.createSignedInHrEmployee({ name: 'Req Alice', email: 'req.alice@example.test' });
  const bob = await ctx.createSignedInHrEmployee({ name: 'Req Bob', email: 'req.bob@example.test' });
  const supervisor = await ctx.createSignedInEmployee({
    name: 'Req Supervisor',
    email: 'req.supervisor@example.test',
    role: 'supervisor',
  });

  /* ---------------------------------------------------- raise every kind */
  const ids: Record<string, number> = {};
  for (const category of ['letter', 'payroll', 'attendance', 'leave', 'it', 'other']) {
    const raised = await alice.client.post('/hr/requests', {
      category,
      subject: `Need help with ${category}`,
      details: category === 'letter' ? 'An address proof letter for my bank, please.' : undefined,
      clientKey: `req-alice-${category}-0001`,
    });
    ids[category] = Number(raised.json.request?.id ?? 0);
    check(
      `requests: a ${category} request is raised (201, open, cancellable, no payload)`,
      raised.status === 201 &&
        raised.json.request?.category === category &&
        raised.json.request?.status === 'open' &&
        raised.json.request?.canCancel === true &&
        raised.json.request?.payload === null &&
        raised.json.deduplicated === false,
      raised.json,
    );
  }
  const letterId = ids.letter ?? 0;

  const replay = await alice.client.post('/hr/requests', {
    category: 'letter',
    subject: 'Need help with letter',
    clientKey: 'req-alice-letter-0001',
  });
  const keyRows = await rows('SELECT COUNT(*) AS c FROM hr_requests WHERE user_id = ? AND client_key = ?', [
    alice.id,
    'req-alice-letter-0001',
  ]);
  check(
    'requests: a clientKey replay answers 200 with the original, deduplicated',
    replay.status === 200 && replay.json.deduplicated === true && Number(replay.json.request?.id) === letterId,
    replay.json,
  );
  check('requests: and writes no second row', Number(keyRows[0]?.c) === 1, keyRows);

  /* ------------------------------------------------- profile update rules */
  const bad = async (label: string, body: Json, field: string) => {
    const response = await alice.client.post('/hr/requests', body);
    check(label, response.status === 422 && typeof response.json.errors?.[field] === 'string', {
      status: response.status,
      json: response.json,
    });
  };
  await bad(
    'requests: a profile update without a payload is refused on payload',
    { category: 'profile_update', subject: 'Update my phone', clientKey: 'req-alice-bad-0001' },
    'payload',
  );
  await bad(
    'requests: an empty profile update payload is refused',
    { category: 'profile_update', subject: 'Update my phone', payload: {}, clientKey: 'req-alice-bad-0002' },
    'payload',
  );
  await bad(
    'requests: a malformed phone in the payload is refused on payload.phone',
    { category: 'profile_update', subject: 'Update my phone', payload: { phone: 'call me' }, clientKey: 'req-alice-bad-0003' },
    'payload.phone',
  );
  await bad(
    'requests: a future date of birth is refused on payload.dateOfBirth',
    { category: 'profile_update', subject: 'Fix my birthday', payload: { dateOfBirth: '2999-01-01' }, clientKey: 'req-alice-bad-0004' },
    'payload.dateOfBirth',
  );
  await bad(
    'requests: a payload on any other category is refused',
    { category: 'letter', subject: 'A letter', payload: { phone: '+919800000000' }, clientKey: 'req-alice-bad-0005' },
    'payload',
  );
  await bad(
    'requests: a subject under 3 characters is refused',
    { category: 'other', subject: 'Hi', clientKey: 'req-alice-bad-0006' },
    'subject',
  );
  await bad('requests: a missing clientKey is refused', { category: 'other', subject: 'No key here' }, 'clientKey');

  const newValues = {
    phone: '+91 98765 43210',
    address: '12 MG Road\nPune 411001',
    emergencyContactName: 'Kiran   Rao',
    emergencyContactPhone: '+919800000001',
    dateOfBirth: '1990-04-12',
  };
  const profileUpdate = await alice.client.post('/hr/requests', {
    category: 'profile_update',
    subject: 'Please update my contact details',
    payload: { ...newValues, role: 'hr_admin' },
    clientKey: 'req-alice-profile-0001',
  });
  const profileId = Number(profileUpdate.json.request?.id ?? 0);
  check(
    'requests: a valid profile update is raised with its payload (names tidied, unknown keys dropped)',
    profileUpdate.status === 201 &&
      profileUpdate.json.request?.payload?.phone === newValues.phone &&
      profileUpdate.json.request?.payload?.emergencyContactName === 'Kiran Rao' &&
      profileUpdate.json.request?.payload?.address === newValues.address &&
      profileUpdate.json.request?.payload?.role === undefined,
    profileUpdate.json,
  );

  const secondProfile = await alice.client.post('/hr/requests', {
    category: 'profile_update',
    subject: 'Another change',
    payload: { address: 'Somewhere else' },
    clientKey: 'req-alice-profile-0002',
  });
  check(
    'requests: a second open profile update is refused (400)',
    secondProfile.status === 400 && typeof secondProfile.json.message === 'string',
    secondProfile.json,
  );

  /* ------------------------------------------------------------- comments */
  const employeeComment = await alice.client.post(`/hr/requests/${profileId}/comments`, {
    body: 'My old number no longer works.',
  });
  check(
    'requests: the employee comments on their request',
    employeeComment.status === 201 &&
      employeeComment.json.comment?.authorType === 'employee' &&
      employeeComment.json.comment?.authorName === 'Req Alice',
    employeeComment.json,
  );
  const commentReplay = await alice.client.post(`/hr/requests/${profileId}/comments`, {
    body: 'My old number no longer works.',
  });
  check(
    'requests: the same comment sent again at once is answered with the first (no duplicate)',
    commentReplay.status === 200 &&
      commentReplay.json.deduplicated === true &&
      commentReplay.json.comment?.id === employeeComment.json.comment?.id,
    commentReplay.json,
  );

  const updatedBefore = (await notices(alice.id, 'request_updated')).length;
  const adminComment = await adminAsBearer.post(`/admin/hr/requests/${profileId}/comments`, {
    body: 'Thanks, we will update it today.',
  });
  check(
    'requests: HR replies from the admin portal',
    adminComment.status === 201 && adminComment.json.comment?.authorType === 'admin',
    adminComment.json,
  );
  check(
    'requests: and the employee is notified of the reply',
    (await notices(alice.id, 'request_updated')).length === updatedBefore + 1,
  );

  const detail = await alice.client.get(`/hr/requests/${profileId}`);
  check(
    'requests: the detail carries the timeline, oldest first',
    detail.status === 200 &&
      detail.json.comments?.total === 2 &&
      detail.json.comments?.items?.[0]?.authorType === 'employee' &&
      detail.json.comments?.items?.[1]?.authorType === 'admin' &&
      Array.isArray(detail.json.documents) &&
      detail.json.request?.commentCount === 2,
    detail.json,
  );

  // A comment moves a request to the top of the employee's inbox.
  await sleep(1100);
  await alice.client.post(`/hr/requests/${letterId}/comments`, { body: 'Any update on this one?' });
  const inboxTop = await alice.client.get('/hr/requests?page=1&pageSize=1');
  check(
    'requests: a comment bumps the request to the top of the employee list',
    inboxTop.status === 200 && Number(inboxTop.json.items?.[0]?.id) === letterId,
    inboxTop.json.items?.[0],
  );

  /* ----------------------------------------------------- admin and roles */
  const queue = await adminAsBearer.get(`/admin/hr/requests?userId=${alice.id}&category=profile_update`);
  check(
    'requests: the admin queue filters by employee and category',
    queue.status === 200 && queue.json.total === 1 && Number(queue.json.items?.[0]?.id) === profileId,
    queue.json,
  );
  const adminDetail = await adminAsBearer.get(`/admin/hr/requests/${profileId}`);
  check(
    'requests: the admin detail shows the CURRENT values beside the requested ones',
    adminDetail.status === 200 &&
      adminDetail.json.current !== null &&
      typeof adminDetail.json.current === 'object' &&
      'phone' in (adminDetail.json.current ?? {}) &&
      adminDetail.json.current?.phone === null &&
      adminDetail.json.request?.payload?.phone === newValues.phone,
    adminDetail.json.current,
  );
  const letterDetail = await adminAsBearer.get(`/admin/hr/requests/${letterId}`);
  check(
    'requests: other categories carry no current values',
    letterDetail.status === 200 && letterDetail.json.current === null,
    letterDetail.json.current,
  );

  const supervisorRead = await supervisor.client.get('/admin/hr/requests?status=active');
  check('requests: a supervisor may read the queue', supervisorRead.status === 200, supervisorRead.json);
  const supervisorWrite = await supervisor.client.post(`/admin/hr/requests/${profileId}/status`, {
    status: 'in_progress',
  });
  check('requests: a supervisor may not decide (403)', supervisorWrite.status === 403, supervisorWrite.json);
  const telecallerRead = await ravi.get('/admin/hr/requests');
  check('requests: a telecaller may not read the queue (403)', telecallerRead.status === 403, telecallerRead.json);
  const hrTokenAdmin = await alice.client.get('/admin/hr/requests');
  check('requests: an HR app token is refused on the admin routes (401)', hrTokenAdmin.status === 401, hrTokenAdmin.json);

  const countBefore = await adminAsBearer.get('/admin/hr/requests/count');
  const inProgress = await adminAsBearer.post(`/admin/hr/requests/${profileId}/status`, {
    status: 'in_progress',
    note: 'Checking with payroll.',
  });
  const countAfter = await adminAsBearer.get('/admin/hr/requests/count');
  check(
    'requests: HR moves a request to in progress',
    inProgress.status === 200 && inProgress.json.request?.status === 'in_progress' && inProgress.json.applied === null,
    inProgress.json,
  );
  check(
    'requests: the queue count moves from open to in progress by one',
    Number(countAfter.json.open) === Number(countBefore.json.open) - 1 &&
      Number(countAfter.json.inProgress) === Number(countBefore.json.inProgress) + 1,
    { before: countBefore.json, after: countAfter.json },
  );
  const statusRows = await rows(
    'SELECT author_type, status_from, status_to, body FROM hr_request_comments WHERE request_id = ? AND status_to IS NOT NULL',
    [profileId],
  );
  check(
    'requests: the status change is a timeline entry (open → in_progress, with the note)',
    statusRows.length === 1 &&
      statusRows[0]?.status_from === 'open' &&
      statusRows[0]?.status_to === 'in_progress' &&
      statusRows[0]?.author_type === 'admin' &&
      statusRows[0]?.body === 'Checking with payroll.',
    statusRows,
  );
  const againInProgress = await adminAsBearer.post(`/admin/hr/requests/${profileId}/status`, { status: 'in_progress' });
  check('requests: moving it to in progress twice is refused', againInProgress.status === 400, againInProgress.json);

  /* ---------------------------------------------- resolving a profile update */
  const resolvedBefore = (await notices(alice.id, 'request_resolved')).length;
  const resolved = await adminAsBearer.post(`/admin/hr/requests/${profileId}/status`, {
    status: 'resolved',
    note: 'Updated as asked.',
  });
  check(
    'requests: resolving the profile update applies it',
    resolved.status === 200 &&
      resolved.json.request?.status === 'resolved' &&
      resolved.json.request?.resolvedByName === 'Asha Admin' &&
      resolved.json.request?.resolutionNote === 'Updated as asked.' &&
      resolved.json.request?.canCancel === false &&
      resolved.json.applied?.after?.phone === newValues.phone &&
      resolved.json.applied?.before?.phone === null,
    resolved.json,
  );
  const me = await alice.client.get('/hr/auth/me');
  check(
    'requests: /hr/auth/me shows the new values',
    me.status === 200 &&
      me.json.employee?.phone === newValues.phone &&
      me.json.employee?.address === newValues.address &&
      me.json.employee?.emergencyContactName === 'Kiran Rao' &&
      me.json.employee?.emergencyContactPhone === newValues.emergencyContactPhone &&
      me.json.employee?.dateOfBirth === newValues.dateOfBirth &&
      me.json.employee?.role === 'employee',
    me.json.employee,
  );
  const profileAudit = await rows(
    "SELECT meta FROM audit_logs WHERE action = 'hr_profile_update_applied' AND entity_type = 'hr_user' AND entity_id = ?",
    [alice.id],
  );
  const auditMeta = (() => {
    const raw = profileAudit[0]?.meta;
    try {
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Json | null;
    } catch {
      return null;
    }
  })();
  check(
    'requests: the change is audited against the employee with before and after',
    profileAudit.length === 1 &&
      auditMeta?.before?.phone === null &&
      auditMeta?.after?.phone === newValues.phone &&
      Number(auditMeta?.requestId) === profileId,
    profileAudit,
  );
  const requestAudit = await rows(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_request_resolved' AND entity_type = 'hr_request' AND entity_id = ?",
    [profileId],
  );
  check('requests: and the decision against the request', Number(requestAudit[0]?.c) === 1, requestAudit);
  check(
    'requests: the employee is notified it was resolved',
    (await notices(alice.id, 'request_resolved')).length === resolvedBefore + 1,
  );
  const decidedAgain = await adminAsBearer.post(`/admin/hr/requests/${profileId}/status`, { status: 'rejected', note: 'No' });
  check('requests: a decided request cannot be decided again', decidedAgain.status === 400, decidedAgain.json);
  const commentOnClosed = await alice.client.post(`/hr/requests/${profileId}/comments`, { body: 'One more thing' });
  check('requests: a resolved request takes no more comments', commentOnClosed.status === 400, commentOnClosed.json);

  // The first is resolved, so a new profile update may be raised — and withdrawn.
  const nextProfile = await alice.client.post('/hr/requests', {
    category: 'profile_update',
    subject: 'Another change',
    payload: { address: 'Somewhere else' },
    clientKey: 'req-alice-profile-0003',
  });
  check('requests: once resolved, a new profile update may be raised', nextProfile.status === 201, nextProfile.json);
  const nextProfileId = Number(nextProfile.json.request?.id ?? 0);

  /* ------------------------------------------------------------ rejection */
  const rejectNoNote = await adminAsBearer.post(`/admin/hr/requests/${letterId}/status`, { status: 'rejected' });
  check(
    'requests: rejecting without a note is refused on note',
    rejectNoNote.status === 422 && typeof rejectNoNote.json.errors?.note === 'string',
    rejectNoNote.json,
  );
  const rejectedBefore = (await notices(alice.id, 'request_rejected')).length;
  const rejected = await adminAsBearer.post(`/admin/hr/requests/${letterId}/status`, {
    status: 'rejected',
    note: 'Please ask your branch manager for this letter.',
  });
  check(
    'requests: a rejection with a note is recorded',
    rejected.status === 200 &&
      rejected.json.request?.status === 'rejected' &&
      rejected.json.request?.resolutionNote === 'Please ask your branch manager for this letter.',
    rejected.json,
  );
  check(
    'requests: and the employee is notified',
    (await notices(alice.id, 'request_rejected')).length === rejectedBefore + 1,
  );

  /* --------------------------------------------------------- cancel rules */
  const cancelOpen = await alice.client.post(`/hr/requests/${ids.payroll}/cancel`);
  check(
    'requests: an open request can be cancelled',
    cancelOpen.status === 200 && cancelOpen.json.request?.status === 'cancelled' && cancelOpen.json.request?.canCancel === false,
    cancelOpen.json,
  );
  await adminAsBearer.post(`/admin/hr/requests/${ids.attendance}/status`, { status: 'in_progress' });
  const cancelInProgress = await alice.client.post(`/hr/requests/${ids.attendance}/cancel`);
  check(
    'requests: an in-progress request can be cancelled',
    cancelInProgress.status === 200 && cancelInProgress.json.request?.status === 'cancelled',
    cancelInProgress.json,
  );
  const cancelRows = await rows(
    "SELECT author_type, status_from FROM hr_request_comments WHERE request_id = ? AND status_to = 'cancelled'",
    [ids.attendance],
  );
  check(
    'requests: the cancellation is a timeline entry by the employee',
    cancelRows.length === 1 && cancelRows[0]?.author_type === 'employee' && cancelRows[0]?.status_from === 'in_progress',
    cancelRows,
  );
  const cancelTwice = await alice.client.post(`/hr/requests/${ids.payroll}/cancel`);
  check('requests: cancelling twice is refused', cancelTwice.status === 400, cancelTwice.json);
  const cancelRejected = await alice.client.post(`/hr/requests/${letterId}/cancel`);
  check('requests: a rejected request cannot be cancelled', cancelRejected.status === 400, cancelRejected.json);
  await adminAsBearer.post(`/admin/hr/requests/${ids.it}/status`, { status: 'resolved' });
  const cancelResolved = await alice.client.post(`/hr/requests/${ids.it}/cancel`);
  check('requests: a resolved request cannot be cancelled', cancelResolved.status === 400, cancelResolved.json);
  const cancelNext = await alice.client.post(`/hr/requests/${nextProfileId}/cancel`);
  check('requests: the employee withdraws the second profile update', cancelNext.status === 200, cancelNext.json);
  const decideCancelled = await adminAsBearer.post(`/admin/hr/requests/${nextProfileId}/status`, { status: 'resolved' });
  check('requests: HR cannot resolve a cancelled request', decideCancelled.status === 400, decideCancelled.json);
  const meAfterCancel = await alice.client.get('/hr/auth/me');
  check(
    'requests: and the withdrawn change was never applied',
    meAfterCancel.json.employee?.address === newValues.address,
    meAfterCancel.json.employee?.address,
  );

  /* ------------------------------------------------ another employee's view */
  const bobReads = await bob.client.get(`/hr/requests/${ids.leave}`);
  const bobComments = await bob.client.get(`/hr/requests/${ids.leave}/comments`);
  const bobComment = await bob.client.post(`/hr/requests/${ids.leave}/comments`, { body: 'Hello?' });
  const bobCancel = await bob.client.post(`/hr/requests/${ids.leave}/cancel`);
  const bobList = await bob.client.get('/hr/requests');
  check(
    "requests: another employee's request is 404 to read, page, comment on or cancel",
    bobReads.status === 404 && bobComments.status === 404 && bobComment.status === 404 && bobCancel.status === 404,
    [bobReads.status, bobComments.status, bobComment.status, bobCancel.status],
  );
  check('requests: and is not in their list', bobList.status === 200 && bobList.json.total === 0, bobList.json);
  const stillOpen = await rows('SELECT status FROM hr_requests WHERE id = ?', [ids.leave]);
  check('requests: and is left untouched', stillOpen[0]?.status === 'open', stillOpen);

  /* ------------------------------------------------------------ pagination */
  const aliceTotal = Number(
    (await rows('SELECT COUNT(*) AS c FROM hr_requests WHERE user_id = ?', [alice.id]))[0]?.c ?? -1,
  );
  const page1 = await alice.client.get('/hr/requests?page=1&pageSize=3');
  const page2 = await alice.client.get('/hr/requests?page=2&pageSize=3');
  const pageIds = [...(page1.json.items ?? []), ...(page2.json.items ?? [])].map((item: Json) => Number(item.id));
  check(
    'requests: the employee list paginates with a true total',
    page1.status === 200 &&
      page1.json.total === aliceTotal &&
      page1.json.items?.length === 3 &&
      page1.json.pageSize === 3 &&
      page2.json.page === 2 &&
      new Set(pageIds).size === pageIds.length,
    { total: page1.json.total, aliceTotal, pageIds },
  );
  const activeOnly = await alice.client.get('/hr/requests?status=active');
  const activeExpected = Number(
    (
      await rows("SELECT COUNT(*) AS c FROM hr_requests WHERE user_id = ? AND status IN ('open','in_progress')", [
        alice.id,
      ])
    )[0]?.c ?? -1,
  );
  check(
    'requests: status=active is open plus in progress',
    activeOnly.status === 200 && activeOnly.json.total === activeExpected,
    { got: activeOnly.json.total, activeExpected },
  );
  const { openRequestCount } = await import('../../src/modules/hr/requests/requests.service');
  check(
    'requests: openRequestCount (for the dashboard) agrees',
    (await openRequestCount(alice.id)) === activeExpected,
  );
  const commentsPage = await alice.client.get(`/hr/requests/${profileId}/comments?page=2&pageSize=2`);
  check(
    'requests: the timeline pages on',
    commentsPage.status === 200 && commentsPage.json.total === 4 && commentsPage.json.items?.length === 2,
    commentsPage.json,
  );
  const adminPaged = await adminAsBearer.get(`/admin/hr/requests?userId=${alice.id}&page=1&pageSize=2`);
  check(
    'requests: the admin queue paginates, open first',
    adminPaged.status === 200 &&
      adminPaged.json.total === aliceTotal &&
      adminPaged.json.items?.length === 2 &&
      adminPaged.json.items?.[0]?.status === 'open',
    adminPaged.json.items,
  );

  /* -------------------------------------------------------------- documents */
  const storedIds: number[] = [];
  try {
    const remember = (response: ApiResponse): number => {
      const id = Number(response.json.document?.id ?? 0);
      if (id > 0) storedIds.push(id);
      return id;
    };

    const sharedBefore = (await notices(alice.id, 'document_shared')).length;
    const personal = await upload(adminAsBearer, { name: 'Offer letter – Alice.pdf', bytes: MINIMAL_PDF, type: 'application/pdf' }, {
      title: 'Offer letter',
      category: 'letter',
      userId: String(alice.id),
    });
    const personalId = remember(personal);
    check(
      'documents: a PDF is shared with one employee',
      personal.status === 201 &&
        personal.json.document?.scope === 'personal' &&
        personal.json.document?.userId === alice.id &&
        personal.json.document?.mimeType === 'application/pdf' &&
        personal.json.document?.sizeBytes === MINIMAL_PDF.length &&
        personal.json.document?.originalName === 'Offer letter – Alice.pdf' &&
        personal.json.recipients === 1 &&
        personal.json.document?.storageKey === undefined,
      personal.json,
    );
    check(
      'documents: the employee is notified',
      (await notices(alice.id, 'document_shared')).length === sharedBefore + 1,
    );

    const keyRow = (await rows('SELECT storage_key FROM hr_documents WHERE id = ?', [personalId]))[0];
    check(
      'documents: the storage key is generated under hr-documents/, not the file name',
      typeof keyRow?.storage_key === 'string' &&
        /^hr-documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/.test(String(keyRow?.storage_key)),
      keyRow,
    );

    const expectedRecipients = Number(
      (
        await rows(
          "SELECT COUNT(*) AS c FROM hr_users WHERE approval_status = 'approved' AND is_active = 1 AND employment_status <> 'exited'",
        )
      )[0]?.c ?? -1,
    );
    const company = await upload(adminAsBearer, { name: 'handbook.pdf', bytes: MINIMAL_PDF, type: 'application/pdf' }, {
      title: 'Employee handbook',
      category: 'policy',
    });
    const companyId = remember(company);
    const bobCompanyNotice = (await notices(bob.id, 'document_shared')).filter((row) => Number(row.entity_id) === companyId);
    check(
      'documents: a company-wide PDF is shared and every current employee notified',
      company.status === 201 &&
        company.json.document?.scope === 'company' &&
        company.json.document?.userId === null &&
        company.json.recipients === expectedRecipients &&
        bobCompanyNotice.length === 1,
      { status: company.status, recipients: company.json.recipients, expectedRecipients },
    );

    const png = await upload(adminAsBearer, { name: 'badge.png', bytes: MINIMAL_PNG, type: 'image/png' }, {
      title: 'ID badge',
      category: 'identity',
      userId: String(bob.id),
    });
    const bobPngId = remember(png);
    check(
      'documents: a PNG is accepted (personal to another employee)',
      png.status === 201 && png.json.document?.mimeType === 'image/png' && png.json.document?.userId === bob.id,
      png.json,
    );

    const renamed = await upload(adminAsBearer, { name: 'scan.pdf', bytes: MINIMAL_PNG, type: 'application/pdf' }, {
      title: 'Not really a PDF',
      userId: String(alice.id),
    });
    remember(renamed);
    check(
      'documents: a PNG renamed .pdf is refused on file',
      renamed.status === 400 && typeof renamed.json.errors?.file === 'string',
      renamed.json,
    );
    const text = await upload(adminAsBearer, { name: 'notes.txt', bytes: Buffer.from('hello'), type: 'text/plain' }, {
      title: 'Notes',
    });
    remember(text);
    check(
      'documents: a text file is refused on file',
      text.status === 400 && typeof text.json.errors?.file === 'string',
      text.json,
    );
    const mismatched = await upload(adminAsBearer, { name: 'letter.pdf', bytes: MINIMAL_PDF, type: 'image/png' }, {
      title: 'Declared as an image',
    });
    remember(mismatched);
    check('documents: an extension and declared type that disagree are refused', mismatched.status === 400, mismatched.json);
    const noFile = await upload(adminAsBearer, null, { title: 'Nothing attached' });
    check(
      'documents: an upload without a file is refused on file',
      noFile.status === 400 && typeof noFile.json.errors?.file === 'string',
      noFile.json,
    );
    const noTitle = await upload(adminAsBearer, { name: 'x.pdf', bytes: MINIMAL_PDF, type: 'application/pdf' }, {});
    remember(noTitle);
    check(
      'documents: an upload without a title is refused on title',
      noTitle.status === 422 && typeof noTitle.json.errors?.title === 'string',
      noTitle.json,
    );
    const supervisorUpload = await upload(supervisor.client, { name: 'x.pdf', bytes: MINIMAL_PDF, type: 'application/pdf' }, {
      title: 'Supervisor upload',
    });
    remember(supervisorUpload);
    check('documents: a supervisor may not upload (403)', supervisorUpload.status === 403, supervisorUpload.json);
    const wrongOwner = await upload(adminAsBearer, { name: 'x.pdf', bytes: MINIMAL_PDF, type: 'application/pdf' }, {
      title: 'Mismatched request',
      userId: String(bob.id),
      requestId: String(ids.leave),
    });
    remember(wrongOwner);
    check(
      "documents: a request of one employee cannot carry another's document",
      wrongOwner.status === 400 && typeof wrongOwner.json.errors?.requestId === 'string',
      wrongOwner.json,
    );
    const leftover = await rows("SELECT COUNT(*) AS c FROM hr_documents WHERE title IN ('Not really a PDF', 'Notes', 'Mismatched request')");
    check('documents: refused uploads leave no row', Number(leftover[0]?.c) === 0, leftover);

    const onRequest = await upload(adminAsBearer, { name: 'salary-certificate.pdf', bytes: MINIMAL_PDF, type: 'application/pdf' }, {
      title: 'Salary certificate',
      category: 'payroll',
      requestId: String(ids.leave),
    });
    const onRequestId = remember(onRequest);
    check(
      "documents: a document shared on a request belongs to the request's employee",
      onRequest.status === 201 &&
        onRequest.json.document?.scope === 'personal' &&
        onRequest.json.document?.userId === alice.id &&
        onRequest.json.document?.requestId === ids.leave,
      onRequest.json,
    );
    const requestWithDoc = await alice.client.get(`/hr/requests/${ids.leave}`);
    check(
      'documents: and appears on the request, with a timeline entry',
      requestWithDoc.status === 200 &&
        requestWithDoc.json.documents?.length === 1 &&
        Number(requestWithDoc.json.documents?.[0]?.id) === onRequestId &&
        requestWithDoc.json.documentsTotal === 1 &&
        requestWithDoc.json.comments?.items?.some((item: Json) => String(item.body ?? '').includes('Salary certificate')) === true,
      requestWithDoc.json,
    );

    // The employee's view
    const aliceAll = await alice.client.get('/hr/documents');
    const aliceAllIds = (aliceAll.json.items ?? []).map((item: Json) => Number(item.id));
    check(
      'documents: the employee lists their own and company-wide documents, not anyone else’s',
      aliceAll.status === 200 &&
        aliceAllIds.includes(personalId) &&
        aliceAllIds.includes(companyId) &&
        aliceAllIds.includes(onRequestId) &&
        !aliceAllIds.includes(bobPngId),
      aliceAllIds,
    );
    const aliceCompany = await alice.client.get('/hr/documents?scope=company');
    const alicePersonal = await alice.client.get('/hr/documents?scope=personal&pageSize=1');
    check(
      'documents: scope=company lists only company-wide documents',
      aliceCompany.status === 200 &&
        (aliceCompany.json.items ?? []).every((item: Json) => item.scope === 'company' && item.userId === null) &&
        (aliceCompany.json.items ?? []).some((item: Json) => Number(item.id) === companyId),
      aliceCompany.json.items,
    );
    check(
      'documents: scope=personal lists only their own, paginated',
      alicePersonal.status === 200 &&
        alicePersonal.json.total === 2 &&
        alicePersonal.json.items?.length === 1 &&
        alicePersonal.json.items?.[0]?.userId === alice.id,
      alicePersonal.json,
    );

    // Links
    const link = await alice.client.post(`/hr/documents/${personalId}/link`);
    const linkPath = String(link.json.path ?? '');
    check(
      'documents: the employee gets a short-lived link',
      link.status === 200 && linkPath.startsWith('/hr/files/') && typeof link.json.expiresAt === 'string',
      link.json,
    );
    const anonymous = ctx.makeClient(ctx.base);
    const followed = await anonymous.getRaw(linkPath);
    check(
      'documents: following it (no session needed) serves the PDF',
      followed.status === 200 && (followed.headers.get('content-type') ?? '').startsWith('application/pdf'),
      { status: followed.status, type: followed.headers.get('content-type') },
    );
    check('documents: byte for byte', followed.body.equals(MINIMAL_PDF), followed.body.length);
    check(
      'documents: as an attachment under its original name',
      (followed.headers.get('content-disposition') ?? '').includes("filename*=UTF-8''Offer%20letter%20%E2%80%93%20Alice.pdf"),
      followed.headers.get('content-disposition'),
    );

    const bobCompanyLink = await bob.client.post(`/hr/documents/${companyId}/link`);
    const bobCompanyFile = await anonymous.getRaw(String(bobCompanyLink.json.path ?? '/hr/files/none'));
    check(
      'documents: another employee can open the company-wide document',
      bobCompanyLink.status === 200 && bobCompanyFile.status === 200 && bobCompanyFile.body.equals(MINIMAL_PDF),
      { link: bobCompanyLink.status, file: bobCompanyFile.status },
    );
    const crossLink = await alice.client.post(`/hr/documents/${bobPngId}/link`);
    check("documents: another employee's personal document is 404 to link", crossLink.status === 404, crossLink.json);
    const missingLink = await alice.client.post('/hr/documents/99999999/link');
    check('documents: an unknown document is 404', missingLink.status === 404, missingLink.json);

    const garbage = await anonymous.getRaw('/hr/files/not-a-token');
    check('documents: a garbage token is 404', garbage.status === 404, garbage.status);
    const jwt = (await import('jsonwebtoken')).default;
    const past = Math.floor(Date.now() / 1000) - 600;
    const expired = jwt.sign(
      { sub: String(alice.id), kind: 'document', id: personalId, iat: past - 300, exp: past },
      process.env.JWT_SECRET ?? '',
      { issuer: 'jmk-api', audience: 'jmk-hr-file' },
    );
    const expiredFile = await anonymous.getRaw(`/hr/files/${expired}`);
    check('documents: an expired token is 404', expiredFile.status === 404, expiredFile.status);
    const forged = jwt.sign({ sub: String(alice.id), kind: 'document', id: bobPngId }, process.env.JWT_SECRET ?? '', {
      issuer: 'jmk-api',
      audience: 'jmk-hr-file',
      expiresIn: 300,
    });
    const forgedFile = await anonymous.getRaw(`/hr/files/${forged}`);
    check(
      "documents: even a valid token for somebody else's document is 404 when followed",
      forgedFile.status === 404,
      forgedFile.status,
    );

    // Admin portal
    const adminList = await adminAsBearer.get(`/admin/hr/documents?userId=${alice.id}&scope=personal`);
    check(
      "documents: the admin lists one employee's personal documents",
      adminList.status === 200 &&
        adminList.json.total === 2 &&
        (adminList.json.items ?? []).every((item: Json) => item.userId === alice.id && item.employeeName === 'Req Alice'),
      adminList.json,
    );
    const adminSearch = await adminAsBearer.get('/admin/hr/documents?scope=company&q=handbook');
    check(
      'documents: and searches company-wide ones',
      adminSearch.status === 200 && (adminSearch.json.items ?? []).some((item: Json) => Number(item.id) === companyId),
      adminSearch.json,
    );
    const supervisorList = await supervisor.client.get('/admin/hr/documents');
    check('documents: a supervisor may list', supervisorList.status === 200, supervisorList.json);
    const adminDownload = await adminAsBearer.getRaw(`/admin/hr/documents/${bobPngId}/download`);
    check(
      'documents: the admin download serves the bytes with the verified type',
      adminDownload.status === 200 &&
        adminDownload.body.equals(MINIMAL_PNG) &&
        (adminDownload.headers.get('content-type') ?? '').startsWith('image/png'),
      { status: adminDownload.status, type: adminDownload.headers.get('content-type') },
    );
    const downloadAudit = await rows(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_document_downloaded' AND entity_id = ?",
      [bobPngId],
    );
    check('documents: and the access is audited', Number(downloadAudit[0]?.c) === 1, downloadAudit);
    const hrTokenDownload = await alice.client.getRaw(`/admin/hr/documents/${personalId}/download`);
    check('documents: an HR app token cannot use the admin download (401)', hrTokenDownload.status === 401, hrTokenDownload.status);

    // Removal: a link minted before the removal stops working.
    const staleLink = await alice.client.post(`/hr/documents/${personalId}/link`);
    const supervisorDelete = await supervisor.client.del(`/admin/hr/documents/${personalId}`);
    check('documents: a supervisor may not remove (403)', supervisorDelete.status === 403, supervisorDelete.json);
    const removed = await adminAsBearer.del(`/admin/hr/documents/${personalId}`);
    check(
      'documents: the admin removes a document',
      removed.status === 200 && Number(removed.json.document?.id) === personalId,
      removed.json,
    );
    const softRow = (await rows('SELECT deleted_at FROM hr_documents WHERE id = ?', [personalId]))[0];
    check('documents: as a soft delete (the row stays, marked removed)', softRow?.deleted_at != null, softRow);
    const staleFollow = await anonymous.getRaw(String(staleLink.json.path ?? '/hr/files/none'));
    check('documents: a link minted before the removal is now 404', staleLink.status === 200 && staleFollow.status === 404, {
      link: staleLink.status,
      follow: staleFollow.status,
    });
    const relink = await alice.client.post(`/hr/documents/${personalId}/link`);
    check('documents: and no new link can be minted', relink.status === 404, relink.json);
    const listAfter = await alice.client.get('/hr/documents?scope=personal');
    check(
      'documents: it is gone from the employee list',
      listAfter.status === 200 && !(listAfter.json.items ?? []).some((item: Json) => Number(item.id) === personalId),
      listAfter.json.items,
    );
    const adminAfter = await adminAsBearer.getRaw(`/admin/hr/documents/${personalId}/download`);
    const removeAgain = await adminAsBearer.del(`/admin/hr/documents/${personalId}`);
    check(
      'documents: and from the admin download; removing it again is 404',
      adminAfter.status === 404 && removeAgain.status === 404,
      [adminAfter.status, removeAgain.status],
    );

    /* -------------------------------------------------------- announcements */
    const carol = await ctx.createSignedInHrEmployee({ name: 'Req Carol', email: 'req.carol@example.test' });
    const dave = await ctx.createSignedInHrEmployee({ name: 'Req Dave', email: 'req.dave@example.test' });
    const [departmentInsert] = (await utcDb.query(
      "INSERT INTO hr_departments (name, code) VALUES ('Requests Test Department', 'RQT')",
    )) as unknown as [{ insertId: number }];
    const departmentId = Number(departmentInsert?.insertId ?? 0);
    await utcDb.query('UPDATE hr_users SET department_id = ? WHERE id IN (?, ?)', [departmentId, carol.id, dave.id]);

    const aliceAnnouncementsBefore = (await notices(alice.id, 'announcement')).length;
    const broadcast = await adminAsBearer.post('/admin/hr/notifications/broadcast', {
      title: 'Team lunch on Friday',
      body: 'Lunch is at 1 pm in the cafeteria.',
      departmentId,
    });
    check(
      'announcements: a department broadcast reaches exactly its members',
      broadcast.status === 200 && broadcast.json.recipients === 2,
      broadcast.json,
    );
    const carolGot = await notices(carol.id, 'announcement');
    const daveGot = await notices(dave.id, 'announcement');
    check(
      'announcements: both members have it in their inbox',
      carolGot.length === 1 && daveGot.length === 1 && carolGot[0]?.title === 'Team lunch on Friday',
      { carolGot, daveGot },
    );
    check(
      'announcements: and nobody outside the department does',
      (await notices(alice.id, 'announcement')).length === aliceAnnouncementsBefore,
    );
    const carolInbox = await carol.client.get('/hr/notifications?pageSize=5');
    check(
      'announcements: the member reads it through the app inbox',
      carolInbox.status === 200 && (carolInbox.json.items ?? []).some((item: Json) => item.kind === 'announcement'),
      carolInbox.json,
    );
    const broadcastAudit = await rows("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'hr_announcement_sent'");
    check('announcements: the broadcast is audited', Number(broadcastAudit[0]?.c) >= 1, broadcastAudit);
    const noDepartment = await adminAsBearer.post('/admin/hr/notifications/broadcast', {
      title: 'To nowhere',
      departmentId: 99999999,
    });
    check(
      'announcements: an unknown department is refused on departmentId',
      noDepartment.status === 400 && typeof noDepartment.json.errors?.departmentId === 'string',
      noDepartment.json,
    );
    const shortTitle = await adminAsBearer.post('/admin/hr/notifications/broadcast', { title: 'Hi', departmentId });
    check('announcements: a title under 3 characters is refused', shortTitle.status === 422, shortTitle.json);
    const supervisorBroadcast = await supervisor.client.post('/admin/hr/notifications/broadcast', {
      title: 'From a supervisor',
      departmentId,
    });
    check('announcements: a supervisor may not broadcast (403)', supervisorBroadcast.status === 403, supervisorBroadcast.json);
    check(
      'announcements: and the refused broadcasts wrote nothing',
      (await notices(carol.id, 'announcement')).length === 1,
    );

    /* -------------------------------------------------------- the HR inbox */
    const inboxTotal = Number(
      (await rows('SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ?', [alice.id]))[0]?.c ?? -1,
    );
    const inbox1 = await alice.client.get('/hr/notifications?page=1&pageSize=2');
    const inbox2 = await alice.client.get('/hr/notifications?page=2&pageSize=2');
    const inboxIds = [...(inbox1.json.items ?? []), ...(inbox2.json.items ?? [])].map((item: Json) => Number(item.id));
    check(
      'inbox: notifications paginate with a true total, newest first, no overlap',
      inbox1.status === 200 &&
        inbox1.json.total === inboxTotal &&
        inboxTotal >= 4 &&
        inbox1.json.items?.length === 2 &&
        inbox2.json.items?.length === 2 &&
        new Set(inboxIds).size === 4 &&
        Number(inbox1.json.items?.[0]?.id) > Number(inbox1.json.items?.[1]?.id),
      { total: inbox1.json.total, inboxTotal, inboxIds },
    );
    const unreadBefore = Number(inbox1.json.unread ?? -1);
    const firstId = Number(inbox1.json.items?.[0]?.id ?? 0);
    const markOne = await alice.client.post('/hr/notifications/read', { ids: [firstId, 99999999] });
    check(
      'inbox: marking one read changes exactly that one',
      markOne.status === 200 && markOne.json.changed === 1 && markOne.json.unread === unreadBefore - 1,
      { markOne: markOne.json, unreadBefore },
    );
    const markBobs = await bob.client.post('/hr/notifications/read', { ids: [firstId] });
    check("inbox: nobody can mark another person's notification", markBobs.status === 200 && markBobs.json.changed === 0, markBobs.json);
    const markAll = await alice.client.post('/hr/notifications/read-all');
    const unreadNow = await alice.client.get('/hr/notifications/unread-count');
    const unreadList = await alice.client.get('/hr/notifications?unreadOnly=true');
    check(
      'inbox: read-all clears the badge',
      markAll.status === 200 &&
        markAll.json.changed === unreadBefore - 1 &&
        unreadNow.json.unread === 0 &&
        unreadList.json.total === 0,
      { markAll: markAll.json, unread: unreadNow.json, list: unreadList.json.total },
    );
  } finally {
    /*
     * Remove what this section stored. Rows go with the scratch database; the FILES
     * would outlive it (local driver: UPLOAD_DIR/hr-documents/…), so they are deleted
     * here even when a check above failed or threw.
     */
    try {
      const keys = storedIds.length
        ? await rows(`SELECT storage_key FROM hr_documents WHERE id IN (${storedIds.map(() => '?').join(',')})`, storedIds)
        : [];
      const { deleteHrDocument, hrDocumentStorageReport } = await import('../../src/services/storage/hrDocuments');
      const report = hrDocumentStorageReport();
      const fs = await import('node:fs');
      const path = await import('node:path');
      let present = 0;
      for (const row of keys) {
        const key = String(row.storage_key ?? '');
        if (report.driver === 'local' && fs.existsSync(path.join(report.directory, '..', ...key.split('/')))) present += 1;
        await deleteHrDocument(key);
      }
      if (report.driver === 'local') {
        check('documents: every stored file was on disk under UPLOAD_DIR/hr-documents', present === keys.length, {
          present,
          stored: keys.length,
        });
        const gone = keys.every(
          (row) => !fs.existsSync(path.join(report.directory, '..', ...String(row.storage_key ?? '').split('/'))),
        );
        check('documents: and the files this run stored are cleaned up', gone);
      }
    } catch (error) {
      check('documents: stored files could be cleaned up', false, String(error));
    }
  }
}
