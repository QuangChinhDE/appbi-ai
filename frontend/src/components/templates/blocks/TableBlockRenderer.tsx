'use client';

import React from 'react';
import { Database } from 'lucide-react';
import type { TableConfig, TableCellDef, TableRowDef, CellValue } from '@/types/template';
import { isDataField, isFormula, cellDisplayText } from '@/types/template';

/* ── Helper: render cells for a single row ─────────────────── */

function renderRowCells(row: TableRowDef, showBorder: boolean) {
  return row.cells.map((cell, ci) => {
    if (cell.hidden) return null;

    // Skip merged-away cells
    if (ci > 0) {
      let skip = false;
      for (let prev = 0; prev < ci; prev++) {
        if (row.cells[prev].hidden) continue;
        const prevSpan = row.cells[prev].colSpan ?? 1;
        if (prev + prevSpan > ci) { skip = true; break; }
      }
      if (skip) return null;
    }

    const span = cell.colSpan ?? 1;
    const Tag = row.isHeader ? 'th' : 'td';

    return (
      <Tag
        key={ci}
        colSpan={span > 1 ? span : undefined}
        rowSpan={cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : undefined}
        className={`px-2 py-1 break-words ${showBorder ? 'border border-gray-300' : ''}
          ${cell.bold || row.isHeader ? 'font-semibold' : ''}
          ${cell.align === 'center' ? 'text-center' : cell.align === 'right' ? 'text-right' : 'text-left'}
          ${row.isHeader ? 'text-gray-700' : 'text-gray-800'}
        `}
        style={{ backgroundColor: cell.bg || undefined }}
      >
        <CellValueDisplay value={cell.value} />
      </Tag>
    );
  });
}

interface TableBlockRendererProps {
  config: Record<string, any>;
  printMode?: boolean;
}

export function TableBlockRenderer({ config, printMode }: TableBlockRendererProps) {
  const heading = config.heading || '';
  const showBorder = config.showBorder !== false;
  const tbl = config as Partial<TableConfig>;

  // ── New structured rows mode ────────────────────────────────
  if (tbl.rows && Array.isArray(tbl.rows) && tbl.rows.length > 0) {
    const colWidths = tbl.columnWidths;
    const rowHeights = tbl.rowHeights;
    const totalColWidth = colWidths?.reduce((sum, width) => sum + width, 0) ?? 0;

    return (
      <div className={printMode ? 'px-1 py-1' : 'h-full overflow-y-auto overflow-x-hidden px-1 py-1'}>
        {heading && <p className="mb-1 text-xs font-semibold text-gray-700">{heading}</p>}
        <table
          className={`w-full text-xs border-collapse ${showBorder ? 'border border-gray-300' : ''}`}
          style={{ tableLayout: colWidths ? 'fixed' : 'auto' }}
        >
          {colWidths && (
            <colgroup>
              {colWidths.map((w, i) => (
                <col
                  key={i}
                  style={{ width: totalColWidth > 0 ? `${(w / totalColWidth) * 100}%` : undefined }}
                />
              ))}
            </colgroup>
          )}
          {/* Separate header rows into <thead> so they repeat on each printed page */}
          {tbl.rows.some((r) => r.isHeader) && (
            <thead>
              {tbl.rows.filter((r) => r.isHeader).map((row, ri) => (
                <tr
                  key={`h-${ri}`}
                  className="bg-gray-100"
                  style={rowHeights?.[ri] ? { height: rowHeights[ri] } : undefined}
                >
                  {renderRowCells(row, showBorder)}
                </tr>
              ))}
            </thead>
          )}
          <tbody>
            {tbl.rows.filter((r) => !r.isHeader).map((row, ri) => (
              <tr
                key={ri}
                className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}
                style={{
                  ...(rowHeights?.[ri] ? { height: rowHeights[ri] } : {}),
                  breakInside: 'avoid',
                }}
              >
                {renderRowCells(row, showBorder)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // ── Legacy sampleData mode (backward compat) ────────────────
  const sampleData: Record<string, any>[] = config.sampleData ?? [];
  const mergeRules: { fromCol: number; toCol: number; label: string }[] = config.mergeRules ?? [];

  if (sampleData.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">
        {heading ? <span className="font-medium text-gray-500">{heading}</span> : 'Table block — double-click to edit'}
      </div>
    );
  }

  const columns = Object.keys(sampleData[0] ?? {});
  const showHeader = config.showHeader !== false;

  return (
    <div className="h-full overflow-auto px-2 py-1">
      {heading && <p className="mb-1 text-xs font-semibold text-gray-700">{heading}</p>}
      <table className={`w-full text-xs ${showBorder ? 'border border-gray-300' : ''}`}>
        {mergeRules.length > 0 && (
          <thead>
            <tr>
              {(() => {
                const cells: React.ReactNode[] = [];
                let col = 0;
                while (col < columns.length) {
                  const rule = mergeRules.find((r) => r.fromCol === col);
                  if (rule) {
                    const span = rule.toCol - rule.fromCol + 1;
                    cells.push(
                      <th key={`merge-${col}`} colSpan={span}
                        className={`px-2 py-1 text-center font-semibold text-gray-700 ${showBorder ? 'border border-gray-300' : ''} bg-gray-100`}>
                        {rule.label}
                      </th>,
                    );
                    col += span;
                  } else {
                    cells.push(
                      <th key={`merge-empty-${col}`}
                        className={`px-2 py-1 ${showBorder ? 'border border-gray-300' : ''} bg-gray-100`} />,
                    );
                    col += 1;
                  }
                }
                return cells;
              })()}
            </tr>
          </thead>
        )}
        {showHeader && (
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col}
                  className={`px-2 py-1 text-left font-medium text-gray-600 ${showBorder ? 'border border-gray-300' : ''} bg-gray-50`}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {sampleData.map((row, idx) => (
            <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
              {columns.map((col) => (
                <td key={col}
                  className={`px-2 py-1 text-gray-800 ${showBorder ? 'border border-gray-300' : ''}`}>
                  {row[col] == null ? '' : String(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellValueDisplay({ value }: { value: CellValue }) {
  if (typeof value === 'string') return <span className="whitespace-pre-wrap">{value || '\u00A0'}</span>;
  if (isDataField(value)) {
    return (
      <span className="inline-flex items-center gap-0.5 text-blue-600 font-medium">
        <Database className="h-2.5 w-2.5" />
        {value.label ?? value.column}
      </span>
    );
  }
  if (isFormula(value)) {
    return <span className="text-green-600 font-mono">ƒ {value.expression}</span>;
  }
  return <span>&nbsp;</span>;
}
