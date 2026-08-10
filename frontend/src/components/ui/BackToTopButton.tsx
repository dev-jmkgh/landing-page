'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';

/** Distance scrolled before the button appears. */
const REVEAL_AFTER_PX = 400;

/**
 * Floating "Back to top" control, mounted once in the site chrome so it is available
 * on every page. It sits directly above the "Enquire Now" button — the vertical offset
 * is derived from that button's size in CSS, so the two can never overlap.
 */
export function BackToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > REVEAL_AFTER_PX);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToTop = useCallback(() => {
    // Honour the OS-level motion preference: an instant jump rather than a long glide.
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });

    // Scrolling alone does not move keyboard focus, which would leave a keyboard user
    // still deep in the page. Send focus back to the top of the document.
    const main = document.getElementById('main-content');
    if (main) {
      main.setAttribute('tabindex', '-1');
      main.focus({ preventScroll: true });
      main.removeAttribute('tabindex');
    }
  }, []);

  return (
    <button
      type="button"
      className={`back-to-top${visible ? ' is-visible' : ''}`}
      onClick={scrollToTop}
      aria-label="Back to top"
      // Removed from the tab order while hidden so it is never a focusable ghost.
      tabIndex={visible ? 0 : -1}
      aria-hidden={visible ? undefined : true}
    >
      <Icon name="arrowUp" size={20} strokeWidth={2} />
    </button>
  );
}
