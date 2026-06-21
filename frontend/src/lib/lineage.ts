/**
 * System data-lineage graph for the Overview page.
 *
 * Columns: Source -> Table -> Dataset -> Chart -> Dashboard, plus a Workboard
 * column branching off Datasets.
 *
 * Table nodes (and the Source/Table/Dataset/Chart edges) are derived from the
 * chart list — every chart carries dataset_table_id / dataset_table_name /
 * datasource_id / dataset_id — so the whole board is built from data already
 * fetched, with no extra requests. Workboard -> Dataset comes from the
 * workboard's dataset_id; the workboard's own tables are resolved lazily in
 * the drill-down.
 */
import type { Dataset } from '@/hooks/use-datasets';
import type { Chart, Dashboard, DataSource } from '@/types/api';
import type { Workboard } from '@/lib/api/workboards';

export type LineageKind = 'source' | 'table' | 'dataset' | 'chart' | 'dashboard' | 'workboard';

export interface LineageRef {
  kind: LineageKind;
  id: number;
}

export type EdgeType =
  | 'source-table'
  | 'table-dataset'
  | 'source-dataset'
  | 'dataset-chart'
  | 'chart-dashboard'
  | 'dataset-workboard';

export interface LineageNode {
  key: string; // `${kind}:${id}`
  kind: LineageKind;
  id: number;
  name: string;
  sub?: string;
}

export interface LineageEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface LineageColumns {
  source: LineageNode[];
  table: LineageNode[];
  dataset: LineageNode[];
  chart: LineageNode[];
  dashboard: LineageNode[];
  workboard: LineageNode[];
}

export interface LineageGraph {
  columns: LineageColumns;
  edges: LineageEdge[];
  nodeByKey: Map<string, LineageNode>;
  counts: Record<LineageKind, number>;
  /** Undirected connected component of a node (for highlight). */
  connectedKeys: (key: string) => Set<string>;
  /** Forward-reachable output counts from a node (impact analysis). */
  impactOf: (key: string) => { charts: number; dashboards: number; workboards: number };
}

interface BuildArgs {
  dataSources: DataSource[];
  datasets: Dataset[];
  charts: Chart[];
  dashboards: Dashboard[];
  workboards: Workboard[];
}

export const keyOf = (kind: LineageKind, id: number): string => `${kind}:${id}`;

const DATASOURCE_TYPE_LABEL: Record<string, string> = {
  postgresql: 'PostgreSQL',
  bigquery: 'BigQuery',
  google_sheets: 'Google Sheets',
  mysql: 'MySQL',
  snowflake: 'Snowflake',
};

function num(value: number | string | null | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function buildLineageGraph({
  dataSources,
  datasets,
  charts,
  dashboards,
  workboards,
}: BuildArgs): LineageGraph {
  const nodeByKey = new Map<string, LineageNode>();
  const add = (node: LineageNode) => {
    if (!nodeByKey.has(node.key)) nodeByKey.set(node.key, node);
  };

  const sourceNameById = new Map<number, string>();
  for (const s of dataSources) {
    sourceNameById.set(s.id, s.name);
    add({
      key: keyOf('source', s.id),
      kind: 'source',
      id: s.id,
      name: s.name,
      sub: DATASOURCE_TYPE_LABEL[String(s.type)] ?? String(s.type),
    });
  }
  for (const d of datasets) {
    add({ key: keyOf('dataset', d.id), kind: 'dataset', id: d.id, name: d.name });
  }
  for (const d of dashboards) {
    add({ key: keyOf('dashboard', d.id), kind: 'dashboard', id: d.id, name: d.name });
  }
  for (const w of workboards) {
    add({
      key: keyOf('workboard', w.id),
      kind: 'workboard',
      id: w.id,
      name: w.name,
      sub: w.is_published ? undefined : 'Draft',
    });
  }

  const edgeSet = new Set<string>();
  const edges: LineageEdge[] = [];
  const pushEdge = (from: string, to: string, type: EdgeType) => {
    const sig = `${from}->${to}`;
    if (edgeSet.has(sig)) return;
    edgeSet.add(sig);
    edges.push({ from, to, type });
  };

  // Tables + Source/Table/Dataset/Chart edges, derived from charts.
  const chartById = new Map<number, Chart>(charts.map((c) => [c.id, c]));
  for (const chart of charts) {
    add({ key: keyOf('chart', chart.id), kind: 'chart', id: chart.id, name: chart.name, sub: String(chart.chart_type ?? '') || undefined });

    const datasetId = num(chart.dataset_id);
    const sourceId = num(chart.datasource_id);
    const tableId = num(chart.dataset_table_id);

    if (tableId != null) {
      const tableKey = keyOf('table', tableId);
      add({
        key: tableKey,
        kind: 'table',
        id: tableId,
        name: chart.dataset_table_name ?? `table #${tableId}`,
        sub: sourceId != null ? sourceNameById.get(sourceId) : undefined,
      });
      if (sourceId != null) pushEdge(keyOf('source', sourceId), tableKey, 'source-table');
      if (datasetId != null) pushEdge(tableKey, keyOf('dataset', datasetId), 'table-dataset');
    }
    // Board flow is Source → Dataset → Chart → Dashboard (the Table column is not
    // shown). `source-dataset` is the drawn edge between the Source and Dataset
    // columns; `source-table` / `table-dataset` are kept for the drill-down detail.
    if (sourceId != null && datasetId != null) {
      pushEdge(keyOf('source', sourceId), keyOf('dataset', datasetId), 'source-dataset');
    }
    if (datasetId != null) {
      pushEdge(keyOf('dataset', datasetId), keyOf('chart', chart.id), 'dataset-chart');
    }
  }

  // Chart -> Dashboard edges.
  for (const dashboard of dashboards) {
    const dcs = (dashboard.dashboard_charts ?? []) as Array<{ chart?: Chart; chart_id?: number }>;
    for (const dc of dcs) {
      const chartId = num(dc.chart?.id ?? dc.chart_id);
      if (chartId == null) continue;
      if (!nodeByKey.has(keyOf('chart', chartId))) {
        const chart = dc.chart ?? chartById.get(chartId);
        add({
          key: keyOf('chart', chartId),
          kind: 'chart',
          id: chartId,
          name: chart?.name ?? `chart #${chartId}`,
        });
      }
      pushEdge(keyOf('chart', chartId), keyOf('dashboard', dashboard.id), 'chart-dashboard');
    }
  }

  // Dataset -> Workboard edges.
  for (const w of workboards) {
    const datasetId = num(w.dataset_id);
    if (datasetId != null) pushEdge(keyOf('dataset', datasetId), keyOf('workboard', w.id), 'dataset-workboard');
  }

  // Adjacency (undirected for highlight, forward for impact).
  const undirected = new Map<string, Set<string>>();
  const forward = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, a: string, b: string) => {
    const bucket = map.get(a);
    if (bucket) bucket.add(b);
    else map.set(a, new Set([b]));
  };
  for (const e of edges) {
    link(undirected, e.from, e.to);
    link(undirected, e.to, e.from);
    link(forward, e.from, e.to);
  }

  const connectedKeys = (key: string): Set<string> => {
    const seen = new Set<string>([key]);
    const stack = [key];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of undirected.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };

  const impactOf = (key: string) => {
    const seen = new Set<string>([key]);
    const stack = [key];
    let cCharts = 0;
    let cDashboards = 0;
    let cWorkboards = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of forward.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
        const node = nodeByKey.get(next);
        if (node?.kind === 'chart') cCharts += 1;
        else if (node?.kind === 'dashboard') cDashboards += 1;
        else if (node?.kind === 'workboard') cWorkboards += 1;
      }
    }
    return { charts: cCharts, dashboards: cDashboards, workboards: cWorkboards };
  };

  const byKind = (kind: LineageKind) =>
    Array.from(nodeByKey.values())
      .filter((n) => n.kind === kind)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const columns: LineageColumns = {
    source: byKind('source'),
    table: byKind('table'),
    dataset: byKind('dataset'),
    chart: byKind('chart'),
    dashboard: byKind('dashboard'),
    workboard: byKind('workboard'),
  };

  const counts: Record<LineageKind, number> = {
    source: columns.source.length,
    table: columns.table.length,
    dataset: columns.dataset.length,
    chart: columns.chart.length,
    dashboard: columns.dashboard.length,
    workboard: columns.workboard.length,
  };

  return { columns, edges, nodeByKey, counts, connectedKeys, impactOf };
}

export interface LineageFilters {
  source?: number;
  dataset?: number;
  chart?: number;
  dashboard?: number;
  workboard?: number;
}

/**
 * Which node keys are visible given entity filters + a name query. With no
 * filters everything is visible; each filter narrows to the intersection of
 * the selected nodes' connected components; the query keeps only nodes whose
 * name matches plus the rest of their connected chain.
 */
export function resolveVisibleKeys(
  graph: LineageGraph,
  filters: LineageFilters,
  query: string,
): Set<string> | null {
  const chains: Set<string>[] = [];
  const pushChain = (kind: LineageKind, id?: number) => {
    if (id) chains.push(graph.connectedKeys(keyOf(kind, id)));
  };
  pushChain('source', filters.source);
  pushChain('dataset', filters.dataset);
  pushChain('chart', filters.chart);
  pushChain('dashboard', filters.dashboard);
  pushChain('workboard', filters.workboard);

  let visible: Set<string> | null;
  if (chains.length === 0) {
    visible = null; // null = everything
  } else {
    visible = chains.reduce((acc, set) => new Set([...acc].filter((k) => set.has(k))));
  }

  const needle = query.trim().toLowerCase();
  if (!needle) return visible;

  const inScope = (key: string) => visible == null || visible.has(key);
  const matched = Array.from(graph.nodeByKey.values()).filter(
    (n) => inScope(n.key) && n.name.toLowerCase().includes(needle),
  );
  const narrowed = new Set<string>();
  for (const node of matched) {
    for (const key of graph.connectedKeys(node.key)) {
      if (inScope(key)) narrowed.add(key);
    }
  }
  return narrowed;
}
