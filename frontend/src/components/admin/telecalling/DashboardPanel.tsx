'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import {
  formatDuration,
  telecallingApi,
  type AdminDashboard,
  type EmployeePerformance,
} from '@/lib/telecalling';
import {
  BarChart,
  EmptyPanel,
  RangePicker,
  StatCard,
  StatGrid,
  StatGridSkeleton,
  rangeFor,
  type RangePreset,
} from './shared';

/**
 * Admin dashboard (spec: Admin Module 2).
 *
 * One request fills the whole screen — totals, per-employee performance and the overdue
 * breakdown all come back together. The alternative, a request per tile, would put
 * fifteen round trips behind the first screen a manager sees every morning.
 */
export function DashboardPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [preset, setPreset] = useState<RangePreset>('month');
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(await telecallingApi.dashboard(rangeFor(preset), controller.signal));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load the dashboard.');
    } finally {
      setLoading(false);
    }
  }, [preset, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  /*
   * Tiles, not table rows.
   *
   * This screen is three stat grids above one table, and standing in for it with eight
   * table rows described a layout that never appears — so the page visibly rearranged
   * itself the moment the data landed.
   */
  if (loading && !data) {
    return (
      <>
        <h2 className="tc-section-title">Leads</h2>
        <StatGridSkeleton count={6} />
        <h2 className="tc-section-title">Calls</h2>
        <StatGridSkeleton count={6} />
        <h2 className="tc-section-title">Follow-ups and team</h2>
        <StatGridSkeleton count={4} />
      </>
    );
  }

  if (!data) {
    return (
      <>
        {error ? <FormAlert variant="error">{error}</FormAlert> : null}
        <EmptyPanel
          title="Nothing to show"
          message="The dashboard could not be loaded."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      </>
    );
  }

  const { leads, calls, followUps, employees, conversionRate, employeeRows, overdueByEmployee } =
    data;

  /** Ranked by talk time — the measure that best reflects work actually done. */
  const busiest: EmployeePerformance[] = [...employeeRows]
    .filter((row) => row.calls > 0)
    .sort((a, b) => b.talkTimeSeconds - a.talkTimeSeconds)
    .slice(0, 8);

  return (
    <>
      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      <div className="tc-panel-head">
        <RangePicker value={preset} onChange={setPreset} />
      </div>

      {/*
        Overdue follow-ups get their own banner rather than a tile, and only when there
        are any. A permanent "0 overdue" tile teaches people to skip the place the real
        warning will one day appear.
      */}
      {followUps.overdue > 0 ? (
        <FormAlert variant="error">
          {followUps.overdue === 1
            ? '1 follow-up is overdue.'
            : `${followUps.overdue} follow-ups are overdue.`}{' '}
          {overdueByEmployee.length > 0
            ? `Worst affected: ${overdueByEmployee
                .slice(0, 3)
                .map((row) => `${row.name} (${row.overdue})`)
                .join(', ')}.`
            : null}
        </FormAlert>
      ) : null}

      <h2 className="tc-section-title">Leads</h2>
      <StatGrid>
        <StatCard value={leads.total} label="Total leads" icon="target" />
        <StatCard
          value={leads.new}
          label="Not yet contacted"
          tone={leads.new > 0 ? 'warn' : 'default'}
          icon="inbox"
        />
        <StatCard
          value={leads.unassigned}
          label="Unassigned"
          tone={leads.unassigned > 0 ? 'warn' : 'default'}
          hint={leads.unassigned > 0 ? 'Nobody is working these' : undefined}
        />
        <StatCard value={leads.assigned} label="Assigned" icon="users" />
        <StatCard value={leads.walkedIn} label="Walked in" tone="accent" icon="pin" />
        <StatCard value={leads.converted} label="Converted" tone="good" icon="check" />
        <StatCard
          value={leads.lost}
          label="Lost"
          tone={leads.lost > 0 ? 'bad' : 'default'}
          icon="close"
        />
      </StatGrid>

      <h2 className="tc-section-title">Calls</h2>
      <StatGrid>
        <StatCard value={calls.total} label="Total calls" icon="phone" />
        <StatCard value={calls.answered} label="Answered" tone="good" icon="check" />
        <StatCard value={calls.missed} label="Not answered" icon="phone" />
        <StatCard
          value={formatDuration(calls.talkTimeSeconds)}
          label="Total talk time"
          icon="clock"
        />
        <StatCard
          value={calls.total > 0 ? `${Math.round((calls.answered / calls.total) * 100)}%` : '—'}
          label="Answer rate"
        />
        <StatCard
          value={`${conversionRate}%`}
          label="Conversion rate"
          tone={conversionRate > 0 ? 'good' : 'default'}
          hint="Converted / total leads"
        />
      </StatGrid>

      <h2 className="tc-section-title">Follow-ups and team</h2>
      <StatGrid>
        <StatCard
          value={followUps.today}
          label="Due today"
          tone={followUps.today > 0 ? 'warn' : 'default'}
        />
        <StatCard
          value={followUps.overdue}
          label="Overdue"
          tone={followUps.overdue > 0 ? 'bad' : 'default'}
        />
        <StatCard value={followUps.completed} label="Completed today" tone="good" />
        <StatCard value={employees.active} label="Active employees" hint={`${employees.total} in total`} />
      </StatGrid>

      <h2 className="tc-section-title">Busiest telecallers</h2>
      {busiest.length === 0 ? (
        <p className="tc-muted">No calls were logged in this period.</p>
      ) : (
        <div className="tc-card">
          <BarChart
            data={busiest.map((row) => ({ label: row.name, value: row.talkTimeSeconds }))}
            primaryLabel="Talk time"
            formatValue={formatDuration}
          />
        </div>
      )}

      <h2 className="tc-section-title">Conversion by telecaller</h2>
      {employeeRows.filter((row) => row.leadsAssigned > 0).length === 0 ? (
        <p className="tc-muted">No leads are assigned yet.</p>
      ) : (
        <div className="tc-card">
          <BarChart
            data={employeeRows
              .filter((row) => row.leadsAssigned > 0)
              .sort((a, b) => b.leadsAssigned - a.leadsAssigned)
              .slice(0, 10)
              .map((row) => ({
                label: row.name,
                value: row.leadsAssigned,
                secondary: row.leadsConverted,
              }))}
            primaryLabel="Leads assigned"
            secondaryLabel="Converted"
          />
        </div>
      )}
    </>
  );
}
