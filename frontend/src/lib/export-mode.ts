'use client';

import { createContext, useContext } from 'react';

/**
 * Phase-B22 — when true, dashboard tiles render in "export mode": tables show
 * ALL rows (no 200-cap, no inner scroll) and lazy tiles render immediately, so
 * the PDF exporter captures the full content. Provided around the captured DOM
 * by each surface (build / public / embed) while a PDF export runs.
 */
export const ExportModeContext = createContext(false);

export function useExportMode(): boolean {
  return useContext(ExportModeContext);
}

/**
 * Open a blank tab for the PDF preview. MUST be called synchronously inside the
 * export click handler (before any `await`) — a PDF export runs for several
 * seconds, and by the time it finishes the transient user activation is spent,
 * so `window.open` from there gets popup-blocked. We open the tab up-front while
 * the activation is still live, show a "generating…" placeholder, and the
 * exporter navigates it to the finished PDF. Lives here (a tiny static module)
 * rather than in the heavy, dynamically-imported `export-pdf` chunk so it's
 * available without awaiting that import. Returns null if the popup was blocked.
 */
export function openPdfPreviewTab(): Window | null {
  if (typeof window === 'undefined') return null;
  try {
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(
        '<!doctype html><html lang="vi"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<title>Đang tạo PDF…</title></head>' +
          '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
          'height:100vh;font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#475569;background:#f8fafc">' +
          '<div style="text-align:center"><div style="font-size:15px">Đang tạo PDF…</div>' +
          '<div style="font-size:13px;margin-top:6px;color:#94a3b8">Tab này sẽ hiển thị báo cáo khi tạo xong.</div>' +
          '</div></body></html>',
      );
      w.document.close();
    }
    return w;
  } catch {
    return null;
  }
}
