/**
 * Mini-app builder types — mirror the backend ``LayoutJson.screens[]``
 * shape so the builder edits exactly the JSON the runtime consumes.
 *
 * Kept loose (``unknown`` for free-form fields) so we don't have to
 * re-derive Pydantic types in TS — the canonical contract is defined in
 * ``backend/app/modules/workboards/schemas.py``.
 */

export type ScreenKind = 'form' | 'list' | 'doc' | 'dashboard';

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
    | 'lookup';
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
  } | null;
}

export interface FormScreenSpecBuilt {
  fields: FormFieldSpec[];
  submit_label?: string | null;
  after_submit?: ScreenAction | null;
  initial_values?: Record<string, unknown>;
}

export interface ListFilterSpec {
  column: string;
  kind: 'text' | 'select' | 'date_range' | 'number_range';
  label?: string | null;
}

export interface ListScreenSpecBuilt {
  columns: string[];
  filters?: ListFilterSpec[];
  page_size?: number;
  default_sort_column?: string | null;
  default_sort_direction?: 'asc' | 'desc';
  row_actions?: ScreenAction[];
  empty_state_message?: string | null;
}

export interface DocBlockSpec {
  type:
    | 'header'
    | 'kv_grid'
    | 'data_table'
    | 'text'
    | 'spacer'
    | 'signature'
    | 'footer';
  [key: string]: unknown;
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
  list?: ListScreenSpecBuilt | null;
  doc?: DocScreenSpecBuilt | null;
  dashboard?: DashboardScreenSpecBuilt | null;
  rls?: ScreenRlsRuleSpec[];
  rls_default?: ScreenRlsRuleSpec | null;
}

export interface MiniAppNavSpec {
  mobile_kind: 'bottom_nav' | 'drawer';
  desktop_kind: 'sidebar' | 'top_tabs';
  items: string[];
}

export interface BrandingSpec {
  app_name?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
  welcome_text?: string | null;
}

export interface MiniAppLayoutSpec {
  screens: ScreenSpec[];
  mini_app_nav: MiniAppNavSpec;
  branding?: BrandingSpec;
  audit?: unknown;
  [key: string]: unknown;
}

export const DEFAULT_LAYOUT: MiniAppLayoutSpec = {
  screens: [],
  mini_app_nav: { mobile_kind: 'bottom_nav', desktop_kind: 'sidebar', items: [] },
  branding: { primary_color: '#2563eb' },
  audit: {},
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
  };
}
