'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { EnquiryTrigger } from '@/components/enquiry/EnquiryTrigger';
import { Icon } from '@/components/ui/Icon';
import { assetPath } from '@/lib/paths';
import { contactDetails, mainNavigation, siteConfig } from '@/lib/site';

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
                  onMouseEnter={() => setOpenMenu(item.href)}
                  onMouseLeave={() => setOpenMenu((current) => (current === item.href ? null : current))}
                >
                  <Link
                    href={item.href}
                    className={`nav-link${active ? ' is-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    aria-expanded={isOpen}
                    aria-controls={menuId}
                    onFocus={() => setOpenMenu(item.href)}
                    onClick={() => setOpenMenu(null)}
                  >
                    {item.label}
                    <Icon className="nav-link__chevron" name="chevronDown" size={15} />
                  </Link>

                  <div className="mega-menu" id={menuId} role="group" aria-label={item.label}>
                    {item.children.map((child) => (
                      <Link className="mega-menu__link" href={child.href} key={child.href}>
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
            <a className="header-actions__call" href={contactDetails.phones[0].href}>
              <Icon name="phone" size={16} />
              {contactDetails.phones[0].label}
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
              <a className="btn btn--outline btn--block" href={contactDetails.phones[0].href}>
                <Icon name="phone" size={16} />
                {contactDetails.phones[0].label}
              </a>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
