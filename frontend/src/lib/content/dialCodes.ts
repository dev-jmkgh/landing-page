/**
 * Dial codes offered on the phone fields.
 *
 * Not an exhaustive ITU list — a long select is harder to use than a short one, and a
 * visitor whose code is missing can still type it, because the local-number input
 * accepts a leading `+` and the field submits whatever is typed. This is the set the
 * group actually deals with: India first as the default, then the export, training and
 * software markets the content document names, then the rest alphabetically.
 *
 * `code` is the ISO alpha-2 and exists only to keep React keys unique — `+1` is shared
 * by the US and Canada, and `+7` by Russia and Kazakhstan, so the dial number alone is
 * not a stable key.
 */

export type DialCode = {
  code: string;
  country: string;
  dial: string;
};

/** Seeded on both forms. The group is headquartered in Coimbatore. */
export const DEFAULT_DIAL_CODE = '+91';

export const dialCodes: DialCode[] = [
  { code: 'IN', country: 'India', dial: '+91' },
  { code: 'AE', country: 'United Arab Emirates', dial: '+971' },
  { code: 'SA', country: 'Saudi Arabia', dial: '+966' },
  { code: 'QA', country: 'Qatar', dial: '+974' },
  { code: 'OM', country: 'Oman', dial: '+968' },
  { code: 'KW', country: 'Kuwait', dial: '+965' },
  { code: 'BH', country: 'Bahrain', dial: '+973' },
  { code: 'SG', country: 'Singapore', dial: '+65' },
  { code: 'MY', country: 'Malaysia', dial: '+60' },
  { code: 'LK', country: 'Sri Lanka', dial: '+94' },
  { code: 'GB', country: 'United Kingdom', dial: '+44' },
  { code: 'US', country: 'United States', dial: '+1' },
  { code: 'CA', country: 'Canada', dial: '+1' },
  { code: 'AU', country: 'Australia', dial: '+61' },
  { code: 'NZ', country: 'New Zealand', dial: '+64' },
  { code: 'DE', country: 'Germany', dial: '+49' },
  { code: 'FR', country: 'France', dial: '+33' },
  { code: 'NL', country: 'Netherlands', dial: '+31' },
  { code: 'IT', country: 'Italy', dial: '+39' },
  { code: 'ES', country: 'Spain', dial: '+34' },
  { code: 'CH', country: 'Switzerland', dial: '+41' },
  { code: 'SE', country: 'Sweden', dial: '+46' },
  { code: 'ZA', country: 'South Africa', dial: '+27' },
  { code: 'KE', country: 'Kenya', dial: '+254' },
  { code: 'NG', country: 'Nigeria', dial: '+234' },
  { code: 'EG', country: 'Egypt', dial: '+20' },
  { code: 'JP', country: 'Japan', dial: '+81' },
  { code: 'CN', country: 'China', dial: '+86' },
  { code: 'HK', country: 'Hong Kong', dial: '+852' },
  { code: 'BD', country: 'Bangladesh', dial: '+880' },
  { code: 'NP', country: 'Nepal', dial: '+977' },
];
