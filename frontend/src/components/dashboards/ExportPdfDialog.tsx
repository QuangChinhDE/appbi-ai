'use client';

import React, { useState } from 'react';
import { X, FileDown, Loader2 } from 'lucide-react';
import type { PdfOrientation, PdfPageSize, PdfProgress } from '@/lib/export-pdf';
import { useI18n } from '@/providers/LanguageProvider';

export interface ExportPdfChoices {
  orientation: PdfOrientation;
  format: PdfPageSize;
  pageIds: string[];
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  pages: Array<{ id: string; name: string }>;
  isExporting: boolean;
  onExport: (choices: ExportPdfChoices) => void;
  /** Live progress while exporting (null when idle). */
  progress?: PdfProgress | null;
};

/** Phase-B22 — pre-export "custom layout" dialog: orientation, page size, and
 *  which dashboard pages to include. Shared by build / public / embed. */
export function ExportPdfDialog({ isOpen, onClose, pages, isExporting, onExport, progress }: Props) {
  const { t } = useI18n();
  const [orientation, setOrientation] = useState<PdfOrientation>('landscape');
  const [format, setFormat] = useState<PdfPageSize>('a4');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(pages.map((p) => p.id)));

  React.useEffect(() => {
    // re-seed selection when the page set changes (e.g. dialog opened later)
    setSelected(new Set(pages.map((p) => p.id)));
  }, [pages.map((p) => p.id).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const chosenIds = pages.map((p) => p.id).filter((id) => selected.has(id));
  const canExport = chosenIds.length > 0 && !isExporting;
  const pct = Math.max(0, Math.min(100, Math.round((progress?.ratio ?? 0) * 100)));

  const segBtn = (active: boolean) =>
    `flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active ? 'bg-brand text-white' : 'bg-surface-2 text-text-secondary hover:bg-surface-3'
    }`;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">{t('dashboards.exportPdf.title')}</h2>
          <button onClick={onClose} disabled={isExporting} className="text-text-tertiary hover:text-text-primary disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>
        {isExporting ? (
          /* Progress view — tells the user what's happening + how far along. */
          <div className="space-y-3 px-5 py-6">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              <span>{t('dashboards.exportPdf.exporting')}</span>
              <span className="ml-auto tabular-nums text-text-tertiary">{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="min-h-[2.5rem] text-[13px] leading-snug text-text-secondary">
              {progress?.message || t('dashboards.exportPdf.preparing')}
            </p>
            <p className="text-[11px] text-text-quaternary">
              {t('dashboards.exportPdf.progressHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-4 px-5 py-5">
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.exportPdf.orientation')}</div>
              <div className="flex gap-2">
                <button className={segBtn(orientation === 'landscape')} onClick={() => setOrientation('landscape')}>{t('dashboards.exportPdf.landscape')}</button>
                <button className={segBtn(orientation === 'portrait')} onClick={() => setOrientation('portrait')}>{t('dashboards.exportPdf.portrait')}</button>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.exportPdf.pageSize')}</div>
              <div className="flex gap-2">
                {(['a4', 'a3', 'letter'] as PdfPageSize[]).map((f) => (
                  <button key={f} className={segBtn(format === f)} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>
                ))}
              </div>
            </div>
            {pages.length > 1 && (
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.exportPdf.pages', { chosen: chosenIds.length, total: pages.length })}</div>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-[rgb(var(--border-line))] bg-surface-2/40 p-2">
                  {pages.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="accent-[rgb(var(--brand))]" />
                      <span className="truncate text-text-secondary">{p.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <p className="text-[11px] text-text-quaternary">
              {t('dashboards.exportPdf.tableHint')}
            </p>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] px-5 py-3">
          <button onClick={onClose} disabled={isExporting} className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-sm hover:bg-surface-3 disabled:opacity-40">{t('common.cancel')}</button>
          <button
            onClick={() => canExport && onExport({ orientation, format, pageIds: chosenIds })}
            disabled={!canExport}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            {isExporting ? t('dashboards.exportPdf.exportingPct', { pct }) : t('dashboards.exportPdf.title')}
          </button>
        </div>
      </div>
    </div>
  );
}
