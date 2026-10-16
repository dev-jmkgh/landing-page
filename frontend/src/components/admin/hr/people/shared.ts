'use client';

import { useCallback, useEffect, useRef } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Small pieces the HR people and attendance screens share.
 *
 * Kept out of the telecalling `shared.tsx` because nothing here is presentational — it is
 * the error and dialog plumbing every HR form repeats.
 */

/** A request cancelled because a newer one replaced it. Never an error to show. */
export function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

/** The server's sentence if there is one, otherwise the screen's own fallback. */
export function messageFor(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

/**
 * The outcome of a failed write, sorted into what the screen does with it.
 *
 * - `unauthorized`: the session ended — hand over to the shell's sign-in redirect.
 * - `forbidden`: a supervisor reached an administrator-only action. That is a role gate,
 *   not a fault, so the caller says so in its own words.
 * - `fields`: errors keyed by field, to show beside each input.
 */
export function classifyWriteError(caught: unknown): {
  unauthorized: boolean;
  forbidden: boolean;
  message: string;
  fields: Record<string, string>;
} {
  if (caught instanceof ApiError) {
    return {
      unauthorized: caught.status === 401,
      forbidden: caught.status === 403,
      message: caught.message,
      fields: caught.fieldErrors ?? {},
    };
  }
  return {
    unauthorized: false,
    forbidden: false,
    message: 'Something went wrong. Please try again in a moment.',
    fields: {},
  };
}

/**
 * A close handler whose identity never changes.
 *
 * `Dialog` re-runs its open effect — which moves focus to the panel — whenever `onClose`
 * changes identity, so a parent that re-renders while the dialog is open (a list refresh
 * landing) would pull focus out of the field being typed in. The latest handler lives in
 * a ref and `Dialog` gets one stable function. Same fix as the telecalling move dialog.
 */
export function useStableClose(onClose: () => void): () => void {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  });
  return useCallback(() => ref.current(), []);
}

/** Pick out the field errors a form knows how to place; the rest go in the banner. */
export function unplacedErrors(fields: Record<string, string>, known: readonly string[]): string[] {
  return Object.entries(fields)
    .filter(([key]) => !known.includes(key))
    .map(([, message]) => message);
}

/** The same email check the telecalling forms use before the round trip. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

/** The server's phone rule (`optionalPhoneField`), repeated for a message before sending. */
export const PHONE_PATTERN = /^[0-9+\-\s()]{6,20}$/;
