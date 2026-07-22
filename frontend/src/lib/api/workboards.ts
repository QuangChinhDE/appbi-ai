/**
 * API client + TypeScript contracts for the Workboard module (mini-app).
 *
 * Backend reference: backend/app/modules/workboards/api.py.
 *
 * Endpoint summary:
 *   GET    /workboards/                       → list (owned + shared)
 *   POST   /workboards/                       → create
 *   GET    /workboards/{id}                   → fetch one
 *   PATCH  /workboards/{id}                   → partial update
 *   DELETE /workboards/{id}                   → remove
 *   POST   /workboards/{id}/publish           → flip is_published
 *   GET    /workboards/{id}/public-links      → list public links
 *   POST   /workboards/{id}/public-links      → create
 *   ...    app-users, _import_template, import-auto-map
 *
 * Runtime (form/list/doc rendering) is served by the public workspace API
 * (`/public/workspaces/{token}/workboards/{wbid}/...`) — see lib/api/workspace.ts.
 */
import apiClient from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Layout types — mini-app contract. Strict validation lives on the BE; the FE
// keeps screen contents loose so iteration does not require a frontend rebuild.
// ---------------------------------------------------------------------------

export interface WorkboardMiniAppNav {
  mobile_kind?: 'bottom_nav' | 'drawer';
  desktop_kind?: 'sidebar' | 'top_tabs';
  items?: string[];
}

export interface WorkboardBranding {
  app_name?: string;
  logo_url?: string;
  logo_data?: string;
  logo_layout?: 'mark' | 'wide';
  primary_color?: string;
  accent_color?: string;
  theme?: 'light' | 'dark' | 'auto';
}

export interface WorkboardScreenGroup {
  id: string;
  label: string;
  icon?: string | null;
  screen_ids: string[];
}

export interface WorkboardLayoutJson {
  screens: Array<Record<string, unknown>>;
  screen_groups?: WorkboardScreenGroup[];
  mini_app_nav?: WorkboardMiniAppNav;
  branding?: WorkboardBranding;
  audit?: {
    created_by_column?: string;
    created_at_column?: string;
    updated_by_column?: string;
    updated_at_column?: string;
  };
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
  // Draft/Published lifecycle. `version` is the DRAFT counter (builder edits);
  // `published_version` is the draft version captured at the last publish.
  // `publish_status` is the BE-computed pill state: 'draft' | 'live' |
  // 'live_unpublished_changes'.
  published_version?: number | null;
  published_at?: string | null;
  publish_status?: 'draft' | 'live' | 'live_unpublished_changes';
  settings?: Record<string, unknown> | null;
  owner_id?: string | null;
  owner_email?: string | null;
  user_permission?: string | null;
  created_at: string;
  updated_at: string;
  default_owner_credentials?: WorkboardDefaultOwnerCredentials | null;
}

export interface WorkboardDefaultOwnerCredentials {
  username: string;
  pin: string;
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
  // v2 "pick a Source" import — the dataset auto-rebuild outcome (null for the
  // legacy "reuse existing dataset" path).
  dataset_rebuild?: {
    dataset_id: number;
    dataset_name: string;
    created_tables: Array<{
      old_table_id: number;
      new_table_id: number;
      source_table_name: string | null;
      columns: number;
    }>;
    skipped_tables: Array<{ old_table_id: number; reason: string; detail?: string }>;
    id_map?: Record<string, number>;
  } | null;
}

/** A bundle datasource the importer must map to a live Source. */
export interface WorkboardBundleDatasource {
  ref: string;
  name: string;
  type: string;
}

export interface WorkboardSourceInspectTable {
  old_table_id: number;
  display_name: string | null;
  source_kind: string;
  source_table_name: string | null;
  datasource_ref: string | null;
  datasource_name?: string | null;
  status: 'found' | 'missing' | 'recreate' | 'no_source_selected';
  matched_source_table?: string;
  available_sample?: string[];
}

export interface WorkboardSourceInspect {
  tables: WorkboardSourceInspectTable[];
  physical_total: number;
  physical_found: number;
  all_found: boolean;
}

export interface WorkboardImportFromSourceInput {
  bundle: Record<string, unknown>;
  /** bundle datasource ``ref`` -> target datasource id (auto-create path). */
  datasource_map?: Record<string, number>;
  /** Skip auto-create + import onto an existing dataset (legacy path). */
  reuse_dataset_id?: number | null;
  target_name?: string;
  target_workspace_id?: number | null;
  table_mapping?: Record<string, number | null>;
  column_mapping?: Record<string, Record<string, string>>;
  /** old bundle table id (str) -> source table name override for a rename. */
  table_source_overrides?: Record<string, string>;
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

export interface WorkboardPublicLink {
  id: string;
  name: string;
  token: string;
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
    slug?: string | null;
    layout?: WorkboardLayoutJson;
  };
  link: WorkboardPublicLink;
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
    const response = await apiClient.post<Workboard>('/workboards/', payload);
    const username = response.headers['x-appbi-default-owner-username'];
    const pin = response.headers['x-appbi-default-owner-pin'];
    if (typeof username === 'string' && typeof pin === 'string' && username && pin) {
      return {
        ...response.data,
        default_owner_credentials: {
          username,
          pin,
        },
      };
    }
    return response.data;
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

  /** Reveal the decrypted OCR token for one form screen (owner/editor only). */
  revealOcrKey: async (id: number, screenId: string): Promise<string> => {
    const { data } = await apiClient.get(`/workboards/${id}/ocr-key`, {
      params: { screen_id: screenId },
    });
    return (data?.api_key as string) || '';
  },

  testOcrConnection: async (
    id: number,
    screenId: string,
    payload: { provider?: string; model?: string; api_key?: string },
  ): Promise<{ ok: boolean; model?: string; message?: string }> => {
    const { data } = await apiClient.post(
      `/workboards/${id}/screens/${screenId}/ocr-test`,
      payload,
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

  // ── Phase-16: access-mode audit ────────────────────────────────────
  getAccessAudit: async (workboardId: number): Promise<WorkboardAccessAudit> => {
    const { data } = await apiClient.get(`/workboards/${workboardId}/access-audit`);
    return data;
  },
  setTableMiniappShare: async (
    workboardId: number,
    tableId: number,
    shared: boolean,
  ): Promise<{ table_id: number; miniapp_share: boolean }> => {
    const { data } = await apiClient.put(
      `/workboards/${workboardId}/tables/${tableId}/miniapp-share`,
      { shared },
    );
    return data;
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

  // ── v2 import: pick a Source → auto-create dataset ─────────────────
  inspectImportSource: async (
    bundle: Record<string, unknown>,
    datasource_map: Record<string, number>,
  ): Promise<WorkboardSourceInspect> => {
    const { data } = await apiClient.post('/workboards/import/inspect-source', {
      bundle,
      datasource_map,
    });
    return data;
  },
  importFromSource: async (
    payload: WorkboardImportFromSourceInput,
  ): Promise<WorkboardImportResponse> => {
    const { data } = await apiClient.post('/workboards/import/from-source', payload);
    return data;
  },
};

export type AccessMode = 'per_user' | 'joined_through' | 'shared' | 'unknown';

export interface AccessChainHop {
  from_view: string;
  to_view: string;
  from_columns: string[];
  to_columns: string[];
  relationship?: string;
  direction?: 'forward' | 'reverse';
}

export interface AccessAuditEntry {
  table_id: number;
  table_name: string;
  mode: AccessMode;
  reason: string;
  chain?: AccessChainHop[];
  screens: { screen_id: string; screen_title: string }[];
  legacy_rules: {
    screen_id: string;
    screen_title: string;
    role?: string | null;
    filter_column: string;
    filter_value?: unknown;
  }[];
}

export interface WorkboardAccessAudit {
  workboard_id: number;
  dataset_id: number;
  tables: AccessAuditEntry[];
  summary: Record<AccessMode, number>;
}

export interface WorkboardAppUserResponse {
  id: number;
  workboard_id: number;
  username: string;
  full_name: string | null;
  role: string | null;
  active: boolean;
  context: Record<string, unknown>;
  has_pin: boolean;
  using_default_pin: boolean;
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
