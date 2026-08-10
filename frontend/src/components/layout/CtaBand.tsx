import Link from 'next/link';
import { EnquiryTrigger } from '@/components/enquiry/EnquiryTrigger';
import { Icon } from '@/components/ui/Icon';
import { PatternBackdrop } from '@/components/ui/PatternBackdrop';

type CtaBandProps = {
  title: string;
  text: string;
  /** Pre-selects the enquiry modal's "Interested In" value. */
  interest?: string;
  secondary?: { label: string; href: string };
  patternId: string;
};

export function CtaBand({ title, text, interest, secondary, patternId }: CtaBandProps) {
  return (
    <section className="cta-band">
      <PatternBackdrop
        className="page-hero__backdrop"
        id={patternId}
        variant="blueprint"
      />
      <div className="container">
        <div className="cta-band__inner">
          <div>
            <h2 className="cta-band__title">{title}</h2>
            <p className="cta-band__text">{text}</p>
          </div>
          <div className="cta-band__actions">
            <EnquiryTrigger className="btn btn--accent btn--lg" interest={interest} withIcon>
              Enquire Now
            </EnquiryTrigger>
            {secondary ? (
              <Link className="btn btn--ghost-light btn--lg" href={secondary.href}>
                {secondary.label}
                <Icon name="arrowRight" size={16} />
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
