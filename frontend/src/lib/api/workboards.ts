/**
 * API client + TypeScript contracts for the Workboard module.
 *
 * Backend reference: backend/app/api/workboards.py and
 * backend/app/schemas/workboard.py.
 *
 * Endpoint summary:
 *   GET    /workboards/                       → list (owned + shared)
 *   POST   /workboards/                       → create
 *   GET    /workboards/{id}                   → fetch one
 *   PATCH  /workboards/{id}                   → partial update
 *   DELETE /workboards/{id}                   → remove
 *   POST   /workboards/{id}/publish           → flip is_published
 *   GET    /workboards/{id}/form              → form spec + lookup options
 *   GET    /workboards/{id}/lookups/{column}  → reload a single lookup
 *   POST   /workboards/{id}/rows/list         → paginated rows
 *   POST   /workboards/{id}/rows              → insert
 *   PATCH  /workboards/{id}/rows              → update by PK
 *   DELETE /workboards/{id}/rows              → delete by PK
 *   GET    /workboards/{id}/doc/{view}        → rendered doc-view payload
 *   GET    /workboards/{id}/doc/{view}/export → html | pdf | excel download
 */
import apiClient from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Layout types (kept loose so the FE can iterate without recompiling on
// every backend tweak — strict validation lives on the BE).
// ---------------------------------------------------------------------------

export type WorkboardWidget =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'date'
  | 'datetime'
  | 'checkbox'
  | 'lookup';

export interface WorkboardLookupConfig {
  kind: 'static' | 'dataset_table';
  values?: Array<{ label: string; value: unknown }>;
  table_id?: number;
  value_column?: string;
  label_column?: string;
}

export interface WorkboardFormField {
  column: string;
  widget: WorkboardWidget;
  label?: string;
  required?: boolean;
  default?: unknown;
  help_text?: string;
  placeholder?: string;
  readonly?: boolean;
  lookup?: WorkboardLookupConfig;
}

export interface WorkboardFormView {
  title?: string;
  fields: WorkboardFormField[];
  submit_label?: string;
}

export interface WorkboardListFilter {
  column: string;
  kind: 'text' | 'select' | 'date_range' | 'number_range';
  label?: string;
}

export interface WorkboardListView {
  columns: string[];
  filters: WorkboardListFilter[];
  page_size: number;
  row_actions: Array<'edit' | 'delete' | 'duplicate'>;
  default_sort_column?: string;
  default_sort_direction?: 'asc' | 'desc';
}

export type WorkboardDocBlock = Record<string, unknown> & { type: string };

export interface WorkboardDocView {
  id: string;
  title?: string;
  page: { size: 'A4' | 'A3' | 'Letter'; orientation: 'portrait' | 'landscape'; margin_mm: number };
  blocks: WorkboardDocBlock[];
}

export interface WorkboardLayoutJson {
  version: number;
  form: WorkboardFormView;
  list: WorkboardListView;
  doc_views: WorkboardDocView[];
  rls: { enabled: boolean; owner_column?: string };
  audit: {
    created_by_column?: string;
    created_at_column?: string;
    updated_by_column?: string;
    updated_at_column?: string;
  };
  // v2 additive fields (auto-populated server-side on read)
  branding?: WorkboardBranding;
  tables?: WorkboardAppTable[];
  refs?: WorkboardAppRef[];
  slices?: WorkboardAppSlice[];
  actions?: WorkboardAppAction[];
  views?: WorkboardAppView[];
  nav?: WorkboardNavConfig;
  security?: WorkboardSecurityConfig;
}

// ---------------------------------------------------------------------------
// v2 — AppSheet-style multi-table / multi-view contracts
// ---------------------------------------------------------------------------

export type WorkboardViewKind =
  | 'table'
  | 'deck'
  | 'detail'
  | 'form'
  | 'gallery'
  | 'calendar'
  | 'map'
  | 'chart'
  | 'dashboard'
  | 'onboarding';

export interface WorkboardBranding {
  app_name?: string;
  logo_url?: string;
  primary_color?: string;
  accent_color?: string;
  theme?: 'light' | 'dark' | 'auto';
}

export interface WorkboardColumnConfig {
  label?: string;
  type?: string;
  required?: boolean;
  editable?: boolean;
  show?: boolean;
  show_in?: Array<'table' | 'detail' | 'form'>;
  initial_value_expr?: string;
  formula_expr?: string;
  valid_if_expr?: string;
  show_if_expr?: string;
  editable_if_expr?: string;
  required_if_expr?: string;
  enum_values?: Array<{ label: string; value: unknown }>;
  ref_table_id?: string;
  ref_action?: 'navigate' | 'inline';
}

export interface WorkboardAppTable {
  id: string;
  table_id: number;
  label?: string;
  icon?: string;
  label_column?: string;
  pk?: string[];
  column_config?: Record<string, WorkboardColumnConfig>;
}

export interface WorkboardAppRef {
  id: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  cardinality?: 'one_to_many' | 'many_to_one';
  inline_view?: string;
}

export interface WorkboardAppSlice {
  id: string;
  label: string;
  source_table: string;
  row_filter_expr?: unknown;
  visible_columns?: string[];
  sort?: Array<Record<string, unknown>>;
  action_ids?: string[];
}

export type WorkboardAppActionKind =
  | 'navigate'
  | 'set_values'
  | 'open_url'
  | 'compose_email'
  | 'webhook'
  | 'add_row'
  | 'delete_row'
  | 'go_back';

export interface WorkboardAppAction {
  id: string;
  label: string;
  source_table: string;
  kind: WorkboardAppActionKind;
  icon?: string;
  condition_expr?: string;
  prominence?: 'overlay' | 'display' | 'inline' | 'detail_only';
  navigate_to?: string;
  set_columns?: Array<{ column: string; value: unknown }>;
  url?: string;
  email?: Record<string, unknown>;
  webhook?: Record<string, unknown>;
  add_to_table?: string;
  add_with_values?: Record<string, unknown>;
  confirm_message?: string;
}

export interface WorkboardAppView {
  id: string;
  label: string;
  kind: WorkboardViewKind;
  source: { kind: 'table' | 'slice'; id: string };
  position?: 'primary' | 'menu' | 'ref' | 'system';
  icon?: string;
  visible_columns?: string[];
  group_by?: string;
  sort?: Array<Record<string, unknown>>;
  action_ids?: string[];
  config?: Record<string, unknown>;
}

export interface WorkboardNavConfig {
  primary_view?: string;
  menu_view_ids?: string[];
  bottom_tab_view_ids?: string[];
}

export interface WorkboardColumnPermPolicy {
  table: string;
  column: string;
  read_if_expr?: string;
  edit_if_expr?: string;
}

export interface WorkboardSecurityConfig {
  rls?: { enabled: boolean; owner_column?: string };
  column_perms?: WorkboardColumnPermPolicy[];
}

export interface WorkboardV2Bundle {
  version: number;
  branding: WorkboardBranding;
  tables: WorkboardAppTable[];
  views: WorkboardAppView[];
  slices: WorkboardAppSlice[];
  actions: WorkboardAppAction[];
  refs: WorkboardAppRef[];
  nav: WorkboardNavConfig;
}

export interface WorkboardRenderViewRequest {
  page?: number;
  page_size?: number;
  filters?: Array<Record<string, unknown>>;
  pk?: Record<string, unknown>;
}

export interface WorkboardRenderViewResponse {
  view: WorkboardAppView;
  table?: WorkboardAppTable;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  row?: Record<string, unknown> | null;
  page?: number;
  page_size?: number;
  has_more?: boolean;
  execution_time_ms?: number;
  missing_table?: boolean;
}

export interface WorkboardActionExecuteResponse {
  ok: boolean;
  kind?: WorkboardAppActionKind;
  action?: WorkboardAppAction;
  result?: unknown;
  error?: string;
  deferred?: boolean;
}

// ---------------------------------------------------------------------------
// Workboard CRUD
// ---------------------------------------------------------------------------

export interface Workboard {
  id: number;
  name: string;
  slug?: string | null;
  description?: string | null;
  icon?: string | null;
  dataset_id: number;
  primary_table_id: number;
  primary_key_columns: string[];
  lookup_tables: Array<Record<string, unknown>>;
  layout_json: WorkboardLayoutJson;
  write_mode: string;
  optimistic_lock_column?: string | null;
  is_published: boolean;
  version: number;
  settings?: Record<string, unknown> | null;
  owner_id?: string | null;
  owner_email?: string | null;
  user_permission?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkboardCreateInput {
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
  dataset_id: number;
  /** Optional — backend auto-picks the first physical table of the dataset
   *  when omitted. Each mini-app screen carries its own table_id anyway. */
  primary_table_id?: number;
  primary_key_columns?: string[];
  layout_json?: Partial<WorkboardLayoutJson>;
  optimistic_lock_column?: string;
}

export interface WorkboardUpdateInput {
  name?: string;
  slug?: string;
  description?: string;
  icon?: string;
  dataset_id?: number;
  primary_table_id?: number;
  layout_json?: Partial<WorkboardLayoutJson>;
  optimistic_lock_column?: string;
  is_published?: boolean;
  settings?: Record<string, unknown>;
}

export interface WorkboardImportReport {
  matched_tables: Array<{
    old_table_id: number;
    source_table_name: string | null;
    display_name: string | null;
    new_table_id: number | null;
    mapping_source?: 'manual' | 'auto' | 'missing' | 'unmapped';
  }>;
  missing_tables: Array<{
    old_table_id: number;
    source_table_name: string | null;
    display_name: string | null;
    new_table_id?: number | null;
    mapping_source?: 'manual' | 'auto' | 'missing' | 'unmapped';
  }>;
  missing_columns: Array<{
    screen: string;
    where: string;
    column: string;
  }>;
  app_users_imported?: number;
  app_users_needing_pin?: string[];
}

export interface WorkboardImportInput {
  bundle: Record<string, unknown>;
  target_dataset_id: number;
  target_name?: string;
  target_workspace_id?: number | null;
  table_mapping?: Record<string, number | null>;
  column_mapping?: Record<string, Record<string, string>>;
}

export type WorkboardImportResponse = Workboard & {
  _import_report?: WorkboardImportReport;
  _workspace_attach_report?: {
    workspace_id: number;
    workspace_name: string;
    workboard_slug: string;
    attached: boolean;
  };
};

// ---------------------------------------------------------------------------
// Runtime payloads
// ---------------------------------------------------------------------------

export interface WorkboardFormSpec {
  title?: string;
  submit_label?: string;
  fields: WorkboardFormField[];
  lookups: Record<string, Array<{ label: string; value: unknown }>>;
  primary_key_columns: string[];
  audit: WorkboardLayoutJson['audit'];
  rls: WorkboardLayoutJson['rls'];
}

export interface WorkboardRowsRequest {
  filters?: Array<Record<string, unknown>>;
  page?: number;
  page_size?: number;
  sort_column?: string;
  sort_direction?: 'asc' | 'desc';
}

export interface WorkboardRowsResponse {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  page: number;
  page_size: number;
  total?: number;
  has_more: boolean;
}

export interface WorkboardWriteResult {
  action: 'insert' | 'update' | 'delete';
  row?: Record<string, unknown> | null;
  pk?: Record<string, unknown> | null;
  affected_rows: number;
  warnings: Array<Record<string, unknown>>;
  submission_id?: number | null;
}

export interface WorkboardRenderedDoc {
  id: string;
  title?: string | null;
  page: WorkboardDocView['page'];
  blocks: WorkboardDocBlock[];
  context?: Record<string, unknown>;
  missing?: boolean;
}

export interface WorkboardPublicLink {
  id: string;
  name: string;
  token: string;
  mode: 'form' | 'view';
  view_id?: string | null;
  is_active: boolean;
  has_password: boolean;
  access_count: number;
  last_accessed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WorkboardPublicPayload {
  workboard: {
    id: number;
    name: string;
    description?: string | null;
  };
  link: WorkboardPublicLink;
  mode: 'form' | 'view';
  form?: WorkboardFormSpec;
  rendered_view?: WorkboardRenderViewResponse;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export const workboardApi = {
  list: async (): Promise<Workboard[]> => {
    const { data } = await apiClient.get('/workboards/');
    return data;
  },

  getById: async (id: number): Promise<Workboard> => {
    const { data } = await apiClient.get(`/workboards/${id}`);
    return data;
  },

  create: async (payload: WorkboardCreateInput): Promise<Workboard> => {
    const { data } = await apiClient.post('/workboards/', payload);
    return data;
  },

  importTemplate: async (
    payload: WorkboardImportInput,
  ): Promise<WorkboardImportResponse> => {
    const { data } = await apiClient.post('/workboards/_import_template', payload);
    return data;
  },

  update: async (id: number, payload: WorkboardUpdateInput): Promise<Workboard> => {
    const { data } = await apiClient.patch(`/workboards/${id}`, payload);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    await apiClient.delete(`/workboards/${id}`);
  },

  publish: async (id: number): Promise<Workboard> => {
    const { data } = await apiClient.post(`/workboards/${id}/publish`);
    return data;
  },

  // Runtime
  getFormSpec: async (id: number): Promise<WorkboardFormSpec> => {
    const { data } = await apiClient.get(`/workboards/${id}/form`);
    return data;
  },

  getLookupOptions: async (
    id: number,
    column: string,
  ): Promise<{ field: string; options: Array<{ label: string; value: unknown }> }> => {
    const { data } = await apiClient.get(`/workboards/${id}/lookups/${encodeURIComponent(column)}`);
    return data;
  },

  listRows: async (id: number, body: WorkboardRowsRequest = {}): Promise<WorkboardRowsResponse> => {
    const { data } = await apiClient.post(`/workboards/${id}/rows/list`, {
      filters: body.filters ?? [],
      page: body.page ?? 1,
      page_size: body.page_size,
      sort_column: body.sort_column,
      sort_direction: body.sort_direction,
    });
    return data;
  },

  insertRow: async (
    id: number,
    values: Record<string, unknown>,
  ): Promise<WorkboardWriteResult> => {
    const { data } = await apiClient.post(`/workboards/${id}/rows`, { values });
    return data;
  },

  updateRow: async (
    id: number,
    payload: { pk: Record<string, unknown>; values: Record<string, unknown>; lock_token?: unknown },
  ): Promise<WorkboardWriteResult> => {
    const { data } = await apiClient.patch(`/workboards/${id}/rows`, payload);
    return data;
  },

  deleteRow: async (
    id: number,
    payload: { pk: Record<string, unknown>; lock_token?: unknown },
  ): Promise<WorkboardWriteResult> => {
    const { data } = await apiClient.delete(`/workboards/${id}/rows`, { data: payload });
    return data;
  },

  renderDoc: async (id: number, viewId: string): Promise<WorkboardRenderedDoc> => {
    const { data } = await apiClient.get(`/workboards/${id}/doc/${encodeURIComponent(viewId)}`);
    return data;
  },

  exportDocUrl: (id: number, viewId: string, format: 'html' | 'pdf' | 'excel'): string => {
    return `/api/v1/workboards/${id}/doc/${encodeURIComponent(viewId)}/export?format=${format}`;
  },

  // ---------------------------------------------------------------------
  // v2 — multi-view runtime
  // ---------------------------------------------------------------------
  listV2Views: async (id: number): Promise<WorkboardV2Bundle> => {
    const { data } = await apiClient.get(`/workboards/${id}/v2/views`);
    return data;
  },

  renderV2View: async (
    id: number,
    viewId: string,
    body: WorkboardRenderViewRequest = {},
  ): Promise<WorkboardRenderViewResponse> => {
    const { data } = await apiClient.post(
      `/workboards/${id}/v2/views/${encodeURIComponent(viewId)}/render`,
      body,
    );
    return data;
  },

  executeV2Action: async (
    id: number,
    actionId: string,
    body: { pk?: Record<string, unknown> } = {},
  ): Promise<WorkboardActionExecuteResponse> => {
    const { data } = await apiClient.post(
      `/workboards/${id}/v2/actions/${encodeURIComponent(actionId)}/execute`,
      body,
    );
    return data;
  },

  listPublicLinks: async (id: number): Promise<WorkboardPublicLink[]> => {
    const { data } = await apiClient.get(`/workboards/${id}/public-links`);
    return data;
  },

  createPublicLink: async (
    id: number,
    payload: {
      name: string;
      mode: 'form' | 'view';
      view_id?: string;
      password?: string;
    },
  ): Promise<WorkboardPublicLink> => {
    const { data } = await apiClient.post(`/workboards/${id}/public-links`, payload);
    return data;
  },

  updatePublicLink: async (
    id: number,
    linkId: string,
    payload: {
      name?: string;
      mode?: 'form' | 'view';
      view_id?: string;
      is_active?: boolean;
      password?: string;
    },
  ): Promise<WorkboardPublicLink> => {
    const { data } = await apiClient.patch(
      `/workboards/${id}/public-links/${encodeURIComponent(linkId)}`,
      payload,
    );
    return data;
  },

  deletePublicLink: async (id: number, linkId: string): Promise<void> => {
    await apiClient.delete(`/workboards/${id}/public-links/${encodeURIComponent(linkId)}`);
  },

  // ── App users (Builder "Users" tab) ─────────────────────────────────
  listAppUsers: async (workboardId: number): Promise<WorkboardAppUserResponse[]> => {
    const { data } = await apiClient.get(`/workboards/${workboardId}/app-users`);
    return data;
  },
  createAppUser: async (
    workboardId: number,
    payload: WorkboardAppUserCreate,
  ): Promise<WorkboardAppUserResponse> => {
    const { data } = await apiClient.post(`/workboards/${workboardId}/app-users`, payload);
    return data;
  },
  updateAppUser: async (
    workboardId: number,
    appUserId: number,
    payload: WorkboardAppUserUpdate,
  ): Promise<WorkboardAppUserResponse> => {
    const { data } = await apiClient.patch(
      `/workboards/${workboardId}/app-users/${appUserId}`,
      payload,
    );
    return data;
  },
  deleteAppUser: async (workboardId: number, appUserId: number): Promise<void> => {
    await apiClient.delete(`/workboards/${workboardId}/app-users/${appUserId}`);
  },

  // ── AI auto-map for import ─────────────────────────────────────────
  autoMapImport: async (
    bundle: Record<string, unknown>,
    target_dataset_id: number,
  ): Promise<{
    table_mapping: Record<string, number | null>;
    column_mapping: Record<string, Record<string, string>>;
    ai_used: boolean;
  }> => {
    const { data } = await apiClient.post('/workboards/import-auto-map', {
      bundle,
      target_dataset_id,
    });
    return data;
  },
};

export interface WorkboardAppUserResponse {
  id: number;
  workboard_id: number;
  username: string;
  full_name: string | null;
  role: string | null;
  active: boolean;
  context: Record<string, unknown>;
  has_pin: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkboardAppUserCreate {
  username: string;
  pin: string;
  full_name?: string | null;
  role?: string | null;
  active?: boolean;
  context?: Record<string, unknown>;
}

export interface WorkboardAppUserUpdate {
  username?: string;
  pin?: string;
  full_name?: string | null;
  role?: string | null;
  active?: boolean;
  context?: Record<string, unknown>;
}
