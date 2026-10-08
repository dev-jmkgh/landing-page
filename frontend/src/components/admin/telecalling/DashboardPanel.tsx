'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import {
  ANALYTICS_GRANULARITIES,
  formatCount,
  formatDateRange,
  formatDuration,
  telecallingApi,
  type AdminDashboard,
  type AnalyticsGranularity,
  type AnalyticsGranularityChoice,
  type FollowUpScope,
} from '@/lib/telecalling';
import {
  DashboardCharts,
  callsWindow,
  leadsWindow,
  type ChartDataState,
  type DashboardAnalyticsResult,
} from './DashboardCharts';
import { NavLink, useTelecallingNav } from './nav';
import {
  EmptyPanel,
  RangePicker,
  StatCard,
  StatGrid,
  StatGridSkeleton,
  rangeFor,
  type RangePreset,
} from './shared';
import { readEnum, readRange, type UrlParams } from './urlState';

/**
 * Admin dashboard (spec: Admin Module 2).
 *
 * Two requests rather than one, fired together: the tiles (`/dashboard`) and the trend
 * charts (`/dashboard/analytics`). Separate so that changing the charts' granularity
 * refetches only the charts, and a chart failure can never blank the tiles — but still
 * one round trip for the screen, not one per tile.
 *
 * Every tile is a link to the list behind its number, with the filters that select
 * exactly what it counted (A-NAV §5). The period and the chart granularity live in the
 * address, so Back from a list returns to the dashboard as it was left.
 */

const DEFAULT_PRESET: RangePreset = 'month';
const GRANULARITY_CHOICES = ['auto', ...ANALYTICS_GRANULARITIES] as const;

/**
 * How "All time" is written in the dashboard's own address.
 *
 * urlState never writes the value `all` — it is how every filter select spells "no
 * filter" — so `range=all` would silently disappear and a refresh, or Back from a list,
 * would fall back to the last 30 days.
 */
const ALL_TIME_PARAM = 'all-time';

function readPreset(params: URLSearchParams): RangePreset {
  return params.get('range') === ALL_TIME_PARAM ? 'all' : readRange(params, DEFAULT_PRESET);
}

/** The same cap the server applies: past this many bars a chart is unreadable. */
const MAX_CHART_FRAMES = 400;

/** Days in an inclusive range, counting both ends, or null for an open one ("All time"). */
function spanDays(range: { from?: string; to?: string }): number | null {
  if (!range.from || !range.to) return null;
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Number.isNaN(from) || Number.isNaN(to) ? null : Math.round((to - from) / 86_400_000) + 1;
}

/** The most bars a span can produce — the server's own estimate, so the two agree. */
function estimatedFrames(granularity: AnalyticsGranularity, span: number): number {
  switch (granularity) {
    case 'hour':
      return span * 24;
    case 'day':
      return span;
    case 'week':
      return Math.ceil((span + 6) / 7);
    case 'month':
      return Math.ceil((span - 1) / 28) + 1;
  }
}

const GRANULARITY_LABELS: Record<AnalyticsGranularity, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

type AnalyticsLoaded = DashboardAnalyticsResult & { granularity: AnalyticsGranularityChoice };

export function DashboardPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const nav = useTelecallingNav();
  const { replaceParams, linkProps } = nav;

  // Read once. The panel is remounted whenever the address changes under it.
  const [preset, setPreset] = useState<RangePreset>(() => readPreset(nav.params));
  const [granularity, setGranularity] = useState<AnalyticsGranularityChoice>(() =>
    readEnum(nav.params, 'granularity', GRANULARITY_CHOICES, 'auto'),
  );

  useEffect(() => {
    replaceParams(
      { range: preset === 'all' ? ALL_TIME_PARAM : preset, granularity },
      { range: DEFAULT_PRESET, granularity: 'auto' },
    );
  }, [replaceParams, preset, granularity]);

  /* ------------------------------------------------------------------ tiles */

  const [dash, setDash] = useState<{ preset: RangePreset; data: AdminDashboard } | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState<string | null>(null);
  const dashAbort = useRef<AbortController | null>(null);

  const loadDashboard = useCallback(async () => {
    dashAbort.current?.abort();
    const controller = new AbortController();
    dashAbort.current = controller;

    setDashLoading(true);
    setDashError(null);

    try {
      const data = await telecallingApi.dashboard(rangeFor(preset), controller.signal);
      setDash({ preset, data });
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setDashError(caught instanceof ApiError ? caught.message : 'Could not load the dashboard.');
      // Another period's figures would sit under this period's name. Keep them only when
      // this was a refresh of the same period.
      setDash((previous) => (previous?.preset === preset ? previous : null));
    } finally {
      // A request replaced by a newer one must not end the newer one's loading state.
      if (dashAbort.current === controller) setDashLoading(false);
    }
  }, [preset, onUnauthorized]);

  /* ----------------------------------------------------------------- charts */

  const [analytics, setAnalytics] = useState<AnalyticsLoaded | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const analyticsAbort = useRef<AbortController | null>(null);

  const loadAnalytics = useCallback(async () => {
    analyticsAbort.current?.abort();
    const controller = new AbortController();
    analyticsAbort.current = controller;

    setAnalyticsLoading(true);
    setAnalyticsError(null);

    const request = rangeFor(preset);

    try {
      const data = await telecallingApi.dashboardAnalytics({ ...request, granularity }, controller.signal);
      setAnalytics({ data, request, preset, granularity });
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setAnalyticsError(caught instanceof ApiError ? caught.message : 'Could not load the charts.');
      setAnalytics((previous) =>
        previous && previous.preset === preset && previous.granularity === granularity ? previous : null,
      );
    } finally {
      if (analyticsAbort.current === controller) setAnalyticsLoading(false);
    }
  }, [preset, granularity, onUnauthorized]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  useEffect(
    () => () => {
      dashAbort.current?.abort();
      analyticsAbort.current?.abort();
    },
    [],
  );

  const choosePreset = (next: RangePreset) => {
    setPreset(next);
    // A new period starts from the granularity that suits its length.
    setGranularity('auto');
  };

  /* --------------------------------------------------------- granularity */

  // The charts on screen describe the current period only once its request has landed.
  const current = analytics && analytics.preset === preset ? analytics.data : null;
  const span = current ? spanDays(current.range) : spanDays(rangeFor(preset));
  // What the server actually used once it has answered; until then, what was asked for.
  const pressed: AnalyticsGranularity | null =
    current && analytics?.granularity === granularity
      ? current.granularity
      : granularity === 'auto'
        ? null
        : granularity;

  const dashState: ChartDataState = dash
    ? dashLoading
      ? 'refetching'
      : 'ready'
    : dashLoading
      ? 'loading'
      : 'failed';
  const analyticsState: ChartDataState = analytics
    ? analyticsLoading
      ? 'refetching'
      : 'ready'
    : analyticsLoading
      ? 'loading'
      : 'failed';

  return (
    <>
      <div className="tc-panel-head tc-dash-filters">
        <RangePicker value={preset} onChange={choosePreset} />

        <div className="tc-dash-granularity">
          <span className="tc-dash-granularity__label" aria-hidden="true">
            Charts by
          </span>
          <div className="tc-segmented" role="group" aria-label="Group the charts by">
            {ANALYTICS_GRANULARITIES.filter(
              // Hourly bars only make sense for a day or two; the server refuses more.
              (option) => option !== 'hour' || (span !== null && span <= 2),
            ).map((option) => (
              <button
                key={option}
                type="button"
                className="tc-segmented__button"
                aria-pressed={pressed === option}
                disabled={span !== null && estimatedFrames(option, span) > MAX_CHART_FRAMES}
                onClick={() => setGranularity(option)}
              >
                {GRANULARITY_LABELS[option]}
              </button>
            ))}
          </div>
        </div>

        {current ? (
          <p className="tc-dash-caption">
            {formatDateRange(current.range)} · by {current.granularity} · IST
          </p>
        ) : null}
      </div>

      {dash ? (
        <>
          {dashError ? (
            <FormAlert variant="error">
              The figures could not be refreshed. {dashError}{' '}
              <button type="button" className="tc-alert-action" onClick={() => void loadDashboard()}>
                Try again
              </button>
            </FormAlert>
          ) : null}

          <LoadingOverlay busy={dashLoading} label="Updating the figures…">
            <DashboardTiles
              data={dash.data}
              leads={leadsWindow(dash.preset)}
              calls={callsWindow(dash.preset)}
              linkProps={linkProps}
            />
          </LoadingOverlay>
        </>
      ) : dashLoading ? (
        /*
          Tiles, not table rows: the screen is three stat grids, and a skeleton in another
          shape made the page visibly rearrange itself the moment the data landed.
        */
        <>
          <h2 className="tc-section-title">Leads</h2>
          <StatGridSkeleton count={7} />
          <h2 className="tc-section-title">Calls</h2>
          <StatGridSkeleton count={8} />
          <h2 className="tc-section-title">Follow-ups and team</h2>
          <StatGridSkeleton count={4} />
        </>
      ) : (
        <>
          {dashError ? <FormAlert variant="error">{dashError}</FormAlert> : null}
          <EmptyPanel
            title="Nothing to show"
            message="The dashboard figures could not be loaded."
            actionLabel="Try again"
            onAction={() => void loadDashboard()}
          />
        </>
      )}

      <h2 className="tc-section-title">Trends</h2>
      <DashboardCharts
        analytics={analytics}
        analyticsState={analyticsState}
        analyticsError={analyticsError}
        onRetryAnalytics={() => void loadAnalytics()}
        rows={dash?.data.employeeRows ?? null}
        rowsPreset={dash?.preset ?? preset}
        rowsState={dashState}
        onWiden={
          preset === 'today' || preset === 'week' || preset === 'month' ? () => choosePreset('quarter') : undefined
        }
      />
    </>
  );
}

type LinkPropsFn = ReturnType<typeof useTelecallingNav>['linkProps'];

/**
 * The three tile groups, each tile a link to the list behind its number.
 *
 * `leads` and `calls` are the list filters for the period the figures were counted for;
 * each tile adds its own on top. The follow-up and team tiles are live — not bound by the
 * period — so their links carry no dates.
 */
function DashboardTiles({
  data,
  leads: leadWindow,
  calls: callWindow,
  linkProps,
}: {
  data: AdminDashboard;
  leads: UrlParams;
  calls: UrlParams;
  linkProps: LinkPropsFn;
}) {
  const { leads, calls, followUps, employees, conversionRate, overdueByEmployee } = data;

  const toLeads = (params: UrlParams = {}) => linkProps('leads', { ...leadWindow, ...params });
  const toCalls = (params: UrlParams = {}) => linkProps('calls', { ...callWindow, ...params });
  const toFollowUps = (scope: FollowUpScope) => linkProps('followups', { scope });

  return (
    <div>
      {/*
        Overdue follow-ups get their own banner rather than a tile, and only when there
        are any. A permanent "0 overdue" tile teaches people to skip the place the real
        warning will one day appear.

        The "worst affected" names are deliberately not links: they count follow-ups
        overdue by more than the alert threshold (followup.overdue_alert_hours), which no
        list filter expresses, so a link would open a list that disagrees with them.
      */}
      {followUps.overdue > 0 ? (
        <FormAlert variant="error">
          {followUps.overdue === 1
            ? '1 follow-up is overdue.'
            : `${formatCount(followUps.overdue)} follow-ups are overdue.`}{' '}
          {overdueByEmployee.length > 0
            ? `Worst affected: ${overdueByEmployee
                .slice(0, 3)
                .map((row) => `${row.name} (${row.overdue})`)
                .join(', ')}. `
            : null}
          <NavLink section="followups" params={{ scope: 'overdue' }} className="tc-alert-link">
            View overdue follow-ups
          </NavLink>
        </FormAlert>
      ) : null}

      <h2 className="tc-section-title">Leads</h2>
      <StatGrid>
        <StatCard value={formatCount(leads.total)} label="Total leads" icon="target" {...toLeads()} />
        <StatCard
          value={formatCount(leads.new)}
          label="Not yet contacted"
          tone={leads.new > 0 ? 'warn' : 'default'}
          icon="inbox"
          {...toLeads({ contacted: 'never' })}
        />
        <StatCard
          value={formatCount(leads.unassigned)}
          label="Unassigned"
          tone={leads.unassigned > 0 ? 'warn' : 'default'}
          hint={leads.unassigned > 0 ? 'Nobody is working these' : undefined}
          {...toLeads({ assignedTo: 'unassigned' })}
        />
        <StatCard
          value={formatCount(leads.assigned)}
          label="Assigned"
          icon="users"
          {...toLeads({ assignedTo: 'assigned' })}
        />
        <StatCard
          value={formatCount(leads.walkedIn)}
          label="Walked in"
          tone="accent"
          icon="pin"
          {...toLeads({ status: 'walked_in' })}
        />
        <StatCard
          value={formatCount(leads.converted)}
          label="Converted"
          tone="good"
          icon="check"
          {...toLeads({ status: 'converted' })}
        />
        <StatCard
          value={formatCount(leads.lost)}
          label="Lost"
          tone={leads.lost > 0 ? 'bad' : 'default'}
          icon="close"
          {...toLeads({ status: 'lost' })}
        />
      </StatGrid>

      <h2 className="tc-section-title">Calls</h2>
      <StatGrid>
        <StatCard value={formatCount(calls.total)} label="Total calls" icon="phone" {...toCalls()} />
        <StatCard
          value={formatCount(calls.answered)}
          label="Answered"
          tone="good"
          icon="check"
          {...toCalls({ outcome: 'answered' })}
        />
        {/*
          Every unanswered outcome — missed, rejected, busy, unreachable, no answer — not
          just "missed", so the link uses the `unanswered` group rather than one outcome.
        */}
        <StatCard
          value={formatCount(calls.missed)}
          label="Not answered"
          icon="phone"
          {...toCalls({ outcome: 'unanswered' })}
        />
        {/* Talk time counts answered calls only; the list's summary line repeats the figure. */}
        <StatCard
          value={formatDuration(calls.talkTimeSeconds)}
          label="Total talk time"
          icon="clock"
          {...toCalls({ outcome: 'answered' })}
        />
        <StatCard
          value={calls.total > 0 ? `${Math.round((calls.answered / calls.total) * 100)}%` : '—'}
          label="Answer rate"
          {...toCalls()}
        />
        {/*
          Incoming, as a share of the total rather than as a rival total.

          Telecallers' handsets report the calls customers make to them, so this is the
          only place the business can see how much of the day's activity it did not
          initiate. The hint says it is a subset, because "Total calls 400 / Incoming 90"
          otherwise reads as 490.
        */}
        <StatCard
          value={formatCount(calls.incoming)}
          label="Incoming"
          icon="phone"
          tone="accent"
          hint="Customers who called in — included in total calls"
          {...toCalls({ direction: 'incoming' })}
        />
        <StatCard
          value={formatCount(calls.incomingMissed)}
          label="Incoming missed"
          icon="phone"
          tone={calls.incomingMissed > 0 ? 'bad' : 'default'}
          hint="Nobody picked up"
          {...toCalls({ direction: 'incoming', outcome: 'unanswered' })}
        />
        <StatCard
          value={`${conversionRate}%`}
          label="Conversion rate"
          tone={conversionRate > 0 ? 'good' : 'default'}
          hint="Converted / total leads"
          {...toLeads({ status: 'converted' })}
        />
      </StatGrid>

      <h2 className="tc-section-title tc-section-title--with-hint">Follow-ups and team</h2>
      <p className="tc-section-hint">As of now. The date range does not apply.</p>
      <StatGrid>
        <StatCard
          value={formatCount(followUps.today)}
          label="Due today"
          tone={followUps.today > 0 ? 'warn' : 'default'}
          {...toFollowUps('today')}
        />
        <StatCard
          value={formatCount(followUps.overdue)}
          label="Overdue"
          tone={followUps.overdue > 0 ? 'bad' : 'default'}
          {...toFollowUps('overdue')}
        />
        <StatCard
          value={formatCount(followUps.completed)}
          label="Completed today"
          tone="good"
          {...toFollowUps('completed_today')}
        />
        <StatCard
          value={formatCount(employees.active)}
          label="Active employees"
          hint={`${formatCount(employees.total)} in total`}
          {...linkProps('employees', { approval: 'approved', active: true })}
        />
      </StatGrid>
    </div>
  );
}
