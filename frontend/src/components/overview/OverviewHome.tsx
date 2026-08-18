/**
 * Overview — the system home.
 *
 * A lightweight landing that orients the user across the whole product:
 * how the modules connect (Sources -> Datasets -> Explore -> Dashboards /
 * Workboards), headline counts, things that need attention, and recent
 * activity. The long-form module explainers that used to sit on every list
 * page now live here, so the module pages can stay list-first.
 *
 * Currently unmounted in every deployment: the Home module is switched off (see
 * `lib/feature-flags.ts`), and `app/(main)/overview/page.tsx` only renders this
 * when the flag is on. It reads five list endpoints and joins them into a
 * lineage graph, which is why hiding it was worth doing — keep that cost in
 * mind before wiring it into any always-mounted surface.
 */
'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart3,
  ClipboardList,
  Layers,
  LayoutDashboard,
  Plug,
  Table2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useDataSources } from '@/hooks/use-datasources';
import { useDatasets } from '@/hooks/use-datasets';
import { useCharts } from '@/hooks/use-charts';
import { useDashboards } from '@/hooks/use-dashboards';
import { useWorkboards } from '@/hooks/use-workboards';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { buildCatalogRelationIndex } from '@/lib/module-relations';
import { LineageExplorer } from '@/components/overview/LineageExplorer';
import type { LineageRef } from '@/lib/lineage';
import { GettingStartedGuide } from '@/components/common/GettingStartedGuide';
import { useI18n } from '@/providers/LanguageProvider';

type ModuleKey = 'data_sources' | 'datasets' | 'explore_charts' | 'dashboards' | 'workboards';

export function OverviewHome() {
  const router = useRouter();
  const { locale } = useI18n();
  const vi = locale === 'vi';

  const { data: dataSources = [], isLoading: loadingSources } = useDataSources();
  const { data: datasets = [], isLoading: loadingDatasets } = useDatasets();
  const { data: charts = [], isLoading: loadingCharts } = useCharts({ limit: 500, sort: 'updated_desc' });
  const { data: dashboards = [], isLoading: loadingDashboards } = useDashboards();
  const { data: workboards = [], isLoading: loadingWorkboards } = useWorkboards();
  const { data: permData } = usePermissions();
  const perms = permData?.permissions;

  const isLoading =
    loadingSources || loadingDatasets || loadingCharts || loadingDashboards || loadingWorkboards;

  const canView = (module: ModuleKey) => hasPermission(perms, module, 'view');

  const relationIndex = useMemo(
    () =>
      buildCatalogRelationIndex({
        dashboards,
        charts,
        datasets,
        datasources: dataSources,
      }),
    [dashboards, charts, datasets, dataSources],
  );

  const hasAnyData =
    dataSources.length + datasets.length + charts.length + dashboards.length + workboards.length > 0;

  const openRef = (ref: LineageRef) => {
    const hrefByKind: Record<LineageRef['kind'], string> = {
      source: `/datasources/${ref.id}`,
      table: '/datasets',
      dataset: `/datasets/${ref.id}`,
      chart: `/explore/${ref.id}`,
      dashboard: `/dashboards/${ref.id}`,
      workboard: `/workboards/${ref.id}`,
    };
    router.push(hrefByKind[ref.kind]);
  };

  // Permission-gated inputs for the lineage board. The list endpoints already
  // return only resources this user may see (owned + shared); the module gate
  // additionally hides a whole column when the user has no view access at all.
  const lineageSources = canView('data_sources') ? dataSources : [];
  const lineageDatasets = canView('datasets') ? datasets : [];
  const lineageDashboards = canView('dashboards') ? dashboards : [];
  const lineageWorkboards = canView('workboards') ? workboards : [];
  const lineageCharts = canView('explore_charts') || canView('dashboards') ? charts : [];

  // ---- Headline KPI cards (real numbers, permission-gated) ----------------
  const kpis = useMemo(() => {
    const DAY = 24 * 60 * 60 * 1000;
    const within = (iso: string | undefined, days: number) => {
      const t = iso ? new Date(iso).getTime() : NaN;
      return Number.isFinite(t) && Date.now() - t <= days * DAY;
    };
    const older = (iso: string | undefined, days: number) => {
      const t = iso ? new Date(iso).getTime() : NaN;
      return Number.isFinite(t) && Date.now() - t > days * DAY;
    };

    const usedSources = dataSources.filter(
      (s) => (relationIndex.sourceRelationsById.get(s.id)?.datasetIds.size ?? 0) > 0,
    ).length;
    const tablesCount = new Set(
      charts.map((c) => c.dataset_table_id).filter((id): id is number => Number.isInteger(id as number)),
    ).size;
    const datasetsWithTables = new Set(
      charts.filter((c) => c.dataset_table_id).map((c) => c.dataset_id).filter(Boolean),
    ).size;
    const datasetsUnused = datasets.filter((d) => {
      const r = relationIndex.datasetRelationsById.get(d.id);
      const inWorkboard = workboards.some((w) => w.dataset_id === d.id);
      return (r?.chartIds.size ?? 0) === 0 && (r?.dashboardIds.size ?? 0) === 0 && !inWorkboard;
    }).length;
    const chartsNoDash = charts.filter(
      (c) => (relationIndex.chartRelationsById.get(c.id)?.dashboardIds.size ?? 0) === 0,
    ).length;
    const dashStale = dashboards.filter((d) => older(d.updated_at, 30)).length;
    const dashFresh = dashboards.filter((d) => within(d.updated_at, 7)).length;
    const wbDraft = workboards.filter((w) => !w.is_published).length;
    const wbPublished = workboards.filter((w) => w.is_published).length;

    type Card = {
      key: string;
      module: ModuleKey;
      icon: LucideIcon;
      color: string;
      labelEn: string;
      labelVi: string;
      value: number;
      badge?: { text: string; tone: 'pos' | 'warn' };
      subEn: string;
      subVi: string;
    };
    const all: Card[] = [
      {
        key: 'sources', module: 'data_sources', icon: Plug, color: 'text-info',
        labelEn: 'Sources', labelVi: 'Nguồn', value: dataSources.length,
        badge: dataSources.filter((s) => within(s.created_at, 7)).length > 0
          ? { text: `+${dataSources.filter((s) => within(s.created_at, 7)).length}`, tone: 'pos' } : undefined,
        subEn: `${usedSources} in use`, subVi: `${usedSources} đang dùng`,
      },
      {
        key: 'tables', module: 'datasets', icon: Table2, color: 'text-success',
        labelEn: 'Tables', labelVi: 'Bảng', value: tablesCount,
        subEn: `across ${datasetsWithTables} datasets`, subVi: `thuộc ${datasetsWithTables} dataset`,
      },
      {
        key: 'datasets', module: 'datasets', icon: Layers, color: 'text-brand',
        labelEn: 'Datasets', labelVi: 'Dataset', value: datasets.length,
        badge: datasets.filter((d) => within(d.created_at, 7)).length > 0
          ? { text: `+${datasets.filter((d) => within(d.created_at, 7)).length}`, tone: 'pos' } : undefined,
        subEn: `${datasetsUnused} unused`, subVi: `${datasetsUnused} chưa dùng`,
      },
      {
        key: 'charts', module: 'explore_charts', icon: BarChart3, color: 'text-info',
        labelEn: 'Charts', labelVi: 'Chart', value: charts.length,
        badge: charts.filter((c) => within(c.created_at, 7)).length > 0
          ? { text: `+${charts.filter((c) => within(c.created_at, 7)).length}`, tone: 'pos' } : undefined,
        subEn: `${chartsNoDash} not on a dashboard`, subVi: `${chartsNoDash} chưa lên dashboard`,
      },
      {
        key: 'dashboards', module: 'dashboards', icon: LayoutDashboard, color: 'text-brand',
        labelEn: 'Dashboards', labelVi: 'Dashboard', value: dashboards.length,
        badge: dashStale > 0 ? { text: vi ? `${dashStale} cũ` : `${dashStale} stale`, tone: 'warn' } : undefined,
        subEn: `${dashFresh} recently updated`, subVi: `${dashFresh} mới cập nhật`,
      },
      {
        key: 'workboards', module: 'workboards', icon: ClipboardList, color: 'text-warning',
        labelEn: 'Workboards', labelVi: 'Workboard', value: workboards.length,
        badge: wbDraft > 0 ? { text: vi ? `${wbDraft} nháp` : `${wbDraft} draft`, tone: 'warn' } : undefined,
        subEn: `${wbPublished} published`, subVi: `${wbPublished} đã publish`,
      },
    ];
    return all.filter((c) => (c.module === 'datasets' && c.key === 'tables' ? canView('datasets') : canView(c.module)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSources, datasets, charts, dashboards, workboards, relationIndex, perms, vi]);

  return (
    <div className="px-4 py-6 sm:px-6 xl:px-8">
      <div className="mb-5">
        <h1 className="text-h1 font-emphasis text-text-primary">{vi ? 'Tổng quan' : 'Overview'}</h1>
        <p className="mt-1 max-w-2xl text-caption text-text-tertiary">
          {vi
            ? 'Bức tranh toàn cảnh: các module đang kết nối với nhau ra sao và đâu là việc cần xử lý.'
            : 'The whole picture: how your modules connect and what needs attention.'}
        </p>
      </div>

      {/* New-user onboarding lives here now (hidden once the basics exist). */}
      <GettingStartedGuide locale={locale} />

      {isLoading ? (
        <OverviewSkeleton />
      ) : (
        <>
          {/* Headline KPI cards */}
          {kpis.length > 0 && (
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
              {kpis.map((c) => (
                <div
                  key={c.key}
                  className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4"
                >
                  <div className="flex items-start justify-between">
                    <c.icon className={`h-5 w-5 ${c.color}`} />
                    {c.badge && (
                      <span
                        className={
                          c.badge.tone === 'pos'
                            ? 'rounded-full bg-success/10 px-2 py-0.5 text-tiny font-emphasis text-success'
                            : 'rounded-full bg-warning/10 px-2 py-0.5 text-tiny font-emphasis text-warning'
                        }
                      >
                        {c.badge.text}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-caption font-emphasis text-text-secondary">{vi ? c.labelVi : c.labelEn}</div>
                  <div className="mt-0.5 text-3xl font-strong leading-tight text-text-primary">{c.value}</div>
                  <div className="mt-1 text-tiny text-text-tertiary">{vi ? c.subVi : c.subEn}</div>
                </div>
              ))}
            </div>
          )}

          {/* Interactive data-lineage board: Source -> Dataset -> Dashboard / Workboard */}
          {hasAnyData ? (
            <LineageExplorer
              dataSources={lineageSources}
              datasets={lineageDatasets}
              charts={lineageCharts}
              dashboards={lineageDashboards}
              workboards={lineageWorkboards}
              canViewWorkboards={canView('workboards')}
              vi={vi}
              onOpen={openRef}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 py-16 text-center text-caption text-text-tertiary">
              {vi
                ? 'Chưa có dữ liệu để hiển thị luồng. Tạo nguồn/dataset/dashboard để bắt đầu.'
                : 'Nothing to map yet. Create a source / dataset / dashboard to get started.'}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
            <div className="h-5 w-5 rounded bg-surface-3" />
            <div className="mt-3 h-3 w-16 rounded bg-surface-3" />
            <div className="mt-2 h-7 w-12 rounded bg-surface-3" />
            <div className="mt-2 h-2.5 w-20 rounded bg-surface-2" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
        <div className="mb-3 h-8 rounded-md bg-surface-2" />
        <div className="flex gap-12">
          {Array.from({ length: 4 }).map((_, col) => (
            <div key={col} className="flex w-48 shrink-0 flex-col gap-3">
              <div className="h-4 w-24 rounded bg-surface-3" />
              {Array.from({ length: 6 }).map((__, row) => (
                <div key={row} className="h-9 rounded-lg bg-surface-2" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
