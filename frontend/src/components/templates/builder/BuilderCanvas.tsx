'use client';

import React, { useState, useRef } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type {
  TemplateDefinition,
  LayoutType,
  HeaderLine,
  TemplateFooter,
  TemplateTheme,
} from '@/types/template';
import { PRESET_THEMES, DEFAULT_THEME } from '@/types/template';
import type { TablePreviewResponse } from '@/hooks/use-datasets';
import { TableLayout } from './TableLayout';
import { CardLayout } from './CardLayout';
import { CrossTabLayout } from './CrossTabLayout';

const FONT_SIZE_MAP: Record<string, string> = {
  sm: 'text-xs',
  base: 'text-sm',
  lg: 'text-base',
  xl: 'text-lg',
};

interface BuilderCanvasProps {
  definition: TemplateDefinition;
  selectedColumnId: string | null;
  onSelectColumn: (id: string | null) => void;
  onLayoutChange: (layout: LayoutType) => void;
  onThemeChange: (theme: TemplateTheme | undefined) => void;
  onHeaderLinesChange: (lines: HeaderLine[]) => void;
  onHeaderTitleChange: (title: string, meta?: string) => void;
  onFooterChange: (footer: TemplateFooter) => void;
  onAddColumn: () => void;
  previewData?: TablePreviewResponse;
  isLoadingData: boolean;
  canEdit: boolean;
  printRef?: React.RefObject<HTMLDivElement | null>;
}

const LAYOUT_OPTIONS: { value: LayoutType; label: string; icon: string }[] = [
  { value: 'table', label: 'Bảng', icon: '⊞' },
  { value: 'card', label: 'Thẻ', icon: '⊟' },
  { value: 'cross-tab', label: 'Cross-tab', icon: '╪' },
];

export function BuilderCanvas({
  definition,
  selectedColumnId,
  onSelectColumn,
  onLayoutChange,
  onThemeChange,
  onHeaderLinesChange,
  onHeaderTitleChange,
  onFooterChange,
  onAddColumn,
  previewData,
  isLoadingData,
  canEdit,
  printRef,
}: BuilderCanvasProps) {
  const [isPreview, setIsPreview] = useState(false);
  const internalPrintRef = useRef<HTMLDivElement>(null);
  const refToUse = printRef ?? internalPrintRef;

  const theme: TemplateTheme = definition.theme ?? DEFAULT_THEME;
  const headerLines = definition.header?.lines ?? [];
  const footer = definition.footer ?? {};

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-gray-100">
      {/* ── Toolbar ── */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4">

        {/* Layout switcher */}
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onLayoutChange(opt.value)}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                definition.layout === opt.value
                  ? 'bg-white text-blue-700 shadow-sm border border-gray-200'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <span>{opt.icon}</span>
              <span>{opt.label}</span>
            </button>
          ))}
        </div>

        <div className="mx-1 h-4 w-px bg-gray-200 shrink-0" />

        {/* Theme color dots */}
        <span className="text-xs text-gray-400 shrink-0">Màu</span>
        <div className="flex gap-1 shrink-0">
          {Object.entries(PRESET_THEMES).map(([key, t]) => {
            const isActive = theme.headerBg === t.headerBg;
            return (
              <button
                key={key}
                onClick={() => onThemeChange(key === 'dark-blue' ? undefined : t)}
                title={key}
                className={`h-5 w-5 rounded-full border-2 transition-all ${
                  isActive ? 'border-gray-800 scale-110' : 'border-gray-300 hover:border-gray-500'
                }`}
                style={{ background: t.headerBg }}
              />
            );
          })}
        </div>

        <div className="flex-1" />

        {/* Preview toggle */}
        <button
          onClick={() => setIsPreview(!isPreview)}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
            isPreview
              ? 'border-blue-300 bg-blue-50 text-blue-700'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {isPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {isPreview ? 'Đang xem trước' : 'Xem trước'}
        </button>
      </div>

      {/* ── Canvas Body ── */}
      <div className="flex-1 overflow-auto p-4">
        <div
          ref={refToUse as React.RefObject<HTMLDivElement>}
          className="mx-auto overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
          style={{ minHeight: 480, maxWidth: 1100 }}
        >
          {/* ── Header Section ── */}
          {(headerLines.length > 0 || !!definition.header?.title) && (
            <div
              className="px-5 py-4"
              style={!isPreview ? { background: theme.headerBg } : undefined}
            >
              {/* Header lines (company name, address, etc.) */}
              {headerLines.length > 0 && (
                <div className="mb-2 space-y-0.5">
                  {headerLines.map((line, idx) => {
                    const fsCls = FONT_SIZE_MAP[line.fontSize ?? 'base'] ?? 'text-sm';
                    const alignCls =
                      line.align === 'center' ? 'text-center' :
                      line.align === 'right' ? 'text-right' : 'text-left';
                    const hasRight = !!line.rightText;

                    if (hasRight) {
                      return (
                        <div
                          key={idx}
                          className={`flex justify-between ${fsCls} ${line.bold ? 'font-bold' : ''} ${isPreview ? 'text-gray-900' : 'text-gray-200'}`}
                        >
                          <span>{line.text || '\u00A0'}</span>
                          <span>{line.rightText}</span>
                        </div>
                      );
                    }
                    return (
                      <p
                        key={idx}
                        className={`${fsCls} ${alignCls} ${line.bold ? 'font-bold' : ''} ${isPreview ? 'text-gray-900' : 'text-gray-200'}`}
                      >
                        {line.text || '\u00A0'}
                      </p>
                    );
                  })}
                </div>
              )}

              {/* Report title */}
              {definition.header?.title && (
                <div className="flex items-center justify-between">
                  <span
                    className={`text-base font-bold ${isPreview ? 'text-gray-900' : ''}`}
                    style={!isPreview ? { color: theme.headerText } : undefined}
                  >
                    {definition.header.title}
                  </span>
                  {definition.header?.meta && (
                    <span className={`text-xs font-mono ${isPreview ? 'text-gray-500' : 'text-gray-400'}`}>
                      {definition.header.meta}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Empty state when no header and no columns ── */}
          {!definition.header?.title && headerLines.length === 0 && definition.columns.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center px-8">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
                <span className="text-2xl">📋</span>
              </div>
              <p className="text-sm font-semibold text-gray-700 mb-1">Bắt đầu tạo template</p>
              <p className="text-xs text-gray-400 max-w-xs leading-relaxed">
                1. Chọn nguồn dữ liệu ở panel trái<br />
                2. Thêm các cột cần hiển thị<br />
                3. Thiết lập tiêu đề và cấu trúc
              </p>
            </div>
          )}

          {/* ── Layout renderers ── */}
          {definition.layout === 'table' && definition.columns.length > 0 && (
            <TableLayout
              definition={definition}
              selectedColumnId={isPreview ? null : selectedColumnId}
              onSelectColumn={isPreview ? () => {} : onSelectColumn}
              previewData={previewData}
              isLoading={isLoadingData}
            />
          )}
          {definition.layout === 'card' && definition.columns.length > 0 && (
            <CardLayout
              definition={definition}
              previewData={previewData}
              isLoading={isLoadingData}
            />
          )}
          {definition.layout === 'cross-tab' && definition.columns.length > 0 && (
            <CrossTabLayout
              definition={definition}
              previewData={previewData}
              isLoading={isLoadingData}
            />
          )}

          {/* ── Add column prompt (when no columns but has datasource) ── */}
          {definition.columns.length === 0 && definition.dataSource && (
            <div className="flex flex-col items-center py-10">
              <button
                onClick={onAddColumn}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                + Thêm cột đầu tiên
              </button>
              <p className="mt-2 text-xs text-gray-400">Hoặc thêm từ panel bên trái</p>
            </div>
          )}

          {/* ── Footer Section ── */}
          {((footer.lines && footer.lines.length > 0) || (footer.signatureSlots ?? 0) > 0) && (
            <div
              className={`border-t px-5 py-4 ${isPreview ? 'border-gray-200' : ''}`}
              style={!isPreview ? { background: theme.headerBg, borderColor: 'rgba(255,255,255,0.15)' } : undefined}
            >
              {(footer.lines ?? []).map((line, idx) => {
                const fsCls = FONT_SIZE_MAP[line.fontSize ?? 'sm'] ?? 'text-xs';
                const alignCls =
                  line.align === 'center' ? 'text-center' :
                  line.align === 'right' ? 'text-right' : 'text-left';
                return (
                  <p
                    key={idx}
                    className={`${fsCls} ${alignCls} ${line.bold ? 'font-bold' : ''} ${isPreview ? 'text-gray-700' : 'text-gray-300'} mb-1`}
                  >
                    {line.text || '\u00A0'}
                  </p>
                );
              })}

              {(footer.signatureSlots ?? 0) > 0 && (
                <div
                  className="mt-4 gap-4"
                  style={{ display: 'grid', gridTemplateColumns: `repeat(${footer.signatureSlots}, 1fr)` }}
                >
                  {Array.from({ length: footer.signatureSlots! }).map((_, si) => {
                    const label = footer.signatureLabels?.[si] ?? `Chữ ký ${si + 1}`;
                    return (
                      <div key={si} className="flex flex-col items-center">
                        <div className={`h-16 w-full rounded border ${isPreview ? 'border-gray-300' : 'border-gray-500'}`} />
                        <span className={`mt-1 text-xs ${isPreview ? 'text-gray-600' : 'text-gray-400'}`}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Preview mode label */}
        {isPreview && (
          <p className="mt-2 text-center text-xs text-gray-400">
            Chế độ xem trước — dữ liệu thực từ dataset
          </p>
        )}
      </div>
    </div>
  );
}
