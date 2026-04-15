'use client';

import React, { useMemo } from 'react';
import type { ResolvedSheet, ResolvedRow, ResolvedCell } from '@/hooks/use-spreadsheet-preview-data';
import { PAGE_SIZES, PAGE_MARGIN } from '@/types/template';

const PREVIEW_BORDER_COLOR = '#111827';

function getPreviewBorderStyle(cell: ResolvedCell): React.CSSProperties {
  return {
    borderTop: cell.borders?.top ? `1px solid ${PREVIEW_BORDER_COLOR}` : undefined,
    borderRight: cell.borders?.right ? `1px solid ${PREVIEW_BORDER_COLOR}` : undefined,
    borderBottom: cell.borders?.bottom ? `1px solid ${PREVIEW_BORDER_COLOR}` : undefined,
    borderLeft: cell.borders?.left ? `1px solid ${PREVIEW_BORDER_COLOR}` : undefined,
  };
}

interface SpreadsheetPreviewProps {
  resolved: ResolvedSheet | null;
  pageSize?: string;
  orientation?: string;
}

/**
 * Print-ready renderer for spreadsheet data.
 *
 * Takes the resolved sheet (with expanded repeating rows) and renders it
 * as paginated content. Page breaks are inserted at row boundaries when
 * cumulative height exceeds the page content height.
 *
 * CSS @page rules in globals.css handle physical page sizing for print.
 * Each "page div" acts as a visual page in the preview.
 */
export function SpreadsheetPreview({
  resolved,
  pageSize = 'A4',
  orientation = 'portrait',
}: SpreadsheetPreviewProps) {
  const dims = PAGE_SIZES[pageSize] ?? PAGE_SIZES.A4;
  const isLandscape = orientation === 'landscape';
  const pageWidth = isLandscape ? dims.height : dims.width;
  const pageHeight = isLandscape ? dims.width : dims.height;
  const contentHeight = pageHeight - PAGE_MARGIN * 2;

  // Split resolved rows into pages
  const pages = useMemo(() => {
    if (!resolved) return [];

    const result: ResolvedRow[][] = [];
    let currentPage: ResolvedRow[] = [];
    let usedHeight = 0;

    for (const row of resolved.rows) {
      const rowH = row.height;

      if (usedHeight + rowH > contentHeight && currentPage.length > 0) {
        result.push(currentPage);
        currentPage = [];
        usedHeight = 0;
      }

      currentPage.push(row);
      usedHeight += rowH;
    }

    if (currentPage.length > 0) {
      result.push(currentPage);
    }

    return result;
  }, [resolved, contentHeight]);

  if (!resolved || resolved.rows.length === 0) {
    return (
      <div className="flex items-center justify-center p-12 text-gray-400 text-sm">
        No content to preview
      </div>
    );
  }

  const { colWidths } = resolved;
  const totalColWidth = colWidths.reduce((s, w) => s + w, 0);

  return (
    <div className="template-print-root flex flex-col items-center gap-6 bg-gray-100 p-8 print:bg-white print:p-0 print:gap-0">
      {pages.map((pageRows, pageIdx) => (
        <div
          key={pageIdx}
          className="template-print-page bg-white shadow-lg print:shadow-none print:break-after-page"
          style={{
            width: pageWidth,
            minHeight: pageHeight,
            padding: PAGE_MARGIN,
            boxSizing: 'border-box',
          }}
        >
          <table
            className="w-full border-collapse text-xs"
            style={{ tableLayout: 'fixed' }}
          >
            <colgroup>
              {colWidths.map((w, i) => (
                <col
                  key={i}
                  style={{ width: totalColWidth > 0 ? `${(w / totalColWidth) * 100}%` : undefined }}
                />
              ))}
            </colgroup>
            <tbody>
              {pageRows.map((row, ri) => (
                <tr key={ri} style={{ height: row.height, breakInside: 'avoid' }}>
                  {row.cells.map((cell, ci) => {
                    if (cell.hidden) return null;
                    return (
                      <td
                        key={ci}
                        colSpan={cell.colSpan}
                        rowSpan={cell.rowSpan}
                        className={[
                          'px-1.5 py-0.5 break-words align-top',
                          cell.bold ? 'font-bold' : '',
                          cell.italic ? 'italic' : '',
                          cell.align === 'center' ? 'text-center' : cell.align === 'right' ? 'text-right' : 'text-left',
                        ].join(' ')}
                        style={{
                          backgroundColor: cell.bg || undefined,
                          fontSize: cell.fontSize ? `${cell.fontSize}px` : undefined,
                          ...getPreviewBorderStyle(cell),
                        }}
                      >
                        {cell.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
