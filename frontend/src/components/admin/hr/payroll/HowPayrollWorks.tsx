'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { cycleSpan } from '@/lib/hrPayroll';

/**
 * A small "i" button beside the Pay periods heading that opens four lines on how payroll
 * works, for an administrator who is not an accountant: structures first, then a period,
 * then figures so far, then the final calculation and approval.
 *
 * A button, not a standing banner: the steps are read once, and a card above the list
 * pushed the pay periods down for everybody, every visit.
 *
 * A disclosure, not a modal. The panel follows the button in the tab order, so a keyboard
 * user reaches its link next; Escape closes it and puts focus back on the button, and so
 * does a click anywhere outside it.
 */
export function HowPayrollWorks({
  startDay,
  onOpenStructures,
}: {
  /** The pay cycle's start day, or null while it is loading or could not be read. */
  startDay: number | null;
  onOpenStructures: () => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <span className="hr-pay-howto" ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className="hr-pay-howto__button"
        aria-expanded={open}
        aria-controls={`${uid}-panel`}
        aria-label="How payroll works"
        title="How payroll works"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="info" size={17} />
      </button>

      {open ? (
        <div className="hr-pay-howto__panel" id={`${uid}-panel`} role="region" aria-labelledby={`${uid}-title`}>
          <div className="hr-pay-howto__head">
            <p className="hr-pay-howto__title" id={`${uid}-title`}>
              How payroll works
            </p>
            <button
              type="button"
              className="hr-pay-howto__close"
              aria-label="Close"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              <Icon name="close" size={15} />
            </button>
          </div>

          <ol className="hr-pay-howto__steps">
            <li>
              <strong>Give each employee a salary structure</strong> — what they are paid in a
              full month.{' '}
              <button
                type="button"
                className="tc-text-button"
                onClick={() => {
                  setOpen(false);
                  onOpenStructures();
                }}
              >
                Salary structures
              </button>
            </li>
            <li>
              <strong>Open the pay period.</strong> It follows your pay cycle
              {startDay !== null ? `: ${cycleSpan(startDay)}` : ''}.
            </li>
            <li>
              <strong>Calculate payslips any time</strong> to see the figures so far. Days still
              to come are not counted yet.
            </li>
            <li>
              <strong>When the period has ended, recalculate once more and approve.</strong>{' '}
              Employees then see their payslips in the HR app.
            </li>
          </ol>
        </div>
      ) : null}
    </span>
  );
}
