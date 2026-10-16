'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Spinner } from '@/components/admin/Loader';
import { ApiError } from '@/lib/api';
import { peopleApi, type HrEmployee } from '@/lib/hr';
import { isAbort } from './shared';

/**
 * Chooses one employee by searching the directory — used for "reports to".
 *
 * A search rather than a dropdown because the directory is unbounded: a select would
 * have to load everyone to offer them, which is exactly the whole-list fetch the HR
 * screens never make. Each keystroke (debounced) asks the server for one small page of
 * APPROVED accounts — the only ones the server accepts as a manager.
 *
 * Two layouts. `inline` lists the matches under the box, for a dialog form. `popover`
 * floats them over the content, for the filter bar, and closes on Escape or when focus
 * leaves the picker.
 */

export type PickedEmployee = { id: number; name: string; employeeCode: string | null };

const RESULT_SIZE = 8;

export function EmployeePicker({
  label,
  value,
  onChange,
  excludeId,
  hint,
  error,
  disabled,
  layout = 'inline',
  onUnauthorized,
}: {
  label: string;
  value: PickedEmployee | null;
  onChange: (next: PickedEmployee | null) => void;
  /** The employee being edited — nobody can be their own manager. */
  excludeId?: number;
  hint?: string;
  error?: string;
  disabled?: boolean;
  layout?: 'inline' | 'popover';
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const statusId = `${uid}-status`;

  /** True while the search box is showing instead of the chosen name. */
  const [searching, setSearching] = useState(value === null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<HrEmployee[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  /** Focus the box once it renders after "Change" — not on first mount. */
  const focusInput = useRef(false);

  /*
   * Follows the value when it changes from outside — a filter cleared, a form reset — so
   * a set value shows as chosen and a cleared one shows the search box. Keyed on the id so
   * re-rendering with an equal object does not throw away a search in progress.
   */
  const valueId = value?.id ?? null;
  useEffect(() => {
    setSearching(valueId === null);
  }, [valueId]);

  useEffect(() => {
    if (searching && focusInput.current) {
      focusInput.current = false;
      inputRef.current?.focus();
    }
  }, [searching]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!searching || !open) return undefined;

    const controller = new AbortController();
    setLoading(true);
    setFailure(null);

    peopleApi
      .directory(
        { q: debounced || undefined, approval: 'approved', page: 1, pageSize: RESULT_SIZE },
        controller.signal,
      )
      .then((page) => {
        setResults(page.items.filter((employee) => employee.id !== excludeId));
        setTotal(page.total);
      })
      .catch((caught: unknown) => {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setFailure(caught instanceof ApiError ? caught.message : 'Could not search employees.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [searching, open, debounced, excludeId, onUnauthorized]);

  const choose = (employee: HrEmployee) => {
    onChange({ id: employee.id, name: employee.name, employeeCode: employee.employeeCode });
    setSearching(false);
    setOpen(false);
    setQuery('');
    // Back to the control that now names the choice, so the keyboard user is not lost.
    window.setTimeout(() => changeRef.current?.focus(), 0);
  };

  const moveFocus = (from: HTMLElement | null, step: 1 | -1) => {
    const options = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (options.length === 0) return;
    const index = from ? options.indexOf(from as HTMLButtonElement) : -1;
    const next = index + step;
    if (next < 0) {
      inputRef.current?.focus();
      return;
    }
    options[Math.min(next, options.length - 1)]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && event.target === inputRef.current) {
      /*
       * The picker sits inside forms, where Enter in a text box submits. Here it means
       * "take the only match" — and with several, nothing, rather than saving the form
       * with no manager chosen.
       */
      event.preventDefault();
      const only = results?.length === 1 ? results[0] : undefined;
      if (only) choose(only);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      moveFocus(event.target === inputRef.current ? null : (event.target as HTMLElement), 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.target as HTMLElement, -1);
    } else if (event.key === 'Escape' && layout === 'popover' && open) {
      // Close the list only. In a dialog the inline layout is used, so Escape there still
      // reaches the dialog and closes it as everywhere else.
      event.preventDefault();
      setOpen(false);
      inputRef.current?.focus();
    }
  };

  const visible = (results ?? []).length;
  const status = !open
    ? ''
    : failure
      ? failure
      : loading && results === null
        ? 'Searching…'
        : visible === 0
          ? debounced
            ? `No approved employee matches “${debounced}”.`
            : 'No approved employees yet.'
          : total > RESULT_SIZE
            ? `Showing ${visible} of ${total}. Keep typing to narrow it.`
            : `${visible} ${visible === 1 ? 'match' : 'matches'}.`;

  if (!searching && value) {
    return (
      <div className={`field${error ? ' field--invalid' : ''}`}>
        <span className="field__label">{label}</span>
        <div className="hrp-picker__chosen">
          <span>
            <strong>{value.name}</strong>
            {value.employeeCode ? <span className="tc-muted tc-mono"> {value.employeeCode}</span> : null}
          </span>
          <button
            ref={changeRef}
            type="button"
            className="tc-text-button"
            disabled={disabled}
            onClick={() => {
              focusInput.current = true;
              setSearching(true);
              setOpen(true);
            }}
            aria-label={`Change ${label.toLowerCase()} from ${value.name}`}
          >
            Change
          </button>
          <button
            type="button"
            className="tc-text-button"
            disabled={disabled}
            onClick={() => onChange(null)}
            aria-label={`Remove ${value.name} as ${label.toLowerCase()}`}
          >
            Remove
          </button>
        </div>
        {error ? (
          <p className="field__error" id={errorId} role="alert">
            {error}
          </p>
        ) : hint ? (
          <p className="field__hint">{hint}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`field hrp-picker hrp-picker--${layout}${error ? ' field--invalid' : ''}`}
      onBlur={(event) => {
        // Focus moving between the box and its matches keeps the list; leaving closes it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={onKeyDown}
    >
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="hrp-picker__box">
        <input
          ref={inputRef}
          id={inputId}
          className="input"
          type="search"
          autoComplete="off"
          value={query}
          disabled={disabled}
          placeholder="Search by name, email or code"
          // A plain search box that controls a list of buttons, not a combobox: the matches
          // are announced through the live status line, and Arrow Down moves into them.
          aria-controls={open && visible > 0 ? listId : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errorId : hint ? hintId : null, statusId].filter(Boolean).join(' ')}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
        />
        {loading ? (
          <span className="hrp-picker__spinner">
            <Spinner size="sm" />
          </span>
        ) : null}
      </div>

      {open ? (
        <div className="hrp-picker__panel">
          <p className="hrp-picker__status" id={statusId} role="status" aria-live="polite">
            {status}
          </p>
          {visible > 0 ? (
            <ul className="hrp-picker__list" id={listId} ref={listRef}>
              {(results ?? []).map((employee) => (
                <li key={employee.id}>
                  <button
                    type="button"
                    className="hrp-picker__option"
                    // Keeps the box focused through the click, so the popover does not
                    // close between mouse-down and the choice landing.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(employee)}
                  >
                    <span className="hrp-picker__name">{employee.name}</span>
                    <span className="hrp-picker__meta">
                      {[employee.employeeCode, employee.designationName, employee.departmentName]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <span id={statusId} className="sr-only" />
      )}

      {value && searching ? (
        <button
          type="button"
          className="tc-text-button hrp-picker__keep"
          onClick={() => {
            setSearching(false);
            setOpen(false);
            setQuery('');
            window.setTimeout(() => changeRef.current?.focus(), 0);
          }}
        >
          Keep {value.name}
        </button>
      ) : null}

      {error ? (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
