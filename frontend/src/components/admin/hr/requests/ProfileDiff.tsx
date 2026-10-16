'use client';

import { formatCalendarDate } from '@/lib/hrLeave';
import {
  PROFILE_UPDATE_FIELDS,
  PROFILE_UPDATE_LABELS,
  type ProfileUpdateField,
  type ProfileUpdatePayload,
} from '@/lib/hrRequests';
import { Tag } from '../../telecalling/shared';

/**
 * A profile update as "current → requested", one row per field the employee asked to
 * change.
 *
 * `current` is what the employee's record holds NOW, read by the server when the request
 * was opened — so on an open request it is the before, and resolving writes the
 * requested column over it. A requested `null` clears the field, and says so: an empty
 * cell would read as "nothing asked for".
 *
 * Only the keys present in the payload are listed. A field the employee did not mention
 * is left alone by the resolution, so showing it would suggest a change that will not
 * happen.
 */

export type ProfileChange = {
  field: ProfileUpdateField;
  label: string;
  current: string | null;
  requested: string | null;
  same: boolean;
};

function display(field: ProfileUpdateField, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return field === 'dateOfBirth' ? formatCalendarDate(value) : value;
}

/** The rows of the diff, in a fixed order — the same order everywhere it is shown. */
export function profileChanges(
  payload: ProfileUpdatePayload | null,
  current: ProfileUpdatePayload | null,
): ProfileChange[] {
  if (!payload) return [];
  return PROFILE_UPDATE_FIELDS.filter((field) => payload[field] !== undefined).map((field) => {
    const requested = payload[field] ?? null;
    const now = current?.[field] ?? null;
    return {
      field,
      label: PROFILE_UPDATE_LABELS[field],
      current: display(field, now),
      requested: display(field, requested),
      same: (now ?? '') === (requested ?? ''),
    };
  });
}

export function ProfileDiffTable({
  changes,
  applied,
  caption,
}: {
  changes: ProfileChange[];
  /** The request is resolved: the requested values are on the record now. */
  applied: boolean;
  caption: string;
}) {
  if (changes.length === 0) {
    return <p className="tc-muted">The request does not name any detail to change.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table hrl-diff">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col style={{ width: '12rem' }} />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Detail</th>
            <th scope="col">{applied ? 'On record now' : 'Current'}</th>
            <th scope="col">Requested</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.field} data-same={change.same ? 'true' : undefined}>
              <th scope="row" className="hrl-diff__label">
                {change.label}
              </th>
              <td className="hrl-diff__current">
                {change.current ?? <span className="tc-muted">Not set</span>}
              </td>
              <td className="hrl-diff__requested">
                <span className="sr-only">changes to </span>
                {change.requested ?? <em className="tc-muted">Cleared</em>}
                {change.same && !applied ? (
                  <>
                    {' '}
                    <Tag>Same as now</Tag>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
