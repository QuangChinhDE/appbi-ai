'use client';

/**
 * DatasetQualityPanel — Setup-first Quality Monitor
 * ==================================================
 * Layout: toolbar (table dropdown + dimension chips + Run Now + Add Rule)
 *         → dimension groups (collapsible) → rule rows (inline toggle/edit/delete/duplicate)
 *         → slide-in Rule Editor drawer (fixed right)
 *
 * Features:
 *  - Inline enable/disable toggle per rule (1-click)
 *  - Bulk toggle per dimension or per table
 *  - Duplicate rule (copy to same or different table)
 *  - Column autocomplete from columns_cache
 *  - Cross-table consistency hint in editor
 *  - pass/fail badges per-rule from latest completed run
 *  - Run Now + live polling (toast on complete)
 *  - No run history / score report in this panel — setup only
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Info,
  Loader2,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  type DatasetTable,
  type QualityDimension,
  type QualityRule,
  type QualityRuleConfig,
  type QualityFormat,
  type QualityRuleUpdate,
  type QualitySeverity,
  useCreateQualityRule,
  useDeleteQualityRule,
  useDuplicateQualityRule,
  useQualityRules,
  useQualityRunPoll,
  useQualityRuns,
  useQualitySummary,
  useTriggerQualityRun,
  useUpdateQualityRule,
} from '@/hooks/use-datasets';

// ---------------------------------------------------------------------------
// DQ catalogue
// ---------------------------------------------------------------------------

const DQ_DIMENSIONS: {
  key: QualityDimension;
  label: string;
  description: string;
  color: string;          // tailwind text color
  bg: string;             // tailwind bg color (light)
  border: string;         // tailwind border color
  dot: string;            // tailwind bg for dot
  ruleTypes: { value: string; label: string; level: 'column' | 'table' | 'both'; hint?: string }[];
}[] = [
  {
    key: 'completeness',
    label: 'Completeness',
    description: 'Data exists and is not missing',
    color: 'text-blue-700',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    dot: 'bg-blue-500',
    ruleTypes: [
      { value: 'not_null', label: 'Not Null', level: 'column', hint: 'Fails if any value in this column is NULL' },
      { value: 'not_blank', label: 'Not Blank', level: 'column', hint: 'Fails if any value is an empty string after trimming' },
      { value: 'completeness_pct', label: 'Completeness % ≥ threshold', level: 'column', hint: 'Fails if the % of non-null values is below the threshold' },
    ],
  },
  {
    key: 'validity',
    label: 'Validity',
    description: 'Values conform to defined formats and ranges',
    color: 'text-violet-700',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
    dot: 'bg-violet-500',
    ruleTypes: [
      { value: 'accepted_values', label: 'Accepted Values', level: 'column', hint: 'Fails if any non-null value is not in the allowed list' },
      { value: 'pattern_match', label: 'Pattern Match (regex)', level: 'column', hint: 'Fails if any non-null value does not match the regex' },
      { value: 'range_check', label: 'Numeric Range [min, max]', level: 'column', hint: 'Fails if any value is outside the specified numeric range' },
      { value: 'format_check', label: 'Format Check', level: 'column', hint: 'Checks a built-in format heuristic: email, url, date, phone…' },
    ],
  },
  {
    key: 'uniqueness',
    label: 'Uniqueness',
    description: 'No duplicate values or combinations',
    color: 'text-green-700',
    bg: 'bg-green-50',
    border: 'border-green-200',
    dot: 'bg-green-500',
    ruleTypes: [
      { value: 'unique_column', label: 'Unique Column', level: 'column', hint: 'Fails if any duplicate values exist in this column' },
      { value: 'unique_combo', label: 'Unique Combination', level: 'table', hint: 'Fails if any combination of the specified columns is duplicated' },
    ],
  },
  {
    key: 'consistency',
    label: 'Consistency',
    description: 'Values are logically consistent across columns',
    color: 'text-amber-700',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    dot: 'bg-amber-500',
    ruleTypes: [
      { value: 'cross_column', label: 'Cross-column SQL Expression', level: 'table', hint: 'Write a SQL boolean expression (TRUE = valid row). Can reference multiple columns.' },
    ],
  },
  {
    key: 'timeliness',
    label: 'Timeliness',
    description: 'Data is up-to-date within expected freshness window',
    color: 'text-orange-700',
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    dot: 'bg-orange-500',
    ruleTypes: [
      { value: 'freshness_days', label: 'Freshness (max age in days)', level: 'table', hint: 'Fails if MAX(date_col) is older than the specified number of days' },
    ],
  },
  {
    key: 'accuracy',
    label: 'Accuracy',
    description: 'Data reflects expected volume and statistical distribution',
    color: 'text-red-700',
    bg: 'bg-red-50',
    border: 'border-red-200',
    dot: 'bg-red-500',
    ruleTypes: [
      { value: 'row_count_range', label: 'Row Count Range [min, max]', level: 'table', hint: 'Fails if total row count is outside the specified range' },
      { value: 'statistical_range', label: 'Statistical Z-score Range', level: 'column', hint: 'Fails if values are outside mean ± z·stddev (outlier detection)' },
    ],
  },
];

const SEVERITY_META: Record<QualitySeverity, { label: string; textColor: string; bgColor: string; icon: React.ElementType }> = {
  info:    { label: 'Info',    textColor: 'text-blue-600',  bgColor: 'bg-blue-50',  icon: Info },
  warning: { label: 'Warning', textColor: 'text-amber-600', bgColor: 'bg-amber-50', icon: AlertTriangle },
  error:   { label: 'Error',   textColor: 'text-red-600',   bgColor: 'bg-red-50',   icon: XCircle },
};

const FORMAT_OPTIONS: { value: QualityFormat; label: string }[] = [
  { value: 'email',    label: 'Email address' },
  { value: 'url',      label: 'URL (http/https)' },
  { value: 'date',     label: 'Date (YYYY-MM-DD)' },
  { value: 'datetime', label: 'Datetime (ISO 8601)' },
  { value: 'phone',    label: 'Phone number' },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function dimDef(key: QualityDimension) {
  return DQ_DIMENSIONS.find((d) => d.key === key)!;
}

function getRuleTypeLabel(dim: QualityDimension, ruleType: string): string {
  const d = dimDef(dim);
  return d?.ruleTypes.find((r) => r.value === ruleType)?.label ?? ruleType;
}

function getColumnOptions(tables: DatasetTable[], tableId: number): string[] {
  const t = tables.find((t) => t.id === tableId);
  if (!t?.columns_cache) return [];
  const cache = t.columns_cache as Record<string, any>;
  const cols = cache.columns as { name: string }[] | undefined;
  return cols?.map((c) => c.name) ?? [];
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function RuleResultPill({ result }: {
  result?: { passed?: boolean; skipped?: boolean; error?: boolean; rows_failed?: number | null; rows_checked?: number | null } | null;
}) {
  if (!result) return null;
  if (result.skipped)
    return <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">skipped</span>;
  if (result.error)
    return <span className="inline-flex items-center gap-0.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600"><XCircle className="h-3 w-3" />error</span>;
  if (result.passed)
    return <span className="inline-flex items-center gap-0.5 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700"><CheckCircle2 className="h-3 w-3" />pass</span>;
  const detail = result.rows_failed != null ? `${result.rows_failed} fail` : 'fail';
  return <span className="inline-flex items-center gap-0.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700"><XCircle className="h-3 w-3" />{detail}</span>;
}

function InlineToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`flex items-center transition-colors disabled:opacity-40 ${checked ? 'text-blue-600' : 'text-gray-300'}`}
      title={checked ? 'Enabled — click to disable' : 'Disabled — click to enable'}
    >
      {checked ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tag input
// ---------------------------------------------------------------------------

function TagInput({ values, onChange, placeholder, suggestions }: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
}) {
  const [input, setInput] = useState('');
  const [showSug, setShowSug] = useState(false);
  const filtered = useMemo(
    () => (suggestions ?? []).filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !values.includes(s)),
    [suggestions, input, values],
  );

  function add(val: string) {
    const v = val.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput('');
    setShowSug(false);
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-1 rounded border border-gray-200 p-1.5 focus-within:border-blue-400">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-0.5 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
            {v}
            <button onClick={() => onChange(values.filter((x) => x !== v))} className="hover:text-blue-900"><X className="h-2.5 w-2.5" /></button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setShowSug(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (input.trim()) add(input); }
            if (e.key === 'Backspace' && !input && values.length) onChange(values.slice(0, -1));
          }}
          onFocus={() => setShowSug(true)}
          onBlur={() => setTimeout(() => setShowSug(false), 150)}
          placeholder={values.length === 0 ? placeholder : ''}
          className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
        />
      </div>
      {showSug && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full rounded border border-gray-200 bg-white shadow-lg max-h-40 overflow-y-auto">
          {filtered.map((s) => (
            <button key={s} onMouseDown={() => add(s)} className="flex w-full items-center px-3 py-1.5 text-xs hover:bg-blue-50 text-gray-700">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column selector (dropdown or text)
// ---------------------------------------------------------------------------

function ColumnSelector({ tableId, tables, value, onChange, placeholder, label }: {
  tableId: number;
  tables: DatasetTable[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  const options = getColumnOptions(tables, tableId);
  return (
    <div>
      {label && <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>}
      {options.length > 0 ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
        >
          <option value="">— select column —</option>
          {options.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'column_name'}
          className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config fields per rule type
// ---------------------------------------------------------------------------

function ConfigFields({ ruleType, config, onPatch, tableId, tables }: {
  ruleType: string;
  config: QualityRuleConfig;
  onPatch: (p: Partial<QualityRuleConfig>) => void;
  tableId: number;
  tables: DatasetTable[];
}) {
  const colOptions = getColumnOptions(tables, tableId);

  switch (ruleType) {
    case 'completeness_pct':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Minimum completeness % (non-null rows)</label>
          <div className="flex items-center gap-2">
            <input type="number" min={0} max={100} step={1}
              value={config.threshold ?? ''}
              onChange={(e) => onPatch({ threshold: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="95"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
            <span className="text-sm text-gray-500 shrink-0">%</span>
          </div>
        </div>
      );

    case 'accepted_values':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Allowed values <span className="text-gray-400 font-normal">(Enter or comma to add)</span></label>
          <TagInput values={config.values ?? []} onChange={(values) => onPatch({ values })} placeholder="Add value and press Enter…" />
        </div>
      );

    case 'pattern_match':
      return (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Regex pattern</label>
            <input type="text"
              value={config.pattern ?? ''}
              onChange={(e) => onPatch({ pattern: e.target.value || undefined })}
              placeholder="^[A-Z]{2}[0-9]+$"
              className="w-full rounded border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Flags <span className="text-gray-400 font-normal">(optional, e.g. i for case-insensitive)</span></label>
            <input type="text"
              value={(config as any).flags ?? ''}
              onChange={(e) => onPatch({ flags: e.target.value || undefined } as any)}
              placeholder="i"
              className="w-24 rounded border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none" />
          </div>
        </div>
      );

    case 'range_check':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Min <span className="text-gray-400 font-normal">(inclusive)</span></label>
            <input type="text" value={config.min ?? ''}
              onChange={(e) => onPatch({ min: e.target.value || undefined })}
              placeholder="0"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Max <span className="text-gray-400 font-normal">(inclusive)</span></label>
            <input type="text" value={config.max ?? ''}
              onChange={(e) => onPatch({ max: e.target.value || undefined })}
              placeholder="1000"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
        </div>
      );

    case 'format_check':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Format type</label>
          <select value={config.format ?? ''}
            onChange={(e) => onPatch({ format: (e.target.value || undefined) as QualityFormat | undefined })}
            className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
            <option value="">— select format —</option>
            {FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
      );

    case 'unique_combo':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Columns to check combination uniqueness</label>
          <TagInput
            values={config.columns ?? []}
            onChange={(columns) => onPatch({ columns })}
            placeholder="Add column and press Enter…"
            suggestions={colOptions}
          />
          <p className="mt-1 text-[11px] text-gray-400">Fails if any combination of these columns is duplicated.</p>
        </div>
      );

    case 'cross_column':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            SQL boolean expression <span className="text-gray-400 font-normal">(TRUE = valid row)</span>
          </label>
          <textarea rows={3}
            value={config.expression ?? ''}
            onChange={(e) => onPatch({ expression: e.target.value || undefined })}
            placeholder={'end_date >= start_date\n-- or cross-table: amount > 0 AND status != \'void\''}
            className="w-full rounded border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-blue-400 focus:outline-none resize-none" />
          <p className="mt-1 text-[11px] text-gray-400">
            Can reference any column in this table. Use standard SQL operators.
          </p>
        </div>
      );

    case 'freshness_days':
      return (
        <div className="space-y-3">
          <ColumnSelector
            tableId={tableId} tables={tables}
            value={config.column ?? ''}
            onChange={(v) => onPatch({ column: v || undefined })}
            label="Date / timestamp column"
            placeholder="updated_at"
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Max age (days)</label>
            <input type="number" min={1} step={1}
              value={config.max_days ?? ''}
              onChange={(e) => onPatch({ max_days: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="1"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
        </div>
      );

    case 'row_count_range':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Min rows</label>
            <input type="number" min={0} step={1}
              value={config.min ?? ''}
              onChange={(e) => onPatch({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="1"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Max rows</label>
            <input type="number" min={0} step={1}
              value={config.max ?? ''}
              onChange={(e) => onPatch({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="10000000"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
        </div>
      );

    case 'statistical_range':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Min Z-score</label>
            <input type="number" step={0.1}
              value={config.min_z ?? ''}
              onChange={(e) => onPatch({ min_z: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="-3"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Max Z-score</label>
            <input type="number" step={0.1}
              value={config.max_z ?? ''}
              onChange={(e) => onPatch({ max_z: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="3"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Rule Editor Drawer
// ---------------------------------------------------------------------------

interface RuleEditorProps {
  datasetId: number;
  tables: DatasetTable[];
  editingRule: QualityRule | null;         // null = create mode
  defaultTableId?: number;
  defaultDimension?: QualityDimension;
  onClose: () => void;
  onSaved: (rule: QualityRule) => void;
  onDuplicate?: (rule: QualityRule) => void;
}

function RuleEditorDrawer({
  datasetId, tables, editingRule, defaultTableId, defaultDimension, onClose, onSaved, onDuplicate,
}: RuleEditorProps) {
  const isEdit = editingRule !== null;

  const [tableId, setTableId]       = useState<number>(editingRule?.table_id ?? defaultTableId ?? (tables[0]?.id ?? 0));
  const [dimension, setDimension]   = useState<QualityDimension>(editingRule?.dimension ?? defaultDimension ?? 'completeness');
  const [ruleType, setRuleType]     = useState<string>(editingRule?.rule_type ?? 'not_null');
  const [columnName, setColumnName] = useState<string>(editingRule?.column_name ?? '');
  const [name, setName]             = useState<string>(editingRule?.name ?? '');
  const [severity, setSeverity]     = useState<QualitySeverity>(editingRule?.severity ?? 'warning');
  const [enabled, setEnabled]       = useState<boolean>(editingRule?.enabled ?? true);
  const [config, setConfig]         = useState<QualityRuleConfig>(editingRule?.config ?? {});
  const [nameEdited, setNameEdited] = useState<boolean>(isEdit);

  const createMutation = useCreateQualityRule(datasetId);
  const updateMutation = useUpdateQualityRule(datasetId);

  const dimDef_ = dimDef(dimension);
  const rtDef   = dimDef_.ruleTypes.find((r) => r.value === ruleType);
  const colOpts = getColumnOptions(tables, tableId);

  // Auto-generate name when fields change (create mode only)
  useEffect(() => {
    if (nameEdited) return;
    const tableName = tables.find((t) => t.id === tableId)?.display_name ?? '';
    const rtLabel = dimDef_.ruleTypes.find((r) => r.value === ruleType)?.label ?? ruleType;
    const col = columnName.trim();
    setName(col ? `${tableName}: ${col} — ${rtLabel}` : `${tableName} — ${rtLabel}`);
  }, [tableId, dimension, ruleType, columnName, nameEdited, tables, dimDef_]);

  function patchConfig(partial: Partial<QualityRuleConfig>) {
    setConfig((prev) => ({ ...prev, ...partial }));
  }

  function switchDimension(d: QualityDimension) {
    setDimension(d);
    const firstType = DQ_DIMENSIONS.find((x) => x.key === d)!.ruleTypes[0].value;
    setRuleType(firstType);
    setConfig({});
    setColumnName('');
  }

  function switchRuleType(rt: string) {
    setRuleType(rt);
    setConfig({});
  }

  async function handleSave() {
    if (!tables.find((t) => t.id === tableId)) { toast.error('Select a table'); return; }
    if (!name.trim()) { toast.error('Rule name is required'); return; }
    try {
      let saved: QualityRule;
      if (isEdit) {
        saved = await updateMutation.mutateAsync({
          ruleId: editingRule!.id,
          body: { column_name: columnName || undefined, dimension, rule_type: ruleType, name: name.trim(), config, severity, enabled },
        });
        toast.success('Rule updated');
      } else {
        saved = await createMutation.mutateAsync({
          table_id: tableId, column_name: columnName || undefined, dimension, rule_type: ruleType,
          name: name.trim(), config, severity, enabled,
        });
        toast.success('Rule created');
      }
      onSaved(saved);
    } catch {
      toast.error('Failed to save rule');
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 z-40 flex h-full w-full max-w-sm flex-col bg-white shadow-2xl border-l border-gray-200">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{isEdit ? 'Edit Rule' : 'New Quality Rule'}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{isEdit ? `Rule #${editingRule!.id}` : 'Configure a data quality check'}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

          {/* Table */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Table</label>
            <select value={tableId} onChange={(e) => { setTableId(Number(e.target.value)); setColumnName(''); }} disabled={isEdit}
              className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400">
              {tables.map((t) => <option key={t.id} value={t.id}>{t.display_name || t.source_table_name}</option>)}
            </select>
          </div>

          {/* Dimension chips */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-600">DQ Dimension</label>
            <div className="grid grid-cols-3 gap-1.5">
              {DQ_DIMENSIONS.map((d) => (
                <button key={d.key}
                  onClick={() => switchDimension(d.key)}
                  className={`rounded border px-2 py-1.5 text-xs font-medium transition-colors ${
                    dimension === d.key
                      ? `${d.bg} ${d.color} ${d.border}`
                      : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:bg-gray-50'
                  }`}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* Rule type */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Rule Type</label>
            <select value={ruleType} onChange={(e) => switchRuleType(e.target.value)}
              className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
              {dimDef_.ruleTypes.map((rt) => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
            </select>
            {rtDef?.hint && (
              <p className="mt-1 text-[11px] text-gray-400">{rtDef.hint}</p>
            )}
          </div>

          {/* Column selector — shown for column-level rules */}
          {rtDef?.level !== 'table' && (
            <ColumnSelector
              tableId={tableId} tables={tables}
              value={columnName}
              onChange={setColumnName}
              label={rtDef?.level === 'both' ? 'Column (optional)' : 'Column'}
              placeholder="column_name"
            />
          )}

          {/* Dynamic config */}
          <ConfigFields ruleType={ruleType} config={config} onPatch={patchConfig} tableId={tableId} tables={tables} />

          {/* Rule name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Rule Name</label>
            <input type="text" value={name}
              onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
              onFocus={() => setNameEdited(true)}
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>

          {/* Severity */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-600">Severity</label>
            <div className="flex gap-2">
              {(['info', 'warning', 'error'] as QualitySeverity[]).map((s) => {
                const meta = SEVERITY_META[s];
                const Icon = meta.icon;
                return (
                  <button key={s} onClick={() => setSeverity(s)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded border py-1.5 text-xs font-medium transition-colors ${
                      severity === s
                        ? `${meta.bgColor} ${meta.textColor} border-current`
                        : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                    }`}>
                    <Icon className="h-3.5 w-3.5" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Enable toggle */}
          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-gray-200 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-gray-700">Enabled</p>
              <p className="text-xs text-gray-400">Disabled rules are skipped during quality runs</p>
            </div>
            <InlineToggle checked={enabled} onChange={setEnabled} />
          </label>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-gray-200 px-4 py-3 flex items-center justify-between gap-2">
          {isEdit && onDuplicate && (
            <button
              onClick={() => onDuplicate(editingRule!)}
              className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </button>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose}
              className="rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
            <button onClick={handleSave} disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isEdit ? 'Update Rule' : 'Create Rule'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dimension Group
// ---------------------------------------------------------------------------

interface DimensionGroupProps {
  dimKey: QualityDimension;
  rules: QualityRule[];
  tables: DatasetTable[];
  runResultsMap: Record<number, any>;
  canEdit: boolean;
  isRunning: boolean;
  onAddRule: (dim: QualityDimension) => void;
  onEditRule: (rule: QualityRule) => void;
  onToggleRule: (rule: QualityRule) => void;
  onDeleteRule: (rule: QualityRule) => void;
  onDuplicateRule: (rule: QualityRule) => void;
  togglingIds: Set<number>;
}

function DimensionGroup({
  dimKey, rules, tables, runResultsMap, canEdit, isRunning,
  onAddRule, onEditRule, onToggleRule, onDeleteRule, onDuplicateRule, togglingIds,
}: DimensionGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const def = dimDef(dimKey);

  const passCount  = rules.filter((r) => runResultsMap[r.id]?.passed === true && !runResultsMap[r.id]?.skipped).length;
  const failCount  = rules.filter((r) => runResultsMap[r.id]?.passed === false && !runResultsMap[r.id]?.skipped && !runResultsMap[r.id]?.error).length;
  const hasResults = rules.some((r) => r.id in runResultsMap);

  const allEnabled   = rules.every((r) => r.enabled);
  const noneEnabled  = rules.every((r) => !r.enabled);

  return (
    <div className={`rounded-xl border ${def.border} overflow-hidden`}>
      {/* Group header */}
      <div className={`flex items-center gap-2 px-3 py-2 ${def.bg}`}>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {collapsed ? <ChevronRight className={`h-4 w-4 ${def.color}`} /> : <ChevronDown className={`h-4 w-4 ${def.color}`} />}
          <span className={`h-2 w-2 rounded-full ${def.dot} shrink-0`} />
          <span className={`text-xs font-bold uppercase tracking-wide ${def.color}`}>{def.label}</span>
          <span className={`text-xs ${def.color} opacity-60 truncate hidden sm:block`}>— {def.description}</span>
          <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${def.bg} ${def.color} border ${def.border}`}>
            {rules.length}
          </span>
        </button>

        {/* Pass/fail summary from latest run */}
        {hasResults && (
          <div className="flex items-center gap-1.5 shrink-0">
            {passCount > 0 && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
                <CheckCircle2 className="h-3 w-3" />{passCount} pass
              </span>
            )}
            {failCount > 0 && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                <XCircle className="h-3 w-3" />{failCount} fail
              </span>
            )}
          </div>
        )}

        {/* Bulk toggle */}
        {canEdit && (
          <button
            onClick={() => {
              rules.forEach((r) => {
                const shouldEnable = !allEnabled;
                if (r.enabled !== shouldEnable) onToggleRule({ ...r, enabled: !r.enabled });
              });
            }}
            className={`shrink-0 text-[11px] rounded border px-2 py-0.5 font-medium transition-colors ${def.color} border-current hover:opacity-80`}
            title={allEnabled ? 'Disable all in this dimension' : 'Enable all in this dimension'}
          >
            {allEnabled ? 'Disable all' : noneEnabled ? 'Enable all' : 'Toggle all'}
          </button>
        )}

        {canEdit && (
          <button
            onClick={() => onAddRule(dimKey)}
            className={`shrink-0 inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${def.color} border-current hover:opacity-80`}
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
      </div>

      {/* Rules list */}
      {!collapsed && (
        <div className="divide-y divide-gray-100 bg-white">
          {rules.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-5 text-center justify-center">
              <ShieldCheck className="h-6 w-6 text-gray-200" />
              <div>
                <p className="text-sm text-gray-400">No {def.label} rules yet</p>
                {canEdit && (
                  <button onClick={() => onAddRule(dimKey)} className="mt-1 text-xs text-blue-600 hover:underline">
                    + Add first rule
                  </button>
                )}
              </div>
            </div>
          ) : (
            rules.map((rule) => {
              const result = runResultsMap[rule.id];
              const sev = SEVERITY_META[rule.severity as QualitySeverity] ?? SEVERITY_META.warning;
              const SevIcon = sev.icon;
              const tableName = tables.find((t) => t.id === rule.table_id)?.display_name ?? '';
              const isToggling = togglingIds.has(rule.id);

              return (
                <div
                  key={rule.id}
                  className={`group flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors ${!rule.enabled ? 'opacity-50' : ''}`}
                >
                  {/* Severity icon */}
                  <SevIcon className={`h-3.5 w-3.5 shrink-0 ${sev.textColor}`} title={sev.label} />

                  {/* Rule info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-gray-800 font-medium truncate">{rule.name}</p>
                      {!rule.enabled && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-400">disabled</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
                      <span className="flex items-center gap-1">
                        <Database className="h-3 w-3" />{tableName}
                      </span>
                      {rule.column_name && (
                        <>
                          <ChevronRight className="h-3 w-3" />
                          <code className="font-mono text-gray-500">{rule.column_name}</code>
                        </>
                      )}
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px]">
                        {getRuleTypeLabel(rule.dimension, rule.rule_type)}
                      </span>
                    </div>
                  </div>

                  {/* Last run result */}
                  <RuleResultPill result={result} />

                  {/* Actions */}
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {canEdit && (
                      <>
                        <InlineToggle checked={rule.enabled} onChange={() => onToggleRule(rule)} disabled={isToggling} />
                        <button
                          onClick={() => onDuplicateRule(rule)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                          title="Duplicate rule"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => onEditRule(rule)}
                          className="rounded p-1 text-gray-400 hover:bg-blue-100 hover:text-blue-600"
                          title="Edit rule"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteRule(rule)}
                          className="rounded p-1 text-gray-400 hover:bg-red-100 hover:text-red-600"
                          title="Delete rule"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Duplicate dialog
// ---------------------------------------------------------------------------

function DuplicateDialog({ rule, tables, datasetId, onClose, onDone }: {
  rule: QualityRule;
  tables: DatasetTable[];
  datasetId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [targetTableId, setTargetTableId] = useState<number>(rule.table_id);
  const dupMutation = useDuplicateQualityRule(datasetId);

  async function handleDuplicate() {
    try {
      await dupMutation.mutateAsync({ ruleId: rule.id, targetTableId, nameSuffix: ' (copy)' });
      toast.success('Rule duplicated');
      onDone();
    } catch {
      toast.error('Failed to duplicate rule');
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-2xl border border-gray-200">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Duplicate Rule</h3>
        <p className="text-xs text-gray-500 mb-4">Copy <strong>"{rule.name}"</strong> to which table?</p>
        <div className="mb-4">
          <label className="mb-1 block text-xs font-medium text-gray-600">Target table</label>
          <select value={targetTableId} onChange={(e) => setTargetTableId(Number(e.target.value))}
            className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
            {tables.map((t) => <option key={t.id} value={t.id}>{t.display_name || t.source_table_name}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={handleDuplicate} disabled={dupMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {dupMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Duplicate
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm
// ---------------------------------------------------------------------------

function DeleteConfirmDialog({ rule, onConfirm, onCancel, isPending }: {
  rule: QualityRule;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onCancel} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-2xl border border-gray-200">
        <div className="flex items-start gap-3 mb-4">
          <Trash2 className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Delete Rule?</h3>
            <p className="text-xs text-gray-500 mt-1">Are you sure you want to delete <strong>"{rule.name}"</strong>? This cannot be undone.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={isPending} className="rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export interface DatasetQualityPanelProps {
  datasetId: number;
  tables: DatasetTable[];
  canEdit: boolean;
}

export function DatasetQualityPanel({ datasetId, tables, canEdit }: DatasetQualityPanelProps) {
  // Filters
  const [tableFilter, setTableFilter]   = useState<number | 'all'>('all');
  const [dimFilter, setDimFilter]       = useState<QualityDimension | 'all'>('all');

  // Editor state
  const [editorOpen, setEditorOpen]             = useState(false);
  const [editingRule, setEditingRule]           = useState<QualityRule | null>(null);
  const [editorDefaultDim, setEditorDefaultDim] = useState<QualityDimension | undefined>(undefined);
  const [duplicatingRule, setDuplicatingRule]   = useState<QualityRule | null>(null);
  const [deletingRule, setDeletingRule]         = useState<QualityRule | null>(null);
  const [togglingIds, setTogglingIds]           = useState<Set<number>>(new Set());

  // Run state
  const [pollingRunId, setPollingRunId] = useState<number | null>(null);
  // Lưu kết quả run cuối để hiển thị sau khi xong
  const [lastRunResult, setLastRunResult] = useState<{ status: 'completed' | 'failed'; score?: number | null } | null>(null);

  // Data
  const { data: allRules = [], isLoading: loadingRules, error: rulesError, refetch: refetchRules } = useQualityRules(datasetId);
  const { data: runs = [], refetch: refetchRuns } = useQualityRuns(datasetId);
  const { data: summary, refetch: refetchSummary } = useQualitySummary(datasetId);
  const { data: pollingRun } = useQualityRunPoll(datasetId, pollingRunId, pollingRunId !== null);
  const triggerRun     = useTriggerQualityRun(datasetId);
  const updateRule     = useUpdateQualityRule(datasetId);
  const deleteMutation = useDeleteQualityRule(datasetId);

  // Auto-detect active run khi mới load — chỉ chạy 1 lần
  const didAutoDetectRef = React.useRef(false);
  useEffect(() => {
    if (didAutoDetectRef.current) return;
    if (runs.length === 0) return;
    didAutoDetectRef.current = true;
    if (pollingRunId !== null) return;
    const active = runs.find((r) => r.status === 'queued' || r.status === 'running');
    if (active) setPollingRunId(active.id);
  }, [runs, pollingRunId]);

  // Khi run xong — refetch data, lưu kết quả, KHÔNG toast
  const handledRunIdRef = React.useRef<number | null>(null);
  useEffect(() => {
    if (!pollingRun) return;
    if (pollingRun.status !== 'completed' && pollingRun.status !== 'failed') return;
    if (handledRunIdRef.current === pollingRun.id) return;
    handledRunIdRef.current = pollingRun.id;

    setPollingRunId(null);
    setLastRunResult({ status: pollingRun.status, score: pollingRun.score });
    refetchRuns();
    refetchSummary();
  }, [pollingRun?.id, pollingRun?.status]);

  const isRunning = pollingRunId !== null;

  // Progress từ pollingRun (cập nhật mỗi 2s)
  const progressDone  = pollingRun?.progress_done ?? 0;
  const progressTotal = pollingRun?.progress_total ?? allRules.filter((r) => r.enabled).length;
  const progressPct   = progressTotal > 0
    ? Math.round((progressDone / progressTotal) * 100)
    : (pollingRun?.status === 'queued' ? 0 : 100);

  async function handleRunNow() {
    setLastRunResult(null);
    try {
      const res = await triggerRun.mutateAsync();
      setPollingRunId(res.run_id);
    } catch {
      toast.error('Failed to start quality run');
    }
  }

  // Inline toggle
  async function handleToggleRule(rule: QualityRule) {
    setTogglingIds((s) => new Set(s).add(rule.id));
    try {
      await updateRule.mutateAsync({ ruleId: rule.id, body: { enabled: !rule.enabled } });
    } catch {
      toast.error('Failed to update rule');
    } finally {
      setTogglingIds((s) => { const n = new Set(s); n.delete(rule.id); return n; });
    }
  }

  // Delete
  async function handleDeleteConfirm() {
    if (!deletingRule) return;
    try {
      await deleteMutation.mutateAsync(deletingRule.id);
      setDeletingRule(null);
    } catch {
      toast.error('Failed to delete rule');
    }
  }

  // Latest completed run results map
  const latestCompletedRun = runs.find((r) => r.status === 'completed') ?? null;
  const runResultsMap: Record<number, any> = useMemo(() => {
    if (!latestCompletedRun?.results) return {};
    return Object.fromEntries(
      Object.entries(latestCompletedRun.results).map(([k, v]) => [Number(k), v])
    );
  }, [latestCompletedRun]);

  // Filtered rules
  const filteredRules = useMemo(() => allRules.filter((r) => {
    if (tableFilter !== 'all' && r.table_id !== tableFilter) return false;
    if (dimFilter !== 'all' && r.dimension !== dimFilter) return false;
    return true;
  }), [allRules, tableFilter, dimFilter]);

  const groupedByDim = useMemo(() => {
    const map: Partial<Record<QualityDimension, QualityRule[]>> = {};
    for (const rule of filteredRules) {
      if (!map[rule.dimension]) map[rule.dimension] = [];
      map[rule.dimension]!.push(rule);
    }
    return map;
  }, [filteredRules]);

  // Rule counts per dim for chips
  const dimCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const rule of allRules) {
      if (tableFilter !== 'all' && rule.table_id !== tableFilter) continue;
      counts[rule.dimension] = (counts[rule.dimension] ?? 0) + 1;
    }
    return counts;
  }, [allRules, tableFilter]);

  // Open editor for new rule
  function openNewRule(dim?: QualityDimension) {
    setEditingRule(null);
    setEditorDefaultDim(dim);
    setEditorOpen(true);
  }

  // Open editor for existing rule
  function openEditRule(rule: QualityRule) {
    setEditingRule(rule);
    setEditorDefaultDim(undefined);
    setEditorOpen(true);
  }

  const totalRules   = allRules.length;
  const enabledRules = allRules.filter((r) => r.enabled).length;

  // ── Quick-view card stats ──────────────────────────────────────────────────
  // Score từ latest completed run (hoặc summary)
  const overallScore: number | null = latestCompletedRun?.score ?? summary?.score ?? null;

  // Pass / fail / skipped / error counts từ latest completed run
  const runStats = useMemo(() => {
    const vals = Object.values(runResultsMap);
    if (vals.length === 0) return null;
    const pass    = vals.filter((r) => r.passed && !r.skipped).length;
    const fail    = vals.filter((r) => !r.passed && !r.skipped && !r.error).length;
    const skipped = vals.filter((r) => r.skipped).length;
    const error   = vals.filter((r) => r.error).length;
    return { pass, fail, skipped, error, total: vals.length };
  }, [runResultsMap]);

  // Dimension breakdown từ summary (có passed/failed per-dimension)
  const dimBreakdown = summary?.dimension_breakdown ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-50">
      {/* ── Toolbar ── */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-4 py-2 flex items-center gap-3 flex-wrap">
        {/* Table filter */}
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <select
            value={tableFilter === 'all' ? 'all' : String(tableFilter)}
            onChange={(e) => setTableFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
          >
            <option value="all">All tables ({allRules.length} rules)</option>
            {tables.map((t) => {
              const cnt = allRules.filter((r) => r.table_id === t.id).length;
              return (
                <option key={t.id} value={t.id}>{t.display_name || t.source_table_name} ({cnt})</option>
              );
            })}
          </select>
        </div>

        {/* Dimension chips */}
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={() => setDimFilter('all')}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              dimFilter === 'all'
                ? 'border-gray-700 bg-gray-700 text-white'
                : 'border-gray-200 text-gray-500 hover:border-gray-400'
            }`}
          >
            All
          </button>
          {DQ_DIMENSIONS.map((d) => {
            const cnt = dimCounts[d.key] ?? 0;
            const active = dimFilter === d.key;
            return (
              <button
                key={d.key}
                onClick={() => setDimFilter(active ? 'all' : d.key)}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  active
                    ? `${d.bg} ${d.color} ${d.border}`
                    : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                {d.label}{cnt > 0 ? ` (${cnt})` : ''}
              </button>
            );
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Stats */}
        <span className="text-xs text-gray-400 shrink-0">
          {enabledRules}/{totalRules} enabled
        </span>

        {/* Run now */}
        {canEdit && (
          <button
            onClick={handleRunNow}
            disabled={isRunning || triggerRun.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 shrink-0"
          >
            {isRunning
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Running…</>
              : <><Play className="h-3.5 w-3.5" />Run Now</>
            }
          </button>
        )}

        {/* Add rule */}
        {canEdit && (
          <button
            onClick={() => openNewRule()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-600 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" /> Add Rule
          </button>
        )}
      </div>

      {/* ── Progress bar (chỉ hiện khi đang chạy) ── */}
      {isRunning && (
        <div className="shrink-0 border-b border-blue-100 bg-white px-4 py-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-blue-700 flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {pollingRun?.status === 'queued'
                ? 'Preparing run…'
                : `Checking rules… ${progressDone}/${progressTotal}`}
            </span>
            <span className="text-xs font-semibold text-blue-700">{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Kết quả run (hiện ngắn sau khi xong, không dùng toast) ── */}
      {!isRunning && lastRunResult && (
        <div className={`shrink-0 border-b px-4 py-2 flex items-center justify-between ${
          lastRunResult.status === 'completed'
            ? 'bg-green-50 border-green-200'
            : 'bg-red-50 border-red-200'
        }`}>
          <span className={`text-xs font-medium flex items-center gap-1.5 ${
            lastRunResult.status === 'completed' ? 'text-green-700' : 'text-red-700'
          }`}>
            {lastRunResult.status === 'completed'
              ? <><CheckCircle2 className="h-3.5 w-3.5" />
                  Run complete{lastRunResult.score != null ? ` — ${lastRunResult.score.toFixed(0)}% pass rate` : ''}</>
              : <><XCircle className="h-3.5 w-3.5" />Run failed</>
            }
          </span>
          <button
            onClick={() => setLastRunResult(null)}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Quick-view Summary Cards ── */}
      {(overallScore !== null || runStats || dimBreakdown.length > 0) && (
        <div className="shrink-0 border-b border-gray-100 bg-white px-4 py-3">
          <div className="flex items-stretch gap-3 flex-wrap">

            {/* Score card */}
            {overallScore !== null && (
              <div className={`flex flex-col items-center justify-center min-w-[80px] rounded-xl border px-4 py-2.5 ${
                overallScore >= 90
                  ? 'border-green-200 bg-green-50'
                  : overallScore >= 70
                  ? 'border-yellow-200 bg-yellow-50'
                  : 'border-red-200 bg-red-50'
              }`}>
                <span className={`text-2xl font-bold leading-none ${
                  overallScore >= 90 ? 'text-green-700' : overallScore >= 70 ? 'text-yellow-700' : 'text-red-700'
                }`}>
                  {overallScore.toFixed(0)}%
                </span>
                <span className="mt-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide">Score</span>
              </div>
            )}

            {/* Pass / Fail / Error counts */}
            {runStats && (
              <div className="flex items-stretch gap-2">
                <div className="flex flex-col items-center justify-center min-w-[56px] rounded-xl border border-green-200 bg-green-50 px-3 py-2.5">
                  <span className="text-lg font-bold text-green-700 leading-none">{runStats.pass}</span>
                  <span className="mt-1 text-[10px] font-medium text-green-500 uppercase tracking-wide">Pass</span>
                </div>
                <div className="flex flex-col items-center justify-center min-w-[56px] rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
                  <span className="text-lg font-bold text-red-600 leading-none">{runStats.fail}</span>
                  <span className="mt-1 text-[10px] font-medium text-red-400 uppercase tracking-wide">Fail</span>
                </div>
                {runStats.error > 0 && (
                  <div className="flex flex-col items-center justify-center min-w-[56px] rounded-xl border border-orange-200 bg-orange-50 px-3 py-2.5">
                    <span className="text-lg font-bold text-orange-600 leading-none">{runStats.error}</span>
                    <span className="mt-1 text-[10px] font-medium text-orange-400 uppercase tracking-wide">Error</span>
                  </div>
                )}
                {runStats.skipped > 0 && (
                  <div className="flex flex-col items-center justify-center min-w-[56px] rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
                    <span className="text-lg font-bold text-gray-500 leading-none">{runStats.skipped}</span>
                    <span className="mt-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide">Skip</span>
                  </div>
                )}
              </div>
            )}

            {/* Divider */}
            {dimBreakdown.length > 0 && (overallScore !== null || runStats) && (
              <div className="w-px bg-gray-100 self-stretch mx-1" />
            )}

            {/* Per-dimension health pills */}
            {dimBreakdown.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {dimBreakdown.map((dim) => {
                  const meta = DQ_DIMENSIONS.find((d) => d.key === dim.dimension);
                  const total = dim.enabled;
                  if (total === 0) return null;
                  const passed = dim.passed ?? 0;
                  const failed = dim.failed ?? 0;
                  const pct = total > 0 ? Math.round((passed / total) * 100) : null;
                  const healthy = failed === 0;
                  return (
                    <button
                      key={dim.dimension}
                      onClick={() => setDimFilter(dimFilter === dim.dimension ? 'all' : dim.dimension as QualityDimension)}
                      title={`${dim.dimension}: ${passed}/${total} passed`}
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                        dimFilter === dim.dimension
                          ? `${meta?.bg ?? 'bg-gray-100'} ${meta?.color ?? 'text-gray-700'} ${meta?.border ?? 'border-gray-300'}`
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${healthy ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span>{meta?.label ?? dim.dimension}</span>
                      {pct !== null && (
                        <span className={`font-semibold ${healthy ? 'text-green-600' : 'text-red-500'}`}>
                          {pct}%
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* No-run hint */}
            {overallScore === null && !runStats && dimBreakdown.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <Info className="h-3.5 w-3.5" />
                Run rules to see quality scores
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {rulesError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Could not load quality rules</p>
              <p className="mt-1 text-red-600">{(rulesError as Error).message}</p>
              <button onClick={() => refetchRules()} className="mt-2 text-xs text-red-700 underline underline-offset-2">Retry</button>
            </div>
          </div>
        ) : loadingRules && !allRules.length ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Loader2 className="h-8 w-8 animate-spin text-gray-300" />
            <p className="text-sm text-gray-400">Loading rules…</p>
          </div>
        ) : allRules.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <div className="rounded-2xl border-2 border-dashed border-gray-200 p-6">
              <ShieldCheck className="h-12 w-12 text-gray-200 mx-auto mb-3" />
              <p className="text-base font-semibold text-gray-700 mb-1">No quality rules yet</p>
              <p className="text-sm text-gray-400 max-w-xs">
                Add rules to monitor data completeness, validity, uniqueness, consistency, timeliness, and accuracy across your tables.
              </p>
              {canEdit && (
                <button
                  onClick={() => openNewRule()}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  <Plus className="h-4 w-4" /> Add first rule
                </button>
              )}
            </div>
            {/* Quick-start dimension cards */}
            {canEdit && (
              <div className="mt-2 grid grid-cols-3 gap-2 max-w-xl">
                {DQ_DIMENSIONS.map((d) => (
                  <button
                    key={d.key}
                    onClick={() => openNewRule(d.key)}
                    className={`rounded-lg border ${d.border} ${d.bg} px-3 py-2 text-left hover:opacity-90 transition-opacity`}
                  >
                    <p className={`text-xs font-semibold ${d.color}`}>{d.label}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">{d.description}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Dimension groups */
          <div className="space-y-3">
            {DQ_DIMENSIONS.map((d) => {
              const dimRules = groupedByDim[d.key] ?? [];
              // Show group if it has rules OR filter is set to this dimension
              if (dimRules.length === 0 && dimFilter !== d.key && dimFilter !== 'all') return null;
              if (dimRules.length === 0 && dimFilter === 'all') return null; // hide empty groups when showing all
              return (
                <DimensionGroup
                  key={d.key}
                  dimKey={d.key}
                  rules={dimRules}
                  tables={tables}
                  runResultsMap={runResultsMap}
                  canEdit={canEdit}
                  isRunning={isRunning}
                  onAddRule={openNewRule}
                  onEditRule={openEditRule}
                  onToggleRule={handleToggleRule}
                  onDeleteRule={setDeletingRule}
                  onDuplicateRule={setDuplicatingRule}
                  togglingIds={togglingIds}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Rule Editor Drawer ── */}
      {editorOpen && canEdit && (
        <RuleEditorDrawer
          datasetId={datasetId}
          tables={tables}
          editingRule={editingRule}
          defaultTableId={tableFilter !== 'all' ? tableFilter : undefined}
          defaultDimension={editorDefaultDim}
          onClose={() => setEditorOpen(false)}
          onSaved={() => setEditorOpen(false)}
          onDuplicate={(rule) => { setEditorOpen(false); setDuplicatingRule(rule); }}
        />
      )}

      {/* ── Duplicate Dialog ── */}
      {duplicatingRule && (
        <DuplicateDialog
          rule={duplicatingRule}
          tables={tables}
          datasetId={datasetId}
          onClose={() => setDuplicatingRule(null)}
          onDone={() => setDuplicatingRule(null)}
        />
      )}

      {/* ── Delete Confirm ── */}
      {deletingRule && (
        <DeleteConfirmDialog
          rule={deletingRule}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeletingRule(null)}
          isPending={deleteMutation.isPending}
        />
      )}
    </div>
  );
}
