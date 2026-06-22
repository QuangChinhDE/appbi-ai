'use client';

import { useEffect } from 'react';

/**
 * Registers the mini-app service worker. Rendered only on the public runtime
 * surfaces (launcher `/m` + `/ws/...`) so the SW lifecycle is tied to them.
 * No-ops on browsers without SW support or when not served over a secure
 * context (http LAN) — registration silently fails, app still works online.
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* secure-context required; ignore on plain-http LAN */
      });
    };
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });
  }, []);
  return null;
}
