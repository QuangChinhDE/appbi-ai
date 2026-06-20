/**
 * Shared filter types and utilities for both Explore and Dashboard
 */

import type { ChartSemanticBinding } from '@/types/api';

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'like'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches_regex'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'between'
  | 'not_between'
  | 'is_null'
  | 'is_not_null'
  | 'date_eq'
  | 'date_between'
  | 'date_in_last'
  | 'date_this'
  | 'date_to_date'
  | 'top_n'
  | 'bottom_n';

export type FilterType = 'text' | 'number' | 'date' | 'dropdown';

// Phase-B (PBI-parity rework) — every dashboard filter-pane entry
// carries a `publicMode` flag that drives how the public-link viewer
// sees it. See docs/filter-semantics.md §2.2.
//   - 'visible' → viewer sees value in mini-pane, may override if
//                 `allowOverride === true`
//   - 'locked'  → value enforced; viewer sees read-only banner row
//                 when `showBanner !== false`
//   - 'hidden'  → value enforced; viewer is unaware the field exists
export type FilterPublicMode = 'visible' | 'locked' | 'hidden';

export type DatePreset =
  | 'custom'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'last_year'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days';

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  custom: 'Tùy chọn',
  today: 'Hôm nay',
  yesterday: 'Hôm qua',
  this_week: 'Tuần này',
  last_week: 'Tuần trước',
  this_month: 'Tháng này',
  last_month: 'Tháng trước',
  this_quarter: 'Quý này',
  last_quarter: 'Quý trước',
  this_year: 'Năm nay',
  last_year: 'Năm trước',
  last_7_days: '7 ngày qua',
  last_30_days: '30 ngày qua',
  last_90_days: '90 ngày qua',
};

/**
 * Base filter structure used by both Explore and Dashboard
 */
export interface BaseFilter {
  id: string;                // unique per filter (e.g. uuid)
  field: string;             // primary column name
  fieldKey?: string;         // stable key for semantic/qualified fields
  semanticField?: string;    // qualified field name (e.g. orders.country)
  datasetId?: number;        // semantic dataset scope when available
  linkedFields?: string[];   // additional column names this filter also applies to (cross-chart linking)
  type: FilterType;          // 'date' | 'dropdown' | 'text' | 'number'
  operator: FilterOperator;  // default depends on type
  value: any;                // string | number | [min,max] | array
  label?: string;            // optional user-friendly label
  datePreset?: DatePreset;   // for date filters: selected preset or 'custom'
  // Phase-B (PBI-parity rework) — public-link behavior. All fields
  // optional and default-backwards-compatible: an entry without
  // `publicMode` behaves as `visible` with no override.
  publicMode?: FilterPublicMode;
  allowOverride?: boolean;
  showBanner?: boolean;
  // Per-page slicer scope. 'all' (or absent for legacy) → dashboard.slicers_config,
  // applies to every page. 'page' → pages_config[i].slicers, applies only to its
  // own page. Only meaningful for slicer entries in the dashboard build editor.
  scope?: 'all' | 'page';
  // Phase-G — per-slicer card width in px (collapsed slicer card mode).
  // Author drags the card's right edge; persisted so the public link
  // shows the same width. Undefined → default card width.
  widthPx?: number;
  // Phase-14 — Looker-style interaction type the DA picked when creating
  // this filter (Dropdown / Fixed list / Input box / Advanced / Slider /
  // Checkbox / Date range). FilterCard renders the body UI from THIS
  // first, falling back to (operator + col.type) for legacy filters that
  // pre-date Phase-9.
  interactionType?:
    | 'dropdown'
    | 'fixed_list'
    | 'input'
    | 'advanced'
    | 'slider'
    | 'checkbox'
    | 'date_range';
}

/**
 * Dashboard filter extends BaseFilter with dataset context
 * Since dashboard can contain charts from different datasets,
 * we need to know which dataset each filter applies to
 */
export interface DashboardFilter extends BaseFilter {
  datasetId: number; // dataset this filter targets
}

// Phase-B (PBI-parity rework) — slicer entry is structurally identical
// to a DashboardFilter but lives in `Dashboard.slicers_config` and
// renders as a canvas block via SlicerBar instead of as a row in the
// Filter pane. Per spec §2.1 slicers are always visible to viewers
// (no `publicMode` toggle on them — visibility on a public link is
// controlled at the link-manager level instead).
export interface SlicerEntry extends DashboardFilter {
  /** Optional grid/canvas placement. When omitted, the FE auto-stacks
   *  the slicer inside the SlicerBar at the top of the canvas. */
  layout?: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    xPx?: number;
    yPx?: number;
    wPx?: number;
    hPx?: number;
    z?: number;
    pageId?: string;
  };
}

// Phase-G — image child of the slicer cluster (logos, icons,
// decoration). Lives in `slicers_config` alongside real slicer
// entries; the BE filter pipeline skips them via
// `normalize_filter_conditions` so they never reach the SQL builder.
export interface SlicerImageEntry {
  id: string;
  type: 'image';
  /** Image URL or base64 data: URI. */
  src: string;
  alt?: string;
  /** CSS object-fit value. Default 'contain'. */
  fit?: 'contain' | 'cover' | 'fill';
  /** Optional click target — opens in a new tab. Useful for logos. */
  link?: string;
  /** Display size in px; omit to fill the cluster cell. */
  widthPx?: number;
  heightPx?: number;
}

/** Union of children that can live inside `slicers_config` after Phase-G. */
export type SlicerClusterChild = SlicerEntry | SlicerImageEntry;

export function isSlicerImageEntry(child: any): child is SlicerImageEntry {
  return child != null && typeof child === 'object' && (child as any).type === 'image';
}

// Phase-G — cluster-level layout metadata. Stored on
// `Dashboard.slicer_cluster_layout`. Undefined/null → use the default
// auto-stacked top-bar layout (backward compat).
export interface SlicerClusterLayout {
  /** Where the cluster lives on the canvas.
   *   'top'  — stacked above the chart grid (default)
   *   'left' — vertical column to the left of the grid
   *   'free' — author dragged/resized; uses x/y/w/h or pixel coords */
  position?: 'top' | 'left' | 'free';
  /** 12-col grid coords (used when dashboard.layout_mode === 'grid'). */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Pixel coords (used when dashboard.layout_mode === 'canvas'). */
  xPx?: number;
  yPx?: number;
  wPx?: number;
  hPx?: number;
  z?: number;
  /** Direction children are laid out inside the cluster. */
  direction?: 'horizontal' | 'vertical' | 'grid';
  /** Pixel gap between children. */
  gap?: number;
  /** Background CSS color or 'transparent'. */
  background?: string;
  /** Border style. */
  border?: 'none' | 'dashed' | 'solid';
  /**
   * Phase-10 — child width strategy in horizontal/top mode.
   *   'manual' (default) — each filter keeps its drag-set `widthPx`
   *                        (legacy behavior; flow-wrap when total > container).
   *   'auto'             — distribute available width equally across all
   *                        slicers (flex-1); ignores per-card `widthPx`.
   *                        DA-friendly "Tự động giãn cách" toggle.
   */
  distribute?: 'manual' | 'auto';
}

// Phase-B (PBI-parity rework) — entry inside
// `DashboardPublicLink.filters_config`. Carries either a hard value
// override (locked, `hidden=false`) OR a "drop this field from the
// public viewer entirely" marker (`hidden=true`). The merge layer at
// BE treats the two cases differently — see filter-semantics.md §2.3
// and `filter_layered_merge.py`.
export interface PublicLinkFilterEntry {
  id?: string;
  field: string;
  fieldKey?: string;
  semanticField?: string;
  datasetId?: number;
  operator?: FilterOperator;
  value?: any;
  /** When true, the field is removed from the public viewer entirely.
   *  Cannot be overridden by viewer. */
  hidden?: boolean;
}

// ─── Phase-15.80: Typed Filter discriminated union ────────────────────────
//
// PowerBI-style: each filter has a `kind` discriminator that tells the UI
// what controls to render and tells the bridge how to project the filter
// into the legacy `BaseFilter` shape that the chart-data API still
// consumes. The legacy `BaseFilter` stays the canonical wire format —
// authoring & UI logic move to the union, execution layers don't change.
//
// Three kinds cover the PowerBI Filter Pane mainstream:
//   • categorical → text/dropdown column, multi-select OR single-select
//     OR explicit exclude
//   • numeric     → number column, between/eq/gt/...
//   • date        → date column, preset OR explicit range
//
// Per-tile Top-N is intentionally NOT modeled as a Filter here — it's a
// chart-shaping rule on the metric, not a row predicate, and ships
// through styleConfigOverride.dataLimit (Phase-15.78). Keeping the two
// layers separate avoids the "filter that has no real WHERE clause"
// foot-gun PowerBI itself has.

export type FilterKind = 'categorical' | 'numeric' | 'date';

interface FilterCommon {
  id: string;
  field: string;
  fieldKey?: string;
  semanticField?: string;
  datasetId?: number;
  linkedFields?: string[];
  label?: string;
}

export type CategoricalMode = 'multi' | 'single' | 'exclude';

export interface CategoricalFilter extends FilterCommon {
  kind: 'categorical';
  mode: CategoricalMode;
  /** Always an array regardless of mode. Length 0 = inactive.
   *  Length 1 with mode='single' = single value selected.
   *  Length >=1 with mode='multi'/'exclude' = N-way selection. */
  values: string[];
}

export type NumericMode = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';

export interface NumericFilter extends FilterCommon {
  kind: 'numeric';
  mode: NumericMode;
  /** For eq/neq/gt/gte/lt/lte. */
  value?: number | null;
  /** For between. min or max may be null to express "unbounded on this side". */
  range?: { min: number | null; max: number | null };
}

export interface DateFilter extends FilterCommon {
  kind: 'date';
  /** When preset === 'custom', `range` is used. Otherwise range is computed
   *  on the fly from the preset (see computeDatePresetRange). */
  preset: DatePreset;
  range?: { start: string | null; end: string | null };
}

export type Filter = CategoricalFilter | NumericFilter | DateFilter;

/** Type guards for the union. */
export function isCategorical(f: Filter): f is CategoricalFilter { return f.kind === 'categorical'; }
export function isNumeric(f: Filter): f is NumericFilter         { return f.kind === 'numeric'; }
export function isDate(f: Filter): f is DateFilter               { return f.kind === 'date'; }

/** Active = has data the engine can actually use. Empty selection / no
 *  bounds = inactive. Used for badge counts + skipping idle filters before
 *  the legacy bridge runs. */
export function isFilterActive(filter: Filter): boolean {
  switch (filter.kind) {
    case 'categorical':
      return filter.values.some((v) => v != null && String(v).trim() !== '');
    case 'numeric':
      if (filter.mode === 'between') {
        const lo = filter.range?.min;
        const hi = filter.range?.max;
        return (lo != null && !Number.isNaN(lo)) || (hi != null && !Number.isNaN(hi));
      }
      return filter.value != null && !Number.isNaN(filter.value);
    case 'date':
      if (filter.preset !== 'custom') return true;
      const s = filter.range?.start;
      const e = filter.range?.end;
      return Boolean((s && s.trim()) || (e && e.trim()));
  }
}

/** Project a typed filter onto the legacy `BaseFilter` shape that the
 *  chart-data API + applyFiltersToRows / serverFilters already consume.
 *  Returns null when the typed filter is inactive (engine should skip).
 *  When `allowInactive=true` is passed, an empty filter (e.g. a freshly
 *  added card whose value the user hasn't picked yet) is also projected
 *  — for editor UIs that need to show every authored slot, not just
 *  the executable ones. */
export function toBaseFilter(f: Filter, opts?: { allowInactive?: boolean }): BaseFilter | null {
  if (!isFilterActive(f) && !opts?.allowInactive) return null;
  const common = {
    id: f.id,
    field: f.field,
    fieldKey: f.fieldKey,
    semanticField: f.semanticField,
    datasetId: f.datasetId,
    linkedFields: f.linkedFields,
    label: f.label,
  };
  switch (f.kind) {
    case 'categorical': {
      const cleanValues = f.values.filter((v) => v != null && String(v).trim() !== '');
      if (f.mode === 'single') {
        return { ...common, type: 'dropdown', operator: 'eq', value: cleanValues[0] ?? '' };
      }
      if (f.mode === 'exclude') {
        return { ...common, type: 'dropdown', operator: 'not_in', value: cleanValues };
      }
      return { ...common, type: 'dropdown', operator: 'in', value: cleanValues };
    }
    case 'numeric': {
      if (f.mode === 'between') {
        const min = f.range?.min;
        const max = f.range?.max;
        return {
          ...common,
          type: 'number',
          operator: 'between',
          value: [
            min != null && !Number.isNaN(min) ? min : '',
            max != null && !Number.isNaN(max) ? max : '',
          ],
        };
      }
      return {
        ...common,
        type: 'number',
        operator: f.mode,
        value: f.value ?? '',
      };
    }
    case 'date': {
      if (f.preset !== 'custom') {
        const [start, end] = computeDatePresetRange(f.preset);
        return {
          ...common,
          type: 'date',
          operator: 'between',
          value: [start, end],
          datePreset: f.preset,
        };
      }
      return {
        ...common,
        type: 'date',
        operator: 'between',
        value: [f.range?.start ?? '', f.range?.end ?? ''],
        datePreset: 'custom',
      };
    }
  }
}

/** Inverse of `toBaseFilter` for hydrating typed state from a legacy
 *  `BaseFilter` (DB saved config, URL pre-Phase-15.80, etc.). Returns null
 *  for shapes we can't safely convert — caller drops with a warning. */
export function fromBaseFilter(b: BaseFilter): Filter | null {
  const common = {
    id: b.id,
    field: b.field,
    fieldKey: b.fieldKey,
    semanticField: b.semanticField,
    datasetId: b.datasetId,
    linkedFields: b.linkedFields,
    label: b.label,
  };
  if (b.type === 'date') {
    const preset: DatePreset = b.datePreset ?? 'custom';
    const [start, end] = Array.isArray(b.value) ? b.value : ['', ''];
    return {
      ...common,
      kind: 'date',
      preset,
      range: preset === 'custom'
        ? { start: start || null, end: end || null }
        : undefined,
    };
  }
  if (b.type === 'number') {
    if (b.operator === 'between') {
      const [lo, hi] = Array.isArray(b.value) ? b.value : [null, null];
      const parseNum = (v: any): number | null => {
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        ...common,
        kind: 'numeric',
        mode: 'between',
        range: { min: parseNum(lo), max: parseNum(hi) },
      };
    }
    const allowed = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
    const mode = allowed.has(b.operator as string) ? (b.operator as NumericMode) : 'eq';
    const n = b.value === '' || b.value == null ? null : Number(b.value);
    return {
      ...common,
      kind: 'numeric',
      mode,
      value: Number.isFinite(n as number) ? (n as number) : null,
    };
  }
  // text + dropdown → categorical
  if (b.operator === 'in') {
    return { ...common, kind: 'categorical', mode: 'multi', values: Array.isArray(b.value) ? b.value.map(String) : [] };
  }
  if (b.operator === 'not_in') {
    return { ...common, kind: 'categorical', mode: 'exclude', values: Array.isArray(b.value) ? b.value.map(String) : [] };
  }
  if (b.operator === 'eq' || b.operator === 'neq') {
    const v = b.value == null ? '' : String(b.value);
    return { ...common, kind: 'categorical', mode: b.operator === 'eq' ? 'single' : 'exclude', values: v === '' ? [] : [v] };
  }
  // contains/like/starts_with etc. — represent as a single-value
  // categorical for now (UI doesn't expose those operators yet). Legacy
  // configs that used them will be downgraded to multi-select.
  if (Array.isArray(b.value)) {
    return { ...common, kind: 'categorical', mode: 'multi', values: b.value.map(String) };
  }
  return null;
}

/**
 * Infer FilterType by sampling actual values in the data rows.
 * Returns 'date' | 'number' | 'text'.
 */
export function inferColumnTypeFromData(
  field: string,
  rows: Record<string, any>[]
): FilterType {
  // Sample up to 20 rows for more reliable type detection
  let seenNumber = false;
  let seenText = false;
  let seenDate = false;
  const limit = Math.min(rows.length, 20);

  for (let i = 0; i < limit; i++) {
    const val = rows[i][field];
    if (val === null || val === undefined) continue;

    if (val instanceof Date) { seenDate = true; continue; }
    if (typeof val === 'number') { seenNumber = true; continue; }
    if (typeof val === 'string') {
      // Match ISO dates (YYYY-MM-DD), ISO datetimes with T (YYYY-MM-DDTHH:MM:SS),
      // and common datetime strings with space separator (YYYY-MM-DD HH:MM:SS)
      if (/^\d{4}-\d{2}-\d{2}([ T]|$)/.test(val)) { seenDate = true; continue; }
      if (val.trim() !== '' && !isNaN(Number(val))) { seenNumber = true; }
      else { seenText = true; }
    }
  }

  // If any text (non-numeric, non-date) values seen, treat as text
  if (seenDate && !seenText && !seenNumber) return 'date';
  if (seenText) return 'text';
  if (seenNumber) return 'number';
  return 'text';
}

/**
 * Column name + inferred type, used by DashboardFilterBar
 */
export interface ColumnInfo {
  name: string;
  type: FilterType;
  key?: string;
  label?: string;
  tableLabel?: string;
  datasetId?: number;
  /** Friendly dataset name (e.g. "AppBI Tasks") for the column picker.
   *  Populated alongside datasetId when the column comes from a known
   *  semantic dataset; absent for legacy non-semantic columns. */
  datasetName?: string;
  semanticField?: string;
  defaultLinkedFields?: string[];
  chartCoverage?: number;
  datasetChartCount?: number;
  sharedAcrossDataset?: boolean;
}

export interface DashboardFilterableDimensionLike {
  name?: string;
  hidden?: boolean;
}

export interface DashboardFilterableViewLike {
  hidden_in_canvas?: boolean;
}

export interface DashboardFilterableJoinLike {
  origin?: string;
  from_view?: string;
  from_column?: string;
  from_columns?: string[];
  view?: string;
  to_column?: string;
  to_columns?: string[];
}

export interface DashboardFilterableExploreLike {
  base_view_name?: string;
  joins?: DashboardFilterableJoinLike[];
}

export interface DashboardFilterableModelLike {
  explores?: DashboardFilterableExploreLike[];
}

const UPPERCASE_FIELD_WORDS = new Set([
  'id',
  'ip',
  'sku',
  'api',
  'sql',
  'url',
  'ui',
  'ux',
  'utc',
]);

function titleCaseTechnicalWord(word: string): string {
  const trimmed = word.trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();
  if (UPPERCASE_FIELD_WORDS.has(lower)) {
    return lower.toUpperCase();
  }

  if (/^[A-Z0-9]{2,}$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function humanizeTechnicalFieldName(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!spaced) return '';

  return spaced
    .split(' ')
    .map(titleCaseTechnicalWord)
    .join(' ');
}

export function getFriendlyFieldLabel(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  const lastSegment = trimmed.split('.').pop()?.trim() ?? trimmed;
  if (!lastSegment) return '';

  if (
    /[_-]/.test(lastSegment)
    || /^[a-z0-9 ]+$/.test(lastSegment)
    || /[a-z0-9][A-Z]/.test(lastSegment)
    || !/\s/.test(lastSegment)
  ) {
    return humanizeTechnicalFieldName(lastSegment);
  }

  return lastSegment;
}

export function getColumnDisplayLabel(
  column: Pick<ColumnInfo, 'label' | 'name' | 'semanticField'>,
): string {
  return (
    getFriendlyFieldLabel(column.label)
    || getFriendlyFieldLabel(column.name)
    || getFriendlyFieldLabel(column.semanticField)
    || column.name
  );
}

export function getSemanticViewLabel(semanticField: string | null | undefined): string {
  const trimmed = String(semanticField ?? '').trim();
  if (!trimmed.includes('.')) return '';
  return getFriendlyFieldLabel(trimmed.split('.')[0]);
}

export function getColumnContextLabel(
  column: Pick<ColumnInfo, 'semanticField' | 'datasetId' | 'key' | 'name' | 'tableLabel'>,
): string {
  if (column.tableLabel) return getFriendlyFieldLabel(column.tableLabel);
  const viewLabel = getSemanticViewLabel(column.semanticField);
  if (viewLabel) return viewLabel;
  if (column.datasetId != null) return `Dataset ${column.datasetId}`;
  if (column.key && column.key !== column.name) return column.key;
  return '';
}

export function getColumnGroupLabel(
  column: Pick<ColumnInfo, 'semanticField' | 'datasetId' | 'tableLabel'>,
): string {
  if (column.tableLabel) return getFriendlyFieldLabel(column.tableLabel);
  const viewLabel = getSemanticViewLabel(column.semanticField);
  if (viewLabel) return viewLabel;
  if (column.datasetId != null) return `Dataset ${column.datasetId}`;
  return 'Columns';
}

export function getFilterDisplayLabel(
  filter: Pick<BaseFilter, 'label' | 'field' | 'semanticField'>,
): string {
  return (
    getFriendlyFieldLabel(filter.label)
    || getFriendlyFieldLabel(filter.field)
    || getFriendlyFieldLabel(filter.semanticField)
    || filter.field
  );
}

export function collectJoinKeySemanticFields(model: DashboardFilterableModelLike | null | undefined): Set<string> {
  const fields = new Set<string>();

  const normalizeColumns = (values?: string[] | null, fallback?: string) => {
    const source = values?.length ? values : (fallback ? [fallback] : []);
    return source
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  };

  for (const explore of model?.explores ?? []) {
    for (const join of explore.joins ?? []) {
      if (join?.origin === 'auto_calendar') continue;

      const fromView = String(join?.from_view || explore?.base_view_name || '').trim();
      const toView = String(join?.view || '').trim();
      const fromColumns = normalizeColumns(join?.from_columns, join?.from_column);
      const toColumns = normalizeColumns(join?.to_columns, join?.to_column);

      if (fromView) {
        for (const fromColumn of fromColumns) {
          fields.add(`${fromView}.${fromColumn}`);
        }
      }
      if (toView) {
        for (const toColumn of toColumns) {
          fields.add(`${toView}.${toColumn}`);
        }
      }
    }
  }

  return fields;
}

export function isSemanticDimensionFilterableForDashboard(options: {
  semanticField: string;
  view?: DashboardFilterableViewLike | null;
  dimension?: DashboardFilterableDimensionLike | null;
  joinKeyFields?: Set<string> | null;
}): boolean {
  const { semanticField, view, dimension, joinKeyFields } = options;
  if (!semanticField || !dimension || view?.hidden_in_canvas) {
    return false;
  }

  if (!dimension.hidden) {
    return true;
  }

  return Boolean(joinKeyFields?.has(semanticField));
}

export function getColumnKey(column: Pick<ColumnInfo, 'key' | 'semanticField' | 'name'>): string {
  return column.key ?? column.semanticField ?? column.name;
}

export function getFilterKey(filter: Pick<BaseFilter, 'fieldKey' | 'semanticField' | 'field'>): string {
  return filter.fieldKey ?? filter.semanticField ?? filter.field;
}

type ChartSemanticBindingLike = Pick<
  ChartSemanticBinding,
  | 'datasetId'
  | 'baseViewName'
  | 'fieldMap'
  | 'dimensionFields'
  | 'measureFields'
  | 'reachableViews'
  | 'reachableFields'
  | 'calendarFieldMappings'
>;

function semanticCandidates(filter: Pick<BaseFilter, 'fieldKey' | 'semanticField' | 'field'>): string[] {
  const candidates = [filter.semanticField, filter.fieldKey]
    .filter((value): value is string => Boolean(value && value.includes('.')));
  return Array.from(new Set(candidates));
}

export function resolveChartSemanticField(
  binding: ChartSemanticBindingLike | null | undefined,
  chartField: string,
): string | null {
  if (!binding) return null;

  const mapped = binding.fieldMap?.[chartField];
  if (mapped) return mapped;

  if (!chartField) return null;

  const availableSemanticFields = new Set([
    ...(binding.dimensionFields ?? []),
    ...(binding.measureFields ?? []),
  ]);

  // The clicked field may ALREADY be a fully-qualified semantic field
  // (`view.column`) — the norm when the chart's xField comes from a JOINED
  // view (snowflake), so it does NOT start with baseViewName. Prepending
  // baseViewName again would yield `base.view.column` and miss. Accept it
  // as-is when it's a known dimension/measure. Fixes click-to-select (both
  // cross-filter and cross-highlight) on charts grouped by a joined-view dim.
  if (availableSemanticFields.has(chartField)) return chartField;

  if (!binding.baseViewName) return null;

  const semanticField = `${binding.baseViewName}.${chartField}`;
  return availableSemanticFields.has(semanticField) ? semanticField : null;
}

export function resolveCalendarFieldMapping(
  binding: ChartSemanticBindingLike | null | undefined,
  semanticField: string | null | undefined,
) {
  if (!binding || !semanticField) return null;
  return (binding.calendarFieldMappings ?? []).find(
    (mapping) => mapping.semanticField === semanticField,
  ) ?? null;
}

export function canDeferFilterToChartSemanticBinding(
  filter: Pick<BaseFilter, 'field' | 'fieldKey' | 'semanticField' | 'datasetId'>,
  binding: ChartSemanticBindingLike | null | undefined,
): boolean {
  const candidates = semanticCandidates(filter);
  if (candidates.length === 0) {
    return false;
  }

  if (
    filter.datasetId != null
    && binding?.datasetId != null
    && filter.datasetId !== binding.datasetId
  ) {
    return false;
  }

  if (!binding) {
    return false;
  }

  const supportedSemanticFields = new Set<string>([
    ...(binding.dimensionFields ?? []),
    ...(binding.measureFields ?? []),
    ...(binding.reachableFields ?? []),
    ...Object.values(binding.fieldMap ?? {}).filter(
      (value): value is string => typeof value === 'string' && value.includes('.'),
    ),
    ...(binding.calendarFieldMappings ?? [])
      .map((mapping) => mapping?.semanticField)
      .filter((value): value is string => typeof value === 'string' && value.includes('.')),
  ]);

  const reachableViews = new Set(binding.reachableViews ?? []);
  return candidates.some((candidate) => {
    if (supportedSemanticFields.has(candidate)) return true;
    const viewName = candidate.split('.')[0];
    return Boolean(viewName && reachableViews.has(viewName));
  });
}

export function resolveChartFieldForFilter(
  filter: Pick<BaseFilter, 'field' | 'fieldKey' | 'semanticField' | 'datasetId'>,
  binding: ChartSemanticBindingLike | null | undefined,
): string | null {
  if (
    filter.datasetId != null &&
    binding?.datasetId != null &&
    filter.datasetId !== binding.datasetId
  ) {
    return null;
  }

  if (!binding) {
    return filter.field;
  }

  const availableSemanticFields = new Set([
    ...(binding.dimensionFields ?? []),
    ...(binding.measureFields ?? []),
  ]);

  for (const semanticField of semanticCandidates(filter)) {
    const calendarMapping = resolveCalendarFieldMapping(binding, semanticField);
    if (calendarMapping?.sourceField) {
      return calendarMapping.sourceField;
    }

    const mappedField = Object.entries(binding.fieldMap ?? {}).find(
      ([, value]) => value === semanticField,
    )?.[0];
    if (mappedField) return mappedField;

    if (availableSemanticFields.has(semanticField) && binding.baseViewName) {
      const prefix = `${binding.baseViewName}.`;
      if (semanticField.startsWith(prefix)) {
        return semanticField.slice(prefix.length);
      }
    }
  }

  if (binding.fieldMap && filter.field in binding.fieldMap) {
    return filter.field;
  }

  return null;
}

export function resolveFilterForChartData(
  filter: BaseFilter,
  options: {
    binding?: ChartSemanticBindingLike | null;
    availableFields?: Iterable<string> | null;
  } = {},
): BaseFilter | null {
  const { binding = null, availableFields = null } = options;
  const availableFieldSet = availableFields ? new Set(availableFields) : null;
  const resolvedField = resolveChartFieldForFilter(filter, binding);

  if (resolvedField && (!availableFieldSet || availableFieldSet.has(resolvedField))) {
    return resolvedField === filter.field ? filter : { ...filter, field: resolvedField };
  }

  if (semanticCandidates(filter).length > 0) {
    return null;
  }

  const candidates = [filter.field, ...(filter.linkedFields ?? [])];
  const fallback = availableFieldSet
    ? candidates.find((candidate) => availableFieldSet.has(candidate))
    : candidates[0];

  if (!fallback) return null;
  return fallback === filter.field ? filter : { ...filter, field: fallback };
}

/**
 * Helper to detect filter type from column type
 */
export function getFilterTypeForColumn(columnType: string): FilterType {
  const dateTypes = ['date', 'datetime', 'timestamp', 'DATE', 'DATETIME', 'TIMESTAMP'];
  const numberTypes = [
    'number', 'integer', 'float', 'double', 'numeric', 
    'FLOAT', 'INTEGER', 'NUMERIC', 'DOUBLE', 'BIGINT', 
    'int', 'INT', 'DECIMAL', 'decimal'
  ];

  const type = columnType.toLowerCase();
  
  if (dateTypes.some(t => type.includes(t.toLowerCase()))) return 'date';
  if (numberTypes.some(t => type.includes(t.toLowerCase()))) return 'number';
  
  return 'dropdown'; // default to dropdown for strings and others
}

/**
 * Get distinct values from data for a field
 */
export function getDistinctValues(field: string, rows: Record<string, any>[]): string[] {
  const set = new Set<string>();
  rows.forEach(row => {
    const val = row[field];
    if (val !== null && val !== undefined) {
      set.add(String(val));
    }
  });
  return Array.from(set).sort();
}

/**
 * Apply filters to rows (client-side v1)
 * Works with both BaseFilter and DashboardFilter (ignores datasetId)
 */
export function applyFiltersToRows(
  rows: Record<string, any>[],
  filters: BaseFilter[]
): Record<string, any>[] {
  if (!filters.length) return rows;

  return rows.filter(row =>
    filters.every(f => {
      if (!isFilterValueActive(f)) return true;
      const val = row[f.field];

      if (f.operator === 'is_null') return val === null || val === undefined;
      if (f.operator === 'is_not_null') return val !== null && val !== undefined;

      // handle null/undefined
      if (val === null || val === undefined) return false;

      // Handle multi-value operators first (type-agnostic)
      // Normalize both sides to strings so numeric/string mismatches don't cause false negatives
      if (f.operator === 'in') {
        const selected = Array.isArray(f.value) ? f.value : [];
        if (!selected.length) return true; // empty selection = no filter
        const strVal = String(val);
        return selected.some(s => String(s) === strVal);
      }
      if (f.operator === 'not_in') {
        const excluded = Array.isArray(f.value) ? f.value : [];
        if (!excluded.length) return true;
        const strVal = String(val);
        return !excluded.some(s => String(s) === strVal);
      }

      switch (f.type) {
        case 'date': {
          // Normalise both sides to comparable YYYY-MM-DD strings
          const strVal = String(val).slice(0, 10);
          const filterVal = String(f.value ?? '').slice(0, 10);
          switch (f.operator) {
            case 'eq':  return strVal === filterVal;
            case 'neq': return strVal !== filterVal;
            case 'gt':  return strVal > filterVal;
            case 'gte': return strVal >= filterVal;
            case 'lt':  return strVal < filterVal;
            case 'lte': return strVal <= filterVal;
            case 'between': {
              const [start, end] = Array.isArray(f.value) ? f.value : [];
              if (start && strVal < String(start).slice(0, 10)) return false;
              if (end   && strVal > String(end).slice(0, 10))   return false;
              return true;
            }
            default: return true;
          }
        }
        
        case 'dropdown': {
          // Phase-15.79 — `in`/`not_in` already handled above (the multi-select
          // path). Single-select dropdown filters (Phase-15.78 toggle) arrive
          // here with operator `eq`/`neq` and a *scalar* value, not an array.
          // Old code did `(f.value ?? []).length` which on a string crashed
          // at `.some(...)` (TypeError: not a function). Route scalar ops to
          // the same string comparison the `text` branch does.
          const strVal = String(val);
          if (Array.isArray(f.value)) {
            if (f.value.length === 0) return true;
            const inList = f.value.some(s => String(s) === strVal);
            return f.operator === 'neq' ? !inList : inList;
          }
          const filterVal = String(f.value ?? '');
          if (filterVal === '') return true;
          switch (f.operator) {
            case 'eq': return strVal === filterVal;
            case 'neq': return strVal !== filterVal;
            case 'contains': return strVal.toLowerCase().includes(filterVal.toLowerCase());
            case 'not_contains': return !strVal.toLowerCase().includes(filterVal.toLowerCase());
            case 'starts_with': return strVal.toLowerCase().startsWith(filterVal.toLowerCase());
            default: return true;
          }
        }
        
        case 'number': {
          const numVal = Number(val);
          if (isNaN(numVal)) return false;
          
          if (f.operator === 'between') {
            const [min, max] = f.value ?? [];
            // Phase-15.79 — old code treated `''` as a present bound and ran
            // `Number('') = 0` which silently rejected every value > 0 when
            // the user typed only one bound. Range slider (Phase-15.78) made
            // single-bound state common because dragging one thumb leaves
            // the other end empty. Treat empty string + null + undefined
            // identically as "unbounded".
            const hasMin = min !== null && min !== undefined && min !== '';
            const hasMax = max !== null && max !== undefined && max !== '';
            if (hasMin && numVal < Number(min)) return false;
            if (hasMax && numVal > Number(max)) return false;
            return true;
          }
          
          const filterVal = Number(f.value);
          if (isNaN(filterVal)) return true;
          
          switch (f.operator) {
            case 'eq': return numVal === filterVal;
            case 'neq': return numVal !== filterVal;
            case 'gt': return numVal > filterVal;
            case 'gte': return numVal >= filterVal;
            case 'lt': return numVal < filterVal;
            case 'lte': return numVal <= filterVal;
            default: return true;
          }
        }
        
        case 'text': {
          const strVal = String(val);
          const filterVal = String(f.value ?? '');
          
          switch (f.operator) {
            case 'eq': return strVal === filterVal;
            case 'neq': return strVal !== filterVal;
            case 'like':
            case 'contains': return strVal.toLowerCase().includes(filterVal.toLowerCase());
            case 'not_contains': return !strVal.toLowerCase().includes(filterVal.toLowerCase());
            case 'starts_with': return strVal.toLowerCase().startsWith(filterVal.toLowerCase());
            default: return true;
          }
        }
        
        default:
          return true;
      }
    })
  );
}

function hasPresentFilterAtom(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasPresentFilterAtom);
  return true;
}

export function isFilterValueActive(filter: Pick<BaseFilter, 'operator' | 'value'>): boolean {
  const operator = filter.operator;
  if (operator === 'is_null' || operator === 'is_not_null') return true;
  if (operator === 'in' || operator === 'not_in') {
    return Array.isArray(filter.value) && filter.value.some(hasPresentFilterAtom);
  }
  if (operator === 'between') {
    const [start, end] = Array.isArray(filter.value) ? filter.value : [];
    return hasPresentFilterAtom(start) || hasPresentFilterAtom(end);
  }
  return hasPresentFilterAtom(filter.value);
}

export function getDistinctValueFilterContext(
  filters: BaseFilter[],
  targetColumn: Pick<ColumnInfo, 'key' | 'semanticField' | 'name' | 'datasetId'>,
): BaseFilter[] {
  const targetKey = getColumnKey(targetColumn);
  return filters.filter((filter) => {
    if (!isFilterValueActive(filter)) return false;
    if (filter.datasetId != null && targetColumn.datasetId != null && filter.datasetId !== targetColumn.datasetId) {
      return false;
    }
    if (getFilterKey(filter) === targetKey) return false;
    if ((filter.linkedFields ?? []).includes(targetKey)) return false;
    return true;
  });
}

/**
 * Page/dashboard SCOPE filters are a HARD BOUND on viewer slicers that target
 * the SAME field: a viewer may only narrow WITHIN the scope, never escape it.
 *
 * Why this exists: the previous assembly DROPPED the page-scope filter whenever
 * an active same-field slicer was present ("viewer's choice wins"). That let a
 * viewer pick a value OUTSIDE the author's page scope (e.g. page scoped to
 * [Laptop,Charger,Headphones], viewer picks "Tablet") and see data the page was
 * meant to exclude (10M instead of the 303K page total) — a scope-escape /
 * over-exposure bug, especially on public links. The dedup-keep-one model
 * fundamentally cannot AND two same-field filters, so we intersect here.
 *
 * `selections` = viewer slicer/cross-filter choices (overridable).
 * `scopes`     = author page/dashboard scope filters (always-applied, hidden
 *                from the viewer's controls). Returns the filter list to send to
 *                the chart-data endpoint.
 *
 * Rule per field X that has a scope:
 *   - no active same-field selection → scope applies unchanged.
 *   - active `in` selection + `in` scope → emit ONE filter = scope ∩ selection.
 *       empty intersection → fall back to the scope (ignore the out-of-scope
 *       pick; never escape, never show "all").
 *   - any other operator combo → keep the scope (the hard bound wins).
 */
export function applyScopeBound(
  selections: BaseFilter[],
  scopes: BaseFilter[],
): BaseFilter[] {
  const keyOf = (f: BaseFilter) =>
    String(f.fieldKey ?? f.semanticField ?? f.field ?? '').trim().toLowerCase();
  const activeSelByKey = new Map<string, BaseFilter>();
  for (const s of selections) {
    if (isFilterValueActive(s)) activeSelByKey.set(keyOf(s), s);
  }
  const out: BaseFilter[] = [];
  const foldedKeys = new Set<string>();
  for (const scope of scopes) {
    const k = keyOf(scope);
    const sel = activeSelByKey.get(k);
    if (!sel) { out.push(scope); continue; }
    foldedKeys.add(k);
    const toList = (v: any): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)) : (v != null && String(v) !== '' ? [String(v)] : []);
    if (sel.operator === 'in' && scope.operator === 'in') {
      const sv = toList(sel.value);
      const pv = toList(scope.value);
      const inter = sv.filter((x) => pv.includes(x));
      out.push({ ...scope, value: inter.length ? inter : scope.value });
    } else {
      // hard bound wins for non-list operators (rare for slicers)
      out.push(scope);
    }
  }
  for (const s of selections) {
    if (foldedKeys.has(keyOf(s))) continue;
    out.push(s);
  }
  return out;
}

/**
 * Get default operator for a filter type
 */
export function getDefaultOperator(type: FilterType): FilterOperator {
  switch (type) {
    case 'date': return 'between';
    case 'dropdown': return 'in';
    case 'number': return 'eq';
    case 'text': return 'contains';
    default: return 'eq';
  }
}

/**
 * Compute [startDate, endDate] range for a date preset (YYYY-MM-DD strings).
 * Returns ['', ''] for 'custom'.
 */
export function computeDatePresetRange(preset: DatePreset): [string, string] {
  const now = new Date();
  const fmt = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const today = fmt(now);

  switch (preset) {
    case 'today':
      return [today, today];
    case 'yesterday': {
      const d = new Date(now); d.setDate(d.getDate() - 1);
      const s = fmt(d);
      return [s, s];
    }
    case 'this_week': {
      const d = new Date(now);
      const day = d.getDay();
      const diffToMonday = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diffToMonday);
      const end = new Date(d); end.setDate(end.getDate() + 6);
      return [fmt(d), fmt(end)];
    }
    case 'last_week': {
      const d = new Date(now);
      const day = d.getDay();
      const diffToMonday = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diffToMonday - 7);
      const end = new Date(d); end.setDate(end.getDate() + 6);
      return [fmt(d), fmt(end)];
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return [fmt(start), fmt(end)];
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return [fmt(start), fmt(end)];
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      const start = new Date(now.getFullYear(), q * 3, 1);
      const end = new Date(now.getFullYear(), q * 3 + 3, 0);
      return [fmt(start), fmt(end)];
    }
    case 'last_quarter': {
      const q = Math.floor(now.getMonth() / 3) - 1;
      const y = q < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const qn = ((q % 4) + 4) % 4;
      const start = new Date(y, qn * 3, 1);
      const end = new Date(y, qn * 3 + 3, 0);
      return [fmt(start), fmt(end)];
    }
    case 'this_year': {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31);
      return [fmt(start), fmt(end)];
    }
    case 'last_year': {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31);
      return [fmt(start), fmt(end)];
    }
    case 'last_7_days': {
      const d = new Date(now); d.setDate(d.getDate() - 6);
      return [fmt(d), today];
    }
    case 'last_30_days': {
      const d = new Date(now); d.setDate(d.getDate() - 29);
      return [fmt(d), today];
    }
    case 'last_90_days': {
      const d = new Date(now); d.setDate(d.getDate() - 89);
      return [fmt(d), today];
    }
    case 'custom':
    default:
      return ['', ''];
  }
}
