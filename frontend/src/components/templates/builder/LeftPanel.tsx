'use client';

import React, { useState, useMemo } from 'react';
import {
  Database,
  Plus,
  ChevronDown,
  ChevronRight,
  Trash2,
  FileDown,
  Printer,
  GripVertical,
  X,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type {
  TemplateDefinition,
  TemplateFilter,
  TemplateColumn,
  TemplateDataSource,
  TemplateFooter,
  ColumnGroup,
  HeaderLine,
  NumberFormat,
  ColumnType,
} from '@/types/template';
import type { TablePreviewResponse } from '@/hooks/use-datasets';
import type { TemplatePreviewFormulaError } from '@/hooks/use-template-data';

interface LeftPanelProps {
  definition: TemplateDefinition;
  templateFilters: TemplateFilter[];
  selectedColumn: TemplateColumn | null;
  availableColumns?: Array<{ name: string; type: string; nullable?: boolean }>;
  previewData?: TablePreviewResponse;
  formulaErrors: TemplatePreviewFormulaError[];
  previewErrorMessage?: string | null;
  isLoadingData: boolean;
  rowCount: number;
  totalRows: number;
  canEdit: boolean;
  onOpenDataSourcePicker: () => void;
  onColumnChange: (col: TemplateColumn) => void;
  onRemoveColumn: (id: string) => void;
  onSelectColumn: (id: string | null) => void;
  onAddColumn: () => void;
  onReorderColumns: (from: number, to: number) => void;
  onGroupByChange: (groupBy: string | undefined) => void;
  onHeaderLinesChange: (lines: HeaderLine[]) => void;
  onHeaderTitleChange: (title: string, meta?: string) => void;
  onFooterChange: (footer: TemplateFooter) => void;
  onColumnGroupsChange: (groups: ColumnGroup[]) => void;
  onTemplateFiltersChange: (filters: TemplateFilter[]) => void;
  onExportExcel: () => void;
  onExportPDF: () => void;
}

type SectionKey = 'columns' | 'filters' | 'structure' | 'export';

export function LeftPanel({
  definition,
  templateFilters,
  selectedColumn,
  availableColumns,
  previewData,
  formulaErrors,
  previewErrorMessage,
  isLoadingData,
  rowCount,
  totalRows,
  canEdit,
  onOpenDataSourcePicker,
  onColumnChange,
  onRemoveColumn,
  onSelectColumn,
  onAddColumn,
  onReorderColumns,
  onGroupByChange,
  onHeaderLinesChange,
  onHeaderTitleChange,
  onFooterChange,
  onColumnGroupsChange,
  onTemplateFiltersChange,
  onExportExcel,
  onExportPDF,
}: LeftPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(
    new Set(['columns', 'filters', 'structure']),
  );
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const formulaErrorByKey = useMemo(
    () => new Map(formulaErrors.map((item) => [item.key, item.error])),
    [formulaErrors],
  );

  const toggleSection = (key: SectionKey) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const update = (patch: Partial<TemplateColumn>) => {
    if (!selectedColumn) return;
    onColumnChange({ ...selectedColumn, ...patch });
  };

  const groupableColumns = definition.columns.filter(
    (c) => c.type === 'raw' || c.type === 'input',
  );
  const filterableColumns = availableColumns ?? [];

  const addTemplateFilter = () => {
    if (!definition.dataSource) return;
    onTemplateFiltersChange([
      ...templateFilters,
      {
        id: uuidv4(),
        label: `Bộ lọc ${templateFilters.length + 1}`,
        datasetId: definition.dataSource.datasetId,
        tableId: definition.dataSource.tableId,
        column: filterableColumns[0]?.name ?? '',
        operator: 'eq',
        defaultValue: '',
      },
    ]);
  };

  const updateTemplateFilter = (filterId: string, patch: Partial<TemplateFilter>) => {
    onTemplateFiltersChange(
      templateFilters.map((filter) =>
        filter.id === filterId
          ? {
              ...filter,
              ...patch,
              datasetId: definition.dataSource?.datasetId ?? filter.datasetId,
              tableId: definition.dataSource?.tableId ?? filter.tableId,
            }
          : filter,
      ),
    );
  };

  const removeTemplateFilter = (filterId: string) => {
    onTemplateFiltersChange(templateFilters.filter((filter) => filter.id !== filterId));
  };

  /* ── Column Groups helpers ── */
  const columnGroups = definition.columnGroups ?? [];
  const addColumnGroup = () => {
    onColumnGroupsChange([...columnGroups, { id: uuidv4(), label: 'Nhóm mới', columnIds: [] }]);
  };
  const updateColumnGroup = (idx: number, patch: Partial<ColumnGroup>) => {
    onColumnGroupsChange(columnGroups.map((g, i) => (i === idx ? { ...g, ...patch } : g)));
  };
  const removeColumnGroup = (idx: number) => {
    onColumnGroupsChange(columnGroups.filter((_, i) => i !== idx));
  };
  const toggleColumnInGroup = (groupIdx: number, colId: string) => {
    const group = columnGroups[groupIdx];
    const ids = group.columnIds.includes(colId)
      ? group.columnIds.filter((id) => id !== colId)
      : [...group.columnIds, colId];
    updateColumnGroup(groupIdx, { columnIds: ids });
  };

  /* ── Footer helpers ── */
  const footer = definition.footer ?? {};
  const addFooterLine = () => {
    const lines = footer.lines ?? [];
    onFooterChange({ ...footer, lines: [...lines, { text: '', align: 'left', fontSize: 'sm' }] });
  };
  const updateFooterLine = (idx: number, text: string) => {
    const lines = (footer.lines ?? []).map((l, i) => (i === idx ? { ...l, text } : l));
    onFooterChange({ ...footer, lines });
  };
  const removeFooterLine = (idx: number) => {
    onFooterChange({ ...footer, lines: (footer.lines ?? []).filter((_, i) => i !== idx) });
  };

  /* ── Header helpers ── */
  const headerLines = definition.header?.lines ?? [];
  const addHeaderLine = () => {
    onHeaderLinesChange([...headerLines, { text: '', align: 'left', fontSize: 'base' }]);
  };
  const updateHeaderLineText = (idx: number, text: string) => {
    onHeaderLinesChange(headerLines.map((l, i) => (i === idx ? { ...l, text } : l)));
  };
  const removeHeaderLine = (idx: number) => {
    onHeaderLinesChange(headerLines.filter((_, i) => i !== idx));
  };

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-[rgb(var(--border-line))] bg-surface-1 pt-3">
        <button
          onClick={() => setCollapsed(false)}
          className="rounded-md p-1.5 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary transition-colors"
          title="Mở panel"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-[rgb(var(--border-line))] bg-surface-1">
      {/* Panel header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[rgb(var(--border-line))] px-3">
        <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Cấu hình</span>
        <button
          onClick={() => setCollapsed(true)}
          className="rounded p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary transition-colors"
          title="Thu nhỏ panel"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── DATA SOURCE ── */}
        <div className="border-b border-[rgb(var(--border-line))] px-3 py-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
            Nguồn dữ liệu
          </p>
          {definition.dataSource ? (
            <button
              onClick={onOpenDataSourcePicker}
              disabled={!canEdit}
              className="flex w-full items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-2 text-left transition-colors hover:bg-brand/15 disabled:cursor-not-allowed"
            >
              <Database className="h-3.5 w-3.5 shrink-0 text-brand" />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-brand">
                  {definition.dataSource.datasetName ?? 'Dataset'}
                </p>
                <p className="truncate text-[10px] text-brand">
                  {definition.dataSource.tableName ?? 'Table'}
                </p>
              </div>
              <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-brand" />
            </button>
          ) : (
            <button
              onClick={onOpenDataSourcePicker}
              disabled={!canEdit}
              className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[rgb(var(--border-strong))] px-2.5 py-2 text-left transition-colors hover:border-brand/50 hover:bg-brand/15 disabled:cursor-not-allowed"
            >
              <Database className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
              <span className="text-xs text-text-tertiary">Chọn nguồn dữ liệu…</span>
            </button>
          )}
          {!isLoadingData && previewData && (
            <p className="mt-1 text-[10px] text-text-quaternary">
              {rowCount}{totalRows > rowCount ? ` / ${totalRows}` : ''} dòng dữ liệu
            </p>
          )}
          {isLoadingData && (
            <p className="mt-1 text-[10px] text-text-quaternary">Đang tải dữ liệu…</p>
          )}
          {previewErrorMessage && (
            <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2">
              <p className="text-[10px] font-semibold text-danger">{previewErrorMessage}</p>
              {formulaErrors.length > 0 && (
                <div className="mt-1 space-y-1">
                  {formulaErrors.slice(0, 3).map((item) => (
                    <p key={`${item.key}-${item.error}`} className="text-[10px] text-danger/90">
                      {item.key}: {item.error}
                    </p>
                  ))}
                  {formulaErrors.length > 3 && (
                    <p className="text-[10px] text-danger/80">
                      +{formulaErrors.length - 3} lỗi công thức khác
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── COLUMNS SECTION ── */}
        <SectionHeader
          label="Cột dữ liệu"
          open={openSections.has('columns')}
          onToggle={() => toggleSection('columns')}
          action={
            canEdit ? (
              <button
                onClick={onAddColumn}
                className="rounded p-0.5 text-text-quaternary hover:bg-surface-2 hover:text-brand transition-colors"
                title="Thêm cột"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            ) : null
          }
        />
        {openSections.has('columns') && (
          <div className="border-b border-[rgb(var(--border-line))] pb-1">
            {/* Column list */}
            {definition.columns.length === 0 ? (
              <div className="px-3 py-4 text-center">
                <p className="text-xs text-text-quaternary">Chưa có cột nào</p>
                {canEdit && (
                  <button
                    onClick={onAddColumn}
                    className="mt-2 inline-flex items-center gap-1 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    Thêm cột đầu tiên
                  </button>
                )}
              </div>
            ) : (
              <div className="px-2 pt-1">
                {definition.columns.map((col, idx) => {
                  const isSelected = col.id === selectedColumn?.id;
                  const isFormula = col.type === 'formula' || col.type === 'subtotal';
                  const isInput = col.type === 'input';
                  const hasFormulaError = formulaErrorByKey.has(col.key);
                  return (
                    <div
                      key={col.id}
                      draggable={canEdit}
                      onDragStart={() => setDragIdx(idx)}
                      onDragOver={(e) => { e.preventDefault(); }}
                      onDrop={() => {
                        if (dragIdx !== null && dragIdx !== idx) {
                          onReorderColumns(dragIdx, idx);
                        }
                        setDragIdx(null);
                      }}
                      onClick={() => onSelectColumn(isSelected ? null : col.id)}
                      className={`group mb-0.5 flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs transition-colors ${
                        hasFormulaError
                          ? isSelected
                            ? 'bg-danger/10 text-danger'
                            : 'text-danger hover:bg-danger/5'
                          : isSelected
                            ? 'bg-brand/10 text-brand'
                            : 'text-text-secondary hover:bg-surface-2'
                      }`}
                    >
                      {canEdit && (
                        <GripVertical className="h-3 w-3 shrink-0 text-text-quaternary cursor-grab" />
                      )}
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          hasFormulaError ? 'bg-danger' : isFormula ? 'bg-warning' : isInput ? 'bg-brand/60' : 'bg-surface-3'
                        }`}
                      />
                      <span className="flex-1 truncate font-medium">{col.label}</span>
                      {hasFormulaError && (
                        <span className="shrink-0 rounded bg-danger/15 px-1 py-0.5 text-[9px] font-semibold uppercase text-danger">
                          Lỗi
                        </span>
                      )}
                      <span className={`shrink-0 text-[9px] font-mono ${isFormula ? 'text-warning' : 'text-text-quaternary'}`}>
                        {col.type === 'formula' ? 'ƒ' : col.type === 'subtotal' ? 'Σ' : col.type === 'input' ? '✎' : ''}
                      </span>
                    </div>
                  );
                })}
                {canEdit && (
                  <button
                    onClick={onAddColumn}
                    className="mt-1 flex w-full items-center gap-1.5 rounded-md border border-dashed border-[rgb(var(--border-line))] px-2 py-1.5 text-xs text-text-quaternary hover:border-brand/40 hover:text-brand transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    Thêm cột
                  </button>
                )}
              </div>
            )}

            {/* ── Column properties (inline, shown when a column is selected) ── */}
            {selectedColumn && (
              <ColumnInlineProps
                column={selectedColumn}
                columns={definition.columns}
                availableColumns={availableColumns}
                formulaError={formulaErrorByKey.get(selectedColumn.key)}
                canEdit={canEdit}
                onUpdate={(patch) => onColumnChange({ ...selectedColumn, ...patch })}
                onRemove={() => onRemoveColumn(selectedColumn.id)}
              />
            )}
          </div>
        )}

        {/* ── FILTERS SECTION ── */}
        <SectionHeader
          label="Bộ lọc runtime"
          open={openSections.has('filters')}
          onToggle={() => toggleSection('filters')}
          action={
            canEdit ? (
              <button
                onClick={addTemplateFilter}
                disabled={!definition.dataSource}
                className="rounded p-0.5 text-text-quaternary hover:bg-surface-2 hover:text-brand transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                title="Thêm bộ lọc"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            ) : null
          }
        />
        {openSections.has('filters') && (
          <div className="border-b border-[rgb(var(--border-line))] px-3 py-2 space-y-2">
            {!definition.dataSource && (
              <p className="text-[10px] text-text-quaternary">
                Chọn nguồn dữ liệu trước khi cấu hình bộ lọc runtime.
              </p>
            )}
            {definition.dataSource && templateFilters.length === 0 && (
              <p className="text-[10px] text-text-quaternary">
                Chưa có bộ lọc nào. Thêm bộ lọc để preview và export chạy theo tham số runtime.
              </p>
            )}
            {templateFilters.map((filter) => (
              <div key={filter.id} className="rounded-md border border-[rgb(var(--border-line))] p-2 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <input
                    className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                    value={filter.label}
                    onChange={(e) => updateTemplateFilter(filter.id, { label: e.target.value })}
                    disabled={!canEdit}
                    placeholder="Tên hiển thị"
                  />
                  {canEdit && (
                    <button
                      onClick={() => removeTemplateFilter(filter.id)}
                      className="rounded p-0.5 text-text-quaternary hover:text-danger transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {filterableColumns.length > 0 ? (
                  <select
                    value={filter.column}
                    onChange={(e) => updateTemplateFilter(filter.id, { column: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                  >
                    {filterableColumns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name} ({column.type})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                    value={filter.column}
                    onChange={(e) => updateTemplateFilter(filter.id, { column: e.target.value })}
                    disabled={!canEdit}
                    placeholder="Tên cột"
                  />
                )}
                <div className="flex gap-2">
                  <select
                    value={filter.operator}
                    onChange={(e) => updateTemplateFilter(filter.id, { operator: e.target.value as TemplateFilter['operator'] })}
                    disabled={!canEdit}
                    className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                  >
                    <option value="eq">=</option>
                    <option value="neq">!=</option>
                    <option value="gt">&gt;</option>
                    <option value="gte">&gt;=</option>
                    <option value="lt">&lt;</option>
                    <option value="lte">&lt;=</option>
                    <option value="contains">contains</option>
                    <option value="like">like</option>
                    <option value="in">in</option>
                    <option value="not_in">not in</option>
                    <option value="between">between</option>
                  </select>
                  <input
                    className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                    value={filter.defaultValue ?? ''}
                    onChange={(e) => updateTemplateFilter(filter.id, { defaultValue: e.target.value })}
                    disabled={!canEdit}
                    placeholder="Giá trị mặc định"
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── STRUCTURE SECTION ── */}
        <SectionHeader
          label="Cấu trúc báo cáo"
          open={openSections.has('structure')}
          onToggle={() => toggleSection('structure')}
        />
        {openSections.has('structure') && (
          <div className="border-b border-[rgb(var(--border-line))] px-3 py-2 space-y-3">
            {/* Group by */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-text-quaternary mb-1 block">
                Nhóm theo
              </label>
              <select
                value={definition.groupBy ?? ''}
                onChange={(e) => onGroupByChange(e.target.value || undefined)}
                disabled={!canEdit || groupableColumns.length === 0}
                className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs text-text-secondary focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2 disabled:text-text-quaternary"
              >
                <option value="">Không nhóm</option>
                {groupableColumns.map((c) => (
                  <option key={c.id} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Header lines */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  Tiêu đề báo cáo
                </label>
                {canEdit && (
                  <button
                    onClick={addHeaderLine}
                    className="text-[10px] text-brand hover:text-brand"
                  >
                    + Thêm dòng
                  </button>
                )}
              </div>
              {headerLines.length === 0 && (
                <p className="text-[10px] text-text-quaternary">
                  Chưa có dòng tiêu đề. Nhấn &ldquo;+ Thêm dòng&rdquo; để thêm tên công ty, địa chỉ…
                </p>
              )}
              {headerLines.map((line, idx) => (
                <div key={idx} className="flex items-center gap-1 mb-1">
                  <input
                    className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                    value={line.text}
                    onChange={(e) => updateHeaderLineText(idx, e.target.value)}
                    disabled={!canEdit}
                    placeholder={`Dòng ${idx + 1}…`}
                  />
                  {canEdit && (
                    <button
                      onClick={() => removeHeaderLine(idx)}
                      className="rounded p-0.5 text-text-quaternary hover:text-danger transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
              {/* Report title */}
              <input
                className="mt-1 w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs font-semibold outline-none focus:ring-1 focus:ring-brand"
                value={definition.header?.title ?? ''}
                onChange={(e) => onHeaderTitleChange(e.target.value, definition.header?.meta)}
                disabled={!canEdit}
                placeholder="Tên báo cáo chính (VD: BẢNG LƯƠNG…)"
              />
            </div>

            {/* Column groups */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  Nhóm cột (merged header)
                </label>
                {canEdit && (
                  <button
                    onClick={addColumnGroup}
                    className="text-[10px] text-brand hover:text-brand"
                  >
                    + Thêm
                  </button>
                )}
              </div>
              {columnGroups.length === 0 && (
                <p className="text-[10px] text-text-quaternary">
                  Dùng để gộp nhiều cột dưới một tiêu đề chung.
                </p>
              )}
              {columnGroups.map((group, gi) => (
                <div key={group.id} className="mb-2 rounded-md border border-[rgb(var(--border-line))] p-2">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <input
                      className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                      value={group.label}
                      onChange={(e) => updateColumnGroup(gi, { label: e.target.value })}
                      disabled={!canEdit}
                      placeholder="Tên nhóm…"
                    />
                    {canEdit && (
                      <button
                        onClick={() => removeColumnGroup(gi)}
                        className="rounded p-0.5 text-text-quaternary hover:text-danger transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {definition.columns.filter((c) => c.visible !== false).map((col) => {
                      const inGroup = group.columnIds.includes(col.id);
                      return (
                        <button
                          key={col.id}
                          disabled={!canEdit}
                          onClick={() => toggleColumnInGroup(gi, col.id)}
                          className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                            inGroup
                              ? 'border-brand/50 bg-brand/15 text-brand'
                              : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-tertiary hover:bg-surface-2'
                          }`}
                        >
                          {col.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer notes */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  Ghi chú cuối trang
                </label>
                {canEdit && (
                  <button
                    onClick={addFooterLine}
                    className="text-[10px] text-brand hover:text-brand"
                  >
                    + Thêm
                  </button>
                )}
              </div>
              {(footer.lines ?? []).map((line, idx) => (
                <div key={idx} className="flex items-center gap-1 mb-1">
                  <input
                    className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                    value={line.text}
                    onChange={(e) => updateFooterLine(idx, e.target.value)}
                    disabled={!canEdit}
                    placeholder={`Ghi chú ${idx + 1}…`}
                  />
                  {canEdit && (
                    <button
                      onClick={() => removeFooterLine(idx)}
                      className="rounded p-0.5 text-text-quaternary hover:text-danger transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
              {/* Signature slots */}
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-text-quaternary">Ô chữ ký:</span>
                <button
                  disabled={!canEdit}
                  onClick={() => {
                    const slots = (footer.signatureSlots ?? 0) + 1;
                    const labels = [...(footer.signatureLabels ?? []), `Chữ ký ${slots}`];
                    onFooterChange({ ...footer, signatureSlots: slots, signatureLabels: labels });
                  }}
                  className="text-[10px] text-brand hover:text-brand disabled:opacity-40"
                >
                  + Thêm
                </button>
                {(footer.signatureSlots ?? 0) > 0 && (
                  <>
                    <span className="text-[10px] text-text-tertiary">{footer.signatureSlots} ô</span>
                    <button
                      disabled={!canEdit}
                      onClick={() => {
                        const slots = Math.max(0, (footer.signatureSlots ?? 0) - 1);
                        const labels = (footer.signatureLabels ?? []).slice(0, slots);
                        onFooterChange({ ...footer, signatureSlots: slots, signatureLabels: labels });
                      }}
                      className="text-[10px] text-danger hover:text-danger disabled:opacity-40"
                    >
                      − Bớt
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── EXPORT SECTION ── */}
        <SectionHeader
          label="Xuất báo cáo"
          open={openSections.has('export')}
          onToggle={() => toggleSection('export')}
        />
        {openSections.has('export') && (
          <div className="px-3 py-3 space-y-2">
            <button
              onClick={onExportExcel}
              disabled={!previewData?.rows?.length}
              className="flex w-full items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-sm font-medium text-success transition-colors hover:bg-success/15 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FileDown className="h-4 w-4 text-success" />
              <div className="text-left">
                <p className="text-xs font-semibold">Xuất Excel</p>
                <p className="text-[10px] text-success font-normal">Tải về file .xlsx</p>
              </div>
            </button>
            <button
              onClick={onExportPDF}
              className="flex w-full items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2"
            >
              <Printer className="h-4 w-4 text-text-tertiary" />
              <div className="text-left">
                <p className="text-xs font-semibold">In / Xuất PDF</p>
                <p className="text-[10px] text-text-tertiary font-normal">Mở hộp thoại in</p>
              </div>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Section Header component ── */

function SectionHeader({
  label,
  open,
  onToggle,
  action,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-3 py-2 bg-surface-2">
      <button
        onClick={onToggle}
        className="flex flex-1 items-center gap-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-text-quaternary" />
        ) : (
          <ChevronRight className="h-3 w-3 text-text-quaternary" />
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          {label}
        </span>
      </button>
      {action}
    </div>
  );
}

/* ── Inline Column Properties ── */

function ColumnInlineProps({
  column,
  columns,
  availableColumns,
  formulaError,
  canEdit,
  onUpdate,
  onRemove,
}: {
  column: TemplateColumn;
  columns: TemplateColumn[];
  availableColumns?: Array<{ name: string; type: string; nullable?: boolean }>;
  formulaError?: string;
  canEdit: boolean;
  onUpdate: (patch: Partial<TemplateColumn>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mx-2 mb-2 rounded-lg border border-brand/30 bg-brand/10 p-3 space-y-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-brand">
        Cấu hình: <span className="font-mono normal-case">{column.label}</span>
      </p>

      {/* Tên hiển thị */}
      <Field label="Tên hiển thị">
        <input
          className="w-full rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand"
          value={column.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          disabled={!canEdit}
        />
      </Field>

      {/* Nguồn dữ liệu / Công thức */}
      <Field label="Lấy dữ liệu từ">
        {availableColumns && availableColumns.length > 0 ? (
          <select
            value={column.sourceColumn ?? ''}
            onChange={(e) => onUpdate({ sourceColumn: e.target.value || undefined, type: 'raw' })}
            disabled={!canEdit}
            className="w-full rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs text-text-secondary outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
          >
            <option value="">— Không liên kết —</option>
            {availableColumns.map((ac) => (
              <option key={ac.name} value={ac.name}>
                {ac.name} ({ac.type})
              </option>
            ))}
          </select>
        ) : (
          <input
            className="w-full rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-brand"
            value={column.sourceColumn ?? ''}
            onChange={(e) => onUpdate({ sourceColumn: e.target.value || undefined })}
            disabled={!canEdit}
            placeholder="Bind dataset để chọn cột"
          />
        )}
      </Field>

      {/* Công thức tính */}
      <Field label="Công thức tính (tuỳ chọn)">
        <div>
          <input
            className={`w-full rounded border bg-surface-1 px-2 py-1.5 text-xs font-mono outline-none focus:ring-2 ${
              formulaError
                ? 'border-danger/50 text-danger focus:ring-danger'
                : 'border-[rgb(var(--border-strong))] focus:ring-brand'
            }`}
            value={column.expression ?? ''}
            onChange={(e) =>
              onUpdate({
                expression: e.target.value || undefined,
                type: e.target.value ? 'formula' : (column.sourceColumn ? 'raw' : 'raw'),
              })
            }
            disabled={!canEdit}
            placeholder="VD: col_a * col_b + col_c"
          />
          {formulaError && (
            <p className="mt-1 text-[10px] text-danger">{formulaError}</p>
          )}
        </div>
      </Field>

      {/* Định dạng + Suffix */}
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label="Định dạng">
            <select
              value={column.format ?? 'text'}
              onChange={(e) => onUpdate({ format: e.target.value as NumberFormat })}
              disabled={!canEdit}
              className="w-full rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
            >
              <option value="text">Văn bản</option>
              <option value="integer">Số nguyên</option>
              <option value="decimal">Số thập phân</option>
              <option value="percentage">Phần trăm</option>
            </select>
          </Field>
        </div>
        <div className="w-20">
          <Field label="Đơn vị">
            <input
              className="w-full rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-brand"
              value={column.suffix ?? ''}
              onChange={(e) => onUpdate({ suffix: e.target.value || undefined })}
              disabled={!canEdit}
              placeholder="KIP"
            />
          </Field>
        </div>
      </div>

      {/* Width + Align */}
      <div className="flex gap-2">
        <div className="w-20">
          <Field label="Rộng (px)">
            <input
              type="number"
              className="w-full rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand"
              value={column.width ?? ''}
              onChange={(e) => onUpdate({ width: e.target.value ? parseInt(e.target.value) : undefined })}
              disabled={!canEdit}
              placeholder="120"
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field label="Căn lề">
            <div className="flex gap-0.5">
              {(['left', 'center', 'right'] as const).map((a) => (
                <button
                  key={a}
                  disabled={!canEdit}
                  onClick={() => onUpdate({ align: a })}
                  className={`flex-1 rounded border py-1.5 text-[11px] transition-colors ${
                    column.align === a
                      ? 'border-brand bg-brand text-white'
                      : 'border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary hover:bg-surface-2'
                  }`}
                >
                  {a === 'left' ? '◂' : a === 'center' ? '≡' : '▸'}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </div>

      {/* Flags */}
      <div className="flex gap-3">
        <label className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={column.bold ?? false}
            onChange={(e) => onUpdate({ bold: e.target.checked })}
            disabled={!canEdit}
            className="h-3.5 w-3.5 rounded border-[rgb(var(--border-strong))] text-brand"
          />
          In đậm
        </label>
        <label className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={column.highlightNegative ?? false}
            onChange={(e) => onUpdate({ highlightNegative: e.target.checked })}
            disabled={!canEdit}
            className="h-3.5 w-3.5 rounded border-[rgb(var(--border-strong))] text-brand"
          />
          Đánh dấu số âm
        </label>
      </div>

      {/* Tổng phụ (sum this column in group) */}
      <label className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={column.type === 'subtotal'}
          onChange={(e) =>
            onUpdate({ type: e.target.checked ? 'subtotal' : (column.expression ? 'formula' : column.sourceColumn ? 'raw' : 'raw') })
          }
          disabled={!canEdit}
          className="h-3.5 w-3.5 rounded border-[rgb(var(--border-strong))] text-brand"
        />
        Hiển thị tổng phụ trong nhóm (Σ)
      </label>

      {/* Delete */}
      {canEdit && (
        <button
          onClick={onRemove}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-danger/30 bg-surface-1 py-1.5 text-xs text-danger hover:bg-danger/10 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Xoá cột này
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-0.5 block text-[10px] font-medium text-text-tertiary">{label}</label>
      {children}
    </div>
  );
}
