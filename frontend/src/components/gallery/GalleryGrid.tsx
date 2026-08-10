'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  categoryLabel,
  galleryCategories,
  itemsForCategory,
  type GalleryCategoryId,
} from '@/lib/content/gallery';

/**
 * Category-filtered editorial gallery with a lightbox.
 *
 * Tiles vary in size (feature / wide / tall / standard) so the grid reads as an
 * art-directed portfolio rather than a uniform wall of squares. Every image is a
 * licensed stock photograph representing the discipline — see the note at the top of
 * `lib/content/gallery.ts`.
 */
export function GalleryGrid() {
  const [active, setActive] = useState<GalleryCategoryId | 'all'>('all');
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const items = useMemo(() => itemsForCategory(active), [active]);
  const current = openIndex === null ? null : (items[openIndex] ?? null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const open = useCallback((index: number) => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setOpenIndex(index);
  }, []);

  const close = useCallback(() => {
    setOpenIndex(null);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }, []);

  const step = useCallback(
    (delta: number) => {
      setOpenIndex((index) => {
        if (index === null) return index;
        // Wrap around so the arrows never dead-end.
        return (index + delta + items.length) % items.length;
      });
    },
    [items.length],
  );

  /* Keyboard: Escape closes, arrows navigate, Tab stays inside the dialog. */
  useEffect(() => {
    if (openIndex === null) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (event.key === 'Tab') {
        const node = dialogRef.current;
        if (!node) return;
        const focusable = node.querySelectorAll<HTMLElement>('button, a[href]');
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
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openIndex, close, step]);

  /* Touch swipe on the lightbox image. */
  const touchStartX = useRef<number | null>(null);
  const onTouchStart = (event: React.TouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const startX = touchStartX.current;
    const endX = event.changedTouches[0]?.clientX;
    touchStartX.current = null;
    if (startX === null || endX === undefined) return;
    const delta = endX - startX;
    if (Math.abs(delta) > 50) step(delta < 0 ? 1 : -1);
  };

  function selectCategory(id: GalleryCategoryId | 'all') {
    setActive(id);
    setOpenIndex(null);
  }

  return (
    <>
      <div className="gallery-filters" role="group" aria-label="Filter the gallery by business">
        {galleryCategories.map((category) => {
          const count = itemsForCategory(category.id).length;
          return (
            <button
              key={category.id}
              type="button"
              className="gallery-filter"
              aria-pressed={active === category.id}
              onClick={() => selectCategory(category.id)}
            >
              {category.label}
              <span className="gallery-filter__count">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Re-keying on the active filter restarts the staggered entry animation. */}
      <ul className="gallery-grid" key={active}>
        {items.map((item, index) => (
          <li
            key={item.id}
            className="gallery-tile"
            style={{ '--tile-index': index } as React.CSSProperties}
          >
            <button
              type="button"
              className="gallery-card"
              onClick={() => open(index)}
              aria-label={`${item.title} — ${categoryLabel(item.category)}. Open larger image.`}
            >
              <span className="gallery-card__media">
                <Image
                  className="gallery-card__img"
                  src={item.src}
                  alt={item.alt}
                  width={item.width}
                  height={item.height}
                  sizes="(max-width: 639px) 100vw, (max-width: 1023px) 50vw, 33vw"
                  // The first row is above the fold on most screens.
                  loading={index < 3 ? 'eager' : 'lazy'}
                />
                <span className="gallery-card__arrow" aria-hidden="true">
                  <Icon name="arrowUpRight" size={15} />
                </span>
              </span>

              <span className="gallery-card__body">
                <span className="gallery-card__category">{categoryLabel(item.category)}</span>
                <span className="gallery-card__title">{item.title}</span>
                <span className="gallery-card__description">{item.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {current && openIndex !== null ? (
        <div
          className="lightbox"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            className="lightbox__dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${current.title}. Image ${openIndex + 1} of ${items.length}.`}
            tabIndex={-1}
            ref={dialogRef}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            <figure className="lightbox__figure">
              <Image
                className="lightbox__img"
                src={current.src}
                alt={current.alt}
                width={current.width}
                height={current.height}
                sizes="(max-width: 1100px) 100vw, 1040px"
                priority
              />
            </figure>

            <figcaption className="lightbox__caption">
              <p className="lightbox__category">{categoryLabel(current.category)}</p>
              <p className="lightbox__title">{current.title}</p>
              <p className="lightbox__description">{current.description}</p>
              {current.credit ? (
                <p className="lightbox__credit">
                  Representative image ·{' '}
                  <a href={current.credit.url} target="_blank" rel="noopener noreferrer">
                    {current.credit.photographer}
                  </a>{' '}
                  on Unsplash
                </p>
              ) : null}
            </figcaption>

            <div className="lightbox__controls">
              <p className="lightbox__counter">
                {openIndex + 1} / {items.length}
              </p>
              <button type="button" className="lightbox__btn lightbox__btn--close" onClick={close} aria-label="Close">
                <Icon name="close" size={18} />
              </button>
              {items.length > 1 ? (
                <>
                  <button
                    type="button"
                    className="lightbox__btn lightbox__btn--prev"
                    onClick={() => step(-1)}
                    aria-label="Previous image"
                  >
                    <Icon name="arrowLeft" size={18} />
                  </button>
                  <button
                    type="button"
                    className="lightbox__btn lightbox__btn--next"
                    onClick={() => step(1)}
                    aria-label="Next image"
                  >
                    <Icon name="arrowRight" size={18} />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
