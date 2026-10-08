'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * A modal dialog.
 *
 * The behaviour here is the part that is easy to get wrong and easy to forget: Escape
 * closes, Tab is trapped inside, the page behind does not scroll, focus moves in on
 * open, and — the one most often missed — focus returns to whatever opened it on close,
 * so a keyboard user is not dumped back at the top of the document.
 *
 * The gallery lightbox implements the same behaviour separately. It is deliberately
 * left alone rather than refactored onto this component: it also handles arrow-key
 * navigation between images and swipe gestures, so folding the two together would mean
 * changing working code on a page this change has no other business touching.
 */
export function Dialog({
  open,
  onClose,
  title,
  label,
  className,
  dismissOnBackdrop = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered as the dialog's heading. */
  title: string;
  /** Accessible name, when it should differ from the visible heading. */
  label?: string;
  /**
   * Extra classes for the panel, appended to `.dialog`.
   *
   * For a dialog that needs its own width or layout — an admin form is wider than the
   * marketing card this shell was built for. Omit it and the panel is exactly as before.
   */
  className?: string;
  /**
   * Whether a click on the dimmed backdrop closes the dialog. Defaults to true, which is
   * what the marketing dialogs rely on.
   *
   * Pass false for a dialog that holds a form. There, a click that lands a few pixels
   * outside the panel is far more often a slip than a decision, and closing would throw
   * away whatever had been typed. Escape and the close button still work either way.
   */
  dismissOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Captured on open, restored on close.
  useEffect(() => {
    if (open) returnFocusRef.current = document.activeElement as HTMLElement;
  }, [open]);

  const close = useCallback(() => {
    onClose();
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={dismissOnBackdrop ? close : undefined}>
      <div
        className={className ? `dialog ${className}` : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? title}
        tabIndex={-1}
        ref={dialogRef}
        // Clicks inside must not reach the backdrop's close handler.
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="dialog__close" onClick={close}>
          <Icon name="close" size={18} />
          <span className="sr-only">Close</span>
        </button>
        {children}
      </div>
    </div>
  );
}
