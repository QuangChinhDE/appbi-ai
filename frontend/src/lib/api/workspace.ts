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

export interface ThemeBackgroundApi {
  kind: 'color' | 'gradient' | 'image';
  color?: string | null;
  gradient_preset?: string | null;
  image_data?: string | null;
}

export interface WorkspaceBranding {
  app_name?: string | null;
  logo_url?: string | null;
  logo_data?: string | null;
  logo_layout?: 'mark' | 'wide' | null;
  primary_color?: string | null;
  accent_color?: string | null;
  welcome_text?: string | null;
  theme?: 'light' | 'dark' | 'auto';
  background?: ThemeBackgroundApi | null;
  font_family?: 'system' | 'inter' | 'be-vietnam' | 'roboto' | 'serif' | 'mono' | null;
  card_style?: {
    radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | null;
    shadow?: 'none' | 'sm' | 'md' | null;
    border?: boolean | null;
  } | null;
  header_style?: 'fill' | 'line' | 'minimal' | null;
  login?: { background?: ThemeBackgroundApi | null; tagline?: string | null } | null;
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

export interface ExperienceResolved {
  schema_version?: number;
  preset?: string | null;
  theme: {
    primary: string; success: string; warning: string; danger: string; info: string;
    neutral: string; background: string; surface: string; border: string; text: string;
    font_family: string; heading_weight: string; body_weight: string; type_scale: number;
    density: 'compact' | 'cozy' | 'comfortable';
    radius: 'none' | 'small' | 'medium' | 'large' | 'full';
    elevation: 'none' | 'small' | 'medium' | 'large';
    motion: 'instant' | 'standard' | 'expressive';
    mode: 'light' | 'dark' | 'auto';
    app_background?: string | null;
  };
  shell: {
    sticky_header: boolean; show_search: boolean; show_logo: boolean;
    content_width: 'full_bleed' | 'constrained' | 'wide'; content_width_px?: number | null;
    page_padding: 'compact' | 'cozy' | 'comfortable'; footer_enabled: boolean;
    background: 'light' | 'gray' | 'dark' | 'custom';
  };
  navigation: {
    desktop_kind: 'sidebar' | 'top_tabs' | 'compact_rail';
    mobile_kind: 'bottom_nav' | 'drawer';
    sidebar_width: number; default_collapsed: boolean; show_icons: boolean;
    show_labels: boolean; active_style: 'pill' | 'bar' | 'highlight'; breadcrumbs: boolean;
  };
  feedback: {
    loading: 'skeleton' | 'spinner'; empty_style: 'illustration' | 'message' | 'minimal';
    success: 'toast' | 'inline' | 'banner'; confirmation: 'modal' | 'drawer' | 'inline';
    error_retry: boolean; motion_ms: number;
  };
  /** True only when layout.experience exists. Legacy boards keep the old
   * compatibility renderer instead of receiving the broad semantic sweep. */
  explicit?: boolean;
  /** Exact author-authored block, before defaults/legacy inheritance. */
  overrides?: {
    schema_version?: number;
    preset?: string | null;
    theme?: Partial<ExperienceResolved['theme']>;
    shell?: Partial<ExperienceResolved['shell']>;
    navigation?: Partial<ExperienceResolved['navigation']>;
    feedback?: Partial<ExperienceResolved['feedback']>;
  };
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
  /** Resolved presentation contract (Experience Studio). Always populated by the
   * backend (defaults ← legacy branding/nav adapter ← explicit experience). */
  experience?: ExperienceResolved;
  /** Storage-aware media size ceiling (KB); FE pre-checks uploads against it. */
  media_max_kb?: number;
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
  action_type?: 'navigate' | 'open_related_records';
  go_to_screen?: string | null;
  carry?: string[];
  relation_id?: string | null;
  parent_screen_id?: string | null;
  confirm_message?: string | null;
  visible_for_roles?: string[];
}

export interface ScreenPresentation {
  content_width?: 'narrow' | 'standard' | 'wide';
  page_padding?: number;
  card_radius?: number;
  shadow?: 'none' | 'small' | 'medium' | 'large';
  motion?: 'instant' | 'standard' | 'expressive';
  density?: 'compact' | 'cozy' | 'comfortable';
  sticky_action_bar?: boolean;
  form?: {
    columns?: 1 | 2 | 3;
    section_style?: 'plain' | 'divided' | 'surface';
  };
  table?: {
    sticky_header?: boolean;
    row_height?: 'compact' | 'cozy' | 'comfortable';
    filter_position?: 'top' | 'sticky';
    action_placement?: 'inline' | 'top_bar' | 'drawer';
    mobile_rendering?: 'table' | 'cards' | 'list';
  };
  doc?: Record<string, unknown>;
  dashboard?: Record<string, unknown>;
  responsive?: Record<string, unknown>;
}

export interface RelatedRecordConfig {
  id: string;
  label?: string | null;
  child_screen_id: string;
  parent_key_column: string;
  child_foreign_key_column: string;
  allow_multiple?: boolean;
  show_existing?: boolean;
  allow_add_after_save?: boolean;
  keep_parent_context?: boolean;
  delete_behavior?: 'restrict' | 'cascade' | 'unlink';
  display_columns?: string[];
  finish_screen_id?: string | null;
}

export interface RelatedRecordsResponse {
  columns: string[];
  primary_key_columns?: string[];
  rows: Array<Record<string, unknown>>;
  total_count?: number;
}

export interface OpenRelatedRecordsResponse {
  child_screen_id: string;
  parent_values: Record<string, unknown>;
  relation_context: {
    relation_id: string;
    relation_label?: string | null;
    parent_screen_id: string;
    child_screen_id: string;
    parent_key_column: string;
    parent_key_value: unknown;
    child_foreign_key_column: string;
    finish_screen_id?: string | null;
    show_existing?: boolean;
    allow_multiple?: boolean;
    keep_parent_context?: boolean;
  };
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
  lookups: Record<string, Array<{ label: string; value: unknown; geometry?: unknown; lat?: unknown; lng?: unknown; filter?: unknown }>>;
  initial_values: Record<string, unknown>;
  after_submit?: ScreenAction | null;
  related_records?: RelatedRecordConfig[];
  /** Columns the workboard auto-fills on insert when left blank.
   *  Treat as readonly with a hint so the user knows typing is ignored. */
  auto_number_columns?: string[];
  /** Per-column scope metadata so the FE can guide the user on which fields a
   *  scoped sequence depends on (scope_columns + date_column). */
  auto_number_meta?: Record<
    string,
    { scope_columns?: string[]; date_column?: string | null; missing_scope_behavior?: string }
  >;
  /** When set, the FE captures device GPS at submit and writes "lat,lng" here. */
  geo_stamp_column?: string | null;
  /** Pages array for multi-step forms (optional). */
  pages?: Array<Record<string, unknown>>;
  /** Section headings used to group fields inside a single page. */
  sections?: string[];
  /** Photo-capture / OCR — runtime only learns whether it is enabled. */
  ocr?: { enabled?: boolean } | null;
  presentation?: ScreenPresentation | null;
}

export interface OcrExtractResult {
  values: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface PosCartHeaderInput {
  column: string;
  label: string;
  kind?: 'text' | 'select' | 'date';
  options?: string[];
  default?: string | null;
  required?: boolean;
  write_to_line?: boolean;
}

export interface PosCartConfig {
  barcode_column: string;
  quantity_column: string;
  catalog_table_id: number;
  catalog_match_column: string;
  catalog_label_column?: string | null;
  catalog_price_column?: string | null;
  catalog_copy?: Record<string, string>;
  amount_column?: string | null;
  header_inputs?: PosCartHeaderInput[];
  order_id_column?: string | null;
  order_id_prefix?: string;
  date_column?: string | null;
  header_screen_id?: string | null;
  submit_label?: string;
  after_submit_screen?: string | null;
  after_submit_carry?: string[];
  allow_manual_search?: boolean;
  catalog_group_column?: string | null;
  empty_hint?: string | null;
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
      action_type?: 'navigate' | 'open_related_records';
      go_to_screen?: string | null;
      carry?: string[];
      relation_id?: string | null;
      parent_screen_id?: string | null;
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
    rollup_columns?: Array<{
      name: string;
      label?: string | null;
      from_table_id: number;
      match_column_local: string;
      match_column_remote: string;
      agg?: 'sum' | 'count' | 'avg' | 'min' | 'max';
      value_column?: string;
      format?: string | null;
    }>;
    format_rules?: Array<{
      when: string;
      color: 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'violet';
      columns?: string[];
      icon?: string | null;
      label?: string | null;
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
        input_type?: string | null;
        options?: Array<{ label: string; value: unknown }> | null;
        currency_code?: string | null;
        max_stars?: number | null;
        min_value?: number | null;
        max_value?: number | null;
        step?: number | null;
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
    display_mode?: 'table' | 'gallery' | 'calendar' | 'route_map';
    gallery_config?: {
      image_column: string;
      title_column?: string | null;
      subtitle_column?: string | null;
      group_by_column?: string | null;
      columns_per_row?: number;
    } | null;
    calendar_config?: {
      date_column: string;
      title_column?: string | null;
      color_column?: string | null;
    } | null;
    route_map_config?: {
      lat_column: string;
      lng_column: string;
      title_column?: string | null;
      subtitle_columns?: string[];
      route_id_column?: string | null;
      route_filter_default?: string | null;
      order_column?: string | null;
      weight_column?: string | null;
      value_column?: string | null;
      deadline_column?: string | null;
      vehicle_column?: string | null;
      status_column?: string | null;
      basemap?: 'satellite' | 'streets' | 'light';
      line_mode?: 'straight' | 'road';
      route_provider?: 'osrm';
      route_profile?: 'driving';
      fallback_line_mode?: 'straight';
      show_side_panel?: boolean;
      side_panel_title?: string | null;
      selection_budget?: {
        value_column: string;
        limit?: string | null;
        unit?: string | null;
        label?: string | null;
        block_when_over?: boolean;
        action_label?: string | null;
        action_go_to_screen?: string | null;
      } | null;
    } | null;
    geocode?: {
      enabled?: boolean;
      provider?: 'nominatim' | 'none';
      address_column?: string | null;
      address_template?: string | null;
      lat_column: string;
      lng_column: string;
      status_column?: string | null;
      provider_label_column?: string | null;
      overwrite_existing?: boolean;
      country_codes?: string | null;
      language?: string | null;
      timeout_seconds?: number;
    } | null;
    stat_tiles?: Array<{ label: string; column: string; agg?: string; format?: string | null; unit?: string | null }>;
    pos_cart?: PosCartConfig | null;
    bulk_actions?: Array<{
      id: string;
      label: string;
      icon?: string | null;
      style?: 'primary' | 'secondary' | 'ghost' | 'danger';
      set_column: string;
      also_set?: Record<string, unknown>;
      parent_screen_id: string;
      parent_code_column: string;
      code_prefix?: string;
      parent_defaults?: Record<string, unknown>;
      confirm_message?: string | null;
      min_selection?: number;
      success_message?: string | null;
      visible_for_roles?: string[];
      require_same?: string[];
      preview_aggregates?: Array<{ column: string; agg?: 'sum' | 'avg' | 'min' | 'max' | 'count'; label: string; format?: string | null }>;
      route_preview?: {
        lat_column: string;
        lng_column: string;
        title_column?: string | null;
        subtitle_columns?: string[];
        route_id_column?: string | null;
        route_filter_default?: string | null;
        order_column?: string | null;
        weight_column?: string | null;
        value_column?: string | null;
        deadline_column?: string | null;
        vehicle_column?: string | null;
        status_column?: string | null;
        basemap?: 'satellite' | 'streets' | 'light';
        line_mode?: 'straight' | 'road';
        route_provider?: 'osrm';
        route_profile?: 'driving';
        fallback_line_mode?: 'straight';
        show_side_panel?: boolean;
        side_panel_title?: string | null;
      } | null;
      // Phase-2 advanced (server-executed recipe + pickers + guards)
      resource_inputs?: Array<{
        id: string;
        label: string;
        source_screen_id: string;
        value_column: string;
        label_column?: string | null;
        required?: boolean;
        capacity_column?: string | null;
      }>;
      constraints?: Array<{
        agg_column: string;
        agg?: 'sum' | 'count' | 'avg' | 'min' | 'max';
        op?: '<=' | '<' | '>=' | '>';
        limit?: number | null;
        limit_from_resource?: string | null;
        label?: string | null;
        error_message?: string | null;
      }>;
      steps?: Array<Record<string, unknown>>;
    }>;
  };
  pos_catalog?: {
    match_column?: string | null;
    label_column?: string | null;
    price_column?: string | null;
    group_column?: string | null;
    rows: Array<Record<string, unknown>>;
  } | null;
  totals_row?: Record<string, unknown> | null;
  stat_tiles?: Array<{ label: string; value: unknown; format?: string | null; unit?: string | null }>;
  /** Distinct values per "single select" filter column, for dropdown slicers. */
  filter_options?: Record<string, string[]>;
  column_groups?: Array<{ label: string; columns: string[] }>;
  merges?: Array<{ column: string; row_start: number; row_span: number }>;
  column_labels?: Record<string, string>;
  presentation?: ScreenPresentation | null;
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

export interface PrintTemplate {
  enabled?: boolean;
  company_name?: string | null;
  address?: string | null;
  tax_code?: string | null;
  hotline?: string | null;
  email?: string | null;
  website?: string | null;
  logo_data?: string | null;
  footer_note?: string | null;
  accent_color?: string | null;
}

export interface DocScreenResponse {
  screen_id: string;
  kind: 'doc';
  title: string;
  page?: Record<string, unknown> | null;
  blocks: DocBlockRendered[];
  context?: Record<string, unknown>;
  print_template?: PrintTemplate | null;
  presentation?: ScreenPresentation | null;
}

export interface DashboardScreenResponse {
  screen_id: string;
  kind: 'dashboard';
  title: string;
  icon?: string | null;
  description?: string | null;
  presentation?: ScreenPresentation | null;
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

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function blobToErrorMessage(blob: Blob): Promise<string | null> {
  try {
    const text = await blob.text();
    if (!text.trim()) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.detail) {
        return typeof parsed.detail === 'string'
          ? parsed.detail
          : JSON.stringify(parsed.detail);
      }
      if (parsed?.message) return String(parsed.message);
    } catch {
      // Not JSON. Fall through to a short text/html preview.
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 220);
  } catch {
    return null;
  }
}

async function assertXlsxBlob(blob: Blob): Promise<void> {
  if (!blob || blob.size === 0) {
    throw new Error('File Excel tải về đang rỗng.');
  }
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isZip =
    signature[0] === 0x50 &&
    signature[1] === 0x4b &&
    signature[2] === 0x03 &&
    signature[3] === 0x04;
  if (isZip) return;

  const serverMessage = await blobToErrorMessage(blob);
  throw new Error(
    serverMessage ||
      'Máy chủ không trả về file XLSX hợp lệ. Vui lòng thử xuất lại.',
  );
}

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
      shared?: Record<string, unknown>;
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
    opId?: string,
    relationContext?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/rows`,
      // client_op_id = idempotency key so an offline submit replayed after
      // reconnect can never be inserted twice (BE dedups on it).
      {
        values,
        ...(opId ? { client_op_id: opId } : {}),
        ...(relationContext ? { relation_context: relationContext } : {}),
      },
    );
    return r.data;
  },
  async getRelatedRecords(
    token: string,
    workboardId: number,
    params: {
      parent_screen_id: string;
      relation_id: string;
      parent_key_value: unknown;
    },
  ): Promise<RelatedRecordsResponse> {
    const r = await client.get(
      `/public/workspaces/${token}/workboards/${workboardId}/related-records`,
      {
        params: {
          parent_screen_id: params.parent_screen_id,
          relation_id: params.relation_id,
          parent_key_value: JSON.stringify(params.parent_key_value ?? null),
        },
      },
    );
    return r.data;
  },
  async openRelatedRecords(
    token: string,
    workboardId: number,
    screenId: string,
    actionId: string,
    pk: Record<string, unknown>,
  ): Promise<OpenRelatedRecordsResponse> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}` +
        `/screens/${screenId}/actions/${actionId}/open-related-records`,
      { pk },
    );
    return r.data;
  },
  async ocrExtract(
    token: string,
    workboardId: number,
    screenId: string,
    image: string,
  ): Promise<OcrExtractResult> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/ocr-extract`,
      { image },
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
  // Advanced "gộp & điều phối" — server-executed recipe (BulkAction.steps).
  async bulkAction(
    token: string,
    workboardId: number,
    screenId: string,
    body: { action_id: string; selected_pks: Array<Record<string, unknown>>; resources?: Record<string, Record<string, unknown>> },
  ): Promise<{
    ok: boolean;
    primary_code?: string | null;
    codes?: Record<string, string>;
    created?: number;
    updated?: number;
    per_step?: Array<Record<string, unknown>>;
    success_message?: string;
  }> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/bulk-action`,
      body,
    );
    return r.data;
  },
  // ── Web Push (C13) ──
  async pushConfig(token: string): Promise<{ enabled: boolean; public_key: string | null }> {
    const r = await client.get(`/public/workspaces/${token}/push/config`);
    return r.data;
  },
  async pushSubscribe(
    token: string,
    workboardId: number,
    subscription: unknown,
    unsubscribe = false,
  ): Promise<Record<string, unknown>> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/push/subscribe`,
      { subscription, unsubscribe },
    );
    return r.data;
  },
  async pushTest(token: string, workboardId: number): Promise<{ ok: boolean; delivered: number }> {
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/push/test`,
      {},
    );
    return r.data;
  },
  async exportDocBlockExcel(
    token: string,
    workboardId: number,
    screenId: string,
    blockIndex: number,
    sharedContext?: Record<string, unknown>,
  ): Promise<{ blob: Blob; filename: string }> {
    const params: Record<string, string> = {};
    if (sharedContext && Object.keys(sharedContext).length > 0) {
      params.shared = JSON.stringify(sharedContext);
    }
    let r;
    try {
      r = await client.get(
        `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/blocks/${blockIndex}/export.xlsx`,
        { responseType: 'blob', params, headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.data instanceof Blob) {
        const message = await blobToErrorMessage(err.response.data);
        throw new Error(message || 'Không xuất được Excel.');
      }
      throw err;
    }
    // Guard: if the server (or a stale cache) returned a non-spreadsheet body
    // (JSON/HTML error), surface it instead of saving a corrupt ".xlsx".
    const rawBlob = r.data as Blob;
    const blobType = String(rawBlob?.type || '');
    if (blobType && !blobType.includes('spreadsheet') && !blobType.includes('octet-stream')) {
      let msg = 'Xuất Excel lỗi — máy chủ trả về nội dung không hợp lệ.';
      try {
        const text = await (r.data as Blob).text();
        const parsed = JSON.parse(text);
        if (parsed?.detail) msg = String(parsed.detail);
      } catch {
        /* keep default */
      }
      throw new Error(msg);
    }
    await assertXlsxBlob(rawBlob);
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
    // Re-wrap with the canonical spreadsheet MIME so the saved file always
    // opens as Excel regardless of what the transport tagged the blob.
    return {
      blob:
        blobType === XLSX_MIME
          ? rawBlob
          : new Blob([rawBlob], { type: XLSX_MIME }),
      filename,
    };
  },

  async triggerBlockSync(
    token: string,
    workboardId: number,
    screenId: string,
    blockIndex: number,
    triggerId: string,
    sharedContext?: Record<string, unknown>,
  ): Promise<{
    group_id: string;
    runs: Array<{
      run_id: string;
      status: string;
      webhook_id: string;
      webhook_name?: string | null;
    }>;
  }> {
    const body: Record<string, unknown> = { trigger_id: triggerId };
    if (sharedContext && Object.keys(sharedContext).length > 0) {
      body.shared = sharedContext;
    }
    const r = await client.post(
      `/public/workspaces/${token}/workboards/${workboardId}/screens/${screenId}/blocks/${blockIndex}/sync`,
      body,
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
