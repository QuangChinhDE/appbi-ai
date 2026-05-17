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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Hash,
  Loader2,
  Pencil,
  Plus,
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
import { AiDescriptionDiffModal } from './AiDescriptionDiffModal';
import { AppModalShell } from '@/components/common/AppModalShell';
import { toast } from '@/lib/toast';
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
  { key: 'count', label: 'Count rows', group: 'basic', build: (n) => ({ name: `count_${n}`, label: 'Count', type: 'count', sql: '*', hidden: false }) },
  { key: 'sum', label: 'Sum of column', group: 'basic', build: (n) => ({ name: `sum_${n}`, label: 'Sum', type: 'sum', sql: '', hidden: false }) },
  { key: 'avg', label: 'Average of column', group: 'basic', build: (n) => ({ name: `avg_${n}`, label: 'Average', type: 'avg', sql: '', hidden: false }) },
  { key: 'distinct', label: 'Count distinct', group: 'basic', build: (n) => ({ name: `distinct_${n}`, label: 'Unique count', type: 'count_distinct', sql: '', hidden: false }) },
  {
    key: 'filtered',
    label: 'Filtered count (e.g. paid orders)',
    group: 'basic',
    build: (n) => ({
      name: `filtered_count_${n}`,
      label: 'Filtered count',
      type: 'count',
      sql: '*',
      filters: [{ field: '', operator: 'eq', value: '' }],
      hidden: false,
    }),
  },
  { key: 'pct', label: '% of total', group: 'basic', build: (n) => ({ name: `pct_${n}`, label: '% of total', type: 'percent_of_total', sql: '', hidden: false }) },

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
      expression: 'SUM(${other_view.col})',
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
  if (!open || !note) return null;

  return (
    <AppModalShell
      onClose={onClose}
      title={note.column_name}
      description={`${tableName} · column dictionary`}
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
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2">
            Close
          </button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary uppercase tracking-wide">Business name</label>
          <input
            value={note.business_name ?? ''}
            onChange={(e) => onChange((cur) => ({ ...cur, business_name: e.target.value }))}
            disabled={!canEdit}
            placeholder="Friendly name for business users"
            className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary uppercase tracking-wide">Description</label>
          <textarea
            rows={4}
            value={note.description ?? ''}
            onChange={(e) => onChange((cur) => ({ ...cur, description: e.target.value }))}
            disabled={!canEdit}
            placeholder="What does this column mean? How should it be interpreted?"
            className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2 resize-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary uppercase tracking-wide">Examples</label>
          <TokenEditor values={note.examples ?? []} onChange={(values) => onChange((cur) => ({ ...cur, examples: values }))} placeholder="Add a sample value…" disabled={!canEdit} />
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
            placeholder="Search columns…"
            className="w-full rounded-md border border-[rgb(var(--border-line))] py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <span className="text-[11px] text-text-quaternary shrink-0">{columnsMeta.length} cols</span>
      </div>

      {/* Column list */}
      <div className="flex-1 overflow-y-auto">
        {columnsMeta.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-xs text-text-quaternary">Column metadata not available.</div>
        ) : visible.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-xs text-text-quaternary">No columns match this filter.</div>
        ) : (
          <table className="min-w-full">
            <thead className="sticky top-0 z-10 border-b border-[rgb(var(--border-line))] bg-surface-2">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">Column</th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">Description</th>
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
                        title={documented ? 'Remove from catalog' : 'Add to catalog'}
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
                          <div className="mt-0.5 text-[11px] text-text-quaternary italic">+ add name</div>
                        ) : null}
                      </button>
                    </td>
                    <td className="px-3 py-2 max-w-[200px]">
                      {documented ? (
                        <button type="button" onClick={() => openModal(column)} className="text-left w-full">
                          {hasDesc ? (
                            <p className="line-clamp-2 text-[11px] text-text-secondary leading-relaxed">{note!.description}</p>
                          ) : (
                            <span className="text-[11px] text-warning italic">No description</span>
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
              title={dim.hidden ? 'Show' : 'Hide'}
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
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Column</label>
              <input
                list={colsListId}
                value={dim.name}
                onChange={(e) => updateColumn(e.target.value)}
                className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder="Pick a column"
                title="Dimension trỏ đến 1 cột. Nếu cần tính toán, tạo Calculated Column ở bảng nguồn rồi chọn cột đó ở đây."
              />
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Type</label>
              <select value={dim.type} onChange={(e) => onChange({ ...dim, type: e.target.value as DimensionDefinition['type'] })} className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand">
                {DIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-text-tertiary uppercase font-medium">Label</label>
            <input value={dim.label || ''} onChange={(e) => onChange({ ...dim, label: e.target.value || undefined })} className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand" placeholder="Display label" />
          </div>
          {/* Phase-15.1: drill-down parent. Pure metadata — FE Explore uses
              it to surface a "↓ Drill into <child>" action when the chart
              groups by this dim. BE validator rejects self-reference and
              hierarchy cycles. Leave blank for a root-level dim. */}
          <div>
            <label className="text-[10px] text-text-tertiary uppercase font-medium flex items-center gap-1">
              Parent (drill-down)
              <span className="font-normal normal-case text-[9px] text-text-quaternary">
                — vd Month.parent = Year, Day.parent = Month
              </span>
            </label>
            <select
              value={dim.parent ?? ''}
              onChange={(e) => onChange({ ...dim, parent: e.target.value || undefined })}
              className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="">(không có — root dimension)</option>
              {siblingDimNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <p className="text-[10px] italic text-text-quaternary leading-4">
            Dimension chỉ là mapping cột — không phải nơi tính toán. Để tạo cột tính toán mới, hãy dùng <span className="font-medium text-text-tertiary">Add Calculated Column</span> ở bảng nguồn.
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
  onChange,
  onRemove,
}: {
  filter: MeasureFilter;
  listId: string;
  onChange: (updated: MeasureFilter) => void;
  onRemove: () => void;
}) {
  const opSpec = FILTER_OPERATORS.find((o) => o.value === filter.operator) ?? FILTER_OPERATORS[0];
  const valueAsString = (() => {
    if (filter.value == null) return '';
    if (Array.isArray(filter.value)) return filter.value.join(', ');
    return String(filter.value);
  })();

  return (
    <div className="flex items-center gap-1.5">
      <input
        list={listId}
        value={filter.field}
        onChange={(e) => onChange({ ...filter, field: e.target.value })}
        placeholder="column"
        className="flex-1 min-w-0 text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded font-mono focus:outline-none focus:ring-1 focus:ring-brand"
      />
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
          value={valueAsString}
          onChange={(e) => {
            const raw = e.target.value;
            let parsed: unknown = raw;
            if (opSpec.isList || opSpec.isRange) {
              parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
            }
            onChange({ ...filter, value: parsed });
          }}
          placeholder={opSpec.isList ? 'a, b, c' : opSpec.isRange ? 'low, high' : 'value'}
          className="flex-1 min-w-0 text-xs px-2 py-1 border border-[rgb(var(--border-line))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
        />
      )}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-danger/10 rounded text-text-quaternary hover:text-danger shrink-0"
        title="Remove filter"
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
        <div className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
          Filter context
        </div>
        {preset !== 'none' && (
          <span
            className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-emphasis uppercase text-purple-600 dark:text-purple-400"
            title="Measure đang dùng filter-context — engine emit SQL window aggregate (OVER PARTITION BY)"
          >
            {preset === 'custom' ? 'Custom' : 'Active'}
          </span>
        )}
      </div>
      <p className="text-[10px] leading-snug text-text-quaternary">
        Chọn pattern bên dưới để bỏ qua hoặc giữ một phần filter context khi
        chart slice. Tương đương PowerBI <code>CALCULATE/ALL/ALLEXCEPT</code>.
        Default (None) = aggregate thường.
      </p>

      {/* Phase-15.4: preset picker — 4 button row. Hide Advanced editors
          unless user clicks "Advanced" disclosure. */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          disabled={!canEdit}
          onClick={() => applyPreset('none')}
          className={`rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
            preset === 'none'
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
          }`}
          title="Measure aggregate thường, group theo dim của chart như bình thường."
        >
          <div className="font-emphasis">None (default)</div>
          <div className="mt-0.5 text-[10px] text-text-quaternary leading-tight">
            Aggregate thường, no window
          </div>
        </button>

        <button
          disabled={!canEdit}
          onClick={() => applyPreset('grand_total')}
          className={`rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
            preset === 'grand_total'
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
          }`}
          title="Emit SUM(...) OVER () — bypass mọi slicer của chart. Tương đương DAX CALCULATE(measure, ALL())."
        >
          <div className="font-emphasis">% of grand total</div>
          <div className="mt-0.5 text-[10px] text-text-quaternary leading-tight">
            Bỏ tất cả filter — DAX ALL()
          </div>
        </button>

        <button
          disabled={!canEdit}
          onClick={() => {
            // Default to first kept field, or prompt user to fill below.
            applyPreset('within_kept', { keepField: keptField || '' });
          }}
          className={`rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
            preset === 'within_kept'
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
          }`}
          title="Emit SUM(...) OVER (PARTITION BY <field>) — giữ field này trong filter, bỏ rest. Tương đương DAX ALLEXCEPT(table, table[field])."
        >
          <div className="font-emphasis">% within ...</div>
          <div className="mt-0.5 text-[10px] text-text-quaternary leading-tight">
            Giữ 1 dim — DAX ALLEXCEPT()
          </div>
        </button>

        <button
          disabled={!canEdit}
          onClick={() => applyPreset('use_relationship', { joinAlias: useRelAlias })}
          className={`rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
            preset === 'use_relationship'
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
          }`}
          title="Dùng inactive relationship (alias join) thay default. Schema-only ở Phase-14 — sẽ wire ở phase sau."
        >
          <div className="font-emphasis">Use relationship</div>
          <div className="mt-0.5 text-[10px] text-text-quaternary leading-tight">
            DAX USERELATIONSHIP() — schema only
          </div>
        </button>
      </div>

      {/* Inline param for "within ..." preset — single-field common case. */}
      {preset === 'within_kept' && (
        <div className="rounded-md bg-surface-2 p-1.5 space-y-1">
          <label className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
            Giữ dim
          </label>
          <input
            value={keptField}
            onChange={(e) => applyPreset('within_kept', { keepField: e.target.value })}
            placeholder="region"
            disabled={!canEdit}
            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <p className="text-[10px] text-text-quaternary leading-tight">
            Tên dim sẽ ở trong PARTITION BY. Vd <code>region</code> → mỗi
            region 1 baseline, slice khác (channel/product/...) bị bỏ.
            Để thêm nhiều dim, mở Advanced bên dưới.
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

      {/* Advanced — raw modifier checkboxes. Keep for power users, hidden
          by default. Auto-opens if preset detector flagged 'custom'. */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="text-[10px] text-text-tertiary hover:text-text-secondary flex items-center gap-1"
      >
        {showAdvanced ? '▼' : '▶'} Advanced (raw modifiers)
      </button>

      {showAdvanced && (
        <div className="space-y-1.5 border-l-2 border-[rgb(var(--border-line))] pl-2">
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary">
            <input type="checkbox" checked={hasAll} disabled={!canEdit} onChange={toggleAll} />
            <span><code>ALL</code> — grand total</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-[11px] text-text-secondary">
            <input type="checkbox" checked={hasAllExcept} disabled={!canEdit} onChange={toggleAllExcept} className="mt-0.5" />
            <span className="flex-1">
              <code>ALL EXCEPT</code> — multi-dim partition
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
              <code>USE RELATIONSHIP</code> — alias join
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
              Không thể đồng thời <code>ALL</code> và <code>ALL EXCEPT</code> trên
              cùng measure. Pick 1.
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

function MeasureRow({
  measure,
  canEdit,
  columnOptions,
  measureNames,
  viewName,
  rowKey,
  defaultOpen,
  modelViews,
  onChange,
  onRemove,
}: {
  measure: MeasureDefinition;
  canEdit: boolean;
  columnOptions: string[];
  measureNames: string[];
  viewName?: string;
  rowKey: string;
  defaultOpen?: boolean;
  /** Phase-12: every view in the dataset model — used to populate the
   * cross-table source-columns picker when measure scope='dataset'. */
  modelViews?: DatasetModelView[];
  onChange: (updated: MeasureDefinition) => void;
  onRemove: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(() => rowKey.startsWith('new-measure') || Boolean(defaultOpen));
  const [showAdvanced, setShowAdvanced] = useState(Boolean(measure.expression || measure.where_sql));
  const [editingLabel, setEditingLabel] = useState(false);

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

  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setIsExpanded(!isExpanded)} className="text-text-quaternary hover:text-text-secondary shrink-0">
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
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
            title={`Cross-table (đa bảng): measure tham chiếu ${measure.source_columns?.length ?? 0} cột nguồn từ view khác. Engine tự JOIN.`}
          >
            đa bảng
          </span>
        )}
        {/* Phase-14: surface filter-context flag — these measures emit
            SQL window aggregates instead of GROUP BY aggregates. */}
        {(measure.context_modifiers?.length ?? 0) > 0 && (
          <span
            className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 font-emphasis uppercase shrink-0"
            title="Measure dùng filter-context modifier (OVER PARTITION BY) — tham khảo Filter Context panel ở Advanced"
          >
            ctx
          </span>
        )}
        <span className="text-[10px] text-text-quaternary bg-warning/10 text-warning px-1.5 py-0.5 rounded uppercase">{measure.type}</span>
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
        <div className="px-3 pb-3 pt-1 border-t border-[rgb(var(--border-line))] space-y-2.5">
          {/* Datalists shared across this row's inputs */}
          <datalist id={colsListId}>
            {columnOptions.map((c) => <option key={c} value={c} />)}
          </datalist>
          <datalist id={measuresListId}>
            {measureNames.filter((n) => !selfMeasureRefs.has(n)).map((n) => <option key={n} value={n} />)}
          </datalist>

          {/* Identity — Label first (primary), Aggregation alongside */}
          <div className="grid grid-cols-2 gap-2">
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
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Aggregation</label>
              <select
                value={measure.type}
                onChange={(e) => onChange({ ...measure, type: e.target.value as MeasureDefinition['type'] })}
                className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand"
              >
                {MEASURE_TYPES.map((t) => <option key={t} value={t}>{MEASURE_TYPE_LABEL[t]}</option>)}
              </select>
            </div>
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
                className="w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder="sql_identifier"
                title="Internal SQL identifier. Letters, digits and underscores only."
              />
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

          {/* Column to aggregate (form mode). COUNT counts rows so column is N/A. */}
          {measure.type !== 'count' && (
            <div>
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Column to aggregate</label>
              <input
                list={colsListId}
                value={measure.sql || ''}
                onChange={(e) => onChange({ ...measure, sql: e.target.value || undefined })}
                className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder="Pick a column"
              />
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
                    onChange={(u) => updateFilters(filters.map((x, j) => (j === i ? u : x)))}
                    onRemove={() => updateFilters(filters.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Format */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-text-tertiary uppercase font-medium">Format</label>
              <span className="text-[9px] italic text-text-quaternary" title="Display hint stored on the measure. Charts apply their own number format; this hint is exposed to chart pickers and AI consumers.">
                display hint
              </span>
            </div>
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

          {/* Advanced toggle */}
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-[10px] text-text-tertiary hover:text-text-secondary flex items-center gap-1"
          >
            {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Advanced (SQL expression, raw WHERE, depends on)
          </button>

          {showAdvanced && (
            <div className="space-y-2 pl-3 border-l border-[rgb(var(--border-line))]">
              <div>
                <label className="text-[10px] text-text-tertiary uppercase font-medium">
                  SQL expression (overrides column)
                </label>
                <input
                  value={measure.expression || ''}
                  onChange={(e) => onChange({ ...measure, expression: e.target.value || undefined })}
                  className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="e.g. revenue - cost"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-tertiary uppercase font-medium">
                  Raw WHERE (added to filters)
                </label>
                <input
                  value={measure.where_sql || ''}
                  onChange={(e) => onChange({ ...measure, where_sql: e.target.value || undefined })}
                  className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="e.g. status <> 'cancelled'"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-tertiary uppercase font-medium">
                  Depends on (other measures)
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
                  className="mt-0.5 w-full text-xs px-2 py-1.5 border border-[rgb(var(--border-line))] rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="e.g. revenue, calendar.days"
                />
              </div>

              {/* Phase-12 / Phase-13.3: dataset-scope measure with cross-table source
                  columns. Phase-13.3 adds expression↔source_columns drift detection
                  so the form catches the common mistake where the SQL expression
                  references ${view.field} but source_columns is empty / mismatched. */}
              <div className="space-y-1.5 rounded-md border border-dashed border-[rgb(var(--border-line))] p-2">
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
                  Đa bảng (cross-table — PowerBI: USERELATIONSHIP)
                </label>
                <p className="text-[10px] leading-snug text-text-quaternary">
                  Khi bật: SQL expression có thể dùng <code>{'${view.field}'}</code> từ bảng khác.
                  Khai báo từng cột nguồn dưới đây để engine tự JOIN qua relationship.
                </p>
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

              {/* Phase-14: filter-context modifiers — compile measure to a
                  SQL window aggregate. Kept in Advanced because most
                  measures don't need this; "% of total" / "% of region"
                  use cases live here. */}
              <FilterContextModifiers
                measure={measure}
                canEdit={canEdit}
                onChange={onChange}
              />
            </div>
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
  /** Ask the parent page to open the AddColumnModal targeting the underlying table. */
  onRequestAddColumn?: (tableId: number) => void;
}

export function ModelViewEditPanel({
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
  onRequestAddColumn,
}: ModelViewEditPanelProps) {
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
  // Phase-15.5: time-intelligence dialog state. Open when user picks the
  // dedicated "+ Time intelligence (smart)" entry in the Add Measure menu.
  const [showTimeIntelDialog, setShowTimeIntelDialog] = useState(false);
  const updateView = useUpdateModelView();

  useEffect(() => {
    if (triggerAddMeasure && triggerAddMeasure > 0) setShowMeasureTemplates(true);
  }, [triggerAddMeasure]);

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

  useEffect(() => {
    if (!view) return;
    setDimensions(view.dimensions.map((d) => ({ ...d })));
    setMeasures(view.measures.map((m) => ({ ...m })));
    setDimensionRowKeys(view.dimensions.map((d, index) => `${view.id}:dimension:${index}:${d.name || 'field'}`));
    setMeasureRowKeys(view.measures.map((m, index) => `${view.id}:measure:${index}:${m.name || 'field'}`));
    setViewDescription(view.description || '');
  }, [view]);

  const modelIsDirty =
    !!view && (
      JSON.stringify(measures) !== JSON.stringify(view.measures) ||
      (contentMode !== 'measures' && (
        JSON.stringify(dimensions) !== JSON.stringify(view.dimensions) ||
        viewDescription !== (view.description || '')
      ))
    );

  const handleSaveModel = async () => {
    if (!view) return;
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

    measures.forEach((m, i) => {
      const trimmedName = (m.name || '').trim();
      if (!trimmedName) {
        errors.push(`Measure #${i + 1}: name is required`);
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedName)) {
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
      return;
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
            toast.success('Đã lưu (cần sửa lại chart đang dùng).');
          } catch (force_error: unknown) {
            const fd = (force_error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
            toast.error(typeof fd === 'string' ? fd : 'Force save failed');
          }
        }
        return;
      }
      toast.error(typeof detail === 'string' ? detail : contentMode === 'measures' ? 'Failed to save measures' : 'Failed to save fields');
    }
  };

  // ── Unified save ──────────────────────────────────────────────────────────
  const isSavingAny = updateDict.isPending || updateView.isPending;
  const canSave = activeTab === 'dictionary' ? dictDirty : modelIsDirty;

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
                <div className="flex items-center justify-between mb-2 relative">
                  <span className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                    <Sigma className="w-3.5 h-3.5 text-warning" />
                    {singleMeasureMode ? 'Edit measure' : 'Measures'}
                    {!singleMeasureMode && <span className="text-text-quaternary font-normal">({measures.length})</span>}
                  </span>
                  {canEdit && !singleMeasureMode && (
                    <>
                      <button
                        onClick={() => setShowMeasureTemplates((v) => !v)}
                        className="inline-flex items-center gap-1 text-xs text-warning hover:text-warning font-medium"
                      >
                        <Plus className="w-3 h-3" /> {contentMode === 'measures' ? 'Add measure' : 'Add'}
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showMeasureTemplates && (
                        <div className="absolute right-0 top-6 z-20 w-72 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg py-1 max-h-96 overflow-y-auto">
                          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">
                            Basic
                          </div>
                          {MEASURE_TEMPLATES.filter((t) => t.group === 'basic').map((tpl) => (
                            <button
                              key={tpl.key}
                              onClick={() => handleAddMeasureFromTemplate(tpl)}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2"
                            >
                              {tpl.label}
                            </button>
                          ))}
                          <div className="mt-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-quaternary border-t border-[rgb(var(--border-line))]">
                            Time intelligence
                          </div>
                          {/* Phase-15.5: smart wizard — pick base measure +
                              date dim, auto-fill expression. Sits above the
                              raw-template entries (legacy) which still work
                              for users who want to write expressions by hand. */}
                          <button
                            onClick={() => {
                              setShowMeasureTemplates(false);
                              setShowTimeIntelDialog(true);
                            }}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 border-b border-[rgb(var(--border-line))]"
                            title="Mở dialog chọn base measure + date dim → tự sinh expression đầy đủ. Đơn giản hơn template raw."
                          >
                            <div className="flex items-center gap-1">
                              <span className="font-emphasis">+ Time intelligence (smart)</span>
                              <span className="rounded bg-brand/10 px-1 text-[9px] font-emphasis uppercase text-brand">PBI</span>
                            </div>
                            <div className="text-[10px] text-text-quaternary mt-0.5 leading-tight">
                              YoY, MTD, YTD, prev month, rolling N days — pick measure + date dim
                            </div>
                          </button>
                          {MEASURE_TEMPLATES.filter((t) => t.group === 'time').map((tpl) => (
                            <button
                              key={tpl.key}
                              onClick={() => handleAddMeasureFromTemplate(tpl)}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2"
                              title={tpl.hint}
                            >
                              <div>{tpl.label}</div>
                              {tpl.hint && (
                                <div className="text-[10px] text-text-quaternary mt-0.5 leading-tight">{tpl.hint}</div>
                              )}
                            </button>
                          ))}
                          {/* Phase-15.2: cross-table presets first-class. */}
                          <div className="mt-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-quaternary border-t border-[rgb(var(--border-line))]">
                            Cross-table (đa bảng)
                          </div>
                          {MEASURE_TEMPLATES.filter((t) => t.group === 'cross').map((tpl) => (
                            <button
                              key={tpl.key}
                              onClick={() => handleAddMeasureFromTemplate(tpl)}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2"
                              title={tpl.hint}
                            >
                              <div className="flex items-center gap-1">
                                <span>{tpl.label}</span>
                                <span className="rounded bg-brand/10 px-1 text-[9px] font-emphasis uppercase text-brand">PBI</span>
                              </div>
                              {tpl.hint && (
                                <div className="text-[10px] text-text-quaternary mt-0.5 leading-tight">{tpl.hint}</div>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="space-y-1.5">
                  {measures.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-5 text-center text-xs text-text-quaternary">
                      No measures yet
                    </div>
                  ) : (
                    measures
                      .filter((m, _idx) => !singleMeasureMode || m.name === focusMeasureName)
                      .map((m) => {
                        const idx = measures.indexOf(m);
                        const rowKey = measureRowKeys[idx] ?? `measure-${idx}`;
                        return (
                          <MeasureRow
                            key={rowKey}
                            rowKey={rowKey}
                            measure={m}
                            canEdit={canEdit}
                            columnOptions={columnOptions}
                            measureNames={measureDependencyRefs}
                            viewName={view.name}
                            modelViews={modelViews}
                            defaultOpen={singleMeasureMode || Boolean(focusMeasureName && m.name === focusMeasureName)}
                            onChange={(u) => setMeasures((prev) => prev.map((mm, i) => (i === idx ? u : mm)))}
                            onRemove={() => {
                              setMeasures((prev) => prev.filter((_, i) => i !== idx));
                              setMeasureRowKeys((prev) => prev.filter((_, i) => i !== idx));
                            }}
                          />
                        );
                      })
                  )}
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
          <span className="text-[11px] text-text-quaternary flex-1 truncate">
            {activeTab === 'dictionary'
              ? (dictDirty ? 'Unsaved dictionary changes' : 'Dictionary up to date')
              : contentMode === 'measures'
                ? (modelIsDirty ? 'Unsaved measure changes' : 'Measures up to date')
                : (modelIsDirty ? 'Unsaved field changes' : 'Fields up to date')}
          </span>
          <button
            onClick={handleSave}
            disabled={!canSave || isSavingAny}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-40 transition-colors"
          >
            {isSavingAny ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save
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
}
