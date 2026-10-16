'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { hrRequestsApi, type HrRequest } from '@/lib/hrRequests';
import { readUrlId, useUrlParam } from './leave/shared';
import { RequestDetail } from './requests/RequestDetail';
import { RequestQueue } from './requests/RequestQueue';

/**
 * HR requests: the queue of things employees have asked HR for, and one request at a
 * time — its conversation, the decision, and any document shared in answer.
 *
 * The open request replaces the queue on screen, but the queue stays MOUNTED (hidden)
 * underneath, the way the telecalling Lead View sits over its list: Back returns to the
 * same filters, page and scroll, and the queue re-reads its page because the request may
 * have moved status. The open request is kept in the address (`?request=<id>`), so a
 * link to it can be shared and a refresh reopens it.
 *
 * Reads are open to supervisors; replying, moving a request and sharing documents are
 * administrator-only.
 */

export function HrRequestsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [openId, setOpenId] = useState<number | null>(() => readUrlId('request'));
  const [counts, setCounts] = useState<{ open: number; inProgress: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [changed, setChanged] = useState(false);
  /** What opened the request, so focus can go back to it. */
  const opener = useRef<HTMLElement | null>(null);

  useUrlParam('request', openId === null ? null : String(openId));

  const refreshCounts = useCallback(async () => {
    try {
      setCounts(await hrRequestsApi.counts());
    } catch {
      // The badge is advice; the queue works without it.
      setCounts(null);
    }
  }, []);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  const open = useCallback((request: HrRequest, from: HTMLElement | null) => {
    opener.current = from;
    setChanged(false);
    setOpenId(request.id);
    window.scrollTo({ top: 0 });
  }, []);

  const back = useCallback(() => {
    setOpenId(null);
    if (changed) setRefreshKey((value) => value + 1);
    setChanged(false);
    window.setTimeout(() => {
      if (opener.current?.isConnected) opener.current.focus();
    }, 0);
  }, [changed]);

  const handleChanged = useCallback(() => {
    setChanged(true);
    void refreshCounts();
  }, [refreshCounts]);

  return (
    <>
      <div hidden={openId !== null}>
        <RequestQueue
          counts={counts}
          refreshKey={refreshKey}
          onOpen={open}
          onUnauthorized={onUnauthorized}
        />
      </div>

      {openId !== null ? (
        <RequestDetail
          key={openId}
          requestId={openId}
          onBack={back}
          onChanged={handleChanged}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
