/**
 * JMK Academy course catalogue.
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

export const cadTiles: CourseTile[] = [
  {
    id: 'engineering-cad',
    category: 'CAD & Engineering',
    title: 'Engineering CAD Training',
    description:
      'Engineering-focused CAD delivered through CAD DESK Coimbatore, working with the modelling and drafting tools used on real design work.',
    image: {
      src: '/images/gallery/academy-cad-3d-workstation.jpg',
      alt: 'Engineer working on a 3D plant model in CAD software at a dual-monitor workstation',
      width: 1600,
      height: 1067,
    },
  },
  {
    id: 'cad-lab',
    category: 'Classroom & Lab',
    title: 'CAD Training Sessions',
    description:
      'Instructor-led sessions at individual workstations, so every participant works through the exercises on screen rather than watching them.',
    image: {
      src: '/images/gallery/academy-cad-classroom.jpg',
      alt: 'Instructor presenting at a screen while participants follow on individual workstations',
      width: 1800,
      height: 2696,
    },
  },
  {
    id: 'drafting-modelling',
    category: 'Drafting & Modelling',
    title: '2D Drafting & 3D Modelling',
    description:
      'From dimensioned 2D drawings through to 3D models and assemblies — the drafting-to-modelling span the Design Studio works in daily.',
    image: {
      src: '/images/gallery/design-3d-model-workstation.jpg',
      alt: 'Three-dimensional structural assembly model open on a CAD workstation display',
      width: 1800,
      height: 1201,
    },
  },
  {
    id: 'corporate-workshops',
    category: 'For Organisations',
    title: 'Corporate Training & Workshops',
    description:
      'Corporate programmes and industry workshops for teams, plus placement assistance for individual learners.',
    image: {
      src: '/images/gallery/academy-corporate-training.jpg',
      alt: 'Presenter leading a seminar for a seated group in a corporate training room',
      width: 1800,
      height: 1202,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* SAP                                                                         */
/* -------------------------------------------------------------------------- */

export const sapBanner = {
  src: '/images/gallery/academy-sap-business-training.jpg',
  alt: 'Trainer presenting business process and reporting charts during an enterprise software session',
  width: 1800,
  height: 1200,
};

export type SapModule = {
  code: string;
  name: string;
  description: string;
  /** Why the module matters — about the module itself, never a promise to a learner. */
  why: string;
  icon: IconName;
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
  },
  {
    code: 'BASIS',
    name: 'System Administration',
    description:
      'The administration layer: installation, users and authorisations, transports, monitoring and system health.',
    why: 'Every other module runs on top of BASIS — it is the platform the functional teams depend on.',
    icon: 'server',
  },
  {
    code: 'FICO',
    name: 'Financial Accounting & Controlling',
    description:
      'General ledger, accounts payable and receivable, asset accounting, and the cost and profitability side of controlling.',
    why: 'Finance is where an ERP is ultimately reconciled, which makes FICO one of the most widely used modules.',
    icon: 'ledger',
  },
  {
    code: 'MM',
    name: 'Materials Management',
    description:
      'Purchasing, master data, inventory movements, valuation and the procure-to-pay flow.',
    why: 'Materials management connects purchasing to stock and to finance, so it touches most day-to-day operations.',
    icon: 'export',
  },
  {
    code: 'SD',
    name: 'Sales & Distribution',
    description:
      'Enquiries and quotations through orders, deliveries, billing and the order-to-cash flow.',
    why: 'Sales and distribution is the revenue side of the same chain that materials management supplies.',
    icon: 'chart',
  },
  {
    code: 'CSM',
    name: 'Customer Service Management',
    description: 'Service processes, notifications and the handling of customer requests.',
    why: 'Service keeps the relationship going after the sale, which is where much of the recurring work sits.',
    icon: 'users',
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
