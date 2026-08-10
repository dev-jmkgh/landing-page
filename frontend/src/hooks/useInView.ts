'use client';

import { useEffect, useRef, useState } from 'react';

type Options = {
  /** Stop observing after the first intersection. Default: true. */
  once?: boolean;
  rootMargin?: string;
  threshold?: number;
};

/**
 * Minimal IntersectionObserver hook used for scroll reveals and the stat counters.
 * Falls back to "visible" when the API is unavailable so content is never hidden.
 */
export function useInView<T extends HTMLElement>({
  once = true,
  rootMargin = '0px 0px -10% 0px',
  threshold = 0.15,
}: Options = {}) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { rootMargin, threshold },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [once, rootMargin, threshold]);

  return { ref, inView };
}
