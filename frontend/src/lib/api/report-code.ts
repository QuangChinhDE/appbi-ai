/**
 * Report Studio (Report-as-Code) API — signed-in surfaces only.
 * Public pages use `publicReportApi` from `@/lib/api/public` instead.
 */
import apiClient from '@/lib/api-client';
import type { PublicLink } from '@/lib/api/dashboards';
import type { FilterState } from '@/lib/report-code/protocol';

export interface ReportJob {
  id: string;
  kind: 'generate' | 'import' | 'edit';
  state: 'running' | 'done' | 'failed';
  step?: string;
  steps?: string[];
  error?: string;
  notes?: string[];
  summary?: string;
  revision?: number;
  elapsed_ms?: number;
  design_source?: 'ai' | 'template';
  data_source?: 'model' | 'rules';
  started_at?: string;
}

export interface ReportSummary {
  id: number;
  name: string;
  description: string | null;
  dataset_id: number | null;
  owner_id: string | null;
  draft_number: number | null;
  published_number: number | null;
  has_unpublished_changes: boolean;
  /** True when at least one public link is active (links: reportCodeApi.listPublicLinks). */
  public_enabled: boolean;
  public_link_count?: number;
  /** The data sources (bindings) of the draft. */
  binding_count?: number;
  /** Set by the list endpoint: the caller's level and the owner, as on a dashboard row. */
  user_permission?: 'none' | 'view' | 'edit' | 'full';
  owner_email?: string | null;
  job: ReportJob | null;
  updated_at: string | null;
  last_published_at: string | null;
}

export interface ReportBinding { id: string; chart_id: number; title: string; kind: string }
export interface ReportFilter { key: string; label: string; kind: 'category' | 'date'; fieldKey?: string }
export interface ReportRegion { id: string; tag: string; label: string }

export interface ReportRevision {
  id: number;
  number: number;
  source: string;
  note: string | null;
  content_hash: string;
  created_by: string | null;
  created_at: string | null;
  binding_count: number;
  filter_count: number;
  html?: string;
  css?: string;
  js?: string;
  bindings?: ReportBinding[];
  filters?: ReportFilter[];
  regions?: ReportRegion[];
  is_draft?: boolean;
  is_published?: boolean;
}

export interface ReportDetail extends ReportSummary {
  draft: ReportRevision | null;
  /** Filters of the PUBLISHED revision: what a public link of this report meets. */
  published_filters?: ReportFilter[];
  user_permission: 'none' | 'view' | 'edit' | 'full';
  warnings?: string[];
  dataset_name: string | null;
}

export interface ReportCatalog {
  candidates: { id: string; kind: string; type: string; title: string }[];
  dimensions: { id: string; label: string; kind: 'category' | 'date' }[];
}

export interface CreateReportInput {
  dataset_id: number;
  prompt: string;
  name?: string;
  reference_html?: string;
  reference_image?: string;
}

export interface ImportSlot {
  id: string;
  kind: 'value' | 'chart' | 'table' | 'filter';
  context: string;
  sample: string;
  candidate?: string | null;
  candidate_title?: string | null;
  viz?: string | null;
  dimension?: string | null;
  confidence: number;
  source: 'model' | 'rules';
}

export interface ImportAnalysis {
  compatible: boolean;
  slots: ImportSlot[];
  warnings: string[];
  placeholders: string[];
  candidates: { id: string; kind: string; type: string; title: string }[];
  dimensions: { id: string; label: string; kind: 'category' | 'date' }[];
}

export interface ImportSources { dataset_id: number; html: string; css: string; js: string; prompt?: string }

const base = (id: number) => `/report-artifacts/${id}`;

export const reportCodeApi = {
  list: async (): Promise<ReportSummary[]> => (await apiClient.get('/report-artifacts')).data,
  create: async (input: CreateReportInput): Promise<ReportSummary> => (await apiClient.post('/report-artifacts', input)).data,
  createBlank: async (input: { dataset_id: number; name: string }): Promise<ReportSummary> =>
    (await apiClient.post('/report-artifacts/blank', input)).data,
  importAnalyze: async (input: ImportSources): Promise<ImportAnalysis> =>
    (await apiClient.post('/report-artifacts/import/analyze', input)).data,
  importApply: async (input: ImportSources & {
    name?: string; artifact_id?: number;
    mapping: { slot: string; candidate?: string | null; viz?: string | null; dimension?: string | null }[];
    filters: string[];
  }): Promise<ReportSummary> => (await apiClient.post('/report-artifacts/import', input)).data,
  /** The AI Design Context Pack (markdown): meanings + SDK + rules, never data. */
  contextPack: async (datasetId: number): Promise<{ text: string; filename: string }> => {
    const res = await apiClient.get('/report-artifacts/context-pack', { params: { dataset_id: datasetId }, responseType: 'text' });
    const cd = String(res.headers?.['content-disposition'] || '');
    const m = cd.match(/filename="([^"]+)"/);
    return { text: String(res.data), filename: m ? m[1] : 'appbi-context-pack.md' };
  },
  get: async (id: number): Promise<ReportDetail> => (await apiClient.get(base(id))).data,
  job: async (id: number): Promise<{ job: ReportJob | null; draft_number: number | null }> => (await apiClient.get(`${base(id)}/job`)).data,
  rename: async (id: number, name: string): Promise<ReportSummary> => (await apiClient.patch(base(id), { name })).data,
  remove: async (id: number): Promise<void> => { await apiClient.delete(base(id)); },
  saveSource: async (id: number, body: { html: string; css: string; js: string; base_number: number | null }):
    Promise<{ revision: ReportRevision; warnings: string[] }> => (await apiClient.put(`${base(id)}/source`, body)).data,
  aiEdit: async (id: number, body: { instruction: string; region?: string | null; reference_image?: string; allow_data?: boolean }):
    Promise<{ job: ReportJob }> => (await apiClient.post(`${base(id)}/ai-edit`, body)).data,
  revisions: async (id: number): Promise<ReportRevision[]> => (await apiClient.get(`${base(id)}/revisions`)).data,
  revision: async (id: number, number: number): Promise<ReportRevision> => (await apiClient.get(`${base(id)}/revisions/${number}`)).data,
  restore: async (id: number, number: number): Promise<{ revision: ReportRevision }> =>
    (await apiClient.post(`${base(id)}/revisions/${number}/restore`)).data,
  publish: async (id: number, revisionId?: number): Promise<ReportSummary> =>
    (await apiClient.post(`${base(id)}/publish`, { revision_id: revisionId ?? null })).data,
  /** Named public links — the same contract (and PublicLink shape) as a dashboard's. */
  listPublicLinks: async (id: number): Promise<PublicLink[]> => (await apiClient.get(`${base(id)}/public-links`)).data,
  createPublicLink: async (id: number, body: Record<string, unknown>): Promise<PublicLink> =>
    (await apiClient.post(`${base(id)}/public-links`, body)).data,
  updatePublicLink: async (id: number, linkId: number, body: Record<string, unknown>): Promise<PublicLink> =>
    (await apiClient.patch(`${base(id)}/public-links/${linkId}`, body)).data,
  deletePublicLink: async (id: number, linkId: number): Promise<unknown> =>
    (await apiClient.delete(`${base(id)}/public-links/${linkId}`)).data,
  /** The link's AI Bot: is its model ready, and what can it read (publisher guide pickers). */
  publicLinkAiStatus: async (id: number, linkId: number): Promise<any> =>
    (await apiClient.get(`${base(id)}/public-links/${linkId}/ai-status`)).data,
  publicLinkAiCatalog: async (id: number, linkId: number): Promise<any> =>
    (await apiClient.get(`${base(id)}/public-links/${linkId}/ai/catalog`)).data,
  previewPublicLink: async (id: number, body: { filters_config: unknown[]; appearance_config: Record<string, unknown> }):
    Promise<{ token: string; expires_at: string }> => (await apiClient.post(`${base(id)}/public-links/preview`, body)).data,
  /** A signed, 10-minute URL for one revision's document on the isolated report origin. */
  documentTicket: async (id: number, revision?: number | null): Promise<{ url: string; isolated: boolean; revision: number }> =>
    (await apiClient.post(`${base(id)}/document-ticket`, null, { params: revision ? { revision } : {} })).data,
  data: async (id: number, binding: string, state: FilterState, revision?: number | null): Promise<unknown> =>
    (await apiClient.post(`${base(id)}/data`, { binding, state, revision: revision ?? null })).data,
  values: async (id: number, key: string, search: string, state: FilterState, revision?: number | null): Promise<unknown[]> =>
    (await apiClient.post(`${base(id)}/values`, { key, search, state, revision: revision ?? null })).data?.values ?? [],
  catalog: async (id: number): Promise<ReportCatalog> => (await apiClient.get(`${base(id)}/catalog`)).data,
  addBinding: async (id: number, body: { candidate_id?: string; chart_id?: number; title?: string }) =>
    (await apiClient.post(`${base(id)}/bindings`, body)).data as { revision: ReportRevision; warnings: string[]; binding: ReportBinding },
  removeBinding: async (id: number, bindingId: string) =>
    (await apiClient.delete(`${base(id)}/bindings/${encodeURIComponent(bindingId)}`)).data as { revision: ReportRevision; warnings: string[] },
  addFilter: async (id: number, dimensionId: string) =>
    (await apiClient.post(`${base(id)}/filters`, { dimension_id: dimensionId })).data as { revision: ReportRevision; warnings: string[] },
  removeFilter: async (id: number, key: string) =>
    (await apiClient.delete(`${base(id)}/filters/${encodeURIComponent(key)}`)).data as { revision: ReportRevision; warnings: string[] },
};
