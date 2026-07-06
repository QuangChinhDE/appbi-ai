/**
 * DatasetTableGrid - NocoDB-style grid component for table data preview
 * Includes PowerBI-like column formatting (display-only, client-side)
 */
'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Hash, Settings2, X, Trash2, Eye, Filter as FilterIcon, Wand2, Loader2 } from 'lucide-react';
import { ColumnSummaryPopover } from './ColumnSummaryPopover';
import { ColumnFilterPopover } from '@/components/common/ColumnFilterPopover';
import { AiButton } from '@/components/ui/AiButton';
import {
  type TableColumnFilter,
  type TableFilterColumnType,
  EMPTY_TABLE_COLUMN_FILTER,
  isTableColumnFilterActive,
  detectTableColumnType,
  rowMatchesAllTableFilters,
  distinctTableColumnValues,
} from '@/lib/tableColumnFilter';
import type { AutoDetectTypesResult, AutoDetectSuggestion } from '@/hooks/use-datasets';
import { useI18n } from '@/providers/LanguageProvider';

// Map a dataset column's declared/overridden data type → the filter's type
// family (else fall back to value-based sniffing). Keeps the filter's operators
// aligned with the type the user set in the grid.
const NUMERIC_DATA_TYPES = new Set(['number', 'integer', 'int', 'float', 'double', 'decimal', 'bigint', 'long']);
const DATE_DATA_TYPES = new Set(['date', 'datetime', 'timestamp', 'timestamptz', 'datetimetz', 'time']);

// ===================== Types =====================

export interface DatasetTableGridProps {
  columns: { name: string; type: string }[];
  rows: Record<string, any>[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  readOnly?: boolean;
  onAddColumn?: () => void;
  /** User-defined type overrides loaded from DB. Each value is either a type
   *  string ("float", "date", ...) or an object {type, format} when a parse
   *  pattern (e.g. "DD/MM/YYYY") was saved alongside the type. */
  typeOverrides?: Record<string, any>;
  /** Names of columns that were added via formula (can be deleted) */
  computedColumns?: string[];
  /** Called when user deletes a computed column */
  onDeleteColumn?: (colName: string) => void;
  /** Called when user wants to edit the formula of a computed column */
  onEditColumn?: (colName: string) => void;
  /** Full display formats from DB, restored on mount */
  columnFormatsDb?: Record<string, ColFormat>;
  /** Called when user applies a format so parent can persist to DB */
  onColumnFormatChange?: (colName: string, fmt: ColFormat | null) => Promise<void> | void;
  /** Full-scan auto-detect of column types. `onAutoDetectPreview` is a DRY RUN
   *  (returns suggestions incl. off-type row counts/examples) → the grid shows a
   *  confirm modal → `onAutoDetectApply` persists + reloads. When preview is set,
   *  a toolbar "Auto-detect types" button shows. */
  onAutoDetectPreview?: () => Promise<AutoDetectTypesResult>;
  onAutoDetectApply?: () => Promise<void> | void;
  /** When set, enables the per-column summary popover (eye icon). */
  datasetId?: number | string;
  tableId?: number | string;
}

type DisplayUnit = 'none' | 'K' | 'M' | 'B';
type DateFmt =
  | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD MMM YYYY' | 'MMM DD, YYYY'
  | 'DD/MM/YYYY HH:mm' | 'DD/MM/YYYY HH:mm:ss'
  | 'MM/DD/YYYY HH:mm' | 'MM/DD/YYYY HH:mm:ss'
  | 'YYYY-MM-DD HH:mm' | 'YYYY-MM-DD HH:mm:ss'
  | 'DD MMM YYYY HH:mm';
type TextCase = 'none' | 'upper' | 'lower' | 'title';
type FormatType = 'default' | 'number' | 'currency' | 'percentage' | 'date' | 'datetime' | 'text';

interface ColFormat {
  formatType: FormatType;
  decimalPlaces: number;
  thousandsSeparator: boolean;
  currencySymbol: string;
  displayUnit: DisplayUnit;
  dateFormat: DateFmt;
  textCase: TextCase;
  prefix: string;
  suffix: string;
}

const DEFAULT_FORMAT: ColFormat = {
  formatType: 'default',
  decimalPlaces: 2,
  thousandsSeparator: true,
  currencySymbol: '$',
  displayUnit: 'none',
  dateFormat: 'DD/MM/YYYY',
  textCase: 'none',
  prefix: '',
  suffix: '',
};

// ===================== Formatting helpers =====================

function defaultRender(value: any): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatNumber(value: any, dp: number, sep: boolean, unit: DisplayUnit): string {
  let num = parseFloat(String(value));
  if (isNaN(num)) return defaultRender(value);
  let unitLabel = '';
  if (unit === 'K') { num = num / 1_000; unitLabel = 'K'; }
  else if (unit === 'M') { num = num / 1_000_000; unitLabel = 'M'; }
  else if (unit === 'B') { num = num / 1_000_000_000; unitLabel = 'B'; }
  let s = num.toFixed(dp);
  if (sep) {
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    s = parts.join('.');
  }
  return s + unitLabel;
}

function formatDate(value: any, fmt: DateFmt): string {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return defaultRender(value);
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = String(date.getFullYear());
    const H = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mn = months[date.getMonth()];
    switch (fmt) {
      case 'DD/MM/YYYY':            return `${d}/${m}/${y}`;
      case 'MM/DD/YYYY':            return `${m}/${d}/${y}`;
      case 'YYYY-MM-DD':            return `${y}-${m}-${d}`;
      case 'DD MMM YYYY':           return `${d} ${mn} ${y}`;
      case 'MMM DD, YYYY':          return `${mn} ${d}, ${y}`;
      case 'DD/MM/YYYY HH:mm':      return `${d}/${m}/${y} ${H}:${mi}`;
      case 'DD/MM/YYYY HH:mm:ss':   return `${d}/${m}/${y} ${H}:${mi}:${s}`;
      case 'MM/DD/YYYY HH:mm':      return `${m}/${d}/${y} ${H}:${mi}`;
      case 'MM/DD/YYYY HH:mm:ss':   return `${m}/${d}/${y} ${H}:${mi}:${s}`;
      case 'YYYY-MM-DD HH:mm':      return `${y}-${m}-${d} ${H}:${mi}`;
      case 'YYYY-MM-DD HH:mm:ss':   return `${y}-${m}-${d} ${H}:${mi}:${s}`;
      case 'DD MMM YYYY HH:mm':     return `${d} ${mn} ${y} ${H}:${mi}`;
      default:                      return `${d}/${m}/${y}`;
    }
  } catch {
    return defaultRender(value);
  }
}

function applyTextCase(str: string, tc: TextCase): string {
  if (tc === 'upper') return str.toUpperCase();
  if (tc === 'lower') return str.toLowerCase();
  if (tc === 'title') return str.replace(/\b\w/g, (l) => l.toUpperCase());
  return str;
}

function applyFormat(value: any, fmt: ColFormat, colType?: string): string {
  if (value === null || value === undefined) return '—';
  const { formatType, decimalPlaces, thousandsSeparator, currencySymbol,
    displayUnit, dateFormat, textCase, prefix, suffix } = fmt;

  // Auto-treat date/datetime-type columns even when formatType is 'default'
  const effectiveType: FormatType =
    formatType === 'default' && colType && isDateType(colType)
      ? (['datetime', 'timestamp'].includes(colType.toLowerCase()) ? 'datetime' : 'date')
      : formatType;

  let result: string;
  if (effectiveType === 'number') {
    result = formatNumber(value, decimalPlaces, thousandsSeparator, displayUnit);
  } else if (effectiveType === 'currency') {
    result = currencySymbol + formatNumber(value, decimalPlaces, thousandsSeparator, displayUnit);
  } else if (effectiveType === 'percentage') {
    const num = parseFloat(String(value));
    result = isNaN(num) ? defaultRender(value) : (num * 100).toFixed(decimalPlaces) + '%';
  } else if (effectiveType === 'date') {
    result = formatDate(value, dateFormat);
  } else if (effectiveType === 'datetime') {
    // Default datetime format includes time; respect user choice if already includes time
    const dtFmt: DateFmt = (dateFormat as string).includes('HH') ? dateFormat : 'DD/MM/YYYY HH:mm:ss';
    result = formatDate(value, dtFmt);
  } else if (effectiveType === 'text') {
    result = applyTextCase(defaultRender(value), textCase);
  } else {
    result = defaultRender(value);
  }

  if (effectiveType !== 'text' && textCase !== 'none') {
    result = applyTextCase(result, textCase);
  }

  return prefix + result + suffix;
}

const isNumericType = (t: string) =>
  ['number', 'integer', 'int', 'float', 'decimal', 'double', 'bigint', 'numeric', 'real'].includes(
    t.toLowerCase()
  );
const isDateType = (t: string) =>
  ['date', 'datetime', 'timestamp', 'time'].includes(t.toLowerCase());

// Map frontend formatType → backend semantic type (for DB persistence)
function formatTypeToBackendType(formatType: FormatType): string | null {
  if (formatType === 'number' || formatType === 'currency' || formatType === 'percentage') return 'float';
  if (formatType === 'date') return 'date';
  if (formatType === 'datetime') return 'datetime';
  if (formatType === 'text') return 'string';
  return null; // 'default' → clear override
}

// Map backend semantic type → formatType (for initialising from DB)
function backendTypeToFormatType(backendType: string): FormatType {
  if (['float', 'integer', 'number', 'int', 'decimal', 'double', 'bigint', 'numeric', 'real'].includes(backendType.toLowerCase())) return 'number';
  if (['datetime', 'timestamp'].includes(backendType.toLowerCase())) return 'datetime';
  if (backendType.toLowerCase() === 'date') return 'date';
  if (backendType.toLowerCase() === 'string') return 'text';
  return 'default';
}

// ===================== Column value validation =====================

interface ValidationResult {
  valid: boolean;
  invalidCount: number;
  total: number;
  examples: string[];
}

const _MONTHS_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const _ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const _DATE_TOKENS: Array<[string, string]> = [
  ['YYYY', '(\\d{4})'], ['MMM', '([A-Za-z]{3,})'], ['MM', '(\\d{1,2})'], ['DD', '(\\d{1,2})'],
  ['HH', '(\\d{1,2})'], ['mm', '(\\d{1,2})'], ['ss', '(\\d{1,2})'],
];

/** Does `value` match the SELECTED date format (range-checked)? Mirrors the
 *  backend PARSE_DATE branch so the warning reflects what conversion will
 *  actually keep. Dates come in many shapes on Sheets — we validate against the
 *  format the user picked, not JS `new Date()` (which mis-reads dd/mm and
 *  rejects valid day-first dates like 31/07/2026). */
function matchesDateFormat(value: string, fmt: string): boolean {
  const order: string[] = [];
  let pattern = '';
  let i = 0;
  while (i < fmt.length) {
    const tok = _DATE_TOKENS.find(([t]) => fmt.startsWith(t, i));
    if (tok) { pattern += tok[1]; order.push(tok[0]); i += tok[0].length; }
    else { pattern += fmt[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  const m = new RegExp('^' + pattern + '$').exec(value);
  if (!m) return false;
  let g = 1;
  for (const t of order) {
    const v = m[g++];
    const n = Number(v);
    if (t === 'MM' && (n < 1 || n > 12)) return false;
    if (t === 'DD' && (n < 1 || n > 31)) return false;
    if (t === 'HH' && (n < 0 || n > 23)) return false;
    if ((t === 'mm' || t === 'ss') && (n < 0 || n > 59)) return false;
    if (t === 'MMM' && !_MONTHS_ABBR.includes(v.slice(0, 3).toLowerCase())) return false;
  }
  return true;
}

function validateColumnValues(values: any[], formatType: FormatType, dateFormat: string): ValidationResult {
  if (formatType === 'default' || formatType === 'text') {
    return { valid: true, invalidCount: 0, total: values.length, examples: [] };
  }

  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (nonEmpty.length === 0) {
    return { valid: true, invalidCount: 0, total: 0, examples: [] };
  }

  const isInvalid = (v: any): boolean => {
    const s = String(v).trim();
    if (formatType === 'number' || formatType === 'currency' || formatType === 'percentage') {
      return isNaN(parseFloat(s)) || !isFinite(Number(s.replace(/,/g, '')));
    }
    if (formatType === 'date' || formatType === 'datetime') {
      if (s === '') return false;
      // Convertible if it matches the chosen format OR ISO (the backend's
      // COALESCE(PARSE_DATE(fmt), CAST AS DATE/TIMESTAMP) fallback). Anything
      // else genuinely won't parse → it's a real "will be blank" value.
      return !(matchesDateFormat(s, dateFormat) || _ISO_DATE_RE.test(s));
    }
    return false;
  };

  const badValues = nonEmpty.filter(isInvalid);
  const examples = Array.from(new Set(badValues.map((v) => String(v)))).slice(0, 4);
  return {
    valid: badValues.length === 0,
    invalidCount: badValues.length,
    total: nonEmpty.length,
    examples,
  };
}

// ===================== FormatPanel =====================

interface FormatPanelProps {
  column: { name: string; type: string };
  format: ColFormat;
  /** Raw column values from the current preview rows — used for type validation */
  values: any[];
  /** Called only when user explicitly clicks "Áp dụng" */
  onApply: (fmt: ColFormat) => Promise<void> | void;
  onClose: () => void;
  onReset: () => Promise<void> | void;
  /** If set, show a delete button for this computed column */
  onDelete?: () => void;
  /** If set, show an edit formula button for this computed column */
  onEdit?: () => void;
}

function FormatPanel({ column, format, values, onApply, onClose, onReset, onDelete, onEdit }: FormatPanelProps) {
  const { t } = useI18n();
  // Local draft — changes staged here, only committed on "Áp dụng"
  // For date-type columns, pre-select 'date' formatType so the dropdown + date rendering work immediately
  const initDraft = (f: ColFormat): ColFormat => {
    if (f.formatType === 'default' && isDateType(column.type)) {
      // datetime/timestamp → 'datetime' with time format; date → 'date'
      const isDatetime = ['datetime', 'timestamp'].includes(column.type.toLowerCase());
      return {
        ...f,
        formatType: isDatetime ? 'datetime' : 'date',
        dateFormat: isDatetime ? 'DD/MM/YYYY HH:mm:ss' : 'DD/MM/YYYY',
      };
    }
    return f;
  };
  const [draft, setDraft] = useState<ColFormat>(() => initDraft(format));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Sync draft when applied format changes from outside
  useEffect(() => {
    setDraft(initDraft(format));
    setIsSaving(false);
    setSaveError(null);
  }, [format]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const upd = (partial: Partial<ColFormat>) => setDraft((prev) => ({ ...prev, ...partial }));
  const isDirty = JSON.stringify(draft) !== JSON.stringify(format);

  // Validate current draft type against actual column data — for dates, against
  // the CHOSEN format (+ ISO fallback), matching what the backend keeps.
  const validation = useMemo(
    () => validateColumnValues(values, draft.formatType, draft.dateFormat),
    [values, draft.formatType, draft.dateFormat]
  );

  // WARN, don't BLOCK: a few unparseable values shouldn't stop the user setting
  // the type — they'll be saved blank (the backend safe-casts them to NULL).
  // Only hard-block when EVERY non-empty value fails (the type is just wrong).
  const allInvalid = validation.total > 0 && validation.invalidCount === validation.total;
  const canApply = isDirty && !allInvalid;
  const handleApply = async () => {
    if (!canApply || isSaving) return;
    setSaveError(null);
    setIsSaving(true);
    try {
      await onApply(draft);
      onClose();
    } catch (error: any) {
      setSaveError(error?.message ?? t('datasets.formatPanel.saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    if (isSaving) return;
    setSaveError(null);
    setIsSaving(true);
    try {
      await onReset();
      onClose();
    } catch (error: any) {
      setSaveError(error?.message ?? t('datasets.formatPanel.resetError'));
    } finally {
      setIsSaving(false);
    }
  };

  // Sub-option visibility based on what the user has SELECTED in draft (not inferred column type)
  const draftIsNum = draft.formatType === 'number' || draft.formatType === 'currency' || draft.formatType === 'percentage';
  const draftIsDate = draft.formatType === 'date' || draft.formatType === 'datetime' || (draft.formatType === 'default' && isDateType(column.type));
  const draftIsDatetime = draft.formatType === 'datetime';

  return (
    <div
      className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 text-xs shadow-linear-lg"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-surface-2 rounded-t-lg">
        <span className="font-semibold text-text-secondary text-[11px] truncate max-w-[180px]">
          ⚙ {t('datasets.formatPanel.headerLabel')} {column.name}
        </span>
        <button onClick={onClose} className="text-text-quaternary hover:text-text-secondary flex-shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* Format type — all types always visible so user can override any column */}
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{t('datasets.formatPanel.formatTypeLabel')}</label>
          <select
            value={draft.formatType}
            onChange={(e) => upd({ formatType: e.target.value as FormatType })}
            className="w-full border border-[rgb(var(--border-strong))] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="default">{t('datasets.formatPanel.typeDefault')}</option>
            <option value="number">{t('datasets.formatPanel.typeNumber')}</option>
            <option value="currency">{t('datasets.formatPanel.typeCurrency')}</option>
            <option value="percentage">{t('datasets.formatPanel.typePercentage')}</option>
            <option value="date">{t('datasets.formatPanel.typeDate')}</option>
            <option value="datetime">{t('datasets.formatPanel.typeDatetime')}</option>
            <option value="text">{t('datasets.formatPanel.typeText')}</option>
          </select>
        </div>

        {/* Number / Currency / Percentage */}
        {draftIsNum && (
          <>
            {draft.formatType === 'currency' && (
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{t('datasets.formatPanel.currencySymbolLabel')}</label>
                <select
                  value={draft.currencySymbol}
                  onChange={(e) => upd({ currencySymbol: e.target.value })}
                  className="w-full border border-[rgb(var(--border-strong))] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
                >
                  <option value="$">$ — USD</option>
                  <option value="€">€ — EUR</option>
                  <option value="£">£ — GBP</option>
                  <option value="¥">¥ — JPY / CNY</option>
                  <option value="₫">₫ — VND</option>
                  <option value="₩">₩ — KRW</option>
                </select>
              </div>
            )}

            {draft.formatType !== 'percentage' && (
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{t('datasets.formatPanel.displayUnitLabel')}</label>
                <select
                  value={draft.displayUnit}
                  onChange={(e) => upd({ displayUnit: e.target.value as DisplayUnit })}
                  className="w-full border border-[rgb(var(--border-strong))] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
                >
                  <option value="none">{t('datasets.formatPanel.unitNone')}</option>
                  <option value="K">{t('datasets.formatPanel.unitK')}</option>
                  <option value="M">{t('datasets.formatPanel.unitM')}</option>
                  <option value="B">{t('datasets.formatPanel.unitB')}</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{t('datasets.formatPanel.decimalPlacesLabel')}</label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={4}
                  value={draft.decimalPlaces}
                  onChange={(e) => upd({ decimalPlaces: parseInt(e.target.value) })}
                  className="flex-1 accent-blue-600"
                />
                <span className="w-5 text-center font-mono text-text-secondary">{draft.decimalPlaces}</span>
              </div>
            </div>

            {draft.formatType !== 'percentage' && (
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={draft.thousandsSeparator}
                  onChange={(e) => upd({ thousandsSeparator: e.target.checked })}
                  className="w-3.5 h-3.5 rounded text-brand accent-blue-600"
                />
                <span className="text-text-secondary">{t('datasets.formatPanel.thousandsSeparator')}</span>
              </label>
            )}
          </>
        )}

        {/* Date / Datetime */}
        {draftIsDate && (
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{draftIsDatetime ? t('datasets.formatPanel.datetimeFormatLabel') : t('datasets.formatPanel.dateFormatLabel')}</label>
            <select
              value={draft.dateFormat}
              onChange={(e) => upd({ dateFormat: e.target.value as DateFmt })}
              className="w-full border border-[rgb(var(--border-strong))] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            >
              {!draftIsDatetime && (
                <>
                  <option value="DD/MM/YYYY">DD/MM/YYYY  (14/03/2026)</option>
                  <option value="MM/DD/YYYY">MM/DD/YYYY  (03/14/2026)</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD  (2026-03-14)</option>
                  <option value="DD MMM YYYY">DD MMM YYYY  (14 Mar 2026)</option>
                  <option value="MMM DD, YYYY">MMM DD, YYYY  (Mar 14, 2026)</option>
                </>
              )}
              {draftIsDatetime && (
                <>
                  <option value="DD/MM/YYYY HH:mm:ss">DD/MM/YYYY HH:mm:ss  (14/03/2026 09:05:00)</option>
                  <option value="DD/MM/YYYY HH:mm">DD/MM/YYYY HH:mm  (14/03/2026 09:05)</option>
                  <option value="MM/DD/YYYY HH:mm:ss">MM/DD/YYYY HH:mm:ss  (03/14/2026 09:05:00)</option>
                  <option value="MM/DD/YYYY HH:mm">MM/DD/YYYY HH:mm  (03/14/2026 09:05)</option>
                  <option value="YYYY-MM-DD HH:mm:ss">YYYY-MM-DD HH:mm:ss  (2026-03-14 09:05:00)</option>
                  <option value="YYYY-MM-DD HH:mm">YYYY-MM-DD HH:mm  (2026-03-14 09:05)</option>
                  <option value="DD MMM YYYY HH:mm">DD MMM YYYY HH:mm  (14 Mar 2026 09:05)</option>
                </>
              )}
            </select>
          </div>
        )}

        {/* Text case */}
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{t('datasets.formatPanel.textCaseLabel')}</label>
          <div className="grid grid-cols-4 gap-1">
            {(['none', 'upper', 'lower', 'title'] as TextCase[]).map((tc) => (
              <button
                key={tc}
                onClick={() => upd({ textCase: tc })}
                className={`py-1 border rounded text-[10px] font-medium transition-colors ${
                  draft.textCase === tc
                    ? 'bg-brand text-white border-brand'
                    : 'border-[rgb(var(--border-strong))] text-text-secondary hover:border-brand/50 hover:text-brand'
                }`}
              >
                {tc === 'none' ? 'Abc' : tc === 'upper' ? 'ABC' : tc === 'lower' ? 'abc' : 'Title'}
              </button>
            ))}
          </div>
        </div>

        {/* Prefix / Suffix */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{t('datasets.formatPanel.prefixLabel')}</label>
            <input
              type="text"
              value={draft.prefix}
              onChange={(e) => upd({ prefix: e.target.value })}
              placeholder={t('datasets.formatPanel.prefixPlaceholder')}
              className="w-full border border-[rgb(var(--border-strong))] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1 font-semibold uppercase tracking-wide">{t('datasets.formatPanel.suffixLabel')}</label>
            <input
              type="text"
              value={draft.suffix}
              onChange={(e) => upd({ suffix: e.target.value })}
              placeholder={t('datasets.formatPanel.suffixPlaceholder')}
              className="w-full border border-[rgb(var(--border-strong))] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
        </div>

        {/* Validation warning */}
        {isDirty && !validation.valid && (
          <div className="rounded border border-warning/40 bg-warning/10 p-2 text-[10px] text-warning space-y-0.5">
            <p className="font-semibold">⚠️ {t('datasets.formatPanel.invalidCount', { count: validation.invalidCount, total: validation.total })}</p>
            <p className="text-warning">
              {allInvalid
                ? <>{t('datasets.formatPanel.invalidTypePrefix')} <strong>{draft.formatType}</strong>. {t('datasets.formatPanel.invalidTypeSuffix')}</>
                : t('datasets.formatPanel.invalidWillBlank')}
            </p>
            {validation.examples.length > 0 && (
              <p className="font-mono text-[9px] text-warning break-all">
                {t('datasets.formatPanel.examplePrefix')} {validation.examples.map((e) => `"${e}"`).join(', ')}
              </p>
            )}
          </div>
        )}

        {/* Apply button — explicit save */}
        {saveError && (
          <div className="rounded border border-danger/40 bg-danger/10 p-2 text-[10px] text-danger">
            {saveError}
          </div>
        )}

        <button
          onClick={handleApply}
          disabled={!canApply || isSaving}
          className={`w-full py-1.5 rounded text-[11px] font-semibold transition-colors ${
            canApply && !isSaving
              ? 'bg-brand text-white hover:bg-brand-hover'
              : !isDirty
              ? 'bg-surface-2 text-text-quaternary cursor-not-allowed'
              : 'bg-warning/15 text-warning cursor-not-allowed'
          }`}
        >
          {!isDirty
            ? t('datasets.formatPanel.noChanges')
            : allInvalid
            ? t('datasets.formatPanel.dataInvalid')
            : !validation.valid
            ? t('datasets.formatPanel.applyAnyway')
            : t('datasets.formatPanel.applyAndSave')}
        </button>

        {/* Reset */}
        <button
          onClick={handleReset}
          disabled={isSaving}
          className="w-full text-center text-[10px] text-text-quaternary hover:text-danger py-1.5 border border-dashed border-[rgb(var(--border-strong))] rounded hover:border-danger/40 transition-colors"
        >
          {t('datasets.formatPanel.resetDefault')}
        </button>

        {/* Delete computed column */}
        {onEdit && (
          <button
            onClick={onEdit}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-brand border border-brand/30 rounded hover:bg-brand/15 hover:border-brand/50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            {t('datasets.formatPanel.editFormula')}
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-danger border border-danger/30 rounded hover:bg-danger/10 hover:border-danger/30 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('datasets.formatPanel.deleteColumn')}
          </button>
        )}
      </div>
    </div>
  );
}

// ===================== Main component =====================

export function DatasetTableGrid({
  columns,
  rows,
  isLoading = false,
  error = null,
  onRetry,
  readOnly = false,
  onAddColumn,
  typeOverrides,
  computedColumns,
  onDeleteColumn,
  onEditColumn,
  columnFormatsDb,
  onColumnFormatChange,
  onAutoDetectPreview,
  onAutoDetectApply,
  datasetId,
  tableId,
}: DatasetTableGridProps) {
  const { t } = useI18n();
  const computedColSet = useMemo(() => new Set(computedColumns ?? []), [computedColumns]);
  const [columnFormats, setColumnFormats] = useState<Record<string, ColFormat>>({});
  const [summaryCol, setSummaryCol] = useState<string | null>(null);
  const [activeFormatCol, setActiveFormatCol] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Per-column data filter (Excel / Power BI AutoFilter) over the previewed
  // rows. Pure client-side view filter — narrows which rows show, never
  // re-queries. Multiple columns AND together. Shared popover + logic with the
  // Explore chart table.
  const [columnDataFilters, setColumnDataFilters] = useState<Record<string, TableColumnFilter>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);   // preview (dry-run) in flight
  const [isApplyingTypes, setIsApplyingTypes] = useState(false);
  // Non-null → the confirm modal is open, holding the columns that will change.
  const [autoDetectPlan, setAutoDetectPlan] = useState<AutoDetectSuggestion[] | null>(null);
  const runAutoDetectPreview = async () => {
    if (!onAutoDetectPreview || isAutoDetecting) return;
    setIsAutoDetecting(true);
    try {
      const result = await onAutoDetectPreview();
      // Show only columns whose detected type DIFFERS from the current one.
      const NUM = new Set(['integer', 'float', 'number', 'int', 'double', 'decimal', 'bigint', 'numeric', 'real']);
      const norm = (t?: string | null) => {
        const s = (t || '').toLowerCase();
        return NUM.has(s) ? 'number' : (s === 'datetime' || s === 'timestamp') ? 'datetime' : s;
      };
      const currentOf = (name: string) => {
        const ov = (typeOverrides as Record<string, any> | undefined)?.[name];
        const ovt = typeof ov === 'string' ? ov : ov?.type;
        return norm(ovt || columns.find((c) => c.name === name)?.type);
      };
      const changes = (result.suggestions || []).filter(
        (s) => s.suggested_type && norm(s.suggested_type) !== currentOf(s.column),
      );
      setAutoDetectPlan(changes);
    } catch {
      setAutoDetectPlan(null);
    } finally {
      setIsAutoDetecting(false);
    }
  };
  const confirmAutoDetect = async () => {
    if (!onAutoDetectApply || isApplyingTypes) return;
    setIsApplyingTypes(true);
    try {
      await onAutoDetectApply();
      setAutoDetectPlan(null);
    } finally {
      setIsApplyingTypes(false);
    }
  };
  const openColumnFilter = (name: string, anchor: HTMLElement) => {
    setFilterAnchorRect(anchor.getBoundingClientRect());
    setOpenFilterCol((cur) => (cur === name ? null : name));
    setSummaryCol(null);
    setActiveFormatCol(null);
  };
  const updateColumnDataFilter = (name: string, next: TableColumnFilter) =>
    setColumnDataFilters((prev) => ({ ...prev, [name]: next }));
  const clearColumnDataFilter = (name: string) =>
    setColumnDataFilters((prev) => {
      const rest = { ...prev };
      delete rest[name];
      return rest;
    });
  const clearAllDataFilters = () => {
    setColumnDataFilters({});
    setOpenFilterCol(null);
  };

  // Initialise format state from DB on table change.
  // columnFormatsDb (full format) takes priority over typeOverrides (type only).
  useEffect(() => {
    const initial: Record<string, ColFormat> = {};
    // 1. Seed from typeOverrides (type only). Entries may be a plain string
    //    ("date") or {type, format} when a parse pattern was saved.
    if (typeOverrides) {
      for (const [col, entry] of Object.entries(typeOverrides as Record<string, any>)) {
        const backendType = typeof entry === 'string' ? entry : (entry?.type ?? '');
        if (!backendType) continue;
        const formatType = backendTypeToFormatType(backendType);
        if (formatType !== 'default') {
          const seed: ColFormat = { ...DEFAULT_FORMAT, formatType };
          if (typeof entry === 'object' && typeof entry?.format === 'string' && entry.format) {
            seed.dateFormat = entry.format as DateFmt;
          }
          initial[col] = seed;
        }
      }
    }
    // 2. Override with full saved formats (takes priority)
    if (columnFormatsDb) {
      for (const [col, fmt] of Object.entries(columnFormatsDb)) {
        initial[col] = fmt as ColFormat;
      }
    }
    setColumnFormats(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeOverrides, columnFormatsDb]);

  const getFormat = (name: string): ColFormat => columnFormats[name] ?? DEFAULT_FORMAT;

  const setFormat = async (name: string, fmt: ColFormat) => {
    if (onColumnFormatChange) await onColumnFormatChange(name, fmt);
    setColumnFormats((s) => ({ ...s, [name]: fmt }));
  };

  const resetFormat = async (name: string) => {
    if (onColumnFormatChange) await onColumnFormatChange(name, null);
    setColumnFormats((s) => {
      const next = { ...s };
      delete next[name];
      return next;
    });
  };

  // Close popover on outside click
  useEffect(() => {
    if (!activeFormatCol) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setActiveFormatCol(null);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [activeFormatCol]);

  const nonEmptyValuesByColumn = useMemo(() => {
    const valuesByColumn: Record<string, any[]> = {};
    for (const column of columns) {
      valuesByColumn[column.name] = rows
        .map((row) => row[column.name])
        .filter((value) => value !== null && value !== undefined);
    }
    return valuesByColumn;
  }, [columns, rows]);

  const formattedRows = useMemo(() => {
    return rows.map((row) => {
      const formattedRow: Record<string, { text: string; isLong: boolean }> = {};
      for (const column of columns) {
        const text = applyFormat(row[column.name], getFormat(column.name), column.type);
        formattedRow[column.name] = {
          text,
          isLong: text.length > 50,
        };
      }
      return formattedRow;
    });
  }, [rows, columns, columnFormats]);

  // Filter type per column: prefer the declared/overridden data type, else sniff
  // values. Distinct-value list + row matching reuse the shared filter engine.
  const columnFilterTypes = useMemo<Record<string, TableFilterColumnType>>(() => {
    const map: Record<string, TableFilterColumnType> = {};
    for (const col of columns) {
      const ov = (typeOverrides as Record<string, any> | undefined)?.[col.name];
      const ovType = typeof ov === 'string' ? ov : ov?.type;
      const declared = String(ovType || col.type || '').toLowerCase();
      if (DATE_DATA_TYPES.has(declared)) map[col.name] = 'date';
      else if (NUMERIC_DATA_TYPES.has(declared)) map[col.name] = 'number';
      else map[col.name] = detectTableColumnType(rows, col.name, false);
    }
    return map;
  }, [columns, rows, typeOverrides]);
  const hasActiveDataFilters = useMemo(
    () => Object.values(columnDataFilters).some(isTableColumnFilterActive),
    [columnDataFilters],
  );
  // Keep the ORIGINAL row index so formatted-cell + row-number lookups stay
  // aligned after filtering.
  const filteredIndexedRows = useMemo(() => {
    const indexed = rows.map((row, i) => ({ row, i }));
    if (!hasActiveDataFilters) return indexed;
    return indexed.filter(({ row }) => rowMatchesAllTableFilters(row, columnDataFilters, columnFilterTypes));
  }, [rows, columnDataFilters, columnFilterTypes, hasActiveDataFilters]);

  // ---- Loading skeleton ----
  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
            <thead className="bg-surface-2 sticky top-0 z-10">
              <tr>
                <th className="w-16 px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider border-r">#</th>
                {[1, 2, 3, 4, 5].map((i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider">
                    <div className="h-4 bg-surface-3 rounded animate-pulse w-24" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-surface-1 divide-y divide-[rgb(var(--border-line))]">
              {[1, 2, 3, 4, 5].map((rowIdx) => (
                <tr key={rowIdx}>
                  <td className="w-16 px-4 py-3 text-sm text-text-quaternary border-r">
                    <div className="h-4 bg-surface-2 rounded animate-pulse w-8" />
                  </td>
                  {[1, 2, 3, 4, 5].map((colIdx) => (
                    <td key={colIdx} className="px-4 py-3 text-sm">
                      <div className="h-4 bg-surface-2 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ---- Error state ----
  if (error) {
    return (
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-8">
        <div className="text-center">
          <div className="text-danger mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-1">{t('datasets.grid.loadError')}</h3>
          <p className="text-sm text-text-tertiary mb-4">{error}</p>
          {onRetry && (
            <button onClick={onRetry} className="px-4 py-2 bg-brand text-white rounded-md hover:bg-brand-hover transition-colors">
              {t('datasets.grid.retry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- Empty state ----
  if (rows.length === 0) {
    return (
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-12">
        <div className="text-center">
          <div className="text-text-quaternary mb-3">
            <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-1">{t('datasets.grid.noData')}</h3>
          <p className="text-sm text-text-tertiary">{t('datasets.grid.noRows')}</p>
        </div>
      </div>
    );
  }

  // ---- Main table ----
  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex-1 overflow-auto">
        <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
          <thead className="bg-surface-2 sticky top-0 z-10">
            <tr>
              {/* Row number */}
              <th className="w-16 px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider border-r bg-surface-2">
                <Hash className="w-4 h-4" />
              </th>

              {columns.map((column) => {
                const isActive = activeFormatCol === column.name;
                const colFmt = columnFormats[column.name];
                const hasCustomFmt = colFmt !== undefined;
                const isComputed = computedColSet.has(column.name);
                // Show effective type: use applied format type if set, otherwise fall back to server type
                const effectiveType = colFmt && colFmt.formatType !== 'default'
                  ? colFmt.formatType
                  : column.type;

                return (
                  <th
                    key={column.name}
                    className={`px-4 py-3 text-left text-xs font-medium uppercase tracking-wider group relative ${
                      isComputed
                        ? 'bg-warning/10 text-warning'
                        : 'bg-surface-2 text-text-secondary'
                    }`}
                    title={`${column.name} (${column.type})${isComputed ? ` — ${t('datasets.grid.computedColumn')}` : ''}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      {/* Column name + type badge */}
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        {isComputed && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning/60 flex-shrink-0" />
                        )}
                        <span className="truncate">{column.name}</span>
                        <span className={`text-[10px] font-normal normal-case shrink-0 ${hasCustomFmt && colFmt.formatType !== 'default' ? 'text-brand' : isComputed ? 'text-warning' : 'text-text-quaternary'}`}>
                          {effectiveType}
                        </span>
                        {hasCustomFmt && (
                          <span className="text-brand text-[8px] leading-none shrink-0" title={t('datasets.grid.customFormatBadge')}>●</span>
                        )}
                      </div>

                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openColumnFilter(column.name, e.currentTarget);
                          }}
                          className={`w-5 h-5 flex items-center justify-center rounded transition-all shrink-0 ${
                            isTableColumnFilterActive(columnDataFilters[column.name])
                              ? 'opacity-100 text-brand bg-brand/15'
                              : openFilterCol === column.name
                              ? 'opacity-100 text-brand bg-brand/15'
                              : 'opacity-0 group-hover:opacity-100 text-text-quaternary hover:text-brand hover:bg-brand/15'
                          }`}
                          title={t('datasets.grid.filterColumn')}
                        >
                          <FilterIcon className={`w-3.5 h-3.5 ${isTableColumnFilterActive(columnDataFilters[column.name]) ? 'fill-current' : ''}`} />
                        </button>
                        {datasetId !== undefined && tableId !== undefined && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSummaryCol(summaryCol === column.name ? null : column.name);
                              setActiveFormatCol(null);
                            }}
                            className={`w-5 h-5 flex items-center justify-center rounded transition-all shrink-0 ${
                              summaryCol === column.name
                                ? 'opacity-100 text-brand bg-brand/15'
                                : 'opacity-0 group-hover:opacity-100 text-text-quaternary hover:text-brand hover:bg-brand/15'
                            }`}
                            title={t('datasets.grid.viewSummary')}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!readOnly && <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveFormatCol(isActive ? null : column.name);
                            setSummaryCol(null);
                          }}
                          className={`w-5 h-5 flex items-center justify-center rounded transition-all shrink-0 ${
                            isActive
                              ? 'opacity-100 text-brand bg-brand/15'
                              : hasCustomFmt
                              ? 'opacity-100 text-brand hover:bg-brand/15'
                              : 'opacity-0 group-hover:opacity-100 text-text-quaternary hover:text-brand hover:bg-brand/15'
                          }`}
                          title={t('datasets.grid.formatColumn')}
                        >
                          <Settings2 className="w-3.5 h-3.5" />
                        </button>}
                      </div>
                    </div>

                    {summaryCol === column.name && datasetId !== undefined && tableId !== undefined && (
                      <ColumnSummaryPopover
                        datasetId={datasetId}
                        tableId={tableId}
                        columnName={column.name}
                        columnType={effectiveType}
                        onClose={() => setSummaryCol(null)}
                      />
                    )}

                    {/* Format popover */}
                    {!readOnly && isActive && (
                      <FormatPanel
                        column={column}
                        format={getFormat(column.name)}
                        values={nonEmptyValuesByColumn[column.name] ?? []}
                        onApply={(f) => setFormat(column.name, f)}
                        onClose={() => setActiveFormatCol(null)}
                        onReset={() => resetFormat(column.name)}
                        onDelete={isComputed && onDeleteColumn ? () => {
                          setActiveFormatCol(null);
                          onDeleteColumn(column.name);
                        } : undefined}
                        onEdit={isComputed && onEditColumn ? () => {
                          setActiveFormatCol(null);
                          onEditColumn(column.name);
                        } : undefined}
                      />
                    )}
                  </th>
                );
              })}

              {/* Add column button */}
              {!readOnly && onAddColumn && (
                <th className="w-16 px-4 py-3 bg-surface-2 border-l">
                  <button
                    onClick={onAddColumn}
                    className="w-8 h-8 flex items-center justify-center text-text-quaternary hover:text-brand hover:bg-brand/15 rounded transition-colors"
                    title={t('datasets.grid.addColumn')}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </th>
              )}
            </tr>
          </thead>

          <tbody className="bg-surface-1 divide-y divide-[rgb(var(--border-line))]">
            {filteredIndexedRows.map(({ row, i: rowIndex }) => (
              <tr key={rowIndex} className="hover:bg-surface-2 transition-colors">
                <td className="w-16 px-4 py-3 text-sm text-text-quaternary border-r font-mono">{rowIndex + 1}</td>
                {columns.map((column) => {
                  const isComputed2 = computedColSet.has(column.name);
                  const displayValue = formattedRows[rowIndex]?.[column.name]?.text ?? defaultRender(row[column.name]);
                  const isLong = formattedRows[rowIndex]?.[column.name]?.isLong ?? displayValue.length > 50;
                  return (
                    <td
                      key={`${rowIndex}-${column.name}`}
                      className={`px-4 py-3 text-sm ${
                        isComputed2 ? 'bg-warning/10 text-warning' : 'text-text-primary'
                      }`}
                      title={isLong ? displayValue : undefined}
                    >
                      <div className="max-w-xs truncate">{displayValue}</div>
                    </td>
                  );
                })}
                {!readOnly && onAddColumn && <td className="w-16 px-4 py-3 border-l" />}
              </tr>
            ))}
            {hasActiveDataFilters && filteredIndexedRows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1 + (!readOnly && onAddColumn ? 1 : 0)}
                  className="px-4 py-8 text-center text-sm text-text-tertiary"
                >
                  {t('datasets.grid.filteredRows', { shown: 0, total: rows.length })}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t bg-surface-2 px-4 py-2 flex items-center gap-4">
        <p className="text-xs text-text-tertiary">
          {hasActiveDataFilters
            ? t('datasets.grid.filteredRows', { shown: filteredIndexedRows.length, total: rows.length })
            : t('datasets.grid.showingRows', { count: rows.length })}
        </p>
        {computedColSet.size > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-warning">
            <span className="inline-block w-2 h-2 rounded-full bg-warning/60" />
            {t('datasets.grid.computedColumnsCount', { count: computedColSet.size })}
          </span>
        )}
        {hasActiveDataFilters && (
          <button
            onClick={clearAllDataFilters}
            className="text-xs text-text-quaternary hover:text-danger transition-colors"
          >
            {t('datasets.grid.clearAllFilters')}
          </button>
        )}
        {Object.keys(columnFormats).length > 0 && (
          <button
            onClick={() => setColumnFormats({})}
            className="text-xs text-text-quaternary hover:text-danger transition-colors"
          >
            {t('datasets.grid.clearAllFormats', { count: Object.keys(columnFormats).length })}
          </button>
        )}
        {onAutoDetectPreview && (
          <AiButton
            onClick={runAutoDetectPreview}
            loading={isAutoDetecting}
            title={t('datasets.grid.autoDetectHint')}
            className="ml-auto"
          >
            {t('datasets.grid.autoDetectTypes')}
          </AiButton>
        )}
      </div>

      {/* Column-filter popover — portal to <body> so the grid's overflow can't
          clip it. */}
      {openFilterCol && filterAnchorRect && (
        <ColumnFilterPopover
          key={openFilterCol}
          label={openFilterCol}
          type={columnFilterTypes[openFilterCol] ?? 'text'}
          filter={columnDataFilters[openFilterCol] ?? EMPTY_TABLE_COLUMN_FILTER}
          distinctValues={distinctTableColumnValues(rows, openFilterCol)}
          anchorRect={filterAnchorRect}
          onChange={(next) => updateColumnDataFilter(openFilterCol, next)}
          onClear={() => clearColumnDataFilter(openFilterCol)}
          onClose={() => setOpenFilterCol(null)}
        />
      )}

      {/* Auto-detect PREVIEW / confirm modal — shows which columns will be typed
          and which off-type rows become blank BEFORE applying. It's a config
          (type_overrides), never a raw-data edit. */}
      {autoDetectPlan !== null && createPortal(
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
          onClick={() => !isApplyingTypes && setAutoDetectPlan(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-4 py-3">
              <div className="flex items-center gap-2">
                <Wand2 className="h-4 w-4 text-brand" />
                <h3 className="text-sm font-semibold text-text-primary">{t('datasets.grid.autoDetectPreviewTitle')}</h3>
              </div>
              <button
                type="button"
                aria-label="Close"
                disabled={isApplyingTypes}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
                onClick={() => setAutoDetectPlan(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <p className="mb-3 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-2 text-[11px] leading-relaxed text-text-tertiary">
                {t('datasets.grid.autoDetectConfigNote')}
              </p>
              {autoDetectPlan.length === 0 ? (
                <p className="py-6 text-center text-sm text-text-tertiary">{t('datasets.grid.autoDetectNone')}</p>
              ) : (
                <ul className="space-y-2">
                  {autoDetectPlan.map((s) => {
                    const bad = s.invalid_count ?? 0;
                    const ex = (s.invalid_examples ?? []).slice(0, 3);
                    return (
                      <li key={s.column} className="rounded-md border border-[rgb(var(--border-line))] px-3 py-2">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="truncate font-medium text-text-primary" title={s.column}>{s.column}</span>
                          <span className="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-[11px] font-semibold text-brand">
                            {s.suggested_type}{s.parse_format ? ` · ${s.parse_format}` : ''}
                          </span>
                        </div>
                        {bad > 0 && (
                          <div className="mt-1 text-[11px] text-warning">
                            ⚠ {t('datasets.grid.autoDetectRowsToBlank', { count: bad })}
                            {ex.length > 0 && (
                              <span className="ml-1 font-mono text-text-quaternary">
                                {t('datasets.formatPanel.examplePrefix')} {ex.map((e) => `"${e}"`).join(', ')}
                              </span>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] px-4 py-3">
              <button
                type="button"
                disabled={isApplyingTypes}
                onClick={() => setAutoDetectPlan(null)}
                className="rounded-md border border-[rgb(var(--border-line))] px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 disabled:opacity-50"
              >
                {t('datasets.grid.autoDetectCancel')}
              </button>
              <button
                type="button"
                disabled={isApplyingTypes || autoDetectPlan.length === 0}
                onClick={confirmAutoDetect}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isApplyingTypes && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('datasets.grid.autoDetectApplyBtn', { count: autoDetectPlan.length })}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
