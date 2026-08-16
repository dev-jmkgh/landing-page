'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { EnquiryTrigger } from '@/components/enquiry/EnquiryTrigger';
import { Icon, type IconName } from '@/components/ui/Icon';
import { assetPath } from '@/lib/paths';
import { contactDetails, mainNavigation, siteConfig, socialLinks } from '@/lib/site';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The company logo, linking home.
 *
 * Two files rather than one: the supplied lockup sets "JMK GLOBAL HOLDINGS" in the
 * brand's dark blue and "EST 2023" in black, both of which disappear against the navy
 * footer. `logo-on-dark.png` is the same artwork with the type knocked out to white and
 * the shield left in full colour.
 *
 * Dimensions are declared so the header reserves the space before the image loads —
 * without them the navigation shifts sideways on first paint. A plain `img` is used
 * rather than `next/image` because the export is unoptimised anyway, so the component
 * would add a wrapper and a srcset for a fixed-size asset that needs neither.
 */
function Brand({ variant = 'header' }: { variant?: 'header' | 'footer' }) {
  const onDark = variant === 'footer';

  return (
    <Link
      href="/"
      className={`brand${onDark ? ' brand--footer' : ''}`}
      aria-label={`${siteConfig.name} — home`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="brand__logo"
        src={assetPath(onDark ? '/images/brand/logo-on-dark.png' : '/images/brand/logo.png')}
        alt={siteConfig.name}
        width={508}
        height={160}
        decoding="async"
        // The header logo is above the fold on every page; the footer one never is.
        {...(onDark ? { loading: 'lazy' as const } : { fetchPriority: 'high' as const })}
      />
    </Link>
  );
}

export { Brand };

/**
 * Facebook / Instagram / LinkedIn.
 *
 * URLs come from `socialLinks` in `lib/site.ts`, which drops any entry whose URL is
 * blank — so a channel the company has not given us simply does not render, rather
 * than shipping a dead icon. Adding one later is an edit to that file alone.
 */
function SocialRow({ variant }: { variant: 'header' | 'drawer' }) {
  if (socialLinks.length === 0) return null;

  return (
    <ul className={`social-row social-row--${variant}`}>
      {socialLinks.map((link) => (
        <li key={link.id}>
          <a
            className="social-row__link"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${siteConfig.name} on ${link.label}`}
          >
            <Icon name={link.id as IconName} size={16} />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function SiteHeader() {
  const pathname = usePathname() ?? '/';
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Close everything on navigation.
  useEffect(() => {
    setOpenMenu(null);
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // While the drawer is open it is a modal dialog: background scrolling is locked and
  // Tab stays inside it, so keyboard users cannot land on the page behind the overlay.
  useEffect(() => {
    if (!drawerOpen) return;

    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';

    const node = drawerRef.current;
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !node) return;

      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [drawerOpen]);

  // A menu left open across a navigation is the "randomly stays open" bug; closing on
  // pathname change is the only reliable cure, since the click that navigated may have
  // happened inside the menu itself.
  useEffect(() => {
    setOpenMenu(null);
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpenMenu(null);
      setDrawerOpen(false);
    }
    function onPointerDown(event: MouseEvent) {
      if (navRef.current && !navRef.current.contains(event.target as Node)) setOpenMenu(null);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, []);

  return (
    <>
      <header className={`site-header${scrolled ? ' is-scrolled' : ''}`}>
        <div className="container site-header__inner">
          <Brand />

          <nav className="nav-desktop" aria-label="Primary" ref={navRef}>
            {mainNavigation.map((item) => {
              const active = isActive(pathname, item.href);

              if (!item.children) {
                return (
                  <div className="nav-desktop__item" key={item.href}>
                    <Link
                      href={item.href}
                      className={`nav-link${active ? ' is-active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                    >
                      {item.label}
                    </Link>
                  </div>
                );
              }

              const menuId = `menu-${item.href.replace(/\W/g, '')}`;
              const isOpen = openMenu === item.href;

              return (
                <div
                  className={`nav-desktop__item${isOpen ? ' is-open' : ''}`}
                  key={item.href}
                >
                  {/*
                    A button, not a link on hover. Hover-only menus open when the
                    pointer merely crosses them and are unreachable by keyboard or
                    touch; this opens on click, closes on a second click, on Escape,
                    on an outside click and on navigation. The overview page is still
                    reachable — it is the first entry inside the menu.
                  */}
                  <button
                    type="button"
                    className={`nav-link nav-link--trigger${active ? ' is-active' : ''}`}
                    aria-expanded={isOpen}
                    aria-controls={menuId}
                    aria-haspopup="true"
                    onClick={() =>
                      setOpenMenu((current) => (current === item.href ? null : item.href))
                    }
                  >
                    {item.label}
                    <Icon className="nav-link__chevron" name="chevronDown" size={15} />
                  </button>

                  <div
                    className="mega-menu"
                    id={menuId}
                    role="menu"
                    aria-label={item.label}
                    hidden={!isOpen}
                  >
                    <Link
                      className="mega-menu__link mega-menu__link--overview"
                      href={item.href}
                      role="menuitem"
                      onClick={() => setOpenMenu(null)}
                    >
                      <span className="mega-menu__icon" aria-hidden="true">
                        <Icon name="briefcase" size={16} />
                      </span>
                      <span className="label-stack">
                        <span className="label-stack__title">All of {item.label}</span>
                        <span className="label-stack__description">
                          The full group overview and how the verticals fit together
                        </span>
                      </span>
                    </Link>

                    {item.children.map((child) => (
                      <Link
                        className="mega-menu__link"
                        href={child.href}
                        key={child.href}
                        role="menuitem"
                        onClick={() => setOpenMenu(null)}
                      >
                        <span className="mega-menu__icon" aria-hidden="true">
                          <Icon name="arrowRight" size={16} />
                        </span>
                        <span className="label-stack">
                          <span className="label-stack__title">{child.label}</span>
                          <span className="label-stack__description">{child.description}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>

          <div className="header-actions">
            <SocialRow variant="header" />
            <a className="header-actions__call" href={contactDetails.primaryPhone.href}>
              <Icon name="phone" size={16} />
              {contactDetails.primaryPhone.label}
            </a>
            <EnquiryTrigger className="btn btn--accent btn--sm">Enquire Now</EnquiryTrigger>
            <button
              type="button"
              className="menu-toggle"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-drawer"
            >
              <Icon name="menu" size={22} />
            </button>
          </div>
        </div>
      </header>

      {drawerOpen ? (
        <>
          <div
            className="drawer-backdrop"
            onClick={() => setDrawerOpen(false)}
            role="presentation"
          />
          <div
            className="drawer"
            id="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
            ref={drawerRef}
          >
            <div className="drawer__head">
              <Brand />
              <button
                type="button"
                className="menu-toggle"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                <Icon name="close" size={20} />
              </button>
            </div>

            <nav className="drawer__body" aria-label="Mobile">
              {mainNavigation.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <div key={item.href}>
                    <Link
                      href={item.href}
                      className="drawer__link"
                      aria-current={active ? 'page' : undefined}
                    >
                      {item.label}
                    </Link>
                    {item.children ? (
                      <div className="drawer__sublist">
                        {item.children.map((child) => (
                          <Link
                            key={child.href}
                            href={child.href}
                            className="drawer__sublink"
                            aria-current={pathname === child.href ? 'page' : undefined}
                          >
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </nav>

            <div className="drawer__foot">
              <EnquiryTrigger className="btn btn--accent btn--block">Enquire Now</EnquiryTrigger>
              <a className="btn btn--outline btn--block" href={contactDetails.primaryPhone.href}>
                <Icon name="phone" size={16} />
                {contactDetails.primaryPhone.label}
              </a>
              <SocialRow variant="drawer" />
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
