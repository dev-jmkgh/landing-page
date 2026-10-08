import { escapeHtml, escapeHtmlMultiline } from '../../../utils/text';
import { BRAND } from './brand';

/**
 * Content building blocks shared by the templates.
 *
 * Every function here escapes what it is given. No template is allowed to interpolate
 * a user-supplied value into HTML by itself — that rule is what keeps a cover letter
 * containing `<script>` or `<img onerror=…>` from becoming markup in an inbox.
 */

const { colours } = BRAND;

export type DetailRow = {
  label: string;
  value: string | null | undefined;
  /** Preserve line breaks — for messages and cover letters. */
  multiline?: boolean;
  /** Render as a mailto:/https: link. Only ever used for values we have validated. */
  link?: 'email' | 'url';
};

function usable(row: DetailRow): row is DetailRow & { value: string } {
  return typeof row.value === 'string' && row.value.trim().length > 0;
}

function renderValue(row: DetailRow & { value: string }): string {
  if (row.link === 'email') {
    const address = encodeURI(`mailto:${row.value}`);
    return `<a href="${escapeHtml(address)}" style="color:${colours.navySoft};">${escapeHtml(row.value)}</a>`;
  }

  if (row.link === 'url') {
    // Only http(s) becomes a link; anything else is shown as inert text so a
    // `javascript:` value supplied by an applicant cannot become clickable.
    const safe = /^https?:\/\//i.test(row.value);
    return safe
      ? `<a href="${escapeHtml(encodeURI(row.value))}" style="color:${colours.navySoft};">${escapeHtml(row.value)}</a>`
      : escapeHtml(row.value);
  }

  return row.multiline ? escapeHtmlMultiline(row.value) : escapeHtml(row.value);
}

/** A label/value table. Empty values are dropped rather than shown blank. */
export function detailTable(rows: DetailRow[]): string {
  const body = rows
    .filter(usable)
    .map(
      (row) => `
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid ${colours.line};color:${colours.muted};font-size:13px;width:150px;vertical-align:top;">${escapeHtml(row.label)}</td>
                  <td style="padding:10px 0;border-bottom:1px solid ${colours.line};font-size:14px;vertical-align:top;word-break:break-word;">${renderValue(row)}</td>
                </tr>`,
    )
    .join('');

  if (!body) return '';

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}
              </table>`;
}

export function paragraph(text: string, options: { muted?: boolean; size?: number } = {}): string {
  const colour = options.muted ? colours.muted : colours.ink;
  const size = options.size ?? 15;
  return `
              <p style="margin:0 0 16px;font-size:${size}px;line-height:1.6;color:${colour};">${escapeHtml(text)}</p>`;
}

/** A prominent reference number block. */
export function referenceBlock(label: string, reference: string): string {
  return `
              <p style="margin:0 0 6px;font-size:13px;color:${colours.muted};">${escapeHtml(label)}</p>
              <p style="margin:0 0 20px;font-size:18px;font-weight:700;letter-spacing:1px;color:${colours.ink};">${escapeHtml(reference)}</p>`;
}

/** Good news, a caution, bad news — or the neutral accent the confirmations use. */
export type CalloutTone = 'accent' | 'good' | 'warn' | 'bad';

const CALLOUT_TONES: Record<CalloutTone, { border: string; background: string; text: string }> = {
  accent: { border: colours.accent, background: colours.panel, text: colours.muted },
  good: { border: colours.good, background: colours.goodSoft, text: colours.ink },
  warn: { border: colours.warn, background: colours.warnSoft, text: colours.ink },
  bad: { border: colours.bad, background: colours.badSoft, text: colours.ink },
};

/**
 * A tinted callout: the "we received it" confirmation banner, the daily report's "needs
 * attention" panel.
 *
 * `body` may be several lines, each escaped and set on a line of its own. `tone` is
 * optional and defaults to the accent every existing caller was written against, so
 * their markup is unchanged. A toned callout sets its text in ink rather than grey: there
 * the body is the message, not a gloss on the heading.
 */
export function callout(
  heading: string,
  body: string | readonly string[],
  tone: CalloutTone = 'accent',
): string {
  const { border, background, text } = CALLOUT_TONES[tone];
  const content = typeof body === 'string' ? escapeHtml(body) : body.map(escapeHtml).join('<br />');

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${background};border-left:3px solid ${border};border-radius:4px;">
                <tr>
                  <td style="padding:16px 18px;">
                    <div style="font-size:15px;font-weight:700;color:${colours.ink};">${escapeHtml(heading)}</div>
                    <div style="margin-top:6px;font-size:14px;line-height:1.6;color:${text};">${content}</div>
                  </td>
                </tr>
              </table>`;
}

/** A small capitalised heading that opens a section of a longer message. */
export function sectionHeading(text: string): string {
  return `
              <h2 style="margin:28px 0 10px;font-size:13px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${colours.navySoft};">${escapeHtml(text)}</h2>`;
}

/* -------------------------------------------------------------------------- */
/* Figures and tables                                                          */
/* -------------------------------------------------------------------------- */

export type MetricTone = 'default' | 'good' | 'warn' | 'bad';

export type MetricTile = {
  label: string;
  /** Already formatted — `'1,204'`, `'2h 5m'`, `'—'`. */
  value: string;
  /** One short line under the label, e.g. `'9 out · 3 in'`. */
  hint?: string | null;
  tone?: MetricTone;
};

const METRIC_TONES: Record<MetricTone, { border: string; background: string }> = {
  default: { border: colours.line, background: colours.panel },
  good: { border: colours.good, background: colours.goodSoft },
  warn: { border: colours.warn, background: colours.warnSoft },
  bad: { border: colours.bad, background: colours.badSoft },
};

function metricCell(tile: MetricTile, width: string): string {
  const { border, background } = METRIC_TONES[tile.tone ?? 'default'];
  const hint = tile.hint
    ? `
                          <div style="margin-top:2px;font-size:11px;line-height:1.4;color:${colours.muted};">${escapeHtml(tile.hint)}</div>`
    : '';

  return `
                  <td width="${width}" valign="top" style="padding:4px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${background};border-left:3px solid ${border};border-radius:4px;">
                      <tr>
                        <td style="padding:10px 12px;">
                          <div style="font-size:20px;font-weight:700;line-height:1.2;color:${colours.ink};">${escapeHtml(tile.value)}</div>
                          <div style="margin-top:4px;font-size:12px;line-height:1.4;color:${colours.muted};">${escapeHtml(tile.label)}</div>${hint}
                        </td>
                      </tr>
                    </table>
                  </td>`;
}

/**
 * Figure tiles in rows of `perRow`: a large value, its label, an optional hint.
 *
 * Nested tables, not floats or flex — Outlook lays out nothing else reliably. Every tile
 * takes a fixed share of its row, and a short last row is padded with empty cells so its
 * tiles stay the width of the ones above. The tone tints the tile's background and left
 * edge, never the number, so the figure stays legible in every client and in dark mode.
 */
export function metricGrid(tiles: readonly MetricTile[], perRow = 3): string {
  if (tiles.length === 0) return '';

  const columns = Math.min(Math.max(Math.trunc(perRow), 1), 4);
  const width = `${Math.floor(100 / columns)}%`;
  const rows: string[] = [];

  for (let start = 0; start < tiles.length; start += columns) {
    const cells = tiles.slice(start, start + columns).map((tile) => metricCell(tile, width));
    while (cells.length < columns) {
      cells.push(`
                  <td width="${width}" style="padding:4px;"></td>`);
    }
    rows.push(`
                <tr>${cells.join('')}
                </tr>`);
  }

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">${rows.join('')}
              </table>`;
}

export type DataColumn = {
  label: string;
  /** Numbers read right-aligned, so their digits line up. */
  align?: 'left' | 'right';
};

/**
 * One table cell: text, a number (grouped the Indian way, `1,23,456`), or text with a
 * smaller second line under it — an employee's code under their name.
 */
export type DataCell = string | number | { text: string | number; sub?: string | null };

function cellText(value: string | number): string {
  return typeof value === 'number' ? value.toLocaleString('en-IN') : value;
}

function cellParts(cell: DataCell | undefined): { text: string; sub: string | null } {
  if (cell === undefined) return { text: '', sub: null };
  if (typeof cell === 'object') return { text: cellText(cell.text), sub: cell.sub ?? null };
  return { text: cellText(cell), sub: null };
}

/**
 * A multi-column data table: a tinted header, zebra rows, numbers right-aligned.
 *
 * A real table rather than `role="presentation"`, so a screen reader announces columns
 * and headers. Every cell is escaped here — the employee names in it are typed by the
 * employees themselves at sign-up. `emptyText` replaces the body when there are no rows,
 * and `note` is a muted line under the table (e.g. "and 5 more").
 */
export function dataTable(options: {
  columns: readonly DataColumn[];
  rows: readonly (readonly DataCell[])[];
  emptyText?: string;
  note?: string | null;
}): string {
  const { columns, rows } = options;

  const head = columns
    .map((column) => {
      const align = column.align ?? 'left';
      return `
                    <th scope="col" align="${align}" style="padding:8px;background-color:${colours.panel};border-bottom:1px solid ${colours.line};font-size:11px;font-weight:700;line-height:1.3;letter-spacing:0.3px;text-transform:uppercase;color:${colours.muted};text-align:${align};vertical-align:bottom;">${escapeHtml(column.label)}</th>`;
    })
    .join('');

  const body =
    rows.length === 0
      ? `
                  <tr>
                    <td colspan="${columns.length}" style="padding:12px 8px;font-size:13px;color:${colours.muted};">${escapeHtml(options.emptyText ?? 'Nothing to show.')}</td>
                  </tr>`
      : rows
          .map((row, index) => {
            const background = index % 2 === 1 ? colours.panel : '#ffffff';
            const cells = columns
              .map((column, columnIndex) => {
                const align = column.align ?? 'left';
                const { text, sub } = cellParts(row[columnIndex]);
                const second = sub
                  ? `<div style="margin-top:1px;font-size:11px;color:${colours.muted};">${escapeHtml(sub)}</div>`
                  : '';
                return `
                    <td align="${align}" style="padding:7px 8px;border-bottom:1px solid ${colours.line};background-color:${background};font-size:12px;line-height:1.4;color:${colours.ink};text-align:${align};vertical-align:top;${align === 'right' ? 'white-space:nowrap;' : 'word-break:break-word;'}">${escapeHtml(text)}${second}</td>`;
              })
              .join('');
            return `
                  <tr>${cells}
                  </tr>`;
          })
          .join('');

  const note = options.note
    ? `
              <p style="margin:6px 0 0;font-size:12px;color:${colours.muted};">${escapeHtml(options.note)}</p>`
    : '';

  return `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${colours.line};border-collapse:collapse;">
                <thead>
                  <tr>${head}
                  </tr>
                </thead>
                <tbody>${body}
                </tbody>
              </table>${note}`;
}

/**
 * The text/plain counterpart of `dataTable`: every column padded to a common width,
 * numbers right-aligned, a rule under the header. Returns one string per line, for
 * `renderText`. A cell's second line follows it in brackets.
 */
export function textTable(
  columns: readonly DataColumn[],
  rows: readonly (readonly DataCell[])[],
): string[] {
  const values = rows.map((row) =>
    columns.map((_column, index) => {
      const { text, sub } = cellParts(row[index]);
      return sub ? `${text} (${sub})` : text;
    }),
  );

  const widths = columns.map((column, index) =>
    Math.max(column.label.length, ...values.map((row) => (row[index] ?? '').length)),
  );

  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        return columns[index]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((column) => column.label)),
    line(widths.map((width) => '-'.repeat(width))),
    ...values.map(line),
  ];
}

/**
 * A call-to-action button.
 *
 * Built as a table with inline styles because that is the only construction Outlook
 * renders reliably — a styled <a> collapses to plain text there. The href is not escaped
 * through escapeHtml: it is a URL this application generated, and HTML-escaping the
 * ampersands in a query string would break it. It is quote-stripped instead so it
 * cannot terminate the attribute.
 */
export function actionButton(label: string, href: string): string {
  const safeHref = href.replace(/"/g, '');
  return `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;">
                  <tr>
                    <td style="background-color:${colours.accent};border-radius:4px;">
                      <a href="${safeHref}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#0a1b2e;text-decoration:none;">${escapeHtml(label)}</a>
                    </td>
                  </tr>
                </table>`;
}

export function signOff(): string {
  return `
              <p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:${colours.ink};">
                Warm regards,<br />${escapeHtml(BRAND.name)}
              </p>`;
}

/** Plain-text rendering of the same rows, for the text/plain alternative. */
export function detailLines(rows: DetailRow[]): string[] {
  return rows.filter(usable).map((row) => `${row.label}: ${row.value}`);
}

const formatter = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'full',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export function formatSubmissionTime(date: Date): string {
  return `${formatter.format(date)} IST`;
}
