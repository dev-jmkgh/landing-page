'use client';

import { useCallback, useEffect, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  attendanceAdminApi,
  minutesAsHours,
  type Shift,
  type WorkLocation,
} from '@/lib/hr';
import { EmptyPanel, Tag, TableSkeleton } from '../telecalling/shared';
import { SitePicker } from './SitePicker';

/**
 * Work locations and shifts — the two things attendance measures against.
 *
 * Both on one screen because neither is big enough to deserve its own, and because
 * they are configured together: a site is only useful once somebody is assigned to it
 * on a shift, and the sequence an administrator follows is site → shift → assign.
 *
 * NOTHING HERE IS SEEDED WITH REAL COORDINATES, and that is deliberate. A made-up
 * geofence would refuse every employee at a real office, so the site has to be entered
 * by somebody who knows where the building is.
 */

const BLANK_SITE = { name: '', address: '', latitude: '', longitude: '', radiusMetres: '150' };
const BLANK_SHIFT = {
  name: '',
  startsAt: '09:00',
  endsAt: '18:00',
  breakMinutes: '60',
  graceMinutes: '10',
  halfDayMinutes: '240',
};

export function HrWorkplacesPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [locations, setLocations] = useState<WorkLocation[] | null>(null);
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [siteForm, setSiteForm] = useState(BLANK_SITE);
  const [shiftForm, setShiftForm] = useState(BLANK_SHIFT);
  const [showSite, setShowSite] = useState(false);
  const [showShift, setShowShift] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [l, s] = await Promise.all([
        attendanceAdminApi.listLocations(),
        attendanceAdminApi.listShifts(),
      ]);
      setLocations(l);
      setShifts(s);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load workplaces.');
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const createSite = async () => {
    setError(null);
    setNotice(null);

    const latitude = Number(siteForm.latitude);
    const longitude = Number(siteForm.longitude);

    /*
     * Checked here because an empty string coerces to 0, and (0, 0) is a real place in
     * the Gulf of Guinea. Left to the server it would be stored as a valid coordinate
     * and every check-in would be measured against the wrong hemisphere.
     */
    if (!siteForm.latitude.trim() || !siteForm.longitude.trim()) {
      setError('Enter both a latitude and a longitude.');
      return;
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setError('Latitude and longitude must be numbers, like 9.9312 and 76.2673.');
      return;
    }

    setSaving(true);

    try {
      await attendanceAdminApi.createLocation({
        name: siteForm.name.trim(),
        address: siteForm.address.trim() || null,
        latitude,
        longitude,
        radiusMetres: Number(siteForm.radiusMetres),
      });
      setNotice(`${siteForm.name.trim()} added.`);
      setSiteForm(BLANK_SITE);
      setShowSite(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save that site.');
    } finally {
      setSaving(false);
    }
  };

  const createShift = async () => {
    setError(null);
    setNotice(null);
    setSaving(true);

    try {
      await attendanceAdminApi.createShift({
        name: shiftForm.name.trim(),
        startsAt: shiftForm.startsAt,
        endsAt: shiftForm.endsAt,
        breakMinutes: Number(shiftForm.breakMinutes),
        graceMinutes: Number(shiftForm.graceMinutes),
        halfDayMinutes: Number(shiftForm.halfDayMinutes),
      });
      setNotice(`${shiftForm.name.trim()} added.`);
      setShiftForm(BLANK_SHIFT);
      setShowShift(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save that shift.');
    } finally {
      setSaving(false);
    }
  };

  const toggleSite = async (site: WorkLocation) => {
    try {
      await attendanceAdminApi.updateLocation(site.id, { isActive: !site.isActive });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update that site.');
    }
  };

  return (
    <>
      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {/* ------------------------------------------------------------ sites */}
      <div className="admin-toolbar">
        <h3 className="tc-section-title" style={{ margin: 0 }}>
          Work locations
        </h3>
        <div className="admin-filters">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setShowSite((value) => !value)}
          >
            <Icon name="pin" size={16} />
            {showSite ? 'Cancel' : 'Add a site'}
          </button>
        </div>
      </div>

      {showSite ? (
        <div className="tc-card tc-form">
          <div className="tc-form__grid">
            <div className="field">
              <label className="field__label" htmlFor="hr-site-name">
                Name
              </label>
              <input
                id="hr-site-name"
                className="input"
                value={siteForm.name}
                placeholder="Kochi head office"
                onChange={(e) => setSiteForm({ ...siteForm, name: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-site-address">
                Address (optional)
              </label>
              <input
                id="hr-site-address"
                className="input"
                value={siteForm.address}
                onChange={(e) => setSiteForm({ ...siteForm, address: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-site-lat">
                Latitude
              </label>
              <input
                id="hr-site-lat"
                className="input"
                inputMode="decimal"
                value={siteForm.latitude}
                placeholder="9.9312"
                onChange={(e) => setSiteForm({ ...siteForm, latitude: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-site-lng">
                Longitude
              </label>
              <input
                id="hr-site-lng"
                className="input"
                inputMode="decimal"
                value={siteForm.longitude}
                placeholder="76.2673"
                onChange={(e) => setSiteForm({ ...siteForm, longitude: e.target.value })}
              />
              <p className="field__hint">
                {/*
                  Named explicitly because the commonest way to get a geofence wrong is
                  to paste a pair in the other order — which lands the site in the wrong
                  country and refuses everyone, with no clue as to why.
                */}
                From Google Maps: right-click the building and copy the pair. Latitude
                first.
              </p>
            </div>

            {/*
              The map sits between the coordinates and the radius because it writes
              the first and illustrates the second. It renders nothing when no Maps
              key is configured, and the fields below keep working on their own.
            */}
            <SitePicker
              latitude={siteForm.latitude}
              longitude={siteForm.longitude}
              radiusMetres={siteForm.radiusMetres}
              onPick={(lat, lng) =>
                setSiteForm((form) => ({
                  ...form,
                  latitude: String(lat),
                  longitude: String(lng),
                }))
              }
            />

            <div className="field">
              <label className="field__label" htmlFor="hr-site-radius">
                Radius (metres)
              </label>
              <input
                id="hr-site-radius"
                className="input"
                inputMode="numeric"
                value={siteForm.radiusMetres}
                onChange={(e) => setSiteForm({ ...siteForm, radiusMetres: e.target.value })}
              />
              <p className="field__hint">
                150m suits most offices. Tighter than about 50m starts refusing people
                who are genuinely inside the building, because phone GPS is not that
                precise.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void createSite()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Add site'}
          </button>
        </div>
      ) : null}

      {loading && !locations ? (
        <TableSkeleton rows={3} />
      ) : !locations || locations.length === 0 ? (
        <EmptyPanel
          title="No work locations"
          message="Add the sites your staff check in from. Office workers cannot check in until they are assigned one."
          actionLabel="Add a site"
          onAction={() => setShowSite(true)}
        />
      ) : (
        <DataTable
          rows={locations}
          rowKey={(row) => row.id}
          minWidth="52rem"
          caption="Work locations"
          columns={[
            {
              key: 'name',
              header: 'Site',
              render: (row) => <CellStack primary={row.name} secondary={row.address ?? undefined} />,
            },
            {
              key: 'coords',
              header: 'Coordinates',
              width: '15rem',
              nowrap: true,
              render: (row) => (
                <span className="tc-mono tc-muted">
                  {row.latitude.toFixed(5)}, {row.longitude.toFixed(5)}
                </span>
              ),
            },
            {
              key: 'radius',
              header: 'Radius',
              width: '7rem',
              align: 'end',
              nowrap: true,
              render: (row) => `${row.radiusMetres}m`,
            },
            {
              key: 'state',
              header: 'State',
              width: '7rem',
              nowrap: true,
              render: (row) =>
                row.isActive ? <Tag tone="good">Active</Tag> : <Tag tone="bad">Off</Tag>,
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              width: '8rem',
              nowrap: true,
              render: (row) => (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void toggleSite(row)}
                >
                  {row.isActive ? 'Switch off' : 'Switch on'}
                </button>
              ),
            },
          ]}
        />
      )}

      {/* ----------------------------------------------------------- shifts */}
      <div className="admin-toolbar" style={{ marginTop: '2rem' }}>
        <h3 className="tc-section-title" style={{ margin: 0 }}>
          Shifts
        </h3>
        <div className="admin-filters">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setShowShift((value) => !value)}
          >
            <Icon name="clock" size={16} />
            {showShift ? 'Cancel' : 'Add a shift'}
          </button>
        </div>
      </div>

      {showShift ? (
        <div className="tc-card tc-form">
          <div className="tc-form__grid">
            <div className="field">
              <label className="field__label" htmlFor="hr-shift-name">
                Name
              </label>
              <input
                id="hr-shift-name"
                className="input"
                value={shiftForm.name}
                placeholder="Morning shift"
                onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-shift-start">
                Starts
              </label>
              <input
                id="hr-shift-start"
                className="input"
                type="time"
                value={shiftForm.startsAt}
                onChange={(e) => setShiftForm({ ...shiftForm, startsAt: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-shift-end">
                Ends
              </label>
              <input
                id="hr-shift-end"
                className="input"
                type="time"
                value={shiftForm.endsAt}
                onChange={(e) => setShiftForm({ ...shiftForm, endsAt: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-shift-grace">
                Grace (minutes)
              </label>
              <input
                id="hr-shift-grace"
                className="input"
                inputMode="numeric"
                value={shiftForm.graceMinutes}
                onChange={(e) => setShiftForm({ ...shiftForm, graceMinutes: e.target.value })}
              />
              <p className="field__hint">
                Minutes after the start that are still not counted late. Zero marks
                09:00:30 as late, which makes the figure noise.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-shift-break">
                Break (minutes)
              </label>
              <input
                id="hr-shift-break"
                className="input"
                inputMode="numeric"
                value={shiftForm.breakMinutes}
                onChange={(e) => setShiftForm({ ...shiftForm, breakMinutes: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="hr-shift-half">
                Half day under (minutes)
              </label>
              <input
                id="hr-shift-half"
                className="input"
                inputMode="numeric"
                value={shiftForm.halfDayMinutes}
                onChange={(e) => setShiftForm({ ...shiftForm, halfDayMinutes: e.target.value })}
              />
            </div>
          </div>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void createShift()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Add shift'}
          </button>
        </div>
      ) : null}

      {loading && !shifts ? (
        <TableSkeleton rows={2} />
      ) : !shifts || shifts.length === 0 ? (
        <EmptyPanel title="No shifts" message="Add a shift so lateness has something to measure against." />
      ) : (
        <DataTable
          rows={shifts}
          rowKey={(row) => row.id}
          minWidth="48rem"
          caption="Shifts"
          columns={[
            { key: 'name', header: 'Shift', render: (row) => row.name },
            {
              key: 'hours',
              header: 'Hours',
              width: '11rem',
              nowrap: true,
              render: (row) => `${row.startsAt} – ${row.endsAt}`,
            },
            {
              key: 'grace',
              header: 'Grace',
              width: '7rem',
              align: 'end',
              nowrap: true,
              render: (row) => `${row.graceMinutes}m`,
            },
            {
              key: 'break',
              header: 'Break',
              width: '7rem',
              align: 'end',
              nowrap: true,
              render: (row) => minutesAsHours(row.breakMinutes),
            },
            {
              key: 'half',
              header: 'Half day under',
              width: '10rem',
              align: 'end',
              nowrap: true,
              render: (row) => minutesAsHours(row.halfDayMinutes),
            },
          ]}
        />
      )}
    </>
  );
}
