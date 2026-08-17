import type { IconName } from '@/components/ui/Icon';

/**
 * Home page copy. Sourced from the "HOME PAGE" and "ABOUT US" sections of the supplied
 * content document — see `docs/content-map.md`.
 */

export const heroContent = {
  headline: 'Building Skills, Businesses & Sustainable Futures',
  subheadline: 'One Group. Multiple Industries. Unlimited Possibilities.',
  intro:
    'JMK Global Holdings is a diversified business group headquartered in Coimbatore, India, operating across education, engineering design, software development, exports, agriculture, renewable energy, and real estate. Since 2023, we have been committed to empowering individuals, industries, and communities through innovation, technology, and sustainable business practices.',
};

export const welcomeContent = {
  eyebrow: 'Welcome to JMK Global Holdings',
  heading: 'A diversified group built on innovation, integrity and excellence',
  paragraphs: [
    'Established in 2023, JMK Global Holdings is a rapidly growing business group with a vision to become one of India’s most trusted diversified organizations.',
    'Our businesses operate across multiple strategic sectors that contribute to economic development, skill enhancement, digital transformation, sustainable agriculture, renewable energy, and international trade.',
    'We believe in creating long-term value for our customers, partners, employees, and society through innovation, integrity, and excellence.',
  ],
  highlights: [
    { label: 'Founded', value: '2023' },
    { label: 'Headquarters', value: 'Coimbatore, Tamil Nadu' },
    { label: 'Operating sectors', value: 'Seven' },
  ],
};

export type Stat = {
  /** Numeric portion used by the animated counter. */
  value: number;
  suffix: string;
  label: string;
};

export const successStats: Stat[] = [
  { value: 1000, suffix: '+', label: 'Students Trained' },
  { value: 250, suffix: '+', label: 'Projects Delivered' },
  { value: 100, suffix: '+', label: 'Business Clients' },
];

export type Contribution = {
  id: string;
  title: string;
  /**
   * One line for the card face. Every one of these is a condensation of `description`
   * below — same claims, fewer words. Nothing is asserted here that the content
   * document does not already say.
   */
  summary: string;
  /** The full statement, shown in the dialog rather than on the card. */
  description: string;
  icon: IconName;
  image: { src: string; alt: string; width: number; height: number };
};

/**
 * "Government Contribution" section — the group's contribution to India's economic
 * development. Descriptions are the document's own wording.
 */
export const contributions: Contribution[] = [
  {
    id: 'export',
    summary:
      'Trade, foreign exchange earnings and employment across the agricultural supply chain.',
    title: 'Export Business',
    description:
      'Our export division strengthens India’s economy by increasing international trade, generating foreign exchange earnings, boosting GDP, and creating employment opportunities throughout the agricultural supply chain.',
    icon: 'export',
    image: {
      src: '/images/gallery/contrib-export-produce.jpg',
      alt: 'Workers unloading crates of harvested produce from a truck',
      width: 1400,
      height: 2100,
    },
  },
  {
    id: 'farming',
    summary:
      'Food security, sustainable agriculture and rural employment.',
    title: 'Integrated Farming',
    description:
      'Our farming initiatives promote food security, sustainable agriculture, rural employment, efficient resource utilization, and environmentally responsible farming practices aligned with national development goals.',
    icon: 'agriculture',
    image: {
      src: '/images/gallery/sustainability-farmland.jpg',
      alt: 'Cultivated farmland in even rows stretching to the horizon',
      width: 1400,
      height: 788,
    },
  },
  {
    id: 'renewable',
    summary:
      'Solar, wind and biogas supporting decentralised clean power.',
    title: 'Renewable Energy',
    description:
      'Solar, wind, and biogas initiatives contribute to India’s renewable energy transition by supporting decentralized clean power generation, reducing carbon emissions, strengthening energy security, and promoting green employment.',
    icon: 'energy',
    image: {
      src: '/images/gallery/sustainability-solar-farm.jpg',
      alt: 'Aerial view of long rows of solar photovoltaic panels across open ground',
      width: 1400,
      height: 788,
    },
  },
  {
    id: 'software',
    summary:
      'Digital transformation that streamlines processes and supports secure infrastructure.',
    title: 'Software Solutions',
    description:
      'We accelerate digital transformation through intelligent software solutions that streamline administrative processes, improve operational efficiency, enhance data-driven decision-making, and support secure digital infrastructure.',
    icon: 'software',
    image: {
      src: '/images/gallery/software-development-team.jpg',
      alt: 'Developers working together at a shared desk of monitors',
      width: 1600,
      height: 2397,
    },
  },
  {
    id: 'training',
    summary:
      'Skilled professionals for infrastructure, manufacturing, construction, defence and industry.',
    title: 'CAD & Engineering Training',
    description:
      'Our engineering training programs prepare skilled professionals for infrastructure, manufacturing, construction, defense, and industrial sectors by providing expertise in CAD, simulation, and engineering technologies.',
    icon: 'academy',
    image: {
      src: '/images/gallery/academy-cad-classroom.jpg',
      alt: 'Instructor presenting at a screen while participants follow on individual workstations',
      width: 1800,
      height: 2696,
    },
  },
  {
    id: 'marketing',
    summary:
      'Brand reach, quality leads and measurable digital visibility.',
    title: 'Digital Marketing',
    description:
      'Build your brand, reach the right audience, generate quality leads, and turn digital visibility into measurable business growth.',
    icon: 'marketing',
    image: {
      src: '/images/gallery/svc-marketing-metrics.jpg',
      alt: 'A campaign dashboard on screen showing click-through and conversion figures',
      width: 1400,
      height: 1008,
    },
  },
];

export const whyChooseUs: string[] = [
  'Multiple Industries Under One Brand',
  'Industry Experienced Professionals',
  'Innovation Driven',
  'Customer-Centric Solutions',
  'Sustainable Business Practices',
  'Skilled Workforce Development',
  'Quality Commitment',
  'Technology-Oriented Services',
  'Global Business Network',
  'End-to-End Business Solutions',
];
