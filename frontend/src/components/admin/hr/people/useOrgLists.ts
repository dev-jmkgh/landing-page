'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { peopleApi, type Department, type Designation } from '@/lib/hr';

/**
 * Departments and designations, for the filters and pickers that name them.
 *
 * Both lists are bounded (an organisation has tens, not thousands) and the server returns
 * them whole by design, so loading them once per screen is not the whole-list fetch the
 * paging rule forbids. A failure leaves them `null` and the selects show what is known —
 * the directory itself still works, it just cannot be narrowed by department.
 */
export function useOrgLists(onUnauthorized: () => void) {
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [designations, setDesignations] = useState<Designation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [d, g] = await Promise.all([
          peopleApi.listDepartments(signal),
          peopleApi.listDesignations(signal),
        ]);
        setDepartments(d);
        setDesignations(g);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setError('Departments and designations could not be loaded, so those filters are empty.');
      }
    },
    [onUnauthorized],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return { departments, designations, error, reload: load };
}

/**
 * The entries a form may offer: the active ones, plus whatever the record holds now even
 * if it has since been switched off — the server keeps people in a retired department
 * but refuses to put anybody new into one.
 */
export function selectable<T extends { id: number; isActive: boolean }>(
  items: T[] | null,
  currentId: number | null,
): T[] {
  return (items ?? []).filter((item) => item.isActive || item.id === currentId);
}
