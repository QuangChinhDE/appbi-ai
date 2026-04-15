'use client';

import React, { useState, useRef } from 'react';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { TemplateDefinition, LayoutType, HeaderLine, TemplateFooter, ColumnGroup, TemplateTheme } from '@/types/template';
import { PRESET_THEMES, DEFAULT_THEME } from '@/types/template';
import type { TablePreviewResponse } from '@/hooks/use-datasets';
import { TableLayout } from './TableLayout';
import { CardLayout } from './CardLayout';
import { CrossTabLayout } from './CrossTabLayout';
import { Tooltip } from './Tooltip';

type ViewTab = 'design' | 'preview' | 'json';

interface BuilderCanvasProps {
  definition: TemplateDefinition;
  selectedColumnId: string | null;
  onSelectColumn: (id: string | null) => void;
  onLayoutChange: (layout: LayoutType) => void;
  onGroupByChange: (groupBy: string | undefined) => void;
  onHeaderChange: (title: string, meta?: string) => void;
  onHeaderLinesChange: (lines: HeaderLine[]) => void;
  onFooterChange: (footer: TemplateFooter) => void;
  onColumnGroupsChange: (groups: ColumnGroup[]) => void;
  onThemeChange: (theme: TemplateTheme | undefined) => void;
  onAddColumn: () => void;
  onReorderColumns: (from: number, to: number) => void;
  previewData?: TablePreviewResponse;
  isLoadingData: boolean;
  canEdit: boolean;
  printRef?: React.RefObject<HTMLDivElement | null>;
}

const FONT_SIZE_MAP: Record<string, string> = {
  sm: 'text-xs',
  base: 'text-sm',
  lg: 'text-base',
  xl: 'text-lg',
};

export function BuilderCanvas({
  definition,
  selectedColumnId,
  onSelectColumn,
  onLayoutChange,
  onGroupByChange,
  onHeaderChange,
  onHeaderLinesChange,
  onFooterChange,
  onColumnGroupsChange,
  onThemeChange,
  onAddColumn,
  onReorderColumns,
  previewData,
  isLoadingData,
  canEdit,
  printRef,
}: BuilderCanvasProps) {
  const [activeView, setActiveView] = useState<ViewTab>('design');
  const internalPrintRef = useRef<HTMLDivElement>(null);
  const refToUse = printRef ?? internalPrintRef;
  const [showHeader, setShowHeader] = useState(
    () => (definition.header?.lines?.length ?? 0) > 0 || !!definition.header?.title,
  );
  const [showFooter, setShowFooter] = useState(
    () => (definition.footer?.lines?.length ?? 0) > 0 || (definition.footer?.signatureSlots ?? 0) > 0,
  );
  const [showColumnGroups, setShowColumnGroups] = useState(
    () => (definition.columnGroups?.length ?? 0) > 0,
  );

  const formulaValue = (() => {
    if (!selectedColumnId) return '';
    const col = definition.columns.find((c) => c.id === selectedColumnId);
    if (!col) return '';
    if (col.expression) return col.expression;
    if (col.sourceColumn) return col.sourceColumn;
    return col.key;
  })();

  const groupableColumns = definition.columns.filter(
    (c) => c.type === 'raw' || c.type === 'input',
  );

  const headerLines = definition.header?.lines ?? [];
  const footer = definition.footer ?? {};
  const theme: TemplateTheme = definition.theme ?? DEFAULT_THEME;

  const addHeaderLine = () => {
    onHeaderLinesChange([...headerLines, { text: '', align: 'center', fontSize: 'base' }]);
  };
  const updateHeaderLine = (idx: number, patch: Partial<HeaderLine>) => {
    const next = headerLines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    onHeaderLinesChange(next);
  };
  const removeHeaderLine = (idx: number) => {
    onHeaderLinesChange(headerLines.filter((_, i) => i !== idx));
  };

  const addFooterLine = () => {
    const lines = footer.lines ?? [];
    onFooterChange({ ...footer, lines: [...lines, { text: '', align: 'left', fontSize: 'sm' }] });
  };
  const updateFooterLine = (idx: number, patch: Partial<HeaderLine>) => {
    const lines = (footer.lines ?? []).map((l, i) => (i === idx ? { ...l, ...patch } : l));
    onFooterChange({ ...footer, lines });
  };
  const removeFooterLine = (idx: number) => {
    onFooterChange({ ...footer, lines: (footer.lines ?? []).filter((_, i) => i !== idx) });
  };

  /* ── Column groups helpers ── */
  const columnGroups = definition.columnGroups ?? [];
  const addColumnGroup = () => {
    onColumnGroupsChange([...columnGroups, { id: uuidv4(), label: 'Nhóm mới', columnIds: [] }]);
  };
  const updateColumnGroup = (idx: number, patch: Partial<ColumnGroup>) => {
    const next = columnGroups.map((g, i) => (i === idx ? { ...g, ...patch } : g));
    onColumnGroupsChange(next);
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

  const isPreview = activeView === 'preview';

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-gray-50">
      {/* ── Toolbar ── */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4 overflow-x-auto">
        <Tooltip content="Chọn cách hiển thị dữ liệu: Bảng, Thẻ hoặc Bảng chéo">
          <span className="text-xs font-medium text-gray-500 shrink-0">Layout</span>
        </Tooltip>
        {(['table', 'card', 'cross-tab'] as LayoutType[]).map((lt) => (
          <button
            key={lt}
            onClick={() => onLayoutChange(lt)}
            className={`shrink-0 rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${
              definition.layout === lt
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {lt === 'cross-tab' ? 'Cross-tab' : lt.charAt(0).toUpperCase() + lt.slice(1)}
          </button>
        ))}

        <div className="mx-1 h-4 w-px bg-gray-200 shrink-0" />

        <Tooltip content="Nhóm các dòng dữ liệu theo cột">
          <span className="text-xs font-medium text-gray-500 shrink-0">Group by</span>
        </Tooltip>
        <select
          value={definition.groupBy ?? ''}
          onChange={(e) => onGroupByChange(e.target.value || undefined)}
          className="shrink-0 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">None</option>
          {groupableColumns.map((c) => (
            <option key={c.id} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>

        <div className="mx-1 h-4 w-px bg-gray-200 shrink-0" />

        <Tooltip content="Bật/tắt phần tiêu đề (header) phía trên bảng">
          <button
            onClick={() => setShowHeader(!showHeader)}
            className={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors ${
              showHeader ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-500 hover:bg-gray-50'
            }`}
          >
            Header {showHeader ? '✓' : ''}
          </button>
        </Tooltip>
        <Tooltip content="Bật/tắt phần chân trang (footer) bên dưới bảng">
          <button
            onClick={() => setShowFooter(!showFooter)}
            className={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors ${
              showFooter ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-500 hover:bg-gray-50'
            }`}
          >
            Footer {showFooter ? '✓' : ''}
          </button>
        </Tooltip>
        <Tooltip content="Bật/tắt nhóm cột (merged header row). VD: nhóm Lương, nhóm Phụ cấp...">
          <button
            onClick={() => setShowColumnGroups(!showColumnGroups)}
            className={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors ${
              showColumnGroups ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-gray-300 text-gray-500 hover:bg-gray-50'
            }`}
          >
            Groups {showColumnGroups ? '✓' : ''}
          </button>
        </Tooltip>

        <div className="mx-1 h-4 w-px bg-gray-200 shrink-0" />

        {/* Theme picker */}
        <Tooltip content="Chọn bảng màu cho bảng dữ liệu">
          <span className="text-xs font-medium text-gray-500 shrink-0">Màu</span>
        </Tooltip>
        <div className="flex gap-1 shrink-0">
          {Object.entries(PRESET_THEMES).map(([key, t]) => {
            const isActive = theme.headerBg === t.headerBg;
            return (
              <button
                key={key}
                onClick={() => onThemeChange(key === 'dark-blue' ? undefined : t)}
                className={`h-5 w-5 rounded-full border-2 shrink-0 transition-all ${
                  isActive ? 'border-gray-900 scale-110' : 'border-gray-300 hover:border-gray-500'
                }`}
                style={{ background: t.headerBg }}
                title={key}
              />
            );
          })}
        </div>

        <div className="mx-1 h-4 w-px bg-gray-200 shrink-0" />

        <Tooltip content="Thêm cột mới vào template">
          <button
            onClick={onAddColumn}
            className="shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
          >
            + Column
          </button>
        </Tooltip>
      </div>

      {/* ── Formula Bar ── */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-gray-200 bg-gray-100 px-4">
        <Tooltip content="Hiển thị công thức hoặc cột nguồn của cột đang chọn">
          <span className="shrink-0 text-[10px] font-mono text-gray-400">fx</span>
        </Tooltip>
        <input
          readOnly
          value={formulaValue}
          className="flex-1 border-none bg-transparent text-xs font-mono text-amber-700 outline-none"
        />
      </div>

      {/* ── View Tabs ── */}
      <div className="flex border-b border-gray-200 bg-white px-4">
        {(['design', 'preview', 'json'] as ViewTab[]).map((tab) => (
          <Tooltip
            key={tab}
            content={
              tab === 'design'
                ? 'Chế độ thiết kế: chỉnh sửa header, cột, layout'
                : tab === 'preview'
                  ? 'Xem trước bản in với dữ liệu thực tế từ dataset'
                  : 'Xem cấu trúc JSON (dành cho developer)'
            }
          >
            <button
              onClick={() => setActiveView(tab)}
              className={`border-b-2 px-3 py-2 text-xs capitalize transition-colors ${
                activeView === tab
                  ? 'border-blue-600 text-blue-700 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'json' ? 'JSON' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* ── Canvas Body ── */}
      <div className="flex-1 overflow-auto p-4">
        {activeView === 'json' ? (
          <pre className="rounded-lg border border-gray-200 bg-white p-4 text-xs font-mono text-gray-900 overflow-auto">
            {JSON.stringify(definition, null, 2)}
          </pre>
        ) : (
          <div className="space-y-3">
            {/* ── Column Groups Editor Panel (above table) ── */}
            {showColumnGroups && !isPreview && canEdit && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-amber-700">Nhóm cột (merged header)</span>
                  <button
                    onClick={addColumnGroup}
                    className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-0.5 text-[10px] text-amber-700 hover:bg-amber-100 transition-colors"
                  >
                    <Plus className="h-3 w-3" /> Thêm nhóm
                  </button>
                </div>
                {columnGroups.length === 0 && (
                  <p className="text-[10px] text-amber-600">Chưa có nhóm cột. Nhấn &ldquo;Thêm nhóm&rdquo; để tạo merged header row.</p>
                )}
                {columnGroups.map((group, gi) => (
                  <div key={group.id} className="mb-2 rounded border border-amber-200 bg-white p-2">
                    <div className="flex items-center gap-2 mb-1.5">
                      <input
                        className="flex-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium outline-none focus:ring-1 focus:ring-amber-400"
                        value={group.label}
                        onChange={(e) => updateColumnGroup(gi, { label: e.target.value })}
                        placeholder="Tên nhóm (VD: Lương tháng 02)"
                      />
                      <button
                        onClick={() => removeColumnGroup(gi)}
                        className="rounded p-0.5 text-red-400 hover:bg-red-50 transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {definition.columns
                        .filter((c) => c.visible !== false)
                        .map((col) => {
                          const inGroup = group.columnIds.includes(col.id);
                          return (
                            <button
                              key={col.id}
                              onClick={() => toggleColumnInGroup(gi, col.id)}
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-mono transition-colors ${
                                inGroup
                                  ? 'border-amber-400 bg-amber-100 text-amber-800'
                                  : 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100'
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
            )}

            {/* ── Print / Preview area ── */}
            <div
              ref={refToUse as React.RefObject<HTMLDivElement>}
              className={`overflow-hidden rounded-lg border border-gray-200 bg-white ${isPreview ? 'print-area' : ''}`}
              style={{ minHeight: 400 }}
            >
              {/* ── Header Section (optional) ── */}
              {(showHeader || isPreview) && (headerLines.length > 0 || definition.header?.title) && (
                <div
                  className={`${isPreview ? 'bg-white px-6 py-4' : 'px-4 py-3'}`}
                  style={!isPreview ? { background: theme.headerBg } : undefined}
                >
                  {headerLines.length > 0 && (
                    <div className="mb-2 space-y-0.5">
                      {headerLines.map((line, idx) => {
                        const fsCls = FONT_SIZE_MAP[line.fontSize ?? 'base'] ?? 'text-sm';
                        const hasRight = !!line.rightText;

                        if (!isPreview && canEdit) {
                          return (
                            <div key={idx} className="group flex items-center gap-1">
                              <input
                                className={`${hasRight ? 'w-1/2' : 'flex-1'} bg-transparent outline-none ${fsCls} ${line.bold ? 'font-bold' : ''} text-gray-300 placeholder:text-gray-600`}
                                value={line.text}
                                onChange={(e) => updateHeaderLine(idx, { text: e.target.value })}
                                placeholder={`Bên trái (VD: Tên công ty...)`}
                              />
                              <input
                                className={`${hasRight ? 'w-1/2' : 'w-0 focus:w-1/2'} bg-transparent outline-none text-right ${fsCls} ${line.bold ? 'font-bold' : ''} text-gray-300 placeholder:text-gray-600 transition-all`}
                                value={line.rightText ?? ''}
                                onChange={(e) => updateHeaderLine(idx, { rightText: e.target.value || undefined })}
                                placeholder="Bên phải (tuỳ chọn)"
                              />
                              <select
                                value={line.fontSize ?? 'base'}
                                onChange={(e) => updateHeaderLine(idx, { fontSize: e.target.value as HeaderLine['fontSize'] })}
                                className="w-10 bg-transparent text-[9px] text-gray-500 outline-none opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <option value="sm">S</option>
                                <option value="base">M</option>
                                <option value="lg">L</option>
                                <option value="xl">XL</option>
                              </select>
                              <button
                                onClick={() => updateHeaderLine(idx, { bold: !line.bold })}
                                className={`text-[9px] px-1 opacity-0 group-hover:opacity-100 transition-opacity ${line.bold ? 'text-white font-bold' : 'text-gray-500'}`}
                              >
                                B
                              </button>
                              <button
                                onClick={() => removeHeaderLine(idx)}
                                className="text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1"
                              >
                                ✕
                              </button>
                            </div>
                          );
                        }

                        // Preview / read-only render
                        if (hasRight) {
                          return (
                            <div key={idx} className={`flex justify-between ${fsCls} ${line.bold ? 'font-bold' : ''} ${isPreview ? 'text-gray-900' : 'text-gray-300'}`}>
                              <span>{line.text || '\u00A0'}</span>
                              <span className="text-right">{line.rightText}</span>
                            </div>
                          );
                        }

                        const alignCls =
                          line.align === 'center' ? 'text-center' :
                          line.align === 'right' ? 'text-right' : 'text-left';

                        return (
                          <p key={idx} className={`${fsCls} ${alignCls} ${line.bold ? 'font-bold' : ''} ${isPreview ? 'text-gray-900' : 'text-gray-300'}`}>
                            {line.text || '\u00A0'}
                          </p>
                        );
                      })}
                    </div>
                  )}

                  {!isPreview && canEdit && (
                    <button
                      onClick={addHeaderLine}
                      className="mb-2 text-[10px] text-gray-500 hover:text-gray-300 border border-dashed border-gray-600 rounded px-2 py-0.5 transition-colors"
                    >
                      + Thêm dòng
                    </button>
                  )}

                  <div className="flex items-center justify-between">
                    {!isPreview && canEdit ? (
                      <input
                        className="bg-transparent text-sm font-semibold outline-none placeholder:text-gray-500 w-[60%]"
                        style={{ color: theme.headerText }}
                        value={definition.header?.title ?? ''}
                        onChange={(e) => onHeaderChange(e.target.value, definition.header?.meta)}
                        placeholder="Tiêu đề chính (VD: BẢNG THU NHẬP...)"
                      />
                    ) : (
                      <span className={`text-sm font-semibold ${isPreview ? 'text-gray-900' : ''}`} style={!isPreview ? { color: theme.headerText } : undefined}>
                        {definition.header?.title || ''}
                      </span>
                    )}
                    {!isPreview && canEdit ? (
                      <input
                        className="bg-transparent text-right text-xs font-mono text-gray-400 outline-none w-[35%]"
                        value={definition.header?.meta ?? ''}
                        onChange={(e) => onHeaderChange(definition.header?.title ?? '', e.target.value)}
                        placeholder="Thông tin phụ (VD: tỷ giá...)"
                      />
                    ) : definition.header?.meta ? (
                      <span className={`text-xs font-mono ${isPreview ? 'text-gray-500' : 'text-gray-400'}`}>
                        {definition.header.meta}
                      </span>
                    ) : null}
                  </div>
                </div>
              )}

              {/* ── show header toggle when header is off ── */}
              {!showHeader && !isPreview && canEdit && (
                <div className="flex items-center justify-center border-b border-dashed border-gray-200 py-2">
                  <button
                    onClick={() => setShowHeader(true)}
                    className="text-[10px] text-gray-400 hover:text-blue-600 transition-colors"
                  >
                    + Thêm Header (tiêu đề báo cáo)
                  </button>
                </div>
              )}

              {/* Layout Content */}
              {definition.layout === 'table' && (
                <TableLayout
                  definition={definition}
                  selectedColumnId={isPreview ? null : selectedColumnId}
                  onSelectColumn={isPreview ? () => {} : onSelectColumn}
                  previewData={previewData}
                  isLoading={isLoadingData}
                />
              )}
              {definition.layout === 'card' && (
                <CardLayout
                  definition={definition}
                  previewData={previewData}
                  isLoading={isLoadingData}
                />
              )}
              {definition.layout === 'cross-tab' && (
                <CrossTabLayout
                  definition={definition}
                  previewData={previewData}
                  isLoading={isLoadingData}
                />
              )}

              {definition.columns.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="text-sm text-gray-500">Chưa có cột nào.</p>
                  <p className="text-xs text-gray-400 mt-1 max-w-xs">
                    Bước 1: Bind Dataset → Bước 2: Thêm cột → Bước 3: Cấu hình
                  </p>
                  <button
                    onClick={onAddColumn}
                    className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    + Thêm cột đầu tiên
                  </button>
                </div>
              )}

              {/* ── Footer Section (optional) ── */}
              {showFooter && ((footer.lines && footer.lines.length > 0) || (footer.signatureSlots ?? 0) > 0 || (!isPreview && canEdit)) && (
                <div
                  className={`border-t ${isPreview ? 'border-gray-300 px-6 py-4' : 'border-gray-700 px-4 py-3'}`}
                  style={!isPreview ? { background: theme.headerBg } : undefined}
                >
                  {(footer.lines ?? []).map((line, idx) => {
                    const fsCls = FONT_SIZE_MAP[line.fontSize ?? 'sm'] ?? 'text-xs';
                    const alignCls =
                      line.align === 'center' ? 'text-center' :
                      line.align === 'right' ? 'text-right' : 'text-left';

                    if (!isPreview && canEdit) {
                      return (
                        <div key={idx} className="group flex items-center gap-1 mb-0.5">
                          <input
                            className={`flex-1 bg-transparent outline-none ${fsCls} ${alignCls} text-gray-300 placeholder:text-gray-600`}
                            value={line.text}
                            onChange={(e) => updateFooterLine(idx, { text: e.target.value })}
                            placeholder={`Ghi chú ${idx + 1}`}
                          />
                          <button
                            onClick={() => removeFooterLine(idx)}
                            className="text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    }

                    return (
                      <p key={idx} className={`${fsCls} ${alignCls} ${line.bold ? 'font-bold' : ''} text-gray-700 mb-1`}>
                        {line.text || '\u00A0'}
                      </p>
                    );
                  })}

                  {!isPreview && canEdit && (
                    <button
                      onClick={addFooterLine}
                      className="mt-1 text-[10px] text-gray-500 hover:text-gray-300 border border-dashed border-gray-600 rounded px-2 py-0.5 transition-colors"
                    >
                      + Thêm dòng ghi chú
                    </button>
                  )}

                  {(footer.signatureSlots ?? 0) > 0 && (
                    <div
                      className="mt-4 gap-4"
                      style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${footer.signatureSlots}, 1fr)`,
                      }}
                    >
                      {Array.from({ length: footer.signatureSlots! }).map((_, si) => {
                        const label = footer.signatureLabels?.[si] ?? `Chữ ký ${si + 1}`;
                        return (
                          <div key={si} className="flex flex-col items-center">
                            <div className={`h-16 w-full rounded border ${isPreview ? 'border-gray-300' : 'border-gray-600'}`} />
                            {!isPreview && canEdit ? (
                              <input
                                className="mt-1 w-full bg-transparent text-center text-xs text-gray-400 outline-none placeholder:text-gray-600"
                                value={label}
                                onChange={(e) => {
                                  const labels = [...(footer.signatureLabels ?? [])];
                                  labels[si] = e.target.value;
                                  onFooterChange({ ...footer, signatureLabels: labels });
                                }}
                                placeholder="Tên chữ ký"
                              />
                            ) : (
                              <span className={`mt-1 text-xs ${isPreview ? 'text-gray-600' : 'text-gray-400'}`}>
                                {label}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!isPreview && canEdit && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10px] text-gray-500">Ô ký tên:</span>
                      <button
                        onClick={() => {
                          const slots = (footer.signatureSlots ?? 0) + 1;
                          const labels = [...(footer.signatureLabels ?? []), `Chữ ký ${slots}`];
                          onFooterChange({ ...footer, signatureSlots: slots, signatureLabels: labels });
                        }}
                        className="text-[10px] text-blue-400 hover:text-blue-300"
                      >
                        + Thêm
                      </button>
                      {(footer.signatureSlots ?? 0) > 0 && (
                        <button
                          onClick={() => {
                            const slots = Math.max(0, (footer.signatureSlots ?? 0) - 1);
                            const labels = (footer.signatureLabels ?? []).slice(0, slots);
                            onFooterChange({ ...footer, signatureSlots: slots, signatureLabels: labels });
                          }}
                          className="text-[10px] text-red-400 hover:text-red-300"
                        >
                          − Bớt
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── show footer toggle when footer is off ── */}
              {!showFooter && !isPreview && canEdit && (
                <div className="flex items-center justify-center border-t border-dashed border-gray-200 py-2">
                  <button
                    onClick={() => setShowFooter(true)}
                    className="text-[10px] text-gray-400 hover:text-blue-600 transition-colors"
                  >
                    + Thêm Footer (ghi chú, chữ ký)
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
