/**
 * AddColumnModal — Excel-style formula column builder
 *
 * Supported syntax:
 *   - Cell refs:  [ColumnName]  →  value of that column in current row
 *   - Functions:  IF, SUM, ROUND, CONCATENATE, TEXT, LEFT, RIGHT, MID,
 *                 LEN, TRIM, UPPER, LOWER, IFERROR, AND, OR, NOT, DATE, TODAY, NOW,
 *                 MAX, MIN, ABS, CEILING, FLOOR, MOD, POWER, SQRT, etc.
 *   - Operators:  + - * / & (string concat) > < >= <= <> = (equality)
 *   - Strings:    "hello"
 *   - Numbers:    123, 1.5
 */
'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { X, Loader2, AlertCircle, Play, ChevronDown, ChevronRight, Info } from 'lucide-react';
import type { DatasetTable, Transformation } from '@/hooks/use-datasets';
import * as formulajs from 'formulajs';

// ─── formula evaluator ──────────────────────────────────────────────────────────────────────

/**
 * Transpile an Excel-style formula to runnable JavaScript, then eval it.
 *
 * Column refs:  [My Column]  → row["My Column"]
 * String concat operator &  →  +  (JS)
 * Equality =  outside quotes  → ===
 * Not-equal <>  → !==
 * Boolean literals TRUE/FALSE → true/false
 * Function calls forwarded to formulajs namespace
 */
function evalExcelFormula(
  formula: string,
  row: Record<string, any>,
  fns: Record<string, Function>
): { ok: true; value: any } | { ok: false; error: string } {
  try {
    // 1. Replace [Column Name] with a sentinel then swap to row access
    const colMap: Record<string, string> = {};
    let idx = 0;
    let expr = formula.replace(/\[([^\]]+)\]/g, (_m, name) => {
      const key = `__COL${idx++}__`;
      colMap[key] = name;
      return key;
    });

    // 2. Tokenise string literals out so we don’t clobber their contents
    const strings: string[] = [];
    expr = expr.replace(/"([^"]*)"/g, (_m, s) => {
      strings.push(s);
      return `__STR${strings.length - 1}__`;
    });

    // 3. Operator transpilation (safe now that strings are masked)
    expr = expr
      .replace(/<>/g, '!==')
      .replace(/(?<![<>!=])=(?![>=])/g, '===')
      .replace(/&/g, '+')
      .replace(/\bTRUE\b/gi, 'true')
      .replace(/\bFALSE\b/gi, 'false');

    // 4. Route known function calls to __FN namespace
    expr = expr.replace(/\b([A-Z][A-Z0-9_]*)\s*\(/g, (m, name) => {
      if (name in fns) return `__FN.${name}(`;
      return m;
    });

    // 5. Restore string literals
    expr = expr.replace(/__STR(\d+)__/g, (_m, i) => JSON.stringify(strings[Number(i)]));

    // 6. Expand column sentinels to row["..."] lookups
    for (const [key, colName] of Object.entries(colMap)) {
      expr = expr.replace(new RegExp(key, 'g'), `__ROW[${JSON.stringify(colName)}]`);
    }

    // eslint-disable-next-line no-new-func
    const fn = new Function('__ROW', '__FN', `return (${expr});`);
    const result = fn(row, fns);
    return { ok: true, value: result };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function renderValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ─── function catalogue ───────────────────────────────────────────────────────────────────────

const FUNCTION_GROUPS: { group: string; fns: { name: string; desc: string; example: string }[] }[] = [
  {
    group: 'Logic',
    fns: [
      { name: 'IF', desc: 'Điều kiện', example: 'IF([Doanh_thu]>1000000,"Cao","Thấp")' },
      { name: 'IFERROR', desc: 'Bẫy lỗi', example: 'IFERROR([A]/[B],0)' },
      { name: 'AND', desc: 'Và', example: 'AND([A]>0,[B]>0)' },
      { name: 'OR', desc: 'Hoặc', example: 'OR([A]="X",[A]="Y")' },
      { name: 'NOT', desc: 'Phủ định', example: 'NOT([Active])' },
    ],
  },
  {
    group: 'Số học',
    fns: [
      { name: 'ROUND', desc: 'Làm tròn', example: 'ROUND([Price]*[Qty],0)' },
      { name: 'ROUNDUP', desc: 'Làm tròn lên', example: 'ROUNDUP([Val],2)' },
      { name: 'ROUNDDOWN', desc: 'Làm tròn xuống', example: 'ROUNDDOWN([Val],2)' },
      { name: 'ABS', desc: 'Trị tuyệt đối', example: 'ABS([Diff])' },
      { name: 'MOD', desc: 'Phần dư', example: 'MOD([Total],7)' },
      { name: 'POWER', desc: 'Lũy thừa', example: 'POWER([Base],2)' },
      { name: 'SQRT', desc: 'Căn bậu hai', example: 'SQRT([Area])' },
      { name: 'SUM', desc: 'Tổng (nhiều giá trị)', example: 'SUM([A],[B],[C])' },
      { name: 'MAX', desc: 'Lớn nhất', example: 'MAX([A],[B])' },
      { name: 'MIN', desc: 'Nhỏ nhất', example: 'MIN([A],[B])' },
      { name: 'CEILING', desc: 'Làm tròn lên bội số', example: 'CEILING([Val],1000)' },
      { name: 'FLOOR', desc: 'Làm tròn xuống bội số', example: 'FLOOR([Val],1000)' },
    ],
  },
  {
    group: 'Chuỗi',
    fns: [
      { name: 'CONCATENATE', desc: 'Nối chuỗi', example: 'CONCATENATE([HoTen]," - ",[MaNV])' },
      { name: 'LEFT', desc: 'N ký tự trái', example: 'LEFT([Code],3)' },
      { name: 'RIGHT', desc: 'N ký tự phải', example: 'RIGHT([Code],4)' },
      { name: 'MID', desc: 'Cắt giữa', example: 'MID([Code],2,3)' },
      { name: 'LEN', desc: 'Độ dài', example: 'LEN([Name])' },
      { name: 'TRIM', desc: 'Xoá khoảng trắng', example: 'TRIM([Name])' },
      { name: 'UPPER', desc: 'Viết hoa', example: 'UPPER([Name])' },
      { name: 'LOWER', desc: 'Viết thường', example: 'LOWER([Name])' },
      { name: 'TEXT', desc: 'Định dạng số/ngày', example: 'TEXT([Price],"#,##0")' },
      { name: 'SUBSTITUTE', desc: 'Thay thế chuỗi', example: 'SUBSTITUTE([Addr],"HN","Hà Nội")' },
      { name: 'FIND', desc: 'Tìm vị trí', example: 'FIND("-",[Code])' },
    ],
  },
  {
    group: 'Ngày tháng',
    fns: [
      { name: 'TODAY', desc: 'Ngày hôm nay', example: 'TODAY()' },
      { name: 'NOW', desc: 'Ngày giờ hiện tại', example: 'NOW()' },
      { name: 'DATE', desc: 'Tạo ngày', example: 'DATE(2026,3,14)' },
      { name: 'YEAR', desc: 'Lấy năm', example: 'YEAR([OrderDate])' },
      { name: 'MONTH', desc: 'Lấy tháng', example: 'MONTH([OrderDate])' },
      { name: 'DAY', desc: 'Lấy ngày', example: 'DAY([OrderDate])' },
      { name: 'DATEDIF', desc: 'Khoảng cách ngày', example: 'DATEDIF([BirthDate],TODAY(),"Y")' },
    ],
  },
  {
    group: 'Lookup bảng khác',
    fns: [
      { name: 'LOOKUP', desc: 'Tìm giá trị từ bảng khác trong dataset', example: 'LOOKUP([ma_kh],"Khách_hàng","ma_kh","ten_kh")' },
      { name: 'VLOOKUP', desc: 'Alias của LOOKUP (cú pháp tương tự)', example: 'VLOOKUP([product_id],"Sản_phẩm","id","tên")' },
    ],
  },
];

// Base FNS map — formulajs functions only (no lookup, which is runtime-dynamic)
const FNS_BASE: Record<string, Function> = {};
for (const group of FUNCTION_GROUPS) {
  for (const fn of group.fns) {
    if (fn.name in (formulajs as any)) {
      FNS_BASE[fn.name] = (formulajs as any)[fn.name];
    }
  }
}

/**
 * Build the full FNS map, optionally injecting LOOKUP bound to cross-table data.
 * lookupData: { [tableLabel]: rows[] } — keyed by the same label shown in columnGroups.
 *
 * Table name matching: case-insensitive, trims whitespace.
 * Value matching: case-insensitive string comparison after trimming.
 */
export function buildFNS(
  lookupData?: Record<string, Record<string, any>[]>
): Record<string, Function> {
  const fns: Record<string, Function> = { ...FNS_BASE };
  if (lookupData && Object.keys(lookupData).length > 0) {
    // Build case-insensitive index of table names
    const tableIndex: Record<string, Record<string, any>[]> = {};
    for (const [key, rows] of Object.entries(lookupData)) {
      tableIndex[key.trim().toLowerCase()] = rows;
    }

    const lookup = (searchValue: any, tableName: string, searchCol: string, returnCol: string) => {
      // Case-insensitive table name lookup
      const tableRows = tableIndex[String(tableName).trim().toLowerCase()] ?? [];
      if (tableRows.length === 0) return null;
      // Case-insensitive, trimmed value match
      const needle = String(searchValue ?? '').trim().toLowerCase();
      const found = tableRows.find(
        (r) => String(r[searchCol] ?? '').trim().toLowerCase() === needle
      );
      return found !== undefined ? (found[returnCol] ?? null) : null;
    };
    fns['LOOKUP'] = lookup;
    fns['VLOOKUP'] = lookup;
  }
  return fns;
}

// Convenience constant when no lookup data is needed
const FNS = buildFNS();

// ─── component ────────────────────────────────────────────────────────────────────────────────

/** Column group — e.g. primary table columns vs join partner columns */
export interface ColumnGroup {
  /** Display label, e.g. "orders" or "customers (join)" */
  sourceLabel: string;
  columns: string[];
}

interface AddColumnModalProps {
  table: DatasetTable;
  /**
   * Flat list used when no grouping needed.
   * If columnGroups is also supplied, columnGroups takes priority.
   */
  allColumns: string[];
  /**
   * Optional grouped columns — supply this when the table involves JOINs
   * so the user can see which source each column belongs to.
   */
  columnGroups?: ColumnGroup[];
  previewRows: Record<string, any>[];
  /**
   * Lookup data keyed by table label (= sourceLabel in columnGroups).
   * Each entry is the rows from that table's sample cache.
   * Used by LOOKUP / VLOOKUP functions in formulas.
   */
  lookupData?: Record<string, Record<string, any>[]>;
  isOpen: boolean;
  onClose: () => void;
  onSave: (transformations: Transformation[]) => Promise<void>;
  /** When provided the modal opens in EDIT mode for this existing step */
  editingStep?: Transformation | null;
}

export function AddColumnModal({
  table,
  allColumns,
  columnGroups,
  previewRows,
  lookupData,
  isOpen,
  onClose,
  onSave,
  editingStep,
}: AddColumnModalProps) {
  const isEditMode = !!editingStep;

  const [columnName, setColumnName] = useState('');
  const [formula, setFormula] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>('Logic');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const livePreview = useMemo(() => {
    if (!formula.trim()) return [];
    const fns = buildFNS(lookupData);
    return previewRows.slice(0, 5).map((row) => evalExcelFormula(formula, row, fns));
  }, [formula, previewRows, lookupData]);

  const hasPreviewError = livePreview.some((r) => !r.ok);
  const allPreviewOk = livePreview.length > 0 && livePreview.every((r) => r.ok);

  useEffect(() => {
    if (isOpen) {
      if (editingStep) {
        setColumnName(editingStep.params.newField ?? '');
        setFormula(editingStep.params.formula ?? editingStep.params.code ?? '');
      } else {
        setColumnName('');
        setFormula('');
      }
      setSaveError(null);
    }
  }, [isOpen, editingStep]);

  const insertColumnRef = (colName: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    const snippet = `[${colName}]`;
    const next = formula.slice(0, s) + snippet + formula.slice(ta.selectionEnd);
    setFormula(next);
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + snippet.length; ta.focus(); });
  };

  const insertFnExample = (example: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    const next = formula.slice(0, s) + example + formula.slice(ta.selectionEnd);
    setFormula(next);
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + example.length; ta.focus(); });
  };

  const handleSave = async () => {
    setSaveError(null);
    if (!isEditMode && !columnName.trim()) { setSaveError('Vui lòng nhập tên cột'); return; }
    if (!isEditMode && /\s/.test(columnName.trim())) { setSaveError('Tên cột không được chứa khoảng trắng'); return; }
    if (!formula.trim()) { setSaveError('Vui lòng nhập công thức'); return; }
    if (previewRows.length > 0) {
      const check = evalExcelFormula(formula, previewRows[0], buildFNS(lookupData));
      if (!check.ok) { setSaveError(`Lỗi công thức: ${check.error}`); return; }
    }
    setIsSaving(true);
    try {
      const existing = table.transformations || [];
      if (isEditMode && editingStep) {
        // EDIT: replace existing step in-place, preserving order
        const updated = existing.map((t) =>
          t.id === editingStep.id
            ? { ...t, params: { ...t.params, formula: formula.trim() } }
            : t
        );
        await onSave(updated);
      } else {
        // ADD: append new step
        const newStep: Transformation = {
          id: crypto.randomUUID(),
          type: 'js_formula',
          enabled: true,
          params: { newField: columnName.trim(), formula: formula.trim() },
        };
        await onSave([...existing, newStep]);
      }
      onClose();
    } catch (e: any) {
      setSaveError('Lưu thất bại: ' + (e?.message ?? String(e)));
    } finally {
      setIsSaving(false);
    }
  };

  // Resolved column groups: prefer explicit groups, fall back to flat allColumns
  // Must be before early return to satisfy Rules of Hooks
  const resolvedGroups: ColumnGroup[] = useMemo(() => {
    if (columnGroups && columnGroups.length > 0) return columnGroups;
    if (allColumns.length === 0) return [];
    return [{ sourceLabel: table.display_name || table.source_table_name || 'Cột', columns: allColumns }];
  }, [columnGroups, allColumns, table.display_name, table.source_table_name]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      {/* Fixed 900×640 — does not resize when panels expand */}
      <div className="bg-white rounded-xl shadow-2xl flex flex-col" style={{ width: 900, height: 640 }}>

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {isEditMode ? `Sửa cột: ${editingStep?.params.newField}` : 'Thêm cột tính toán'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {isEditMode ? 'Sửa công thức Excel · tên cột không thể đổi' : 'Dùng công thức Excel để tạo cột mới từ dữ liệu hiện có'}
            </p>
          </div>
          <button onClick={onClose} disabled={isSaving} className="text-gray-400 hover:text-gray-600 mt-0.5">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Left: editor */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

            {/* Column name — hidden (and fixed) in edit mode */}
            {!isEditMode && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tên cột mới <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={columnName}
                  onChange={(e) => setColumnName(e.target.value)}
                  placeholder="vd: THANH_TIEN  (không khoảng trắng)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isSaving}
                />
              </div>
            )}

            {/* Column chips — grouped by source table */}
            {resolvedGroups.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1.5 font-medium">Cột khả dụng — click để chèn:</p>
                <div className="space-y-2 max-h-28 overflow-y-auto">
                  {resolvedGroups.map((group) => (
                    <div key={group.sourceLabel}>
                      {/* Show source label only when there are multiple groups (joins) */}
                      {resolvedGroups.length > 1 && (
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                          📋 {group.sourceLabel}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {group.columns.map((col) => (
                          <button key={col} type="button" onClick={() => insertColumnRef(col)}
                            className="px-2 py-0.5 text-[11px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 transition-colors">
                            [{col}]
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Formula input */}
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">
                Công thức <span className="text-red-500">*</span>
              </label>
              <div className="relative border border-gray-300 rounded-md overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500">
                <textarea
                  ref={textareaRef}
                  value={formula}
                  onChange={(e) => setFormula(e.target.value)}
                  spellCheck={false}
                  placeholder={`IF([Doanh_thu]>1000000,"Cao","Thấp")`}
                  className="w-full px-3 py-2 font-mono text-sm focus:outline-none resize-y min-h-[90px] bg-white"
                  disabled={isSaving}
                  onKeyDown={(e) => {
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      const ta = e.currentTarget;
                      const s = ta.selectionStart;
                      const next = formula.slice(0, s) + '  ' + formula.slice(ta.selectionEnd);
                      setFormula(next);
                      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
                    }
                  }}
                />
              </div>
              <p className="mt-1 text-[10px] text-gray-400">
                Dùng <code className="bg-gray-100 px-0.5 rounded">[TênCột]</code> để tham chiếu cột · cú pháp y hệt Excel
              </p>
            </div>

            {/* Live preview */}
            {previewRows.length > 0 && formula.trim() && (
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <Play className="w-3.5 h-3.5 text-gray-500" />
                  <span className="text-xs font-medium text-gray-700">Xem trước ({Math.min(5, previewRows.length)} hàng đầu)</span>
                  {allPreviewOk && <span className="text-[10px] text-green-600 font-medium">✓ Hợp lệ</span>}
                  {hasPreviewError && <span className="text-[10px] text-red-600 font-medium">✗ Có lỗi</span>}
                </div>
                <div className="border border-gray-200 rounded-md overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-1.5 text-left text-gray-500 font-medium w-10">#</th>
                        <th className="px-3 py-1.5 text-left text-gray-500 font-medium">{columnName.trim() || '(tên cột)'}</th>
                        <th className="px-3 py-1.5 text-left text-gray-500 font-medium w-28">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {livePreview.map((res, i) => (
                        <tr key={i} className={res.ok ? 'bg-white' : 'bg-red-50'}>
                          <td className="px-3 py-1.5 text-gray-400 font-mono">{i + 1}</td>
                          <td className="px-3 py-1.5 font-mono truncate max-w-xs">
                            {res.ok
                              ? <span className="text-gray-800">{renderValue(res.value)}</span>
                              : <span className="text-red-400">—</span>}
                          </td>
                          <td className="px-3 py-1.5">
                            {res.ok
                              ? <span className="text-green-600">✓ OK</span>
                              : <span className="text-red-600 break-all text-[10px]">{(res as any).error}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {saveError && (
              <div className="flex items-start gap-2 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{saveError}</span>
              </div>
            )}
          </div>

          {/* Right: function reference panel */}
          <div className="w-60 border-l bg-gray-50 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b bg-white shrink-0">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-blue-500" />
                Hàm Excel khả dụng
              </p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {/* Lookup table list */}
              {lookupData && Object.keys(lookupData).length > 0 && (
                <div className="px-3 py-2 border-b bg-amber-50">
                  <p className="text-[10px] font-semibold text-amber-700 mb-1.5">Bảng lookup khả dụng:</p>
                  <div className="space-y-1">
                    {Object.entries(lookupData).map(([tableKey, rows]) => (
                      <button
                        key={tableKey}
                        type="button"
                        onClick={() => insertFnExample(`LOOKUP([khóa],"${tableKey}","cột_khóa","cột_cần_lấy")`)}
                        className="w-full text-left px-2 py-1 bg-amber-100 hover:bg-amber-200 rounded border border-amber-200 transition-colors"
                      >
                        <span className="text-[10px] font-mono font-semibold text-amber-800 block">"{tableKey}"</span>
                        <span className="text-[9px] text-amber-600">{rows.length} rows cache · click chèn mẫu</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {FUNCTION_GROUPS.map((group) => (
                <div key={group.group}>
                  <button
                    className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold text-gray-600 hover:bg-gray-100 transition-colors"
                    onClick={() => setOpenGroup(openGroup === group.group ? null : group.group)}
                  >
                    <span>{group.group}</span>
                    {openGroup === group.group
                      ? <ChevronDown className="w-3 h-3" />
                      : <ChevronRight className="w-3 h-3" />}
                  </button>
                  {openGroup === group.group && (
                    <div className="pb-1">
                      {group.fns.map((fn) => (
                        <button
                          key={fn.name}
                          type="button"
                          onClick={() => insertFnExample(fn.example)}
                          className="w-full text-left px-3 py-1.5 hover:bg-blue-50 group"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-mono font-semibold text-blue-700 group-hover:text-blue-900">{fn.name}</span>
                            <span className="text-[9px] text-gray-400">chèn</span>
                          </div>
                          <p className="text-[10px] text-gray-500 mt-0.5">{fn.desc}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t bg-gray-50 rounded-b-xl">
          <p className="text-[11px] text-gray-400">Tính toán trong trình duyệt · cú pháp Excel</p>
          <div className="flex gap-3">
            <button onClick={onClose} disabled={isSaving} className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900">Huỷ</button>
            <button
              onClick={handleSave}
              disabled={isSaving || (!isEditMode && !columnName.trim()) || !formula.trim() || hasPreviewError}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEditMode ? 'Cập nhật cột' : 'Thêm cột'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
