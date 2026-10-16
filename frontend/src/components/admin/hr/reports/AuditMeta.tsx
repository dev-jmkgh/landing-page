'use client';

import type { HrAuditRecord } from '@/lib/hrReports';

/**
 * An audit entry's details, opened in place under its summary.
 *
 * A native `<details>`: it is a button to a keyboard and a screen reader without any
 * script, and opening one entry never moves the reader's place in the list.
 *
 * When the entry recorded `before` and `after` objects (an employee edit, an applied
 * profile update, a corrected day), they are laid out side by side with the fields that
 * changed marked, because that is the question the trail is opened to answer. Everything
 * else the entry carries is shown as formatted JSON, exactly as stored — nothing is
 * dropped or reworded.
 */

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `joiningDate` → "Joining date", `departmentId` → "Department id". */
function fieldLabel(key: string): string {
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function Value({ value }: { value: unknown }) {
  if (value === undefined) return <span className="tc-muted">—</span>;
  if (value === null || value === '') return <span className="tc-muted">Empty</span>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'string' || typeof value === 'number') return <span className="hr-rep-wrap">{String(value)}</span>;
  return <code className="hr-audit-details__code">{JSON.stringify(value)}</code>;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ChangeTable({ before, after }: { before: Plain | null; after: Plain | null }) {
  const keys = [...new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})])];
  if (keys.length === 0) return null;

  return (
    <table className="hr-audit-changes">
      <caption className="sr-only">Values before and after the change</caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => {
          const from = before ? before[key] : undefined;
          const to = after ? after[key] : undefined;
          const changed = !same(from, to);
          return (
            <tr key={key} data-changed={changed ? 'true' : undefined}>
              <th scope="row">
                {fieldLabel(key)}
                {changed ? <span className="sr-only"> (changed)</span> : null}
              </th>
              <td>
                <Value value={from} />
              </td>
              <td>
                <Value value={to} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AuditMeta({ entry }: { entry: HrAuditRecord }) {
  const meta = entry.meta;
  const before = meta && isPlain(meta.before) ? meta.before : null;
  const after = meta && isPlain(meta.after) ? meta.after : null;
  const hasChange = before !== null || after !== null;

  const rest: Plain | null = meta
    ? Object.fromEntries(Object.entries(meta).filter(([key]) => !hasChange || (key !== 'before' && key !== 'after')))
    : null;
  const hasRest = rest !== null && Object.keys(rest).length > 0;

  if (!hasChange && !hasRest && !entry.ipAddress) return null;

  return (
    <details className="hr-audit-details">
      <summary>
        Details<span className="sr-only"> of this entry</span>
      </summary>
      <div className="hr-audit-details__body">
        {hasChange ? <ChangeTable before={before} after={after} /> : null}
        {hasRest ? <pre className="hr-audit-details__json">{JSON.stringify(rest, null, 2)}</pre> : null}
        {entry.ipAddress ? <p className="hr-audit-details__ip">From address {entry.ipAddress}</p> : null}
      </div>
    </details>
  );
}
