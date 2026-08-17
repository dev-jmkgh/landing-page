/**
 * JMK Academy course catalogue.
 *
 * IMAGERY. Service and module photographs are licensed stock (Unsplash —
 * https://unsplash.com/license, free for commercial use, no attribution required)
 * showing the *domain the service works in*: source code for ABAP, a warehouse aisle
 * for Materials Management, a server hall for licensing and hosting. None is presented
 * as a JMK site, a JMK employee or a JMK project, none is reused across tiles, and the
 * alt text describes only what the frame literally shows. Frames carrying a visible
 * third-party brand were rejected during selection — the same rule that removed the
 * shipping-line photographs from the gallery.
 *
 * Two rules govern everything here.
 *
 * The offerings are exactly those in the supplied content document: engineering CAD
 * training through CAD DESK Coimbatore, corporate training, industry workshops,
 * placement assistance, and SAP module training in ABAP, BASIS, FICO, MM, SD and CSM.
 * Nothing is added — no durations, no fees, no batch sizes, no placement figures, no
 * certifications.
 *
 * The `why` lines describe what each SAP module *is* and where it sits in an
 * organisation. That is a statement about SAP, not a promise from JMK: none of them
 * says a learner will be hired, certified or paid more. Where the document is silent
 * on an outcome, so is this file.
 *
 * Photographs represent the discipline, never a JMK facility or a JMK student — the
 * same rule the gallery documents.
 */

import type { IconName } from '@/components/ui/Icon';

export type CourseTile = {
  id: string;
  /** Small label above the title. */
  category: string;
  title: string;
  description: string;
  image: { src: string; alt: string; width: number; height: number };
};

/* -------------------------------------------------------------------------- */
/* CAD & engineering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One CAD tile, not four.
 *
 * This was a four-tile carousel, and the page then listed the same CAD services again
 * further down from `business.ts` — so a visitor met "Engineering CAD Training" twice
 * under two different presentations. There is now a single primary tile, and what the
 * other three tiles said survives as `cadHighlights` beneath it: the same information,
 * stated once, without a second set of photographs implying a second set of courses.
 *
 * The photograph is deliberately not the one behind this page's hero — the same frame
 * twice on one screen reads as a template with nothing to put in it.
 */
export const primaryCadTile: CourseTile = {
  id: 'engineering-cad',
  category: 'CAD & Engineering',
  title: 'Engineering CAD Training',
  description:
    'Engineering-focused CAD delivered through CAD DESK Coimbatore, working with the modelling and drafting tools used on real design work — from dimensioned 2D drawings through to 3D models and assemblies.',
  image: {
    src: '/images/gallery/academy-cad-workstation.jpg',
    alt: 'A widescreen monitor displaying a 3D CAD model of a structural steel assembly',
    width: 1400,
    height: 933,
  },
};

/** What the retired tiles carried, as supporting detail rather than as course cards. */
export const cadHighlights: { title: string; text: string; icon: IconName }[] = [
  {
    title: 'Instructor-led sessions',
    text: 'Participants work through the exercises at their own workstation rather than watching them.',
    icon: 'academy',
  },
  {
    title: '2D drafting to 3D modelling',
    text: 'Dimensioned drawings through to models and assemblies — the span the Design Studio works in daily.',
    icon: 'compass',
  },
  {
    title: 'For organisations',
    text: 'Corporate programmes and industry workshops for teams, plus placement assistance for individual learners.',
    icon: 'users',
  },
];

/* -------------------------------------------------------------------------- */
/* SAP                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One SAP tile, matching the CAD one in shape so the two read as a pair.
 *
 * `why` was previously a caption floating over a wide banner image. It is the single
 * most useful sentence in this section — it says what SAP is and why module training
 * exists — so it belongs in the tile rather than as an overlay on a photograph.
 */
export const primarySapTile: CourseTile & { why: string } = {
  id: 'sap-training',
  category: 'Enterprise Software',
  title: 'SAP Training',
  description:
    'Module-wise SAP training across functional and technical tracks, covering the six modules JMK Academy teaches.',
  why: 'SAP runs the core processes — finance, materials, sales, service — of a great many organisations. Module training is how people learn to work inside those processes rather than around them.',
  image: {
    src: '/images/gallery/academy-sap-business-training.jpg',
    alt: 'Trainer presenting business process and reporting charts during an enterprise software session',
    width: 1800,
    height: 1200,
  },
};

export type SapModule = {
  code: string;
  name: string;
  description: string;
  /** Why the module matters — about the module itself, never a promise to a learner. */
  why: string;
  icon: IconName;
  /**
   * Photograph of the *domain the module works in* — code for ABAP, a server hall for
   * BASIS, a warehouse for MM. Not a photograph of SAP, which has none, and not of a
   * JMK classroom. Each module gets its own frame; none is used twice.
   */
  image: { src: string; alt: string; width: number; height: number };
};

/**
 * The six modules named in the content document, in its order.
 *
 * Split functional/technical because that is how SAP itself is organised and how
 * anyone choosing between them will think about it.
 */
export const sapModules: SapModule[] = [
  {
    code: 'ABAP',
    name: 'Advanced Business Application Programming',
    description:
      'SAP’s own programming language — reports, data dictionary objects, forms and the enhancements that tailor a standard system.',
    why: 'ABAP is how an SAP system is extended, so it sits behind almost every customisation an organisation asks for.',
    icon: 'code',
    image: {
      src: '/images/gallery/sap-abap-code.jpg',
      alt: 'Program source code on a dark editor screen',
      width: 1400,
      height: 935,
    },
  },
  {
    code: 'BASIS',
    name: 'System Administration',
    description:
      'The administration layer: installation, users and authorisations, transports, monitoring and system health.',
    why: 'Every other module runs on top of BASIS — it is the platform the functional teams depend on.',
    icon: 'server',
    image: {
      src: '/images/gallery/sap-basis-servers.jpg',
      alt: 'Server racks and structured cabling in an equipment room',
      width: 1400,
      height: 934,
    },
  },
  {
    code: 'FICO',
    name: 'Financial Accounting & Controlling',
    description:
      'General ledger, accounts payable and receivable, asset accounting, and the cost and profitability side of controlling.',
    why: 'Finance is where an ERP is ultimately reconciled, which makes FICO one of the most widely used modules.',
    icon: 'ledger',
    image: {
      src: '/images/gallery/sap-fico-finance.jpg',
      alt: 'A desk with printed financial charts, a calculator and a notebook',
      width: 1400,
      height: 934,
    },
  },
  {
    code: 'MM',
    name: 'Materials Management',
    description:
      'Purchasing, master data, inventory movements, valuation and the procure-to-pay flow.',
    why: 'Materials management connects purchasing to stock and to finance, so it touches most day-to-day operations.',
    icon: 'export',
    image: {
      src: '/images/gallery/sap-mm-warehouse.jpg',
      alt: 'A warehouse aisle lined with racked and palletised stock',
      width: 1400,
      height: 934,
    },
  },
  {
    code: 'SD',
    name: 'Sales & Distribution',
    description:
      'Enquiries and quotations through orders, deliveries, billing and the order-to-cash flow.',
    why: 'Sales and distribution is the revenue side of the same chain that materials management supplies.',
    icon: 'chart',
    image: {
      src: '/images/gallery/sap-sd-dispatch.jpg',
      alt: 'Workers handling packed cartons at a distribution bay',
      width: 1400,
      height: 1050,
    },
  },
  {
    code: 'CSM',
    name: 'Customer Service Management',
    description: 'Service processes, notifications and the handling of customer requests.',
    why: 'Service keeps the relationship going after the sale, which is where much of the recurring work sits.',
    icon: 'users',
    image: {
      src: '/images/gallery/sap-csm-support.jpg',
      alt: 'Service agents wearing headsets at workstations in a support centre',
      width: 1400,
      height: 934,
    },
  },
];

/**
 * Why learn at JMK.
 *
 * Deliberately modest: each point restates something the content document actually
 * says about the Academy. No placement rates, no rankings, no partner claims.
 */
export const academyPromises: { title: string; text: string; icon: IconName }[] = [
  {
    title: 'Practical training',
    text: 'Sessions are built around working through the tools, not around slides.',
    icon: 'compass',
  },
  {
    title: 'Industry workshops',
    text: 'Workshop formats run alongside the core programmes.',
    icon: 'briefcase',
  },
  {
    title: 'Corporate programmes',
    text: 'Training can be delivered for an organisation’s own team.',
    icon: 'users',
  },
  {
    title: 'Placement assistance',
    text: 'Placement assistance is offered to learners on the CAD programmes.',
    icon: 'target',
  },
];
