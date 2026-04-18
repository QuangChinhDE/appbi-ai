'use client';

/**
 * DatasetQualityPanel — Setup-first Quality Monitor
 * ==================================================
 * Layout: toolbar (table dropdown + dimension chips + Run Now + Add Rule)
 *         → dimension groups (collapsible) → rule rows (inline toggle/edit/delete/duplicate)
 *         → wide Rule Editor modal with inline setup guidance
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
  Eye,
  Filter,
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
import { toast } from '@/lib/toast';
import { HelpTooltip } from '@/components/ui/HelpTooltip';

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
    color: 'text-brand',
    bg: 'bg-brand/10',
    border: 'border-brand/30',
    dot: 'bg-brand',
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
    color: 'text-brand',
    bg: 'bg-brand/10',
    border: 'border-brand/30',
    dot: 'bg-brand',
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
    color: 'text-success',
    bg: 'bg-success/10',
    border: 'border-success/30',
    dot: 'bg-success',
    ruleTypes: [
      { value: 'unique_column', label: 'Unique Column', level: 'column', hint: 'Fails if any duplicate values exist in this column' },
      { value: 'unique_combo', label: 'Unique Combination', level: 'table', hint: 'Fails if any combination of the specified columns is duplicated' },
    ],
  },
  {
    key: 'consistency',
    label: 'Consistency',
    description: 'Values are logically consistent across columns',
    color: 'text-warning',
    bg: 'bg-warning/10',
    border: 'border-warning/30',
    dot: 'bg-warning',
    ruleTypes: [
      { value: 'cross_column', label: 'Same-table SQL Expression', level: 'table', hint: 'Write a SQL boolean expression (TRUE = valid row). Can reference multiple columns in the selected table.' },
      { value: 'cross_table', label: 'Cross-table Join Expression', level: 'table', hint: 'Join the selected table to another table, then evaluate a SQL boolean expression using aliases src and ref.' },
    ],
  },
  {
    key: 'timeliness',
    label: 'Timeliness',
    description: 'Data is up-to-date within expected freshness window',
    color: 'text-warning',
    bg: 'bg-warning/10',
    border: 'border-warning/30',
    dot: 'bg-warning',
    ruleTypes: [
      { value: 'freshness_days', label: 'Freshness (max age in days)', level: 'table', hint: 'Fails if MAX(date_col) is older than the specified number of days' },
    ],
  },
  {
    key: 'accuracy',
    label: 'Accuracy',
    description: 'Data reflects expected volume and statistical distribution',
    color: 'text-danger',
    bg: 'bg-danger/10',
    border: 'border-danger/30',
    dot: 'bg-danger',
    ruleTypes: [
      { value: 'row_count_range', label: 'Row Count Range [min, max]', level: 'table', hint: 'Fails if total row count is outside the specified range' },
      { value: 'statistical_range', label: 'Statistical Z-score Range', level: 'column', hint: 'Fails if values are outside mean ± z·stddev (outlier detection)' },
    ],
  },
];

const SEVERITY_META: Record<QualitySeverity, { label: string; textColor: string; bgColor: string; icon: React.ElementType }> = {
  info:    { label: 'Info',    textColor: 'text-brand',  bgColor: 'bg-brand/10',  icon: Info },
  warning: { label: 'Warning', textColor: 'text-warning', bgColor: 'bg-warning/10', icon: AlertTriangle },
  error:   { label: 'Error',   textColor: 'text-danger',   bgColor: 'bg-danger/10',   icon: XCircle },
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

type RuleTypeDefinition = (typeof DQ_DIMENSIONS)[number]['ruleTypes'][number];

function getRuleTypeDef(dimension: QualityDimension, ruleType: string): RuleTypeDefinition | undefined {
  return dimDef(dimension).ruleTypes.find((r) => r.value === ruleType);
}

function ruleUsesColumn(ruleTypeDef?: RuleTypeDefinition): boolean {
  return ruleTypeDef?.level !== 'table';
}

function buildSuggestedRuleName(
  tables: DatasetTable[],
  tableId: number,
  ruleTypeDef: RuleTypeDefinition | undefined,
  ruleType: string,
  columnName: string,
) {
  const table = tables.find((t) => t.id === tableId);
  const tableName = table?.display_name ?? table?.source_table_name ?? '';
  const ruleLabel = ruleTypeDef?.label ?? ruleType;
  const normalizedColumn = columnName.trim();
  return normalizedColumn
    ? `${tableName}: ${normalizedColumn} - ${ruleLabel}`
    : `${tableName} - ${ruleLabel}`;
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function RuleResultPill({ result }: {
  result?: { passed?: boolean; skipped?: boolean; error?: boolean; rows_failed?: number | null; rows_checked?: number | null; detail?: string | null } | null;
}) {
  if (!result) return null;
  if (result.skipped)
    return <span title={result.detail ?? undefined} className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-tertiary cursor-help">skipped</span>;
  if (result.error)
    return <span title={result.detail ?? 'Execution error'} className="inline-flex items-center gap-0.5 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger cursor-help"><XCircle className="h-3 w-3" />error</span>;
  if (result.passed)
    return <span title={result.detail ?? 'All rows passed'} className="inline-flex items-center gap-0.5 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success cursor-help"><CheckCircle2 className="h-3 w-3" />pass</span>;
  const detail = result.rows_failed != null ? `${result.rows_failed} fail` : 'fail';
  return <span title={result.detail ?? undefined} className="inline-flex items-center gap-0.5 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger cursor-help"><XCircle className="h-3 w-3" />{detail}</span>;
}

function InlineToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`flex items-center transition-colors disabled:opacity-40 ${checked ? 'text-brand' : 'text-text-quaternary'}`}
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
      <div className="flex flex-wrap gap-1 rounded border border-[rgb(var(--border-line))] p-1.5 focus-within:border-brand/50">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-0.5 rounded bg-brand/10 px-2 py-0.5 text-xs text-brand">
            {v}
            <button onClick={() => onChange(values.filter((x) => x !== v))} className="hover:text-brand"><X className="h-2.5 w-2.5" /></button>
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
          className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-text-quaternary"
        />
      </div>
      {showSug && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-40 w-full overflow-y-auto rounded border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          {filtered.map((s) => (
            <button key={s} onMouseDown={() => add(s)} className="flex w-full items-center px-3 py-1.5 text-xs hover:bg-brand/15 text-text-secondary">
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

function FieldLabel({ label, helpText, action }: {
  label: string;
  helpText?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center text-xs font-medium text-text-secondary">
        <span>{label}</span>
        {helpText && <HelpTooltip text={helpText} />}
      </div>
      {action}
    </div>
  );
}

function EditorSection({ title, description, children, className = '' }: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-sm ${className}`.trim()}>
      <div className="mb-4">
        <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
        <p className="mt-1 text-xs leading-5 text-text-tertiary">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ColumnSelector({ tableId, tables, value, onChange, placeholder, label, helpText }: {
  tableId: number;
  tables: DatasetTable[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  helpText?: string;
}) {
  const options = getColumnOptions(tables, tableId);
  return (
    <div>
      {label && <FieldLabel label={label} helpText={helpText} />}
      {options.length > 0 ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none"
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
          className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none"
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
  const selectedTable = tables.find((table) => table.id === tableId);
  const secondaryTableId = typeof config.secondary_table_id === 'number' ? config.secondary_table_id : undefined;
  const secondaryTable = tables.find((table) => table.id === secondaryTableId);

  switch (ruleType) {
    case 'completeness_pct':
      return (
        <div>
          <FieldLabel
            label="Minimum completeness %"
            helpText="Set the lowest allowed percentage of non-null rows. The rule fails when completeness drops below this threshold."
          />
          <div className="flex items-center gap-2">
            <input type="number" min={0} max={100} step={1}
              value={config.threshold ?? ''}
              onChange={(e) => onPatch({ threshold: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="95"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
            <span className="text-sm text-text-tertiary shrink-0">%</span>
          </div>
        </div>
      );

    case 'accepted_values':
      return (
        <div>
          <FieldLabel
            label="Allowed values"
            helpText="Add every value that is permitted for this column. Any other non-null value fails the check."
            action={<span className="text-[11px] font-normal text-text-quaternary">Enter or comma to add</span>}
          />
          <TagInput values={config.values ?? []} onChange={(values) => onPatch({ values })} placeholder="Add value and press Enter…" />
        </div>
      );

    case 'pattern_match':
      return (
        <div className="space-y-2">
          <div>
            <FieldLabel
              label="Regex pattern"
              helpText="Use a datasource-compatible regular expression. Every non-null value in the selected column must match it."
            />
            <input type="text"
              value={config.pattern ?? ''}
              onChange={(e) => onPatch({ pattern: e.target.value || undefined })}
              placeholder="^[A-Z]{2}[0-9]+$"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div>
            <FieldLabel
              label="Flags"
              helpText="Optional regex flags supported by your datasource, such as i for case-insensitive matching."
              action={<span className="text-[11px] font-normal text-text-quaternary">Optional</span>}
            />
            <input type="text"
              value={(config as any).flags ?? ''}
              onChange={(e) => onPatch({ flags: e.target.value || undefined } as any)}
              placeholder="i"
              className="w-24 rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-sm focus:border-brand/50 focus:outline-none" />
          </div>
        </div>
      );

    case 'range_check':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <FieldLabel
              label="Min"
              helpText="Inclusive lower bound for valid values. Leave blank if only a maximum matters."
            />
            <input type="text" value={config.min ?? ''}
              onChange={(e) => onPatch({ min: e.target.value || undefined })}
              placeholder="0"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div className="flex-1">
            <FieldLabel
              label="Max"
              helpText="Inclusive upper bound for valid values. Leave blank if only a minimum matters."
            />
            <input type="text" value={config.max ?? ''}
              onChange={(e) => onPatch({ max: e.target.value || undefined })}
              placeholder="1000"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
        </div>
      );

    case 'format_check':
      return (
        <div>
          <FieldLabel
            label="Format type"
            helpText="Choose a built-in validator such as email, phone, URL, or date."
          />
          <select value={config.format ?? ''}
            onChange={(e) => onPatch({ format: (e.target.value || undefined) as QualityFormat | undefined })}
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none">
            <option value="">— select format —</option>
            {FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
      );

    case 'unique_combo':
      return (
        <div>
          <FieldLabel
            label="Columns for unique combination"
            helpText="Add the columns whose combined values must be unique across the table."
          />
          <TagInput
            values={config.columns ?? []}
            onChange={(columns) => onPatch({ columns })}
            placeholder="Add column and press Enter…"
            suggestions={colOptions}
          />
          <p className="mt-1 text-[11px] text-text-quaternary">Fails if any combination of these columns is duplicated.</p>
        </div>
      );

    case 'cross_column':
      return (
        <div>
          <FieldLabel
            label="SQL boolean expression"
            helpText="Write a SQL condition that returns TRUE for valid rows and FALSE for failing rows."
          />
          <textarea rows={3}
            value={config.expression ?? ''}
            onChange={(e) => onPatch({ expression: e.target.value || undefined })}
            placeholder={'end_date >= start_date\namount > 0 AND status != \'void\''}
            className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-xs focus:border-brand/50 focus:outline-none resize-none" />
          <p className="mt-1 text-[11px] text-text-quaternary">
            Can reference any column in the selected table only. Use standard SQL operators.
          </p>
        </div>
      );

    case 'cross_table':
      return (
        <div className="space-y-3">
          <div>
            <FieldLabel
              label="Related table"
              helpText="Choose the second table that this rule should compare against."
            />
            <select
              value={secondaryTableId ?? ''}
              onChange={(e) => onPatch({ secondary_table_id: e.target.value ? Number(e.target.value) : undefined })}
              className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none"
            >
              <option value="">— select related table —</option>
              {tables.map((table) => (
                <option key={table.id} value={table.id}>{table.display_name || table.source_table_name}</option>
              ))}
            </select>
          </div>

          <div>
            <FieldLabel
              label="Join condition"
              helpText="Join the current table as src to the related table as ref. Write the condition exactly as it should appear in SQL."
            />
            <textarea rows={2}
              value={config.join_condition ?? ''}
              onChange={(e) => onPatch({ join_condition: e.target.value || undefined })}
              placeholder={'src.customer_id = ref.customer_id'}
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-xs focus:border-brand/50 focus:outline-none resize-none" />
          </div>

          <div>
            <FieldLabel
              label="SQL boolean expression"
              helpText="Write the validation condition that runs after the join. TRUE means the joined row is valid."
            />
            <textarea rows={3}
              value={config.expression ?? ''}
              onChange={(e) => onPatch({ expression: e.target.value || undefined })}
              placeholder={'ref.customer_id IS NOT NULL\nsrc.order_total <= ref.credit_limit'}
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-xs focus:border-brand/50 focus:outline-none resize-none" />
            <p className="mt-1 text-[11px] text-text-quaternary">
              Use a join that preserves the grain you want to validate. Current aliases: src = {selectedTable?.display_name || selectedTable?.source_table_name || 'selected table'}, ref = {secondaryTable?.display_name || secondaryTable?.source_table_name || 'related table'}.
            </p>
          </div>
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
            helpText="Choose the date or timestamp column that represents the latest update time for this table."
            placeholder="updated_at"
          />
          <div>
            <FieldLabel
              label="Max age (days)"
              helpText="Maximum allowed age between the newest value in the selected column and the current time."
            />
            <input type="number" min={1} step={1}
              value={config.max_days ?? ''}
              onChange={(e) => onPatch({ max_days: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="1"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
        </div>
      );

    case 'row_count_range':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <FieldLabel
              label="Min rows"
              helpText="Minimum acceptable number of rows in the table for the run to pass."
            />
            <input type="number" min={0} step={1}
              value={config.min ?? ''}
              onChange={(e) => onPatch({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="1"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div className="flex-1">
            <FieldLabel
              label="Max rows"
              helpText="Maximum acceptable row count. Leave blank if the table only needs a minimum volume check."
            />
            <input type="number" min={0} step={1}
              value={config.max ?? ''}
              onChange={(e) => onPatch({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="10000000"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
        </div>
      );

    case 'statistical_range':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <FieldLabel
              label="Min Z-score"
              helpText="Lower expected z-score bound for the selected metric. Values below this threshold fail."
            />
            <input type="number" step={0.1}
              value={config.min_z ?? ''}
              onChange={(e) => onPatch({ min_z: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="-3"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div className="flex-1">
            <FieldLabel
              label="Max Z-score"
              helpText="Upper expected z-score bound for the selected metric. Values above this threshold fail."
            />
            <input type="number" step={0.1}
              value={config.max_z ?? ''}
              onChange={(e) => onPatch({ max_z: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="3"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
        </div>
      );

    default:
      return (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 px-3 py-3 text-xs leading-5 text-text-tertiary">
          This rule type does not need extra parameters. Review the scope and governance settings, then save it.
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Rule Editor Modal
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
  const rtDef   = getRuleTypeDef(dimension, ruleType);
  const usesColumn = ruleUsesColumn(rtDef);
  const suggestedName = useMemo(
    () => buildSuggestedRuleName(tables, tableId, rtDef, ruleType, columnName),
    [tables, tableId, rtDef, ruleType, columnName],
  );

  // Seed the name once; further changes use the explicit "Use suggested" action.
  useEffect(() => {
    if (nameEdited || name.trim()) return;
    setName(suggestedName);
  }, [name, nameEdited, suggestedName]);

  function patchConfig(partial: Partial<QualityRuleConfig>) {
    setConfig((prev) => ({ ...prev, ...partial }));
  }

  function switchDimension(d: QualityDimension) {
    const firstType = DQ_DIMENSIONS.find((x) => x.key === d)!.ruleTypes[0].value;
    const nextRuleDef = getRuleTypeDef(d, firstType);
    setDimension(d);
    setRuleType(firstType);
    setConfig({});
    if (!ruleUsesColumn(nextRuleDef)) setColumnName('');
  }

  function switchRuleType(rt: string) {
    const nextRuleDef = getRuleTypeDef(dimension, rt);
    setRuleType(rt);
    setConfig({});
    if (!ruleUsesColumn(nextRuleDef)) setColumnName('');
  }

  async function handleSave() {
    if (!tables.find((t) => t.id === tableId)) { toast.error('Select a table'); return; }
    if (!name.trim()) { toast.error('Rule name is required'); return; }
    const nextColumnName = usesColumn ? columnName.trim() || undefined : undefined;
    try {
      let saved: QualityRule;
      if (isEdit) {
        saved = await updateMutation.mutateAsync({
          ruleId: editingRule!.id,
          body: { column_name: nextColumnName, dimension, rule_type: ruleType, name: name.trim(), config, severity, enabled },
        });
        toast.success('Rule updated');
      } else {
        saved = await createMutation.mutateAsync({
          table_id: tableId, column_name: nextColumnName, dimension, rule_type: ruleType,
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
  const selectedTable = tables.find((table) => table.id === tableId);
  const selectedTableLabel = selectedTable?.display_name
    || selectedTable?.source_table_name
    || 'No table selected';
  const severityMeta = SEVERITY_META[severity];
  const previewCards = [
    { label: 'Table', value: selectedTableLabel },
    { label: 'Dimension', value: dimDef_.label },
    { label: 'Rule type', value: rtDef?.label ?? ruleType },
    { label: 'Scope', value: usesColumn ? (columnName.trim() ? `Column: ${columnName}` : 'Column-level rule') : 'Table-level rule' },
  ];
  const setupTips = [
    'Hover the info icon next to any field to see what the rule checks and how to configure it.',
    usesColumn
      ? 'Pick a column before saving so the rule runs against the correct field in the selected table.'
      : 'This rule evaluates table-level behavior, so you can leave the column selector empty.',
    ruleType === 'cross_table'
      ? 'Use src for the current table and ref for the related table in both the join and validation expressions.'
      : 'Keep the suggested name until the rule logic is final, then rename it with business language if needed.',
  ];

  return (
    <>
      <div className="fixed inset-0 z-30 bg-overlay/84 backdrop-blur-[2px]" onClick={onClose} />

      <div className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-5 lg:p-8">
        <div className="flex h-full max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-[28px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[rgb(var(--border-line))] px-5 py-4 sm:px-6">
            <div className="min-w-0 space-y-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">Quality rule setup</p>
                <h3 className="mt-1 text-lg font-semibold text-text-primary">{isEdit ? 'Edit Quality Rule' : 'Create Quality Rule'}</h3>
                <p className="mt-1 text-sm text-text-tertiary">
                  {isEdit
                    ? `Rule #${editingRule!.id} · update the rule without losing its run history.`
                    : 'Set the scope, logic, and severity for a source-backed data quality check.'}
                </p>
              </div>
              <div className="inline-flex max-w-2xl items-start gap-2 rounded-2xl border border-brand/20 bg-brand/10 px-3 py-2.5 text-sm text-brand">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Hover the info icon next to any field to see what it checks and how to configure it.</p>
              </div>
            </div>
            <button onClick={onClose} className="rounded-xl p-2 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-secondary">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div className="space-y-5">
                <EditorSection title="Basic setup" description="Choose the table, quality objective, and check style before defining the detailed rule logic.">
                  <div className="space-y-4">
                    <div>
                      <FieldLabel
                        label="Table"
                        helpText="Pick the table this rule should validate. In edit mode the table stays locked so previous runs remain consistent."
                      />
                      <select value={tableId} onChange={(e) => { setTableId(Number(e.target.value)); setColumnName(''); }} disabled={isEdit}
                        className="w-full rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-sm focus:border-brand/50 focus:outline-none disabled:bg-surface-2 disabled:text-text-quaternary">
                        {tables.map((t) => <option key={t.id} value={t.id}>{t.display_name || t.source_table_name}</option>)}
                      </select>
                    </div>

                    <div>
                      <FieldLabel
                        label="DQ Dimension"
                        helpText="Choose the quality area first. It controls which rule types are available and keeps setup focused on the right objective."
                      />
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {DQ_DIMENSIONS.map((d) => (
                          <button key={d.key}
                            onClick={() => switchDimension(d.key)}
                            className={`rounded-2xl border px-3 py-3 text-left transition-colors ${
                              dimension === d.key
                                ? `${d.bg} ${d.color} ${d.border}`
                                : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                            }`}>
                            <span className="block text-sm font-semibold">{d.label}</span>
                            <span className="mt-1 block text-[11px] leading-4 opacity-80">{d.description}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <FieldLabel
                        label="Rule Type"
                        helpText="Pick the exact validation to run for the selected dimension. The helper text below explains what counts as a failure."
                      />
                      <select value={ruleType} onChange={(e) => switchRuleType(e.target.value)}
                        className="w-full rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-sm focus:border-brand/50 focus:outline-none">
                        {dimDef_.ruleTypes.map((rt) => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
                      </select>
                      {rtDef?.hint && (
                        <div className="mt-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs leading-5 text-text-secondary">
                          {rtDef.hint}
                        </div>
                      )}
                    </div>
                  </div>
                </EditorSection>

                <EditorSection title="Rule logic" description="Define the exact scope and parameters that decide whether rows pass or fail.">
                  <div className="space-y-4 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2/70 p-4">
                    {usesColumn && (
                      <ColumnSelector
                        tableId={tableId} tables={tables}
                        value={columnName}
                        onChange={setColumnName}
                        label={rtDef?.level === 'both' ? 'Column (optional)' : 'Column'}
                        helpText={rtDef?.level === 'both'
                          ? 'Choose a column when this rule should narrow the check to one field. Leave it empty if the rule should evaluate the whole table.'
                          : 'Choose the column this rule validates inside the selected table.'}
                        placeholder="column_name"
                      />
                    )}

                    <ConfigFields ruleType={ruleType} config={config} onPatch={patchConfig} tableId={tableId} tables={tables} />
                  </div>
                </EditorSection>
              </div>

              <div className="space-y-5">
                <EditorSection title="Governance" description="Set the name, severity, and execution status that users see in summaries and review logs.">
                  <div className="space-y-4">
                    <div>
                      <FieldLabel
                        label="Rule Name"
                        helpText="This name appears in the rule list, quality summaries, and run history. Keep it business-readable."
                        action={name.trim() !== suggestedName ? (
                          <button
                            type="button"
                            onClick={() => { setName(suggestedName); setNameEdited(false); }}
                            className="text-[11px] font-medium text-brand hover:text-brand"
                          >
                            Use suggested
                          </button>
                        ) : undefined}
                      />
                      <input type="text" value={name}
                        onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
                        className="w-full rounded-xl border border-[rgb(var(--border-line))] px-3 py-2 text-sm focus:border-brand/50 focus:outline-none" />
                      {!isEdit && (
                        <p className="mt-2 text-[11px] leading-5 text-text-quaternary">
                          The suggested name follows table, column, and rule type until you rename it.
                        </p>
                      )}
                    </div>

                    <div>
                      <FieldLabel
                        label="Severity"
                        helpText="Use info for light signals, warning for issues to monitor, and error for problems that should strongly reduce trust."
                      />
                      <div className="flex gap-2">
                        {(['info', 'warning', 'error'] as QualitySeverity[]).map((s) => {
                          const meta = SEVERITY_META[s];
                          const Icon = meta.icon;
                          return (
                            <button key={s} onClick={() => setSeverity(s)}
                              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-medium transition-colors ${
                                severity === s
                                  ? `${meta.bgColor} ${meta.textColor} border-current`
                                  : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))]'
                              }`}>
                              <Icon className="h-3.5 w-3.5" />
                              {meta.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-[rgb(var(--border-line))] px-4 py-3">
                      <div>
                        <div className="flex items-center text-sm font-medium text-text-secondary">
                          <span>Enabled</span>
                          <HelpTooltip text="Only enabled rules run during dataset quality checks. Disable a rule when you want to keep its setup but skip execution." />
                        </div>
                        <p className="mt-1 text-xs text-text-quaternary">Disabled rules are skipped during quality runs</p>
                      </div>
                      <InlineToggle checked={enabled} onChange={setEnabled} />
                    </label>
                  </div>
                </EditorSection>

                <EditorSection title="Quick preview" description="Review the scope before saving so the rule reads clearly in the dataset quality workspace.">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {previewCards.map((card) => (
                      <div key={card.label} className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-quaternary">{card.label}</p>
                        <p className="mt-1 text-sm font-medium text-text-primary">{card.value}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 rounded-2xl border border-brand/20 bg-brand/10/80 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-brand">
                      <Info className="h-4 w-4" />
                      Setup guidance
                    </div>
                    <div className="mt-3 space-y-3">
                      {setupTips.map((tip, index) => (
                        <div key={tip} className="flex items-start gap-2 text-sm leading-5 text-brand">
                          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-1 text-[11px] font-semibold text-brand">{index + 1}</span>
                          <p>{tip}</p>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-3 text-sm text-text-secondary">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-text-primary">Selected severity</span>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${severityMeta.bgColor} ${severityMeta.textColor}`}>
                          <severityMeta.icon className="h-3.5 w-3.5" />
                          {severityMeta.label}
                        </span>
                      </div>
                    </div>
                  </div>
                </EditorSection>
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-[rgb(var(--border-line))] px-5 py-4 sm:px-6">
            <div className="flex items-center justify-between gap-2">
          {isEdit && onDuplicate && (
            <button
              onClick={() => onDuplicate(editingRule!)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[rgb(var(--border-line))] px-3 py-2 text-xs text-text-secondary hover:bg-surface-2"
            >
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </button>
          )}
              <div className="ml-auto flex gap-2">
                <button onClick={onClose}
                  className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={isPending}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50">
                  {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {isEdit ? 'Update Rule' : 'Create Rule'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rule Execution Log Modal
// ---------------------------------------------------------------------------

interface RuleLogEntry {
  ruleId: number;
  ruleName: string;
  ruleType: string;
  dimension: string;
  tableName: string;
  columnName?: string | null;
  result: {
    passed?: boolean;
    skipped?: boolean;
    error?: boolean;
    rows_checked?: number | null;
    rows_failed?: number | null;
    detail?: string | null;
    sql?: string | null;
    log?: string[];
    elapsed_ms?: number;
  };
}

function formatMetricCount(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString();
}

function formatMetricPercent(value?: number | null, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

function hasComparableRowCounts(ruleType: string): boolean {
  return [
    'not_null',
    'not_blank',
    'completeness_pct',
    'accepted_values',
    'pattern_match',
    'range_check',
    'format_check',
    'unique_column',
    'cross_column',
    'cross_table',
    'statistical_range',
  ].includes(ruleType);
}

function failureRate(entry: RuleLogEntry): number | null {
  if (!hasComparableRowCounts(entry.ruleType)) return null;
  const checked = entry.result.rows_checked;
  const failed = entry.result.rows_failed;
  if (checked == null || failed == null || checked <= 0) return null;
  return (failed / checked) * 100;
}

function issueThemeLabel(ruleType: string): string {
  switch (ruleType) {
    case 'not_null':
    case 'not_blank':
    case 'completeness_pct':
      return 'missing or incomplete data';
    case 'accepted_values':
    case 'pattern_match':
    case 'range_check':
    case 'format_check':
      return 'invalid values';
    case 'unique_column':
    case 'unique_combo':
      return 'duplicate records';
    case 'cross_column':
    case 'cross_table':
      return 'logic inconsistency';
    case 'freshness_days':
      return 'stale data';
    case 'row_count_range':
      return 'unexpected row volume';
    case 'statistical_range':
      return 'unusual distribution';
    default:
      return 'quality issue';
  }
}

function buildIssueRemark(entry: RuleLogEntry): { summary: string; interpretation: string; followUp: string } {
  const checked = entry.result.rows_checked ?? null;
  const failed = entry.result.rows_failed ?? null;
  const rate = failureRate(entry);
  const issueLabel = issueThemeLabel(entry.ruleType);
  const targetLabel = entry.columnName ? `${entry.tableName}.${entry.columnName}` : entry.tableName;

  if (entry.result.skipped) {
    return {
      summary: entry.result.detail || 'This rule was skipped in the latest run.',
      interpretation: 'The system did not produce a data-quality verdict for this rule, so users should not rely on it yet.',
      followUp: 'Check whether the table source is supported and whether the rule configuration is still valid.',
    };
  }

  if (entry.result.error) {
    const summary = entry.result.detail || 'This rule failed during execution.';
    const interpretation = entry.ruleType === 'cross_table'
      ? 'The cross-table validation could not finish, often because the join condition, datasource alignment, timeout, or scan guard blocked the check.'
      : 'The validation query could not finish, so the issue is currently in rule execution rather than in confirmed data content.';
    const followUp = entry.ruleType === 'cross_table'
      ? 'Review the related table, join condition, and expression first. If they are correct, inspect timeout or datasource limits.'
      : 'Review the rule expression/config and verify the source can execute the check within current limits.';
    return { summary, interpretation, followUp };
  }

  if (entry.result.passed) {
    if (entry.ruleType === 'freshness_days') {
      return {
        summary: 'Data freshness is still within the allowed time window.',
        interpretation: `The latest load for ${targetLabel} is recent enough for this rule.`,
        followUp: 'Keep monitoring the refresh cadence to make sure the current SLA still holds.',
      };
    }

    if (entry.ruleType === 'row_count_range') {
      return {
        summary: checked != null
          ? `Current row volume is within the expected range (${formatMetricCount(checked)} rows).`
          : 'Current row volume is within the expected range.',
        interpretation: `The table size for ${targetLabel} looks stable against the configured expectation.`,
        followUp: 'No immediate action is needed unless the business baseline changes.',
      };
    }

    if (entry.ruleType === 'unique_combo') {
      return {
        summary: 'No duplicate combinations were found for this rule in the latest run.',
        interpretation: `The configured key combination is currently behaving as expected in ${targetLabel}.`,
        followUp: 'Keep monitoring after schema or upstream logic changes.',
      };
    }

    return {
      summary: checked != null
        ? `No violating rows were found in ${formatMetricCount(checked)} checked rows.`
        : 'No violation was found in the latest run.',
      interpretation: `The latest validation suggests ${targetLabel} is currently stable for this rule.`,
      followUp: 'No immediate action is needed beyond normal monitoring.',
    };
  }

  let summary = checked != null && failed != null
    ? `${formatMetricCount(failed)} of ${formatMetricCount(checked)} checked rows are failing because of ${issueLabel}.`
    : entry.result.detail || `The rule is failing because of ${issueLabel}.`;

  if (entry.ruleType === 'freshness_days') {
    summary = 'The latest data is older than the configured freshness window.';
  } else if (entry.ruleType === 'row_count_range') {
    summary = checked != null
      ? `Current row volume (${formatMetricCount(checked)} rows) is outside the configured range.`
      : 'Current row volume is outside the configured range.';
  } else if (entry.ruleType === 'unique_combo') {
    summary = failed != null
      ? `${formatMetricCount(failed)} duplicate rows were found for the configured column combination.`
      : 'Duplicate combinations were found for the configured key columns.';
  }

  let interpretation = `The issue is affecting ${targetLabel}. `;
  if (rate == null) {
    if (entry.ruleType === 'freshness_days') {
      interpretation += 'This is a table-level freshness problem, so users may be reading data that is no longer current enough.';
    } else if (entry.ruleType === 'row_count_range') {
      interpretation += 'This is a table-level volume signal, which usually points to an ingestion, filter, or duplication change upstream.';
    } else if (entry.ruleType === 'unique_combo') {
      interpretation += 'The latest run confirms duplicate business keys are present, which can inflate counts or create repeated records.';
    } else {
      interpretation += 'The exact failure rate is not available, but the latest run confirms the problem is real.';
    }
  } else if (rate < 1) {
    interpretation += 'The impact is still localized, but it can already distort edge cases and manual follow-up.';
  } else if (rate < 5) {
    interpretation += 'The impact is noticeable and can skew filtered views or smaller segments.';
  } else if (rate < 20) {
    interpretation += 'The issue is broad enough to affect operational reporting and downstream analysis.';
  } else {
    interpretation += 'The issue is widespread and can materially reduce trust in this table for reporting.';
  }

  let followUp = 'Review the failing records and trace them back to the upstream source or transformation that produced them.';
  switch (entry.ruleType) {
    case 'not_null':
    case 'not_blank':
    case 'completeness_pct':
      followUp = 'Prioritize why required values are missing, then decide whether the field is optional or the source pipeline is dropping data.';
      break;
    case 'accepted_values':
    case 'pattern_match':
    case 'range_check':
    case 'format_check':
      followUp = 'Compare failing values with the expected business rule and check whether the validation list, format, or source mapping needs correction.';
      break;
    case 'unique_column':
    case 'unique_combo':
      followUp = 'Inspect duplicate keys first, because duplicates often propagate inflated counts and duplicate business events.';
      break;
    case 'cross_column':
    case 'cross_table':
      followUp = 'Review the business logic behind the expression and confirm whether the issue comes from bad source data, a wrong join, or an outdated rule.';
      break;
    case 'freshness_days':
      followUp = 'Check the latest successful ingest/load time and confirm whether the expected refresh cadence is still realistic.';
      break;
    case 'row_count_range':
      followUp = 'Check upstream loads, filters, or deduplication logic because unexpected row volume often signals broken ingestion.';
      break;
    case 'statistical_range':
      followUp = 'Inspect whether these are real outliers or whether recent source changes shifted the distribution.';
      break;
  }

  return { summary, interpretation, followUp };
}

function RuleLogModal({
  entries,
  initialExpandedId,
  onClose,
}: {
  entries: RuleLogEntry[];
  initialExpandedId?: number | null;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'pass' | 'fail' | 'error' | 'skip'>('all');
  const [expandedId, setExpandedId] = useState<number | null>(initialExpandedId ?? null);
  const [searchText, setSearchText] = useState('');

  const filtered = useMemo(() => {
    let list = entries;
    if (filter === 'pass') list = list.filter((e) => e.result.passed && !e.result.skipped);
    else if (filter === 'fail') list = list.filter((e) => !e.result.passed && !e.result.skipped && !e.result.error);
    else if (filter === 'error') list = list.filter((e) => e.result.error);
    else if (filter === 'skip') list = list.filter((e) => e.result.skipped);
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      list = list.filter((e) =>
        e.ruleName.toLowerCase().includes(q) ||
        e.ruleType.toLowerCase().includes(q) ||
        e.dimension.toLowerCase().includes(q) ||
        e.tableName.toLowerCase().includes(q) ||
        (e.columnName || '').toLowerCase().includes(q) ||
        (e.result.detail || '').toLowerCase().includes(q) ||
        (e.result.sql || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [entries, filter, searchText]);

  const counts = useMemo(() => {
    const pass = entries.filter((e) => e.result.passed && !e.result.skipped).length;
    const fail = entries.filter((e) => !e.result.passed && !e.result.skipped && !e.result.error).length;
    const error = entries.filter((e) => e.result.error).length;
    const skip = entries.filter((e) => e.result.skipped).length;
    return { pass, fail, error, skip, all: entries.length };
  }, [entries]);

  const totals = useMemo(() => {
    const checkedRows = entries.reduce((sum, entry) => sum + (entry.result.rows_checked ?? 0), 0);
    const failedRows = entries.reduce((sum, entry) => sum + (entry.result.rows_failed ?? 0), 0);
    const rulesNeedingAttention = counts.fail + counts.error;
    return { checkedRows, failedRows, rulesNeedingAttention };
  }, [entries, counts.fail, counts.error]);

  function statusLabel(r: RuleLogEntry['result']) {
    if (r.skipped) return { text: 'SKIP', cls: 'bg-surface-2 text-text-tertiary' };
    if (r.error) return { text: 'ERROR', cls: 'bg-danger/15 text-danger' };
    if (r.passed) return { text: 'PASS', cls: 'bg-success/15 text-success' };
    return { text: 'FAIL', cls: 'bg-danger/15 text-danger' };
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-overlay/84 backdrop-blur-[2px]" onClick={onClose} />
      <div className="fixed inset-3 z-50 flex items-center justify-center" onClick={onClose}>
        <div
          className="flex h-[min(90vh,980px)] w-[min(1500px,calc(100vw-1.5rem))] max-w-none flex-col overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-brand" />
              <h2 className="text-base font-semibold text-text-primary">Quality Check Review</h2>
              <span className="text-xs text-text-quaternary">{entries.length} rules</span>
            </div>
            <button onClick={onClose} className="rounded-lg p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* ── Filter bar ── */}
          <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-5 py-2.5 bg-surface-2 flex-wrap">
            {/* Status filters */}
            {([
              ['all', `All (${counts.all})`, ''],
              ['pass', `Pass (${counts.pass})`, 'text-success'],
              ['fail', `Fail (${counts.fail})`, 'text-danger'],
              ['error', `Error (${counts.error})`, 'text-warning'],
              ['skip', `Skip (${counts.skip})`, 'text-text-tertiary'],
            ] as [typeof filter, string, string][]).map(([key, label, clr]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  filter === key
                    ? 'border-brand bg-brand/10 text-brand'
                    : `border-[rgb(var(--border-line))] ${clr || 'text-text-tertiary'} hover:border-[rgb(var(--border-strong))] hover:bg-surface-1`
                }`}
              >
                {label}
              </button>
            ))}
            <div className="flex-1" />
            {/* Search */}
            <div className="relative">
              <Filter className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-quaternary" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search rule, table, issue, or SQL…"
                className="w-48 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 py-1 pl-7 pr-2 text-xs focus:border-brand/50 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto border-b border-[rgb(var(--border-line))] bg-surface-1 px-5 py-2.5">
            <div className="min-w-[132px] rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-quaternary">Rules Reviewed</p>
              <p className="mt-1 text-base font-semibold text-text-primary">{formatMetricCount(counts.all)}</p>
            </div>
            <div className="min-w-[132px] rounded-lg border border-success/20 bg-success/10 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-success">Passed</p>
              <p className="mt-1 text-base font-semibold text-success">{formatMetricCount(counts.pass)}</p>
            </div>
            <div className="min-w-[132px] rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-danger">Need Attention</p>
              <p className="mt-1 text-base font-semibold text-danger">{formatMetricCount(totals.rulesNeedingAttention)}</p>
            </div>
            <div className="min-w-[132px] rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-warning">Execution Errors</p>
              <p className="mt-1 text-base font-semibold text-warning">{formatMetricCount(counts.error)}</p>
            </div>
            <div className="min-w-[132px] rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-quaternary">Not Evaluated</p>
              <p className="mt-1 text-base font-semibold text-text-primary">{formatMetricCount(counts.skip)}</p>
            </div>
            <div className="min-w-[132px] rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-quaternary">Rows Checked</p>
              <p className="mt-1 text-base font-semibold text-text-primary">{formatMetricCount(totals.checkedRows)}</p>
            </div>
            <div className="min-w-[132px] rounded-lg border border-warning/20 bg-warning/10 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-warning">Violations</p>
              <p className="mt-1 text-base font-semibold text-warning">{formatMetricCount(totals.failedRows)}</p>
            </div>
          </div>

          {/* ── Review entries ── */}
          <div className="flex-1 overflow-y-auto divide-y divide-[rgb(var(--border-line))]">
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-sm text-text-quaternary">
                No matching rules
              </div>
            ) : filtered.map((entry) => {
              const st = statusLabel(entry.result);
              const isExpanded = expandedId === entry.ruleId;
              const remark = buildIssueRemark(entry);
              const rate = failureRate(entry);

              return (
                <div key={entry.ruleId}>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : entry.ruleId)}
                    className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-surface-2 transition-colors"
                  >
                    {isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
                    }
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shrink-0 ${st.cls}`}>
                      {st.text}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text-primary">{entry.ruleName}</span>
                      <span className="text-xs text-text-quaternary">
                        {entry.tableName}
                        {entry.columnName ? ` › ${entry.columnName}` : ''}
                        {' · '}
                        <span className="font-mono">{entry.ruleType}</span>
                      </span>
                      <p className="mt-1 truncate text-xs text-text-tertiary">{remark.summary}</p>
                    </div>
                    <div className="shrink-0 flex items-center gap-3 text-xs text-text-quaternary">
                      {entry.result.rows_checked != null && (
                        <span>checked: <strong className="text-text-secondary">{entry.result.rows_checked}</strong></span>
                      )}
                      {entry.result.rows_failed != null && (
                        <span>failed: <strong className="text-danger">{entry.result.rows_failed}</strong></span>
                      )}
                      {rate != null && (
                        <span>rate: <strong className="text-text-secondary">{formatMetricPercent(rate)}</strong></span>
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-[rgb(var(--border-line))] bg-surface-2 px-5 py-3">
                      <div className="grid gap-3 xl:grid-cols-[260px,minmax(0,1fr)]">
                        <div className="grid content-start grid-cols-2 gap-2">
                          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Status</p>
                            <p className="mt-1 text-sm font-semibold text-text-primary">{st.text}</p>
                          </div>
                          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Rows Checked</p>
                            <p className="mt-1 text-sm font-semibold text-text-primary">{formatMetricCount(entry.result.rows_checked)}</p>
                          </div>
                          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Rows Failing</p>
                            <p className="mt-1 text-sm font-semibold text-text-primary">{formatMetricCount(entry.result.rows_failed)}</p>
                          </div>
                          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Failure Rate</p>
                            <p className="mt-1 text-sm font-semibold text-text-primary">{formatMetricPercent(rate)}</p>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">Issue Summary</p>
                              <p className="mt-1 text-sm text-text-primary">{remark.summary}</p>
                            </div>

                            <div className="mt-3 border-t border-[rgb(var(--border-line))] pt-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">Interpretation</p>
                              <p className="mt-1 text-sm text-text-secondary">{remark.interpretation}</p>
                            </div>

                            <div className="mt-3 border-t border-[rgb(var(--border-line))] pt-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">Recommended Check</p>
                              <p className="mt-1 text-sm text-text-secondary">{remark.followUp}</p>
                            </div>

                            {entry.result.detail && entry.result.detail !== remark.summary && (
                              <div className="mt-3 rounded-lg border border-brand/20 bg-brand/10 p-3">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">System Note</p>
                                <p className="mt-1 text-sm text-brand">{entry.result.detail}</p>
                              </div>
                            )}
                          </div>

                          {entry.result.sql && (
                            <details className="group rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" open>
                              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary">
                                <span>SQL Query</span>
                                <span className="text-[11px] text-text-quaternary">Click to expand/collapse</span>
                              </summary>
                              <div className="border-t border-[rgb(var(--border-line))] px-3 py-3">
                                <pre className="max-h-56 overflow-auto rounded-lg bg-surface-inverse p-3 font-mono text-xs leading-relaxed text-success whitespace-pre-wrap break-all">
                                  {entry.result.sql}
                                </pre>
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
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
  onViewLog: (rule: QualityRule) => void;
  togglingIds: Set<number>;
}

function DimensionGroup({
  dimKey, rules, tables, runResultsMap, canEdit, isRunning,
  onAddRule, onEditRule, onToggleRule, onDeleteRule, onDuplicateRule, onViewLog, togglingIds,
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
              <span className="inline-flex items-center gap-0.5 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                <CheckCircle2 className="h-3 w-3" />{passCount} pass
              </span>
            )}
            {failCount > 0 && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger">
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
        <div className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
          {rules.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-5 text-center justify-center">
              <ShieldCheck className="h-6 w-6 text-text-secondary" />
              <div>
                <p className="text-sm text-text-quaternary">No {def.label} rules yet</p>
                {canEdit && (
                  <button onClick={() => onAddRule(dimKey)} className="mt-1 text-xs text-brand hover:underline">
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
                  className={`group flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 transition-colors ${!rule.enabled ? 'opacity-50' : ''}`}
                >
                  {/* Severity icon */}
                  <SevIcon className={`h-3.5 w-3.5 shrink-0 ${sev.textColor}`} title={sev.label} />

                  {/* Rule info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-text-primary font-medium truncate">{rule.name}</p>
                      {!rule.enabled && (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-quaternary">disabled</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-quaternary">
                      <span className="flex items-center gap-1">
                        <Database className="h-3 w-3" />{tableName}
                      </span>
                      {rule.column_name && (
                        <>
                          <ChevronRight className="h-3 w-3" />
                          <code className="font-mono text-text-tertiary">{rule.column_name}</code>
                        </>
                      )}
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
                        {getRuleTypeLabel(rule.dimension, rule.rule_type)}
                      </span>
                    </div>
                  </div>

                  {/* Last run result + view log */}
                  <div className="flex items-center gap-1 shrink-0">
                    <RuleResultPill result={result} />
                    {result && (
                      <button
                        onClick={() => onViewLog(rule)}
                        className="rounded p-1 text-text-quaternary hover:bg-brand/15 hover:text-brand transition-colors"
                        title="View rule summary"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-0.5 shrink-0">
                    {canEdit && (
                      <>
                        <InlineToggle checked={rule.enabled} onChange={() => onToggleRule(rule)} disabled={isToggling} />
                        <button
                          onClick={() => onDuplicateRule(rule)}
                          className="rounded p-1 text-text-quaternary hover:bg-surface-3 hover:text-text-secondary"
                          title="Duplicate rule"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => onEditRule(rule)}
                          className="rounded p-1 text-text-quaternary hover:bg-brand/15 hover:text-brand"
                          title="Edit rule"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteRule(rule)}
                          className="rounded p-1 text-text-quaternary hover:bg-danger/15 hover:text-danger"
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
      <div className="fixed inset-0 z-40 bg-overlay/84 backdrop-blur-[2px]" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 p-5 shadow-linear-lg">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Duplicate Rule</h3>
        <p className="text-xs text-text-tertiary mb-4">Copy <strong>"{rule.name}"</strong> to which table?</p>
        <div className="mb-4">
          <label className="mb-1 block text-xs font-medium text-text-secondary">Target table</label>
          <select value={targetTableId} onChange={(e) => setTargetTableId(Number(e.target.value))}
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none">
            {tables.map((t) => <option key={t.id} value={t.id}>{t.display_name || t.source_table_name}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-[rgb(var(--border-line))] px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2">Cancel</button>
          <button onClick={handleDuplicate} disabled={dupMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50">
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
      <div className="fixed inset-0 z-40 bg-overlay/84 backdrop-blur-[2px]" onClick={onCancel} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 p-5 shadow-linear-lg">
        <div className="flex items-start gap-3 mb-4">
          <Trash2 className="h-5 w-5 text-danger shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Delete Rule?</h3>
            <p className="text-xs text-text-tertiary mt-1">Are you sure you want to delete <strong>"{rule.name}"</strong>? This cannot be undone.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={isPending} className="rounded border border-[rgb(var(--border-line))] px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded bg-danger px-4 py-1.5 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50">
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
  const [logModalOpen, setLogModalOpen]         = useState(false);
  const [logFocusRuleId, setLogFocusRuleId]     = useState<number | null>(null);

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
    refetchRules();   // cập nhật badge pass/fail trên từng rule
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

  // Build log entries for the modal
  const logEntries: RuleLogEntry[] = useMemo(() => {
    return allRules
      .filter((r) => r.id in runResultsMap)
      .map((r) => ({
        ruleId: r.id,
        ruleName: r.name,
        ruleType: r.rule_type,
        dimension: r.dimension,
        tableName: tables.find((t) => t.id === r.table_id)?.display_name
          ?? tables.find((t) => t.id === r.table_id)?.source_table_name
          ?? '',
        columnName: r.column_name,
        result: runResultsMap[r.id],
      }));
  }, [allRules, runResultsMap, tables]);

  function handleViewLog(rule: QualityRule) {
    setLogFocusRuleId(rule.id);
    setLogModalOpen(true);
  }

  function handleOpenAllLogs() {
    setLogFocusRuleId(null);
    setLogModalOpen(true);
  }

  // Open editor for new rule
  function openNewRule(dim?: QualityDimension) {
    if (tables.length === 0) {
      toast.error('Add a table before creating quality rules');
      return;
    }
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
    <div className="flex flex-col h-full overflow-hidden bg-surface-2">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 shrink-0 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2 flex-wrap">
        {/* Table filter */}
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
          <select
            value={tableFilter === 'all' ? 'all' : String(tableFilter)}
            onChange={(e) => setTableFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs focus:border-brand/50 focus:outline-none"
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
                ? 'border-[rgb(var(--border-strong))] bg-surface-inverse/70 text-white'
                : 'border-[rgb(var(--border-line))] text-text-tertiary hover:border-[rgb(var(--border-strong))]'
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
                    : 'border-[rgb(var(--border-line))] text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
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
        <span className="text-xs text-text-quaternary shrink-0">
          {enabledRules}/{totalRules} enabled
        </span>

        {/* Run now */}
        {canEdit && (
          <button
            onClick={handleRunNow}
            disabled={isRunning || triggerRun.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-50 shrink-0"
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
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/15 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" /> Add Rule
          </button>
        )}
      </div>

      {/* ── Progress bar (chỉ hiện khi đang chạy) ── */}
      {isRunning && (
        <div className="shrink-0 border-b border-brand/20 bg-surface-1 px-4 py-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-brand flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {pollingRun?.status === 'queued'
                ? 'Preparing run…'
                : `Checking rules… ${progressDone}/${progressTotal}`}
            </span>
            <span className="text-xs font-semibold text-brand">{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-brand/15 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Kết quả run (hiện ngắn sau khi xong, không dùng toast) ── */}
      {!isRunning && lastRunResult && (
        <div className={`shrink-0 border-b px-4 py-2 flex items-center justify-between ${
          lastRunResult.status === 'completed'
            ? 'bg-success/10 border-success/30'
            : 'bg-danger/10 border-danger/30'
        }`}>
          <span className={`text-xs font-medium flex items-center gap-1.5 ${
            lastRunResult.status === 'completed' ? 'text-success' : 'text-danger'
          }`}>
            {lastRunResult.status === 'completed'
              ? <><CheckCircle2 className="h-3.5 w-3.5" />
                  Run complete{lastRunResult.score != null ? ` — ${lastRunResult.score.toFixed(0)}% pass rate` : ''}</>
              : <><XCircle className="h-3.5 w-3.5" />Run failed</>
            }
          </span>
          <button
            onClick={() => setLastRunResult(null)}
            className="text-text-quaternary hover:text-text-secondary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Summary Bar ── */}
      {(overallScore !== null || runStats || dimBreakdown.length > 0 || allRules.length > 0) && (
        <div className="shrink-0 border-b border-[rgb(var(--border-line))] bg-surface-2/80 px-4 py-2">
          <div className="flex items-center gap-3">

            {/* ── Score ── */}
            {overallScore !== null ? (
              <div className="flex items-center gap-2 shrink-0">
                <div className="relative h-8 w-8 shrink-0">
                  <svg viewBox="0 0 36 36" className="h-8 w-8 -rotate-90">
                    <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor"
                      className={overallScore >= 90 ? 'text-success' : overallScore >= 70 ? 'text-warning' : 'text-danger'}
                      strokeWidth="3.5" />
                    <circle cx="18" cy="18" r="15" fill="none"
                      stroke={overallScore >= 90 ? '#16a34a' : overallScore >= 70 ? '#ca8a04' : '#dc2626'}
                      strokeWidth="3.5"
                      strokeDasharray={`${(overallScore / 100) * 94.25} 94.25`}
                      strokeLinecap="round" />
                  </svg>
                </div>
                <span className={`text-sm font-bold ${
                  overallScore >= 90 ? 'text-success' : overallScore >= 70 ? 'text-warning' : 'text-danger'
                }`}>{overallScore.toFixed(0)}%</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 shrink-0">
                <ShieldCheck className="h-4 w-4 text-text-quaternary" />
                <span className="text-xs text-text-quaternary">No run</span>
              </div>
            )}

            {/* ── Divider ── */}
            {runStats && <div className="h-4 w-px bg-surface-3 shrink-0" />}

            {/* ── Stat counts (inline text) ── */}
            {runStats && (
              <div className="flex items-center gap-2.5 text-xs shrink-0">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  <span className="font-semibold text-success">{runStats.pass}</span>
                  <span className="text-text-quaternary">pass</span>
                </span>
                <span className="flex items-center gap-1">
                  <XCircle className="h-3 w-3 text-danger" />
                  <span className="font-semibold text-danger">{runStats.fail}</span>
                  <span className="text-text-quaternary">fail</span>
                </span>
                {runStats.error > 0 && (
                  <span className="flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3 text-warning" />
                    <span className="font-semibold text-warning">{runStats.error}</span>
                    <span className="text-text-quaternary">error</span>
                  </span>
                )}
                {runStats.skipped > 0 && (
                  <span className="flex items-center gap-1">
                    <Info className="h-3 w-3 text-text-quaternary" />
                    <span className="font-semibold text-text-tertiary">{runStats.skipped}</span>
                    <span className="text-text-quaternary">skip</span>
                  </span>
                )}
              </div>
            )}

            {/* ── Divider ── */}
            {dimBreakdown.length > 0 && <div className="h-4 w-px bg-surface-3 shrink-0" />}

            {/* ── Dimension chips (horizontal) ── */}
            {dimBreakdown.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
                {dimBreakdown.map((dim) => {
                  const meta = DQ_DIMENSIONS.find((d) => d.key === dim.dimension);
                  const total = dim.enabled;
                  if (total === 0) return null;
                  const passed = dim.passed ?? 0;
                  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
                  const healthy = pct === 100;
                  const active = dimFilter === dim.dimension;
                  return (
                    <button
                      key={dim.dimension}
                      onClick={() => setDimFilter(active ? 'all' : dim.dimension as QualityDimension)}
                      title={`${meta?.label ?? dim.dimension}: ${passed}/${total} passed`}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                        active
                          ? 'bg-brand/10 text-brand ring-1 ring-brand'
                          : healthy
                          ? 'text-success bg-success/10/60 hover:bg-success/10'
                          : 'text-danger bg-danger/10/60 hover:bg-danger/10'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${active ? 'bg-brand' : healthy ? 'bg-success' : 'bg-danger/60'}`} />
                      <span className="truncate">{meta?.label ?? dim.dimension}</span>
                      <span className={`tabular-nums ${active ? 'text-brand' : healthy ? 'text-success' : 'text-danger'}`}>{pct}%</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── Logs button ── */}
            {logEntries.length > 0 && (
              <button
                onClick={handleOpenAllLogs}
                className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-[11px] font-medium text-text-tertiary hover:bg-surface-2 hover:border-[rgb(var(--border-strong))] transition-colors shrink-0"
                title="View quality summaries"
              >
                <Eye className="h-3 w-3" />
                Review
              </button>
            )}

            {/* No-run hint */}
            {overallScore === null && !runStats && dimBreakdown.length === 0 && allRules.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-text-quaternary">
                <Info className="h-3.5 w-3.5" />
                Run checks to see scores
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {rulesError ? (
          <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Could not load quality rules</p>
              <p className="mt-1 text-danger">{(rulesError as Error).message}</p>
              <button onClick={() => refetchRules()} className="mt-2 text-xs text-danger underline underline-offset-2">Retry</button>
            </div>
          </div>
        ) : loadingRules && !allRules.length ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Loader2 className="h-8 w-8 animate-spin text-text-quaternary" />
            <p className="text-sm text-text-quaternary">Loading rules…</p>
          </div>
        ) : allRules.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <div className="rounded-2xl border-2 border-dashed border-[rgb(var(--border-line))] p-6">
              <ShieldCheck className="h-12 w-12 text-text-secondary mx-auto mb-3" />
              <p className="text-base font-semibold text-text-secondary mb-1">No quality rules yet</p>
              <p className="text-sm text-text-quaternary max-w-xs">
                Add rules to monitor data completeness, validity, uniqueness, consistency, timeliness, and accuracy across your tables.
              </p>
              {canEdit && (
                <button
                  onClick={() => openNewRule()}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
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
                    <p className="text-[11px] text-text-tertiary mt-0.5">{d.description}</p>
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
                  onViewLog={handleViewLog}
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

      {/* ── Rule Log Modal ── */}
      {logModalOpen && logEntries.length > 0 && (
        <RuleLogModal
          entries={logEntries}
          initialExpandedId={logFocusRuleId}
          onClose={() => { setLogModalOpen(false); setLogFocusRuleId(null); }}
        />
      )}
    </div>
  );
}
