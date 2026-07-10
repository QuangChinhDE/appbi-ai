/**
 * Catalog client — talks ONLY to AppBI's /api/v1/catalog/* proxy.
 * Native AppBI backend (its own Postgres) — no third-party catalog server.
 * Powers the Govern module (Vocabulary + Metrics + Knowledge Hub).
 */
import { apiClient } from './api-client';

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
export interface MetricsLibrary {
  metrics: Metric[];
  total: number;
  datasets: number;
  conflicts: number;
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
  /** Which version is live (RAG/public read it); may differ from the latest. */
  published_version?: number | null;
  /** [[wikilinks]] this doc points at, resolved for the reader. */
  wikilinks_on_page?: { target: string; alias?: string | null; doc_id: number | null; title: string | null; exists: boolean }[];
  /** Docs that explicitly [[link]] to this one (Obsidian backlinks). */
  backlinks?: { id: number; title: string; space: string }[];
  // ── Resource sharing / permissions (same model as Dataset) ──
  owner_id?: string | null;
  owner_email?: string | null;
  /** Caller's effective permission on this doc: none|view|edit|full. */
  user_permission?: string | null;
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
  is_published?: boolean;
  is_latest?: boolean;
}

/** Make a specific version live (RAG/public reads it); requires a change note. */
export async function publishVersion(docId: number, version: number, changeNote: string): Promise<{ published_version: number }> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/publish`, { version, change_note: changeNote });
  return data;
}
/** AI drafts a short "what changed" note from the diff (never the whole doc). */
export async function aiChangeNote(docId: number, version: number): Promise<string> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/versions/${version}/change-note-ai`);
  return data.change_note ?? '';
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

// ── Knowledge Hub: search everything / AI summary / verify ──────────────────
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

export async function regenAiSummary(docId: number): Promise<{ ai_summary: string; ai_keywords: string[] }> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/ai-summary`);
  return { ai_summary: data.ai_summary ?? '', ai_keywords: data.ai_keywords ?? [] };
}

// Whole-hub knowledge graph (Obsidian-style): docs + [[wikilink]]/shared-KPI edges.
export interface GraphNode { id: number; title: string; space: string; doc_type: string }
export interface GraphEdge { from: number; to: number; type: 'link' | 'metric' }
export interface KnowledgeGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export async function governGraph(): Promise<KnowledgeGraph> {
  const { data } = await apiClient.get<KnowledgeGraph>('/catalog/govern/graph');
  return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
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
