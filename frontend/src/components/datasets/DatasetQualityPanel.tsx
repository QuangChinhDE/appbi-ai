'use client';

/**
 * DatasetQualityPanel
 * ===================
 * Full Data Quality management panel for a dataset.
 *
 * Layout (3 columns):
 *   Left sidebar  — table list + dimension filter
 *   Center        — rule list for selected table, grouped by dimension
 *   Right panel   — rule editor (slide-in when creating / editing a rule)
 *
 * Sections:
 *   1. Quality Score banner (from latest completed run)
 *   2. Run Now button + run history
 *   3. Rules grouped by DQ dimension (Completeness/Validity/Uniqueness/Consistency/Timeliness/Accuracy)
 *   4. Per-rule result badges (pass/fail/pending) when a run exists
 *
 * No table notes / column descriptions here — those live in the Model tab's
 * ModelViewEditPanel dictionary context pane.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Database,
  Filter,
  Info,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
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
  type QualityRuleCreate,
  type QualityRun,
  type QualityRuleUpdate,
  type QualitySeverity,
  type QualitySummary,
  useCreateQualityRule,
  useDeleteQualityRule,
  useQualityRules,
  useQualityRunPoll,
  useQualityRuns,
  useQualitySummary,
  useTriggerQualityRun,
  useUpdateQualityRule,
} from '@/hooks/use-datasets';

// ---------------------------------------------------------------------------
// Constants & catalogue
// ---------------------------------------------------------------------------

export const DQ_DIMENSIONS: {
  key: QualityDimension;
  label: string;
  description: string;
  bgColor: string;
  textColor: string;
  dotColor: string;
  ruleTypes: { value: string; label: string; level: 'column' | 'table' | 'both' }[];
}[] = [
  {
    key: 'completeness',
    label: 'Completeness',
    description: 'Data exists and is not missing',
    bgColor: 'bg-blue-50',
    textColor: 'text-blue-700',
    dotColor: 'bg-blue-400',
    ruleTypes: [
      { value: 'not_null', label: 'Not Null', level: 'column' },
      { value: 'not_blank', label: 'Not Blank (empty string)', level: 'column' },
      { value: 'completeness_pct', label: 'Completeness % ≥ threshold', level: 'column' },
    ],
  },
  {
    key: 'validity',
    label: 'Validity',
    description: 'Values conform to defined formats and ranges',
    bgColor: 'bg-violet-50',
    textColor: 'text-violet-700',
    dotColor: 'bg-violet-400',
    ruleTypes: [
      { value: 'accepted_values', label: 'Accepted Values (enum)', level: 'column' },
      { value: 'pattern_match', label: 'Pattern Match (regex)', level: 'column' },
      { value: 'range_check', label: 'Numeric Range [min, max]', level: 'column' },
      { value: 'format_check', label: 'Format Check (email/url/date…)', level: 'column' },
    ],
  },
  {
    key: 'uniqueness',
    label: 'Uniqueness',
    description: 'No duplicate values or combinations',
    bgColor: 'bg-green-50',
    textColor: 'text-green-700',
    dotColor: 'bg-green-400',
    ruleTypes: [
      { value: 'unique_column', label: 'Unique Column', level: 'column' },
      { value: 'unique_combo', label: 'Unique Combination of Columns', level: 'table' },
    ],
  },
  {
    key: 'consistency',
    label: 'Consistency',
    description: 'Values are logically consistent across columns',
    bgColor: 'bg-amber-50',
    textColor: 'text-amber-700',
    dotColor: 'bg-amber-400',
    ruleTypes: [
      { value: 'cross_column', label: 'Cross-column SQL Expression', level: 'table' },
    ],
  },
  {
    key: 'timeliness',
    label: 'Timeliness',
    description: 'Data is up-to-date within expected freshness window',
    bgColor: 'bg-orange-50',
    textColor: 'text-orange-700',
    dotColor: 'bg-orange-400',
    ruleTypes: [
      { value: 'freshness_days', label: 'Freshness (max age in days)', level: 'table' },
    ],
  },
  {
    key: 'accuracy',
    label: 'Accuracy',
    description: 'Data reflects expected volume and statistical distribution',
    bgColor: 'bg-red-50',
    textColor: 'text-red-700',
    dotColor: 'bg-red-400',
    ruleTypes: [
      { value: 'row_count_range', label: 'Row Count Range [min, max]', level: 'table' },
      { value: 'statistical_range', label: 'Statistical Z-score Range', level: 'column' },
    ],
  },
];

const SEVERITY_META: Record<QualitySeverity, { label: string; color: string; icon: React.ElementType }> = {
  info: { label: 'Info', color: 'text-blue-500', icon: Info },
  warning: { label: 'Warning', color: 'text-amber-500', icon: AlertTriangle },
  error: { label: 'Error', color: 'text-red-500', icon: XCircle },
};

const FORMAT_OPTIONS = ['email', 'url', 'date', 'datetime', 'phone'];

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

function dimMeta(dim: QualityDimension) {
  return DQ_DIMENSIONS.find((d) => d.key === dim)!;
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 90 ? 'bg-green-100 text-green-700 border-green-200' :
    score >= 70 ? 'bg-amber-100 text-amber-700 border-amber-200' :
                  'bg-red-100 text-red-700 border-red-200';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm font-semibold ${color}`}>
      <ShieldCheck className="h-3.5 w-3.5" />
      {score.toFixed(0)}%
    </span>
  );
}

function RunStatusIcon({ status }: { status: QualityRun['status'] }) {
  if (status === 'queued' || status === 'running')
    return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  if (status === 'completed') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  return <XCircle className="h-4 w-4 text-red-500" />;
}

function RuleResultBadge({ result }: {
  result?: { passed?: boolean; skipped?: boolean; error?: boolean } | null;
}) {
  if (!result) return <span className="text-xs text-gray-400">—</span>;
  if (result.skipped) return <span className="text-xs text-gray-400">skipped</span>;
  if (result.error) return <span className="text-xs text-red-500">error</span>;
  if (result.passed)
    return <span className="inline-flex items-center gap-0.5 text-xs text-green-600"><CheckCircle2 className="h-3 w-3" /> pass</span>;
  return <span className="inline-flex items-center gap-0.5 text-xs text-red-600"><XCircle className="h-3 w-3" /> fail</span>;
}

// ---------------------------------------------------------------------------
// Tag input (accepted_values / columns)
// ---------------------------------------------------------------------------

function ValuesTagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');

  function add() {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput('');
  }

  return (
    <div className="rounded border border-gray-200 p-1.5">
      <div className="flex flex-wrap gap-1 mb-1">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-0.5 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
            {v}
            <button onClick={() => onChange(values.filter((x) => x !== v))} className="ml-0.5 hover:text-blue-900">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm outline-none placeholder:text-gray-400"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dynamic config fields by rule_type
// ---------------------------------------------------------------------------

interface ConfigFieldsProps {
  ruleType: string;
  config: QualityRuleConfig;
  onPatch: (partial: Partial<QualityRuleConfig>) => void;
}

function ConfigFields({ ruleType, config, onPatch }: ConfigFieldsProps) {
  switch (ruleType) {
    case 'completeness_pct':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Minimum completeness % (non-null rows)</label>
          <input type="number" min={0} max={100} step={1}
            value={config.threshold ?? ''}
            onChange={(e) => onPatch({ threshold: e.target.value === '' ? undefined : Number(e.target.value) })}
            placeholder="95"
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </div>
      );
    case 'accepted_values':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Allowed values</label>
          <ValuesTagInput values={config.values ?? []} onChange={(values) => onPatch({ values })} placeholder="Add value and press Enter…" />
        </div>
      );
    case 'pattern_match':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Regex pattern</label>
          <input type="text"
            value={config.pattern ?? ''}
            onChange={(e) => onPatch({ pattern: e.target.value || undefined })}
            placeholder="^[A-Z]{2}[0-9]+$"
            className="w-full rounded border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none" />
        </div>
      );
    case 'range_check':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Min</label>
            <input type="text" value={config.min ?? ''}
              onChange={(e) => onPatch({ min: e.target.value || undefined })}
              placeholder="0"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Max</label>
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
            onChange={(e) => onPatch({ format: e.target.value || undefined })}
            className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
            <option value="">— select —</option>
            {FORMAT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      );
    case 'unique_combo':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Columns (combination must be unique)</label>
          <ValuesTagInput values={config.columns ?? []} onChange={(columns) => onPatch({ columns })} placeholder="Add column and press Enter…" />
        </div>
      );
    case 'cross_column':
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">SQL boolean expression (True = valid row)</label>
          <textarea rows={3}
            value={config.expression ?? ''}
            onChange={(e) => onPatch({ expression: e.target.value || undefined })}
            placeholder="end_date >= start_date"
            className="w-full rounded border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-blue-400 focus:outline-none resize-none" />
        </div>
      );
    case 'freshness_days':
      return (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Date/timestamp column</label>
            <input type="text"
              value={config.column ?? ''}
              onChange={(e) => onPatch({ column: e.target.value || undefined })}
              placeholder="updated_at"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
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
// Rule Editor (right panel)
// ---------------------------------------------------------------------------

interface RuleEditorProps {
  datasetId: number;
  tables: DatasetTable[];
  editingRule: QualityRule | null;
  defaultTableId?: number;
  onClose: () => void;
  onSaved: () => void;
}

function RuleEditor({ datasetId, tables, editingRule, defaultTableId, onClose, onSaved }: RuleEditorProps) {
  const isEdit = editingRule !== null;

  const [tableId, setTableId] = useState<number>(
    editingRule?.table_id ?? defaultTableId ?? (tables[0]?.id ?? 0)
  );
  const [dimension, setDimension] = useState<QualityDimension>(editingRule?.dimension ?? 'completeness');
  const [ruleType, setRuleType] = useState<string>(editingRule?.rule_type ?? 'not_null');
  const [columnName, setColumnName] = useState<string>(editingRule?.column_name ?? '');
  const [name, setName] = useState<string>(editingRule?.name ?? '');
  const [severity, setSeverity] = useState<QualitySeverity>(editingRule?.severity ?? 'warning');
  const [enabled, setEnabled] = useState<boolean>(editingRule?.enabled ?? true);
  const [config, setConfig] = useState<QualityRuleConfig>(editingRule?.config ?? {});

  const createMutation = useCreateQualityRule(datasetId);
  const updateMutation = useUpdateQualityRule(datasetId);

  const dimDef = dimMeta(dimension);
  const rtDef = dimDef.ruleTypes.find((r) => r.value === ruleType);

  useEffect(() => {
    if (!isEdit) {
      const tableName = tables.find((t) => t.id === tableId)?.display_name ?? '';
      const rtLabel = dimDef.ruleTypes.find((r) => r.value === ruleType)?.label ?? ruleType;
      const col = columnName.trim();
      setName(col ? `${tableName}: ${col} — ${rtLabel}` : `${tableName} — ${rtLabel}`);
    }
  }, [tableId, dimension, ruleType, columnName, isEdit, tables, dimDef]);

  function patchConfig(partial: Partial<QualityRuleConfig>) {
    setConfig((prev) => ({ ...prev, ...partial }));
  }

  const columnOptions: string[] = useMemo(() => {
    const selectedTable = tables.find((t) => t.id === tableId);
    if (!selectedTable?.columns_cache) return [];
    const cache = selectedTable.columns_cache as Record<string, any>;
    const cols = cache.columns as { name: string }[] | undefined;
    return cols?.map((c) => c.name) ?? [];
  }, [tables, tableId]);

  async function handleSave() {
    if (!tables.find((t) => t.id === tableId)) { toast.error('Select a table'); return; }
    if (!name.trim()) { toast.error('Rule name is required'); return; }

    try {
      if (isEdit) {
        await updateMutation.mutateAsync({
          ruleId: editingRule!.id,
          body: { column_name: columnName || undefined, dimension, rule_type: ruleType, name: name.trim(), config, severity, enabled },
        });
        toast.success('Rule updated');
      } else {
        await createMutation.mutateAsync({
          table_id: tableId, column_name: columnName || undefined, dimension, rule_type: ruleType,
          name: name.trim(), config, severity, enabled,
        });
        toast.success('Rule created');
      }
      onSaved();
    } catch {
      toast.error('Failed to save rule');
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="flex h-full flex-col bg-white border-l border-gray-200 w-[22rem] shrink-0">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-800">{isEdit ? 'Edit Rule' : 'New Rule'}</h3>
        <button onClick={onClose} className="rounded p-1 hover:bg-gray-100">
          <X className="h-4 w-4 text-gray-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Table */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Table</label>
          <select value={tableId} onChange={(e) => setTableId(Number(e.target.value))} disabled={isEdit}
            className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none disabled:bg-gray-50">
            {tables.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
          </select>
        </div>

        {/* Dimension */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">DQ Dimension</label>
          <div className="grid grid-cols-3 gap-1.5">
            {DQ_DIMENSIONS.map((d) => (
              <button key={d.key}
                onClick={() => { setDimension(d.key); setRuleType(d.ruleTypes[0].value); setConfig({}); }}
                className={`rounded border px-2 py-1.5 text-xs font-medium transition-colors ${
                  dimension === d.key
                    ? `${d.bgColor} ${d.textColor} border-current`
                    : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                }`}>
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {/* Rule type */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Rule Type</label>
          <select value={ruleType} onChange={(e) => { setRuleType(e.target.value); setConfig({}); }}
            className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
            {dimDef.ruleTypes.map((rt) => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
          </select>
        </div>

        {/* Column name */}
        {rtDef?.level !== 'table' && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Column <span className="text-gray-400">(leave empty for table-level)</span>
            </label>
            {columnOptions.length > 0 ? (
              <select value={columnName} onChange={(e) => setColumnName(e.target.value)}
                className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
                <option value="">— select column —</option>
                {columnOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <input type="text" value={columnName} onChange={(e) => setColumnName(e.target.value)}
                placeholder="column_name"
                className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
            )}
          </div>
        )}

        {/* Dynamic config */}
        <ConfigFields ruleType={ruleType} config={config} onPatch={patchConfig} />

        {/* Rule name */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Rule Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </div>

        {/* Severity */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Severity</label>
          <div className="flex gap-2">
            {(['info', 'warning', 'error'] as const).map((s) => {
              const meta = SEVERITY_META[s];
              const Icon = meta.icon;
              return (
                <button key={s} onClick={() => setSeverity(s)}
                  className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
                    severity === s ? 'border-gray-400 bg-gray-100' : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}>
                  <Icon className={`h-3.5 w-3.5 ${meta.color}`} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Enabled */}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300" />
          <span className="text-gray-700">Enabled</span>
        </label>
      </div>

      <div className="shrink-0 border-t border-gray-200 px-4 py-3 flex justify-end gap-2">
        <button onClick={onClose}
          className="rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
        <button onClick={handleSave} disabled={isPending}
          className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isEdit ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run history row
// ---------------------------------------------------------------------------

function RunHistoryRow({ run, rules }: { run: QualityRun; rules: QualityRule[] }) {
  const [expanded, setExpanded] = useState(false);
  const ruleMap = Object.fromEntries(rules.map((r) => [r.id, r]));
  const passedCount = run.results
    ? Object.values(run.results).filter((r) => r.passed && !r.skipped).length
    : null;
  const total = rules.filter((r) => r.enabled).length;

  return (
    <div className="border-b border-gray-100 last:border-0">
      <button onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50">
        <RunStatusIcon status={run.status} />
        <span className="flex-1 text-xs text-gray-700">
          Run #{run.id}
          {run.created_at && (
            <span className="ml-2 text-gray-400">{new Date(run.created_at).toLocaleString()}</span>
          )}
        </span>
        {run.score != null && <ScoreBadge score={run.score} />}
        {passedCount != null && <span className="text-xs text-gray-500">{passedCount}/{total} passed</span>}
        <ChevronRight className={`h-3.5 w-3.5 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && run.results && (
        <div className="bg-gray-50 px-4 py-2 space-y-1">
          {run.error_message && <p className="text-xs text-red-500">{run.error_message}</p>}
          {Object.entries(run.results).map(([ruleIdStr, res]) => {
            const rule = ruleMap[Number(ruleIdStr)];
            return (
              <div key={ruleIdStr} className="flex items-center justify-between gap-2">
                <span className="text-xs text-gray-600 truncate">{rule?.name ?? `Rule #${ruleIdStr}`}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {res.rows_failed != null && (
                    <span className="text-xs text-gray-400">{res.rows_failed}/{res.rows_checked}</span>
                  )}
                  <RuleResultBadge result={res} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface DatasetQualityPanelProps {
  datasetId: number;
  tables: DatasetTable[];
  canEdit: boolean;
}

export function DatasetQualityPanel({ datasetId, tables, canEdit }: DatasetQualityPanelProps) {
  const [selectedTableId, setSelectedTableId] = useState<number | null>(
    tables.length > 0 ? tables[0].id : null
  );
  const [dimFilter, setDimFilter] = useState<QualityDimension | 'all'>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<QualityRule | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [pollingRunId, setPollingRunId] = useState<number | null>(null);

  const { data: summary } = useQualitySummary(datasetId);
  const { data: allRules = [], refetch: refetchRules } = useQualityRules(datasetId);
  const { data: runs = [], refetch: refetchRuns } = useQualityRuns(datasetId);
  const triggerRun = useTriggerQualityRun(datasetId);
  const deleteRule = useDeleteQualityRule(datasetId);

  const { data: pollingRun } = useQualityRunPoll(datasetId, pollingRunId, pollingRunId !== null);

  useEffect(() => {
    if (pollingRun && (pollingRun.status === 'completed' || pollingRun.status === 'failed')) {
      setPollingRunId(null);
      refetchRules();
      refetchRuns();
      if (pollingRun.status === 'completed') {
        toast.success(`Quality run complete — score: ${pollingRun.score?.toFixed(0) ?? '?'}%`);
      } else {
        toast.error('Quality run failed');
      }
    }
  }, [pollingRun, refetchRules, refetchRuns]);

  const isRunning = pollingRunId !== null || runs[0]?.status === 'running' || runs[0]?.status === 'queued';

  async function handleRunNow() {
    try {
      const res = await triggerRun.mutateAsync();
      setPollingRunId(res.run_id);
      setShowRuns(true);
      toast.info('Quality check started…');
    } catch {
      toast.error('Failed to start quality run');
    }
  }

  async function handleDeleteRule(rule: QualityRule) {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await deleteRule.mutateAsync(rule.id);
      toast.success('Rule deleted');
    } catch {
      toast.error('Failed to delete rule');
    }
  }

  const filteredRules = useMemo(() => allRules.filter((r) => {
    if (selectedTableId !== null && r.table_id !== selectedTableId) return false;
    if (dimFilter !== 'all' && r.dimension !== dimFilter) return false;
    return true;
  }), [allRules, selectedTableId, dimFilter]);

  const groupedByDimension = useMemo(() => {
    const map: Partial<Record<QualityDimension, QualityRule[]>> = {};
    for (const rule of filteredRules) {
      if (!map[rule.dimension]) map[rule.dimension] = [];
      map[rule.dimension]!.push(rule);
    }
    return map;
  }, [filteredRules]);

  const latestCompletedRun = runs.find((r) => r.status === 'completed') ?? null;

  const runResultsMap: Record<number, any> = useMemo(() => {
    if (!latestCompletedRun?.results) return {};
    return Object.fromEntries(
      Object.entries(latestCompletedRun.results).map(([k, v]) => [Number(k), v])
    );
  }, [latestCompletedRun]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Left sidebar */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-gray-200 bg-gray-50 overflow-hidden">
        {/* Score */}
        <div className="border-b border-gray-200 px-3 py-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Quality Score</span>
            {summary?.score != null ? (
              <ScoreBadge score={summary.score} />
            ) : (
              <span className="text-xs text-gray-400">No run yet</span>
            )}
          </div>
          {summary && (
            <p className="text-[11px] text-gray-500">
              {summary.enabled_rules} rules · {summary.covered_tables} tables
            </p>
          )}
        </div>

        {/* Run now */}
        {canEdit && (
          <div className="border-b border-gray-200 px-3 py-2 space-y-1">
            <button onClick={handleRunNow} disabled={isRunning || triggerRun.isPending}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {isRunning
                ? <><Loader2 className="h-3 w-3 animate-spin" /> Running…</>
                : <><Play className="h-3 w-3" /> Run Now</>}
            </button>
            <button onClick={() => setShowRuns(!showRuns)}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600 hover:bg-gray-50">
              <Activity className="h-3 w-3" /> Run History
            </button>
          </div>
        )}

        {/* Tables */}
        <div className="flex-1 overflow-y-auto py-1">
          <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Tables</p>
          <button onClick={() => setSelectedTableId(null)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
              selectedTableId === null ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
            }`}>
            <Database className="h-3.5 w-3.5 shrink-0" />
            All tables
            <span className="ml-auto text-[10px] text-gray-400">{allRules.length}</span>
          </button>
          {tables.map((t) => {
            const count = allRules.filter((r) => r.table_id === t.id).length;
            return (
              <button key={t.id} onClick={() => setSelectedTableId(t.id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  selectedTableId === t.id ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                }`}>
                <Database className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="truncate">{t.display_name}</span>
                {count > 0 && <span className="ml-auto text-[10px] text-gray-400">{count}</span>}
              </button>
            );
          })}

          {/* Dimension filter */}
          <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Dimension</p>
          <button onClick={() => setDimFilter('all')}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
              dimFilter === 'all' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
            }`}>
            <Filter className="h-3.5 w-3.5 shrink-0" /> All
          </button>
          {DQ_DIMENSIONS.map((d) => {
            const count = allRules.filter((r) =>
              (selectedTableId === null || r.table_id === selectedTableId) && r.dimension === d.key
            ).length;
            return (
              <button key={d.key} onClick={() => setDimFilter(d.key)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  dimFilter === d.key ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                }`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${d.dotColor}`} />
                {d.label}
                {count > 0 && <span className="ml-auto text-[10px] text-gray-400">{count}</span>}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Center — rules */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-2.5">
          <ShieldCheck className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">
            {selectedTableId !== null
              ? tables.find((t) => t.id === selectedTableId)?.display_name ?? 'Table'
              : 'All Tables'}{' '}
            — Quality Rules
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
            {filteredRules.length}
          </span>
          {canEdit && (
            <button onClick={() => { setEditingRule(null); setEditorOpen(true); }}
              className="ml-auto inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
              <Plus className="h-3.5 w-3.5" /> Add Rule
            </button>
          )}
        </div>

        {/* Run history */}
        {showRuns && (
          <div className="shrink-0 border-b border-gray-200 bg-white">
            <div className="flex items-center justify-between px-4 py-2">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Run History</span>
              <button onClick={() => setShowRuns(false)}><X className="h-3.5 w-3.5 text-gray-400" /></button>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {runs.length === 0 ? (
                <p className="px-4 py-3 text-xs text-gray-400">No runs yet.</p>
              ) : (
                runs.map((run) => <RunHistoryRow key={run.id} run={run} rules={allRules} />)
              )}
            </div>
          </div>
        )}

        {/* Rules list */}
        <div className="flex-1 overflow-y-auto">
          {filteredRules.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <ShieldCheck className="h-10 w-10 text-gray-200" />
              <p className="text-sm text-gray-400">No rules defined yet</p>
              {canEdit && (
                <button onClick={() => { setEditingRule(null); setEditorOpen(true); }}
                  className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  <Plus className="h-4 w-4" /> Add first rule
                </button>
              )}
            </div>
          ) : (
            DQ_DIMENSIONS.filter((d) => groupedByDimension[d.key]).map((d) => {
              const dimRules = groupedByDimension[d.key]!;
              return (
                <div key={d.key} className="border-b border-gray-100 last:border-0">
                  {/* Dimension header */}
                  <div className={`flex items-center gap-2 px-4 py-2 ${d.bgColor}`}>
                    <span className={`h-2 w-2 rounded-full ${d.dotColor}`} />
                    <span className={`text-xs font-semibold uppercase tracking-wide ${d.textColor}`}>{d.label}</span>
                    <span className={`text-xs ${d.textColor} opacity-60`}>— {d.description}</span>
                    <span className={`ml-auto text-xs font-medium ${d.textColor}`}>
                      {dimRules.length} rule{dimRules.length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Rules */}
                  {dimRules.map((rule) => {
                    const result = runResultsMap[rule.id];
                    const SevIcon = SEVERITY_META[rule.severity as QualitySeverity]?.icon ?? Circle;
                    const tableName = tables.find((t) => t.id === rule.table_id)?.display_name ?? '';

                    return (
                      <div key={rule.id}
                        className={`flex items-center gap-3 border-b border-gray-50 px-4 py-2.5 last:border-0 hover:bg-gray-50 ${!rule.enabled ? 'opacity-50' : ''}`}>
                        <SevIcon className={`h-3.5 w-3.5 shrink-0 ${SEVERITY_META[rule.severity as QualitySeverity]?.color ?? 'text-gray-400'}`} />

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-gray-800">{rule.name}</p>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                            <span>{tableName}</span>
                            {rule.column_name && (
                              <>
                                <ChevronRight className="h-2.5 w-2.5" />
                                <span className="font-mono">{rule.column_name}</span>
                              </>
                            )}
                            <span className="rounded bg-gray-100 px-1.5 py-0.5">{rule.rule_type}</span>
                          </div>
                        </div>

                        <div className="shrink-0">
                          <RuleResultBadge result={result} />
                        </div>

                        {canEdit && (
                          <div className="flex shrink-0 gap-1">
                            <button onClick={() => { setEditingRule(rule); setEditorOpen(true); }}
                              className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600" title="Edit">
                              <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => handleDeleteRule(rule)}
                              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500" title="Delete">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel — rule editor */}
      {editorOpen && canEdit && (
        <RuleEditor
          datasetId={datasetId}
          tables={tables}
          editingRule={editingRule}
          defaultTableId={selectedTableId ?? undefined}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); refetchRules(); }}
        />
      )}
    </div>
  );
}
