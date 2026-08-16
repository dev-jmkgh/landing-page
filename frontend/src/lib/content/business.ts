import type { IconName } from '@/components/ui/Icon';

/**
 * Business verticals and group sectors.
 *
 * Vertical names, taglines and service lists are exactly those supplied in the content
 * document. Service descriptions explain the *discipline* in neutral terms — they never
 * name software, clients, industries served, project values or capacity, none of which
 * were supplied.
 */

export type ServiceItem = {
  name: string;
  description?: string;
  /** Sub-items, e.g. the SAP module list. */
  items?: string[];
};

export type ServiceGroup = {
  id: string;
  title: string;
  intro?: string;
  icon: IconName;
  services: ServiceItem[];
  /** Rendered as an external-link call to action inside the group. */
  externalCta?: { label: string; href: string; note: string };
};

export type Vertical = {
  slug: string;
  name: string;
  /** Short identifier used in the visual mark (no logo files were supplied). */
  mark: string;
  tagline: string;
  icon: IconName;
  cardSummary: string;
  cardServices: string[];
  hero: {
    eyebrow: string;
    heading: string;
    intro: string;
  };
  groups: ServiceGroup[];
  seo: { title: string; description: string };
};

export const verticals: Vertical[] = [
  {
    slug: 'jmk-academy',
    name: 'JMK Academy',
    mark: 'JA',
    tagline: 'CAD DESK and SAP training',
    icon: 'academy',
    cardSummary:
      'Engineering CAD training delivered through CAD DESK Coimbatore and SAP module training — with corporate programmes, industry workshops and placement assistance.',
    cardServices: [
      'Engineering CAD Training',
      'SAP Training',
      'Corporate Training',
      'Industry Workshops',
      'Placement Assistance',
    ],
    hero: {
      eyebrow: 'Business Vertical',
      heading: 'Training that turns learners into industry-ready professionals',
      intro:
        'JMK Academy delivers CAD DESK and SAP training. Our engineering training programs prepare skilled professionals for infrastructure, manufacturing, construction, defense, and industrial sectors by providing expertise in CAD, simulation, and engineering technologies.',
    },
    groups: [
      {
        id: 'cad',
        title: 'Engineering CAD Training',
        intro:
          'CAD training at JMK Academy runs under the CAD DESK Coimbatore centre on NSR Road. Course details, batches and enrolment are handled on the CAD DESK website.',
        icon: 'compass',
        services: [
          {
            name: 'CAD Training',
            description:
              'Structured CAD programmes for students and working engineers, delivered at our Coimbatore centre.',
          },
          {
            name: 'Corporate Training',
            description: 'Team training arranged for organisations around their own schedules.',
          },
          {
            name: 'Industry Workshops',
            description: 'Short-format workshops covering engineering design tools and practice.',
          },
          {
            name: 'Placement Assistance',
            description: 'Placement support extended to candidates completing our programmes.',
          },
        ],
        externalCta: {
          label: 'Visit CAD DESK Coimbatore',
          href: 'https://caddeskindia.com/cad-desk-coimbatore-nsr-rd/',
          note: 'Opens caddeskindia.com — the official CAD DESK Coimbatore (NSR Road) website.',
        },
      },
      {
        id: 'sap',
        title: 'SAP Training',
        intro: 'Module-wise SAP training across functional and technical tracks.',
        icon: 'server',
        services: [
          {
            name: 'SAP Modules',
            description: 'Training is offered across the following modules.',
            items: ['ABAP', 'BASIS', 'FICO', 'MM', 'SD', 'CSM'],
          },
        ],
      },
    ],
    seo: {
      title: 'JMK Academy — CAD & SAP Training',
      description:
        'CAD training through CAD DESK Coimbatore and SAP modules (ABAP, BASIS, FICO, MM, SD, CSM), with workshops and placement assistance.',
    },
  },
  {
    slug: 'jmk-design-studio',
    name: 'JMK Design Studio',
    mark: 'JD',
    tagline: 'All CAD Designing Works',
    icon: 'compass',
    cardSummary:
      'A dedicated engineering design studio covering all CAD designing works — from 2D drafting and 3D modelling through to product design, visualisation and reverse engineering.',
    cardServices: [
      '2D Drafting',
      '3D Modeling',
      'Product Design',
      'Architectural Visualization',
      'Industrial Design',
      'Rendering Services',
      'Reverse Engineering',
    ],
    hero: {
      eyebrow: 'Business Vertical',
      heading: 'Engineering design, drafting and visualisation under one roof',
      intro:
        'JMK Design Studio handles all CAD designing works — 2D drafting, 3D modeling, product design, architectural visualization, industrial design, rendering services and reverse engineering — supported by the same engineering expertise that drives our training programmes.',
    },
    groups: [
      {
        id: 'design-services',
        title: 'Design & Drafting Services',
        icon: 'compass',
        services: [
          {
            name: '2D Drafting',
            description:
              'Dimensioned production drawings, layouts and detail sheets prepared to your drawing standards.',
          },
          {
            name: '3D Modeling',
            description:
              'Parametric part and assembly models built for downstream design, review and manufacturing use.',
          },
          {
            name: 'Product Design',
            description: 'Concept development through to detailed design of manufacturable products.',
          },
          {
            name: 'Architectural Visualization',
            description:
              'Visual representation of architectural and interior spaces for review and presentation.',
          },
          {
            name: 'Industrial Design',
            description: 'Form, ergonomics and aesthetics developed alongside engineering requirements.',
          },
          {
            name: 'Rendering Services',
            description: 'High-quality renders produced from CAD geometry for presentation and approvals.',
          },
          {
            name: 'Reverse Engineering',
            description: 'Existing parts and assemblies translated back into accurate CAD models and drawings.',
          },
        ],
      },
    ],
    seo: {
      title: 'JMK Design Studio — CAD Design & Drafting',
      description:
        '2D drafting, 3D modeling, product design, architectural visualization, industrial design, rendering and reverse engineering from JMK Design Studio.',
    },
  },
  {
    slug: 'jmk-software-solutions',
    name: 'JMK Software Solutions',
    mark: 'JS',
    tagline: 'Software, web, mobile, cloud and digital infrastructure',
    icon: 'software',
    cardSummary:
      'Software development covering ERP, web and mobile applications, websites and analytics — plus digital marketing support, email box server, domain and hosting services.',
    cardServices: [
      'Custom Software Development',
      'ERP Solutions',
      'Website Development',
      'Mobile Applications',
      'Analytics Dashboard',
      'Cloud Applications',
      'SAP License & Server Solutions',
    ],
    hero: {
      eyebrow: 'Business Vertical',
      heading: 'Software that streamlines how organisations run',
      intro:
        'JMK Software Solutions accelerates digital transformation through intelligent software solutions that streamline administrative processes, improve operational efficiency, enhance data-driven decision-making, and support secure digital infrastructure.',
    },
    groups: [
      {
        id: 'build',
        title: 'Build',
        intro: 'Applications designed, developed and delivered around your operating processes.',
        icon: 'code',
        services: [
          {
            name: 'Custom Software Development',
            description: 'Applications built to fit an organisation’s own workflows rather than the reverse.',
          },
          {
            name: 'ERP Solutions',
            description: 'Process-driven ERP platforms, including the following in-house products.',
            items: ['Advocate Case Management Software', 'Student Management Software'],
          },
          {
            name: 'Website Development',
            description: 'Corporate and business websites built for performance, SEO and maintainability.',
          },
          {
            name: 'Mobile Applications',
            description: 'Mobile applications that extend your systems to field teams and customers.',
          },
        ],
      },
      {
        id: 'operate',
        title: 'Operate & Analyse',
        intro: 'Keeping systems running, measurable and available.',
        icon: 'chart',
        services: [
          {
            name: 'Analytics Dashboard',
            description: 'Operational dashboards that turn transactional data into decisions.',
          },
          {
            name: 'Cloud Applications',
            description: 'Cloud-hosted applications with centralised access and managed deployment.',
          },
          {
            name: 'SAP License & Server Solutions',
            description: 'SAP licensing and server provisioning support for organisations running SAP.',
          },
        ],
      },
      {
        id: 'infrastructure',
        title: 'Digital Infrastructure & Marketing Support',
        intro:
          'The supporting services that keep a business online — supplied alongside development work.',
        icon: 'globe',
        services: [
          {
            name: 'Digital Marketing Support',
            description:
              'Build your brand, reach the right audience, generate quality leads, and turn digital visibility into measurable business growth.',
          },
          {
            name: 'Email Box Server',
            description: 'Business mailbox provisioning on your own domain.',
          },
          {
            name: 'Domain Services',
            description: 'Domain registration and management handled for you.',
          },
          {
            name: 'Hosting Services',
            description: 'Website and application hosting with ongoing support.',
          },
        ],
      },
    ],
    seo: {
      title: 'JMK Software Solutions — ERP, Web & Mobile',
      description:
        'Custom software, ERP, websites, mobile apps, analytics and cloud applications, with SAP licensing, email, domain and hosting from JMK Software Solutions.',
    },
  },
];

export const verticalsBySlug = new Map(verticals.map((vertical) => [vertical.slug, vertical]));

export type GroupSector = {
  id: string;
  name: string;
  description: string;
  icon: IconName;
};

/**
 * Sectors the group operates in that were named in the document without a service
 * catalogue. Descriptions use the document's own national-contribution wording; Real
 * Estate was named as a sector only, so nothing beyond that is claimed.
 */
export const groupSectors: GroupSector[] = [
  {
    id: 'exports',
    name: 'Exports',
    description:
      'Our export division strengthens India’s economy by increasing international trade, generating foreign exchange earnings, boosting GDP, and creating employment opportunities throughout the agricultural supply chain.',
    icon: 'export',
  },
  {
    id: 'agriculture',
    name: 'Agriculture & Integrated Farming',
    description:
      'Our farming initiatives promote food security, sustainable agriculture, rural employment, efficient resource utilization, and environmentally responsible farming practices aligned with national development goals.',
    icon: 'agriculture',
  },
  {
    id: 'renewable-energy',
    name: 'Renewable Energy',
    description:
      'Solar, wind, and biogas initiatives contribute to India’s renewable energy transition by supporting decentralized clean power generation, reducing carbon emissions, strengthening energy security, and promoting green employment.',
    icon: 'energy',
  },
  {
    id: 'real-estate',
    name: 'Real Estate',
    description:
      'Real estate is one of the seven sectors within the group’s diversified operating portfolio.',
    icon: 'building',
  },
];
