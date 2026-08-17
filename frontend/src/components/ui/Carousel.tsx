'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * A horizontal card carousel.
 *
 * Built on native scroll with CSS scroll-snap rather than on transforms and a slide
 * index. That decision buys a lot for free: touch swiping, trackpad flicks, keyboard
 * scrolling, and — most importantly — the slides remain ordinary laid-out elements, so
 * they wrap and reflow like any other card and are all present for screen readers and
 * for find-in-page. A transform-based carousel has to reimplement each of those, and
 * usually reimplements some of them badly.
 *
 * The buttons scroll by one card rather than one "page", which is what someone
 * expects when they can see a card half-cut at the edge.
 *
 * No autoplay. Nothing here changes on its own, so nobody has to race it.
 */

type CarouselProps = {
  children: ReactNode;
  /** Announced to assistive technology, e.g. "CAD training courses". */
  label: string;
  /** Slides visible at the widest size; below that the CSS steps it down. */
  className?: string;
};

export function Carousel({ children, label, className }: CarouselProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  /** Hidden entirely when everything already fits — controls that do nothing are noise. */
  const [scrollable, setScrollable] = useState(false);

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth;
    setScrollable(max > 4);
    setAtStart(track.scrollLeft <= 4);
    setAtEnd(track.scrollLeft >= max - 4);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    measure();
    track.addEventListener('scroll', measure, { passive: true });

    // Card widths are percentage-based, so a resize changes what fits.
    const observer = new ResizeObserver(measure);
    observer.observe(track);

    return () => {
      track.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure]);

  const step = useCallback((direction: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;

    const first = track.firstElementChild as HTMLElement | null;
    // Fall back to two-thirds of the viewport if there is somehow no child to measure.
    const distance = first ? first.getBoundingClientRect().width + 16 : track.clientWidth * 0.66;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollBy({ left: direction * distance, behavior: reduced ? 'auto' : 'smooth' });
  }, []);

  return (
    <div className={['carousel', className].filter(Boolean).join(' ')}>
      <div
        className="carousel__track"
        ref={trackRef}
        role="group"
        aria-roledescription="carousel"
        aria-label={label}
        // Focusable so the arrow keys can scroll it without a pointer.
        tabIndex={0}
      >
        {children}
      </div>

      {scrollable ? (
        <div className="carousel__controls">
          <button
            type="button"
            className="carousel__btn"
            onClick={() => step(-1)}
            disabled={atStart}
            aria-label={`Previous — ${label}`}
          >
            <Icon name="arrowLeft" size={18} />
          </button>
          <button
            type="button"
            className="carousel__btn"
            onClick={() => step(1)}
            disabled={atEnd}
            aria-label={`Next — ${label}`}
          >
            <Icon name="arrowRight" size={18} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
