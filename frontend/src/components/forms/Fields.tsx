'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useId } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * Form field primitives. Every control gets a real `<label>`, an accessible error
 * association through `aria-describedby`, and `aria-invalid` when it fails validation.
 */

type BaseProps = {
  label: string;
  name: string;
  required?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
  autoComplete?: string;
};

function FieldShell({
  label,
  id,
  required,
  hint,
  error,
  hintId,
  errorId,
  children,
}: {
  label: string;
  id: string;
  required?: boolean;
  hint?: string;
  error?: string;
  hintId: string;
  errorId: string;
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
      {hint && !error ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId} role="alert">
          <Icon name="alert" size={14} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(hint: string | undefined, error: string | undefined, hintId: string, errorId: string) {
  const ids = [error ? errorId : null, hint && !error ? hintId : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

/* -------------------------------------------------------------------------- */

type TextFieldProps = BaseProps & {
  type?: 'text' | 'email' | 'tel' | 'password';
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (value: string) => void;
  onBlur?: () => void;
};

export function TextField({
  label,
  name,
  type = 'text',
  value,
  onChange,
  onBlur,
  required,
  hint,
  error,
  placeholder,
  maxLength,
  disabled,
  autoComplete,
}: TextFieldProps) {
  const uid = useId();
  const id = `${name}-${uid}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <FieldShell
      label={label}
      id={id}
      required={required}
      hint={hint}
      error={error}
      hintId={hintId}
      errorId={errorId}
    >
      <input
        className="input"
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        onBlur={onBlur}
        required={required}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      />
    </FieldShell>
  );
}

/* -------------------------------------------------------------------------- */

type TextAreaFieldProps = BaseProps & {
  value: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
};

export function TextAreaField({
  label,
  name,
  value,
  onChange,
  onBlur,
  rows = 5,
  required,
  hint,
  error,
  placeholder,
  maxLength,
  disabled,
}: TextAreaFieldProps) {
  const uid = useId();
  const id = `${name}-${uid}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <FieldShell
      label={label}
      id={id}
      required={required}
      hint={hint}
      error={error}
      hintId={hintId}
      errorId={errorId}
    >
      <textarea
        className="textarea"
        id={id}
        name={name}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        required={required}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      />
    </FieldShell>
  );
}

/* -------------------------------------------------------------------------- */

type SelectFieldProps = BaseProps & {
  value: string;
  options: readonly string[];
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
};

export function SelectField({
  label,
  name,
  value,
  options,
  onChange,
  onBlur,
  required,
  hint,
  error,
  placeholder = 'Please select…',
  disabled,
}: SelectFieldProps) {
  const uid = useId();
  const id = `${name}-${uid}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <FieldShell
      label={label}
      id={id}
      required={required}
      hint={hint}
      error={error}
      hintId={hintId}
      errorId={errorId}
    >
      <select
        className="select"
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

/* -------------------------------------------------------------------------- */

type FileFieldProps = BaseProps & {
  file: File | null;
  accept: string;
  buttonLabel?: string;
  onChange: (file: File | null) => void;
};

export function FileField({
  label,
  name,
  file,
  accept,
  onChange,
  required,
  hint,
  error,
  disabled,
  buttonLabel = 'Choose file',
}: FileFieldProps) {
  const uid = useId();
  const id = `${name}-${uid}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <FieldShell
      label={label}
      id={id}
      required={required}
      hint={hint}
      error={error}
      hintId={hintId}
      errorId={errorId}
    >
      <div className="file-field">
        <input
          id={id}
          name={name}
          type="file"
          accept={accept}
          required={required}
          disabled={disabled}
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint, error, hintId, errorId)}
        />
        <label className="btn btn--outline btn--sm" htmlFor={id}>
          <Icon name="upload" size={16} />
          {buttonLabel}
        </label>
        <span className="file-field__name">
          {file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)` : 'No file selected'}
        </span>
        {file ? (
          <button
            type="button"
            className="btn btn--sm btn--outline"
            onClick={() => onChange(null)}
          >
            Remove
          </button>
        ) : null}
      </div>
    </FieldShell>
  );
}

/* -------------------------------------------------------------------------- */

/** Hidden field bots fill in and humans never see. Paired with a timing check. */
export function HoneypotField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="hp-field" aria-hidden="true">
      <label htmlFor="website-url">Website</label>
      <input
        id="website-url"
        name="website"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

type FormAlertProps = {
  variant: 'success' | 'error' | 'info';
  children: ReactNode;
};

export function FormAlert({ variant, children }: FormAlertProps) {
  const icon = variant === 'success' ? 'successCircle' : variant === 'error' ? 'alert' : 'info';

  return (
    <div
      className={`alert alert--${variant}`}
      role={variant === 'error' ? 'alert' : 'status'}
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
    >
      <Icon className="alert__icon" name={icon} size={18} />
      <div>{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function SubmitButton({
  pending,
  children,
  pendingLabel = 'Submitting…',
  className = 'btn btn--primary btn--lg btn--block',
}: {
  pending: boolean;
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
}) {
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? (
        <>
          <span className="btn__spinner" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
