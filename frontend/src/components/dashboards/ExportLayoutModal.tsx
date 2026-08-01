'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
import { X, Plus, Trash2, Wand2, AlertTriangle, FileDown, GripVertical, Layers, Magnet, Move } from 'lucide-react';
import { useI18n } from '@/providers/LanguageProvider';
import type { PdfOrientation, PdfPageSize } from '@/lib/export-pdf';
import { ChartSketchPreview } from './ChartSketchPreview';
import {
  SHEET_COLS,
  autoArrange,
  minTileSize,
  newSheetId,
  paperAspect,
  planFromDashboard,
  sheetRows,
  validatePlan,
  type ExportLayoutPlan,
  type PlanCandidate,
  type PlanSheet,
} from '@/lib/export-layout';

const ResponsiveGrid = WidthProvider(Responsive);

type Props = {
  isOpen: boolean;
  onClose: () => void;
  candidates: PlanCandidate[];
  /** Charts placed up-front (the pages the user ticked). The rest wait in the
   *  library, so charts from other pages can still be pulled in. */
  preplacedIds?: number[];
  pages?: Array<{ id: string; name?: string }>;
  dashboardCols?: number;
  format: PdfPageSize;
  orientation: PdfOrientation;
  /** Chart rows keyed by chart id — drives the live previews. */
  chartRows?: Record<number, unknown[] | undefined>;
  /** Load a page's chart data WITHOUT navigating the report to it. */
  onEnsurePageData?: (pageId: string) => Promise<void>;
  onExport: (plan: ExportLayoutPlan) => void;
};

/**
 * Lay out the export by hand — a small design surface, not a form.
 *
 * The screen is shaped like the tools people already use for this job: the
 * charts you can use on the left, ONE sheet in the middle at real paper
 * proportions, the other sheets as thumbnails on the right to switch to or drop
 * onto. Editing one sheet at a time is what makes dragging between sheets
 * possible at all — with every sheet stacked in a single scroller you had to
 * drag and scroll at the same time, which no browser handles well.
 *
 * Previews are drawn from the report's own data (ChartSketchPreview), not
 * screenshotted: screenshots needed the tile to be mounted, which meant walking
 * the report page by page and made opening this dialog take minutes.
 *
 * The arrangement drives ONE export. Nothing here writes to the dashboard.
 */
export function ExportLayoutModal({
  isOpen, onClose, candidates, preplacedIds, pages, dashboardCols = 36,
  format, orientation, chartRows, onEnsurePageData, onExport,
}: Props) {
  const { t } = useI18n();
  const rows = sheetRows(format, orientation);
  const aspect = paperAspect(format, orientation);

  const seedCandidates = useMemo(
    () => (preplacedIds && preplacedIds.length
      ? candidates.filter((c) => preplacedIds.includes(c.chartId))
      : candidates),
    [candidates, preplacedIds],
  );

  const seedSheets = useCallback(() => {
    const seedPages = (pages ?? []).filter((pg) => seedCandidates.some((c) => c.pageId === pg.id));
    if (seedPages.length && seedCandidates.some((c) => c.layout)) {
      return planFromDashboard(seedCandidates, seedPages, dashboardCols, format, orientation);
    }
    return autoArrange(seedCandidates, format, orientation);
  }, [seedCandidates, pages, dashboardCols, format, orientation]);

  const [sheets, setSheets] = useState<PlanSheet[]>(seedSheets);
  const [activeSheet, setActiveSheet] = useState(0);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  // Tidy (default) pushes tiles aside and settles them upward, so a sheet is
  // always printable; Free allows exact placement. Tidy is the default because
  // the usual ask is "make this look right", not "let me hand-place 20 boxes".
  const [tidyMode, setTidyMode] = useState(true);

  const seedKey = `${format}|${orientation}|${seedCandidates.map((c) => c.chartId).join(',')}`;
  const seededRef = useRef(seedKey);
  useEffect(() => {
    if (seededRef.current !== seedKey) {
      seededRef.current = seedKey;
      setSheets(seedSheets());
      setActiveSheet(0);
    }
  }, [seedKey, seedSheets]);

  // Fill the previews in the background. No page switching: the batch endpoint
  // answers for any page, which is exactly why this is fast.
  const [loadingData, setLoadingData] = useState(false);
  useEffect(() => {
    if (!isOpen || !onEnsurePageData) return;
    let cancelled = false;
    (async () => {
      setLoadingData(true);
      for (const pg of pages ?? []) {
        if (cancelled) break;
        try { await onEnsurePageData(pg.id); } catch { /* preview stays a placeholder */ }
      }
      if (!cancelled) setLoadingData(false);
    })();
    return () => { cancelled = true; };
  }, [isOpen, pages, onEnsurePageData]);

  const byId = useMemo(() => new Map(candidates.map((c) => [c.chartId, c])), [candidates]);
  const placedIds = useMemo(() => new Set(sheets.flatMap((s) => s.tiles.map((tl) => tl.chartId))), [sheets]);
  const tray = candidates.filter((c) => !placedIds.has(c.chartId));

  const plan: ExportLayoutPlan = useMemo(() => ({ format, orientation, sheets }), [format, orientation, sheets]);
  const issues = useMemo(() => validatePlan(plan, candidates), [plan, candidates]);
  const blocking = issues.filter((i) => i.level === 'error');

  // The sheet is aspect-locked, so the grid's row height follows its rendered
  // width — measured, not guessed, or the arrangement would not match the paper.
  const paperRef = useRef<HTMLDivElement>(null);
  const sheetBoxRef = useRef<HTMLDivElement>(null);
  const [paperH, setPaperH] = useState(0);
  useEffect(() => {
    const el = paperRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPaperH(el.clientHeight));
    ro.observe(el);
    setPaperH(el.clientHeight);
    return () => ro.disconnect();
  }, [isOpen, activeSheet]);
  const GRID_MARGIN = 6;
  const GRID_PAD = 8;
  // Row height comes from the paper's actual height, so `rows` rows fill it
  // exactly — the grid can never be taller than the sheet it sits on.
  const rowHeight = Math.max(8, (paperH - GRID_PAD * 2 - GRID_MARGIN * (rows - 1)) / Math.max(1, rows));

  const sheet = sheets[Math.min(activeSheet, Math.max(0, sheets.length - 1))];

  /** Size a chart takes when dropped. A KPI and a table are not the same shape;
   *  making everything 6×4 meant every drop needed a resize afterwards. */
  const dropSize = useCallback((chartId: number | null) => {
    const type = String((chartId ? byId.get(chartId) : undefined)?.chartType || '').toUpperCase();
    if (/KPI|CARD/.test(type)) return { w: 3, h: 2 };
    if (/TABLE|MATRIX/.test(type)) return { w: 12, h: 4 };
    if (/PIE|DONUT|GAUGE/.test(type)) return { w: 4, h: 4 };
    return { w: 6, h: 4 };
  }, [byId]);

  const updateSheet = (sheetId: string, next: PlanSheet['tiles']) =>
    setSheets((cur) => cur.map((s) => (s.id === sheetId ? { ...s, tiles: next } : s)));

  const addSheet = () => {
    setSheets((cur) => [...cur, { id: newSheetId(), tiles: [] }]);
    setActiveSheet(sheets.length);
  };
  const removeSheet = (id: string) => {
    setSheets((cur) => (cur.length > 1 ? cur.filter((s) => s.id !== id) : cur));
    setActiveSheet((i) => Math.max(0, i - 1));
  };

  const placeOnSheet = (sheetId: string, chartId: number, atX = 0, atY?: number) => {
    const { w, h } = dropSize(chartId);
    setSheets((cur) =>
      cur.map((s) => {
        if (s.id !== sheetId) return s;
        const bottom = s.tiles.reduce((m, tl) => Math.max(m, tl.y + tl.h), 0);
        const y = atY ?? Math.min(bottom, Math.max(0, rows - h));
        return {
          ...s,
          tiles: [...s.tiles, {
            chartId,
            x: Math.max(0, Math.min(SHEET_COLS - w, atX)),
            y: Math.max(0, Math.min(Math.max(0, rows - h), y)),
            w, h,
          }],
        };
      }),
    );
  };

  const removeTile = (sheetId: string, chartId: number) =>
    setSheets((cur) => cur.map((s) => (s.id === sheetId
      ? { ...s, tiles: s.tiles.filter((tl) => tl.chartId !== chartId) }
      : s)));

  const moveTileToSheet = (fromId: string, toId: string, chartId: number) => {
    if (fromId === toId) return;
    const { w, h } = dropSize(chartId);
    setSheets((cur) => cur.map((s) => {
      if (s.id === fromId) return { ...s, tiles: s.tiles.filter((tl) => tl.chartId !== chartId) };
      if (s.id === toId) {
        const bottom = s.tiles.reduce((m, tl) => Math.max(m, tl.y + tl.h), 0);
        return { ...s, tiles: [...s.tiles, { chartId, x: 0, y: Math.min(bottom, Math.max(0, rows - h)), w, h }] };
      }
      return s;
    }));
  };

  const tidyActive = () => {
    if (!sheet) return;
    const placed = sheet.tiles.map((tl) => byId.get(tl.chartId)).filter(Boolean) as PlanCandidate[];
    const [first] = autoArrange(placed, format, orientation);
    if (first) updateSheet(sheet.id, first.tiles);
  };

  const previewFor = (c?: PlanCandidate) => (
    <ChartSketchPreview
      rows={c ? (chartRows?.[c.chartId] as Record<string, unknown>[] | undefined) : undefined}
      chartType={c?.chartType}
      className="h-full w-full"
    />
  );

  if (!isOpen) return null;
  const dropping = dropSize(draggingId);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4">
      <div
        className="flex w-full max-w-[100rem] flex-col overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg"
        style={{ height: 'min(900px, 95vh)' }}
      >
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('dashboards.exportLayout.title')}</h2>
            <p className="text-xs text-text-tertiary">{t('dashboards.exportLayout.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-[rgb(var(--border-line))]">
              <button
                type="button"
                onClick={() => setTidyMode(true)}
                title={t('dashboards.exportLayout.tidyModeHint')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${tidyMode ? 'bg-brand text-white' : 'bg-surface-2 text-text-secondary hover:bg-surface-3'}`}
              >
                <Magnet className="h-3.5 w-3.5" />
                {t('dashboards.exportLayout.tidyMode')}
              </button>
              <button
                type="button"
                onClick={() => setTidyMode(false)}
                title={t('dashboards.exportLayout.freeModeHint')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${!tidyMode ? 'bg-brand text-white' : 'bg-surface-2 text-text-secondary hover:bg-surface-3'}`}
              >
                <Move className="h-3.5 w-3.5" />
                {t('dashboards.exportLayout.freeMode')}
              </button>
            </div>
            <button
              type="button"
              onClick={tidyActive}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-3"
            >
              <Wand2 className="h-3.5 w-3.5" />
              {t('dashboards.exportLayout.tidy')}
            </button>
            <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Library */}
          <div className="flex w-[250px] shrink-0 flex-col border-r border-[rgb(var(--border-line))] bg-surface-2/40">
            <div className="flex items-center justify-between px-3 pb-1 pt-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                {t('dashboards.exportLayout.trayHeading', { count: tray.length })}
              </span>
              {loadingData && (
                <span className="text-[10px] text-text-quaternary">{t('dashboards.exportLayout.loadingPreviews')}</span>
              )}
            </div>
            <p className="px-3 pb-2 text-[10px] leading-snug text-text-quaternary">
              {t('dashboards.exportLayout.trayHint')}
            </p>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
              {tray.length === 0 ? (
                <p className="text-[11px] leading-snug text-text-quaternary">{t('dashboards.exportLayout.trayEmpty')}</p>
              ) : tray.map((c) => (
                <div
                  key={c.chartId}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', String(c.chartId));
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggingId(c.chartId);
                  }}
                  onDragEnd={() => setDraggingId(null)}
                  onDoubleClick={() => sheet && placeOnSheet(sheet.id, c.chartId)}
                  title={t('dashboards.exportLayout.trayCardHint')}
                  className={`cursor-grab rounded-md border bg-surface-1 p-1.5 active:cursor-grabbing ${
                    draggingId === c.chartId ? 'border-brand opacity-60' : 'border-[rgb(var(--border-line))] hover:border-brand/50'
                  }`}
                >
                  <div className="flex items-start gap-1">
                    <GripVertical className="mt-0.5 h-3 w-3 shrink-0 text-text-quaternary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium text-text-primary" title={c.title}>{c.title}</div>
                      <div className="truncate text-[9px] text-text-quaternary">
                        {c.chartType || '—'}{c.pageName ? ` · ${c.pageName}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="mt-1 h-12 w-full rounded border border-[rgb(var(--border-line))] bg-white p-1">
                    {previewFor(c)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* The sheet being edited */}
          {/* The sheet is sized to FIT this pane (height-first), so the whole
              page is always visible — scrolling a design surface to see the
              bottom of the page you are composing defeats the point. */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-2/20 p-4">
            <div ref={sheetBoxRef} className="mx-auto flex h-full w-full max-w-5xl flex-col">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-text-primary">
                  {sheet?.title || t('dashboards.exportLayout.sheetN', { n: activeSheet + 1 })}
                  <span className="ml-2 text-xs font-normal text-text-quaternary">
                    {format.toUpperCase()} · {t(orientation === 'portrait' ? 'dashboards.exportPdf.portrait' : 'dashboards.exportPdf.landscape')}
                    {' · '}{sheet?.tiles.length ?? 0} {t('dashboards.exportLayout.itemsSuffix')}
                  </span>
                </div>
                {sheets.length > 1 && (
                  <button
                    type="button"
                    onClick={() => sheet && removeSheet(sheet.id)}
                    className="inline-flex items-center gap-1 text-[11px] text-text-quaternary hover:text-danger"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('dashboards.exportLayout.removeSheet')}
                  </button>
                )}
              </div>

              <div
                className="relative mx-auto min-h-0 flex-1 overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-white shadow-linear-md"
                style={{ aspectRatio: String(aspect), maxWidth: '100%' }}
                ref={paperRef}
              >
                {sheet && (
                  <ResponsiveGrid
                    className="layout h-full"
                    breakpoints={{ lg: 0 }}
                    cols={{ lg: SHEET_COLS }}
                    rowHeight={rowHeight}
                    margin={[GRID_MARGIN, GRID_MARGIN]}
                    containerPadding={[GRID_PAD, GRID_PAD]}
                    layouts={{ lg: sheet.tiles.map((tl) => ({ i: String(tl.chartId), x: tl.x, y: tl.y, w: tl.w, h: tl.h, minW: 1, minH: 1 })) }}
                    compactType={tidyMode ? 'vertical' : null}
                    preventCollision={!tidyMode}
                    isBounded
                    maxRows={rows}
                    autoSize={false}
                    isDroppable
                    droppingItem={{ i: '__dropping__', w: dropping.w, h: dropping.h }}
                    onDrop={(_l, item, e) => {
                      const raw = (e as unknown as DragEvent)?.dataTransfer?.getData('text/plain');
                      const chartId = Number(raw);
                      if (!Number.isFinite(chartId) || !chartId) return;
                      placeOnSheet(sheet.id, chartId, item?.x ?? 0, item?.y ?? 0);
                      setDraggingId(null);
                    }}
                    onLayoutChange={(next) => {
                      const mapped = next
                        .filter((l) => l.i !== '__dropping__')
                        .map((l) => ({ chartId: Number(l.i), x: l.x, y: l.y, w: l.w, h: l.h }));
                      if (JSON.stringify(mapped) !== JSON.stringify(sheet.tiles)) updateSheet(sheet.id, mapped);
                    }}
                  >
                    {sheet.tiles.map((tl) => {
                      const c = byId.get(tl.chartId);
                      const min = minTileSize(c?.chartType);
                      const small = tl.w < min.w || tl.h < min.h;
                      return (
                        <div
                          key={String(tl.chartId)}
                          onDoubleClick={() => removeTile(sheet.id, tl.chartId)}
                          title={t('dashboards.exportLayout.tileHint')}
                          className={`group flex flex-col overflow-hidden rounded-md border bg-white ${
                            small ? 'border-warning' : 'border-[rgb(var(--border-line))]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-1 px-1.5 pt-1">
                            <span className="truncate text-[10px] font-medium text-text-primary" title={c?.title}>
                              {c?.title || `#${tl.chartId}`}
                            </span>
                            <button
                              type="button"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() => removeTile(sheet.id, tl.chartId)}
                              className="shrink-0 text-text-quaternary opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                          <div className="min-h-0 flex-1 p-1">{previewFor(c)}</div>
                          {small && (
                            <div className="bg-warning/15 px-1.5 py-0.5 text-[9px] leading-tight text-warning">
                              {t('dashboards.exportLayout.tooSmall', { w: min.w, h: min.h })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </ResponsiveGrid>
                )}
              </div>
            </div>
          </div>

          {/* Sheet strip */}
          <div className="flex w-[190px] shrink-0 flex-col border-l border-[rgb(var(--border-line))] bg-surface-2/40">
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
              <Layers className="h-3.5 w-3.5" />
              {t('dashboards.exportLayout.sheetsHeading', { count: sheets.length })}
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
              {sheets.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSheet(i)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const chartId = Number(e.dataTransfer.getData('text/plain'));
                    if (!Number.isFinite(chartId) || !chartId) return;
                    const from = sheets.find((sh) => sh.tiles.some((tl) => tl.chartId === chartId));
                    if (from) moveTileToSheet(from.id, s.id, chartId);
                    else placeOnSheet(s.id, chartId);
                    setDraggingId(null);
                    setActiveSheet(i);
                  }}
                  className={`w-full rounded-md border p-1.5 text-left transition ${
                    i === activeSheet ? 'border-brand ring-1 ring-brand/30' : 'border-[rgb(var(--border-line))] hover:border-brand/40'
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between text-[10px] font-medium text-text-secondary">
                    <span className="truncate">{s.title || t('dashboards.exportLayout.sheetN', { n: i + 1 })}</span>
                    <span className="text-text-quaternary">{s.tiles.length}</span>
                  </div>
                  {/* Miniature with the real positions, so the strip reads like a
                      page navigator instead of a list of numbers. */}
                  <div
                    className="relative w-full overflow-hidden rounded border border-[rgb(var(--border-line))] bg-white"
                    style={{ aspectRatio: String(aspect) }}
                  >
                    {s.tiles.map((tl) => (
                      <div
                        key={tl.chartId}
                        className="absolute rounded-[1px] bg-brand/25"
                        style={{
                          left: `${(tl.x / SHEET_COLS) * 100}%`,
                          top: `${(tl.y / rows) * 100}%`,
                          width: `${(tl.w / SHEET_COLS) * 100}%`,
                          height: `${(tl.h / rows) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                </button>
              ))}
              <button
                type="button"
                onClick={addSheet}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-[rgb(var(--border-line))] px-2 py-1.5 text-[11px] font-medium text-text-secondary hover:border-brand hover:text-brand"
              >
                <Plus className="h-3 w-3" />
                {t('dashboards.exportLayout.addSheet')}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-[rgb(var(--border-line))] px-5 py-3">
          <div className="min-h-[1.5rem] flex-1 space-y-0.5 overflow-y-auto text-[11px] leading-snug" style={{ maxHeight: '3.5rem' }}>
            {issues.slice(0, 3).map((iss, i) => (
              <div key={i} className={`flex items-start gap-1 ${iss.level === 'error' ? 'text-danger' : 'text-warning'}`}>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{iss.message}</span>
              </div>
            ))}
          </div>
          <button onClick={onClose} className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-sm hover:bg-surface-3">
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onExport(plan)}
            disabled={blocking.length > 0 || placedIds.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
          >
            <FileDown className="h-4 w-4" />
            {t('dashboards.exportLayout.export', { sheets: sheets.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
