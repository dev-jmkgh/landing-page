'use client';

import { useId, type ChangeEvent } from 'react';
import { dialCodes } from '@/lib/content/dialCodes';

/**
 * Phone number with a country code picker.
 *
 * The two controls are one field, not two: they share a single label, a single error
 * and a single `aria-describedby`, because a screen reader announcing "Phone, combo
 * box" and then "Phone, edit" for what the eye reads as one input is confusing. The
 * select carries its own `sr-only` label so it is still identifiable on its own.
 *
 * The value handed back to the form is already combined — `+91 7305 555555` — so the
 * request body, the stored record and the notification email keep the single `phone`
 * string they have always had. Nothing downstream needs to know this control exists.
 */
export function PhoneField({
  label,
  name,
  dial,
  number,
  onDialChange,
  onNumberChange,
  onBlur,
  required,
  error,
  hint,
  disabled,
  maxLength,
}: {
  label: string;
  name: string;
  dial: string;
  number: string;
  onDialChange: (value: string) => void;
  onNumberChange: (value: string) => void;
  onBlur?: () => void;
  required?: boolean;
  error?: string;
  hint?: string;
  disabled?: boolean;
  maxLength?: number;
}) {
  const uid = useId();
  const id = `${name}-${uid}`;
  const dialId = `${id}-dial`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

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

      <div className="phone-field">
        <label className="sr-only" htmlFor={dialId}>
          Country dialling code
        </label>
        <select
          className="input phone-field__dial"
          id={dialId}
          name={`${name}DialCode`}
          value={dial}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => onDialChange(event.target.value)}
          onBlur={onBlur}
          disabled={disabled}
        >
          {dialCodes.map((entry) => (
            <option key={entry.code} value={entry.dial}>
              {entry.dial} · {entry.country}
            </option>
          ))}
        </select>

        <input
          className="input phone-field__number"
          id={id}
          name={name}
          type="tel"
          inputMode="tel"
          value={number}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onNumberChange(event.target.value)}
          onBlur={onBlur}
          required={required}
          placeholder="00000 00000"
          maxLength={maxLength}
          disabled={disabled}
          autoComplete="tel-national"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
        />
      </div>

      {hint && !error ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
