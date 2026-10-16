'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  COMPONENT_KIND_LABELS,
  formatCalendarDate,
  formatInr,
  longCalendarDate,
  payrollApi,
  type PayrollEmployee,
  type PayrollPage,
  type SalaryStructure,
} from '@/lib/hrPayroll';
import { formatDateTime, todayIso } from '@/lib/telecalling';
import { EmptyPanel, Pager, TableSkeleton, Tag } from '../../telecalling/shared';
import { StructureForm } from './StructureForm';
import { ConfirmDialog, isAbort, readFailure } from './shared';

/**
 * One employee's salary structures, newest first, and the form for a new one.
 *
 * Structures are never edited. A change of salary is a NEW structure from a later date,
 * because the old one is the record of what earlier payslips were computed from — the
 * server refuses to delete a structure once a payslip used it (`inUse`), and this screen
 * only offers Delete where the server would allow it.
 *
 * Which structure is "in force" and which is "upcoming" is the server's answer (the
 * employee row carries both), re-read after every change rather than worked out from
 * dates here, so the labels can never disagree with what payroll will use.
 */

const PAGE_SIZE = 10;

export function EmployeeStructures({
  employee: initialEmployee,
  onBack,
  onUnauthorized,
  onRestricted,
}: {
  employee: PayrollEmployee;
  onBack: () => void;
  onUnauthorized: () => void;
  onRestricted: () => void;
}) {
  const [employee, setEmployee] = useState(initialEmployee);
  const user = employee.user;

  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);
  const [data, setData] = useState<PayrollPage<SalaryStructure> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Somebody with no structure at all came here to set one up: open the form for them.
  const [formOpen, setFormOpen] = useState(
    initialEmployee.currentStructure === null && initialEmployee.upcomingStructure === null,
  );

  const [deleting, setDeleting] = useState<SalaryStructure | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(
        await payrollApi.listStructures({ userId: user.id, page, pageSize: PAGE_SIZE }, controller.signal),
      );
    } catch (caught) {
      if (isAbort(caught)) return;
      setError(
        readFailure(caught, { onUnauthorized, onRestricted }, 'Could not load the salary structures.'),
      );
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [user.id, page, onUnauthorized, onRestricted]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(1);
  }, [data, page]);

  /**
   * Re-reads this employee's row for its in-force and upcoming structures.
   *
   * There is no single-employee payroll endpoint, so it is the list filtered by employee
   * code, matched on id. Allowed to fail quietly: the history below is still right, and
   * only the "in force" label could be a step behind.
   */
  const refreshEmployee = useCallback(async () => {
    try {
      const result = await payrollApi.listEmployees({ q: user.employeeCode, page: 1, pageSize: 20 });
      const fresh = result.items.find((item) => item.user.id === user.id);
      if (fresh) setEmployee(fresh);
    } catch {
      // Keep the row we have.
    }
  }, [user.employeeCode, user.id]);

  const changed = (message: string) => {
    setNotice(message);
    setPage(1);
    setRefreshToken((value) => value + 1);
    void refreshEmployee();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);

    try {
      await payrollApi.deleteStructure(deleting.id);
      const when = longCalendarDate(deleting.effectiveFrom);
      setDeleting(null);
      changed(`The structure from ${when} was deleted.`);
      // Its Delete button is gone with it; the heading is the steady place to land.
      headingRef.current?.focus();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setDeleteError(caught instanceof ApiError ? caught.message : 'Could not delete the structure.');
    } finally {
      setDeleteBusy(false);
    }
  };

  const today = todayIso();
  const currentId = employee.currentStructure?.id ?? null;
  const upcomingId = employee.upcomingStructure?.id ?? null;

  const standing = (structure: SalaryStructure): { label: string; tone: 'good' | 'progress' | 'neutral' } => {
    if (structure.id === currentId) return { label: 'In force', tone: 'good' };
    if (structure.id === upcomingId) return { label: 'Upcoming', tone: 'progress' };
    if (structure.effectiveFrom > today) return { label: 'Scheduled', tone: 'progress' };
    return { label: 'Earlier', tone: 'neutral' };
  };

  const facts = [
    user.employeeCode,
    user.departmentName,
    user.designationName,
    user.joiningDate ? `Joined ${formatCalendarDate(user.joiningDate)}` : null,
    user.exitDate ? `Left ${formatCalendarDate(user.exitDate)}` : null,
  ].filter((value): value is string => Boolean(value));

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="hr-pay-detail-nav">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          <Icon name="arrowLeft" size={15} />
          All employees
        </button>
      </div>

      <header className="hr-pay-run-head">
        <div className="hr-pay-run-head__title">
          <h2 className="hr-pay-run-head__heading" ref={headingRef} tabIndex={-1}>
            {user.name}
          </h2>
          {!user.isActive ? <Tag tone="bad">Switched off</Tag> : null}
          {user.employmentStatus === 'exited' ? <Tag>Exited</Tag> : null}
        </div>
        <p className="tc-muted hr-pay-run-head__sub">{facts.join(' · ')}</p>
      </header>

      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}
      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      <div className="hr-pay-summary">
        <div className="hr-pay-summary__item">
          <span className="hr-pay-summary__label">In force today</span>
          {employee.currentStructure ? (
            <>
              <span className="hr-pay-summary__value">{formatInr(employee.currentStructure.totals.net)}</span>
              <span className="tc-muted">
                net a month, from {formatCalendarDate(employee.currentStructure.effectiveFrom)}
              </span>
            </>
          ) : (
            <span className="hr-pay-summary__none">
              <Tag tone="warn">None</Tag>
              <span className="tc-muted">Payroll leaves {user.name} out until a structure starts.</span>
            </span>
          )}
        </div>
        {employee.upcomingStructure ? (
          <div className="hr-pay-summary__item">
            <span className="hr-pay-summary__label">Upcoming</span>
            <span className="hr-pay-summary__value">{formatInr(employee.upcomingStructure.totals.net)}</span>
            <span className="tc-muted">
              net a month, from {formatCalendarDate(employee.upcomingStructure.effectiveFrom)}
            </span>
          </div>
        ) : null}
      </div>

      {formOpen ? (
        <StructureForm
          employeeName={user.name}
          userId={user.id}
          copyFrom={employee.currentStructure ?? employee.upcomingStructure}
          onUnauthorized={onUnauthorized}
          onCancel={() => {
            setFormOpen(false);
            window.setTimeout(() => newButtonRef.current?.focus(), 0);
          }}
          onCreated={(structure) => {
            setFormOpen(false);
            changed(
              `Structure from ${longCalendarDate(structure.effectiveFrom)} saved: ${formatInr(structure.totals.net)} net a month.`,
            );
            headingRef.current?.focus();
          }}
        />
      ) : null}

      <div className="tc-panel-head">
        <h3 className="tc-section-title" style={{ margin: 0 }}>
          Structure history
        </h3>
        {formOpen ? null : (
          <button
            type="button"
            className="btn btn--primary"
            ref={newButtonRef}
            onClick={() => {
              setNotice(null);
              setFormOpen(true);
            }}
          >
            <Icon name="add" size={16} />
            New structure
          </button>
        )}
      </div>

      {loading && !data ? (
        <TableSkeleton rows={3} />
      ) : !data ? (
        <EmptyPanel
          title="History not loaded"
          message="The salary structures could not be loaded."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : data.items.length === 0 ? (
        <EmptyPanel
          title="No salary structure yet"
          message={`${user.name} is left out of payroll runs until they have one. Add the components they are paid each month and the date it starts.`}
          actionLabel={formOpen ? undefined : 'New structure'}
          onAction={formOpen ? undefined : () => setFormOpen(true)}
        />
      ) : (
        <LoadingOverlay busy={loading} label="Updating…">
          <div className="hr-pay-structures">
            {data.items.map((structure) => (
              <StructureCard
                key={structure.id}
                structure={structure}
                standing={standing(structure)}
                onDelete={() => {
                  setDeleteError(null);
                  setDeleting(structure);
                }}
              />
            ))}
          </div>

          <Pager
            page={data.page}
            totalPages={totalPages}
            total={data.total}
            noun="structure"
            busy={loading}
            onChange={setPage}
          />
        </LoadingOverlay>
      )}

      {deleting ? (
        <ConfirmDialog
          title={`Delete the structure from ${longCalendarDate(deleting.effectiveFrom)}?`}
          confirmLabel="Delete structure"
          busyLabel="Deleting…"
          danger
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p className="dialog__text">
            No payslip has been computed from it, so nothing already paid changes. Payroll will use{' '}
            {user.name}’s earlier structure, if there is one, for the months it covered.
          </p>
          <p className="dialog__text tc-muted">This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function StructureCard({
  structure,
  standing,
  onDelete,
}: {
  structure: SalaryStructure;
  standing: { label: string; tone: 'good' | 'progress' | 'neutral' };
  onDelete: () => void;
}) {
  const titleId = `hr-pay-structure-${structure.id}`;
  const earnings = structure.components.filter((component) => component.kind === 'earning');
  const deductions = structure.components.filter((component) => component.kind === 'deduction');

  return (
    <article className="tc-card hr-pay-structure" aria-labelledby={titleId} data-standing={standing.label}>
      <header className="hr-pay-structure__head">
        <div className="hr-pay-structure__title">
          <h4 id={titleId}>From {longCalendarDate(structure.effectiveFrom)}</h4>
          <Tag tone={standing.tone}>{standing.label}</Tag>
        </div>
        <p className="hr-pay-structure__net">
          <strong>{formatInr(structure.totals.net)}</strong>
          <span className="tc-muted"> net a month</span>
        </p>
      </header>

      {structure.note ? <p className="hr-pay-structure__note">{structure.note}</p> : null}

      <div className="hr-pay-lines-scroll">

        <table className="hr-pay-lines hr-pay-lines--structure">
          <caption className="sr-only">Components of the structure from {longCalendarDate(structure.effectiveFrom)}</caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Type</th>
              <th scope="col">Monthly amount</th>
              <th scope="col">Loss of pay</th>
            </tr>
          </thead>
          <tbody>
            {[...earnings, ...deductions].map((component) => (
              <tr key={component.id}>
                <th scope="row">{component.label}</th>
                <td>{COMPONENT_KIND_LABELS[component.kind]}</td>
                <td>{formatInr(component.amount)}</td>
                <td>
                  {component.kind === 'deduction'
                    ? 'Taken in full'
                    : component.prorated
                      ? 'Reduced'
                      : 'Paid in full'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Earnings</th>
              <td />
              <td>{formatInr(structure.totals.earnings)}</td>
              <td />
            </tr>
            <tr>
              <th scope="row">Deductions</th>
              <td />
              <td>{formatInr(structure.totals.deductions)}</td>
              <td />
            </tr>
            <tr className="hr-pay-lines__net">
              <th scope="row">Net a month</th>
              <td />
              <td>{formatInr(structure.totals.net)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <footer className="hr-pay-structure__foot">
        <span className="tc-muted">
          Added {structure.createdByName ? `by ${structure.createdByName} ` : ''}on{' '}
          {formatDateTime(structure.createdAt)}
        </span>
        {structure.inUse ? (
          <span className="tc-muted hr-pay-structure__kept">
            <Icon name="shield" size={14} />
            Used for payslips, so it is kept as the record of what was paid.
          </span>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--sm hr-pay-btn--danger-text"
            onClick={onDelete}
            aria-label={`Delete the structure from ${longCalendarDate(structure.effectiveFrom)}`}
          >
            Delete
          </button>
        )}
      </footer>
    </article>
  );
}
