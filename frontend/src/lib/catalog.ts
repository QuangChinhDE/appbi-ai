/**
 * Catalog client — talks ONLY to AppBI's /api/v1/catalog/* proxy.
 * Native AppBI backend (its own Postgres) — no third-party catalog server.
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

// ── Managed Metrics (metrics quản trị doanh nghiệp) — AUTHORED KPIs ──────────
export interface ManagedMetric {
  name: string;                 // display name
  machine_name: string;         // stable id
  fqn: string;
  definition?: string | null;
  formula?: string | null;
  unit?: string | null;
  grain?: string | null;        // daily|weekly|monthly|quarterly|yearly|point_in_time
  category?: string | null;
  direction: 'up_good' | 'down_good' | 'neutral';
  target_value?: number | null;
  target_operator?: string | null;   // >= | <= | = | between
  target_value2?: number | null;
  owner?: string | null;
  related_term_fqn?: string | null;
  dataset_id?: number | null;
  dataset_table_id?: number | null;
  measure_ref?: string | null;
  home_doc_id?: number | null;  // knowledge doc where this metric is DEFINED (home/SSOT)
  anchor?: string | null;
  synonyms: string[];
  status: 'Draft' | 'Approved' | 'Deprecated';
  version: number;
  provider?: string | null;
  updated_at?: string | null;
  /** Resolved on LIST — title of the home doc + how many docs reuse it. */
  home_doc_title?: string | null;
  usage_count?: number;
}

/** A minimal knowledge-doc reference used in metric lineage + asset-docs. */
export interface KnowledgeDocRef {
  id: number;
  title: string;
  space: string;
}

export interface ManagedMetricLineage {
  home_doc: KnowledgeDocRef | null;
  used_in: KnowledgeDocRef[];
}

/** GET one managed metric — carries the reuse/SSOT lineage graph. */
export interface ManagedMetricDetail extends ManagedMetric {
  lineage?: ManagedMetricLineage;
}

export interface ManagedMetricWrite {
  name: string;
  machine_name?: string;        // set on EDIT
  definition?: string;
  formula?: string;
  unit?: string;
  grain?: string;
  category?: string;
  direction?: 'up_good' | 'down_good' | 'neutral';
  target_value?: number | null;
  target_operator?: string;
  target_value2?: number | null;
  owner?: string;
  related_term_fqn?: string;
  dataset_id?: number | null;
  dataset_table_id?: number | null;
  measure_ref?: string;
  home_doc_id?: number | null;
  anchor?: string;
  synonyms?: string[];
  status?: 'Draft' | 'Approved' | 'Deprecated';
}

export interface GovernChangeEntry {
  id: number;
  entity_type: string;
  entity_fqn: string;
  action: string;
  summary?: string | null;
  changed_by?: string | null;
  created_at?: string | null;
}

export async function listManagedMetrics(params?: { category?: string; status?: string }): Promise<ManagedMetric[]> {
  const { data } = await apiClient.get<{ metrics: ManagedMetric[] }>('/catalog/govern/managed-metrics', { params });
  return data.metrics ?? [];
}

/** Fetch a single managed metric (by machine_name) with its SSOT + reuse lineage. */
export async function getManagedMetric(machineName: string): Promise<ManagedMetricDetail> {
  const { data } = await apiClient.get<ManagedMetricDetail>(`/catalog/govern/managed-metric/${encodeURIComponent(machineName)}`);
  return data;
}

export async function upsertManagedMetric(body: ManagedMetricWrite): Promise<{ machine_name: string; version: number }> {
  const { data } = await apiClient.put('/catalog/govern/managed-metric', body);
  return data;
}

export async function deleteManagedMetric(name: string): Promise<void> {
  await apiClient.delete(`/catalog/govern/managed-metric/${encodeURIComponent(name)}`);
}

export async function getGovernChangeLog(params?: { entity_type?: string; entity_fqn?: string; limit?: number }): Promise<GovernChangeEntry[]> {
  const { data } = await apiClient.get<{ entries: GovernChangeEntry[] }>('/catalog/govern/change-log', { params });
  return data.entries ?? [];
}

// ── Knowledge Hub (Cẩm nang tri thức) ───────────────────────────────────────
export interface KnowledgeDoc {
  id: number;
  title: string;
  slug?: string | null;
  space: string;
  parent_id?: number | null;
  position: number;
  doc_type: string;             // overview|guide|domain|process|faq|article
  summary?: string | null;
  body?: string;                // markdown (only on GET one)
  tags: string[];
  related_metrics: string[];
  related_terms: string[];
  related_dashboard_ids: number[];
  related_dataset_ids: number[];
  status: 'Draft' | 'Published' | 'Archived';
  version: number;
  pinned: boolean;
  owner?: string | null;
  updated_at?: string | null;
  /** Resolved on GET one — metric embed tokens ({{metric:slug}}) → cards. */
  metrics_on_page?: (ManagedMetric & { is_source: boolean })[];
  missing_metric_tokens?: string[];
  /** Resolved on GET one — asset embed tokens ({{dashboard|dataset|term:...}}). */
  assets_on_page?: KnowledgeAsset[];
  /** Resolved on GET one — the knowledge-graph neighborhood with reasons. */
  related_docs?: RelatedDoc[];
  // ── Knowledge Hub metadata + AI section + usage telemetry ──
  business_domain?: string | null;
  process_ref?: string | null;
  review_date?: string | null;          // YYYY-MM-DD
  last_verified_at?: string | null;
  importance?: 'low' | 'normal' | 'high' | string;
  ai_summary?: string | null;
  ai_keywords?: string[];
  view_count?: number;
  retrieval_count?: number;
  /** Deterministic AI-readiness score + machine keys of what's missing. */
  ai_ready?: { score: number; missing: string[] };
}

export interface RelatedDoc {
  id: number;
  title: string;
  space: string;
  shared_metrics: string[];
  shared_dashboards?: string[];
  shared_datasets?: string[];
  shared_tags?: string[];
}

export interface KnowledgeAsset {
  type: 'dashboard' | 'dataset' | 'term';
  ref: string;
  name?: string | null;
  description?: string | null;
  definition?: string | null;
  open_path?: string | null;
  exists: boolean;
}

export interface KnowledgeSpace { space: string; count: number; }

export interface KnowledgeDocWrite {
  id?: number;
  title: string;
  space?: string;
  parent_id?: number | null;
  position?: number;
  doc_type?: string;
  summary?: string;
  body?: string;
  tags?: string[];
  related_metrics?: string[];
  related_terms?: string[];
  related_dashboard_ids?: number[];
  related_dataset_ids?: number[];
  status?: 'Draft' | 'Published' | 'Archived';
  pinned?: boolean;
  owner?: string;
  change_note?: string;         // optional note recorded on the version snapshot
  business_domain?: string;
  process_ref?: string;
  review_date?: string | null;  // YYYY-MM-DD
  importance?: string;          // low|normal|high
}

export async function listKnowledge(params?: { space?: string; status?: string }): Promise<{ docs: KnowledgeDoc[]; spaces: KnowledgeSpace[] }> {
  const { data } = await apiClient.get<{ docs: KnowledgeDoc[]; spaces: KnowledgeSpace[] }>('/catalog/govern/knowledge', { params });
  return { docs: data.docs ?? [], spaces: data.spaces ?? [] };
}

export async function getKnowledgeDoc(id: number): Promise<KnowledgeDoc> {
  const { data } = await apiClient.get<KnowledgeDoc>(`/catalog/govern/knowledge/${id}`);
  return data;
}

export async function upsertKnowledgeDoc(body: KnowledgeDocWrite): Promise<{ id: number; version: number; slug: string }> {
  const { data } = await apiClient.put('/catalog/govern/knowledge', body);
  return data;
}

export async function deleteKnowledgeDoc(id: number): Promise<void> {
  await apiClient.delete(`/catalog/govern/knowledge/${id}`);
}

// Version history (locked snapshots of a business doc over time)
export interface KnowledgeDocVersion {
  version: number;
  title: string;
  status?: string | null;
  change_note?: string | null;
  changed_by?: string | null;
  created_at?: string | null;
  space?: string | null;
  doc_type?: string | null;
  summary?: string | null;
  body?: string;
}

export async function listDocVersions(docId: number): Promise<KnowledgeDocVersion[]> {
  const { data } = await apiClient.get<{ versions: KnowledgeDocVersion[] }>(`/catalog/govern/knowledge/${docId}/versions`);
  return data.versions ?? [];
}

export async function getDocVersion(docId: number, version: number): Promise<KnowledgeDocVersion> {
  const { data } = await apiClient.get<KnowledgeDocVersion>(`/catalog/govern/knowledge/${docId}/versions/${version}`);
  return data;
}

// AI-drafted document: the backend reads the dataset's real model + sample +
// metrics and writes a business doc (unsaved) for the user to review/edit.
export interface KnowledgeDraft {
  title: string;
  summary: string;
  body: string;
  tags: string[];
  space?: string;
  related_dataset_ids?: number[];
  related_dashboard_ids?: number[];
}
export interface AiDraftReq { dataset_ids: number[]; dashboard_ids?: number[]; focus?: string }
export async function aiDraftKnowledge(req: AiDraftReq): Promise<KnowledgeDraft> {
  const { data } = await apiClient.post<KnowledgeDraft>('/catalog/govern/knowledge/ai-draft', {
    dataset_ids: req.dataset_ids,
    dashboard_ids: req.dashboard_ids ?? [],
    focus: req.focus ?? null,
  });
  return data;
}

// ── Knowledge Hub: search everything / insights / AI summary / verify ───────
export interface SearchHit { id: number | string; name: string; subtitle?: string; open_path?: string }
export interface GovernSearchResult {
  documents: SearchHit[]; metrics: SearchHit[]; terms: SearchHit[]; dashboards: SearchHit[]; datasets: SearchHit[];
}
export async function governSearch(q: string): Promise<GovernSearchResult> {
  const { data } = await apiClient.get<GovernSearchResult>('/catalog/govern/search', { params: { q } });
  return {
    documents: data.documents ?? [], metrics: data.metrics ?? [], terms: data.terms ?? [],
    dashboards: data.dashboards ?? [], datasets: data.datasets ?? [],
  };
}

export interface InsightRef { id: number; title: string; count?: number }
export interface KnowledgeInsights {
  no_owner: InsightRef[]; no_summary: InsightRef[]; no_tags: InsightRef[];
  stale_review: InsightRef[]; not_embedded: InsightRef[];
  most_viewed: InsightRef[]; most_retrieved: InsightRef[];
}
export async function knowledgeInsights(): Promise<KnowledgeInsights> {
  const { data } = await apiClient.get<KnowledgeInsights>('/catalog/govern/knowledge/insights');
  return data;
}

export async function regenAiSummary(docId: number): Promise<{ ai_summary: string; ai_keywords: string[] }> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/ai-summary`);
  return { ai_summary: data.ai_summary ?? '', ai_keywords: data.ai_keywords ?? [] };
}

export async function verifyDoc(docId: number): Promise<{ last_verified_at: string }> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/verify`);
  return data;
}

export interface DatasetLite { id: number; name: string }
export async function listDatasetsLite(): Promise<DatasetLite[]> {
  const { data } = await apiClient.get<unknown>('/datasets/');
  const arr = Array.isArray(data) ? data : ((data as { datasets?: unknown[]; items?: unknown[] })?.datasets ?? (data as { items?: unknown[] })?.items ?? []);
  return (arr as { id: number; name: string }[]).map((d) => ({ id: d.id, name: d.name }));
}

/** Reverse lineage: knowledge docs that reference a given dashboard/dataset/term. */
export async function assetDocs(
  assetType: 'dashboard' | 'dataset' | 'term',
  assetRef: string | number,
): Promise<KnowledgeDocRef[]> {
  const { data } = await apiClient.get<{ docs: KnowledgeDocRef[] }>('/catalog/govern/asset-docs', {
    params: { asset_type: assetType, asset_ref: String(assetRef) },
  });
  return data.docs ?? [];
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
