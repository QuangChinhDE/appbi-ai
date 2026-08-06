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
  // ── External source (Source & Sync tab) — null = hand-typed ──
  source_type?: 'google_doc' | 'file' | 'web' | null;
  source_config?: Record<string, unknown>;
  /** Deep link to the original (Google Doc / crawled page); null when hand-typed. */
  source_url?: string | null;
  sync_schedule?: DocSyncSchedule | null;
  last_synced_at?: string | null;
  last_sync_status?: 'ok' | 'error' | 'running' | null;
  // ── Embedding configuration (Embedding tab) ──
  chunk_strategy?: 'paragraph' | 'heading' | 'fixed';
  chunk_size?: number;
  chunk_overlap?: number;
  embedding_model?: string | null;
}

// ── Source & Sync ────────────────────────────────────────────────────────────
export interface DocSyncSchedule { mode: 'manual' | 'hourly' | 'daily' | 'cron'; at?: string; cron?: string; timezone?: string }
export interface DocSourceInfo {
  source_type: 'google_doc' | 'file' | 'web' | null;
  source_config: Record<string, unknown>;
  sync_schedule: DocSyncSchedule | null;
  last_synced_at: string | null;
  last_sync_status: string | null;
  file: { filename: string; content_type: string; byte_size: number; uploaded_at: string } | null;
  google_sources: GoogleDocsSource[];
}

/** A "Google Docs" data source — a named Google connection a doc reads through. */
export interface GoogleDocsSource {
  id: number;
  name: string;
  email: string | null;
  /** The source's account actually granted documents.readonly. */
  can_read_docs: boolean;
}
export interface DocSourceWrite { source_type: string | null; source_config: Record<string, unknown>; sync_schedule: DocSyncSchedule | null }

/** Google Docs sources available (create wizard needs them before a doc exists). */
export async function listGoogleDocsSources(): Promise<GoogleDocsSource[]> {
  const { data } = await apiClient.get<{ sources: GoogleDocsSource[] }>('/catalog/govern/google-connection');
  return data.sources ?? [];
}

export async function getDocSource(docId: number): Promise<DocSourceInfo> {
  const { data } = await apiClient.get<DocSourceInfo>(`/catalog/govern/knowledge/${docId}/source`);
  return data;
}
export async function putDocSource(docId: number, body: DocSourceWrite): Promise<{ ok: boolean }> {
  const { data } = await apiClient.put(`/catalog/govern/knowledge/${docId}/source`, body);
  return data;
}
export async function uploadDocSourceFile(docId: number, file: File): Promise<{ ok: boolean; filename: string; extracted_chars: number }> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/source/upload`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}
export async function syncDocSource(docId: number): Promise<{ ok: boolean; status: string; detail?: string }> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/sync`);
  return data;
}

/** Stored snapshot of a crawled page. Render ONLY in a script-less sandboxed iframe. */
export interface DocSnapshot { html: string; url: string | null; byte_size: number; fetched_at: string }
export async function getDocSnapshot(docId: number): Promise<DocSnapshot> {
  const { data } = await apiClient.get<DocSnapshot>(`/catalog/govern/knowledge/${docId}/source/snapshot`);
  return data;
}

/** Source types a document can be created from. `null` = hand-typed. */
export type DocSourceKind = 'manual' | 'google_doc' | 'file' | 'web';
/** Google Doc + crawled web content is owned by the source — read-only here. */
export function isSourceOwned(sourceType?: string | null): boolean {
  return sourceType === 'google_doc' || sourceType === 'web';
}

// ── Embedding ────────────────────────────────────────────────────────────────
export interface EmbeddingConfig {
  chunk_strategy: 'paragraph' | 'heading' | 'fixed';
  chunk_size: number;
  chunk_overlap: number;
  embedding_model: string | null;
  embedded_hash: string | null;
  chunk_count: number;
}
export interface EmbeddingConfigWrite { chunk_strategy: string; chunk_size: number; chunk_overlap: number; embedding_model: string | null }
export interface ChunkPreviewResult { chunks: { index: number; text: string; char_count: number }[]; total_chunks: number }

export async function getEmbeddingConfig(docId: number): Promise<EmbeddingConfig> {
  const { data } = await apiClient.get<EmbeddingConfig>(`/catalog/govern/knowledge/${docId}/embedding-config`);
  return data;
}
export async function putEmbeddingConfig(docId: number, body: EmbeddingConfigWrite): Promise<{ ok: boolean }> {
  const { data } = await apiClient.put(`/catalog/govern/knowledge/${docId}/embedding-config`, body);
  return data;
}
export async function previewChunks(docId: number, body: { chunk_strategy: string; chunk_size: number; chunk_overlap: number }): Promise<ChunkPreviewResult> {
  const { data } = await apiClient.post<ChunkPreviewResult>(`/catalog/govern/knowledge/${docId}/embedding-preview`, body);
  return data;
}
export async function reembedDoc(docId: number, body?: EmbeddingConfigWrite): Promise<{ status: string; chunks: number; new_chunks: number }> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/embed`, body ?? undefined);
  return data;
}

// ── History (unified sync + embed runs, alongside content versions) ────────
export interface DocRun {
  id: number;
  run_type: 'sync' | 'embed';
  trigger: 'manual' | 'scheduled' | 'save' | 'publish';
  status: string;
  detail?: string | null;
  stats?: Record<string, unknown> | null;
  started_at: string;
  finished_at?: string | null;
  triggered_by?: string | null;
}
export interface DocHistory { runs: DocRun[]; versions: KnowledgeDocVersion[] }

export async function getDocHistory(docId: number, limit = 100): Promise<DocHistory> {
  const { data } = await apiClient.get<DocHistory>(`/catalog/govern/knowledge/${docId}/history`, { params: { limit } });
  return data;
}

// ── Usage ────────────────────────────────────────────────────────────────────
export interface DocUsage { dashboards: { id: number; name: string }[]; retrieval_count: number }

export async function getDocUsage(docId: number): Promise<DocUsage> {
  const { data } = await apiClient.get<DocUsage>(`/catalog/govern/knowledge/${docId}/usage`);
  return data;
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

// ═════════════════════════════════════════════════════════════════════════════
// Intelligence modules — teach-the-AI knowledge (rules / playbooks / verified
// Q&A / AI instructions) + governance spine (single review inbox, data caveats,
// AI data scope, provenance cockpit). Mirrors /catalog/govern/* endpoints.
// ═════════════════════════════════════════════════════════════════════════════

export type IntelStatus = 'Draft' | 'Approved' | 'Deprecated';

export interface GovernRule {
  id: number;
  name: string;
  condition_text: string;
  conclusion_text: string;
  exceptions_text?: string | null;
  applies_to: { kind: string; ref: string; label?: string }[];
  status: IntelStatus;
  version: number;
  owner?: string | null;
  updated_at?: string | null;
}

export interface GovernPlaybook {
  id: number;
  name: string;
  trigger_text: string;
  steps: string[];
  dim_priority: string[];
  expected_output?: string | null;
  linked_metrics: string[];
  status: IntelStatus;
  version: number;
  owner?: string | null;
  run_count: number;
  last_run_at?: string | null;
  updated_at?: string | null;
}

export interface GovernQA {
  id: number;
  question: string;
  trigger_phrases: string[];
  answer_md: string;
  chart_id?: number | null;
  dashboard_id?: number | null;
  playbook_id?: number | null;
  status: IntelStatus;
  as_test: boolean;
  owner?: string | null;
  use_count: number;
  last_used_at?: string | null;
  version: number;
  updated_at?: string | null;
}

export interface GovernInstruction {
  id: number;
  scope: 'global' | 'dataset' | 'dashboard';
  scope_id?: number | null;
  content_md: string;
  version: number;
  status: 'active' | 'archived';
  eval_pass_rate?: number | null;
  created_by?: string | null;
  created_at?: string | null;
}

export interface GovernCaveat {
  id: number;
  dataset_id?: number | null;
  title: string;
  content: string;
  always_inject: boolean;
  status: string;
  owner?: string | null;
  updated_at?: string | null;
}

export interface ReviewItem {
  id: number;
  entity_type: string;
  entity_id?: number | null;
  action: 'suggest' | 'certify' | 'recertify' | 'flag' | 'retire';
  title: string;
  payload?: Record<string, unknown> | null;
  evidence?: string | null;
  confidence?: number | null;
  source: 'ai' | 'user' | 'system';
  status: 'pending' | 'approved' | 'rejected';
  note?: string | null;
  created_by?: string | null;
  resolved_by?: string | null;
  created_at?: string | null;
  resolved_at?: string | null;
}

export interface IntelligenceOverview {
  readiness: number;
  coverage: Record<string, { approved: number; total: number }>;
  pending_reviews: number;
  flagged: number;
  answers_30d: number;
  top_used: { kind: string; name: string; count: number }[];
  ungrounded_questions: string[];
  unbound_metrics: { id: number; name: string; display_name: string; binding: string; status: string }[];
  lifecycle: { draft: number; approved: number; deprecated: number; pending_suggestions: number };
}

// ── Rules ─────────────────────────────────────────────────────────────────
export async function listRules(): Promise<GovernRule[]> {
  const { data } = await apiClient.get<{ rules: GovernRule[] }>('/catalog/govern/rules');
  return data.rules ?? [];
}
export async function upsertRule(body: Partial<GovernRule>): Promise<GovernRule> {
  const { data } = await apiClient.put<GovernRule>('/catalog/govern/rules', body);
  return data;
}
export async function deleteRule(id: number): Promise<void> {
  await apiClient.delete(`/catalog/govern/rules/${id}`);
}

// ── Playbooks ─────────────────────────────────────────────────────────────
export async function listPlaybooks(): Promise<GovernPlaybook[]> {
  const { data } = await apiClient.get<{ playbooks: GovernPlaybook[] }>('/catalog/govern/playbooks');
  return data.playbooks ?? [];
}
export async function upsertPlaybook(body: Partial<GovernPlaybook>): Promise<GovernPlaybook> {
  const { data } = await apiClient.put<GovernPlaybook>('/catalog/govern/playbooks', body);
  return data;
}
export async function deletePlaybook(id: number): Promise<void> {
  await apiClient.delete(`/catalog/govern/playbooks/${id}`);
}

// ── Verified Q&A ──────────────────────────────────────────────────────────
export async function listQA(): Promise<GovernQA[]> {
  const { data } = await apiClient.get<{ qa: GovernQA[] }>('/catalog/govern/qa');
  return data.qa ?? [];
}
export async function upsertQA(body: Partial<GovernQA>): Promise<GovernQA> {
  const { data } = await apiClient.put<GovernQA>('/catalog/govern/qa', body);
  return data;
}
export async function deleteQA(id: number): Promise<void> {
  await apiClient.delete(`/catalog/govern/qa/${id}`);
}

// ── Certify (in-context; writes the single review ledger) ────────────────
export async function certifyEntity(entityType: 'metric' | 'rule' | 'playbook' | 'qa', id: number): Promise<unknown> {
  const { data } = await apiClient.post(`/catalog/govern/certify/${entityType}/${id}`);
  return data;
}

// ── AI Instructions ───────────────────────────────────────────────────────
export async function listInstructions(): Promise<GovernInstruction[]> {
  const { data } = await apiClient.get<{ instructions: GovernInstruction[] }>('/catalog/govern/instructions');
  return data.instructions ?? [];
}
export async function createInstructionVersion(body: { scope: string; scope_id?: number | null; content_md: string }): Promise<GovernInstruction> {
  const { data } = await apiClient.put<GovernInstruction>('/catalog/govern/instructions', body);
  return data;
}

// ── Data caveats ──────────────────────────────────────────────────────────
export async function listCaveats(): Promise<GovernCaveat[]> {
  const { data } = await apiClient.get<{ caveats: GovernCaveat[] }>('/catalog/govern/caveats');
  return data.caveats ?? [];
}
export async function upsertCaveat(body: Partial<GovernCaveat>): Promise<GovernCaveat> {
  const { data } = await apiClient.put<GovernCaveat>('/catalog/govern/caveats', body);
  return data;
}
export async function deleteCaveat(id: number): Promise<void> {
  await apiClient.delete(`/catalog/govern/caveats/${id}`);
}

// ── AI data scope ─────────────────────────────────────────────────────────
export interface AIScope {
  dataset_id: number;
  excluded_columns: string[];
  excluded_measures: string[];
  fields?: {
    measures: { name: string; label: string; kind: string }[];
    columns: { name: string }[];
  };
}
export async function getAIScope(datasetId: number): Promise<AIScope> {
  const { data } = await apiClient.get<AIScope>(`/catalog/govern/ai-scope/${datasetId}`);
  return data;
}
export async function putAIScope(datasetId: number, body: { excluded_columns: string[]; excluded_measures: string[] }): Promise<AIScope> {
  const { data } = await apiClient.put<AIScope>(`/catalog/govern/ai-scope/${datasetId}`, body);
  return data;
}

// ── Review inbox (single ledger) ──────────────────────────────────────────
export async function listReviewItems(params?: { status?: string; entity_type?: string }): Promise<{ items: ReviewItem[]; pending: number }> {
  const { data } = await apiClient.get<{ items: ReviewItem[]; pending: number }>('/catalog/govern/review-items', { params });
  return { items: data.items ?? [], pending: data.pending ?? 0 };
}
export async function reviewCount(): Promise<number> {
  const { data } = await apiClient.get<{ pending: number }>('/catalog/govern/review-items/count');
  return data.pending ?? 0;
}
export async function createReviewItem(body: Partial<ReviewItem>): Promise<ReviewItem> {
  const { data } = await apiClient.post<ReviewItem>('/catalog/govern/review-items', body);
  return data;
}
export async function approveReviewItem(id: number, note?: string): Promise<ReviewItem & { created_entity?: unknown }> {
  const { data } = await apiClient.post(`/catalog/govern/review-items/${id}/approve`, { note: note ?? null });
  return data;
}
export async function rejectReviewItem(id: number, note?: string): Promise<ReviewItem> {
  const { data } = await apiClient.post(`/catalog/govern/review-items/${id}/reject`, { note: note ?? null });
  return data;
}

// ── Cockpit overview ──────────────────────────────────────────────────────
export async function intelligenceOverview(): Promise<IntelligenceOverview> {
  const { data } = await apiClient.get<IntelligenceOverview>('/catalog/govern/intelligence/overview');
  return data;
}

// ── AI compose: prompt → structured draft the create modal fills in ─────────
export async function aiDraftEntity(
  entityType: 'rule' | 'playbook' | 'qa' | 'caveat' | 'metric',
  prompt: string,
  datasetId?: number,
): Promise<Record<string, unknown>> {
  const { data } = await apiClient.post<{ draft: Record<string, unknown> }>(
    '/catalog/govern/ai-draft', { entity_type: entityType, prompt, dataset_id: datasetId ?? null });
  return data.draft ?? {};
}
