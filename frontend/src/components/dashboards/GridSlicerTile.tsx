'use client';

/**
 * A slicer control on the report grid.
 *
 * It draws ONE slicer with the same FilterCard the filter bar uses (the bar's
 * `bare` mode), bound to whatever filter state its surface owns — the builder's
 * draft slicers, or the viewer's staged filters on a public link. It holds no
 * filter state of its own and never writes one: a value picked here goes to
 * `onChange` exactly as it would from the bar, and is applied by the page's one
 * Apply. What the tile itself stores is `{slicerId, treatment}` — presentation.
 *
 * When the slicer cannot be shown here (its scope hides it on this page, or it
 * no longer exists), an author sees why and a viewer sees nothing.
 */
import React from 'react';
import { EyeOff, GripVertical, Lock, SlidersHorizontal, Trash2, Unlink, Unlock, X } from 'lucide-react';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import type { BaseFilter, ColumnInfo } from '@/lib/filters';
import {
  SLICER_TREATMENTS,
  resolveSlicerControl,
  resolveTreatment,
  slicerIdOfControl,
  treatmentOfControl,
  type SlicerTreatment,
} from '@/lib/slicer-placement';
import { useI18n } from '@/providers/LanguageProvider';
import type { DashboardChart } from '@/types/api';

/** What a surface lends its slicer controls. */
export interface SlicerControlBinding {
  /** Every slicer this surface can show a control for. */
  slicers: BaseFilter[];
  /** The whole staged filter set of the page, for the empty-combination hint. */
  siblingFilters?: BaseFilter[];
  visibleHere: (slicer: BaseFilter) => boolean;
  filtersHere: (slicer: BaseFilter) => boolean;
  /** Author surface: explains hidden / missing controls and offers edits. */
  editing: boolean;
  /** The viewer may not change filters on this link. */
  readOnly?: boolean;
  onChange?: (next: BaseFilter) => void;
  onTreatmentChange?: (tileId: number, treatment: SlicerTreatment) => void;
  onRemoveControl?: (tileId: number) => void;
  onDeleteFilter?: (slicerId: string) => void;
  /** Lock the control's place (the grid's own lock, through the draft). */
  onToggleLock?: (tileId: number, next: boolean) => void;
  columns: ColumnInfo[];
  columnChartCount: Map<string, number>;
  distinctValues: Record<string, string[]>;
  distinctStatus?: React.ComponentProps<typeof DashboardFilterBar>['distinctStatus'];
  fetchServerDistinct?: (column: ColumnInfo, search: string) => Promise<string[]>;
  showScopeToggle?: boolean;
  dashboardPages?: { id: string; name: string }[];
  activePageId?: string;
  onUpdateSlicerScope?: React.ComponentProps<typeof DashboardFilterBar>['onUpdateSlicerScope'];
}

/** Room the list treatment's header, search and "select all" row take. */
const LIST_CHROME_PX = 112;

export function GridSlicerTile({ tile, binding }: { tile: DashboardChart; binding: SlicerControlBinding }) {
  const { t } = useI18n();
  const slicerId = slicerIdOfControl(tile);
  const treatment = treatmentOfControl(tile);
  const resolution = resolveSlicerControl(slicerId, binding.slicers, {
    visibleHere: binding.visibleHere,
    filtersHere: binding.filtersHere,
  });

  // A callback ref, not a one-shot effect: on the public link the viewer's
  // filters arrive after the first render, so the tile first renders without
  // its box, and a mount-only measurement never saw the real tile (its height
  // stayed 0 and a tall control never became a list).
  const [box, setBox] = React.useState<HTMLDivElement | null>(null);
  const boxRef = setBox;
  const [heightPx, setHeightPx] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = box;
    if (!el || typeof ResizeObserver === 'undefined') return;
    setHeightPx(Math.round(el.getBoundingClientRect().height));
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect?.height ?? 0);
      setHeightPx((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [box]);

  const [menuOpen, setMenuOpen] = React.useState(false);
  const locked = Boolean((tile.layout as any)?.locked);

  if (resolution.state === 'missing' || (resolution.state === 'hidden' && !binding.editing)) {
    if (!binding.editing) return <div className="h-full w-full" data-slicer-control="absent" aria-hidden />;
    return (
      <div
        ref={boxRef}
        data-slicer-control="missing"
        className="flex h-full w-full items-center justify-between gap-2 rounded-lg border border-dashed border-[rgb(var(--border-strong))] px-3 text-[12px] text-text-tertiary"
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate"><Unlink className="h-3.5 w-3.5 shrink-0" />{t('dashboards.slicerControl.missing')}</span>
        {binding.onRemoveControl && (
          <button
            type="button"
            className="no-drag shrink-0 rounded border border-[rgb(var(--border-line))] px-2 py-0.5 text-[11px] hover:bg-surface-2"
            onClick={() => binding.onRemoveControl?.(tile.id)}
          >
            {t('dashboards.slicerControl.removeControl')}
          </button>
        )}
      </div>
    );
  }

  const slicer = resolution.slicer;
  const resolved = resolveTreatment(treatment, { slicer, tileHeightPx: heightPx });
  const hidden = resolution.state === 'hidden';
  const listMax = Math.max(72, heightPx - LIST_CHROME_PX);

  return (
    <div
      ref={boxRef}
      data-slicer-control={hidden ? 'hidden' : 'ok'}
      data-slicer-id={slicer.id}
      data-slicer-treatment={resolved}
      className="group/slicer relative h-full w-full min-w-0"
      style={{ ['--slicer-list-max' as any]: `${listMax}px` }}
    >
      <div className={`h-full w-full ${hidden ? 'pointer-events-none opacity-45' : ''} ${binding.readOnly ? 'pointer-events-none' : ''}`}
        aria-disabled={binding.readOnly || hidden || undefined}>
        <DashboardFilterBar
          bare
          treatment={resolved}
          filters={[slicer]}
          siblingFilters={binding.siblingFilters}
          onFiltersChange={(next) => {
            // The bar hands back the list it was given, edited. One entry in,
            // one entry out: removal is not a gesture a control offers.
            const updated = next.find((f) => f.id === slicer.id);
            if (updated && binding.onChange) binding.onChange(updated);
          }}
          columns={binding.columns}
          columnChartCount={binding.columnChartCount}
          distinctValues={binding.distinctValues}
          distinctStatus={binding.distinctStatus}
          fetchServerDistinct={binding.fetchServerDistinct}
          lockSlots
          showScopeToggle={binding.editing && binding.showScopeToggle}
          dashboardPages={binding.dashboardPages}
          activePageId={binding.activePageId}
          onUpdateSlicerScope={binding.onUpdateSlicerScope}
        />
      </div>
      {hidden && (
        <span className="pointer-events-none absolute inset-x-1 bottom-1 flex items-center gap-1 truncate rounded bg-surface-1/90 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
          <EyeOff className="h-3 w-3 shrink-0" />
          {resolution.filtersHere ? t('dashboards.slicerControl.hiddenHere') : t('dashboards.slicerControl.inactiveHere')}
        </span>
      )}
      {binding.editing && (
        <>
          {/* A grip that is always a drag start: the card itself is a button. */}
          <span
            className="drag-handle absolute -left-0.5 top-1/2 z-10 flex h-6 w-3 -translate-y-1/2 cursor-move items-center justify-center rounded-sm text-text-quaternary opacity-0 transition-opacity group-hover/slicer:opacity-100"
            title={t('dashboards.slicerControl.dragHint')}
            aria-hidden
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          {(binding.onTreatmentChange || binding.onDeleteFilter || binding.onRemoveControl) && (
            <div className="no-drag absolute right-1 top-1 z-20 opacity-0 transition-opacity group-hover/slicer:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                data-testid="slicer-control-menu"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setMenuOpen((v) => !v)}
                className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1 shadow-linear-sm hover:border-brand/40 hover:text-brand"
                title={t('dashboards.slicerControl.display')}
                aria-expanded={menuOpen}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-1 text-[12px] shadow-xl"
                  onMouseLeave={() => setMenuOpen(false)}
                >
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">
                    {t('dashboards.slicerControl.display')}
                  </div>
                  {binding.onTreatmentChange && SLICER_TREATMENTS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="menuitemradio"
                      aria-checked={treatment === option}
                      data-testid={`slicer-treatment-${option}`}
                      onClick={() => { binding.onTreatmentChange?.(tile.id, option); setMenuOpen(false); }}
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-surface-2 ${treatment === option ? 'font-semibold text-brand' : 'text-text-secondary'}`}
                    >
                      {t(`dashboards.slicerControl.treatment.${option}`)}
                      {treatment === option && <span aria-hidden>✓</span>}
                    </button>
                  ))}
                  {(binding.onToggleLock || binding.onRemoveControl) && <div className="my-1 border-t border-[rgb(var(--border-line))]" />}
                  {binding.onToggleLock && (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={locked}
                      data-testid="slicer-lock-toggle"
                      onClick={() => { binding.onToggleLock?.(tile.id, !locked); setMenuOpen(false); }}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-text-secondary hover:bg-surface-2"
                    >
                      {locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                      {locked ? t('dashboards.grid.unlock') : t('dashboards.grid.lock')}
                    </button>
                  )}
                  {binding.onRemoveControl && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="slicer-remove-control"
                      onClick={() => { setMenuOpen(false); binding.onRemoveControl?.(tile.id); }}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-text-secondary hover:bg-surface-2"
                    >
                      <X className="h-3.5 w-3.5" />
                      {t('dashboards.slicerControl.removeControl')}
                    </button>
                  )}
                  {binding.onDeleteFilter && (
                    <>
                      <div className="my-1 border-t border-[rgb(var(--border-line))]" />
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="slicer-delete-filter"
                        onClick={() => {
                          setMenuOpen(false);
                          const label = slicer.label || slicer.field;
                          if (window.confirm(t('dashboards.slicerControl.deleteConfirm', { label }))) {
                            binding.onDeleteFilter?.(String(slicer.id));
                          }
                        }}
                        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-danger hover:bg-danger/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('dashboards.slicerControl.deleteFilter')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The one Apply for every staged filter choice, when some of the page's
 *  controls are on the grid rather than in the filter bar. */
export function FilterApplyBar({
  visible,
  isApplying,
  onApply,
  onReset,
}: {
  visible: boolean;
  isApplying?: boolean;
  onApply: () => void;
  onReset?: () => void;
}) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <div
      data-testid="filter-apply-bar"
      data-html2canvas-ignore
      className="pointer-events-none sticky bottom-3 z-40 mt-3 flex justify-center px-2"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-brand/30 bg-surface-1 px-3 py-1.5 text-[12px] shadow-xl">
        <span className="truncate text-text-secondary">{t('dashboards.applyBar.pending')}</span>
        {onReset && (
          <button type="button" onClick={onReset} className="shrink-0 rounded-full px-2 py-0.5 text-text-tertiary hover:bg-surface-2">
            {t('dashboards.applyBar.reset')}
          </button>
        )}
        <button
          type="button"
          data-testid="filter-apply-bar-apply"
          onClick={onApply}
          disabled={isApplying}
          className="shrink-0 rounded-full bg-brand px-3 py-0.5 font-medium text-white hover:bg-brand-hover disabled:opacity-60"
        >
          {t('dashboards.applyBar.apply')}
        </button>
      </div>
    </div>
  );
}
