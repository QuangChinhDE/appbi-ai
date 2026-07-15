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
 *  - In-tab overview report for the latest quality run
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  Database,
  Eye,
  Filter,
  Info,
  Loader2,
  Pencil,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import { AiButton } from '@/components/ui/AiButton';
import { apiClient as api } from '@/lib/api-client';
import { DatasetQualityReportModal } from '@/components/datasets/DatasetQualityReportModal';
import { DatasetQualityScheduleModal } from '@/components/datasets/DatasetQualityScheduleModal';

import {
  type DatasetTable,
  type QualityDimension,
  type QualityRule,
  type QualityRuleConfig,
  type QualityRuleCreate,
  type QualityFormat,
  type QualityRuleUpdate,
  type QualitySeverity,
  type QualityAISuggestResponse,
  useAISuggestQualityRule,
  useBulkCreateQualityRules,
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
      { value: 'not_null', label: 'Not Null', level: 'column', hint: 'Fails if any value in this column is NULL. Tip: use the multi-column mode to cover several columns in one step.' },
      { value: 'not_blank', label: 'Not Blank', level: 'column', hint: 'Fails if any value is an empty string after trimming. Also supports multi-column selection.' },
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
      { value: 'pattern_match', label: 'Pattern Match (regex)', level: 'column', hint: 'Fails if any non-null value does not match the regex. Use this for UPPER(column), custom formats, or anything beyond the built-in Format Check options.' },
      { value: 'range_check', label: 'Numeric Range [min, max]', level: 'column', hint: 'Fails if any value is outside the specified numeric range' },
      { value: 'format_check', label: 'Format Check', level: 'column', hint: 'Built-in heuristics only (email, url, date, datetime, phone). For custom formats use Pattern Match.' },
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
      { value: 'unique_combo', label: 'Unique Combination (table grain)', level: 'table', hint: 'Define table grain by listing the columns whose combination must be unique. Example: deal_id + payment_date + customer_id — each row = one payment, duplicates fail.' },
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
      { value: 'cross_column', label: 'Same-table SQL Expression', level: 'table', hint: 'Write any SQL boolean expression. A row FAILS when the expression is FALSE. Can reference any column in the selected table — great for conditional business rules (e.g. status=\'fully_received\' implies income_value = receivable + received).' },
      { value: 'cross_table', label: 'Cross-table Join Expression', level: 'table', hint: 'Join the selected table to another table, then evaluate a SQL boolean expression using aliases src and ref.' },
      { value: 'schema_drift', label: 'Schema Drift', level: 'table', hint: 'Captures a baseline of the table columns on first run, then fails when columns are added, removed, or retyped. Edit/re-save the rule to reset the baseline after an intended schema change.' },
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
      { value: 'custom_sql', label: 'Custom SQL (escape hatch)', level: 'table', hint: 'Write any SQL query that returns two columns: rows_checked and rows_failed. Use this when no other rule type fits.' },
    ],
  },
];

// Flat list of all rule types, including their natural (default) dimension.
// The natural dimension is only a suggestion — users can pair any rule type
// with any dimension after the 2026-04 decoupling change.
const ALL_RULE_TYPES: Array<{
  value: string;
  label: string;
  level: 'column' | 'table' | 'both';
  hint?: string;
  naturalDimension: QualityDimension;
}> = DQ_DIMENSIONS.flatMap((d) =>
  d.ruleTypes.map((rt) => ({ ...rt, naturalDimension: d.key })),
);

// Rule types that accept column-level multi-select for bulk creation.
const BULK_COLUMN_RULE_TYPES = new Set([
  'not_null', 'not_blank', 'unique_column',
  'format_check', 'range_check', 'completeness_pct',
]);

const SEVERITY_META: Record<QualitySeverity, { label: string; textColor: string; bgColor: string; icon: React.ElementType; tooltip: string; description: string }> = {
  info:    { label: 'Info',    textColor: 'text-brand',  bgColor: 'bg-brand/10',  icon: Info,          tooltip: 'Informational only — does not affect trust score', description: 'Informational — does not affect the trust score' },
  warning: { label: 'Warning', textColor: 'text-warning', bgColor: 'bg-warning/10', icon: AlertTriangle, tooltip: 'Worth monitoring — lowers score but not blocking', description: 'Lowers score but does not block usage' },
  error:   { label: 'Error',   textColor: 'text-danger',   bgColor: 'bg-danger/10',   icon: XCircle,       tooltip: 'Data cannot be trusted — fix urgently', description: 'Data cannot be trusted — fix urgently' },
};

// ---------------------------------------------------------------------------
// Live Preview types
// ---------------------------------------------------------------------------

interface RulePreviewResult {
  sql: string | null;
  pass_description: string;
  fail_description: string;
  scope_description: string;
  error: string | null;
}

interface RuleTestResult {
  passed: boolean;
  rows_checked?: number | null;
  rows_failed?: number | null;
  detail?: string | null;
  sql?: string | null;
  preview_sql?: string | null;
  preview_note?: string | null;
  preview_columns?: string[] | null;
  preview_rows?: Array<Record<string, unknown>> | null;
  log?: string[] | null;
  elapsed_ms?: number | null;
  skipped?: boolean;
  error?: boolean;
}

function getRequestErrorMessage(error: any, fallback: string): string {
  const message = error?.response?.data?.detail ?? error?.response?.data?.message ?? error?.message ?? fallback;
  return typeof message === 'string' ? message : JSON.stringify(message);
}

function normalizeQualityRuleIdentityValue(value: any): any {
  if (Array.isArray(value)) {
    return [...value]
      .map((item) => normalizeQualityRuleIdentityValue(item))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeQualityRuleIdentityValue(item)]),
    );
  }
  return value;
}

function findEquivalentQualityRule({
  rules,
  tableId,
  columnName,
  ruleType,
  config,
  excludeRuleId,
}: {
  rules: QualityRule[];
  tableId: number;
  columnName?: string;
  ruleType: string;
  config: QualityRuleConfig;
  excludeRuleId?: number;
}): QualityRule | null {
  const normalizedColumnName = columnName?.trim() || undefined;
  const normalizedRuleType = ruleType.trim().toLowerCase();
  const normalizedConfig = JSON.stringify(normalizeQualityRuleIdentityValue(config ?? {}));

  return rules.find((rule) => {
    if (excludeRuleId != null && rule.id === excludeRuleId) return false;
    if (rule.table_id !== tableId) return false;
    if ((rule.column_name?.trim() || undefined) !== normalizedColumnName) return false;
    if ((rule.rule_type || '').trim().toLowerCase() !== normalizedRuleType) return false;
    return JSON.stringify(normalizeQualityRuleIdentityValue(rule.config ?? {})) === normalizedConfig;
  }) ?? null;
}

const FORMAT_OPTIONS: { value: QualityFormat; label: string }[] = [
  { value: 'email',    label: 'Email address' },
  { value: 'url',      label: 'URL (http/https)' },
  { value: 'date',     label: 'Date (YYYY-MM-DD)' },
  { value: 'datetime', label: 'Datetime (ISO 8601)' },
  { value: 'phone',    label: 'Phone number' },
];

const REGEX_PRESETS: { label: string; pattern: string; flags?: string }[] = [
  { label: 'UPPERCASE',     pattern: '^[A-Z\\s]+$' },
  { label: 'lowercase',     pattern: '^[a-z\\s]+$' },
  { label: 'Alphanumeric',  pattern: '^[A-Za-z0-9]+$' },
  { label: 'Numeric string', pattern: '^[0-9]+$' },
  { label: 'No special',    pattern: '^[A-Za-z0-9\\s_-]+$' },
  { label: 'UUID',          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', flags: 'i' },
];

// Fallback definition for custom (user-created) dimensions not in DQ_DIMENSIONS.
const CUSTOM_DIM_DEF = {
  label: 'Other',
  description: 'Custom dimension',
  color: 'text-text-secondary',
  bg: 'bg-surface-2',
  border: 'border-[rgb(var(--border-line))]',
  dot: 'bg-text-quaternary',
  ruleTypes: [] as { value: string; label: string; level: 'column' | 'table' | 'both'; hint?: string }[],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function dimDef(key: QualityDimension) {
  return DQ_DIMENSIONS.find((d) => d.key === key) ?? { ...CUSTOM_DIM_DEF, key, label: key };
}

function getRuleTypeLabel(ruleType: string): string {
  return ALL_RULE_TYPES.find((r) => r.value === ruleType)?.label ?? ruleType;
}

function getColumnOptions(tables: DatasetTable[], tableId: number): string[] {
  const t = tables.find((t) => t.id === tableId);
  if (!t?.columns_cache) return [];
  const cache = t.columns_cache as Record<string, any>;
  const cols = cache.columns as { name: string }[] | undefined;
  return cols?.map((c) => c.name) ?? [];
}

type RuleTypeDefinition = (typeof ALL_RULE_TYPES)[number];

function getRuleTypeDef(ruleType: string): RuleTypeDefinition | undefined {
  return ALL_RULE_TYPES.find((r) => r.value === ruleType);
}

function getNaturalDimension(ruleType: string): QualityDimension | undefined {
  return getRuleTypeDef(ruleType)?.naturalDimension;
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
  const { t } = useI18n();
  if (!result) return null;
  if (result.skipped)
    return <span title={result.detail ?? undefined} className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-tertiary cursor-help">{t('datasets.quality.pill.skipped')}</span>;
  if (result.error)
    return <span title={result.detail ?? t('datasets.quality.pill.executionError')} className="inline-flex items-center gap-0.5 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger cursor-help"><XCircle className="h-3 w-3" />{t('datasets.quality.pill.error')}</span>;
  if (result.passed)
    return <span title={result.detail ?? t('datasets.quality.pill.allRowsPassed')} className="inline-flex items-center gap-0.5 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success cursor-help"><CheckCircle2 className="h-3 w-3" />{t('datasets.quality.pill.pass')}</span>;
  const detail = result.rows_failed != null ? t('datasets.quality.pill.failCount', { count: result.rows_failed }) : t('datasets.quality.pill.fail');
  return <span title={result.detail ?? undefined} className="inline-flex items-center gap-0.5 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger cursor-help"><XCircle className="h-3 w-3" />{detail}</span>;
}

function InlineToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`flex items-center transition-colors disabled:opacity-40 ${checked ? 'text-brand' : 'text-text-quaternary'}`}
      title={checked ? t('datasets.quality.toggle.enabledHint') : t('datasets.quality.toggle.disabledHint')}
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
    <div className="mb-1.5 flex items-start justify-between gap-2">
      <div className="flex min-w-0 items-center text-xs font-medium text-text-secondary">
        <span>{label}</span>
        {helpText && <HelpTooltip text={helpText} />}
      </div>
      {action}
    </div>
  );
}

function SectionHeader({ title, helpText, icon: Icon }: {
  title: string;
  helpText?: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {Icon && <Icon className="h-3.5 w-3.5 text-text-quaternary" />}
      <h4 className="text-xs font-semibold text-text-primary">{title}</h4>
      {helpText && <HelpTooltip text={helpText} />}
    </div>
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
  const { t } = useI18n();
  const options = getColumnOptions(tables, tableId);
  return (
    <div>
      {label && <FieldLabel label={label} helpText={helpText} />}
      {options.length > 0 ? (
        <SearchableSelect
          options={options}
          value={value}
          onChange={onChange}
          placeholder={placeholder ?? t('datasets.quality.column.searchPlaceholder')}
        />
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

function SearchableSelect({ options, value, onChange, placeholder }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef     = React.useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

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
      if (filtered[focusIdx]) selectValue(filtered[focusIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  const displayValue = open ? query : value;
  const hintPlaceholder = placeholder ?? t('datasets.quality.column.searchAvailable', { count: options.length });

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 focus-within:border-brand/50">
        <Search className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onFocus={() => { setOpen(true); setFocusIdx(0); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setFocusIdx(0); }}
          onKeyDown={handleKey}
          placeholder={hintPlaceholder}
          className="w-full bg-transparent text-sm focus:outline-none"
        />
        {value && !open && (
          <button
            type="button"
            onClick={() => { onChange(''); inputRef.current?.focus(); }}
            className="text-text-quaternary hover:text-text-secondary"
            aria-label={t('datasets.quality.column.clearAria')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-md">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-text-quaternary">{t('datasets.quality.common.noMatches')}</p>
          ) : (
            filtered.map((opt, idx) => (
              <button
                key={opt}
                type="button"
                onMouseEnter={() => setFocusIdx(idx)}
                onClick={() => selectValue(opt)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm ${
                  idx === focusIdx ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-surface-2'
                }`}
              >
                <span className="truncate font-mono">{opt}</span>
                {opt === value && <Check className="h-3.5 w-3.5 text-brand" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MultiColumnPicker({ tableId, tables, value, onChange }: {
  tableId: number;
  tables: DatasetTable[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useI18n();
  const options = getColumnOptions(tables, tableId);
  const [query, setQuery] = useState('');

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter((o) => o.toLowerCase().includes(normalizedQuery))
    : options;
  const selectedSet = new Set(value);
  const allVisibleSelected = filtered.length > 0 && filtered.every((o) => selectedSet.has(o));

  function toggleColumn(col: string) {
    if (selectedSet.has(col)) onChange(value.filter((v) => v !== col));
    else onChange([...value, col]);
  }

  function toggleAllVisible() {
    if (allVisibleSelected) {
      onChange(value.filter((v) => !filtered.includes(v)));
    } else {
      const merged = new Set(value);
      filtered.forEach((o) => merged.add(o));
      onChange(Array.from(merged));
    }
  }

  return (
    <div>
      <FieldLabel
        label={t('datasets.quality.multiColumn.label', { count: value.length })}
        helpText={t('datasets.quality.multiColumn.help')}
        action={
          value.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[11px] font-medium text-text-tertiary hover:text-text-secondary"
            >
              {t('datasets.quality.common.clear')}
            </button>
          ) : undefined
        }
      />
      {options.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-xs text-text-quaternary">
          {t('datasets.quality.multiColumn.noColumns')}
        </p>
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="flex items-center gap-1.5 border-b border-[rgb(var(--border-line))] px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('datasets.quality.multiColumn.searchPlaceholder', { count: options.length })}
              className="w-full bg-transparent text-sm focus:outline-none"
            />
            <button
              type="button"
              onClick={toggleAllVisible}
              className="shrink-0 rounded border border-[rgb(var(--border-line))] px-2 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-surface-2"
            >
              {allVisibleSelected ? t('datasets.quality.multiColumn.deselectAll') : t('datasets.quality.multiColumn.selectAll')}
            </button>
          </div>
          <div className="max-h-64 overflow-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-quaternary">{t('datasets.quality.common.noMatches')}</p>
            ) : (
              filtered.map((col) => {
                const checked = selectedSet.has(col);
                return (
                  <button
                    key={col}
                    type="button"
                    onClick={() => toggleColumn(col)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                      checked ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-surface-2'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        checked ? 'border-brand bg-brand text-white' : 'border-[rgb(var(--border-line))] bg-surface-1'
                      }`}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate font-mono">{col}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule Type search select (flat list with search, replacing <optgroup>)
// ---------------------------------------------------------------------------

function RuleTypeSearchSelect({ value, onChange }: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef     = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? ALL_RULE_TYPES.filter((rt) =>
        rt.label.toLowerCase().includes(normalizedQuery)
        || (rt.hint ?? '').toLowerCase().includes(normalizedQuery)
        || rt.naturalDimension.toLowerCase().includes(normalizedQuery)
        || rt.value.toLowerCase().includes(normalizedQuery)
      )
    : ALL_RULE_TYPES;

  function selectValue(v: string) {
    onChange(v);
    setOpen(false);
    setQuery('');
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[focusIdx]) selectValue(filtered[focusIdx].value); }
    else if (e.key === 'Escape') { setOpen(false); setQuery(''); }
  }

  const currentLabel = ALL_RULE_TYPES.find((r) => r.value === value)?.label ?? value;
  const displayValue = open ? query : currentLabel;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 focus-within:border-brand/50">
        <Search className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onFocus={() => { setOpen(true); setFocusIdx(0); setQuery(''); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setFocusIdx(0); }}
          onKeyDown={handleKey}
          placeholder={t('datasets.quality.ruleType.searchPlaceholder')}
          className="w-full bg-transparent text-sm focus:outline-none"
        />
        {!open && (
          <ChevronDown className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
        )}
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-3 text-xs text-text-quaternary">{t('datasets.quality.ruleType.noMatches')}</p>
          ) : (
            filtered.map((rt, idx) => {
              const dimMeta = DQ_DIMENSIONS.find((d) => d.key === rt.naturalDimension);
              return (
                <button
                  key={rt.value}
                  type="button"
                  title={rt.hint}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onClick={() => selectValue(rt.value)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    idx === focusIdx ? 'bg-brand/10' : 'hover:bg-surface-2'
                  }`}
                >
                  <span className={`min-w-0 flex-1 text-xs font-medium truncate ${rt.value === value ? 'text-brand' : 'text-text-primary'}`}>{rt.label}</span>
                  {rt.value === value && <Check className="h-3 w-3 text-brand shrink-0" />}
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${dimMeta?.bg ?? 'bg-surface-2'} ${dimMeta?.color ?? 'text-text-tertiary'}`}>
                    {dimMeta?.label ?? rt.naturalDimension}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table search select
// ---------------------------------------------------------------------------

function TableSearchSelect({ tables, value, onChange, disabled, includeAllOption, allLabel }: {
  tables: DatasetTable[];
  value: number | 'all';
  onChange: (v: number | 'all') => void;
  disabled?: boolean;
  includeAllOption?: boolean;
  allLabel?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredTables = normalizedQuery
    ? tables.filter((t) =>
        (t.display_name ?? '').toLowerCase().includes(normalizedQuery)
        || (t.source_table_name ?? '').toLowerCase().includes(normalizedQuery)
      )
    : tables;

  const options = [
    ...(includeAllOption ? [{ id: 'all' as const, label: allLabel ?? t('datasets.quality.table.allTables') }] : []),
    ...filteredTables.map((table) => ({
      id: table.id as number | 'all',
      label: table.display_name || table.source_table_name || t('datasets.quality.table.untitled'),
    })),
  ];

  function selectTable(id: number | 'all') {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  const currentTable = value === 'all' ? null : tables.find((t) => t.id === value);
  const currentLabel = value === 'all'
    ? (allLabel ?? t('datasets.quality.table.allTables'))
    : (currentTable?.display_name || currentTable?.source_table_name || t('datasets.quality.table.selectTable'));
  const displayValue = open ? query : currentLabel;

  if (disabled) {
    return (
      <div className="flex items-center gap-1.5 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-sm text-text-quaternary">
        <Database className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{currentLabel}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 focus-within:border-brand/50">
        <Database className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
        <input
          type="text"
          value={displayValue}
          onFocus={() => { setOpen(true); setFocusIdx(0); setQuery(''); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setFocusIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setFocusIdx((i) => Math.min(i + 1, options.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (options[focusIdx]) selectTable(options[focusIdx].id); }
            else if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          }}
          placeholder={includeAllOption ? t('datasets.quality.table.filterPlaceholder', { count: tables.length }) : t('datasets.quality.table.searchPlaceholder', { count: tables.length })}
          className="w-full bg-transparent text-sm focus:outline-none"
        />
        <ChevronDown className="h-3.5 w-3.5 text-text-quaternary shrink-0" />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-text-quaternary">{t('datasets.quality.common.noMatches')}</p>
          ) : (
            options.map((option, idx) => (
              <button
                key={String(option.id)}
                type="button"
                onMouseEnter={() => setFocusIdx(idx)}
                onClick={() => selectTable(option.id)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                  idx === focusIdx ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-surface-2'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {option.id === value && <Check className="h-3.5 w-3.5 text-brand shrink-0" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Intent-based quick-start cards
// ---------------------------------------------------------------------------

const INTENT_CARDS: Array<{
  title: string;
  description: string;
  ruleType: string;
  dimension: QualityDimension;
  icon: string;
}> = [
  {
    title: 'Column must not be NULL',
    description: 'Check that required columns always have values. Supports multi-column selection.',
    ruleType: 'not_null',
    dimension: 'completeness',
    icon: '🔒',
  },
  {
    title: 'Unique combination (grain)',
    description: 'Ensure a set of columns forms a unique key — e.g. deal_id + payment_date + customer_id.',
    ruleType: 'unique_combo',
    dimension: 'uniqueness',
    icon: '🔑',
  },
  {
    title: 'Business logic (SQL)',
    description: 'Write any SQL condition rows must satisfy — conditional checks, cross-column formulas, etc.',
    ruleType: 'cross_column',
    dimension: 'consistency',
    icon: '⚡',
  },
  {
    title: 'Values in allowed list',
    description: 'Restrict a column to a set of accepted values — statuses, categories, codes.',
    ruleType: 'accepted_values',
    dimension: 'validity',
    icon: '📋',
  },
  {
    title: 'Numeric range [min, max]',
    description: 'Validate that numbers stay within expected bounds — amounts, ages, scores.',
    ruleType: 'range_check',
    dimension: 'validity',
    icon: '📊',
  },
  {
    title: 'Pattern / Regex match',
    description: 'Validate format with regex — UPPER(), phone numbers, custom codes.',
    ruleType: 'pattern_match',
    dimension: 'validity',
    icon: '🔤',
  },
  {
    title: 'Data must be fresh',
    description: 'Alert when the latest data is older than N days.',
    ruleType: 'freshness_days',
    dimension: 'timeliness',
    icon: '⏰',
  },
  {
    title: 'Custom SQL (escape hatch)',
    description: 'Write any SQL query returning rows_checked and rows_failed. Ultimate flexibility.',
    ruleType: 'custom_sql',
    dimension: 'accuracy',
    icon: '🛠️',
  },
];

function IntentCardsGrid({ onSelect }: {
  onSelect: (ruleType: string, dimension: QualityDimension) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-brand/20 bg-brand/5 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Wand2 className="h-3.5 w-3.5 text-brand" />
        <h4 className="text-xs font-semibold text-brand">{t('datasets.quality.intent.quickStart')}</h4>
      </div>
      <div className="grid gap-1.5 grid-cols-4 lg:grid-cols-8">
        {INTENT_CARDS.map((card) => (
          <button
            key={card.ruleType}
            type="button"
            title={card.description}
            onClick={() => onSelect(card.ruleType, card.dimension)}
            className="flex flex-col items-center gap-1 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-2 text-center transition-all hover:border-brand/40 hover:bg-brand/5 hover:shadow-linear-sm group"
          >
            <span className="text-base leading-none">{card.icon}</span>
            <span className="text-[10px] font-medium leading-tight text-text-secondary group-hover:text-brand transition-colors">{card.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Rule Assistant
// ---------------------------------------------------------------------------

function AIRuleAssistant({ datasetId, tableId, tables, onApply }: {
  datasetId: number;
  tableId: number;
  tables: DatasetTable[];
  onApply: (suggestion: QualityAISuggestResponse) => void;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState('');
  const [lastResult, setLastResult]   = useState<QualityAISuggestResponse | null>(null);
  const mutation = useAISuggestQualityRule(datasetId);

  const selectedTable = tables.find((t) => t.id === tableId);
  const tableName = selectedTable?.display_name || selectedTable?.source_table_name || '';
  const columns: { name: string; type: string }[] = useMemo(() => {
    if (!selectedTable?.columns_cache) return [];
    const cache = selectedTable.columns_cache as Record<string, any>;
    const cols = cache.columns as { name: string; type?: string }[] | undefined;
    return cols?.map((c) => ({ name: c.name, type: c.type ?? '' })) ?? [];
  }, [selectedTable]);

  async function handleGenerate() {
    if (!description.trim() || !tableName) return;
    try {
      const result = await mutation.mutateAsync({
        description: description.trim(),
        table_name: tableName,
        columns,
      });
      setLastResult(result);
    } catch {
      // error handled by mutation state
    }
  }

  function handleApply() {
    if (lastResult) {
      onApply(lastResult);
      setLastResult(null);
      setDescription('');
    }
  }

  return (
    <div className="rounded-2xl border border-brand/20 bg-brand/5 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-3.5 w-3.5 text-brand" />
        <span className="text-xs font-semibold text-brand">{t('datasets.quality.ai.assist')}</span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleGenerate(); } }}
          placeholder={t('datasets.quality.ai.placeholder')}
          className="min-w-0 flex-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-xs focus:border-brand/50 focus:outline-none placeholder:text-text-quaternary"
        />
        <AiButton
          size="md"
          className="shrink-0"
          onClick={handleGenerate}
          loading={mutation.isPending}
          disabled={!description.trim() || !tableName}
          aria-label={t('datasets.quality.ai.assist')}
        />
      </div>

      {mutation.isError && (
        <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {(mutation.error as any)?.response?.data?.detail ?? t('datasets.quality.ai.unavailable')}
        </div>
      )}

      {lastResult && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-purple-500/30 bg-surface-1 px-3 py-2">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium text-text-primary">{lastResult.name}</span>
            <span className="ml-2 text-[11px] text-text-tertiary" title={lastResult.explanation}>{getRuleTypeLabel(lastResult.rule_type)} · {lastResult.dimension}</span>
          </div>
          <button
            type="button"
            onClick={handleApply}
            className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-purple-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-purple-700"
          >
            <Check className="h-3 w-3" /> {t('datasets.quality.ai.apply')}
          </button>
        </div>
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
  const { t } = useI18n();
  const colOptions = getColumnOptions(tables, tableId);
  const selectedTable = tables.find((table) => table.id === tableId);
  const secondaryTableId = typeof config.secondary_table_id === 'number' ? config.secondary_table_id : undefined;
  const secondaryTable = tables.find((table) => table.id === secondaryTableId);

  switch (ruleType) {
    case 'completeness_pct':
      return (
        <div>
          <FieldLabel
            label={t('datasets.quality.config.completenessPct.label')}
            helpText={t('datasets.quality.config.completenessPct.help')}
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
            label={t('datasets.quality.config.acceptedValues.label')}
            helpText={t('datasets.quality.config.acceptedValues.help')}
            action={<span className="text-[11px] font-normal text-text-quaternary">{t('datasets.quality.config.acceptedValues.enterHint')}</span>}
          />
          <TagInput values={config.values ?? []} onChange={(values) => onPatch({ values })} placeholder={t('datasets.quality.config.acceptedValues.placeholder')} />
        </div>
      );

    case 'pattern_match':
      return (
        <div className="space-y-2">
          <div>
            <FieldLabel
              label={t('datasets.quality.config.patternMatch.patternLabel')}
              helpText={t('datasets.quality.config.patternMatch.patternHelp')}
            />
            <input type="text"
              value={config.pattern ?? ''}
              onChange={(e) => onPatch({ pattern: e.target.value || undefined })}
              placeholder="^[A-Z]{2}[0-9]+$"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div>
            <FieldLabel
              label={t('datasets.quality.config.patternMatch.flagsLabel')}
              helpText={t('datasets.quality.config.patternMatch.flagsHelp')}
              action={<span className="text-[11px] font-normal text-text-quaternary">{t('datasets.quality.common.optional')}</span>}
            />
            <input type="text"
              value={(config as any).flags ?? ''}
              onChange={(e) => onPatch({ flags: e.target.value || undefined } as any)}
              placeholder="i"
              className="w-24 rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-[11px] text-text-quaternary mr-0.5">{t('datasets.quality.config.patternMatch.presets')}</span>
            {REGEX_PRESETS.map((p) => (
              <button key={p.label} type="button"
                onClick={() => onPatch({ pattern: p.pattern, ...(p.flags ? { flags: p.flags } : {}) } as any)}
                className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-brand/10 hover:text-brand hover:border-brand/30 transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      );

    case 'range_check':
      return (
        <div className="flex gap-2">
          <div className="flex-1">
            <FieldLabel
              label={t('datasets.quality.config.range.minLabel')}
              helpText={t('datasets.quality.config.range.minHelp')}
            />
            <input type="text" value={config.min ?? ''}
              onChange={(e) => onPatch({ min: e.target.value || undefined })}
              placeholder="0"
              className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div className="flex-1">
            <FieldLabel
              label={t('datasets.quality.config.range.maxLabel')}
              helpText={t('datasets.quality.config.range.maxHelp')}
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
            label={t('datasets.quality.config.format.label')}
            helpText={t('datasets.quality.config.format.help')}
          />
          <select value={config.format ?? ''}
            onChange={(e) => onPatch({ format: (e.target.value || undefined) as QualityFormat | undefined })}
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none">
            <option value="">{t('datasets.quality.config.format.selectOption')}</option>
            {FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <p className="mt-1.5 text-[11px] text-text-quaternary">
            {t('datasets.quality.config.format.note')}
          </p>
        </div>
      );

    case 'unique_combo':
      return (
        <div>
          <FieldLabel
            label={t('datasets.quality.config.uniqueCombo.label')}
            helpText={t('datasets.quality.config.uniqueCombo.help')}
          />
          <TagInput
            values={config.columns ?? []}
            onChange={(columns) => onPatch({ columns })}
            placeholder={t('datasets.quality.config.uniqueCombo.placeholder')}
            suggestions={colOptions}
          />
          <p className="mt-1 text-[11px] text-text-quaternary">{t('datasets.quality.config.uniqueCombo.note')}</p>
        </div>
      );

    case 'cross_column':
      return (
        <div>
          <FieldLabel
            label={t('datasets.quality.config.crossColumn.label')}
            helpText={t('datasets.quality.config.crossColumn.help')}
          />
          <textarea rows={4}
            value={config.expression ?? ''}
            onChange={(e) => onPatch({ expression: e.target.value || undefined })}
            placeholder={'end_date >= start_date\namount > 0 AND status != \'void\''}
            className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-1.5 font-mono text-xs focus:border-brand/50 focus:outline-none resize-none" />
          <p className="mt-1 text-[11px] text-text-quaternary">
            {t('datasets.quality.config.crossColumn.note')}
          </p>
          <ExpressionExamples
            defaultOpen
            examples={[
              {
                title: t('datasets.quality.config.crossColumn.example1Title'),
                sql: "status != 'fully_received' OR income_value = (receivable + received)",
                note: t('datasets.quality.config.crossColumn.example1Note'),
              },
              {
                title: t('datasets.quality.config.crossColumn.example2Title'),
                sql: "deal_id >= 0 OR owner_email = 'khoa.hoc@base.vn'",
                note: t('datasets.quality.config.crossColumn.example2Note'),
              },
              {
                title: t('datasets.quality.config.crossColumn.example3Title'),
                sql: 'amount IS NOT NULL AND amount > 0',
                note: t('datasets.quality.config.crossColumn.example3Note'),
              },
            ]}
            onCopy={(sql) => onPatch({ expression: sql })}
          />
        </div>
      );

    case 'cross_table':
      return (
        <div className="space-y-2">
          <div>
            <FieldLabel
              label={t('datasets.quality.config.crossTable.relatedTableLabel')}
              helpText={t('datasets.quality.config.crossTable.relatedTableHelp')}
            />
            <select
              value={secondaryTableId ?? ''}
              onChange={(e) => onPatch({ secondary_table_id: e.target.value ? Number(e.target.value) : undefined })}
              className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm focus:border-brand/50 focus:outline-none"
            >
              <option value="">{t('datasets.quality.config.crossTable.selectRelatedOption')}</option>
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
        <div className="space-y-2">
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

    case 'custom_sql':
      return (
        <div className="space-y-2">
          <FieldLabel
            label="Custom SQL"
            helpText="Write a SQL query that returns two columns: rows_checked (total rows in scope) and rows_failed (rows that violate your rule). Use {{ table }} as a placeholder for the target table — the runner replaces it before execution."
          />
          <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-5 text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Custom SQL runs directly on your datasource with no sandboxing. Ensure the query is safe, read-only, and performant before saving.</span>
          </div>
          <textarea rows={10}
            value={config.sql ?? ''}
            onChange={(e) => onPatch({ sql: e.target.value || undefined })}
            placeholder={
`-- Must SELECT two columns: rows_checked and rows_failed
SELECT
  COUNT(*) AS rows_checked,
  COUNT(*) FILTER (WHERE NOT (amount >= 0)) AS rows_failed
FROM {{ table }}`
            }
            className="w-full rounded border border-[rgb(var(--border-line))] px-2 py-2 font-mono text-xs focus:border-brand/50 focus:outline-none resize-y" />
          <p className="text-[11px] text-text-quaternary">
            The query must return exactly two aliased columns. Failing rows are reported as rule failures. Use Run test in the preview panel to validate the SQL and inspect live output before saving.
          </p>
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

function ExpressionExamples({ examples, onCopy, defaultOpen = false }: {
  examples: Array<{ title: string; sql: string; note: string }>;
  onCopy: (sql: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-text-secondary hover:bg-surface-1"
      >
        <span className="inline-flex items-center gap-1.5">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Copy-paste examples
        </span>
        <span className="text-[11px] text-text-quaternary">{examples.length} patterns</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-[rgb(var(--border-line))] p-2">
          {examples.map((ex) => (
            <div key={ex.title} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold text-text-secondary">{ex.title}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-text-quaternary">{ex.note}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onCopy(ex.sql)}
                  className="shrink-0 rounded border border-brand/40 bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand hover:bg-brand/20"
                >
                  Use
                </button>
              </div>
              <pre className="mt-1 overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-[11px] leading-4 text-text-primary">{ex.sql}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule Editor Modal
// ---------------------------------------------------------------------------

interface RuleEditorProps {
  datasetId: number;
  tables: DatasetTable[];
  existingRules: QualityRule[];
  editingRule: QualityRule | null;         // null = create mode
  defaultTableId?: number;
  lastUsedTableId?: number;
  defaultDimension?: QualityDimension;
  onClose: () => void;
  onSaved: (rule: QualityRule) => void;
  onDuplicate?: (rule: QualityRule) => void;
}

function RuleEditorDrawerLegacy({
  datasetId, tables, editingRule, defaultTableId, lastUsedTableId, defaultDimension, onClose, onSaved, onDuplicate,
}: RuleEditorProps) {
  const isEdit = editingRule !== null;
  const resolvedDefaultTable = editingRule?.table_id ?? defaultTableId ?? lastUsedTableId ?? (tables[0]?.id ?? 0);

  const [tableId, setTableId]       = useState<number>(resolvedDefaultTable);
  const [dimension, setDimension]   = useState<QualityDimension>(editingRule?.dimension ?? defaultDimension ?? 'completeness');
  const [ruleType, setRuleType]     = useState<string>(editingRule?.rule_type ?? 'not_null');
  const [columnName, setColumnName] = useState<string>(editingRule?.column_name ?? '');
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [name, setName]             = useState<string>(editingRule?.name ?? '');
  const [severity, setSeverity]     = useState<QualitySeverity>(editingRule?.severity ?? 'warning');
  const [enabled, setEnabled]       = useState<boolean>(editingRule?.enabled ?? true);
  const [config, setConfig]         = useState<QualityRuleConfig>(editingRule?.config ?? {});
  const [nameEdited, setNameEdited] = useState<boolean>(isEdit);
  const [showIntentCards, setShowIntentCards] = useState<boolean>(false);
  const [showAiAssistant, setShowAiAssistant] = useState<boolean>(false);
  const [showBulkPicker, setShowBulkPicker] = useState<boolean>(false);
  const [showNameEditor, setShowNameEditor] = useState<boolean>(isEdit);
  const [dimExpanded, setDimExpanded] = useState<boolean>(false);
  // When editing, dimension is already chosen by the user, so it counts as
  // "touched". In create mode the auto-suggest kicks in until they click one.
  const [dimensionTouched, setDimensionTouched] = useState<boolean>(isEdit || Boolean(defaultDimension));

  // Live preview state
  const [preview, setPreview] = useState<RulePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreviewSql, setShowPreviewSql] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createMutation = useCreateQualityRule(datasetId);
  const updateMutation = useUpdateQualityRule(datasetId);
  const bulkCreateMutation = useBulkCreateQualityRules(datasetId);

  const dimDef_ = dimDef(dimension);
  const rtDef   = getRuleTypeDef(ruleType);
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

  // Debounced live preview
  const fetchPreview = useCallback(async () => {
    if (!tableId || !ruleType) { setPreview(null); return; }
    setPreviewLoading(true);
    try {
      const res = await api.post<RulePreviewResult>(
        `/datasets/${datasetId}/quality/rules/preview`,
        { table_id: tableId, rule_type: ruleType, column_name: columnName || null, config },
      );
      setPreview(res.data);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [datasetId, tableId, ruleType, columnName, config]);

  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(fetchPreview, 500);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [fetchPreview]);

  function patchConfig(partial: Partial<QualityRuleConfig>) {
    setConfig((prev) => ({ ...prev, ...partial }));
  }

  // Dimension is an independent semantic label after the 2026-04 decoupling.
  // Changing it no longer resets the rule type or its config.
  function switchDimension(d: QualityDimension) {
    setDimension(d);
    setDimensionTouched(true);
  }

  function switchRuleType(rt: string) {
    const nextRuleDef = getRuleTypeDef(rt);
    setRuleType(rt);
    setConfig({});
    if (!ruleUsesColumn(nextRuleDef)) {
      setColumnName('');
      setColumnNames([]);
    }
    // Auto-suggest natural dimension only when the user has not manually
    // overridden it yet — keeps the default path ergonomic without locking
    // advanced users out.
    if (!dimensionTouched) {
      const natural = getNaturalDimension(rt);
      if (natural) setDimension(natural);
    }
  }

  function handleIntentSelect(intentRuleType: string, intentDimension: QualityDimension) {
    switchRuleType(intentRuleType);
    setDimension(intentDimension);
    setDimensionTouched(true);
    setShowIntentCards(false);
  }

  function handleAIApply(suggestion: QualityAISuggestResponse) {
    setRuleType(suggestion.rule_type);
    if (suggestion.dimension) setDimension(suggestion.dimension as QualityDimension);
    if (suggestion.column_name) setColumnName(suggestion.column_name);
    if (suggestion.config) setConfig(suggestion.config);
    if (suggestion.severity) setSeverity(suggestion.severity as QualitySeverity);
    if (suggestion.name) { setName(suggestion.name); setNameEdited(true); }
    setDimensionTouched(true);
    setShowIntentCards(false);
    setShowAiAssistant(false);
  }

  const bulkEligible = !isEdit && usesColumn && BULK_COLUMN_RULE_TYPES.has(ruleType);
  const bulkActive   = bulkEligible && columnNames.length > 1;
  const selectedTable = tables.find((t) => t.id === tableId);
  const selectedTableLabel = selectedTable?.display_name || selectedTable?.source_table_name || 'No table selected';
  const selectedColumns = columnNames.length > 0 ? columnNames : (columnName ? [columnName] : []);
  const selectedColumnCount = selectedColumns.length;
  const currentScopeLabel = usesColumn
    ? (selectedColumnCount > 1 ? `${selectedColumnCount} columns selected` : columnName || 'No column selected')
    : 'Whole table';

  useEffect(() => {
    if (!bulkEligible) setShowBulkPicker(false);
  }, [bulkEligible]);

  async function handleSave() {
    if (!tables.find((t) => t.id === tableId)) { toast.error('Select a table'); return; }
    if (bulkActive) {
      if (columnNames.length === 0) { toast.error('Select at least one column'); return; }
      try {
        const selectedTable = tables.find((t) => t.id === tableId);
        const tableLabel = selectedTable?.display_name || selectedTable?.source_table_name || '';
        const ruleLabel = rtDef?.label ?? ruleType;
        const items: QualityRuleCreate[] = columnNames.map((col) => ({
          table_id: tableId,
          column_name: col,
          dimension,
          rule_type: ruleType,
          name: `${tableLabel}: ${col} - ${ruleLabel}`,
          config,
          severity,
          enabled,
        }));
        const saved = await bulkCreateMutation.mutateAsync(items);
        toast.success(`Created ${saved.length} rule${saved.length === 1 ? '' : 's'}`);
        if (saved.length > 0) onSaved(saved[0]);
      } catch {
        toast.error('Failed to create rules');
      }
      return;
    }

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

  const isPending = createMutation.isPending || updateMutation.isPending || bulkCreateMutation.isPending;

  return (
    <>
      <div className="fixed inset-0 z-30 bg-overlay/84 backdrop-blur-[2px]" onClick={onClose} />

      <div className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-5 lg:p-8">
        <div className="flex h-full max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-[28px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-4 py-2 sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-brand shrink-0" />
              <h3 className="text-sm font-semibold text-text-primary">{isEdit ? 'Edit Quality Rule' : 'Create Quality Rule'}</h3>
              {isEdit && <span className="text-[11px] text-text-quaternary">#{editingRule!.id}</span>}
            </div>
            <button onClick={onClose} className="rounded-xl p-1.5 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-secondary">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-2 sm:px-5">
            <div className="grid gap-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div className="space-y-2">
                {/* ── Intent Cards (create mode only) ── */}
                {!isEdit && showIntentCards && (
                  <IntentCardsGrid onSelect={handleIntentSelect} />
                )}

                {/* ── AI Assistant (create mode only) ── */}
                {!isEdit && (
                  <AIRuleAssistant
                    datasetId={datasetId}
                    tableId={tableId}
                    tables={tables}
                    onApply={handleAIApply}
                  />
                )}

                <div className="space-y-2">
                  <SectionHeader title="Basic setup" helpText="Table, check type, and quality dimension." />
                  <div className="space-y-2">
                    <div>
                      <FieldLabel
                        label="Table"
                        helpText="Pick the table this rule should validate. In edit mode the table stays locked so previous runs remain consistent."
                      />
                      <TableSearchSelect
                        tables={tables}
                        value={tableId}
                        onChange={(value) => {
                          if (value === 'all') return;
                          setTableId(value);
                          setColumnName('');
                        }}
                        disabled={isEdit}
                      />
                    </div>

                    <div>
                      <FieldLabel
                        label="Rule Type"
                        helpText="Pick any rule type regardless of dimension. Search by name, keyword, or description. The dimension below is auto-suggested but you can override it freely."
                      />
                      <RuleTypeSearchSelect value={ruleType} onChange={switchRuleType} />
                    </div>

                    <div>
                      <FieldLabel
                        label="DQ Dimension"
                        helpText="Grouping label only — auto-suggested from rule type but you can override freely."
                      />
                      {/* Inline auto-suggested dimension with expandable override */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${dimDef_.bg} ${dimDef_.color}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${dimDef_.dot}`} />
                            {dimDef_.label}
                          </span>
                          {!dimensionTouched && (
                            <span className="text-[11px] text-text-quaternary">(auto-suggested)</span>
                          )}
                          <button
                            type="button"
                            onClick={() => setDimExpanded((v) => !v)}
                            className="text-[11px] font-medium text-brand hover:text-brand-hover"
                          >
                            {dimExpanded ? 'Hide' : 'Change'}
                          </button>
                        </div>
                        {dimExpanded && (
                          <div className="grid gap-1.5 grid-cols-4 lg:grid-cols-7">
                            {DQ_DIMENSIONS.map((d) => (
                              <button key={d.key}
                                title={d.description}
                                onClick={() => { switchDimension(d.key); setDimExpanded(false); }}
                                className={`rounded-xl border px-2 py-1.5 text-center transition-colors ${
                                  dimension === d.key
                                    ? `${d.bg} ${d.color} ${d.border}`
                                    : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                                }`}>
                                <span className="text-xs font-medium">{d.label}</span>
                              </button>
                            ))}
                            <button
                              title="Custom dimension — type your own label"
                              onClick={() => {
                                const custom = prompt('Enter custom dimension name:');
                                if (custom?.trim()) {
                                  setDimension(custom.trim().toLowerCase().replace(/\s+/g, '_') as QualityDimension);
                                  setDimensionTouched(true);
                                  setDimExpanded(false);
                                }
                              }}
                              className={`rounded-xl border px-2 py-1.5 text-center transition-colors ${
                                !DQ_DIMENSIONS.some((d) => d.key === dimension)
                                  ? 'bg-surface-3 text-text-primary border-[rgb(var(--border-strong))]'
                                  : 'border-dashed border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                              }`}
                            >
                              <span className="text-xs font-medium">
                                {!DQ_DIMENSIONS.some((d) => d.key === dimension) ? dimension : 'Other…'}
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <SectionHeader title="Rule logic" helpText="Scope and parameters for pass/fail evaluation." />
                  <div className="space-y-2">
                    {/* Contextual hint for rule type */}
                    {rtDef?.hint && (
                      <div className="flex items-start gap-2 rounded-xl border border-brand/20 bg-brand/5 px-3 py-2 text-[11px] leading-5 text-text-secondary">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                        <span>{rtDef.hint}</span>
                      </div>
                    )}

                    {/* For bulk-eligible types, always show multi-column picker */}
                    {usesColumn && bulkEligible ? (
                      <div>
                        <FieldLabel
                          label="Column(s)"
                          helpText="Select one column for a single rule, or multiple columns to create one rule per column (bulk)."
                        />
                        <MultiColumnPicker
                          tableId={tableId}
                          tables={tables}
                          value={columnNames.length > 0 ? columnNames : (columnName ? [columnName] : [])}
                          onChange={(cols) => {
                            setColumnNames(cols);
                            setColumnName(cols[0] ?? '');
                          }}
                        />
                        {columnNames.length > 1 && (
                          <p className="mt-1 text-[11px] text-brand font-medium">
                            → {columnNames.length} rules will be created (one per column)
                          </p>
                        )}
                      </div>
                    ) : usesColumn ? (
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
                    ) : null}

                    <ConfigFields ruleType={ruleType} config={config} onPatch={patchConfig} tableId={tableId} tables={tables} />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="space-y-2">
                  <SectionHeader title="Governance" helpText="Name, severity, execution status, and live preview." />
                  <div className="space-y-2">
                    <div>
                      <FieldLabel
                        label="Rule Name"
                        helpText="This name appears in the rule list, quality summaries, and run history. Keep it business-readable."
                        action={!bulkActive && name.trim() !== suggestedName ? (
                          <button
                            type="button"
                            onClick={() => { setName(suggestedName); setNameEdited(false); }}
                            className="text-[11px] font-medium text-brand hover:text-brand"
                          >
                            Use suggested
                          </button>
                        ) : undefined}
                      />
                      {bulkActive ? (
                        <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-[11px] text-text-tertiary" title="Each column gets its own rule with auto-generated name">
                          Auto-named per column: <span className="font-mono text-text-secondary">{`{table}: {col} - ${rtDef?.label ?? ruleType}`}</span>
                        </div>
                      ) : (
                        <>
                          <input type="text" value={name}
                            onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
                            className="w-full rounded-xl border border-[rgb(var(--border-line))] px-3 py-2 text-sm focus:border-brand/50 focus:outline-none" />
                        </>
                      )}
                    </div>

                    <div>
                      <FieldLabel
                        label="Severity"
                        helpText="Pick the right level for how strongly this rule should reduce trust when it fails."
                      />
                      <div className="flex flex-wrap gap-2">
                        {(['info', 'warning', 'error'] as QualitySeverity[]).map((s) => {
                          const meta = SEVERITY_META[s];
                          const Icon = meta.icon;
                          const selected = severity === s;
                          return (
                            <button key={s} onClick={() => setSeverity(s)}
                              title={meta.description}
                              className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                selected
                                  ? `${meta.bgColor} ${meta.textColor} border-current`
                                  : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                              }`}>
                              <Icon className="h-3.5 w-3.5 shrink-0" />
                              <span>{meta.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {SEVERITY_META[severity] && (
                        <p className="text-[11px] text-text-quaternary mt-0.5">{SEVERITY_META[severity].description}</p>
                      )}
                    </div>

                    <label className="flex cursor-pointer items-center justify-between rounded-xl border border-[rgb(var(--border-line))] px-3 py-2">
                      <span className="text-xs font-medium text-text-secondary" title="Only enabled rules run during quality checks">Enabled</span>
                      <InlineToggle checked={enabled} onChange={setEnabled} />
                    </label>
                  </div>
                  <div className="space-y-2 border-t border-[rgb(var(--border-line))] pt-2">
                    <SectionHeader title="Live preview" helpText="See the generated SQL, then run a live test before saving if needed." icon={Eye} />
                  {previewLoading ? (
                    <div className="flex items-center gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-text-quaternary" />
                      <span className="text-xs text-text-quaternary">Generating preview…</span>
                    </div>
                  ) : preview ? (
                    <div className="space-y-2">
                      <div className="rounded-xl border border-success/30 bg-success/5 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-success">✓ Pass</p>
                        <p className="mt-0.5 text-xs text-text-primary">{preview.pass_description}</p>
                      </div>
                      <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-danger">✗ Fail</p>
                        <p className="mt-0.5 text-xs text-text-primary">{preview.fail_description}</p>
                      </div>
                      {preview.scope_description && (
                        <p className="text-[11px] text-text-quaternary">{preview.scope_description}</p>
                      )}
                      {preview.sql && (
                        <div className="mt-1">
                          <button
                            type="button"
                            onClick={() => setShowPreviewSql((v) => !v)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-text-tertiary hover:text-text-secondary"
                          >
                            <Code className="h-3 w-3" />
                            {showPreviewSql ? 'Hide SQL' : 'Show SQL'}
                          </button>
                          {showPreviewSql && (
                            <pre className="mt-1 overflow-x-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 font-mono text-[11px] leading-5 text-text-secondary">
                              {preview.sql}
                            </pre>
                          )}
                        </div>
                      )}
                      {preview.error && (
                        <p className="text-[11px] text-warning">{preview.error}</p>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3 text-xs text-text-quaternary">
                      Select a rule type and configure it to see a preview.
                    </div>
                  )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-[rgb(var(--border-line))] px-4 py-2 sm:px-5">
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
                  {isEdit
                    ? 'Update Rule'
                    : bulkActive
                      ? `Create ${columnNames.length} rule${columnNames.length === 1 ? '' : 's'}`
                      : 'Create Rule'}
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
// Rule Editor Modal (Compact Builder)
// ---------------------------------------------------------------------------

function RuleEditorDrawer({
  datasetId, tables, existingRules, editingRule, defaultTableId, lastUsedTableId, defaultDimension, onClose, onSaved, onDuplicate,
}: RuleEditorProps) {
  const isEdit = editingRule !== null;
  const resolvedDefaultTable = editingRule?.table_id ?? defaultTableId ?? lastUsedTableId ?? (tables[0]?.id ?? 0);

  const [tableId, setTableId] = useState<number>(resolvedDefaultTable);
  const [dimension, setDimension] = useState<QualityDimension>(editingRule?.dimension ?? defaultDimension ?? 'completeness');
  const [ruleType, setRuleType] = useState<string>(editingRule?.rule_type ?? 'not_null');
  const [columnName, setColumnName] = useState<string>(editingRule?.column_name ?? '');
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [name, setName] = useState<string>(editingRule?.name ?? '');
  const [severity, setSeverity] = useState<QualitySeverity>(editingRule?.severity ?? 'warning');
  const [enabled, setEnabled] = useState<boolean>(editingRule?.enabled ?? true);
  const [config, setConfig] = useState<QualityRuleConfig>(editingRule?.config ?? {});
  const [nameEdited, setNameEdited] = useState<boolean>(isEdit);
  const [showIntentCards, setShowIntentCards] = useState<boolean>(false);
  const [showAiAssistant, setShowAiAssistant] = useState<boolean>(false);
  const [showBulkPicker, setShowBulkPicker] = useState<boolean>(false);
  const [showNameEditor, setShowNameEditor] = useState<boolean>(isEdit);
  const [dimExpanded, setDimExpanded] = useState<boolean>(false);
  const [dimensionTouched, setDimensionTouched] = useState<boolean>(isEdit || Boolean(defaultDimension));
  const [preview, setPreview] = useState<RulePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreviewSql, setShowPreviewSql] = useState(false);
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createMutation = useCreateQualityRule(datasetId);
  const updateMutation = useUpdateQualityRule(datasetId);
  const bulkCreateMutation = useBulkCreateQualityRules(datasetId);

  const dimDef_ = dimDef(dimension);
  const rtDef = getRuleTypeDef(ruleType);
  const usesColumn = ruleUsesColumn(rtDef);
  const bulkEligible = !isEdit && usesColumn && BULK_COLUMN_RULE_TYPES.has(ruleType);
  const bulkActive = bulkEligible && columnNames.length > 1;
  const selectedTable = tables.find((t) => t.id === tableId);
  const selectedTableLabel = selectedTable?.display_name || selectedTable?.source_table_name || 'No table selected';
  const selectedColumns = columnNames.length > 0 ? columnNames : (columnName ? [columnName] : []);
  const selectedColumnCount = selectedColumns.length;
  const currentScopeLabel = usesColumn
    ? (selectedColumnCount > 1 ? `${selectedColumnCount} columns selected` : columnName || 'No column selected')
    : 'Whole table';
  const suggestedName = useMemo(
    () => buildSuggestedRuleName(tables, tableId, rtDef, ruleType, columnName),
    [tables, tableId, rtDef, ruleType, columnName],
  );
  const findConflict = useCallback((targetTableId: number, targetColumnName?: string) => {
    return findEquivalentQualityRule({
      rules: existingRules,
      tableId: targetTableId,
      columnName: targetColumnName,
      ruleType,
      config,
      excludeRuleId: isEdit ? editingRule!.id : undefined,
    });
  }, [config, editingRule, existingRules, isEdit, ruleType]);

  useEffect(() => {
    if (nameEdited || name.trim()) return;
    setName(suggestedName);
  }, [name, nameEdited, suggestedName]);

  const fetchPreview = useCallback(async () => {
    if (!tableId || !ruleType) { setPreview(null); return; }
    setPreviewLoading(true);
    try {
      const res = await api.post<RulePreviewResult>(
        `/datasets/${datasetId}/quality/rules/preview`,
        { table_id: tableId, rule_type: ruleType, column_name: columnName || null, config },
      );
      setPreview(res.data);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [datasetId, tableId, ruleType, columnName, config]);

  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(fetchPreview, 500);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [fetchPreview]);

  useEffect(() => {
    if (!bulkEligible) setShowBulkPicker(false);
  }, [bulkEligible]);

  useEffect(() => {
    setTestResult(null);
  }, [tableId, ruleType, columnName, config]);

  function patchConfig(partial: Partial<QualityRuleConfig>) {
    setConfig((prev) => ({ ...prev, ...partial }));
  }

  function switchDimension(d: QualityDimension) {
    setDimension(d);
    setDimensionTouched(true);
  }

  function switchRuleType(rt: string) {
    const nextRuleDef = getRuleTypeDef(rt);
    setRuleType(rt);
    setConfig({});
    if (!ruleUsesColumn(nextRuleDef)) {
      setColumnName('');
      setColumnNames([]);
    }
    if (!dimensionTouched) {
      const natural = getNaturalDimension(rt);
      if (natural) setDimension(natural);
    }
  }

  function handleIntentSelect(intentRuleType: string, intentDimension: QualityDimension) {
    switchRuleType(intentRuleType);
    setDimension(intentDimension);
    setDimensionTouched(true);
    setShowIntentCards(false);
  }

  function handleAIApply(suggestion: QualityAISuggestResponse) {
    setRuleType(suggestion.rule_type);
    if (suggestion.dimension) setDimension(suggestion.dimension as QualityDimension);
    if (suggestion.column_name) {
      setColumnName(suggestion.column_name);
      setColumnNames([suggestion.column_name]);
    }
    if (suggestion.config) setConfig(suggestion.config);
    if (suggestion.severity) setSeverity(suggestion.severity as QualitySeverity);
    if (suggestion.name) {
      setName(suggestion.name);
      setNameEdited(true);
      setShowNameEditor(true);
    }
    setDimensionTouched(true);
    setShowIntentCards(false);
    setShowAiAssistant(false);
    setShowBulkPicker(false);
  }

  const handleRunTest = useCallback(async () => {
    if (!tableId || !ruleType) {
      setTestResult(null);
      return;
    }

    setTestLoading(true);
    try {
      const res = await api.post<RuleTestResult>(
        `/datasets/${datasetId}/quality/rules/test`,
        { table_id: tableId, rule_type: ruleType, column_name: columnName || null, config },
      );
      setTestResult(res.data);
    } catch (error: any) {
      setTestResult({
        passed: false,
        rows_checked: null,
        rows_failed: null,
        detail: getRequestErrorMessage(error, 'Could not run test.'),
        sql: null,
        preview_sql: null,
        preview_note: null,
        preview_columns: [],
        preview_rows: [],
        log: [],
        elapsed_ms: null,
        skipped: false,
        error: true,
      });
    } finally {
      setTestLoading(false);
    }
  }, [datasetId, tableId, ruleType, columnName, config]);

  async function handleSave() {
    if (!tables.find((t) => t.id === tableId)) { toast.error('Select a table'); return; }
    if (bulkActive) {
      if (columnNames.length === 0) { toast.error('Select at least one column'); return; }
      const conflictingColumn = columnNames.find((col) => findConflict(tableId, col));
      if (conflictingColumn) {
        const conflict = findConflict(tableId, conflictingColumn);
        toast.error(conflict ? `An equivalent quality rule already exists: ${conflict.name}` : 'An equivalent quality rule already exists.');
        return;
      }
      try {
        const currentTable = tables.find((t) => t.id === tableId);
        const tableLabel = currentTable?.display_name || currentTable?.source_table_name || '';
        const ruleLabel = rtDef?.label ?? ruleType;
        const items: QualityRuleCreate[] = columnNames.map((col) => ({
          table_id: tableId,
          column_name: col,
          dimension,
          rule_type: ruleType,
          name: `${tableLabel}: ${col} - ${ruleLabel}`,
          config,
          severity,
          enabled,
        }));
        const saved = await bulkCreateMutation.mutateAsync(items);
        toast.success(`Created ${saved.length} rule${saved.length === 1 ? '' : 's'}`);
        if (saved.length > 0) onSaved(saved[0]);
      } catch (error: any) {
        toast.error(getRequestErrorMessage(error, 'Failed to create rules'));
      }
      return;
    }

    if (!name.trim()) { toast.error('Rule name is required'); return; }
    const nextColumnName = usesColumn ? columnName.trim() || undefined : undefined;
    const conflict = findConflict(tableId, nextColumnName);
    if (conflict) {
      toast.error(`An equivalent quality rule already exists: ${conflict.name}`);
      return;
    }
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
          table_id: tableId,
          column_name: nextColumnName,
          dimension,
          rule_type: ruleType,
          name: name.trim(),
          config,
          severity,
          enabled,
        });
        toast.success('Rule created');
      }
      onSaved(saved);
    } catch (error: any) {
      toast.error(getRequestErrorMessage(error, 'Failed to save rule'));
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending || bulkCreateMutation.isPending;
  const testStatus = useMemo(() => {
    if (!testResult) return null;
    if (testResult.skipped) {
      return {
        label: 'Skipped',
        badgeClass: 'bg-surface-2 text-text-tertiary',
        detailClass: 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary',
      };
    }
    if (testResult.error) {
      return {
        label: 'Error',
        badgeClass: 'bg-danger/10 text-danger',
        detailClass: 'border-danger/30 bg-danger/5 text-danger',
      };
    }
    if (testResult.passed) {
      return {
        label: 'Pass',
        badgeClass: 'bg-success/10 text-success',
        detailClass: 'border-success/20 bg-success/5 text-text-secondary',
      };
    }
    return {
      label: 'Fail',
      badgeClass: 'bg-warning/10 text-warning',
      detailClass: 'border-warning/20 bg-warning/10 text-text-secondary',
    };
  }, [testResult]);

  return (
    <>
      <div className="fixed inset-0 z-30 bg-overlay/84 backdrop-blur-[2px]" onClick={onClose} />

      <div className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-5 lg:p-8">
        <div className="flex h-full max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-[28px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-4 py-2 sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-brand" />
              <h3 className="text-sm font-semibold text-text-primary">{isEdit ? 'Edit Quality Rule' : 'Create Quality Rule'}</h3>
              {isEdit && <span className="text-[11px] text-text-quaternary">#{editingRule!.id}</span>}
            </div>
            <button onClick={onClose} className="rounded-xl p-1.5 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-text-secondary">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-2 sm:px-5">
            <div className="sticky top-0 z-10 mb-3 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-3.5 shadow-linear-sm">
              <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-6">
                <div className="min-w-0 md:col-span-1 xl:col-span-2">
                  <FieldLabel
                    label="Table"
                    helpText="Pick the table this rule should validate. In edit mode the table stays locked so previous runs remain consistent."
                  />
                  <TableSearchSelect
                    tables={tables}
                    value={tableId}
                    onChange={(value) => {
                      if (value === 'all') return;
                      setTableId(value);
                      setColumnName('');
                      setColumnNames([]);
                    }}
                    disabled={isEdit}
                  />
                </div>

                <div className="min-w-0 md:col-span-1 xl:col-span-2">
                  <FieldLabel
                    label="Rule Type"
                    helpText="Pick any rule type regardless of dimension. Search by name, keyword, or description."
                  />
                  <RuleTypeSearchSelect value={ruleType} onChange={switchRuleType} />
                </div>

                {usesColumn && (
                  <div className="min-w-0 md:col-span-2 xl:col-span-2">
                    <FieldLabel
                      label={rtDef?.level === 'both' ? 'Column (optional)' : 'Column'}
                      helpText={bulkEligible
                        ? 'Choose one column here for the common case, or open bulk select to create one rule per column.'
                        : rtDef?.level === 'both'
                          ? 'Choose a column when this rule should narrow the check to one field. Leave it empty if the rule should evaluate the whole table.'
                          : 'Choose the column this rule validates inside the selected table.'}
                      action={bulkEligible ? (
                        <button
                          type="button"
                          onClick={() => {
                            setShowBulkPicker((v) => !v);
                            setShowIntentCards(false);
                            setShowAiAssistant(false);
                          }}
                          className="text-[11px] font-medium text-brand hover:text-brand-hover"
                        >
                          {showBulkPicker ? 'Hide bulk' : 'Bulk select'}
                        </button>
                      ) : undefined}
                    />
                    <ColumnSelector
                      tableId={tableId}
                      tables={tables}
                      value={columnName}
                      onChange={(v) => {
                        setColumnName(v);
                        if (bulkEligible) setColumnNames(v ? [v] : []);
                      }}
                      placeholder="column_name"
                    />
                    {bulkEligible && selectedColumnCount > 1 && (
                      <p className="mt-1 text-[11px] text-brand">{selectedColumnCount} columns selected.</p>
                    )}
                  </div>
                )}

                <div className="min-w-0 md:col-span-1 xl:col-span-1">
                  <FieldLabel
                    label="Severity"
                    helpText="Pick the right level for how strongly this rule should reduce trust when it fails."
                  />
                  <div className="flex flex-wrap gap-2">
                    {(['info', 'warning', 'error'] as QualitySeverity[]).map((s) => {
                      const meta = SEVERITY_META[s];
                      const Icon = meta.icon;
                      const selected = severity === s;
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setSeverity(s)}
                          title={meta.description}
                          className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                            selected
                              ? `${meta.bgColor} ${meta.textColor} border-current`
                              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span>{meta.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="min-w-0 md:col-span-1 xl:col-span-1">
                  <FieldLabel
                    label="Enabled"
                    helpText="Only enabled rules run during quality checks."
                  />
                  <div className="flex h-[42px] items-center justify-between rounded-xl border border-[rgb(var(--border-line))] px-3">
                    <span className="text-xs font-medium text-text-secondary">{enabled ? 'On' : 'Off'}</span>
                    <InlineToggle checked={enabled} onChange={setEnabled} />
                  </div>
                </div>
              </div>

              <div className="mt-3 border-t border-[rgb(var(--border-line))] pt-3">
                <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-quaternary">Dimension</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${dimDef_.bg} ${dimDef_.color}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${dimDef_.dot}`} />
                      {dimDef_.label}
                    </span>
                    {!dimensionTouched && (
                      <span className="text-[11px] text-text-quaternary">Auto-suggested</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setDimExpanded((v) => !v)}
                      className="text-[11px] font-medium text-brand hover:text-brand-hover"
                    >
                      {dimExpanded ? 'Hide dimensions' : 'Change dimension'}
                    </button>
                  </div>

                  {!isEdit && (
                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setShowIntentCards((v) => !v);
                          setShowAiAssistant(false);
                          setShowBulkPicker(false);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          showIntentCards
                            ? 'border-brand/40 bg-brand/10 text-brand'
                            : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
                        }`}
                      >
                        <Wand2 className="h-3.5 w-3.5" />
                        Templates
                      </button>
                      <AiButton
                        size="md"
                        onClick={() => {
                          setShowAiAssistant((v) => !v);
                          setShowIntentCards(false);
                          setShowBulkPicker(false);
                        }}
                        className={showAiAssistant ? 'border-brand/40 bg-brand/20' : undefined}
                      >
                        Suggest with AI
                      </AiButton>
                    </div>
                  )}
                </div>
              </div>

              {dimExpanded && (
                <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                  {DQ_DIMENSIONS.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      title={d.description}
                      onClick={() => { switchDimension(d.key); setDimExpanded(false); }}
                      className={`rounded-xl border px-2 py-1.5 text-center transition-colors ${
                        dimension === d.key
                          ? `${d.bg} ${d.color} ${d.border}`
                          : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                      }`}
                    >
                      <span className="text-xs font-medium">{d.label}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    title="Custom dimension - type your own label"
                    onClick={() => {
                      const custom = prompt('Enter custom dimension name:');
                      if (custom?.trim()) {
                        setDimension(custom.trim().toLowerCase().replace(/\s+/g, '_') as QualityDimension);
                        setDimensionTouched(true);
                        setDimExpanded(false);
                      }
                    }}
                    className={`rounded-xl border px-2 py-1.5 text-center transition-colors ${
                      !DQ_DIMENSIONS.some((d) => d.key === dimension)
                        ? 'border-[rgb(var(--border-strong))] bg-surface-3 text-text-primary'
                        : 'border-dashed border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                    }`}
                  >
                    <span className="text-xs font-medium">
                      {!DQ_DIMENSIONS.some((d) => d.key === dimension) ? dimension : 'Other...'}
                    </span>
                  </button>
                </div>
              )}

              {bulkEligible && showBulkPicker && (
                <div className="mt-2 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-2.5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <SectionHeader
                      title="Bulk columns"
                      helpText="Select multiple columns to create one rule per column with the same configuration."
                    />
                    {selectedColumnCount > 0 && (
                      <span className="text-[11px] text-text-quaternary">{selectedColumnCount} selected</span>
                    )}
                  </div>
                  <MultiColumnPicker
                    tableId={tableId}
                    tables={tables}
                    value={selectedColumns}
                    onChange={(cols) => {
                      setColumnNames(cols);
                      setColumnName(cols[0] ?? '');
                    }}
                  />
                  {selectedColumnCount > 1 && (
                    <p className="mt-1 text-[11px] text-brand">
                      Create {selectedColumnCount} rules. The logic below applies to each selected column.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
              <div className="min-w-0 space-y-3">
                {!isEdit && showIntentCards && (
                  <IntentCardsGrid onSelect={handleIntentSelect} />
                )}

                {!isEdit && showAiAssistant && (
                  <AIRuleAssistant
                    datasetId={datasetId}
                    tableId={tableId}
                    tables={tables}
                    onApply={handleAIApply}
                  />
                )}

                <div className="space-y-2 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-3 shadow-linear-sm">
                  <SectionHeader title="Rule logic" helpText="Scope and parameters for pass/fail evaluation." />
                  {rtDef?.hint && (
                    <div className="flex items-start gap-2 rounded-xl border border-brand/20 bg-brand/5 px-3 py-2 text-[11px] leading-5 text-text-secondary">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                      <span>{rtDef.hint}</span>
                    </div>
                  )}
                  {bulkEligible && selectedColumnCount > 1 && (
                    <div className="rounded-xl border border-brand/20 bg-brand/5 px-3 py-2 text-[11px] text-text-secondary">
                      This configuration will be reused for all {selectedColumnCount} selected columns.
                    </div>
                  )}
                  <ConfigFields ruleType={ruleType} config={config} onPatch={patchConfig} tableId={tableId} tables={tables} />
                </div>
              </div>

              <div className="min-w-0 self-start xl:sticky xl:top-[9rem]">
                <div className="min-w-0 space-y-2 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-3 shadow-linear-sm xl:max-h-[calc(94vh-12rem)] xl:overflow-auto">
                  <SectionHeader title="Review" helpText="Preview the rule before saving." icon={Eye} />

                  <div className="flex flex-wrap gap-1.5">
                    <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">
                      {selectedTableLabel}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">
                      {rtDef?.label ?? ruleType}
                    </span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${dimDef_.bg} ${dimDef_.color}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${dimDef_.dot}`} />
                      {dimDef_.label}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">
                      {currentScopeLabel}
                    </span>
                  </div>

                  <div className="space-y-2 border-t border-[rgb(var(--border-line))] pt-2">
                    <FieldLabel
                      label="Rule Name"
                      helpText="This name appears in the rule list, quality summaries, and run history."
                      action={!bulkActive ? (
                        <div className="flex items-center gap-2">
                          {!showNameEditor ? (
                            <button
                              type="button"
                              onClick={() => setShowNameEditor(true)}
                              className="text-[11px] font-medium text-brand hover:text-brand-hover"
                            >
                              Rename
                            </button>
                          ) : (
                            <>
                              {name.trim() !== suggestedName && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setName(suggestedName);
                                    setNameEdited(false);
                                  }}
                                  className="text-[11px] font-medium text-brand hover:text-brand-hover"
                                >
                                  Use suggested
                                </button>
                              )}
                              {!isEdit && (
                                <button
                                  type="button"
                                  onClick={() => setShowNameEditor(false)}
                                  className="text-[11px] font-medium text-text-tertiary hover:text-text-secondary"
                                >
                                  Hide
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      ) : undefined}
                    />
                    {bulkActive ? (
                      <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-[11px] text-text-tertiary">
                        Auto-named per column: <span className="font-mono text-text-secondary">{`{table}: {col} - ${rtDef?.label ?? ruleType}`}</span>
                      </div>
                    ) : showNameEditor ? (
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setNameEdited(true);
                        }}
                        className="w-full rounded-xl border border-[rgb(var(--border-line))] px-3 py-2 text-sm focus:border-brand/50 focus:outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowNameEditor(true)}
                        className="w-full rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-1"
                      >
                        {name || suggestedName}
                      </button>
                    )}
                  </div>

                  <div className="space-y-2 border-t border-[rgb(var(--border-line))] pt-2">
                    <SectionHeader title="Live preview" helpText="See the generated SQL, then run a live test before saving if needed." icon={Eye} />
                    {previewLoading ? (
                      <div className="flex items-center gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-text-quaternary" />
                        <span className="text-xs text-text-quaternary">Generating preview...</span>
                      </div>
                    ) : preview ? (
                      <div className="space-y-2">
                        <div className="rounded-xl border border-success/30 bg-success/5 px-3 py-2">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-success">Pass</p>
                          <p className="mt-0.5 text-xs text-text-primary">{preview.pass_description}</p>
                        </div>
                        <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-danger">Fail</p>
                          <p className="mt-0.5 text-xs text-text-primary">{preview.fail_description}</p>
                        </div>
                        {preview.scope_description && (
                          <p className="text-[11px] text-text-quaternary">{preview.scope_description}</p>
                        )}
                        {preview.sql && (
                          <div className="mt-1">
                            <button
                              type="button"
                              onClick={() => setShowPreviewSql((v) => !v)}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-text-tertiary hover:text-text-secondary"
                            >
                              <Code className="h-3 w-3" />
                              {showPreviewSql ? 'Hide SQL' : 'Show SQL'}
                            </button>
                            {showPreviewSql && (
                              <pre className="mt-1 overflow-x-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 font-mono text-[11px] leading-5 text-text-secondary">
                                {preview.sql}
                              </pre>
                            )}
                          </div>
                        )}
                        {preview.error && (
                          <div className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-[11px] text-warning">
                            {preview.error}
                          </div>
                        )}

                        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-quaternary">Run test before save</p>
                              <p className="mt-1 text-xs text-text-secondary">
                                {ruleType === 'custom_sql'
                                  ? 'Execute this custom SQL on the current table to surface syntax/runtime errors and preview failing output before you create the rule.'
                                  : 'Execute this rule on live data to verify counts and inspect the failing output before you create the rule.'}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={handleRunTest}
                              disabled={testLoading || !tableId || !ruleType}
                              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {testLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                              {testLoading ? 'Running test...' : 'Run test'}
                            </button>
                          </div>

                          {testResult ? (
                            <div className="mt-3 space-y-3 border-t border-[rgb(var(--border-line))] pt-3">
                              <div className="flex flex-wrap items-center gap-2">
                                {testStatus && (
                                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${testStatus.badgeClass}`}>
                                    {testStatus.label}
                                  </span>
                                )}
                                {testResult.elapsed_ms != null && (
                                  <span className="text-[11px] text-text-quaternary">{testResult.elapsed_ms} ms</span>
                                )}
                              </div>

                              <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
                                <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                                  <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Rows Checked</p>
                                  <p className="mt-1 text-sm font-semibold text-text-primary">{formatMetricCount(testResult.rows_checked)}</p>
                                </div>
                                <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                                  <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Rows Failed</p>
                                  <p className="mt-1 text-sm font-semibold text-text-primary">{formatMetricCount(testResult.rows_failed)}</p>
                                </div>
                                <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                                  <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Preview Output</p>
                                  <p className="mt-1 text-sm font-semibold text-text-primary">
                                    {testResult.preview_rows?.length ? `${testResult.preview_rows.length} row(s)` : '—'}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                                  <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Preview Query</p>
                                  <p className="mt-1 text-sm font-semibold text-text-primary">{testResult.preview_sql ? 'Available' : '—'}</p>
                                </div>
                              </div>

                              {testResult.detail && testStatus && (
                                <div className={`rounded-lg border px-3 py-2 ${testStatus.detailClass}`}>
                                  {testResult.error ? (
                                    <div className="flex items-start gap-2">
                                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                      <div className="min-w-0 flex-1">
                                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em]">Database / execution error</p>
                                        <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-danger/10 px-2 py-1.5 text-xs font-mono text-danger">
                                          {testResult.detail}
                                        </pre>
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="text-sm">{testResult.detail}</p>
                                  )}
                                </div>
                              )}

                              {testResult.preview_note && (
                                <div className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-text-secondary">
                                  {testResult.preview_note}
                                </div>
                              )}

                              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                  <div className="min-w-0">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">Output Preview</p>
                                    <p className="mt-1 text-xs text-text-secondary">
                                      {testResult.preview_rows?.length
                                        ? `Showing ${testResult.preview_rows.length} row(s) from the live test output.`
                                        : 'No output rows are available for this test yet.'}
                                    </p>
                                  </div>
                                  {testResult.preview_rows?.length ? (
                                    <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                                      first {testResult.preview_rows.length} rows
                                    </span>
                                  ) : null}
                                </div>

                                {testResult.preview_rows && testResult.preview_rows.length > 0 ? (
                                  <div className="mt-3 overflow-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
                                    <table className="min-w-full divide-y divide-[rgb(var(--border-line))] text-left text-xs">
                                      <thead className="bg-surface-2">
                                        <tr>
                                          {(testResult.preview_columns && testResult.preview_columns.length > 0
                                            ? testResult.preview_columns
                                            : Object.keys(testResult.preview_rows[0] ?? {})
                                          ).map((column) => (
                                            <th key={column} className="whitespace-nowrap px-3 py-2 font-semibold text-text-secondary">
                                              {column}
                                            </th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                                        {testResult.preview_rows.map((row, rowIndex) => {
                                          const columns = testResult.preview_columns && testResult.preview_columns.length > 0
                                            ? testResult.preview_columns
                                            : Object.keys(row ?? {});
                                          return (
                                            <tr key={`test-preview-${rowIndex}`}>
                                              {columns.map((column) => (
                                                <td key={`test-preview-${rowIndex}-${column}`} className="max-w-[240px] whitespace-pre-wrap break-words px-3 py-2 align-top text-text-primary">
                                                  {formatPreviewCellValue(row?.[column])}
                                                </td>
                                              ))}
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <div className="mt-3 rounded-lg border border-dashed border-[rgb(var(--border-line))] bg-surface-1 px-3 py-4 text-sm text-text-tertiary">
                                    {testResult.preview_note || 'This test run did not return output rows to preview.'}
                                  </div>
                                )}
                              </div>

                              {testResult.sql && (
                                <details className="group rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
                                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary">
                                    <span>Check SQL</span>
                                    <span className="text-[11px] text-text-quaternary">Click to expand/collapse</span>
                                  </summary>
                                  <div className="border-t border-[rgb(var(--border-line))] px-3 py-3">
                                    <pre className="max-h-56 overflow-auto rounded-lg bg-surface-inverse p-3 font-mono text-xs leading-relaxed text-success whitespace-pre-wrap break-all">
                                      {testResult.sql}
                                    </pre>
                                  </div>
                                </details>
                              )}

                              {testResult.preview_sql && (
                                <details className="group rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
                                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary">
                                    <span>Output SQL</span>
                                    <span className="text-[11px] text-text-quaternary">Click to expand/collapse</span>
                                  </summary>
                                  <div className="border-t border-[rgb(var(--border-line))] px-3 py-3">
                                    <pre className="max-h-56 overflow-auto rounded-lg bg-surface-inverse p-3 font-mono text-xs leading-relaxed text-success whitespace-pre-wrap break-all">
                                      {testResult.preview_sql}
                                    </pre>
                                  </div>
                                </details>
                              )}

                              {testResult.log && testResult.log.length > 0 && (
                                <details className="group rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
                                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary">
                                    <span>Execution log</span>
                                    <span className="text-[11px] text-text-quaternary">Click to expand/collapse</span>
                                  </summary>
                                  <div className="border-t border-[rgb(var(--border-line))] px-3 py-3">
                                    <pre className="max-h-64 overflow-auto rounded-lg bg-surface-inverse p-3 font-mono text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all">
                                      {testResult.log.join('\n')}
                                    </pre>
                                  </div>
                                </details>
                              )}
                            </div>
                          ) : (
                            <div className="mt-3 rounded-lg border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-4 text-sm text-text-tertiary">
                              Run a live test to validate the rule and preview the output before saving.
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3 text-xs text-text-quaternary">
                        Select a rule type and configure it to see a preview.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-[rgb(var(--border-line))] px-4 py-2 sm:px-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                {isEdit && onDuplicate && (
                  <button
                    onClick={() => onDuplicate(editingRule!)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[rgb(var(--border-line))] px-3 py-2 text-xs text-text-secondary hover:bg-surface-2"
                  >
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </button>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  onClick={onClose}
                  className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={isPending}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                >
                  {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {isEdit
                    ? 'Update Rule'
                    : bulkActive
                      ? `Create ${columnNames.length} rule${columnNames.length === 1 ? '' : 's'}`
                      : 'Create Rule'}
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
    preview_sql?: string | null;
    preview_note?: string | null;
    preview_columns?: string[] | null;
    preview_rows?: Array<Record<string, unknown>> | null;
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

function formatPreviewCellValue(value: unknown): string {
  if (value == null) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
  const [detailTab, setDetailTab] = useState<'output' | 'technical'>('output');

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
        (e.result.preview_note || '').toLowerCase().includes(q) ||
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
                    onClick={() => {
                      setExpandedId(isExpanded ? null : entry.ruleId);
                      setDetailTab('output');
                    }}
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
                          <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-1">
                            <button
                              type="button"
                              onClick={() => setDetailTab('output')}
                              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                detailTab === 'output'
                                  ? 'bg-brand/10 text-brand'
                                  : 'text-text-tertiary hover:bg-surface-2 hover:text-text-secondary'
                              }`}
                            >
                              Output
                            </button>
                            <button
                              type="button"
                              onClick={() => setDetailTab('technical')}
                              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                detailTab === 'technical'
                                  ? 'bg-brand/10 text-brand'
                                  : 'text-text-tertiary hover:bg-surface-2 hover:text-text-secondary'
                              }`}
                            >
                              Technical log
                            </button>
                          </div>

                          {detailTab === 'output' ? (
                            <>
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

                              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">Query Output</p>
                                    <p className="mt-1 text-sm text-text-secondary">
                                      {entry.result.preview_rows?.length
                                        ? `Showing ${entry.result.preview_rows.length} preview row(s) from the failure output.`
                                        : 'No preview rows are available for this rule yet.'}
                                    </p>
                                  </div>
                                  {entry.result.preview_rows?.length ? (
                                    <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                                      first {entry.result.preview_rows.length} rows
                                    </span>
                                  ) : null}
                                </div>

                                {entry.result.preview_note && (
                                  <div className="mt-3 rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-text-secondary">
                                    {entry.result.preview_note}
                                  </div>
                                )}

                                {entry.result.preview_rows && entry.result.preview_rows.length > 0 ? (
                                  <div className="mt-3 overflow-auto rounded-lg border border-[rgb(var(--border-line))]">
                                    <table className="min-w-full divide-y divide-[rgb(var(--border-line))] text-left text-xs">
                                      <thead className="bg-surface-2">
                                        <tr>
                                          {(entry.result.preview_columns && entry.result.preview_columns.length > 0
                                            ? entry.result.preview_columns
                                            : Object.keys(entry.result.preview_rows[0] ?? {})
                                          ).map((column) => (
                                            <th key={column} className="whitespace-nowrap px-3 py-2 font-semibold text-text-secondary">
                                              {column}
                                            </th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                                        {entry.result.preview_rows.map((row, rowIndex) => {
                                          const columns = entry.result.preview_columns && entry.result.preview_columns.length > 0
                                            ? entry.result.preview_columns
                                            : Object.keys(row ?? {});
                                          return (
                                            <tr key={`${entry.ruleId}-${rowIndex}`}>
                                              {columns.map((column) => (
                                                <td key={`${entry.ruleId}-${rowIndex}-${column}`} className="max-w-[260px] whitespace-pre-wrap break-words px-3 py-2 align-top text-text-primary">
                                                  {formatPreviewCellValue(row?.[column])}
                                                </td>
                                              ))}
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <div className="mt-3 rounded-lg border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-4 text-sm text-text-tertiary">
                                    {entry.result.preview_note || 'This rule does not currently have preview rows to display.'}
                                  </div>
                                )}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="grid gap-2 sm:grid-cols-2">
                                <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                                  <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Rule Execution</p>
                                  <p className="mt-1 text-sm font-semibold text-text-primary">
                                    {entry.result.elapsed_ms != null ? `${entry.result.elapsed_ms} ms` : '—'}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                                  <p className="text-[10px] uppercase tracking-wide text-text-quaternary">Preview Query</p>
                                  <p className="mt-1 text-sm font-semibold text-text-primary">
                                    {entry.result.preview_sql ? 'available' : 'not available'}
                                  </p>
                                </div>
                              </div>

                              {entry.result.sql && (
                                <details className="group rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" open>
                                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary">
                                    <span>Check SQL</span>
                                    <span className="text-[11px] text-text-quaternary">Click to expand/collapse</span>
                                  </summary>
                                  <div className="border-t border-[rgb(var(--border-line))] px-3 py-3">
                                    <pre className="max-h-56 overflow-auto rounded-lg bg-surface-inverse p-3 font-mono text-xs leading-relaxed text-success whitespace-pre-wrap break-all">
                                      {entry.result.sql}
                                    </pre>
                                  </div>
                                </details>
                              )}

                              {entry.result.preview_sql && (
                                <details className="group rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
                                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-secondary">
                                    <span>Output Query</span>
                                    <span className="text-[11px] text-text-quaternary">Click to expand/collapse</span>
                                  </summary>
                                  <div className="border-t border-[rgb(var(--border-line))] px-3 py-3">
                                    <pre className="max-h-56 overflow-auto rounded-lg bg-surface-inverse p-3 font-mono text-xs leading-relaxed text-success whitespace-pre-wrap break-all">
                                      {entry.result.preview_sql}
                                    </pre>
                                  </div>
                                </details>
                              )}

                              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">Execution Log</p>
                                {entry.result.log && entry.result.log.length > 0 ? (
                                  <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-surface-inverse p-3 font-mono text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all">
                                    {entry.result.log.join('\n')}
                                  </pre>
                                ) : (
                                  <p className="mt-2 text-sm text-text-tertiary">No execution log captured for this rule.</p>
                                )}
                              </div>
                            </>
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
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      rule.severity === 'error' ? 'bg-danger' :
                      rule.severity === 'warning' ? 'bg-warning' : 'bg-brand'
                    }`}
                    title={sev.tooltip}
                  />

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
                        {getRuleTypeLabel(rule.rule_type)}
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

function DuplicateDialog({ rule, tables, existingRules, datasetId, onClose, onDone }: {
  rule: QualityRule;
  tables: DatasetTable[];
  existingRules: QualityRule[];
  datasetId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [targetTableId, setTargetTableId] = useState<number>(rule.table_id);
  const dupMutation = useDuplicateQualityRule(datasetId);

  async function handleDuplicate() {
    const conflict = findEquivalentQualityRule({
      rules: existingRules,
      tableId: targetTableId,
      columnName: rule.column_name ?? undefined,
      ruleType: rule.rule_type,
      config: rule.config ?? {},
    });
    if (conflict) {
      toast.error(`An equivalent quality rule already exists: ${conflict.name}`);
      return;
    }
    try {
      await dupMutation.mutateAsync({ ruleId: rule.id, targetTableId, nameSuffix: ' (copy)' });
      toast.success('Rule duplicated');
      onDone();
    } catch (error: any) {
      toast.error(getRequestErrorMessage(error, 'Failed to duplicate rule'));
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
          <TableSearchSelect tables={tables} value={targetTableId} onChange={(value) => value !== 'all' && setTargetTableId(value)} />
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
  const scopedTableId = tableFilter === 'all' ? undefined : tableFilter;

  // Editor state
  const [editorOpen, setEditorOpen]             = useState(false);
  const [editingRule, setEditingRule]           = useState<QualityRule | null>(null);
  const [editorDefaultDim, setEditorDefaultDim] = useState<QualityDimension | undefined>(undefined);
  const [lastUsedTableId, setLastUsedTableId]   = useState<number | undefined>(undefined);
  const [duplicatingRule, setDuplicatingRule]   = useState<QualityRule | null>(null);
  const [deletingRule, setDeletingRule]         = useState<QualityRule | null>(null);
  const [togglingIds, setTogglingIds]           = useState<Set<number>>(new Set());
  const [logModalOpen, setLogModalOpen]         = useState(false);
  const [logFocusRuleId, setLogFocusRuleId]     = useState<number | null>(null);
  const [reportModalOpen, setReportModalOpen]   = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);

  // Run state
  const [pollingRunId, setPollingRunId] = useState<number | null>(null);
  // Lưu kết quả run cuối để hiển thị sau khi xong
  const [lastRunResult, setLastRunResult] = useState<{ status: 'completed' | 'failed'; score?: number | null } | null>(null);

  // Data
  const { data: allRules = [], isLoading: loadingAllRules, error: allRulesError, refetch: refetchRules } = useQualityRules(datasetId);
  const { data: scopedRules = [], isLoading: loadingScopedRules, error: scopedRulesError } = useQualityRules(datasetId, scopedTableId);
  const { data: runs = [], refetch: refetchRuns } = useQualityRuns(datasetId);
  const { data: summary, refetch: refetchSummary } = useQualitySummary(datasetId);
  const { data: pollingRun } = useQualityRunPoll(datasetId, pollingRunId, pollingRunId !== null);
  const triggerRun     = useTriggerQualityRun(datasetId);
  const updateRule     = useUpdateQualityRule(datasetId);
  const deleteMutation = useDeleteQualityRule(datasetId);
  const loadingRules = loadingAllRules || (scopedTableId !== undefined && loadingScopedRules);
  const rulesError = allRulesError ?? scopedRulesError;
  const visibleSourceRules = scopedTableId !== undefined ? scopedRules : allRules;

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
  const filteredRules = useMemo(() => visibleSourceRules.filter((r) => {
    if (dimFilter !== 'all' && r.dimension !== dimFilter) return false;
    return true;
  }), [visibleSourceRules, dimFilter]);

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
    for (const rule of visibleSourceRules) {
      counts[rule.dimension] = (counts[rule.dimension] ?? 0) + 1;
    }
    return counts;
  }, [visibleSourceRules]);

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

  const modalLogEntries = useMemo(() => {
    if (logFocusRuleId == null) return logEntries;
    return logEntries.filter((entry) => entry.ruleId === logFocusRuleId);
  }, [logEntries, logFocusRuleId]);

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

  const totalRules   = visibleSourceRules.length;
  const enabledRules = visibleSourceRules.filter((r) => r.enabled).length;

  // ── Quick-view card stats ──────────────────────────────────────────────────
  // Score từ latest completed run (hoặc summary)
  const overallScore: number | null = latestCompletedRun?.score ?? summary?.score ?? null;

  // Severity-aware run breakdown for the latest completed run.
  // A failed info rule stays informational, a failed warning rule stays warning,
  // and hard failures include error-severity rules plus execution errors.
  const runStats = useMemo(() => {
    const executedRules = allRules
      .filter((rule) => rule.id in runResultsMap)
      .map((rule) => ({
        rule,
        result: runResultsMap[rule.id] as {
          passed?: boolean;
          skipped?: boolean;
          error?: boolean;
        },
      }));

    if (executedRules.length === 0) return null;

    const counts = {
      pass: 0,
      info: 0,
      warning: 0,
      failed: 0,
      skipped: 0,
      total: executedRules.length,
      evaluated: 0,
    };

    for (const { rule, result } of executedRules) {
      if (result?.skipped) {
        counts.skipped += 1;
        continue;
      }

      counts.evaluated += 1;

      if (result?.passed && !result?.error) {
        counts.pass += 1;
        continue;
      }

      if (result?.error || rule.severity === 'error') {
        counts.failed += 1;
        continue;
      }

      if (rule.severity === 'warning') {
        counts.warning += 1;
        continue;
      }

      counts.info += 1;
    }

    const pct = (value: number) => counts.evaluated > 0 ? (value / counts.evaluated) * 100 : 0;

    return {
      ...counts,
      passPct: pct(counts.pass),
      infoPct: pct(counts.info),
      warningPct: pct(counts.warning),
      failedPct: pct(counts.failed),
    };
  }, [allRules, runResultsMap]);

  // Dimension breakdown từ summary (có passed/failed per-dimension)
  const dimBreakdown = summary?.dimension_breakdown ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-surface-2">
      {/* ── Toolbar ── */}
      <div className="grid shrink-0 gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] xl:items-center">
        <div className="min-w-0">
          <TableSearchSelect
            tables={tables}
            value={tableFilter}
            onChange={setTableFilter}
            includeAllOption
            allLabel={`All tables (${allRules.length} rules)`}
          />
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1">
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

        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <span className="text-xs text-text-quaternary shrink-0">
            {enabledRules}/{totalRules} enabled
          </span>

          <button
            onClick={() => setScheduleModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 shrink-0"
            title="Configure scheduled runs and email reports"
          >
            <CalendarClock className="h-3.5 w-3.5" /> Automate
          </button>

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

          {canEdit && (
            <button
              onClick={() => openNewRule()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/15 shrink-0"
            >
              <Plus className="h-3.5 w-3.5" /> Add Rule
            </button>
          )}
        </div>
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
              <div className="flex items-center gap-2.5 text-xs shrink-0 flex-wrap">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  <span className="font-semibold text-success">{formatMetricPercent(runStats.passPct)}</span>
                  <span className="text-text-quaternary">pass</span>
                  <span className="text-text-tertiary">({runStats.pass})</span>
                </span>
                <span className="flex items-center gap-1">
                  <Info className="h-3 w-3 text-brand" />
                  <span className="font-semibold text-brand">{formatMetricPercent(runStats.infoPct)}</span>
                  <span className="text-text-quaternary">info</span>
                  <span className="text-text-tertiary">({runStats.info})</span>
                </span>
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-warning" />
                  <span className="font-semibold text-warning">{formatMetricPercent(runStats.warningPct)}</span>
                  <span className="text-text-quaternary">warning</span>
                  <span className="text-text-tertiary">({runStats.warning})</span>
                </span>
                <span className="flex items-center gap-1">
                  <XCircle className="h-3 w-3 text-danger" />
                  <span className="font-semibold text-danger">{formatMetricPercent(runStats.failedPct)}</span>
                  <span className="text-text-quaternary">failed</span>
                  <span className="text-text-tertiary">({runStats.failed})</span>
                </span>
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

            {/* ── Report button ── */}
            {latestCompletedRun && (
              <button
                onClick={() => setReportModalOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-[11px] font-medium text-text-tertiary hover:bg-surface-2 hover:border-[rgb(var(--border-strong))] transition-colors shrink-0"
                title="View the latest quality report overview"
              >
                <Eye className="h-3 w-3" />
                Report
              </button>
            )}

            {/* ── Logs button ── */}
            {logEntries.length > 0 && (
              <button
                onClick={handleOpenAllLogs}
                className="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-[11px] font-medium text-text-tertiary hover:bg-surface-2 hover:border-[rgb(var(--border-strong))] transition-colors shrink-0"
                title="View per-rule result details"
              >
                <Search className="h-3 w-3" />
                Rule details
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
            {/* Custom dimension groups */}
            {(() => {
              const knownKeys = new Set(DQ_DIMENSIONS.map((d) => d.key));
              return Object.entries(groupedByDim)
                .filter(([k]) => !knownKeys.has(k as QualityDimension))
                .map(([customKey, dimRules]) => {
                  if (!dimRules || dimRules.length === 0) return null;
                  return (
                    <DimensionGroup
                      key={customKey}
                      dimKey={customKey as QualityDimension}
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
                });
            })()}
          </div>
        )}
      </div>

      {/* ── Rule Editor Drawer ── */}
      {editorOpen && canEdit && (
        <RuleEditorDrawer
          datasetId={datasetId}
          tables={tables}
          existingRules={allRules}
          editingRule={editingRule}
          defaultTableId={tableFilter !== 'all' ? tableFilter : undefined}
          lastUsedTableId={lastUsedTableId}
          defaultDimension={editorDefaultDim}
          onClose={() => setEditorOpen(false)}
          onSaved={(rule) => { setEditorOpen(false); setLastUsedTableId(rule.table_id); }}
          onDuplicate={(rule) => { setEditorOpen(false); setDuplicatingRule(rule); }}
        />
      )}

      {/* ── Duplicate Dialog ── */}
      {duplicatingRule && (
        <DuplicateDialog
          rule={duplicatingRule}
          tables={tables}
          existingRules={allRules}
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
      {logModalOpen && modalLogEntries.length > 0 && (
        <RuleLogModal
          entries={modalLogEntries}
          initialExpandedId={logFocusRuleId}
          onClose={() => { setLogModalOpen(false); setLogFocusRuleId(null); }}
        />
      )}

      <DatasetQualityReportModal
        datasetId={datasetId}
        open={reportModalOpen}
        onClose={() => setReportModalOpen(false)}
        latestRun={latestCompletedRun}
        recentRuns={runs}
        rules={allRules}
        tables={tables}
        dimensionBreakdown={dimBreakdown}
      />

      {/* ── Schedule / Automation Modal ── */}
      <DatasetQualityScheduleModal
        datasetId={datasetId}
        open={scheduleModalOpen}
        canEdit={canEdit}
        onClose={() => setScheduleModalOpen(false)}
      />
    </div>
  );
}
