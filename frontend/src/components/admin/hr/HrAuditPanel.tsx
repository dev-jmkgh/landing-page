'use client';

import { useCallback, useEffect, useState } from 'react';
import { CellStack, DataTable, type Column } from '@/components/admin/DataTable';
import { Icon } from '@/components/ui/Icon';
import {
  HR_APP_ACTOR_PREFIX,
  HR_AUDIT_ACTION_GROUPS,
  HR_AUDIT_ENTITY_LABELS,
  auditActionLabel,
  auditEntityLabel,
  hrReportsApi,
  type HrAuditRecord,
} from '@/lib/hrReports';
import { DateTimeCell, Tag } from '../telecalling/shared';
import { AuditMeta } from './reports/AuditMeta';
import { DateRangeFields } from './reports/filters';
import { ReportFrame } from './reports/ReportFrame';
import {
  RestrictedPanel,
  plural,
  readUrlDate,
  readUrlPage,
  readUrlParam,
  useServerData,
  useUrlParams,
} from './reports/shared';

/**
 * The HR audit trail — every administrative change to HR data, and every decision a
 * manager took in the HR app, newest first. ADMINISTRATORS ONLY.
 *
 * It is the `hr_*` slice of the one `audit_logs` table the telecalling admin also writes
 * to; the server does the slicing (with the underscore escaped, so no other product's
 * entries can leak in), so this screen never sees a telecalling row.
 *
 * Each entry's details — the record's values before and after, the request's address —
 * open in place under its summary, so reading one entry never loses the reader's place
 * in the list.
 */

const PAGE_SIZE = 30;

function isHrAppActor(entry: HrAuditRecord): boolean {
  return (entry.actorLabel ?? '').startsWith(HR_APP_ACTOR_PREFIX);
}

/**
 * Where the action was taken. `actor_type` alone cannot say: an HR-app manager is filed as
 * `employee` (the table's enum has no HR value) with a label starting "HR app:", and an
 * administrator signed in through the telecalling app's token is also `employee`.
 */
function actorSource(entry: HrAuditRecord): { label: string; tone: 'progress' | 'neutral' } {
  if (isHrAppActor(entry)) return { label: 'HR app', tone: 'progress' };
  if (entry.actorType === 'admin') return { label: 'Admin portal', tone: 'neutral' };
  if (entry.actorType === 'system') return { label: 'System', tone: 'neutral' };
  return { label: 'Telecalling app sign-in', tone: 'neutral' };
}

const COLUMNS: Column<HrAuditRecord>[] = [
  {
    key: 'when',
    header: 'When',
    width: '8rem',
    render: (entry) => <DateTimeCell value={entry.createdAt} />,
  },
  {
    key: 'who',
    header: 'Who',
    width: '14rem',
    render: (entry) => {
      const source = actorSource(entry);
      // The label is stored on the row, so it still reads correctly after an account is gone.
      const label = entry.actorLabel
        ? isHrAppActor(entry)
          ? entry.actorLabel.slice(HR_APP_ACTOR_PREFIX.length).trim()
          : entry.actorLabel
        : null;
      return (
        <CellStack primary={label ? <span className="hr-rep-wrap">{label}</span> : <span className="tc-muted">System</span>}>
          <Tag tone={source.tone}>{source.label}</Tag>
        </CellStack>
      );
    },
  },
  {
    key: 'action',
    header: 'Action',
    width: '13rem',
    render: (entry) => (
      <CellStack
        primary={auditActionLabel(entry.action)}
        secondary={
          <>
            {auditEntityLabel(entry.entityType)}
            {entry.entityId !== null ? ` #${entry.entityId}` : ''}
          </>
        }
      />
    ),
  },
  {
    key: 'summary',
    header: 'Summary',
    render: (entry) => (
      <div className="hr-audit-summary">
        <p className="hr-audit-summary__text">{entry.summary}</p>
        <AuditMeta entry={entry} />
      </div>
    ),
  },
];

export function HrAuditPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [action, setAction] = useState(() => readUrlParam('audit-action') ?? '');
  const [entityType, setEntityType] = useState(() => readUrlParam('audit-type') ?? '');
  const [search, setSearch] = useState(() => (readUrlParam('audit-q') ?? '').slice(0, 120));
  const [q, setQ] = useState(search.trim());
  const [range, setRange] = useState(() => ({ from: readUrlDate('audit-from'), to: readUrlDate('audit-to') }));
  const [page, setPage] = useState(() => readUrlPage('audit-page'));

  useUrlParams({
    'audit-action': action || null,
    'audit-type': entityType || null,
    'audit-q': q || null,
    'audit-from': range.from || null,
    'audit-to': range.to || null,
    'audit-page': page > 1 ? String(page) : null,
  });

  // The search box commits after a pause; the page restarts with it.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === q) return;
    const timer = window.setTimeout(() => {
      setQ(trimmed);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, q]);

  const query = {
    action: action || undefined,
    entityType: entityType || undefined,
    q: q || undefined,
    from: range.from || undefined,
    to: range.to || undefined,
  };

  const result = useServerData(
    JSON.stringify(['audit', query, page]),
    (signal) => hrReportsApi.audit({ ...query, page, pageSize: PAGE_SIZE }, signal),
    onUnauthorized,
    'Could not load the audit log.',
  );

  const narrowed = Boolean(action || entityType || q || range.from || range.to);

  const clear = useCallback(() => {
    setAction('');
    setEntityType('');
    setSearch('');
    setQ('');
    setRange({ from: '', to: '' });
    setPage(1);
  }, []);

  // An action or type from a pasted link that the lists do not know is still offered, so the
  // select shows the filter that is actually in force.
  const knownAction = HR_AUDIT_ACTION_GROUPS.some((group) => group.actions.some(([code]) => code === action));
  const knownEntity = entityType in HR_AUDIT_ENTITY_LABELS;

  // A role gate, not a fault: no filters to offer, nothing to retry.
  if (result.status === 403) {
    return (
      <RestrictedPanel
        title="The audit log is for administrators"
        message="Only an administrator can read the HR audit trail. Ask an administrator if you need to know who changed something."
      />
    );
  }

  return (
    <>
      <div className="admin-toolbar hr-rep-toolbar">
        <div className="admin-filters">
          <div className="field hr-rep-field--select hr-rep-field--wide">
            <label className="field__label" htmlFor="hr-audit-action">
              Action
            </label>
            <select
              id="hr-audit-action"
              className="select"
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Any action</option>
              {action && !knownAction ? <option value={action}>{auditActionLabel(action)}</option> : null}
              {HR_AUDIT_ACTION_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.actions.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="field hr-rep-field--select">
            <label className="field__label" htmlFor="hr-audit-entity">
              Record type
            </label>
            <select
              id="hr-audit-entity"
              className="select"
              value={entityType}
              onChange={(event) => {
                setEntityType(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Any record</option>
              {entityType && !knownEntity ? <option value={entityType}>{auditEntityLabel(entityType)}</option> : null}
              {Object.entries(HR_AUDIT_ENTITY_LABELS)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
            </select>
          </div>

          <div className="field hr-rep-field--search">
            <label className="field__label" htmlFor="hr-audit-search">
              Search
            </label>
            <input
              id="hr-audit-search"
              className="input"
              type="search"
              placeholder="Summary, person or action"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <DateRangeFields
            idPrefix="hr-audit"
            from={range.from}
            to={range.to}
            onChange={(next) => {
              setRange(next);
              setPage(1);
            }}
            errors={result.fieldErrors}
          />

          {narrowed ? (
            <button type="button" className="btn btn--ghost" onClick={clear}>
              Clear filters
            </button>
          ) : null}

          <button type="button" className="btn btn--outline" onClick={result.reload} disabled={result.loading}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      <ReportFrame
        result={result}
        page={page}
        onPage={setPage}
        noun="entry"
        nounPlural="entries"
        caption={(data) => `${plural(data.total, 'entry', 'entries')}${narrowed ? ' match these filters' : ''} · newest first`}
        download={null}
        empty={{
          title: narrowed ? 'No entries match' : 'Nothing logged yet',
          message: narrowed
            ? 'No HR audit entry matches these filters. Clear them to see the whole trail.'
            : 'Changes to employees, attendance, leave, requests, documents, payroll and settings are recorded here.',
        }}
        onClear={narrowed ? clear : undefined}
        restricted={{
          title: 'The audit log is for administrators',
          message: 'Only an administrator can read the HR audit trail. Ask an administrator if you need to know who changed something.',
        }}
      >
        {(data) => (
          <DataTable
            rows={data.items}
            rowKey={(entry) => entry.id}
            columns={COLUMNS}
            minWidth="60rem"
            caption="HR audit trail, newest first"
          />
        )}
      </ReportFrame>
    </>
  );
}
