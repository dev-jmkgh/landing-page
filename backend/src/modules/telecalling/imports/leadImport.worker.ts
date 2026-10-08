import { parentPort, workerData } from 'node:worker_threads';
import * as XLSX from 'xlsx';
import type {
  Cell,
  ParseWorkerInput,
  ParseWorkerResult,
  ParsedSheet,
  SheetRow,
} from './leadImport.parser';

/**
 * The SheetJS read of an uploaded Excel file, in a worker thread.
 *
 * Started by `runParseWorker` with its own heap limit and a deadline, so a hostile or
 * merely enormous workbook costs this thread, not the API. Imports nothing from the app
 * — only SheetJS and type declarations — so it starts quickly and never reads the
 * configuration.
 *
 * Reads in up to three passes, each bounded:
 *
 *   1. The workbook's sheet list and which sheets are hidden, without parsing any sheet
 *      (an .xls cannot skip its sheets, so it is parsed here, truncated).
 *   2. The chosen sheet, truncated to the first LEAD_IMPORT_ROW_CAP rows — the header
 *      window plus the row limit plus one, which is all a valid file can need.
 *   3. Only if the sheet's own dimensions say rows exist past that point: the whole
 *      sheet, so a file with 2,000 rows and some blank lines between them is counted
 *      exactly instead of silently cut short. Empty formatted cells (a common reason for
 *      an over-long dimension) create no cell objects, so this stays cheap unless the
 *      sheet really is huge — in which case the heap limit ends it.
 *
 * Formulas are never evaluated; only the values Excel cached are read.
 */

const input = workerData as ParseWorkerInput;

const READ_OPTIONS: XLSX.ParsingOptions = {
  type: 'buffer',
  dense: true,
  cellFormula: false,
  cellHTML: false,
  cellStyles: false,
  // Number formats are needed to tell a date from a number: Excel stores both as numbers.
  cellNF: true,
  cellDates: false,
  bookVBA: false,
  bookFiles: false,
  bookDeps: false,
  sheetStubs: false,
};

function post(result: ParseWorkerResult): void {
  parentPort?.postMessage(result);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

type DateParts = { y: number; m: number; d: number; H: number; M: number; S: number };

function formatDateParts(parts: DateParts): string {
  const date = `${pad(parts.y, 4)}-${pad(parts.m)}-${pad(parts.d)}`;
  return parts.H === 0 && parts.M === 0 && parts.S === 0 ? date : `${date} ${pad(parts.H)}:${pad(parts.M)}`;
}

const BLANK: Cell = { k: 'blank', s: null };

function toCell(cell: XLSX.CellObject | undefined | null, date1904: boolean): Cell {
  if (!cell) return BLANK;

  switch (cell.t) {
    case 's': {
      const text = typeof cell.v === 'string' ? cell.v : String(cell.v ?? '');
      return text.trim() === '' ? BLANK : { k: 's', s: text };
    }
    case 'n': {
      const value = typeof cell.v === 'number' ? cell.v : Number(cell.v);
      if (!Number.isFinite(value)) {
        const text = cell.w ?? String(cell.v ?? '');
        return text.trim() === '' ? BLANK : { k: 's', s: text };
      }
      if (typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z)) {
        const parts = XLSX.SSF.parse_date_code(value, { date1904 }) as DateParts | null;
        if (parts) return { k: 'd', s: formatDateParts(parts), n: value };
      }
      return { k: 'n', s: cell.w ?? String(value), n: value };
    }
    case 'b':
      return { k: 'b', s: cell.v ? 'TRUE' : 'FALSE' };
    case 'e':
      return { k: 'e', s: cell.w ?? '#ERROR' };
    case 'd': {
      const date = cell.v instanceof Date ? cell.v : new Date(String(cell.v));
      if (Number.isNaN(date.getTime())) return BLANK;
      return { k: 'd', s: date.toISOString().slice(0, 10) };
    }
    default:
      return BLANK;
  }
}

/** Has the sheet got rows past the ones read? (`!fullref` is set when it was truncated.) */
function wasTruncated(sheet: XLSX.WorkSheet, rowCap: number): boolean {
  const full = sheet['!fullref'] as string | undefined;
  if (!full) return false;
  try {
    return XLSX.utils.decode_range(full).e.r >= rowCap;
  } catch {
    return false;
  }
}

type RowsOutcome =
  | { ok: true; rows: SheetRow[]; moreRows: boolean }
  | { ok: false; result: ParseWorkerResult };

function collectRows(sheet: XLSX.WorkSheet, date1904: boolean): RowsOutcome {
  const { maxColumns, maxCellChars, rowCap } = input.limits;
  const data = (sheet['!data'] as (XLSX.CellObject | null | undefined)[][] | undefined) ?? [];
  const rows: SheetRow[] = [];

  for (let r = 0; r < data.length; r += 1) {
    const source = data[r];
    if (!source || source.length === 0) continue;

    const cells: Cell[] = [];
    let lastFilled = -1;

    for (let c = 0; c < source.length; c += 1) {
      const cell = toCell(source[c], date1904);
      if (cell.k === 'blank') {
        if (c < maxColumns) cells.push(cell);
        continue;
      }
      if (c >= maxColumns) {
        return {
          ok: false,
          result: {
            ok: false,
            code: 'too_many_columns',
            sheetRow: r + 1,
            column: XLSX.utils.encode_col(c),
          },
        };
      }
      if ((cell.s?.length ?? 0) > maxCellChars) {
        return {
          ok: false,
          result: {
            ok: false,
            code: 'cell_too_long',
            sheetRow: r + 1,
            column: XLSX.utils.encode_col(c),
          },
        };
      }
      cells.push(cell);
      lastFilled = c;
    }

    if (lastFilled === -1) continue;

    if (rows.length >= rowCap) return { ok: true, rows, moreRows: true };
    rows.push({ sheetRow: r + 1, cells: cells.slice(0, lastFilled + 1) });
  }

  return { ok: true, rows, moreRows: false };
}

function run(): ParseWorkerResult {
  const buffer = Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength);
  const { rowCap } = input.limits;

  // Pass 1: names and visibility. `sheets: []` parses no worksheet for .xlsx; .xls has to
  // read its sheets regardless, so they are truncated to the cap.
  const book = XLSX.read(buffer, { ...READ_OPTIONS, sheets: [], sheetRows: rowCap });
  const names = book.SheetNames ?? [];
  if (names.length === 0) return { ok: false, code: 'empty' };

  let name: string | undefined;
  if (input.sheet !== null) {
    const wanted = input.sheet;
    name = names.find((candidate) => candidate === wanted) ??
      names.find((candidate) => candidate.trim().toLowerCase() === wanted.trim().toLowerCase());
    if (name === undefined) return { ok: false, code: 'no_sheet', sheet: wanted };
  } else {
    const flags = book.Workbook?.Sheets ?? [];
    name = names.find((_candidate, index) => (flags[index]?.Hidden ?? 0) === 0) ?? names[0];
  }
  if (name === undefined) return { ok: false, code: 'empty' };

  const date1904 = Boolean(book.Workbook?.WBProps?.date1904);

  // Pass 2: the chosen sheet, truncated.
  let sheet: XLSX.WorkSheet | undefined =
    book.Sheets?.[name] ??
    XLSX.read(buffer, { ...READ_OPTIONS, sheets: [name], sheetRows: rowCap }).Sheets[name];
  if (!sheet) return { ok: false, code: 'empty' };

  // Pass 3: the whole sheet, only when its dimensions reach past the cap.
  if (wasTruncated(sheet, rowCap)) {
    sheet = XLSX.read(buffer, { ...READ_OPTIONS, sheets: [name] }).Sheets[name];
    if (!sheet) return { ok: false, code: 'empty' };
  }

  const collected = collectRows(sheet, date1904);
  if (!collected.ok) return collected.result;

  const parsed: ParsedSheet = {
    sheetNames: names,
    sheetName: name,
    rows: collected.rows,
    moreRows: collected.moreRows,
  };
  return { ok: true, sheet: parsed };
}

try {
  post(run());
} catch (error) {
  // SheetJS reports an encrypted workbook in several phrasings; everything else it
  // throws means the bytes are not a workbook it can read.
  const message = error instanceof Error ? error.message : String(error);
  post({ ok: false, code: /password|encrypt/i.test(message) ? 'password' : 'corrupt' });
}
