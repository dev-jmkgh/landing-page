'use client';

import { useEffect, useState } from 'react';
import { useInView } from '@/hooks/useInView';

type CountUpProps = {
  value: number;
  suffix?: string;
  /** Animation length in ms. */
  duration?: number;
};

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts from 0 to `value` once the element scrolls into view. */
export function CountUp({ value, suffix = '', duration = 1400 }: CountUpProps) {
  const { ref, inView } = useInView<HTMLSpanElement>({ threshold: 0.4 });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;

    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }

    let frame = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      // easeOutExpo — quick and settled, no bounce.
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setDisplay(Math.round(value * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, value, duration]);

  return (
    <span ref={ref}>
      {display.toLocaleString('en-IN')}
      {suffix ? <span>{suffix}</span> : null}
    </span>
  );
}
