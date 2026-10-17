'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useDialogs } from '@/components/admin/ConfirmDialog';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  COMPONENT_KINDS,
  COMPONENT_KIND_LABELS,
  STRUCTURE_LIMITS,
  formatPaise,
  longCalendarDate,
  parseAmountToPaise,
  payrollApi,
  type ComponentKind,
  type SalaryStructure,
} from '@/lib/hrPayroll';

/**
 * A new salary structure for one employee: the date it starts, and its components.
 *
 * THE LIVE TOTALS ARE THE ONE PLACE PAYROLL ADDS UP MONEY IN THE BROWSER. They are a sum
 * of what is being typed, so the administrator sees the net before saving, and they are
 * summed in integer paise (`parseAmountToPaise`) exactly as the server sums them — so
 * the figure here is the figure the saved structure will show. Payslip figures are never
 * computed here; those are the server's.
 *
 * Every check the server makes is also made here, next to the field it is about, so a
 * typo is caught where it was typed rather than as a banner after the round trip. The
 * server still decides — its field errors are mapped back onto the same fields, and a
 * date already used for this employee is only knowable there.
 *
 * The quick-add chips add the usual Indian components with NO amount: a pre-filled
 * figure would be an invented salary that is one careless click from being saved.
 */

type Row = {
  key: number;
  label: string;
  kind: ComponentKind;
  /** As typed. Parsed with `parseAmountToPaise`; never a float. */
  amount: string;
  /** Earnings only. */
  prorated: boolean;
};

const PRESETS: { label: string; kind: ComponentKind }[] = [
  { label: 'Basic', kind: 'earning' },
  { label: 'HRA', kind: 'earning' },
  { label: 'Special allowance', kind: 'earning' },
  { label: 'Conveyance', kind: 'earning' },
  { label: 'Provident fund', kind: 'deduction' },
  { label: 'Professional tax', kind: 'deduction' },
  { label: 'TDS', kind: 'deduction' },
];

/** A copy of `errors` without the given keys — the fields just corrected. */
function without(errors: Record<string, string>, ...keys: string[]): Record<string, string> {
  const next = { ...errors };
  for (const key of keys) delete next[key];
  return next;
}

/** Paise as the plain decimal an amount field holds: 3000000 → "30000", 150 → "1.50". */
function paiseToInput(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest === 0 ? String(rupees) : `${rupees}.${String(rest).padStart(2, '0')}`;
}

export function StructureForm({
  employeeName,
  userId,
  copyFrom,
  onCancel,
  onCreated,
  onUnauthorized,
}: {
  employeeName: string;
  userId: number;
  /**
   * The structure in force (or, without one, the upcoming one), offered as a starting
   * point for a revision. Copying brings its own amounts — real figures, not invented.
   */
  copyFrom: SalaryStructure | null;
  onCancel: () => void;
  onCreated: (structure: SalaryStructure) => void;
  onUnauthorized: () => void;
}) {
  const dialogs = useDialogs();
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;

  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const nextKey = useRef(1);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** The id of a field to focus after the next render — a row just added, a field in error. */
  const focusAfterRender = useRef<string | null>(null);
  useEffect(() => {
    if (!focusAfterRender.current) return;
    document.getElementById(focusAfterRender.current)?.focus();
    focusAfterRender.current = null;
  });

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  /* ---------------------------------------------------------------- rows */

  const addRow = (kind: ComponentKind, label = '', focus: 'label' | 'amount' = 'label') => {
    if (rows.length >= STRUCTURE_LIMITS.components) return;
    const key = nextKey.current++;
    setRows((current) => [...current, { key, label, kind, amount: '', prorated: kind === 'earning' }]);
    setErrors((current) => without(current, 'components'));
    focusAfterRender.current = id(`${focus}-${key}`);
  };

  const updateRow = (key: number, change: Partial<Omit<Row, 'key'>>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
    // The field being corrected stops showing its old error, and so does a totals error
    // that the change may have fixed.
    setErrors((current) =>
      without(current, 'components', ...Object.keys(change).map((field) => `${key}.${field}`)),
    );
  };

  const removeRow = (key: number, index: number) => {
    setRows((current) => current.filter((row) => row.key !== key));
    setErrors((current) => without(current, `${key}.label`, `${key}.amount`, 'components'));
    // Focus moves to the row that took its place, or the add buttons when it was last.
    const following = rows[index + 1] ?? rows[index - 1];
    focusAfterRender.current = following ? id(`label-${following.key}`) : id('add-earning');
  };

  const copyCurrent = () => {
    if (!copyFrom) return;
    setRows(
      copyFrom.components.map((component) => ({
        key: nextKey.current++,
        label: component.label,
        kind: component.kind,
        amount: paiseToInput(Math.round(component.amount * 100)),
        prorated: component.kind === 'earning' ? component.prorated : false,
      })),
    );
    setErrors({});
    const first = nextKey.current - copyFrom.components.length;
    focusAfterRender.current = id(`amount-${first}`);
  };

  const usedLabels = new Set(rows.map((row) => row.label.trim().toLowerCase()));
  const full = rows.length >= STRUCTURE_LIMITS.components;

  /* -------------------------------------------------------------- totals */

  let earningsPaise = 0;
  let deductionsPaise = 0;
  let unfilled = 0;
  for (const row of rows) {
    const parsed = parseAmountToPaise(row.amount);
    if (!parsed.ok) {
      unfilled += 1;
      continue;
    }
    if (row.kind === 'earning') earningsPaise += parsed.paise;
    else deductionsPaise += parsed.paise;
  }
  const netPaise = earningsPaise - deductionsPaise;

  /* ---------------------------------------------------------- validation */

  const validate = (): { found: Record<string, string>; first: string | null } => {
    const found: Record<string, string> = {};
    let first: string | null = null;
    const fail = (key: string, message: string, fieldId: string) => {
      found[key] = message;
      first ??= fieldId;
    };

    if (!effectiveFrom) {
      fail('effectiveFrom', 'Choose the date this structure starts.', id('effective'));
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      fail('effectiveFrom', 'Enter a real date.', id('effective'));
    }

    if (note.trim().length > STRUCTURE_LIMITS.noteLength) {
      fail('note', `Keep the note to ${STRUCTURE_LIMITS.noteLength} characters or fewer.`, id('note'));
    }

    if (rows.length === 0) {
      fail('components', 'Add at least one component.', id('add-earning'));
    }

    let rowsValid = true;
    for (const row of rows) {
      if (!row.label.trim()) {
        rowsValid = false;
        fail(`${row.key}.label`, 'Name the component.', id(`label-${row.key}`));
      }
      const parsed = parseAmountToPaise(row.amount);
      if (!parsed.ok) {
        rowsValid = false;
        fail(`${row.key}.amount`, parsed.error, id(`amount-${row.key}`));
      }
    }

    // Only once every amount reads, or the totals would be judged on half a structure.
    if (rows.length > 0 && rowsValid) {
      if (earningsPaise <= 0) {
        fail('components', 'Add at least one earning above zero.', id('add-earning'));
      } else if (deductionsPaise > earningsPaise) {
        fail('components', 'Deductions cannot be more than earnings.', id('totals'));
      }
    }

    return { found, first };
  };

  /* -------------------------------------------------------------- submit */

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;

    setFormError(null);
    const { found, first } = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError('Check the highlighted fields.');
      focusAfterRender.current = first;
      return;
    }

    // Fixed for the round trip, so a field error for `components.2` lands on the row that
    // was third when it was sent.
    const submitted = rows;
    setSaving(true);

    try {
      const structure = await payrollApi.createStructure({
        userId,
        effectiveFrom,
        note: note.trim() || null,
        components: submitted.map((row) => {
          const parsed = parseAmountToPaise(row.amount);
          return {
            label: row.label.trim(),
            kind: row.kind,
            // Whole paise back to rupees: exact for two decimals.
            amount: parsed.ok ? parsed.paise / 100 : 0,
            prorated: row.kind === 'earning' ? row.prorated : false,
          };
        }),
      });
      onCreated(structure);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (!(caught instanceof ApiError)) {
        setFormError('Could not save the structure.');
        return;
      }

      const mapped: Record<string, string> = {};
      let firstField: string | null = null;
      for (const [field, message] of Object.entries(caught.fieldErrors)) {
        const match = /^components\.(\d+)\.(\w+)$/.exec(field);
        const row = match ? submitted[Number(match[1])] : undefined;
        if (match && row) {
          const part = match[2] === 'label' ? 'label' : 'amount';
          mapped[`${row.key}.${part}`] = message;
          firstField ??= id(`${part}-${row.key}`);
        } else if (field.startsWith('components')) {
          mapped.components = message;
          firstField ??= id('totals');
        } else if (field === 'effectiveFrom' || field === 'note') {
          mapped[field] = message;
          firstField ??= id(field === 'effectiveFrom' ? 'effective' : 'note');
        } else {
          mapped[field] = message;
        }
      }

      setErrors(mapped);
      const inline = Object.values(mapped);
      // The banner only when it adds something: a 400 for a used date carries the same
      // sentence as its field error, and saying it twice is noise.
      setFormError(inline.includes(caught.message) ? null : caught.message);
      focusAfterRender.current = firstField;
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    const dirty = rows.length > 0 || note.trim() !== '' || effectiveFrom !== '';
    if (
      dirty &&
      !(await dialogs.confirm({
        title: 'Discard this new structure?',
        message: 'Nothing you typed is saved.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      }))
    ) {
      return;
    }
    onCancel();
  };

  /* ---------------------------------------------------------------- view */

  const fieldError = (key: string, fieldId: string) =>
    errors[key] ? (
      <p className="field__error" id={`${fieldId}-error`} role="alert">
        <Icon name="alert" size={14} />
        {errors[key]}
      </p>
    ) : null;

  const otherErrors = Object.entries(errors).filter(
    ([key]) => !/^\d+\.(label|amount)$/.test(key) && !['effectiveFrom', 'note', 'components'].includes(key),
  );

  return (
    <form
      className="tc-card tc-form hr-pay-structure-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-labelledby={id('title')}
    >
      <div>
        <h3 className="tc-section-title hr-pay-form-title" id={id('title')} ref={headingRef} tabIndex={-1}>
          New salary structure for {employeeName}
        </h3>
        <p className="tc-muted">
          What they are paid in a full month. Payroll works out the rest from attendance and leave.
        </p>
      </div>

      {formError ? <FormAlert variant="error">{formError}</FormAlert> : null}
      {otherErrors.length > 0 ? (
        <FormAlert variant="error">{otherErrors.map(([, message]) => message).join(' ')}</FormAlert>
      ) : null}

      <div className="tc-form__grid">
        <div className={`field${errors.effectiveFrom ? ' field--invalid' : ''}`}>
          <label className="field__label" htmlFor={id('effective')}>
            Effective from
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={id('effective')}
            className="input"
            type="date"
            value={effectiveFrom}
            required
            disabled={saving}
            aria-invalid={errors.effectiveFrom ? true : undefined}
            aria-describedby={errors.effectiveFrom ? `${id('effective')}-error` : `${id('effective')}-hint`}
            onChange={(event) => {
              setEffectiveFrom(event.target.value);
              setErrors((current) => without(current, 'effectiveFrom'));
            }}
          />
          {fieldError('effectiveFrom', id('effective')) ?? (
            <p className="field__hint" id={`${id('effective')}-hint`}>
              Each pay period is paid by the latest structure starting on or before its last day,
              for the whole period — a structure from the 20th also pays the period’s days
              before the 20th.
            </p>
          )}
        </div>

        <div className={`field${errors.note ? ' field--invalid' : ''}`}>
          <label className="field__label" htmlFor={id('note')}>
            Note (optional)
          </label>
          <input
            id={id('note')}
            className="input"
            value={note}
            maxLength={STRUCTURE_LIMITS.noteLength}
            disabled={saving}
            placeholder="e.g. Annual revision"
            aria-invalid={errors.note ? true : undefined}
            aria-describedby={errors.note ? `${id('note')}-error` : undefined}
            onChange={(event) => {
              setNote(event.target.value);
              setErrors((current) => without(current, 'note'));
            }}
          />
          {fieldError('note', id('note'))}
        </div>
      </div>

      {/* ---------------------------------------------------------- components */}
      <fieldset className="hr-pay-fieldset" aria-describedby={id('components-help')}>
        <legend className="field__label">Components</legend>
        <p className="tc-muted hr-pay-components-help" id={id('components-help')}>
          An earning marked <strong>reduced for loss-of-pay days</strong> is paid in proportion to
          the days paid: with 2 loss-of-pay days in a 30-day month it pays 28/30 of the amount.
          Loss-of-pay days are unpaid leave and absences. Other earnings, and every deduction,
          are paid or taken in full.
        </p>

        <div className="hr-pay-chips" role="group" aria-label="Quick add a common component">
          <span className="hr-pay-chips__label" aria-hidden="true">
            Quick add
          </span>
          {PRESETS.map((preset) => {
            const used = usedLabels.has(preset.label.toLowerCase());
            return (
              <button
                key={preset.label}
                type="button"
                className="hr-pay-chip"
                data-kind={preset.kind}
                disabled={used || full || saving}
                aria-label={`Add ${preset.label} (${COMPONENT_KIND_LABELS[preset.kind].toLowerCase()})${used ? ', already added' : ''}`}
                onClick={() => addRow(preset.kind, preset.label, 'amount')}
              >
                <Icon name="add" size={13} />
                {preset.label}
              </button>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <p className="hr-pay-components-empty">
            No components yet. Use the quick-add chips or the buttons below
            {copyFrom ? ', or copy their existing structure and change what is different' : ''}.
          </p>
        ) : (
          <ol className="hr-pay-components">
            {rows.map((row, index) => {
              const labelId = id(`label-${row.key}`);
              const amountId = id(`amount-${row.key}`);
              const kindId = id(`kind-${row.key}`);
              const proratedId = id(`prorated-${row.key}`);
              const labelError = errors[`${row.key}.label`];
              const amountError = errors[`${row.key}.amount`];
              return (
                <li key={row.key} className="hr-pay-component" data-kind={row.kind}>
                  <span className="sr-only">Component {index + 1}</span>

                  <div className={`field hr-pay-component__label${labelError ? ' field--invalid' : ''}`}>
                    <label className="field__label hr-pay-sublabel" htmlFor={labelId}>
                      Name
                    </label>
                    <input
                      id={labelId}
                      className="input input--sm"
                      value={row.label}
                      maxLength={STRUCTURE_LIMITS.labelLength}
                      disabled={saving}
                      placeholder={row.kind === 'earning' ? 'e.g. Basic' : 'e.g. Provident fund'}
                      aria-invalid={labelError ? true : undefined}
                      aria-describedby={labelError ? `${labelId}-error` : undefined}
                      onChange={(event) => updateRow(row.key, { label: event.target.value })}
                    />
                    {fieldError(`${row.key}.label`, labelId)}
                  </div>

                  <div className="field hr-pay-component__kind">
                    <label className="field__label hr-pay-sublabel" htmlFor={kindId}>
                      Type
                    </label>
                    <select
                      id={kindId}
                      className="select select--sm"
                      value={row.kind}
                      disabled={saving}
                      onChange={(event) => {
                        const kind = event.target.value as ComponentKind;
                        updateRow(row.key, { kind, prorated: kind === 'earning' });
                      }}
                    >
                      {COMPONENT_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {COMPONENT_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={`field hr-pay-component__amount${amountError ? ' field--invalid' : ''}`}>
                    <label className="field__label hr-pay-sublabel" htmlFor={amountId}>
                      Monthly amount (₹)
                    </label>
                    <input
                      id={amountId}
                      className="input input--sm hr-pay-amount-input"
                      inputMode="decimal"
                      autoComplete="off"
                      value={row.amount}
                      disabled={saving}
                      placeholder="0.00"
                      aria-invalid={amountError ? true : undefined}
                      aria-describedby={amountError ? `${amountId}-error` : undefined}
                      onChange={(event) => updateRow(row.key, { amount: event.target.value })}
                    />
                    {fieldError(`${row.key}.amount`, amountId)}
                  </div>

                  <div className="hr-pay-component__prorate">
                    {row.kind === 'earning' ? (
                      <label className="hr-pay-check" htmlFor={proratedId}>
                        <input
                          id={proratedId}
                          type="checkbox"
                          checked={row.prorated}
                          disabled={saving}
                          onChange={(event) => updateRow(row.key, { prorated: event.target.checked })}
                        />
                        <span>Reduced for loss-of-pay days</span>
                      </label>
                    ) : (
                      <span className="tc-muted">Always taken in full</span>
                    )}
                  </div>

                  <button
                    type="button"
                    className="btn btn--ghost btn--sm hr-pay-component__remove"
                    disabled={saving}
                    onClick={() => removeRow(row.key, index)}
                    aria-label={`Remove ${row.label.trim() || `component ${index + 1}`}`}
                  >
                    <Icon name="close" size={15} />
                    <span className="hr-pay-component__remove-text">Remove</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        <div className="hr-pay-component-actions">
          <button
            type="button"
            id={id('add-earning')}
            className="btn btn--outline btn--sm"
            disabled={full || saving}
            onClick={() => addRow('earning')}
          >
            <Icon name="add" size={15} />
            Add earning
          </button>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            disabled={full || saving}
            onClick={() => addRow('deduction')}
          >
            <Icon name="add" size={15} />
            Add deduction
          </button>
          {copyFrom && rows.length === 0 ? (
            <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={copyCurrent}>
              Copy the structure from {longCalendarDate(copyFrom.effectiveFrom)}
            </button>
          ) : null}
          {full ? (
            <span className="tc-muted">A structure can have at most {STRUCTURE_LIMITS.components} components.</span>
          ) : null}
        </div>

        {errors.components ? (
          <p className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {errors.components}
          </p>
        ) : null}
      </fieldset>

      {/* -------------------------------------------------------------- totals */}
      <div
        className="hr-pay-form-totals"
        id={id('totals')}
        tabIndex={-1}
        aria-label="Totals for a full month"
        data-invalid={netPaise < 0 || (rows.length > 0 && earningsPaise === 0 && unfilled === 0) ? 'true' : undefined}
      >
        <dl>
          <div>
            <dt>Earnings</dt>
            <dd>{formatPaise(earningsPaise)}</dd>
          </div>
          <div>
            <dt>Deductions</dt>
            <dd>{formatPaise(deductionsPaise)}</dd>
          </div>
          <div className="hr-pay-form-totals__net">
            <dt>Net a month</dt>
            <dd>{netPaise < 0 ? `−${formatPaise(-netPaise)}` : formatPaise(netPaise)}</dd>
          </div>
        </dl>
        <p className="tc-muted">
          {unfilled > 0
            ? `Full-month figures. ${unfilled === 1 ? 'One amount is' : `${unfilled} amounts are`} not entered yet and ${unfilled === 1 ? 'is' : 'are'} left out.`
            : netPaise < 0
              ? 'Deductions are more than earnings — the server refuses that.'
              : 'Full-month figures, before any loss of pay.'}
        </p>
      </div>

      <div className="hr-pay-form-buttons">
        <button type="submit" className="btn btn--primary" disabled={saving} aria-busy={saving || undefined}>
          {saving ? <ButtonSpinner /> : <Icon name="check" size={16} />}
          {saving ? 'Saving…' : 'Save structure'}
        </button>
        <button type="button" className="btn btn--ghost" disabled={saving} onClick={() => void cancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
