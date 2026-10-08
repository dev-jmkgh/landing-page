import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HttpError } from '../../../utils/httpError';
import { describeError, logger } from '../../../utils/logger';
import {
  LEAD_IMPORT_LIMITS,
  LEAD_IMPORT_ROW_CAP,
  NULL_TOKENS,
  ZERO_WIDTH,
  normaliseHeader,
  type LeadImportField,
  type LeadImportFileKind,
} from './leadImport.schema';

/**
 * Reading a spreadsheet into rows of cells. No database access here — the service owns
 * every decision about what the cells mean for a lead.
 *
 * Two readers, deliberately:
 *
 * - Excel files (.xlsx, .xls) are read by SheetJS inside a worker thread with its own
 *   heap limit and a deadline (`runParseWorker`). Parsing an untrusted Office file is a
 *   denial-of-service surface — zip bombs, pathological XML, synchronous CPU-heavy work
 *   on the one event loop the whole office's API traffic shares — and a worker is the
 *   only real guarantee: it can be killed, and its memory is not the API's memory.
 * - CSV is read in-house (`readCsv`), not by SheetJS. SheetJS sniffs plain text into its
 *   HTML, SYLK, DIF and PRN readers, which would make the format depend on the content.
 *   A small RFC 4180 reader mirrors the hand-written CSV writer in the admin web, runs in
 *   linear time over at most 5 MB, and never produces a numeric phone.
 */

/* -------------------------------------------------------------------------- */
/* Cells and rows                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One cell, reduced to what the import needs.
 *
 *   s      text
 *   n      a number; `s` is the text Excel displays, `n` the exact value
 *   d      a date-formatted number; `s` is `YYYY-MM-DD` (or with `HH:MM`), no timezone —
 *          an Excel date has none
 *   b      a boolean, `s` is TRUE or FALSE
 *   e      an error cell; `s` is what Excel shows, e.g. `#N/A`
 *   blank  nothing (or only spaces)
 */
export type CellKind = 's' | 'n' | 'd' | 'b' | 'e' | 'blank';
export type Cell = { k: CellKind; s: string | null; n?: number };
export const BLANK_CELL: Cell = { k: 'blank', s: null };

/** A non-blank row. `sheetRow` is the row number Excel shows (1-based). */
export type SheetRow = { sheetRow: number; cells: Cell[] };

export type ParsedSheet = {
  /** Every sheet in the workbook, in order. Empty for CSV. */
  sheetNames: string[];
  /** The sheet that was read. Null for CSV. */
  sheetName: string | null;
  /** The non-blank rows, in order — at most LEAD_IMPORT_ROW_CAP of them. */
  rows: SheetRow[];
  /** True when non-blank rows exist beyond the ones returned. */
  moreRows: boolean;
};

/**
 * A file the import cannot use, with a message the person who uploaded it can act on.
 * The service turns it into a 400 naming the `file` field.
 */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFileError';
  }
}

/** The column letter Excel shows for a zero-based index: 0 → A, 26 → AA. */
export function columnLetter(index: number): string {
  let letters = '';
  let remaining = index + 1;
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

export function detectFileKind(originalName: string): LeadImportFileKind | null {
  switch (path.extname(originalName).toLowerCase()) {
    case '.xlsx':
      return 'xlsx';
    case '.xls':
      return 'xls';
    case '.csv':
      return 'csv';
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* .xlsx container check                                                       */
/* -------------------------------------------------------------------------- */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_MIN = 22;
const EOCD_MAX_COMMENT = 0xffff;

const DAMAGED =
  'This file is damaged or is not a complete Excel workbook. Open it in Excel, save it again as .xlsx, and try again.';
const TOO_LARGE_UNPACKED =
  'This workbook is too large to read safely once unpacked. Save a copy with only the lead columns and try again.';

/**
 * Checks an .xlsx (a ZIP) from its central directory, before anything is inflated.
 *
 * Returns a message when the file must be refused, or null when it may go on to the
 * parser. This stops honest zip bombs for the cost of reading a few kilobytes: the sizes
 * every entry DECLARES are capped individually and in total, and an entry compressed far
 * more tightly than any real worksheet is refused once it is big enough to matter. A
 * dishonest file that lies about its sizes gets past this, and is stopped by the worker's
 * heap limit instead — this check is what keeps that rare.
 *
 * It also refuses a ZIP that is not a workbook at all — an .ods or .docx renamed to
 * .xlsx — which the parser would otherwise either read as something else or reject with
 * a message about ZIP internals.
 */
export function inspectZipContainer(buffer: Buffer): string | null {
  const limits = LEAD_IMPORT_LIMITS.zip;
  if (buffer.length < EOCD_MIN) return DAMAGED;

  // The end-of-central-directory record is the last thing in the file, followed only by
  // an optional comment of at most 65,535 bytes.
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - EOCD_MIN - EOCD_MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) return DAMAGED;

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const entriesHere = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  // ZIP64 markers. No genuine 5 MB lead sheet needs ZIP64, and its sizes are exactly the
  // ones this check exists to bound.
  if (
    totalEntries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    return TOO_LARGE_UNPACKED;
  }

  if (diskNumber !== 0 || directoryDisk !== 0 || entriesHere !== totalEntries) return DAMAGED;
  if (totalEntries > limits.maxEntries) return TOO_LARGE_UNPACKED;
  if (directoryOffset + directorySize > eocd) return DAMAGED;

  let pointer = directoryOffset;
  let declaredTotal = 0;
  let hasWorkbook = false;

  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (pointer + 46 > eocd || buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) return DAMAGED;

    const flags = buffer.readUInt16LE(pointer + 8);
    const compressed = buffer.readUInt32LE(pointer + 20);
    const uncompressed = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const nameEnd = pointer + 46 + nameLength;
    if (nameEnd > eocd) return DAMAGED;

    if (flags & 0x0001) {
      return 'This workbook is password-protected. Remove the password in Excel and try again.';
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) return TOO_LARGE_UNPACKED;
    if (uncompressed > limits.maxEntryBytes) return TOO_LARGE_UNPACKED;

    declaredTotal += uncompressed;
    if (declaredTotal > limits.maxTotalBytes) return TOO_LARGE_UNPACKED;

    const ratio = compressed > 0 ? uncompressed / compressed : uncompressed > 0 ? Infinity : 0;
    if (ratio > limits.maxRatio && uncompressed > limits.ratioMinBytes) return TOO_LARGE_UNPACKED;

    const name = buffer.toString('latin1', pointer + 46, nameEnd).toLowerCase();
    if (name === 'xl/workbook.xml' || name === 'xl/workbook.bin') hasWorkbook = true;

    pointer = nameEnd + extraLength + commentLength;
  }

  if (!hasWorkbook) {
    return 'This file is not an Excel workbook. If it came from another program, open it in Excel and save it as .xlsx, then try again.';
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Excel files: the worker                                                     */
/* -------------------------------------------------------------------------- */

export type ParseWorkerInput = {
  buffer: Uint8Array;
  kind: 'xlsx' | 'xls';
  /** The sheet to read; null for the first visible one. */
  sheet: string | null;
  limits: { maxColumns: number; maxCellChars: number; rowCap: number };
};

export type ParseWorkerFailure =
  | { ok: false; code: 'password' | 'corrupt' | 'empty' }
  | { ok: false; code: 'no_sheet'; sheet: string }
  | { ok: false; code: 'too_many_columns'; sheetRow: number; column: string }
  | { ok: false; code: 'cell_too_long'; sheetRow: number; column: string };

export type ParseWorkerResult = { ok: true; sheet: ParsedSheet } | ParseWorkerFailure;

/**
 * The worker's file, next to this one.
 *
 * Under tsx (dev and the e2e harness) this module is `.ts` and so is the worker; the
 * worker inherits the parent's execArgv, which carries tsx's loader, so it can load
 * TypeScript too. In the compiled build both are `.js` in the same dist folder. Taking
 * the extension from this very file keeps the two cases one line.
 */
const WORKER_FILE = path.join(__dirname, `leadImport.worker${path.extname(__filename)}`);

/** Parses in flight. A module-level count: one API process, one budget. */
let activeParses = 0;

/** Callers waiting for a parse slot, oldest first. */
const parseQueue: (() => void)[] = [];

/** How long a caller waits for a free slot before being told to try again. */
const PARSE_SLOT_WAIT_MS = 3000;

/**
 * Takes one of the parse slots, waiting a short while for one to free up.
 *
 * Two managers uploading in the same second should both get an answer, so a third parse
 * waits — but only briefly, and never more than the slots allow at once: a real burst is
 * told to try again rather than stacking up minutes of parsing in memory.
 */
function acquireParseSlot(): Promise<boolean> {
  if (activeParses < LEAD_IMPORT_LIMITS.maxConcurrentParses) {
    activeParses += 1;
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const take = () => {
      clearTimeout(timer);
      activeParses += 1;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const index = parseQueue.indexOf(take);
      if (index !== -1) parseQueue.splice(index, 1);
      resolve(false);
    }, PARSE_SLOT_WAIT_MS);
    parseQueue.push(take);
  });
}

/** Frees a slot and hands it straight to the next caller waiting, if any. */
function releaseParseSlot(): void {
  activeParses -= 1;
  parseQueue.shift()?.();
}

/**
 * Reads an Excel file in a worker thread, bounded in memory, time and concurrency.
 *
 * - The worker gets its own V8 heap capped at 256 MB. A workbook that needs more is
 *   refused with ERR_WORKER_OUT_OF_MEMORY instead of taking the API process down.
 * - It is terminated after 15 seconds.
 * - At most two run at once. A third caller waits up to three seconds for a slot, then is
 *   told to try again (503 `import_busy`).
 */
export async function runParseWorker(
  buffer: Buffer,
  kind: 'xlsx' | 'xls',
  sheet: string | null,
): Promise<ParsedSheet> {
  if (!(await acquireParseSlot())) {
    throw new HttpError(503, 'Another file is being checked. Try again in a moment.', {
      code: 'import_busy',
    });
  }

  try {
    const result = await new Promise<ParseWorkerResult>((resolve, reject) => {
      const input: ParseWorkerInput = {
        buffer: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        kind,
        sheet,
        limits: {
          maxColumns: LEAD_IMPORT_LIMITS.maxColumns,
          maxCellChars: LEAD_IMPORT_LIMITS.maxCellChars,
          rowCap: LEAD_IMPORT_ROW_CAP,
        },
      };

      const worker = new Worker(WORKER_FILE, {
        workerData: input,
        resourceLimits: {
          maxOldGenerationSizeMb: LEAD_IMPORT_LIMITS.parseHeapMb,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });

      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };

      // On the deadline the worker is terminated, and the call answers only once the
      // thread has actually gone (the 'exit' below) — so its slot is not handed to the
      // next parse while the old one still holds its memory.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void worker.terminate();
      }, LEAD_IMPORT_LIMITS.parseTimeoutMs);

      worker.once('message', (message: ParseWorkerResult) => {
        settle(() => resolve(message));
        void worker.terminate();
      });

      worker.once('error', (error: Error & { code?: string }) => {
        settle(() => {
          if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
            reject(
              new ImportFileError(
                'This file is too complex to read safely. Save a copy with only the lead columns, as .xlsx or .csv, and try again.',
              ),
            );
            return;
          }
          // Logged without any cell content: the file holds customers' personal data.
          logger.error('Lead import parse worker failed', describeError(error));
          reject(
            new ImportFileError(
              'This file could not be read. Open it in Excel, save it again as .xlsx, and try again.',
            ),
          );
        });
      });

      worker.once('exit', (code) => {
        settle(() => {
          if (timedOut) {
            reject(
              new ImportFileError(
                'The file took too long to read. Save it again as .xlsx or .csv and try again.',
              ),
            );
            return;
          }
          logger.error('Lead import parse worker exited without an answer', { code });
          reject(
            new ImportFileError(
              'This file could not be read. Open it in Excel, save it again as .xlsx, and try again.',
            ),
          );
        });
      });
    });

    if (result.ok) return result.sheet;

    switch (result.code) {
      case 'password':
        throw new ImportFileError(
          'This workbook is password-protected. Remove the password in Excel and try again.',
        );
      case 'empty':
        throw new ImportFileError('The file has no rows to import.');
      case 'no_sheet':
        throw new ImportFileError(`The sheet "${result.sheet}" is not in this file.`);
      case 'too_many_columns':
        throw new ImportFileError(
          `Row ${result.sheetRow} has a value in column ${result.column}, past the ${LEAD_IMPORT_LIMITS.maxColumns}-column limit. Delete the columns you do not need and try again.`,
        );
      case 'cell_too_long':
        throw new ImportFileError(
          `The value in row ${result.sheetRow}, column ${result.column} is longer than ${formatCount(LEAD_IMPORT_LIMITS.maxCellChars)} characters.`,
        );
      case 'corrupt':
      default:
        throw new ImportFileError(
          'This file is not a valid Excel workbook. Open it in Excel, save it again as .xlsx, and try again.',
        );
    }
  } finally {
    releaseParseSlot();
  }
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Decodes CSV bytes to text.
 *
 * Excel's "CSV UTF-8" writes a BOM; its plain "CSV (Comma delimited)" writes the Windows
 * ANSI code page with no marker at all; "Unicode Text" is UTF-16LE with a BOM. So: a BOM
 * decides, otherwise strict UTF-8, and if that fails Windows-1252 — the only reading
 * under which an ANSI "José" survives.
 */
export function decodeCsvText(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

const QUOTE = 34; // "
const CR = 13;
const LF = 10;

/**
 * The delimiter, sniffed from the first non-empty line outside quotes among comma,
 * semicolon and tab. European Excel writes semicolons; "Unicode Text" writes tabs.
 * Ties go to the comma.
 */
function sniffDelimiter(text: string, start: number): number {
  const counts = new Map<number, number>([
    [44, 0], // ,
    [59, 0], // ;
    [9, 0], //  tab
  ]);

  let index = start;
  // Skip leading blank lines.
  while (index < text.length && (text.charCodeAt(index) === CR || text.charCodeAt(index) === LF)) {
    index += 1;
  }

  let inQuotes = false;
  for (; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (code === CR || code === LF) break;
    const count = counts.get(code);
    if (count !== undefined) counts.set(code, count + 1);
  }

  let best = 44;
  let bestCount = counts.get(44) ?? 0;
  for (const candidate of [59, 9]) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Reads CSV text into rows (RFC 4180: quoted fields, doubled quotes, embedded newlines,
 * CRLF, LF or CR line ends).
 *
 * Row numbers count every record, blank ones included, so they match the row numbers
 * Excel shows when it opens the same file. A leading `sep=;` line — Excel's own delimiter
 * hint — is honoured and, as in Excel, not counted as a row.
 *
 * Refuses rather than truncates: a row with a value past the 60th column, a value over
 * 4,000 characters (usually a quote that is never closed, swallowing the rest of the
 * file), or a quote still open at the end. Stops reading once more non-blank rows than
 * the cap have been seen — the caller only needs to know there are too many.
 */
export function readCsv(text: string): ParsedSheet {
  const { maxColumns, maxCellChars } = LEAD_IMPORT_LIMITS;
  const length = text.length;

  let index = 0;
  let delimiter: number;
  const hint = /^sep=([,;\t|])\r?\n/i.exec(text.slice(0, 8));
  if (hint) {
    delimiter = hint[1]!.charCodeAt(0);
    index = hint[0].length;
  } else {
    delimiter = sniffDelimiter(text, 0);
  }

  const isBoundary = (code: number) => code === delimiter || code === CR || code === LF;

  const rows: SheetRow[] = [];
  let moreRows = false;
  let recordNumber = 0;

  while (index < length) {
    recordNumber += 1;
    const sheetRow = recordNumber;
    const values: string[] = [];

    for (;;) {
      let value: string;

      if (text.charCodeAt(index) === QUOTE) {
        index += 1;
        let collected = '';
        let segmentStart = index;
        for (;;) {
          const close = text.indexOf('"', index);
          if (close === -1) {
            throw new ImportFileError(
              `A quote in row ${sheetRow} is never closed. Check that row in the file and try again.`,
            );
          }
          if (text.charCodeAt(close + 1) === QUOTE) {
            collected += text.slice(segmentStart, close + 1);
            index = close + 2;
            segmentStart = index;
          } else {
            collected += text.slice(segmentStart, close);
            index = close + 1;
            break;
          }
          if (collected.length > maxCellChars) break;
        }
        // Lenient about stray text between the closing quote and the delimiter, as
        // Excel is: it is kept rather than lost.
        let end = index;
        while (end < length && !isBoundary(text.charCodeAt(end))) end += 1;
        if (end > index) collected += text.slice(index, end);
        index = end;
        value = collected;
      } else {
        let end = index;
        while (end < length && !isBoundary(text.charCodeAt(end))) end += 1;
        value = text.slice(index, end);
        index = end;
      }

      if (value.length > maxCellChars) {
        throw new ImportFileError(
          `A value in row ${sheetRow} is longer than ${formatCount(maxCellChars)} characters, or a quote in it is never closed.`,
        );
      }

      if (values.length >= maxColumns) {
        if (value.trim() !== '') {
          throw new ImportFileError(
            `Row ${sheetRow} has more than ${maxColumns} columns. Delete the columns you do not need and try again.`,
          );
        }
      } else {
        values.push(value);
      }

      if (index >= length) break;
      const code = text.charCodeAt(index);
      if (code === delimiter) {
        index += 1;
        if (index >= length) {
          if (values.length < maxColumns) values.push('');
          break;
        }
        continue;
      }
      // A line end: CRLF, LF or a lone CR.
      index += code === CR && text.charCodeAt(index + 1) === LF ? 2 : 1;
      break;
    }

    if (values.every((value) => value.trim() === '')) continue;

    if (rows.length >= LEAD_IMPORT_ROW_CAP) {
      moreRows = true;
      break;
    }

    rows.push({
      sheetRow,
      cells: values.map((value) => (value.trim() === '' ? BLANK_CELL : { k: 's', s: value })),
    });
  }

  return { sheetNames: [], sheetName: null, rows, moreRows };
}

/* -------------------------------------------------------------------------- */
/* A cell as a lead field                                                      */
/* -------------------------------------------------------------------------- */

export type FieldText = {
  /** The text to validate, or null for "nothing". */
  value: string | null;
  /** Refuses the row, against this field. */
  error?: string;
  /** Imports the row, with this explanation. */
  warning?: string;
  /** A second number found in a phone cell. */
  secondPhone?: string;
};

/** Fields a person reads back; text in them must not be able to run as a formula. */
const FORMULA_GUARDED: ReadonlySet<LeadImportField> = new Set([
  'customerName',
  'firstName',
  'lastName',
  'city',
  'address',
  'productInterest',
  'summaryNote',
]);

const REQUIRED_FIELDS: ReadonlySet<LeadImportField> = new Set([
  'customerName',
  'firstName',
  'lastName',
  'phone',
]);

const SCIENTIFIC = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i;
const TRAILING_ZERO_DECIMAL = /^(\d{7,15})\.0+$/;
const PHONE_SEPARATOR = /\s*(?:[/,;|]|\bor\b)\s*/i;

/**
 * True when text would execute as a formula once a lead export is opened in Excel:
 * starting with `=` or `@`, or `+`/`-` followed by something other than a space. The
 * admin web's CSV export writes values as they are, so this has to be stopped on the way
 * in.
 */
export function looksLikeFormula(value: string): boolean {
  const first = value.charAt(0);
  if (first === '=' || first === '@') return true;
  if ((first === '+' || first === '-') && value.length > 1 && !/\s/.test(value.charAt(1))) {
    return true;
  }
  return false;
}

function cleanText(value: string): string {
  return value.replace(ZERO_WIDTH, '').trim();
}

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/**
 * Turns one cell into the text a lead field will be validated with — the spreadsheet
 * artefacts the create schema never anticipated, handled here.
 *
 * Phones:
 * - a numeric cell must be a whole number of at most 15 digits; JS writes those without
 *   an exponent, so the digits are exact (a lost leading 0 or + does not matter — the
 *   duplicate key is the trailing digits)
 * - a date-formatted cell, or text in scientific notation, is refused: `9.88E+09` has
 *   already lost digits and is never "repaired"
 * - `9876543210.0` (pandas, Google Sheets) loses the `.0`; a leading apostrophe goes
 * - two numbers in one cell (`/`, `,`, `;`, `|` or "or") are split; the caller decides
 *   where the second one goes
 *
 * Text: date cells become `YYYY-MM-DD` with a warning, error cells become nothing with a
 * warning, and the formula guard applies to the fields people read back.
 *
 * Optional fields treat "N/A", "-", "none" and the like as empty.
 */
export function cellToFieldText(field: LeadImportField, cell: Cell | undefined): FieldText {
  const source = cell ?? BLANK_CELL;
  const isPhone = field === 'phone' || field === 'alternatePhone';
  const optional = !REQUIRED_FIELDS.has(field);

  if (source.k === 'blank' || source.s === null) return { value: null };

  if (source.k === 'e') {
    const message = `The cell showed an Excel error (${source.s}).`;
    return optional ? { value: null, warning: message } : { value: null, error: message };
  }

  if (isPhone) {
    if (source.k === 'd') {
      return { value: source.s, error: 'This looks like a date, not a phone number.' };
    }
    if (source.k === 'b') {
      return { value: source.s, error: 'Enter a valid phone number.' };
    }
    if (source.k === 'n' && source.n !== undefined) {
      const number = source.n;
      if (!Number.isInteger(number) || number < 0 || number >= 1e15) {
        return { value: source.s, error: 'Enter a valid phone number.' };
      }
      return { value: String(number) };
    }

    let text = cleanText(source.s);
    if (text.startsWith("'")) text = text.slice(1).trim();
    if (optional && NULL_TOKENS.has(normaliseHeader(text))) return { value: null };

    if (SCIENTIFIC.test(text.replace(/\s+/g, ''))) {
      return {
        value: text,
        error: `This number is in scientific notation (${text}) and has lost digits. Format the column as Text in Excel and enter the number again.`,
      };
    }

    const decimal = TRAILING_ZERO_DECIMAL.exec(text);
    if (decimal) text = decimal[1]!;

    const parts = text.split(PHONE_SEPARATOR).filter((part) => part.length > 0);
    if (parts.length >= 2 && parts.every((part) => digitCount(part) >= 7)) {
      const first = parts[0]!;
      const second = parts[1]!;
      return { value: first, secondPhone: second };
    }

    return { value: text.length > 0 ? text : null };
  }

  let text: string;
  let warning: string | undefined;

  if (source.k === 'd') {
    text = source.s;
    warning = `An Excel date was saved as ${source.s}.`;
  } else {
    text = cleanText(source.s);
  }

  if (optional && NULL_TOKENS.has(normaliseHeader(text))) return { value: null };

  if (FORMULA_GUARDED.has(field) && looksLikeFormula(text)) {
    return { value: text, error: 'Text cannot start with "=", "+", "-" or "@".' };
  }

  return warning ? { value: text, warning } : { value: text };
}

/** `2000` → `2,000`, the way the admin screens write counts. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-IN');
}
