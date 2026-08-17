'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Photo } from '@/components/ui/Photo';
import { Reveal } from '@/components/ui/Reveal';
import { contributions } from '@/lib/content/home';

/**
 * The national-contribution cards.
 *
 * Each card carries a photograph and one line; the full statement moves into a dialog.
 * The cards previously showed the whole paragraph, which made six of them a wall of
 * text at identical length — nothing to scan by, and the section took more height than
 * anything else on the page. A face you can scan and a dialog you can open reads faster
 * and says the same thing.
 *
 * The whole card is the button rather than a "read more" link inside it: the card has
 * no other action, so making only part of it activate would leave most of an obviously
 * clickable surface inert.
 */
export function ContributionGrid() {
  const [openId, setOpenId] = useState<string | null>(null);
  const current = contributions.find((item) => item.id === openId) ?? null;

  return (
    <>
      <div className="contribution-grid">
        {contributions.map((item, index) => (
          <Reveal key={item.id} delay={index * 60}>
            <button
              type="button"
              className="contribution"
              onClick={() => setOpenId(item.id)}
              aria-haspopup="dialog"
            >
              {/* The icon is a sibling of the media, not a child of it: the media
                  clips its overflow so the photograph can scale on hover, and a
                  badge straddling its lower edge from inside gets cut in half. */}
              <span className="contribution__media">
                <Photo
                  src={item.image.src}
                  alt={item.image.alt}
                  width={item.image.width}
                  height={item.image.height}
                  sizes="(max-width: 639px) 92vw, (max-width: 1023px) 46vw, 30vw"
                />
              </span>
              <span className="contribution__icon" aria-hidden="true">
                <Icon name={item.icon} size={20} />
              </span>

              <span className="contribution__body">
                <span className="contribution__title">{item.title}</span>
                <span className="contribution__text">{item.summary}</span>
                <span className="contribution__more">
                  Read more
                  <Icon name="arrowRight" size={15} />
                </span>
              </span>
            </button>
          </Reveal>
        ))}
      </div>

      <Dialog
        open={current !== null}
        onClose={() => setOpenId(null)}
        title={current?.title ?? ''}
        label={current ? `${current.title} — how this supports national development` : undefined}
      >
        {current ? (
          <>
            <div className="dialog__media">
              <Photo
                src={current.image.src}
                alt={current.image.alt}
                width={current.image.width}
                height={current.image.height}
                sizes="(max-width: 719px) 92vw, 640px"
              />
            </div>
            <div className="dialog__body">
              <p className="dialog__eyebrow">Contribution to national development</p>
              <h3 className="dialog__title">{current.title}</h3>
              <p className="dialog__text">{current.description}</p>
            </div>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
