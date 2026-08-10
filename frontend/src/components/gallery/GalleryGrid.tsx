'use client';

import { useMemo, useState } from 'react';
import { MediaFigure } from '@/components/ui/MediaFigure';
import { galleryCategories, gallerySlots } from '@/lib/content/gallery';

/**
 * Category-filtered gallery. Slots without a real image render a branded placeholder —
 * we never caption a placeholder with an invented project description.
 */
export function GalleryGrid() {
  const [active, setActive] = useState('all');

  const visible = useMemo(
    () => (active === 'all' ? gallerySlots : gallerySlots.filter((slot) => slot.category === active)),
    [active],
  );

  const labelFor = (categoryId: string) =>
    galleryCategories.find((category) => category.id === categoryId)?.label ?? '';

  return (
    <>
      <div className="gallery-filters" role="group" aria-label="Filter gallery by business">
        {galleryCategories.map((category) => (
          <button
            key={category.id}
            type="button"
            className="gallery-filter"
            aria-pressed={active === category.id}
            onClick={() => setActive(category.id)}
          >
            {category.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="empty-state">No images in this category yet.</p>
      ) : (
        <ul className="gallery-grid">
          {visible.map((slot) => (
            <li
              key={slot.id}
              className={`gallery-item${slot.wide ? ' gallery-item--wide' : ''}`}
            >
              <MediaFigure
                src={slot.src}
                alt={slot.alt}
                seed={slot.id}
                ratio="4 / 3"
                badge={labelFor(slot.category)}
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              />
              {slot.caption ? <p className="gallery-item__caption">{slot.caption}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
