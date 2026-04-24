'use client';

import React, { useMemo } from 'react';
import type { TemplateDefinition, TemplateColumn, ColumnGroup, TemplateTheme } from '@/types/template';
import { DEFAULT_THEME } from '@/types/template';
import type { TablePreviewResponse } from '@/hooks/use-datasets';
import { evaluateFormula, formatValue } from '@/hooks/use-template-data';

interface GroupHeaderCell {
  label: string;
  span: number;
  isGroup: boolean;
  width: number;
}

/* ── Column header bg by type — fallback classes only ─────── */

const COL_CELL_CLASSES: Record<string, string> = {
  raw: 'text-text-secondary',
  input: 'text-text-primary',
  formula: 'text-warning',
  subtotal: 'font-semibold',
};

/* ── Group rows by key ──────────────────────────────────────── */

function groupRows(
  rows: Record<string, any>[],
  groupByKey: string | undefined,
  columns: TemplateColumn[],
): Array<{ label?: string; rows: Record<string, any>[]; count: number }> {
  if (!groupByKey) return [{ rows, count: rows.length }];

  const col = columns.find((c) => c.key === groupByKey);
  const sourceCol = col?.sourceColumn ?? groupByKey;

  const groups = new Map<string, Record<string, any>[]>();
  for (const row of rows) {
    const key = String(row[sourceCol] ?? 'Other');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return Array.from(groups.entries()).map(([label, gRows]) => ({
    label,
    rows: gRows,
    count: gRows.length,
  }));
}

/* ── Compute subtotals ──────────────────────────────────────── */

function computeSubtotals(
  rows: Record<string, any>[],
  columns: TemplateColumn[],
): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const col of columns) {
    if (col.type === 'formula' || col.type === 'subtotal' || col.format === 'integer' || col.format === 'decimal') {
      const sourceCol = col.sourceColumn ?? col.key;
      let total = 0;
      for (const row of rows) {
        if (col.expression) {
          const val = row[col.key] != null ? Number(row[col.key]) : evaluateFormula(col.expression, row, columns);
          total += val ?? 0;
        } else {
          const v = row[sourceCol];
          total += typeof v === 'number' ? v : parseFloat(v) || 0;
        }
      }
      sums[col.key] = total;
    }
  }
  return sums;
}

/* ── Resolve cell value ─────────────────────────────────────── */

function resolveCell(
  col: TemplateColumn,
  row: Record<string, any>,
  columns: TemplateColumn[],
): string {
  if (col.expression) {
    const val = row[col.key] != null ? row[col.key] : evaluateFormula(col.expression, row, columns);
    return formatValue(val, col.format, col.suffix);
  }

  const sourceCol = col.sourceColumn ?? col.key;
  const raw = row[sourceCol];
  return formatValue(raw, col.format, col.suffix);
}

function buildGroupHeaderRows(
  visibleCols: TemplateColumn[],
  columnGroups: ColumnGroup[] | undefined,
): GroupHeaderCell[][] | null {
  if (!columnGroups || columnGroups.length === 0) return null;

  const normalizedGroups = columnGroups.map((group) => ({
    ...group,
    level: Math.max(1, Number(group.level ?? 1) || 1),
  }));
  const levels = Array.from(new Set(normalizedGroups.map((group) => group.level))).sort((a, b) => a - b);
  const rows = levels
    .map((level) => {
      const groupsAtLevel = normalizedGroups.filter((group) => group.level === level);
      const colGroupMap = new Map<string, ColumnGroup>();
      for (const group of groupsAtLevel) {
        for (const columnId of group.columnIds) {
          colGroupMap.set(columnId, group);
        }
      }

      const cells: GroupHeaderCell[] = [];
      let index = 0;
      let hasGroup = false;

      while (index < visibleCols.length) {
        const col = visibleCols[index];
        const group = colGroupMap.get(col.id);
        if (group) {
          const groupColumnIds = new Set(group.columnIds);
          let span = 0;
          let totalWidth = 0;
          while (index + span < visibleCols.length && groupColumnIds.has(visibleCols[index + span].id)) {
            totalWidth += visibleCols[index + span].width ?? 100;
            span += 1;
          }
          cells.push({
            label: group.label,
            span: Math.max(1, span),
            isGroup: true,
            width: totalWidth || (col.width ?? 100),
          });
          hasGroup = true;
          index += Math.max(1, span);
        } else {
          cells.push({ label: '', span: 1, isGroup: false, width: col.width ?? 100 });
          index += 1;
        }
      }

      return hasGroup ? cells : null;
    })
    .filter((row): row is GroupHeaderCell[] => row !== null);

  return rows.length > 0 ? rows : null;
}

/* ── Component ──────────────────────────────────────────────── */

interface TableLayoutProps {
  definition: TemplateDefinition;
  selectedColumnId: string | null;
  onSelectColumn: (id: string | null) => void;
  previewData?: TablePreviewResponse;
  isLoading: boolean;
}

export function TableLayout({
  definition,
  selectedColumnId,
  onSelectColumn,
  previewData,
  isLoading,
}: TableLayoutProps) {
  const { columns, groupBy, showSubtotals, columnGroups, theme: userTheme } = definition;
  const theme: TemplateTheme = userTheme ?? DEFAULT_THEME;
  const visibleCols = columns.filter((c) => c.visible !== false);
  const rows = previewData?.rows ?? [];

  const grouped = useMemo(
    () => groupRows(rows, groupBy, columns),
    [rows, groupBy, columns],
  );

  const groupHeaderRows = useMemo(
    () => buildGroupHeaderRows(visibleCols, columnGroups),
    [visibleCols, columnGroups],
  );

  if (visibleCols.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      {grouped.map((group, gi) => (
        <React.Fragment key={gi}>
          {/* Section band */}
          {group.label && (
            <div
              className="flex items-center gap-2 border-b px-4 py-1.5"
              style={{ background: theme.groupBg, borderColor: theme.groupBg }}
            >
              <span className="text-[10px] text-text-quaternary cursor-grab">⠿</span>
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: theme.groupText }}>
                {group.label}
              </span>
            </div>
          )}

          {/* Merged group header rows */}
          {groupHeaderRows?.map((headerRow, headerRowIndex) => (
            <div
              key={`group-row-${headerRowIndex}`}
              className="flex"
              style={{ background: theme.headerBg, opacity: 0.72 + (headerRowIndex * 0.12) }}
            >
              <div className="px-2.5 py-1 w-8 min-w-[32px] shrink-0 border-r" style={{ borderColor: 'rgba(255,255,255,0.15)' }} />
              {headerRow.map((cell, ci) => (
                <div
                  key={ci}
                  className="px-2.5 py-1 text-[10px] font-semibold tracking-wide border-r text-center truncate shrink-0"
                  style={{
                    width: cell.width,
                    minWidth: cell.width,
                    color: cell.isGroup ? theme.headerText : 'transparent',
                    borderColor: 'rgba(255,255,255,0.15)',
                  }}
                >
                  {cell.label}
                </div>
              ))}
            </div>
          ))}

          {/* Column headers */}
          <div className="flex" style={{ background: theme.headerBg }}>
            {/* STT column */}
            <div
              className="px-2.5 py-1.5 text-[10px] font-medium font-mono w-8 min-w-[32px] shrink-0 border-r"
              style={{ color: theme.headerText, borderColor: 'rgba(255,255,255,0.15)' }}
            >
              #
            </div>
            {visibleCols.map((col) => (
              <div
                key={col.id}
                onClick={() => onSelectColumn(col.id)}
                className="cursor-pointer px-2.5 py-1.5 text-[10px] font-medium tracking-wide border-r truncate shrink-0"
                style={{
                  width: col.width ?? 100,
                  minWidth: col.width ?? 100,
                  color: theme.headerText,
                  backgroundColor: theme.headerBg,
                  borderColor: 'rgba(255,255,255,0.15)',
                  outline: selectedColumnId === col.id ? '2px solid #3b82f6' : 'none',
                  outlineOffset: '-2px',
                }}
              >
                {col.label}
                {col.type === 'formula' && (
                  <span className="ml-1 text-[8px] opacity-60">fx</span>
                )}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {rows.length === 0 && !isLoading && (
            <div className="px-4 py-6 text-center text-xs italic text-text-quaternary">
              {definition.dataSource
                ? 'No data rows. Run a preview to load data.'
                : 'Bind a dataset to see data here.'}
            </div>
          )}

          {isLoading && (
            <div className="px-4 py-6 text-center text-xs text-text-tertiary">
              Loading data…
            </div>
          )}

          {group.rows.map((row, ri) => (
            <div
              key={ri}
              className="flex border-b border-[rgb(var(--border-line))] hover:bg-surface-2 transition-colors"
            >
              <div className="px-2.5 py-1.5 text-xs font-mono text-text-quaternary w-8 min-w-[32px] shrink-0 border-r border-[rgb(var(--border-line))]">
                {ri + 1}
              </div>
              {visibleCols.map((col) => {
                const displayVal = resolveCell(col, row, columns);
                const isNeg =
                  col.highlightNegative &&
                  typeof displayVal === 'string' &&
                  displayVal.startsWith('-');

                return (
                  <div
                    key={col.id}
                    onClick={() => onSelectColumn(col.id)}
                    className={`cursor-pointer px-2.5 py-1.5 text-xs font-mono border-r border-[rgb(var(--border-line))] truncate shrink-0 ${
                      COL_CELL_CLASSES[col.type] ?? COL_CELL_CLASSES.raw
                    } ${col.bold ? 'font-medium text-text-primary' : ''}`}
                    style={{
                      width: col.width ?? 100,
                      minWidth: col.width ?? 100,
                      textAlign: col.align ?? (col.type === 'formula' || col.type === 'subtotal' ? 'right' : 'left'),
                      color: isNeg ? '#dc2626' : undefined,
                      outline: selectedColumnId === col.id ? '1px solid #3b82f6' : 'none',
                      outlineOffset: '-1px',
                    }}
                  >
                    {displayVal}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Subtotal row */}
          {showSubtotals !== false && group.rows.length > 0 && (
            <div
              className="flex border-b border-t"
              style={{ background: theme.subtotalBg, borderColor: theme.subtotalBg }}
            >
              <div className="w-8 min-w-[32px] px-2.5 py-1.5 border-r shrink-0" style={{ borderColor: 'rgba(0,0,0,0.06)' }} />
              {visibleCols.map((col, ci) => {
                const subs = computeSubtotals(group.rows, columns);
                const val = subs[col.key];
                const isFirst = ci === 0;

                return (
                  <div
                    key={col.id}
                    className="px-2.5 py-1.5 text-xs font-mono font-semibold border-r truncate shrink-0"
                    style={{
                      width: col.width ?? 100,
                      minWidth: col.width ?? 100,
                      textAlign: col.align ?? (col.type === 'formula' || col.type === 'subtotal' ? 'right' : 'left'),
                      color: theme.subtotalText,
                      borderColor: 'rgba(0,0,0,0.06)',
                    }}
                  >
                    {isFirst && group.label
                      ? `${group.label} — ${group.count} rows`
                      : val != null
                        ? formatValue(val, col.format, col.suffix)
                        : ''}
                  </div>
                );
              })}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
