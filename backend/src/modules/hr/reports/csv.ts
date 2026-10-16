import type { Response } from 'express';
import { contentDisposition } from '../files/hrFileLinks';

/**
 * CSV for the HR exports (reports here, the payroll run export in payroll/).
 *
 * The files are made to be opened in Excel by HR, so three things are not optional:
 *
 *   - A UTF-8 BOM. Without it Excel reads the bytes as the Windows code page and every
 *     Malayalam, Tamil or accented name turns into mojibake.
 *   - CRLF line endings and RFC 4180 quoting: a field containing a comma, a quote or a
 *     line break is wrapped in quotes with inner quotes doubled.
 *   - Formula neutralising. A cell beginning `=`, `+`, `-`, `@`, tab or CR runs as a
 *     formula when the file is opened, so a name typed as `=HYPERLINK(...)` at signup
 *     would execute on an administrator's machine. Such TEXT is prefixed with an
 *     apostrophe, which Excel shows as plain text. Numbers are written as numbers and
 *     are never prefixed — a negative figure must stay a figure.
 */

export type CsvValue = string | number | boolean | null | undefined;

export const CSV_BOM = '﻿';
const CRLF = '\r\n';

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: CsvValue[]): string {
  return cells.map(csvCell).join(',') + CRLF;
}

/** A whole file in memory — for small, bounded exports. */
export function csvDocument(header: string[], rows: CsvValue[][]): string {
  return CSV_BOM + csvLine(header) + rows.map(csvLine).join('');
}

/**
 * Writes a CSV straight to the response, a batch of rows at a time.
 *
 * Streaming rather than building one string: an attendance export is employees × days,
 * and holding all of it in memory before sending the first byte is how an export of
 * a quarter for the whole company becomes the request that times out. The caller
 * bounds the total (a validated date range), this bounds what is held at once.
 *
 * Headers go out with the FIRST write (or at `end()` for an empty file), not before:
 * a failure on the first batch can then still become an ordinary JSON error. Once a
 * 200 has gone out, an error can only cut the file short — see `started`.
 */
export class CsvStream {
  private opened = false;

  constructor(
    private readonly response: Response,
    private readonly filename: string,
    private readonly header: string[],
  ) {}

  /** True once the status line and the header row have been sent. */
  get started(): boolean {
    return this.opened;
  }

  private open(): void {
    if (this.opened) return;
    this.opened = true;
    this.response.status(200);
    this.response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    this.response.setHeader('Content-Disposition', contentDisposition(this.filename));
    this.response.setHeader('Cache-Control', 'private, no-store');
    this.response.setHeader('X-Content-Type-Options', 'nosniff');
    this.response.write(CSV_BOM + csvLine(this.header));
  }

  /** True once the client has gone away — callers stop reading batches nobody will get. */
  get aborted(): boolean {
    return this.response.destroyed || this.response.writableEnded;
  }

  /** Writes rows, waiting for the socket to drain when its buffer is full. */
  async write(rows: CsvValue[][]): Promise<void> {
    if (rows.length === 0 || this.aborted) return;
    this.open();
    const ok = this.response.write(rows.map(csvLine).join(''));
    if (!ok && !this.response.writableEnded) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.response.off('drain', done);
          this.response.off('close', done);
          resolve();
        };
        this.response.once('drain', done);
        // A client that went away never drains; do not hang the handler on it.
        this.response.once('close', done);
      });
    }
  }

  /** Finishes the file — a header-only file when nothing matched, which is a real answer. */
  end(): void {
    if (this.aborted) return;
    this.open();
    this.response.end();
  }
}
