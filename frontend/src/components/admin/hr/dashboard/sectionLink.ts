import type { MouseEvent } from 'react';

/**
 * Links from the HR dashboard to another HR section.
 *
 * HrApp keeps the visible section in `?section=` and listens for `popstate`. A link here
 * therefore pushes the new address itself and dispatches a `popstate`, which HrApp answers
 * exactly as it answers Back and Forward — so the dashboard needs nothing from HrApp, and
 * the section switch is the same one the sidebar makes.
 *
 * The href is a real one (`?section=leave`), so Ctrl- or middle-click opens the section
 * in a new tab and a screen reader announces a link. The new address carries ONLY the
 * section: the dashboard's own `date` must not ride along into a screen that might read a
 * parameter of that name as its own filter.
 */

export type HrSectionKey =
  | 'dashboard'
  | 'people'
  | 'attendance'
  | 'corrections'
  | 'leave'
  | 'requests'
  | 'documents'
  | 'payroll'
  | 'reports'
  | 'workplaces'
  | 'organisation'
  | 'audit';

export function sectionHref(section: HrSectionKey): string {
  return `?section=${encodeURIComponent(section)}`;
}

export function goToSection(section: HrSectionKey): void {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('section', section);
  // The same entry HrApp's own section switch pushes. Next's patched pushState copies its
  // router state into it, so Back and Forward over this entry behave like any other.
  window.history.pushState({ section }, '', url);
  /*
   * `state: null` is load-bearing. Next's app router also listens for popstate, and it
   * RELOADS THE PAGE for an event whose state lacks its own `__NA` marker (it takes such an
   * entry for one written by the old pages router). A null state it ignores — the patched
   * pushState above has already told it the new URL. HrApp reads only `location.search`.
   */
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  // The next screen starts at its top, as it does from the sidebar on a short page.
  window.scrollTo({ top: 0 });
}

/** `href` + `onClick` for an anchor that switches section in place. */
export function sectionLinkProps(section: HrSectionKey): {
  href: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href: sectionHref(section),
    onClick: (event) => {
      // A modified click is the reader asking for a new tab or window: let the browser have it.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      goToSection(section);
    },
  };
}
