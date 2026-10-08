import { AREAS } from '@/components/admin/AdminNav';
import { BASE_PATH } from '@/lib/paths';
import { isIsoDate, type DateRange } from '@/lib/telecalling';
import { RANGE_PRESETS, type RangePreset } from './shared';

/**
 * The telecalling admin's address bar.
 *
 * The admin is one route (see TelecallingApp), so which section is showing, which lead is
 * open over it, and each section's filters all live in this one query string. That is
 * what makes a refresh, a link pasted to a colleague and the Back button reproduce what
 * was on screen.
 *
 * This module is the only code that reads or writes it. Panels call the readers to start
 * from the URL and `replaceParams` to record their filters as they change; moving between
 * views — a section, a lead — is nav.tsx's job, through the same writer.
 *
 * Two rules here come from Next.js rather than from this app:
 *
 * - `window` is read only in effects and event handlers. The page is prerendered at build
 *   time, where there is no window, and a value read during render would differ between
 *   that prerender and the first render in the browser.
 *
 * - `window.history.state` is never handed back to pushState or replaceState. Next 15
 *   patches both so that its router follows the URL, except when the state passed in
 *   already carries its private `__NA` marker, which it reads as "Next wrote this itself"
 *   and skips the sync. The router would go on believing the old URL and write it back
 *   on its next update. Every write passes null or a fresh object of our own.
 */

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * The section list lives in AdminNav, which renders the sidebar for every admin area.
 * Declaring it twice would let the sidebar and the panel switch disagree, and the sidebar
 * is the half that has to match reality.
 */
const TELECALLING = AREAS.find((group) => group.area === 'telecalling');

if (!TELECALLING) {
  throw new Error('AdminNav has no telecalling area — the sidebar and this shell disagree.');
}

export const SECTIONS = TELECALLING.items;

export type Section =
  | 'dashboard'
  | 'leads'
  | 'followups'
  | 'calls'
  | 'employees'
  | 'reports'
  | 'settings';

/** What an address with no `?section=`, or one that names no section, shows. */
export const DEFAULT_SECTION: Section = 'dashboard';

export function isSection(value: unknown): value is Section {
  return typeof value === 'string' && SECTIONS.some((section) => section.key === value);
}

export function sectionLabel(section: Section): string {
  return SECTIONS.find((item) => item.key === section)?.label ?? 'Telecalling';
}

/**
 * The admin's own page, with the base path and with the trailing slash before `?`.
 *
 * `trailingSlash` is on, so `/admin/telecalling?section=…` is answered with a redirect —
 * a wasted round trip for every link — while `/admin/telecalling/?section=…` is the page
 * itself. AREAS already spells the path with its slash.
 */
export const TELECALLING_PATH = `${BASE_PATH}${TELECALLING.path}`;

/*
 * Reserved parameter names. A panel's filters may use any other name; these two are the
 * view itself, and replaceParams refuses to touch them.
 */
const SECTION_PARAM = 'section';
const LEAD_PARAM = 'lead';

/* -------------------------------------------------------------------------- */
/* Readers                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Every reader falls back to a default rather than passing on what it found. These values
 * go straight to the API, and an address can be hand-edited or years old: a value the
 * server would refuse must never get as far as a 422 banner over an otherwise working
 * screen.
 */

/** The address's parameters, or none where there is no window (the build's prerender). */
export function currentParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function readSection(params: URLSearchParams): Section {
  const value = params.get(SECTION_PARAM);
  return isSection(value) ? value : DEFAULT_SECTION;
}

/** The lead open over the section, if any. */
export function readLeadId(params: URLSearchParams): number | null {
  return readId(params, LEAD_PARAM);
}

/** One of `allowed`, or `fallback`. */
export function readEnum<T extends string>(
  params: URLSearchParams,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = params.get(name);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A positive whole number in plain digits, or null. "12abc", "-3" and "1e3" are all null. */
export function readId(params: URLSearchParams, name: string): number | null {
  const value = params.get(name);
  if (value === null || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** A page number within what the API accepts (1 to 10,000), or 1. */
export function readPage(params: URLSearchParams, name = 'page'): number {
  const value = params.get(name);
  if (value === null || !/^[1-9]\d{0,4}$/.test(value)) return 1;
  const page = Number(value);
  return page <= 10_000 ? page : 1;
}

/**
 * Free text, trimmed and cut to `max` characters — the API's limit for a search is 120.
 *
 * Cut by UTF-16 units, which is how the server counts, without leaving half of an emoji
 * at the end.
 */
export function readText(params: URLSearchParams, name: string, max = 120): string {
  let text = (params.get(name) ?? '').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = text.trim();
  }
  return text;
}

/** A date-range preset key, or `fallback`. */
export function readRange(
  params: URLSearchParams,
  fallback: RangePreset,
  name = 'range',
): RangePreset {
  return readEnum(
    params,
    name,
    RANGE_PRESETS.map((preset) => preset.key),
    fallback,
  );
}

/** A real `YYYY-MM-DD` calendar date, or null. "2026-02-30" is null. */
export function readDate(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value !== null && isIsoDate(value) ? value : null;
}

/**
 * An explicit date range — from a chart bucket or a link — or null when there is none.
 *
 * Either end may be missing. A range that ends before it starts is treated as no range:
 * passing it on would at best list nothing and at worst be refused outright.
 */
export function readCustomRange(
  params: URLSearchParams,
  fromName = 'from',
  toName = 'to',
): DateRange | null {
  const from = readDate(params, fromName);
  const to = readDate(params, toName);

  if (from === null && to === null) return null;
  if (from !== null && to !== null && from > to) return null;

  return {
    ...(from !== null ? { from } : {}),
    ...(to !== null ? { to } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

export type UrlValue = string | number | boolean | null | undefined;
export type UrlParams = Record<string, UrlValue>;

/**
 * A parameter as it appears in the address, or null to leave it out.
 *
 * Empty, null and `all` are left out. `all` is how every filter select spells "no
 * filter", and the API binding drops it for the same reason, so an address never says
 * what the default already means.
 */
function serialise(value: UrlValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const text = typeof value === 'string' ? value.trim() : String(value);
  return text === '' || text === 'all' ? null : text;
}

/**
 * `?section=…&…&lead=…`, with the section first and the lead last.
 *
 * A fixed order, so that the same view always produces the same string — "unchanged" is
 * decided by comparing strings — and so the address reads naturally.
 */
function composeSearch(
  section: Section,
  entries: Iterable<[string, string]>,
  leadId: number | null,
): string {
  const params = new URLSearchParams();
  params.set(SECTION_PARAM, section);
  for (const [key, value] of entries) {
    if (key !== SECTION_PARAM && key !== LEAD_PARAM) params.append(key, value);
  }
  if (leadId !== null) params.set(LEAD_PARAM, String(leadId));
  return `?${params.toString()}`;
}

/** The query string of a section opened fresh: its section and these params, nothing else. */
export function sectionSearch(section: Section, params: UrlParams = {}): string {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    const text = serialise(value);
    if (text !== null) entries.push([key, text]);
  }
  return composeSearch(section, entries, null);
}

/** A link to a section opened fresh, for an `href`. */
export function sectionHref(section: Section, params: UrlParams = {}): string {
  return `${TELECALLING_PATH}${sectionSearch(section, params)}`;
}

/**
 * A link to a lead, open over `section` with that section's default filters.
 *
 * Only the section and the lead, deliberately. This is the address a new tab opens or a
 * colleague is sent, and it should show them the lead, not the sender's list filters.
 */
export function leadHref(section: Section, leadId: number): string {
  return `${TELECALLING_PATH}${composeSearch(section, [], leadId)}`;
}

/** The same view with this lead open over it, keeping the section's filters. */
export function withLead(search: string, leadId: number): string {
  const params = new URLSearchParams(search);
  return composeSearch(readSection(params), params.entries(), leadId);
}

/** The same view with no lead open. */
export function withoutLead(search: string): string {
  const params = new URLSearchParams(search);
  return composeSearch(readSection(params), params.entries(), null);
}

/**
 * What a section's panel is showing, as one string: its section and its filters.
 *
 * Two addresses with the same signature show the same panel in the same state, whatever
 * the parameter order, empty values or an open lead. nav.tsx remounts the panel exactly
 * when this changes on a Back or Forward — an open lead alone never does.
 */
export function urlSignature(search: string): string {
  const params = new URLSearchParams(search);
  const filters = [...params.entries()]
    .filter(([key, value]) => key !== SECTION_PARAM && key !== LEAD_PARAM && serialise(value) !== null)
    .map(([key, value]): [string, string] => [key, value.trim()])
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? (valueA < valueB ? -1 : valueA > valueB ? 1 : 0) : keyA < keyB ? -1 : 1,
    );
  return `${readSection(params)}?${new URLSearchParams(filters).toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The query string as of the last write here or the last Back/Forward nav.tsx saw.
 *
 * nav.tsx compares a new address with this one to decide what a Back or Forward changed:
 * the browser has already moved `window.location` by the time it says so.
 */
let knownSearch: string | null = null;

/**
 * Filters a panel recorded while a lead was open over it.
 *
 * The lead's history entry belongs to the lead: writing the hidden list's filters into it
 * would make Back land on an address the list no longer matches — and remount the list,
 * losing its scroll and selection. They wait here instead and are written into the list's
 * own entry when the lead closes. nav.tsx owns when that happens.
 */
let pendingListSearch: string | null = null;

const listeners = new Set<() => void>();

/** Called after every write here. Returns the unsubscribe. */
export function subscribeToUrl(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function lastKnownSearch(): string {
  if (knownSearch !== null) return knownSearch;
  return typeof window === 'undefined' ? '' : window.location.search;
}

/** For nav.tsx, after the browser moved the address itself (Back, Forward, a fresh load). */
export function rememberSearch(search: string): void {
  knownSearch = search;
}

/** The list filters waiting for a lead to close, taken once. */
export function takePendingListSearch(): string | null {
  const pending = pendingListSearch;
  pendingListSearch = null;
  return pending;
}

export function discardPendingListSearch(): void {
  pendingListSearch = null;
}

/**
 * Moves the address to `search` on this page — a new history entry, or in place.
 *
 * The path is the one the page is on, not TELECALLING_PATH: a write only ever changes the
 * query, and the page should not start answering at a different spelling of itself. Any
 * `#fragment` is dropped, since it belonged to the view being left.
 */
export function writeSearch(
  mode: 'push' | 'replace',
  search: string,
  state: Record<string, unknown> | null = null,
): void {
  const url = `${window.location.pathname}${search}`;

  if (mode === 'push') window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);

  knownSearch = window.location.search;
  for (const listener of listeners) listener();
}

/**
 * Records a panel's filters in the address, without a new history entry.
 *
 * Filters change on every keystroke-settle and click; a history entry for each would make
 * Back step through them one at a time. Values that are empty, `all`, or equal to
 * `defaults[key]` are removed, so a panel on its defaults has a clean address. Keys not
 * named in `values` are left alone, and `section` and `lead` cannot be set this way.
 *
 * A no-op unless the address is showing `section` — so a request finishing in a panel
 * that is already on its way out can never write its filters into the next section — and
 * when nothing would change. While a lead is open over the section, the filters are kept
 * for when it closes (see `pendingListSearch`).
 *
 * Returns whether anything was recorded.
 */
export function replaceParams(
  section: Section,
  values: UrlParams,
  defaults: UrlParams = {},
): boolean {
  if (typeof window === 'undefined') return false;

  const current = new URLSearchParams(window.location.search);
  if (readSection(current) !== section) return false;

  const leadOpen = readLeadId(current) !== null;
  const base = new URLSearchParams(
    leadOpen && pendingListSearch !== null ? pendingListSearch : window.location.search,
  );
  base.delete(LEAD_PARAM);

  for (const [key, value] of Object.entries(values)) {
    if (key === SECTION_PARAM || key === LEAD_PARAM) continue;

    const text = serialise(value);
    if (text === null || text === serialise(defaults[key])) base.delete(key);
    else base.set(key, text);
  }

  const filters = [...base.entries()].filter(([key]) => key !== SECTION_PARAM);

  // A bare address stays bare: a section on its defaults, reached without `?section=`,
  // is not rewritten to spell its own default out.
  const listSearch =
    filters.length === 0 && !current.has(SECTION_PARAM) ? '' : composeSearch(section, filters, null);

  if (leadOpen) {
    const showing = withoutLead(window.location.search);
    const next = listSearch === showing ? null : listSearch;
    const changed = next !== pendingListSearch;
    pendingListSearch = next;
    return changed;
  }

  if (listSearch === window.location.search) return false;

  writeSearch('replace', listSearch, null);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

type ClickLike = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

/**
 * Whether a click on a link should be handled here, in the page.
 *
 * Only a plain primary-button click. With a modifier held — Ctrl or Cmd for a new tab,
 * Shift for a new window, Alt to download — the browser does what the person asked for,
 * which is why the links are real anchors with real addresses. A middle click never
 * arrives as a `click` at all.
 */
export function isPlainLeftClick(event: ClickLike): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}
