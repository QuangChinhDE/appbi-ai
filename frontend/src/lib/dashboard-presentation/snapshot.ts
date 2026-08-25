/**
 * What the planner is allowed to see, and the fingerprint that proves what it
 * changed.
 *
 * Two jobs live here because they are two halves of one guarantee. The snapshot
 * decides what leaves the building: a redesign needs to know a tile is a donut
 * called "Payments by method" sitting bottom-left, and needs to know nothing at
 * all about which dataset that came from, what SQL ran, or what the rows say.
 * Sending less is not only safer, it is cheaper and it stops the model from
 * reasoning about data it cannot verify and inventing a conclusion.
 *
 * The fingerprint decides what must come back unchanged. It is taken from the
 * SAME tiles at the SAME moment, so a plan built on stale server state cannot
 * be validated against a fresher baseline and quietly pass.
 */
import type { Dashboard, DashboardChart } from '@/types/api';
import {
  DASHBOARD_GRID_COLS,
  DEFAULT_DASHBOARD_PAGE_ID,
  getDashboardChartPageId,
  getDashboardChartsForPage,
  scaleGridLayoutForRender,
} from '@/lib/dashboard-pages';
import { buildCapabilitySchema, AI_ALLOWED_CHART_STYLE_KEYS } from './capabilities';
import { inferPresentationRole, isDataVisual } from './roles';
import type {
  DashboardPresentationSnapshot,
  PresentationFingerprint,
  PresentationFingerprintEntry,
  SnapshotSlicer,
  SnapshotVisual,
} from './types';

/** The page a tile belongs to, by the same rule the grid uses — a tile with no
 *  pageId belongs to page 1, which is how single-page dashboards written before
 *  pages existed keep working. */
const pageIdOf = (tile: DashboardChart): string => getDashboardChartPageId(tile.layout);

export function tilesOnPage(dashboard: Dashboard | null | undefined, pageId: string): DashboardChart[] {
  return getDashboardChartsForPage(dashboard?.dashboard_charts, pageId || DEFAULT_DASHBOARD_PAGE_ID);
}

/** The tile's visible title, by the same precedence the tile header uses:
 *  the dashboard-level custom title first, then the chart's own name. */
function titleOf(tile: DashboardChart): string {
  const custom = (tile.layout as any)?.custom_title;
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  const widgetTitle = (tile.widget_config as any)?.title ?? (tile.widget_config as any)?.text;
  if (typeof widgetTitle === 'string' && widgetTitle.trim()) return widgetTitle.trim();
  return String(tile.chart?.name ?? '').trim() || `Visual ${tile.id}`;
}

function chartTypeOf(tile: DashboardChart): string {
  const raw = (tile.chart as any)?.chart_type;
  return String(raw ?? '').toUpperCase();
}

/**
 * Stable hash of everything about a tile that is NOT presentation. Any change
 * to what the tile MEANS moves this string; moving, resizing or restyling it
 * does not. JSON key order is normalised because two structurally identical
 * configs serialised in different key orders would otherwise read as a
 * semantic change and reject a perfectly good plan.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function hash(input: string): string {
  // FNV-1a. Not a security hash — it only has to change when the input does,
  // and be identical across two runs in the same session.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function semanticHashOf(tile: DashboardChart): string {
  const layout = (tile.layout ?? {}) as Record<string, any>;
  // `styleConfigOverride` is mixed: some of it is presentation and some of it
  // (Top-N, sort, benchmarks) is not. Only the non-presentation half is
  // fingerprinted, so a legitimate restyle does not read as tampering while a
  // changed row limit does.
  const styleOverride = (layout.styleConfigOverride ?? {}) as Record<string, any>;
  const semanticStyle: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(styleOverride)) {
    if (!(AI_ALLOWED_CHART_STYLE_KEYS as readonly string[]).includes(key)) {
      semanticStyle[key] = value;
    }
  }
  return hash(stableStringify({
    chartId: tile.chart_id ?? null,
    chartType: chartTypeOf(tile),
    widgetType: tile.widget_type ?? 'chart',
    // The chart's own config is the content layer. Any edit to it — dimensions,
    // measures, aggregation, filters, calculated fields — moves the hash.
    chartConfig: (tile.chart as any)?.config ?? null,
    datasetId: (tile.chart as any)?.dataset_id ?? null,
    parameters: tile.parameters ?? null,
    tileFilters: layout.tileFilters ?? null,
    semanticStyle,
  }));
}

export function buildPresentationFingerprint(tiles: DashboardChart[]): PresentationFingerprint {
  const out: PresentationFingerprint = {};
  for (const tile of tiles) {
    const entry: PresentationFingerprintEntry = {
      dashboardChartId: tile.id,
      chartId: tile.chart_id ?? null,
      chartType: chartTypeOf(tile),
      widgetType: String(tile.widget_type ?? 'chart'),
      pageId: pageIdOf(tile),
      semanticHash: semanticHashOf(tile),
    };
    out[String(tile.id)] = entry;
  }
  return out;
}

/** Which allow-listed style keys are meaningful for this chart type. Sending a
 *  donut's plan `barRadius` wastes tokens and invites nonsense. */
function styleCapabilitiesFor(chartType: string, widgetType: string): string[] {
  if (!isDataVisual(widgetType)) return ['transparentBackground'];
  const type = chartType.toUpperCase();
  const common = ['transparentBackground', 'fontSize', 'chartTitleFontSize', 'palette', 'numberFormat', 'decimalPlaces'];
  if (type === 'KPI' || type === 'GAUGE' || type === 'CARD') {
    return [...common, 'kpiBackgroundMode', 'kpiAccentColor', 'kpiAccentBorder', 'kpiGradientBg', 'kpiValueFontSize', 'kpiIconName', 'kpiIconColor'];
  }
  if (type === 'TABLE' || type === 'MATRIX') return [...common];
  if (type === 'PIE' || type === 'DONUT') return [...common, 'legendPosition', 'showDataLabels', 'dataLabelPosition', 'pieInnerRadius'];
  const cartesian = [...common, 'legendPosition', 'showGrid', 'showDataLabels', 'dataLabelPosition', 'axisDisplayUnits'];
  if (type === 'LINE' || type === 'TIME_SERIES' || type === 'AREA') {
    return [...cartesian, 'showDots', 'lineStyle', 'lineWidth', 'areaOpacity'];
  }
  return [...cartesian, 'barRadius', 'barSize'];
}

export interface BuildSnapshotInput {
  dashboard: Dashboard;
  /** The tiles as the USER currently sees them — server state with unsaved
   *  local moves already merged in. Passing raw server tiles here is the bug
   *  §24 exists to prevent. */
  tiles: DashboardChart[];
  pageId: string;
  pageName: string;
  pageCount: number;
  slicers: Array<Record<string, any>>;
  slicerDock: string;
}

export function buildPresentationSnapshot(input: BuildSnapshotInput): DashboardPresentationSnapshot {
  const { dashboard, tiles, pageId, pageName, pageCount, slicers, slicerDock } = input;
  const theme = (dashboard.theme_config ?? {}) as Record<string, any>;

  const visuals: SnapshotVisual[] = tiles.map((tile) => {
    // Read through the same upscaler the renderer uses, so a legacy 12-column
    // tile is described to the planner at the coordinates it actually occupies.
    const layout = (scaleGridLayoutForRender(tile.layout as any) ?? {}) as Record<string, any>;
    const chartType = chartTypeOf(tile);
    const widgetType = String(tile.widget_type ?? 'chart');
    const x = Number(layout.x) || 0;
    const y = Number(layout.y) || 0;
    const w = Number(layout.w) || 0;
    const h = Number(layout.h) || 0;
    return {
      dashboardChartId: tile.id,
      chartType: chartType || (widgetType === 'chart' ? 'UNKNOWN' : widgetType.toUpperCase()),
      title: titleOf(tile),
      currentLayout: { x, y, w, h },
      displayRoleHint: inferPresentationRole({
        chartType, widgetType, w, y, gridColumns: DASHBOARD_GRID_COLS,
      }),
      isWidget: !isDataVisual(widgetType),
      widgetType,
      styleCapabilities: styleCapabilitiesFor(chartType, widgetType),
    };
  });

  const snapshotSlicers: SnapshotSlicer[] = (slicers ?? []).map((slicer, index) => ({
    id: String(slicer?.id ?? `slicer-${index + 1}`),
    // The LABEL is presentation. The field it filters is not sent at all —
    // the planner has no use for it and no way to change it.
    displayLabel: String(slicer?.label ?? slicer?.name ?? `Filter ${index + 1}`),
    presentationType: String(slicer?.type ?? 'dropdown'),
    currentPosition: slicerDock,
  }));

  return {
    dashboard: {
      name: String(dashboard.name ?? ''),
      currentPageId: pageId,
      pageCount,
    },
    currentPage: { id: pageId, name: pageName },
    visuals,
    slicers: snapshotSlicers,
    theme: {
      template: typeof theme.templateId === 'string' ? theme.templateId : undefined,
      colorway: typeof theme.colorwayId === 'string' ? theme.colorwayId : undefined,
      mode: typeof theme.mode === 'string' ? theme.mode : undefined,
      density: typeof theme.density === 'string' ? theme.density : undefined,
      cardTreatment: typeof theme.cardTreatment === 'string' ? theme.cardTreatment : undefined,
    },
    capabilities: buildCapabilitySchema(),
  };
}
