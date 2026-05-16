/**
 * DimensionMeasureEditor — Side panel for editing a model table's fields.
 * Allows toggling visibility, changing types, editing labels and SQL.
 */
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  Sigma,
  Eye,
  EyeOff,
  Save,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  useUpdateModelView,
  type DatasetModelView,
  type DimensionDefinition,
  type MeasureDefinition,
  type MeasureFilter,
  type MeasureFilterOperator,
  type MeasureFormat,
} from '@/hooks/use-dataset-model';
import { toast } from '@/lib/toast';
import { extractApiError } from '@/lib/api-errors';

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

const FILTER_OPERATORS: { value: MeasureFilterOperator; label: string; needsValue: boolean; isList?: boolean; isRange?: boolean }[] = [
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

// ===== Name helpers =====

function slugifyName(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[0-9]/, '_$&')
    .replace(/^_+|_+$/g, '');
  return slug || 'measure';
}

function isAutoName(name: string, label?: string): boolean {
  if (/^(count|sum|avg|min|max|distinct|filtered_count|pct)_\d+$/.test(name)) return true;
  if (label) return name === slugifyName(label);
  return false;
}

// ===== Dimension Row =====

function DimensionRow({
  dim,
  onChange,
  onRemove,
}: {
  dim: DimensionDefinition;
  onChange: (updated: DimensionDefinition) => void;
  onRemove: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-text-quaternary hover:text-text-secondary"
        >
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <Type className="w-3.5 h-3.5 text-brand shrink-0" />
        <span className="text-sm text-text-primary truncate flex-1">
          {dim.label || dim.name}
        </span>
        <span className="text-[10px] text-text-quaternary uppercase">{dim.type}</span>
        <button
          onClick={() => onChange({ ...dim, hidden: !dim.hidden })}
          className="p-0.5 hover:bg-surface-2 rounded"
          title={dim.hidden ? 'Show' : 'Hide'}
        >
          {dim.hidden ? <EyeOff className="w-3.5 h-3.5 text-text-quaternary" /> : <Eye className="w-3.5 h-3.5 text-text-tertiary" />}
        </button>
        <button onClick={onRemove} className="p-0.5 hover:bg-danger/10 rounded text-text-quaternary hover:text-danger">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-tertiary uppercase">Name</label>
              <input
                value={dim.name}
                onChange={(e) => onChange({ ...dim, name: e.target.value })}
                className="w-full text-xs px-2 py-1 border rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase">Type</label>
              <select
                value={dim.type}
                onChange={(e) => onChange({ ...dim, type: e.target.value as any })}
                className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs"
              >
                {DIM_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-text-tertiary uppercase">Label</label>
            <input
              value={dim.label || ''}
              onChange={(e) => onChange({ ...dim, label: e.target.value || undefined })}
              className="w-full text-xs px-2 py-1 border rounded"
              placeholder="Display label"
            />
          </div>
          <div>
            <label className="text-[10px] text-text-tertiary uppercase">SQL</label>
            <input
              value={dim.sql || ''}
              onChange={(e) => onChange({ ...dim, sql: e.target.value || undefined })}
              className="w-full text-xs px-2 py-1 border rounded font-mono"
              placeholder="Column name or SQL expression"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Measure Filter Row =====

function MeasureFilterRow({
  filter,
  columnOptions,
  onChange,
  onRemove,
}: {
  filter: MeasureFilter;
  columnOptions: string[];
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
        list="__measure_filter_columns"
        value={filter.field}
        onChange={(e) => onChange({ ...filter, field: e.target.value })}
        placeholder="column"
        className="flex-1 min-w-0 text-xs px-2 py-1 border rounded font-mono"
      />
      <datalist id="__measure_filter_columns">
        {columnOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <select
        value={filter.operator}
        onChange={(e) => onChange({ ...filter, operator: e.target.value as MeasureFilterOperator })}
        className="text-xs px-1.5 py-1 border rounded bg-surface-1 shrink-0"
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
          className="flex-1 min-w-0 text-xs px-2 py-1 border rounded"
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

// ===== Measure Row =====

function MeasureRow({
  measure,
  columnOptions,
  measureNames,
  onChange,
  onRemove,
}: {
  measure: MeasureDefinition;
  columnOptions: string[];
  measureNames: string[];
  onChange: (updated: MeasureDefinition) => void;
  onRemove: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(measure.expression || measure.where_sql));

  const filters = measure.filters ?? [];

  const updateFilters = (next: MeasureFilter[]) => onChange({ ...measure, filters: next });
  const addFilter = () => updateFilters([...filters, { field: columnOptions[0] ?? '', operator: 'eq', value: '' }]);

  const fmt: MeasureFormat = measure.format ?? { kind: 'number' };
  const updateFormat = (patch: Partial<MeasureFormat>) =>
    onChange({ ...measure, format: { ...fmt, ...patch } });

  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-text-quaternary hover:text-text-secondary"
        >
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <Sigma className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-sm text-text-primary truncate flex-1">
          {measure.label || measure.name}
        </span>
        {filters.length > 0 && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-warning/10 text-warning" title={`${filters.length} filter(s)`}>
            ƒ {filters.length}
          </span>
        )}
        <span className="text-[10px] text-text-quaternary uppercase">{measure.type}</span>
        <button
          onClick={() => onChange({ ...measure, hidden: !measure.hidden })}
          className="p-0.5 hover:bg-surface-2 rounded"
          title={measure.hidden ? 'Show' : 'Hide'}
        >
          {measure.hidden ? <EyeOff className="w-3.5 h-3.5 text-text-quaternary" /> : <Eye className="w-3.5 h-3.5 text-text-tertiary" />}
        </button>
        <button onClick={onRemove} className="p-0.5 hover:bg-danger/10 rounded text-text-quaternary hover:text-danger">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          {/* Identity — Label first, SQL name secondary */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-tertiary uppercase">Label</label>
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
                className="w-full text-xs px-2 py-1 border rounded"
                placeholder="Display name"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase">Aggregation</label>
              <select
                value={measure.type}
                onChange={(e) => onChange({ ...measure, type: e.target.value as MeasureDefinition['type'] })}
                className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs"
              >
                {MEASURE_TYPES.map((t) => (
                  <option key={t} value={t}>{MEASURE_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="flex items-center gap-1 mb-0.5">
                <label className="text-[10px] text-text-tertiary uppercase">SQL Name</label>
                {isAutoName(measure.name, measure.label) && (
                  <span className="text-[9px] text-text-quaternary italic">auto</span>
                )}
              </div>
              <input
                value={measure.name}
                onChange={(e) => onChange({ ...measure, name: e.target.value })}
                className="w-full text-xs px-2 py-1 border rounded font-mono"
                title="Internal SQL identifier. Letters, digits and underscores only."
              />
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase">Folder</label>
              <input
                value={measure.folder || ''}
                onChange={(e) => onChange({ ...measure, folder: e.target.value || undefined })}
                className="w-full text-xs px-2 py-1 border rounded"
                placeholder="e.g. Revenue"
              />
            </div>
          </div>

          {/* Column being aggregated (form mode) */}
          {measure.type !== 'count' && (
            <div>
              <label className="text-[10px] text-text-tertiary uppercase">Column to aggregate</label>
              <input
                list={`__cols_for_${measure.name}`}
                value={measure.sql || ''}
                onChange={(e) => onChange({ ...measure, sql: e.target.value || undefined })}
                className="w-full text-xs px-2 py-1 border rounded font-mono"
                placeholder="Pick a column"
              />
              <datalist id={`__cols_for_${measure.name}`}>
                {columnOptions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          )}

          {/* Filters builder */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] text-text-tertiary uppercase">Filters (apply to this measure only)</label>
              <button onClick={addFilter} className="text-[10px] text-brand hover:underline flex items-center gap-0.5">
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
            {filters.length === 0 ? (
              <p className="text-[10px] text-text-quaternary italic">No filter — measure runs over every row.</p>
            ) : (
              <div className="space-y-1">
                {filters.map((f, i) => (
                  <MeasureFilterRow
                    key={i}
                    filter={f}
                    columnOptions={columnOptions}
                    onChange={(u) => updateFilters(filters.map((x, j) => (j === i ? u : x)))}
                    onRemove={() => updateFilters(filters.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Format */}
          <div>
            <label className="text-[10px] text-text-tertiary uppercase">Format</label>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={fmt.kind}
                onChange={(e) => updateFormat({ kind: e.target.value as MeasureFormat['kind'] })}
                className="text-xs px-2 py-1 border rounded bg-surface-1"
              >
                {FORMAT_KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                max={10}
                value={fmt.decimals ?? ''}
                onChange={(e) => updateFormat({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })}
                placeholder="decimals"
                className="text-xs px-2 py-1 border rounded"
              />
              {fmt.kind === 'currency' ? (
                <input
                  value={fmt.currency || ''}
                  onChange={(e) => updateFormat({ currency: e.target.value || undefined })}
                  placeholder="USD"
                  className="text-xs px-2 py-1 border rounded uppercase"
                  maxLength={4}
                />
              ) : (
                <input
                  value={fmt.suffix || ''}
                  onChange={(e) => updateFormat({ suffix: e.target.value || undefined })}
                  placeholder="suffix"
                  className="text-xs px-2 py-1 border rounded"
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
                <label className="text-[10px] text-text-tertiary uppercase">SQL expression (overrides column)</label>
                <input
                  value={measure.expression || ''}
                  onChange={(e) => onChange({ ...measure, expression: e.target.value || undefined })}
                  className="w-full text-xs px-2 py-1 border rounded font-mono"
                  placeholder="e.g. revenue - cost"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-tertiary uppercase">Raw WHERE (added to filters)</label>
                <input
                  value={measure.where_sql || ''}
                  onChange={(e) => onChange({ ...measure, where_sql: e.target.value || undefined })}
                  className="w-full text-xs px-2 py-1 border rounded font-mono"
                  placeholder="e.g. status &lt;&gt; 'cancelled'"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-tertiary uppercase">Depends on (other measures)</label>
                <input
                  value={(measure.depends_on || []).join(', ')}
                  onChange={(e) =>
                    onChange({
                      ...measure,
                      depends_on: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  list={`__measures_for_${measure.name}`}
                  className="w-full text-xs px-2 py-1 border rounded font-mono"
                  placeholder="e.g. revenue, orders"
                />
                <datalist id={`__measures_for_${measure.name}`}>
                  {measureNames.filter((n) => n !== measure.name).map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===== Measure templates =====

type MeasureTemplate = { key: string; label: string; build: (n: number) => MeasureDefinition };

const MEASURE_TEMPLATES: MeasureTemplate[] = [
  {
    key: 'count',
    label: 'Count rows',
    build: (n) => ({ name: `count_${n}`, type: 'count', sql: '*', hidden: false }),
  },
  {
    key: 'sum',
    label: 'Sum of column',
    build: (n) => ({ name: `sum_${n}`, type: 'sum', sql: '', hidden: false }),
  },
  {
    key: 'avg',
    label: 'Average of column',
    build: (n) => ({ name: `avg_${n}`, type: 'avg', sql: '', hidden: false }),
  },
  {
    key: 'distinct',
    label: 'Count distinct',
    build: (n) => ({ name: `distinct_${n}`, type: 'count_distinct', sql: '', hidden: false }),
  },
  {
    key: 'filtered',
    label: 'Filtered count (e.g. paid orders)',
    build: (n) => ({
      name: `filtered_count_${n}`,
      type: 'count',
      sql: '*',
      filters: [{ field: '', operator: 'eq', value: '' }],
      hidden: false,
    }),
  },
  {
    key: 'pct',
    label: '% of total',
    build: (n) => ({ name: `pct_${n}`, type: 'percent_of_total', sql: '', hidden: false }),
  },
];

// ===== Main Editor Panel =====

interface DimensionMeasureEditorProps {
  datasetId: number;
  view: DatasetModelView;
  onClose: () => void;
}

export function DimensionMeasureEditor({ datasetId, view, onClose }: DimensionMeasureEditorProps) {
  const [dimensions, setDimensions] = useState<DimensionDefinition[]>([]);
  const [measures, setMeasures] = useState<MeasureDefinition[]>([]);
  const [description, setDescription] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const updateView = useUpdateModelView();

  // Columns available for the form-first measure editor: pull from existing
  // dimensions (their `sql` resolves to the underlying column) plus dimension
  // names. This gives no-SQL users a working pick-list.
  const columnOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const d of dimensions) {
      if (d.sql) set.add(d.sql);
      if (d.name) set.add(d.name);
    }
    return Array.from(set).sort();
  }, [dimensions]);

  const measureNames = React.useMemo(() => measures.map((m) => m.name), [measures]);

  useEffect(() => {
    setDimensions(view.dimensions.map((d) => ({ ...d })));
    setMeasures(view.measures.map((m) => ({ ...m })));
    setDescription(view.description || '');
  }, [view]);

  const handleDimChange = useCallback((idx: number, updated: DimensionDefinition) => {
    setDimensions((prev) => prev.map((d, i) => (i === idx ? updated : d)));
  }, []);

  const handleMeasureChange = useCallback((idx: number, updated: MeasureDefinition) => {
    setMeasures((prev) => prev.map((m, i) => (i === idx ? updated : m)));
  }, []);

  const handleRemoveDim = useCallback((idx: number) => {
    setDimensions((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleRemoveMeasure = useCallback((idx: number) => {
    setMeasures((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleAddDimension = () => {
    setDimensions((prev) => [
      ...prev,
      { name: `new_dimension_${prev.length + 1}`, type: 'string', hidden: false },
    ]);
  };

  const handleAddMeasureFromTemplate = (tpl: MeasureTemplate) => {
    setMeasures((prev) => {
      // Ensure unique name across the view
      let n = prev.length + 1;
      const existingNames = new Set(prev.map((m) => m.name));
      let candidate = tpl.build(n);
      while (existingNames.has(candidate.name)) {
        n += 1;
        candidate = tpl.build(n);
      }
      return [...prev, candidate];
    });
    setShowTemplates(false);
  };

  const handleSave = async () => {
    try {
      await updateView.mutateAsync({
        datasetId,
        viewId: view.id,
        data: { dimensions, measures, description },
      });
      toast.success('Table fields updated');
      onClose();
    } catch (err: unknown) {
      toast.error(extractApiError(err, 'Failed to update table fields'));
    }
  };

  const isDirty =
    JSON.stringify(dimensions) !== JSON.stringify(view.dimensions) ||
    JSON.stringify(measures) !== JSON.stringify(view.measures) ||
    description !== (view.description || '');

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {view.table_display_name || view.name}
          </h3>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-surface-2 rounded">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Description */}
      <div className="px-4 py-3 border-b shrink-0">
        <label className="text-[10px] text-text-tertiary uppercase block mb-1">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-xs px-2 py-1.5 border rounded"
          placeholder="Table description"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Dimensions */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary uppercase">
              Dimensions ({dimensions.length})
            </span>
            <button
              onClick={handleAddDimension}
              className="text-xs text-brand hover:text-brand flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          <div className="space-y-1.5">
            {dimensions.map((dim, idx) => (
              <DimensionRow
                key={`dim-${idx}-${dim.name}`}
                dim={dim}
                onChange={(u) => handleDimChange(idx, u)}
                onRemove={() => handleRemoveDim(idx)}
              />
            ))}
          </div>
        </div>

        {/* Measures */}
        <div className="px-4 py-3 border-t">
          <div className="flex items-center justify-between mb-2 relative">
            <span className="text-xs font-medium text-text-secondary uppercase">
              Measures ({measures.length})
            </span>
            <button
              onClick={() => setShowTemplates((v) => !v)}
              className="text-xs text-warning hover:text-warning flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add
              <ChevronDown className="w-3 h-3" />
            </button>
            {showTemplates && (
              <div className="absolute right-0 top-6 z-10 w-56 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg py-1">
                {MEASURE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.key}
                    onClick={() => handleAddMeasureFromTemplate(tpl)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            {measures.map((m, idx) => (
              <MeasureRow
                key={`mea-${idx}-${m.name}`}
                measure={m}
                columnOptions={columnOptions}
                measureNames={measureNames}
                onChange={(u) => handleMeasureChange(idx, u)}
                onRemove={() => handleRemoveMeasure(idx)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t flex items-center justify-end gap-2 shrink-0">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-text-secondary border border-[rgb(var(--border-strong))] rounded-md hover:bg-surface-2"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!isDirty || updateView.isPending}
          className="px-3 py-1.5 text-xs text-white bg-brand rounded-md hover:bg-brand-hover disabled:opacity-50 flex items-center gap-1.5"
        >
          {updateView.isPending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Save className="w-3 h-3" />
          )}
          Save Changes
        </button>
      </div>
    </div>
  );
}
