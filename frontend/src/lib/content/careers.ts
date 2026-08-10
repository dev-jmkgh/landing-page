import type { IconName } from '@/components/ui/Icon';

/**
 * Careers copy. The 13 open roles and 5 benefits are exactly those listed in the content
 * document. The document supplied no salary bands, locations per role, experience levels
 * or department structure — none are invented here. Roles are grouped by discipline
 * purely for readability.
 */

export const careersIntro = {
  heading: 'Join Our Team',
  intro:
    'We are always looking for passionate professionals who want to build a meaningful career.',
};

export type RoleGroup = {
  id: string;
  title: string;
  icon: IconName;
  roles: string[];
};

export const roleGroups: RoleGroup[] = [
  {
    id: 'training',
    title: 'Training & Education',
    icon: 'academy',
    roles: ['CAD Trainers', 'SAP Trainers'],
  },
  {
    id: 'technology',
    title: 'Technology & Design',
    icon: 'code',
    roles: ['Software Developers', 'UI/UX Designers'],
  },
  {
    id: 'engineering',
    title: 'Engineering',
    icon: 'compass',
    roles: ['Civil Engineers', 'Mechanical Engineers', 'Electrical Engineers'],
  },
  {
    id: 'business',
    title: 'Business & Growth',
    icon: 'chart',
    roles: [
      'Business Development Executives',
      'Sales Executives',
      'Telecallers',
      'Digital Marketing Executives',
      'Export Executives',
    ],
  },
  {
    id: 'corporate',
    title: 'Corporate',
    icon: 'users',
    roles: ['HR Professionals'],
  },
];

/** Flat list in document order — used to populate the application form's position select. */
export const openPositions: string[] = [
  'CAD Trainers',
  'SAP Trainers',
  'Business Development Executives',
  'Telecallers',
  'Software Developers',
  'UI/UX Designers',
  'Digital Marketing Executives',
  'Export Executives',
  'Civil Engineers',
  'Mechanical Engineers',
  'Electrical Engineers',
  'Sales Executives',
  'HR Professionals',
];

export type Benefit = {
  name: string;
  icon: IconName;
};

export const benefits: Benefit[] = [
  { name: 'Career Growth', icon: 'chart' },
  { name: 'Learning Opportunities', icon: 'book' },
  { name: 'Performance Incentives', icon: 'award' },
  { name: 'Friendly Work Environment', icon: 'users' },
  { name: 'Industry Exposure', icon: 'globe' },
];
