'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { EnquiryForm } from '@/components/forms/EnquiryForm';
import { Icon } from '@/components/ui/Icon';

type EnquiryContextValue = {
  open: (options?: { interest?: string }) => void;
  close: () => void;
  isOpen: boolean;
};

const EnquiryContext = createContext<EnquiryContextValue | null>(null);

export function useEnquiry(): EnquiryContextValue {
  const context = useContext(EnquiryContext);
  if (!context) throw new Error('useEnquiry must be used inside <EnquiryProvider>');
  return context;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Owns the site-wide enquiry modal. Any component can open it via `useEnquiry()`,
 * so the floating button, header CTA and in-page CTAs all share one form and one
 * submission path.
 */
export function EnquiryProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [interest, setInterest] = useState<string | undefined>(undefined);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const open = useCallback((options?: { interest?: string }) => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setInterest(options?.interest);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Give React a tick to unmount before restoring focus.
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }, []);

  // Lock background scrolling while the modal is open.
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  // Escape to close, Tab kept inside the dialog.
  useEffect(() => {
    if (!isOpen) return;

    const node = dialogRef.current;
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key !== 'Tab' || !node) return;

      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <EnquiryContext.Provider value={value}>
      {children}

      {isOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="enquiry-modal-title"
            ref={dialogRef}
          >
            <div className="modal__head">
              <div>
                <h2 className="modal__title" id="enquiry-modal-title">
                  Enquire Now
                </h2>
                <p className="modal__subtitle">
                  Tell us what you need — our team responds to every enquiry.
                </p>
              </div>
              <button type="button" className="modal__close" onClick={close} aria-label="Close enquiry form">
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="modal__body">
              <EnquiryForm source="floating-widget" defaultInterest={interest} />
            </div>
          </div>
        </div>
      ) : null}
    </EnquiryContext.Provider>
  );
}
