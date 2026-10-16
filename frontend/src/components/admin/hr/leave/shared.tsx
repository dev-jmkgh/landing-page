'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';

/**
 * Small pieces shared by the HR leave, requests and documents screens.
 *
 * Kept to what at least two of those screens use. The telecalling `shared.tsx` already
 * provides the table furniture (Pager, Tag, EmptyPanel, TableSkeleton, DateTimeCell) and
 * is imported directly rather than wrapped.
 */

export function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

/**
 * The sentence to show for a failed write, or null when the failure was a signed-out
 * session (the caller has already handed that to `onUnauthorized`).
 *
 * A 403 is named as a role gate rather than shown as the server's generic refusal: a
 * supervisor can read every one of these screens but change none of them, and "only an
 * administrator can…" tells them whose move it is.
 */
export function writeFailure(
  caught: unknown,
  onUnauthorized: () => void,
  forbidden: string,
  fallback: string,
): string | null {
  if (caught instanceof ApiError && caught.status === 401) {
    onUnauthorized();
    return null;
  }
  if (caught instanceof ApiError && caught.status === 403) return forbidden;
  return caught instanceof ApiError ? caught.message : fallback;
}

/** The same for a read: 401 hands over, anything else is a sentence. */
export function readFailure(caught: unknown, onUnauthorized: () => void, fallback: string): string | null {
  if (caught instanceof ApiError && caught.status === 401) {
    onUnauthorized();
    return null;
  }
  return caught instanceof ApiError ? caught.message : fallback;
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The admin form dialog: the shared `Dialog` shell, the `tc-dialog` head, and two pieces
 * of focus handling the shell leaves to its caller.
 *
 * 1. `onClose` is held in a ref and the shell gets one stable function. The shell re-runs
 *    its open effect — which focuses the panel — whenever `onClose` changes identity, so a
 *    screen re-rendering behind an open dialog (a list refresh landing) would otherwise
 *    pull focus out of the field being typed in. Same fix as MoveFollowUpDialog.
 * 2. Focus returns to whatever opened the dialog when it closes for ANY reason. The shell
 *    restores focus only when it closes itself (Escape, the close button); a dialog the
 *    screen closes after a successful save would otherwise drop focus on the body.
 *
 * `initialFocus` moves focus into the first field once the shell has focused its panel —
 * a deferred focus, because the shell's own effect runs after this one and would take it
 * straight back.
 */
export function HrDialog({
  title,
  eyebrow,
  sub,
  label,
  wide = false,
  onClose,
  initialFocus,
  children,
}: {
  title: string;
  eyebrow?: string;
  sub?: ReactNode;
  /** Accessible name, when it should say more than the heading. */
  label?: string;
  wide?: boolean;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const close = useCallback(() => onCloseRef.current(), []);

  /*
   * The opener, read during the first render. Not in an effect: the shell is a child,
   * its effects run first, and by the time this component's effect ran the shell would
   * already have moved focus onto its own panel.
   */
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    const timer = window.setTimeout(() => initialFocus?.current?.focus(), 0);

    return () => {
      window.clearTimeout(timer);
      window.setTimeout(() => {
        if (opener && opener.isConnected) opener.focus();
      }, 0);
    };
    // Mount and unmount only: this is the dialog opening and closing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      label={label ?? title}
      className={wide ? 'tc-dialog tc-dialog--wide' : 'tc-dialog'}
      dismissOnBackdrop={false}
    >
      <div className="tc-dialog__head">
        {eyebrow ? <p className="tc-dialog__eyebrow">{eyebrow}</p> : null}
        <h2 className="tc-dialog__title">{title}</h2>
        {sub ? <p className="tc-dialog__sub">{sub}</p> : null}
      </div>
      {children}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* The address                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One panel-owned query parameter, kept in the address with `replaceState`.
 *
 * `HrApp` owns `?section=` and pushes a new history entry per section; within a section a
 * panel only REPLACES, so a tab change or an opened record never adds a Back step of its
 * own, but a refresh, a pasted link or Back from another section reopens the same view.
 *
 * The parameter is removed again when the panel unmounts, so it does not ride along into
 * the next section's address. The history entry the panel was on keeps it, which is what
 * makes Back return to the same view.
 */
export function readUrlParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

function writeUrlParam(name: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null || value === '') url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  if (url.href !== window.location.href) {
    // The existing state is kept: HrApp's entries carry `{ section }`.
    window.history.replaceState(window.history.state, '', url);
  }
}

export function useUrlParam(name: string, value: string | null): void {
  useEffect(() => {
    writeUrlParam(name, value);
  }, [name, value]);

  useEffect(
    () => () => {
      writeUrlParam(name, null);
    },
    [name],
  );
}

/** A value from the address, if it is one of `allowed`. */
export function readUrlEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = readUrlParam(name);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A positive integer id from the address, or null. */
export function readUrlId(name: string): number | null {
  const value = readUrlParam(name);
  if (value === null || !/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

/* -------------------------------------------------------------------------- */
/* Year                                                                        */
/* -------------------------------------------------------------------------- */

/** The bounds the server accepts for a leave or holiday year. */
export const YEAR_MIN = 2000;
export const YEAR_MAX = 2100;

/**
 * Previous / this / next year. Balances and holidays are both per calendar year, and the
 * common moves are one step either way — setting next year's holidays in December,
 * checking last year's balances in January.
 */
export function YearSwitcher({
  year,
  onChange,
  label,
  disabled = false,
}: {
  year: number;
  onChange: (next: number) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="hrl-year" role="group" aria-label={label}>
      <button
        type="button"
        className="btn btn--outline btn--sm"
        onClick={() => onChange(year - 1)}
        disabled={disabled || year <= YEAR_MIN}
        aria-label={`Previous year, ${year - 1}`}
      >
        <Icon name="arrowLeft" size={15} />
      </button>
      <span className="hrl-year__value" aria-live="polite">
        {year}
      </span>
      <button
        type="button"
        className="btn btn--outline btn--sm"
        onClick={() => onChange(year + 1)}
        disabled={disabled || year >= YEAR_MAX}
        aria-label={`Next year, ${year + 1}`}
      >
        <Icon name="arrowRight" size={15} />
      </button>
    </div>
  );
}

/** Total pages for an HR page, which carries `total` and `pageSize` but no page count. */
export function pageCount(page: { total: number; pageSize: number }): number {
  return Math.max(1, Math.ceil(page.total / Math.max(1, page.pageSize)));
}
