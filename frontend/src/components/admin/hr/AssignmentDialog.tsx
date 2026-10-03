'use client';

import { useEffect, useState } from 'react';
import { FormAlert } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import {
  WORK_MODES,
  WORK_MODE_LABELS,
  attendanceAdminApi,
  type HrEmployee,
  type Shift,
  type WorkLocation,
  type WorkMode,
} from '@/lib/hr';

/**
 * Sets the attendance rule for one employee: how they work, from where, on what shift.
 *
 * THIS IS WHERE THE GEOFENCE IS TURNED ON. Creating a site on the Workplaces tab only
 * describes a place; until somebody is set to `office` AT that site, nothing is
 * enforced for them. The two halves were split across a screen and an API endpoint
 * with no UI, which meant the rule could be defined but never applied.
 *
 * The modes are offered as radio buttons rather than a dropdown because the choice
 * changes what the rest of the form means — picking `office` makes the site field
 * required, and a closed dropdown hides the thing that caused that.
 */
export function AssignmentDialog({
  employee,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  employee: HrEmployee;
  onClose: () => void;
  onSaved: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const [mode, setMode] = useState<WorkMode>(employee.workMode);
  const [locationId, setLocationId] = useState<string>(
    employee.workLocationId ? String(employee.workLocationId) : '',
  );
  const [shiftId, setShiftId] = useState<string>(
    employee.shiftId ? String(employee.shiftId) : '',
  );

  const [locations, setLocations] = useState<WorkLocation[] | null>(null);
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [l, s] = await Promise.all([
          attendanceAdminApi.listLocations(),
          attendanceAdminApi.listShifts(),
        ]);
        if (cancelled) return;
        setLocations(l);
        setShifts(s);
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
        setError('Could not load sites and shifts.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  /*
   * Only ACTIVE sites are offered. A switched-off site stops being geofenced on the
   * server, so assigning somebody to one would silently give them an unrestricted
   * check-in — the opposite of what picking a site looks like it does.
   */
  const selectableSites = (locations ?? []).filter(
    (site) => site.isActive || site.id === employee.workLocationId,
  );

  const save = async () => {
    setError(null);

    // Mirrors the server, which refuses the same combination — but says so before the
    // round trip, next to the field that has to change.
    if (mode === 'office' && !locationId) {
      setError(
        'An office worker needs a site, otherwise they cannot check in at all. Pick one, or set them to remote or field.',
      );
      return;
    }

    setSaving(true);

    try {
      await attendanceAdminApi.assign(employee.id, {
        workMode: mode,
        workLocationId: locationId ? Number(locationId) : null,
        shiftId: shiftId ? Number(shiftId) : null,
      });

      onSaved(
        mode === 'office'
          ? `${employee.name} checks in at ${
              selectableSites.find((s) => String(s.id) === locationId)?.name ?? 'the site'
            }.`
          : `${employee.name} is set to ${WORK_MODE_LABELS[mode].toLowerCase()} — no location check.`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError && caught.status === 403) {
        setError('Only an administrator can change an assignment.');
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const chosenSite = selectableSites.find((s) => String(s.id) === locationId);

  return (
    <div className="tc-card tc-form" role="group" aria-label={`Attendance rule for ${employee.name}`}>
      <h3 className="tc-section-title" style={{ marginTop: 0 }}>
        Attendance rule — {employee.name}
      </h3>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      <div className="field">
        <span className="field__label">How they work</span>
        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
          {WORK_MODES.map((value) => (
            <label key={value} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input
                type="radio"
                name={`work-mode-${employee.id}`}
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              <span>{WORK_MODE_LABELS[value]}</span>
            </label>
          ))}
        </div>
        <p className="field__hint">
          {mode === 'office'
            ? 'Check-in is refused outside the site’s radius.'
            : 'No location check. The coordinates are still recorded, so you can see where a punch came from.'}
        </p>
      </div>

      <div className="tc-form__grid">
        <div className="field">
          <label className="field__label" htmlFor={`hr-assign-site-${employee.id}`}>
            Work location {mode === 'office' ? '' : '(optional)'}
          </label>
          <select
            id={`hr-assign-site-${employee.id}`}
            className="select"
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          >
            <option value="">No site</option>
            {selectableSites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name} ({site.radiusMetres}m){site.isActive ? '' : ' — switched off'}
              </option>
            ))}
          </select>
          {locations !== null && selectableSites.length === 0 ? (
            <p className="field__hint">
              {/*
                The dead end worth naming: there is nothing to pick, and the fix is on
                another tab. Without this the select is simply empty and the
                administrator has no idea why.
              */}
              No sites yet. Add one on the Workplaces tab first.
            </p>
          ) : chosenSite ? (
            <p className="field__hint">
              {chosenSite.latitude.toFixed(5)}, {chosenSite.longitude.toFixed(5)} · a check-in is
              accepted within {chosenSite.radiusMetres}m
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`hr-assign-shift-${employee.id}`}>
            Shift (optional)
          </label>
          <select
            id={`hr-assign-shift-${employee.id}`}
            className="select"
            value={shiftId}
            onChange={(event) => setShiftId(event.target.value)}
          >
            <option value="">No shift</option>
            {(shifts ?? []).map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.name} ({shift.startsAt}–{shift.endsAt})
              </option>
            ))}
          </select>
          <p className="field__hint">
            {/* Says what is lost rather than what is gained — nothing breaks without a
                shift, but lateness stops being measurable, which is not obvious. */}
            Without a shift there is nothing to measure lateness against, so nobody is
            ever marked late.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
