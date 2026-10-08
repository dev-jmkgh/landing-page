'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { ButtonSpinner, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  formatDateTime,
  telecallingApi,
  type AuditEntry,
  type LeadSourceRecord,
  type Paginated,
  type SettingRecord,
} from '@/lib/telecalling';
import { DailyReportSection } from './DailyReportSection';
import { useTelecallingNav } from './nav';
import { EmptyPanel, Pager, Tag, TableSkeleton } from './shared';
import { readEnum, readPage } from './urlState';

/**
 * System settings, lead sources, the audit log and the daily report email (spec: Admin
 * Modules 13, 14 and 15).
 *
 * Grouped because they are all "how the system is configured and what has been done to
 * it" — the screen an administrator opens rarely and deliberately, rather than as part
 * of daily work.
 *
 * The tab and the page of whichever history it shows live in the address, so a refresh
 * or a shared link lands on the same view.
 */

const TABS = ['settings', 'sources', 'audit', 'report'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  settings: 'Settings',
  sources: 'Lead sources',
  audit: 'Audit log',
  report: 'Daily report',
};

/** The tabs whose content is a paged history; only they carry `page` in the address. */
const PAGED_TABS: readonly Tab[] = ['audit', 'report'];

/** Descriptions for the switches an admin will actually reason about. */
const SETTING_HELP: Record<string, string> = {
  'recording.enabled':
    'Leave off until calls are routed through a telephony provider. On-device recording is blocked by Android 10+ and by every version of iOS, so this switch does nothing on its own.',
  'recording.announce':
    'Plays an announcement to the customer before a recorded call connects. Keep this on — notifying the other party is a legal requirement.',
  'followup.reminder_minutes': 'How long before a follow-up is due to notify the telecaller.',
  'followup.overdue_alert_hours':
    'How long a follow-up may stay overdue before it is flagged on the admin dashboard.',
  'assignment.strategy':
    'How new leads find an owner. Only "manual" is implemented; round-robin and load-based are planned.',
  'calling.working_hours': 'Advisory calling window shown in the mobile app. Not enforced.',
  'report.daily_email_enabled':
    "Emails yesterday's calls, leads, follow-ups and per-employee activity to the administrators every morning.",
  'report.daily_email_time':
    "When the daily email is sent, in 24-hour IST time. It always covers the whole previous day: 08:00 sends Monday's report on Tuesday morning.",
};

/** A setting holding a time of day — `report.daily_email_time` and any added later. */
function isTimeSetting(setting: SettingRecord): setting is SettingRecord & { value: string } {
  return setting.key.endsWith('_time') && typeof setting.value === 'string' && /^\d{2}:\d{2}$/.test(setting.value);
}

export function SettingsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const nav = useTelecallingNav();
  const { replaceParams } = nav;

  // Read once. The panel is remounted whenever the address changes under it.
  const [tab, setTab] = useState<Tab>(() => readEnum(nav.params, 'tab', TABS, 'settings'));
  const [page, setPage] = useState(() => readPage(nav.params));

  useEffect(() => {
    replaceParams(
      { tab, page: PAGED_TABS.includes(tab) ? page : undefined },
      { tab: 'settings', page: 1 },
    );
  }, [replaceParams, tab, page]);

  const [settings, setSettings] = useState<SettingRecord[] | null>(null);
  const [sources, setSources] = useState<LeadSourceRecord[] | null>(null);
  const [audit, setAudit] = useState<Paginated<AuditEntry> | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The tab the server refused for this role. Retrying cannot help, so no "Try again". */
  const [denied, setDenied] = useState<Tab | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  /**
   * Per setting, bumped after a refused save. The value inputs are uncontrolled, so a
   * rejected value would otherwise stay on screen looking saved; a new key remounts that
   * one input with the value the server actually holds, leaving the others alone.
   */
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const resetControl = (key: string) =>
    setRevisions((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));

  /** Bumped by Refresh while the Daily report tab is open; the section reloads itself. */
  const [reportRefresh, setReportRefresh] = useState(0);

  const [newSource, setNewSource] = useState({ slug: '', label: '' });

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();

    // The daily report section fetches its own data.
    if (tab === 'report') {
      abort.current = null;
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      if (tab === 'settings') {
        setSettings(await telecallingApi.listSettings(controller.signal));
      } else if (tab === 'sources') {
        setSources(await telecallingApi.listLeadSources(controller.signal));
      } else {
        setAudit(await telecallingApi.listAuditLogs({ page, pageSize: 30 }, controller.signal));
      }
      setDenied(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (caught instanceof ApiError && caught.status === 403) {
        setDenied(tab);
        setError('Your role does not have access to this section.');
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load this section.');
    } finally {
      // A request replaced by a newer one must not end the newer one's loading state.
      if (abort.current === controller) setLoading(false);
    }
  }, [tab, page, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  // A page past the end — a hand-edited address, or entries removed since — goes back to
  // the first page rather than claiming the log is empty.
  useEffect(() => {
    if (tab === 'audit' && audit && audit.items.length === 0 && audit.total > 0 && page > 1) setPage(1);
  }, [tab, audit, page]);

  const chooseTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setPage(1);
    setError(null);
    setNotice(null);
  };

  const refresh = () => {
    if (tab === 'report') setReportRefresh((value) => value + 1);
    else void load();
  };

  /* ------------------------------------------------------------------ actions */

  const saveSetting = async (key: string, value: unknown) => {
    setBusyKey(key);
    setError(null);
    setNotice(null);

    try {
      setSettings(await telecallingApi.saveSetting(key, value));
      setNotice('Setting saved.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not save the setting.');
      // Put the stored value back in the field, and re-read the list in case it is the
      // list that was out of date.
      resetControl(key);
      void load();
    } finally {
      setBusyKey(null);
    }
  };

  const saveSource = async (source: LeadSourceRecord, changes: Partial<LeadSourceRecord>) => {
    setBusyKey(source.slug);
    setError(null);
    setNotice(null);

    try {
      setSources(
        await telecallingApi.saveLeadSource({
          slug: source.slug,
          label: changes.label ?? source.label,
          isActive: changes.isActive ?? source.isActive,
          sortOrder: changes.sortOrder ?? source.sortOrder,
        }),
      );
      setNotice('Lead source saved.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not save the lead source.');
    } finally {
      setBusyKey(null);
    }
  };

  const addSource = async () => {
    const slug = newSource.slug.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const label = newSource.label.trim();

    if (!/^[a-z0-9_]{2,40}$/.test(slug)) {
      setError('Use lowercase letters, numbers and underscores for the source key.');
      return;
    }
    if (label.length < 2) {
      setError('Give the source a label.');
      return;
    }

    setBusyKey('new');
    setError(null);
    setNotice(null);

    try {
      const next = await telecallingApi.saveLeadSource({
        slug,
        label,
        isActive: true,
        // Placed at the end of the list; the order can be edited afterwards.
        sortOrder: (sources?.length ?? 0) * 10 + 100,
      });
      setSources(next);
      setNewSource({ slug: '', label: '' });
      setNotice(`Added "${label}".`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not add the lead source.');
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Renders the right control for a setting's value type.
   *
   * The values are JSON — a boolean, a number, or a small object — so this switches on
   * what came back rather than on a hard-coded map. A setting added on the server appears
   * here with a usable control and no frontend change.
   */
  const renderControl = (setting: SettingRecord) => {
    const busy = busyKey === setting.key;
    // A new value from the server (a save, or a re-read) or a refused save remounts the
    // input, so its uncontrolled text always starts from what is stored.
    const controlKey = `${setting.key}:${setting.updatedAt}:${revisions[setting.key] ?? 0}`;

    if (typeof setting.value === 'boolean') {
      return (
        <button
          type="button"
          className={setting.value ? 'btn btn--primary btn--sm' : 'btn btn--outline btn--sm'}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void saveSetting(setting.key, !setting.value)}
          aria-pressed={setting.value}
        >
          {busy ? <ButtonSpinner /> : null}
          {setting.value ? 'On' : 'Off'}
        </button>
      );
    }

    if (typeof setting.value === 'number') {
      return (
        <input
          key={controlKey}
          className="input input--sm"
          type="number"
          defaultValue={setting.value}
          disabled={busy}
          aria-busy={busy || undefined}
          style={{ maxWidth: '7rem' }}
          aria-label={setting.key}
          // Saved on blur rather than on every keystroke, which would write a row per
          // digit typed and log an audit entry for each.
          onBlur={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next) && next !== setting.value) {
              void saveSetting(setting.key, next);
            }
          }}
        />
      );
    }

    /*
     * A time of day gets the browser's time field, which can only hold a real time. The
     * value is still the 24-hour "HH:MM" string the server stores — a time input reports
     * its value that way whatever clock the browser displays.
     */
    if (isTimeSetting(setting)) {
      return (
        <span className="tc-setting-time">
          <input
            key={controlKey}
            className="input input--sm"
            type="time"
            step={60}
            required
            defaultValue={setting.value}
            disabled={busy}
            aria-busy={busy || undefined}
            aria-label={`${setting.key}, in IST`}
            onBlur={(event) => {
              const next = event.target.value;
              if (next === setting.value) return;
              if (!/^\d{2}:\d{2}$/.test(next)) {
                setNotice(null);
                setError('Choose a time, for example 08:00.');
                resetControl(setting.key);
                return;
              }
              void saveSetting(setting.key, next);
            }}
          />
          <span className="tc-muted">IST</span>
        </span>
      );
    }

    if (typeof setting.value === 'string') {
      return (
        <input
          key={controlKey}
          className="input input--sm"
          defaultValue={setting.value}
          disabled={busy}
          aria-busy={busy || undefined}
          style={{ maxWidth: '12rem' }}
          aria-label={setting.key}
          onBlur={(event) => {
            if (event.target.value !== setting.value) {
              void saveSetting(setting.key, event.target.value);
            }
          }}
        />
      );
    }

    /**
     * Structured values are shown read-only.
     *
     * A JSON textarea in an admin screen is a way to write invalid configuration
     * confidently. When a structured setting needs editing it deserves its own form.
     */
    return <code className="tc-code">{JSON.stringify(setting.value)}</code>;
  };

  /* ------------------------------------------------------------------- render */

  /** A tab whose first load failed: the error is in the alert above, this offers the way back. */
  const notLoaded =
    denied === tab ? null : (
      <EmptyPanel
        title="Nothing to show"
        message="This section could not be loaded."
        actionLabel="Try again"
        onAction={() => void load()}
      />
    );

  /** The current tab's content: a skeleton on its first load, dimmed in place on a refetch. */
  const renderTab = () => {
    if (tab === 'report') {
      return (
        <DailyReportSection
          onUnauthorized={onUnauthorized}
          page={page}
          onPageChange={setPage}
          onOpenSettings={() => chooseTab('settings')}
          refreshToken={reportRefresh}
        />
      );
    }

    if (tab === 'settings') {
      if (!settings) return loading ? <TableSkeleton rows={6} /> : notLoaded;
      if (settings.length === 0) {
        return <EmptyPanel title="No settings" message="Run the database migrations to seed them." />;
      }

      return (
        <LoadingOverlay busy={loading} label="Updating…">
          <DataTable
            rows={settings}
            rowKey={(setting) => setting.key}
            minWidth="46rem"
            caption="System settings and when each was last changed"
            columns={[
              {
                key: 'setting',
                header: 'Setting',
                render: (setting) => (
                  <CellStack
                    primary={<span className="tc-mono">{setting.key}</span>}
                    secondary={SETTING_HELP[setting.key] ?? setting.description ?? ''}
                  />
                ),
              },
              {
                key: 'value',
                header: 'Value',
                width: '16rem',
                render: (setting) => renderControl(setting),
              },
              {
                key: 'updated',
                header: 'Last changed',
                width: '11rem',
                nowrap: true,
                render: (setting) => formatDateTime(setting.updatedAt),
              },
            ]}
          />
        </LoadingOverlay>
      );
    }

    if (tab === 'sources') {
      if (!sources) return loading ? <TableSkeleton rows={6} /> : notLoaded;

      return (
        <>
          <div className="tc-card tc-form">
            <h3 className="tc-section-title" style={{ marginTop: 0 }}>
              Add a lead source
            </h3>
            <div className="tc-form__grid">
              <div className="field">
                <label className="field__label" htmlFor="tc-src-label">
                  Label
                </label>
                <input
                  id="tc-src-label"
                  className="input"
                  value={newSource.label}
                  placeholder="e.g. Trade fair"
                  onChange={(event) =>
                    setNewSource((current) => ({
                      label: event.target.value,
                      // The key is derived from the label so an admin never has to invent
                      // a slug, but stays editable for an existing convention.
                      slug: current.slug || event.target.value.trim().toLowerCase().replace(/[\s-]+/g, '_'),
                    }))
                  }
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="tc-src-slug">
                  Key
                </label>
                <input
                  id="tc-src-slug"
                  className="input"
                  value={newSource.slug}
                  placeholder="trade_fair"
                  onChange={(event) => setNewSource((current) => ({ ...current, slug: event.target.value }))}
                />
                <p className="field__hint">
                  Stored on every lead from this source. It cannot be changed afterwards without rewriting
                  history, so the label is what you edit later.
                </p>
              </div>
            </div>

            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void addSource()}
              disabled={busyKey === 'new'}
              aria-busy={busyKey === 'new' || undefined}
            >
              {busyKey === 'new' ? <ButtonSpinner /> : null}
              Add source
            </button>
          </div>

          {sources.length === 0 ? (
            <EmptyPanel title="No lead sources" message="Run the migrations to seed the defaults." />
          ) : (
            <LoadingOverlay busy={loading} label="Updating…">
              <DataTable
                rows={sources}
                rowKey={(source) => source.slug}
                minWidth="44rem"
                caption="Lead sources and whether each is offered in the mobile app"
                columns={[
                  {
                    key: 'slug',
                    header: 'Key',
                    width: '11rem',
                    render: (source) => <span className="tc-mono">{source.slug}</span>,
                  },
                  {
                    key: 'label',
                    header: 'Label',
                    render: (source) => (
                      <input
                        className="input input--sm"
                        defaultValue={source.label}
                        disabled={busyKey === source.slug}
                        aria-label={`Label for ${source.slug}`}
                        onBlur={(event) => {
                          if (event.target.value.trim() !== source.label) {
                            void saveSource(source, { label: event.target.value.trim() });
                          }
                        }}
                      />
                    ),
                  },
                  {
                    key: 'active',
                    header: 'Shown in the app',
                    width: '14rem',
                    render: (source) => (
                      <CellStack
                        primary={
                          <button
                            type="button"
                            className={source.isActive ? 'btn btn--primary btn--sm' : 'btn btn--outline btn--sm'}
                            disabled={busyKey === source.slug}
                            aria-busy={busyKey === source.slug || undefined}
                            aria-pressed={source.isActive}
                            onClick={() => void saveSource(source, { isActive: !source.isActive })}
                          >
                            {busyKey === source.slug ? <ButtonSpinner /> : null}
                            {source.isActive ? 'Active' : 'Hidden'}
                          </button>
                        }
                        /*
                          Retiring a source never rewrites existing leads — their history
                          stays accurate. It only stops appearing as an option for new ones.
                        */
                        secondary={source.isActive ? null : 'Existing leads keep this source'}
                      />
                    ),
                  },
                ]}
              />
            </LoadingOverlay>
          )}
        </>
      );
    }

    if (!audit) return loading ? <TableSkeleton rows={6} /> : notLoaded;
    if (audit.items.length === 0) {
      return (
        <EmptyPanel
          title="Nothing logged yet"
          message="Lead creation, assignment, employee changes and settings changes are recorded here."
        />
      );
    }

    return (
      <LoadingOverlay busy={loading} label="Updating…">
        <div>
          <DataTable
            rows={audit.items}
            rowKey={(entry) => entry.id}
            minWidth="48rem"
            caption="Audit trail of administrative actions"
            columns={[
              {
                key: 'when',
                header: 'When',
                width: '11rem',
                nowrap: true,
                render: (entry) => formatDateTime(entry.createdAt),
              },
              {
                key: 'who',
                header: 'Who',
                width: '14rem',
                render: (entry) => (
                  <CellStack
                    /*
                      The actor's name and email are stored on the row, so this still
                      reads correctly after the account has been deleted.
                    */
                    primary={entry.actorLabel ?? <span className="tc-muted">System</span>}
                  >
                    <Tag>{entry.actorType}</Tag>
                  </CellStack>
                ),
              },
              {
                key: 'what',
                header: 'What',
                render: (entry) => (
                  <CellStack primary={entry.summary} secondary={<span className="tc-mono">{entry.action}</span>} />
                ),
              },
            ]}
          />

          <Pager
            page={audit.page}
            totalPages={audit.totalPages}
            total={audit.total}
            noun="entry"
            nounPlural="entries"
            busy={loading}
            onChange={setPage}
          />
        </div>
      </LoadingOverlay>
    );
  };

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Configuration section">
          {TABS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === option}
              onClick={() => chooseTab(option)}
            >
              {TAB_LABELS[option]}
            </button>
          ))}
        </div>

        <button type="button" className="btn btn--outline" onClick={refresh}>
          <Icon name="refresh" size={16} />
          Refresh
        </button>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {renderTab()}
    </>
  );
}
