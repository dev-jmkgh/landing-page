'use client';

import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps, mapsAvailable } from '@/lib/googleMaps';

/**
 * Picks a work location by clicking it on a map.
 *
 * WHY THIS EXISTS
 *
 * The alternative is two text boxes, and the failure they invite is specific and
 * silent: latitude and longitude pasted in the wrong order. `76.2673, 9.9312` is a
 * perfectly valid coordinate — in Somalia — so nothing rejects it, the site saves, and
 * every employee at that office is refused next morning with "you are 4,000km away".
 * Clicking a building cannot produce that mistake.
 *
 * The circle is drawn at the chosen radius because the radius is the other thing
 * nobody can judge as a number. Seeing 150m cover the building and its car park, or
 * 50m fall short of the far entrance, is the whole decision.
 *
 * DEGRADES TO NOTHING. With no API key configured — or with Google unreachable — this
 * renders nothing at all and the coordinate fields beside it keep working. A map is an
 * easier way to enter a site, never the only way.
 */

/** Fallback centre when no site has been chosen yet: roughly the middle of Kerala. */
const DEFAULT_CENTRE = { lat: 10.0, lng: 76.3 };

type Props = {
  latitude: string;
  longitude: string;
  radiusMetres: string;
  onPick: (lat: number, lng: number) => void;
};

export function SitePicker({ latitude, longitude, radiusMetres, onPick }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const map = useRef<google.maps.Map | null>(null);
  const marker = useRef<google.maps.Marker | null>(null);
  const circle = useRef<google.maps.Circle | null>(null);

  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    mapsAvailable() ? 'loading' : 'unavailable',
  );

  /*
   * `onPick` is held in a ref so the map's click listener — attached exactly once —
   * always calls the current one. Putting it in the effect's dependencies instead
   * would tear down and rebuild the whole map on every keystroke in the form.
   */
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!mapsAvailable()) return;

    let cancelled = false;

    void loadGoogleMaps().then((ok) => {
      if (cancelled) return;
      if (!ok || !host.current) {
        setState('unavailable');
        return;
      }

      const centre =
        Number.isFinite(Number(latitude)) && latitude.trim()
          ? { lat: Number(latitude), lng: Number(longitude) }
          : DEFAULT_CENTRE;

      const instance = new google.maps.Map(host.current, {
        center: centre,
        zoom: latitude.trim() ? 17 : 11,
        mapTypeId: 'hybrid',
        streetViewControl: false,
        fullscreenControl: false,
        mapTypeControl: true,
      });

      instance.addListener('click', (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return;
        /*
         * Rounded to seven decimals to match the DECIMAL(10,7) column. Sending more
         * precision than the database can hold means the value read back differs from
         * the one just clicked, and the marker jumps on reload.
         */
        pick.current(
          Number(event.latLng.lat().toFixed(7)),
          Number(event.latLng.lng().toFixed(7)),
        );
      });

      map.current = instance;
      setState('ready');
    });

    return () => {
      cancelled = true;
    };
    // Mount only. The marker and circle follow the props in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Keep the marker and the radius circle in step with the form. */
  useEffect(() => {
    if (state !== 'ready' || !map.current) return;

    const lat = Number(latitude);
    const lng = Number(longitude);
    const radius = Number(radiusMetres);

    if (!latitude.trim() || !longitude.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      marker.current?.setMap(null);
      circle.current?.setMap(null);
      marker.current = null;
      circle.current = null;
      return;
    }

    const position = { lat, lng };

    if (!marker.current) {
      marker.current = new google.maps.Marker({ map: map.current, position });
    } else {
      marker.current.setPosition(position);
      marker.current.setMap(map.current);
    }

    if (!circle.current) {
      circle.current = new google.maps.Circle({
        map: map.current,
        center: position,
        radius: Number.isFinite(radius) ? radius : 150,
        strokeColor: '#0974B0',
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: '#0974B0',
        fillOpacity: 0.15,
      });
    } else {
      circle.current.setCenter(position);
      circle.current.setRadius(Number.isFinite(radius) ? radius : 150);
      circle.current.setMap(map.current);
    }

    map.current.panTo(position);
  }, [state, latitude, longitude, radiusMetres]);

  // No key, or Google could not be reached. The coordinate fields carry on alone.
  if (state === 'unavailable') return null;

  return (
    <div className="field" style={{ gridColumn: '1 / -1' }}>
      <span className="field__label">Pick the site on the map</span>
      <div
        ref={host}
        style={{
          height: '22rem',
          width: '100%',
          borderRadius: 'var(--radius-md, 8px)',
          border: '1px solid var(--line, #DFE3E8)',
          background: 'var(--surface-muted, #F4F5F7)',
        }}
        role="application"
        aria-label="Map for choosing the work location"
      />
      <p className="field__hint">
        {state === 'loading'
          ? 'Loading the map…'
          : 'Click the building. The circle shows the area a check-in will be accepted from.'}
      </p>
    </div>
  );
}
