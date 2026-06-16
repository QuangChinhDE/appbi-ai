'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Plus, X, Filter, ChevronDown, ChevronRight, Search, Link2, Check, RotateCcw,
  Calendar, Pencil, ToggleLeft, ToggleRight,
  // Phase-9 — icons for the Looker-style interaction-type picker.
  List, ListChecks, TextCursor, SlidersHorizontal, CheckSquare, Settings2,
  ArrowLeft,
} from 'lucide-react';
import {
  BaseFilter,
  FilterOperator,
  FilterType,
  DatePreset,
  DATE_PRESET_LABELS,
  computeDatePresetRange,
  ColumnInfo,
  getColumnContextLabel,
  getColumnDisplayLabel,
  getColumnGroupLabel,
  getColumnKey,
  getFilterDisplayLabel,
  getFilterKey,
  isFilterValueActive,
} from '@/lib/filters';
import { DateInput } from '@/components/ui/DateInput';

// ─── Type badge helpers ────────────────────────────────────────
const TYPE_BADGE: Record<FilterType, string> = { text: 'T', number: '#', date: 'D', dropdown: '=' };
const TYPE_CLR: Record<FilterType, string> = {
  text:     'text-sky-500',
  number:   'text-brand',
  date:     'text-teal-500',
  dropdown: 'text-text-tertiary',
};
// Pill-style badge (replaces cramped monospace single-char). Used in card
// headers + linked-field rows. Dropdown rows keep the compact char.
const TYPE_PILL: Record<FilterType, string> = {
  text:     'bg-sky-50 text-sky-600 ring-1 ring-sky-100',
  number:   'bg-brand-soft text-brand ring-1 ring-brand/15',
  date:     'bg-teal-50 text-teal-600 ring-1 ring-teal-100',
  dropdown: 'bg-surface-2 text-text-tertiary ring-1 ring-[rgb(var(--border-line))]',
};
const TYPE_LABEL: Record<FilterType, string> = {
  text:     'Text',
  number:   'Num',
  date:     'Date',
  dropdown: 'List',
};

// ─── Phase-9: Looker-style "Add Filter" — pick interaction type first ───
//
// Replaces the legacy "pick column → auto-infer operator from column.type"
// flow with Looker's two-step picker: user explicitly chooses HOW they want
// the filter to behave (Dropdown / Slider / Date range / …) and then we
// only show columns the chosen interaction is compatible with. The
// resulting BaseFilter carries an explicit `operator` + `value` shape that
// no longer needs to be re-derived from column metadata.
type SlicerInteractionType =
  | 'dropdown'      // List, multi-select  — operator='in',       columns: text/dropdown
  | 'fixed_list'    // List with fixed UI  — operator='in',       columns: text/dropdown (renders inline, not collapsed)
  | 'input'         // Free-form text      — operator='contains', columns: text
  | 'advanced'      // Power-user picker   — operator chosen later; any column
  | 'slider'        // Numeric range       — operator='between',  columns: number
  | 'checkbox'      // Yes/No toggle       — operator='eq',       columns: number/text representing booleans
  | 'date_range';   // Date range          — operator='between',  columns: date

interface SlicerInteractionMeta {
  id: SlicerInteractionType;
  label: string;          // Vietnamese label per the user's screenshot
  description: string;    // 1-line hint shown under the label
  icon: React.ComponentType<{ className?: string }>;
  compatibleColumnTypes: FilterType[];
  defaultOperator: FilterOperator;
}

const SLICER_INTERACTIONS: readonly SlicerInteractionMeta[] = [
  {
    id: 'dropdown',
    label: 'Dropdown',
    description: 'Multi-select dropdown — most common',
    icon: ChevronDown,
    compatibleColumnTypes: ['dropdown', 'text'],
    defaultOperator: 'in',
  },
  {
    id: 'fixed_list',
    label: 'Fixed-size list',
    description: 'Always-expanded checklist (no collapse)',
    icon: List,
    compatibleColumnTypes: ['dropdown', 'text'],
    defaultOperator: 'in',
  },
  {
    id: 'input',
    label: 'Input box',
    description: 'Free-form text (contains, starts with…)',
    icon: TextCursor,
    // AppBI's `semanticDimensionToFilterType` maps string columns to
    // 'dropdown' by default (only legacy non-semantic text columns end up
    // as 'text'). So `input` must cover both so DAs can pick free-text
    // search on a plain string field.
    compatibleColumnTypes: ['text', 'dropdown'],
    defaultOperator: 'contains',
  },
  {
    id: 'advanced',
    label: 'Advanced filter',
    description: 'Pick the operator (eq / ne / gt / lt / …)',
    icon: Settings2,
    compatibleColumnTypes: ['text', 'dropdown', 'number', 'date'],
    defaultOperator: 'eq',
  },
  {
    id: 'slider',
    label: 'Slider',
    description: 'Range slider for numeric values',
    icon: SlidersHorizontal,
    compatibleColumnTypes: ['number'],
    defaultOperator: 'between',
  },
  {
    id: 'checkbox',
    label: 'Checkbox',
    description: 'On / Off (yes/no, 0/1)',
    icon: CheckSquare,
    compatibleColumnTypes: ['number', 'text', 'dropdown'],
    defaultOperator: 'eq',
  },
  {
    id: 'date_range',
    label: 'Date range',
    description: 'Date range + preset (this month, last week…)',
    icon: Calendar,
    compatibleColumnTypes: ['date'],
    defaultOperator: 'between',
  },
];

interface DashboardFilterBarProps {
  columns: ColumnInfo[];
  columnChartCount: Map<string, number>;
  /** Distinct values per column, keyed by stable column key */
  distinctValues: Record<string, string[]>;
  /**
   * Phase-7.6 — per-column distinct query status. Lets the FilterCard
   * tell apart "still fetching" from "fetched and the cascade returned
   * []". Without this, an empty `values` list always displays as
   * "Loading values..." even after the query has resolved, which DAs
   * mistake for a hang (especially when a cross-list filter — page filter
   * on a view with no join path back to this slicer — legitimately
   * produces 0 cascade rows).
   */
  distinctStatus?: Record<string, {
    isLoading: boolean;
    isError: boolean;
    hasFilterContext: boolean;
  }>;
  filters: BaseFilter[];
  onFiltersChange: (filters: BaseFilter[]) => void;
  hasPendingChanges?: boolean;
  onApply?: () => void;
  onReset?: () => void;
  isApplying?: boolean;
  initialExpanded?: boolean;
  /** When true, strips the outer card wrapper — use when embedded inside another card. */
  embedded?: boolean;
  /** Slicer mode (Looker/PowerBI parity): DA defines the slot inventory, viewer
   * can only change values within those slots. Hides Add Filter / per-card Remove
   * / Clear-all controls. Used on public-link viewer page. */
  lockSlots?: boolean;
  /** Phase-G — force filter cards into a single full-width column.
   * Used by the slicer cluster's 'left'/vertical layout where the
   * responsive viewport-based grid would otherwise crush cards into a
   * narrow column. */
  stackVertical?: boolean;
  /** Phase-G — render each filter as a collapsed button that opens its
   * value controls in a floating popover (overlay) instead of an
   * always-expanded inline card. Used by the slicer cluster (editor +
   * public). */
  collapsedSlicers?: boolean;
  /** Phase-10 — when true, slicer cards ignore their manual `widthPx` and
   * share the available row width equally via `flex-1`. Used by the slicer
   * cluster's "Tự động giãn cách" toggle. Only applies in collapsedSlicers
   * + horizontal (top) layout; vertical/left and the legacy filter bar
   * keep their existing behavior. */
  distributeChildren?: boolean;
}

type AddFilterColumnGroup = {
  key: string;
  label: string;
  columns: ColumnInfo[];
};

type AddFilterDatasetGroup = {
  datasetKey: string;
  datasetLabel: string;
  tables: AddFilterColumnGroup[];
};

export function DashboardFilterBar({
  columns,
  columnChartCount,
  distinctValues,
  distinctStatus,
  filters,
  onFiltersChange,
  hasPendingChanges = false,
  onApply,
  onReset,
  isApplying = false,
  initialExpanded = true,
  embedded = false,
  lockSlots = false,
  stackVertical = false,
  collapsedSlicers = false,
  distributeChildren = false,
  headerExtras,
}: DashboardFilterBarPropsWithExtras) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [addingField, setAddingField] = useState(false);
  const [addFilterSearch, setAddFilterSearch] = useState('');
  // Phase-9 — Looker-style two-step picker. Step 1: choose interaction type.
  // Step 2: choose a column compatible with that type. `pickedType=null`
  // means the panel is still showing the type list; non-null means we've
  // moved on to the column list.
  const [pickedType, setPickedType] = useState<SlicerInteractionType | null>(null);
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({});
  const addFilterSearchRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);

  // Compute fixed position when dropdown opens so it escapes overflow-hidden parents
  useEffect(() => {
    if (addingField && addButtonRef.current) {
      const rect = addButtonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [addingField]);

  // Auto-focus search input whenever the dropdown opens
  useEffect(() => {
    if (addingField) {
      // Short timeout so the DOM element is mounted before we focus
      const t = setTimeout(() => addFilterSearchRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [addingField]);

  // How many filters have a non-empty value?
  const activeCount = filters.filter(isFilterValueActive).length;

  // Set of all fields currently used by filters (primary only)
  const usedFields = useMemo(
    () => new Set(filters.map(f => getFilterKey(f))),
    [filters],
  );

  // Columns not yet added as filters
  const availableColumns = useMemo(
    () => columns.filter(c => !usedFields.has(getColumnKey(c))),
    [columns, usedFields],
  );

  const normalizedAddFilterSearch = addFilterSearch.trim().toLowerCase();

  // A column is offerable as a dashboard filter when at least one chart in
  // the dashboard can apply it. Charts that don't reach the field are simply
  // skipped at query time. Date columns are always offered (legacy auto-link
  // behavior for non-semantic date fields still applies).
  const addableColumns = useMemo(
    () => availableColumns.filter((column) =>
      column.type === 'date' || (column.chartCoverage ?? 0) > 0,
    ),
    [availableColumns],
  );

  // Phase-9 — when a type has been picked, narrow the column list to the
  // types compatible with that interaction (slider → numbers only, date_range
  // → dates only, …). When pickedType is null we're still on the type-picker
  // screen; the column list isn't shown at all in that case.
  const compatibleColumns = useMemo(() => {
    if (!pickedType) return addableColumns;
    const meta = SLICER_INTERACTIONS.find((m) => m.id === pickedType);
    if (!meta) return addableColumns;
    return addableColumns.filter((c) => meta.compatibleColumnTypes.includes(c.type));
  }, [addableColumns, pickedType]);

  const matchingAvailableColumns = useMemo(
    () => compatibleColumns.filter((column) => {
      if (!normalizedAddFilterSearch) return true;
      // Phase-15.81 v8 — match dataset name too so users can jump to a
      // specific dataset's columns when two datasets share field names.
      const haystack = [
        getColumnDisplayLabel(column),
        getColumnGroupLabel(column),
        column.name,
        column.semanticField,
        column.datasetName,
      ]
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedAddFilterSearch);
    }),
    [compatibleColumns, normalizedAddFilterSearch],
  );

  // Phase-15.81 v8 — hierarchical Dataset › Table grouping in the
  // Add-Filter dropdown so users always know which dataset a column
  // belongs to (e.g. two tables both expose `status`, viewer picks the
  // right one). Insertion order preserved from the source column list.
  const groupColumnsByDataset = (sourceColumns: ColumnInfo[]): AddFilterDatasetGroup[] => {
    const datasets = new Map<string, AddFilterDatasetGroup>();
    for (const column of sourceColumns) {
      const datasetLabel = column.datasetName
        ?? (column.datasetId != null ? `Dataset ${column.datasetId}` : 'Unscoped');
      const datasetKey = column.datasetId != null
        ? `id:${column.datasetId}`
        : `name:${datasetLabel}`;
      const semanticView = String(column.semanticField ?? '').split('.')[0]?.trim();
      const tableLabel = getColumnGroupLabel(column);
      const tableKey = `${datasetKey}:${semanticView || tableLabel}`;

      let dataset = datasets.get(datasetKey);
      if (!dataset) {
        dataset = { datasetKey, datasetLabel, tables: [] };
        datasets.set(datasetKey, dataset);
      }
      let table = dataset.tables.find((t) => t.key === tableKey);
      if (!table) {
        table = { key: tableKey, label: tableLabel, columns: [] };
        dataset.tables.push(table);
      }
      table.columns.push(column);
    }
    return Array.from(datasets.values());
  };

  // ── Mutators ───────────────────────────────────────────────────
  // Phase-9 — operator + initial value come from the chosen interaction
  // type. The old branching on column.type stays as a SAFE FALLBACK for
  // call sites that don't yet supply an interaction (legacy / programmatic).
  const addFilter = (
    columnKey: string,
    preset?: DatePreset,
    interaction?: SlicerInteractionType,
  ) => {
    const col = columns.find(c => getColumnKey(c) === columnKey);
    if (!col) return;
    if (usedFields.has(columnKey)) return;

    let linkedFields = col.defaultLinkedFields ? [...col.defaultLinkedFields] : undefined;

    // Auto-link legacy non-semantic date columns when no explicit linked targets are provided.
    if (!linkedFields?.length && col.type === 'date' && !col.semanticField) {
      linkedFields = columns
        .filter(c => c.type === 'date' && getColumnKey(c) !== columnKey && !usedFields.has(getColumnKey(c)))
        .map(c => getColumnKey(c));
      if (!linkedFields.length) linkedFields = undefined;
    }

    // Resolve operator + initial value from the chosen interaction. When no
    // interaction is supplied (legacy callers), keep the previous
    // column-type-driven defaults so the shape stays identical for them.
    let operator: FilterOperator;
    let value: any;
    let datePreset: DatePreset | undefined;
    if (interaction === 'dropdown' || interaction === 'fixed_list') {
      operator = 'in';
      value = [];
    } else if (interaction === 'input') {
      operator = 'contains';
      value = '';
    } else if (interaction === 'slider') {
      operator = 'between';
      value = ['', ''];
    } else if (interaction === 'checkbox') {
      operator = 'eq';
      value = '';
    } else if (interaction === 'date_range') {
      operator = 'between';
      datePreset = preset ?? 'this_month';
      value = datePreset !== 'custom' ? computeDatePresetRange(datePreset) : ['', ''];
    } else if (interaction === 'advanced') {
      // Pick a sensible default per column type; user can switch operator after.
      if (col.type === 'date') {
        operator = 'between';
        datePreset = preset ?? 'this_month';
        value = datePreset !== 'custom' ? computeDatePresetRange(datePreset) : ['', ''];
      } else if (col.type === 'number') {
        operator = 'eq';
        value = '';
      } else {
        operator = 'in';
        value = [];
      }
    } else {
      // Legacy fallback — unchanged from pre-Phase-9 inference.
      const isMultiSelect = col.type === 'text' || col.type === 'dropdown';
      datePreset = col.type === 'date' ? (preset ?? 'this_month') : undefined;
      const dateValue = datePreset && datePreset !== 'custom'
        ? computeDatePresetRange(datePreset)
        : ['', ''];
      operator = isMultiSelect ? 'in' : col.type === 'date' ? 'between' : 'gte';
      value = isMultiSelect ? [] : col.type === 'date' ? dateValue : '';
    }

    const newFilter: BaseFilter = {
      id:           `gf-${Date.now()}`,
      field:        col.name,
      fieldKey:     columnKey,
      semanticField: col.semanticField,
      datasetId:    col.datasetId,
      linkedFields,
      type:         col.type,
      operator,
      value,
      label:        getColumnDisplayLabel(col),
      datePreset,
      // Phase-14 — persist the picked interaction so the card body
      // dispatches to the right UI (input box / slider / checkbox / …)
      // rather than re-inferring from col.type.
      interactionType: interaction,
    };
    onFiltersChange([...filters, newFilter]);
    setAddingField(false);
    setAddFilterSearch('');
    setPickedType(null);
    setIsExpanded(true);
  };

  const removeFilter = (id: string) => {
    onFiltersChange(filters.filter(f => f.id !== id));
    setSearchTerms(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const clearFilter = (id: string) => {
    onFiltersChange(filters.map(f => {
      if (f.id !== id) return f;
      if (f.operator === 'in' || f.operator === 'not_in') return { ...f, value: [] };
      if (f.operator === 'between') return { ...f, value: ['', ''] };
      return { ...f, value: '' };
    }));
  };

  const toggleValue = (filterId: string, val: string) => {
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const cur: string[] = Array.isArray(f.value) ? f.value : [];
      return { ...f, value: cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val] };
    }));
  };

  const selectAll = (filterId: string, vals: string[]) =>
    onFiltersChange(filters.map(f => f.id === filterId ? { ...f, value: [...vals] } : f));

  const deselectAll = (filterId: string) =>
    onFiltersChange(filters.map(f => f.id === filterId ? { ...f, value: [] } : f));

  const updateValue = (filterId: string, value: any) =>
    onFiltersChange(filters.map(f => f.id === filterId ? { ...f, value, datePreset: f.type === 'date' ? 'custom' : f.datePreset } : f));

  const updateDatePreset = (filterId: string, preset: DatePreset) =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      if (preset === 'custom') return { ...f, datePreset: 'custom' };
      return { ...f, datePreset: preset, operator: 'between' as FilterOperator, value: computeDatePresetRange(preset) };
    }));

  const updateOperator = (filterId: string, operator: FilterOperator) =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      if (operator === 'between') return { ...f, operator, value: ['', ''] };
      if (operator === 'in' || operator === 'not_in') return { ...f, operator, value: [] };
      return { ...f, operator, value: '' };
    }));

  // Phase-15.78 — user-editable label. BaseFilter.label already takes
  // priority in getFilterDisplayLabel; this just exposes the UI to set
  // it. Empty/whitespace clears the override so the auto-derived label
  // (semantic measure name → friendly field name → raw column) comes
  // back.
  const updateLabel = (filterId: string, label: string) =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const next = label.trim();
      return { ...f, label: next || undefined };
    }));

  // Phase-G — per-slicer card width (collapsed-card mode). Persisted on
  // the slicer entry so the public link renders the same width the
  // author dragged. `undefined` → default card width.
  const updateWidth = (filterId: string, widthPx: number | undefined) =>
    onFiltersChange(filters.map(f => (
      f.id === filterId ? { ...f, widthPx } as BaseFilter : f
    )));

  // Phase-15.78 — toggle dropdown mode (multi vs single). Operator is
  // the source of truth: `in` = multi, `eq` = single. Switching modes
  // coerces the value: array → first element when going single, scalar
  // → [scalar] when going multi. Same field, same dataset, different
  // affordance — slicers without a multi-select count box are the
  // PowerBI default.
  const switchDropdownMode = (filterId: string, mode: 'multi' | 'single') =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const isCurrentlyMulti = f.operator === 'in' || f.operator === 'not_in';
      const wantsMulti = mode === 'multi';
      if (isCurrentlyMulti === wantsMulti) return f;
      if (wantsMulti) {
        const cur = typeof f.value === 'string' && f.value !== '' ? [f.value] : [];
        return { ...f, operator: 'in' as FilterOperator, value: cur };
      }
      const first = Array.isArray(f.value) && f.value.length > 0 ? String(f.value[0]) : '';
      return { ...f, operator: 'eq' as FilterOperator, value: first };
    }));

  const toggleLinkedField = (filterId: string, columnName: string) => {
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const current = f.linkedFields ?? [];
      const next = current.includes(columnName)
        ? current.filter(n => n !== columnName)
        : [...current, columnName];
      return { ...f, linkedFields: next.length ? next : undefined };
    }));
  };

  // Compute total chart coverage per filter (primary + linked fields)
  const getFilterChartCount = (f: BaseFilter): number => {
    const fields = [getFilterKey(f), ...(f.linkedFields ?? [])];
    const primaryColumn = columns.find((column) => getColumnKey(column) === getFilterKey(f));
    let total = 0;
    for (const field of fields) {
      total += columnChartCount.get(field) ?? 0;
    }
    const maxPossible = primaryColumn?.datasetChartCount ?? Math.max(...Array.from(columnChartCount.values()), 0);
    return Math.min(total, maxPossible || total);
  };

  const getCoverageLabel = (column: ColumnInfo) => {
    const covered = column.chartCoverage ?? columnChartCount.get(getColumnKey(column)) ?? 0;
    if (column.datasetChartCount && column.datasetChartCount > 0) {
      return `${covered}/${column.datasetChartCount} charts`;
    }
    return `${covered} chart${covered !== 1 ? 's' : ''}`;
  };

  const renderColumnOption = (column: ColumnInfo) => {
    const columnKey = getColumnKey(column);
    const label = getColumnDisplayLabel(column);
    const sameTypeCount = column.type === 'date' && !column.semanticField
      ? columns.filter(c => c.type === 'date' && getColumnKey(c) !== columnKey && !usedFields.has(getColumnKey(c))).length
      : 0;

    return (
      <button
        key={columnKey}
        onClick={() => addFilter(columnKey, undefined, pickedType ?? undefined)}
        title={column.semanticField ?? column.key ?? column.name}
        className="w-full text-left px-3 py-2 text-sm hover:bg-brand/15 flex items-center justify-between gap-3 group"
      >
        <span className="flex items-start gap-2 min-w-0">
          <span className={`text-xs font-mono w-4 text-center ${TYPE_CLR[column.type]}`}>
            {TYPE_BADGE[column.type]}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-text-secondary group-hover:text-brand">{label}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {sameTypeCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-teal-500" title={`Will auto-link ${sameTypeCount} other date column(s)`}>
              <Link2 className="w-3 h-3" />
              +{sameTypeCount}
            </span>
          )}
          <span className="text-xs text-text-quaternary">
            {getCoverageLabel(column)}
          </span>
        </span>
      </button>
    );
  };

  const renderDatasetGroups = (sourceColumns: ColumnInfo[]) => {
    const datasetGroups = groupColumnsByDataset(sourceColumns);
    return (
      <>
        {datasetGroups.map((dataset) => (
          <div key={dataset.datasetKey} className="py-1">
            <div className="sticky top-[49px] z-10 border-y border-[rgb(var(--border-line))] bg-brand/5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand backdrop-blur">
              {dataset.datasetLabel}
            </div>
            {dataset.tables.map((table) => (
              <div key={table.key}>
                <div className="bg-surface-2/95 px-4 py-1 text-[10px] font-medium text-text-tertiary">
                  {table.label}
                </div>
                {table.columns.map(renderColumnOption)}
              </div>
            ))}
          </div>
        ))}
      </>
    );
  };

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className={embedded ? 'border-t border-[rgba(255,255,255,0.06)]' : 'mb-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm'}>
      {/* ── Header bar ────────────────────────────────────────────── */}
      <div className={`flex items-center gap-2 flex-wrap ${embedded ? 'px-3 py-1.5' : 'px-4 py-2.5'}`}>
        {/* Phase-B8 — headerExtras (Thu gọn + config gear) moved to the RIGHT
            group next to "Add Filter" (was on the left, forcing the user to
            look/click both sides). See the ml-auto cluster below. */}
        {/* Filters label / expand toggle. In collapsedSlicers mode the
            slicers are always-visible buttons + the cluster has its own
            ⛃ badge, so this redundant label is hidden to declutter. */}
        {!collapsedSlicers && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <Filter className="w-4 h-4 text-brand" />
            <span>Filters</span>
            {activeCount > 0 && (
              <span className="px-1.5 py-0.5 bg-brand/15 text-brand text-xs rounded-full font-semibold">
                {activeCount}
              </span>
            )}
            {isExpanded
              ? <ChevronDown className="w-3.5 h-3.5 text-text-quaternary" />
              : <ChevronRight className="w-3.5 h-3.5 text-text-quaternary" />}
          </button>
        )}

        {/* Unapplied-changes pill — hidden in collapsedSlicers (the
            Apply button below already pulses when pending). */}
        {hasPendingChanges && !collapsedSlicers && (
          <span
            className="inline-flex items-center gap-1 rounded-full border-2 border-amber-400 bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-900 shadow-sm animate-pulse"
            title="You have filter changes that haven't been applied yet. Click Apply to update the dashboard."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Unapplied changes
          </span>
        )}

        {/* Collapsed summary chips */}
        {!isExpanded && activeCount > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap flex-1 ml-2">
            {filters
              .filter(isFilterValueActive)
              .map(f => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-brand/10 border border-brand/30 text-brand text-xs rounded-full"
                >
                  <span className="font-semibold">{getFilterDisplayLabel(f)}</span>
                  {f.datePreset && f.datePreset !== 'custom' && (
                    <span className="opacity-70">{DATE_PRESET_LABELS[f.datePreset]}</span>
                  )}
                  {f.linkedFields && f.linkedFields.length > 0 && (
                    <Link2 className="w-3 h-3 text-brand" />
                  )}
                  {Array.isArray(f.value) && f.value.length > 0 && (
                    <span className="opacity-70">({f.value.length})</span>
                  )}
                </span>
              ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Phase-B8 — slicer-cluster controls (Thu gọn + gear) now live here,
              on the right, grouped with Add Filter. */}
          {headerExtras}
          {hasPendingChanges && onReset && (
            <button
              onClick={onReset}
              className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-2"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}

          {/* Apply — in collapsedSlicers mode only render when there are
              pending changes (a permanently-visible disabled Apply was
              pure clutter). Other modes keep the always-visible button. */}
          {onApply && (!collapsedSlicers || hasPendingChanges) && (
            <button
              onClick={onApply}
              disabled={!hasPendingChanges || isApplying}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-white transition-shadow disabled:cursor-not-allowed disabled:bg-brand/40 ${
                hasPendingChanges && !isApplying
                  ? 'bg-brand hover:bg-brand-hover ring-2 ring-brand/30 ring-offset-1 shadow-md'
                  : 'bg-brand hover:bg-brand-hover'
              }`}
            >
              <Check className="h-3 w-3" />
              {isApplying ? 'Applying...' : 'Apply'}
            </button>
          )}

          {/* "Clear all" hidden in collapsedSlicers — per-slicer clear
              lives inside each popover; a top-level clear-all just added
              noise. */}
          {!lockSlots && !collapsedSlicers && filters.length > 0 && (
            <button
              onClick={() => onFiltersChange([])}
              className="text-xs text-text-quaternary hover:text-danger transition-colors"
            >
              Clear all
            </button>
          )}

          {/* Phase-9 — Add filter: Looker-style 2-step picker.
              Step 1 (pickedType=null): list of interaction types.
              Step 2 (pickedType set):  list of columns compatible with the
                                        chosen type, then `addFilter(col, _, type)`
                                        creates a BaseFilter with explicit operator. */}
          {!lockSlots && (
          <div className="relative">
            <button
              ref={addButtonRef}
              onClick={() => {
                const next = !addingField;
                setAddingField(next);
                if (!next) {
                  setAddFilterSearch('');
                  setPickedType(null);
                }
              }}
              disabled={addableColumns.length === 0}
              title={addableColumns.length === 0 ? 'No dashboard filter fields available' : undefined}
              // Phase-17 — chrome that survives any DashboardThemeProvider
              // background colour. The old `text-brand` on transparent bg
              // disappeared when the DA painted the canvas with a colour
              // close to the brand. Solid brand fill + white text +
              // shadow gives a stable affordance on light, dark and
              // accent-heavy themes.
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-brand border border-brand/60 rounded-md shadow-md ring-1 ring-black/5 hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Filter
            </button>

            {addingField && addableColumns.length > 0 && (
              <>
                <div className="fixed inset-0 z-[9998]" onClick={() => {
                  setAddingField(false);
                  setAddFilterSearch('');
                  setPickedType(null);
                }} />
                <div
                  className="fixed z-[9999] max-h-[min(34rem,75vh)] w-[26rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg"
                  style={dropdownPos ? { top: dropdownPos.top, right: dropdownPos.right } : { top: 0, right: 0 }}
                >
                  {pickedType === null ? (
                    // ── Step 1: pick interaction type ────────────────
                    <div className="py-1">
                      <div className="sticky top-0 z-20 border-b border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">
                        <Filter className="w-3 h-3" />
                        Add a control
                      </div>
                      <ul className="py-1">
                        {SLICER_INTERACTIONS.map((m) => {
                          const Icon = m.icon;
                          const compatCount = addableColumns.filter(
                            (c) => m.compatibleColumnTypes.includes(c.type),
                          ).length;
                          const disabled = compatCount === 0;
                          return (
                            <li key={m.id}>
                              <button
                                type="button"
                                disabled={disabled}
                                onClick={() => {
                                  setPickedType(m.id);
                                  setAddFilterSearch('');
                                  // Re-focus the search field once the column step renders.
                                  setTimeout(() => addFilterSearchRef.current?.focus(), 60);
                                }}
                                title={disabled ? 'No columns compatible with this type' : undefined}
                                className={`w-full flex items-start gap-3 px-3 py-2 text-left text-sm transition-colors ${
                                  disabled
                                    ? 'opacity-40 cursor-not-allowed'
                                    : 'hover:bg-surface-2 cursor-pointer'
                                }`}
                              >
                                <Icon className="w-4 h-4 mt-0.5 text-text-tertiary flex-shrink-0" />
                                <div className="min-w-0 flex-1">
                                  <div className="font-medium text-text-secondary">{m.label}</div>
                                  <div className="text-[11px] text-text-quaternary leading-snug truncate">
                                    {m.description}
                                  </div>
                                </div>
                                <span className="text-[10px] text-text-quaternary mt-1">
                                  {compatCount} {compatCount === 1 ? 'column' : 'columns'}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : (
                    // ── Step 2: pick column ──────────────────────────
                    <>
                      <div className="sticky top-0 z-20 border-b border-[rgb(var(--border-line))] bg-surface-1 px-2 py-2">
                        <div className="flex items-center gap-1.5 mb-2">
                          <button
                            type="button"
                            onClick={() => {
                              setPickedType(null);
                              setAddFilterSearch('');
                            }}
                            className="inline-flex items-center gap-0.5 text-[11px] text-text-tertiary hover:text-brand"
                          >
                            <ArrowLeft className="w-3 h-3" />
                            Change type
                          </button>
                          <span className="text-[11px] text-text-quaternary">/</span>
                          <span className="text-[11px] font-semibold text-text-secondary truncate">
                            {SLICER_INTERACTIONS.find((m) => m.id === pickedType)?.label}
                          </span>
                        </div>
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-quaternary" />
                          <input
                            ref={addFilterSearchRef}
                            type="text"
                            value={addFilterSearch}
                            onChange={(e) => setAddFilterSearch(e.target.value)}
                            placeholder="Search columns..."
                            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1.5 pl-7 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                if (addFilterSearch) {
                                  setAddFilterSearch('');
                                } else {
                                  setPickedType(null);
                                }
                              } else if (e.key === 'Enter' && matchingAvailableColumns.length > 0) {
                                addFilter(getColumnKey(matchingAvailableColumns[0]), undefined, pickedType);
                              }
                            }}
                          />
                        </div>
                      </div>

                      {matchingAvailableColumns.length > 0 ? (
                        <div className="py-1">
                          {renderDatasetGroups(matchingAvailableColumns)}
                        </div>
                      ) : (
                        <p className="px-3 py-3 text-xs text-text-quaternary italic">
                          {compatibleColumns.length === 0
                            ? 'No columns compatible with this type.'
                            : 'No search match.'}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          )}
        </div>
      </div>

      {/* ── Filter cards ──────────────────────────────────────────── */}
      {/* Phase-G fix — `stackVertical` forces a single full-width
          column. The default responsive grid keys off VIEWPORT
          breakpoints (sm/lg/xl), not container width, so when this bar
          is embedded in a narrow column (slicer cluster in 'left' mode,
          ~280px) it still tried 4 columns and crushed the cards. The
          slicer cluster passes stackVertical for left/vertical layout. */}
      {(isExpanded || collapsedSlicers) && filters.length > 0 && (
        <div className={
          collapsedSlicers
            // Collapsed slicer mode: row of compact buttons (vertical
            // stack when stackVertical/left). Each button opens a popover.
            // Phase-10: when `distributeChildren` is on (horizontal mode only),
            // drop flex-wrap so cards share the row equally via flex-1 below.
            ? `px-3 pb-3 pt-1 flex gap-2 ${
                stackVertical
                  ? 'flex-col items-stretch'
                  : distributeChildren
                    ? 'flex-row items-stretch'
                    : 'flex-row flex-wrap items-start'
              }`
            : `px-3 pb-3 grid gap-3 ${stackVertical ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'}`
        }>
          {filters.map(f => {
            // Conflict-detection signal: when the user picks values that have
            // no intersection (e.g. Role=SDR & Phòng=BE.E), the cascading
            // distinct query returns []. Surfacing the names of the other
            // active filters here lets the user know which combo is empty
            // instead of silently rendering "Loading values…".
            const otherActiveFilters = filters.filter(
              (other) => other.id !== f.id && isFilterValueActive(other),
            );
            return (
              <FilterCard
                key={f.id}
                filter={f}
                allColumns={columns}
                allDistinctValues={distinctValues}
                distinctStatus={distinctStatus?.[getFilterKey(f)]}
                usedFields={usedFields}
                columnChartCount={columnChartCount}
                filterChartCount={getFilterChartCount(f)}
                search={searchTerms[f.id] ?? ''}
                onSearchChange={s => setSearchTerms(prev => ({ ...prev, [f.id]: s }))}
                onToggleValue={val => toggleValue(f.id, val)}
                onSelectAll={vals => selectAll(f.id, vals)}
                onDeselectAll={() => deselectAll(f.id)}
                onUpdateValue={v => updateValue(f.id, v)}
                onUpdateOperator={op => updateOperator(f.id, op)}
                onUpdateDatePreset={preset => updateDatePreset(f.id, preset)}
                onToggleLinkedField={col => toggleLinkedField(f.id, col)}
                onUpdateLabel={l => updateLabel(f.id, l)}
                onSwitchDropdownMode={m => switchDropdownMode(f.id, m)}
                onClear={() => clearFilter(f.id)}
                onRemove={() => removeFilter(f.id)}
                conflictingFilterLabels={otherActiveFilters.map((other) => getFilterDisplayLabel(other))}
                lockSlots={lockSlots}
                collapsedPopover={collapsedSlicers}
                popoverPlacement={stackVertical ? 'right' : 'bottom'}
                onUpdateWidth={(w) => updateWidth(f.id, w)}
                distributeChildren={distributeChildren && !stackVertical}
              />
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {isExpanded && filters.length === 0 && (
        <div className="px-4 py-5 text-center border-t border-[rgb(var(--border-line))]">
          {addableColumns.length > 0 ? (
            <p className="text-sm text-text-quaternary">
              No filters added. Click <strong>Add Filter</strong> to filter all charts in this dashboard.
            </p>
          ) : (
            <p className="text-sm text-text-quaternary">
              No shared dashboard filters are available here. Use chart-level filters for chart-specific analysis.
            </p>
          )}
          {columns.filter(c => c.type === 'date').length > 1 && (
            <p className="text-xs text-teal-500 mt-1">
              <Link2 className="w-3 h-3 inline mr-1" />
              Tip: Adding a date filter will auto-link all date columns across charts.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Individual filter card with cross-chart linking
// ═══════════════════════════════════════════════════════════════════
interface FilterCardProps {
  filter: BaseFilter;
  allColumns: ColumnInfo[];
  allDistinctValues: Record<string, string[]>;
  /** Phase-7.6 — per-column distinct query status for this card's field. */
  distinctStatus?: {
    isLoading: boolean;
    isError: boolean;
    hasFilterContext: boolean;
  };
  /** Phase-10 — when true, this card stretches via `flex-1` instead of its
   * manual `widthPx`. Set by SlicerCluster's "Tự động giãn cách" toggle. */
  distributeChildren?: boolean;
  usedFields: Set<string>;
  columnChartCount: Map<string, number>;
  filterChartCount: number;
  search: string;
  onSearchChange: (s: string) => void;
  onToggleValue: (val: string) => void;
  onSelectAll: (vals: string[]) => void;
  onDeselectAll: () => void;
  onUpdateValue: (value: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
  onUpdateDatePreset: (preset: DatePreset) => void;
  onToggleLinkedField: (columnName: string) => void;
  /** Phase-15.78: persist a user-friendly label override. */
  onUpdateLabel: (label: string) => void;
  /** Phase-15.78: switch dropdown filters between multi (`in`) and single (`eq`). */
  onSwitchDropdownMode: (mode: 'multi' | 'single') => void;
  onClear: () => void;
  onRemove: () => void;
  /** Labels of other filters currently constraining the distinct-values query
   * for this card. Used to render a conflict banner when the cascading
   * dropdown returns no values. */
  conflictingFilterLabels?: string[];
  /** Slicer-mode flag from parent: hides per-card remove (X) button. */
  lockSlots?: boolean;
  /** Phase-G — render as a collapsed button that opens the value
   * controls in a floating popover (overlay) instead of an
   * always-expanded inline card. Used by the slicer cluster (editor +
   * public) so a long value list overlays content below rather than
   * stretching the layout. */
  collapsedPopover?: boolean;
  /** Phase-G — where the popover opens relative to the collapsed
   * button. 'right' for the Left-column cluster (opens beside, over
   * charts); 'bottom' for the Top bar (opens below). */
  popoverPlacement?: 'bottom' | 'right';
  /** Phase-G — persist the card width after the author drags its right
   * edge (collapsed-card mode, editor only). */
  onUpdateWidth?: (widthPx: number | undefined) => void;
}

interface DashboardFilterBarPropsWithExtras extends DashboardFilterBarProps {
  /** Phase-G — extra controls injected at the START of the header bar
   * (before the Filters label). The slicer cluster passes its badge +
   * position toggle + Add Image here so everything lives in a SINGLE
   * header row instead of two stacked headers. */
  headerExtras?: React.ReactNode;
}

function FilterCard({
  filter: f,
  allColumns,
  allDistinctValues,
  distinctStatus,
  distributeChildren = false,
  usedFields,
  columnChartCount,
  filterChartCount,
  search,
  onSearchChange,
  onToggleValue,
  onSelectAll,
  onDeselectAll,
  onUpdateValue,
  onUpdateOperator,
  onUpdateDatePreset,
  onToggleLinkedField,
  onUpdateLabel,
  onSwitchDropdownMode,
  onClear,
  onRemove,
  conflictingFilterLabels,
  lockSlots = false,
  collapsedPopover = false,
  popoverPlacement = 'bottom',
  onUpdateWidth,
}: FilterCardProps) {
  const [showLinked, setShowLinked] = useState(false);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(f.label ?? '');
  // Phase-G — popover open state for collapsed slicer mode.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!popoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverWrapRef.current && !popoverWrapRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [popoverOpen]);

  // Phase-G — per-card width via a CUSTOM drag handle (NOT CSS resize +
  // ResizeObserver, which fought React's controlled width and snapped
  // the card back mid-drag). Mirrors chart resize: dragging updates a
  // LOCAL live width on the FE; releasing commits it to the draft via
  // onUpdateWidth. Persisting to BE still happens only on the slicer
  // Apply / dashboard Publish — not during the drag.
  // Enabled only on the Top bar in the editor (Left cards are
  // full-width; the public viewer passes no onUpdateWidth).
  // Phase-10 — hide the manual width-drag handle when "Tự động giãn cách"
  // is on, since the row layout overrides any committed widthPx anyway.
  const canResizeCard = collapsedPopover && !!onUpdateWidth && popoverPlacement !== 'right' && !distributeChildren;
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const widthDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const cardResizeRef = useRef<HTMLDivElement>(null);

  const onWidthHandleDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startW = cardResizeRef.current?.offsetWidth ?? f.widthPx ?? 190;
    widthDragRef.current = { startX: e.clientX, startW };
    setLiveWidth(startW);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onWidthHandleMove = (e: React.PointerEvent) => {
    if (!widthDragRef.current) return;
    const next = Math.max(140, Math.round(widthDragRef.current.startW + (e.clientX - widthDragRef.current.startX)));
    setLiveWidth(next);
  };
  const onWidthHandleUp = (e: React.PointerEvent) => {
    if (!widthDragRef.current) return;
    const finalW = liveWidth;
    widthDragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (finalW != null) onUpdateWidth?.(finalW);
    setLiveWidth(null);
  };

  const isMultiSelect = f.operator === 'in' || f.operator === 'not_in';
  const selected: string[] = isMultiSelect && Array.isArray(f.value) ? f.value : [];
  const hasValue = isFilterValueActive(f);
  // text + dropdown-typed filters can toggle multi/single (number/date keep
  // their operator-driven UI). String fields are the common slicer case.
  const supportsDropdownModeToggle = f.type === 'dropdown' || f.type === 'text';

  // Columns of the same type that could be linked (not the primary, not used as separate filters)
  const linkableColumns = useMemo(
    () => (
      f.semanticField
        ? []
        : allColumns.filter(c =>
            !c.semanticField &&
            c.type === f.type &&
            getColumnKey(c) !== getFilterKey(f) &&
            !usedFields.has(getColumnKey(c))
          )
    ),
    [allColumns, f, usedFields],
  );

  // Merge distinct values from primary + linked fields
  const mergedValues = useMemo(() => {
    const primary = allDistinctValues[getFilterKey(f)] ?? [];
    if (!f.linkedFields?.length) return primary;
    const set = new Set(primary);
    f.linkedFields.forEach(lf => {
      (allDistinctValues[lf] ?? []).forEach(v => set.add(v));
    });
    return Array.from(set).sort();
  }, [f, allDistinctValues]);

  const filteredValues = useMemo(() => {
    if (!search) return mergedValues;
    const q = search.toLowerCase();
    return mergedValues.filter(v => v.toLowerCase().includes(q));
  }, [mergedValues, search]);

  const linkedCount = f.linkedFields?.length ?? 0;
  const hasLinkableColumns = linkableColumns.length > 0;
  const primaryColumn = useMemo(
    () => allColumns.find((column) => getColumnKey(column) === getFilterKey(f)),
    [allColumns, f],
  );
  const filterCoverageLabel = primaryColumn?.datasetChartCount
    ? `${filterChartCount}/${primaryColumn.datasetChartCount} charts`
    : `${filterChartCount} chart${filterChartCount !== 1 ? 's' : ''}`;
  const contextLabel = primaryColumn ? getColumnContextLabel(primaryColumn) : getColumnContextLabel({
    name: f.field,
    key: f.fieldKey,
    semanticField: f.semanticField,
    datasetId: f.datasetId,
  });

  // Phase-G — short value summary for the collapsed slicer button.
  const valueSummary: string = (() => {
    if (isMultiSelect) {
      if (selected.length === 0) return 'All';
      if (selected.length === 1) return String(selected[0]);
      return `${selected[0]} +${selected.length - 1}`;
    }
    if (f.type === 'date') {
      if (f.datePreset && f.datePreset !== 'custom') {
        return DATE_PRESET_LABELS[f.datePreset] ?? String(f.datePreset);
      }
      if (Array.isArray(f.value) && (f.value[0] || f.value[1])) {
        return `${f.value[0] ?? '…'} → ${f.value[1] ?? '…'}`;
      }
      return 'All';
    }
    if (f.value == null || f.value === '') return 'All';
    return String(f.value);
  })();

  const cardContent = (
    <div className="bi-fade-in border border-[rgb(var(--border-line))] rounded-lg bg-surface-2/70 overflow-hidden flex flex-col">
      {/* Card header */}
      <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`bi-filter-chip ${TYPE_PILL[f.type]}`} title={`Type: ${TYPE_LABEL[f.type]}`}>
            {TYPE_LABEL[f.type]}
          </span>
          {isEditingLabel ? (
            // Phase-15.78 — inline label editor. Tester report (X.1):
            // users were stuck reading raw column names like
            // customer_acquisition_channel; this lets them rename to
            // "Kênh mua hàng" or similar, persisted on the filter.
            <input
              autoFocus
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onBlur={() => { onUpdateLabel(labelDraft); setIsEditingLabel(false); }}
              onKeyDown={e => {
                if (e.key === 'Enter') { onUpdateLabel(labelDraft); setIsEditingLabel(false); }
                if (e.key === 'Escape') { setLabelDraft(f.label ?? ''); setIsEditingLabel(false); }
              }}
              placeholder={getFilterDisplayLabel(f)}
              className="text-sm font-semibold text-text-primary bg-surface-2 border border-brand/40 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-brand min-w-0 max-w-[12rem]"
            />
          ) : (
            <button
              onClick={() => { setLabelDraft(f.label ?? ''); setIsEditingLabel(true); }}
              title={f.label ? 'Click to rename — clears to default if empty' : 'Click to set a custom label'}
              className="group/label inline-flex items-center gap-1 min-w-0"
            >
              <span className="text-sm font-semibold text-text-primary truncate">
                {getFilterDisplayLabel(f)}
              </span>
              <Pencil className="w-3 h-3 text-text-quaternary opacity-0 group-hover/label:opacity-100 transition-opacity flex-shrink-0" />
            </button>
          )}
          {contextLabel && (
            <span className="hidden max-w-[9rem] truncate text-xs text-text-quaternary sm:inline">
              {contextLabel}
            </span>
          )}
          {selected.length > 0 && (
            <span className="px-1.5 py-0.5 bg-brand/15 text-brand text-xs rounded-full font-semibold flex-shrink-0">
              {selected.length}
            </span>
          )}
          {/* Chart coverage badge */}
          {filterChartCount > 0 && (
            <span
              className={`px-1.5 py-0.5 text-xs rounded-full flex-shrink-0 ${
                linkedCount > 0
                  ? 'bg-teal-100 text-teal-700'
                  : 'bg-surface-2 text-text-tertiary'
              }`}
              title={linkedCount > 0
                ? `Linked to ${linkedCount} other column(s) - applies to more charts`
                : `Applies to ${filterCoverageLabel}`
              }
            >
              {linkedCount > 0 && <Link2 className="w-3 h-3 inline mr-0.5" />}
              {filterCoverageLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {hasValue && (
            <button onClick={onClear} className="text-xs text-text-quaternary hover:text-text-secondary">
              Clear
            </button>
          )}
          {!lockSlots && (
            <button
              onClick={onRemove}
              className="p-0.5 text-text-quaternary hover:text-danger transition-colors"
              title="Remove filter"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Card body */}
      <div className="px-3 py-2 flex-1">
        {/* Phase-15.78 — multi/single mode toggle for dropdown/text filters.
            Operator `in` → multi-select checklist (legacy behaviour);
            `eq` → single-select dropdown (PowerBI-style). Hidden on
            number/date because they have their own operator UI.
            Phase-14 — also hidden when an explicit interactionType locks
            the body shape (input / checkbox / slider / advanced / etc).
            Only the legacy `dropdown` and `fixed_list` interactions still
            support multi↔single toggling on the fly. */}
        {supportsDropdownModeToggle
          && (!f.interactionType
              || f.interactionType === 'dropdown'
              || f.interactionType === 'fixed_list') && (
          <div className="mb-2 flex items-center gap-1 text-[11px] text-text-tertiary">
            <span className="opacity-70">Mode:</span>
            <button
              type="button"
              onClick={() => onSwitchDropdownMode(isMultiSelect ? 'single' : 'multi')}
              className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-0.5 hover:bg-surface-2 transition-colors"
              title={isMultiSelect ? 'Click to switch to single-select' : 'Click to switch to multi-select'}
            >
              {isMultiSelect
                ? <><ToggleRight className="w-3.5 h-3.5 text-brand" /> Multi</>
                : <><ToggleLeft className="w-3.5 h-3.5 text-text-quaternary" /> Single</>}
            </button>
          </div>
        )}
        {/* Phase-14 — interaction-aware dispatch. When `f.interactionType`
            is present, route to the body that matches the DA's pick at
            the Looker picker step. Legacy filters (pre-Phase-9, no
            interactionType) fall through to the operator/type inference
            below — same behaviour as before this commit. */}
        {f.interactionType === 'input' ? (
          <TextInputBody
            filter={f}
            onUpdateValue={onUpdateValue}
            onUpdateOperator={onUpdateOperator}
          />
        ) : f.interactionType === 'checkbox' ? (
          <CheckboxBody filter={f} onUpdateValue={onUpdateValue} />
        ) : f.interactionType === 'slider' ? (
          // Slider == range body directly. Skip NumberBody's operator
          // picker (slider IS the operator — between).
          <NumberRangeBody filter={f} onUpdateValue={onUpdateValue} />
        ) : f.interactionType === 'date_range' ? (
          <DateBody
            filter={f}
            onUpdateValue={onUpdateValue}
            onUpdateOperator={onUpdateOperator}
            onUpdateDatePreset={onUpdateDatePreset}
          />
        ) : f.interactionType === 'advanced' ? (
          // String / dropdown → operator picker + text input. Number /
          // date → existing NumberBody / DateBody (they're already
          // operator-pickable).
          f.type === 'number' ? (
            <NumberBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} />
          ) : f.type === 'date' ? (
            <DateBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} onUpdateDatePreset={onUpdateDatePreset} />
          ) : (
            <StringAdvancedBody
              filter={f}
              onUpdateValue={onUpdateValue}
              onUpdateOperator={onUpdateOperator}
            />
          )
        ) : isMultiSelect ? (
          // 'dropdown' / 'fixed_list' (and legacy multi) → multi-checklist.
          // `fixed_list` keeps the same UI but the parent slot is rendered
          // always-expanded (no popover collapse) when collapsedPopover=false.
          <MultiSelectBody
            values={mergedValues}
            filteredValues={filteredValues}
            selected={selected}
            search={search}
            onSearchChange={onSearchChange}
            onToggleValue={onToggleValue}
            onSelectAll={() => onSelectAll(mergedValues)}
            onDeselectAll={onDeselectAll}
            conflictingFilterLabels={conflictingFilterLabels}
            distinctStatus={distinctStatus}
          />
        ) : supportsDropdownModeToggle ? (
          // Phase-15.78 — single-select dropdown for `eq` operator on
          // text/dropdown columns. One radio active at a time; clears
          // the value when the user picks "(none)".
          <SingleSelectBody
            values={mergedValues}
            filteredValues={filteredValues}
            selectedValue={typeof f.value === 'string' ? f.value : ''}
            search={search}
            onSearchChange={onSearchChange}
            onSelect={val => onUpdateValue(val)}
            onClear={() => onUpdateValue('')}
            conflictingFilterLabels={conflictingFilterLabels}
            distinctStatus={distinctStatus}
          />
        ) : f.type === 'number' ? (
          <NumberBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} />
        ) : f.type === 'date' ? (
          <DateBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} onUpdateDatePreset={onUpdateDatePreset} />
        ) : null}
      </div>

      {/* ── Linked columns section ────────────────────────────────── */}
      {hasLinkableColumns && (
        <div className="border-t border-[rgb(var(--border-line))]">
          <button
            onClick={() => setShowLinked(!showLinked)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-2/80 transition-colors"
          >
            <Link2 className="w-3 h-3" />
            <span>
              Link columns
              {linkedCount > 0 && (
                <span className="ml-1 text-teal-600 font-semibold">({linkedCount} linked)</span>
              )}
            </span>
            {showLinked
              ? <ChevronDown className="w-3 h-3 ml-auto" />
              : <ChevronRight className="w-3 h-3 ml-auto" />}
          </button>

          {showLinked && (
            <div className="px-3 pb-2 space-y-0.5">
              <p className="text-xs text-text-quaternary mb-1">
                Same filter value will apply to checked columns across charts:
              </p>
              {linkableColumns.map(col => {
                const columnKey = getColumnKey(col);
                const isLinked = f.linkedFields?.includes(columnKey) ?? false;
                const count = columnChartCount.get(columnKey) ?? 0;
                return (
                  <label
                    key={columnKey}
                    className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                      isLinked ? 'bg-teal-50 text-teal-800' : 'hover:bg-surface-2 text-text-secondary'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isLinked}
                      onChange={() => onToggleLinkedField(columnKey)}
                      className="w-3.5 h-3.5 rounded border-[rgb(var(--border-strong))] text-teal-600 focus:ring-teal-500 focus:ring-1"
                    />
                    <span className={`font-mono text-xs ${TYPE_CLR[col.type]}`}>
                      {TYPE_BADGE[col.type]}
                    </span>
                    <span className="truncate flex-1">{getColumnDisplayLabel(col)}</span>
                    {count > 0 && (
                      <span className="text-xs text-text-quaternary flex-shrink-0">
                        {count} chart{count !== 1 ? 's' : ''}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Phase-G — default: render the card inline (editor filter pane,
  // public-link manager, etc.).
  if (!collapsedPopover) return cardContent;

  // Collapsed slicer mode: a compact button that opens the card in a
  // floating popover. The popover is absolutely positioned so a long
  // value list OVERLAYS the content below instead of stretching the
  // layout (per the public-viewer UX request). Width is capped + the
  // value list inside scrolls.
  //
  // Placement depends on the cluster layout:
  //   'right'  → Left-column cluster: buttons stack full-width down the
  //              column; the popover opens to the RIGHT (over the
  //              charts) so it doesn't cover the buttons below it.
  //   'bottom' → Top bar: buttons flow in a row; the popover opens
  //              BELOW the button (over the charts beneath).
  const openRight = popoverPlacement === 'right';
  // Tableau-style slicer CARD: field name as a small EDITABLE title on
  // top (double-click to rename, editor only), current value + chevron
  // below, thin even border. Active (real value) = brand-tinted border.
  // Top bar → cards line up; author drags the right-edge handle to widen
  // (controlled liveWidth, committed to draft on release). Left column →
  // full-width (no manual resize; the column width controls it).
  // Phase-10 — when the slicer cluster has "Tự động giãn cách" on, the
  // card stretches via flex-1 (set on the OUTER wrapper). We still set a
  // sensible width on the inner box so the popover anchor doesn't collapse
  // when the row has only 1 filter.
  const cardWidthStyle: React.CSSProperties = openRight
    ? { width: '100%' }
    : distributeChildren
      ? { width: '100%', minWidth: 140 }
      : { width: `${liveWidth ?? f.widthPx ?? 190}px`, minWidth: 140 };
  // Outer wrapper class: `inline-block` is the legacy fixed-width mode.
  // With distribute on, switch to `flex-1` so siblings share the row.
  const outerWrapperClass = openRight
    ? 'relative block w-full'
    : distributeChildren
      ? 'relative flex-1 min-w-0'
      : 'relative inline-block align-top';
  return (
    <div ref={popoverWrapRef} className={outerWrapperClass}>
      <div
        ref={cardResizeRef}
        style={cardWidthStyle}
        className={`relative flex flex-col gap-0.5 rounded-lg border bg-surface-1 px-3 py-2 transition-colors ${
          popoverOpen
            ? 'border-brand ring-1 ring-brand/30'
            : hasValue
              ? 'border-brand/45'
              : 'border-[rgb(var(--border-line))]'
        }`}
      >
        {/* Right-edge width drag handle (editor, Top mode). Custom
            pointer-drag → live FE width; commit to draft on release. */}
        {canResizeCard && (
          <span
            onPointerDown={onWidthHandleDown}
            onPointerMove={onWidthHandleMove}
            onPointerUp={onWidthHandleUp}
            className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize rounded-r-lg hover:bg-brand/30"
            title="Kéo để chỉnh rộng"
          />
        )}
        {/* Title row — editable label (double-click in editor). */}
        <span className="flex items-center justify-between gap-1">
          {isEditingLabel && !lockSlots ? (
            <input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={() => { onUpdateLabel(labelDraft); setIsEditingLabel(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onUpdateLabel(labelDraft); setIsEditingLabel(false); }
                if (e.key === 'Escape') { setLabelDraft(f.label ?? ''); setIsEditingLabel(false); }
              }}
              placeholder={getFilterDisplayLabel(f)}
              className="min-w-0 flex-1 rounded border border-brand/40 bg-surface-2 px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide outline-none focus:ring-1 focus:ring-brand"
            />
          ) : (
            <span
              className="group/lbl flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold uppercase tracking-wide text-text-tertiary"
              onDoubleClick={lockSlots ? undefined : () => { setLabelDraft(f.label ?? ''); setIsEditingLabel(true); }}
              title={lockSlots ? undefined : 'Double-click để đổi tên'}
            >
              <span className="truncate">{getFilterDisplayLabel(f)}</span>
              {!lockSlots && <Pencil className="h-2.5 w-2.5 flex-shrink-0 text-text-quaternary opacity-0 transition-opacity group-hover/lbl:opacity-100" />}
            </span>
          )}
          {selected.length > 1 && (
            <span className="flex-shrink-0 rounded-full bg-brand/15 px-1.5 text-[10px] font-semibold text-brand">
              {selected.length}
            </span>
          )}
        </span>
        {/* Value row — opens the popover. */}
        <button
          type="button"
          onClick={() => setPopoverOpen((v) => !v)}
          className="flex items-center justify-between gap-1.5 text-left"
          title={`${getFilterDisplayLabel(f)}: ${valueSummary}`}
        >
          <span className={`truncate text-sm ${hasValue ? 'font-medium text-text-primary' : 'text-text-tertiary'}`}>
            {valueSummary}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 text-text-quaternary transition-transform ${popoverOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {popoverOpen && (
        <div
          className={`absolute z-50 w-[280px] max-h-[60vh] overflow-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-xl ${
            openRight
              // Open to the right of the column, aligned to the card top.
              ? 'left-full top-0 ml-2'
              // Open below the card.
              : 'left-0 top-full mt-1'
          }`}
        >
          {cardContent}
        </div>
      )}
    </div>
  );
}

// ── Single-select dropdown (PowerBI radio-style slicer) ─────────
// Phase-15.78 — alternate body for `eq` operator on dropdown/text filters.
// One value at a time, radio buttons, with the same cascading distinct
// query + conflict banner UX as MultiSelectBody.
function SingleSelectBody({
  values,
  filteredValues,
  selectedValue,
  search,
  onSearchChange,
  onSelect,
  onClear,
  conflictingFilterLabels,
  distinctStatus,
}: {
  values: string[];
  filteredValues: string[];
  selectedValue: string;
  search: string;
  onSearchChange: (s: string) => void;
  onSelect: (val: string) => void;
  onClear: () => void;
  conflictingFilterLabels?: string[];
  distinctStatus?: {
    isLoading: boolean;
    isError: boolean;
    hasFilterContext: boolean;
  };
}) {
  // Only a TRUE cascade conflict — the BE answered (200) with zero rows for
  // this field/filter combo. A load failure (isError, e.g. the field isn't an
  // allowed public filter → 404) must NOT show "Try relaxing": that misreports
  // an endpoint error as a filter conflict and sends people chasing the wrong
  // cause. While still loading we also don't claim a conflict.
  const showConflictBanner =
    values.length === 0
    && (conflictingFilterLabels?.length ?? 0) > 0
    && !distinctStatus?.isError
    && !distinctStatus?.isLoading;
  // Phase-7.6 — when no values AND no in-list conflict, also check if a
  // cross-list filter (page-level, slicer cluster) was passed via the
  // distinct query — then we know the dropdown is empty because of the
  // filter context, NOT because the data hasn't loaded yet.
  const emptyDueToFilter = values.length === 0
    && !showConflictBanner
    && distinctStatus?.hasFilterContext
    && !distinctStatus.isLoading;
  return (
    <div>
      {showConflictBanner && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          <p className="font-medium">No values match current filter combination.</p>
          <p className="mt-0.5 text-amber-700">
            Try relaxing: {conflictingFilterLabels!.slice(0, 3).join(', ')}
            {conflictingFilterLabels!.length > 3 ? ` (+${conflictingFilterLabels!.length - 3} more)` : ''}
          </p>
        </div>
      )}
      {values.length > 8 && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-quaternary" />
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search values..."
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1 pl-7 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
          />
        </div>
      )}
      {selectedValue && (
        <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-[rgb(var(--border-line))]">
          <button onClick={onClear} className="text-xs text-text-tertiary hover:text-text-secondary">
            Clear selection
          </button>
        </div>
      )}
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {filteredValues.length === 0 ? (
          <p className="text-xs text-text-quaternary italic py-1">
            {values.length === 0
              ? (showConflictBanner
                  ? 'No matching values'
                  : distinctStatus?.isError
                    ? 'Failed to load values.'
                    : emptyDueToFilter
                      ? 'No values match the active filter on this dashboard.'
                      : (distinctStatus && !distinctStatus.isLoading)
                        ? 'No values available.'
                        : 'Loading values...')
              : 'No match'}
          </p>
        ) : (
          filteredValues.map(val => {
            const checked = selectedValue === val;
            return (
              <label
                key={val}
                className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                  checked ? 'bg-brand/10 text-brand' : 'hover:bg-surface-2 text-text-secondary'
                }`}
              >
                <input
                  type="radio"
                  checked={checked}
                  onChange={() => onSelect(val)}
                  className="w-3.5 h-3.5 border-[rgb(var(--border-strong))] text-brand focus:ring-brand focus:ring-1"
                />
                <span className="truncate flex-1">{val || '(empty)'}</span>
              </label>
            );
          })
        )}
      </div>
      {search && filteredValues.length < values.length && (
        <p className="text-xs text-text-quaternary mt-1">
          {filteredValues.length} of {values.length}
        </p>
      )}
    </div>
  );
}

// ── Multi-select checklist (PowerBI Basic Filter) ───────────────
function MultiSelectBody({
  values,
  filteredValues,
  selected,
  search,
  onSearchChange,
  onToggleValue,
  onSelectAll,
  onDeselectAll,
  conflictingFilterLabels,
  distinctStatus,
}: {
  values: string[];
  filteredValues: string[];
  selected: string[];
  search: string;
  onSearchChange: (s: string) => void;
  onToggleValue: (val: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  conflictingFilterLabels?: string[];
  distinctStatus?: {
    isLoading: boolean;
    isError: boolean;
    hasFilterContext: boolean;
  };
}) {
  // When the cascading distinct query yields no values BUT other filters
  // are constraining it, surface the combination explicitly so the user
  // knows which filter to relax. Without this signal the user just sees
  // "Loading values…" and assumes the filter is broken.
  // Only a TRUE cascade conflict — the BE answered (200) with zero rows for
  // this field/filter combo. A load failure (isError, e.g. the field isn't an
  // allowed public filter → 404) must NOT show "Try relaxing": that misreports
  // an endpoint error as a filter conflict and sends people chasing the wrong
  // cause. While still loading we also don't claim a conflict.
  const showConflictBanner =
    values.length === 0
    && (conflictingFilterLabels?.length ?? 0) > 0
    && !distinctStatus?.isError
    && !distinctStatus?.isLoading;
  // Phase-7.6 — cross-list filter (page filter, slicer cluster filter
  // outside the current popup's filter list) can also produce 0 cascade
  // rows. Without `distinctStatus.isLoading=false + hasFilterContext` we'd
  // keep showing "Loading values..." forever — the BE has already
  // responded with [].
  const emptyDueToFilter = values.length === 0
    && !showConflictBanner
    && distinctStatus?.hasFilterContext
    && !distinctStatus.isLoading;
  return (
    <div>
      {showConflictBanner && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          <p className="font-medium">No values match current filter combination.</p>
          <p className="mt-0.5 text-amber-700">
            Try relaxing: {conflictingFilterLabels!.slice(0, 3).join(', ')}
            {conflictingFilterLabels!.length > 3 ? ` (+${conflictingFilterLabels!.length - 3} more)` : ''}
          </p>
        </div>
      )}
      {/* Search */}
      {values.length > 8 && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-quaternary" />
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search values..."
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1 pl-7 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
          />
        </div>
      )}

      {/* Select / Deselect all */}
      {values.length > 1 && !search && (
        <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-[rgb(var(--border-line))]">
          <button onClick={onSelectAll} className="text-xs text-brand hover:text-brand">
            Select all
          </button>
          <span className="text-text-quaternary">|</span>
          <button onClick={onDeselectAll} className="text-xs text-text-tertiary hover:text-text-secondary">
            Deselect all
          </button>
        </div>
      )}

      {/* Checkboxes */}
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {filteredValues.length === 0 ? (
          <p className="text-xs text-text-quaternary italic py-1">
            {values.length === 0
              ? (showConflictBanner
                  ? 'No matching values'
                  : distinctStatus?.isError
                    ? 'Failed to load values.'
                    : emptyDueToFilter
                      ? 'No values match the active filter on this dashboard.'
                      : (distinctStatus && !distinctStatus.isLoading)
                        ? 'No values available.'
                        : 'Loading values...')
              : 'No match'}
          </p>
        ) : (
          filteredValues.map(val => {
            const checked = selected.includes(val);
            return (
              <label
                key={val}
                className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                  checked ? 'bg-brand/10 text-brand' : 'hover:bg-surface-2 text-text-secondary'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleValue(val)}
                  className="w-3.5 h-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand focus:ring-1"
                />
                <span className="truncate flex-1">{val || '(empty)'}</span>
              </label>
            );
          })
        )}
      </div>

      {search && filteredValues.length < values.length && (
        <p className="text-xs text-text-quaternary mt-1">
          {filteredValues.length} of {values.length}
        </p>
      )}
    </div>
  );
}

// ── Number range body (between operator) ────────────────────────
// Phase-15.78 — paired range sliders + number inputs for the between
// operator. Sliders give visual feedback while typing into either
// input still lets the user pin precise bounds. Slider scale is
// auto-derived from the current values (with a 10× padding for
// headroom) so the bar isn't dead before the user types numbers; if
// they want a wider range, they just type larger numbers into the
// inputs and the slider re-scales next render.
function NumberRangeBody({
  filter: f,
  onUpdateValue,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
}) {
  const [lo, hi] = Array.isArray(f.value)
    ? [f.value[0] ?? '', f.value[1] ?? '']
    : ['', ''];
  const loNum = lo !== '' && lo != null ? Number(lo) : NaN;
  const hiNum = hi !== '' && hi != null ? Number(hi) : NaN;

  // Derive slider scale. If both bounds typed, scale spans them with
  // generous headroom either side; otherwise default 0–100. When the
  // user types out-of-range numbers, the slider thumb sits at the edge
  // and the inputs remain the source of truth.
  const hasBoth = Number.isFinite(loNum) && Number.isFinite(hiNum);
  const span = hasBoth ? Math.max(Math.abs(hiNum - loNum), 1) : 100;
  const min = hasBoth ? Math.min(loNum, hiNum) - span : 0;
  const max = hasBoth ? Math.max(loNum, hiNum) + span : 100;
  const step = span > 100 ? Math.max(1, Math.round(span / 100)) : span > 10 ? 1 : 0.1;

  const updateLo = (next: string | number) => {
    const value = typeof next === 'number' ? String(next) : next;
    onUpdateValue([value, hi]);
  };
  const updateHi = (next: string | number) => {
    const value = typeof next === 'number' ? String(next) : next;
    onUpdateValue([lo, value]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={lo}
          onChange={e => updateLo(e.target.value)}
          placeholder="Min"
          className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
        <span className="text-text-quaternary text-xs">–</span>
        <input
          type="number"
          value={hi}
          onChange={e => updateHi(e.target.value)}
          placeholder="Max"
          className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
      </div>
      <div className="space-y-1 pt-1">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(loNum) ? loNum : min}
          onChange={e => updateLo(Number(e.target.value))}
          className="w-full accent-brand"
          title={`Min: ${Number.isFinite(loNum) ? loNum : '(not set)'}`}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(hiNum) ? hiNum : max}
          onChange={e => updateHi(Number(e.target.value))}
          className="w-full accent-brand"
          title={`Max: ${Number.isFinite(hiNum) ? hiNum : '(not set)'}`}
        />
        {!hasBoth && (
          <p className="text-[10px] text-text-quaternary leading-tight">
            Type Min &amp; Max to enable visual range; sliders re-scale automatically.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Number filter body ──────────────────────────────────────────
// ── Phase-14: bodies for Looker-style interactions that didn't have a
// matching renderer pre-Phase-9. Each maps to one entry in
// SLICER_INTERACTIONS:
//   TextInputBody    → 'input'    (free-form `contains` search)
//   CheckboxBody     → 'checkbox' (boolean-ish toggle)
//   StringAdvancedBody → 'advanced' on text/dropdown columns

// "Input box" — free-form text. Operator stays at 'contains' / 'starts_with'
// / 'ends_with' / 'eq'; value is a string. Matches PowerBI's "Text filter"
// and Looker's "Input box". DA can switch the predicate flavor via a
// compact dropdown next to the input.
function TextInputBody({
  filter: f,
  onUpdateValue,
  onUpdateOperator,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
}) {
  const opLabel: Record<string, string> = {
    contains: 'contains',
    starts_with: 'starts with',
    ends_with: 'ends with',
    eq: 'equals',
    ne: 'not equals',
  };
  // If filter was created with a non-text-style operator (e.g. 'in'),
  // reset to a sensible default the first time the body renders. The
  // caller's `addFilter` sets `contains` for the input interaction so this
  // is just a safety net.
  const op = (opLabel[f.operator] ? f.operator : 'contains') as FilterOperator;
  const value = typeof f.value === 'string' ? f.value : '';
  return (
    <div className="space-y-2">
      <select
        value={op}
        onChange={(e) => onUpdateOperator(e.target.value as FilterOperator)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
      >
        {(['contains', 'starts_with', 'ends_with', 'eq', 'ne'] as FilterOperator[]).map((o) => (
          <option key={o} value={o}>{opLabel[o]}</option>
        ))}
      </select>
      <input
        type="text"
        value={value}
        onChange={(e) => onUpdateValue(e.target.value)}
        placeholder="Enter value..."
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
      />
    </div>
  );
}

// "Checkbox" — boolean-ish on/off. Three explicit states (None / On / Off)
// rendered as three buttons. Saves as 'eq' against the user's preferred
// truthy literal (default '1' / '0' — DA can override via the small text
// inputs below for boolean columns stored as 'true'/'false' etc).
function CheckboxBody({
  filter: f,
  onUpdateValue,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
}) {
  const current = typeof f.value === 'string' ? f.value : '';
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1">
        <button
          type="button"
          onClick={() => onUpdateValue('')}
          className={`rounded border px-2 py-1.5 text-xs transition-colors ${
            current === ''
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
          }`}
        >
          Any
        </button>
        <button
          type="button"
          onClick={() => onUpdateValue('1')}
          className={`rounded border px-2 py-1.5 text-xs transition-colors ${
            current === '1' || current === 'true' || current === 'yes' || current === 'on'
              ? 'border-brand bg-brand text-text-inverse'
              : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
          }`}
        >
          ✓ On
        </button>
        <button
          type="button"
          onClick={() => onUpdateValue('0')}
          className={`rounded border px-2 py-1.5 text-xs transition-colors ${
            current === '0' || current === 'false' || current === 'no' || current === 'off'
              ? 'border-brand bg-brand text-text-inverse'
              : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
          }`}
        >
          ✕ Off
        </button>
      </div>
      <p className="text-[10px] text-text-quaternary leading-tight">
        Boolean columns stored as &quot;1&quot;/&quot;0&quot; or &quot;true&quot;/&quot;false&quot; both match. Need a custom literal? Use the &quot;Advanced filter&quot; type instead.
      </p>
    </div>
  );
}

// "Advanced filter" on a text/dropdown column — exposes the full operator
// menu (eq / ne / contains / starts_with / ends_with / is_null /
// is_not_null) and a value field. Power-user mode; for the common cases
// DA picks Dropdown / Input directly.
function StringAdvancedBody({
  filter: f,
  onUpdateValue,
  onUpdateOperator,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
}) {
  const op = f.operator;
  const value = typeof f.value === 'string' ? f.value : '';
  const usesValue = !(op === 'is_null' || op === 'is_not_null');
  return (
    <div className="space-y-2">
      <select
        value={op}
        onChange={(e) => onUpdateOperator(e.target.value as FilterOperator)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
      >
        <option value="eq">= equals</option>
        <option value="ne">≠ not equals</option>
        <option value="contains">⊂ contains</option>
        <option value="starts_with">⊂ starts with</option>
        <option value="ends_with">⊃ ends with</option>
        <option value="is_null">∅ is empty</option>
        <option value="is_not_null">≠∅ is not empty</option>
      </select>
      {usesValue && (
        <input
          type="text"
          value={value}
          onChange={(e) => onUpdateValue(e.target.value)}
          placeholder="Value..."
          className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
      )}
    </div>
  );
}

function NumberBody({
  filter: f,
  onUpdateValue,
  onUpdateOperator,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
}) {
  return (
    <div className="space-y-2">
      <select
        value={f.operator}
        onChange={e => onUpdateOperator(e.target.value as FilterOperator)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
      >
        <option value="eq">= equals</option>
        <option value="neq">≠ not equals</option>
        <option value="gt">&gt; greater than</option>
        <option value="gte">≥ greater or equal</option>
        <option value="lt">&lt; less than</option>
        <option value="lte">≤ less or equal</option>
        <option value="between">↔ between</option>
        <option value="is_null">∅ is empty</option>
        <option value="is_not_null">≠∅ is not empty</option>
      </select>
      {f.operator === 'is_null' || f.operator === 'is_not_null' ? null : f.operator === 'between' ? (
        <NumberRangeBody filter={f} onUpdateValue={onUpdateValue} />
      ) : (
        <input
          type="number"
          value={typeof f.value === 'number' ? f.value : f.value ?? ''}
          onChange={e => onUpdateValue(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder="Enter value..."
          className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
      )}
    </div>
  );
}

// ── Date filter body ────────────────────────────────────────────
function DateBody({
  filter: f,
  onUpdateValue,
  onUpdateOperator,
  onUpdateDatePreset,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
  onUpdateDatePreset: (preset: DatePreset) => void;
}) {
  const activePreset = f.datePreset ?? 'custom';
  const isCustom = activePreset === 'custom';

  return (
    <div className="space-y-2">
      {/* ── Date preset selector ──────────────────────────── */}
      <select
        value={activePreset}
        onChange={e => onUpdateDatePreset(e.target.value as DatePreset)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs font-medium text-teal-700 outline-none focus:ring-1 focus:ring-teal-400"
      >
        {(Object.entries(DATE_PRESET_LABELS) as [DatePreset, string][]).map(([key, label]) => (
          <option key={key} value={key}>{label}</option>
        ))}
      </select>

      {/* ── Operator + manual date inputs (only when custom) ── */}
      {isCustom && (
        <>
          <select
            value={f.operator}
            onChange={e => onUpdateOperator(e.target.value as FilterOperator)}
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="between">↔ between dates</option>
            <option value="eq">= on date</option>
            <option value="gt">&gt; after</option>
            <option value="gte">≥ on or after</option>
            <option value="lt">&lt; before</option>
            <option value="lte">≤ on or before</option>
            <option value="is_null">∅ is empty</option>
            <option value="is_not_null">≠∅ is not empty</option>
          </select>
          {f.operator === 'is_null' || f.operator === 'is_not_null' ? null : f.operator === 'between' ? (
            <div className="space-y-1.5">
              <DateInput
                value={Array.isArray(f.value) ? f.value[0] ?? '' : ''}
                onChange={d => onUpdateValue([d, Array.isArray(f.value) ? f.value[1] ?? '' : ''])}
                placeholder="From date DD/MM/YYYY"
              />
              <DateInput
                value={Array.isArray(f.value) ? f.value[1] ?? '' : ''}
                onChange={d => onUpdateValue([Array.isArray(f.value) ? f.value[0] ?? '' : '', d])}
                placeholder="To date DD/MM/YYYY"
              />
            </div>
          ) : (
            <DateInput
              value={typeof f.value === 'string' ? f.value : ''}
              onChange={d => onUpdateValue(d)}
              placeholder="DD/MM/YYYY"
            />
          )}
        </>
      )}

      {/* ── Computed range preview (non-custom) ──────────── */}
      {!isCustom && Array.isArray(f.value) && f.value[0] && (
        <p className="text-[11px] text-text-tertiary">
          {f.value[0]} → {f.value[1]}
        </p>
      )}
    </div>
  );
}
