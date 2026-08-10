import type { ReactNode, SVGProps } from 'react';

/**
 * Inline icon set — no icon library is shipped to the browser.
 * Outline icons are drawn with `currentColor` strokes; brand glyphs are filled.
 */

const outline: Record<string, ReactNode> = {
  academy: (
    <>
      <path d="M12 3.5 2.5 8.2 12 13l9.5-4.8L12 3.5Z" />
      <path d="M6.5 10.8V16c0 1.6 2.6 3 5.5 3s5.5-1.4 5.5-3v-5.2" />
      <path d="M21.5 8.2v5.6" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.6 8.4 10 10l-1.6 5.6L14 14l1.6-5.6Z" />
    </>
  ),
  software: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M9 21h6M12 17v4" />
      <path d="M8.5 9.5 6.5 11l2 1.5M13.5 9.5l2 1.5-2 1.5" />
    </>
  ),
  code: (
    <>
      <path d="m9 7-5 5 5 5" />
      <path d="m15 7 5 5-5 5" />
    </>
  ),
  chart: (
    <>
      <path d="M3 20h18" />
      <path d="M7 20v-5.5M12 20V7.5M17 20v-9" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="6.5" rx="1.5" />
      <rect x="3" y="13.5" width="18" height="6.5" rx="1.5" />
      <path d="M6.8 7.2h.01M6.8 16.8h.01" />
    </>
  ),
  ledger: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5v-15Z" />
      <path d="M9 3v18" />
      <path d="M12.5 8.5h3.5M12.5 12h3.5" />
    </>
  ),
  export: (
    <>
      <rect x="2.5" y="6.5" width="19" height="12" rx="1" />
      <path d="M8 6.5v12M12 6.5v12M16 6.5v12" />
    </>
  ),
  agriculture: (
    <>
      <path d="M12 21v-8.5" />
      <path d="M12 12.5c0-3.4 2.2-5.5 6.5-5.5 0 4.3-2.4 6.4-6.5 5.5Z" />
      <path d="M12 15c0-2.4-1.8-4.2-5.5-4.2 0 3.3 2.2 5 5.5 4.2Z" />
    </>
  ),
  energy: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </>
  ),
  building: (
    <>
      <path d="M4.5 21V5.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5V21" />
      <path d="M15.5 10h3a1.5 1.5 0 0 1 1.5 1.5V21" />
      <path d="M3 21h18" />
      <path d="M8 8h1.5M11.5 8H13M8 12h1.5M11.5 12H13M8 16h1.5M11.5 16H13" />
    </>
  ),
  marketing: (
    <>
      <path d="m3.5 10.5 13-5.5v14l-13-5.5z" />
      <path d="M7.5 12.7V19h3v-5.2" />
      <path d="M19.5 9.5a3 3 0 0 1 0 5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 9.5h17M3.5 14.5h17" />
      <path d="M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3Z" />
    </>
  ),
  leaf: (
    <>
      <path d="M20.5 3.5c0 9.4-5.4 14.5-13 14.5H4.8C4.8 9.6 11 4.9 20.5 3.5Z" />
      <path d="M3.5 20.5c3.5-5.5 7.5-8 12-9.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16.5 5.2a3.5 3.5 0 0 1 0 6.6" />
      <path d="M18 14.6A6.5 6.5 0 0 1 21.5 20" />
    </>
  ),
  award: (
    <>
      <circle cx="12" cy="9" r="5.5" />
      <path d="m8.4 13.6-1.4 7.4 5-2.6 5 2.6-1.4-7.4" />
    </>
  ),
  book: (
    <>
      <path d="M4.5 4.5A2 2 0 0 1 6.5 2.5H20v15H6.5a2 2 0 0 0-2 2v-15Z" />
      <path d="M4.5 19.5a2 2 0 0 1 2-2H20v4H6.5a2 2 0 0 1-2-2Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2.5 4.5 5.6v5.1c0 4.8 3.1 8.7 7.5 10.8 4.4-2.1 7.5-6 7.5-10.8V5.6L12 2.5Z" />
      <path d="m9 11.8 2.2 2.2L15 10" />
    </>
  ),
  spark: (
    <>
      <path d="M12 2.5 14 9.2l6.7 2-6.7 2-2 6.7-2-6.7-6.7-2 6.7-2 2-6.7Z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  arrowRight: (
    <>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M20 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 19.5V5" />
      <path d="m5.5 11.5 6.5-6.5 6.5 6.5" />
    </>
  ),
  external: (
    <>
      <path d="M14 3.5h6.5V10" />
      <path d="M20.5 3.5 11 13" />
      <path d="M18 13.5v5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  phone: (
    <>
      <path d="M4.6 3h3.2l1.6 4-2.1 1.4a13.5 13.5 0 0 0 6.3 6.3L15 12.6l4 1.6v3.2a1.6 1.6 0 0 1-1.8 1.6C9.7 18.2 3.9 12.4 3 6.6A1.6 1.6 0 0 1 4.6 3Z" />
    </>
  ),
  mail: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="m3.5 7 8.5 5.8L20.5 7" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21.5s7-6.4 7-11.4a7 7 0 1 0-14 0c0 5 7 11.4 7 11.4Z" />
      <circle cx="12" cy="10" r="2.6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.4l3.4 2" />
    </>
  ),
  menu: <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13.5h5l1.5 3h5l1.5-3h5" />
      <path d="M3.5 13.5 6 5.5h12l2.5 8v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4.5Z" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.2" />
      <path d="M12 16.4h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6h.01" />
    </>
  ),
  successCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.8 2.8L16.2 9.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 20h16" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4 20h16" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="6.5" width="18" height="13.5" rx="2" />
      <path d="M9 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" />
      <path d="M3 12h18" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 3H14l4.5 4.5V21H6.5z" />
      <path d="M14 3v4.5h4.5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M10 8.5 6.5 12 10 15.5" />
      <path d="M6.5 12H16" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-13.9-4.4L3.5 9" />
      <path d="M4 13a8 8 0 0 0 13.9 4.4L20.5 15" />
      <path d="M3.5 4.5V9H8M20.5 19.5V15H16" />
    </>
  ),
};

const brand: Record<string, ReactNode> = {
  facebook: (
    <path d="M13.5 21.5V13h2.86l.43-3.32H13.5V7.56c0-.96.27-1.62 1.65-1.62h1.76V2.97c-.3-.04-1.35-.13-2.56-.13-2.53 0-4.27 1.55-4.27 4.39v2.45H7.2V13h2.88v8.5h3.42Z" />
  ),
  instagram: (
    <path d="M12 2.2c-2.66 0-3 .01-4.04.06-1.04.05-1.75.21-2.37.46a4.78 4.78 0 0 0-1.73 1.13A4.78 4.78 0 0 0 2.73 5.6c-.25.62-.41 1.33-.46 2.37C2.22 9 2.2 9.34 2.2 12s.02 3 .07 4.04c.05 1.03.21 1.74.46 2.36a4.78 4.78 0 0 0 1.13 1.74c.5.5 1.02.82 1.73 1.13.62.24 1.33.4 2.37.45 1.04.05 1.38.07 4.04.07s3-.02 4.04-.07c1.04-.05 1.75-.21 2.37-.45a4.78 4.78 0 0 0 1.73-1.13 4.78 4.78 0 0 0 1.13-1.74c.25-.62.41-1.33.46-2.36.05-1.04.07-1.38.07-4.04s-.02-3-.07-4.04c-.05-1.03-.21-1.74-.46-2.36a4.78 4.78 0 0 0-1.13-1.74 4.78 4.78 0 0 0-1.73-1.13c-.62-.25-1.33-.41-2.37-.46C15 2.21 14.66 2.2 12 2.2Zm0 1.77c2.6 0 2.92.01 3.95.06.95.04 1.47.2 1.81.34.46.17.78.38 1.12.72.34.34.55.66.72 1.12.13.34.3.86.34 1.81.05 1.03.06 1.34.06 3.95s-.01 2.92-.07 3.95c-.05.95-.21 1.47-.35 1.81-.17.46-.38.78-.72 1.12-.34.34-.66.55-1.12.72-.34.13-.87.3-1.82.34-1.03.05-1.34.06-3.94.06s-2.91-.01-3.94-.07c-.95-.04-1.48-.2-1.82-.34a3.02 3.02 0 0 1-1.12-.72 3.02 3.02 0 0 1-.72-1.12c-.14-.34-.3-.86-.35-1.81-.04-1.02-.06-1.35-.06-3.94s.02-2.92.06-3.95c.05-.95.21-1.47.35-1.81.17-.46.38-.78.72-1.12.34-.34.66-.55 1.12-.72.34-.14.86-.3 1.81-.35 1.03-.04 1.35-.06 3.95-.06Zm0 3.01a5.02 5.02 0 1 0 0 10.04 5.02 5.02 0 0 0 0-10.04Zm0 8.28a3.26 3.26 0 1 1 0-6.52 3.26 3.26 0 0 1 0 6.52Zm6.4-8.48a1.17 1.17 0 1 1-2.35 0 1.17 1.17 0 0 1 2.34 0Z" />
  ),
  linkedin: (
    <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3.2 9.5h3.6V21H3.2V9.5Zm6.1 0h3.44v1.57h.05c.48-.9 1.65-1.86 3.4-1.86 3.64 0 4.31 2.4 4.31 5.51V21h-3.6v-5.55c0-1.32-.02-3.02-1.84-3.02-1.85 0-2.13 1.44-2.13 2.93V21H9.3V9.5Z" />
  ),
  youtube: (
    <path d="M21.6 7.2a2.52 2.52 0 0 0-1.77-1.79C18.25 5 12 5 12 5s-6.25 0-7.83.41A2.52 2.52 0 0 0 2.4 7.2 26.3 26.3 0 0 0 2 12a26.3 26.3 0 0 0 .4 4.8 2.52 2.52 0 0 0 1.77 1.79C5.75 19 12 19 12 19s6.25 0 7.83-.41a2.52 2.52 0 0 0 1.77-1.79A26.3 26.3 0 0 0 22 12a26.3 26.3 0 0 0-.4-4.8ZM10 15.1V8.9l5.2 3.1-5.2 3.1Z" />
  ),
};

export type IconName = keyof typeof outline | keyof typeof brand;

type IconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  /** Provide when the icon carries meaning that is not repeated in nearby text. */
  title?: string;
};

export function Icon({ name, size = 20, strokeWidth = 1.6, title, ...rest }: IconProps) {
  const isBrand = name in brand;
  const children = isBrand ? brand[name] : outline[name];

  if (!children) return null;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={isBrand ? 'currentColor' : 'none'}
      stroke={isBrand ? 'none' : 'currentColor'}
      strokeWidth={isBrand ? undefined : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}
