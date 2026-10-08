'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  discardPendingListSearch,
  isPlainLeftClick,
  lastKnownSearch,
  leadHref as buildLeadHref,
  readLeadId,
  readSection,
  rememberSearch,
  replaceParams as replaceSectionParams,
  sectionHref,
  sectionLabel as labelFor,
  sectionSearch,
  subscribeToUrl,
  takePendingListSearch,
  urlSignature,
  withLead,
  withoutLead,
  writeSearch,
  type Section,
  type UrlParams,
} from './urlState';

/**
 * Navigation inside the telecalling admin.
 *
 * Two kinds of move, with different history behaviour:
 *
 * - **A section** (`go`): a new history entry, and the section's panel starts fresh with
 *   only the filters it was sent. Nothing from the previous section's address carries
 *   over, which is what keeps one screen's filters from leaking into the next.
 *
 * - **A lead** (`openLead`): a new history entry showing the Lead View over the section
 *   it was clicked in. The section's panel stays mounted underneath, hidden, so closing
 *   the lead returns to the list exactly as it was — filters, page, ticked rows, scroll
 *   position — without refetching anything.
 *
 * Filter changes inside a panel are not moves: they are recorded in place with
 * `replaceParams` (urlState.ts), so Back does not step through every keystroke.
 *
 * A panel is remounted — keyed on `navKey` — exactly when the section or its filters
 * differ from what it is showing: on `go`, and on a Back or Forward to a different list
 * state. Opening or closing a lead never remounts it.
 *
 * Panels reach all of this through `useTelecallingNav()`, so they keep the single
 * `onUnauthorized` prop the shell has always given them.
 */

/** Marks a history entry that openLead pushed — the only kind closeLead may go Back from. */
const LEAD_PUSHED = 'tcLeadPushed';

/**
 * How long a Back started by closeLead blocks further moves.
 *
 * A double click on "Back to leads" would otherwise step back twice and could leave the
 * admin entirely. The popstate that ends the Back clears this much sooner; the timeout is
 * only there so a lost event can never leave navigation stuck.
 */
const CLOSING_TIMEOUT_MS = 1500;

export type LeadFocus = 'notes' | 'calls' | 'followups';

export type OpenLeadOptions = {
  /** A part of the Lead View to scroll to once it has loaded. */
  focus?: LeadFocus;
  /** What gets focus back when the lead closes. Defaults to whatever has focus now. */
  returnFocus?: HTMLElement | null;
};

/** The two props that make an anchor navigate in the page. Spread onto `<a>` or a StatCard. */
export type LinkTarget = {
  href: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export type TelecallingNav = {
  /** The section showing, or underneath the open lead. */
  section: Section;
  sectionLabel: string;
  /**
   * The address's parameters. Read them once, to initialise a panel's state, and record
   * changes with `replaceParams` — deriving state from them on every render would undo a
   * user's change before it was recorded.
   */
  params: URLSearchParams;
  /** Changes whenever the panel must start over. TelecallingApp keys the panels on it. */
  navKey: number;
  leadId: number | null;
  /** The part of the open lead to scroll to, if one was asked for. */
  leadFocus: LeadFocus | null;
  /**
   * Whether the section's panel may mount. False only while a lead that the page was
   * opened on (a shared link) is showing, so the hidden list is not fetched for nothing.
   */
  originReady: boolean;
  /** Opens a section, fresh, with these filters. */
  go: (section: Section, params?: UrlParams) => void;
  /** The address `go` would move to, for an `href`. */
  href: (section: Section, params?: UrlParams) => string;
  /** `href` plus an onClick that keeps a plain click in the page. */
  linkProps: (section: Section, params?: UrlParams) => LinkTarget;
  openLead: (leadId: number, options?: OpenLeadOptions) => void;
  closeLead: () => void;
  /** A shareable address for a lead, over the current section. */
  leadHref: (leadId: number) => string;
  /** urlState's `replaceParams`, already bound to the panel's own section. */
  replaceParams: (values: UrlParams, defaults?: UrlParams) => boolean;
};

type RestorePoint = { scrollY: number; focus: HTMLElement | null };

function isLeadPushedEntry(): boolean {
  const state: unknown = window.history.state;
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[LEAD_PUSHED] === true
  );
}

/**
 * Stops any audio playing on the page.
 *
 * A recording keeps playing when the panel holding it is hidden, and a customer's voice
 * carrying on under an unrelated lead is exactly the kind of thing nobody can find the
 * source of.
 */
function pausePlayingAudio(): void {
  for (const audio of document.querySelectorAll('audio')) {
    if (!audio.paused) audio.pause();
  }
}

/**
 * The navigation state for TelecallingApp, which passes it to TelecallingNavProvider.
 * Everything else uses `useTelecallingNav()`.
 */
export function useTelecallingRouter(): TelecallingNav {
  /*
   * The query string is the state; section and lead are read from it. Starts empty and is
   * filled in by the first effect, because there is no address during the prerender.
   */
  const [search, setSearch] = useState('');
  const [navKey, setNavKey] = useState(0);
  const [leadFocus, setLeadFocus] = useState<LeadFocus | null>(null);
  const [originReady, setOriginReady] = useState(false);

  const params = useMemo(() => new URLSearchParams(search), [search]);
  const section = readSection(params);
  const leadId = readLeadId(params);

  /** Where the list was when a lead opened over it, put back when the lead closes. */
  const restoreRef = useRef<RestorePoint | null>(null);
  /** The list's last scroll position, kept while no lead is open. */
  const listScrollRef = useRef(0);
  /** Set while a Back started by closeLead is in flight. */
  const closingRef = useRef<number | null>(null);

  const endClosing = useCallback(() => {
    if (closingRef.current === null) return;
    window.clearTimeout(closingRef.current);
    closingRef.current = null;
  }, []);

  /** Puts the address the browser now shows on screen. */
  const show = useCallback((options: { remount?: boolean; focus?: LeadFocus | null } = {}) => {
    const next = window.location.search;
    setSearch(next);
    setLeadFocus(options.focus ?? null);
    if (readLeadId(new URLSearchParams(next)) === null) setOriginReady(true);
    if (options.remount) setNavKey((key) => key + 1);
  }, []);

  useEffect(() => {
    rememberSearch(window.location.search);
    discardPendingListSearch();
    listScrollRef.current = window.scrollY;
    show();

    const onPopState = () => {
      endClosing();

      const previous = lastKnownSearch();
      const current = window.location.search;
      const previousLead = readLeadId(new URLSearchParams(previous));
      const currentLead = readLeadId(new URLSearchParams(current));
      const remount = urlSignature(previous) !== urlSignature(current);

      rememberSearch(current);

      if (remount) {
        // A different list state: anything the old panel recorded or meant to put back
        // belongs to a panel that is about to be replaced.
        discardPendingListSearch();
        restoreRef.current = null;
      } else if (previousLead === null && currentLead !== null) {
        // Forward onto a lead. The list's position comes from the scroll tracking rather
        // than window.scrollY, which the browser may already have moved to the entry's.
        restoreRef.current = { scrollY: listScrollRef.current, focus: null };
      } else if (currentLead === null) {
        // Back off a lead onto the list. Filters the hidden list recorded meanwhile are
        // written into this entry now, so the address matches what it shows again.
        const pending = takePendingListSearch();
        if (pending !== null && pending !== current) writeSearch('replace', pending);
      }

      show({ remount });
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [show, endClosing]);

  // Direct `replaceParams` calls from panels change the address without passing through
  // here; follow them so `params` stays current.
  useEffect(() => subscribeToUrl(() => setSearch(window.location.search)), []);

  useEffect(() => {
    const onScroll = () => {
      if (readLeadId(new URLSearchParams(window.location.search)) === null) {
        listScrollRef.current = window.scrollY;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /*
   * Scroll and focus, after each move and before the browser paints it.
   *
   * A layout effect so the list never flashes at the wrong position: hiding the panel
   * shortens the page, and the browser clamps the scroll to the new height, so the
   * position has to be put back once the panel is visible again — not before, and not a
   * frame after.
   */
  const previousRef = useRef<{ leadId: number | null; navKey: number } | null>(null);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { leadId, navKey };
    if (previous === null) return;

    if (leadId !== null && leadId !== previous.leadId) {
      pausePlayingAudio();
      window.scrollTo(0, 0);
      return;
    }

    if (navKey !== previous.navKey) {
      window.scrollTo(0, 0);
      return;
    }

    if (leadId === null && previous.leadId !== null) {
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (!restore) return;

      window.scrollTo(0, restore.scrollY);
      // Focus goes back to the link that opened the lead, so a keyboard user carries on
      // down the list from where they were rather than from the top of the page.
      if (restore.focus?.isConnected) restore.focus.focus({ preventScroll: true });
    }
  }, [leadId, navKey]);

  const go = useCallback(
    (target: Section, values: UrlParams = {}) => {
      if (closingRef.current !== null) return;

      const next = sectionSearch(target, values);
      // Already there — the sidebar link for the section on screen — starts it over in
      // place rather than adding an entry that Back would step through to no effect.
      writeSearch(next === window.location.search ? 'replace' : 'push', next);
      discardPendingListSearch();
      restoreRef.current = null;
      show({ remount: true });
    },
    [show],
  );

  const openLead = useCallback(
    (id: number, options: OpenLeadOptions = {}) => {
      if (closingRef.current !== null || !Number.isSafeInteger(id) || id <= 0) return;

      const current = window.location.search;
      const openNow = readLeadId(new URLSearchParams(current));

      if (openNow === id) {
        setLeadFocus(options.focus ?? null);
        return;
      }

      // From a lead to another lead, the list's position was recorded when the first one
      // opened, and that is still where the list is.
      if (openNow === null) {
        const active = document.activeElement;
        restoreRef.current = {
          scrollY: window.scrollY,
          focus: options.returnFocus ?? (active instanceof HTMLElement ? active : null),
        };
      }

      writeSearch('push', withLead(current, id), { [LEAD_PUSHED]: true });
      show({ focus: options.focus ?? null });
    },
    [show],
  );

  const closeLead = useCallback(() => {
    if (closingRef.current !== null) return;

    const current = window.location.search;
    if (readLeadId(new URLSearchParams(current)) === null) return;

    if (isLeadPushedEntry()) {
      // Opened from this page: step back to the entry it was opened from, so Back and
      // Forward keep working as a pair. The popstate handler takes it from there.
      closingRef.current = window.setTimeout(() => {
        closingRef.current = null;
      }, CLOSING_TIMEOUT_MS);
      window.history.back();
      return;
    }

    // The page was opened on this lead — a shared link, a new tab, a return from sign-in.
    // Back would leave the admin, so the lead is closed in place instead.
    writeSearch('replace', takePendingListSearch() ?? withoutLead(current));
    show();
  }, [show]);

  const leadHref = useCallback((id: number) => buildLeadHref(section, id), [section]);

  const replaceParams = useCallback(
    (values: UrlParams, defaults?: UrlParams) => replaceSectionParams(section, values, defaults),
    [section],
  );

  const linkProps = useCallback(
    (target: Section, values: UrlParams = {}): LinkTarget => ({
      href: sectionHref(target, values),
      onClick: (event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        go(target, values);
      },
    }),
    [go],
  );

  return useMemo(
    () => ({
      section,
      sectionLabel: labelFor(section),
      params,
      navKey,
      leadId,
      leadFocus,
      originReady,
      go,
      href: sectionHref,
      linkProps,
      openLead,
      closeLead,
      leadHref,
      replaceParams,
    }),
    [
      section,
      params,
      navKey,
      leadId,
      leadFocus,
      originReady,
      go,
      linkProps,
      openLead,
      closeLead,
      leadHref,
      replaceParams,
    ],
  );
}

const TelecallingNavContext = createContext<TelecallingNav | null>(null);

export function TelecallingNavProvider({
  value,
  children,
}: {
  value: TelecallingNav;
  children: ReactNode;
}) {
  return <TelecallingNavContext.Provider value={value}>{children}</TelecallingNavContext.Provider>;
}

export function useTelecallingNav(): TelecallingNav {
  const context = useContext(TelecallingNavContext);
  if (!context) throw new Error('useTelecallingNav must be used inside <TelecallingNavProvider>');
  return context;
}

/**
 * A link to a lead, opening the Lead View over the current section.
 *
 * A real anchor with a real address, so a Ctrl- or Cmd-click, a middle click or "copy
 * link" all do what they normally do; only a plain click stays in the page.
 */
export function LeadLink({
  leadId,
  className = 'tc-link',
  title,
  focus,
  children,
}: {
  leadId: number;
  /** Replaces the default `tc-link`, for a link styled as something else (a note cell). */
  className?: string;
  title?: string;
  /** A part of the Lead View to scroll to once it has loaded. */
  focus?: LeadFocus;
  children: ReactNode;
}) {
  const { leadHref, openLead } = useTelecallingNav();

  return (
    <a
      href={leadHref(leadId)}
      className={className}
      title={title}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        openLead(leadId, { focus, returnFocus: event.currentTarget });
      }}
    >
      {children}
    </a>
  );
}

/** A link to another section with filters applied — the same pattern as LeadLink. */
export function NavLink({
  section,
  params,
  className = 'tc-link',
  title,
  children,
}: {
  section: Section;
  params?: UrlParams;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const { linkProps } = useTelecallingNav();
  const { href, onClick } = linkProps(section, params);

  return (
    <a href={href} className={className} title={title} onClick={onClick}>
      {children}
    </a>
  );
}
