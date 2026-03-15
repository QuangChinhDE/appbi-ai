/**
 * DatasetTableGrid - NocoDB-style grid component for table data preview
 * Includes PowerBI-like column formatting (display-only, client-side)
 */
'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Hash, Settings2, X, Trash2 } from 'lucide-react';

// ===================== Types =====================

export interface DatasetTableGridProps {
  columns: { name: string; type: string }[];
  rows: Record<string, any>[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onAddColumn?: () => void;
  /** User-defined type overrides loaded from DB: { colName: 'float' | 'date' | ... } */
  typeOverrides?: Record<string, string>;
  /** Called when the user changes a column's format type so the parent can persist it */
  onTypeOverride?: (colName: string, backendType: string | null) => void;
  /** Names of columns that were added via formula (can be deleted) */
  computedColumns?: string[];
  /** Called when user deletes a computed column */
  onDeleteColumn?: (colName: string) => void;
  /** Called when user wants to edit the formula of a computed column */
  onEditColumn?: (colName: string) => void;
  /** Full display formats from DB, restored on mount */
  columnFormatsDb?: Record<string, ColFormat>;
  /** Called when user applies a format so parent can persist to DB */
  onColumnFormatChange?: (colName: string, fmt: ColFormat | null) => void;
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

function validateColumnValues(values: any[], formatType: FormatType): ValidationResult {
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
      return isNaN(parseFloat(s)) || !isFinite(Number(s.replace(',', '.')));
    }
    if (formatType === 'date' || formatType === 'datetime') {
      if (s === '') return false;
      const d = new Date(s);
      return isNaN(d.getTime());
    }
    return false;
  };

  const badValues = nonEmpty.filter(isInvalid);
  const examples = badValues.slice(0, 3).map((v) => String(v));
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
  onApply: (fmt: ColFormat) => void;
  onClose: () => void;
  onReset: () => void;
  /** If set, show a delete button for this computed column */
  onDelete?: () => void;
  /** If set, show an edit formula button for this computed column */
  onEdit?: () => void;
}

function FormatPanel({ column, format, values, onApply, onClose, onReset, onDelete, onEdit }: FormatPanelProps) {
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

  // Sync draft when applied format changes from outside
  useEffect(() => { setDraft(initDraft(format)); }, [format]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const upd = (partial: Partial<ColFormat>) => setDraft((prev) => ({ ...prev, ...partial }));
  const isDirty = JSON.stringify(draft) !== JSON.stringify(format);

  // Validate current draft type against actual column data
  const validation = useMemo(
    () => validateColumnValues(values, draft.formatType),
    [values, draft.formatType]
  );

  const canApply = isDirty && validation.valid;

  // Sub-option visibility based on what the user has SELECTED in draft (not inferred column type)
  const draftIsNum = draft.formatType === 'number' || draft.formatType === 'currency' || draft.formatType === 'percentage';
  const draftIsDate = draft.formatType === 'date' || draft.formatType === 'datetime' || (draft.formatType === 'default' && isDateType(column.type));
  const draftIsDatetime = draft.formatType === 'datetime';

  return (
    <div
      className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-2xl z-50 text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-gray-50 rounded-t-lg">
        <span className="font-semibold text-gray-700 text-[11px] truncate max-w-[180px]">
          ⚙ Định dạng: {column.name}
        </span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 flex-shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* Format type — all types always visible so user can override any column */}
        <div>
          <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Định dạng kiểu cột</label>
          <select
            value={draft.formatType}
            onChange={(e) => upd({ formatType: e.target.value as FormatType })}
            className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="default">Mặc định (auto)</option>
            <option value="number">Số</option>
            <option value="currency">Tiền tệ</option>
            <option value="percentage">Phần trăm (%)</option>
            <option value="date">Ngày tháng (DATE)</option>
            <option value="datetime">Ngày giờ (DATETIME)</option>
            <option value="text">Văn bản</option>
          </select>
        </div>

        {/* Number / Currency / Percentage */}
        {draftIsNum && (
          <>
            {draft.formatType === 'currency' && (
              <div>
                <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Ký hiệu tiền tệ</label>
                <select
                  value={draft.currencySymbol}
                  onChange={(e) => upd({ currencySymbol: e.target.value })}
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Đơn vị rút gọn</label>
                <select
                  value={draft.displayUnit}
                  onChange={(e) => upd({ displayUnit: e.target.value as DisplayUnit })}
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="none">Không rút gọn</option>
                  <option value="K">K — nghìn</option>
                  <option value="M">M — triệu</option>
                  <option value="B">B — tỷ</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Số chữ số thập phân</label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={4}
                  value={draft.decimalPlaces}
                  onChange={(e) => upd({ decimalPlaces: parseInt(e.target.value) })}
                  className="flex-1 accent-blue-600"
                />
                <span className="w-5 text-center font-mono text-gray-700">{draft.decimalPlaces}</span>
              </div>
            </div>

            {draft.formatType !== 'percentage' && (
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={draft.thousandsSeparator}
                  onChange={(e) => upd({ thousandsSeparator: e.target.checked })}
                  className="w-3.5 h-3.5 rounded text-blue-600 accent-blue-600"
                />
                <span className="text-gray-600">Dấu phân cách nghìn (1,000)</span>
              </label>
            )}
          </>
        )}

        {/* Date / Datetime */}
        {draftIsDate && (
          <div>
            <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Định dạng ngày{draftIsDatetime ? ' giờ' : ''}</label>
            <select
              value={draft.dateFormat}
              onChange={(e) => upd({ dateFormat: e.target.value as DateFmt })}
              className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
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
          <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Định dạng chữ</label>
          <div className="grid grid-cols-4 gap-1">
            {(['none', 'upper', 'lower', 'title'] as TextCase[]).map((tc) => (
              <button
                key={tc}
                onClick={() => upd({ textCase: tc })}
                className={`py-1 border rounded text-[10px] font-medium transition-colors ${
                  draft.textCase === tc
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600'
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
            <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Tiền tố</label>
            <input
              type="text"
              value={draft.prefix}
              onChange={(e) => upd({ prefix: e.target.value })}
              placeholder="vd: ~"
              className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-1 font-semibold uppercase tracking-wide">Hậu tố</label>
            <input
              type="text"
              value={draft.suffix}
              onChange={(e) => upd({ suffix: e.target.value })}
              placeholder="vd: pts"
              className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Validation warning */}
        {isDirty && !validation.valid && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[10px] text-amber-800 space-y-0.5">
            <p className="font-semibold">⚠️ {validation.invalidCount}/{validation.total} giá trị không hợp lệ</p>
            <p className="text-amber-700">Cột này chứa dữ liệu không khớp kiểu <strong>{draft.formatType}</strong>.
              Cần sửa dữ liệu trước khi áp dụng.</p>
            {validation.examples.length > 0 && (
              <p className="font-mono text-[9px] text-amber-600 break-all">
                VD: {validation.examples.map((e) => `"${e}"`).join(', ')}
              </p>
            )}
          </div>
        )}

        {/* Apply button — explicit save */}
        <button
          onClick={() => { if (canApply) { onApply(draft); onClose(); } }}
          disabled={!canApply}
          className={`w-full py-1.5 rounded text-[11px] font-semibold transition-colors ${
            canApply
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : !isDirty
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-amber-100 text-amber-600 cursor-not-allowed'
          }`}
        >
          {!isDirty ? 'Chưa có thay đổi' : !validation.valid ? 'Dữ liệu chưa hợp lệ' : 'Áp dụng & Lưu'}
        </button>

        {/* Reset */}
        <button
          onClick={onReset}
          className="w-full text-center text-[10px] text-gray-400 hover:text-red-600 py-1.5 border border-dashed border-gray-300 rounded hover:border-red-300 transition-colors"
        >
          Đặt lại mặc định
        </button>

        {/* Delete computed column */}
        {onEdit && (
          <button
            onClick={onEdit}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-blue-600 border border-blue-200 rounded hover:bg-blue-50 hover:border-blue-400 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            Sửa công thức
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-red-600 border border-red-200 rounded hover:bg-red-50 hover:border-red-400 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Xóa cột này
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
  onAddColumn,
  typeOverrides,
  onTypeOverride,
  computedColumns,
  onDeleteColumn,
  onEditColumn,
  columnFormatsDb,
  onColumnFormatChange,
}: DatasetTableGridProps) {
  const computedColSet = useMemo(() => new Set(computedColumns ?? []), [computedColumns]);
  const [columnFormats, setColumnFormats] = useState<Record<string, ColFormat>>({});
  const [activeFormatCol, setActiveFormatCol] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialise format state from DB on table change.
  // columnFormatsDb (full format) takes priority over typeOverrides (type only).
  useEffect(() => {
    const initial: Record<string, ColFormat> = {};
    // 1. Seed from typeOverrides (type only)
    if (typeOverrides) {
      for (const [col, backendType] of Object.entries(typeOverrides)) {
        const formatType = backendTypeToFormatType(backendType);
        if (formatType !== 'default') {
          initial[col] = { ...DEFAULT_FORMAT, formatType };
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

  const setFormat = (name: string, fmt: ColFormat) => {
    const prev = columnFormats[name] ?? DEFAULT_FORMAT;
    setColumnFormats((s) => ({ ...s, [name]: fmt }));
    // Notify parent to persist full format to DB
    if (onColumnFormatChange) onColumnFormatChange(name, fmt);
    // Also notify type override if type changed (keeps type inference in sync)
    if (fmt.formatType !== prev.formatType && onTypeOverride) {
      onTypeOverride(name, formatTypeToBackendType(fmt.formatType));
    }
  };

  const resetFormat = (name: string) => {
    setColumnFormats((s) => {
      const next = { ...s };
      delete next[name];
      return next;
    });
    if (onColumnFormatChange) onColumnFormatChange(name, null);
    if (onTypeOverride) onTypeOverride(name, null);
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

  // ---- Loading skeleton ----
  if (isLoading) {
    return (
      <div className="border rounded-lg overflow-hidden bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th className="w-16 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">#</th>
                {[1, 2, 3, 4, 5].map((i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <div className="h-4 bg-gray-200 rounded animate-pulse w-24" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {[1, 2, 3, 4, 5].map((rowIdx) => (
                <tr key={rowIdx}>
                  <td className="w-16 px-4 py-3 text-sm text-gray-400 border-r">
                    <div className="h-4 bg-gray-100 rounded animate-pulse w-8" />
                  </td>
                  {[1, 2, 3, 4, 5].map((colIdx) => (
                    <td key={colIdx} className="px-4 py-3 text-sm">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
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
      <div className="border rounded-lg overflow-hidden bg-white p-8">
        <div className="text-center">
          <div className="text-red-600 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-1">Failed to load data</h3>
          <p className="text-sm text-gray-500 mb-4">{error}</p>
          {onRetry && (
            <button onClick={onRetry} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- Empty state ----
  if (rows.length === 0) {
    return (
      <div className="border rounded-lg overflow-hidden bg-white p-12">
        <div className="text-center">
          <div className="text-gray-400 mb-3">
            <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-1">No data</h3>
          <p className="text-sm text-gray-500">This table has no rows</p>
        </div>
      </div>
    );
  }

  // ---- Main table ----
  return (
    <div ref={containerRef} className="border rounded-lg overflow-hidden bg-white h-full flex flex-col">
      <div className="flex-1 overflow-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              {/* Row number */}
              <th className="w-16 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r bg-gray-50">
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
                        ? 'bg-amber-50 text-amber-700'
                        : 'bg-gray-50 text-gray-700'
                    }`}
                    title={`${column.name} (${column.type})${isComputed ? ' — cột công thức' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      {/* Column name + type badge */}
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        {isComputed && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                        )}
                        <span className="truncate">{column.name}</span>
                        <span className={`text-[10px] font-normal normal-case shrink-0 ${hasCustomFmt && colFmt.formatType !== 'default' ? 'text-blue-500' : isComputed ? 'text-amber-500' : 'text-gray-400'}`}>
                          {effectiveType}
                        </span>
                        {hasCustomFmt && (
                          <span className="text-blue-500 text-[8px] leading-none shrink-0" title="Đã tuỳ chỉnh định dạng">●</span>
                        )}
                      </div>

                      {/* Format button — gear icon, visible on hover or when active/customised */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveFormatCol(isActive ? null : column.name);
                        }}
                        className={`w-5 h-5 flex items-center justify-center rounded transition-all shrink-0 ${
                          isActive
                            ? 'opacity-100 text-blue-600 bg-blue-100'
                            : hasCustomFmt
                            ? 'opacity-100 text-blue-500 hover:bg-blue-50'
                            : 'opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-600 hover:bg-blue-50'
                        }`}
                        title="Định dạng cột"
                      >
                        <Settings2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Format popover */}
                    {isActive && (
                      <FormatPanel
                        column={column}
                        format={getFormat(column.name)}
                        values={rows.map((r) => r[column.name]).filter((v) => v !== null && v !== undefined)}
                        onApply={(f) => setFormat(column.name, f)}
                        onClose={() => setActiveFormatCol(null)}
                        onReset={() => {
                          resetFormat(column.name);
                          setActiveFormatCol(null);
                        }}
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
              {onAddColumn && (
                <th className="w-16 px-4 py-3 bg-gray-50 border-l">
                  <button
                    onClick={onAddColumn}
                    className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                    title="Add column"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </th>
              )}
            </tr>
          </thead>

          <tbody className="bg-white divide-y divide-gray-200">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-gray-50 transition-colors">
                <td className="w-16 px-4 py-3 text-sm text-gray-400 border-r font-mono">{rowIndex + 1}</td>
                {columns.map((column) => {
                  const isComputed2 = computedColSet.has(column.name);
                  const displayValue = applyFormat(row[column.name], getFormat(column.name), column.type);
                  const isLong = displayValue.length > 50;
                  return (
                    <td
                      key={`${rowIndex}-${column.name}`}
                      className={`px-4 py-3 text-sm ${
                        isComputed2 ? 'bg-amber-50 text-amber-900' : 'text-gray-900'
                      }`}
                      title={isLong ? displayValue : undefined}
                    >
                      <div className="max-w-xs truncate">{displayValue}</div>
                    </td>
                  );
                })}
                {onAddColumn && <td className="w-16 px-4 py-3 border-l" />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t bg-gray-50 px-4 py-2 flex items-center gap-4">
        <p className="text-xs text-gray-500">
          Showing {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </p>
        {computedColSet.size > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-amber-700">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
            {computedColSet.size} cột công thức
          </span>
        )}
        {Object.keys(columnFormats).length > 0 && (
          <button
            onClick={() => setColumnFormats({})}
            className="text-xs text-gray-400 hover:text-red-600 transition-colors"
          >
            Xoá tất cả định dạng ({Object.keys(columnFormats).length} cột)
          </button>
        )}
      </div>
    </div>
  );
}
