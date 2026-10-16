'use client';

import { useId } from 'react';
import { WEEKDAYS, WEEKDAY_LONG, WEEKDAY_SHORT, type Weekday } from '@/lib/hr';

/**
 * Seven toggle buttons, Sunday to Saturday, for choosing weekly off days.
 *
 * Toggle buttons (`aria-pressed`) rather than seven tick boxes because the choice is read
 * as a week at a glance — a row of pressed days says "Sat and Sun off" faster than a
 * column of labels. Each button still announces its full day name and state.
 *
 * Picking none is allowed and said out loud: an empty list is a real policy (a seven-day
 * rota), not a form left blank.
 */
export function WeekdayPicker({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
}: {
  label: string;
  value: readonly Weekday[];
  onChange: (next: Weekday[]) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;

  const toggle = (day: Weekday) => {
    const next = value.includes(day) ? value.filter((d) => d !== day) : [...value, day];
    // Always week order, so the saved value never depends on the order of the clicks.
    onChange(WEEKDAYS.filter((d) => next.includes(d)));
  };

  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <span className="field__label" id={labelId}>
        {label}
      </span>
      <div
        className="hrp-weekdays"
        role="group"
        aria-labelledby={labelId}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
      >
        {WEEKDAYS.map((day) => (
          <button
            key={day}
            type="button"
            className="hrp-weekdays__day"
            aria-pressed={value.includes(day)}
            aria-label={WEEKDAY_LONG[day]}
            disabled={disabled}
            onClick={() => toggle(day)}
          >
            {WEEKDAY_SHORT[day]}
          </button>
        ))}
      </div>
      {error ? (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : (
        <p className="field__hint" id={hintId}>
          {value.length === 0 ? 'No weekly off — every day is a working day. ' : ''}
          {hint}
        </p>
      )}
    </div>
  );
}
