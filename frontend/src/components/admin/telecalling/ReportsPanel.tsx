'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  formatDuration,
  humanise,
  telecallingApi,
  type EmployeePerformance,
} from '@/lib/telecalling';
import {
  BarChart,
  RangePicker,
  StatCard,
  StatGrid,
  TableSkeleton,
  downloadCsv,
  rangeFor,
  type RangePreset,
} from './shared';

/**
 * Reports, analytics and performance (spec: Admin Modules 11, 12 and 13).
 *
 * One screen because they answer one question from three angles: who is doing the work,
 * where the leads come from, and whether the follow-ups are being kept. Separate screens
 * would mean setting the same date range three times.
 */

type Dimension = 'status' | 'source' | 'employee';

type ReportData = {
  performance: EmployeePerformance[];
  trend: { period: string; calls: number; answered: number; missed: number; talkTimeSeconds: number }[];
  breakdown: { key: string; total: number; converted: number; conversionRate: number }[];
  followUps: {
    created: number;
    completed: number;
    pending: number;
    overdue: number;
    cancelled: number;
    completedOnTime: number;
    completedLate: number;
  };
};

export function ReportsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [preset, setPreset] = useState<RangePreset>('month');
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day');
  const [dimension, setDimension] = useState<Dimension>('source');

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);
  const range = useMemo(() => rangeFor(preset), [preset]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      /**
       * Four requests in parallel rather than one composite endpoint.
       *
       * Each is a different report with its own filters — granularity applies only to
       * the trend, dimension only to the breakdown — so a single endpoint would take
       * every parameter and recompute all four whenever any one of them changed.
       */
      const [performance, trend, breakdown, followUps] = await Promise.all([
        telecallingApi.performance(range, controller.signal),
        telecallingApi.callTrend({ granularity, ...range }, controller.signal),
        telecallingApi.leadBreakdown({ dimension, ...range }, controller.signal),
        telecallingApi.followUpReport({ ...range }, controller.signal),
      ]);

      setData({ performance, trend: trend.items, breakdown: breakdown.items, followUps });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load the reports.');
    } finally {
      setLoading(false);
    }
  }, [range, granularity, dimension, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const exportPerformance = () => {
    if (!data) return;

    downloadCsv(
      `jmk-performance-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Code',
        'Name',
        'Role',
        'Active',
        'Total calls',
        'Answered',
        'Not answered',
        'Talk time (seconds)',
        'Average call (seconds)',
        'Follow-ups completed',
        'Follow-ups pending',
        'Leads assigned',
        'Customers reached',
        'Leads converted',
        'Conversion rate (%)',
      ],
      data.performance.map((row) => [
        row.employeeCode,
        row.name,
        row.role,
        row.isActive ? 'Yes' : 'No',
        row.calls,
        row.answered,
        row.missed,
        row.talkTimeSeconds,
        row.averageDurationSeconds,
        row.followUpsCompleted,
        row.followUpsPending,
        row.leadsAssigned,
        row.leadsContacted,
        row.leadsConverted,
        row.conversionRate,
      ]),
    );
  };

  if (loading && !data) return <TableSkeleton rows={10} />;

  return (
    <>
      <div className="tc-panel-head">
        <RangePicker value={preset} onChange={setPreset} />

        <button
          type="button"
          className="btn btn--outline btn--sm"
          onClick={exportPerformance}
          disabled={!data || data.performance.length === 0}
        >
          <Icon name="download" size={15} />
          Export performance
        </button>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {data ? (
        <>
          <h2 className="tc-section-title">Follow-up performance</h2>
          <StatGrid>
            <StatCard value={data.followUps.created} label="Follow-ups booked" />
            <StatCard value={data.followUps.completed} label="Completed" tone="good" />
            <StatCard
              value={data.followUps.completedOnTime}
              label="Completed on time"
              tone="good"
              hint={
                data.followUps.completed > 0
                  ? `${Math.round((data.followUps.completedOnTime / data.followUps.completed) * 100)}% of completed`
                  : undefined
              }
            />
            <StatCard
              value={data.followUps.completedLate}
              label="Completed late"
              tone={data.followUps.completedLate > 0 ? 'warn' : 'default'}
            />
            <StatCard
              value={data.followUps.overdue}
              label="Still overdue"
              tone={data.followUps.overdue > 0 ? 'bad' : 'default'}
            />
            <StatCard value={data.followUps.cancelled} label="Cancelled" />
          </StatGrid>

          <div className="tc-panel-head">
            <h2 className="tc-section-title" style={{ marginBottom: 0 }}>
              Call volume
            </h2>
            <div className="tc-segmented" role="group" aria-label="Group calls by">
              {(['day', 'week', 'month'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="tc-segmented__button"
                  aria-pressed={granularity === value}
                  onClick={() => setGranularity(value)}
                >
                  {humanise(value)}
                </button>
              ))}
            </div>
          </div>

          <div className="tc-card">
            <BarChart
              // Newest last reads as a timeline; the API already returns ascending order.
              data={data.trend.map((point) => ({
                label: point.period,
                value: point.calls,
                secondary: point.answered,
              }))}
              primaryLabel="Calls"
              secondaryLabel="Answered"
            />
          </div>

          <div className="tc-panel-head">
            <h2 className="tc-section-title" style={{ marginBottom: 0 }}>
              Leads and conversion
            </h2>
            <div className="tc-segmented" role="group" aria-label="Break leads down by">
              {(['source', 'status', 'employee'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="tc-segmented__button"
                  aria-pressed={dimension === value}
                  onClick={() => setDimension(value)}
                >
                  By {value}
                </button>
              ))}
            </div>
          </div>

          <div className="tc-card">
            <BarChart
              data={data.breakdown.map((row) => ({
                label: humanise(row.key),
                value: row.total,
                secondary: row.converted,
              }))}
              primaryLabel="Leads"
              secondaryLabel="Converted"
            />
          </div>

          {dimension === 'source' && data.breakdown.length > 0 ? (
              <DataTable
                rows={data.breakdown}
                rowKey={(row) => row.key}
                minWidth="34rem"
                caption="Leads and conversions by source"
                columns={[
                  { key: 'source', header: 'Source', render: (row) => humanise(row.key) },
                  {
                    /* Counts are right-aligned throughout the reports. */
                    key: 'total',
                    header: 'Leads',
                    align: 'end',
                    width: '7rem',
                    render: (row) => row.total,
                  },
                  {
                    key: 'converted',
                    header: 'Converted',
                    align: 'end',
                    width: '8rem',
                    render: (row) => row.converted,
                  },
                  {
                    key: 'rate',
                    header: 'Conversion rate',
                    align: 'end',
                    width: '10rem',
                    nowrap: true,
                    render: (row) => `${row.conversionRate}%`,
                  },
                ]}
              />
          ) : null}

          <h2 className="tc-section-title">Employee performance</h2>

          {data.performance.length === 0 ? (
            <p className="tc-muted">No employees have activity in this period.</p>
          ) : (
              <DataTable
                rows={data.performance}
                rowKey={(row) => row.userId}
                minWidth="76rem"
                caption="Per-employee call, follow-up and conversion figures for the period"
                columns={[
                  {
                    key: 'employee',
                    header: 'Employee',
                    render: (row) => (
                      <CellStack primary={row.name}>
                        <span className="tc-muted tc-mono">{row.employeeCode}</span>
                        {!row.isActive ? (
                          <span className="tc-badge tc-badge--bad">Deactivated</span>
                        ) : null}
                      </CellStack>
                    ),
                  },
                  {
                    key: 'calls',
                    header: 'Calls',
                    align: 'end',
                    width: '6rem',
                    render: (row) => row.calls,
                  },
                  {
                    key: 'answered',
                    header: 'Answered',
                    align: 'end',
                    width: '7.5rem',
                    render: (row) => (
                      <CellStack
                        primary={row.answered}
                        secondary={
                          row.calls > 0
                            ? `${Math.round((row.answered / row.calls) * 100)}%`
                            : null
                        }
                      />
                    ),
                  },
                  {
                    key: 'talkTime',
                    header: 'Talk time',
                    align: 'end',
                    width: '7.5rem',
                    nowrap: true,
                    render: (row) => formatDuration(row.talkTimeSeconds),
                  },
                  {
                    key: 'avgCall',
                    header: 'Avg call',
                    align: 'end',
                    width: '7.5rem',
                    nowrap: true,
                    render: (row) => formatDuration(row.averageDurationSeconds),
                  },
                  {
                    key: 'followUps',
                    header: 'Follow-ups',
                    align: 'end',
                    width: '8.5rem',
                    render: (row) => (
                      <CellStack
                        primary={`${row.followUpsCompleted} done`}
                        secondary={
                          <span className={row.followUpsPending > 0 ? 'tc-cell-warn' : undefined}>
                            {row.followUpsPending} pending
                          </span>
                        }
                      />
                    ),
                  },
                  {
                    key: 'leads',
                    header: 'Leads',
                    align: 'end',
                    width: '9rem',
                    render: (row) => (
                      <CellStack
                        primary={`${row.leadsAssigned} assigned`}
                        /*
                          "Reached" counts distinct customers actually spoken to, not calls
                          made. Labelled explicitly because the two are easy to confuse and
                          conflating them rewards ringing the same person repeatedly.
                        */
                        secondary={`${row.leadsContacted} reached`}
                      />
                    ),
                  },
                  {
                    key: 'converted',
                    header: 'Converted',
                    align: 'end',
                    width: '8rem',
                    render: (row) => (
                      <CellStack primary={row.leadsConverted} secondary={`${row.conversionRate}%`} />
                    ),
                  },
                ]}
              />
          )}
        </>
      ) : null}
    </>
  );
}
