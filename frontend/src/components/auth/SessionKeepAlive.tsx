'use client';

import { useEffect, useRef } from 'react';

import { refreshAuthSession } from '@/lib/api-client';

const CHECK_INTERVAL_MS = 60 * 1000;
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const ACTIVITY_WINDOW_MS = 20 * 60 * 1000;
const ACTIVITY_THROTTLE_MS = 5 * 1000;

export function SessionKeepAlive() {
  const lastActivityAtRef = useRef(Date.now());
  const lastRefreshAtRef = useRef(Date.now());
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    const markActivity = () => {
      const now = Date.now();
      if (now - lastActivityAtRef.current >= ACTIVITY_THROTTLE_MS) {
        lastActivityAtRef.current = now;
      }
    };

    const maybeRefresh = async () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible') return;
      if (refreshInFlightRef.current) return;
      if (now - lastActivityAtRef.current >= ACTIVITY_WINDOW_MS) return;
      if (now - lastRefreshAtRef.current < REFRESH_INTERVAL_MS) return;

      refreshInFlightRef.current = true;
      const refreshed = await refreshAuthSession({ redirectOnFailure: false });
      refreshInFlightRef.current = false;

      if (refreshed) {
        lastRefreshAtRef.current = Date.now();
      }
    };

    const handleVisible = () => {
      if (document.visibilityState === 'visible') {
        markActivity();
        void maybeRefresh();
      }
    };

    const activityEvents: Array<keyof WindowEventMap> = [
      'pointerdown',
      'keydown',
      'scroll',
      'mousemove',
      'touchstart',
      'focus',
    ];

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, markActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', handleVisible);

    const intervalId = window.setInterval(() => {
      void maybeRefresh();
    }, CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, markActivity);
      }
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, []);

  return null;
}
