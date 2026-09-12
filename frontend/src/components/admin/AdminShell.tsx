'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AdminNav, type AdminArea } from '@/components/admin/AdminNav';
import { Icon } from '@/components/ui/Icon';
import { assetPath } from '@/lib/paths';

/**
 * The chrome around every admin screen: sidebar, title bar, signed-in user, sign-out.
 *
 * Both admin applications rendered their own near-identical header. Sharing it means the
 * sidebar cannot be present on one screen and missing from the other, which is exactly
 * the state this was written to fix.
 */
export function AdminShell({
  area,
  activeKey,
  onNavigate,
  title,
  email,
  onSignOut,
  actions,
  children,
}: {
  area: AdminArea;
  activeKey: string;
  onNavigate: (key: string) => void;
  title: string;
  email: string | null;
  onSignOut: () => void;
  /** Screen-specific controls for the title bar, e.g. a refresh button. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  /*
   * Escape closes the drawer.
   *
   * It is an overlay on narrow screens, and an overlay with no keyboard dismissal is a
   * trap for anyone not using a touchscreen.
   */
  useEffect(() => {
    if (!drawerOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="admin-layout">
      {/*
        One sidebar element, not one per breakpoint. `data-open` drives the drawer on
        narrow screens and is ignored by the desktop rules, so the navigation exists once
        in the accessibility tree — two copies would announce every section twice.
      */}
      <aside className="admin-layout__side" data-open={drawerOpen ? 'true' : undefined}>
        <div className="admin-side__brand">
          {/*
            The real lockup, not a text eyebrow.

            Dimensions are declared so the sidebar reserves the space before the image
            loads — without them the navigation below shifts down on first paint.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="admin-side__logo"
            src={assetPath('/images/brand/logo.png')}
            alt="JMK Global Holdings"
            width={508}
            height={160}
            decoding="async"
            fetchPriority="high"
          />
          <p className="admin-side__product">Admin</p>
        </div>

        <AdminNav
          area={area}
          activeKey={activeKey}
          onNavigate={onNavigate}
          onDismiss={() => setDrawerOpen(false)}
        />

        <div className="admin-side__foot">
          {email ? <span className="admin-side__user">{email}</span> : null}
          {/*
            `btn--ghost`, not `btn--ghost-light`. The latter is white text on a
            white-alpha border, built for the navy header — against the light sidebar
            this panel now uses it was invisible.
          */}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onSignOut}>
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Click-away for the drawer. Rendered only while open so it cannot swallow taps. */}
      {drawerOpen ? (
        <button
          type="button"
          className="admin-layout__scrim"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <div className="admin-layout__main">
        <header className="admin-topbar">
          <button
            type="button"
            className="admin-topbar__menu"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="menu" size={20} />
          </button>

          <h1 className="admin-topbar__title">{title}</h1>

          {actions ? <div className="admin-topbar__actions">{actions}</div> : null}
        </header>

        <div className="admin-layout__content">{children}</div>
      </div>
    </div>
  );
}
