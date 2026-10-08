import type { SqlParam } from '../../src/db/pool';
import type { ApiResponse, Client, E2EContext, Json } from './context';

/**
 * Importing leads from a spreadsheet: the template, preview, batched commit and cancel.
 *
 * Owned by the import feature (key `import`). Runs last; the rules every section follows
 * are in `context.ts`.
 *
 * FIXTURES. Everything here is its own: employees `imp.*@example.test` with codes
 * `IM-####`, and lead numbers in the 73xxxxxxxx range — 731… for the file checks, 732…
 * for mapping and validation, 733… for commits — so nothing collides with another
 * section's leads, and assertions are made on this section's own rows and deltas.
 *
 * THE PREVIEW LIMITER IS REAL HERE. It is keyed per employee (30 files per ten minutes by
 * default) and this harness does not lift it, so the groups below each use their own
 * manager and stay well under the budget — and the last group proves the limit, and that
 * it is per person, by exhausting one manager's budget on purpose.
 */

/** A JSON column's value: parsed by MySQL, text from MariaDB. */
function jsonColumn(value: unknown): Json | null {
  if (value && typeof value === 'object') return value as Json;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const IMPORTS = '/admin/telecalling/lead-imports';

type Upload = { name: string; bytes: Buffer | string; type?: string };

function form(file: Upload | null, fields: Record<string, string> = {}): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  if (file) {
    const bytes = typeof file.bytes === 'string' ? Buffer.from(file.bytes, 'utf8') : file.bytes;
    body.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: file.type ?? 'application/octet-stream' }),
      file.name,
    );
  }
  return body;
}

function upload(client: Client, file: Upload | null, fields: Record<string, string> = {}): Promise<ApiResponse> {
  return client.callForm('POST', IMPORTS, form(file, fields));
}

function csv(lines: string[]): Upload {
  return { name: 'leads.csv', bytes: `${lines.join('\r\n')}\r\n`, type: 'text/csv' };
}

/** The row with this sheet row number, from a response's `rows`. */
function rowAt(response: ApiResponse, sheetRow: number): Json | undefined {
  const rows = (response.json.rows ?? []) as Json[];
  return rows.find((row) => row?.sheetRow === sheetRow);
}

export async function run(ctx: E2EContext): Promise<void> {
  const { check, db, base, makeClient, adminAsBearer } = ctx;
  const XLSX = await import('xlsx');

  /* ------------------------------------------------------------------ helpers */

  async function scalar(sql: string, params: SqlParam[] = []): Promise<number> {
    const [rows] = (await db.query(sql, params)) as [Json[], unknown];
    return Number(rows[0]?.n ?? 0);
  }

  async function rowsOf(sql: string, params: SqlParam[] = []): Promise<Json[]> {
    const [rows] = (await db.query(sql, params)) as [Json[], unknown];
    return rows;
  }

  function workbook(sheets: { name: string; rows: unknown[][]; hidden?: boolean; patch?: (sheet: Json) => void }[], bookType: 'xlsx' | 'biff8' | 'ods' = 'xlsx'): Buffer {
    const book = XLSX.utils.book_new();
    for (const sheet of sheets) {
      const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
      sheet.patch?.(worksheet as Json);
      XLSX.utils.book_append_sheet(book, worksheet, sheet.name);
    }
    book.Workbook = { Sheets: sheets.map((sheet) => ({ Hidden: sheet.hidden ? 1 : 0 })) };
    return XLSX.write(book, { type: 'buffer', bookType }) as Buffer;
  }

  function xlsx(rows: unknown[][], patch?: (sheet: Json) => void): Upload {
    return { name: 'leads.xlsx', bytes: workbook([{ name: 'Leads', rows, patch }]) };
  }

  async function commitAll(client: Client, id: number, batchSize: number): Promise<ApiResponse[]> {
    const calls: ApiResponse[] = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await client.post(`${IMPORTS}/${id}/commit`, { batchSize });
      calls.push(response);
      if (response.status === 409 && response.json.code === 'import_busy') {
        await sleep(250);
        continue;
      }
      if (response.status !== 200 || response.json.done === true) break;
    }
    return calls;
  }

  const numbers = (prefix: string, from: number, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(from + index).padStart(10 - prefix.length, '0')}`);

  /* ----------------------------------------------------------------- fixtures */
  console.log('\nlead import — fixtures');

  const mona = await ctx.createSignedInEmployee({ name: 'Mona Manager', email: 'imp.mona@example.test', role: 'manager' });
  const maya = await ctx.createSignedInEmployee({ name: 'Maya Manager', email: 'imp.maya@example.test', role: 'manager' });
  const mohan = await ctx.createSignedInEmployee({ name: 'Mohan Manager', email: 'imp.mohan@example.test', role: 'manager' });
  const sid = await ctx.createSignedInEmployee({ name: 'Sid Supervisor', email: 'imp.sid@example.test', role: 'supervisor' });
  const tina = await ctx.createSignedInEmployee({ name: 'Tina Telecaller', email: 'imp.tina@example.test', role: 'telecaller', code: 'IM-0001' });
  const tara = await ctx.createSignedInEmployee({ name: 'Tara Telecaller', email: 'imp.tara@example.test', role: 'telecaller', code: 'IM-0002' });
  await ctx.createSignedInEmployee({ name: 'Imran Shah', email: 'imp.imran1@example.test', role: 'telecaller', code: 'IM-0003' });
  await ctx.createSignedInEmployee({ name: 'Imran Shah', email: 'imp.imran2@example.test', role: 'telecaller', code: 'IM-0004' });
  const dina = await ctx.createSignedInEmployee({ name: 'Dina Telecaller', email: 'imp.dina@example.test', role: 'telecaller', code: 'IM-0005' });
  // A colleague who has left: on file, but no longer able to take leads.
  const gone = await ctx.createSignedInEmployee({ name: 'Gopal Gone', email: 'imp.gone@example.test', role: 'telecaller', code: 'IM-0006' });
  await db.query('UPDATE telecaller_users SET is_active = 0 WHERE id = ?', [gone.id]);
  check('lead import fixtures are signed in', mona.id > 0 && maya.id > 0 && mohan.id > 0 && tina.id > 0 && gone.id > 0);

  /* =================================================== A. gates, template, files */
  console.log('\nlead import — role gates');

  const sideEffectsBefore = {
    leads: await scalar('SELECT COUNT(*) AS n FROM leads'),
    activities: await scalar('SELECT COUNT(*) AS n FROM lead_activities'),
    notifications: await scalar('SELECT COUNT(*) AS n FROM notifications'),
    audits: await scalar('SELECT COUNT(*) AS n FROM audit_logs'),
    imports: await scalar('SELECT COUNT(*) AS n FROM lead_imports'),
  };

  const gateFile = csv(['Customer name,Phone', 'Gate Person,7310000001']);

  const asTelecaller = await upload(tina.client, gateFile);
  check('a telecaller cannot check an import file (403)', asTelecaller.status === 403, asTelecaller.status);
  const asSupervisor = await upload(sid.client, gateFile);
  check('a supervisor cannot either — import is manager and above (403)', asSupervisor.status === 403, asSupervisor.status);
  const anonymous = await upload(makeClient(base), gateFile);
  check('an unauthenticated upload is refused (401)', anonymous.status === 401, anonymous.status);

  const asManager = await upload(mona.client, gateFile);
  check('a manager can check a file (201)', asManager.status === 201, asManager.json);
  const gateImport = (asManager.json.import ?? {}) as Json;
  check(
    'the preview is a ready draft with one row, nothing imported yet',
    gateImport.state === 'ready' &&
      gateImport.totals?.rows === 1 &&
      gateImport.progress?.pending === 1 &&
      gateImport.progress?.created === 0 &&
      gateImport.fileKind === 'csv',
    gateImport,
  );
  check(
    'the preview carries the first page of rows and the page facts',
    Array.isArray(asManager.json.rows) &&
      asManager.json.rows.length === 1 &&
      asManager.json.rowsPage?.page === 1 &&
      asManager.json.rowsPage?.pageSize === 50 &&
      asManager.json.rowsPage?.total === 1 &&
      asManager.json.rowsPage?.totalPages === 1,
    asManager.json.rowsPage,
  );
  check(
    'the default assignee is an explicit "nobody" and the default source is Manual entry',
    gateImport.defaults?.assignedTo === null && gateImport.defaults?.source === 'manual' && gateImport.defaults?.status === 'new',
    gateImport.defaults,
  );
  const gateImportId = Number(gateImport.id ?? 0);

  const gates = await Promise.all([
    sid.client.get(IMPORTS),
    sid.client.get(`${IMPORTS}/${gateImportId}`),
    sid.client.post(`${IMPORTS}/${gateImportId}/commit`, {}),
    sid.client.post(`${IMPORTS}/${gateImportId}/cancel`),
    tina.client.get(`${IMPORTS}/${gateImportId}`),
  ]);
  check(
    'listing, reading, committing and cancelling are manager-only too',
    gates.every((response) => response.status === 403),
    gates.map((response) => response.status),
  );

  console.log('\nlead import — template');

  const templateAsSupervisor = await sid.client.getRaw(`${IMPORTS}/template`);
  check('a supervisor cannot download the template (403)', templateAsSupervisor.status === 403, templateAsSupervisor.status);

  const template = await mona.client.getRaw(`${IMPORTS}/template`);
  check('a manager downloads the template', template.status === 200, template.status);
  check(
    'it is an .xlsx attachment that is never cached',
    (template.headers.get('content-type') ?? '').includes('spreadsheetml.sheet') &&
      (template.headers.get('content-disposition') ?? '').includes('attachment') &&
      (template.headers.get('content-disposition') ?? '').includes('.xlsx') &&
      (template.headers.get('cache-control') ?? '').includes('no-store') &&
      template.headers.get('x-content-type-options') === 'nosniff',
    Object.fromEntries(template.headers.entries()),
  );
  check('the body is a ZIP (an .xlsx starts PK)', template.body.subarray(0, 2).toString('latin1') === 'PK');

  const templateBook = XLSX.read(template.body, { type: 'buffer', cellNF: true });
  const templateHeaders = (XLSX.utils.sheet_to_json(templateBook.Sheets.Leads ?? {}, { header: 1 })[0] ?? []) as unknown[];
  check(
    'the template has a Leads sheet with the headings and a How to fill sheet',
    templateBook.SheetNames.includes('Leads') &&
      templateBook.SheetNames.includes('How to fill') &&
      JSON.stringify(templateHeaders) ===
        JSON.stringify(['Customer name', 'Phone', 'Alternate phone', 'Email', 'City', 'Address', 'Source', 'Product interest', 'Status', 'Assigned to', 'Notes']),
    { sheets: templateBook.SheetNames, templateHeaders },
  );
  check(
    'the Phone and Alternate phone cells are pre-formatted as Text',
    (templateBook.Sheets.Leads?.B2 as Json | undefined)?.z === '@' &&
      (templateBook.Sheets.Leads?.C2001 as Json | undefined)?.z === '@',
    [templateBook.Sheets.Leads?.B2, templateBook.Sheets.Leads?.C2001],
  );
  const guideText = XLSX.utils.sheet_to_csv(templateBook.Sheets['How to fill'] ?? {});
  check(
    'How to fill lists the active sources (incoming_call included) and the status labels',
    guideText.includes('incoming_call') &&
      guideText.includes('Manual entry') &&
      guideText.includes('Follow-up required') &&
      guideText.includes('Walked in'),
    guideText.slice(0, 400),
  );

  const untouched = await upload(mona.client, { name: 'jmk-lead-import-template.xlsx', bytes: template.body });
  check(
    'the untouched template is refused: it has no rows',
    untouched.status === 400 && untouched.json.errors?.file === 'The file has no rows to import.',
    untouched.json,
  );

  console.log('\nlead import — files that are refused');

  const sample = workbook([{ name: 'Leads', rows: [['Customer name', 'Phone'], ['Sample', '7310000002']] }]);
  const refused: { label: string; response: ApiResponse; mention?: string }[] = [];

  refused.push({ label: 'no file', response: await upload(mona.client, null, { defaultStatus: 'new' }), mention: 'Choose a file' });
  refused.push({ label: 'a .txt file', response: await upload(mona.client, { name: 'leads.txt', bytes: 'Customer name,Phone\r\nA,7310000003\r\n' }) });
  refused.push({
    label: 'random bytes named .xlsx',
    response: await upload(mona.client, { name: 'leads.xlsx', bytes: Buffer.alloc(3000, 0x41) }),
    mention: 'not a valid Excel workbook',
  });
  refused.push({
    label: 'an OpenDocument sheet renamed .xlsx',
    response: await upload(mona.client, { name: 'leads.xlsx', bytes: workbook([{ name: 'Leads', rows: [['Customer name', 'Phone'], ['A', '7310000004']] }], 'ods') }),
    mention: 'not an Excel workbook',
  });
  refused.push({
    label: 'a workbook cut off half way',
    response: await upload(mona.client, { name: 'leads.xlsx', bytes: sample.subarray(0, Math.floor(sample.length / 2)) }),
    mention: 'damaged',
  });
  refused.push({
    label: 'random bytes named .xls',
    response: await upload(mona.client, { name: 'leads.xls', bytes: Buffer.alloc(3000, 0x41) }),
  });
  refused.push({
    label: 'a web page named .xls',
    response: await upload(mona.client, { name: 'export.xls', bytes: '<html><body><table><tr><td>A</td></tr></table></body></html>' }),
    mention: 'web page',
  });
  refused.push({
    label: 'an encrypted (password-protected) workbook',
    response: await upload(mona.client, {
      name: 'secret.xlsx',
      bytes: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(2000, 0)]),
    }),
    mention: 'password-protected',
  });

  const oversized = await upload(mona.client, { name: 'huge.csv', bytes: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), type: 'text/csv' });
  refused.push({ label: 'a CSV one byte over 5 MB', response: oversized, mention: '5 MB' });

  for (const { label, response, mention } of refused) {
    check(
      `refused with 400 on the file field: ${label}`,
      response.status === 400 &&
        typeof response.json.errors?.file === 'string' &&
        (mention === undefined || String(response.json.errors.file).includes(mention)),
      { status: response.status, json: response.json },
    );
  }
  check(
    'the oversized upload is not reported against the resume field',
    oversized.json.errors?.resume === undefined,
    oversized.json,
  );

  // A zip bomb's honest form: the central directory declares a 2 GB worksheet.
  const bomb = Buffer.from(sample);
  for (let pointer = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); pointer !== -1; pointer = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), pointer + 4)) {
    const nameLength = bomb.readUInt16LE(pointer + 28);
    if (bomb.toString('latin1', pointer + 46, pointer + 46 + nameLength) === 'xl/worksheets/sheet1.xml') {
      bomb.writeUInt32LE(0x7ffffff0, pointer + 24);
    }
  }
  const bombStarted = Date.now();
  const bombResponse = await upload(mona.client, { name: 'bomb.xlsx', bytes: bomb });
  const bombMs = Date.now() - bombStarted;
  check(
    'a workbook declaring a 2 GB sheet is refused before it is unpacked, quickly',
    bombResponse.status === 400 && String(bombResponse.json.errors?.file ?? '').includes('too large') && bombMs < 2000,
    { status: bombResponse.status, ms: bombMs, json: bombResponse.json },
  );
  const health = await makeClient(base).get('/health');
  check('and the API is still up afterwards', health.status === 200, health.status);

  console.log('\nlead import — limits');

  const header = 'Customer name,Phone';
  const bulk = (count: number) => [header, ...numbers('731', 100_000, count).map((phone, index) => `Bulk Person ${index + 1},${phone}`)];

  const tooMany = await upload(mona.client, csv(bulk(2001)));
  check(
    '2,001 data rows are refused, not truncated',
    tooMany.status === 400 && String(tooMany.json.errors?.file ?? '').includes('more than 2,000 rows'),
    tooMany.json,
  );

  const atLimit = await upload(mona.client, csv(bulk(2000)));
  check(
    'exactly 2,000 rows are accepted',
    atLimit.status === 201 && atLimit.json.import?.totals?.rows === 2000 && atLimit.json.import?.totals?.ready === 2000,
    atLimit.status === 201 ? atLimit.json.import?.totals : atLimit.json,
  );
  check(
    'and only the first page of 50 rows comes back with the preview',
    atLimit.json.rows?.length === 50 && atLimit.json.rowsPage?.total === 2000 && atLimit.json.rowsPage?.totalPages === 40,
    atLimit.json.rowsPage,
  );
  const bigImportId = Number(atLimit.json.import?.id ?? 0);

  const pageTwo = await mona.client.get(`${IMPORTS}/${bigImportId}?page=2`);
  check(
    'page 2 of the rows starts at the 51st data row (sheet row 52)',
    pageTwo.status === 200 && pageTwo.json.rows?.[0]?.sheetRow === 52 && pageTwo.json.rows?.length === 50 && pageTwo.json.rowsPage?.page === 2,
    { status: pageTwo.status, first: pageTwo.json.rows?.[0]?.sheetRow, page: pageTwo.json.rowsPage },
  );
  const widePage = await mona.client.get(`${IMPORTS}/${bigImportId}?pageSize=100&page=3`);
  check(
    'a page of 100 is allowed',
    widePage.status === 200 && widePage.json.rows?.length === 100 && widePage.json.rows?.[0]?.sheetRow === 202,
    { status: widePage.status, first: widePage.json.rows?.[0]?.sheetRow },
  );
  const tooWide = await mona.client.get(`${IMPORTS}/${bigImportId}?pageSize=101`);
  check('a page larger than 100 is refused (422)', tooWide.status === 422, tooWide.status);
  const pastEnd = await mona.client.get(`${IMPORTS}/${bigImportId}?page=900`);
  check(
    'a page past the end answers with the last page rather than nothing',
    pastEnd.status === 200 && pastEnd.json.rowsPage?.page === 40 && pastEnd.json.rows?.length === 50,
    pastEnd.json.rowsPage,
  );

  const wide = Array.from({ length: 61 }, (_, index) => (index === 0 ? 'Customer name' : index === 1 ? 'Phone' : `Extra ${index}`));
  const tooWideFile = await upload(mona.client, csv([wide.join(','), wide.map((_, index) => (index === 0 ? 'Wide' : index === 1 ? '7310000005' : 'x')).join(',')]));
  check(
    'a file with 61 columns is refused',
    tooWideFile.status === 400 && String(tooWideFile.json.errors?.file ?? '').includes('60'),
    tooWideFile.json,
  );

  const unclosed = await upload(mona.client, csv([header, 'Fine Row,7310000006', '"Broken Row,7310000007', 'Next Row,7310000008']));
  check(
    'an unclosed quote is refused, naming the row',
    unclosed.status === 400 && String(unclosed.json.errors?.file ?? '').includes('row 3'),
    unclosed.json,
  );

  const sideEffectsAfter = {
    leads: await scalar('SELECT COUNT(*) AS n FROM leads'),
    activities: await scalar('SELECT COUNT(*) AS n FROM lead_activities'),
    notifications: await scalar('SELECT COUNT(*) AS n FROM notifications'),
    audits: await scalar('SELECT COUNT(*) AS n FROM audit_logs'),
    imports: await scalar('SELECT COUNT(*) AS n FROM lead_imports'),
  };
  check(
    'checking files writes no lead, activity, notification or audit row',
    sideEffectsAfter.leads === sideEffectsBefore.leads &&
      sideEffectsAfter.activities === sideEffectsBefore.activities &&
      sideEffectsAfter.notifications === sideEffectsBefore.notifications &&
      sideEffectsAfter.audits === sideEffectsBefore.audits,
    { before: sideEffectsBefore, after: sideEffectsAfter },
  );
  check(
    'only the import tables gained rows',
    sideEffectsAfter.imports > sideEffectsBefore.imports &&
      (await scalar('SELECT COUNT(*) AS n FROM lead_import_rows WHERE import_id = ?', [bigImportId])) === 2000,
    sideEffectsAfter,
  );

  /* =============================================== B. mapping, rows, duplicates */
  console.log('\nlead import — header mapping');

  const mappingRows = [
    ['CUSTOMER NAME', 'Mobile No.', 'E-mail', 'Lead Source', 'Status', 'Assigned To', 'Interested in', 'Budget'],
    ['Mapped Person', '7320000001', 'Mapped@Example.test', 'Referral', 'Interested', 'IM-0001', 'Course A', '5 lakh'],
  ];
  const mapped = await upload(maya.client, xlsx(mappingRows));
  const mappedFields = ((mapped.json.columns ?? []) as Json[]).map((column) => column?.field ?? null);
  check(
    'headers are matched whatever their case and punctuation',
    mapped.status === 201 &&
      JSON.stringify(mappedFields) ===
        JSON.stringify(['customerName', 'phone', 'email', 'source', 'status', 'assignedTo', 'productInterest', null]),
    { status: mapped.status, mappedFields, json: mapped.status === 201 ? undefined : mapped.json },
  );
  check(
    'name and phone columns are marked required, and matched by alias',
    mapped.json.columns?.[0]?.required === true &&
      mapped.json.columns?.[1]?.required === true &&
      mapped.json.columns?.[2]?.required === false &&
      mapped.json.columns?.[0]?.matchedBy === 'alias' &&
      mapped.json.columns?.[1]?.letter === 'B',
    mapped.json.columns,
  );
  check(
    'an unmatched column is named in the notices',
    ((mapped.json.notices ?? []) as string[]).some((notice) => notice.includes('Budget')),
    mapped.json.notices,
  );
  const mappedRow = rowAt(mapped, 2);
  check(
    'the row is read through the mapping: label source, label status, code assignee',
    mappedRow?.outcome === 'ready' &&
      mappedRow?.values?.source === 'referral' &&
      mappedRow?.values?.status === 'interested' &&
      mappedRow?.values?.assignedTo === tina.id &&
      mappedRow?.values?.assignedToName === 'Tina Telecaller' &&
      mappedRow?.values?.email === 'mapped@example.test' &&
      mappedRow?.values?.productInterest === 'Course A',
    mappedRow,
  );

  const noPhone = await upload(maya.client, xlsx([['Customer name', 'City'], ['No Phone', 'Pune']]));
  check(
    'a sheet without a phone column is refused, naming the column',
    noPhone.status === 400 && String(noPhone.json.errors?.file ?? '').includes('no Phone column'),
    noPhone.json,
  );

  const overridden = await upload(maya.client, xlsx(mappingRows), { columnMap: JSON.stringify({ 7: 'summaryNote' }) });
  check(
    'a manual column choice maps Budget into the notes',
    overridden.status === 201 &&
      overridden.json.columns?.[7]?.field === 'summaryNote' &&
      overridden.json.columns?.[7]?.matchedBy === 'manual' &&
      rowAt(overridden, 2)?.values?.summaryNote === '5 lakh',
    { status: overridden.status, column: overridden.json.columns?.[7], row: rowAt(overridden, 2) },
  );

  const twoPhones = await upload(maya.client, xlsx(mappingRows), { columnMap: JSON.stringify({ 1: 'phone', 2: 'phone' }) });
  check(
    'two columns chosen as Phone are refused (422 on columnMap)',
    twoPhones.status === 422 && typeof twoPhones.json.errors?.columnMap === 'string',
    twoPhones.json,
  );

  const missingColumn = await upload(maya.client, xlsx(mappingRows), { columnMap: JSON.stringify({ 20: 'city' }) });
  check(
    'a column choice for a column the file does not have is refused (422)',
    missingColumn.status === 422 && String(missingColumn.json.errors?.columnMap ?? '').includes('U'),
    missingColumn.json,
  );

  const inactiveDefault = await upload(maya.client, xlsx(mappingRows), { defaultAssignedTo: String(gone.id) });
  check(
    'a deactivated default assignee is refused (422)',
    inactiveDefault.status === 422 && inactiveDefault.json.errors?.defaultAssignedTo === 'Choose an active employee.',
    inactiveDefault.json,
  );
  const unknownSource = await upload(maya.client, xlsx(mappingRows), { defaultSource: 'no_such_source' });
  check(
    'an unknown default source is refused (422)',
    unknownSource.status === 422 && typeof unknownSource.json.errors?.defaultSource === 'string',
    unknownSource.json,
  );

  console.log('\nlead import — row validation');

  const validationRows: unknown[][] = [
    ['Customer name', 'Phone', 'Email', 'Source', 'Status', 'Assigned to', 'Interested in'],
    ['Numeric Phone', 7320000101, '', '', '', '', ''],
    ['Sci Note', '7.32E+09', '', '', '', '', ''],
    ['Date Phone', 45000, '', '', '', '', ''],
    ['Callback Person', '7320000105', '', '', 'Callback requested', '', ''],
    ['Manual Label', '7320000106', '', 'Manual entry', '', '', ''],
    ['Billboard Source', '7320000107', '', 'Billboard', '', '', ''],
    ['Coded Assignee', '7320000108', '', '', '', 'IM-0001', ''],
    ['Deactivated Assignee', '7320000109', '', '', '', 'imp.gone@example.test', ''],
    ['NA Email', '7320000110', 'N/A', '', '', '', ''],
    ['', '7320000111', '', '', '', '', ''],
    ['Hot Status', '7320000112', '', '', 'Hot', '', ''],
    ['=HYPERLINK("http://x.test","y")', '7320000113', '', '', '', '', ''],
    ['Date Interest', '7320000114', '', '', '', '', 46302],
    ['Ambiguous Assignee', '7320000115', '', '', '', 'Imran Shah', ''],
    ['Unassigned Explicit', '7320000116', '', '', '', 'Unassigned', ''],
    ['Default Assignee', '7320000117', '', '', '', '', ''],
    ['Name Match', '7320000118', '', '', '', 'tina telecaller', ''],
    ['Two Numbers', '7320000119 / 7320000219', '', '', '', '', ''],
  ];
  const validation = await upload(
    maya.client,
    xlsx(validationRows, (sheet) => {
      // A phone cell and an "Interested in" cell that Excel holds as dates.
      if (sheet.B4) sheet.B4.z = 'yyyy-mm-dd';
      if (sheet.G14) sheet.G14.z = 'yyyy-mm-dd';
    }),
    { defaultAssignedTo: String(tara.id) },
  );
  check('the validation file is checked', validation.status === 201, validation.json);
  const validationImportId = Number(validation.json.import?.id ?? 0);
  const v = (sheetRow: number) => rowAt(validation, sheetRow);

  check(
    'a numeric phone cell is read digit for digit',
    v(2)?.outcome === 'ready' && v(2)?.values?.phone === '7320000101',
    v(2),
  );
  check(
    'a phone in scientific notation is refused as having lost digits',
    v(3)?.outcome === 'error' && String(v(3)?.errors?.phone ?? '').includes('scientific notation'),
    v(3),
  );
  check(
    'a phone cell formatted as a date is refused',
    v(4)?.outcome === 'error' && String(v(4)?.errors?.phone ?? '').includes('date'),
    v(4),
  );
  check(
    'the status label "Callback requested" is read as the slug, with a no-follow-up warning',
    v(5)?.outcome === 'warning' && v(5)?.values?.status === 'callback_requested' && typeof v(5)?.warnings?.status === 'string',
    v(5),
  );
  check('the source label "Manual entry" is read as manual, not other', v(6)?.values?.source === 'manual' && v(6)?.outcome === 'ready', v(6));
  check(
    'an unknown source warns and falls back to the default source',
    v(7)?.outcome === 'warning' && v(7)?.values?.source === 'manual' && String(v(7)?.warnings?.source ?? '').includes('Billboard'),
    v(7),
  );
  check(
    'an employee code assigns the row',
    v(8)?.values?.assignedTo === tina.id && v(8)?.values?.assignedToName === 'Tina Telecaller',
    v(8),
  );
  check(
    'a deactivated employee cannot be assigned',
    v(9)?.outcome === 'error' && String(v(9)?.errors?.assignedTo ?? '').includes('No active employee'),
    v(9),
  );
  check('"N/A" in the email column is an empty email, not an error', v(10)?.outcome === 'ready' && v(10)?.values?.email === null, v(10));
  check(
    'a missing name gets the lead form\'s own message',
    v(11)?.outcome === 'error' && v(11)?.errors?.customerName === 'Enter the customer name.',
    v(11),
  );
  check('an unknown status refuses the row', v(12)?.outcome === 'error' && String(v(12)?.errors?.status ?? '').includes('Hot'), v(12));
  check(
    'text that would run as a formula is refused',
    v(13)?.outcome === 'error' && String(v(13)?.errors?.customerName ?? '').includes('cannot start with'),
    v(13),
  );
  check(
    'a date cell in a text column becomes YYYY-MM-DD, with a warning',
    v(14)?.outcome === 'warning' && v(14)?.values?.productInterest === '2026-10-07' && typeof v(14)?.warnings?.productInterest === 'string',
    v(14),
  );
  check(
    'a name two employees share is refused as ambiguous',
    v(15)?.outcome === 'error' && String(v(15)?.errors?.assignedTo ?? '').includes('more than one employee'),
    v(15),
  );
  check('"Unassigned" overrides the default assignee', v(16)?.outcome === 'ready' && v(16)?.values?.assignedTo === null, v(16));
  check('an empty assignee takes the default', v(17)?.values?.assignedTo === tara.id && v(17)?.values?.assignedToName === 'Tara Telecaller', v(17));
  check('an exact name, in any case, assigns the row', v(18)?.values?.assignedTo === tina.id, v(18));
  check(
    'two numbers in one cell become phone and alternate phone, with a warning',
    v(19)?.outcome === 'warning' &&
      v(19)?.values?.phone === '7320000119' &&
      v(19)?.values?.alternatePhone === '7320000219' &&
      typeof v(19)?.warnings?.alternatePhone === 'string',
    v(19),
  );
  check(
    'raw cells come back only for rows that will not be imported',
    Array.isArray(v(3)?.raw) && v(3)?.raw?.[0] === 'Sci Note' && v(2)?.raw === null,
    { error: v(3)?.raw, ready: v(2)?.raw },
  );
  check(
    'the totals add up',
    validation.json.import?.totals?.rows === 18 &&
      validation.json.import?.totals?.errors === 7 &&
      validation.json.import?.totals?.warnings === 4 &&
      validation.json.import?.totals?.ready === 7 &&
      validation.json.import?.progress?.notImported === 7 &&
      validation.json.import?.progress?.pending === 11,
    validation.json.import,
  );

  const errorsOnly = await maya.client.get(`${IMPORTS}/${validationImportId}?outcome=error`);
  check(
    'rows can be filtered by outcome on the server',
    errorsOnly.status === 200 &&
      errorsOnly.json.rowsPage?.total === 7 &&
      ((errorsOnly.json.rows ?? []) as Json[]).every((row) => row?.outcome === 'error'),
    errorsOnly.json.rowsPage,
  );
  const several = await maya.client.get(`${IMPORTS}/${validationImportId}?outcome=error,warning&pageSize=5`);
  check(
    'several outcomes at once, paged',
    several.status === 200 && several.json.rowsPage?.total === 11 && several.json.rows?.length === 5 && several.json.rowsPage?.totalPages === 3,
    several.json.rowsPage,
  );
  const byState = await maya.client.get(`${IMPORTS}/${validationImportId}?state=not_imported`);
  check('and by state', byState.status === 200 && byState.json.rowsPage?.total === 7, byState.json.rowsPage);
  const badFilter = await maya.client.get(`${IMPORTS}/${validationImportId}?outcome=bogus`);
  check('an unknown outcome filter is refused (422)', badFilter.status === 422, badFilter.status);

  const fixCsv = await mona.client.getRaw(`${IMPORTS}/${validationImportId}/rows.csv`);
  const fixText = fixCsv.body.toString('utf8');
  check(
    'the rows to fix download as CSV: BOM, original columns plus Problem, only the refused rows',
    fixCsv.status === 200 &&
      (fixCsv.headers.get('content-type') ?? '').includes('text/csv') &&
      (fixCsv.headers.get('content-disposition') ?? '').includes('rows-to-fix.csv') &&
      fixText.startsWith('﻿Customer name,Phone,Email,Source,Status,Assigned to,Interested in,Problem') &&
      fixText.includes('Hot Status') &&
      fixText.includes('Unknown status') &&
      !fixText.includes('Numeric Phone') &&
      fixText.trim().split('\r\n').length === 8,
    fixText.slice(0, 600),
  );
  check(
    'and a value that would run as a formula is neutralised in it',
    fixText.includes("'=HYPERLINK") && !/(^|,)=HYPERLINK/m.test(fixText),
    fixText,
  );
  const fixAsSupervisor = await sid.client.getRaw(`${IMPORTS}/${validationImportId}/rows.csv`);
  check('a supervisor cannot download it (403)', fixAsSupervisor.status === 403, fixAsSupervisor.status);

  const mixedCalls = await commitAll(maya.client, validationImportId, 100);
  const mixedDone = mixedCalls[mixedCalls.length - 1]?.json.import ?? {};
  check(
    'committing a mixed file creates the ready and warning rows and leaves the rest',
    mixedDone.state === 'completed' &&
      mixedDone.progress?.created === 11 &&
      mixedDone.progress?.skipped === 0 &&
      mixedDone.progress?.failed === 0 &&
      mixedDone.progress?.notImported === 7,
    mixedDone.progress,
  );
  const callbackLead = (await rowsOf("SELECT id, status, assigned_to FROM leads WHERE phone = '7320000105'"))[0];
  check(
    'a row imported as "callback requested" keeps that status, and no follow-up is invented for it',
    callbackLead?.status === 'callback_requested' &&
      Number(callbackLead?.assigned_to) === tara.id &&
      (await scalar('SELECT COUNT(*) AS n FROM follow_ups WHERE lead_id = ?', [Number(callbackLead?.id ?? 0)])) === 0,
    callbackLead,
  );
  const createdOnly = await maya.client.get(`${IMPORTS}/${validationImportId}?state=created&pageSize=100`);
  check(
    'the created rows link to their leads; the refused rows stay as they were',
    createdOnly.json.rowsPage?.total === 11 &&
      ((createdOnly.json.rows ?? []) as Json[]).every((row) => typeof row?.leadReference === 'string' && row?.raw === null) &&
      (await scalar("SELECT COUNT(*) AS n FROM lead_import_rows WHERE import_id = ? AND state = 'not_imported'", [validationImportId])) === 7,
    createdOnly.json.rowsPage,
  );

  console.log('\nlead import — duplicates');

  const existingLead = await mohan.client.post('/admin/telecalling/leads', {
    customerName: 'Existing Deepa',
    phone: '7320000301',
    assignedTo: tina.id,
  });
  const archivedLead = await mohan.client.post('/admin/telecalling/leads', { customerName: 'Archived Arun', phone: '7320000302', assignedTo: null });
  const secondExisting = await mohan.client.post('/admin/telecalling/leads', { customerName: 'Existing Two', phone: '7320000306', assignedTo: null });
  check(
    'duplicate fixtures are created',
    existingLead.status === 201 && archivedLead.status === 201 && secondExisting.status === 201,
    [existingLead.json, archivedLead.json, secondExisting.json],
  );
  await db.query('UPDATE leads SET is_archived = 1 WHERE id = ?', [Number(archivedLead.json.lead?.id ?? 0)]);

  const duplicates = await upload(
    maya.client,
    csv(['Customer name,Phone', 'First Copy,+91 73200 00303', 'Other Person,7320000304', 'Second Copy,07320000303', 'Existing Number,73200 00301', 'Archived Number,7320000302']),
  );
  check('the duplicates file is checked', duplicates.status === 201, duplicates.json);
  check('the first copy of a number imports', rowAt(duplicates, 2)?.outcome === 'ready', rowAt(duplicates, 2));
  check(
    'a later copy in the same file is a duplicate of that row',
    rowAt(duplicates, 4)?.outcome === 'duplicate_in_file' &&
      rowAt(duplicates, 4)?.duplicateOf?.kind === 'row' &&
      rowAt(duplicates, 4)?.duplicateOf?.sheetRow === 2 &&
      rowAt(duplicates, 4)?.state === 'not_imported',
    rowAt(duplicates, 4),
  );
  check(
    'a number an active lead holds is a duplicate of that lead, named with its owner',
    rowAt(duplicates, 5)?.outcome === 'duplicate_existing' &&
      rowAt(duplicates, 5)?.duplicateOf?.kind === 'lead' &&
      rowAt(duplicates, 5)?.duplicateOf?.reference === existingLead.json.lead?.reference &&
      rowAt(duplicates, 5)?.duplicateOf?.customerName === 'Existing Deepa' &&
      rowAt(duplicates, 5)?.duplicateOf?.assignedToName === 'Tina Telecaller',
    rowAt(duplicates, 5),
  );
  check('a number held only by an archived lead is free', rowAt(duplicates, 6)?.outcome === 'ready', rowAt(duplicates, 6));
  check(
    'the duplicate totals are split by kind',
    duplicates.json.import?.totals?.duplicatesInFile === 1 && duplicates.json.import?.totals?.duplicatesExisting === 1,
    duplicates.json.import?.totals,
  );

  const firstInvalid = await upload(maya.client, csv(['Customer name,Phone', ',7320000305', 'Valid Later,07320000305']));
  check(
    'when the first copy is invalid, the first VALID copy imports',
    rowAt(firstInvalid, 2)?.outcome === 'error' && rowAt(firstInvalid, 3)?.outcome === 'ready',
    firstInvalid.json.rows,
  );

  console.log('\nlead import — CSV specifics');

  const csvSpecifics = await upload(maya.client, {
    name: 'excel-europe.csv',
    type: 'text/csv',
    bytes:
      '﻿Customer name;Phone;Alternate phone;Notes\r\n' +
      '"Multi Line";7320000401;;"first line\r\nsecond line"\r\n' +
      'Point Zero;7320000402.0;;\r\n' +
      "Apostrophe;'7320000403;;\r\n" +
      'Split Numbers;73200 00404 / 73200 00405;;\r\n',
  });
  check('a UTF-8 BOM, semicolon CSV is read', csvSpecifics.status === 201 && csvSpecifics.json.import?.totals?.rows === 4, csvSpecifics.json);
  check(
    'a quoted note keeps its line break',
    rowAt(csvSpecifics, 2)?.values?.summaryNote === 'first line\nsecond line' && rowAt(csvSpecifics, 2)?.values?.customerName === 'Multi Line',
    rowAt(csvSpecifics, 2),
  );
  check('"7320000402.0" loses its ".0"', rowAt(csvSpecifics, 3)?.values?.phone === '7320000402', rowAt(csvSpecifics, 3));
  check('a leading apostrophe is dropped', rowAt(csvSpecifics, 4)?.values?.phone === '7320000403', rowAt(csvSpecifics, 4));
  check(
    'two numbers split into phone and alternate, with a warning',
    rowAt(csvSpecifics, 5)?.values?.phone === '73200 00404' &&
      rowAt(csvSpecifics, 5)?.values?.alternatePhone === '73200 00405' &&
      rowAt(csvSpecifics, 5)?.outcome === 'warning',
    rowAt(csvSpecifics, 5),
  );

  const ansi = await upload(maya.client, {
    name: 'ansi.csv',
    type: 'text/csv',
    bytes: Buffer.concat([Buffer.from('Customer name,Phone\r\nJos', 'latin1'), Buffer.from([0xe9]), Buffer.from(' Kumar,7320000406\r\n', 'latin1')]),
  });
  check(
    'a Windows-1252 CSV decodes "José"',
    ansi.status === 201 && rowAt(ansi, 2)?.values?.customerName === 'José Kumar',
    ansi.status === 201 ? rowAt(ansi, 2) : ansi.json,
  );

  console.log('\nlead import — an export imported back');

  const roundTrip = await upload(
    maya.client,
    csv([
      'Reference,Customer,Phone,Alternate,Email,City,Source,Interested in,Status,Assigned to,Last contacted,Next follow-up,Created',
      `${existingLead.json.lead?.reference ?? ''},Existing Deepa,7320000301,,,Pune,Manual,Course B,Follow-up required,Tina Telecaller,,,2026-10-01`,
      `${secondExisting.json.lead?.reference ?? ''},Existing Two,7320000306,,,,Hard copy,,New,Unassigned,,,2026-10-01`,
    ]),
  );
  const roundFields = ((roundTrip.json.columns ?? []) as Json[]).map((column) => column?.field ?? null);
  check(
    'the admin export\'s own headers map',
    roundTrip.status === 201 &&
      JSON.stringify(roundFields) ===
        JSON.stringify([null, 'customerName', 'phone', 'alternatePhone', 'email', 'city', 'source', 'productInterest', 'status', 'assignedTo', null, null, null]),
    { status: roundTrip.status, roundFields },
  );
  check(
    'every exported row is a duplicate of the lead it came from',
    roundTrip.json.import?.totals?.duplicatesExisting === 2 &&
      ((roundTrip.json.rows ?? []) as Json[]).every((row) => row?.outcome === 'duplicate_existing'),
    roundTrip.json.rows,
  );
  check(
    'status by label, assignee by name, "Unassigned" as nobody, "Hard copy" as hard_copy',
    rowAt(roundTrip, 2)?.values?.status === 'follow_up' &&
      rowAt(roundTrip, 2)?.values?.assignedTo === tina.id &&
      rowAt(roundTrip, 3)?.values?.assignedTo === null &&
      rowAt(roundTrip, 3)?.values?.source === 'hard_copy',
    roundTrip.json.rows,
  );

  console.log('\nlead import — sheets, extra columns, .xls');

  const multiSheet = workbook([
    { name: 'Notes', rows: [['Not leads']], hidden: true },
    { name: 'Leads', rows: [['Customer name', 'Phone'], ['Visible Sheet', '7320000501']] },
    { name: 'Other', rows: [['Customer name', 'Phone'], ['Other Sheet', '7320000502'], ['Other Two', '7320000503']] },
  ]);
  const firstVisible = await upload(maya.client, { name: 'book.xlsx', bytes: multiSheet });
  check(
    'the first VISIBLE sheet is read by default, and every sheet is listed',
    firstVisible.status === 201 &&
      firstVisible.json.import?.sheetName === 'Leads' &&
      JSON.stringify(firstVisible.json.import?.sheetNames) === JSON.stringify(['Notes', 'Leads', 'Other']) &&
      rowAt(firstVisible, 2)?.values?.customerName === 'Visible Sheet',
    firstVisible.json.import,
  );
  const chosenSheet = await upload(maya.client, { name: 'book.xlsx', bytes: multiSheet }, { sheet: 'Other', replaces: String(firstVisible.json.import?.id ?? '') });
  check(
    'a chosen sheet is read instead',
    chosenSheet.status === 201 && chosenSheet.json.import?.sheetName === 'Other' && chosenSheet.json.import?.totals?.rows === 2,
    chosenSheet.json.import,
  );
  const replaced = await maya.client.get(`${IMPORTS}/${Number(firstVisible.json.import?.id ?? 0)}`);
  check(
    'and the draft it replaces is discarded',
    replaced.status === 200 && replaced.json.import?.state === 'cancelled' && replaced.json.rowsPage?.total === 0,
    replaced.json.import,
  );
  const missingSheet = await upload(maya.client, { name: 'book.xlsx', bytes: multiSheet }, { sheet: 'Missing' });
  check(
    'a sheet that does not exist is refused',
    missingSheet.status === 400 && String(missingSheet.json.errors?.file ?? '').includes('Missing'),
    missingSheet.json,
  );

  const extras = await upload(
    maya.client,
    csv(['Customer name,Phone,Budget,Notes', 'Extra Notes,7320000601,5 lakh,Call after six']),
    { extraColumns: 'notes' },
  );
  check(
    'other columns can be kept in the lead\'s notes',
    extras.status === 201 && rowAt(extras, 2)?.values?.summaryNote === 'Call after six\nBudget: 5 lakh',
    extras.status === 201 ? rowAt(extras, 2) : extras.json,
  );

  const legacy = await upload(maya.client, {
    name: 'legacy.xls',
    bytes: workbook([{ name: 'Leads', rows: [['Customer name', 'Phone'], ['Legacy Excel', '7320000701']] }], 'biff8'),
  });
  check(
    'an old .xls workbook is read too',
    legacy.status === 201 && legacy.json.import?.fileKind === 'xls' && rowAt(legacy, 2)?.values?.customerName === 'Legacy Excel',
    legacy.status === 201 ? legacy.json.import : legacy.json,
  );

  /* ====================================================================== C. commit */
  console.log('\nlead import — committing');

  const trapPhones = numbers('733', 1, 2);
  const trap = await upload(mohan.client, csv(['Customer name,Phone', `Trap One,${trapPhones[0]}`, `Trap Two,${trapPhones[1]}`]));
  check('the no-default file is checked', trap.status === 201, trap.json);
  const trapCalls = await commitAll(mohan.client, Number(trap.json.import?.id ?? 0), 1);
  const trapLast = trapCalls[trapCalls.length - 1];
  check(
    'it commits one row per call until done',
    trapCalls.length === 2 && trapLast?.status === 200 && trapLast?.json.done === true && trapCalls[0]?.json.processed === 1 && trapCalls[0]?.json.remaining === 1,
    trapCalls.map((call) => ({ status: call.status, processed: call.json.processed, remaining: call.json.remaining, done: call.json.done })),
  );
  const trapLeads = await rowsOf('SELECT assigned_to, created_by FROM leads WHERE phone IN (?, ?)', trapPhones);
  check(
    'with no default assignee the leads are UNASSIGNED — not given to the manager importing them',
    trapLeads.length === 2 && trapLeads.every((lead) => lead.assigned_to === null && Number(lead.created_by) === mohan.id),
    trapLeads,
  );

  const tinaNotificationsBefore = await scalar(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'lead_assigned'",
    [tina.id],
  );

  const assignedPhones = numbers('733', 11, 5);
  const assigned = await upload(
    mohan.client,
    csv(['Customer name,Phone', ...assignedPhones.map((phone, index) => `Assigned ${index + 1},${phone}`)]),
    { defaultAssignedTo: String(tina.id) },
  );
  const assignedImportId = Number(assigned.json.import?.id ?? 0);
  check('the five-lead file is checked with Tina as the default', assigned.status === 201 && assigned.json.import?.defaults?.assignedTo === tina.id, assigned.json.import);

  const assignedCalls = await commitAll(mohan.client, assignedImportId, 2);
  check(
    'it commits in batches of two: 2, 2, then 1 and done',
    JSON.stringify(assignedCalls.map((call) => call.json.processed)) === '[2,2,1]' &&
      assignedCalls[2]?.json.done === true &&
      assignedCalls[0]?.json.done === false &&
      assignedCalls[0]?.json.import?.state === 'committing',
    assignedCalls.map((call) => ({ status: call.status, processed: call.json.processed, done: call.json.done, state: call.json.import?.state })),
  );
  check(
    'each batch answers with only the rows it handled, created and linked to their leads',
    assignedCalls.every((call) => ((call.json.rows ?? []) as Json[]).length === call.json.processed) &&
      ((assignedCalls[0]?.json.rows ?? []) as Json[]).every(
        (row) => row?.state === 'created' && typeof row?.leadId === 'number' && typeof row?.leadReference === 'string',
      ) &&
      assignedCalls[1]?.json.rows?.[0]?.sheetRow === 4,
    assignedCalls.map((call) => call.json.rows),
  );
  const assignedDone = assignedCalls[2]?.json.import ?? {};
  check(
    'the finished import counts five created, none skipped or failed',
    assignedDone.state === 'completed' &&
      assignedDone.progress?.created === 5 &&
      assignedDone.progress?.skipped === 0 &&
      assignedDone.progress?.failed === 0 &&
      assignedDone.progress?.pending === 0 &&
      typeof assignedDone.completedAt === 'string',
    assignedDone,
  );

  const assignedLeads = await rowsOf(
    `SELECT id, phone, assigned_to, assigned_by, created_by, source, status, phone_key
       FROM leads WHERE phone IN (${assignedPhones.map(() => '?').join(', ')}) ORDER BY id`,
    assignedPhones,
  );
  const assignedIds = assignedLeads.map((lead) => Number(lead.id));
  check(
    'the leads belong to Tina, assigned and created by the manager, as typed',
    assignedLeads.length === 5 &&
      assignedLeads.every(
        (lead) =>
          Number(lead.assigned_to) === tina.id &&
          Number(lead.assigned_by) === mohan.id &&
          Number(lead.created_by) === mohan.id &&
          lead.source === 'manual' &&
          lead.status === 'new' &&
          lead.phone_key !== null &&
          assignedPhones.includes(String(lead.phone)),
      ),
    assignedLeads,
  );

  const createdActivities = await rowsOf(
    `SELECT lead_id, summary, meta FROM lead_activities
      WHERE type = 'lead_created' AND lead_id IN (${assignedIds.map(() => '?').join(', ')})`,
    assignedIds,
  );
  check(
    'one "lead created" activity per lead, saying it came from a spreadsheet, tracing the import',
    createdActivities.length === 5 &&
      createdActivities.every(
        (activity) =>
          String(activity.summary).includes('from a spreadsheet') &&
          jsonColumn(activity.meta)?.importId === assignedImportId &&
          typeof jsonColumn(activity.meta)?.sheetRow === 'number',
      ),
    createdActivities,
  );
  check(
    'and one "assigned" activity each, the owner not being the importer',
    (await scalar(
      `SELECT COUNT(*) AS n FROM lead_activities WHERE type = 'lead_assigned' AND lead_id IN (${assignedIds.map(() => '?').join(', ')})`,
      assignedIds,
    )) === 5,
  );
  const systemNotes = await rowsOf(
    `SELECT body FROM lead_notes WHERE kind = 'system' AND lead_id IN (${assignedIds.map(() => '?').join(', ')})`,
    assignedIds,
  );
  check(
    'one system note per lead, in words a telecaller can read',
    systemNotes.length === 5 && systemNotes.every((note) => /^Added from a spreadsheet by Mohan Manager \(row \d+\)\.$/.test(String(note.body))),
    systemNotes,
  );

  const tinaNotifications = await rowsOf(
    "SELECT title, body, lead_id FROM notifications WHERE user_id = ? AND kind = 'lead_assigned' ORDER BY id DESC",
    [tina.id],
  );
  check(
    'Tina gets ONE notification for the five leads, not five',
    tinaNotifications.length === tinaNotificationsBefore + 1 &&
      tinaNotifications[0]?.title === '5 new leads assigned' &&
      tinaNotifications[0]?.body === 'Added by Mohan Manager.' &&
      tinaNotifications[0]?.lead_id === null,
    tinaNotifications.slice(0, 2),
  );
  check(
    'one "leads imported" audit row for the import, and no per-lead audit rows',
    (await scalar("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'leads_imported' AND entity_type = 'lead_import' AND entity_id = ?", [assignedImportId])) === 1 &&
      (await scalar(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'lead_created' AND entity_id IN (${assignedIds.map(() => '?').join(', ')})`,
        assignedIds,
      )) === 0,
  );

  const leadsBeforeReplay = await scalar('SELECT COUNT(*) AS n FROM leads');
  const again = await mohan.client.post(`${IMPORTS}/${assignedImportId}/commit`, { batchSize: 50 });
  check(
    'committing a finished import again is a harmless "done"',
    again.status === 200 && again.json.done === true && again.json.processed === 0 && (await scalar('SELECT COUNT(*) AS n FROM leads')) === leadsBeforeReplay,
    again.json,
  );

  const taraNotificationsBefore = await scalar("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'lead_assigned'", [tara.id]);
  const singlePhone = numbers('733', 21, 1)[0] ?? '';
  const single = await upload(mohan.client, csv(['Customer name,Phone,Assigned to', `Single Lead,${singlePhone},IM-0002`]));
  const singleCalls = await commitAll(mohan.client, Number(single.json.import?.id ?? 0), 10);
  const singleLeadId = Number(singleCalls[singleCalls.length - 1]?.json.rows?.[0]?.leadId ?? 0);
  const taraNotifications = await rowsOf(
    "SELECT title, lead_id FROM notifications WHERE user_id = ? AND kind = 'lead_assigned' ORDER BY id DESC",
    [tara.id],
  );
  check(
    'a single imported lead is notified as "New lead assigned", linked to the lead',
    taraNotifications.length === taraNotificationsBefore + 1 &&
      taraNotifications[0]?.title === 'New lead assigned' &&
      Number(taraNotifications[0]?.lead_id) === singleLeadId &&
      singleLeadId > 0,
    { taraNotifications: taraNotifications.slice(0, 2), singleLeadId },
  );

  console.log('\nlead import — retries and concurrency');

  const parallelPhones = numbers('733', 31, 6);
  const parallel = await upload(mohan.client, csv(['Customer name,Phone', ...parallelPhones.map((phone, index) => `Parallel ${index + 1},${phone}`)]));
  const parallelId = Number(parallel.json.import?.id ?? 0);
  const [firstCommit, secondCommit] = await Promise.all([
    mohan.client.post(`${IMPORTS}/${parallelId}/commit`, { batchSize: 3 }),
    mohan.client.post(`${IMPORTS}/${parallelId}/commit`, { batchSize: 3 }),
  ]);
  const statuses = [firstCommit.status, secondCommit.status].sort();
  check(
    'two commits at once: the second is told the import is busy, or runs after the first',
    (statuses[0] === 200 && statuses[1] === 409 && [firstCommit, secondCommit].some((call) => call.json.code === 'import_busy')) ||
      (statuses[0] === 200 && statuses[1] === 200),
    [firstCommit.json, secondCommit.json],
  );
  const parallelRest = await commitAll(mohan.client, parallelId, 3);
  check('and the import still finishes', parallelRest[parallelRest.length - 1]?.json.done === true, parallelRest.map((call) => call.json));
  check(
    'with each row created exactly once',
    (await scalar(`SELECT COUNT(*) AS n FROM leads WHERE phone IN (${parallelPhones.map(() => '?').join(', ')})`, parallelPhones)) === 6 &&
      (
        await rowsOf(
          `SELECT phone_key FROM leads WHERE is_archived = 0 AND phone IN (${parallelPhones.map(() => '?').join(', ')})
            GROUP BY phone_key HAVING COUNT(*) > 1`,
          parallelPhones,
        )
      ).length === 0,
  );

  const replayPhones = numbers('733', 41, 3);
  const replay = await upload(mohan.client, csv(['Customer name,Phone', ...replayPhones.map((phone, index) => `Replay ${index + 1},${phone}`)]));
  const replayId = Number(replay.json.import?.id ?? 0);
  const replayFirst = await mohan.client.post(`${IMPORTS}/${replayId}/commit`, { batchSize: 2 });
  const replayLeadId = Number(replayFirst.json.rows?.[0]?.leadId ?? 0);
  check('a partial batch leaves the import committing', replayFirst.json.remaining === 1 && replayFirst.json.import?.state === 'committing', replayFirst.json);
  // Simulate a crash between creating the lead and recording it: the row is pending again.
  await db.query(
    "UPDATE lead_import_rows SET state = 'pending', lead_id = NULL, processed_at = NULL WHERE import_id = ? AND sheet_row = 2",
    [replayId],
  );
  const leadsBeforeCrashReplay = await scalar('SELECT COUNT(*) AS n FROM leads');
  const replayRest = await commitAll(mohan.client, replayId, 10);
  const replayedRow = (await rowsOf('SELECT state, lead_id FROM lead_import_rows WHERE import_id = ? AND sheet_row = 2', [replayId]))[0];
  check(
    'a row replayed after a crash finds the lead it already created — no second lead',
    replayRest[replayRest.length - 1]?.json.done === true &&
      replayedRow?.state === 'created' &&
      Number(replayedRow?.lead_id) === replayLeadId &&
      replayLeadId > 0 &&
      (await scalar('SELECT COUNT(*) AS n FROM leads')) === leadsBeforeCrashReplay + 1,
    { replayedRow, replayLeadId },
  );

  const racePhones = numbers('733', 51, 3);
  const race = await upload(mohan.client, csv(['Customer name,Phone', ...racePhones.map((phone, index) => `Race ${index + 1},${phone}`)]));
  const raceId = Number(race.json.import?.id ?? 0);
  const rival = await mohan.client.post('/admin/telecalling/leads', { customerName: 'Rival Lead', phone: racePhones[2], assignedTo: null });
  check('a lead takes one of the numbers after the check', rival.status === 201, rival.json);
  const raceCalls = await commitAll(mohan.client, raceId, 10);
  const raceRows = (raceCalls[raceCalls.length - 1]?.json.rows ?? []) as Json[];
  const raceSkipped = raceRows.find((row) => row?.sheetRow === 4);
  check(
    'that row is skipped at commit with the duplicate rule\'s own message, the others are created',
    raceSkipped?.state === 'skipped' &&
      String(raceSkipped?.resultMessage ?? '').includes(String(rival.json.lead?.reference ?? '?')) &&
      raceRows.filter((row) => row?.state === 'created').length === 2 &&
      raceCalls[raceCalls.length - 1]?.json.import?.progress?.skipped === 1,
    raceRows,
  );
  const raceCsv = await mohan.client.getRaw(`${IMPORTS}/${raceId}/rows.csv`);
  check(
    'a row skipped at commit is in the rows to fix, with the reason',
    raceCsv.status === 200 && raceCsv.body.toString('utf8').includes('Race 3') && raceCsv.body.toString('utf8').includes('already has this number'),
    raceCsv.body.toString('utf8'),
  );

  console.log('\nlead import — deactivated default assignee');

  const dinaPhones = numbers('733', 61, 2);
  const forDina = await upload(mohan.client, csv(['Customer name,Phone', ...dinaPhones.map((phone, index) => `For Dina ${index + 1},${phone}`)]), {
    defaultAssignedTo: String(dina.id),
  });
  const forDinaId = Number(forDina.json.import?.id ?? 0);
  await db.query('UPDATE telecaller_users SET is_active = 0 WHERE id = ?', [dina.id]);
  const leadsBeforeDina = await scalar('SELECT COUNT(*) AS n FROM leads');
  const dinaCommit = await mohan.client.post(`${IMPORTS}/${forDinaId}/commit`, {});
  check(
    'committing after the default assignee was deactivated is refused (400), explaining why',
    dinaCommit.status === 400 && String(dinaCommit.json.message ?? '').includes('deactivated'),
    dinaCommit.json,
  );
  const dinaAfter = await mohan.client.get(`${IMPORTS}/${forDinaId}`);
  check(
    'and nothing was created; the draft is untouched',
    (await scalar('SELECT COUNT(*) AS n FROM leads')) === leadsBeforeDina && dinaAfter.json.import?.state === 'ready',
    dinaAfter.json.import,
  );
  await db.query('UPDATE telecaller_users SET is_active = 1 WHERE id = ?', [dina.id]);

  console.log('\nlead import — who may run an import');

  const othersPhones = numbers('733', 71, 2);
  const others = await upload(mohan.client, csv(['Customer name,Phone', ...othersPhones.map((phone, index) => `Others ${index + 1},${phone}`)]));
  const othersId = Number(others.json.import?.id ?? 0);
  const byOtherManager = await mona.client.post(`${IMPORTS}/${othersId}/commit`, {});
  const cancelByOther = await mona.client.post(`${IMPORTS}/${othersId}/cancel`);
  const readByOther = await mona.client.get(`${IMPORTS}/${othersId}`);
  check(
    'another manager may read the import but not run or stop it (403)',
    byOtherManager.status === 403 && cancelByOther.status === 403 && readByOther.status === 200,
    [byOtherManager.status, cancelByOther.status, readByOther.status],
  );
  const byAdmin = await commitAll(adminAsBearer, othersId, 10);
  check('an administrator may finish it', byAdmin[byAdmin.length - 1]?.json.done === true, byAdmin.map((call) => call.json));

  console.log('\nlead import — cancel and expiry');

  const cancelPhones = numbers('733', 81, 2);
  const toCancel = await upload(mohan.client, csv(['Customer name,Phone', ...cancelPhones.map((phone, index) => `Cancel ${index + 1},${phone}`)]));
  const toCancelId = Number(toCancel.json.import?.id ?? 0);
  const auditsBeforeCancel = await scalar('SELECT COUNT(*) AS n FROM audit_logs');
  const cancelled = await mohan.client.post(`${IMPORTS}/${toCancelId}/cancel`);
  check(
    'an unconfirmed draft can be cancelled',
    cancelled.status === 200 && cancelled.json.import?.state === 'cancelled' && cancelled.json.import?.progress?.created === 0,
    cancelled.json,
  );
  check(
    'its staged rows are deleted at once, and no audit row is written for a draft',
    (await scalar('SELECT COUNT(*) AS n FROM lead_import_rows WHERE import_id = ?', [toCancelId])) === 0 &&
      (await scalar('SELECT COUNT(*) AS n FROM audit_logs')) === auditsBeforeCancel,
  );
  const commitCancelled = await mohan.client.post(`${IMPORTS}/${toCancelId}/commit`, {});
  check('committing it afterwards is refused (409 import_closed)', commitCancelled.status === 409 && commitCancelled.json.code === 'import_closed', commitCancelled.json);
  const cancelAgain = await mohan.client.post(`${IMPORTS}/${toCancelId}/cancel`);
  check('cancelling twice is harmless', cancelAgain.status === 200 && cancelAgain.json.import?.state === 'cancelled', cancelAgain.json);
  const cancelCompleted = await mohan.client.post(`${IMPORTS}/${assignedImportId}/cancel`);
  check('a finished import cannot be cancelled (409 import_closed)', cancelCompleted.status === 409 && cancelCompleted.json.code === 'import_closed', cancelCompleted.json);

  const expiring = await upload(mohan.client, csv(['Customer name,Phone', `Expiring,${numbers('733', 91, 1)[0] ?? ''}`]));
  const expiringId = Number(expiring.json.import?.id ?? 0);
  await db.query('UPDATE lead_imports SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [expiringId]);
  const sweepTrigger = await upload(mohan.client, csv(['Customer name,Phone', `Sweep Trigger,${numbers('733', 92, 1)[0] ?? ''}`]));
  check('another preview runs', sweepTrigger.status === 201, sweepTrigger.json);
  check(
    'the housekeeping it runs expires the old draft and deletes its rows',
    (await rowsOf('SELECT state FROM lead_imports WHERE id = ?', [expiringId]))[0]?.state === 'expired' &&
      (await scalar('SELECT COUNT(*) AS n FROM lead_import_rows WHERE import_id = ?', [expiringId])) === 0,
  );
  const expiredDetail = await mohan.client.get(`${IMPORTS}/${expiringId}`);
  check(
    'an expired import reads as expired with its rows purged',
    expiredDetail.status === 200 && expiredDetail.json.import?.state === 'expired' && expiredDetail.json.rowsPurged === true && expiredDetail.json.rows?.length === 0,
    expiredDetail.json,
  );
  const commitExpired = await mohan.client.post(`${IMPORTS}/${expiringId}/commit`, {});
  check('and cannot be committed (409 import_closed)', commitExpired.status === 409 && commitExpired.json.code === 'import_closed', commitExpired.json);

  const midPhones = numbers('733', 101, 4);
  const tinaBeforeMid = await scalar("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'lead_assigned'", [tina.id]);
  const mid = await upload(mohan.client, csv(['Customer name,Phone', ...midPhones.map((phone, index) => `Midway ${index + 1},${phone}`)]), {
    defaultAssignedTo: String(tina.id),
  });
  const midId = Number(mid.json.import?.id ?? 0);
  const midFirst = await mohan.client.post(`${IMPORTS}/${midId}/commit`, { batchSize: 2 });
  check('half of the import is committed', midFirst.status === 200 && midFirst.json.processed === 2 && midFirst.json.remaining === 2, midFirst.json);
  const midCancel = await mohan.client.post(`${IMPORTS}/${midId}/cancel`);
  check(
    'cancelling part-way keeps the leads already created',
    midCancel.status === 200 &&
      midCancel.json.import?.state === 'cancelled' &&
      midCancel.json.import?.progress?.created === 2 &&
      midCancel.json.import?.progress?.notImported === 2 &&
      (await scalar(`SELECT COUNT(*) AS n FROM leads WHERE is_archived = 0 AND phone IN (${midPhones.map(() => '?').join(', ')})`, midPhones)) === 2,
    midCancel.json,
  );
  check(
    'and writes one "import cancelled" audit row and one notification for what was created',
    (await scalar("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'lead_import_cancelled' AND entity_id = ?", [midId])) === 1 &&
      (await scalar("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'lead_assigned'", [tina.id])) === tinaBeforeMid + 1 &&
      (await rowsOf("SELECT title FROM notifications WHERE user_id = ? AND kind = 'lead_assigned' ORDER BY id DESC LIMIT 1", [tina.id]))[0]?.title ===
        '2 new leads assigned',
  );
  check(
    'its rows that were never imported are gone; the created ones are kept for the record',
    (await scalar("SELECT COUNT(*) AS n FROM lead_import_rows WHERE import_id = ? AND state = 'pending'", [midId])) === 0 &&
      (await scalar("SELECT COUNT(*) AS n FROM lead_import_rows WHERE import_id = ? AND state = 'created'", [midId])) === 2,
  );
  const commitAfterCancel = await mohan.client.post(`${IMPORTS}/${midId}/commit`, {});
  check('committing after a cancel is refused (409 import_closed)', commitAfterCancel.status === 409 && commitAfterCancel.json.code === 'import_closed', commitAfterCancel.json);

  console.log('\nlead import — the import list');

  const mine = await mohan.client.get(`${IMPORTS}?mine=true&pageSize=3`);
  check(
    'the list is paginated, newest first, and "mine" means mine',
    mine.status === 200 &&
      mine.json.items?.length === 3 &&
      mine.json.pageSize === 3 &&
      mine.json.total >= 10 &&
      mine.json.totalPages === Math.ceil(Number(mine.json.total) / 3) &&
      ((mine.json.items ?? []) as Json[]).every((item) => item?.createdBy?.id === mohan.id) &&
      Number(mine.json.items?.[0]?.id) > Number(mine.json.items?.[1]?.id),
    { total: mine.json.total, pages: mine.json.totalPages, items: ((mine.json.items ?? []) as Json[]).map((item) => item?.id) },
  );
  const completedList = await mohan.client.get(`${IMPORTS}?mine=true&state=completed&pageSize=100`);
  check(
    'filtered by state',
    completedList.status === 200 &&
      completedList.json.total >= 5 &&
      ((completedList.json.items ?? []) as Json[]).every((item) => item?.state === 'completed'),
    completedList.json.total,
  );
  const listTooBig = await mohan.client.get(`${IMPORTS}?pageSize=101`);
  check('a page larger than 100 is refused (422)', listTooBig.status === 422, listTooBig.status);

  console.log('\nlead import — parsing capacity');

  const capacityFile = workbook([{ name: 'Leads', rows: [['Customer name', 'Phone'], ...numbers('733', 200, 300).map((phone, index) => [`Capacity ${index}`, phone])] }]);
  const burst = await Promise.all(
    Array.from({ length: 4 }, () => upload(mohan.client, { name: 'capacity.xlsx', bytes: capacityFile })),
  );
  check(
    'a burst of Excel uploads waits its turn for a parse slot (or is told to try again, 503 import_busy) — never an error',
    burst.every((response) => response.status === 201 || (response.status === 503 && response.json.code === 'import_busy')),
    burst.map((response) => ({ status: response.status, code: response.json.code })),
  );

  /* ================================================================ D. the limiter */
  console.log('\nlead import — the preview limiter');

  const configured = Number(process.env.LEAD_IMPORT_RATE_LIMIT_MAX);
  const limit = Number.isInteger(configured) && configured > 0 ? configured : 30;
  if (limit > 60) {
    console.log(`  (skipped: LEAD_IMPORT_RATE_LIMIT_MAX is ${limit}, too high to exhaust here)`);
  } else {
    const rush = await ctx.createSignedInEmployee({ name: 'Rush Manager', email: 'imp.rush@example.test', role: 'manager' });
    const within: number[] = [];
    // Fileless forms: refused with a 400 straight after the limiter has counted them.
    for (let attempt = 0; attempt < limit; attempt += 1) {
      within.push((await upload(rush.client, null, { defaultStatus: 'new' })).status);
    }
    const over = await upload(rush.client, null, { defaultStatus: 'new' });
    check(
      `the ${limit} files allowed per ten minutes are counted, then refused with 429`,
      within.every((status) => status === 400) && over.status === 429 && over.json.code === 'rate_limited',
      { within: [...new Set(within)], over: over.status, json: over.json },
    );
    const colleague = await upload(maya.client, csv(['Customer name,Phone', `Colleague,${numbers('732', 900, 1)[0] ?? ''}`]));
    check('and the limit is per person: a colleague is unaffected', colleague.status === 201, colleague.status);
  }
}
