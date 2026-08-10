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
  description: string;
  icon: IconName;
};

/**
 * "Government Contribution" section — the group's contribution to India's economic
 * development. Descriptions are the document's own wording.
 */
export const contributions: Contribution[] = [
  {
    id: 'export',
    title: 'Export Business',
    description:
      'Our export division strengthens India’s economy by increasing international trade, generating foreign exchange earnings, boosting GDP, and creating employment opportunities throughout the agricultural supply chain.',
    icon: 'export',
  },
  {
    id: 'farming',
    title: 'Integrated Farming',
    description:
      'Our farming initiatives promote food security, sustainable agriculture, rural employment, efficient resource utilization, and environmentally responsible farming practices aligned with national development goals.',
    icon: 'agriculture',
  },
  {
    id: 'renewable',
    title: 'Renewable Energy',
    description:
      'Solar, wind, and biogas initiatives contribute to India’s renewable energy transition by supporting decentralized clean power generation, reducing carbon emissions, strengthening energy security, and promoting green employment.',
    icon: 'energy',
  },
  {
    id: 'software',
    title: 'Software Solutions',
    description:
      'We accelerate digital transformation through intelligent software solutions that streamline administrative processes, improve operational efficiency, enhance data-driven decision-making, and support secure digital infrastructure.',
    icon: 'software',
  },
  {
    id: 'training',
    title: 'CAD & Engineering Training',
    description:
      'Our engineering training programs prepare skilled professionals for infrastructure, manufacturing, construction, defense, and industrial sectors by providing expertise in CAD, simulation, and engineering technologies.',
    icon: 'academy',
  },
  {
    id: 'marketing',
    title: 'Digital Marketing',
    description:
      'Build your brand, reach the right audience, generate quality leads, and turn digital visibility into measurable business growth.',
    icon: 'marketing',
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
