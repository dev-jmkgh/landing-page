'use client';

import { useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert, TextField } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
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
  type HrEmployee,
  type HrEmploymentStatus,
  type HrEmploymentType,
  type HrRole,
} from '@/lib/hr';
import { EmployeePicker, type PickedEmployee } from './EmployeePicker';
import { DateField, EnumSelect, OrgSelect } from './fields';
import {
  EMAIL_PATTERN,
  PHONE_PATTERN,
  classifyWriteError,
  unplacedErrors,
  useStableClose,
} from './shared';
import { selectable } from './useOrgLists';

/**
 * Adds an HR employee directly.
 *
 * The administrator vouches for the person, so the account is approved, active and
 * email-verified at once and can sign in to the HR app straight away with the password
 * set here — the two gates of self-signup (confirming the address, waiting for approval)
 * do not apply. The server allocates the next EMP- code from the same series signup uses,
 * and applies the signup password rule (12 characters or more).
 */

type Form = {
  name: string;
  email: string;
  phone: string;
  password: string;
  role: HrRole;
  departmentId: string;
  designationId: string;
  manager: PickedEmployee | null;
  joiningDate: string;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
};

const BLANK: Form = {
  name: '',
  email: '',
  phone: '',
  password: '',
  role: 'employee',
  departmentId: '',
  designationId: '',
  manager: null,
  joiningDate: '',
  employmentType: 'full_time',
  employmentStatus: 'active',
};

/** The fields this form can put an error beside. Anything else goes in the banner. */
const FIELDS = [
  'name',
  'email',
  'phone',
  'password',
  'role',
  'departmentId',
  'designationId',
  'managerId',
  'joiningDate',
  'employmentType',
  'employmentStatus',
] as const;

export function AddEmployeeDialog({
  departments,
  designations,
  onClose,
  onCreated,
  onUnauthorized,
}: {
  departments: Department[] | null;
  designations: Designation[] | null;
  onClose: () => void;
  onCreated: (employee: HrEmployee) => void;
  onUnauthorized: () => void;
}) {
  const close = useStableClose(onClose);
  const [form, setForm] = useState<Form>(BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setBanner(null);

    // The server's own rules, checked first so each message lands beside its field.
    const local: Record<string, string> = {};
    if (form.name.trim().length < 2) local.name = 'Enter their full name.';
    if (!EMAIL_PATTERN.test(form.email.trim())) local.email = 'Enter a valid email address.';
    if (form.phone.trim() && !PHONE_PATTERN.test(form.phone.trim())) {
      local.phone = 'Enter a valid phone number.';
    }
    if (form.password.length < 12) local.password = 'Use at least 12 characters.';

    setErrors(local);
    if (Object.keys(local).length > 0) {
      setBanner('Check the highlighted fields.');
      return;
    }

    setSaving(true);
    try {
      const created = await peopleApi.createEmployee({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim() || null,
        password: form.password,
        role: form.role,
        departmentId: form.departmentId ? Number(form.departmentId) : null,
        designationId: form.designationId ? Number(form.designationId) : null,
        managerId: form.manager?.id ?? null,
        joiningDate: form.joiningDate || null,
        employmentType: form.employmentType,
        employmentStatus: form.employmentStatus,
      });
      onCreated(created);
    } catch (caught) {
      const outcome = classifyWriteError(caught);
      if (outcome.unauthorized) return onUnauthorized();
      if (outcome.forbidden) {
        setBanner('Only an administrator can add employees.');
        return;
      }
      setErrors(outcome.fields);
      const unplaced = unplacedErrors(outcome.fields, FIELDS);
      setBanner(unplaced.length > 0 ? unplaced.join(' ') : outcome.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={close} title="Add employee" className="tc-dialog" dismissOnBackdrop={false}>
      <div className="tc-dialog__head">
        <p className="tc-dialog__eyebrow">HR employee</p>
        <h2 className="tc-dialog__title">Add employee</h2>
        <p className="tc-dialog__sub">
          The account is ready to use at once — no email confirmation or approval step.
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

          <section className="tc-dialog__section" aria-labelledby="hr-add-signin">
            <h3 className="tc-dialog__section-title" id="hr-add-signin">
              Sign-in details
            </h3>
            <div className="tc-form__grid">
              <TextField
                label="Full name"
                name="hr-add-name"
                required
                value={form.name}
                error={errors.name}
                maxLength={120}
                autoComplete="off"
                onChange={(value) => set('name', value)}
              />
              <TextField
                label="Email address"
                name="hr-add-email"
                type="email"
                required
                value={form.email}
                error={errors.email}
                maxLength={190}
                autoComplete="off"
                hint="Their HR app sign-in. It cannot be changed afterwards."
                onChange={(value) => set('email', value)}
              />
              <TextField
                label="Phone (optional)"
                name="hr-add-phone"
                type="tel"
                value={form.phone}
                error={errors.phone}
                maxLength={20}
                autoComplete="off"
                onChange={(value) => set('phone', value)}
              />
              <TextField
                label="Password"
                name="hr-add-password"
                // Plain text on purpose: it has to be read out or written down to hand
                // over, and a masked field guarantees a typo neither party can see.
                type="text"
                required
                value={form.password}
                error={errors.password}
                maxLength={200}
                autoComplete="off"
                hint="At least 12 characters. Shown in plain text because you need to pass it on — it cannot be retrieved afterwards."
                onChange={(value) => set('password', value)}
              />
              <EnumSelect
                label="Access level"
                value={form.role}
                options={HR_ROLES}
                labels={HR_ROLE_LABELS}
                error={errors.role}
                hint="HR managers approve leave and corrections for the people who report to them."
                onChange={(value) => set('role', value)}
              />
            </div>
          </section>

          <section className="tc-dialog__section" aria-labelledby="hr-add-employment">
            <h3 className="tc-dialog__section-title" id="hr-add-employment">
              Employment
            </h3>
            <div className="tc-form__grid">
              <OrgSelect
                label="Department (optional)"
                value={form.departmentId}
                options={selectable(departments, null)}
                emptyLabel="No department"
                error={errors.departmentId}
                onChange={(value) => set('departmentId', value)}
              />
              <OrgSelect
                label="Designation (optional)"
                value={form.designationId}
                options={selectable(designations, null)}
                emptyLabel="No designation"
                error={errors.designationId}
                onChange={(value) => set('designationId', value)}
              />
              <EmployeePicker
                label="Reports to (optional)"
                value={form.manager}
                onChange={(next) => set('manager', next)}
                error={errors.managerId}
                onUnauthorized={onUnauthorized}
              />
              <DateField
                label="Joining date (optional)"
                value={form.joiningDate}
                error={errors.joiningDate}
                hint="Days before it are never counted as absences."
                onChange={(value) => set('joiningDate', value)}
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
                onChange={(value) => set('employmentStatus', value)}
              />
            </div>
            <p className="tc-dialog__note">
              Work location, shift, address, date of birth and emergency contact are set from
              their profile once the account exists.
            </p>
          </section>
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving ? <ButtonSpinner /> : null}
            Add employee
          </button>
        </div>
      </form>
    </Dialog>
  );
}
