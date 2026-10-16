'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { peopleApi, type HrEmployee } from '@/lib/hr';
import { isAbort } from './shared';

/**
 * One employee, chosen by searching the directory — `GET /admin/hr/employees?q`.
 *
 * A search rather than a select of everybody: the directory is paged and unbounded, and
 * a dropdown of the whole company is exactly the "load every row" the screens never do.
 * Eight matches at a time, approved accounts only (a pending registration has no days to
 * report), active or not — somebody who left last month is still in last month's report.
 *
 * The ARIA 1.2 combobox pattern: the input owns the list, arrow keys move through it,
 * Enter picks, Escape closes. Once picked, the employee shows as a chip with a clear
 * button, so the filter in force is always visible.
 */

export type PickedEmployee = {
  id: number;
  /** Null when only the id is known (a link opened from the address); the picker looks the name up. */
  name: string | null;
  code: string | null;
};

const MATCHES = 8;
const DEBOUNCE_MS = 300;

export function EmployeePicker({
  id,
  value,
  onChange,
  onUnauthorized,
  label = 'Employee',
}: {
  id: string;
  value: PickedEmployee | null;
  onChange: (next: PickedEmployee | null) => void;
  onUnauthorized: () => void;
  label?: string;
}) {
  const labelId = useId();
  const listId = useId();
  const statusId = useId();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<HrEmployee[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(-1);
  /** The name behind an id that arrived without one. */
  const [resolved, setResolved] = useState<PickedEmployee | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    unauthorizedRef.current = onUnauthorized;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // The search itself, one request at a time; a newer query aborts the older one.
  useEffect(() => {
    if (!debounced) {
      setResults(null);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    setFailed(false);

    peopleApi
      .directory({ q: debounced, pageSize: MATCHES, approval: 'approved' }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setResults(page.items);
        setActive(page.items.length > 0 ? 0 : -1);
        setSearching(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) unauthorizedRef.current();
        setResults(null);
        setFailed(true);
        setSearching(false);
      });

    return () => controller.abort();
  }, [debounced]);

  // An id from the address: look up who it is, so the chip names a person, not a number.
  const needsName = value !== null && value.name === null && resolved?.id !== value.id;
  const lookupId = needsName ? value.id : null;
  useEffect(() => {
    if (lookupId === null) return;
    const controller = new AbortController();
    peopleApi
      .employee(lookupId, controller.signal)
      .then(({ employee }) => {
        if (!controller.signal.aborted) {
          setResolved({ id: employee.id, name: employee.name, code: employee.employeeCode });
        }
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) unauthorizedRef.current();
        // Not found or not readable: the chip keeps saying "Employee #id", which is still true.
      });
    return () => controller.abort();
  }, [lookupId]);

  const choose = (employee: HrEmployee) => {
    onChange({ id: employee.id, name: employee.name, code: employee.employeeCode });
    setQuery('');
    setDebounced('');
    setResults(null);
    setOpen(false);
  };

  const clear = () => {
    onChange(null);
    // Back to the search box, so the next person can be typed straight away.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  if (value) {
    const shown = value.name !== null ? value : resolved?.id === value.id ? resolved : null;
    const name = shown?.name ?? `Employee #${value.id}`;

    return (
      <div className="field hr-picker">
        <span className="field__label" id={labelId}>
          {label}
        </span>
        <div className="hr-picker__chip" role="group" aria-labelledby={labelId}>
          <span className="hr-picker__chip-name">
            {name}
            {shown?.code ? <span className="hr-picker__chip-code"> · {shown.code}</span> : null}
          </span>
          <button
            type="button"
            className="hr-picker__clear"
            onClick={clear}
            aria-label={`Remove the employee filter (${name})`}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
    );
  }

  const items = results ?? [];
  const expanded = open && debounced.length > 0;
  const activeId = expanded && active >= 0 && items[active] ? `${listId}-${items[active].id}` : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      if (items.length > 0) setActive((current) => (current + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (items.length > 0) setActive((current) => (current <= 0 ? items.length - 1 : current - 1));
    } else if (event.key === 'Enter') {
      const picked = expanded && active >= 0 ? items[active] : undefined;
      if (picked) {
        event.preventDefault();
        choose(picked);
      }
    } else if (event.key === 'Escape') {
      if (expanded) {
        event.preventDefault();
        setOpen(false);
      } else if (query) {
        event.preventDefault();
        setQuery('');
      }
    }
  };

  const statusText = !debounced
    ? ''
    : searching
      ? 'Searching…'
      : failed
        ? 'The search did not work. Try again in a moment.'
        : items.length === 0
          ? 'No approved employee matches that.'
          : `${items.length === MATCHES ? `First ${MATCHES}` : items.length} ${items.length === 1 ? 'match' : 'matches'}. Use the arrow keys to choose.`;

  return (
    <div className="field hr-picker">
      <label className="field__label" id={labelId} htmlFor={id}>
        {label}
      </label>
      <div className="hr-picker__box">
        <input
          ref={inputRef}
          id={id}
          className="input"
          type="search"
          role="combobox"
          autoComplete="off"
          placeholder="Name, email or code"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-describedby={statusId}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />

        <ul id={listId} role="listbox" aria-labelledby={labelId} className="hr-picker__list" hidden={!expanded || items.length === 0}>
          {items.map((employee, index) => (
            <li
              key={employee.id}
              id={`${listId}-${employee.id}`}
              role="option"
              aria-selected={index === active}
              className="hr-picker__option"
              // Keeps focus in the input, so the blur that closes the list never beats the click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(employee)}
              onMouseEnter={() => setActive(index)}
            >
              <span className="hr-picker__option-name">{employee.name}</span>
              <span className="hr-picker__option-meta">
                {employee.employeeCode}
                {employee.departmentName ? ` · ${employee.departmentName}` : ''}
                {employee.isActive ? '' : ' · inactive'}
              </span>
            </li>
          ))}
        </ul>

        {expanded && items.length === 0 && statusText ? (
          <p className="hr-picker__empty" aria-hidden="true">
            {statusText}
          </p>
        ) : null}
      </div>
      <span id={statusId} className="sr-only" role="status" aria-live="polite">
        {open ? statusText : ''}
      </span>
    </div>
  );
}
