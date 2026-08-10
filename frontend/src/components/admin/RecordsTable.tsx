'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  ENQUIRY_STATUSES,
  ENQUIRY_STATUS_LABELS,
} from '@/lib/constants';
import type { AdminApplication, AdminEnquiry, RecordStatus } from '@/lib/api';

/**
 * The two record types move through different workflows, so each table offers its own
 * status vocabulary — sharing one list would let an enquiry be marked "hired".
 */
const ALL_LABELS: Record<RecordStatus, string> = {
  ...ENQUIRY_STATUS_LABELS,
  ...APPLICATION_STATUS_LABELS,
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function StatusBadge({ status }: { status: RecordStatus }) {
  return <span className={`status-badge status-badge--${status}`}>{ALL_LABELS[status]}</span>;
}

function StatusSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: RecordStatus;
  options: readonly RecordStatus[];
  disabled: boolean;
  onChange: (status: RecordStatus) => void;
}) {
  return (
    <select
      className="select"
      style={{ minWidth: '9.5rem', padding: '0.4rem 2rem 0.4rem 0.6rem', fontSize: '0.85rem' }}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as RecordStatus)}
      aria-label="Change status"
    >
      {options.map((status) => (
        <option key={status} value={status}>
          {ALL_LABELS[status]}
        </option>
      ))}
    </select>
  );
}

/* -------------------------------------------------------------------------- */

export function EnquiriesTable({
  rows,
  busyId,
  onStatusChange,
}: {
  rows: AdminEnquiry[];
  busyId: number | null;
  onStatusChange: (id: number, status: RecordStatus) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">Enquiries</caption>
        <thead>
          <tr>
            <th scope="col">Reference</th>
            <th scope="col">Contact</th>
            <th scope="col">Interested in</th>
            <th scope="col">Received</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <code style={{ fontSize: '0.82rem' }}>{row.reference}</code>
                <div style={{ color: 'var(--ink-400)', fontSize: '0.78rem' }}>{row.source}</div>
              </td>
              <td>
                <strong>{row.name}</strong>
                <div>
                  <a href={`mailto:${row.email}`}>{row.email}</a>
                </div>
                <div>
                  <a href={`tel:${row.phone.replace(/\s/g, '')}`}>{row.phone}</a>
                </div>
                {row.company ? (
                  <div style={{ color: 'var(--ink-400)' }}>{row.company}</div>
                ) : null}
              </td>
              <td>{row.interestedIn}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDate(row.createdAt)}</td>
              <td>
                <StatusSelect
                  value={row.status}
                  options={ENQUIRY_STATUSES}
                  disabled={busyId === row.id}
                  onChange={(status) => onStatusChange(row.id, status)}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  onClick={() => setExpanded((current) => (current === row.id ? null : row.id))}
                  aria-expanded={expanded === row.id}
                >
                  {expanded === row.id ? 'Hide' : 'View'}
                </button>
                {expanded === row.id ? (
                  <div className="admin-detail" style={{ marginTop: '0.75rem', minWidth: '18rem' }}>
                    <div className="admin-detail__row">
                      <span className="admin-detail__label">Message</span>
                      <span style={{ whiteSpace: 'pre-wrap' }}>{row.message}</span>
                    </div>
                    <div className="admin-detail__row">
                      <span className="admin-detail__label">Last updated</span>
                      <span>{formatDate(row.updatedAt)}</span>
                    </div>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function ApplicationsTable({
  rows,
  busyId,
  onStatusChange,
  resumeUrl,
}: {
  rows: AdminApplication[];
  busyId: number | null;
  onStatusChange: (id: number, status: RecordStatus) => void;
  resumeUrl: (id: number) => string;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">Career applications</caption>
        <thead>
          <tr>
            <th scope="col">Reference</th>
            <th scope="col">Applicant</th>
            <th scope="col">Position</th>
            <th scope="col">Received</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <code style={{ fontSize: '0.82rem' }}>{row.reference}</code>
              </td>
              <td>
                <strong>{row.fullName}</strong>
                <div>
                  <a href={`mailto:${row.email}`}>{row.email}</a>
                </div>
                <div>
                  <a href={`tel:${row.phone.replace(/\s/g, '')}`}>{row.phone}</a>
                </div>
              </td>
              <td>{row.position}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDate(row.createdAt)}</td>
              <td>
                <StatusSelect
                  value={row.status}
                  options={APPLICATION_STATUSES}
                  disabled={busyId === row.id}
                  onChange={(status) => onStatusChange(row.id, status)}
                />
              </td>
              <td>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {row.resumeFilename ? (
                    <a className="btn btn--outline btn--sm" href={resumeUrl(row.id)}>
                      <Icon name="download" size={15} />
                      Resume
                    </a>
                  ) : (
                    <span style={{ color: 'var(--ink-400)', fontSize: '0.82rem' }}>No file</span>
                  )}
                  {row.message ? (
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      onClick={() => setExpanded((current) => (current === row.id ? null : row.id))}
                      aria-expanded={expanded === row.id}
                    >
                      {expanded === row.id ? 'Hide' : 'Message'}
                    </button>
                  ) : null}
                </div>
                {expanded === row.id && row.message ? (
                  <p style={{ marginTop: '0.75rem', whiteSpace: 'pre-wrap', minWidth: '16rem' }}>
                    {row.message}
                  </p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
