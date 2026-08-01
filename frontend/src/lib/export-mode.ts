'use client';

import { createContext, useContext } from 'react';

/**
 * How the dashboard renders while a PDF export runs. Provided around the
 * captured DOM by each surface (build / public / embed).
 *
 *   false      — not exporting.
 *   'snapshot' — the DEFAULT export: one dashboard page becomes one sheet, so we
 *                only need the tiles to be RENDERED (lazy gating off). Tables
 *                keep their on-screen rows.
 *   'full'     — the "full data" export: tables additionally expand to EVERY row
 *                (no 200-cap, no inner scroll) and the report paginates as long
 *                as it needs to.
 *
 * The distinction matters for speed, which is the whole point of the snapshot
 * mode: expanding every table to thousands of rows is the single most expensive
 * thing an export does, and it is pure waste when the sheet is a scaled picture
 * of the page. Both modes still need lazy tiles forced on — otherwise an
 * off-screen chart is captured blank.
 */
export type ExportRenderMode = false | 'snapshot' | 'full';

export const ExportModeContext = createContext<ExportRenderMode>(false);

/** True while ANY export is running — use for "render now, don't wait for
 *  scroll" and "no enter animations" decisions. */
export function useExportMode(): boolean {
  return useContext(ExportModeContext) !== false;
}

/** True only for the full-data export — use for "show every row" decisions. */
export function useFullDataExportMode(): boolean {
  return useContext(ExportModeContext) === 'full';
}

/** Characters a filesystem genuinely refuses. Built with RegExp() from an
 *  escaped string so this source file never carries a raw control byte. */
const FILENAME_FORBIDDEN = new RegExp("[\\\\/:*?\"<>|]", 'g');

/**
 * Turn a report name into a download filename that is still READABLE.
 *
 * The old rule stripped everything outside `[a-zA-Z0-9_\-\s]`, which deletes
 * Vietnamese diacritics character by character: "Olist – Phân tích Toàn diện"
 * came down as "Olist  Phn tch Ton din.pdf" — a DA can't tell those files apart
 * in a downloads folder. Every modern browser/OS accepts Unicode filenames, so
 * keep the letters and only remove what a filesystem refuses, plus trailing
 * dots/spaces (Windows). Falls back to `fallback` if nothing usable is left.
 */
export function safePdfFilename(name: string | null | undefined, fallback: string): string {
  const cleaned = (name || '')
    .replace(FILENAME_FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * Show the finished PDF in a second browser tab as well as downloading it.
 *
 * Declared in `.env.example` as `NEXT_PUBLIC_PDF_PREVIEW_TAB`, default **false**
 * (DA feedback 2026-07-28: "chỉ cần ở màn báo cáo nhìn process và xong tải
 * thành pdf"). Watching progress on the report and getting a file is the whole
 * job — the extra tab only ever showed a `blob:…uuid` address, which reads like
 * a broken link to a business reader. Off, the export keeps the viewer on the
 * report and simply saves the file; nothing else about the flow changes.
 *
 * A deployment that wants the side-by-side preview back sets the variable to
 * `true` and rebuilds the frontend (NEXT_PUBLIC_* values are inlined at build
 * time, like every other flag in this app). The pre-opened-tab mechanism below
 * stays in the code either way: it must run inside the click, before any await,
 * or the popup blocker eats it — subtle enough not to re-derive later.
 */
export const PDF_PREVIEW_TAB_ENABLED =
  String(process.env.NEXT_PUBLIC_PDF_PREVIEW_TAB ?? 'false').toLowerCase() === 'true';

/**
 * Open a blank tab for the PDF preview. MUST be called synchronously inside the
 * export click handler (before any `await`) — a PDF export runs for several
 * seconds, and by the time it finishes the transient user activation is spent,
 * so `window.open` from there gets popup-blocked. We open the tab up-front while
 * the activation is still live, show a "generating…" placeholder, and the
 * exporter navigates it to the finished PDF. Lives here (a tiny static module)
 * rather than in the heavy, dynamically-imported `export-pdf` chunk so it's
 * available without awaiting that import.
 *
 * Returns null when the feature is switched off (the normal case today) or when
 * the popup was blocked — callers treat both the same way: download only.
 */
export function openPdfPreviewTab(): Window | null {
  if (!PDF_PREVIEW_TAB_ENABLED) return null;
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
