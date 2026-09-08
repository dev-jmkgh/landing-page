'use client';

import Link from 'next/link';
import { Icon, type IconName } from '@/components/ui/Icon';

/**
 * The admin sidebar.
 *
 * This exists because the two admin applications were mutually invisible. Enquiries and
 * applications live at `/admin/enquiries/`, the seven telecalling sections at
 * `/admin/telecalling/`, and only the telecalling shell had a link to the other one —
 * so anyone who opened the enquiries screen saw two tabs and had no way to discover that
 * the rest of the system existed.
 *
 * One map, declared once here, is rendered by both. Adding a section means adding a row
 * to `AREAS` rather than remembering to edit two shells.
 */

/**
 * An "area" is one exported route with its own document.
 *
 * The distinction matters for navigation: moving within an area is a state change, and
 * moving between areas is a real page load. The static export gives each route its own
 * HTML file, so there is no way to make the second case cheap — but there is also no
 * reason to make the first case expensive, which is why this is not simply nine links.
 */
export type AdminArea = 'records' | 'telecalling';

type NavItem = {
  key: string;
  label: string;
  icon: IconName;
  /** The query parameter this area uses to address its own sections. */
  param: string;
};

type NavGroup = {
  area: AdminArea;
  title: string;
  path: string;
  param: string;
  items: NavItem[];
};

export const AREAS: NavGroup[] = [
  {
    area: 'records',
    title: 'Website',
    path: '/admin/enquiries/',
    param: 'tab',
    items: [
      { key: 'enquiries', label: 'Enquiries', icon: 'inbox', param: 'tab' },
      { key: 'applications', label: 'Applications', icon: 'briefcase', param: 'tab' },
    ],
  },
  {
    area: 'telecalling',
    title: 'Telecalling',
    path: '/admin/telecalling/',
    param: 'section',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: 'chart', param: 'section' },
      { key: 'leads', label: 'Leads', icon: 'target', param: 'section' },
      { key: 'followups', label: 'Follow-ups', icon: 'clock', param: 'section' },
      { key: 'calls', label: 'Calls', icon: 'phone', param: 'section' },
      { key: 'employees', label: 'Employees', icon: 'users', param: 'section' },
      { key: 'reports', label: 'Reports', icon: 'ledger', param: 'section' },
      { key: 'settings', label: 'Settings', icon: 'shield', param: 'section' },
    ],
  },
];

export function AdminNav({
  area,
  activeKey,
  onNavigate,
  onDismiss,
}: {
  area: AdminArea;
  activeKey: string;
  /** Switches section within the current area, without a page load. */
  onNavigate: (key: string) => void;
  /** Closes the drawer on narrow screens. No-op on desktop, where it is always open. */
  onDismiss?: () => void;
}) {
  return (
    <nav className="admin-nav" aria-label="Admin sections">
      {AREAS.map((group) => (
        <div key={group.area} className="admin-nav__group">
          <p className="admin-nav__title">{group.title}</p>

          <ul className="admin-nav__list">
            {group.items.map((item) => {
              const isCurrentArea = group.area === area;
              const isActive = isCurrentArea && item.key === activeKey;

              /*
               * Same area: a button, so the panel swaps in place and the shell, the
               * session check and the sidebar are not torn down and rebuilt.
               *
               * Different area: a `next/link`, which Next rewrites for `basePath`. The
               * hand-written `<a href="/admin/enquiries/">` this replaces did not get
               * that rewrite, so it would have broken on a sub-path deployment.
               */
              return (
                <li key={item.key}>
                  {isCurrentArea ? (
                    <button
                      type="button"
                      className="admin-nav__link"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => {
                        onNavigate(item.key);
                        onDismiss?.();
                      }}
                    >
                      <Icon name={item.icon} size={17} />
                      <span>{item.label}</span>
                    </button>
                  ) : (
                    <Link
                      className="admin-nav__link"
                      href={`${group.path}?${item.param}=${item.key}`}
                      onClick={onDismiss}
                    >
                      <Icon name={item.icon} size={17} />
                      <span>{item.label}</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
