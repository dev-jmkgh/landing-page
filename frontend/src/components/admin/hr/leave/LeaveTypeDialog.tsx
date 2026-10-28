'use client';

import { useId, useRef, useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  LEAVE_KINDS,
  LEAVE_KIND_LABELS,
  isHalfStep,
  leaveAdminApi,
  type LeaveKind,
  type LeaveType,
  type LeaveTypeInput,
} from '@/lib/hrLeave';
import { HrDialog, writeFailure } from './shared';

/**
 * Creates or edits a leave type.
 *
 * THE QUOTA IS A CHOICE BETWEEN TWO THINGS, not a number that may be blank: "an annual
 * quota of N days" or "no quota — untracked". Untracked is the honest state for a type
 * HR has no policy for, and the screens show no balance for it at all. A blank number box
 * would invite reading "empty" as "zero".
 *
 * Work from home and field work never carry a quota (the server refuses one): they are
 * arrangements for where a day is worked, not time off drawn from a balance. Choosing
 * either kind switches the quota to untracked and locks it there.
 *
 * Editing sends only the fields that changed. The kind of a type cannot change once any
 * request uses it; the server says so on `errors.kind`, shown under the kind.
 */

const KIND_HINTS: Record<LeaveKind, string> = {
  leave: 'Time off. May carry an annual quota, and approved days count against the balance.',
  wfh: 'Working from home. The day counts as worked and the check-in has no location check.',
  field: 'Working in the field. The day counts as worked and the check-in has no location check.',
};

type FieldKey = 'name' | 'code' | 'kind' | 'annualQuota' | 'sortOrder' | 'form';

export function LeaveTypeDialog({
  existing,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  /** Null to create a new type. */
  existing: LeaveType | null;
  onClose: () => void;
  onSaved: (saved: LeaveType, message: string) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const nameRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState(existing?.name ?? '');
  const [code, setCode] = useState(existing?.code ?? '');
  const [kind, setKind] = useState<LeaveKind>(existing?.kind ?? 'leave');
  const [isPaid, setIsPaid] = useState(existing?.isPaid ?? true);
  const [tracked, setTracked] = useState(existing ? existing.annualQuota !== null : false);
  const [quota, setQuota] = useState(
    existing?.annualQuota !== null && existing?.annualQuota !== undefined ? String(existing.annualQuota) : '',
  );
  const [allowHalfDay, setAllowHalfDay] = useState(existing?.allowHalfDay ?? true);
  const [sortOrder, setSortOrder] = useState(String(existing?.sortOrder ?? 0));
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});

  const quotaAllowed = kind === 'leave';
  const quotaTracked = quotaAllowed && tracked;
  // Compensatory leave's kind, quota and half-day rule are fixed: only the rest is editable.
  const compOff = existing?.isCompOff === true;

  /* --------------------------------------------------------- validation */

  const validate = (): { input: LeaveTypeInput } | { errors: Partial<Record<FieldKey, string>> } => {
    const errors: Partial<Record<FieldKey, string>> = {};
    const cleanName = name.trim();
    const cleanCode = code.trim().toUpperCase();

    if (cleanName.length < 2) errors.name = 'Name the leave type.';
    else if (cleanName.length > 80) errors.name = 'Keep the name to 80 characters or fewer.';

    if (!/^[A-Z0-9]{2,16}$/.test(cleanCode)) errors.code = 'Use 2 to 16 letters or digits, e.g. CL.';

    let annualQuota: number | null = null;
    if (quotaTracked) {
      const value = Number(quota);
      if (quota.trim() === '' || !Number.isFinite(value) || value < 0 || value > 365) {
        errors.annualQuota = 'Use a number of days from 0 to 365.';
      } else if (!isHalfStep(value)) {
        errors.annualQuota = 'Use whole or half days, e.g. 12 or 7.5.';
      } else {
        annualQuota = value;
      }
    }

    const order = Number(sortOrder);
    if (sortOrder.trim() === '' || !Number.isInteger(order) || order < 0 || order > 10_000) {
      errors.sortOrder = 'Use a whole number from 0 to 10000.';
    }

    if (Object.keys(errors).length > 0) return { errors };
    return {
      input: {
        name: cleanName,
        code: cleanCode,
        kind,
        isPaid,
        annualQuota,
        allowHalfDay,
        sortOrder: order,
      },
    };
  };

  const submit = async () => {
    const result = validate();
    if ('errors' in result) {
      setFieldErrors(result.errors);
      setError('Check the highlighted fields.');
      return;
    }

    const { input } = result;
    let patch: Partial<LeaveTypeInput & { isActive: boolean }> | null = null;

    if (existing) {
      patch = {};
      if (input.name !== existing.name) patch.name = input.name;
      if (input.code !== existing.code) patch.code = input.code;
      if (input.kind !== existing.kind) patch.kind = input.kind;
      if (input.isPaid !== existing.isPaid) patch.isPaid = input.isPaid;
      if (input.annualQuota !== existing.annualQuota) patch.annualQuota = input.annualQuota;
      if (input.allowHalfDay !== existing.allowHalfDay) patch.allowHalfDay = input.allowHalfDay;
      if (input.sortOrder !== existing.sortOrder) patch.sortOrder = input.sortOrder;
      if (isActive !== existing.isActive) patch.isActive = isActive;

      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const saved = existing
        ? await leaveAdminApi.updateType(existing.id, patch ?? {})
        : await leaveAdminApi.createType(input);
      onSaved(
        saved,
        existing
          ? `${saved.name} is updated.${
              patch?.annualQuota !== undefined
                ? ' Balances without a per-person allocation follow the new quota.'
                : ''
            }`
          : `${saved.name} (${saved.code}) is added. Employees can apply for it in the HR app.`,
      );
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can change leave types.',
        'The leave type could not be saved.',
      );
      if (message === null) return;
      if (caught instanceof ApiError) setFieldErrors(caught.fieldErrors as Partial<Record<FieldKey, string>>);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = (key: FieldKey) => `field${fieldErrors[key] ? ' field--invalid' : ''}`;

  const errorLine = (key: FieldKey) =>
    fieldErrors[key] ? (
      <p className="field__error" id={id(`${key}-error`)}>
        <Icon name="alert" size={14} />
        {fieldErrors[key]}
      </p>
    ) : null;

  return (
    <HrDialog
      title={existing ? `Edit ${existing.name}` : 'Add a leave type'}
      eyebrow="Leave type"
      sub={existing ? `${existing.code} · ${LEAVE_KIND_LABELS[existing.kind]}` : undefined}
      onClose={onClose}
      initialFocus={nameRef}
    >
      <form
        className="hrl-dialog-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="tc-dialog__body">
          {error ? <FormAlert variant="error">{error}</FormAlert> : null}

          <div className="tc-form__grid">
            <div className={fieldClass('name')}>
              <label className="field__label" htmlFor={id('name')}>
                Name
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                ref={nameRef}
                id={id('name')}
                className="input"
                maxLength={80}
                required
                value={name}
                disabled={saving}
                placeholder="e.g. Casual leave"
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? id('name-error') : undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {errorLine('name')}
            </div>

            <div className={fieldClass('code')}>
              <label className="field__label" htmlFor={id('code')}>
                Code
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id={id('code')}
                className="input hrl-input--code"
                maxLength={16}
                required
                value={code}
                disabled={saving}
                placeholder="e.g. CL"
                autoCapitalize="characters"
                aria-invalid={fieldErrors.code ? true : undefined}
                aria-describedby={fieldErrors.code ? id('code-error') : id('code-hint')}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
              {fieldErrors.code ? (
                errorLine('code')
              ) : (
                <p className="field__hint" id={id('code-hint')}>
                  2 to 16 letters or digits. Shown beside the name in the app.
                </p>
              )}
            </div>
          </div>

          {compOff ? (
            <FormAlert variant="info">
              Compensatory leave has no quota. Each employee’s balance is the weekly offs and holidays they
              worked a full day on, still within the time limit in HR settings. It is always a whole day, and
              only HR administrators approve it — not team managers.
            </FormAlert>
          ) : (
            <>
            <fieldset className="tc-choice-list" aria-describedby={id('kind-hint')}>
              <legend>Kind</legend>
              <div className="tc-choice">
                {LEAVE_KINDS.map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name={id('kind')}
                      value={value}
                      checked={kind === value}
                      disabled={saving}
                      onChange={() => {
                        setKind(value);
                        if (value !== 'leave') setTracked(false);
                      }}
                    />
                    <span>{LEAVE_KIND_LABELS[value]}</span>
                  </label>
                ))}
              </div>
              <p className="field__hint" id={id('kind-hint')}>
                {KIND_HINTS[kind]}
              </p>
              {errorLine('kind')}
            </fieldset>

            <fieldset className="tc-choice-list" aria-describedby={id('quota-hint')}>
              <legend>Annual quota</legend>
              <div className="tc-choice">
                <label>
                  <input
                    type="radio"
                    name={id('quota-mode')}
                    checked={!quotaTracked}
                    disabled={saving}
                    onChange={() => setTracked(false)}
                  />
                  <span>No quota — untracked</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={id('quota-mode')}
                    checked={quotaTracked}
                    disabled={saving || !quotaAllowed}
                    onChange={() => setTracked(true)}
                  />
                  <span>An annual quota</span>
                </label>
              </div>

              {quotaTracked ? (
                <div className={`${fieldClass('annualQuota')} hrl-quota-field`}>
                  <label className="field__label" htmlFor={id('quota')}>
                    Days a year
                  </label>
                  <input
                    id={id('quota')}
                    className="input"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={365}
                    step={0.5}
                    value={quota}
                    disabled={saving}
                    aria-invalid={fieldErrors.annualQuota ? true : undefined}
                    aria-describedby={fieldErrors.annualQuota ? id('annualQuota-error') : undefined}
                    onChange={(event) => setQuota(event.target.value)}
                  />
                  {errorLine('annualQuota')}
                </div>
              ) : (
                errorLine('annualQuota')
              )}

              <p className="field__hint" id={id('quota-hint')}>
                {!quotaAllowed
                  ? 'Work from home and field work are never counted against a balance, so they have no quota.'
                  : quotaTracked
                    ? 'Each employee is entitled to this many days per calendar year, unless an allocation for them says otherwise.'
                    : 'No balance is kept or shown. An allocation on the Balances tab can still give one person a tracked entitlement.'}
              </p>
            </fieldset>
            </>
          )}

          <div className="tc-choice-list">
            <div className="tc-choice">
              <label>
                <input
                  type="checkbox"
                  checked={isPaid}
                  disabled={saving}
                  onChange={(event) => setIsPaid(event.target.checked)}
                />
                <span>Paid — the day is paid in payroll</span>
              </label>
            </div>
            {compOff ? null : (
              <div className="tc-choice">
                <label>
                  <input
                    type="checkbox"
                    checked={allowHalfDay}
                    disabled={saving}
                    onChange={(event) => setAllowHalfDay(event.target.checked)}
                  />
                  <span>Half days allowed</span>
                </label>
              </div>
            )}
            {existing ? (
              <div className="tc-choice">
                <label>
                  <input
                    type="checkbox"
                    checked={isActive}
                    disabled={saving}
                    onChange={(event) => setIsActive(event.target.checked)}
                  />
                  <span>Active — employees can apply for it</span>
                </label>
              </div>
            ) : null}
            {existing && existing.isActive && !isActive ? (
              <p className="tc-dialog__note">
                Switched off, it is no longer offered in the app. Requests already made keep it.
              </p>
            ) : null}
          </div>

          <div className="tc-form__grid">
            <div className={fieldClass('sortOrder')}>
              <label className="field__label" htmlFor={id('sort')}>
                Sort order
              </label>
              <input
                id={id('sort')}
                className="input"
                type="number"
                inputMode="numeric"
                min={0}
                max={10000}
                step={1}
                value={sortOrder}
                disabled={saving}
                aria-invalid={fieldErrors.sortOrder ? true : undefined}
                aria-describedby={fieldErrors.sortOrder ? id('sortOrder-error') : id('sort-hint')}
                onChange={(event) => setSortOrder(event.target.value)}
              />
              {fieldErrors.sortOrder ? (
                errorLine('sortOrder')
              ) : (
                <p className="field__hint" id={id('sort-hint')}>
                  Lower numbers are listed first in the app.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving ? <ButtonSpinner /> : null}
            {existing ? 'Save changes' : 'Add leave type'}
          </button>
        </div>
      </form>
    </HrDialog>
  );
}
