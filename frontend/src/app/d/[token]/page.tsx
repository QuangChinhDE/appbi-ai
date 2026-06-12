'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  AlertTriangle,
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
  getDashboardChartsForPage,
  normalizeDashboardPages,
} from '@/lib/dashboard-pages';
import { getColumnKey, getFilterDisplayLabel, getFilterKey, type BaseFilter, type ColumnInfo } from '@/lib/filters';
import { usePublicFilterDistinctValues } from '@/hooks/use-public-filter-distinct-values';
import { buildPublicLinkTheme } from '@/lib/public-link-appearance';
import { buildPublicDashboardFilterRuntime } from '@/lib/public-dashboard-runtime';
import type { ChartDataResponse, Dashboard, DashboardChart } from '@/types/api';

// Fixed (non-responsive) 12-column grid that scales cell width with the
// container. Mirrors components/dashboards/DashboardGrid.tsx: using a plain
// WidthProvider(GridLayout) instead of Responsive means a viewport shrink
// (rotating a phone, opening DevTools, dragging the window) never swaps
// breakpoints or vertically compacts tiles — the published layout renders
// exactly as the author arranged it, only smaller. Previously this used
// Responsive + compactType="vertical", which made charts jump on resize.
const FixedGridLayout = WidthProvider(GridLayout);

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
const CHART_FETCH_CONCURRENCY = 8;

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

export default function PublicDashboardPage() {
  const params = useParams();
  const token = params.token as string;

  const [mounted, setMounted] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartData, setChartData] = useState<Record<number, ChartDataResponse>>({});
  const [chartErrors, setChartErrors] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [chartsLoading, setChartsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartLoadError, setChartLoadError] = useState<string | null>(null);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [pendingPageId, setPendingPageId] = useState<string | null>(null);
  const [draftViewerFilters, setDraftViewerFilters] = useState<BaseFilter[]>([]);
  const [appliedViewerFilters, setAppliedViewerFilters] = useState<BaseFilter[]>([]);
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
  const [pageState, setPageState] = useState<PageState>('unknown');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // Chart ids that have entered the viewport at least once. Tiles report visibility
  // via onVisible; the fetch effect uses this set to gate which charts to request.
  const [visibleChartIds, setVisibleChartIds] = useState<Set<number>>(() => new Set());
  const [forceVisibleAll, setForceVisibleAll] = useState(false);
  const publicContentRef = useRef<HTMLElement>(null);
  const gridSectionRef = useRef<HTMLElement>(null);

  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartRequestIdRef = useRef(0);
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
      const nextDashboard = await publicDashboardApi.get(token, sessionToken);
      setDashboard(nextDashboard);
      setPageState('loaded');
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
    const slicersFromConfig = Array.isArray((dashboard as any).slicers_config)
      ? ((dashboard as any).slicers_config as BaseFilter[])
      : [];
    const filtersAsSlicers = Array.isArray((dashboard as any).filters_config)
      ? ((dashboard as any).filters_config as BaseFilter[]).filter((f) => {
          const mode = (f as any).publicMode ?? 'visible';
          return mode === 'visible';
        })
      : [];
    const legacyPublicConfig = (slicersFromConfig.length === 0 && filtersAsSlicers.length === 0)
      ? (Array.isArray(dashboard.public_filters_config)
          ? (dashboard.public_filters_config as BaseFilter[])
          : [])
      : [];
    const allPagesSeed: BaseFilter[] = [
      ...slicersFromConfig,
      ...filtersAsSlicers,
      ...legacyPublicConfig,
    ];
    const activePageObj = dashboardPages.find((p) => p.id === activePageId);
    const rawPageSlicers = Array.isArray((activePageObj as any)?.slicers)
      ? ((activePageObj as any).slicers as BaseFilter[])
      : [];
    const rawPageFilters = Array.isArray((activePageObj as any)?.filters)
      ? ((activePageObj as any).filters as BaseFilter[]).filter((f) => {
          const mode = (f as any).publicMode ?? 'visible';
          return mode === 'visible';
        })
      : [];
    const pageSeed: BaseFilter[] = [...rawPageSlicers, ...rawPageFilters];
    // De-dupe by fieldKey; per-page entries take precedence over all-pages
    // when the same field appears in both (rare, but tester intent: page-
    // level override semantics). On token change we reset; on page switch
    // we preserve viewer's edits for fields that still exist in the new
    // seed set.
    const isFirstSeed = seededFiltersForTokenRef.current !== token;
    seededFiltersForTokenRef.current = token;
    const seedByKey = new Map<string, BaseFilter>();
    for (const f of allPagesSeed) seedByKey.set(f.fieldKey ?? f.field, f);
    for (const f of pageSeed) seedByKey.set(f.fieldKey ?? f.field, f);
    const merged: BaseFilter[] = [];
    if (!isFirstSeed) {
      // Preserve viewer's edits for any field that still exists in the
      // seed; otherwise fall back to the (possibly newly added) seed.
      // Read from ref (not closure) so a fast page switch right after an
      // edit doesn't drop the just-typed selection.
      const existingByKey = new Map<string, BaseFilter>();
      for (const f of appliedViewerFiltersRef.current) existingByKey.set(f.fieldKey ?? f.field, f);
      for (const [key, seedFilter] of seedByKey.entries()) {
        const existing = existingByKey.get(key);
        merged.push(existing ?? seedFilter);
      }
    } else {
      for (const f of seedByKey.values()) merged.push(f);
    }
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

  const handleCrossFilterChange = useCallback((sourceChartId: number, filter: BaseFilter | null) => {
    setCrossFilterState((current) => {
      if (!filter) {
        return current?.sourceChartId === sourceChartId ? null : current;
      }

      if (
        current?.sourceChartId === sourceChartId
        && areFiltersEquivalent(current.filter, filter)
      ) {
        return null;
      }

      return {
        sourceChartId,
        filter,
      };
    });
  }, []);

  const fetchChartsForPage = useCallback(async (
    pageId: string,
    sessionToken?: string,
    pageCrossFilterState: typeof crossFilterState = crossFilterState,
    options?: { chartIds?: number[]; force?: boolean },
  ) => {
    if (!dashboard) return false;

    const requestId = ++chartRequestIdRef.current;
    const allCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId)
      // Non-chart widgets (text/image/countdown/shape/parameter_switcher) carry no
      // chart_id and never need a /charts/{id}/data round-trip.
      .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id);
    // When chartIds is supplied (lazy viewport mode), only fetch those tiles.
    const targetCharts = options?.chartIds
      ? allCharts.filter((dc) => options.chartIds!.includes(dc.chart_id))
      : allCharts;

    setChartsLoading(true);
    setChartLoadError(null);

    if (!targetCharts.length) {
      setChartsLoading(false);
      setIsApplyingFilters(false);
      return true;
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
      const entries = await runWithConcurrency(
        targetCharts,
        async (dashboardChart) => {
          const baseViewerFilters = pageCrossFilterState?.sourceChartId === dashboardChart.chart_id
            ? appliedViewerFilters
            : pageCrossFilterState
              ? [...appliedViewerFilters, pageCrossFilterState.filter]
              : appliedViewerFilters;
          const requestFilters = baseViewerFilters;
          try {
            const data = await publicDashboardApi.getChartData(
              token,
              dashboardChart.chart_id,
              sessionToken,
              requestFilters,
            );
            return { chartId: dashboardChart.chart_id, data, error: null as string | null };
          } catch (err: any) {
            return {
              chartId: dashboardChart.chart_id,
              data: null,
              error: getErrorMessage(err),
              status: err?.response?.status,
            };
          }
        },
        CHART_FETCH_CONCURRENCY,
      );

      if (requestId !== chartRequestIdRef.current) {
        return false;
      }

      const unauthorized = entries.find((entry) => (entry as any).status === 401);
      if (unauthorized) {
        clearPublicSession(token);
        setPageState('reauth');
        return false;
      }

      setChartData((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry.data) {
            next[entry.chartId] = entry.data;
          } else {
            delete next[entry.chartId];
          }
        }
        return next;
      });
      setChartErrors((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry.error) {
            next[entry.chartId] = entry.error;
          } else {
            delete next[entry.chartId];
          }
        }
        return next;
      });

      if (entries.some((entry) => entry.error)) {
        setChartLoadError('Some charts could not be loaded in this shared view.');
      }
      if (sessionToken) {
        scheduleSessionExpiry(token);
      }
      return true;
    } finally {
      if (requestId === chartRequestIdRef.current) {
        setChartsLoading(false);
        setIsApplyingFilters(false);
      }
    }
  }, [appliedViewerFilters, crossFilterState, dashboard, dashboardPages, activePageId, scheduleSessionExpiry, token]);

  useEffect(() => {
    if (!dashboard || pageState !== 'loaded') return;
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
    const lazyIds = targetCharts
      .map((dc) => dc.chart_id)
      .filter((id) => visibleChartIds.has(id));
    if (lazyIds.length === 0) {
      // Nothing visible yet (initial mount before IntersectionObserver fires).
      // Skip — the visibility effect will trigger fetch as tiles report in.
      return;
    }
    const storedSession = getPublicSession(token);
    fetchChartsForPage(activePageId, storedSession ?? undefined, crossFilterState, {
      chartIds: lazyIds,
    });
  }, [activePageId, crossFilterState, dashboard, fetchChartsForPage, filtersSeeded, pageState, token, visibleChartIds]);

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

  const handleExportPdf = useCallback(async () => {
    const mainEl = publicContentRef.current;
    if (!mainEl || !dashboard) return;
    setIsExportingPdf(true);
    // Disable lazy gating during export so every tile renders, including
    // off-screen ones. Fetch any not-yet-loaded chart data per page below.
    setForceVisibleAll(true);
    try {
      const safeName = (dashboard.name || 'shared-dashboard').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
      const storedSession = getPublicSession(token) ?? undefined;

      // Helper: ensure every chart on a given page has data fetched. Uses the
      // same concurrency-limited path as the normal viewport fetch.
      const ensurePageDataLoaded = async (pageId: string) => {
        const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId)
          .filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id);
        const missingIds = targetCharts
          .map((dc) => dc.chart_id)
          .filter((id) => !chartData[id] && !chartErrors[id]);
        if (missingIds.length === 0) return;
        await fetchChartsForPage(pageId, storedSession, null, { chartIds: missingIds });
      };

      if (dashboardPages.length <= 1) {
        // Single page — make sure all tiles for the active page have data.
        await ensurePageDataLoaded(activePageId);
        const { exportElementToPdf } = await import('@/lib/export-pdf');
        await exportElementToPdf(mainEl, `${safeName}.pdf`);
      } else {
        // Multi-page: switch to each page, fetch its charts on-demand, then capture.
        const { captureAndBuildPdf } = await import('@/lib/export-pdf');
        const originalPageId = activePageId;

        await captureAndBuildPdf(dashboardPages.length, async (pageIndex) => {
          const page = dashboardPages[pageIndex];
          setCurrentPageId(page.id);
          // Fetch any missing charts for this page before capture.
          await ensurePageDataLoaded(page.id);
          // Wait for React to re-render with new page's charts
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              setTimeout(resolve, 500);
            }));
          });
          return gridSectionRef.current;
        }, `${safeName}.pdf`);

        // Restore original page
        setCurrentPageId(originalPageId);
      }
    } catch (err) {
      console.error('PDF export failed', err);
    } finally {
      setIsExportingPdf(false);
      setForceVisibleAll(false);
    }
  }, [activePageId, chartData, chartErrors, dashboard, dashboardPages, fetchChartsForPage, token]);

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
  const resolvedDistinctValues = usePublicFilterDistinctValues(
    token,
    activeSessionToken,
    availableFilterColumns,
    draftViewerFilters,
    filterRuntime.distinctValues,
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
  const presentationTitle = appearance.headline
    ?? dashboard?.public_link_name
    ?? dashboard?.name
    ?? 'Shared dashboard';
  const viewerFiltersEnabled = appearance.allow_viewer_filters;
  const showPageTabs = appearance.show_page_tabs && dashboardPages.length > 1;
  const showFilterControls = viewerFiltersEnabled && availableFilterColumns.length > 0;
  const showLiveState = Boolean(pendingPageId || crossFilterState || chartLoadError || (chartsLoading && !isApplyingFilters));
  // Phase-G — honor the slicer cluster's saved position on the public
  // link. 'left' lays the cluster as a column beside the charts; 'top'
  // (default) stacks it above. ('free' was removed → treated as top.)
  const slicerClusterPositionLeft =
    ((dashboard as any)?.slicer_cluster_layout?.position) === 'left';

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

  // PDF export now fetches each page's data on-demand inside handleExportPdf,
  // so the dashboard load path no longer prefetches all pages. This was the
  // single biggest source of public-link slowness — a 3-page × 15-chart
  // dashboard fired 30 unused requests in the background on every open.

  // Export button stays enabled once the active page is settled. Other pages
  // are fetched lazily during export itself.
  const allPagesLoaded = useMemo(() => {
    if (!dashboard) return false;
    return hasSettledPageCache(activePageId);
  }, [activePageId, dashboard, hasSettledPageCache]);

  const handlePageSelect = useCallback(async (pageId: string) => {
    if (pageId === activePageId || pendingPageId === pageId) {
      return;
    }

    if (crossFilterState) {
      skipCrossFilterRefreshRef.current = pageId;
    }

    if (hasSettledPageCache(pageId)) {
      skipNextPageLoadRef.current = pageId;
      startTransition(() => setCurrentPageId(pageId));
      return;
    }

    const storedSession = getPublicSession(token) ?? undefined;
    setPendingPageId(pageId);
    const ready = await fetchChartsForPage(pageId, storedSession, null);
    setPendingPageId((current) => (current === pageId ? null : current));
    if (!ready) {
      return;
    }

    skipNextPageLoadRef.current = pageId;
    startTransition(() => setCurrentPageId(pageId));
  }, [activePageId, crossFilterState, fetchChartsForPage, hasSettledPageCache, pendingPageId, token]);

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
        children={[
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
        hasPendingChanges={hasPendingFilterChanges}
        onApply={handleApplyFilters}
        onReset={handleResetFilters}
        isApplying={isApplyingFilters}
        lockSlots
      />
    </div>
  ) : null;

  return (
    <DashboardThemeProvider
      theme={dashboard?.theme_config}
      className="flex h-screen overflow-hidden bg-surface-0 text-text-primary"
      style={publicTheme.pageStyle}
    >
      {pageState === 'reauth' && (
        <SessionExpiredOverlay onReauth={handleReauth} />
      )}

      <main ref={publicContentRef} className={`flex-1 min-w-0 overflow-y-auto flex flex-col ${publicTheme.density.listGapClass} px-3 py-4 sm:px-4 lg:px-6 lg:py-5`}>
        <section
          className="overflow-visible rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-4 sm:px-5 sm:py-5"
          style={publicTheme.panelStyle}
        >
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-h2 font-emphasis tracking-[-0.022em] text-text-primary">
              {presentationTitle}
            </h1>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExportPdf}
              disabled={isExportingPdf || chartsLoading || !allPagesLoaded}
              leadingIcon={
                isExportingPdf || !allPagesLoaded
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Download className="h-4 w-4" />
              }
              className="print:hidden"
              title={!allPagesLoaded ? 'Loading chart data…' : 'Export this dashboard as PDF'}
              data-html2canvas-ignore
            >
              <span className="hidden sm:inline">
                {isExportingPdf ? 'Exporting…' : !allPagesLoaded ? 'Loading…' : 'Export PDF'}
              </span>
            </Button>
          </div>

          {(showPageTabs || showFilterControls || showLiveState) && (
            <div className="mt-3 space-y-3">
              {showPageTabs && (
                <div className="flex flex-wrap gap-2 overflow-x-auto pb-1">
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
                        className={`inline-flex items-center whitespace-nowrap rounded-full border px-3 py-1.5 text-tiny font-emphasis transition-colors ${
                          isActive
                            ? 'border-transparent bg-text-primary text-text-inverse'
                            : isPending
                              ? 'border-brand/20 bg-brand/10 text-brand'
                              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                        }`}
                        style={isActive ? publicTheme.pageTabActiveStyle : isPending ? publicTheme.accentPillStyle : publicTheme.pageTabInactiveStyle}
                        disabled={isPending}
                      >
                        {isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                        {page.name}
                      </button>
                    );
                  })}
                </div>
              )}

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
              {showFilterControls && !slicerClusterPositionLeft && slicerClusterNode}

              {showLiveState && (
                <div className="flex flex-col gap-3">
                  {pendingPageId && (
                    <div
                      className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 text-caption text-text-tertiary"
                      style={publicTheme.neutralPillStyle}
                    >
                      Opening next page...
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

                  {chartLoadError && (
                    <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-caption text-warning">
                      {chartLoadError}
                    </div>
                  )}

                  {chartsLoading && !isApplyingFilters && (
                    <div
                      className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 text-caption text-text-tertiary"
                      style={publicTheme.neutralPillStyle}
                    >
                      Refreshing charts...
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Phase-G — when the slicer cluster is on the Left, lay it as a
            column beside the chart grid (flex-row). Top mode keeps the
            cluster stacked above (rendered in the header section). */}
        <div className={slicerClusterPositionLeft ? 'flex flex-row items-stretch gap-3' : ''}>
        {slicerClusterPositionLeft && showFilterControls && (
          <div className="w-[300px] flex-shrink-0">
            {slicerClusterNode}
          </div>
        )}
        <section
          ref={gridSectionRef}
          className={`rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3 transition-opacity duration-200 sm:p-4 ${pendingPageId ? 'opacity-70' : 'opacity-100'} ${slicerClusterPositionLeft ? 'min-w-0 flex-1' : 'w-full'}`}
          style={publicTheme.canvasFrameStyle}
        >
          {visibleDashboardCharts.length === 0 ? (
            <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-[rgb(var(--border-line))] bg-surface-2">
              <p className="text-caption text-text-tertiary">No charts on this page yet.</p>
            </div>
          ) : (
            <div
              className={`rounded-lg ${publicTheme.density.canvasPaddingClass}`}
              style={publicTheme.canvasInnerStyle}
            >
              <FixedGridLayout
                className="layout"
                layout={layouts}
                cols={12}
                rowHeight={80}
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
                    return (
                      <div key={dashboardChart.id.toString()} className="h-full">
                        <DashboardWidget widget={dashboardChart} />
                      </div>
                    );
                  }

                  const chart = dashboardChart.chart;
                  const payload = chartData[dashboardChart.chart_id];
                  const chartError = chartErrors[dashboardChart.chart_id];
                  const title = dashboardChart.layout.custom_title ?? chart?.name ?? '';

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
                          onSelectCrossFilter={(filter) => handleCrossFilterChange(dashboardChart.chart_id, filter)}
                          isCrossFilterSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
                          forceVisible={forceVisibleAll}
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
              </FixedGridLayout>
            </div>
          )}
        </section>
        </div>{/* /Phase-G left-vs-top slicer arrangement wrapper */}
      </main>

      {dashboard?.public_link_appearance?.ai_bot_enabled === true && (
        <DashboardAiBot
          token={token}
          sessionToken={getPublicSession(token)}
          dashboardName={presentationTitle}
          normalCostCapUsd={dashboard.public_link_appearance?.ai_bot_normal_cost_cap_usd}
          thinkingCostCapUsd={dashboard.public_link_appearance?.ai_bot_thinking_cost_cap_usd}
          keyConfigured={dashboard.public_link_appearance?.ai_bot_key_configured === true}
          viewerFilters={appliedViewerFilters}
        />
      )}
    </DashboardThemeProvider>
  );
}
