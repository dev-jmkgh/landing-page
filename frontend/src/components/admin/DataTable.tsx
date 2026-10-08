'use client';

import type { MouseEvent, ReactNode } from 'react';

/**
 * The one table in the admin area.
 *
 * Every telecalling panel previously hand-wrote `<table className="table">` with its own
 * `<thead>`. `.table` is not defined in any stylesheet — the styled class is
 * `.data-table`, which only `RecordsTable` used — so ten of the eleven admin tables
 * rendered with browser defaults: `<th>` centred, `<td>` left-aligned, and column widths
 * distributed by content. That is the misalignment: a centred "Customer" heading sitting
 * over left-aligned names, and an Actions column three times wider than it needed to be.
 *
 * Fixing the stylesheet alone would have left eleven copies of the markup free to drift
 * again. Describing a table as columns instead makes the failure impossible to
 * reintroduce: a header and its cells share one `align`, so they cannot disagree, and
 * width is declared once per column rather than inferred from whatever happens to be in
 * the longest row.
 */

export type Column<T> = {
  /** Stable identity for the column. Also the React key. */
  key: string;
  header: ReactNode;
  /**
   * Applied to the header AND the cells, which is the whole point — these were the two
   * things that used to disagree. Defaults to `start`.
   *
   * Use `end` for money and counts so digits line up on the decimal, and `center` only
   * for a single glyph or badge, never for text.
   */
  align?: 'start' | 'end' | 'center';
  /**
   * A CSS width for the column, emitted into a `<colgroup>`.
   *
   * Optional, and best used sparingly: give a width to the columns that should not grow
   * (a date, a status, an action group) and leave the one that should absorb the
   * remaining space (usually a note or a name) alone.
   */
  width?: string;
  /** Set on a column whose content must not wrap — a date, a phone number, a button row. */
  nowrap?: boolean;
  render: (row: T) => ReactNode;
};

/**
 * Elements whose own clicks must never be read as "open this row".
 *
 * A double-click on the status select, the owner select or the bulk tick box is someone
 * operating that control twice, not asking for the record. `data-no-row-activate` lets a
 * cell opt any other element out explicitly.
 */
const ROW_ACTIVATION_EXCLUDED =
  'a, button, input, select, textarea, label, audio, video, summary, [role="button"], [contenteditable="true"], [data-no-row-activate]';

function startsOnControl(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  return target instanceof Element && target.closest(ROW_ACTIVATION_EXCLUDED) !== null;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowBusy,
  rowTone,
  minWidth = '46rem',
  caption,
  onRowDoubleClick,
  rowTitle,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  /** Marks a row as having an action in flight. */
  rowBusy?: (row: T) => boolean;
  /** Optional per-row emphasis, e.g. flagging an overdue follow-up. */
  rowTone?: (row: T) => 'bad' | 'warn' | undefined;
  /**
   * The width below which the wrapper scrolls horizontally rather than crushing the
   * columns. Wider tables need a larger value than the 46rem default.
   */
  minWidth?: string;
  /** Screen-reader description. Visually hidden. */
  caption?: string;
  /**
   * Opens the row's record on a double-click.
   *
   * A double-click rather than a single click because the dense telecalling tables
   * already give single clicks to inline controls — status and owner selects, the bulk
   * tick box — and a row that navigated on every click would fire on all of them.
   * Opt-in, so every table that does not pass it (RecordsTable included) is unchanged.
   *
   * This is a shortcut, never the only way in: a double-click is invisible to a keyboard
   * and to a screen reader, so a table that uses it must also render a real link to the
   * same record (the customer name, in the lead tables).
   */
  onRowDoubleClick?: (row: T) => void;
  /** Hover hint for a double-clickable row, e.g. "Double-click to open the lead". */
  rowTitle?: (row: T) => string | undefined;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table" style={{ minWidth }}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}

        {/*
          `<colgroup>` rather than a width on each `<th>`. It sizes the column once for
          the whole table, so a long note in row nine cannot widen the Due column, and
          the header stays over its own cells.
        */}
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{ textAlign: column.align ?? 'start' }}
                data-nowrap={column.nowrap ? 'true' : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => {
            const tone = rowTone?.(row);

            return (
              <tr
                key={rowKey(row)}
                aria-busy={rowBusy?.(row) ? true : undefined}
                data-tone={tone}
                data-activatable={onRowDoubleClick ? 'true' : undefined}
                title={onRowDoubleClick ? rowTitle?.(row) : undefined}
                onMouseDown={
                  onRowDoubleClick
                    ? (event) => {
                        /*
                         * The second press of a double-click selects the word under the
                         * pointer, which would flash a highlight across the cell just as
                         * the record opens. Suppressing that default only for the second
                         * press keeps an ordinary drag-select working, so a phone number
                         * can still be copied out of a row.
                         */
                        if (event.detail > 1 && !startsOnControl(event)) event.preventDefault();
                      }
                    : undefined
                }
                onDoubleClick={
                  onRowDoubleClick
                    ? (event) => {
                        if (startsOnControl(event)) return;
                        onRowDoubleClick(row);
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={{ textAlign: column.align ?? 'start' }}
                    data-nowrap={column.nowrap ? 'true' : undefined}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A cell holding a primary value with a quieter second line beneath.
 *
 * Extracted because six of the eleven tables built this by hand out of `<strong>`, a
 * `<br />` and a muted `<span>`. A `<br />` between two different kinds of information
 * is a layout instruction standing in for a structure, and it gave no way to control the
 * spacing between the two lines.
 */
export function CellStack({
  primary,
  secondary,
  children,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  /** Badges or tags, laid out in a row beneath the secondary line. */
  children?: ReactNode;
}) {
  return (
    <div className="cell-stack">
      <span className="cell-stack__primary">{primary}</span>
      {secondary ? <span className="cell-stack__secondary">{secondary}</span> : null}
      {children ? <span className="cell-stack__extra">{children}</span> : null}
    </div>
  );
}

/**
 * The action group in a table's last column.
 *
 * Wraps rather than overflows, and keeps its buttons from being stretched by the cell.
 */
export function CellActions({ children }: { children: ReactNode }) {
  return <div className="cell-actions">{children}</div>;
}
