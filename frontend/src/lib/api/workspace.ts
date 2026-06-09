/**
 * Public-facing workspace API client.
 *
 * The workspace flow is intentionally separate from the AppBI-authenticated
 * workboards flow: end users do not have AppBI accounts, login uses native
 * Workboard app users, and the session is a cookie set per workspace token.
 *
 * Every request below is sent ``credentials: 'include'`` so the workspace
 * cookie travels with the request even though the auth scheme is unrelated
 * to AppBI's own session.
 */
import axios from 'axios';

export interface WorkspaceBranding {
  app_name?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
  welcome_text?: string | null;
}

export interface WorkspaceMeta {
  name: string;
  description?: string | null;
  branding?: WorkspaceBranding | null;
  requires_login: boolean;
}

export interface WorkspaceAppUser {
  username: string;
  role?: string | null;
  full_name?: string | null;
  context?: Record<string, unknown>;
}

export interface WorkspaceMenuItem {
  workboard_id: number;
  workboard_slug: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  view_id?: string | null;
}

export interface WorkspaceMenuResponse {
  workspace: WorkspaceMeta;
  app_user: WorkspaceAppUser;
  menu: WorkspaceMenuItem[];
}

export interface WorkspaceLoginResponse {
  session_token: string;
  expires_in: number;
  app_user: WorkspaceAppUser;
}

export interface DocBlockRendered {
  type: string;
  [key: string]: unknown;
}

// ── Mini-app contracts ──────────────────────────────────────────────────

export interface AppShellNav {
  mobile_kind: 'bottom_nav' | 'drawer';
  desktop_kind: 'sidebar' | 'top_tabs';
  items: string[];
}

export interface AppShellScreenStub {
  id: string;
  kind: 'form' | 'table' | 'doc' | 'dashboard';
  title: string;
  icon?: string | null;
  description?: string | null;
  show_in_nav: boolean;
}

/** A named group of screens (UI: "Workspace") for the in-app navigation.
 *  Server emits these already role-filtered, with screen_ids referencing
 *  visible screens. Absent/empty => flat nav (legacy behaviour). */
export interface AppShellScreenGroup {
  id: string;
  label: string;
  icon?: string | null;
  screen_ids: string[];
}

export interface AppShellResponse {
  workboard: {
    id: number;
    name: string;
    slug?: string | null;
    icon?: string | null;
    description?: string | null;
  };
  branding: WorkspaceBranding;
  nav: AppShellNav;
  screens: AppShellScreenStub[];
  screen_groups?: AppShellScreenGroup[];
  viewer?: {
    role?: string | null;
    username?: string | null;
  };
}

export interface ScreenAction {
  id: string;
  label: string;
  icon?: string | null;
  style?: 'primary' | 'secondary' | 'ghost' | 'danger';
  go_to_screen?: string | null;
  carry?: string[];
  confirm_message?: string | null;
  visible_for_roles?: string[];
}

export interface FormScreenResponse {
  screen_id: string;
  kind: 'form';
  title: string;
  icon?: string | null;
  description?: string | null;
  table_id?: number | null;
  primary_key_columns: string[];
  submit_label?: string | null;
  fields: Array<Record<string, unknown>>;
  lookups: Record<string, Array<{ label: string; value: unknown }>>;
  initial_values: Record<string, unknown>;
  after_submit?: ScreenAction | null;
  /** Columns the workboard auto-fills on insert when left blank.
   *  Treat as readonly with a hint so the user knows typing is ignored. */
  auto_number_columns?: string[];
  /** Pages array for multi-step forms (optional). */
  pages?: Array<Record<string, unknown>>;
  /** Section headings used to group fields inside a single page. */
  sections?: string[];
}

export interface TableScreenResponse {
  screen_id: string;
  kind: 'table';
  title: string;
  icon?: string | null;
  description?: string | null;
  columns: string[];
  primary_key_columns: string[];
  rows: Array<Record<string, unknown>>;
  page: number;
  page_size: number;
  table_view?: {
    columns?: string[];
    editable_columns?: string[];
    filters?: Array<{ column: string; kind: 'text' | 'select' | 'date_range' | 'number_range'; label?: string | null }>;
    page_size?: number;
    default_sort_column?: string | null;
    default_sort_direction?: 'asc' | 'desc';
    row_actions?: Array<{
      id: string;
      label: string;
      icon?: string | null;
      style?: 'primary' | 'secondary' | 'ghost' | 'danger';
      go_to_screen?: string | null;
      carry?: string[];
      confirm_message?: string | null;
      visible_for_roles?: string[];
    }>;
    allow_add_row?: boolean;
    allow_delete_row?: boolean;
    required_columns?: string[];
    default_values?: Record<string, unknown>;
    computed_columns?: Array<{
      name: string;
      label?: string | null;
      formula: string;
      format?: string | null;
    }>;
    lookup_columns?: Array<{
      name: string;
      label?: string | null;
      from_table_id: number;
      match_column_local: string;
      match_column_remote: string;
      return_column: string;
      format?: string | null;
    }>;
    totals?: Record<string, 'sum' | 'avg' | 'min' | 'max' | 'count'>;
    column_groups?: Array<{ label: string; columns: string[] }>;
    group_by?: string[];
    column_metadata?: Record<
      string,
      {
        label?: string | null;
        width_px?: number | null;
        format?: string | null;
        align?: 'left' | 'center' | 'right' | null;
        merge?: boolean | null;
      }
    >;
    detail_panel?: {
      enabled: boolean;
      title?: string | null;
      columns?: string[];
      editable_columns?: string[];
      sections?: Record<string, string[]>;
    };
    empty_state_message?: string | null;
  };
  totals_row?: Record<string, unknown> | null;
  column_groups?: Array<{ label: string; columns: string[] }>;
  merges?: Array<{ column: string; row_start: number; row_span: number }>;
  column_labels?: Record<string, string>;
}

export interface TableRowDetailResponse {
  row: Record<string, unknown>;
  primary_key_columns: string[];
  columns: string[];
  editable_columns: string[];
  sections: Record<string, string[]>;
  title?: string | null;
  column_labels: Record<string, string>;
  column_metadata: Record<string, Record<string, unknown>>;
  computed_columns: Array<Record<string, unknown>>;
  lookup_columns: Array<Record<string, unknown>>;
}

export interface DocScreenResponse {
  screen_id: string;
  kind: 'doc';
  title: string;
  page?: Record<string, unknown> | null;
  blocks: DocBlockRendered[];
  context?: Record<string, unknown>;
}

export interface DashboardScreenResponse {
  screen_id: string;
  kind: 'dashboard';
  title: string;
  icon?: string | null;
  description?: string | null;
  dashboard: {
    share_token: string;
    password?: string | null;
    height_px?: number | null;
  };
}

export type ScreenResponse =
  | FormScreenResponse
  | TableScreenResponse
  | DocScreenResponse
  | DashboardScreenResponse;

const client = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
});

export const workspaceApi = {
  async getMeta(token: string): Promise<{ workspace: WorkspaceMeta }> {
    const r = await client.get(`/public/workspaces/${token}`);
    return r.data;
  },
  async login(
    token: string,
    username: string,
    pin: string,
  ): Promise<WorkspaceLoginResponse> {
    const r = await client.post(`/public/workspaces/${token}/login`, {
      username,
      pin,
    });
    return r.data;
  },
  async logout(token: string): Promise<void> {
    await client.post(`/public/workspaces/${token}/logout`);
  },
  async getMenu(token: string): Promise<WorkspaceMenuResponse> {
    const r = await client.get(`/public/workspaces/${token}/menu`);
    return r.data;
  },

  // ── Mini-app screen-based ─────────────────────────────────────────
  async getAppShell(token: string, workboardId: number): Promise<AppShellResponse> {
    const r = await client.get(
      `/public/workspaces/${token}/workboards/${workboardId}/app`,
    );
    return r.data;
  },
  async getScreen(
    token: string,
    workboardId: number,
    screenId: string,
    sharedContext?: Record<string, unknown>,
  ): Promise<ScreenResponse> {
    const params: Record<string, string> = {};
    if (sharedContext && Object.keys(sharedContext).length > 0) {
      params.shared = JSON.stringify(sharedContext);
    }
    const r = await client.get(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}`,
      { params },
    );
    return r.data;
  },
  async tableScreenRows(
    token: string,
    workboardId: number,
    screenId: string,
    body: {
      page?: number;
      page_size?: number;
      filters?: Array<Record<string, unknown>>;
    } = {},
  ): Promise<TableScreenResponse> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/table`,
      body,
    );
    return r.data;
  },
  async fetchTableRowDetail(
    token: string,
    workboardId: number,
    screenId: string,
    pk: Record<string, unknown>,
  ): Promise<TableRowDetailResponse> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/row`,
      { pk },
    );
    return r.data;
  },
  async insertScreenRow(
    token: string,
    workboardId: number,
    screenId: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/rows`,
      { values },
    );
    return r.data;
  },
  async bulkInsertScreenRows(
    token: string,
    workboardId: number,
    screenId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<{
    total: number;
    success: number;
    failure: number;
    results: Array<{
      index: number;
      ok: boolean;
      error?: string;
      violations?: Array<Record<string, unknown>>;
      pk?: Record<string, unknown>;
      warnings?: Array<Record<string, unknown>>;
    }>;
  }> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/rows/bulk`,
      { rows },
    );
    return r.data;
  },
  async updateScreenRow(
    token: string,
    workboardId: number,
    screenId: string,
    pk: Record<string, unknown>,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await client.patch(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/rows`,
      { pk, values },
    );
    return r.data;
  },
  async deleteScreenRow(
    token: string,
    workboardId: number,
    screenId: string,
    pk: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await client.delete(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/rows`,
      { data: { pk } },
    );
    return r.data;
  },
  async exportDocBlockExcel(
    token: string,
    workboardId: number,
    screenId: string,
    blockIndex: number,
  ): Promise<{ blob: Blob; filename: string }> {
    const r = await client.get(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/blocks/${blockIndex}/export.xlsx`,
      { responseType: 'blob' },
    );
    const disposition = String(r.headers['content-disposition'] || '');
    let filename = `export-${screenId}-block-${blockIndex + 1}.xlsx`;
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const asciiMatch = disposition.match(/filename="?([^";]+)"?/i);
    if (utf8Match) {
      try {
        filename = decodeURIComponent(utf8Match[1]);
      } catch {
        // keep fallback
      }
    } else if (asciiMatch) {
      filename = asciiMatch[1];
    }
    return { blob: r.data as Blob, filename };
  },

  async triggerBlockSync(
    token: string,
    workboardId: number,
    screenId: string,
    blockIndex: number,
    triggerId: string,
  ): Promise<{
    group_id: string;
    runs: Array<{
      run_id: string;
      status: string;
      webhook_id: string;
      webhook_name?: string | null;
    }>;
  }> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/blocks/${blockIndex}/sync`,
      { trigger_id: triggerId },
    );
    return r.data;
  },

  async getSyncGroup(
    token: string,
    workboardId: number,
    groupId: string,
  ): Promise<{
    group_id: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'partial' | 'cancelled';
    runs: Array<{
      run_id: string;
      status: string;
      webhook_id: string;
      webhook_name?: string | null;
      total_rows: number;
      total_batches: number;
      completed_batches: number;
      failed_batches: number;
      last_response_status?: number | null;
      last_error?: string | null;
    }>;
  }> {
    const r = await client.get(
      `/public/workspaces/${token}/workboards/${workboardId}/sync-groups/${groupId}`,
    );
    return r.data;
  },

  async cancelSyncGroup(
    token: string,
    workboardId: number,
    groupId: string,
  ): Promise<unknown> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/sync-groups/${groupId}/cancel`,
    );
    return r.data;
  },
};
