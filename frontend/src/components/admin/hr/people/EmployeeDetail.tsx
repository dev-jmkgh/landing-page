'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDialogs } from '@/components/admin/ConfirmDialog';
import { ButtonSpinner, LoadingOverlay } from '@/components/admin/Loader';
import { Tag } from '@/components/admin/telecalling/shared';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/telecalling';
import {
  HR_APPROVAL_LABELS,
  HR_EMPLOYMENT_STATUS_LABELS,
  HR_EMPLOYMENT_TYPE_LABELS,
  HR_ROLE_LABELS,
  WORK_MODE_LABELS,
  hrApi,
  peopleApi,
  type Department,
  type Designation,
  type EmployeePatchResult,
  type HrEmployee,
} from '@/lib/hr';
import { AssignmentDialog } from '../AssignmentDialog';
import { DeleteEmployeeDialog, ResetPasswordDialog, deleteSummary } from './EmployeeAccountDialogs';
import { EditEmployeeDialog, EMPLOYEE_FIELD_LABELS } from './EditEmployeeDialog';
import { EmployeeAttendanceTab } from './EmployeeAttendanceTab';
import { EmployeeCalendarTab } from './EmployeeCalendarTab';
import { EmployeeLeaveTab } from './EmployeeLeaveTab';
import { isAbort } from './shared';

/**
 * One employee: the full record, and their attendance, calendar and leave.
 *
 * Shown in place of the directory rather than in a drawer. The record has four tabs, two
 * of them tables of their own, and a drawer narrow enough to leave the list visible is
 * too narrow for a month calendar. The directory stays mounted (hidden) behind it, so
 * Back returns to the same page, filters and scroll position.
 *
 * Starts from the directory's row so the heading and facts appear at once, then reads the
 * record afresh — someone may have edited it since the list was loaded — along with the
 * direct-report count, which the list does not carry.
 */

type Tab = 'profile' | 'attendance' | 'calendar' | 'leave';

const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'leave', label: 'Leave balances' },
];

/** A value, or the honest "Not recorded" — never a stand-in from some other field. */
function show(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="tc-muted">Not recorded</span>;
  }
  return value;
}

function Facts({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="hrp-facts" aria-label={title}>
      <h3 className="tc-dialog__section-title">{title}</h3>
      <dl className="tc-facts">{children}</dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function EmployeeDetail({
  initial,
  departments,
  designations,
  onBack,
  onChanged,
  onUnauthorized,
}: {
  /** The directory row that was opened. */
  initial: HrEmployee;
  departments: Department[] | null;
  designations: Designation[] | null;
  onBack: () => void;
  /** Something about this employee changed, so the directory behind should reload. */
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const dialogs = useDialogs();
  const [employee, setEmployee] = useState<HrEmployee>(initial);
  const [directReports, setDirectReports] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const heading = useRef<HTMLHeadingElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A screen reader starts reading at the name, as the Lead View does.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);

    try {
      const result = await peopleApi.employee(initial.id, controller.signal);
      setEmployee(result.employee);
      setDirectReports(result.directReports);
      setError(null);
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not load this employee.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [initial.id, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const saved = (result: EmployeePatchResult) => {
    setEditing(false);
    setEmployee(result.employee);
    const fields = result.changed.map((field) => EMPLOYEE_FIELD_LABELS[field] ?? field);
    setNotice(
      [
        fields.length > 0 ? `Saved: ${fields.join(', ')}.` : 'Nothing changed — the record already had those details.',
        result.notice,
      ]
        .filter(Boolean)
        .join(' '),
    );
    onChanged();
    // The direct-report count and names joined from other rows come back with a re-read.
    void load();
  };

  const setActive = async (active: boolean) => {
    if (!active) {
      const confirmed = await dialogs.confirm({
        title: `Switch off ${employee.name}'s HR access?`,
        message:
          'They are signed out of the HR app on every device straight away.\n\nThis does NOT affect any telecalling account they hold — that is a separate login.',
        confirmLabel: 'Switch off',
        danger: true,
      });
      if (!confirmed) return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await hrApi.setActive(employee.id, active);
      setNotice(
        active
          ? `${employee.name} can sign in to the HR app again.`
          : `${employee.name}'s HR access is switched off and their devices are signed out.`,
      );
      onChanged();
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(
        caught instanceof ApiError && caught.status === 403
          ? 'Only an administrator can switch HR access on or off.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not update that account.',
      );
    } finally {
      setBusy(false);
    }
  };

  const approved = employee.approvalStatus === 'approved';
  // A deleted record is kept for its history and nothing else: no edits, no account actions.
  const deleted = employee.deletedAt !== null;

  return (
    <article className="hrp-detail" aria-labelledby={`hr-emp-name-${employee.id}`}>
      <header className="hrp-detail__head">
        <button type="button" className="btn btn--ghost btn--sm hrp-detail__back" onClick={onBack}>
          <Icon name="arrowLeft" size={15} />
          All employees
        </button>

        <div className="hrp-detail__identity">
          <h2
            ref={heading}
            id={`hr-emp-name-${employee.id}`}
            className="hrp-detail__name"
            tabIndex={-1}
          >
            {employee.name}
          </h2>
          <p className="hrp-detail__sub">
            <span className="tc-mono">{employee.employeeCode}</span>
            {employee.designationName ? ` · ${employee.designationName}` : ''}
            {employee.departmentName ? ` · ${employee.departmentName}` : ''}
          </p>
          <div className="hrp-detail__tags">
            {deleted ? <Tag tone="bad">Deleted</Tag> : null}
            <Tag tone="neutral">{HR_ROLE_LABELS[employee.role]}</Tag>
            {approved ? null : (
              <Tag tone={employee.approvalStatus === 'rejected' ? 'bad' : 'warn'}>
                {HR_APPROVAL_LABELS[employee.approvalStatus]}
              </Tag>
            )}
            {approved && !deleted ? (
              employee.isActive ? (
                <Tag tone="good">Can sign in</Tag>
              ) : (
                <Tag tone="bad">Switched off</Tag>
              )
            ) : null}
            <Tag tone={employee.employmentStatus === 'exited' ? 'bad' : 'neutral'}>
              {HR_EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]}
            </Tag>
          </div>
        </div>

        {deleted ? null : (
          <div className="hrp-detail__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                setNotice(null);
                setEditing(true);
              }}
            >
              Edit record
            </button>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => {
                setNotice(null);
                setAssigning(true);
              }}
            >
              <Icon name="pin" size={14} />
              Attendance rule
            </button>
            {approved ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void setActive(!employee.isActive)}
              >
                {busy ? <ButtonSpinner /> : null}
                {employee.isActive ? 'Switch off' : 'Switch on'}
              </button>
            ) : null}
            {approved ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setNotice(null);
                  setResetting(true);
                }}
              >
                <Icon name="shield" size={14} />
                Reset password
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost btn--sm hrp-detail__delete"
              onClick={() => {
                setNotice(null);
                setDeleting(true);
              }}
            >
              Delete
            </button>
          </div>
        )}
      </header>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}
      {deleted ? (
        <FormAlert variant="info">
          Deleted{employee.deletedAt ? ` on ${formatDateTime(employee.deletedAt)}` : ''}
          {employee.deletedByName ? ` by ${employee.deletedByName}` : ''}. Kept here for their history only:
          they are not in any list, pay period or approval queue, and cannot sign in.
        </FormAlert>
      ) : null}

      {resetting ? (
        <ResetPasswordDialog
          employee={employee}
          onUnauthorized={onUnauthorized}
          onClose={() => setResetting(false)}
          onDone={(message) => {
            setResetting(false);
            setNotice(message);
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteEmployeeDialog
          employee={employee}
          onUnauthorized={onUnauthorized}
          onClose={() => setDeleting(false)}
          onDeleted={(result) => {
            setDeleting(false);
            setNotice(deleteSummary(result));
            onChanged();
            void load();
            heading.current?.focus();
          }}
        />
      ) : null}

      {assigning ? (
        <AssignmentDialog
          employee={employee}
          onUnauthorized={onUnauthorized}
          onClose={() => setAssigning(false)}
          onSaved={(message) => {
            setAssigning(false);
            setNotice(message);
            onChanged();
            void load();
          }}
        />
      ) : null}

      <div className="admin-tabs hrp-detail__tabs" role="tablist" aria-label={`${employee.name}’s record`}>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`hr-emp-tab-${employee.id}-${item.key}`}
            aria-controls={`hr-emp-panel-${employee.id}-${item.key}`}
            className="admin-tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`hr-emp-panel-${employee.id}-${tab}`}
        aria-labelledby={`hr-emp-tab-${employee.id}-${tab}`}
        className="hrp-detail__panel"
      >
        {tab === 'profile' ? (
          <LoadingOverlay busy={loading}>
            {/*
              An HR manager approves for their direct reports only. With none, their approval
              queues in the app are always empty — which reads as approvals not working.
            */}
            {employee.role === 'hr_manager' && directReports === 0 ? (
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <FormAlert variant="info">
                  Nobody reports to {employee.name} yet, so they have no leave or corrections to approve in
                  the HR app. Set “Reports to” to {employee.name} on each team member, or change their
                  access level to HR administrator to approve for everyone.
                </FormAlert>
              </div>
            ) : null}
            <div className="hrp-facts-grid">
              <Facts title="Work">
                <Fact label="Department">{show(employee.departmentName)}</Fact>
                <Fact label="Designation">{show(employee.designationName)}</Fact>
                <Fact label="Reports to">{show(employee.managerName)}</Fact>
                <Fact label="Direct reports">
                  {directReports === null ? <span className="tc-muted">…</span> : directReports}
                </Fact>
                <Fact label="Access level">{HR_ROLE_LABELS[employee.role]}</Fact>
              </Facts>

              <Facts title="Employment">
                <Fact label="Joining date">{show(employee.joiningDate ? formatDate(employee.joiningDate) : null)}</Fact>
                <Fact label="Exit date">
                  {employee.exitDate ? formatDate(employee.exitDate) : <span className="tc-muted">None</span>}
                </Fact>
                <Fact label="Type">{HR_EMPLOYMENT_TYPE_LABELS[employee.employmentType]}</Fact>
                <Fact label="Status">{HR_EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]}</Fact>
              </Facts>

              <Facts title="Attendance rule">
                <Fact label="How they work">{WORK_MODE_LABELS[employee.workMode]}</Fact>
                <Fact label="Work location">
                  {employee.workLocationName ??
                    (employee.workMode === 'office' ? (
                      <Tag tone="bad">No site — cannot check in</Tag>
                    ) : (
                      <span className="tc-muted">No location check</span>
                    ))}
                </Fact>
                <Fact label="Shift">
                  {employee.shiftName ?? <span className="tc-muted">No shift — never marked late</span>}
                </Fact>
              </Facts>

              <Facts title="Contact">
                <Fact label="Email">{employee.email}</Fact>
                <Fact label="Phone">{show(employee.phone)}</Fact>
                <Fact label="Address">{show(employee.address)}</Fact>
                <Fact label="Emergency contact">
                  {show(
                    employee.emergencyContactName || employee.emergencyContactPhone
                      ? [employee.emergencyContactName, employee.emergencyContactPhone]
                          .filter(Boolean)
                          .join(' · ')
                      : null,
                  )}
                </Fact>
                <Fact label="Date of birth">
                  {show(employee.dateOfBirth ? formatDate(employee.dateOfBirth) : null)}
                </Fact>
              </Facts>

              <Facts title="HR app account">
                <Fact label="Approval">{HR_APPROVAL_LABELS[employee.approvalStatus]}</Fact>
                {employee.rejectionReason ? (
                  <Fact label="Reason given">{employee.rejectionReason}</Fact>
                ) : null}
                <Fact label="App access">
                  {approved ? (employee.isActive ? 'Can sign in' : 'Switched off') : 'Not until approved'}
                </Fact>
                <Fact label="Email confirmed">
                  {employee.emailVerifiedAt ? formatDateTime(employee.emailVerifiedAt) : 'Not yet'}
                </Fact>
                <Fact label="Signed up">{show(employee.registeredAt ? formatDateTime(employee.registeredAt) : null)}</Fact>
                <Fact label="Last signed in">
                  {employee.lastLoginAt ? formatDateTime(employee.lastLoginAt) : <span className="tc-muted">Never</span>}
                </Fact>
              </Facts>
            </div>
          </LoadingOverlay>
        ) : tab === 'attendance' ? (
          <EmployeeAttendanceTab employee={employee} canCorrect={approved && !deleted} onUnauthorized={onUnauthorized} />
        ) : tab === 'calendar' ? (
          <EmployeeCalendarTab employee={employee} onUnauthorized={onUnauthorized} />
        ) : (
          <EmployeeLeaveTab employee={employee} onUnauthorized={onUnauthorized} />
        )}
      </div>

      {editing ? (
        <EditEmployeeDialog
          employee={employee}
          departments={departments}
          designations={designations}
          onClose={() => setEditing(false)}
          onSaved={saved}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </article>
  );
}
