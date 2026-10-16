'use client';

import { useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert, TextAreaField, TextField } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { todayIso } from '@/lib/telecalling';
import {
  HR_EMPLOYMENT_STATUSES,
  HR_EMPLOYMENT_STATUS_LABELS,
  HR_EMPLOYMENT_TYPES,
  HR_EMPLOYMENT_TYPE_LABELS,
  HR_ROLES,
  HR_ROLE_LABELS,
  peopleApi,
  type Department,
  type Designation,
  type EmployeePatch,
  type EmployeePatchResult,
  type HrEmployee,
  type HrEmploymentStatus,
  type HrEmploymentType,
  type HrRole,
} from '@/lib/hr';
import { EmployeePicker, type PickedEmployee } from './EmployeePicker';
import { DateField, EnumSelect, OrgSelect } from './fields';
import { PHONE_PATTERN, classifyWriteError, unplacedErrors, useStableClose } from './shared';
import { selectable } from './useOrgLists';

/**
 * Edits one employee record. ADMIN ONLY on the server.
 *
 * Sends only what changed, so the audit row lists exactly what moved and a save with no
 * edits writes nothing. A cleared field is sent as `null` (the server's "clear"); a field
 * left alone is not sent at all — on a partial update, sending every field back would
 * overwrite a change another administrator saved a moment ago.
 *
 * Email and password are not here: the address is the sign-in identity, and the password
 * is the employee's own.
 */

type Form = {
  name: string;
  phone: string;
  role: HrRole;
  departmentId: string;
  designationId: string;
  manager: PickedEmployee | null;
  joiningDate: string;
  exitDate: string;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
  dateOfBirth: string;
  address: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

/** How each field is named in the "Saved: …" line. */
export const EMPLOYEE_FIELD_LABELS: Record<string, string> = {
  name: 'name',
  phone: 'phone',
  role: 'access level',
  departmentId: 'department',
  designationId: 'designation',
  managerId: 'manager',
  joiningDate: 'joining date',
  exitDate: 'exit date',
  employmentType: 'employment type',
  employmentStatus: 'employment status',
  dateOfBirth: 'date of birth',
  address: 'address',
  emergencyContactName: 'emergency contact',
  emergencyContactPhone: 'emergency contact phone',
};

const FIELDS = Object.keys(EMPLOYEE_FIELD_LABELS);

function fromEmployee(employee: HrEmployee): Form {
  return {
    name: employee.name,
    phone: employee.phone ?? '',
    role: employee.role,
    departmentId: employee.departmentId ? String(employee.departmentId) : '',
    designationId: employee.designationId ? String(employee.designationId) : '',
    manager:
      employee.managerId !== null
        ? { id: employee.managerId, name: employee.managerName ?? 'Their manager', employeeCode: null }
        : null,
    joiningDate: employee.joiningDate ?? '',
    exitDate: employee.exitDate ?? '',
    employmentType: employee.employmentType,
    employmentStatus: employee.employmentStatus,
    dateOfBirth: employee.dateOfBirth ?? '',
    address: employee.address ?? '',
    emergencyContactName: employee.emergencyContactName ?? '',
    emergencyContactPhone: employee.emergencyContactPhone ?? '',
  };
}

/** Collapsed whitespace, the way the server stores free text; '' becomes null. */
function cleanText(value: string): string | null {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? null : collapsed;
}

function idOrNull(value: string): number | null {
  return value ? Number(value) : null;
}

/** The edit as a minimal patch: only fields whose value differs from the record. */
function diff(employee: HrEmployee, form: Form): EmployeePatch {
  const patch: EmployeePatch = {};

  const name = cleanText(form.name);
  if (name !== null && name !== employee.name) patch.name = name;

  const phone = form.phone.trim() || null;
  if (phone !== employee.phone) patch.phone = phone;

  if (form.role !== employee.role) patch.role = form.role;

  const departmentId = idOrNull(form.departmentId);
  if (departmentId !== employee.departmentId) patch.departmentId = departmentId;

  const designationId = idOrNull(form.designationId);
  if (designationId !== employee.designationId) patch.designationId = designationId;

  const managerId = form.manager?.id ?? null;
  if (managerId !== employee.managerId) patch.managerId = managerId;

  const joiningDate = form.joiningDate || null;
  if (joiningDate !== employee.joiningDate) patch.joiningDate = joiningDate;

  const exitDate = form.exitDate || null;
  if (exitDate !== employee.exitDate) patch.exitDate = exitDate;

  if (form.employmentType !== employee.employmentType) patch.employmentType = form.employmentType;
  if (form.employmentStatus !== employee.employmentStatus) {
    patch.employmentStatus = form.employmentStatus;
  }

  const dateOfBirth = form.dateOfBirth || null;
  if (dateOfBirth !== employee.dateOfBirth) patch.dateOfBirth = dateOfBirth;

  const address = cleanText(form.address);
  if (address !== employee.address) patch.address = address;

  const contactName = cleanText(form.emergencyContactName);
  if (contactName !== employee.emergencyContactName) patch.emergencyContactName = contactName;

  const contactPhone = form.emergencyContactPhone.trim() || null;
  if (contactPhone !== employee.emergencyContactPhone) patch.emergencyContactPhone = contactPhone;

  return patch;
}

export function EditEmployeeDialog({
  employee,
  departments,
  designations,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  employee: HrEmployee;
  departments: Department[] | null;
  designations: Designation[] | null;
  onClose: () => void;
  onSaved: (result: EmployeePatchResult) => void;
  onUnauthorized: () => void;
}) {
  const close = useStableClose(onClose);
  const [form, setForm] = useState<Form>(() => fromEmployee(employee));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const patch = diff(employee, form);
  const changedCount = Object.keys(patch).length;

  const submit = async () => {
    setBanner(null);

    const local: Record<string, string> = {};
    if ((cleanText(form.name) ?? '').length < 2) local.name = 'Enter their full name.';
    if (form.phone.trim() && !PHONE_PATTERN.test(form.phone.trim())) {
      local.phone = 'Enter a valid phone number.';
    }
    if (form.emergencyContactPhone.trim() && !PHONE_PATTERN.test(form.emergencyContactPhone.trim())) {
      local.emergencyContactPhone = 'Enter a valid phone number.';
    }
    if (form.joiningDate && form.exitDate && form.exitDate < form.joiningDate) {
      local.exitDate = 'The exit date cannot be before the joining date.';
    }
    if (form.dateOfBirth && form.dateOfBirth >= todayIso()) {
      local.dateOfBirth = 'Enter a date in the past.';
    }
    if ((cleanText(form.address) ?? '').length > 400) {
      local.address = 'Keep the address to 400 characters or fewer.';
    }

    setErrors(local);
    if (Object.keys(local).length > 0) {
      setBanner('Check the highlighted fields.');
      return;
    }

    if (changedCount === 0) {
      setBanner(null);
      close();
      return;
    }

    setSaving(true);
    try {
      onSaved(await peopleApi.updateEmployee(employee.id, patch));
    } catch (caught) {
      const outcome = classifyWriteError(caught);
      if (outcome.unauthorized) return onUnauthorized();
      if (outcome.forbidden) {
        setBanner('Only an administrator can edit employee records.');
        return;
      }
      setErrors(outcome.fields);
      const unplaced = unplacedErrors(outcome.fields, FIELDS);
      setBanner(unplaced.length > 0 ? unplaced.join(' ') : outcome.message);
    } finally {
      setSaving(false);
    }
  };

  const exitedWithoutDate = form.employmentStatus === 'exited' && !form.exitDate;

  return (
    <Dialog
      open
      onClose={close}
      title={`Edit ${employee.name}`}
      className="tc-dialog tc-dialog--wide"
      dismissOnBackdrop={false}
    >
      <div className="tc-dialog__head">
        <p className="tc-dialog__eyebrow">Employee record</p>
        <h2 className="tc-dialog__title">Edit {employee.name}</h2>
        <p className="tc-dialog__sub">
          {employee.employeeCode} · {employee.email}
        </p>
      </div>

      <form
        className="hrp-dialog-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="tc-dialog__body">
          {banner ? <FormAlert variant="error">{banner}</FormAlert> : null}

          <section className="tc-dialog__section" aria-labelledby="hr-edit-work">
            <h3 className="tc-dialog__section-title" id="hr-edit-work">
              Work
            </h3>
            <div className="tc-form__grid">
              <TextField
                label="Full name"
                name="hr-edit-name"
                required
                value={form.name}
                error={errors.name}
                maxLength={120}
                autoComplete="off"
                onChange={(value) => set('name', value)}
              />
              <EnumSelect
                label="Access level"
                value={form.role}
                options={HR_ROLES}
                labels={HR_ROLE_LABELS}
                error={errors.role}
                hint={
                  form.role !== employee.role
                    ? 'The new access level reaches their app when it next refreshes its session, within a few minutes.'
                    : undefined
                }
                onChange={(value) => set('role', value)}
              />
              <OrgSelect
                label="Department"
                value={form.departmentId}
                options={selectable(departments, employee.departmentId)}
                emptyLabel="No department"
                error={errors.departmentId}
                onChange={(value) => set('departmentId', value)}
              />
              <OrgSelect
                label="Designation"
                value={form.designationId}
                options={selectable(designations, employee.designationId)}
                emptyLabel="No designation"
                error={errors.designationId}
                onChange={(value) => set('designationId', value)}
              />
              <EmployeePicker
                label="Reports to"
                value={form.manager}
                excludeId={employee.id}
                onChange={(next) => set('manager', next)}
                error={errors.managerId}
                hint="Their manager approves their leave and attendance corrections in the HR app."
                onUnauthorized={onUnauthorized}
              />
            </div>
          </section>

          <section className="tc-dialog__section" aria-labelledby="hr-edit-employment">
            <h3 className="tc-dialog__section-title" id="hr-edit-employment">
              Employment
            </h3>
            <div className="tc-form__grid">
              <DateField
                label="Joining date"
                value={form.joiningDate}
                error={errors.joiningDate}
                hint="Days before it are never counted as absences."
                onChange={(value) => set('joiningDate', value)}
              />
              <DateField
                label="Exit date"
                value={form.exitDate}
                min={form.joiningDate || undefined}
                error={errors.exitDate}
                hint="Their last working day. Days after it are not counted."
                onChange={(value) => set('exitDate', value)}
              />
              <EnumSelect
                label="Employment type"
                value={form.employmentType}
                options={HR_EMPLOYMENT_TYPES}
                labels={HR_EMPLOYMENT_TYPE_LABELS}
                error={errors.employmentType}
                onChange={(value) => set('employmentType', value)}
              />
              <EnumSelect
                label="Employment status"
                value={form.employmentStatus}
                options={HR_EMPLOYMENT_STATUSES}
                labels={HR_EMPLOYMENT_STATUS_LABELS}
                error={errors.employmentStatus}
                hint={
                  exitedWithoutDate
                    ? 'Set the exit date as well, so attendance and payroll stop counting days after it.'
                    : form.employmentStatus === 'exited'
                      ? 'This does not switch off their HR app access — use Switch off for that.'
                      : undefined
                }
                onChange={(value) => set('employmentStatus', value)}
              />
            </div>
          </section>

          <section className="tc-dialog__section" aria-labelledby="hr-edit-personal">
            <h3 className="tc-dialog__section-title" id="hr-edit-personal">
              Personal and contact
            </h3>
            <div className="tc-form__grid">
              <TextField
                label="Phone"
                name="hr-edit-phone"
                type="tel"
                value={form.phone}
                error={errors.phone}
                maxLength={20}
                autoComplete="off"
                onChange={(value) => set('phone', value)}
              />
              <DateField
                label="Date of birth"
                value={form.dateOfBirth}
                max={todayIso()}
                error={errors.dateOfBirth}
                onChange={(value) => set('dateOfBirth', value)}
              />
              <TextField
                label="Emergency contact name"
                name="hr-edit-contact-name"
                value={form.emergencyContactName}
                error={errors.emergencyContactName}
                maxLength={120}
                autoComplete="off"
                onChange={(value) => set('emergencyContactName', value)}
              />
              <TextField
                label="Emergency contact phone"
                name="hr-edit-contact-phone"
                type="tel"
                value={form.emergencyContactPhone}
                error={errors.emergencyContactPhone}
                maxLength={20}
                autoComplete="off"
                onChange={(value) => set('emergencyContactPhone', value)}
              />
            </div>
            <TextAreaField
              label="Address"
              name="hr-edit-address"
              rows={2}
              value={form.address}
              error={errors.address}
              maxLength={400}
              hint="Saved on one line. Leave a field empty to clear it."
              onChange={(value) => set('address', value)}
            />
          </section>
        </div>

        <div className="tc-dialog__foot">
          <p className="tc-dialog__foot-note" aria-live="polite">
            {changedCount === 0
              ? 'No changes yet.'
              : `${changedCount} ${changedCount === 1 ? 'change' : 'changes'} to save.`}
          </p>
          <button type="button" className="btn btn--ghost" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving || changedCount === 0}
            aria-busy={saving || undefined}
          >
            {saving ? <ButtonSpinner /> : null}
            Save changes
          </button>
        </div>
      </form>
    </Dialog>
  );
}
