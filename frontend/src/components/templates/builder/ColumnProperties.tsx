'use client';

import React, { useState, useMemo } from 'react';
import { Trash2, ChevronRight, ChevronLeft, Search } from 'lucide-react';
import type { TemplateColumn, TemplateDataSource, ColumnType, NumberFormat } from '@/types/template';
import { Tooltip } from './Tooltip';

interface ColumnCacheEntry {
  name: string;
  type: string;
  nullable?: boolean;
}

interface ColumnPropertiesProps {
  column: TemplateColumn | null;
  columns: TemplateColumn[];
  dataSource?: TemplateDataSource;
  availableColumns?: ColumnCacheEntry[];  // from columns_cache
  onColumnChange: (col: TemplateColumn) => void;
  onRemoveColumn: (id: string) => void;
  onSelectColumn: (id: string | null) => void;
  onAddColumn: () => void;
  canEdit: boolean;
}

export function ColumnProperties({
  column,
  columns,
  dataSource,
  availableColumns,
  onColumnChange,
  onRemoveColumn,
  onSelectColumn,
  onAddColumn,
  canEdit,
}: ColumnPropertiesProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [colSearch, setColSearch] = useState('');

  const update = (patch: Partial<TemplateColumn>) => {
    if (!column) return;
    onColumnChange({ ...column, ...patch });
  };

  const filteredAvailCols = useMemo(() => {
    if (!availableColumns) return [];
    if (!colSearch) return availableColumns;
    const q = colSearch.toLowerCase();
    return availableColumns.filter((c) => c.name.toLowerCase().includes(q));
  }, [availableColumns, colSearch]);

  // Collapsed: thin strip with toggle
  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l border-gray-200 bg-white pt-2">
        <Tooltip content="Mở thanh cấu hình cột">
          <button
            onClick={() => setCollapsed(false)}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <div className="mt-4 -rotate-90 whitespace-nowrap text-[10px] font-medium tracking-wider text-gray-400 uppercase">
          Properties
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <div className="text-xs font-medium text-gray-900 truncate">
          {column ? (
            <>
              Column:{' '}
              <span className="font-mono text-blue-600">{column.label}</span>
            </>
          ) : (
            <span className="text-gray-400">Chọn 1 cột để cấu hình</span>
          )}
        </div>
        <Tooltip content="Thu nhỏ thanh cấu hình">
          <button
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto pb-3">
        {column && (
          <>
            {/* ── Column Type ── */}
            <SectionLabel>
              <Tooltip content="Raw: lấy từ dataset · Input: nhập tay · Formula: tính công thức · Subtotal: tổng phụ">
                <span>Loại cột</span>
              </Tooltip>
            </SectionLabel>
            <div className="flex gap-1 px-3 py-1.5">
              {(['raw', 'input', 'formula', 'subtotal'] as ColumnType[]).map((t) => (
                <button
                  key={t}
                  disabled={!canEdit}
                  onClick={() => update({ type: t })}
                  className={`flex-1 rounded-md px-1.5 py-1.5 text-[11px] capitalize border transition-colors ${
                    column.type === t
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {t === 'raw' ? 'Raw' : t === 'input' ? 'Input' : t === 'formula' ? 'Formula' : 'Subtotal'}
                </button>
              ))}
            </div>

            {/* ── Key & Label ── */}
            <SectionLabel>
              <Tooltip content="Key: tên biến dùng trong công thức. Label: tên hiển thị trên bảng">
                <span>Tên cột</span>
              </Tooltip>
            </SectionLabel>
            <PropRow label="Key (dùng trong công thức)">
              <PropInput value={column.key} onChange={(v) => update({ key: v })} disabled={!canEdit} mono />
            </PropRow>
            <PropRow label="Tên hiển thị">
              <PropInput value={column.label} onChange={(v) => update({ label: v })} disabled={!canEdit} />
            </PropRow>

            {/* ── Data Binding (raw/input) — dropdown picker ── */}
            {(column.type === 'raw' || column.type === 'input') && (
              <>
                <SectionLabel>
                  <Tooltip content="Chọn cột dữ liệu từ dataset đã bind. Click để chọn thay vì nhập tay">
                    <span>Liên kết dữ liệu</span>
                  </Tooltip>
                </SectionLabel>
                {availableColumns && availableColumns.length > 0 ? (
                  <div className="px-3 py-1.5">
                    <label className="text-[10px] font-medium text-gray-500 mb-1 block">Cột nguồn</label>
                    {/* Search filter for columns */}
                    <div className="flex items-center gap-1.5 border border-gray-300 rounded-md px-2 py-1 mb-1.5 focus-within:ring-2 focus-within:ring-blue-500">
                      <Search className="h-3 w-3 text-gray-400 shrink-0" />
                      <input
                        className="flex-1 bg-transparent text-xs outline-none placeholder:text-gray-400 font-mono"
                        value={colSearch}
                        onChange={(e) => setColSearch(e.target.value)}
                        placeholder="Tìm cột..."
                      />
                    </div>
                    {/* Column list */}
                    <div className="max-h-[180px] overflow-y-auto rounded-md border border-gray-200 bg-gray-50">
                      {filteredAvailCols.map((ac) => {
                        const isBound = column.sourceColumn === ac.name;
                        const isUsed = !isBound && columns.some((c) => c.sourceColumn === ac.name && c.id !== column.id);
                        return (
                          <button
                            key={ac.name}
                            disabled={!canEdit}
                            onClick={() => {
                              update({ sourceColumn: ac.name });
                              setColSearch('');
                            }}
                            className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs font-mono border-b border-gray-100 last:border-0 transition-colors ${
                              isBound
                                ? 'bg-blue-50 text-blue-700 font-medium'
                                : isUsed
                                  ? 'text-gray-400 hover:bg-gray-100'
                                  : 'text-gray-700 hover:bg-blue-50'
                            }`}
                          >
                            <span className="truncate">{ac.name}</span>
                            <span className="ml-2 shrink-0 text-[9px] text-gray-400">{ac.type}</span>
                          </button>
                        );
                      })}
                      {filteredAvailCols.length === 0 && (
                        <div className="px-2 py-3 text-center text-[10px] text-gray-400">
                          Không tìm thấy cột
                        </div>
                      )}
                    </div>
                    <div className="mt-1 text-[9px] text-gray-400">
                      Đang liên kết: <span className="font-mono text-blue-600">{column.sourceColumn || '—'}</span>
                    </div>
                  </div>
                ) : (
                  <PropRow label="Cột nguồn (nhập tay)">
                    <PropInput
                      value={column.sourceColumn ?? ''}
                      onChange={(v) => update({ sourceColumn: v || undefined })}
                      disabled={!canEdit}
                      mono
                      placeholder="Bind dataset trước để chọn"
                    />
                  </PropRow>
                )}
              </>
            )}

            {/* ── Formula (formula/subtotal) ── */}
            {(column.type === 'formula' || column.type === 'subtotal') && (
              <>
                <SectionLabel>
                  <Tooltip content="Viết công thức dùng key của các cột khác. VD: bac_luong * ngay_cong">
                    <span>Công thức</span>
                  </Tooltip>
                </SectionLabel>
                <PropRow label="Biểu thức">
                  <PropInput
                    value={column.expression ?? ''}
                    onChange={(v) => update({ expression: v })}
                    disabled={!canEdit}
                    mono
                    placeholder="e.g. col_a * col_b"
                  />
                </PropRow>
              </>
            )}

            {/* ── Number Format ── */}
            <SectionLabel>Định dạng số</SectionLabel>
            <PropRow label="Kiểu">
              <select
                value={column.format ?? 'text'}
                onChange={(e) => update({ format: e.target.value as NumberFormat })}
                disabled={!canEdit}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="text">Text</option>
                <option value="integer">Integer (phân cách nghìn)</option>
                <option value="decimal">Decimal (2 số lẻ)</option>
                <option value="percentage">Phần trăm</option>
              </select>
            </PropRow>
            <PropRow label="Hậu tố">
              <PropInput
                value={column.suffix ?? ''}
                onChange={(v) => update({ suffix: v || undefined })}
                disabled={!canEdit}
                mono
                placeholder="KIP, USD, %"
              />
            </PropRow>

            {/* ── Display ── */}
            <SectionLabel>Hiển thị</SectionLabel>
            <div className="flex gap-2 px-3 py-1.5">
              <div className="flex-1">
                <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Rộng (px)</label>
                <PropInput
                  value={String(column.width ?? '')}
                  onChange={(v) => update({ width: v ? parseInt(v) || undefined : undefined })}
                  disabled={!canEdit}
                  mono
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Căn lề</label>
                <div className="flex gap-0.5">
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <button
                      key={a}
                      disabled={!canEdit}
                      onClick={() => update({ align: a })}
                      className={`flex-1 rounded-md px-1 py-1.5 text-[10px] capitalize border transition-colors ${
                        column.align === a
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {a === 'left' ? '◂' : a === 'center' ? '≡' : '▸'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <PropRow label="">
              <div className="flex gap-2">
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={column.bold ?? false}
                    onChange={(e) => update({ bold: e.target.checked })}
                    disabled={!canEdit}
                    className="rounded border-gray-300 text-blue-600 h-3.5 w-3.5"
                  />
                  In đậm
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={column.highlightNegative ?? false}
                    onChange={(e) => update({ highlightNegative: e.target.checked })}
                    disabled={!canEdit}
                    className="rounded border-gray-300 text-blue-600 h-3.5 w-3.5"
                  />
                  Đánh dấu số âm
                </label>
              </div>
            </PropRow>

            {/* ── Delete column ── */}
            {canEdit && (
              <div className="px-3 pt-3">
                <button
                  onClick={() => onRemoveColumn(column.id)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-red-200 bg-red-50 py-1.5 text-xs text-red-600 hover:bg-red-100 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Xoá cột
                </button>
              </div>
            )}
          </>
        )}

        {/* ── Column chips ── */}
        <SectionLabel>Các cột trong template</SectionLabel>
        <div className="flex flex-wrap gap-1 px-3 py-1.5">
          {columns.map((col) => {
            const isActive = col.id === column?.id;
            const isFormula = col.type === 'formula' || col.type === 'subtotal';
            const isInput = col.type === 'input';

            const chipClasses = isFormula
              ? 'border-amber-300 bg-amber-50 text-amber-700'
              : isActive
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-gray-200 bg-gray-50 text-gray-600';

            const dotColor = isFormula ? 'bg-amber-500' : isInput ? 'bg-blue-500' : 'bg-gray-400';

            return (
              <button
                key={col.id}
                onClick={() => onSelectColumn(col.id)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono cursor-pointer transition-colors ${chipClasses}`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
                {col.label}
              </button>
            );
          })}
          {canEdit && (
            <button
              onClick={onAddColumn}
              className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[10px] text-gray-400 hover:text-gray-600 hover:border-gray-400 cursor-pointer transition-colors"
            >
              + thêm
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Reusable mini components ──────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
      {children}
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-1">
      {label && <label className="text-[10px] font-medium text-gray-500">{label}</label>}
      {children}
    </div>
  );
}

function PropInput({
  value,
  onChange,
  disabled,
  mono,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      className={`w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-blue-500 ${
        mono ? 'font-mono' : ''
      } ${disabled ? 'bg-gray-50 cursor-not-allowed text-gray-400' : 'text-gray-900'}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
    />
  );
}
