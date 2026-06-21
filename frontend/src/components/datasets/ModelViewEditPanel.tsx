'use client';

/**
 * ModelViewEditPanel — Static panel for semantic dictionary, fields, and measures.
 *
 * Layout: always visible beside the ERD canvas in a split-pane.
 * Two tabs:
 *   Dictionary — TableNotesBar + column meanings grid
 *   Fields     — Dimensions & Measures editor
 *
 * Single "Save" button; context-aware — saves whichever tab has unsaved changes.
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  Hash,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sigma,
  ToggleLeft,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import {
  useUpdateModelView,
  useDeleteModelMeasure,
  dryRunMeasure,
  previewMeasure,
  type MeasurePreviewResult,
  type DatasetModelView,
  type DimensionDefinition,
  type MeasureDefinition,
  type MeasureFilter,
  type MeasureFilterOperator,
  type MeasureFormat,
  type ContextModifier,
} from '@/hooks/use-dataset-model';
import {
  useDatasetDictionary,
  useUpdateDatasetDictionary,
  type DatasetDictionary,
  type DatasetDictionaryColumnNote,
  type DatasetDictionaryTableNote,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { usePreviewTableDescription, type TableDescriptionPreview } from '@/hooks/useDescription';
import { useLocalDraft } from '@/hooks/use-local-draft';
import { AiDescriptionDiffModal } from './AiDescriptionDiffModal';
import { AppModalShell } from '@/components/common/AppModalShell';
import { MeasureExpressionEditor, type ExprSuggestion } from './MeasureExpressionEditor';
import { toast } from '@/lib/toast';
import { extractApiError } from '@/lib/api-errors';
import { useI18n } from '@/providers/LanguageProvider';
import {
  buildPayload,
  DataTypeBadge,
  emptyColumn,
  emptyTable,
  mergeColumnDescriptions,
  normalizeDictionary,
  tableColumnsMeta,
  TableNotesBar,
  tableLabel,
  TokenEditor,
} from './dataset-catalog-shared';

// ─── Constants ────────────────────────────────────────────────────────────────

const DIM_TYPES = ['string', 'number', 'date', 'datetime', 'yesno'] as const;
const MEASURE_TYPES = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'count_distinct',
  'percent_of_total',
] as const;
const MEASURE_TYPE_LABEL: Record<(typeof MEASURE_TYPES)[number], string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  count_distinct: 'Count Distinct',
  percent_of_total: '% of Total',
};

const FILTER_OPERATORS: {
  value: MeasureFilterOperator;
  label: string;
  needsValue: boolean;
  isList?: boolean;
  isRange?: boolean;
}[] = [
  { value: 'eq', label: '=', needsValue: true },
  { value: 'ne', label: '≠', needsValue: true },
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '≥', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '≤', needsValue: true },
  { value: 'in', label: 'in', needsValue: true, isList: true },
  { value: 'not_in', label: 'not in', needsValue: true, isList: true },
  { value: 'between', label: 'between', needsValue: true, isRange: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true },
  { value: 'ends_with', label: 'ends with', needsValue: true },
  { value: 'is_null', label: 'is empty', needsValue: false },
  { value: 'is_not_null', label: 'is not empty', needsValue: false },
];

const FORMAT_KINDS: MeasureFormat['kind'][] = ['number', 'currency', 'percent', 'duration', 'custom'];

type MeasureTemplate = {
  key: string;
  label: string;
  /**
   * Phase-15.2: 'cross' = cross-table (dataset-scope) measure template.
   * Promotes the Phase-12 feature out of the Advanced section so DA
   * sees it as a first-class option alongside Basic + Time intelligence.
   */
  group: 'basic' | 'time' | 'cross';
  hint?: string;
  build: (n: number) => MeasureDefinition;
};

/**
 * Time-intelligence templates pre-fill the Advanced `expression` field with
 * dialect-friendly SQL. DuckDB syntax is the default since synced datasets
 * land in DuckDB; the comment inside each expression flags the column user
 * must point at (e.g. `${TABLE}.order_date`) so the SQL stays human-editable.
 *
 * Aggregating column placeholder is `<value_col>` — the template builder
 * inserts the user-friendly hint into the description so it's obvious what
 * to replace before saving. We do NOT auto-pick a column because measures
 * span many tables and the right choice depends on intent.
 */
const MEASURE_TEMPLATES: MeasureTemplate[] = [
  // ── Basic aggregations ────────────────────────────────────────────────
  // B2 (2026-06-10): labels phrased as INTENTS ("Đếm số dòng") + a one-line
  // hint, so the picker reads as "what do you want to do" — not as a second
  // copy of the Aggregation dropdown. This kills the DA confusion of
  // "Sum of column" (picker) vs "Sum" (agg dropdown) looking like the same
  // thing. The agg TYPE lives only inside the form's Aggregation select.
  { key: 'count', label: 'Đếm số dòng', group: 'basic', hint: 'Số bản ghi (COUNT *)', build: (n) => ({ name: `count_${n}`, label: 'Count', type: 'count', sql: '*', hidden: false }) },
  { key: 'sum', label: 'Tính tổng một cột', group: 'basic', hint: 'Cộng dồn giá trị một cột số (SUM)', build: (n) => ({ name: `sum_${n}`, label: 'Sum', type: 'sum', sql: '', hidden: false }) },
  { key: 'avg', label: 'Tính trung bình một cột', group: 'basic', hint: 'Giá trị trung bình một cột số (AVG)', build: (n) => ({ name: `avg_${n}`, label: 'Average', type: 'avg', sql: '', hidden: false }) },
  { key: 'distinct', label: 'Đếm giá trị khác nhau', group: 'basic', hint: 'Số giá trị duy nhất (COUNT DISTINCT)', build: (n) => ({ name: `distinct_${n}`, label: 'Unique count', type: 'count_distinct', sql: '', hidden: false }) },
  {
    key: 'filtered',
    label: 'Đếm có điều kiện',
    group: 'basic',
    hint: 'Vd. số đơn đã thanh toán — đếm các dòng thỏa filter',
    build: (n) => ({
      name: `filtered_count_${n}`,
      label: 'Filtered count',
      type: 'count',
      sql: '*',
      filters: [{ field: '', operator: 'eq', value: '' }],
      hidden: false,
    }),
  },
  { key: 'pct', label: 'Tỷ lệ phần trăm trên tổng', group: 'basic', hint: 'Mỗi nhóm chiếm bao nhiêu % của tổng (% of total)', build: (n) => ({ name: `pct_${n}`, label: '% of total', type: 'percent_of_total', sql: '', hidden: false }) },

  // ── Time intelligence ─────────────────────────────────────────────────
  // Phase-5: templates dùng dialect-agnostic macros (resolved bởi engine).
  //   ${TODAY}             → hôm nay
  //   ${MONTH_START}       → đầu tháng hiện tại
  //   ${YEAR_START}        → đầu năm hiện tại
  //   ${PREV_MONTH_START}  → đầu tháng trước
  //   ${DAYS_AGO:N}        → ngày cách hôm nay N ngày
  // Engine tự dịch sang DuckDB / PostgreSQL / BigQuery / MySQL — user
  // không cần viết SQL riêng cho từng dialect.
  {
    key: 'mtd',
    label: 'Month-to-date (MTD)',
    group: 'time',
    hint: 'Tổng từ đầu tháng đến hôm nay — thay <value_col> và <date_col>',
    build: (n) => ({
      name: `mtd_${n}`,
      label: 'MTD',
      type: 'sum',
      sql: '<value_col>',
      expression: 'CASE WHEN ${TABLE}.<date_col> >= ${MONTH_START} AND ${TABLE}.<date_col> <= ${TODAY} THEN ${TABLE}.<value_col> ELSE 0 END',
      hidden: false,
    }),
  },
  {
    key: 'ytd',
    label: 'Year-to-date (YTD)',
    group: 'time',
    hint: 'Tổng từ đầu năm đến hôm nay',
    build: (n) => ({
      name: `ytd_${n}`,
      label: 'YTD',
      type: 'sum',
      sql: '<value_col>',
      expression: 'CASE WHEN ${TABLE}.<date_col> >= ${YEAR_START} AND ${TABLE}.<date_col> <= ${TODAY} THEN ${TABLE}.<value_col> ELSE 0 END',
      hidden: false,
    }),
  },
  {
    key: 'yoy',
    label: 'Same period last year (YoY)',
    group: 'time',
    hint: 'Tổng cùng kỳ năm trước — kết hợp với MTD/YTD để so sánh',
    build: (n) => ({
      name: `yoy_${n}`,
      label: 'Last year same period',
      type: 'sum',
      sql: '<value_col>',
      expression: 'CASE WHEN ${TABLE}.<date_col> >= ${PREV_YEAR_START} AND ${TABLE}.<date_col> < ${YEAR_START} THEN ${TABLE}.<value_col> ELSE 0 END',
      hidden: false,
    }),
  },
  {
    key: 'mom',
    label: 'Previous month',
    group: 'time',
    hint: 'Tổng cả tháng trước',
    build: (n) => ({
      name: `prev_month_${n}`,
      label: 'Previous month',
      type: 'sum',
      sql: '<value_col>',
      expression: 'CASE WHEN ${TABLE}.<date_col> >= ${PREV_MONTH_START} AND ${TABLE}.<date_col> < ${MONTH_START} THEN ${TABLE}.<value_col> ELSE 0 END',
      hidden: false,
    }),
  },
  {
    key: 'last_n_days',
    label: 'Last 30 days',
    group: 'time',
    hint: 'Tổng 30 ngày gần nhất (sửa số 30 trong ${DAYS_AGO:30})',
    build: (n) => ({
      name: `last_30d_${n}`,
      label: 'Last 30 days',
      type: 'sum',
      sql: '<value_col>',
      expression: 'CASE WHEN ${TABLE}.<date_col> >= ${DAYS_AGO:30} AND ${TABLE}.<date_col> <= ${TODAY} THEN ${TABLE}.<value_col> ELSE 0 END',
      hidden: false,
    }),
  },
  {
    key: 'rolling_avg_7',
    label: 'Rolling 7-day average',
    group: 'time',
    hint: 'Trung bình 7 ngày — nên kết hợp với time_grain=day khi consume',
    build: (n) => ({
      name: `rolling_7d_avg_${n}`,
      label: 'Rolling 7d avg',
      type: 'avg',
      sql: '<value_col>',
      expression: 'CASE WHEN ${TABLE}.<date_col> >= ${DAYS_AGO:7} AND ${TABLE}.<date_col> <= ${TODAY} THEN ${TABLE}.<value_col> END',
      hidden: false,
    }),
  },

  // ── Cross-table (dataset-scope) ─────────────────────────────────────────
  // Phase-15.2: Phase-12 đã có scope='dataset' nhưng vùi trong Advanced.
  // Đây là entry point first-class — tạo measure đa bảng (PowerBI parity:
  // USERELATIONSHIP / CALCULATE qua nhiều table). DA chọn template này →
  // skeleton có sẵn scope='dataset' + expression mẫu + 1 source_columns
  // entry trống để fill. Phần còn lại edit như measure thường.
  {
    key: 'cross_ratio',
    label: 'Cross-table ratio (đa bảng)',
    group: 'cross',
    hint: 'Tỷ lệ giữa cột từ 2 bảng khác nhau — engine tự JOIN qua relationship',
    build: (n) => ({
      name: `cross_ratio_${n}`,
      label: 'Cross-table ratio',
      type: 'sum',
      sql: '',
      expression: '${view_a.col_a} / NULLIF(COUNT(DISTINCT ${view_b.col_b}), 0)',
      scope: 'dataset',
      source_columns: [
        { view: '', field: '' },
        { view: '', field: '' },
      ],
      hidden: false,
    }),
  },
  {
    key: 'cross_sum',
    label: 'Cross-table sum (đa bảng)',
    group: 'cross',
    hint: 'Tổng 1 cột từ bảng khác base view — engine JOIN tự động',
    build: (n) => ({
      name: `cross_sum_${n}`,
      label: 'Cross-table sum',
      type: 'sum',
      sql: '',
      // RAW column reference — `type: 'sum'` wraps it (→ SUM(${other_view.col})).
      // Must NOT pre-fill `SUM(...)` here: the advanced-SQL validator rejects an
      // aggregate inside the expression (the aggregation dropdown is what wraps),
      // so a pre-filled SUM made the template show an error out of the box.
      expression: '${other_view.col}',
      scope: 'dataset',
      source_columns: [
        { view: '', field: '' },
      ],
      hidden: false,
    }),
  },
];

// ─── Measure name helpers ───────────────────────────────────────────────────

/** Slugify a display label into a valid SQL identifier. */
function slugifyName(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[0-9]/, '_$&')
    .replace(/^_+|_+$/g, '');
  return slug || 'measure';
}

/** Returns true when the name still looks like a template auto-generated default
 *  (e.g. count_0, sum_3) or when it exactly equals the slugified version of
 *  the current label — meaning the user has not overridden it. */
function isAutoName(name: string, label?: string): boolean {
  if (/^(count|sum|avg|min|max|distinct|filtered_count|pct)_\d+$/.test(name)) return true;
  if (label) return name === slugifyName(label);
  return false;
}

export type PanelTab = 'dictionary' | 'fields';
type PanelContentMode = 'all-fields' | 'measures';

/** E2: sentinel value of focusMeasureName meaning "add a new blank measure".
 *  Deterministic add-mode signal from the page — avoids effect-timing races. */
const NEW_MEASURE_SENTINEL = '__new__';

// ─── ColumnCombobox (C1) ────────────────────────────────────────────────────
//
// DA feedback (2026-06-10): "cho chọn cột thay vì bắt điền free-text thì đỡ
// sai, nhưng vẫn cho điền rồi gợi ý để tích cho nhanh và tránh sai tên".
//
// A type-to-filter combobox that PICKS from a known list but still ACCEPTS
// free text (a column the cache hasn't surfaced yet, or a SQL snippet). Modeled
// on the proven SearchableSelect in DatasetQualityPanel so the datasets domain
// stays consistent. Differences:
//   • free text allowed — typing commits on blur/Enter even with no match, so
//     we never block a power user (matches the old <input>/<datalist> freedom).
//   • optional per-option `category` icon (column vs measure) for the future
//     expression picker; here it just renders a mono label.
//
// Behaviour: focus opens the list; typing filters; click / Enter picks the
// highlighted option; Escape closes keeping the current value; clicking away
// commits whatever text is in the box (so a half-typed valid column name is
// kept, not discarded).
function ColumnCombobox({
  value,
  options,
  onChange,
  placeholder,
  invalid,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Commit the typed query as free text if the user was typing something
        // not yet committed; otherwise keep value. Then close.
        if (query.trim() && query.trim() !== value) onChange(query.trim());
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, query, value, onChange]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter((o) => o.toLowerCase().includes(normalizedQuery))
    : options;

  function selectValue(v: string) {
    onChange(v);
    setOpen(false);
    setQuery('');
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setFocusIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter picks the highlighted option, or commits free text if the user
      // typed something with no exact match (power-user escape hatch).
      if (filtered[focusIdx] && (normalizedQuery === '' || filtered.length > 0)) {
        selectValue(filtered[focusIdx]);
      } else if (query.trim()) {
        selectValue(query.trim());
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  const displayValue = open ? query : value;

  return (
    <div ref={containerRef} className="relative">
      <div className={`flex items-center gap-1.5 rounded-md border bg-surface-1 px-2 py-1.5 focus-within:ring-1 ${
        invalid ? 'border-danger/60 focus-within:ring-danger/40' : 'border-[rgb(var(--border-line))] focus-within:ring-brand'
      }`}>
        <Search className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onFocus={() => { setOpen(true); setFocusIdx(0); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setFocusIdx(0); }}
          onKeyDown={handleKey}
          // Commit typed free text when leaving the field (e.g. tab away).
          onBlur={() => { if (query.trim() && query.trim() !== value) onChange(query.trim()); }}
          placeholder={placeholder ?? t('datasets.columnCombobox.placeholderCount', { count: String(options.length) })}
          className="w-full bg-transparent text-xs font-mono focus:outline-none"
        />
        {value && !open && (
          <button
            type="button"
            onClick={() => { onChange(''); inputRef.current?.focus(); }}
            className="text-text-quaternary hover:text-text-secondary shrink-0"
            aria-label={t('datasets.columnCombobox.clear')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-md">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-text-quaternary">
              {t('datasets.columnCombobox.noMatchPrefix')}"<span className="font-mono">{query.trim()}</span>"{t('datasets.columnCombobox.noMatchSuffix')}
            </p>
          ) : (
            filtered.map((opt, idx) => (
              <button
                key={opt}
                type="button"
                onMouseEnter={() => setFocusIdx(idx)}
                onClick={() => selectValue(opt)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left ${
                  idx === focusIdx ? 'bg-surface-2' : 'hover:bg-surface-2'
                }`}
              >
                {/* chip style — column reads clearly as a tag, not plain text */}
                <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-[11px] font-mono text-brand min-w-0">
                  <Hash className="w-3 h-3 shrink-0" />
                  <span className="truncate">{opt}</span>
                </span>
                {opt === value && <Check className="h-3.5 w-3.5 text-brand shrink-0" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── DimIcon ──────────────────────────────────────────────────────────────────

function DimIcon({ type }: { type: string }) {
  switch (type) {
    case 'number':   return <Hash className="w-3.5 h-3.5 text-brand shrink-0" />;
    case 'date':
    case 'datetime': return <ChevronRight className="w-3.5 h-3.5 text-success shrink-0" />;
    case 'yesno':    return <ToggleLeft className="w-3.5 h-3.5 text-brand shrink-0" />;
    default:         return <Type className="w-3.5 h-3.5 text-text-quaternary shrink-0" />;
  }
}

// ─── ColumnMeaningDrawer ───────────────────────────────────────────────────────

function ColumnMeaningDrawer({
  open,
  tableName,
  note,
  canEdit,
  onClose,
  onChange,
  onRemove,
}: {
  open: boolean;
  tableName: string;
  note: DatasetDictionaryColumnNote | null;
  canEdit: boolean;
  onClose: () => void;
  onChange: (updater: (cur: DatasetDictionaryColumnNote) => DatasetDictionaryColumnNote) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  if (!open || !note) return null;

  return (
    <AppModalShell
      onClose={onClose}
      title={note.column_name}
      description={`${tableName} · ${t('datasets.columnDrawer.dictionarySuffix')}`}
      icon={<Pencil className="h-5 w-5" />}
      maxWidthClass="max-w-lg"
      panelClassName="max-h-[75vh]"
      footer={
        <>
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="mr-auto inline-flex items-center gap-1.5 rounded-md border border-danger/30 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> {t('common.delete')}
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2">
            {t('datasets.columnDrawer.close')}
          </button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary uppercase tracking-wide">{t('datasets.columnDrawer.businessName')}</label>
          <input
            value={note.business_name ?? ''}
            onChange={(e) => onChange((cur) => ({ ...cur, business_name: e.target.value }))}
            disabled={!canEdit}
            placeholder={t('datasets.columnDrawer.businessNamePlaceholder')}
            className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary uppercase tracking-wide">{t('datasets.columnDrawer.description')}</label>
          <textarea
            rows={4}
            value={note.description ?? ''}
            onChange={(e) => onChange((cur) => ({ ...cur, description: e.target.value }))}
            disabled={!canEdit}
            placeholder={t('datasets.columnDrawer.descriptionPlaceholder')}
            className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2 resize-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary uppercase tracking-wide">{t('datasets.columnDrawer.examples')}</label>
          <TokenEditor values={note.examples ?? []} onChange={(values) => onChange((cur) => ({ ...cur, examples: values }))} placeholder={t('datasets.columnDrawer.examplesPlaceholder')} disabled={!canEdit} />
        </div>
      </div>
    </AppModalShell>
  );
}

// ─── DictionaryColumnGrid ─────────────────────────────────────────────────────

function DictionaryColumnGrid({
  table,
  tableNote,
  canEdit,
  isSaving,
  onPatchDictionary,
}: {
  table: DatasetTable;
  tableNote: DatasetDictionaryTableNote;
  canEdit: boolean;
  isSaving: boolean;
  onPatchDictionary: (updater: (current: DatasetDictionary) => DatasetDictionary) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [activeColumn, setActiveColumn] = useState<string | null>(null);

  const columnsMeta = useMemo(() => tableColumnsMeta(table), [table]);

  const visible = useMemo(
    () => columnsMeta.filter(({ name }) => {
      const note = tableNote.column_notes.find((n) => n.column_name === name);
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return [name, note?.business_name ?? '', note?.description ?? ''].join(' ').toLowerCase().includes(q);
    }),
    [columnsMeta, tableNote.column_notes, search],
  );

  const activeNote = tableNote.column_notes.find((n) => n.column_name === activeColumn) ?? null;

  const openModal = (column: string) => {
    const note = tableNote.column_notes.find((n) => n.column_name === column);
    if (!note && canEdit) {
      onPatchDictionary((current) => ({
        ...current,
        table_notes: current.table_notes.map((item) =>
          item.table_id === tableNote.table_id
            ? { ...item, column_notes: [...item.column_notes, emptyColumn(column)] }
            : item,
        ),
      }));
    }
    if (note || canEdit) setActiveColumn(column);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2 shrink-0">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('datasets.dictionaryGrid.searchColumns')}
            className="w-full rounded-md border border-[rgb(var(--border-line))] py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <span className="text-[11px] text-text-quaternary shrink-0">{t('datasets.dictionaryGrid.colsCount', { count: String(columnsMeta.length) })}</span>
      </div>

      {/* Column list */}
      <div className="flex-1 overflow-y-auto">
        {columnsMeta.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-xs text-text-quaternary">{t('datasets.dictionaryGrid.noMetadata')}</div>
        ) : visible.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-xs text-text-quaternary">{t('datasets.dictionaryGrid.noColumnsMatch')}</div>
        ) : (
          <table className="min-w-full">
            <thead className="sticky top-0 z-10 border-b border-[rgb(var(--border-line))] bg-surface-2">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">{t('datasets.dictionaryGrid.columnHeader')}</th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">{t('datasets.dictionaryGrid.descriptionHeader')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
              {visible.map(({ name: column, type: colType }) => {
                const note = tableNote.column_notes.find((n) => n.column_name === column);
                const documented = !!note;
                const hasDesc = !!(note?.description?.trim());
                const hasBizName = !!(note?.business_name?.trim());

                return (
                  <tr key={column} className="group hover:bg-brand/15/40 transition-colors">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={documented}
                        disabled={!canEdit || isSaving}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          onPatchDictionary((current) => ({
                            ...current,
                            table_notes: current.table_notes.map((item) =>
                              item.table_id !== tableNote.table_id ? item : {
                                ...item,
                                column_notes: checked
                                  ? item.column_notes.find((entry) => entry.column_name === column)
                                    ? item.column_notes
                                    : [...item.column_notes, emptyColumn(column)]
                                  : item.column_notes.filter((entry) => entry.column_name !== column),
                              },
                            ),
                          }));
                          if (!checked && activeColumn === column) setActiveColumn(null);
                        }}
                        className="h-3.5 w-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
                        title={documented ? t('datasets.dictionaryGrid.removeFromCatalog') : t('datasets.dictionaryGrid.addToCatalog')}
                      />
                    </td>
                    <td className="px-3 py-2 min-w-[140px]">
                      <button type="button" onClick={() => openModal(column)} className="text-left w-full">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-medium text-text-primary group-hover:text-brand truncate">{column}</span>
                          {colType && <DataTypeBadge type={colType} />}
                        </div>
                        {hasBizName ? (
                          <div className="mt-0.5 text-[11px] text-text-quaternary truncate">{note!.business_name}</div>
                        ) : documented ? (
                          <div className="mt-0.5 text-[11px] text-text-quaternary italic">{t('datasets.dictionaryGrid.addName')}</div>
                        ) : null}
                      </button>
                    </td>
                    <td className="px-3 py-2 max-w-[200px]">
                      {documented ? (
                        <button type="button" onClick={() => openModal(column)} className="text-left w-full">
                          {hasDesc ? (
                            <p className="line-clamp-2 text-[11px] text-text-secondary leading-relaxed">{note!.description}</p>
                          ) : (
                            <span className="text-[11px] text-warning italic">{t('datasets.dictionaryGrid.noDescription')}</span>
                          )}
                        </button>
                      ) : (
                        <span className="text-[11px] text-text-quaternary">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Column drawer */}
      <ColumnMeaningDrawer
        open={Boolean(activeColumn && activeNote)}
        tableName={tableLabel(table)}
        note={activeNote}
        canEdit={canEdit && !isSaving}
        onClose={() => setActiveColumn(null)}
        onChange={(updater) => {
          if (!activeColumn) return;
          onPatchDictionary((current) => ({
            ...current,
            table_notes: current.table_notes.map((item) =>
              item.table_id !== tableNote.table_id ? item : {
                ...item,
                column_notes: item.column_notes.map((entry) =>
                  entry.column_name === activeColumn ? updater(entry) : entry,
                ),
              },
            ),
          }));
        }}
        onRemove={() => {
          if (!activeColumn) return;
          onPatchDictionary((current) => ({
            ...current,
            table_notes: current.table_notes.map((item) =>
              item.table_id !== tableNote.table_id ? item : {
                ...item,
                column_notes: item.column_notes.filter((entry) => entry.column_name !== activeColumn),
              },
            ),
          }));
          setActiveColumn(null);
        }}
      />
    </div>
  );
}

// ─── DimensionRow ─────────────────────────────────────────────────────────────

function DimensionRow({
  dim,
  canEdit,
  columnOptions,
  rowKey,
  /**
   * Phase-15.1: names of OTHER dimensions on the same view so user can
   * pick a parent for hierarchy / drill-down (e.g. month.parent = "year").
   * Excludes the current dim's own name to prevent self-reference at the
   * UI level (BE validator also blocks).
   */
  siblingDimNames,
  onChange,
  onRemove,
}: {
  dim: DimensionDefinition;
  canEdit: boolean;
  columnOptions: string[];
  rowKey: string;
  siblingDimNames: string[];
  onChange: (updated: DimensionDefinition) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const colsListId = `__dim_cols_${rowKey}`;

  // Dimension = pure column mapping. Editing `name` IS editing which column
  // this dimension points to; keep `sql` in lock-step so the backend
  // validator (sql must equal name) is always satisfied.
  const updateColumn = (next: string) =>
    onChange({ ...dim, name: next, sql: next || undefined });

  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setIsExpanded(!isExpanded)} className="text-text-quaternary hover:text-text-secondary shrink-0">
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <DimIcon type={dim.type} />
        <span className="text-sm text-text-primary truncate flex-1">{dim.label || dim.name}</span>
        <span className="text-[10px] text-text-quaternary bg-surface-2 px-1.5 py-0.5 rounded uppercase">{dim.type}</span>
        {canEdit && (
          <>
            <button
              onClick={() => onChange({ ...dim, hidden: !dim.hidden })}
              className="p-0.5 hover:bg-surface-2 rounded shrink-0"
              title={dim.hidden ? t('datasets.fields.show') : t('datasets.fields.hide')}
            >
              {dim.hidden
                ? <EyeOff className="w-3.5 h-3.5 text-text-quaternary" />
                : <Eye className="w-3.5 h-3.5 text-text-quaternary" />}
            </button>
            <button onClick={onRemove} className="p-0.5 hover:bg-danger/10 rounded text-text-quaternary hover:text-danger shrink-0">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
      {isExpanded && canEdit && (
        <div className="px-3 pb-3 pt-1 border-t border-[rgb(var(--border-line))] space-y-2.5">
          <datalist id={colsListId}>
            {columnOptions.map((c) => <option key={c} value={c} />)}
          </datalist>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">{t('datasets.dimensionRow.column')}</label>
              <input
                list={colsListId}
                value={dim.name}
                onChange={(e) => updateColumn(e.target.value)}
                className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder={t('datasets.dimensionRow.pickColumn')}
                title={t('datasets.dimensionRow.columnHint')}
              />
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">{t('datasets.dimensionRow.type')}</label>
              <select value={dim.type} onChange={(e) => onChange({ ...dim, type: e.target.value as DimensionDefinition['type'] })} className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand">
                {DIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-text-tertiary uppercase font-medium">{t('datasets.dimensionRow.label')}</label>
            <input value={dim.label || ''} onChange={(e) => onChange({ ...dim, label: e.target.value || undefined })} className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand" placeholder={t('datasets.dimensionRow.displayLabel')} />
          </div>
          {/* Phase-15.1: drill-down parent. Pure metadata — FE Explore uses
              it to surface a "↓ Drill into <child>" action when the chart
              groups by this dim. BE validator rejects self-reference and
              hierarchy cycles. Leave blank for a root-level dim. */}
          <div>
            <label className="text-[10px] text-text-tertiary uppercase font-medium flex items-center gap-1">
              {t('datasets.dimensionRow.parentDrilldown')}
              <span className="font-normal normal-case text-[9px] text-text-quaternary">
                {t('datasets.dimensionRow.parentHint')}
              </span>
            </label>
            <select
              value={dim.parent ?? ''}
              onChange={(e) => onChange({ ...dim, parent: e.target.value || undefined })}
              className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="">{t('datasets.dimensionRow.rootDimension')}</option>
              {siblingDimNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <p className="text-[10px] italic text-text-quaternary leading-4">
            {t('datasets.dimensionRow.mappingNotePrefix')} <span className="font-medium text-text-tertiary">{t('datasets.dimensionRow.addCalculatedColumn')}</span> {t('datasets.dimensionRow.mappingNoteSuffix')}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── MeasureFilterRow ────────────────────────────────────────────────────────

function MeasureFilterRow({
  filter,
  listId,
  columnOptions,
  onChange,
  onRemove,
}: {
  filter: MeasureFilter;
  listId: string;
  columnOptions: string[];
  onChange: (updated: MeasureFilter) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const opSpec = FILTER_OPERATORS.find((o) => o.value === filter.operator) ?? FILTER_OPERATORS[0];
  const isMulti = opSpec.isList || opSpec.isRange;
  const valueAsString = (() => {
    if (filter.value == null) return '';
    if (Array.isArray(filter.value)) return filter.value.join(', ');
    return String(filter.value);
  })();

  // For list/range operators the value is stored as a parsed array, but the
  // INPUT must keep the raw text the user is typing. Deriving the displayed
  // value from `array.join(', ')` on every keystroke stripped a trailing comma
  // (`split(',').filter(Boolean)` drops the empty tail), so a comma typed right
  // after a value was eaten — you couldn't add the separator before the next
  // item without first inserting+deleting another char. We hold the raw text
  // locally, parse to the array only for storage, and re-seed the local text
  // only when the value changes from OUTSIDE this input (operator switch / row
  // re-init), tracked via `lastEmittedRef`.
  const [rawValue, setRawValue] = useState(valueAsString);
  const lastEmittedRef = useRef(valueAsString);
  useEffect(() => {
    if (valueAsString !== lastEmittedRef.current) {
      setRawValue(valueAsString);
      lastEmittedRef.current = valueAsString;
    }
  }, [valueAsString]);

  return (
    <div className="flex items-center gap-1.5">
      {/* C1: filter field is a combobox (chọn cột, tránh sai tên; vẫn cho gõ). */}
      <div className="flex-1 min-w-0">
        <ColumnCombobox
          value={filter.field}
          options={columnOptions}
          onChange={(v) => onChange({ ...filter, field: v })}
          placeholder={t('datasets.measureFilter.pickColumn')}
        />
      </div>
      <select
        value={filter.operator}
        onChange={(e) => onChange({ ...filter, operator: e.target.value as MeasureFilterOperator })}
        className="text-xs px-1.5 py-1 border border-[rgb(var(--border-line))] rounded bg-surface-1 shrink-0 focus:outline-none focus:ring-1 focus:ring-brand"
      >
        {FILTER_OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {opSpec.needsValue && (
        <input
          value={isMulti ? rawValue : valueAsString}
          onChange={(e) => {
            const raw = e.target.value;
            if (isMulti) {
              setRawValue(raw);
              const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
              // Remember what we emit so the resync effect doesn't clobber the
              // raw text (incl. a trailing comma) the user is still typing.
              lastEmittedRef.current = parsed.join(', ');
              onChange({ ...filter, value: parsed });
            } else {
              lastEmittedRef.current = raw;
              onChange({ ...filter, value: raw });
            }
          }}
          placeholder={opSpec.isList ? t('datasets.measureFilter.placeholderList') : opSpec.isRange ? t('datasets.measureFilter.placeholderRange') : t('datasets.measureFilter.placeholderValue')}
          className="flex-1 min-w-0 text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
        />
      )}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-danger/10 rounded text-text-quaternary hover:text-danger shrink-0"
        title={t('datasets.measureFilter.removeFilter')}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Filter Context Modifiers (Phase-14) ─────────────────────────────────────
//
// Renders the per-measure controls that turn a plain `SUM(amount)` into a
// SQL window aggregate (`SUM(amount) OVER (...)`). This is the "Filter
// Context" surface user mentioned — equivalent to PowerBI's
// CALCULATE/ALL/ALLEXCEPT/USERELATIONSHIP combo, but expressed as
// declarative modifiers that compile to SQL window functions on the BE.
//
// Hard rules (enforced both here and at BE save-time):
//   - 'all' and 'all_except' are mutually exclusive on the same measure
//     (they mean opposite things).
//   - 'all_except' requires at least one keep_field.
//   - 'use_relationship' requires a join_alias matching some
//     JoinDefinition.alias in the dataset's explore.
//
// What this component is NOT: a DAX editor. We deliberately keep this to
// 3 named patterns to stay within the project's "compile down to SQL"
// philosophy. Adding more patterns would re-introduce the same
// "user doesn't know which mechanism to pick" problem Phase-1 closed.

/**
 * Phase-15.4 — Filter Context preset-first UI.
 *
 * Replaces the raw-checkbox UI (Phase-14) with 4 named presets that map
 * to PowerBI patterns DAs already know. The Phase-14 schema underneath is
 * unchanged — these presets just shape context_modifiers correctly so DA
 * doesn't have to learn the modifier vocabulary. Raw modifier UI is moved
 * to an "Advanced" disclosure for power users.
 *
 * Presets:
 *   1. None (default)         — measure stays a plain aggregate
 *   2. % of grand total       — [{type: "all"}]
 *   3. % within ... (kept dim)— [{type: "all_except", keep_fields: [<dim>]}]
 *   4. Use named relationship — [{type: "use_relationship", join_alias: ...}]
 *
 * Detection of "which preset is active" reads the current
 * context_modifiers and matches against these shapes. Custom shapes
 * (e.g. multiple all_except entries) flow through Advanced.
 */
type FilterContextPreset = 'none' | 'grand_total' | 'within_kept' | 'use_relationship' | 'custom';

function detectPreset(modifiers: ContextModifier[]): FilterContextPreset {
  if (modifiers.length === 0) return 'none';
  const onlyTypes = new Set(modifiers.map((m) => m.type));
  if (modifiers.length === 1) {
    const m = modifiers[0];
    if (m.type === 'all') return 'grand_total';
    if (m.type === 'all_except' && (m.keep_fields?.length ?? 0) >= 1) return 'within_kept';
    if (m.type === 'use_relationship' && (m.join_alias ?? '').trim()) return 'use_relationship';
  }
  // Two-modifier safe combinations:
  if (
    modifiers.length === 2
    && onlyTypes.has('use_relationship')
    && (onlyTypes.has('all') || onlyTypes.has('all_except'))
  ) {
    // use_relationship is orthogonal — combine with all/all_except. Treat
    // the "main" preset as the non-use_relationship entry.
    const main = modifiers.find((m) => m.type !== 'use_relationship');
    if (main?.type === 'all') return 'grand_total';
    if (main?.type === 'all_except' && (main.keep_fields?.length ?? 0) >= 1) return 'within_kept';
  }
  return 'custom';
}

function FilterContextModifiers({
  measure,
  canEdit,
  onChange,
}: {
  measure: MeasureDefinition;
  canEdit: boolean;
  onChange: (next: MeasureDefinition) => void;
}) {
  const { t } = useI18n();
  const modifiers = measure.context_modifiers ?? [];
  const preset = detectPreset(modifiers);
  const [showAdvanced, setShowAdvanced] = useState(preset === 'custom');

  const setModifiers = (next: ContextModifier[]) => {
    onChange({
      ...measure,
      context_modifiers: next.length > 0 ? next : undefined,
    });
  };

  // Pure helpers for shaping modifiers per preset. Preserve any existing
  // use_relationship entry when switching between "main" presets — it's
  // orthogonal.
  const useRelEntry = modifiers.find((m) => m.type === 'use_relationship');
  const useRelTail = useRelEntry ? [useRelEntry] : [];

  const applyPreset = (next: FilterContextPreset, opts?: { keepField?: string; joinAlias?: string }) => {
    switch (next) {
      case 'none':
        setModifiers([]);
        return;
      case 'grand_total':
        setModifiers([{ type: 'all' }, ...useRelTail]);
        return;
      case 'within_kept': {
        const existingKept = modifiers.find((m) => m.type === 'all_except')?.keep_fields ?? [];
        const newField = opts?.keepField?.trim();
        const next_keep = newField
          ? [newField]  // single-field preset is the common case
          : existingKept;
        setModifiers([{ type: 'all_except', keep_fields: next_keep }, ...useRelTail]);
        return;
      }
      case 'use_relationship': {
        const alias = (opts?.joinAlias ?? useRelEntry?.join_alias ?? '').trim();
        setModifiers([{ type: 'use_relationship', join_alias: alias }]);
        return;
      }
      case 'custom':
        // No-op — selecting "Advanced (custom)" means user wants to keep
        // whatever they have and edit raw. Just flip the disclosure open.
        setShowAdvanced(true);
        return;
    }
  };

  const hasAll = modifiers.some((m) => m.type === 'all');
  const hasAllExcept = modifiers.some((m) => m.type === 'all_except');
  const hasUseRel = modifiers.some((m) => m.type === 'use_relationship');
  const keptField = modifiers.find((m) => m.type === 'all_except')?.keep_fields?.[0] ?? '';
  const useRelAlias = useRelEntry?.join_alias ?? '';

  const toggleAll = () => {
    if (hasAll) {
      setModifiers(modifiers.filter((m) => m.type !== 'all'));
    } else {
      const stripped = modifiers.filter((m) => m.type !== 'all_except');
      setModifiers([...stripped, { type: 'all' }]);
    }
  };
  const toggleAllExcept = () => {
    if (hasAllExcept) {
      setModifiers(modifiers.filter((m) => m.type !== 'all_except'));
    } else {
      const stripped = modifiers.filter((m) => m.type !== 'all');
      setModifiers([...stripped, { type: 'all_except', keep_fields: [] }]);
    }
  };
  const updateAllExceptKeep = (rawCsv: string) => {
    const keep = rawCsv.split(',').map((s) => s.trim()).filter(Boolean);
    setModifiers(
      modifiers.map((m) => (m.type === 'all_except' ? { ...m, keep_fields: keep } : m)),
    );
  };
  const toggleUseRel = () => {
    if (hasUseRel) {
      setModifiers(modifiers.filter((m) => m.type !== 'use_relationship'));
    } else {
      setModifiers([...modifiers, { type: 'use_relationship', join_alias: '' }]);
    }
  };
  const updateJoinAlias = (alias: string) => {
    setModifiers(
      modifiers.map((m) => (m.type === 'use_relationship' ? { ...m, join_alias: alias.trim() } : m)),
    );
  };
  const allExceptKeepCsv = (
    modifiers.find((m) => m.type === 'all_except')?.keep_fields ?? []
  ).join(', ');

  return (
    <div className="space-y-2 rounded-md border border-dashed border-[rgb(var(--border-line))] p-2">
      <div className="flex items-center justify-between">
        <div
          className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary"
          title={t('datasets.filterContext.headerTitle')}
        >
          {t('datasets.filterContext.header')}
        </div>
        {preset !== 'none' && (
          <span
            className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-emphasis uppercase text-purple-600 dark:text-purple-400"
            title={t('datasets.filterContext.activeBadgeTitle')}
          >
            {preset === 'custom' ? t('datasets.filterContext.custom') : t('datasets.filterContext.on')}
          </span>
        )}
      </div>
      {/* C2: the 3 big preset cards took a lot of vertical space for something
          90% of measures leave at "Mặc định". Collapsed to a single dropdown.
          B4's PowerBI/DAX names (ALL / ALLEXCEPT) ride inline in the option
          labels so a PBI-literate DA still recognises them. The
          USERELATIONSHIP preset stays out (schema-only) — reachable only via
          "Tuỳ chỉnh chi tiết" below. */}
      <select
        disabled={!canEdit}
        value={preset === 'custom' || preset === 'use_relationship' ? 'none' : preset}
        onChange={(e) => {
          const next = e.target.value as FilterContextPreset;
          if (next === 'within_kept') applyPreset('within_kept', { keepField: keptField || '' });
          else applyPreset(next);
        }}
        className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
        title={t('datasets.filterContext.selectTitle')}
      >
        <option value="none">{t('datasets.filterContext.optNone')}</option>
        <option value="grand_total">{t('datasets.filterContext.optGrandTotal')}</option>
        <option value="within_kept">{t('datasets.filterContext.optWithinKept')}</option>
      </select>

      {/* Inline param for "within ..." preset — single-field common case. */}
      {preset === 'within_kept' && (
        <div className="rounded-md bg-surface-2 p-1.5 space-y-1">
          <label className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
            {t('datasets.filterContext.keepDim')}
          </label>
          <input
            value={keptField}
            onChange={(e) => applyPreset('within_kept', { keepField: e.target.value })}
            placeholder="region"
            disabled={!canEdit}
            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <p className="text-[10px] text-text-quaternary leading-tight">
            {t('datasets.filterContext.keepDimHint')}
          </p>
        </div>
      )}

      {preset === 'use_relationship' && (
        <div className="rounded-md bg-surface-2 p-1.5 space-y-1">
          <label className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
            Join alias
          </label>
          <input
            value={useRelAlias}
            onChange={(e) => applyPreset('use_relationship', { joinAlias: e.target.value })}
            placeholder="creator"
            disabled={!canEdit}
            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <p className="text-[10px] text-warning leading-tight">
            ⚠ Schema-only ở Phase-14. Engine compile chưa wire alias —
            follow-up phase sẽ làm. Save vẫn OK, runtime dùng default path.
          </p>
        </div>
      )}

      {/* Tuỳ chỉnh chi tiết — raw modifier checkboxes. Keep for power
          users, hidden by default. Auto-opens if preset detector flagged
          'custom' (a shape no preset matches). */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="text-[10px] text-text-tertiary hover:text-text-secondary flex items-center gap-1"
      >
        {showAdvanced ? '▼' : '▶'} Tuỳ chỉnh chi tiết
      </button>

      {showAdvanced && (
        <div className="space-y-1.5 border-l-2 border-[rgb(var(--border-line))] pl-2">
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary">
            <input type="checkbox" checked={hasAll} disabled={!canEdit} onChange={toggleAll} />
            <span>Lấy tổng toàn bộ — bỏ mọi filter</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-[11px] text-text-secondary">
            <input type="checkbox" checked={hasAllExcept} disabled={!canEdit} onChange={toggleAllExcept} className="mt-0.5" />
            <span className="flex-1">
              Giữ nhiều dim
              {hasAllExcept && (
                <input
                  value={allExceptKeepCsv}
                  onChange={(e) => updateAllExceptKeep(e.target.value)}
                  placeholder="region, channel"
                  disabled={!canEdit}
                  className="mt-1 w-full rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                />
              )}
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 text-[11px] text-text-secondary">
            <input type="checkbox" checked={hasUseRel} disabled={!canEdit} onChange={toggleUseRel} className="mt-0.5" />
            <span className="flex-1">
              Dùng quan hệ alias
              {hasUseRel && (
                <input
                  value={useRelAlias}
                  onChange={(e) => updateJoinAlias(e.target.value)}
                  placeholder="creator"
                  disabled={!canEdit}
                  className="mt-1 w-full rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                />
              )}
            </span>
          </label>

          {hasAll && hasAllExcept && (
            <div className="rounded-md border border-danger/40 bg-danger/5 p-1.5 text-[10px] text-danger">
              Không thể đồng thời chọn "lấy tổng toàn bộ" và "giữ nhiều dim" —
              hai pattern này mâu thuẫn nhau. Pick 1.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Time Intelligence Builder (Phase-15.5) ──────────────────────────────────
//
// 1-click dialog to generate a time-intelligence measure (Same period last
// year, YTD, MTD, prev period, rolling N days). User picks:
//   - Base measure       — which measure to wrap (e.g. "Total Amount")
//   - Date dimension     — qualified field on a reachable view (e.g.
//                          "calendar.date") to gate the CASE WHEN against
//   - Time function      — preset list mapping to Phase-5 dialect-aware
//                          macros so the generated SQL works on
//                          DuckDB / Postgres / BigQuery / MySQL
//
// The dialog produces a fresh MeasureDefinition with an `expression`
// template already substituted with the user's column choices — no more
// "<value_col>" / "<date_col>" placeholders DA has to find and replace.
//
// Architecturally this is just a smarter MeasureTemplate.build() — it
// inserts into the same `measures[]` array. KHÔNG tạo cơ chế tính toán
// thứ 3, vẫn là Measure (Phase-1 invariant).

type TimeFunctionKey =
  | 'same_period_last_year'
  | 'prev_month'
  | 'prev_quarter'
  | 'ytd'
  | 'mtd'
  | 'qtd'
  | 'rolling_7d_sum'
  | 'rolling_30d_sum';

type TimeFunctionDef = {
  key: TimeFunctionKey;
  label: string;
  hint: string;
  /** Build the SQL expression. Date macros (${TODAY}, ${MONTH_START}, ...)
   *  are resolved by Phase-5 engine per dialect. */
  buildExpression: (args: { measureSql: string; dateRef: string }) => string;
  /** Aggregation type the wrapper uses on the base column. */
  aggType: MeasureDefinition['type'];
};

const TIME_FUNCTIONS: TimeFunctionDef[] = [
  {
    key: 'same_period_last_year',
    label: 'Same period last year',
    hint: 'DAX: SAMEPERIODLASTYEAR — value cho khoảng thời gian cùng kỳ năm trước',
    aggType: 'sum',
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${PREV_YEAR_START} AND ${dateRef} < \${YEAR_START} THEN ${measureSql} END`,
  },
  {
    key: 'prev_month',
    label: 'Previous month',
    hint: 'Tổng tháng trước (full month) — DAX: PREVIOUSMONTH',
    aggType: 'sum',
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${PREV_MONTH_START} AND ${dateRef} < \${MONTH_START} THEN ${measureSql} END`,
  },
  {
    key: 'prev_quarter',
    label: 'Previous quarter',
    hint: 'Tổng quý trước — DAX: PREVIOUSQUARTER (xấp xỉ qua macro PREV_QUARTER_START nếu engine support; tạm dùng 3 prev_months)',
    aggType: 'sum',
    // No PREV_QUARTER_START macro yet; approximate via 90-day window from PREV_MONTH_START.
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${DAYS_AGO:90} AND ${dateRef} < \${MONTH_START} THEN ${measureSql} END`,
  },
  {
    key: 'ytd',
    label: 'Year-to-date (YTD)',
    hint: 'DAX: TOTALYTD — tổng từ đầu năm đến hôm nay',
    aggType: 'sum',
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${YEAR_START} AND ${dateRef} <= \${TODAY} THEN ${measureSql} END`,
  },
  {
    key: 'mtd',
    label: 'Month-to-date (MTD)',
    hint: 'DAX: TOTALMTD — tổng từ đầu tháng đến hôm nay',
    aggType: 'sum',
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${MONTH_START} AND ${dateRef} <= \${TODAY} THEN ${measureSql} END`,
  },
  {
    key: 'qtd',
    label: 'Quarter-to-date (QTD)',
    hint: 'Tổng từ đầu quý đến hôm nay (xấp xỉ 90 ngày — macro QUARTER_START nếu có)',
    aggType: 'sum',
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${DAYS_AGO:90} AND ${dateRef} <= \${TODAY} THEN ${measureSql} END`,
  },
  {
    key: 'rolling_7d_sum',
    label: 'Rolling 7-day sum',
    hint: 'Tổng 7 ngày gần nhất — kết hợp time_grain=day khi consume',
    aggType: 'sum',
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${DAYS_AGO:7} AND ${dateRef} <= \${TODAY} THEN ${measureSql} END`,
  },
  {
    key: 'rolling_30d_sum',
    label: 'Rolling 30-day sum',
    hint: 'Tổng 30 ngày gần nhất',
    aggType: 'sum',
    buildExpression: ({ measureSql, dateRef }) =>
      `CASE WHEN ${dateRef} >= \${DAYS_AGO:30} AND ${dateRef} <= \${TODAY} THEN ${measureSql} END`,
  },
];

/**
 * Build a fresh MeasureDefinition from a TimeFunctionDef + user's column
 * picks. Generated name uses the function key + base measure for clarity;
 * user can rename in the row UI after creation.
 */
function buildTimeIntelligenceMeasure(args: {
  func: TimeFunctionDef;
  baseMeasureName: string;
  baseMeasureSqlExpr: string;
  dateFieldRef: string;
  nameSeq: number;
}): MeasureDefinition {
  const { func, baseMeasureName, baseMeasureSqlExpr, dateFieldRef, nameSeq } = args;
  const expression = func.buildExpression({
    measureSql: baseMeasureSqlExpr,
    dateRef: dateFieldRef,
  });
  return {
    name: `${baseMeasureName}_${func.key}_${nameSeq}`,
    label: `${baseMeasureName} — ${func.label}`,
    description: func.hint,
    type: func.aggType,
    sql: '',
    expression,
    hidden: false,
  };
}

function TimeIntelligenceBuilder({
  open,
  existingMeasures,
  modelViews,
  currentViewName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  existingMeasures: MeasureDefinition[];
  modelViews?: DatasetModelView[];
  currentViewName: string;
  onConfirm: (next: MeasureDefinition) => void;
  onClose: () => void;
}) {
  const [funcKey, setFuncKey] = useState<TimeFunctionKey>('same_period_last_year');
  const [baseMeasureName, setBaseMeasureName] = useState<string>('');
  const [dateField, setDateField] = useState<string>('');

  // Reset on open. Pick first reasonable defaults so the dialog is usable
  // immediately without forcing the user through 3 dropdowns.
  useEffect(() => {
    if (!open) return;
    setFuncKey('same_period_last_year');
    const firstNumeric = existingMeasures.find(
      (m) => ['sum', 'avg', 'count', 'count_distinct'].includes(m.type),
    );
    setBaseMeasureName(firstNumeric?.name ?? '');
    // Pick first date/datetime dim across reachable views.
    let firstDate: string | undefined;
    for (const v of modelViews ?? []) {
      const d = (v.dimensions ?? []).find(
        (dd) => !dd.hidden && (dd.type === 'date' || dd.type === 'datetime'),
      );
      if (d) {
        firstDate = `${v.name}.${d.name}`;
        break;
      }
    }
    setDateField(firstDate ?? '');
  }, [open, existingMeasures, modelViews]);

  if (!open) return null;

  const func = TIME_FUNCTIONS.find((f) => f.key === funcKey)!;
  const baseMeasure = existingMeasures.find((m) => m.name === baseMeasureName);

  // Compute the SQL expression for the base measure as the inner value of
  // the time-gated CASE WHEN. For column-based measures use ${TABLE}.<col>.
  // For expression measures, pass through the expression itself (advanced
  // users — they own the syntax).
  const baseMeasureSqlExpr = (() => {
    if (!baseMeasure) return '';
    if (baseMeasure.expression && baseMeasure.expression.trim()) {
      return baseMeasure.expression.trim();
    }
    const sql = (baseMeasure.sql ?? '').trim();
    if (!sql || sql === '*') return '1'; // COUNT(*) → count rows with the date predicate as `1`
    return sql.includes('.') || sql.startsWith('${') ? sql : `\${TABLE}.${sql}`;
  })();

  const previewExpression = baseMeasure && dateField
    ? func.buildExpression({ measureSql: baseMeasureSqlExpr, dateRef: `\${${dateField}}` })
    : '(pick base measure + date dim trước khi preview)';

  const canConfirm = Boolean(baseMeasure && dateField);

  return (
    <AppModalShell
      onClose={onClose}
      title="Time intelligence — generate measure"
      maxWidthClass="max-w-xl"
      bodyClassName="p-0"
      footer={(
        <>
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => {
              if (!baseMeasure || !dateField) return;
              let n = 1;
              const existingNames = new Set(existingMeasures.map((m) => m.name));
              while (existingNames.has(`${baseMeasure.name}_${func.key}_${n}`)) n += 1;
              onConfirm(buildTimeIntelligenceMeasure({
                func,
                baseMeasureName: baseMeasure.name,
                baseMeasureSqlExpr,
                dateFieldRef: `\${${dateField}}`,
                nameSeq: n,
              }));
              onClose();
            }}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-emphasis text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Generate measure
          </button>
        </>
      )}
    >
      <div className="space-y-3 p-4">
        <p className="text-xs leading-snug text-text-tertiary">
          Tạo measure dạng "value theo time window" — engine emit SQL có
          time macro <code>${'${TODAY}'}</code> / <code>${'${MONTH_START}'}</code> /
          v.v., resolve đúng cú pháp dialect (Phase-5).
        </p>

        <div>
          <label className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
            Time function
          </label>
          <select
            value={funcKey}
            onChange={(e) => setFuncKey(e.target.value as TimeFunctionKey)}
            className="mt-0.5 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
          >
            {TIME_FUNCTIONS.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-text-quaternary leading-tight">
            {func.hint}
          </p>
        </div>

        <div>
          <label className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
            Base measure
          </label>
          <select
            value={baseMeasureName}
            onChange={(e) => setBaseMeasureName(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="">— chọn measure đã có —</option>
            {existingMeasures.map((m) => (
              <option key={m.name} value={m.name}>
                {m.label || m.name} ({m.type})
              </option>
            ))}
          </select>
          {existingMeasures.length === 0 && (
            <p className="mt-1 text-[10px] text-warning leading-tight">
              ⚠ Chưa có measure nào trên view này. Tạo measure thường trước
              (vd Total Amount = SUM(amount)) rồi quay lại đây.
            </p>
          )}
        </div>

        <div>
          <label className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
            Date dimension
          </label>
          <select
            value={dateField}
            onChange={(e) => setDateField(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="">— chọn date / datetime field —</option>
            {(modelViews ?? []).flatMap((v) =>
              (v.dimensions ?? [])
                .filter((d) => !d.hidden && (d.type === 'date' || d.type === 'datetime'))
                .map((d) => (
                  <option key={`${v.name}.${d.name}`} value={`${v.name}.${d.name}`}>
                    {v.name}.{d.name}
                  </option>
                )),
            )}
          </select>
          <p className="mt-1 text-[10px] text-text-quaternary leading-tight">
            Engine sẽ JOIN view này vào query nếu khác base view (Phase-12).
          </p>
        </div>

        <div className="rounded-md bg-surface-2 p-2">
          <div className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
            SQL preview
          </div>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10px] font-mono text-text-tertiary">
            {func.aggType.toUpperCase()}(
            {'\n  '}
            {previewExpression}
            {'\n'}
            )
          </pre>
        </div>

        <p className="text-[10px] text-text-quaternary leading-snug">
          Sau khi sinh, measure xuất hiện trong danh sách bên trên — có thể
          edit name / label / agg type như measure thường. Generated
          measure không khoá: bác sửa expression / agg sau đều OK.
          Current view: <code>{currentViewName}</code>.
        </p>
      </div>
    </AppModalShell>
  );
}

// ─── MeasureRow ───────────────────────────────────────────────────────────────

/**
 * Validate one measure against the same rules MeasureRow paints red.
 * Shared between the row (inline error display) and the panel footer
 * (Save button disable).
 *
 * We infer the mode from the saved shape (depends_on => formula;
 * expression/where_sql/scope=dataset => sql; else lowcode) instead of
 * passing the editor's transient mode. Either way the rule has to be
 * "does the persisted measure satisfy the BE compile contract" — the
 * editor UI is just a view onto that contract.
 *
 * Engine semantics this enforces (semantic_query_engine.py:627–729):
 *   • Every measure needs a valid identifier name.
 *   • type='count' is the only type that can omit both sql and expression.
 *   • A measure with expression containing a top-level aggregate
 *     function (SUM/AVG/...) MUST be in formula mode (depends_on set);
 *     otherwise the engine raises a double-aggregation guard error.
 *   • scope='dataset' requires source_columns.
 */
const AGG_FN_RE = /\b(SUM|AVG|COUNT|MIN|MAX|MEDIAN|STDDEV|VARIANCE)\s*\(/i;

function validateMeasure(measure: MeasureDefinition): Record<string, string> {
  const hasDeps = (measure.depends_on?.length ?? 0) > 0;
  const hasExpr = Boolean((measure.expression || '').trim());
  const hasSqlCol = Boolean((measure.sql || '').trim());
  const mode: 'lowcode' | 'sql' | 'formula' = hasDeps
    ? 'formula'
    : (hasExpr || measure.where_sql || measure.scope === 'dataset')
      ? 'sql'
      : 'lowcode';

  const out: Record<string, string> = {};
  const trimmedName = (measure.name || '').trim();
  if (!trimmedName) {
    out.name = 'SQL name là bắt buộc';
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedName)) {
    out.name = 'SQL name chỉ chứa chữ, số, dấu gạch dưới; không bắt đầu bằng số';
  }

  if (mode === 'lowcode' && measure.type !== 'count' && !hasSqlCol) {
    out.column = 'Chọn 1 cột để tính (hoặc đổi sang SQL nâng cao nếu cần biểu thức)';
  }
  if (mode === 'sql' && !hasExpr && !hasSqlCol) {
    out.expression = 'Cần SQL expression hoặc cột nguồn';
  }
  if (mode === 'sql' && hasExpr && AGG_FN_RE.test(measure.expression || '')) {
    // Engine guard: a SQL-mode expression with a top-level aggregate would
    // compile to SUM(SUM(...)) which the BE rejects. B1 (applyExpressionInput,
    // on blur) normally defuses this automatically — `SUM(revenue)` unwraps to
    // agg+column, `SUM(${m})` flips to formula. This message is now only a
    // safety net for a transient mid-edit state; it no longer tells DA to
    // switch mode by hand (that happens for them). Clicking away from the
    // field (incl. clicking Save) triggers the auto-fix.
    out.expression = 'Bỏ con trỏ khỏi ô để hệ thống tự chuẩn hoá biểu thức có SUM/AVG (đang chứa hàm tổng hợp lồng).';
  }
  if (mode === 'formula' && !hasExpr) {
    out.expression = 'Công thức cần biểu thức (vd ${revenue} / NULLIF(${orders}, 0))';
  }
  if (mode === 'formula' && !hasDeps) {
    out.depends_on = 'Công thức cần khai báo ít nhất 1 measure phụ thuộc';
  }
  if (measure.scope === 'dataset' && (measure.source_columns?.length ?? 0) === 0) {
    out.source_columns = 'Tính qua nhiều bảng bật mà chưa khai báo cột nguồn';
  }
  return out;
}

// ─── B1: auto-fix double-aggregation on expression input ─────────────────────
//
// DA mental model from PowerBI: `SUM(revenue)` is the most basic measure you
// can write. In this editor's SQL mode that produced a red error ("biểu thức
// có sẵn SUM — chuyển sang Công thức…") because the engine would wrap it again
// → SUM(SUM(revenue)). That error made DA feel the tool "doesn't understand the
// logic". Instead of erroring, we now READ THE INTENT and reshape the measure
// to the form the engine wants — the same way PowerBI's one DAX box accepts
// `SUM(revenue)` directly.
//
// Two intents, detected from what's INSIDE the outer aggregate:
//   1. SUM(revenue)        — inner is raw column(s), no ${measure} refs
//                          → UNWRAP: agg=SUM, expression=revenue (engine wraps).
//   2. SUM(${revenue})     — inner references other measures via ${name}
//      or ${a}/NULLIF(...) → it's a FORMULA over already-aggregated measures
//                          → switch to formula mode, depends_on = parsed refs.
//
// When the expression has NO top-level aggregate (e.g. `revenue - cost`) we
// leave it exactly as typed — that's the normal SQL-expression case the agg
// dropdown wraps. This helper only fires to DEFUSE the double-agg trap.

/** Parse `${name}` / `${view.name}` measure references out of an expression. */
function parseMeasureRefs(expr: string): string[] {
  const refs = new Set<string>();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) refs.add(m[1]);
  return Array.from(refs);
}

/**
 * If `raw` is a single outer aggregate call wrapping its whole body
 * (e.g. `SUM(...)`, `AVG( ... )`), return `{agg, inner}`. Returns null when the
 * expression is not a single top-level aggregate (so we don't touch
 * `a + SUM(b)` or `SUM(a) - SUM(b)` — those are genuine formulas the user
 * should express via depends_on).
 */
function matchSingleOuterAggregate(raw: string): { agg: MeasureDefinition['type']; inner: string } | null {
  const text = raw.trim();
  const m = /^(SUM|AVG|COUNT|MIN|MAX)\s*\(([\s\S]*)\)$/i.exec(text);
  if (!m) return null;
  const inner = m[2];
  // Confirm the matched closing paren is the one that balances the OPENING
  // paren of this aggregate (i.e. the whole string is one call), not an early
  // close like `SUM(a) + b`. Walk depth over `inner`; it must never dip below 0
  // and must end at exactly 0.
  let depth = 0;
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return null; // closed too early → not a single wrapper
    }
  }
  if (depth !== 0) return null;
  const aggMap: Record<string, MeasureDefinition['type']> = {
    sum: 'sum', avg: 'avg', count: 'count', min: 'min', max: 'max',
  };
  return { agg: aggMap[m[1].toLowerCase()], inner: inner.trim() };
}

/**
 * Reshape a measure after the user edits the SQL-expression field, defusing
 * the double-aggregation trap. Returns the FULL next measure (caller passes it
 * straight to onChange). `setMode` lets the row flip its visible mode when the
 * intent turns out to be a formula.
 */
function applyExpressionInput(
  measure: MeasureDefinition,
  rawValue: string,
  setMode: (m: 'lowcode' | 'sql' | 'formula') => void,
): MeasureDefinition {
  const raw = rawValue;
  const expression = raw || undefined;
  const refs = parseMeasureRefs(raw);

  // Intent 2 — references other measures → FORMULA (engine inlines them; no
  // outer aggregate). This covers both `SUM(${a})` and `${a}/NULLIF(${b},0)`.
  if (refs.length > 0) {
    setMode('formula');
    return {
      ...measure,
      expression,
      depends_on: refs,
      // formula path ignores scope/source_columns; keep them clean.
      scope: 'view',
      source_columns: [],
    };
  }

  // Intent 1 — single outer aggregate over raw columns → UNWRAP so the engine
  // wraps once. `SUM(revenue)` becomes agg=SUM + expression=revenue.
  const wrapped = matchSingleOuterAggregate(raw);
  if (wrapped && wrapped.inner) {
    return {
      ...measure,
      type: wrapped.agg,
      expression: wrapped.inner,
      depends_on: [],
    };
  }

  // Plain expression (e.g. `revenue - cost`) — leave as typed; the Aggregation
  // dropdown wraps it. Strip any stale formula deps so it stays SQL-mode.
  return { ...measure, expression, depends_on: [] };
}

function MeasureRow({
  measure,
  canEdit,
  columnOptions,
  measureNames,
  viewName,
  viewId,
  datasetId,
  rowKey,
  defaultOpen,
  splitLayout,
  modelViews,
  onRetargetView,
  onChange,
  onRemove,
}: {
  measure: MeasureDefinition;
  canEdit: boolean;
  columnOptions: string[];
  measureNames: string[];
  viewName?: string;
  /** D2/D3: the view this row currently lives on (for the table selector + test run). */
  viewId?: number;
  datasetId?: number;
  rowKey: string;
  defaultOpen?: boolean;
  /** E3: render as a single active measure — form left, preview right, with a
   * draggable divider. When false, legacy inline row (no split). */
  splitLayout?: boolean;
  /** Phase-12: every view in the dataset model — used to populate the
   * cross-table source-columns picker when measure scope='dataset'. */
  modelViews?: DatasetModelView[];
  /** D2: a NEW row's "Bảng" selector switches which view the panel edits. */
  onRetargetView?: (viewId: number) => void;
  onChange: (updated: MeasureDefinition) => void;
  onRemove: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(() => rowKey.startsWith('new-measure') || Boolean(defaultOpen));
  const [editingLabel, setEditingLabel] = useState(false);
  // D3: "Chạy thử" (test run) state — run the candidate against the real
  // engine + datasource and show the output before Save.
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<MeasurePreviewResult | null>(null);
  const [testGroupBy, setTestGroupBy] = useState<string>('');
  // E3: when rendered as the single active measure (splitLayout), the form
  // sits left + preview right with a draggable divider. `splitLeftPct` is the
  // left pane width %, dragged by the user (default 50, clamped 30–75).
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [splitLeftPct, setSplitLeftPct] = useState(50);
  const startSplitDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const box = splitContainerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      const pct = ((ev.clientX - box.left) / box.width) * 100;
      setSplitLeftPct(Math.min(75, Math.max(30, pct)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Auto-detect mode from the measure shape. The 3 modes map 1-to-1 onto
  // the BE compile paths in `services/semantic_query_engine.py` (lines
  // 627–729):
  //   • formula  — `expression` + `depends_on` non-empty → Mode-2 ratio
  //                path: aggregation is bypassed, `expression` IS the
  //                final formula over already-aggregated measures.
  //   • sql      — `expression` set (or `where_sql` set, or scope=dataset)
  //                without depends_on → `type` still wraps the value,
  //                so SUM(revenue - cost) compiles correctly.
  //   • lowcode  — only `type` + `sql` (a bare column) → plain aggregation.
  //
  // Auto-detect on FIRST open so MCP-created measures land in the mode
  // that shows all their load-bearing fields. The user can flip later.
  const detectMode = (m: MeasureDefinition): 'lowcode' | 'sql' | 'formula' => {
    if ((m.depends_on?.length ?? 0) > 0) return 'formula';
    if (m.expression || m.where_sql || m.scope === 'dataset') return 'sql';
    return 'lowcode';
  };
  const [mode, setMode] = useState<'lowcode' | 'sql' | 'formula'>(detectMode(measure));

  // B3 (2026-06-10): the 3-way mode toggle (Low-code / SQL / Công thức) leaked
  // the engine's compile-path taxonomy onto DA — they had to classify a measure
  // BEFORE writing it (PowerBI has none of this: one DAX box). We replace the
  // toggle with progressive disclosure: by default DA sees only "Aggregation +
  // Cột" (lowcode, ~90% of measures). A single "Công thức nâng cao" disclosure
  // reveals the SQL-expression box; the engine path (sql vs formula) is then
  // INFERRED from what they type (B1's applyExpressionInput sets `mode`), not
  // chosen by hand. `mode` state still drives which sub-fields render — we just
  // removed the manual buttons. Open the disclosure automatically when a
  // measure already carries advanced shape, so editing an existing
  // expression/formula measure shows its fields.
  const [showAdvanced, setShowAdvanced] = useState(() => detectMode(measure) !== 'lowcode');

  // `mode`/`showAdvanced` are seeded once at mount from the measure prop. When
  // the measure GAINS advanced shape from OUTSIDE the form — i.e. a draft
  // restore (applyDraft) or an external prop update injects an expression /
  // where_sql / cross-table scope / depends_on — re-derive so the SQL box opens
  // and shows the restored formula. Without this, restoring a draft onto a
  // measure that started lowcode left the advanced section collapsed, HIDING
  // the restored expression (it looked like the draft "didn't save the SQL").
  // Collapsing the disclosure clears the advanced fields (toggleAdvanced) →
  // detectMode falls back to lowcode → this never fights a manual collapse.
  useEffect(() => {
    const detected = detectMode(measure);
    if (detected !== 'lowcode') {
      setShowAdvanced(true);
      setMode(detected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure.expression, measure.where_sql, measure.scope, measure.depends_on?.length]);

  // Opening the advanced disclosure: if the measure is still bare lowcode,
  // seed an empty sql-expression shape so the box appears. Closing it: strip
  // advanced fields back to a clean lowcode measure (mirror switchMode's
  // lowcode cleanup) so the saved truth matches the visible form.
  const toggleAdvanced = () => {
    if (showAdvanced) {
      // collapse → revert to lowcode
      onChange({
        ...measure,
        expression: undefined,
        where_sql: undefined,
        depends_on: [],
        scope: 'view',
        source_columns: [],
      });
      setMode('lowcode');
      setShowAdvanced(false);
    } else {
      setMode(detectMode(measure) === 'lowcode' ? 'sql' : detectMode(measure));
      setShowAdvanced(true);
    }
  };

  // (B3) The manual `switchMode` 3-way toggle was removed — mode is now driven
  // by `toggleAdvanced` (disclosure open/close) + B1's `applyExpressionInput`
  // (infers sql vs formula from typed content). The field-cleanup that
  // switchMode used to do on collapse lives in `toggleAdvanced`.

  const filters = measure.filters ?? [];
  const updateFilters = (next: MeasureFilter[]) => onChange({ ...measure, filters: next });
  const addFilter = () =>
    updateFilters([...filters, { field: columnOptions[0] ?? '', operator: 'eq', value: '' }]);

  const fmt: MeasureFormat = measure.format ?? { kind: 'number' };
  const updateFormat = (patch: Partial<MeasureFormat>) =>
    onChange({ ...measure, format: { ...fmt, ...patch } });

  const colsListId = `__cols_${rowKey}`;
  const measuresListId = `__measures_${rowKey}`;
  const selfMeasureRefs = new Set([
    measure.name,
    viewName ? `${viewName}.${measure.name}` : '',
  ].filter(Boolean));

  // C1: insert a field token into the expression at the cursor. Columns go in
  // RAW (e.g. `revenue`); other measures go as `${name}` (the ref syntax the
  // engine inlines + B1 picks up as a formula dependency). DA picks from a
  // list instead of remembering which of the two syntaxes to type — the
  // "one namespace, autocomplete decides the syntax" idea.
  const otherMeasureNames = measureNames.filter((n) => !selfMeasureRefs.has(n));

  // Other reachable views' columns, grouped by table, for the cross-table
  // field picker. Each is inserted as `${view.field}` (the engine's cross-table
  // ref) and labelled "view.col" so DA sees WHICH table the column is from.
  // Toggling these on also flips the measure to scope='dataset' + registers the
  // source column (applyExpressionInput handles the ${...} parse on blur; here
  // we also seed source_columns so the engine knows to JOIN).
  const otherViewColumnGroups = useMemo(() => {
    const groups: { view: DatasetModelView; label: string; columns: string[] }[] = [];
    for (const v of modelViews ?? []) {
      if (v.id === viewId) continue;            // current table is the "Cột" group
      if (v.hidden_in_canvas || v.view_role === 'calendar_role' || v.system_managed) continue;
      const cols = (v.dimensions ?? [])
        .filter((d) => !d.hidden && d.name)
        .map((d) => d.name);
      if (cols.length === 0) continue;
      groups.push({ view: v, label: v.table_display_name || v.name, columns: cols });
    }
    return groups;
  }, [modelViews, viewId]);

  // E8: friendly cross-table refs. The engine needs `${dataset_table_240.col}`
  // (technical view name), but that's unreadable to DA. We DISPLAY the friendly
  // `${dw_buoi_7.employees.col}` (display name is unique within a dataset) and
  // map back to the technical token only when storing. These two maps drive the
  // tech<->display rewrite around the expression input.
  const techToDisplay = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of modelViews ?? []) {
      const disp = (v.table_display_name || v.name || '').trim();
      if (v.name && disp) m.set(v.name, disp);
    }
    return m;
  }, [modelViews]);
  const displayToTech = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of modelViews ?? []) {
      const disp = (v.table_display_name || v.name || '').trim();
      if (v.name && disp) m.set(disp, v.name);
    }
    return m;
  }, [modelViews]);

  // Rewrite every `${<viewToken>.<field>}` inside an expression, swapping the
  // view token via `lookup`. The view token may itself contain dots (display
  // names like `dw_buoi_7.employees`), so we match `${ ... }` then split on the
  // LAST dot to separate field from view token. Unknown tokens pass through
  // unchanged (so plain `${measure}` formula refs and same-table cols are safe).
  const rewriteExprViewTokens = (expr: string, lookup: Map<string, string>): string => {
    if (!expr) return expr;
    return expr.replace(/\$\{([^}]+)\}/g, (whole, inner: string) => {
      const lastDot = inner.lastIndexOf('.');
      if (lastDot <= 0) return whole;               // no view qualifier → leave (measure ref / bare)
      const viewToken = inner.slice(0, lastDot);
      const field = inner.slice(lastDot + 1);
      const mapped = lookup.get(viewToken);
      return mapped ? `\${${mapped}.${field}}` : whole;
    });
  };
  // What the user SEES in the expression box (technical view names → friendly).
  const expressionForDisplay = rewriteExprViewTokens(measure.expression || '', techToDisplay);

  // E9: autocomplete suggestions for the chip editor (display name-space).
  //   - current-table columns  → insert raw (wrap:false), kind 'column'
  //   - other-table columns    → insert ${display.field} (wrap:true), 'crosscol'
  //   - other measures         → insert ${name} (wrap:true), 'measure'
  const exprSuggestions = useMemo(() => {
    const out: ExprSuggestion[] = [];
    for (const c of columnOptions) {
      out.push({ insertText: c, wrap: false, label: c, kind: 'column', group: 'Cột (bảng này)' });
    }
    for (const g of otherViewColumnGroups) {
      for (const c of g.columns) {
        out.push({ insertText: `${g.label}.${c}`, wrap: true, label: `${g.label}.${c}`, kind: 'crosscol', group: `Bảng: ${g.label}` });
      }
    }
    for (const m of otherMeasureNames) {
      out.push({ insertText: m, wrap: true, label: m, kind: 'measure', group: 'Measure (bảng này)' });
    }
    // Cross-view MEASURES — ratio across tables (e.g. ${products.value} /
    // ${employees.value}). Inserted as ${displayView.measure}; the BE inlines
    // each as its own aggregate (no outer wrap). Grouped per source table.
    for (const v of modelViews ?? []) {
      if (v.id === viewId) continue;
      if (v.hidden_in_canvas || v.view_role === 'calendar_role' || v.system_managed) continue;
      const label = v.table_display_name || v.name;
      for (const me of v.measures ?? []) {
        if (!me?.name || me.hidden) continue;
        out.push({
          insertText: `${label}.${me.name}`,
          wrap: true,
          label: `${label}.${me.label || me.name}`,
          kind: 'measure',
          group: `Measure từ bảng: ${label}`,
        });
      }
    }
    return out;
  }, [columnOptions, otherViewColumnGroups, otherMeasureNames, modelViews, viewId]);

  // E9 / BUG-007 (2026-06-11): single handler the chip editor calls with the
  // DISPLAY-space expression. Converts display→technical, then classifies EVERY
  // `${ref}` — bare AND dotted — and routes:
  //   • any ref is a MEASURE        → formula mode (depends_on), scope='view'
  //   • else, any ref is a CROSS-TABLE column → dataset-scope + source_columns
  //   • else (only same-table cols) → plain expression (auto-detect)
  // The previous version matched ONLY dotted `${view.field}` and dropped bare
  // `${lead_nhan}` entirely — leaving it un-resolved so the literal `${...}`
  // reached BigQuery and broke. Now bare refs are recognised: same-table cols
  // are resolved by the BE (`view_alias.field`), measures become deps.
  const knownMeasureNames = useMemo(() => new Set(otherMeasureNames), [otherMeasureNames]);
  const knownColumnNames = useMemo(() => new Set(columnOptions), [columnOptions]);
  // BUG (2026-06-12): a qualified ref `${view.field}` can be a cross-view
  // MEASURE (→ ratio formula, depends_on, NO outer aggregate) or a cross-table
  // COLUMN (→ source_columns + scope=dataset, wrapped by the Aggregation). The
  // old classifier looked only at whether `view` was known and forced EVERY
  // dotted ref to a column — which (a) SUM-wrapped a measure ratio and (b) made
  // the cross-view measure-ratio feature unreachable. These sets let us tell
  // them apart by looking up `field` on its view in the model.
  const crossViewMeasureRefs = useMemo(() => {
    const s = new Set<string>();
    for (const v of modelViews ?? []) {
      for (const m of v.measures ?? []) {
        if (m?.name) s.add(`${v.name}.${m.name}`);
      }
    }
    return s;
  }, [modelViews]);
  const commitExpressionDisplay = (displayText: string) => {
    const tech = rewriteExprViewTokens(displayText, displayToTech);
    // Collect every ${...} ref (bare `name` or dotted `view.field`).
    const refRe = /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;
    const measureRefs: string[] = [];
    const crossRefs: { view: string; field: string }[] = [];
    let hasAnyRef = false;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(tech)) !== null) {
      hasAnyRef = true;
      const inner = m[1];
      const dot = inner.lastIndexOf('.');
      if (dot > 0) {
        const view = inner.slice(0, dot);
        const field = inner.slice(dot + 1);
        if (crossViewMeasureRefs.has(inner)) {
          // ${view.measure} → ratio over another view's MEASURE: formula
          // dependency, NOT a column. Engine inlines the dep measure's own
          // aggregate; the outer Aggregation must NOT wrap it.
          measureRefs.push(inner);
        } else if (techToDisplay.has(view)) {
          crossRefs.push({ view, field });      // cross-table COLUMN
        } else {
          measureRefs.push(inner);              // unknown-view qualified ref → treat as dep
        }
      } else if (knownMeasureNames.has(inner)) {
        measureRefs.push(inner);                // bare measure (same view)
      }
      // else: bare same-table column → leave in expression; BE resolves to
      // view_alias.field. Not a dep, not a source_column.
    }

    if (measureRefs.length > 0) {
      // Formula over other measures (ratio etc). The engine inlines them.
      setMode('formula');
      onChange({
        ...measure,
        expression: tech || undefined,
        depends_on: Array.from(new Set(measureRefs)),
        scope: 'view',
        source_columns: [],
      });
    } else if (crossRefs.length > 0) {
      // Dataset-scope cross-table measure: register source_columns so the
      // engine JOINs the other view(s). Bare same-table cols in the same
      // expression are resolved by the BE; they don't need source_columns.
      setMode('sql');
      const seen = new Set<string>();
      const sources = crossRefs.filter((r) => {
        const k = `${r.view}.${r.field}`;
        if (seen.has(k)) return false; seen.add(k); return true;
      });
      onChange({
        ...measure,
        expression: tech || undefined,
        scope: 'dataset',
        source_columns: sources,
        depends_on: [],
      });
    } else if (hasAnyRef) {
      // Only bare ${col} refs to SAME-TABLE columns (no measures, no cross
      // refs). It's a plain per-row SQL expression the Aggregation wraps; the
      // BE resolves each ${col} to view_alias.col. Do NOT route through
      // applyExpressionInput — its parseMeasureRefs would mis-read ${col} as a
      // measure dependency and wrongly flip to formula mode.
      setMode('sql');
      onChange({
        ...measure,
        expression: tech || undefined,
        depends_on: [],
        scope: 'view',
        source_columns: [],
      });
    } else {
      // No ${...} refs at all (raw text like `revenue - cost` or `SUM(x)`) →
      // auto-detect (unwrap single outer aggregate, etc.).
      onChange(applyExpressionInput(measure, tech, setMode));
    }
  };


  // (E9: field insertion is now handled inside MeasureExpressionEditor via
  // inline autocomplete + chips; the old insertFieldToken/dropdown was removed.)

  // D3: run the candidate measure (unsaved) and show the real output so DA can
  // confirm "ra số đúng không" before Save. Grand-total by default; group by a
  // dimension if one is picked.
  const runTest = async () => {
    if (datasetId == null || viewId == null) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const res = await previewMeasure({ datasetId, viewId, measure, groupBy: testGroupBy || undefined });
      setTestResult(res);
    } catch (err: unknown) {
      setTestResult({ ok: false, error: extractApiError(err, 'Chạy thử thất bại'), rows: [] });
    } finally {
      setTestRunning(false);
    }
  };
  // Dimensions on this view available as "Group theo" options for the test.
  const testGroupOptions = useMemo(() => {
    const v = (modelViews ?? []).find((mv) => mv.id === viewId);
    return (v?.dimensions ?? []).filter((d) => !d.hidden).map((d) => d.name);
  }, [modelViews, viewId]);

  // Inline validation — paint each input red + surface a summary at the
  // bottom of the form. validateMeasure() is shared with the panel
  // footer so the Save button uses the SAME ruleset (no drift between
  // "looks invalid in the row" and "still save-able from the footer").
  const errors = validateMeasure(measure);
  const hasErrors = Object.keys(errors).length > 0;
  const errClass = (key: string) =>
    errors[key]
      ? 'border-danger/60 bg-danger/5 focus:ring-danger/40'
      : 'border-[rgb(var(--border-line))] focus:ring-brand';

  // D3/E3: the "Chạy thử" preview pane. Rendered inline (legacy) or as the
  // right column in the resizable split layout.
  const canPreview = datasetId != null && viewId != null;
  const previewPane = (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={runTest}
          disabled={testRunning}
          className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-3 disabled:opacity-50"
          title="Chạy measure này trên dữ liệu thật (không lưu) để xem kết quả."
        >
          {testRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <span>▶</span>}
          Chạy thử
        </button>
        <span className="text-[10px] text-text-quaternary">Group theo</span>
        <select
          value={testGroupBy}
          onChange={(e) => setTestGroupBy(e.target.value)}
          className="text-[11px] px-1.5 py-1 border border-[rgb(var(--border-line))] rounded bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand"
        >
          <option value="">(tổng — 1 dòng)</option>
          {testGroupOptions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {hasErrors ? (
        <p className="text-[10px] text-text-quaternary italic">Sửa lỗi cấu hình bên trái trước khi chạy thử.</p>
      ) : !testResult ? (
        <p className="text-[10px] text-text-quaternary italic">Bấm "Chạy thử" để xem kết quả thật của measure này.</p>
      ) : testResult.ok ? (
        <div className="rounded bg-surface-2 p-1.5 max-h-72 overflow-auto">
          {testResult.rows.length === 0 ? (
            <p className="text-[10px] text-text-quaternary">Không có dữ liệu trả về.</p>
          ) : (
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-text-quaternary">
                  {Object.keys(testResult.rows[0]).map((k) => (
                    <th key={k} className="px-1 py-0.5 text-left font-medium truncate" title={k}>
                      {k.includes('.') ? k.split('.').slice(1).join('.') : k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {testResult.rows.slice(0, 50).map((row, ri) => (
                  <tr key={ri} className="border-t border-[rgb(var(--border-line))]">
                    {Object.keys(testResult.rows[0]).map((k) => (
                      <td key={k} className="px-1 py-0.5 font-mono truncate" title={String(row[k] ?? '')}>
                        {row[k] == null ? '—' : String(row[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {testResult.rows.length > 50 && (
            <p className="mt-1 text-[10px] text-text-quaternary">… {testResult.rows.length - 50} dòng nữa</p>
          )}
        </div>
      ) : (
        <p className="rounded bg-danger/5 px-1.5 py-1 text-[10px] text-danger">{testResult.error}</p>
      )}
    </div>
  );

  return (
    <div className={splitLayout ? '' : 'rounded-lg border border-[rgb(var(--border-line))] bg-surface-1'}>
      <div className="flex items-center gap-2 px-3 py-2">
        {/* E6: in split (single-measure) layout the row is always expanded —
            the collapse chevron is pointless, so it's hidden. Navigation
            between measures is via the left toolbar. */}
        {!splitLayout && (
          <button onClick={() => setIsExpanded(!isExpanded)} className="text-text-quaternary hover:text-text-secondary shrink-0">
            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        )}
        <Sigma className="w-3.5 h-3.5 text-warning shrink-0" />
        {canEdit && editingLabel ? (
          <input
            autoFocus
            value={measure.label ?? measure.name}
            onChange={(e) => {
              const newLabel = e.target.value || undefined;
              const updates: Partial<MeasureDefinition> = { label: newLabel };
              // Auto-sync the SQL name when it's still an auto-generated default
              if (newLabel && isAutoName(measure.name, measure.label)) {
                updates.name = slugifyName(newLabel);
              }
              onChange({ ...measure, ...updates });
            }}
            onBlur={() => setEditingLabel(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingLabel(false); }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-sm text-text-primary bg-transparent border-b border-brand outline-none min-w-0"
          />
        ) : (
          <span
            className={`text-sm text-text-primary truncate flex-1 ${canEdit ? 'cursor-text' : ''}`}
            title={canEdit ? 'Double-click to edit label' : undefined}
            onDoubleClick={canEdit ? () => setEditingLabel(true) : undefined}
          >
            {measure.label || measure.name}
          </span>
        )}
        {filters.length > 0 && (
          <span
            className="text-[9px] px-1 py-0.5 rounded bg-warning/10 text-warning shrink-0"
            title={`${filters.length} filter(s)`}
          >
            ƒ {filters.length}
          </span>
        )}
        {/* Phase-15.2: surface dataset-scope flag in the collapsed header so
            DA sees at a glance which measures span multiple tables (PowerBI
            equivalent: measure with USERELATIONSHIP / RELATED across tables).
            No edit affordance here — toggle lives in Advanced + the
            Cross-table preset in the Add Measure dropdown. */}
        {measure.scope === 'dataset' && (
          <span
            className="text-[9px] px-1 py-0.5 rounded bg-brand/10 text-brand font-emphasis uppercase shrink-0"
            title={`Tính qua nhiều bảng: measure tham chiếu ${measure.source_columns?.length ?? 0} cột nguồn từ view khác. Engine tự JOIN.`}
          >
            đa bảng
          </span>
        )}
        {/* Phase-14: surface filter-context flag — these measures emit
            SQL window aggregates instead of GROUP BY aggregates. */}
        {(measure.context_modifiers?.length ?? 0) > 0 && (
          <span
            className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 font-emphasis uppercase shrink-0"
            title="Measure dùng filter context — engine emit SQL OVER (PARTITION BY)"
          >
            ngữ cảnh
          </span>
        )}
        {hasErrors && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded bg-danger/10 text-danger font-emphasis uppercase shrink-0"
            title={Object.values(errors).join('\n')}
          >
            {Object.keys(errors).length} lỗi
          </span>
        )}
        {/* Type badge removed — Aggregation dropdown in the form makes it
            redundant. Header now only surfaces things the form doesn't
            already show prominently (errors, đa bảng, ngữ cảnh). */}
        {canEdit && (
          <>
            <button
              onClick={() => onChange({ ...measure, hidden: !measure.hidden })}
              className="p-0.5 hover:bg-surface-2 rounded shrink-0"
              title={measure.hidden ? 'Show' : 'Hide'}
            >
              {measure.hidden
                ? <EyeOff className="w-3.5 h-3.5 text-text-quaternary" />
                : <Eye className="w-3.5 h-3.5 text-text-quaternary" />}
            </button>
            <button onClick={onRemove} className="p-0.5 hover:bg-danger/10 rounded text-text-quaternary hover:text-danger shrink-0">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
      {isExpanded && canEdit && (
        // E3: split layout = flex container (left form pane + divider + right
        // preview pane). Legacy = single column with inline preview.
        <div
          ref={splitLayout ? splitContainerRef : undefined}
          className={splitLayout
            ? 'flex border-t border-[rgb(var(--border-line))]'
            : ''}
        >
        <div
          className={splitLayout
            ? 'px-3 pb-3 pt-1 space-y-2.5 overflow-auto min-w-0'
            : 'px-3 pb-3 pt-1 border-t border-[rgb(var(--border-line))] space-y-2.5'}
          style={splitLayout ? { width: `${splitLeftPct}%` } : undefined}
          data-measure-invalid={hasErrors ? 'true' : 'false'}
        >
          {/* Datalists shared across this row's inputs */}
          <datalist id={colsListId}>
            {columnOptions.map((c) => <option key={c} value={c} />)}
          </datalist>
          <datalist id={measuresListId}>
            {measureNames.filter((n) => !selfMeasureRefs.has(n)).map((n) => <option key={n} value={n} />)}
          </datalist>

          {/* D2 + unified form (2026-06-11): the "Bảng" (target table) selector
              shows in BOTH Add and Edit so the two forms look identical (DA
              found the layout shift confusing). On a NEW row it's editable —
              changing it retargets the panel to that view and re-opens a fresh
              row. On an EXISTING measure it's READ-ONLY (disabled, greyed): a
              saved measure can't move tables here, but DA still sees which
              table the measure lives on. Only hidden when there's a single
              candidate table (nothing to pick). */}
          {modelViews && modelViews.length > 1 && (() => {
            const isNewRow = rowKey.startsWith('new-measure');
            const canRetarget = isNewRow && Boolean(onRetargetView);
            return (
              <div>
                <label className="text-[10px] text-text-tertiary uppercase font-medium">Bảng</label>
                <select
                  value={viewId ?? ''}
                  disabled={!canRetarget}
                  onChange={(e) => {
                    if (!canRetarget) return;
                    const next = Number(e.target.value);
                    if (next && next !== viewId) onRetargetView!(next);
                  }}
                  className={`mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand ${
                    canRetarget ? 'bg-surface-1' : 'bg-surface-2 text-text-tertiary cursor-not-allowed'
                  }`}
                  title={canRetarget
                    ? 'Measure sẽ được tạo trên bảng này. Đổi bảng sẽ mở lại form trên bảng mới.'
                    : 'Measure đã lưu thuộc bảng này — không đổi bảng được. Tạo measure mới nếu cần bảng khác.'}
                >
                  {modelViews.map((v) => (
                    <option key={v.id} value={v.id}>{v.table_display_name || v.name}</option>
                  ))}
                </select>
              </div>
            );
          })()}

          {/* B3: no more 3-way mode toggle. Default = lowcode (Aggregation +
              Cột below). The "Công thức nâng cao" disclosure reveals the SQL
              box; the engine path is inferred from content, not picked by DA. */}

          {/* Identity — Label always, Aggregation only when relevant.
              Formula mode bypasses the wrapping agg entirely (engine
              returns the expression as-is), so showing a dropdown with
              "không áp dụng" was just clutter. Label gets the full row
              in formula mode. */}
          <div className={mode === 'formula' ? '' : 'grid grid-cols-2 gap-2'}>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Label</label>
              <input
                value={measure.label || ''}
                onChange={(e) => {
                  const newLabel = e.target.value || undefined;
                  const updates: Partial<MeasureDefinition> = { label: newLabel };
                  if (newLabel && isAutoName(measure.name, measure.label)) {
                    updates.name = slugifyName(newLabel);
                  }
                  onChange({ ...measure, ...updates });
                }}
                className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder="Display name"
              />
            </div>
            {mode !== 'formula' && (
              <div>
                <label className="text-[10px] text-text-tertiary uppercase font-medium">Aggregation</label>
                <select
                  value={measure.type}
                  onChange={(e) => onChange({ ...measure, type: e.target.value as MeasureDefinition['type'] })}
                  className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand"
                  title={
                    mode === 'lowcode'
                      ? 'Hàm SUM/AVG/COUNT/... áp dụng lên cột bên dưới.'
                      : 'Hàm wrap lên biểu thức SQL. Vd Sum + expression="revenue - cost" → SUM(revenue - cost).'
                  }
                >
                  {MEASURE_TYPES.map((t) => <option key={t} value={t}>{MEASURE_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
            )}
          </div>
          {/* SQL name (secondary) + Folder */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="flex items-center gap-1 mb-0.5">
                <label className="text-[10px] text-text-tertiary uppercase font-medium">SQL Name</label>
                {isAutoName(measure.name, measure.label) && (
                  <span className="text-[9px] text-text-quaternary italic">auto</span>
                )}
              </div>
              <input
                value={measure.name}
                onChange={(e) => onChange({ ...measure, name: e.target.value })}
                className={`w-full text-xs px-2 py-1.5 border rounded-md font-mono focus:outline-none focus:ring-1 ${errClass('name')}`}
                placeholder="sql_identifier"
                title="Internal SQL identifier. Letters, digits and underscores only."
              />
              {errors.name && (
                <p className="mt-0.5 text-[10px] text-danger">{errors.name}</p>
              )}
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Folder</label>
              <input
                value={measure.folder || ''}
                onChange={(e) => onChange({ ...measure, folder: e.target.value || undefined })}
                className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder="e.g. Revenue"
              />
            </div>
          </div>

          {/* Column to aggregate — Low-code mode only. COUNT counts rows
              (= COUNT(*)) so column is N/A; use filters or count_distinct
              for column-specific counting. In SQL mode the SQL expression
              field replaces this — column picker is hidden to keep one
              source of truth. */}
          {mode === 'lowcode' && measure.type !== 'count' && (
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Cột để tính</label>
              {/* C1: combobox — chọn cột từ danh sách (tránh sai tên) nhưng
                  vẫn cho gõ tự do nếu cần. */}
              <div className="mt-0.5">
                <ColumnCombobox
                  value={measure.sql || ''}
                  options={columnOptions}
                  onChange={(v) => onChange({ ...measure, sql: v || undefined })}
                  placeholder="Chọn / gõ cột (vd. num_calls)"
                  invalid={Boolean(errors.column)}
                />
              </div>
              {errors.column && (
                <p className="mt-0.5 text-[10px] text-danger">{errors.column}</p>
              )}
            </div>
          )}

          {/* Filter builder */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] text-text-tertiary uppercase font-medium">
                Filters (apply to this measure only)
              </label>
              <button
                onClick={addFilter}
                className="text-[10px] text-brand hover:underline flex items-center gap-0.5 font-medium"
              >
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
            {filters.length === 0 ? (
              <p className="text-[10px] text-text-quaternary italic">
                No filter — measure runs over every row.
              </p>
            ) : (
              <div className="space-y-1">
                {filters.map((f, i) => (
                  <MeasureFilterRow
                    key={i}
                    filter={f}
                    listId={colsListId}
                    columnOptions={columnOptions}
                    onChange={(u) => updateFilters(filters.map((x, j) => (j === i ? u : x)))}
                    onRemove={() => updateFilters(filters.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Format — only meaningful for non-count types. COUNT measures
              return row counts; currency/percent/duration don't apply.
              Hiding cuts visual noise on the most common measure type. */}
          {measure.type !== 'count' && measure.type !== 'count_distinct' && (
          <div>
            <label className="text-[10px] text-text-tertiary uppercase font-medium" title="Cách chart hiển thị số liệu — number / currency / percent / duration. Chart vẫn có thể override.">Format</label>
            <div className="mt-0.5 grid grid-cols-3 gap-2">
              <select
                value={fmt.kind}
                onChange={(e) => updateFormat({ kind: e.target.value as MeasureFormat['kind'] })}
                className="text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand"
              >
                {FORMAT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input
                type="number"
                min={0}
                max={10}
                value={fmt.decimals ?? ''}
                onChange={(e) =>
                  updateFormat({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })
                }
                placeholder="decimals"
                className="text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
              />
              {fmt.kind === 'currency' ? (
                <input
                  value={fmt.currency || ''}
                  onChange={(e) => updateFormat({ currency: e.target.value || undefined })}
                  placeholder="USD"
                  className="text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded uppercase focus:outline-none focus:ring-1 focus:ring-brand"
                  maxLength={4}
                />
              ) : (
                <input
                  value={fmt.suffix || ''}
                  onChange={(e) => updateFormat({ suffix: e.target.value || undefined })}
                  placeholder="suffix"
                  className="text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
                />
              )}
            </div>
          </div>
          )}

          {/* B3: single disclosure replaces the 3-mode toggle. Closed = the
              simple Aggregation + Cột form above (90% case). Open = the
              SQL-expression box below; whether that compiles as a raw-column
              SQL expression or a formula-over-measures is INFERRED from what
              DA types (B1), never picked by hand. */}
          <button
            type="button"
            onClick={toggleAdvanced}
            className="flex items-center gap-1 text-[11px] font-medium text-text-tertiary hover:text-text-secondary"
            title="Viết biểu thức SQL trên cột, hoặc công thức trên các measure khác (vd tỷ lệ, %). Engine tự nhận loại."
          >
            {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Công thức nâng cao
            <span className="font-normal text-text-quaternary">— SQL trên cột / công thức trên measure khác</span>
          </button>

          {/* Expression-required modes (sql + formula). Each mode shows
              only the sub-fields its compile path uses:
              • sql:     expression + where_sql + cross-table       (no depends_on)
              • formula: expression + depends_on + where_sql        (no cross-table, no column picker upstairs)
              The block is brand-tinted so user sees "I'm in advanced
              territory now". */}
          {showAdvanced && (mode === 'sql' || mode === 'formula') && (
            <div className="space-y-2 rounded-md border border-brand/20 bg-brand/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-brand">
                <span>{mode === 'sql' ? 'SQL nâng cao' : 'Công thức'}</span>
                <span className="text-text-quaternary normal-case font-normal">
                  {mode === 'sql'
                    ? '— biểu thức trên cột thô, Aggregation sẽ wrap bên ngoài'
                    : '— công thức trên các measure khác'}
                </span>
              </div>
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <label className="text-[10px] text-text-tertiary uppercase font-medium">
                    Biểu thức SQL
                  </label>
                  <span className="text-[10px] text-text-quaternary">Gõ tên cột/measure để gợi ý</span>
                </div>
                {/* E9: chip-aware editor. Field refs render as compact chips
                    (just the name, no ${...} clutter); formula glue stays text.
                    Typing a few chars pops inline autocomplete. Works in DISPLAY
                    name-space; commitExpressionDisplay maps back to technical +
                    reconciles cross-table scope/source_columns on store. */}
                <MeasureExpressionEditor
                  value={expressionForDisplay}
                  suggestions={exprSuggestions}
                  invalid={Boolean(errors.expression)}
                  onChange={commitExpressionDisplay}
                  onCommit={commitExpressionDisplay}
                  placeholder={mode === 'sql' ? 'vd: revenue - cost  ·  SUM(revenue) cũng được' : 'vd: revenue / NULLIF(orders, 0) — gõ tên cột để gợi ý'}
                />
                {errors.expression && (
                  <p className="mt-0.5 text-[10px] text-danger">{errors.expression}</p>
                )}
              </div>
              {/* depends_on — only in formula mode. SQL mode hides it
                  because mixing expression + depends_on triggers the
                  engine's Mode-2 formula path (which IS formula mode). */}
              {mode === 'formula' && (
                <div>
                  <label className="text-[10px] text-text-tertiary uppercase font-medium">
                    Phụ thuộc (measure khác) <span className="text-danger">*</span>
                  </label>
                  <input
                    list={measuresListId}
                    value={(measure.depends_on || []).join(', ')}
                    onChange={(e) =>
                      onChange({
                        ...measure,
                        depends_on: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    className={`mt-0.5 w-full text-xs px-2 py-1.5 border rounded-md font-mono focus:outline-none focus:ring-1 ${errClass('depends_on')}`}
                    placeholder="vd: revenue, orders"
                  />
                  <p className="mt-0.5 text-[10px] text-text-quaternary leading-tight">
                    Tên các measure khác mà công thức tham chiếu qua <code>{'${name}'}</code>. Engine inline SQL của chúng vào.
                  </p>
                  {errors.depends_on && (
                    <p className="mt-0.5 text-[10px] text-danger">{errors.depends_on}</p>
                  )}
                </div>
              )}
              <div>
                <label className="text-[10px] text-text-tertiary uppercase font-medium">
                  Điều kiện WHERE bổ sung
                </label>
                <input
                  value={measure.where_sql || ''}
                  onChange={(e) => onChange({ ...measure, where_sql: e.target.value || undefined })}
                  className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="vd: status <> 'cancelled'"
                />
                <p className="mt-0.5 text-[10px] text-text-quaternary leading-tight">
                  Cộng AND vào Filters ở trên. Apply trong CASE WHEN trước khi aggregate.
                </p>
              </div>

              {/* Cross-table source columns — SQL mode only.
                  Formula mode references OTHER MEASURES via ${name}
                  (not view.field) so cross-table doesn't apply. Drift
                  detection (Phase-13.3) flags expression ↔ source_columns
                  mismatches. */}
              {mode === 'sql' && (
              <div className={`space-y-1.5 rounded-md border p-2 ${errors.source_columns ? 'border-danger/50 bg-danger/5' : 'border-dashed border-[rgb(var(--border-line))]'}`}>
                <label className="flex cursor-pointer items-center gap-2 text-[10px] uppercase font-medium text-text-tertiary">
                  <input
                    type="checkbox"
                    checked={measure.scope === 'dataset'}
                    disabled={!canEdit}
                    onChange={(e) => {
                      if (e.target.checked) {
                        onChange({ ...measure, scope: 'dataset', source_columns: measure.source_columns ?? [] });
                      } else {
                        onChange({ ...measure, scope: 'view', source_columns: [] });
                      }
                    }}
                  />
                  Tính qua nhiều bảng
                </label>
                <p className="text-[10px] leading-snug text-text-quaternary">
                  Khi bật: biểu thức SQL có thể tham chiếu <code>{'${view.field}'}</code> từ bảng khác.
                  Khai báo từng cột nguồn dưới đây để engine tự JOIN.
                </p>
                {errors.source_columns && (
                  <p className="text-[10px] text-danger">{errors.source_columns}</p>
                )}
                {measure.scope === 'dataset' && (() => {
                  // Phase-13.3: parse ${view.field} refs from expression and diff
                  // against source_columns so the user sees what's missing.
                  const exprRefs = new Set<string>();
                  const exprText = measure.expression || '';
                  const placeholderRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
                  let match: RegExpExecArray | null;
                  while ((match = placeholderRe.exec(exprText)) !== null) {
                    exprRefs.add(`${match[1]}.${match[2]}`);
                  }
                  const declaredRefs = new Set(
                    (measure.source_columns ?? [])
                      .filter((s) => s.view && s.field)
                      .map((s) => `${s.view}.${s.field}`),
                  );
                  const missing = [...exprRefs].filter((r) => !declaredRefs.has(r));
                  const extra = [...declaredRefs].filter((r) => !exprRefs.has(r));

                  return (
                  <div className="space-y-1.5">
                    {(measure.source_columns ?? []).map((src, idx) => {
                      const targetView = modelViews?.find((v) => v.name === src.view);
                      const fieldOptions = targetView
                        ? [
                            ...targetView.dimensions.filter((d) => !d.hidden).map((d) => d.name),
                          ]
                        : [];
                      return (
                        <div key={idx} className="flex items-center gap-1">
                          <select
                            value={src.view}
                            disabled={!canEdit}
                            onChange={(e) => {
                              const next = [...(measure.source_columns ?? [])];
                              next[idx] = { view: e.target.value, field: '' };
                              onChange({ ...measure, source_columns: next });
                            }}
                            className="flex-1 text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
                          >
                            <option value="">Chọn bảng…</option>
                            {(modelViews ?? [])
                              .filter((v) => !v.hidden_in_canvas)
                              .map((v) => (
                                <option key={v.id} value={v.name}>
                                  {v.table_display_name || v.name}
                                </option>
                              ))}
                          </select>
                          <span className="text-[10px] text-text-quaternary">.</span>
                          <select
                            value={src.field}
                            disabled={!canEdit || !src.view}
                            onChange={(e) => {
                              const next = [...(measure.source_columns ?? [])];
                              next[idx] = { view: src.view, field: e.target.value };
                              onChange({ ...measure, source_columns: next });
                            }}
                            className="flex-1 text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
                          >
                            <option value="">Chọn cột…</option>
                            {fieldOptions.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                          {canEdit && (
                            <button
                              onClick={() => {
                                const next = (measure.source_columns ?? []).filter((_, i) => i !== idx);
                                onChange({ ...measure, source_columns: next });
                              }}
                              className="text-[10px] text-text-quaternary hover:text-danger"
                              title="Xoá entry"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {canEdit && (
                      <button
                        onClick={() => {
                          const next = [...(measure.source_columns ?? []), { view: '', field: '' }];
                          onChange({ ...measure, source_columns: next });
                        }}
                        className="text-[10px] text-brand hover:underline"
                      >
                        + Add source column
                      </button>
                    )}

                    {/* Phase-13.3: drift between expression placeholders and
                        declared source_columns. Missing = ref in expression
                        but not declared; extra = declared but unused. */}
                    {missing.length > 0 && (
                      <div className="rounded-md border border-warning/40 bg-warning/5 p-1.5 text-[10px] text-warning">
                        <div className="font-emphasis">
                          Thiếu {missing.length} cột nguồn trong expression:
                        </div>
                        <div className="mt-0.5 space-y-0.5">
                          {missing.map((ref) => {
                            const [v, f] = ref.split('.', 2);
                            return (
                              <div key={ref} className="flex items-center gap-1">
                                <code className="font-mono">{ref}</code>
                                {canEdit && (
                                  <button
                                    className="text-[10px] underline hover:no-underline"
                                    onClick={() => {
                                      const next = [
                                        ...(measure.source_columns ?? []),
                                        { view: v, field: f },
                                      ];
                                      onChange({ ...measure, source_columns: next });
                                    }}
                                    title="Thêm vào source_columns"
                                  >
                                    + add
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {extra.length > 0 && (
                      <div className="rounded-md border border-text-quaternary/30 bg-surface-2 p-1.5 text-[10px] text-text-tertiary">
                        <div>
                          Có {extra.length} cột nguồn khai báo nhưng không dùng trong expression:
                        </div>
                        <div className="mt-0.5 font-mono">{extra.join(', ')}</div>
                      </div>
                    )}
                    {exprRefs.size === 0 && declaredRefs.size === 0 && (
                      <div className="rounded-md bg-surface-2 p-1.5 text-[10px] leading-snug text-text-quaternary">
                        <div className="font-emphasis text-text-tertiary">Ví dụ:</div>
                        <code className="block font-mono text-[10px]">
                          SUM(${'{deals.amount}'}) / NULLIF(COUNT(DISTINCT ${'{leads.id}'}), 0)
                        </code>
                        <div className="mt-1">
                          Khai báo source columns: <code>deals.amount</code>, <code>leads.id</code>.
                          Engine sẽ tự JOIN deals và leads vào query.
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })()}
              </div>
              )}

            </div>
          )}

          {/* Filter Context — only for aggregations that produce a numeric
              total. COUNT / COUNT DISTINCT measure rows or entities, so
              "% of total" / "% within group" produces confusing window
              semantics (a row count divided by a row count is just 1.0
              per group). Hide entirely for those types. */}
          {measure.type !== 'count' && measure.type !== 'count_distinct' && (
            <FilterContextModifiers
              measure={measure}
              canEdit={canEdit}
              onChange={onChange}
            />
          )}

          {/* Inline "Chạy thử" — only in legacy (non-split) layout. In split
              layout the previewPane lives in the RIGHT column instead. */}
          {!splitLayout && canPreview && (
            <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2">
              {previewPane}
            </div>
          )}

          {/* SQL compile preview — shows the user what the engine will
              actually produce. Faithful to semantic_query_engine.py
              compile path: expression OR sql, wrapped in type (skipped
              for formula), with WHERE merged from filters + where_sql.
              Helps demystify which fields are load-bearing. */}
          {!hasErrors && (() => {
            const aggFn = ({
              count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
              count_distinct: 'COUNT DISTINCT', percent_of_total: 'SUM',
            } as Record<MeasureDefinition['type'], string>)[measure.type];
            const valueExpr = mode === 'lowcode'
              ? (measure.type === 'count' ? '*' : (measure.sql || '<chọn cột>'))
              // friendly view names in the preview too (match the box)
              : (rewriteExprViewTokens(measure.expression || '', techToDisplay) || '<biểu thức>');
            const whereParts: string[] = [];
            if (filters.length > 0) whereParts.push(`${filters.length} filter`);
            if (measure.where_sql) whereParts.push('WHERE bổ sung');
            const whereHint = whereParts.length > 0 ? ` (với ${whereParts.join(' + ')})` : '';
            const ctxHint = (measure.context_modifiers?.length ?? 0) > 0
              ? ' OVER (...)' : '';
            const preview = mode === 'formula'
              ? valueExpr  // formula returns raw expression
              : `${aggFn}(${valueExpr})${ctxHint}`;
            return (
              <div className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[10px]">
                <span className="font-emphasis text-text-tertiary uppercase tracking-wide">Sẽ compile thành: </span>
                <code className="font-mono text-text-secondary">{preview}</code>
                {whereHint && <span className="text-text-quaternary">{whereHint}</span>}
                {measure.type === 'percent_of_total' && mode !== 'formula' && (
                  <span className="text-text-quaternary"> ÷ tổng OVER ()</span>
                )}
              </div>
            );
          })()}

          {/* Validation summary banner. Shows when this row has any
              errors so the user sees a count at the bottom of the form
              instead of having to scroll up. The parent ViewMeasuresTab
              reads data-measure-invalid on the wrapper to disable Save. */}
          {hasErrors && (
            <div className="bi-fade-in rounded-md border border-danger/40 bg-danger/5 px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-danger">
                <span>⚠</span>
                <span>Measure này có {Object.keys(errors).length} lỗi — sửa trước khi lưu:</span>
              </div>
              <ul className="mt-1 ml-4 list-disc text-[10px] text-danger/90 leading-snug">
                {Object.entries(errors).map(([k, msg]) => (
                  <li key={k}>{msg}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {/* E3: split-layout right pane = resizable divider + preview ("Chạy
            thử"). Only in splitLayout; legacy renders preview inline above. */}
        {splitLayout && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startSplitDrag}
              className="w-1.5 shrink-0 cursor-col-resize bg-[rgb(var(--border-line))] hover:bg-brand/40 transition-colors"
              title="Kéo để chỉnh độ rộng"
            />
            <div className="flex-1 min-w-0 overflow-auto px-3 pb-3 pt-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary mb-1.5">
                Chạy thử — xem kết quả thật
              </div>
              {canPreview ? previewPane : (
                <p className="text-[10px] text-text-quaternary italic">Không chạy thử được trên bảng này.</p>
              )}
            </div>
          </>
        )}
        </div>
      )}
    </div>
  );
}

// ─── ModelViewEditPanel (main export) ────────────────────────────────────────

export interface ModelViewEditPanelProps {
  datasetId: number;
  view: DatasetModelView | null;           // null = no table selected
  modelViews?: DatasetModelView[];
  tables: DatasetTable[];
  canEdit: boolean;
  onClose?: () => void;
  initialTab?: PanelTab;
  showDictionaryTab?: boolean;
  contentMode?: PanelContentMode;
  titleKicker?: string;
  focusMeasureName?: string | null;
  triggerAddMeasure?: number;
  /** When true, only the measure matching focusMeasureName is rendered (single-measure editing mode) */
  singleMeasureMode?: boolean;
  /** D2: a new measure's "Bảng" selector switches which view is edited. */
  onRetargetView?: (viewId: number) => void;
  /** Ask the parent page to open the AddColumnModal targeting the underlying table. */
  onRequestAddColumn?: (tableId: number) => void;
}

/**
 * Imperative API the parent (dataset page) uses to guard navigation away from
 * a dirty measure editor — see the "leave modal" on the dataset page. The page
 * owns the navigation; the panel owns the unsaved state + the save/draft/discard
 * actions, so they're exposed here rather than lifted into the page.
 */
export interface ModelViewEditPanelHandle {
  hasUnsavedChanges: () => boolean;
  canSave: () => boolean;
  /** Run the full Save (validate + dry-run + PUT). Resolves true on success. */
  save: () => Promise<boolean>;
  /** Persist the current edits to a local draft (does NOT touch the BE). */
  saveDraft: () => void;
  /** Revert edits to the saved view + drop the local draft. */
  discardChanges: () => void;
}

export const ModelViewEditPanel = forwardRef<ModelViewEditPanelHandle, ModelViewEditPanelProps>(function ModelViewEditPanel({
  datasetId,
  view,
  modelViews,
  tables,
  canEdit,
  onClose,
  initialTab = 'fields',
  showDictionaryTab = true,
  contentMode = 'all-fields',
  titleKicker = 'Model view',
  focusMeasureName,
  triggerAddMeasure,
  singleMeasureMode = false,
  onRetargetView,
  onRequestAddColumn,
}: ModelViewEditPanelProps, ref) {
  const [activeTab, setActiveTab] = useState<PanelTab>(showDictionaryTab ? initialTab : 'fields');

  const tableId = view?.dataset_table_id ?? null;

  // ── Dictionary state ──────────────────────────────────────────────────────
  const { data: rawDict } = useDatasetDictionary(datasetId);
  const updateDict = useUpdateDatasetDictionary(datasetId);

  const [dictDraft, setDictDraft] = useState<DatasetDictionary | null>(null);
  const [dictDirty, setDictDirty] = useState(false);

  // AI preview
  const previewAi = usePreviewTableDescription(datasetId, tableId ?? 0);
  const [aiDraftPayload, setAiDraftPayload] = useState<TableDescriptionPreview | null>(null);
  const [aiDiffOpen, setAiDiffOpen] = useState(false);

  const sourceTable = useMemo(
    () => tables.find((t) => t.id === tableId) ?? null,
    [tables, tableId],
  );

  const normalized = useMemo(() => normalizeDictionary(rawDict?.dictionary), [rawDict]);

  useEffect(() => {
    if (tableId == null) {
      setDictDraft(null);
      setDictDirty(false);
      return;
    }
    const next = { ...normalized };
    if (!next.table_notes.some((n) => n.table_id === tableId)) {
      next.table_notes = [...next.table_notes, emptyTable(tableId)];
    }
    setDictDraft(next);
    setDictDirty(false);
  }, [tableId, normalized]);

  const tableNote = useMemo(
    () => dictDraft?.table_notes.find((n) => n.table_id === tableId) ?? null,
    [dictDraft, tableId],
  );

  const patchDictionary = useCallback(
    (updater: (current: DatasetDictionary) => DatasetDictionary) => {
      setDictDraft((prev) => (prev ? updater(prev) : prev));
      setDictDirty(true);
    },
    [],
  );

  const patchTableNote = useCallback(
    (updater: (note: DatasetDictionaryTableNote) => DatasetDictionaryTableNote) => {
      if (!tableId) return;
      patchDictionary((current) => ({
        ...current,
        table_notes: current.table_notes.map((n) =>
          n.table_id === tableId ? updater(n) : n,
        ),
      }));
    },
    [tableId, patchDictionary],
  );

  const handleSaveDict = async () => {
    if (!dictDraft) return;
    try {
      await updateDict.mutateAsync(buildPayload(dictDraft));
      setDictDirty(false);
      toast.success('Dictionary saved');
    } catch {
      toast.error('Failed to save dictionary');
    }
  };

  const handleGenerateAi = async () => {
    if (!tableId) return;
    try {
      const result = await previewAi.mutateAsync();
      setAiDraftPayload(result);
      setAiDiffOpen(true);
    } catch {
      toast.error('AI generation failed');
    }
  };

  const handleApplyAi = (edited: TableDescriptionPreview) => {
    if (!tableNote || !tableId) return;
    const mergedNotes = mergeColumnDescriptions(tableNote.column_notes ?? [], edited.column_descriptions);
    patchDictionary((current) => ({
      ...current,
      table_notes: current.table_notes.map((n) =>
        n.table_id === tableId
          ? { ...n, business_role: edited.description || n.business_role, column_notes: mergedNotes }
          : n,
      ),
    }));
    setAiDiffOpen(false);
    setAiDraftPayload(null);
    toast.success('AI description applied — save to persist.');
  };

  // ── Model/Fields state ────────────────────────────────────────────────────
  const [dimensions, setDimensions] = useState<DimensionDefinition[]>([]);
  const [measures, setMeasures] = useState<MeasureDefinition[]>([]);
  const [dimensionRowKeys, setDimensionRowKeys] = useState<string[]>([]);
  const [measureRowKeys, setMeasureRowKeys] = useState<string[]>([]);
  const [viewDescription, setViewDescription] = useState('');
  const [showMeasureTemplates, setShowMeasureTemplates] = useState(false);
  // E2: rowKey of a freshly-added blank measure being configured (single-
  // measure config model). Null when editing an existing measure (driven by
  // focusMeasureName) or showing the empty-state.
  const [activeNewRowKey, setActiveNewRowKey] = useState<string | null>(null);
  // Phase-15.5: time-intelligence dialog state. Open when user picks the
  // dedicated "+ Time intelligence (smart)" entry in the Add Measure menu.
  const [showTimeIntelDialog, setShowTimeIntelDialog] = useState(false);
  // A2 (2026-06-10): "đang kiểm tra cú pháp measure" — true while the save
  // handler is compile-checking measures against the engine (dry-run). Keeps
  // the Save button in a loading state so DA sees the check is running.
  const [isCheckingSyntax, setIsCheckingSyntax] = useState(false);
  const updateView = useUpdateModelView();
  // Phase-15.64 — surgical DELETE for existing measures (bypasses the
  // full-batch PUT validation that blocks deletes when ANY measure has
  // legacy invalid shape).
  const deleteMeasureMutation = useDeleteModelMeasure();

  // E2: the page signals "add a new measure" via the sentinel
  // focusMeasureName === '__new__' (deterministic; no add-counter/effect-timing
  // races). The unified view-load effect below appends the blank when it sees
  // the sentinel.
  const isAddingNew = focusMeasureName === NEW_MEASURE_SENTINEL;

  // Pick-list for the form-first measure editor. Source = the table's
  // `columns_cache` (which reflects any Calculated Column added via
  // Transformation), so a freshly added column shows up immediately without
  // first having to declare a dimension for it.
  const sourceColumnsMeta = useMemo(() => tableColumnsMeta(sourceTable), [sourceTable]);

  const columnOptions = useMemo(() => {
    const set = new Set<string>();
    for (const col of sourceColumnsMeta) {
      if (col.name) set.add(col.name);
    }
    // Fall back to dimension names if the table has no cached columns yet
    // (e.g. brand-new dataset still importing). Better to show something than
    // an empty datalist.
    if (set.size === 0) {
      for (const d of dimensions) {
        if (d.name) set.add(d.name);
      }
    }
    return Array.from(set).sort();
  }, [sourceColumnsMeta, dimensions]);

  const measureDependencyRefs = useMemo(() => {
    const refs = new Set<string>();
    const currentViewName = view?.name;
    for (const m of measures) {
      const name = (m.name || '').trim();
      if (!name) continue;
      refs.add(name);
      if (currentViewName) refs.add(`${currentViewName}.${name}`);
    }
    for (const modelView of modelViews ?? []) {
      for (const measure of modelView.measures ?? []) {
        const name = (measure.name || '').trim();
        if (!name) continue;
        refs.add(modelView.name === currentViewName ? name : `${modelView.name}.${name}`);
      }
    }
    return Array.from(refs).sort();
  }, [measures, modelViews, view?.name]);

  const makeClientRowKey = useCallback((kind: 'dimension' | 'measure') => {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `new-${kind}-${randomPart}`;
  }, []);

  const handleAddMeasureFromTemplate = (tpl: MeasureTemplate) => {
    const rowKey = makeClientRowKey('measure');
    setMeasures((prev) => {
      let n = prev.length + 1;
      const existing = new Set(prev.map((m) => m.name));
      let candidate = tpl.build(n);
      while (existing.has(candidate.name)) {
        n += 1;
        candidate = tpl.build(n);
      }
      return [...prev, candidate];
    });
    setMeasureRowKeys((prev) => [...prev, rowKey]);
    setShowMeasureTemplates(false);
  };

  // E1/E2: Add a BLANK measure (default SUM, no column) and make it the single
  // active config. No template picker — DA picks "Cách tính" in the form. The
  // new row's key is tracked in `activeNewRowKey` so the panel renders just
  // this measure's config (toolbar-driven single-measure model).
  const handleAddBlankMeasure = () => {
    const rowKey = makeClientRowKey('measure');
    setMeasures((prev) => {
      let n = prev.length + 1;
      const existing = new Set(prev.map((m) => m.name));
      let name = `measure_${n}`;
      while (existing.has(name)) { n += 1; name = `measure_${n}`; }
      const blank: MeasureDefinition = { name, label: '', type: 'sum', sql: '', hidden: false };
      return [...prev, blank];
    });
    setMeasureRowKeys((prev) => [...prev, rowKey]);
    setActiveNewRowKey(rowKey);
  };

  // Set true by the leave-modal's save/saveDraft/discardChanges so the
  // flush-on-unmount safety net (below) doesn't re-persist a draft the user
  // just resolved. Reset whenever a view (re)loads — a fresh editing context.
  const leaveHandledRef = useRef(false);

  // Unified view-load + new-measure effect. Runs on view change OR when the
  // add sentinel toggles. ALWAYS rebuilds dimensions/measures from the view
  // first; THEN, if the page is in add-mode (focusMeasureName === '__new__'),
  // appends a blank measure and marks it active. One effect = no ordering bug.
  useEffect(() => {
    if (!view) return;
    leaveHandledRef.current = false;
    const baseMeasures = view.measures.map((m) => ({ ...m }));
    const baseMeasureKeys = view.measures.map((m, index) => `${view.id}:measure:${index}:${m.name || 'field'}`);

    setDimensions(view.dimensions.map((d) => ({ ...d })));
    setDimensionRowKeys(view.dimensions.map((d, index) => `${view.id}:dimension:${index}:${d.name || 'field'}`));
    setViewDescription(view.description || '');

    if (isAddingNew) {
      const existing = new Set(baseMeasures.map((m) => m.name));
      let n = baseMeasures.length + 1;
      let name = `measure_${n}`;
      while (existing.has(name)) { n += 1; name = `measure_${n}`; }
      const rowKey = makeClientRowKey('measure');
      setMeasures([...baseMeasures, { name, label: '', type: 'sum', sql: '', hidden: false } as MeasureDefinition]);
      setMeasureRowKeys([...baseMeasureKeys, rowKey]);
      setActiveNewRowKey(rowKey);
    } else {
      setMeasures(baseMeasures);
      setMeasureRowKeys(baseMeasureKeys);
      setActiveNewRowKey(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, isAddingNew]);

  const modelIsDirty =
    !!view && (
      JSON.stringify(measures) !== JSON.stringify(view.measures) ||
      (contentMode !== 'measures' && (
        JSON.stringify(dimensions) !== JSON.stringify(view.dimensions) ||
        viewDescription !== (view.description || '')
      ))
    );

  // ── Draft (UX: never lose measure config) — EXPLICIT mode ──────────────────
  // Snapshots the full editable model state (incl. row keys so rename detection
  // survives a restore). autosave:false → the hook never writes on its own; a
  // draft is created ONLY when the user picks "Lưu nháp" in the leave-modal
  // (→ saveDraft/flush) or on beforeunload (silent flush). Restore is via a
  // banner (never auto-applied). The draft lives in localStorage and NEVER
  // touches the BE — reports keep the saved formula until an explicit Save.
  const draftValue = useMemo(
    () => ({ measures, dimensions, viewDescription, measureRowKeys, dimensionRowKeys }),
    [measures, dimensions, viewDescription, measureRowKeys, dimensionRowKeys],
  );
  const draftKey = view ? `appbi:measure-draft:v1:${datasetId}:${view.id}` : null;
  const { pendingDraft, restore: restoreDraft, discard: discardDraft, flush: flushDraft } = useLocalDraft({
    key: draftKey,
    value: draftValue,
    isDirty: modelIsDirty,
    enabled: canEdit && !!view,
    autosave: false,
  });

  // A stored draft equal to the saved baseline (e.g. written by flush-on-leave
  // when nothing was actually edited) must not surface a banner. The baseline
  // lives on `view.*` here, so we compare the SEMANTIC fields only (row keys
  // are editing-identity, not part of the saved record) and drop equal drafts.
  const draftDiffersFromSaved = useMemo(() => {
    if (!pendingDraft || !view) return false;
    const baseline = JSON.stringify({
      measures: view.measures ?? [],
      dimensions: view.dimensions ?? [],
      viewDescription: view.description || '',
    });
    const draft = JSON.stringify({
      measures: pendingDraft.data.measures ?? [],
      dimensions: pendingDraft.data.dimensions ?? [],
      viewDescription: pendingDraft.data.viewDescription || '',
    });
    return baseline !== draft;
  }, [pendingDraft, view]);

  useEffect(() => {
    if (pendingDraft && view && !draftDiffersFromSaved) discardDraft();
  }, [pendingDraft, view, draftDiffersFromSaved, discardDraft]);

  const applyDraft = () => {
    const data = restoreDraft();
    if (!data || !view) return;
    const restoredMeasures = Array.isArray(data.measures) ? data.measures : [];
    const restoredDimensions = Array.isArray(data.dimensions) ? data.dimensions : [];
    setMeasures(restoredMeasures);
    setDimensions(restoredDimensions);
    setViewDescription(data.viewDescription || '');
    setMeasureRowKeys(
      Array.isArray(data.measureRowKeys) && data.measureRowKeys.length === restoredMeasures.length
        ? data.measureRowKeys
        : restoredMeasures.map((m, index) => `${view.id}:measure:${index}:${m.name || 'field'}`),
    );
    setDimensionRowKeys(
      Array.isArray(data.dimensionRowKeys) && data.dimensionRowKeys.length === restoredDimensions.length
        ? data.dimensionRowKeys
        : restoredDimensions.map((d, index) => `${view.id}:dimension:${index}:${d.name || 'field'}`),
    );
    setActiveNewRowKey(null);
  };

  // Revert the in-memory edits back to the saved view + drop the local draft.
  // Used by the leave-modal's "Bỏ thay đổi". Mirrors the unified view-load.
  const discardChanges = useCallback(() => {
    if (!view) return;
    setMeasures(view.measures.map((m) => ({ ...m })));
    setMeasureRowKeys(view.measures.map((m, index) => `${view.id}:measure:${index}:${m.name || 'field'}`));
    setDimensions(view.dimensions.map((d) => ({ ...d })));
    setDimensionRowKeys(view.dimensions.map((d, index) => `${view.id}:dimension:${index}:${d.name || 'field'}`));
    setViewDescription(view.description || '');
    setActiveNewRowKey(null);
    discardDraft();
  }, [view, discardDraft]);

  // Hard-unload safety net (refresh / close tab / external URL): browsers don't
  // allow a custom dialog here, so instead of the ugly native "Leave site?"
  // prompt we SILENTLY flush the current edits to a local draft (no
  // preventDefault). On return, the restore banner offers it back. In-app
  // leaves are handled by the explicit leave-modal on the dataset page.
  useEffect(() => {
    if (!modelIsDirty) return;
    const onBeforeUnload = () => { flushDraft(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [modelIsDirty, flushDraft]);

  // Flush-on-unmount safety net. The leave-modal on the dataset page only
  // intercepts in-page navigation (switch table/tab/breadcrumb). It CANNOT
  // catch a client-side route change — e.g. clicking the left sidebar to
  // another page — and `beforeunload` does NOT fire for Next.js soft
  // navigation. Without this, editing a measure then navigating away via the
  // app menu silently dropped the work (no draft, no prompt). On unmount we
  // flush a draft if still dirty (recoverable via the restore banner), UNLESS
  // the user already resolved the leave through the modal (Save/Draft/Discard).
  const unmountFlushRef = useRef<() => void>(() => {});
  unmountFlushRef.current = () => {
    if (!leaveHandledRef.current) flushDraft();
  };
  useEffect(() => () => unmountFlushRef.current(), []);

  const handleSaveModel = async (): Promise<boolean> => {
    if (!view) return false;
    // ── Client-side validation: catch misconfigurations before the round-trip ──

    /** Mirror of backend MeasureDefinition.validate_sql_fragment */
    const SQL_FORBIDDEN = [';', '--', '/*', '*/', ' drop ', ' delete ', ' insert ', ' update ', ' alter ', ' create ', ' truncate ', ' execute ', ' grant ', ' revoke '];
    const hasForbiddenSql = (fragment: string | undefined) => {
      if (!fragment?.trim()) return false;
      const padded = ` ${fragment.trim().toLowerCase()} `;
      return SQL_FORBIDDEN.some((t) => padded.includes(t));
    };

    const errors: string[] = [];
    const seen = new Map<string, number>();
    const currentViewName = view.name;
    const localMeasureNames = new Set(
      measures.map((m) => (m.name || '').trim()).filter(Boolean),
    );
    const modelMeasureRefs = new Set<string>();
    for (const modelView of modelViews ?? []) {
      for (const measure of modelView.measures ?? []) {
        const name = (measure.name || '').trim();
        if (name) modelMeasureRefs.add(`${modelView.name}.${name}`);
      }
    }
    for (const name of localMeasureNames) {
      modelMeasureRefs.add(`${currentViewName}.${name}`);
    }

    // Pre-existing measures keep their original name from the BE as the
    // row key suffix (`${view.id}:measure:${origIndex}:${originalName}`).
    // Skip the identifier-regex check on those rows when the user has NOT
    // renamed them — the BE already accepted that name on creation, so
    // re-validating now would block unrelated edits (e.g. deleting a
    // different measure) just because a legacy measure has a space in
    // its name. New measures and renamed measures still get validated.
    const isLegacyUnchanged = (idx: number, name: string): boolean => {
      const key = measureRowKeys[idx];
      if (!key || key.startsWith('new-measure')) return false;
      // Parse the originalName tail — everything after the 3rd ':'.
      const tail = key.split(':').slice(3).join(':');
      return tail === name;
    };

    measures.forEach((m, i) => {
      const trimmedName = (m.name || '').trim();
      if (!trimmedName) {
        errors.push(`Measure #${i + 1}: name is required`);
      } else if (
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedName)
        && !isLegacyUnchanged(i, trimmedName)
      ) {
        errors.push(`Measure "${trimmedName}": name must start with a letter or underscore and contain only letters, digits, or underscores`);
      } else if (seen.has(trimmedName)) {
        errors.push(`Duplicate measure name "${trimmedName}"`);
      } else {
        seen.set(trimmedName, i);
      }
      const needsColumn = m.type !== 'count' && !m.expression;
      if (needsColumn && !(m.sql || '').trim()) {
        errors.push(`Measure "${trimmedName || `#${i + 1}`}": choose a column to aggregate (or write an SQL expression under Advanced)`);
      }
      if (hasForbiddenSql(m.expression)) {
        errors.push(`Measure "${trimmedName}": SQL expression contains a forbidden token`);
      }
      if (hasForbiddenSql(m.where_sql)) {
        errors.push(`Measure "${trimmedName}": WHERE SQL contains a forbidden token`);
      }
      for (const dep of m.depends_on || []) {
        const normalizedDep = String(dep || '').trim();
        if (!normalizedDep) continue;
        if (normalizedDep === trimmedName || normalizedDep === `${currentViewName}.${trimmedName}`) {
          errors.push(`Measure "${trimmedName}": cannot depend on itself`);
          continue;
        }
        if (normalizedDep.includes('.')) {
          if (!modelMeasureRefs.has(normalizedDep)) {
            errors.push(`Measure "${trimmedName}": depends_on "${normalizedDep}" doesn't match any measure in this model`);
          }
        } else if (!localMeasureNames.has(normalizedDep)) {
          errors.push(`Measure "${trimmedName}": depends_on "${normalizedDep}" doesn't match any measure in this view`);
        }
      }
      (m.filters || []).forEach((f, fi) => {
        if (!(f.field || '').trim()) {
          errors.push(`Measure "${trimmedName}": filter #${fi + 1} chưa chọn trường — bấm vào ô Field để chọn cột trước khi lưu`);
        }
      });
    });

    if (errors.length) {
      toast.error(errors[0]);
      return false;
    }

    // A2 (2026-06-10): compile-check measures through the REAL engine before
    // save. The static checks above only catch SHAPE problems (name format,
    // missing column, depends_on existence). They CANNOT tell valid SQL from
    // broken SQL — that needs the engine (dialect + views + join graph). DA
    // hit this: a measure with bad syntax saved fine, then crashed at Explore
    // "Run". We dry-run each measure that carries advanced SQL (expression /
    // raw WHERE / cross-table); pure low-code measures (just agg + a column)
    // can't have a syntax error, so we skip them to keep Save fast.
    const needsDryRun = (m: MeasureDefinition): boolean =>
      Boolean((m.expression || '').trim() || (m.where_sql || '').trim() || m.scope === 'dataset');
    const dryRunTargets = measures.filter(needsDryRun);
    if (dryRunTargets.length > 0) {
      setIsCheckingSyntax(true);
      try {
        for (const m of dryRunTargets) {
          let result;
          try {
            result = await dryRunMeasure({ datasetId, viewId: view.id, measure: m });
          } catch {
            // A 4xx/5xx from the dry-run endpoint itself (access / not-found /
            // system table) — don't block the save on an infra hiccup; let the
            // normal save path run and surface any real error there.
            continue;
          }
          if (!result.ok) {
            toast.error(
              `Measure "${m.label || m.name}" có lỗi cú pháp — sửa trước khi lưu:\n${result.error ?? 'SQL không hợp lệ'}`,
            );
            return false;
          }
        }
      } finally {
        setIsCheckingSyntax(false);
      }
    }

    // Phase-6: detect renames so the BE can auto-rewrite chart configs
    // and depends_on references instead of dropping into the cascade
    // dialog. Each row carries `measureRowKeys[idx]` like
    // `${view.id}:measure:${origIndex}:${originalName}`. New rows use
    // `new-measure-${uuid}` and are skipped.
    const renameMap: Record<string, string> = {};
    measures.forEach((m, idx) => {
      const rowKey = measureRowKeys[idx];
      if (!rowKey || rowKey.startsWith('new-measure')) return;
      const parts = rowKey.split(':');
      // Format: "${viewId}:measure:${origIndex}:${origName}". Anything else
      // we treat as unknown and skip — better to no-op than mis-map.
      if (parts.length < 4 || parts[1] !== 'measure') return;
      const originalName = parts.slice(3).join(':'); // measure name might contain ':' (rare)
      const newName = (m.name || '').trim();
      if (originalName && newName && originalName !== newName) {
        renameMap[originalName] = newName;
      }
    });

    // Phase-3: handle 409 cascade conflict. When BE detects deleted/renamed
    // measures still used by charts, it returns 409 with a structured detail
    // payload. We surface a confirm dialog so the user can choose to force-save
    // (charts will then show "field not found" until rebound) or cancel.
    const trySave = async (force: boolean) => {
      await updateView.mutateAsync({
        datasetId,
        viewId: view.id,
        data: {
          dimensions,
          measures,
          description: viewDescription,
          // Phase-6: only attach rename_map when something actually changed
          // so the BE rewrite path is a no-op for normal saves.
          ...(Object.keys(renameMap).length > 0 ? { rename_map: renameMap } : {}),
        },
        force,
      });
    };

    try {
      const result = (await trySave(false)) as unknown as { renamed?: Record<string, number> } | undefined;
      // Phase-6: BE returns a `renamed` summary like {charts: 3, depends_on: 1}
      // when rename_map was applied. Surface it so the user knows how many
      // consumers got auto-rewritten.
      const renamedTotal = result && result.renamed
        ? Object.values(result.renamed).reduce((a, b) => a + b, 0)
        : 0;
      if (Object.keys(renameMap).length > 0 && renamedTotal > 0) {
        toast.success(
          `Đã đổi tên ${Object.keys(renameMap).length} measure và cập nhật ${renamedTotal} tham chiếu (chart / depends_on / expression).`,
        );
      } else {
        toast.success(contentMode === 'measures' ? 'Measures saved' : 'Fields saved');
      }
      // Persisted to the BE — drop the local draft so a later reload doesn't
      // offer to "restore" what's already saved.
      discardDraft();
      return true;
    } catch (error: unknown) {
      const response = (error as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
      const detail = response?.data?.detail;
      // Structured cascade payload from the BE → prompt for confirmation.
      const isCascade =
        response?.status === 409 &&
        typeof detail === 'object' &&
        detail !== null &&
        (detail as { code?: string }).code === 'MEASURE_CASCADE';
      if (isCascade) {
        const payload = detail as { message: string; affected_charts: string[]; dropped: string[] };
        const lines = payload.affected_charts.slice(0, 6).join('\n');
        const extra = payload.affected_charts.length > 6
          ? `\n…và ${payload.affected_charts.length - 6} chart khác.`
          : '';
        const proceed = window.confirm(
          `${payload.message}\n\nChart bị ảnh hưởng:\n${lines}${extra}\n\nXác nhận để vẫn lưu?`
        );
        if (proceed) {
          try {
            await trySave(true);
            discardDraft();
            toast.success('Đã lưu (cần sửa lại chart đang dùng).');
            return true;
          } catch (force_error: unknown) {
            const fd = (force_error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
            toast.error(typeof fd === 'string' ? fd : 'Force save failed');
            return false;
          }
        }
        return false;
      }
      toast.error(typeof detail === 'string' ? detail : contentMode === 'measures' ? 'Failed to save measures' : 'Failed to save fields');
      return false;
    }
  };

  // ── Unified save ──────────────────────────────────────────────────────────
  const isSavingAny = updateDict.isPending || updateView.isPending;
  // Block save when ANY measure row produces validation errors. Uses
  // the same validateMeasure() helper the row inputs use so the Save
  // button stays in lockstep with the visible red borders.
  const measureErrorCount = useMemo(
    () => measures.reduce((sum, m) => sum + Object.keys(validateMeasure(m)).length, 0),
    [measures],
  );
  const measuresHaveErrors = measureErrorCount > 0;
  const canSave = (activeTab === 'dictionary' ? dictDirty : modelIsDirty)
    && !(contentMode === 'measures' && measuresHaveErrors);

  // Imperative API for the dataset page's leave-guard modal (see header).
  // No deps array on purpose: the handle is rebuilt every render so `save`
  // always closes over the latest measures/handlers (memoizing by modelIsDirty
  // would freeze a stale handleSaveModel while edits keep the panel dirty).
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => modelIsDirty,
    canSave: () => !measuresHaveErrors,
    // Each leave action marks the leave as "handled" so the flush-on-unmount
    // net doesn't re-persist (or resurrect a discarded) draft when the panel
    // then unmounts. Reset on the next view-load (a fresh editing context).
    save: async () => { const ok = await handleSaveModel(); if (ok) leaveHandledRef.current = true; return ok; },
    saveDraft: () => { leaveHandledRef.current = true; flushDraft(); },
    discardChanges: () => { leaveHandledRef.current = true; discardChanges(); },
  }));

  const handleSave = () => {
    if (activeTab === 'dictionary') handleSaveDict();
    else handleSaveModel();
  };

  const hasTable = tableId != null && dictDraft && tableNote && sourceTable;

  // ── Render ────────────────────────────────────────────────────────────────
  // Panel is only mounted when view is non-null (parent conditionally renders),
  // but TypeScript doesn't know that — guard here so types stay narrow.
  if (!view) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-[rgb(var(--border-line))] bg-surface-1">

      {/* Header */}
      <div className="shrink-0 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-text-quaternary uppercase tracking-wide">{titleKicker}</p>
            <h3 className="text-sm font-semibold text-text-primary truncate">{view.table_display_name || view.name}</h3>
          </div>
          {/* Dirty indicators */}
          <div className="flex items-center gap-1.5 shrink-0">
            {dictDirty && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 border border-brand/30 px-2 py-0.5 text-[10px] font-medium text-brand">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                Dictionary
              </span>
            )}
            {modelIsDirty && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 border border-brand/30 px-2 py-0.5 text-[10px] font-medium text-brand">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                {contentMode === 'measures' ? 'Measures' : 'Fields'}
              </span>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="ml-1 rounded-md p-1 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-secondary"
                title="Close editor"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        {showDictionaryTab && (
          <div className="mt-2.5 flex gap-0.5 bg-surface-2 rounded-lg p-0.5">
            {([
              { key: 'dictionary' as PanelTab, label: 'Dictionary', dirty: dictDirty },
              { key: 'fields' as PanelTab, label: `Fields (${dimensions.length}D · ${measures.length}M)`, dirty: modelIsDirty },
            ] as const).map(({ key, label, dirty }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  activeTab === key
                    ? 'bg-surface-1 text-text-primary shadow-linear-sm'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {label}
                {dirty && <span className="h-1.5 w-1.5 rounded-full bg-brand shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

        {/* ── Dictionary tab ── */}
        {activeTab === 'dictionary' && (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {hasTable ? (
              <>
                {/* Table notes bar */}
                <TableNotesBar
                  tableNote={tableNote}
                  canEdit={canEdit}
                  isSaving={updateDict.isPending}
                  isGeneratingAi={previewAi.isPending}
                  onPatchNote={patchTableNote}
                  onGenerateAi={handleGenerateAi}
                />
                {/* Column grid */}
                <DictionaryColumnGrid
                  table={sourceTable}
                  tableNote={tableNote}
                  canEdit={canEdit}
                  isSaving={updateDict.isPending}
                  onPatchDictionary={patchDictionary}
                />
              </>
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-text-quaternary px-6 text-center gap-2">
                <Type className="w-6 h-6 opacity-40" />
                <p className="text-xs">No source table linked to this view.</p>
              </div>
            )}
          </div>
        )}

        {/* ── Fields tab ── */}
        {activeTab === 'fields' && (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Draft restore banner — appears when an autosaved draft for this
                table differs from what's saved (e.g. after a reload or after
                switching away mid-edit and coming back). Restore is explicit. */}
            {draftDiffersFromSaved && pendingDraft && (
              <div className="shrink-0 flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2">
                <RotateCcw className="h-3.5 w-3.5 text-warning shrink-0" />
                <span className="flex-1 text-[11px] leading-4 text-text-secondary">
                  Có bản nháp measure chưa lưu
                  {pendingDraft.savedAt ? ` (lúc ${new Date(pendingDraft.savedAt).toLocaleString('vi-VN')})` : ''} — khôi phục để tiếp tục chỉnh sửa?
                </span>
                <button
                  type="button"
                  onClick={applyDraft}
                  className="inline-flex items-center gap-1 rounded-md bg-warning px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 shrink-0"
                >
                  <RotateCcw className="h-3 w-3" /> Khôi phục
                </button>
                <button
                  type="button"
                  onClick={discardDraft}
                  className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-2 shrink-0"
                >
                  Bỏ
                </button>
              </div>
            )}
            {/* View description */}
            {contentMode !== 'measures' && (
              <div className="shrink-0 px-4 pt-3 pb-2 border-b border-[rgb(var(--border-line))]">
                <label className="text-[10px] text-text-tertiary uppercase font-medium">View description</label>
                <input
                  value={viewDescription}
                  onChange={(e) => setViewDescription(e.target.value)}
                  disabled={!canEdit}
                  className="mt-1 w-full text-xs px-2.5 py-1.5 border border-[rgb(var(--border-line))] rounded-md disabled:bg-surface-2 focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="Short description of this semantic view"
                />
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {/* Dimensions */}
              {contentMode !== 'measures' && (
                <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                    <Type className="w-3.5 h-3.5 text-brand" />
                    Dimensions
                    <span className="text-text-quaternary font-normal">({dimensions.length})</span>
                  </span>
                  {canEdit && (
                    <button
                      onClick={() => {
                        setDimensions((prev) => [...prev, { name: `dim_${prev.length + 1}`, type: 'string', hidden: false }]);
                        setDimensionRowKeys((prev) => [...prev, makeClientRowKey('dimension')]);
                      }}
                      className="inline-flex items-center gap-1 text-xs text-brand hover:text-brand font-medium"
                    >
                      <Plus className="w-3 h-3" /> Add
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {dimensions.map((dim, idx) => {
                    const rowKey = dimensionRowKeys[idx] ?? `dimension-${idx}`;
                    // Phase-15.1: pass sibling dim names (excluding self) so
                    // the Parent dropdown can list valid candidates.
                    const siblingDimNames = dimensions
                      .filter((d, i) => i !== idx && d.name)
                      .map((d) => d.name);
                    return (
                      <DimensionRow
                        key={rowKey}
                        rowKey={rowKey}
                        dim={dim}
                        canEdit={canEdit}
                        columnOptions={columnOptions}
                        siblingDimNames={siblingDimNames}
                        onChange={(u) => setDimensions((prev) => prev.map((d, i) => (i === idx ? u : d)))}
                        onRemove={() => {
                          setDimensions((prev) => prev.filter((_, i) => i !== idx));
                          setDimensionRowKeys((prev) => prev.filter((_, i) => i !== idx));
                        }}
                      />
                    );
                  })}
                  {dimensions.length === 0 && (
                    <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] py-4 text-center text-xs text-text-quaternary">
                      No dimensions — add one above
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Measures */}
              <div>
                {/* E6: in single-measure (split) mode the section header is
                    redundant — the row's own header carries the measure name +
                    actions, and Add lives in the toolbar. Show this header only
                    in the all-fields list mode. */}
                {!singleMeasureMode && (
                  <div className="flex items-center justify-between mb-2 relative">
                    <span className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                      <Sigma className="w-3.5 h-3.5 text-warning" />
                      Measures
                      <span className="text-text-quaternary font-normal">({measures.length})</span>
                    </span>
                    {canEdit && (
                      <button
                        onClick={() => handleAddBlankMeasure()}
                        className="inline-flex items-center gap-1 text-xs text-warning hover:text-warning font-medium"
                      >
                        <Plus className="w-3 h-3" /> {contentMode === 'measures' ? 'Add measure' : 'Add'}
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-1.5">
                  {(() => {
                    // E2: in the Measures workspace, edit ONE measure at a time —
                    // the active measure is the newly-added row (activeNewRowKey)
                    // or the one the toolbar selected (focusMeasureName). No
                    // active measure → empty-state. The all-fields model editor
                    // keeps the legacy full list (singleMeasure = false).
                    const singleMeasure = contentMode === 'measures';
                    const activeIndex = singleMeasure
                      ? measures.findIndex((m, i) =>
                          (activeNewRowKey && measureRowKeys[i] === activeNewRowKey)
                          || (focusMeasureName && m.name === focusMeasureName),
                        )
                      : -1;
                    const visibleIndexes = singleMeasure
                      ? (activeIndex >= 0 ? [activeIndex] : [])
                      : measures.map((_, i) => i);

                    if (singleMeasure && visibleIndexes.length === 0) {
                      return (
                        <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-10 text-center text-xs text-text-quaternary">
                          Chọn một measure ở thanh bên trái để chỉnh sửa, hoặc bấm <span className="font-medium text-text-tertiary">+ Add measure</span> để tạo mới.
                        </div>
                      );
                    }
                    if (!singleMeasure && measures.length === 0) {
                      return (
                        <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-5 text-center text-xs text-text-quaternary">
                          No measures yet
                        </div>
                      );
                    }
                    return visibleIndexes.map((idx) => {
                        const m = measures[idx];
                        const rowKey = measureRowKeys[idx] ?? `measure-${idx}`;
                        const isNewRow = rowKey === activeNewRowKey;
                        return (
                          <MeasureRow
                            key={rowKey}
                            rowKey={rowKey}
                            measure={m}
                            canEdit={canEdit}
                            columnOptions={columnOptions}
                            measureNames={measureDependencyRefs}
                            viewName={view.name}
                            viewId={view.id}
                            datasetId={datasetId}
                            modelViews={modelViews}
                            onRetargetView={isNewRow ? onRetargetView : undefined}
                            splitLayout={singleMeasure}
                            defaultOpen={singleMeasure || Boolean(focusMeasureName && m.name === focusMeasureName)}
                            onChange={(u) => setMeasures((prev) => prev.map((mm, i) => (i === idx ? u : mm)))}
                            onRemove={async () => {
                              // Phase-15.64 — if the measure exists on the
                              // server already, use the surgical DELETE
                              // endpoint instead of the full-batch PUT.
                              // The PUT path re-validates every measure
                              // and would block delete when ANY other
                              // measure has legacy invalid shape. The
                              // DELETE endpoint trusts the operation
                              // (user is REMOVING data, not adding bad).
                              const measureName = String(m.name || '').trim();
                              const existsOnServer = Boolean(
                                measureName
                                && (view?.measures ?? []).some(
                                  (sm: any) => String(sm?.name || '').trim() === measureName
                                ),
                              );
                              if (existsOnServer && view?.id != null) {
                                try {
                                  await deleteMeasureMutation.mutateAsync({
                                    datasetId,
                                    viewId: view.id,
                                    measureName,
                                  });
                                  toast.success(`Đã xoá measure "${measureName}".`);
                                } catch (err: any) {
                                  const detail = err?.response?.data?.detail;
                                  // Cascade prompt → ask + retry with force.
                                  if (
                                    err?.response?.status === 409
                                    && detail?.code === 'MEASURE_CASCADE'
                                  ) {
                                    const hits = (detail?.affected_charts || []).length;
                                    if (confirm(`${hits} chart đang dùng measure "${measureName}". Vẫn xoá?`)) {
                                      try {
                                        await deleteMeasureMutation.mutateAsync({
                                          datasetId,
                                          viewId: view.id,
                                          measureName,
                                          force: true,
                                        });
                                        toast.success(`Đã xoá measure "${measureName}" (force).`);
                                      } catch (forceErr: any) {
                                        toast.error(
                                          forceErr?.response?.data?.detail?.message
                                          || forceErr?.response?.data?.detail
                                          || 'Xoá không thành công.',
                                        );
                                        return;
                                      }
                                    } else {
                                      return;
                                    }
                                  } else {
                                    toast.error(
                                      detail?.message || detail || 'Xoá không thành công.',
                                    );
                                    return;
                                  }
                                }
                              }
                              setMeasures((prev) => prev.filter((_, i) => i !== idx));
                              setMeasureRowKeys((prev) => prev.filter((_, i) => i !== idx));
                              if (rowKey === activeNewRowKey) setActiveNewRowKey(null);
                            }}
                          />
                        );
                      });
                  })()}
                </div>
                {/* Bridge to the data layer: per-row calculations belong in
                    a Calculated Column on the source table, not inside a
                    measure. Surface the path back to the AddColumnModal so
                    users don't have to navigate away. */}
                {canEdit && !singleMeasureMode && onRequestAddColumn && tableId != null && (
                  <button
                    type="button"
                    onClick={() => onRequestAddColumn(tableId)}
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-brand"
                    title="Tạo cột tính toán mới trên bảng nguồn — cột sẽ dùng được cho mọi measure & dimension trên bảng này"
                  >
                    <Plus className="w-3 h-3" />
                    Không thấy cột cần thiết? Thêm Calculated Column vào bảng này →
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer — single Save */}
      {canEdit && (
        <div className="flex items-center gap-2 shrink-0 border-t border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
          <span className={`text-[11px] flex-1 truncate ${
            contentMode === 'measures' && measuresHaveErrors ? 'text-danger font-medium' : 'text-text-quaternary'
          }`}>
            {activeTab === 'dictionary'
              ? (dictDirty ? 'Unsaved dictionary changes' : 'Dictionary up to date')
              : contentMode === 'measures'
                ? (
                    measuresHaveErrors
                      ? `⚠ ${measureErrorCount} lỗi trong measures — sửa trước khi lưu`
                      : (modelIsDirty ? 'Unsaved measure changes' : 'Measures up to date')
                  )
                : (modelIsDirty ? 'Unsaved field changes' : 'Fields up to date')}
          </span>
          <button
            onClick={handleSave}
            disabled={!canSave || isSavingAny || isCheckingSyntax}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-40 transition-colors"
          >
            {(isSavingAny || isCheckingSyntax) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {isCheckingSyntax ? 'Đang kiểm tra cú pháp…' : 'Save'}
          </button>
        </div>
      )}

      {/* AI diff modal */}
      {aiDiffOpen && aiDraftPayload && tableNote && (
        <AiDescriptionDiffModal
          tableName={tableLabel(sourceTable)}
          current={{
            description: tableNote.business_role ?? '',
            column_descriptions: Object.fromEntries(
              (tableNote.column_notes ?? []).map((c) => [c.column_name, c.description ?? '']),
            ),
            common_questions: [],
          }}
          aiDraft={aiDraftPayload}
          onApply={handleApplyAi}
          onClose={() => { setAiDiffOpen(false); setAiDraftPayload(null); }}
        />
      )}

      {/* Phase-15.5: time-intelligence wizard. */}
      {view && (
        <TimeIntelligenceBuilder
          open={showTimeIntelDialog}
          existingMeasures={measures}
          modelViews={modelViews}
          currentViewName={view.name}
          onConfirm={(newMeasure) => {
            const rowKey = makeClientRowKey('measure');
            setMeasures((prev) => [...prev, newMeasure]);
            setMeasureRowKeys((prev) => [...prev, rowKey]);
          }}
          onClose={() => setShowTimeIntelDialog(false)}
        />
      )}
    </div>
  );
});
