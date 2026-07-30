'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardApi, type DashboardEditLock } from '@/lib/api/dashboards';

export type DashboardEditor = {
  user_key: string;
  name: string;
  email: string;
  seconds_ago: number;
  editing_chart_id: number | null;
  editing_page_id: string | null;
  is_owner: boolean;
};

export type DashboardPageHolders = Record<string, { holder_key: string; holder_name: string | null }>;

/**
 * Phase-B17/B19 — editor presence + per-page co-edit rights for the dashboard
 * Build page. While `enabled`, heartbeats every 20s (and immediately when the
 * focused tile OR page changes) and exposes:
 *  - `editors`: the OTHER editors active right now + which tile/page each is on
 *    (Google-Sheets-style cursors).
 *  - `lock`: the caller's edit-right for their CURRENT page under owner-priority
 *    — the owner holds whatever page they're on; a non-owner on that page is
 *    view-only until they request edit and the owner approves; on a page with no
 *    owner present a first-come soft-lock picks one holder among non-owners.
 *  - `pageHolders`: who holds each page (for badging).
 *  - `requestEdit` / `respond`: the request→approve handshake.
 * Best-effort; backend TTL clears stale editors/locks/grants.
 */
export function useDashboardPresence(
  dashboardId: number | null | undefined,
  enabled: boolean,
  editingChartId: number | null,
  editingPageId: string | null,
) {
  const [editors, setEditors] = useState<DashboardEditor[]>([]);
  const [lock, setLock] = useState<DashboardEditLock | null>(null);
  const [pageHolders, setPageHolders] = useState<DashboardPageHolders>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // hold the latest focused tile/page so the interval beat reports current values
  const chartRef = useRef<number | null>(editingChartId);
  chartRef.current = editingChartId;
  const pageRef = useRef<string | null>(editingPageId);
  pageRef.current = editingPageId;

  const beat = useCallback(async (id: number) => {
    try {
      const res = await dashboardApi.editingHeartbeat(id, chartRef.current, pageRef.current);
      setEditors(Array.isArray(res.editors) ? res.editors : []);
      setLock(res.lock ?? null);
      setPageHolders(res.page_holders ?? {});
    } catch {
      /* presence is best-effort */
    }
  }, []);

  // periodic heartbeat while enabled
  useEffect(() => {
    if (!enabled || !dashboardId) {
      setEditors([]);
      setLock(null);
      setPageHolders({});
      return;
    }
    beat(dashboardId);
    timerRef.current = setInterval(() => beat(dashboardId), 20_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      dashboardApi.editingLeave(dashboardId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId, enabled]);

  // beat immediately when the user moves to a different tile OR page (snappy)
  useEffect(() => {
    if (enabled && dashboardId) beat(dashboardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingChartId, editingPageId]);

  const requestEdit = useCallback(async (pageId: string) => {
    if (!dashboardId) return;
    try {
      const res = await dashboardApi.editingRequestEdit(dashboardId, pageId);
      if (res?.lock) setLock(res.lock);
    } catch {
      /* best-effort */
    }
  }, [dashboardId]);

  const respond = useCallback(async (pageId: string, requesterKey: string, approve: boolean) => {
    if (!dashboardId) return;
    try {
      const res = await dashboardApi.editingRespond(dashboardId, pageId, requesterKey, approve);
      if (res?.lock) setLock(res.lock);
      // re-beat so the requester's client picks up the grant quickly
      beat(dashboardId);
    } catch {
      /* best-effort */
    }
  }, [dashboardId, beat]);

  return { editors, lock, pageHolders, requestEdit, respond };
}
