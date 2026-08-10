import type { IconName } from '@/components/ui/Icon';

/** About Us copy — from the "ABOUT US" section of the supplied content document. */

export const whoWeAre = {
  eyebrow: 'Who We Are',
  heading: 'One group, seven sectors, a single standard of quality',
  paragraphs: [
    'JMK Global Holdings is a diversified corporate group headquartered in Coimbatore, Tamil Nadu. Founded in 2023 by co-founders Jose AM and Muthu Krishnan Anantham, our organization brings together expertise across education, engineering, software development, exports, agriculture, renewable energy, and real estate.',
    'We believe that business should not only generate profits but also create opportunities, improve communities, and contribute to national development.',
  ],
};

export const visionStatement =
  'To become one of India’s leading diversified business groups by creating sustainable value through innovation, education, technology, global trade, and responsible business practices.';

export const missionPoints: string[] = [
  'Deliver world-class education and professional training.',
  'Build innovative software and engineering solutions.',
  'Expand India’s global export footprint.',
  'Promote sustainable agriculture and renewable energy.',
  'Foster entrepreneurship and employment opportunities.',
  'Create lasting value for customers, employees, investors, and society.',
];

export type CoreValue = {
  name: string;
  icon: IconName;
};

export const coreValues: CoreValue[] = [
  { name: 'Innovation', icon: 'spark' },
  { name: 'Integrity', icon: 'shield' },
  { name: 'Customer Success', icon: 'target' },
  { name: 'Excellence', icon: 'award' },
  { name: 'Teamwork', icon: 'users' },
  { name: 'Sustainability', icon: 'leaf' },
  { name: 'Continuous Learning', icon: 'book' },
  { name: 'Social Responsibility', icon: 'globe' },
];

/** Leadership named in the document. No biographies were supplied, so none are invented. */
export const founders = [
  { name: 'Jose AM', role: 'Co-Founder' },
  { name: 'Muthu Krishnan Anantham', role: 'Co-Founder' },
];
