'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Spinner } from '@/components/admin/Loader';
import { Icon } from '@/components/ui/Icon';
import { leaveAdminApi, type HrEmployeeOption } from '@/lib/hrLeave';
import { Tag } from '../../telecalling/shared';
import { isAbort, readFailure } from './shared';

/**
 * Chooses one HR employee by searching the directory (`GET /admin/hr/employees?q`).
 *
 * A search, not a dropdown of everyone: the directory is paged on the server and the
 * screens never gather all of it. One page of eight matches is shown, with the total, so
 * "type more" is an instruction rather than a guess.
 *
 * Keyboard: ArrowDown moves from the box into the matches, ArrowUp/ArrowDown move
 * between them, Escape closes the list and returns to the box. The match count is
 * announced politely, so a screen-reader user hears that the list changed.
 *
 * `inline` lays the matches out in the flow instead of floating them — for use inside a
 * dialog, whose scrolling body would otherwise clip a floating list.
 */

const PAGE_SIZE = 8;

export function EmployeePicker({
  label,
  value,
  onChange,
  onUnauthorized,
  hint,
  error,
  disabled = false,
  inline = false,
  placeholder = 'Name, email or employee code',
  changeLabel = 'Change',
}: {
  label: string;
  value: HrEmployeeOption | null;
  onChange: (next: HrEmployeeOption | null) => void;
  onUnauthorized: () => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  inline?: boolean;
  placeholder?: string;
  /** The chosen name's button: "Change" in a form, "Clear" on a filter. */
  changeLabel?: string;
}) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ query: string; items: HrEmployeeOption[]; total: number } | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  /** Set by "Change", so the box that replaces the chosen name takes focus. */
  const focusAfterClear = useRef(false);

  useEffect(() => {
    if (value === null && focusAfterClear.current) {
      focusAfterClear.current = false;
      inputRef.current?.focus();
    }
  }, [value]);

  useEffect(() => {
    if (value !== null) return undefined;

    const term = query.trim();
    // One character matches half the directory; wait for something worth searching for.
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      setSearchError(null);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);

      leaveAdminApi
        .searchEmployees({ q: term, pageSize: PAGE_SIZE }, controller.signal)
        .then((page) => {
          setResults({ query: term, items: page.items, total: page.total });
          setOpen(true);
        })
        .catch((caught: unknown) => {
          if (isAbort(caught)) return;
          const message = readFailure(caught, onUnauthorized, 'Could not search the employees.');
          if (message !== null) setSearchError(message);
        })
        .finally(() => {
          // A newer keystroke owns the spinner now.
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, value, onUnauthorized]);

  const choose = (option: HrEmployeeOption) => {
    onChange(option);
    setQuery('');
    setResults(null);
    setOpen(false);
  };

  const options = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-option]') ?? []);

  /**
   * An Escape that closes the list must not also close the dialog around it.
   *
   * `stopPropagation` alone is not enough here: the App Router mounts React on
   * `document`, the same node the dialog listens on for Escape, and stopping propagation
   * does not stop other listeners on the node the event is already at. React's listener
   * was added first, at hydration, so stopping the rest of them at that node works.
   */
  const keepEscape = (event: KeyboardEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results && results.items.length > 0) {
      event.preventDefault();
      setOpen(true);
      window.setTimeout(() => options()[0]?.focus(), 0);
    } else if (event.key === 'Escape' && open && results !== null) {
      // Closes the list only — an Escape with no list open still closes the dialog.
      keepEscape(event);
      setOpen(false);
    }
  };

  const onOptionKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const all = options();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      all[Math.min(all.length - 1, index + 1)]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else all[index - 1]?.focus();
    } else if (event.key === 'Escape') {
      keepEscape(event);
      setOpen(false);
      inputRef.current?.focus();
    }
  };

  const describedBy = [error ? errorId : null, hint && !error ? hintId : null].filter(Boolean).join(' ');

  /* ------------------------------------------------------------ chosen */

  if (value !== null) {
    return (
      <div className={`field${error ? ' field--invalid' : ''}`}>
        <span className="field__label" id={`${uid}-label`}>
          {label}
        </span>
        <div className="hrl-picker__chosen" role="group" aria-labelledby={`${uid}-label`}>
          <span className="hrl-picker__chosen-name">{value.name}</span>
          <span className="tc-mono tc-muted">{value.employeeCode}</span>
          {!value.isActive ? <Tag tone="warn">Switched off</Tag> : null}
          <button
            type="button"
            className="tc-text-button"
            disabled={disabled}
            onClick={() => {
              focusAfterClear.current = true;
              onChange(null);
            }}
            aria-label={`${changeLabel} the employee (now ${value.name})`}
          >
            {changeLabel}
          </button>
        </div>
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

  /* ------------------------------------------------------------ search */

  const showList = open && results !== null;
  const status = searching
    ? 'Searching…'
    : results === null
      ? ''
      : results.items.length === 0
        ? `No employee matches “${results.query}”.`
        : `${results.total} ${results.total === 1 ? 'employee matches' : 'employees match'}.`;

  return (
    <div
      ref={rootRef}
      className={`field hrl-picker${inline ? ' hrl-picker--inline' : ''}${error ? ' field--invalid' : ''}`}
      onBlur={(event) => {
        // Closes when focus leaves the picker altogether, not when it moves into the list.
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="hrl-picker__box">
        <input
          ref={inputRef}
          id={inputId}
          className="input"
          type="search"
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          aria-controls={showList ? listId : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (results) setOpen(true);
          }}
          onKeyDown={onInputKey}
        />
        {searching ? (
          <span className="hrl-picker__spinner">
            <Spinner size="sm" />
          </span>
        ) : null}
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>

      {showList ? (
        <div
          className="hrl-picker__results"
          /*
           * Keeps focus in the box while a match is clicked. Safari does not focus a
           * button on click, so without this the box's blur — with no related target —
           * closed the list before the click on the match arrived.
           */
          onMouseDown={(event) => event.preventDefault()}
        >
          {results.items.length === 0 ? (
            <p className="hrl-picker__empty">
              No employee matches “{results.query}”. Only approved accounts are listed.
            </p>
          ) : (
            <ul ref={listRef} id={listId} className="hrl-picker__list" aria-label={`Employees matching ${results.query}`}>
              {results.items.map((option, index) => (
                <li key={option.id}>
                  <button
                    type="button"
                    data-option
                    className="hrl-picker__option"
                    onClick={() => choose(option)}
                    onKeyDown={(event) => onOptionKey(event, index)}
                  >
                    <span className="hrl-picker__option-name">
                      {option.name}
                      <span className="tc-mono tc-muted">{option.employeeCode}</span>
                      {!option.isActive ? <Tag tone="warn">Switched off</Tag> : null}
                    </span>
                    <span className="hrl-picker__option-meta">
                      {[option.designationName, option.departmentName, option.email]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {results.total > results.items.length ? (
            <p className="hrl-picker__more">
              Showing {results.items.length} of {results.total}. Type more of the name, email or
              code to narrow it down.
            </p>
          ) : null}
        </div>
      ) : null}

      {searchError ? (
        <p className="field__error" role="alert">
          <Icon name="alert" size={14} />
          {searchError}
        </p>
      ) : null}
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
