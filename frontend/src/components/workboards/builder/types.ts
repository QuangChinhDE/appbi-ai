/**
 * Mini-app builder types — mirror the backend ``LayoutJson.screens[]``
 * shape so the builder edits exactly the JSON the runtime consumes.
 *
 * Kept loose (``unknown`` for free-form fields) so we don't have to
 * re-derive Pydantic types in TS — the canonical contract is defined in
 * ``backend/app/modules/workboards/schemas.py``.
 */

export type ScreenKind = 'form' | 'table' | 'doc' | 'dashboard';

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

export interface FormFieldSpec {
  column: string;
  widget:
    | 'text'
    | 'textarea'
    | 'number'
    | 'select'
    | 'date'
    | 'datetime'
    | 'checkbox'
    | 'lookup'
    | 'file'
    | 'image'
    | 'map'
    | 'geopoint'
    | 'images'
    | 'signature'
    | 'barcode'
    | 'audio'
    | 'computed'
    | 'status'
    | 'email'
    | 'phone'
    | 'url'
    | 'rich_text'
    | 'enum_list'
    | 'rating'
    | 'slider'
    | 'currency'
    | 'percent'
    | 'time'
    | 'duration'
    | 'color'
    | 'video'
    | 'qr';
  label?: string | null;
  required?: boolean;
  default?: unknown;
  help_text?: string | null;
  placeholder?: string | null;
  readonly?: boolean;
  lookup?: {
    kind: 'static' | 'dataset_table';
    values?: Array<{ label: string; value: unknown }> | null;
    table_id?: number | null;
    value_column?: string | null;
    label_column?: string | null;
    relationship_path?: Array<{
      table_id?: number | null;
      value_column?: string | null;
      label_column?: string | null;
    }> | null;
    // Map widget only — geometry projection + basemap style.
    geometry_column?: string | null;
    lat_column?: string | null;
    lng_column?: string | null;
    basemap?: 'satellite' | 'streets' | 'light' | null;
    // Cascading select — narrow options by another field's value.
    filter_by_field?: string | null;
    filter_column?: string | null;
  } | null;
  section?: string | null;
  page?: number | null;
  show_if?: string | null;
  required_if?: string | null;
  readonly_if?: string | null;
  valid_if?: string | null;
  valid_if_error?: string | null;
  computed_from_dataset?: string | null;
  max_file_kb?: number | null;
  // Capture / media / measurement extras.
  capture_only?: boolean | null;
  max_items?: number | null;
  unit?: string | null;
  formula?: string | null;
  status_config?: {
    states?: Array<{ value: string; label?: string | null; color?: string | null }>;
    editable_by_roles?: string[];
    // Lifecycle guard enforced server-side: from-value -> allowed to-values.
    allowed_transitions?: Record<string, string[]>;
  } | null;
  // Rich input-type config.
  max_stars?: number | null;
  allow_half?: boolean | null;
  min_value?: number | null;
  max_value?: number | null;
  step?: number | null;
  currency_code?: string | null;
  max_select?: number | null;
  enum_list_style?: 'chips' | 'dropdown' | 'checkboxes' | null;
  searchable?: 'auto' | 'always' | 'never' | null;
  // QR display (widget='qr').
  qr_source_column?: string | null;
  qr_value_template?: string | null;
  qr_size?: number | null;
  qr_caption?: string | null;
  // Scan -> navigate (widget='barcode').
  scan_go_to_screen?: string | null;
  scan_carry_as?: string | null;
}

export interface FormScreenSpecBuilt {
  fields: FormFieldSpec[];
  submit_label?: string | null;
  after_submit?: ScreenAction | null;
  related_records?: RelatedRecordConfigSpec[];
  initial_values?: Record<string, unknown>;
  pages?: Array<{
    id: number;
    title: string;
    description?: string | null;
    show_if?: string | null;
  }>;
  sections?: string[];
  ocr?: OcrConfigSpec | null;
  geo_stamp_column?: string | null;
}

export interface RelatedRecordConfigSpec {
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

export interface OcrConfigSpec {
  enabled?: boolean;
  provider?: 'anthropic' | 'openai' | 'gemini';
  model?: string | null;
  /** Write-only on save; blank keeps the stored key. GET returns '' + api_key_set. */
  api_key?: string | null;
  api_key_set?: boolean;
  hint?: string | null;
}

export interface TableFilterSpec {
  column: string;
  kind: 'text' | 'select' | 'date_range' | 'number_range';
  label?: string | null;
}

export type CellFormat =
  | 'text'
  | 'number'
  | 'integer'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime';

export interface TableComputedColumnSpec {
  name: string;
  label?: string | null;
  /** JavaScript function body — see ``services/js_evaluator.py``. */
  formula: string;
  format?: CellFormat | null;
}

export interface TableLookupColumnSpec {
  name: string;
  label?: string | null;
  from_table_id: number;
  match_column_local: string;
  match_column_remote: string;
  return_column: string;
  format?: CellFormat | null;
}

export type TableRollupAgg = 'sum' | 'count' | 'avg' | 'min' | 'max';

export interface TableRollupColumnSpec {
  name: string;
  label?: string | null;
  from_table_id: number;
  match_column_local: string;
  match_column_remote: string;
  agg?: TableRollupAgg;
  value_column?: string | null;
  format?: CellFormat | null;
}

export type FormatRuleColor = 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'violet';

export interface FormatRuleSpec {
  when: string;
  color?: FormatRuleColor;
  columns?: string[];
  icon?: string | null;
  label?: string | null;
}

export type TableTotalsKind = 'sum' | 'avg' | 'min' | 'max' | 'count';

export interface TableColumnGroupSpec {
  label: string;
  columns: string[];
}

export type TableInputType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'time'
  | 'checkbox'
  | 'select'
  | 'enum_list'
  | 'rating'
  | 'color'
  | 'slider';

export interface TableColumnMetaSpec {
  label?: string | null;
  width_px?: number | null;
  format?: CellFormat | null;
  align?: 'left' | 'center' | 'right' | null;
  merge?: boolean | null;
  /** Typed inline editor for an editable column. Undefined = plain text. */
  input_type?: TableInputType | null;
  options?: Array<{ label: string; value: unknown }> | null;
  currency_code?: string | null;
  max_stars?: number | null;
  min_value?: number | null;
  max_value?: number | null;
  step?: number | null;
}

export interface TableDetailPanelSpec {
  enabled?: boolean;
  title?: string | null;
  columns?: string[];
  editable_columns?: string[];
  sections?: Record<string, string[]>;
}

export interface PosCartHeaderInputSpec {
  column: string;
  label: string;
  kind?: 'text' | 'select' | 'date';
  options?: string[];
  default?: string | null;
  required?: boolean;
  write_to_line?: boolean;
}

export interface PosCartConfigSpec {
  barcode_column: string;
  quantity_column: string;
  catalog_table_id: number;
  catalog_match_column: string;
  catalog_label_column?: string | null;
  catalog_price_column?: string | null;
  catalog_copy?: Record<string, string>;
  amount_column?: string | null;
  header_inputs?: PosCartHeaderInputSpec[];
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

export interface TableScreenSpecBuilt {
  columns: string[];
  editable_columns?: string[];
  filters?: TableFilterSpec[];
  page_size?: number;
  default_sort_column?: string | null;
  default_sort_direction?: 'asc' | 'desc';
  row_actions?: ScreenAction[];
  allow_add_row?: boolean;
  allow_delete_row?: boolean;
  required_columns?: string[];
  default_values?: Record<string, unknown>;
  computed_columns?: TableComputedColumnSpec[];
  lookup_columns?: TableLookupColumnSpec[];
  rollup_columns?: TableRollupColumnSpec[];
  format_rules?: FormatRuleSpec[];
  totals?: Record<string, TableTotalsKind>;
  column_groups?: TableColumnGroupSpec[];
  group_by?: string[];
  column_metadata?: Record<string, TableColumnMetaSpec>;
  detail_panel?: TableDetailPanelSpec;
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
  stat_tiles?: Array<{
    label: string;
    column: string;
    agg?: 'sum' | 'avg' | 'min' | 'max' | 'count';
    format?: string | null;
    unit?: string | null;
  }>;
  /** Supermarket-style batch scan cart. When set, the runtime renders a POS
   * interface instead of the grid. None/undefined = ordinary table. */
  pos_cart?: PosCartConfigSpec | null;
  /** "Select many rows → one action" recipes (gộp nhóm / điều phối). Rendered as
   * a checkbox column + a compact command bar. The advanced server-executed
   * `steps` recipe is authored via MCP; the builder edits the surface knobs
   * (label, totals, capacity check, pickers, route preview) and round-trips
   * `steps`/simple write fields untouched. */
  bulk_actions?: BulkActionSpec[];
}

export interface BulkActionSpec {
  id: string;
  label: string;
  icon?: string | null;
  style?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** SIMPLE mode write targets (round-tripped; required by BE when `steps` empty). */
  set_column?: string;
  also_set?: Record<string, unknown>;
  parent_screen_id?: string;
  parent_code_column?: string;
  code_prefix?: string;
  parent_defaults?: Record<string, unknown>;
  confirm_message?: string | null;
  min_selection?: number;
  success_message?: string | null;
  visible_for_roles?: string[];
  require_same?: string[];
  /** Running totals shown on the command bar (tự tính tổng). */
  preview_aggregates?: Array<{
    column: string;
    agg?: 'sum' | 'avg' | 'min' | 'max' | 'count';
    label: string;
    format?: string | null;
  }>;
  /** Numeric guards over the selection (e.g. tổng khối lượng ≤ tải trọng xe). */
  constraints?: Array<{
    agg_column: string;
    agg?: 'sum' | 'count' | 'avg' | 'min' | 'max';
    op?: '<=' | '<' | '>=' | '>';
    limit?: number | null;
    limit_from_resource?: string | null;
    label?: string | null;
    error_message?: string | null;
  }>;
  /** Records the operator picks before running (Xe/Kho…); feed the parent + supply constraint limits. */
  resource_inputs?: Array<{
    id: string;
    label: string;
    source_screen_id: string;
    value_column: string;
    label_column?: string | null;
    required?: boolean;
    capacity_column?: string | null;
  }>;
  /** Optional route map of the selected rows (same shape as route_map_config). */
  route_preview?: TableScreenSpecBuilt['route_map_config'];
  /** Advanced server-executed recipe — authored via MCP, round-tripped untouched here. */
  steps?: unknown[];
}

export interface DocBlockSpec {
  type:
    | 'header'
    | 'kv_grid'
    | 'data_table'
    | 'text'
    | 'spacer'
    | 'signature'
    | 'footer'
    | 'qr_code';
  [key: string]: unknown;
}

/**
 * Per-column metadata for `data_table` blocks. The builder stores this on
 * `data_table.column_metadata[colName]`; runtime still receives the
 * canonical `columns: string[]` plus derived `group_by` / `totals` arrays
 * so legacy backends stay compatible.
 */
export interface DataTableColumnMeta {
  /** Friendly header label. Empty/missing = use the raw column name. */
  label?: string;
  /** Pixel width hint for the runtime/exporters. */
  width_px?: number | null;
  /** 'number' | 'integer' | 'currency' | 'percent' | 'date' | 'datetime' | 'text' */
  format?: string | null;
  /** Header & body alignment. */
  align?: 'left' | 'center' | 'right' | null;
  /** Footer aggregation to compute for this column. */
  total?: 'sum' | 'avg' | 'count' | 'min' | 'max' | null;
  /** When true, the runtime merges consecutive identical cells in this column. */
  merge?: boolean;
}

export interface DocScreenSpecBuilt {
  page?: { size?: 'A4' | 'A3' | 'Letter'; orientation?: 'portrait' | 'landscape'; margin_mm?: number };
  blocks: DocBlockSpec[];
}

export interface DashboardRoleFilterMappingSpec {
  /** Required by the dashboard public runtime — slicer model keys filters by (datasetId, semanticField). */
  datasetId: number;
  /** Dotted semantic ref like 'hr.phong_ban'. Must match a slot in the dashboard's available_filter_fields. */
  semanticField: string;
  /** Comparison operator the runtime applies. Defaults to 'eq' since the value is a single role string. */
  operator?: string;
}

export interface DashboardStaticFilterSpec {
  datasetId: number;
  semanticField: string;
  operator?: string;
  /** Hard-coded value applied to every managed link of the screen. Scalar or list (for in/not_in). */
  value: unknown;
  type?: string;
}

export interface DashboardScreenSpecBuilt {
  /** Managed mode: builder picks a dashboard the user has view access to. */
  dashboard_id?: number | null;
  /**
   * Filter slots whose value is filled with the viewing app_user's role at
   * provision time. Empty array = every role gets the same link (no
   * per-role filtering).
   */
  role_filter_mapping?: DashboardRoleFilterMappingSpec[];
  /** Filters with hard-coded values applied to every managed link regardless of role. */
  static_filters?: DashboardStaticFilterSpec[];
  /** role -> share_token. Written by the backend on save; treat as read-only on the FE. */
  managed_links?: Record<string, string>;
  /** Manual mode (legacy / quick-embed): paste an existing public share token. */
  share_token?: string | null;
  password?: string | null;
  height_px?: number | null;
}

export interface ScreenRlsRuleSpec {
  role: string;
  unrestricted?: boolean;
  filter_column?: string | null;
  filter_value?: unknown;
  can_create?: boolean;
  can_update?: boolean;
  can_delete?: boolean;
  writable_columns?: string[] | null;
  readonly_columns?: string[] | null;
}

export interface ScreenPresentationSpec {
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

export interface ScreenSpec {
  id: string;
  kind: ScreenKind;
  title: string;
  icon?: string | null;
  description?: string | null;
  table_id?: number | null;
  primary_key_columns?: string[];
  visible_for_roles?: string[];
  show_in_nav?: boolean;
  form?: FormScreenSpecBuilt | null;
  table?: TableScreenSpecBuilt | null;
  doc?: DocScreenSpecBuilt | null;
  dashboard?: DashboardScreenSpecBuilt | null;
  /** Presentation-only overrides; absent fields inherit app experience. */
  presentation?: ScreenPresentationSpec | null;
  rls?: ScreenRlsRuleSpec[];
  rls_default?: ScreenRlsRuleSpec | null;
}

export interface MiniAppNavSpec {
  mobile_kind: 'bottom_nav' | 'drawer';
  desktop_kind: 'sidebar' | 'top_tabs';
  items: string[];
}

/**
 * A named group of screens inside a workboard — surfaced to the end-user as a
 * "Workspace" (Workboard → Workspaces → Screens). Additive & back-compat: an
 * empty ``screen_groups`` means flat navigation (legacy behaviour). Mirrors
 * ``ScreenGroup`` in ``backend/app/modules/workboards/schemas.py``.
 */
export interface ScreenGroupSpec {
  id: string;
  label: string;
  icon?: string | null;
  /**
   * Screen ids that belong to this workspace (membership). Runtime nav order
   * follows the flat Screens-list order, NOT this array's order.
   */
  screen_ids: string[];
  /**
   * RESERVED / not settable in the builder (Workspaces v1). NAV-DISPLAY ONLY —
   * per-screen ``visible_for_roles`` remains authoritative for access. Always
   * empty today; see ScreenGroup in backend schemas.py for the semantics before
   * wiring a UI.
   */
  visible_for_roles?: string[];
}

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ThemeFont = 'system' | 'inter' | 'be-vietnam' | 'roboto' | 'serif' | 'mono';

export interface ThemeBackgroundSpec {
  kind: 'color' | 'gradient' | 'image';
  color?: string | null;
  gradient_preset?: string | null;
  /** data: URI (client-compressed, ~200KB cap) — external URLs are CSP-blocked. */
  image_data?: string | null;
}

export interface ThemeCardStyleSpec {
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | null;
  shadow?: 'none' | 'sm' | 'md' | null;
  border?: boolean | null;
}

export interface ThemeLoginSpec {
  background?: ThemeBackgroundSpec | null;
  tagline?: string | null;
}

/** Theme + branding superset (mirrors BE BrandingConfig / WorkspaceBranding). */
export interface BrandingSpec {
  app_name?: string | null;
  logo_url?: string | null;
  logo_data?: string | null;
  logo_layout?: 'mark' | 'wide' | null;
  primary_color?: string | null;
  accent_color?: string | null;
  welcome_text?: string | null;
  theme?: ThemeMode;
  background?: ThemeBackgroundSpec | null;
  font_family?: ThemeFont | null;
  card_style?: ThemeCardStyleSpec | null;
  header_style?: 'fill' | 'line' | 'minimal' | null;
  login?: ThemeLoginSpec | null;
}

export interface AutoNumberConfigSpec {
  table_id?: number | null;
  column: string;
  pattern: string;
  reset?: 'never' | 'daily' | 'monthly' | 'yearly';
  padding?: number;
  start_at?: number;
  // Scoped sequences (P0): counter restarts per distinct combination of these
  // columns. Empty = one global counter (legacy).
  scope_columns?: string[];
  // Derive the reset period + pattern date parts from this row column instead
  // of the insert wall-clock (e.g. key mã chuyến off the trip date entered).
  date_column?: string | null;
  allow_manual_override?: boolean;
  missing_scope_behavior?: 'empty' | 'error';
  on_error?: 'leave_blank' | 'block';
}

export interface PrintTemplateSpec {
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

export interface ExperienceSpec {
  schema_version?: number;
  preset?: string | null;
  theme?: {
    primary?: string; success?: string; warning?: string; danger?: string; info?: string;
    neutral?: string; background?: string; surface?: string; border?: string; text?: string;
    font_family?: string;
    heading_weight?: 'regular' | 'medium' | 'semibold' | 'bold';
    body_weight?: 'regular' | 'medium';
    type_scale?: number;
    density?: 'compact' | 'cozy' | 'comfortable';
    radius?: 'none' | 'small' | 'medium' | 'large' | 'full';
    elevation?: 'none' | 'small' | 'medium' | 'large';
    motion?: 'instant' | 'standard' | 'expressive';
    mode?: 'light' | 'dark' | 'auto';
    app_background?: string | null;
  };
  shell?: {
    sticky_header?: boolean; show_search?: boolean; show_logo?: boolean;
    content_width?: 'full_bleed' | 'constrained' | 'wide'; content_width_px?: number | null;
    page_padding?: 'compact' | 'cozy' | 'comfortable'; footer_enabled?: boolean;
    background?: 'light' | 'gray' | 'dark' | 'custom';
  };
  navigation?: {
    desktop_kind?: 'sidebar' | 'top_tabs' | 'compact_rail';
    mobile_kind?: 'bottom_nav' | 'drawer';
    sidebar_width?: number; default_collapsed?: boolean; show_icons?: boolean;
    show_labels?: boolean; active_style?: 'pill' | 'bar' | 'highlight'; breadcrumbs?: boolean;
  };
  feedback?: {
    loading?: 'skeleton' | 'spinner'; empty_style?: 'illustration' | 'message' | 'minimal';
    success?: 'toast' | 'inline' | 'banner'; confirmation?: 'modal' | 'drawer' | 'inline';
    error_retry?: boolean; motion_ms?: number;
  };
}

export interface MiniAppLayoutSpec {
  screens: ScreenSpec[];
  mini_app_nav: MiniAppNavSpec;
  branding?: BrandingSpec;
  /** Experience Studio presentation contract (v1). Additive + cosmetic. */
  experience?: ExperienceSpec;
  audit?: unknown;
  auto_number_columns?: AutoNumberConfigSpec[];
  /** Named workspaces (screen groups). Empty = flat nav (legacy). */
  screen_groups?: ScreenGroupSpec[];
  /** Reusable letterhead for doc print + Excel export. */
  print_template?: PrintTemplateSpec;
  [key: string]: unknown;
}

export const DEFAULT_LAYOUT: MiniAppLayoutSpec = {
  screens: [],
  mini_app_nav: { mobile_kind: 'bottom_nav', desktop_kind: 'sidebar', items: [] },
  branding: { primary_color: '#2563eb' },
  audit: {},
  auto_number_columns: [],
  screen_groups: [],
};

export function ensureLayout(raw: unknown): MiniAppLayoutSpec {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LAYOUT };
  const obj = raw as Record<string, unknown>;
  return {
    ...DEFAULT_LAYOUT,
    ...obj,
    screens: Array.isArray(obj.screens) ? (obj.screens as ScreenSpec[]) : [],
    mini_app_nav: (obj.mini_app_nav as MiniAppNavSpec) || DEFAULT_LAYOUT.mini_app_nav,
    branding: (obj.branding as BrandingSpec) || DEFAULT_LAYOUT.branding,
    auto_number_columns: Array.isArray(obj.auto_number_columns)
      ? (obj.auto_number_columns as AutoNumberConfigSpec[])
      : [],
    screen_groups: Array.isArray(obj.screen_groups)
      ? (obj.screen_groups as ScreenGroupSpec[])
      : [],
  };
}
