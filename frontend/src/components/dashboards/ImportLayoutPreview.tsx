'use client';

import React, { useMemo } from 'react';
import { useI18n } from '@/providers/LanguageProvider';

/**
 * What the imported dashboard will look like, before it is built.
 *
 * The import preview used to be a list of chart plans with their validation
 * errors — which answers "will each chart run", but not "is this the report I
 * designed". Those are different questions, and the second one was unanswerable
 * until after the dashboard existed.
 *
 * This is a map, not a rendering: the charts do not exist yet, so there is no
 * data to draw. It shows where every tile lands, how big it is, what kind it
 * is, and which template and filter dock the report will use — everything the
 * layout decides, which is exactly what a person needs to check before
 * committing.
 */

type Tile = {
  id: string;
  title: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  failing?: boolean;
};

const GRID_COLUMNS = 12;

/** Colour by KIND, so the shape of the report reads at a glance. */
const KIND_STYLE: Record<string, { bg: string; ink: string; ring: string }> = {
  kpi: { bg: 'rgb(var(--brand-rgb, 79 70 229) / 0.10)', ink: 'rgb(var(--brand-rgb, 79 70 229))', ring: 'rgb(var(--brand-rgb, 79 70 229) / 0.32)' },
  chart: { bg: 'rgb(var(--brand-rgb, 79 70 229) / 0.06)', ink: 'rgb(var(--brand-rgb, 79 70 229))', ring: 'rgb(var(--brand-rgb, 79 70 229) / 0.22)' },
  table: { bg: 'rgb(148 163 184 / 0.14)', ink: 'rgb(71 85 105)', ring: 'rgb(148 163 184 / 0.5)' },
  section_header: { bg: 'rgb(148 163 184 / 0.08)', ink: 'rgb(100 116 139)', ring: 'rgb(148 163 184 / 0.35)' },
  callout: { bg: 'rgb(245 158 11 / 0.12)', ink: 'rgb(180 83 9)', ring: 'rgb(245 158 11 / 0.36)' },
  text: { bg: 'rgb(148 163 184 / 0.08)', ink: 'rgb(100 116 139)', ring: 'rgb(148 163 184 / 0.3)' },
  hero_strip: { bg: 'rgb(var(--brand-rgb, 79 70 229) / 0.14)', ink: 'rgb(var(--brand-rgb, 79 70 229))', ring: 'rgb(var(--brand-rgb, 79 70 229) / 0.4)' },
  html_fragment: { bg: 'rgb(16 185 129 / 0.10)', ink: 'rgb(4 120 87)', ring: 'rgb(16 185 129 / 0.34)' },
};

const FALLBACK_STYLE = KIND_STYLE.chart;

function kindOf(item: Record<string, any>): string {
  const widgetType = String(item?.widget_type ?? '').toLowerCase();
  if (widgetType && widgetType !== 'chart') return widgetType;
  const chartType = String(item?.final_chart_type ?? item?.chart_type ?? '').toUpperCase();
  if (chartType === 'KPI') return 'kpi';
  if (chartType === 'TABLE' || chartType === 'MATRIX') return 'table';
  return 'chart';
}

function labelOf(item: Record<string, any>): string {
  const config = item?.widget_config ?? {};
  return String(
    item?.title
      || config.title
      || config.headline
      || config.text
      || config.template
      || item?.block_id
      || '',
  );
}

export function ImportLayoutPreview({
  chartPlans,
  widgets,
  templateFamily,
  colorway,
  filterDock,
  slicers,
  failingBlockIds,
}: {
  chartPlans: Record<string, any>[];
  widgets: Record<string, any>[];
  templateFamily?: string | null;
  colorway?: string | null;
  filterDock?: string | null;
  slicers?: Record<string, any>[];
  failingBlockIds?: Set<string>;
}) {
  const { t } = useI18n();

  const tiles = useMemo<Tile[]>(() => {
    const all = [...(chartPlans ?? []), ...(widgets ?? [])];
    return all
      .map((item) => {
        const layout = item?.layout ?? {};
        return {
          id: String(item?.block_id ?? ''),
          title: labelOf(item),
          kind: kindOf(item),
          x: Number(layout.x ?? 0),
          y: Number(layout.y ?? 0),
          w: Math.max(1, Number(layout.w ?? GRID_COLUMNS)),
          h: Math.max(1, Number(layout.h ?? 1)),
          failing: failingBlockIds?.has(String(item?.block_id ?? '')) ?? false,
        };
      })
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }, [chartPlans, widgets, failingBlockIds]);

  // The grid's own height, so the map is proportioned like the real thing
  // rather than squeezed into a fixed box.
  const rows = useMemo(
    () => tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0),
    [tiles],
  );

  // Overlaps are the one thing a layout map can prove on its own, so it says so
  // rather than leaving a person to spot two tiles sharing a cell.
  const overlapping = useMemo(() => {
    const hits = new Set<string>();
    for (let i = 0; i < tiles.length; i += 1) {
      for (let j = i + 1; j < tiles.length; j += 1) {
        const a = tiles[i];
        const b = tiles[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          hits.add(a.id);
          hits.add(b.id);
        }
      }
    }
    return hits;
  }, [tiles]);

  if (tiles.length === 0) return null;

  const dock = String(filterDock ?? 'top');
  const railDock = dock === 'left' || dock === 'right';

  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-caption font-semibold text-text-primary">
            {t('dashboards.htmlImport.previewTitle')}
          </p>
          <p className="mt-0.5 text-caption text-text-tertiary">
            {t('dashboards.htmlImport.previewSubtitle', { count: tiles.length })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {templateFamily && <Chip label={t('dashboards.htmlImport.previewTemplate')} value={templateFamily} />}
          {colorway && <Chip label={t('dashboards.htmlImport.previewColorway')} value={colorway} />}
          <Chip label={t('dashboards.htmlImport.previewDock')} value={dock} />
          <Chip
            label={t('dashboards.htmlImport.previewSlicers')}
            value={String((slicers ?? []).length)}
          />
        </div>
      </div>

      {overlapping.size > 0 && (
        <p className="mb-2.5 rounded-lg bg-[rgb(245_158_11_/_0.12)] px-3 py-2 text-caption text-[rgb(146_64_14)]">
          {t('dashboards.htmlImport.previewOverlap', { count: overlapping.size })}
        </p>
      )}

      <div className={railDock ? 'flex gap-2' : ''}>
        {railDock && <DockRail side={dock} label={t('dashboards.htmlImport.previewFilters')} />}
        <div className="min-w-0 flex-1">
          {!railDock && dock !== 'drawer' && (
            <div className="mb-2 rounded-md border border-dashed border-[rgb(var(--border-strong))] px-3 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
              {t('dashboards.htmlImport.previewFilters')}
            </div>
          )}
          <div
            className="relative w-full"
            style={{
              // One grid row is rendered at 14px: enough that a 1-row heading
              // band and a 5-row table read as different things.
              height: `${Math.max(rows, 1) * 14}px`,
            }}
          >
            {tiles.map((tile) => {
              const style = KIND_STYLE[tile.kind] ?? FALLBACK_STYLE;
              const isOverlapping = overlapping.has(tile.id);
              return (
                <div
                  key={`${tile.id}-${tile.x}-${tile.y}`}
                  title={`${tile.title} · ${tile.kind} · ${tile.w}×${tile.h}`}
                  className="absolute flex items-center overflow-hidden rounded-[3px] px-1.5"
                  style={{
                    left: `${(tile.x / GRID_COLUMNS) * 100}%`,
                    width: `calc(${(tile.w / GRID_COLUMNS) * 100}% - 2px)`,
                    top: `${tile.y * 14}px`,
                    height: `${tile.h * 14 - 2}px`,
                    background: style.bg,
                    boxShadow: `inset 0 0 0 1px ${isOverlapping ? 'rgb(220 38 38 / 0.7)' : style.ring}`,
                  }}
                >
                  <span
                    className="truncate text-[9px] font-medium leading-none"
                    style={{ color: tile.failing ? 'rgb(185 28 28)' : style.ink }}
                  >
                    {tile.failing ? '⚠ ' : ''}{tile.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
        {Object.entries(
          tiles.reduce<Record<string, number>>((counts, tile) => {
            counts[tile.kind] = (counts[tile.kind] ?? 0) + 1;
            return counts;
          }, {}),
        ).map(([kind, count]) => {
          const style = KIND_STYLE[kind] ?? FALLBACK_STYLE;
          return (
            <span key={kind} className="flex items-center gap-1 text-[10px] text-text-tertiary">
              <span
                className="h-2 w-2 rounded-[2px]"
                style={{ background: style.bg, boxShadow: `inset 0 0 0 1px ${style.ring}` }}
              />
              {kind.replace(/_/g, ' ')} · {count}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-text-secondary ring-1 ring-[rgb(var(--border-line))]">
      <span className="text-text-tertiary">{label}</span> {value}
    </span>
  );
}

function DockRail({ side, label }: { side: string; label: string }) {
  return (
    <div
      className={`w-16 shrink-0 rounded-md border border-dashed border-[rgb(var(--border-strong))] px-1 py-2 text-center text-[9px] font-semibold uppercase leading-tight tracking-[0.08em] text-text-tertiary ${
        side === 'right' ? 'order-2' : ''
      }`}
    >
      {label}
    </div>
  );
}
