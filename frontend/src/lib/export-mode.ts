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
