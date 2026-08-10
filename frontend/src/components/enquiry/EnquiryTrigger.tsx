'use client';

import type { ReactNode } from 'react';
import { useEnquiry } from '@/components/enquiry/EnquiryProvider';
import { Icon } from '@/components/ui/Icon';

type EnquiryTriggerProps = {
  children: ReactNode;
  className?: string;
  /** Pre-selects the "Interested In" option, e.g. from a vertical page. */
  interest?: string;
  withIcon?: boolean;
};

/** Opens the shared enquiry modal from anywhere on the site. */
export function EnquiryTrigger({
  children,
  className = 'btn btn--accent',
  interest,
  withIcon = false,
}: EnquiryTriggerProps) {
  const { open } = useEnquiry();

  return (
    <button type="button" className={className} onClick={() => open({ interest })}>
      {children}
      {withIcon ? <Icon name="arrowRight" size={16} /> : null}
    </button>
  );
}

/** Persistent bottom-right enquiry button, visible on every page and breakpoint. */
export function FloatingEnquiryButton() {
  const { open, isOpen } = useEnquiry();

  if (isOpen) return null;

  return (
    <button
      type="button"
      className="floating-enquiry"
      onClick={() => open()}
      aria-label="Enquire now"
    >
      <Icon name="mail" size={20} />
      <span className="floating-enquiry__label">Enquire Now</span>
    </button>
  );
}
