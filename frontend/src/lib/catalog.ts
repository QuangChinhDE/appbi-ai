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
export interface MetricBinding {
  dataset_id?: number | null;
  /** Resolved server-side so a chip can name the dataset instead of numbering it. */
  dataset_name?: string | null;
  dataset_table_id?: number | null;
  measure_ref?: string | null;
  is_primary?: boolean;
  status?: 'ok' | 'unbound' | 'unresolved' | null;
  reason?: string | null;
  table_name?: string | null;
  measure_name?: string | null;
  measure_label?: string | null;
  canonical_ref?: string | null;
}

export interface ManagedMetric {
  id: number;
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
  /** The PRIMARY realization, mirrored from `bindings`. Kept because older
   *  screens read it directly. */
  dataset_id?: number | null;
  dataset_table_id?: number | null;
  measure_ref?: string | null;
  /** EVERY dataset that computes this definition. A metric is a statement the
   *  business governs by; each binding is one place it is realized — which is why
   *  the same metric can (and should) appear on several datasets' screens. */
  bindings?: MetricBinding[];
  binding_status?: 'ok' | 'unbound' | 'unresolved' | null;
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
  /** Omit to leave the metric's other realizations untouched; send the full list
   *  to replace them. The dataset screens send it so editing "where GMV comes
   *  from here" cannot unbind it everywhere else. */
  bindings?: MetricBinding[];
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
  /**
   * Whether the dashboard AI bot can actually retrieve this doc. Distinct from
   * ai_ready: a doc can score 100% on quality and still be invisible to the bot
   * because it is unpublished or linked to no dashboard.
   * reasons: 'not_published' | 'no_dashboard' | 'not_indexed'
   */
  ai_retrievable?: { ok: boolean; reasons: string[] };
  /** What may leave for a third party. 'none' means the document is deliberately
   *  unreachable by AI; 'full' additionally permits OCR and figure description,
   *  which send page images rather than prose. */
  external_processing?: 'none' | 'embedding' | 'full';
  sensitivity?: string;
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
export interface EmbeddingProfile {
  model: string;
  provider: 'openai' | string;
  dimensions: number;
  distance_metric: 'cosine' | string;
}

export async function certifyManagedMetric(name: string): Promise<{ status: string; version: number }> {
  const { data } = await apiClient.post(`/catalog/govern/managed-metric/${encodeURIComponent(name)}/certify`);
  return data;
}

export interface EmbeddingConfig {
  chunk_strategy: 'paragraph' | 'heading' | 'fixed';
  chunk_size: number;
  chunk_overlap: number;
  embedding_model: string | null;
  embedded_hash: string | null;
  chunk_count: number;
  /** True when the body exceeds the runaway chunk cap and its tail is dropped. */
  truncated?: boolean;
  dropped_chunks?: number;
  dropped_chars?: number;
  max_chunks?: number;
  /** Published content has moved on since the last successful embed. */
  index_stale?: boolean;
  /** Indexing is QUEUED now, so "is it done yet" has to be answerable. */
  index_job?: {
    state: 'queued' | 'running' | 'done' | 'error';
    reason?: string; attempts?: number; error?: string | null;
    queued_at?: string | null; finished_at?: string | null;
    result?: { status?: string; chunks?: number } | null;
  } | null;
  external_processing?: 'none' | 'embedding' | 'full';
  embedding_allowed?: boolean;
  sensitivity?: string;
  model_locked: boolean;
  available_models: EmbeddingProfile[];
}
export interface EmbeddingConfigWrite { chunk_strategy: string; chunk_size: number; chunk_overlap: number; embedding_model: string | null }
export interface ChunkPreviewResult { chunks: { index: number; text: string; char_count: number }[]; total_chunks: number }

export async function getEmbeddingConfig(docId: number): Promise<EmbeddingConfig> {
  const { data } = await apiClient.get<EmbeddingConfig>(`/catalog/govern/knowledge/${docId}/embedding-config`);
  return data;
}
export async function getEmbeddingProfiles(): Promise<{ profiles: EmbeddingProfile[]; default_model: string }> {
  const { data } = await apiClient.get<{ profiles: EmbeddingProfile[]; default_model: string }>('/catalog/govern/embedding-profiles');
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
export interface EgressEntry {
  occurred_at: string | null; purpose: string; provider: string | null; model: string | null;
  chunks_sent: number; chars_sent: number; outcome: string; sensitivity: string | null;
  triggered_by: string | null;
}
export async function getDocEgressLog(docId: number): Promise<EgressEntry[]> {
  const { data } = await apiClient.get<{ entries: EgressEntry[] }>(`/catalog/govern/knowledge/${docId}/egress-log`);
  return data.entries || [];
}

export interface EmbeddingRunResult {
  status: string;
  chunks: number;
  new_chunks: number;
  detail?: string;
  truncated?: boolean;
  dropped_chunks?: number;
  dropped_chars?: number;
  /** Indexing is queued, so the immediate answer is a JOB, not a count.
   *  `chunks` is only present on paths that already had a result. */
  job?: { state?: string; reason?: string } | null;
}

export async function reembedDoc(docId: number, body?: EmbeddingConfigWrite): Promise<EmbeddingRunResult> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/embed`, body ?? undefined);
  return data;
}
export async function resetEmbeddingModel(docId: number, body: EmbeddingConfigWrite): Promise<EmbeddingRunResult> {
  const { data } = await apiClient.post(`/catalog/govern/knowledge/${docId}/embedding-reset`, body);
  return data;
}

// ── Vector store inspection (Pinecone-style browser) ───────────────────────
export interface DocVector {
  id: number;
  chunk_index: number;
  content: string;
  content_hash: string;
  model: string | null;
  created_at: string | null;
  has_vector: boolean;
  dims: number | null;
  /** First few raw values — enough to eyeball, never the whole vector. */
  preview: number[];
  char_count: number;
  trust?: string;
  doc_status?: string;
  heading_path?: string | null;
  page?: number | null;
  block_kind?: string | null;
  section_index?: number | null;
}
export interface DocVectors { vectors: DocVector[]; total: number; dims: number | null; model: string | null }
export interface VectorMatch {
  chunk_index: number;
  content: string;
  score: number;
  /** Which half of hybrid retrieval surfaced this chunk. Score stays cosine-only,
   *  so a keyword-only hit can legitimately show a low score. */
  matched_by?: 'both' | 'vector' | 'keyword';
  /** Where the passage came from: authored | uploaded | linked | external. */
  trust?: string;
  embedding_model?: string;
  /** Where in the document this passage is — what a citation is made of. */
  heading_path?: string | null;
  page?: number | null;
  block_kind?: string | null;
  /** The section around the passage. Small-to-big: the chunk is what matched,
   *  this is what a model should read to understand it. */
  section_content?: string | null;
  /** True when this document was DECLARED the definition of a metric the
   *  question named — authority, not similarity. */
  is_metric_home?: boolean;
  /** The score that DECIDED the order (stage-two rerank). `score` is cosine,
   *  shown for reference but no longer what sorts the list. */
  rerank_score?: number;
  /** Share of the query's weighted terms present in this passage. Diagnostic
   *  only — it does not separate answerable from unanswerable questions. */
  term_coverage?: number;
}

export async function getDocVectors(docId: number): Promise<DocVectors> {
  const { data } = await apiClient.get<DocVectors>(`/catalog/govern/knowledge/${docId}/vectors`);
  return data;
}
/** The document as the EXTRACTOR sees it, not as the author typed it.
 *
 *  Everything here existed on the backend and had no surface: the block tree, the
 *  page numbers, which figures got a caption and which did not. "Why is this image
 *  not searchable" was a question with no answer short of reading the database. */
export interface DocStructure {
  /** Tree format ("a2"). Bumping it rebuilds every document's structure. */
  ast_format: string | null;
  /** Which published version this structure describes. */
  source_version: number | null;
  ast_hash: string | null;
  source_type: string | null;
  blocks: number;
  /** section / paragraph / list / table / figure → count. */
  kinds: Record<string, number>;
  pages: number[];
  outline: Array<{ ordinal: number; level: number; title: string; heading_path: string; page: number | null }>;
  figures: {
    total: number;
    described: number;
    no_text: number;
    /** WHY undescribed figures are undescribed. "not allowed by policy", "no
     *  provider configured" and "the model could not read it" need three
     *  different fixes, and a bare zero distinguishes none of them. */
    reason: string | null;
    policy: string;
    items: Array<{
      ordinal: number | null; page: number | null; caption: string | null;
      source: string | null; src: string | null;
    }>;
  };
  /** Blocks WITH text that no chunk carries — unanswerable content. An alarm. */
  unindexed: Array<{
    ordinal: number | null; kind: string; page: number | null;
    heading_path: string | null; preview: string | null;
  }>;
  unindexed_total: number;
  /** Blocks with no text at all, so nothing to index. Expected, not a defect. */
  not_indexable: number;
}

/** One passage, opened at the version an answer cited it from.
 *
 *  `status` is not decoration. A citation names a VERSION and the block table
 *  holds only the current one, so "resolved" and "resolved + verified" and
 *  "source_changed" are three different truths and the reader needs the third. */
export interface ResolvedCitation {
  status: 'resolved' | 'source_changed' | 'version_not_kept' | 'document_gone' | 'block_not_found';
  resolved: boolean;
  /** Did the CONTENT check pass, as opposed to merely finding something at the
   *  coordinates? A citation resolved without verification is a guess that landed. */
  verified: boolean;
  version: number | null;
  current_version?: number | null;
  is_current?: boolean;
  title?: string | null;
  text: string | null;
  heading_path?: string | null;
  page?: number | null;
  block?: number | null;
  block_kind?: string | null;
  note?: string | null;
}

export async function resolveCitation(citation: {
  doc_id: number; document_version?: number; block?: number;
  block_to?: number; content_fingerprint?: string;
}): Promise<ResolvedCitation> {
  const { data } = await apiClient.post<ResolvedCitation>(
    '/catalog/govern/knowledge/citation/resolve', citation);
  return data;
}

export async function getDocStructure(docId: number): Promise<DocStructure> {
  const { data } = await apiClient.get<DocStructure>(`/catalog/govern/knowledge/${docId}/structure`);
  return data;
}

export async function queryDocVectors(docId: number, query: string, k = 5): Promise<VectorMatch[]> {
  const { data } = await apiClient.post<{ matches: VectorMatch[] }>(`/catalog/govern/knowledge/${docId}/vectors/query`, { query, k });
  return data.matches ?? [];
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
  /** Omit to leave unchanged — the backend only writes it when non-null. */
  external_processing?: 'none' | 'embedding' | 'full';
  sensitivity?: string;
  embedding_model?: string;
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

// Cross-layer AppBI knowledge network. Ids are typed (`dataset:7`) because a
// dataset 7 and a document 7 are different things.
export type KnowledgeNodeKind = 'doc' | 'dataset' | 'dashboard' | 'measure' | 'metric' | 'term' | 'caveat';
export interface KnowledgeGraphNode {
  id: string;
  kind: KnowledgeNodeKind;
  ref: string;
  label: string;
  space?: string;
  doc_type?: string;
  category?: string | null;
  group?: string;
  status?: string | null;
  owner?: string | null;
  summary?: string | null;
  dataset_id?: number | null;
  dataset_table_id?: number | null;
  binding_status?: 'ok' | 'unbound' | 'unresolved' | null;
}
export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  /** `reads` is physical lineage; every other relationship is knowledge. */
  kind: 'reads' | 'explains' | 'defines' | 'defined_in' | 'realized_by' | 'means' | 'applies_to' | 'links' | 'references';
}
export interface CoverageRow {
  id: number;
  name: string;
  docs: number;
  metrics: number;
  terms: number;
  measures?: number;
  caveats?: number;
  charts?: number;
  datasets?: number;
}
export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  coverage: { dashboards: CoverageRow[]; datasets: CoverageRow[] };
  totals: {
    docs: number; metrics: number; measures: number; terms: number; caveats: number;
    datasets: number; dashboards: number;
    knowledge_edges: number; physical_edges: number;
    dashboards_without_knowledge: number;
    orphan_terms: number;
  };
}

export async function governGraph(): Promise<KnowledgeGraph> {
  const { data } = await apiClient.get<KnowledgeGraph>('/catalog/govern/graph');
  return {
    ...data,
    nodes: data.nodes ?? [],
    edges: data.edges ?? [],
    coverage: data.coverage ?? { dashboards: [], datasets: [] },
  };
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
  dataset_name?: string | null;
  scope?: 'global' | 'dataset';
  title: string;
  content: string;
  always_inject: boolean;
  status: 'Draft' | 'Approved' | 'Deprecated';
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
