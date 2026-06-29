/**
 * Catalog client — talks ONLY to AppBI's /api/v1/catalog/* proxy.
 * No OpenMetadata URL ever reaches the browser; AppBI proxies the hidden OM.
 * Powers the Govern + Observability modules.
 */
import { apiClient } from './api-client';

export interface CatalogStatus {
  enabled: boolean;
  connected: boolean;
}

// ── Govern ────────────────────────────────────────────────────────────────
export interface Glossary {
  name: string;            // display name
  machine_name: string;    // stable identifier
  fqn: string;
  description?: string | null;
  termCount: number;
  provider?: string | null;
}
export interface GlossaryTerm {
  name: string;            // display name
  machine_name: string;    // stable identifier
  fqn: string;
  definition?: string | null;
  synonyms: string[];
  status?: string | null;
  glossary?: string | null;     // display name of the parent glossary
  glossaryFqn?: string | null;  // parent glossary machine name (filter + create)
  provider?: string | null;
}
export interface Classification {
  name: string;
  machine_name: string;
  fqn: string;
  description?: string | null;
  termCount: number;
  mutuallyExclusive: boolean;
  provider?: string | null;
}
export interface Tag {
  name: string;
  machine_name: string;
  fqn: string;
  description?: string | null;
  classification?: string | null;
  provider?: string | null;
}
export interface VocabRef {
  fqn: string;
  label: string;
}
export interface Metric {
  name: string;
  label: string;
  type: string;
  definition: string;
  format?: string | null;
  description?: string | null;
  hidden: boolean;
  dataset?: string | null;
  dataset_id?: number | null;
  owner?: string | null;
  shared?: boolean;
  table?: string | null;
  source?: string | null;
  view_id?: number;
  table_id?: number | null;
  conflict?: boolean;
  variants?: number;
  distinctDefs?: number;
  sameSourceCount?: number;
  glossaryTerms?: VocabRef[];
  tags?: VocabRef[];
}
export interface MetricPatch {
  view_id: number;
  name: string;
  label?: string;
  description?: string;
  glossary_terms?: VocabRef[];
  tags?: VocabRef[];
}
export interface VocabUsageMetric {
  name: string;
  label: string;
  type: string;
  dataset?: string | null;
  dataset_id?: number | null;
  table?: string | null;
  view_id?: number;
  table_id?: number | null;
}
export interface VocabUsage {
  fqn: string;
  metrics: VocabUsageMetric[];
  count: number;
}
export interface MetricsLibrary {
  metrics: Metric[];
  total: number;
  datasets: number;
  conflicts: number;
}
export interface MetricVariants {
  name: string;
  count: number;
  distinctDefinitions: number;
  variants: Metric[];
}
export interface MetricUsageChart { id: number; name: string; chartType?: string | null; dashboardIds: number[]; }
export interface MetricUsageDashboard { id: number; name: string; }
export interface MetricUsage {
  charts: MetricUsageChart[];
  dashboards: MetricUsageDashboard[];
  chartCount: number;
  dashboardCount: number;
}

// ── Observability ───────────────────────────────────────────────────────────
export interface DataQualitySummary {
  total: number;
  success: number;
  failed: number;
  aborted: number;
  successRate: number;
}
export interface DataQualityTest {
  name: string;
  fqn: string;
  status: string;
  entity?: string | null;
}
export interface Incident {
  id?: string;
  testCase?: string | null;
  severity?: string | null;
  status?: string | null;
  assignee?: string | null;
  timestamp?: number | null;
}
export interface Alert {
  name: string;
  fqn: string;
  description?: string | null;
  enabled: boolean;
  alertType?: string | null;
}

export async function getCatalogStatus(): Promise<CatalogStatus> {
  const { data } = await apiClient.get<CatalogStatus>('/catalog/status');
  return data;
}

// ── Glossary CRUD (OM-backed) ───────────────────────────────────────────────
export async function getGlossaries(): Promise<Glossary[]> {
  const { data } = await apiClient.get<{ glossaries: Glossary[] }>('/catalog/govern/glossaries');
  return data.glossaries ?? [];
}
export async function listGlossaryTerms(): Promise<GlossaryTerm[]> {
  const { data } = await apiClient.get<{ terms: GlossaryTerm[] }>('/catalog/govern/glossary');
  return data.terms ?? [];
}
export async function upsertGlossary(body: { name: string; description?: string; machine_name?: string }): Promise<void> {
  await apiClient.put('/catalog/govern/glossary', body);
}
export async function deleteGlossary(fqn: string): Promise<void> {
  await apiClient.delete(`/catalog/govern/glossary/${encodeURIComponent(fqn)}`);
}
export async function upsertTerm(body: { glossary: string; name: string; description?: string; synonyms?: string[]; machine_name?: string }): Promise<void> {
  await apiClient.put('/catalog/govern/glossary-term', body);
}
export async function deleteTerm(fqn: string): Promise<void> {
  await apiClient.delete(`/catalog/govern/glossary-term/${encodeURIComponent(fqn)}`);
}

// ── Classification CRUD (OM-backed) ─────────────────────────────────────────
export async function listClassifications(): Promise<Classification[]> {
  const { data } = await apiClient.get<{ classifications: Classification[] }>('/catalog/govern/classifications');
  return data.classifications ?? [];
}
export async function getTags(classification?: string): Promise<Tag[]> {
  const { data } = await apiClient.get<{ tags: Tag[] }>('/catalog/govern/tags', { params: classification ? { classification } : {} });
  return data.tags ?? [];
}
export async function upsertClassification(body: { name: string; description?: string; mutuallyExclusive?: boolean; machine_name?: string }): Promise<void> {
  await apiClient.put('/catalog/govern/classification', body);
}
export async function deleteClassification(fqn: string): Promise<void> {
  await apiClient.delete(`/catalog/govern/classification/${encodeURIComponent(fqn)}`);
}
export async function upsertTag(body: { classification: string; name: string; description?: string; machine_name?: string }): Promise<void> {
  await apiClient.put('/catalog/govern/tag', body);
}
export async function deleteTag(fqn: string): Promise<void> {
  await apiClient.delete(`/catalog/govern/tag/${encodeURIComponent(fqn)}`);
}
export async function getMetrics(): Promise<MetricsLibrary> {
  const { data } = await apiClient.get<MetricsLibrary>('/catalog/govern/metrics');
  return { metrics: data.metrics ?? [], total: data.total ?? 0, datasets: data.datasets ?? 0, conflicts: data.conflicts ?? 0 };
}

export async function getMetricVariants(name: string): Promise<MetricVariants> {
  const { data } = await apiClient.get<MetricVariants>('/catalog/govern/metric-variants', { params: { name } });
  return { name: data.name, count: data.count ?? 0, distinctDefinitions: data.distinctDefinitions ?? 0, variants: data.variants ?? [] };
}

export async function getMetricUsage(tableId: number, name: string): Promise<MetricUsage> {
  const { data } = await apiClient.get<MetricUsage>('/catalog/govern/metric-usage', {
    params: { table_id: tableId, name },
  });
  return data;
}

export async function updateMetric(patch: MetricPatch): Promise<void> {
  await apiClient.patch('/catalog/govern/metric', patch);
}

/** Reverse lineage: metrics that have a given glossary term / classification tag attached. */
export async function getVocabUsage(fqn: string): Promise<VocabUsage> {
  const { data } = await apiClient.get<VocabUsage>('/catalog/govern/vocab-usage', { params: { fqn } });
  return { fqn: data.fqn, metrics: data.metrics ?? [], count: data.count ?? 0 };
}

export async function getDataQuality(): Promise<{ summary: DataQualitySummary; tests: DataQualityTest[] }> {
  const { data } = await apiClient.get<{ summary: DataQualitySummary; tests: DataQualityTest[] }>(
    '/catalog/observability/data-quality',
  );
  return data;
}
export async function listIncidents(): Promise<Incident[]> {
  const { data } = await apiClient.get<{ incidents: Incident[] }>('/catalog/observability/incidents');
  return data.incidents ?? [];
}
export async function listAlerts(): Promise<Alert[]> {
  const { data } = await apiClient.get<{ alerts: Alert[] }>('/catalog/observability/alerts');
  return data.alerts ?? [];
}

// ── AppBI-native Data Quality rollup (the real engine, surfaced org-wide) ────
export interface QualityDatasetRow {
  dataset_id: number;
  dataset: string;
  owner?: string | null;
  score?: number | null;
  totalRules: number;
  enabledRules: number;
  coveredTables: number;
  passed: number;
  failed: number;
  lastRunStatus?: string | null;
  lastRunAt?: string | null;
}
export interface QualityIncident {
  dataset_id: number;
  dataset: string;
  table?: string | null;
  column?: string | null;
  rule: string;
  dimension: string;
  severity: string;
  rowsFailed?: number | null;
  error?: boolean;
  lastRunAt?: string | null;
}
export interface QualityOverview {
  summary: { datasets: number; totalRules: number; enabledRules: number; passed: number; failed: number; incidents: number; avgScore?: number | null };
  datasets: QualityDatasetRow[];
  incidents: QualityIncident[];
  candidates: { dataset_id: number; dataset: string }[];
}
export async function getQualityOverview(): Promise<QualityOverview> {
  const { data } = await apiClient.get<QualityOverview>('/catalog/observability/quality-overview');
  return {
    summary: data.summary ?? { datasets: 0, totalRules: 0, enabledRules: 0, passed: 0, failed: 0, incidents: 0, avgScore: null },
    datasets: data.datasets ?? [],
    incidents: data.incidents ?? [],
    candidates: data.candidates ?? [],
  };
}
