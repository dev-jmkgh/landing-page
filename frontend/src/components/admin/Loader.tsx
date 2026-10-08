'use client';

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getActiveRequestCount, subscribeToRequests } from '@/lib/api';

/**
 * The admin area's one loading language.
 *
 * Every screen used to say "loading" its own way — a skeleton here, a bare "Loading…"
 * paragraph there, a spinner glyph somewhere else — so the same wait looked different on
 * every panel, and some waits (a filter change, a page turn) showed nothing at all. These
 * pieces replace all of that, and the rule for choosing between them is short:
 *
 *   - First load, and the shape of the result is known  → the existing skeletons
 *     (`TableSkeleton`, `StatGridSkeleton`, chart skeletons). Showing the shape first
 *     makes the wait read as loading, not as an empty screen.
 *   - First load, shape not known yet (a dialog body, a detail section) → `LoaderBlock`.
 *   - Refetch of something already on screen (filters, a page turn) → `LoadingOverlay`.
 *     The previous content stays put, dimmed, so nothing jumps and the reader keeps their
 *     place; blanking a table on every page turn is what made the old screens flicker.
 *   - An action in flight on a button → `ButtonSpinner`, with the button disabled.
 *
 * On top of those, `GlobalLoadingBar` runs across the top of every admin screen whenever
 * any API request is in flight, driven by the transport itself (`lib/api.ts`). Nothing has
 * to opt in, so a request a panel forgot to signal still shows.
 */

type SpinnerSize = 'sm' | 'md' | 'lg';

/** The bare glyph. Decorative: the text next to it is what gets announced. */
export function Spinner({ size = 'md' }: { size?: SpinnerSize }) {
  return <span className={`loader__spinner loader__spinner--${size}`} aria-hidden="true" />;
}

/**
 * A spinner with a visible label, announced politely.
 *
 * The label is visible on purpose. "Loading the lead…" tells the reader what is coming and
 * that the screen is working; a lone spinner says neither, and is easy to mistake for a
 * stuck one.
 */
export function Loader({
  label = 'Loading…',
  size = 'md',
  inline = false,
}: {
  label?: string;
  size?: SpinnerSize;
  /** Sits in a line of text rather than on its own row. */
  inline?: boolean;
}) {
  return (
    <span className={inline ? 'loader loader--inline' : 'loader'} role="status" aria-live="polite">
      <Spinner size={size} />
      <span className="loader__label">{label}</span>
    </span>
  );
}

/**
 * A centred block standing in for content whose shape is not known yet.
 *
 * `minHeight` reserves roughly the space the content will take, so the area does not
 * collapse to a line and then jump open when the data lands.
 */
export function LoaderBlock({
  label = 'Loading…',
  minHeight = '12rem',
}: {
  label?: string;
  minHeight?: string;
}) {
  return (
    <div className="loader-block" style={{ minHeight }} aria-busy="true">
      <Loader label={label} size="lg" />
    </div>
  );
}

/**
 * Keeps the current content on screen while it is being refreshed.
 *
 * The children stay mounted and in place — dimmed and not clickable — and a small
 * "Updating…" chip says why. This is the refetch pattern: a table that blanks and
 * re-skeletons on every filter change loses the reader's place and looks broken, while
 * one that dims and settles reads as working.
 */
export function LoadingOverlay({
  busy,
  label = 'Updating…',
  children,
}: {
  busy: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="loading-overlay" data-busy={busy ? 'true' : undefined} aria-busy={busy || undefined}>
      {children}
      {busy ? (
        <div className="loading-overlay__chip" role="status" aria-live="polite">
          <Spinner size="sm" />
          <span>{label}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The glyph for a button whose action is in flight.
 *
 * Uses the site's existing `.btn__spinner` so admin buttons and form submit buttons spin
 * identically. The button itself should also be `disabled` and `aria-busy`.
 */
export function ButtonSpinner() {
  return <span className="btn__spinner" aria-hidden="true" />;
}

/**
 * How long a request may run before the bar appears.
 *
 * Most admin requests finish well inside this, and a bar that flashes for a few frames on
 * every click is noise that teaches people to ignore it.
 */
const SHOW_AFTER_MS = 150;

/** How long the completed bar lingers so it visibly finishes rather than vanishing. */
const FINISH_MS = 250;

/**
 * The thin bar across the top of every admin screen while any request is in flight.
 *
 * Driven by the transport's own in-flight counter, read through `useSyncExternalStore`
 * so it can never disagree with what the network is actually doing. Decorative to
 * assistive technology: each panel announces its own state, and a second, global
 * announcement on every request would be noise.
 */
export function GlobalLoadingBar() {
  const active = useSyncExternalStore(subscribeToRequests, getActiveRequestCount, () => 0) > 0;
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');

  useEffect(() => {
    if (active) {
      const timer = window.setTimeout(() => setState('loading'), SHOW_AFTER_MS);
      return () => window.clearTimeout(timer);
    }

    // Only a bar that was actually shown plays the finish; a request that ended inside the
    // show delay leaves no trace at all.
    setState((previous) => (previous === 'loading' ? 'done' : previous));
    const timer = window.setTimeout(() => setState('idle'), FINISH_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  return <div className="global-loading-bar" data-state={state} aria-hidden="true" />;
}

/**
 * The card shown while an admin area checks the session.
 *
 * Every admin shell (telecalling, HR, the website records area, the index redirect and the
 * login screen) rendered its own copy of this card. One component keeps them identical.
 *
 * `message` is for the one place that has something more specific to say than "checking"
 * — the index redirect, which is choosing where to send the reader.
 */
export function AdminSessionLoader({ message }: { message?: string }) {
  return (
    <div className="admin-login">
      <div className="admin-login__card" aria-busy="true">
        {message ? (
          <>
            <p className="eyebrow">JMK Global Holdings</p>
            <p style={{ color: 'var(--ink-500)', marginTop: '0.5rem' }} role="status">
              {message}
            </p>
          </>
        ) : (
          <>
            <span className="sr-only" role="status">
              Checking your session…
            </span>
            <div className="skeleton" style={{ height: '1.5rem', width: '60%' }} />
            <div className="skeleton" style={{ height: '1rem', width: '85%', marginTop: '1rem' }} />
          </>
        )}
        <div className="skeleton" style={{ height: '2.75rem', marginTop: '1.5rem' }} />
      </div>
    </div>
  );
}
