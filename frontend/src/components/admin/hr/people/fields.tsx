'use client';

import { useId, type ReactNode } from 'react';

/**
 * Form fields the HR record forms need and `components/forms/Fields` does not have: a
 * select over a closed vocabulary with its own labels (`SelectField` uses the option text
 * as the value, which would send "Full time" instead of `full_time`), a department-style
 * select over records, and a date input.
 *
 * Same markup and accessibility contract as `Fields.tsx`: a real label, the error tied to
 * the control with `aria-describedby`, `aria-invalid` while it fails, and the error
 * announced as it appears.
 */

function Shell({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p className="field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: ReactNode | undefined, error: string | undefined) {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export function EnumSelect<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
  hint,
  error,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </Shell>
  );
}

/** A department or designation select: "none" first, then the entries as given. */
export function OrgSelect({
  label,
  value,
  options,
  emptyLabel,
  onChange,
  hint,
  error,
  disabled,
}: {
  label: string;
  /** The id as a string; '' for none. */
  value: string;
  options: { id: number; name: string; isActive: boolean }[];
  emptyLabel: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
            {option.isActive ? '' : ' (switched off)'}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function DateField({
  label,
  value,
  onChange,
  hint,
  error,
  min,
  max,
  disabled,
}: {
  label: string;
  /** `YYYY-MM-DD`, or '' for none. */
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        className="input"
        type="date"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Shell>
  );
}
