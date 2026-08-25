'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  AlertTriangle,
  BarChart3,
  Download,
  Loader2,
  Lock,
  RefreshCw,
  Eye,
  EyeOff,
} from 'lucide-react';
import { ChartErrorBoundary } from '@/components/dashboards/ChartErrorBoundary';
import { DashboardWidget } from '@/components/dashboards/DashboardWidget';
import { DashboardThemeProvider, getDashboardGridMargin } from '@/components/dashboards/DashboardThemeProvider';
import { ReadonlyChartTile } from '@/components/dashboards/ReadonlyChartTile';
import { ExportPdfDialog, type ExportPdfChoices } from '@/components/dashboards/ExportPdfDialog';
import type { PdfExportWarning, PdfProgress } from '@/lib/export-pdf';
import {
  ExportModeContext,
  PDF_PREVIEW_TAB_ENABLED,
  openPdfPreviewTab,
  safePdfFilename,
  type ExportRenderMode,
} from '@/lib/export-mode';
import { parsePrintRenderOptions, type PrintRenderOptions } from '@/lib/print-render';
import { toast } from '@/lib/toast';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { SlicerCluster } from '@/components/dashboards/SlicerCluster';
import { DashboardAiBot } from '@/components/dashboards/DashboardAiBot';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  clearPublicSession,
  getPublicSession,
  publicDashboardApi,
  publicSessionRemainingSeconds,
  savePublicSession,
} from '@/lib/api/public';
import {
  ensureDashboardPageId,
  getDashboardChartPageId,
  getDashboardChartsForPage,
  normalizeDashboardPages,
  deriveStackedLayout,
  computeReportRowHeight,
  dashboardRowHeight,
  DASHBOARD_GRID_COLS,
  normalizeDashboardGridForRender,
  REPORT_STACK_BREAKPOINT,
} from '@/lib/dashboard-pages';
import { resolveStyleTokens } from '@/lib/dashboard-theme-tokens';
import { applyScopeBound, dockLayoutClasses, getColumnKey, getDistinctValueFilterContext, getFilterDisplayLabel, getFilterKey, type BaseFilter, type ColumnInfo } from '@/lib/filters';
import { usePublicFilterDistinctValues } from '@/hooks/use-public-filter-distinct-values';
import { buildPublicLinkTheme } from '@/lib/public-link-appearance';
import { buildPublicDashboardFilterRuntime } from '@/lib/public-dashboard-runtime';
import { mergeSeedWithViewerSelections, resolvePublicPageFilterContext } from '@/lib/public-page-filters';
import type { ChartDataResponse, Dashboard, DashboardChart } from '@/types/api';

// Phase-B5 / Phase-B9 — responsive "Fit to width" grid for the public report.
// Two breakpoints ONLY:
//   • lg  (≥ REPORT_STACK_BREAKPOINT grid px): 12 columns, the EXACT authored
//     layout — so a desktop resize stays in lg and never reflows/jumps. The row
//     height scales WITH the grid width (see computeReportRowHeight) so tiles keep
//     their authored aspect ratio on a TV, laptop, or tablet alike.
//   • xs  (< REPORT_STACK_BREAKPOINT): 1 column, a pre-derived vertical stack —
//     a real phone view instead of micro-tiles (or the old giant stacked cards).
// Explicit layouts for BOTH breakpoints means react-grid-layout never
// auto-generates (and never reflows) a layout. compactType=null +
// preventCollision preserve coordinates exactly as provided.
const ResponsiveReportGrid = WidthProvider(Responsive);
const REPORT_BREAKPOINTS = { lg: REPORT_STACK_BREAKPOINT, xs: 0 };
// Finer grid: 36 cols on desktop/tablet (matches the builder; ×3-migrated coords
// render identically). Phone stack stays 1-col.
const REPORT_COLS = { lg: DASHBOARD_GRID_COLS, xs: 1 };

// Measure an element's CONTENT width (excludes padding) via ResizeObserver and
// keep it in state. Used to drive the report grid's proportional row height from
// the same width react-grid-layout lays out against, so both stay in lockstep on
// resize. Returns a ref-callback (re-attaches cleanly across the two mutually
// exclusive grid branches) + the latest measured width.
function useContentWidth(): [(node: HTMLElement | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const setRef = useCallback((node: HTMLElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (node && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const contentWidth = entries[0]?.contentRect?.width;
        if (typeof contentWidth === 'number' && contentWidth > 0) setWidth(contentWidth);
      });
      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [setRef, width];
}

type PageState = 'unknown' | 'loading' | 'password_gate' | 'reauth' | 'loaded' | 'error';

function areFiltersEquivalent(left: BaseFilter | null, right: BaseFilter | null): boolean {
  if (!left || !right) return false;
  return getFilterKey(left) === getFilterKey(right)
    && left.operator === right.operator
    && JSON.stringify(left.value) === JSON.stringify(right.value);
}

function formatFilterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ');
  }
  return String(value ?? '');
}

// Parse a #rgb/#rrggbb hex into an rgba() string. Used so the header brand
// mark + active page-tab chip can tint themselves from the REPORT's own
// accent colour (dashboard.theme_config.accent) instead of a fixed blue —
// the public surface then "ăn theo" whatever palette the author published.
function hexToRgbaString(hex: string | null | undefined, alpha: number): string | null {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Embed-only: report our content height to the parent frame so the host page
// can auto-size the <iframe> to fit its content (no inner scrollbar; the parent
// page scrolls). No-op when not embedded. Mirrors the old embed page's
// useEmbedHeight so host integrations keep receiving `appbi:resize`.
function useParentResize(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const report = () => {
      const height = document.documentElement.scrollHeight;
      try {
        window.parent.postMessage({ type: 'appbi:resize', height }, '*');
      } catch {
        // Cross-origin access can be blocked by the browser.
      }
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [enabled]);
}

function PasswordGate({
  onSubmit,
  error,
  submitting,
  isReauth = false,
}: {
  onSubmit: (password: string) => void;
  error: string | null;
  submitting: boolean;
  isReauth?: boolean;
}) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0 px-4 py-8">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="border-b border-[rgb(var(--border-line))] px-6 py-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Lock className="h-5 w-5" />
          </div>
          <p className="text-tiny font-emphasis uppercase tracking-[0.18em] text-text-quaternary">
            Protected shared report
          </p>
          <h1 className="mt-2 text-h3 font-emphasis text-text-primary">
            {isReauth ? 'Session expired' : 'Password protected'}
          </h1>
          <p className="mt-2 text-caption text-text-tertiary">
            {isReauth
              ? 'Your 2-hour session ended. Enter the password again to continue.'
              : 'This shared dashboard requires a password to view.'}
          </p>
        </div>

        <div className="px-6 py-6">
          <label className="mb-1.5 block text-caption font-emphasis text-text-secondary">Password</label>
          <Input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value) {
                onSubmit(value);
              }
            }}
            placeholder="Enter password"
            autoFocus
            trailingIcon={
              <button
                type="button"
                onClick={() => setShow((current) => !current)}
                className="pointer-events-auto text-text-tertiary hover:text-text-primary"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            }
          />

          {error && (
            <p className="mt-3 flex items-center gap-1 text-tiny text-danger">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </p>
          )}

          <Button
            variant="primary"
            fullWidth
            className="mt-5"
            onClick={() => value && onSubmit(value)}
            disabled={submitting || !value}
            leadingIcon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          >
            {submitting ? 'Verifying...' : isReauth ? 'Continue viewing' : 'Unlock dashboard'}
          </Button>

          <p className="mt-4 text-center text-tiny text-text-quaternary">
            Sessions last 2 hours and keep the report read-only.
          </p>
        </div>
      </div>
    </div>
  );
}

function SessionExpiredOverlay({ onReauth }: { onReauth: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-text-primary/20 px-4 pb-8 sm:items-center sm:pb-0">
      <div className="w-full max-w-md rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-6 py-6 text-center shadow-linear-lg">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-warning/10 text-warning">
          <RefreshCw className="h-5 w-5" />
        </div>
        <p className="text-tiny font-emphasis uppercase tracking-[0.18em] text-text-quaternary">
          Authentication needed
        </p>
        <h2 className="mt-2 text-h3 font-emphasis text-text-primary">Session expired</h2>
        <p className="mt-2 text-caption text-text-tertiary">
          Your 2-hour viewing session ended. Re-enter the password to continue.
        </p>
        <Button variant="primary" fullWidth className="mt-5" onClick={onReauth}>
          Re-enter password
        </Button>
      </div>
    </div>
  );
}

function getErrorMessage(error: any): string {
  return error?.response?.data?.detail ?? error?.message ?? 'Failed to load chart data.';
}

/**
 * Cap parallel chart requests so that 20+ tiles don't all queue against the
 * browser's HTTP/1.1 6-socket-per-host ceiling at once.
 *
 * Perf (2026-06-10): raised 4 → 8 after the BE per-tile cost dropped sharply
 * (cache-before-SQL-gen, no duplicate BQ dry-run, Sheets result cache). With
 * cheaper tiles, 4-in-flight under-utilised the server; 8 fills the pipeline
 * without starving later tiles. Modern browsers multiplex over HTTP/2, and the
 * public chart-data endpoint allows 300 req/min, so 8 concurrent stays well
 * within budget even on a 20-tile dashboard with filter re-fetches.
 */
/** Group dashboard tiles into their authored rows (same `y`), left to right. */
function groupTilesIntoRows(charts: DashboardChart[]): DashboardChart[][] {
  const sorted = [...charts].sort((a, b) => {
    const ay = a.layout?.y ?? 0;
    const by = b.layout?.y ?? 0;
    if (ay !== by) return ay - by;
    return (a.layout?.x ?? 0) - (b.layout?.x ?? 0);
  });
  const rows: DashboardChart[][] = [];
  let currentY: number | null = null;
  for (const chart of sorted) {
    const y = chart.layout?.y ?? 0;
    if (currentY === null || y !== currentY) {
      rows.push([chart]);
      currentY = y;
    } else {
      rows[rows.length - 1].push(chart);
    }
  }
  return rows;
}

const CHART_FETCH_CONCURRENCY = 8;
// PDF export retries a chart that failed to load before giving up and listing it
// as missing in the report. Warehouse hiccups (BQ rate limit, a Sheets quota
// blip) are transient; a one-shot fetch turned them into silently empty tiles.
const EXPORT_FETCH_ATTEMPTS = 3;
// Server-render polling: 1.2s is responsive without hammering the API, and a
// 15-minute ceiling is well past the worst dashboard we have seen render.
const SERVER_EXPORT_POLL_MS = 1200;
const SERVER_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Format the snapshot "data as of" timestamp for the public / embed header.
 *  Mirrors the BUILD view's format (dd/mm/yyyy hh:mm, locale-aware, no seconds
 *  / AM-PM noise) so the embedded report shows the update time the SAME way it
 *  looks in the builder — instead of the bare `toLocaleString()` US default.
 *  Returns '' for a missing/invalid value so the label never shows "Invalid Date". */
function formatSnapshotAsOf(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function PublicDashboardView({ variant = 'public' }: { variant?: 'public' | 'embed' }) {
  const params = useParams();
  const token = params.token as string;
  // Embed renders inside a host <iframe>: it grows to its content height and
  // reports that height to the parent (which then scrolls), instead of the
  // full-viewport app-shell the standalone /d page uses.
  const isEmbed = variant === 'embed';
  useParentResize(isEmbed);

  const [mounted, setMounted] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  // Perf #5 — report-level "data as of" so the viewer sees when the snapshot
  // numbers were last refreshed. (The "đang làm mới…" staleness hint was
  // removed from the public/embed header per product; we no longer track it.)
  const [snapshotAsOf, setSnapshotAsOf] = useState<string | null>(null);
  const [chartData, setChartData] = useState<Record<number, ChartDataResponse>>({});
  const [chartErrors, setChartErrors] = useState<Record<number, string>>({});
  // Mirrors of the two maps above. PDF export walks pages in a loop and must see
  // what the PREVIOUS iteration just fetched; a closure snapshot would report
  // every chart as "still missing" and refetch the whole report page by page.
  const chartDataRef = useRef<Record<number, ChartDataResponse>>({});
  const chartErrorsRef = useRef<Record<number, string>>({});
  useEffect(() => { chartDataRef.current = chartData; }, [chartData]);
  useEffect(() => { chartErrorsRef.current = chartErrors; }, [chartErrors]);
  // #2 — per-chart viewer date-hierarchy grain (BE re-query). State drives the
  // tile's active highlight; the ref is read inside the fetch callback so a
  // grain change doesn't have to be a useCallback dependency.
  const [chartGrains, setChartGrains] = useState<Record<number, string>>({});
  const chartGrainsRef = useRef<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [chartsLoading, setChartsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartLoadError, setChartLoadError] = useState<string | null>(null);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [pendingPageId, setPendingPageId] = useState<string | null>(null);
  const [draftViewerFilters, setDraftViewerFilters] = useState<BaseFilter[]>([]);
  const [appliedViewerFilters, setAppliedViewerFilters] = useState<BaseFilter[]>([]);
  // PBI parity (2026-06) — "Filters on this page" (pages_config[i].filters) are
  // AUTHOR-side Filter-Pane entries: on a public link they are NOT rendered as
  // viewer controls (the Filter Pane is hidden to viewers; only slicers are
  // interactive). They STILL constrain the active page's chart data, so we keep
  // them here and append to the chart-data request — never to the rendered
  // control bar. Reset per page so page A's filter never leaks onto page B.
  const [pageHiddenFilters, setPageHiddenFilters] = useState<BaseFilter[]>([]);
  const pageHiddenFiltersRef = useRef<BaseFilter[]>([]);
  useEffect(() => { pageHiddenFiltersRef.current = pageHiddenFilters; }, [pageHiddenFilters]);
  // Perf (Fix #10, 2026-06-10) — gate the FIRST chart fetch until the default
  // slicer/filter seed has run. Without this, a tile that became visible before
  // the seed effect fired a chart-data query with filters=[] (no default
  // filter), then the seed landed, cleared chartData, and re-fetched with the
  // real filters — i.e. EVERY tile ran a throwaway 8-17s BigQuery query on a
  // dashboard that has a default filter (prod log: chart 824 filters=0 then
  // filters=1 then filters=2). Starts false; the seed effect flips it true in
  // the same render that sets appliedViewerFilters, so the fetch effect then
  // runs ONCE with the correct filters. An unfiltered dashboard seeds to [] and
  // still flips the flag, so it fetches normally — just never with stale [].
  const [filtersSeeded, setFiltersSeeded] = useState(false);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);
  const [crossFilterState, setCrossFilterState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  // C4 anti-spam — see authed page. Drops accidental rapid re-clicks on a
  // selection so they don't thrash the per-page chart fetch or toggle-clear it.
  const lastCrossFilterAtRef = useRef(0);
  // Cross-highlight (PBI-parity) — opt-in per dashboard via theme_config. When
  // mode='highlight', a data-point click sets THIS (not crossFilterState), so
  // the baseline (viewer + link + page-scope filters) stays applied and the
  // selection is a visual overlay only. `highlightChartData` holds the parallel
  // P-filtered fetch per target chart.
  const [highlightState, setHighlightState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  const [highlightChartData, setHighlightChartData] = useState<Record<number, ChartDataResponse>>({});
  const [pageState, setPageState] = useState<PageState>('unknown');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // WHICH export is running. 'snapshot' (the default) only needs lazy tiles
  // rendered; 'full' additionally expands every table to all its rows. Kept
  // separate from `isExportingPdf` so the render mode is explicit at the
  // provider rather than inferred from a boolean.
  const [exportRenderMode, setExportRenderMode] = useState<ExportRenderMode>(false);
  // PRINT MODE — the surface the server-side render worker loads
  // (`/d/<token>?print=1&page=<id>&filters=<base64>`). It strips every piece of
  // chrome (masthead, tabs, slicer bar, AI bot, export button), forces export
  // mode so tables render all rows, pins the requested page + viewer filters,
  // and finally sets `window.__APPBI_PDF_READY__` so Chromium knows the page is
  // safe to print. Rendering the REAL view (not a parallel "print component")
  // is deliberate: the printed report can never drift from what the viewer saw,
  // and the page-scope filter rules have exactly one implementation.
  const [printOptions, setPrintOptions] = useState<PrintRenderOptions | null>(null);
  const printMode = printOptions !== null;
  // The worker renders this page for a job; the job's layout decides whether
  // tables must expand. Snapshot is the default, matching the dialog.
  const printRenderMode: ExportRenderMode = printMode
    ? (printOptions?.layout === 'full' ? 'full' : 'snapshot')
    : false;
  const printFiltersAppliedRef = useRef(false);
  const printReadyRef = useRef(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [exportProgress, setExportProgress] = useState<PdfProgress | null>(null);
  // Is a render worker deployed? Probed once; false → the in-browser exporter
  // stays the engine, so a stack without the pdf-worker container behaves
  // exactly as it did before the server engine existed.
  const [serverExportReady, setServerExportReady] = useState(false);
  const exportJobIdRef = useRef<string | null>(null);
  // Chart ids that have entered the viewport at least once. Tiles report visibility
  // via onVisible; the fetch effect uses this set to gate which charts to request.
  const [visibleChartIds, setVisibleChartIds] = useState<Set<number>>(() => new Set());
  const [forceVisibleAll, setForceVisibleAll] = useState(false);
  const publicContentRef = useRef<HTMLElement>(null);
  const gridSectionRef = useRef<HTMLElement>(null);
  // "Fit to width": measure the grid wrapper and scale the react-grid row height
  // with it, so tiles keep their authored aspect ratio from phone to TV. The
  // ref-callback attaches to whichever of the two grid branches is mounted.
  const [gridMeasureRef, gridWidth] = useContentWidth();
  // Finer grid: row height couples to the theme gap so the ×3-migrated layout
  // renders pixel-identical to the builder (see dashboardRowHeight).
  const reportRowHeight = computeReportRowHeight(gridWidth, getDashboardGridMargin(dashboard?.theme_config)[1]);

  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartRequestIdRef = useRef(0);
  // True for the whole duration of a PDF export. Export takes over page
  // switching + data fetching, so the reactive effects (slicer seed, page
  // fetch, viewport fetch, highlight refetch) must stand down — otherwise they
  // race the exporter, bump chartRequestIdRef and make it discard the very
  // response it is waiting for. A ref (not state) because the effects need the
  // value in the same tick the export sets it.
  const exportInProgressRef = useRef(false);
  const skipNextPageLoadRef = useRef<string | null>(null);
  const skipCrossFilterRefreshRef = useRef<string | null>(null);
  const appliedFilterSignatureRef = useRef(JSON.stringify([] as BaseFilter[]));
  const seededFiltersForTokenRef = useRef<string | null>(null);
  // Phase-15.81 v6 — keep a ref of the current applied filters so the
  // seed effect (which intentionally excludes appliedViewerFilters from
  // deps to avoid a loop) reads a fresh value on page switch instead of
  // a stale closure snapshot.
  const appliedViewerFiltersRef = useRef<BaseFilter[]>([]);
  useEffect(() => {
    appliedViewerFiltersRef.current = appliedViewerFilters;
  }, [appliedViewerFilters]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPrintOptions(parsePrintRenderOptions(window.location.search));
  }, []);

  const clearSessionTimer = useCallback(() => {
    if (sessionTimerRef.current) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  }, []);

  const scheduleSessionExpiry = useCallback((linkToken: string) => {
    clearSessionTimer();
    const remaining = publicSessionRemainingSeconds(linkToken);
    if (remaining <= 0) return;
    sessionTimerRef.current = setTimeout(() => {
      clearPublicSession(linkToken);
      setPageState('reauth');
    }, remaining * 1000);
  }, [clearSessionTimer]);

  useEffect(() => () => clearSessionTimer(), [clearSessionTimer]);

  const loadDashboard = useCallback(async (sessionToken?: string) => {
    setPageState('loading');
    setLoading(true);
    setError(null);
    // Fix #10: re-gate the fetch for the (re)loaded dashboard — the seed effect
    // flips this back to true once it computes this dashboard's default filters.
    setFiltersSeeded(false);

    try {
      // Finer-grid lazy upscale: legacy (12-col) tiles are scaled ×3 for render
      // so the published report matches the builder without any data migration.
      const nextDashboard = normalizeDashboardGridForRender(await publicDashboardApi.get(token, sessionToken));
      setDashboard(nextDashboard ?? null);
      setPageState('loaded');
      // Fire-and-forget: fetch the report-level snapshot freshness for the
      // "data as of" label (never blocks the dashboard render).
      publicDashboardApi
        .getSnapshotInfo(token, sessionToken)
        .then((info) => { setSnapshotAsOf(info?.as_of ?? null); })
        .catch(() => { /* live / not materialized → no label */ });
      if (sessionToken) {
        scheduleSessionExpiry(token);
      }
    } catch (err: any) {
      if (err?.response?.status === 401) {
        setPageState('password_gate');
      } else {
        setError(getErrorMessage(err));
        setPageState('error');
      }
    } finally {
      setLoading(false);
    }
  }, [scheduleSessionExpiry, token]);

  useEffect(() => {
    if (printMode) setForceVisibleAll(true);
  }, [printMode]);

  useEffect(() => {
    if (!token || pageState !== 'loaded' || printMode) return;
    let cancelled = false;
    publicDashboardApi
      .getExportCapabilities(token, getPublicSession(token) ?? undefined)
      .then((caps) => { if (!cancelled) setServerExportReady(Boolean(caps?.server_engine)); })
      .catch(() => { /* older backend / no worker → keep the browser engine */ });
    return () => { cancelled = true; };
  }, [token, pageState, printMode]);

  useEffect(() => {
    if (!token) return;
    setMounted(true);
    const storedSession = getPublicSession(token);
    loadDashboard(storedSession ?? undefined);
  }, [loadDashboard, token]);

  const dashboardPages = useMemo(
    () => normalizeDashboardPages(dashboard?.pages_config),
    [dashboard?.pages_config],
  );
  const activePageId = useMemo(
    () => ensureDashboardPageId(dashboardPages, currentPageId),
    [currentPageId, dashboardPages],
  );
  const visibleDashboardCharts = useMemo(
    () => getDashboardChartsForPage(dashboard?.dashboard_charts, activePageId),
    [activePageId, dashboard?.dashboard_charts],
  );

  // Phase-F (PBI-parity rework) — collect filter entries with
  // `publicMode === 'locked'` for the banner row. Locked entries are
  // applied at the chart-data layer (BE enforces) but the viewer is
  // shown a read-only "ⓘ Đang lọc theo …" line so they understand
  // the data scope. `hidden` entries do not appear here by design —
  // see docs/filter-semantics.md §2.2/§9.
  const lockedBannerEntries = useMemo(() => {
    const result: { field: string; label?: string; value: any }[] = [];
    const collect = (entries: any[]) => {
      for (const e of entries || []) {
        if (!e || typeof e !== 'object') continue;
        const mode = e.publicMode ?? 'visible';
        if (mode !== 'locked') continue;
        if (e.showBanner === false) continue;
        result.push({ field: e.field, label: e.label, value: e.value });
      }
    };
    if (dashboard) {
      collect((dashboard as any).filters_config || []);
      const page = dashboardPages.find((p) => p.id === activePageId);
      if (page) {
        collect((page as any).filters || []);
      }
    }
    return result;
  }, [dashboard, dashboardPages, activePageId]);

  // Phase-F THẬT (PBI-parity rework) — override-allowed filters list
  // for the "Xem chi tiết" mini-pane. Entries with publicMode='visible'
  // and allowOverride=true are editable by the viewer (the BE merger
  // routes their values as `viewer_filter` layer, which overrides
  // dashboard defaults but loses to `link_locked`).
  const overridableFilterEntries = useMemo(() => {
    const result: { field: string; label?: string; value: any; semanticField?: string; type?: string }[] = [];
    const collect = (entries: any[]) => {
      for (const e of entries || []) {
        if (!e || typeof e !== 'object') continue;
        const mode = e.publicMode ?? 'visible';
        if (mode !== 'visible') continue;
        if (!e.allowOverride) continue;
        result.push({ field: e.field, label: e.label, value: e.value, semanticField: e.semanticField, type: e.type });
      }
    };
    if (dashboard) {
      collect((dashboard as any).filters_config || []);
      const page = dashboardPages.find((p) => p.id === activePageId);
      if (page) {
        collect((page as any).filters || []);
      }
    }
    return result;
  }, [dashboard, dashboardPages, activePageId]);

  // Mini-pane open/close state. Only relevant when there's at least
  // one locked entry OR one override-allowed entry — otherwise the
  // [Xem chi tiết] button never renders.
  const [isMiniPaneOpen, setIsMiniPaneOpen] = useState(false);

  useEffect(() => {
    if (currentPageId !== activePageId) {
      setCurrentPageId(activePageId);
    }
  }, [activePageId, currentPageId]);

  useEffect(() => {
    const nextSignature = JSON.stringify(appliedViewerFilters);
    if (appliedFilterSignatureRef.current === nextSignature) {
      return;
    }
    appliedFilterSignatureRef.current = nextSignature;
    setChartData({});
    setChartErrors({});
  }, [appliedViewerFilters]);

  // Phase-15.81 — Slicer seed.
  //
  // Two filter mechanisms (see backend public.py docstring on
  // _get_share_dashboard for the full taxonomy):
  //
  //   A. DA-authored slicers (top-bar, viewer-editable):
  //        dashboard.public_filters_config (now mirrors dash.filters_config
  //        = all-pages set from the editor FilterPane), PLUS the active
  //        page's pages_config[i].filters when switching pages.
  //
  //   B. Per-link hidden constraints (silent WHERE, viewer never sees):
  //        dashboard.public_link_hidden_filters — these are merged in the
  //        chart-data fetcher, not surfaced to the slicer bar.
  //
  // Seed runs once per token then re-runs when the active page changes
  // (so switching to "page-b" surfaces its per-page slicers without
  // wiping the all-pages chips). Custom values the viewer typed since
  // the last seed are merged on top via fieldKey, so changing pages
  // doesn't drop their in-session selections.
  useEffect(() => {
    if (!dashboard || !token) return;
    // Phase-C (PBI-parity rework) — the top-bar slicer surface now
    // reads `dashboard.slicers_config` (Phase-A new column) when
    // present. Filter-pane entries from `filters_config` ALSO surface
    // here when their `publicMode` is 'visible' (default) so authors
    // who haven't yet promoted to slicers still get the same viewer
    // experience. Entries with publicMode='locked' or 'hidden' fall
    // through to chart-data without rendering as slicers — locked
    // ones will surface in the banner row (Phase F), hidden ones
    // never surface at all.
    //
    // Legacy fallback: pre-Phase-A dashboards still send
    // `public_filters_config` only. Treat that as the slicer source
    // so old shared links keep working.
    // Export freezes the filter state: while a PDF export is running IT drives
    // page switching + fetching with an explicitly resolved per-page context
    // (see doExportPdf). Re-seeding here on every programmatic page switch would
    // rewrite appliedViewerFilters mid-export → the signature effect below wipes
    // chartData → already-captured tiles blank out. Snapshot semantics: what the
    // viewer had applied when they pressed Export is what the whole PDF shows.
    if (exportInProgressRef.current) return;
    // Single source of truth for "which filters does page X carry" lives in
    // lib/public-page-filters (pure). Extracted from this effect so PDF export
    // can resolve ANOTHER page's context synchronously, without waiting for a
    // re-render of this one — see the page-filter A/B bug documented there.
    const { controlSeed, hiddenFilters } = resolvePublicPageFilterContext(
      dashboard as unknown as Record<string, unknown>,
      dashboardPages,
      activePageId,
    );
    // "Filters on this page" + filter-only scoped slicers → constrain the
    // ACTIVE page's chart data but stay hidden from the control bar. Reset per
    // page (active page only), so a page A filter never leaks onto page B.
    setPageHiddenFilters(hiddenFilters);
    // De-dupe by fieldKey. On token change we reset; on page switch we preserve
    // the viewer's edits for fields still present in the new control seed.
    const isFirstSeed = seededFiltersForTokenRef.current !== token;
    seededFiltersForTokenRef.current = token;
    // Preserve the viewer's edits for any field the new page still offers;
    // otherwise fall back to the (possibly newly added) seed. Reads from the ref
    // (not the closure) so a fast page switch right after an edit doesn't drop
    // the just-typed selection.
    const merged: BaseFilter[] = mergeSeedWithViewerSelections(
      controlSeed,
      isFirstSeed ? [] : appliedViewerFiltersRef.current,
    );
    setDraftViewerFilters(merged);
    setAppliedViewerFilters(merged);
    appliedFilterSignatureRef.current = JSON.stringify(merged);
    // Fix #10: default filters are now resolved → release the fetch gate. The
    // fetch effect re-runs after this render with the seeded appliedViewerFilters.
    setFiltersSeeded(true);
  }, [dashboard, token, activePageId, dashboardPages]);

  useEffect(() => {
    if (!crossFilterState) return;
    const sourceExists = visibleDashboardCharts.some(
      (dashboardChart) => dashboardChart.chart_id === crossFilterState.sourceChartId,
    );
    if (!sourceExists) {
      setCrossFilterState(null);
    }
  }, [crossFilterState, visibleDashboardCharts]);

  // Highlight is the DEFAULT click interaction (matches the authed builder);
  // per-chart opt-out via layout.highlightEnabled. Only explicit 'off' falls
  // back to legacy cross-filter.
  const interactionsMode: 'off' | 'highlight' =
    ((dashboard as any)?.theme_config?.interactions?.mode === 'off') ? 'off' : 'highlight';

  const handleCrossFilterChange = useCallback((sourceChartId: number, filter: BaseFilter | null) => {
    // One selection (PBI parity): SOURCE chart dims its non-selected marks,
    // every OTHER chart FILTERS to the clicked value (fetchChartsForPage adds it
    // to the target queries). A null emit (click on empty chart space) clears
    // unconditionally → reverts to the viewer's baseline; the page/locked/slicer
    // filters (appliedViewerFilters) are separate and untouched.
    // C4 anti-spam (see authed page for the full why) — an accidental
    // double-click fires twice ~130ms apart; the 2nd lands after the source
    // re-rendered and the empty-space handler emits a `null` CLEAR that would
    // wipe the selection. Debounce BOTH a rapid re-select and a rapid clear
    // within 300ms of the last selection. Explicit Clear + deliberate
    // (>300ms) clears/re-targets are unaffected.
    {
      const now = Date.now();
      if (now - lastCrossFilterAtRef.current < 300) return;
      if (filter) lastCrossFilterAtRef.current = now;
    }
    setCrossFilterState((current) => {
      if (!filter) {
        return null;
      }
      if (
        current?.sourceChartId === sourceChartId
        && areFiltersEquivalent(current.filter, filter)
      ) {
        return null;
      }
      return { sourceChartId, filter };
    });
  }, []);

  const fetchChartsForPage = useCallback(async (
    pageId: string,
    sessionToken?: string,
    pageCrossFilterState: typeof crossFilterState = crossFilterState,
    options?: {
      chartIds?: number[];
      force?: boolean;
      /**
       * Filter context to use INSTEAD of the live state. PDF export resolves the
       * target page's own context up-front (lib/public-page-filters) and passes
       * it here: reading `pageHiddenFiltersRef` would give page A's page-scope
       * filters while fetching page B's charts (the state hasn't re-seeded yet),
       * which silently exported the wrong slice of data.
       */
      viewerFilters?: BaseFilter[];
      hiddenFilters?: BaseFilter[];
      /** Don't touch the shared loading/error banners (export drives its own UI). */
      silent?: boolean;
    },
  ): Promise<{ ok: boolean; failed: number[] }> => {
    if (!dashboard) return { ok: false, failed: [] };

    const requestId = ++chartRequestIdRef.current;
    const allCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId)
      // Non-chart widgets (text/image/countdown/shape/parameter_switcher) carry no
      // chart_id and never need a /charts/{id}/data round-trip.
      .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id);
    // When chartIds is supplied (lazy viewport mode), only fetch those tiles.
    const targetCharts = options?.chartIds
      ? allCharts.filter((dc) => options.chartIds!.includes(dc.chart_id))
      : allCharts;

    if (!options?.silent) {
      setChartsLoading(true);
      setChartLoadError(null);
    }

    if (!targetCharts.length) {
      if (!options?.silent) {
        setChartsLoading(false);
        setIsApplyingFilters(false);
      }
      return { ok: true, failed: [] };
    }

    try {
      // Phase-H — the chart-data request now sends ONLY the viewer's
      // interactive choices (top-bar slicers/filters + an optional
      // cross-filter). The link's own filters (locked + hidden) are
      // applied SERVER-SIDE by _build_public_chart_filters from
      // DashboardPublicLink.filters_config — the FE no longer re-sends
      // `public_link_hidden_filters`. Re-sending them used to double-feed
      // the merge (link entries landed in the viewer_slicer layer AND the
      // link_locked/link_hidden layers), which was fragile and could let
      // the viewer-layer copy fight the authoritative link layer.
      // "1 request = 1 page": compute each tile's viewer filters (same rules as
      // before — cross-filter source/target + page-scope HARD BOUND via
      // `applyScopeBound`, so a same-field slicer can only NARROW within the
      // page scope, never escape it), then fetch ALL of them in ONE batch call.
      // The server resolves dashboard+link+filters once and fans out the queries
      // concurrently, so this is byte-identical to the old per-chart loop but
      // without N round-trips / the browser's per-host socket queue.
      const viewerFilterSet = options?.viewerFilters ?? appliedViewerFilters;
      const hiddenFilterSet = options?.hiddenFilters ?? pageHiddenFiltersRef.current;
      const batchItems = targetCharts.map((dashboardChart) => {
        const baseViewerFilters = pageCrossFilterState?.sourceChartId === dashboardChart.chart_id
          ? viewerFilterSet
          : pageCrossFilterState
            ? [...viewerFilterSet, pageCrossFilterState.filter]
            : viewerFilterSet;
        return {
          chart_id: dashboardChart.chart_id,
          filters: applyScopeBound(baseViewerFilters, hiddenFilterSet),
          granularity: chartGrainsRef.current[dashboardChart.chart_id],
        };
      });

      type BatchEntry = { chartId: number; data: any; error: string | null; status?: number };
      let entries: BatchEntry[];
      try {
        const resp = await publicDashboardApi.getChartsDataBatch(token, sessionToken, batchItems);
        const byId = new Map<number, { data?: any; error?: string; status?: number }>();
        for (const r of resp.results || []) byId.set(r.chart_id, r);
        entries = targetCharts.map((dc) => {
          const r = byId.get(dc.chart_id);
          if (r && r.data) return { chartId: dc.chart_id, data: r.data, error: null };
          return {
            chartId: dc.chart_id,
            data: null,
            error: r?.error || 'Could not load this chart.',
            status: r?.status,
          };
        });
      } catch (err: any) {
        // A 401 means the whole (password-gated) link session expired — reauth,
        // exactly like the old per-chart path did on a 401 entry.
        if (err?.response?.status === 401) {
          if (requestId === chartRequestIdRef.current) {
            clearPublicSession(token);
            setPageState('reauth');
          }
          return { ok: false, failed: targetCharts.map((dc) => dc.chart_id) };
        }
        // Whole-batch transport failure → mark every target tile errored so the
        // page shows the error state instead of an infinite spinner.
        const msg = getErrorMessage(err);
        entries = targetCharts.map((dc) => ({ chartId: dc.chart_id, data: null, error: msg }));
      }

      if (requestId !== chartRequestIdRef.current) {
        return { ok: false, failed: [] };
      }

      const unauthorized = entries.find((entry) => (entry as any).status === 401);
      if (unauthorized) {
        clearPublicSession(token);
        setPageState('reauth');
        return { ok: false, failed: targetCharts.map((dc) => dc.chart_id) };
      }

      // Update the refs SYNCHRONOUSLY as well as the state: a caller that awaits
      // this call (PDF export) needs the result before React commits, both to
      // report the real per-chart error message and to avoid refetching what it
      // just loaded.
      const nextData = { ...chartDataRef.current };
      const nextErrors = { ...chartErrorsRef.current };
      for (const entry of entries) {
        if (entry.data) nextData[entry.chartId] = entry.data;
        else delete nextData[entry.chartId];
        if (entry.error) nextErrors[entry.chartId] = entry.error;
        else delete nextErrors[entry.chartId];
      }
      chartDataRef.current = nextData;
      chartErrorsRef.current = nextErrors;
      setChartData(nextData);
      setChartErrors(nextErrors);

      const failed = entries.filter((entry) => entry.error).map((entry) => entry.chartId);
      if (failed.length && !options?.silent) {
        setChartLoadError('Some charts could not be loaded in this shared view.');
      }
      if (sessionToken) {
        scheduleSessionExpiry(token);
      }
      return { ok: failed.length === 0, failed };
    } finally {
      if (requestId === chartRequestIdRef.current && !options?.silent) {
        setChartsLoading(false);
        setIsApplyingFilters(false);
      }
    }
  }, [appliedViewerFilters, crossFilterState, dashboard, dashboardPages, activePageId, scheduleSessionExpiry, token]);

  // Cross-highlight (public): when a selection is active, fetch a PARALLEL
  // P-filtered dataset per TARGET chart (baseline viewer/page filters + the
  // selection), stored separately so the baseline tiles keep their full data
  // and the renderer overlays the highlighted portion. Source tile dims locally
  // (no fetch). Gated on interactionsMode='highlight' (opt-in) so existing
  // public links are byte-for-byte unchanged.
  useEffect(() => {
    // Same stand-down as the page-fetch effect: during export the page id changes
    // programmatically, and a highlight overlay refetch would compete with the
    // exporter's batch (and capture a half-applied highlight).
    if (exportInProgressRef.current) return;
    if (interactionsMode !== 'highlight' || !highlightState || !dashboard) {
      setHighlightChartData((cur) => (Object.keys(cur).length ? {} : cur));
      return;
    }
    const session = getPublicSession(token);
    const targets = getDashboardChartsForPage(dashboard.dashboard_charts, activePageId)
      .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id && dc.chart_id !== highlightState.sourceChartId)
      // Per-chart opt-out: don't fetch a highlight overlay for tiles the author
      // turned off (they render their baseline unchanged).
      .filter((dc) => (dc.layout as any)?.highlightEnabled !== false);
    let cancelled = false;
    (async () => {
      const entries = await runWithConcurrency(
        targets,
        async (dc) => {
          const requestFilters = applyScopeBound(
            [...appliedViewerFilters, highlightState.filter],
            pageHiddenFiltersRef.current,
          );
          try {
            const data = await publicDashboardApi.getChartData(
              token, dc.chart_id, session ?? undefined, requestFilters, chartGrainsRef.current[dc.chart_id],
            );
            return { chartId: dc.chart_id, data };
          } catch {
            return { chartId: dc.chart_id, data: null };
          }
        },
        CHART_FETCH_CONCURRENCY,
      );
      if (cancelled) return;
      const map: Record<number, ChartDataResponse> = {};
      for (const e of entries) if (e.data) map[e.chartId] = e.data as ChartDataResponse;
      setHighlightChartData(map);
    })();
    return () => { cancelled = true; };
  }, [highlightState, interactionsMode, activePageId, appliedViewerFilters, dashboard, token]);

  // Drop the highlight when its source tile leaves the page; clear the unused
  // interaction state when the mode flips, so they never overlap.
  useEffect(() => {
    if (!highlightState || !dashboard) return;
    const exists = getDashboardChartsForPage(dashboard.dashboard_charts, activePageId)
      .some((dc) => dc.chart_id === highlightState.sourceChartId);
    if (!exists) setHighlightState(null);
  }, [activePageId, dashboard, highlightState]);
  useEffect(() => {
    if (interactionsMode === 'highlight') setCrossFilterState(null);
    else setHighlightState(null);
  }, [interactionsMode]);

  // #2 — public viewer date-hierarchy: change a chart's grain and re-fetch it
  // from the BE at that bucket (works on pre-aggregated charts). The grain ref
  // is read inside fetchChartsForPage's getChartData call.
  const handleChartDrill = useCallback((chartId: number, grain: string | undefined) => {
    const next = { ...chartGrainsRef.current };
    if (grain) next[chartId] = grain; else delete next[chartId];
    chartGrainsRef.current = next;
    setChartGrains(next);
    fetchChartsForPage(activePageId, getPublicSession(token) ?? undefined, undefined, { chartIds: [chartId] });
  }, [activePageId, token, fetchChartsForPage]);

  useEffect(() => {
    if (!dashboard || pageState !== 'loaded') return;
    // Export owns the fetch loop while it runs (it walks every selected page and
    // resolves that page's filters itself). Letting this effect also fire on the
    // programmatic page switch would start a SECOND batch that bumps
    // chartRequestIdRef — the exporter's own in-flight response then fails the
    // `requestId === current` check and its data is thrown away, so the tile is
    // captured empty.
    if (exportInProgressRef.current) return;
    // Fix #10: hold the first fetch until default filters are seeded, so a tile
    // doesn't fire a throwaway query with empty filters that the seed then
    // invalidates. Once seeded, this effect re-runs (filtersSeeded is a dep) and
    // fetches once with the correct filters.
    if (!filtersSeeded) return;
    if (skipNextPageLoadRef.current === activePageId) {
      skipNextPageLoadRef.current = null;
      return;
    }
    if (!crossFilterState && skipCrossFilterRefreshRef.current === activePageId) {
      skipCrossFilterRefreshRef.current = null;
      return;
    }
    // Lazy mode: only fetch tiles that have already entered the viewport.
    // The visibility effect below picks up the rest as the user scrolls.
    const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, activePageId)
      .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id);
    // forceVisibleAll (PDF export / print render) means "every tile counts as
    // visible" — otherwise the viewport gate would starve off-screen tiles and
    // the printed report would come out empty below the fold.
    const lazyIds = targetCharts
      .map((dc) => dc.chart_id)
      .filter((id) => forceVisibleAll || visibleChartIds.has(id));
    if (lazyIds.length === 0) {
      // Nothing visible yet (initial mount before IntersectionObserver fires).
      // Skip — the visibility effect will trigger fetch as tiles report in.
      return;
    }
    const storedSession = getPublicSession(token);
    fetchChartsForPage(activePageId, storedSession ?? undefined, crossFilterState, {
      chartIds: lazyIds,
    });
  }, [activePageId, crossFilterState, dashboard, fetchChartsForPage, filtersSeeded, forceVisibleAll, pageState, token, visibleChartIds]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const { session_token, expires_in } = await publicDashboardApi.auth(token, password);
      savePublicSession(token, session_token, expires_in);
      await loadDashboard(session_token);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403) {
        setAuthError('Incorrect password. Please try again.');
      } else if (status === 410) {
        setAuthError('This shared link has expired.');
      } else {
        setAuthError(getErrorMessage(err));
      }
      setPageState('password_gate');
    } finally {
      setAuthSubmitting(false);
    }
  }, [loadDashboard, token]);

  const handleReauth = useCallback(() => {
    setPageState('password_gate');
    setAuthError(null);
  }, []);

  // Phase-B22 — human-readable summary of the slicers/filters the viewer has
  // applied, baked into each PDF page header so an exported report says which
  // slice of data it represents.
  const summarizeViewerFilters = useCallback((): string => {
    if (!appliedViewerFilters.length) return '';
    return appliedViewerFilters
      .map((f) => {
        const label = getFilterDisplayLabel(f);
        const val = formatFilterValue((f as { value?: unknown }).value);
        return val ? `${label}: ${val}` : label;
      })
      .filter(Boolean)
      .join(' · ');
  }, [appliedViewerFilters]);

  /**
   * Server-side export: hand the request to the render worker and poll.
   *
   * Everything heavy (opening each page, waiting for charts, printing) happens
   * in a Chromium container, so the viewer's tab is free after ~1 request and
   * the file is identical no matter what machine asked for it. Returns false
   * when the job could not be completed — the caller then falls back to the
   * in-browser engine rather than leaving the user with nothing.
   */
  const runServerExport = useCallback(async (
    choices: ExportPdfChoices,
    previewWindow: Window | null,
  ): Promise<boolean> => {
    if (!dashboard) return false;
    // The arranged layout is rendered in the browser in P1: the worker prints the
    // report's own print route, which knows nothing about a hand-made plan. Sending
    // it there would quietly produce the ordinary layout instead of the one the
    // user just arranged — worse than being a little slower.
    if (choices.layout === 'custom') return false;
    const session = getPublicSession(token) ?? undefined;
    const pageNameById = new Map(dashboardPages.map((p) => [p.id, p.name]));
    const chosen = choices.pageIds.length ? choices.pageIds : [activePageId];
    let job;
    try {
      job = await publicDashboardApi.createExportJob(token, session, {
        pages: chosen,
        orientation: choices.orientation,
        page_format: choices.format,
        layout: choices.layout,
        filters: appliedViewerFiltersRef.current,
        session,
      });
    } catch (err: any) {
      if (err?.response?.status === 429) {
        toast.error('Đã vượt giới hạn xuất PDF', {
          description: err?.response?.data?.detail || 'Vui lòng thử lại sau ít phút.',
        });
        return true; // a quota rejection is an answer, not a reason to re-render locally
      }
      return false;
    }
    exportJobIdRef.current = job.id;
    setExportProgress({ phase: 'prepare', ratio: 0.02, message: job.message || 'Đã xếp hàng chờ xử lý…' });

    const deadline = Date.now() + SERVER_EXPORT_TIMEOUT_MS;
    let current = job;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SERVER_EXPORT_POLL_MS));
      try {
        current = await publicDashboardApi.getExportJob(token, job.id, session);
      } catch {
        continue; // a dropped poll is not a failed render
      }
      setExportProgress({
        phase: current.status === 'queued' ? 'prepare' : 'page',
        ratio: Math.max(0.02, Math.min(0.99, (current.progress ?? 0) / 100)),
        message: current.message || 'Đang dựng báo cáo trên máy chủ…',
      });
      if (['succeeded', 'partial', 'failed', 'cancelled'].includes(current.status)) break;
    }
    exportJobIdRef.current = null;

    if ((current.status === 'succeeded' || current.status === 'partial') && current.download_token) {
      const url = publicDashboardApi.exportDownloadUrl(token, current.id, current.download_token);
      // Same delivery as the browser engine: download the file, and only show
      // it in a tab when the (default-off) preview switch handed us one.
      try {
        if (PDF_PREVIEW_TAB_ENABLED && previewWindow && !previewWindow.closed) {
          previewWindow.location.href = url;
        }
      } catch { /* noop */ }
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safePdfFilename(dashboard.public_link_name || dashboard.name, 'bao-cao')}.pdf`;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setExportProgress({ phase: 'done', ratio: 1, message: 'Hoàn tất — đã tải PDF về máy.' });
      if (current.warnings?.length) {
        toast.warning(`PDF thiếu ${current.warnings.length} phần`, {
          description: `${current.warnings.slice(0, 3).map((w) => w.chart).join(', ')} — phần thiếu được ghi trong báo cáo.`,
        });
      }
      return true;
    }
    if (current.status === 'cancelled') return true;
    return false;
  }, [activePageId, dashboard, dashboardPages, token]);

  // Hybrid export (tables = real text + links, charts = sharp image), driven by
  // the pre-export dialog.
  //
  // Export is a SNAPSHOT: the viewer's filters at click time are frozen
  // (exportInProgressRef makes the reactive effects stand down) and every page is
  // fetched with ITS OWN resolved filter context, so a multi-page PDF can no
  // longer mix page A's page-scope filters into page B's numbers.
  const doExportPdf = useCallback(async (choices: ExportPdfChoices) => {
    if (!dashboard) return;
    // Open the preview tab NOW, synchronously inside the export click, so the
    // popup blocker (which fires once the seconds-long capture has spent the
    // user activation) doesn't eat it. We fill it with the PDF when ready.
    const previewWindow = openPdfPreviewTab();
    exportInProgressRef.current = true;
    setIsExportingPdf(true);
    setExportRenderMode(choices.layout === 'snapshot' ? 'snapshot' : 'full');
    setExportProgress({ phase: 'prepare', ratio: 0, message: 'Đang chuẩn bị…' });

    // Preferred path: let the server render it. Falls through to the in-browser
    // engine when no worker is deployed or the job could not be completed, so
    // the button never dead-ends.
    if (serverExportReady) {
      try {
        const done = await runServerExport(choices, previewWindow);
        if (done) {
          exportInProgressRef.current = false;
          setIsExportingPdf(false);
          setIsExportDialogOpen(false);
          setExportProgress(null);
          return;
        }
        toast.info('Chuyển sang xuất tại trình duyệt', {
          description: 'Máy chủ dựng PDF không phản hồi, đang tạo file ngay trên trình duyệt của bạn.',
        });
      } catch (err) {
        console.error('server PDF export failed', err);
      }
    }
    // Disable lazy gating during export so every tile renders, including
    // off-screen ones. Fetch any not-yet-loaded chart data per page below.
    setForceVisibleAll(true);
    const originalPageId = activePageId;
    // Frozen inputs for the whole run (state keeps moving after we finish).
    const frozenViewerFilters = appliedViewerFiltersRef.current;
    const frozenCharts = dashboard.dashboard_charts ?? [];
    const chartNameById = new Map<number, string>(
      frozenCharts
        .filter((dc) => dc.chart_id)
        .map((dc) => [dc.chart_id, dc.chart?.name || `Biểu đồ #${dc.chart_id}`] as [number, string]),
    );
    // Charts that never produced data → listed in the PDF + the toast instead of
    // silently exporting an empty tile.
    const failures: PdfExportWarning[] = [];
    try {
      const safeName = safePdfFilename(dashboard.public_link_name || dashboard.name, 'bao-cao');
      const storedSession = getPublicSession(token) ?? undefined;
      const filtersSummary = summarizeViewerFilters();

      // Fetch every chart of `pageId` with THAT page's filter context, retrying
      // the ones that fail; whatever is still broken is recorded as a warning.
      const ensurePageDataLoaded = async (pageId: string, pageName: string) => {
        const targetCharts = getDashboardChartsForPage(frozenCharts, pageId)
          .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id);
        if (targetCharts.length === 0) return;
        const { controlSeed, hiddenFilters } = resolvePublicPageFilterContext(
          dashboard as unknown as Record<string, unknown>,
          dashboardPages,
          pageId,
        );
        // The viewer's live selections still win for fields this page offers —
        // same rule as switching to the page by hand.
        const viewerFilters = mergeSeedWithViewerSelections(controlSeed, frozenViewerFilters);
        // Read the CURRENT data map (not a closure snapshot): earlier pages of
        // this same export have already written into it.
        let pending = targetCharts
          .map((dc) => dc.chart_id)
          .filter((id) => !chartDataRef.current[id]);
        // The snapshot export exists to be fast: it takes ONE shot at a failed
        // chart and lists what is missing, rather than spending seconds of
        // backoff per tile. The full-data export keeps retrying.
        const attempts = choices.layout === 'snapshot' ? 1 : EXPORT_FETCH_ATTEMPTS;
        for (let attempt = 0; pending.length > 0 && attempt < attempts; attempt++) {
          if (attempt > 0) {
            setExportProgress({
              phase: 'page',
              ratio: 0.05,
              message: `Đang tải lại ${pending.length} biểu đồ lỗi (lần ${attempt + 1}/${attempts})…`,
            });
            await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
          }
          const res = await fetchChartsForPage(pageId, storedSession, null, {
            chartIds: pending,
            viewerFilters,
            hiddenFilters,
            silent: true,
          });
          pending = res.failed;
        }
        for (const id of pending) {
          failures.push({
            page: pageName,
            chart: chartNameById.get(id) || `Biểu đồ #${id}`,
            reason: chartErrorsRef.current[id] || 'Không tải được dữ liệu',
          });
        }
      };

      const reportTitle = dashboard.public_link_name || dashboard.name || 'Dashboard';
      const chosen = dashboardPages.filter((p) => choices.pageIds.includes(p.id));
      const pageSources = (chosen.length ? chosen : [{ id: activePageId, name: '' }]).map((p) => ({
        name: p.name,
        filtersSummary,
        getRoot: async () => {
          setCurrentPageId(p.id);
          // Keep the on-screen state coherent with the page being captured (the
          // fetch above already used this context explicitly).
          setPageHiddenFilters(
            resolvePublicPageFilterContext(
              dashboard as unknown as Record<string, unknown>,
              dashboardPages,
              p.id,
            ).hiddenFilters,
          );
          await ensurePageDataLoaded(p.id, p.name);
          // Let React commit the new page's tiles; the exporter then runs its own
          // readiness protocol (waitForRenderReady) before capturing anything.
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
          });
          return gridSectionRef.current;
        },
      }));

      const { exportDashboardPdf } = await import('@/lib/export-pdf');
      const result = await exportDashboardPdf({
        filename: `${safeName}.pdf`,
        title: reportTitle,
        orientation: choices.orientation,
        format: choices.format,
        layout: choices.layout,
        plan: choices.plan,
        onProgress: setExportProgress,
        pages: pageSources,
        previewWindow,
        dataAsOf: snapshotAsOf,
        warnings: failures,
      });
      if (failures.length) {
        toast.warning(`PDF thiếu ${failures.length} biểu đồ`, {
          description: `${failures.slice(0, 3).map((f) => f.chart).join(', ')}${failures.length > 3 ? '…' : ''} — file vẫn tải về, phần thiếu được liệt kê ở cuối báo cáo.`,
        });
      }
      if (result === 'saved' && PDF_PREVIEW_TAB_ENABLED) {
        // Only meaningful while the preview tab is switched ON: it means the
        // popup was blocked. With the tab off, "saved" IS the happy path and a
        // toast about pop-ups would just confuse the reader.
        try { previewWindow?.close(); } catch { /* noop */ }
        toast.info('Đã tải PDF về máy', {
          description: 'Trình duyệt chặn mở tab mới. Cho phép pop-up cho trang này để xem PDF ngay tại tab bên cạnh.',
        });
      }
    } catch (err) {
      console.error('PDF export failed', err);
      try { previewWindow?.close(); } catch { /* noop */ }
      toast.error('Xuất PDF thất bại', {
        description: 'Không tạo được file PDF. Vui lòng thử lại; nếu vẫn lỗi, thử bớt số trang export.',
      });
    } finally {
      exportInProgressRef.current = false;
      setCurrentPageId(originalPageId);
      setIsExportingPdf(false);
      setExportRenderMode(false);
      setForceVisibleAll(false);
      setIsExportDialogOpen(false);
      setExportProgress(null);
    }
  }, [activePageId, dashboard, dashboardPages, fetchChartsForPage, runServerExport, serverExportReady, snapshotAsOf, summarizeViewerFilters, token]);

  // Print mode: pin the requested page and the viewer's filter selections, then
  // hand control to the readiness protocol.
  useEffect(() => {
    if (!printOptions || !dashboard) return;
    if (printOptions.pageId && currentPageId !== printOptions.pageId) {
      setCurrentPageId(printOptions.pageId);
    }
  }, [printOptions, dashboard, currentPageId]);

  useEffect(() => {
    if (!printOptions || !dashboard || !filtersSeeded) return;
    if (printFiltersAppliedRef.current) return;
    printFiltersAppliedRef.current = true;
    if (!printOptions.filters.length) return;
    // Overlay the requester's selections on top of the page's own seed, keyed by
    // field — same rule as a viewer changing a slicer by hand.
    const byKey = new Map<string, BaseFilter>();
    for (const f of appliedViewerFiltersRef.current) byKey.set(f.fieldKey ?? f.field, f);
    for (const f of printOptions.filters) byKey.set(f.fieldKey ?? f.field, f);
    const merged = [...byKey.values()];
    setDraftViewerFilters(merged);
    setAppliedViewerFilters(merged);
  }, [printOptions, dashboard, filtersSeeded]);

  useEffect(() => {
    if (!printMode || printReadyRef.current) return;
    if (pageState !== 'loaded' || chartsLoading) return;
    const root = gridSectionRef.current;
    if (!root) return;
    let cancelled = false;
    (async () => {
      const { waitForRenderReady } = await import('@/lib/render-ready');
      const result = await waitForRenderReady(root, { timeoutMs: 60000 });
      if (cancelled) return;
      printReadyRef.current = true;
      // The worker polls for BOTH: the flag is the contract, the attribute makes
      // it visible in a screenshot/devtools when debugging a stuck render.
      (window as unknown as { __APPBI_PDF_READY__?: boolean }).__APPBI_PDF_READY__ = true;
      document.body.setAttribute('data-pdf-ready', result.ready ? 'true' : 'timeout');
    })();
    return () => { cancelled = true; };
  }, [printMode, pageState, chartsLoading]);

  /** Every chart on the report, for the "arrange it yourself" export. Pooled
   *  across pages on purpose: combining charts that live on different pages onto
   *  one handout sheet is exactly what this layout is for. */
  const planCandidates = useMemo(() => {
    const pageNameById = new Map(dashboardPages.map((pg) => [pg.id, pg.name]));
    return (dashboard?.dashboard_charts ?? [])
      .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id)
      .map((dc) => ({
        chartId: dc.chart_id,
        title: dc.chart?.name || `Biểu đồ #${dc.chart_id}`,
        chartType: (dc.chart as { chart_type?: string } | undefined)?.chart_type,
        pageId: getDashboardChartPageId(dc.layout),
        pageName: pageNameById.get(getDashboardChartPageId(dc.layout)) || undefined,
        layout: {
          x: Number(dc.layout?.x ?? 0),
          y: Number(dc.layout?.y ?? 0),
          w: Number(dc.layout?.w ?? 12),
          h: Number(dc.layout?.h ?? 6),
        },
      }));
  }, [dashboard?.dashboard_charts, dashboardPages]);

  /**
   * Load one page's chart data for the export arranger's previews.
   *
   * Deliberately does NOT switch the report to that page: the batch endpoint
   * answers for any page, so the arranger can show every chart without the
   * page-by-page walk that made it take minutes. Silent + single attempt — a
   * preview that fails to load simply shows the chart's name.
   */
  const ensurePageDataForArranger = useCallback(async (pageId: string) => {
    if (!dashboard) return;
    const targets = getDashboardChartsForPage(dashboard.dashboard_charts, pageId)
      .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id)
      .map((dc) => dc.chart_id)
      .filter((id) => !chartDataRef.current[id]);
    if (!targets.length) return;
    const { controlSeed, hiddenFilters } = resolvePublicPageFilterContext(
      dashboard as unknown as Record<string, unknown>, dashboardPages, pageId,
    );
    await fetchChartsForPage(pageId, getPublicSession(token) ?? undefined, null, {
      chartIds: targets,
      viewerFilters: mergeSeedWithViewerSelections(controlSeed, appliedViewerFiltersRef.current),
      hiddenFilters,
      silent: true,
    });
  }, [dashboard, dashboardPages, fetchChartsForPage, token]);

  /** Rows per chart, for the arranger's live previews. */
  const chartRowsForArranger = useMemo(() => {
    const out: Record<number, unknown[] | undefined> = {};
    for (const [id, resp] of Object.entries(chartData)) {
      const rows = (resp as { data?: unknown[] } | undefined)?.data;
      if (Array.isArray(rows)) out[Number(id)] = rows;
    }
    return out;
  }, [chartData]);

  const filterRuntime = useMemo(
    () => buildPublicDashboardFilterRuntime(visibleDashboardCharts, chartData),
    [chartData, visibleDashboardCharts],
  );
  const activeSessionToken = mounted ? (getPublicSession(token) ?? undefined) : undefined;
  const availableFilterColumns = useMemo<ColumnInfo[]>(
    () => (dashboard?.available_filter_fields?.length
      ? dashboard.available_filter_fields
      : filterRuntime.columns),
    [dashboard?.available_filter_fields, filterRuntime.columns],
  );
  const availableFilterChartCount = useMemo(
    () => (
      dashboard?.available_filter_fields?.length
        ? new Map(
            availableFilterColumns.map((column) => [
              getColumnKey(column),
              column.chartCoverage ?? 0,
            ]),
          )
        : filterRuntime.columnChartCount
    ),
    [availableFilterColumns, dashboard?.available_filter_fields, filterRuntime.columnChartCount],
  );
  const { values: resolvedDistinctValues, status: resolvedDistinctStatus } = usePublicFilterDistinctValues(
    token,
    activeSessionToken,
    availableFilterColumns,
    draftViewerFilters,
    filterRuntime.distinctValues,
    // PBI parity: the active page's hidden "Filters on this page" must cascade
    // into the slicer values too (not only into chart data). Without this a
    // public slicer offered values outside the page-filter scope.
    pageHiddenFilters,
  );
  const hasPendingFilterChanges = useMemo(
    () => JSON.stringify(draftViewerFilters) !== JSON.stringify(appliedViewerFilters),
    [appliedViewerFilters, draftViewerFilters],
  );
  const publicTheme = useMemo(
    () => buildPublicLinkTheme(dashboard?.public_link_appearance),
    [dashboard?.public_link_appearance],
  );
  const appearance = publicTheme.appearance;
  // Header/tab accent follows the REPORT's published theme first
  // (theme_config.accent), then the public-link appearance accent, then a
  // safe default — so the masthead "ăn theo" the dashboard's own palette
  // instead of a hard-coded blue.
  const reportAccentHex: string =
    ((dashboard as any)?.theme_config?.accent as string | undefined)
    ?? publicTheme.accentHex
    ?? '#475569';
  const activeTabStyle = {
    backgroundColor: hexToRgbaString(reportAccentHex, 0.12) ?? undefined,
    borderColor: hexToRgbaString(reportAccentHex, 0.38) ?? undefined,
    color: reportAccentHex,
  };
  const presentationTitle = appearance.headline
    ?? dashboard?.public_link_name
    ?? dashboard?.name
    ?? 'Shared dashboard';
  const viewerFiltersEnabled = appearance.allow_viewer_filters;
  // Per-chart CSV export on public + embed (both surfaces — data is client-side,
  // read-only, already filter/permission-scoped). Admin toggle, default on.
  const dataExportEnabled = appearance.allow_data_export;
  const showPageTabs = appearance.show_page_tabs && dashboardPages.length > 1;
  const showFilterControls = viewerFiltersEnabled && availableFilterColumns.length > 0;
  const showLiveState = Boolean(pendingPageId || crossFilterState || chartLoadError || (chartsLoading && !isApplyingFilters));
  // The saved dock, honoured on the public link exactly as in the builder.
  //
  // This used to be a boolean for 'left' only, duplicated from the builder's
  // own branch — so widening the builder to six docks would have silently left
  // the public report on two. Both now read `dockLayoutClasses`, and a rail is
  // left OR right rather than a hard-coded side.
  // Same resolution as the builder: author placement first, then the theme's
  // composition default.
  const slicerDock = String(
    (dashboard as any)?.slicer_cluster_layout?.position
    ?? resolveStyleTokens(((dashboard as any)?.theme_config ?? null) as any).filterDock,
  );
  const slicerClusterIsRail = slicerDock === 'left' || slicerDock === 'right';
  const slicerDockClasses = dockLayoutClasses(slicerDock);
  // 'hidden' keeps the filter VALUES (they are merged server-side) and drops
  // only the UI — the case a locked public link is built for.
  const slicerDockHidden = slicerDock === 'hidden';

  const handleApplyFilters = useCallback(() => {
    setIsApplyingFilters(true);
    setAppliedViewerFilters(draftViewerFilters);
  }, [draftViewerFilters]);

  const handleResetFilters = useCallback(() => {
    setDraftViewerFilters(appliedViewerFilters);
  }, [appliedViewerFilters]);

  const hasSettledPageCache = useCallback((pageId: string) => {
    if (!dashboard) return false;
    const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId)
      .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id);
    if (targetCharts.length === 0) return true;
    return targetCharts.every((dashboardChart) => (
      Boolean(chartData[dashboardChart.chart_id]) || Boolean(chartErrors[dashboardChart.chart_id])
    ));
  }, [chartData, chartErrors, dashboard]);

  // PDF export now fetches each page's data on-demand inside doExportPdf, so the
  // dashboard load path no longer prefetches all pages. This was the single
  // biggest source of public-link slowness — a 3-page × 15-chart dashboard
  // fired 30 unused requests in the background on every open.

  const handlePageSelect = useCallback((pageId: string) => {
    if (pageId === activePageId || pendingPageId === pageId) {
      return;
    }

    if (crossFilterState) {
      skipCrossFilterRefreshRef.current = pageId;
    }

    if (hasSettledPageCache(pageId)) {
      // Fully-cached page → switch instantly and suppress the visibility
      // effect's refetch (its tiles already hold data for the current filters).
      skipNextPageLoadRef.current = pageId;
      startTransition(() => setCurrentPageId(pageId));
      return;
    }

    // Not-yet-loaded page: switch IMMEDIATELY and let the lazy visibility effect
    // fetch only this page's VISIBLE tiles — the exact path a first open uses.
    // Previously we AWAITED a fetch of EVERY chart on the target page before
    // switching, so a not-yet-visited page blocked on its slowest tile; and when
    // a background snapshot rebuild was competing for the warehouse those tile
    // queries stacked up, which read as "chuyển page rất lâu" the longer a
    // session ran. Non-blocking switch keeps it snappy; do NOT set
    // skipNextPageLoadRef here — we WANT the effect to run and load the tiles.
    startTransition(() => setCurrentPageId(pageId));
  }, [activePageId, crossFilterState, hasSettledPageCache, pendingPageId]);

  if (!mounted || pageState === 'unknown' || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0 px-4">
        <div className="w-full max-w-md rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-6 py-10 text-center shadow-linear">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          <h1 className="mt-4 text-small font-strong text-text-primary">Preparing shared dashboard</h1>
          <p className="mt-2 text-caption text-text-tertiary">
            Loading charts, pages, and viewer filters for the published report.
          </p>
        </div>
      </div>
    );
  }

  if (pageState === 'password_gate') {
    return (
      <PasswordGate
        onSubmit={handlePasswordSubmit}
        error={authError}
        submitting={authSubmitting}
        isReauth={false}
      />
    );
  }

  if (pageState === 'error' || !dashboard) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0 px-4">
        <div className="max-w-md rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-8 py-10 text-center shadow-linear">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-warning/10 text-warning">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <p className="text-tiny font-emphasis uppercase tracking-[0.18em] text-text-quaternary">
            Shared link unavailable
          </p>
          <h1 className="mt-2 text-h3 font-emphasis text-text-primary">Dashboard not available</h1>
          <p className="mt-3 text-caption text-text-tertiary">
            {error ?? 'This shared link may have expired or been revoked.'}
          </p>
        </div>
      </div>
    );
  }

  // Render at STORED coordinates — NO liftLayoutToTop. The public report must be
  // pixel-WYSIWYG with the builder desktop: an intentional top gap the DA left is
  // preserved, not normalized away.
  const layouts: Layout[] = visibleDashboardCharts.map((dashboardChart) => {
    const layout = dashboardChart.layout;
    return {
      i: dashboardChart.id.toString(),
      x: layout.x || 0,
      y: layout.y || 0,
      w: layout.w || 4,
      h: layout.h || 4,
    };
  });

  // Phase-G — single SlicerCluster node reused in both placements:
  // stacked above the grid (top) or as a left column (left). Defined
  // here so it can sit beside the grid section in left mode.
  const slicerClusterNode = showFilterControls ? (
    <div className="[&>div]:mb-0">
      <SlicerCluster
        items={[
          ...draftViewerFilters,
          ...(((dashboard as any)?.slicers_config || []).filter(
            (c: any) => c && typeof c === 'object' && c.type === 'image',
          )),
        ]}
        onChildrenChange={(next) => {
          setDraftViewerFilters(
            (next as any[]).filter(
              (c) => !(c && typeof c === 'object' && (c as any).type === 'image'),
            ),
          );
        }}
        layout={(dashboard as any)?.slicer_cluster_layout || null}
        columns={availableFilterColumns}
        columnChartCount={availableFilterChartCount}
        distinctValues={resolvedDistinctValues}
        distinctStatus={resolvedDistinctStatus}
        // Type-to-search over the FULL cached distinct set for high-cardinality
        // slicers on a public/embed link. Hits the BE result cache via the
        // public endpoint (no per-keystroke BigQuery, no authed call).
        fetchServerDistinct={async (column, search) => {
          if (!column.datasetId || !column.semanticField) return [];
          try {
            // Cascade the search results by the viewer's other active filters
            // + page-scope (same context the prefetch uses); self-strips this
            // field so the dropdown never pins its own value.
            const filterContext = getDistinctValueFilterContext(
              [...appliedViewerFilters, ...pageHiddenFilters], column,
            );
            const res = await publicDashboardApi.getFilterDistinctValues(
              token, column.datasetId, column.semanticField, activeSessionToken, 500, filterContext, search,
            );
            return res.values ?? [];
          } catch {
            return [];
          }
        }}
        hasPendingChanges={hasPendingFilterChanges}
        onApply={handleApplyFilters}
        onReset={handleResetFilters}
        isApplying={isApplyingFilters}
        lockSlots
      />
    </div>
  ) : null;

  /**
   * Does this surface offer PDF export?
   *
   * OFF for the EMBED surface (2026-08-04, DA report: export is broken there).
   * An embed link — the `/embed/emb_…` URL that POST
   * /integrations/embed/resolve mints, plus any manual iframe of
   * `/embed/<token>` — is a report living inside somebody else's app, where a
   * half-working button is worse than none: the host has its own chrome and its
   * viewers cannot be told "use the public link instead".
   *
   * The public `/d/<token>` surface keeps its Export button.
   *
   * Set this back to `true` once export works when embedded — the feature is
   * still wired underneath, only the entry point is hidden.
   */
  const exportEnabledOnThisSurface = !isEmbed;

  // ── Shared masthead pieces (used by BOTH the TOP and LEFT layouts) ──
  // Extracted so the LEFT app-shell can reuse them without divergence.
  const exportButtonEl = !exportEnabledOnThisSurface ? null : (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => setIsExportDialogOpen(true)}
      disabled={isExportingPdf || chartsLoading}
      leadingIcon={
        isExportingPdf
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Download className="h-4 w-4" />
      }
      className="print:hidden"
      title="Export this dashboard as PDF"
      data-html2canvas-ignore
    >
      <span className="hidden sm:inline">
        {isExportingPdf ? 'Exporting…' : 'Export PDF'}
      </span>
    </Button>
  );

  // Custom header logo: a published report can replace the default generated
  // brand mark with its own image. Source order: public-link appearance
  // `logo_url` → dashboard `theme_config.logo` (both accept a URL or data: URI)
  // → fall back to the auto-generated accent-tinted chart glyph.
  const headerLogoSrc: string | null =
    appearance.logo_url
    ?? ((dashboard as any)?.theme_config?.logo as string | undefined)
    ?? null;
  const brandMarkEl = headerLogoSrc ? (
    <img
      src={headerLogoSrc}
      alt={presentationTitle}
      className="h-8 w-8 flex-shrink-0 rounded-lg object-contain"
    />
  ) : (
    <span
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-white"
      style={{ backgroundColor: reportAccentHex }}
      aria-hidden
    >
      <BarChart3 className="h-[18px] w-[18px]" />
    </span>
  );

  // Title for the LEFT shell — wraps to multiple lines instead of truncating
  // (the left column is narrow; user asked to let a long title wrap).
  const titleEl = (
    <div className="min-w-0 flex-1">
      <h1
        className="break-words text-lg font-emphasis leading-tight tracking-[-0.02em] text-text-primary sm:text-xl"
        title={presentationTitle}
      >
        {presentationTitle}
      </h1>
      {snapshotAsOf && (
        <p
          className="mt-0.5 text-[11px] text-text-tertiary"
          title={`Số liệu tính đến ${formatSnapshotAsOf(snapshotAsOf)}`}
        >
          Số liệu tính đến {formatSnapshotAsOf(snapshotAsOf)}
        </p>
      )}
    </div>
  );

  const pageTabsEl = showPageTabs ? (
    <nav className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
      {dashboardPages.map((page) => {
        const isActive = page.id === activePageId;
        const isPending = page.id === pendingPageId;
        return (
          <button
            key={page.id}
            type="button"
            onClick={() => {
              void handlePageSelect(page.id);
            }}
            className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1 text-small font-emphasis transition-all ${
              isActive
                ? 'shadow-sm'
                : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:-translate-y-px hover:border-text-tertiary/40 hover:bg-surface-2 hover:text-text-primary hover:shadow-sm'
            }`}
            style={isActive ? activeTabStyle : undefined}
            disabled={isPending}
          >
            {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {page.name}
          </button>
        );
      })}
    </nav>
  ) : null;

  const filterBannerEl = (lockedBannerEntries.length > 0 || overridableFilterEntries.length > 0) ? (
    <div
      className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-secondary"
      style={publicTheme.neutralPillStyle}
      data-public-locked-banner
    >
      <div className="flex flex-wrap items-center gap-2">
        {lockedBannerEntries.length > 0 ? (
          <>
            <span className="font-medium text-text-tertiary">ⓘ Đang lọc theo:</span>
            {lockedBannerEntries.map((entry, i) => (
              <span key={`${entry.field}-${i}`} className="inline-flex items-center gap-1">
                <span className="opacity-70">🔒</span>
                <span className="font-medium">{entry.label ?? entry.field}</span>
                <span className="text-text-quaternary">=</span>
                <span className="font-mono">
                  {Array.isArray(entry.value)
                    ? entry.value.slice(0, 3).join(', ') + (entry.value.length > 3 ? `, +${entry.value.length - 3}` : '')
                    : String(entry.value ?? '')}
                </span>
              </span>
            ))}
          </>
        ) : (
          <span className="text-text-tertiary">Bộ lọc nâng cao có sẵn.</span>
        )}
        <button
          type="button"
          onClick={() => setIsMiniPaneOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-tiny font-emphasis text-text-secondary transition-colors hover:bg-surface-2"
        >
          {isMiniPaneOpen ? 'Đóng' : 'Xem chi tiết'}
        </button>
      </div>
      {isMiniPaneOpen && (
        <div className="mt-3 rounded border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          {lockedBannerEntries.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
                Bộ lọc cố định (do người chia sẻ link cấu hình)
              </div>
              {lockedBannerEntries.map((entry, i) => (
                <div key={`lock-${entry.field}-${i}`} className="flex items-center gap-2 text-caption">
                  <span>🔒</span>
                  <span className="font-medium">{entry.label ?? entry.field}</span>
                  <span className="text-text-quaternary">=</span>
                  <span className="font-mono text-text-secondary">
                    {Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value ?? '')}
                  </span>
                  <span className="ml-auto text-tiny text-text-quaternary">Read-only</span>
                </div>
              ))}
            </div>
          )}
          {overridableFilterEntries.length > 0 && (
            <div className={`${lockedBannerEntries.length > 0 ? 'mt-3 border-t border-[rgb(var(--border-line))] pt-3' : ''} space-y-1.5`}>
              <div className="text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
                Bộ lọc có thể chỉnh
              </div>
              {overridableFilterEntries.map((entry, i) => {
                const currentDraft = draftViewerFilters.find(
                  (f) => f.field === entry.field || f.semanticField === entry.semanticField,
                );
                const displayValue = currentDraft?.value ?? entry.value;
                return (
                  <div key={`ov-${entry.field}-${i}`} className="flex items-center gap-2 text-caption">
                    <span>👁</span>
                    <span className="font-medium">{entry.label ?? entry.field}</span>
                    <span className="text-text-quaternary">=</span>
                    <input
                      type="text"
                      value={Array.isArray(displayValue) ? displayValue.join(', ') : String(displayValue ?? '')}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const nextValue = raw.includes(',')
                          ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                          : raw;
                        setDraftViewerFilters((prev) => {
                          const others = prev.filter(
                            (f) => f.field !== entry.field && f.semanticField !== entry.semanticField,
                          );
                          return [
                            ...others,
                            {
                              ...(currentDraft ?? {}),
                              id: currentDraft?.id ?? `override-${entry.field}`,
                              field: entry.field,
                              semanticField: entry.semanticField,
                              type: (currentDraft?.type ?? entry.type ?? 'dropdown') as any,
                              operator: (currentDraft?.operator ?? 'in') as any,
                              value: nextValue,
                            } as any,
                          ];
                        });
                      }}
                      placeholder={Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value ?? '')}
                      className="ml-auto w-48 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-tiny outline-none focus:ring-1 focus:ring-brand"
                    />
                  </div>
                );
              })}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleApplyFilters()}
                  disabled={!hasPendingFilterChanges}
                  className="rounded border border-brand bg-brand px-3 py-1 text-tiny font-emphasis text-text-inverse transition-opacity disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  ) : null;

  const filterLiveEl = showLiveState ? (
    <div className="flex flex-col gap-3">
      {pendingPageId && (
        <div
          className="inline-flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-tiny text-text-tertiary"
          style={publicTheme.neutralPillStyle}
        >
          <Loader2 className="h-3 w-3 animate-spin" /> Đang mở trang…
        </div>
      )}

      {crossFilterState && (
        <div
          className="rounded-lg border border-brand/20 bg-brand/10 px-4 py-3 text-caption text-brand"
          style={publicTheme.accentPillStyle}
        >
          <p className="font-emphasis">
            Cross-filter from {visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
              ?? visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
              ?? `Chart ${crossFilterState.sourceChartId}`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="break-words text-text-secondary">
              {getFilterDisplayLabel(crossFilterState.filter)} = {formatFilterValue(crossFilterState.filter.value)}
            </span>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setCrossFilterState(null)}
              style={publicTheme.neutralPillStyle}
            >
              Clear selection
            </Button>
          </div>
        </div>
      )}

      {highlightState && (
        <div
          className="rounded-lg border border-brand/20 bg-brand/10 px-4 py-3 text-caption text-brand"
          style={publicTheme.accentPillStyle}
        >
          <p className="font-emphasis">
            Đang làm nổi bật từ {visibleDashboardCharts.find((dc) => dc.chart_id === highlightState.sourceChartId)?.layout?.custom_title
              ?? visibleDashboardCharts.find((dc) => dc.chart_id === highlightState.sourceChartId)?.chart?.name
              ?? `Chart ${highlightState.sourceChartId}`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="break-words text-text-secondary">
              {getFilterDisplayLabel(highlightState.filter)} = {formatFilterValue(highlightState.filter.value)}
            </span>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setHighlightState(null)}
              style={publicTheme.neutralPillStyle}
            >
              Bỏ chọn
            </Button>
          </div>
        </div>
      )}

      {chartLoadError && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-caption text-warning">
          {chartLoadError}
        </div>
      )}

      {chartsLoading && !isApplyingFilters && (
        <div
          className="inline-flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-tiny text-text-tertiary"
          style={publicTheme.neutralPillStyle}
        >
          <Loader2 className="h-3 w-3 animate-spin" /> Đang tải biểu đồ…
        </div>
      )}
    </div>
  ) : null;

  /**
   * One tile, rendered identically wherever it lands: inside the interactive
   * react-grid-layout canvas, or inside the static print flow below. Extracted
   * so the printed report can never diverge from the screen version.
   */
  // Render a non-chart widget (text / image / countdown / shape / parameter
  // switcher) with the SAME card chrome the builder gives it, so a published
  // report matches what the author designed. Without this the public view
  // wrapped every widget in a bare <div>, so a text note rendered as naked text
  // floating on the page background and an image lost its border/rounding.
  // Pure-visual widgets (shape, which also draws line/divider) and the
  // self-framed parameter switcher stay frameless to avoid a double frame.
  function renderWidgetNode(dashboardChart: DashboardChart) {
    const wtype = dashboardChart.widget_type;
    // `transparentBackground` (per-widget config) drops the card frame so the
    // dashboard's own background shows through — same frameless path shape and
    // the self-framed parameter switcher already take.
    const transparentWidget = ((dashboardChart.widget_config ?? {}) as Record<string, any>).transparentBackground === true;
    // Decorative "element" widgets draw their own styling → frameless (no card).
    const selfStyled = wtype === 'section_header' || wtype === 'callout' || wtype === 'hero_strip';
    const frameless = wtype === 'shape' || wtype === 'parameter_switcher' || selfStyled || transparentWidget;
    return (
      <div key={dashboardChart.id.toString()} className="h-full">
        {frameless ? (
          <div className="h-full w-full">
            <DashboardWidget widget={dashboardChart} />
          </div>
        ) : (
          <div
            className="dashboard-tile h-full w-full overflow-hidden rounded-lg border bg-surface-1"
            style={{
              borderRadius: 'var(--dashboard-card-radius, 0.5rem)',
              borderWidth: 'var(--dashboard-card-border-width, 1px)',
              borderColor: 'var(--dashboard-card-border-color, rgb(var(--border-line)))',
            }}
          >
            <DashboardWidget widget={dashboardChart} />
          </div>
        )}
      </div>
    );
  }

  function renderTileNode(dashboardChart: DashboardChart) {
    const isWidget = Boolean(
      dashboardChart.widget_type && dashboardChart.widget_type !== 'chart'
    );
    if (isWidget) {
      return renderWidgetNode(dashboardChart);
    }

    const chart = dashboardChart.chart;
    const payload = chartData[dashboardChart.chart_id];
    const chartError = chartErrors[dashboardChart.chart_id];
    const title = dashboardChart.layout.custom_title ?? '';

    return (
      <div key={dashboardChart.id.toString()} data-chart-id={dashboardChart.chart_id} className="h-full rounded-xl transition-all duration-300">
        <ChartErrorBoundary chartId={dashboardChart.chart_id}>
          <ReadonlyChartTile
            chart={chart}
            chartData={payload}
            error={chartError}
            title={title}
            layout={dashboardChart.layout}
            compact={publicTheme.density.compact}
            showChartTypeLabel={false}
            onSelectCrossFilter={(dashboardChart.layout as any)?.highlightEnabled !== false ? (filter) => handleCrossFilterChange(dashboardChart.chart_id, filter) : undefined}
            isCrossFilterSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
            highlightFilter={crossFilterState?.sourceChartId === dashboardChart.chart_id && (dashboardChart.layout as any)?.highlightEnabled !== false ? (crossFilterState?.filter ?? null) : null}
            isHighlightSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
            highlightData={null}
            forceVisible={forceVisibleAll}
            publicDatasetModels={(dashboard as any)?.public_dataset_models ?? null}
            viewerGrain={chartGrains[dashboardChart.chart_id]}
            onViewerDrill={(g) => handleChartDrill(dashboardChart.chart_id, g)}
            lockDateGrain={(dashboardChart.layout as any)?.lockDateGrain === true}
            allowExport={dataExportEnabled}
            onVisible={() => {
              setVisibleChartIds((current) => {
                if (current.has(dashboardChart.chart_id)) return current;
                const next = new Set(current);
                next.add(dashboardChart.chart_id);
                return next;
              });
            }}
          />
        </ChartErrorBoundary>
      </div>
    );
  }

  // Tiles grouped into the dashboard's own rows (authored `y`, ordered by `x`)
  // for the print flow. NOT a hook: this sits below the loading/password/error
  // early returns above, so a `useMemo` here would be skipped on the first
  // render and blow up with React #310 ("rendered more hooks than last time").
  // The grouping is a sort over a handful of tiles — memoising it would cost
  // more than it saves.
  const printTileRows = printMode ? groupTilesIntoRows(visibleDashboardCharts) : [];

  const gridSectionEl = (
    <ExportModeContext.Provider value={exportRenderMode || (printMode ? printRenderMode : false)}>
      <section
        ref={gridSectionRef}
        className={`px-1 pb-1 pt-0 transition-opacity duration-200 sm:px-1.5 ${pendingPageId ? 'opacity-70' : 'opacity-100'} ${slicerClusterIsRail ? 'min-w-0 flex-1' : 'w-full'}`}
      >
        {visibleDashboardCharts.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-[rgb(var(--border-line))] bg-surface-2">
            <p className="text-caption text-text-tertiary">No charts on this page yet.</p>
          </div>
        ) : (
          <div
            ref={gridMeasureRef}
            className={`${publicTheme.density.compact ? 'px-2 pb-2 pt-0' : 'px-3 pb-3 pt-0.5'}`}
          >
            <ResponsiveReportGrid
              className="layout"
              layouts={{ lg: layouts, xs: deriveStackedLayout(layouts) }}
              breakpoints={REPORT_BREAKPOINTS}
              cols={REPORT_COLS}
              rowHeight={reportRowHeight}
              margin={getDashboardGridMargin(dashboard?.theme_config)}
              isDraggable={false}
              isResizable={false}
              compactType={null}
              preventCollision={true}
            >
              {visibleDashboardCharts.map(renderTileNode)}
            </ResponsiveReportGrid>
          </div>
        )}
      </section>
    </ExportModeContext.Provider>
  );

  if (printMode) {
    // Paper shell: no app chrome, no scroll container, white background.
    //
    // The tiles are laid out as STATIC ROWS here instead of the interactive
    // react-grid canvas. react-grid-layout positions every tile absolutely, and
    // `break-inside: avoid` has no effect on an absolutely-positioned box — so
    // printing the canvas sliced charts in half across sheet boundaries. A row
    // of plain flex children keeps the authored side-by-side arrangement AND
    // lets Chromium move a whole row to the next sheet when it doesn't fit.
    const rowGap = getDashboardGridMargin(dashboard?.theme_config)[1] ?? 8;
    return (
      <DashboardThemeProvider
        theme={dashboard?.theme_config}
        className="min-h-[200px] bg-white text-text-primary"
        style={publicTheme.pageStyle}
      >
        <ExportModeContext.Provider value={printRenderMode}>
          <main className="w-full px-3 py-2" data-pdf-root="1">
            <section ref={gridSectionRef}>
              {printTileRows.map((row, rowIndex) => (
                <div
                  key={`pdf-row-${rowIndex}`}
                  className="pdf-print-row"
                  style={{ display: 'flex', gap: `${rowGap}px`, marginBottom: `${rowGap}px` }}
                >
                  {row.map((dashboardChart) => (
                    <div
                      key={dashboardChart.id}
                      style={{
                        // Same fraction of the width the author gave the tile on
                        // the (finer, 36-column) grid, so the sheet mirrors the
                        // screen. Row height uses the finer per-gap row unit so a
                        // ×3-migrated tile keeps its exact printed height.
                        flex: `0 0 calc(${((dashboardChart.layout?.w ?? DASHBOARD_GRID_COLS) / DASHBOARD_GRID_COLS) * 100}% - ${rowGap}px)`,
                        height: `${(dashboardChart.layout?.h ?? 12) * dashboardRowHeight(rowGap) + (((dashboardChart.layout?.h ?? 12) - 1) * rowGap)}px`,
                      }}
                    >
                      {renderTileNode(dashboardChart)}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          </main>
        </ExportModeContext.Provider>
      </DashboardThemeProvider>
    );
  }

  return (
    <DashboardThemeProvider
      theme={dashboard?.theme_config}
      className={isEmbed
        ? 'min-h-[220px] bg-surface-0 text-text-primary'
        : 'flex h-screen overflow-hidden bg-surface-0 text-text-primary'}
      style={publicTheme.pageStyle}
    >
      {pageState === 'reauth' && (
        <SessionExpiredOverlay onReauth={handleReauth} />
      )}

      {/* The masthead (header/tabs/filter) is PINNED: `main` itself no longer
          scrolls (overflow-hidden) — only the chart region inside each layout
          branch scrolls. So scrolling a long report never pushes the
          header/tabs/filter out of view (user ask). */}
      <main ref={publicContentRef} className={isEmbed
        ? 'w-full min-w-0 flex flex-col gap-1 px-3 pt-3 pb-0 sm:px-4'
        : 'flex-1 min-w-0 overflow-hidden flex flex-col gap-1 px-3 pt-4 pb-0 sm:px-4 lg:px-6 lg:pt-5'}>
        {slicerClusterIsRail ? (
          /* ── LEFT app-shell ──────────────────────────────────────────────
             When the author placed the slicer cluster on the LEFT, the report
             becomes a 2-column shell: the brand mark + title sit ABOVE the
             filter rail in the left column, while the page tabs, Export, and
             the chart grid pull to the TOP of the right column. This removes
             the full-width header band so nothing floats with dead space above
             the rail (user ask). The rail is sticky so filters stay in view. */
          <div className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-3 lg:flex-row lg:items-stretch">
            {/* Left column = brand+title (top, level with the page tabs) then
                the filter rail. gap-4 = 2× the previous title↔filter spacing.
                This column is a fixed flex sibling so it never scrolls away. */}
            <aside className="flex w-full flex-shrink-0 flex-col gap-4 lg:w-[280px]">
              <div className="flex items-start gap-2.5 px-1">
                {brandMarkEl}
                {titleEl}
              </div>
              {showFilterControls && (
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-2 shadow-linear-sm">
                  {slicerClusterNode}
                </div>
              )}
            </aside>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {pageTabsEl}
                <div className="ml-auto shrink-0">{exportButtonEl}</div>
              </div>
              {(filterBannerEl || filterLiveEl) && (
                <div className="shrink-0 space-y-2">
                  {filterBannerEl}
                  {filterLiveEl}
                </div>
              )}
              {/* Only the charts scroll. */}
              <div className={isEmbed ? 'pb-4' : 'min-h-0 flex-1 overflow-y-auto pb-4'}>
                {gridSectionEl}
              </div>
            </div>
          </div>
        ) : (
          <>
        {/* Phase-B7 — FLUSH report header (was a bordered/elevated card on a
            gray page = "web widget" look). A report masthead is flat with just
            a hairline divider; tiles are the only cards. Removes one nesting
            level toward the PBI "flat canvas" feel. */}
        <section
          className="mx-auto w-full shrink-0 overflow-visible px-4 pt-2.5 pb-0.5 sm:px-5 sm:pt-3"
        >
          {/* Report masthead — row 1: brand mark + title + Export. Title is no
              longer clamped to 36%/cramped beside the tabs; tabs drop to their
              own underline row below (row 2), matching a real BI report header
              (PowerBI/Looker) instead of the old one-line pill toolbar. */}
          <div className="flex items-center gap-2.5">
            {brandMarkEl}
            <div className="min-w-0 flex-1">
              <h1
                className="truncate text-lg font-emphasis tracking-[-0.02em] text-text-primary sm:text-xl"
                title={presentationTitle}
              >
                {presentationTitle}
              </h1>
              {snapshotAsOf && (
                <p
                  className="mt-0.5 truncate text-[11px] text-text-tertiary"
                  title={`Số liệu tính đến ${formatSnapshotAsOf(snapshotAsOf)}`}
                >
                  Số liệu tính đến {formatSnapshotAsOf(snapshotAsOf)}
                </p>
              )}
            </div>
            {exportEnabledOnThisSurface && (
            <div className="ml-auto shrink-0">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsExportDialogOpen(true)}
                disabled={isExportingPdf || chartsLoading}
                leadingIcon={
                  isExportingPdf
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Download className="h-4 w-4" />
                }
                className="print:hidden"
                title="Export this dashboard as PDF"
                data-html2canvas-ignore
              >
                <span className="hidden sm:inline">
                  {isExportingPdf ? 'Exporting…' : 'Export PDF'}
                </span>
              </Button>
            </div>
            )}
          </div>

          {/* Row 2 — page tabs (own row), rendered as a segmented set of
              clickable chips so a viewer immediately reads them as pressable
              tabs (user ask). The active page is a filled accent chip tinted
              from the REPORT theme; inactive pages are outlined surface chips
              with a clear hover lift + pointer cursor. */}
          {showPageTabs && (
            <nav className="mt-2 flex min-w-0 items-center gap-1.5 overflow-x-auto">
              {dashboardPages.map((page) => {
                const isActive = page.id === activePageId;
                const isPending = page.id === pendingPageId;
                return (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => {
                      void handlePageSelect(page.id);
                    }}
                    className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1 text-small font-emphasis transition-all ${
                      isActive
                        ? 'shadow-sm'
                        : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:-translate-y-px hover:border-text-tertiary/40 hover:bg-surface-2 hover:text-text-primary hover:shadow-sm'
                    }`}
                    style={isActive ? activeTabStyle : undefined}
                    disabled={isPending}
                  >
                    {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                    {page.name}
                  </button>
                );
              })}
            </nav>
          )}

          {/* In LEFT mode the slicer cluster moves out to the side rail, so the
              header filter block must NOT render just because showFilterControls
              is true — otherwise it draws an empty divider + padding. Only render
              it for the top-mode slicers, live state, or the locked/override
              banners. */}
          {((showFilterControls && !slicerClusterIsRail && !slicerDockHidden) || showLiveState || lockedBannerEntries.length > 0 || overridableFilterEntries.length > 0) && (
            <div className="mt-2 space-y-2 border-t border-[rgb(var(--border-line))] pt-2">

              {/* Phase-F THẬT (PBI-parity rework) — banner for locked
                  filters + [Xem chi tiết] toggle. Click opens mini-pane
                  with locked entries (read-only, 🔒) plus override-allowed
                  entries (editable). See docs/filter-semantics.md §9 +
                  user-approved wireframe. */}
              {(lockedBannerEntries.length > 0 || overridableFilterEntries.length > 0) && (
                <div
                  className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-secondary"
                  style={publicTheme.neutralPillStyle}
                  data-public-locked-banner
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {lockedBannerEntries.length > 0 ? (
                      <>
                        <span className="font-medium text-text-tertiary">ⓘ Đang lọc theo:</span>
                        {lockedBannerEntries.map((entry, i) => (
                          <span key={`${entry.field}-${i}`} className="inline-flex items-center gap-1">
                            <span className="opacity-70">🔒</span>
                            <span className="font-medium">{entry.label ?? entry.field}</span>
                            <span className="text-text-quaternary">=</span>
                            <span className="font-mono">
                              {Array.isArray(entry.value)
                                ? entry.value.slice(0, 3).join(', ') + (entry.value.length > 3 ? `, +${entry.value.length - 3}` : '')
                                : String(entry.value ?? '')}
                            </span>
                          </span>
                        ))}
                      </>
                    ) : (
                      <span className="text-text-tertiary">Bộ lọc nâng cao có sẵn.</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsMiniPaneOpen((v) => !v)}
                      className="ml-auto inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-tiny font-emphasis text-text-secondary transition-colors hover:bg-surface-2"
                    >
                      {isMiniPaneOpen ? 'Đóng' : 'Xem chi tiết'}
                    </button>
                  </div>
                  {isMiniPaneOpen && (
                    <div className="mt-3 rounded border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                      {lockedBannerEntries.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
                            Bộ lọc cố định (do người chia sẻ link cấu hình)
                          </div>
                          {lockedBannerEntries.map((entry, i) => (
                            <div key={`lock-${entry.field}-${i}`} className="flex items-center gap-2 text-caption">
                              <span>🔒</span>
                              <span className="font-medium">{entry.label ?? entry.field}</span>
                              <span className="text-text-quaternary">=</span>
                              <span className="font-mono text-text-secondary">
                                {Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value ?? '')}
                              </span>
                              <span className="ml-auto text-tiny text-text-quaternary">Read-only</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {overridableFilterEntries.length > 0 && (
                        <div className={`${lockedBannerEntries.length > 0 ? 'mt-3 border-t border-[rgb(var(--border-line))] pt-3' : ''} space-y-1.5`}>
                          <div className="text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
                            Bộ lọc có thể chỉnh
                          </div>
                          {overridableFilterEntries.map((entry, i) => {
                            const currentDraft = draftViewerFilters.find(
                              (f) => f.field === entry.field || f.semanticField === entry.semanticField,
                            );
                            const displayValue = currentDraft?.value ?? entry.value;
                            return (
                              <div key={`ov-${entry.field}-${i}`} className="flex items-center gap-2 text-caption">
                                <span>👁</span>
                                <span className="font-medium">{entry.label ?? entry.field}</span>
                                <span className="text-text-quaternary">=</span>
                                <input
                                  type="text"
                                  value={Array.isArray(displayValue) ? displayValue.join(', ') : String(displayValue ?? '')}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    const nextValue = raw.includes(',')
                                      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                                      : raw;
                                    setDraftViewerFilters((prev) => {
                                      const others = prev.filter(
                                        (f) => f.field !== entry.field && f.semanticField !== entry.semanticField,
                                      );
                                      return [
                                        ...others,
                                        {
                                          ...(currentDraft ?? {}),
                                          id: currentDraft?.id ?? `override-${entry.field}`,
                                          field: entry.field,
                                          semanticField: entry.semanticField,
                                          type: (currentDraft?.type ?? entry.type ?? 'dropdown') as any,
                                          operator: (currentDraft?.operator ?? 'in') as any,
                                          value: nextValue,
                                        } as any,
                                      ];
                                    });
                                  }}
                                  placeholder={Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value ?? '')}
                                  className="ml-auto w-48 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-tiny outline-none focus:ring-1 focus:ring-brand"
                                />
                              </div>
                            );
                          })}
                          <div className="mt-2 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => handleApplyFilters()}
                              disabled={!hasPendingFilterChanges}
                              className="rounded border border-brand bg-brand px-3 py-1 text-tiny font-emphasis text-text-inverse transition-opacity disabled:opacity-50"
                            >
                              Apply
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Top mode renders the slicer cluster here (stacked
                  above charts). Left mode renders it BESIDE the grid in
                  the flex-row wrapper below instead. */}
              {showFilterControls && !slicerClusterIsRail && !slicerDockHidden && slicerClusterNode}

              {showLiveState && (
                <div className="flex flex-col gap-3">
                  {pendingPageId && (
                    <div
                      className="inline-flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-tiny text-text-tertiary"
                      style={publicTheme.neutralPillStyle}
                    >
                      <Loader2 className="h-3 w-3 animate-spin" /> Đang mở trang…
                    </div>
                  )}

                  {crossFilterState && (
                    <div
                      className="rounded-lg border border-brand/20 bg-brand/10 px-4 py-3 text-caption text-brand"
                      style={publicTheme.accentPillStyle}
                    >
                      <p className="font-emphasis">
                        Cross-filter from {visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
                          ?? visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
                          ?? `Chart ${crossFilterState.sourceChartId}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="break-words text-text-secondary">
                          {getFilterDisplayLabel(crossFilterState.filter)} = {formatFilterValue(crossFilterState.filter.value)}
                        </span>
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => setCrossFilterState(null)}
                          style={publicTheme.neutralPillStyle}
                        >
                          Clear selection
                        </Button>
                      </div>
                    </div>
                  )}

                  {highlightState && (
                    <div
                      className="rounded-lg border border-brand/20 bg-brand/10 px-4 py-3 text-caption text-brand"
                      style={publicTheme.accentPillStyle}
                    >
                      <p className="font-emphasis">
                        Đang làm nổi bật từ {visibleDashboardCharts.find((dc) => dc.chart_id === highlightState.sourceChartId)?.layout?.custom_title
                          ?? visibleDashboardCharts.find((dc) => dc.chart_id === highlightState.sourceChartId)?.chart?.name
                          ?? `Chart ${highlightState.sourceChartId}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="break-words text-text-secondary">
                          {getFilterDisplayLabel(highlightState.filter)} = {formatFilterValue(highlightState.filter.value)}
                        </span>
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => setHighlightState(null)}
                          style={publicTheme.neutralPillStyle}
                        >
                          Bỏ chọn
                        </Button>
                      </div>
                    </div>
                  )}

                  {chartLoadError && (
                    <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-caption text-warning">
                      {chartLoadError}
                    </div>
                  )}

                  {chartsLoading && !isApplyingFilters && (
                    <div
                      className="inline-flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-tiny text-text-tertiary"
                      style={publicTheme.neutralPillStyle}
                    >
                      <Loader2 className="h-3 w-3 animate-spin" /> Đang tải biểu đồ…
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Only the chart region scrolls; the header above stays pinned. */}
        <div className={isEmbed ? 'pb-4' : 'min-h-0 flex-1 overflow-y-auto pb-4'}>
        <div className={`mx-auto w-full ${slicerClusterIsRail ? `flex flex-col gap-3 lg:items-start ${slicerDock === 'right' ? 'lg:flex-row-reverse' : 'lg:flex-row'}` : slicerDockClasses.wrapper}`}>
        {slicerClusterIsRail && showFilterControls && !slicerDockHidden && (
          <div className="w-full flex-shrink-0 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-2 shadow-linear-sm lg:sticky lg:top-3 lg:w-[280px]">
            {slicerClusterNode}
          </div>
        )}
        {/* Phase-B7 — FLUSH canvas (no card frame): tiles sit directly on the
            page background like a PBI report canvas, not inside a second
            bordered panel. */}
        <ExportModeContext.Provider value={exportRenderMode}>
        <section
          ref={gridSectionRef}
          className={`px-1 pb-1 pt-0 transition-opacity duration-200 sm:px-1.5 ${pendingPageId ? 'opacity-70' : 'opacity-100'} ${slicerClusterIsRail ? 'min-w-0 flex-1' : 'w-full'}`}
        >
          {visibleDashboardCharts.length === 0 ? (
            <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-[rgb(var(--border-line))] bg-surface-2">
              <p className="text-caption text-text-tertiary">No charts on this page yet.</p>
            </div>
          ) : (
            <div
              ref={gridMeasureRef}
              className={`${publicTheme.density.compact ? 'px-2 pb-2 pt-0' : 'px-3 pb-3 pt-0.5'}`}
            >
              <ResponsiveReportGrid
                className="layout"
                layouts={{ lg: layouts, xs: deriveStackedLayout(layouts) }}
                breakpoints={REPORT_BREAKPOINTS}
                cols={REPORT_COLS}
                rowHeight={reportRowHeight}
                margin={getDashboardGridMargin(dashboard?.theme_config)}
                isDraggable={false}
                isResizable={false}
                compactType={null}
                preventCollision={true}
              >
                {visibleDashboardCharts.map((dashboardChart: DashboardChart) => {
                  // Non-chart widgets (text/image/countdown/shape/parameter_switcher)
                  // skip the chart-fetch path and render via the shared DashboardWidget.
                  const isWidget = Boolean(
                    dashboardChart.widget_type && dashboardChart.widget_type !== 'chart'
                  );
                  if (isWidget) {
                    return renderWidgetNode(dashboardChart);
                  }

                  const chart = dashboardChart.chart;
                  const payload = chartData[dashboardChart.chart_id];
                  const chartError = chartErrors[dashboardChart.chart_id];
                  // Phase-B11 — no auto chart-name title; only an explicit one.
                  const title = dashboardChart.layout.custom_title ?? '';

                  return (
                    <div key={dashboardChart.id.toString()} data-chart-id={dashboardChart.chart_id} className="h-full rounded-xl transition-all duration-300">
                      <ChartErrorBoundary chartId={dashboardChart.chart_id}>
                        <ReadonlyChartTile
                          chart={chart}
                          chartData={payload}
                          error={chartError}
                          title={title}
                          layout={dashboardChart.layout}
                          compact={publicTheme.density.compact}
                          showChartTypeLabel={false}
                          onSelectCrossFilter={(dashboardChart.layout as any)?.highlightEnabled !== false ? (filter) => handleCrossFilterChange(dashboardChart.chart_id, filter) : undefined}
                          isCrossFilterSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
                          /* Source-only dim: the clicked chart dims its non-selected marks
                             (local, no fetch); every other chart instead FILTERS (handled by
                             fetchChartsForPage). Per-chart opt-out via layout.highlightEnabled. */
                          highlightFilter={crossFilterState?.sourceChartId === dashboardChart.chart_id && (dashboardChart.layout as any)?.highlightEnabled !== false ? (crossFilterState?.filter ?? null) : null}
                          isHighlightSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
                          highlightData={null}
                          forceVisible={forceVisibleAll}
                          publicDatasetModels={(dashboard as any)?.public_dataset_models ?? null}
                          viewerGrain={chartGrains[dashboardChart.chart_id]}
                          onViewerDrill={(g) => handleChartDrill(dashboardChart.chart_id, g)}
                          lockDateGrain={(dashboardChart.layout as any)?.lockDateGrain === true}
                          allowExport={dataExportEnabled}
                          onVisible={() => {
                            setVisibleChartIds((current) => {
                              if (current.has(dashboardChart.chart_id)) return current;
                              const next = new Set(current);
                              next.add(dashboardChart.chart_id);
                              return next;
                            });
                          }}
                        />
                      </ChartErrorBoundary>
                    </div>
                  );
                })}
              </ResponsiveReportGrid>
            </div>
          )}
        </section>
        </ExportModeContext.Provider>
        </div>{/* /Phase-G left-vs-top slicer arrangement wrapper */}
        </div>{/* /scroll region */}
          </>
        )}
      </main>

      {/* Belt and braces: with export hidden on this surface the dialog must not
          be reachable at all, not even by a stale state flag. */}
      <ExportPdfDialog
        isOpen={isExportDialogOpen && exportEnabledOnThisSurface}
        onClose={() => { if (!isExportingPdf) setIsExportDialogOpen(false); }}
        pages={dashboardPages.map((p) => ({ id: p.id, name: p.name }))}
        isExporting={isExportingPdf}
        progress={exportProgress}
        planCandidates={planCandidates}
        defaultPageId={activePageId}
        planPages={dashboardPages.map((pg) => ({ id: pg.id, name: pg.name }))}
        chartRows={chartRowsForArranger}
        onEnsurePageData={ensurePageDataForArranger}
        onExport={doExportPdf}
      />

      {!isEmbed && dashboard?.public_link_appearance?.ai_bot_enabled === true && (
        <DashboardAiBot
          token={token}
          sessionToken={getPublicSession(token)}
          dashboardName={presentationTitle}
          keyConfigured={dashboard.public_link_appearance?.ai_bot_key_configured === true}
          viewerFilters={appliedViewerFilters}
        />
      )}
    </DashboardThemeProvider>
  );
}
