/**
 * Public-facing workspace API client.
 *
 * The workspace flow is intentionally separate from the AppBI-authenticated
 * workboards flow: end users do not have AppBI accounts, login goes against
 * a project-owned table and the session is a cookie set per workspace token.
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
  kind: 'form' | 'list' | 'doc' | 'dashboard';
  title: string;
  icon?: string | null;
  description?: string | null;
  show_in_nav: boolean;
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
}

export interface ScreenAction {
  id: string;
  label: string;
  icon?: string | null;
  style?: 'primary' | 'secondary' | 'ghost' | 'danger';
  go_to_screen?: string | null;
  carry?: string[];
  confirm_message?: string | null;
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
}

export interface ListScreenResponse {
  screen_id: string;
  kind: 'list';
  title: string;
  icon?: string | null;
  description?: string | null;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  page: number;
  page_size: number;
  list_view?: Record<string, unknown>;
  column_labels?: Record<string, string>;
}

export interface DocScreenResponse {
  screen_id: string;
  kind: 'doc';
  title: string;
  page?: Record<string, unknown> | null;
  blocks: DocBlockRendered[];
  context?: Record<string, unknown>;
}

export type ScreenResponse = FormScreenResponse | ListScreenResponse | DocScreenResponse;

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
  async listScreenRows(
    token: string,
    workboardId: number,
    screenId: string,
    body: {
      page?: number;
      page_size?: number;
      filters?: Array<Record<string, unknown>>;
    } = {},
  ): Promise<ListScreenResponse> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/list`,
      body,
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
};
