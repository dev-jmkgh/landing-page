import type { IconName } from '@/components/ui/Icon';

/**
 * Business verticals and group sectors.
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
  /**
   * Photograph for the tile, where an honest one exists.
   *
   * Only set this where the frame genuinely shows the discipline. Several services here
   * have no picture worth taking — a domain service, an email box, a licence — and the
   * nearest stock image says nothing specific. Those are left without one and the tile
   * draws a generated plate instead; see `components/visuals/TileGraphic.tsx`. Never
   * fill this with a laptop-on-a-desk to even the grid up.
   */
  image?: { src: string; alt: string; width: number; height: number };
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
  /**
   * Card photograph. Licensed stock that shows the *discipline* the vertical works
   * in — never presented as a photograph of JMK's own premises, staff or projects.
   * The same rule as the gallery; see `lib/content/gallery.ts`.
   */
  image: { src: string; alt: string; width: number; height: number };
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
    image: {
      src: '/images/gallery/academy-cad-3d-workstation.jpg',
      alt: 'Engineer working on a 3D plant model in CAD software at a dual-monitor workstation',
      width: 1600,
      height: 1067,
    },
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
    image: {
      src: '/images/gallery/design-technical-drawing-parts.jpg',
      alt: 'Precision-machined flange components resting on dimensioned engineering drawings',
      width: 1400,
      height: 788,
    },
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
            image: {
              src: '/images/gallery/design-cad-drafting-screen.jpg',
              alt: 'A monitor showing a detailed 2D CAD plan drawing with coloured linework and dimensions',
              width: 1400,
              height: 934,
            },
            description:
              'Dimensioned production drawings, layouts and detail sheets prepared to your drawing standards.',
          },
          {
            name: '3D Modeling',
            image: {
              src: '/images/gallery/design-3d-model-workstation.jpg',
              alt: 'Three-dimensional structural assembly model open on a CAD workstation display',
              width: 1800,
              height: 1201,
            },
            description:
              'Parametric part and assembly models built for downstream design, review and manufacturing use.',
          },
          {
            name: 'Product Design',
            image: {
              src: '/images/gallery/design-product-design-bench.jpg',
              alt: 'Technical drawings of a product with drafting instruments and a metal prototype on a desk',
              width: 1400,
              height: 933,
            },
            description: 'Concept development through to detailed design of manufacturable products.',
          },
          {
            name: 'Architectural Visualization',
            image: {
              src: '/images/gallery/svc-architectural-model.jpg',
              alt: 'A scale architectural model displayed in front of mounted building drawings',
              width: 1400,
              height: 890,
            },
            description:
              'Visual representation of architectural and interior spaces for review and presentation.',
          },
          {
            name: 'Industrial Design',
            image: {
              src: '/images/gallery/academy-engineering-workstation.jpg',
              alt: 'A dual-monitor engineering workstation showing a circuit schematic and a 3D board layout',
              width: 1400,
              height: 788,
            },
            description: 'Form, ergonomics and aesthetics developed alongside engineering requirements.',
          },
          {
            name: 'Rendering Services',
            image: {
              src: '/images/gallery/svc-render-house.jpg',
              alt: 'A photorealistic render of a house exterior with its driveway and garden',
              width: 1400,
              height: 788,
            },
            description: 'High-quality renders produced from CAD geometry for presentation and approvals.',
          },
          {
            name: 'Reverse Engineering',
            image: {
              src: '/images/gallery/design-technical-drawing-parts.jpg',
              alt: 'Machined aluminium flange components resting on dimensioned engineering drawings',
              width: 1400,
              height: 788,
            },
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
    image: {
      src: '/images/gallery/software-development-team.jpg',
      alt: 'Two developers writing application code at workstations in a modern software office',
      width: 1600,
      height: 2397,
    },
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
            image: {
              src: '/images/gallery/software-source-code.jpg',
              alt: 'Source code with syntax highlighting displayed on a monitor at a developer workstation',
              width: 1400,
              height: 911,
            },
            description: 'Applications built to fit an organisation’s own workflows rather than the reverse.',
          },
          {
            name: 'ERP Solutions',
            image: {
              src: '/images/gallery/svc-erp-team.jpg',
              alt: 'Colleagues reviewing a business system together on laptops in an office',
              width: 1400,
              height: 934,
            },
            description: 'Process-driven ERP platforms, including the following in-house products.',
            items: ['Advocate Case Management Software', 'Student Management Software'],
          },
          {
            name: 'Website Development',
            image: {
              src: '/images/gallery/svc-web-wireframes.jpg',
              alt: 'Hand-drawn website layout wireframes sketched and coloured on paper',
              width: 1400,
              height: 934,
            },
            description: 'Corporate and business websites built for performance, SEO and maintainability.',
          },
          {
            name: 'Mobile Applications',
            image: {
              src: '/images/gallery/svc-mobile-app.jpg',
              alt: 'A person using an application on a smartphone held in both hands',
              width: 1400,
              height: 934,
            },
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
            image: {
              src: '/images/gallery/software-analytics-dashboard.jpg',
              alt: 'An analytics dashboard on screen showing charts and key performance figures',
              width: 1400,
              height: 1008,
            },
            description: 'Operational dashboards that turn transactional data into decisions.',
          },
          {
            name: 'Cloud Applications',
            image: {
              src: '/images/gallery/software-server-infrastructure.jpg',
              alt: 'Rows of networking and server equipment in a data centre aisle',
              width: 1400,
              height: 2100,
            },
            description: 'Cloud-hosted applications with centralised access and managed deployment.',
          },
          {
            name: 'SAP License & Server Solutions',
            image: {
              src: '/images/gallery/svc-server-aisle.jpg',
              alt: 'An equipment aisle of racked servers in a data hall',
              width: 1400,
              height: 805,
            },
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
            image: {
              src: '/images/gallery/svc-marketing-metrics.jpg',
              alt: 'A campaign dashboard on screen showing click-through and conversion figures',
              width: 1400,
              height: 1008,
            },
            description:
              'Build your brand, reach the right audience, generate quality leads, and turn digital visibility into measurable business growth.',
          },
          {
            name: 'Email Box Server',
            image: {
              src: '/images/gallery/svc-email.jpg',
              alt: 'An envelope symbol representing electronic mail',
              width: 1400,
              height: 788,
            },
            description: 'Business mailbox provisioning on your own domain.',
          },
          {
            name: 'Domain Services',
            image: {
              src: '/images/gallery/svc-network-cabling.jpg',
              alt: 'Patch cabling running between network equipment',
              width: 1400,
              height: 786,
            },
            description: 'Domain registration and management handled for you.',
          },
          {
            name: 'Hosting Services',
            image: {
              src: '/images/gallery/software-development-team.jpg',
              alt: 'Developers working together at a shared desk of monitors',
              width: 1600,
              height: 2397,
            },
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
