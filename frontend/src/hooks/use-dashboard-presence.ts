'use client';

import { useEffect, useRef, useState } from 'react';
import { dashboardApi } from '@/lib/api/dashboards';

export type DashboardEditor = {
  user_key: string;
  name: string;
  email: string;
  seconds_ago: number;
  editing_chart_id: number | null;
};

/**
 * Phase-B17 — editor presence for the dashboard Build page. While `enabled`,
 * heartbeats every 20s (and immediately when the focused tile changes) and
 * exposes the OTHER editors active right now + which tile each is editing, so
 * the UI can show "X is also editing" AND highlight the exact tile they're on
 * (Google-Sheets-style cursors). Best-effort; backend TTL clears stale editors.
 */
export function useDashboardPresence(
  dashboardId: number | null | undefined,
  enabled: boolean,
  editingChartId: number | null,
) {
  const [editors, setEditors] = useState<DashboardEditor[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // hold the latest focused tile so the interval beat reports the current value
  const chartRef = useRef<number | null>(editingChartId);
  chartRef.current = editingChartId;

  const beat = async (id: number) => {
    try {
      const res = await dashboardApi.editingHeartbeat(id, chartRef.current);
      setEditors(Array.isArray(res.editors) ? res.editors : []);
    } catch {
      /* presence is best-effort */
    }
  };

  // periodic heartbeat while enabled
  useEffect(() => {
    if (!enabled || !dashboardId) {
      setEditors([]);
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

  // beat immediately when the user moves to a different tile (snappy cursor)
  useEffect(() => {
    if (enabled && dashboardId) beat(dashboardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingChartId]);

  return editors;
}
