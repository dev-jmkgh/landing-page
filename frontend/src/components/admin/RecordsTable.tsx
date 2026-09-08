'use client';

import { useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
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
      className="select select--sm"
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
    <DataTable
      rows={rows}
      rowKey={(row) => row.id}
      rowBusy={(row) => busyId === row.id}
      minWidth="62rem"
      caption="Enquiries"
      columns={[
        {
          key: 'reference',
          header: 'Reference',
          width: '9rem',
          render: (row) => (
            <CellStack
              primary={<code style={{ fontSize: '0.82rem' }}>{row.reference}</code>}
              secondary={row.source}
            />
          ),
        },
        {
          key: 'contact',
          header: 'Contact',
          width: '15rem',
          render: (row) => (
            <CellStack primary={row.name}>
              <a href={`mailto:${row.email}`}>{row.email}</a>
              <a href={`tel:${row.phone.replace(/\s/g, '')}`}>{row.phone}</a>
              {row.company ? <span className="cell-stack__secondary">{row.company}</span> : null}
            </CellStack>
          ),
        },
        {
          /* No width: the interest text absorbs the leftover space. */
          key: 'interest',
          header: 'Interested in',
          render: (row) => row.interestedIn,
        },
        {
          key: 'received',
          header: 'Received',
          width: '11rem',
          nowrap: true,
          render: (row) => formatDate(row.createdAt),
        },
        {
          key: 'status',
          header: 'Status',
          width: '11rem',
          render: (row) => (
            <StatusSelect
              value={row.status}
              options={ENQUIRY_STATUSES}
              disabled={busyId === row.id}
              onChange={(status) => onStatusChange(row.id, status)}
            />
          ),
        },
        {
          key: 'details',
          header: <span className="sr-only">Details</span>,
          align: 'end',
          width: '6rem',
          render: (row) => (
            <>
              <CellActions>
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  onClick={() => setExpanded((current) => (current === row.id ? null : row.id))}
                  aria-expanded={expanded === row.id}
                >
                  {expanded === row.id ? 'Hide' : 'View'}
                </button>
              </CellActions>

              {expanded === row.id ? (
                <div className="admin-detail" style={{ marginTop: '0.75rem', textAlign: 'start' }}>
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
            </>
          ),
        },
      ]}
    />
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
    <DataTable
      rows={rows}
      rowKey={(row) => row.id}
      rowBusy={(row) => busyId === row.id}
      minWidth="64rem"
      caption="Career applications"
      columns={[
        {
          key: 'reference',
          header: 'Reference',
          width: '9rem',
          render: (row) => <code style={{ fontSize: '0.82rem' }}>{row.reference}</code>,
        },
        {
          key: 'applicant',
          header: 'Applicant',
          width: '15rem',
          render: (row) => (
            <CellStack primary={row.fullName}>
              <a href={`mailto:${row.email}`}>{row.email}</a>
              <a href={`tel:${row.phone.replace(/\s/g, '')}`}>{row.phone}</a>
            </CellStack>
          ),
        },
        {
          key: 'position',
          header: 'Position',
          render: (row) => row.position,
        },
        {
          key: 'received',
          header: 'Received',
          width: '11rem',
          nowrap: true,
          render: (row) => formatDate(row.createdAt),
        },
        {
          key: 'status',
          header: 'Status',
          width: '11rem',
          render: (row) => (
            <StatusSelect
              value={row.status}
              options={APPLICATION_STATUSES}
              disabled={busyId === row.id}
              onChange={(status) => onStatusChange(row.id, status)}
            />
          ),
        },
        {
          key: 'actions',
          header: <span className="sr-only">Actions</span>,
          align: 'end',
          width: '12rem',
          render: (row) => (
            <>
              <CellActions>
                {row.resumeFilename ? (
                  <a className="btn btn--outline btn--sm" href={resumeUrl(row.id)}>
                    <Icon name="download" size={15} />
                    Resume
                  </a>
                ) : (
                  <span className="cell-stack__secondary">No file</span>
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
              </CellActions>

              {expanded === row.id && row.message ? (
                <p style={{ marginTop: '0.75rem', whiteSpace: 'pre-wrap', textAlign: 'start' }}>
                  {row.message}
                </p>
              ) : null}
            </>
          ),
        },
      ]}
    />
  );
}
