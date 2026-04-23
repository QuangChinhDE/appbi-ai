import type { Dataset } from '@/hooks/use-datasets';
import type { Chart, Dashboard, DataSource } from '@/types/api';

export type RelatedFilterKey = 'dashboard' | 'dataset' | 'chart' | 'source';

export type RelatedFilters = Partial<Record<RelatedFilterKey, string | undefined>>;

export interface RelatedFilterOption {
  value: string;
  label: string;
}

export interface RelationBag {
  dashboardIds: Set<number>;
  datasetIds: Set<number>;
  chartIds: Set<number>;
  sourceIds: Set<number>;
}

export interface CatalogRelationIndex {
  dashboardOptions: RelatedFilterOption[];
  datasetOptions: RelatedFilterOption[];
  chartOptions: RelatedFilterOption[];
  sourceOptions: RelatedFilterOption[];
  dashboardRelationsById: Map<number, RelationBag>;
  datasetRelationsById: Map<number, RelationBag>;
  chartRelationsById: Map<number, RelationBag>;
  sourceRelationsById: Map<number, RelationBag>;
  dashboardLabelsById: Map<number, string>;
  datasetLabelsById: Map<number, string>;
  chartLabelsById: Map<number, string>;
  sourceLabelsById: Map<number, string>;
}

interface BuildCatalogRelationIndexArgs {
  dashboards: Dashboard[];
  datasets: Dataset[];
  charts: Chart[];
  datasources: DataSource[];
}

const EMPTY_RELATION_BAG: RelationBag = {
  dashboardIds: new Set<number>(),
  datasetIds: new Set<number>(),
  chartIds: new Set<number>(),
  sourceIds: new Set<number>(),
};

function getOptionPool(index: CatalogRelationIndex, key: RelatedFilterKey): RelatedFilterOption[] {
  if (key === 'dashboard') {
    return index.dashboardOptions;
  }
  if (key === 'dataset') {
    return index.datasetOptions;
  }
  if (key === 'chart') {
    return index.chartOptions;
  }
  return index.sourceOptions;
}

function getRelationPool(index: CatalogRelationIndex, key: RelatedFilterKey): Map<number, RelationBag> {
  if (key === 'dashboard') {
    return index.dashboardRelationsById;
  }
  if (key === 'dataset') {
    return index.datasetRelationsById;
  }
  if (key === 'chart') {
    return index.chartRelationsById;
  }
  return index.sourceRelationsById;
}

function asId(value: number | string | null | undefined): number | null {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function uniqueIds(values: Array<number | string | null | undefined>): number[] {
  const seen = new Set<number>();
  const output: number[] = [];
  for (const value of values) {
    const id = asId(value);
    if (id === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    output.push(id);
  }
  return output;
}

function pushMapValue(map: Map<number, Set<number>>, sourceId: number | null, targetId: number | null): void {
  if (sourceId === null || targetId === null) {
    return;
  }
  const bucket = map.get(sourceId);
  if (bucket) {
    bucket.add(targetId);
    return;
  }
  map.set(sourceId, new Set<number>([targetId]));
}

function buildLabelMap<T extends { id: number; name: string }>(items: T[]): Map<number, string> {
  return new Map(items.map((item) => [item.id, item.name]));
}

function buildOptions(labelMap: Map<number, string>): RelatedFilterOption[] {
  return Array.from(labelMap.entries())
    .sort((left, right) => left[1].localeCompare(right[1], undefined, { sensitivity: 'base' }))
    .map(([id, label]) => ({ value: String(id), label }));
}

function buildRelationBag(args: {
  dashboardIds?: number[];
  datasetIds?: number[];
  chartIds?: number[];
  sourceIds?: number[];
}): RelationBag {
  return {
    dashboardIds: new Set(args.dashboardIds ?? []),
    datasetIds: new Set(args.datasetIds ?? []),
    chartIds: new Set(args.chartIds ?? []),
    sourceIds: new Set(args.sourceIds ?? []),
  };
}

function resolveDashboardChart(chartRef: Dashboard['dashboard_charts'][number], chartById: Map<number, Chart>): Chart | null {
  const fallbackChartId = asId(chartRef.chart?.id ?? chartRef.chart_id);
  if (fallbackChartId === null) {
    return chartRef.chart ?? null;
  }
  const fallbackChart = chartById.get(fallbackChartId) ?? null;
  if (!chartRef.chart) {
    return fallbackChart;
  }
  if (!fallbackChart) {
    return chartRef.chart;
  }
  return {
    ...fallbackChart,
    ...chartRef.chart,
    dataset_id: chartRef.chart.dataset_id ?? fallbackChart.dataset_id,
    dataset_name: chartRef.chart.dataset_name ?? fallbackChart.dataset_name,
    dataset_table_name: chartRef.chart.dataset_table_name ?? fallbackChart.dataset_table_name,
    datasource_id: chartRef.chart.datasource_id ?? fallbackChart.datasource_id,
  };
}

export function buildCatalogRelationIndex({
  dashboards,
  datasets,
  charts,
  datasources,
}: BuildCatalogRelationIndexArgs): CatalogRelationIndex {
  const chartById = new Map<number, Chart>(charts.map((chart) => [chart.id, chart]));

  const dashboardLabelsById = buildLabelMap(dashboards);
  const datasetLabelsById = buildLabelMap(datasets);
  const chartLabelsById = buildLabelMap(charts);
  const sourceLabelsById = buildLabelMap(datasources);

  const chartToDashboardIds = new Map<number, Set<number>>();
  const datasetToDashboardIds = new Map<number, Set<number>>();
  const sourceToDashboardIds = new Map<number, Set<number>>();
  const datasetToChartIds = new Map<number, Set<number>>();
  const sourceToChartIds = new Map<number, Set<number>>();
  const sourceToDatasetIds = new Map<number, Set<number>>();

  const dashboardRelationsById = new Map<number, RelationBag>();
  for (const dashboard of dashboards) {
    const relatedCharts = (dashboard.dashboard_charts ?? [])
      .map((dashboardChart) => resolveDashboardChart(dashboardChart, chartById))
      .filter((chart): chart is Chart => chart !== null);
    const chartIds = uniqueIds([
      ...relatedCharts.map((chart) => chart.id),
      ...(dashboard.dashboard_charts ?? []).map((dashboardChart) => dashboardChart.chart_id),
    ]);
    const datasetIds = uniqueIds(relatedCharts.map((chart) => chart.dataset_id));
    const sourceIds = uniqueIds(relatedCharts.map((chart) => chart.datasource_id));

    dashboardRelationsById.set(
      dashboard.id,
      buildRelationBag({
        dashboardIds: [dashboard.id],
        datasetIds,
        chartIds,
        sourceIds,
      }),
    );

    for (const chartId of chartIds) {
      pushMapValue(chartToDashboardIds, chartId, dashboard.id);
    }
    for (const datasetId of datasetIds) {
      pushMapValue(datasetToDashboardIds, datasetId, dashboard.id);
    }
    for (const sourceId of sourceIds) {
      pushMapValue(sourceToDashboardIds, sourceId, dashboard.id);
    }
  }

  for (const chart of charts) {
    pushMapValue(datasetToChartIds, asId(chart.dataset_id), chart.id);
    pushMapValue(sourceToChartIds, asId(chart.datasource_id), chart.id);
  }

  for (const dataset of datasets) {
    for (const sourceId of uniqueIds(dataset.datasource_ids ?? [])) {
      pushMapValue(sourceToDatasetIds, sourceId, dataset.id);
    }
  }

  const chartRelationsById = new Map<number, RelationBag>();
  for (const chart of charts) {
    const datasetId = asId(chart.dataset_id);
    const sourceId = asId(chart.datasource_id);
    chartRelationsById.set(
      chart.id,
      buildRelationBag({
        dashboardIds: Array.from(chartToDashboardIds.get(chart.id) ?? []),
        datasetIds: datasetId === null ? [] : [datasetId],
        chartIds: [chart.id],
        sourceIds: sourceId === null ? [] : [sourceId],
      }),
    );
  }

  const datasetRelationsById = new Map<number, RelationBag>();
  for (const dataset of datasets) {
    datasetRelationsById.set(
      dataset.id,
      buildRelationBag({
        dashboardIds: Array.from(datasetToDashboardIds.get(dataset.id) ?? []),
        datasetIds: [dataset.id],
        chartIds: Array.from(datasetToChartIds.get(dataset.id) ?? []),
        sourceIds: uniqueIds(dataset.datasource_ids ?? []),
      }),
    );
  }

  const sourceRelationsById = new Map<number, RelationBag>();
  for (const datasource of datasources) {
    sourceRelationsById.set(
      datasource.id,
      buildRelationBag({
        dashboardIds: Array.from(sourceToDashboardIds.get(datasource.id) ?? []),
        datasetIds: Array.from(sourceToDatasetIds.get(datasource.id) ?? []),
        chartIds: Array.from(sourceToChartIds.get(datasource.id) ?? []),
        sourceIds: [datasource.id],
      }),
    );
  }

  return {
    dashboardOptions: buildOptions(dashboardLabelsById),
    datasetOptions: buildOptions(datasetLabelsById),
    chartOptions: buildOptions(chartLabelsById),
    sourceOptions: buildOptions(sourceLabelsById),
    dashboardRelationsById,
    datasetRelationsById,
    chartRelationsById,
    sourceRelationsById,
    dashboardLabelsById,
    datasetLabelsById,
    chartLabelsById,
    sourceLabelsById,
  };
}

export function matchesRelatedFilters(relations: RelationBag | undefined, filters: RelatedFilters): boolean {
  const resolvedRelations = relations ?? EMPTY_RELATION_BAG;

  return (
    (!filters.dashboard || resolvedRelations.dashboardIds.has(Number(filters.dashboard))) &&
    (!filters.dataset || resolvedRelations.datasetIds.has(Number(filters.dataset))) &&
    (!filters.chart || resolvedRelations.chartIds.has(Number(filters.chart))) &&
    (!filters.source || resolvedRelations.sourceIds.has(Number(filters.source)))
  );
}

export function getRelatedFilterLabel(
  index: CatalogRelationIndex,
  key: RelatedFilterKey,
  value: string | undefined,
): string {
  const id = asId(value);
  if (id === null) {
    return String(value ?? '');
  }

  if (key === 'dashboard') {
    return index.dashboardLabelsById.get(id) ?? `#${id}`;
  }
  if (key === 'dataset') {
    return index.datasetLabelsById.get(id) ?? `#${id}`;
  }
  if (key === 'chart') {
    return index.chartLabelsById.get(id) ?? `#${id}`;
  }
  return index.sourceLabelsById.get(id) ?? `#${id}`;
}

export function getAvailableRelatedOptions(
  index: CatalogRelationIndex,
  key: RelatedFilterKey,
  filters: RelatedFilters,
): RelatedFilterOption[] {
  const relationPool = getRelationPool(index, key);
  const optionPool = getOptionPool(index, key);
  const scopedFilters: RelatedFilters = {
    ...filters,
    [key]: undefined,
  };

  return optionPool.filter((option) => {
    const optionId = asId(option.value);
    if (optionId === null) {
      return false;
    }
    return matchesRelatedFilters(relationPool.get(optionId), scopedFilters);
  });
}