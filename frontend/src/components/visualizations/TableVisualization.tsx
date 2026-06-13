'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import type { NumberFormat } from '@/components/explore/ExploreChartConfig';
import type { TableColumnAlignment, TableHyperlinkRule } from '@/types/api';
import {
  SortConfig,
  ConditionalFormatRule,
  TableHeatmapRule,
  TableSummaryRowConfig,
} from '@/types/api';
import {
  buildTableHeatmapStats,
  getCellStyle,
  getHeatmapCellStyle,
  parseNumericCellValue,
} from '@/lib/exploreAggregations';

export interface TableVisualizationProps {
  data: Record<string, any>[];
  columns?: string[];
  maxRows?: number;
  className?: string;
  // Explore 2.0 features
  sorts?: SortConfig[];
  onSortChange?: (sorts: SortConfig[]) => void;
  conditionalFormatting?: ConditionalFormatRule[];
  heatmapRules?: TableHeatmapRule[];
  summaryRows?: TableSummaryRowConfig[];
  showSummaryRow?: boolean;
  summaryLabel?: string;
  summaryLabelColumn?: string;
  onRowClick?: (row: any) => void; // Drilldown trigger
  enableDrilldown?: boolean;
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (columnWidths: Record<string, number>) => void;
  columnAlignments?: Record<string, TableColumnAlignment>;
  hyperlinkRules?: TableHyperlinkRule[];
  enableColumnResize?: boolean;
  numberFormat?: NumberFormat;
  decimalPlaces?: number;
  currencySymbol?: string;
  /**
   * Phase-15.13: column-key → friendly label. When provided, the header
   * shows the label instead of the raw key (which is typically a
   * qualified SQL ref like `Meetings.role_pic_bc`). Keys without an entry
   * fall back to a humanised version of the bare segment.
   */
  columnLabels?: Record<string, string> | Map<string, string>;
}

/**
 * Phase-15.13: derive a human-readable column header from a SQL key.
 *
 * Engine emits keys like `Meetings.role_pic_bc` or `dataset_table_320.role_pic_bc`
 * which are great for routing but terrible for end users. When `columnLabels`
 * does not carry an entry for the key, we strip any view/table qualifier and
 * turn snake_case / kebab-case into Title Case ("Role Pic Bc"). The fallback
 * intentionally keeps the original casing of all-caps tokens (e.g. "ID")
 * and never inverts user choices — if a label was provided, it wins.
 */
function lookupColumnLabel(
  key: string,
  map: Record<string, string> | Map<string, string> | undefined,
): string {
  if (map) {
    const explicit = map instanceof Map ? map.get(key) : map[key];
    if (explicit && explicit.trim()) return explicit;
  }
  const bare = key.includes('.') ? key.split('.').slice(-1)[0] : key;
  if (!bare) return key;
  const cleaned = bare.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) return bare;
  return cleaned
    .split(/\s+/)
    .map((token) => {
      if (/^[A-Z0-9]{2,}$/.test(token)) return token;
      if (/^id$/i.test(token)) return 'ID';
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

const MIN_COLUMN_WIDTH = 96;

function sanitizeColumnWidths(
  widths: Record<string, number> | null | undefined,
): Record<string, number> {
  if (!widths) return {};

  return Object.fromEntries(
    Object.entries(widths)
      .filter(([columnName, width]) => columnName.trim() && Number.isFinite(Number(width)) && Number(width) > 0)
      .map(([columnName, width]) => [columnName, Math.max(Math.round(Number(width)), MIN_COLUMN_WIDTH)]),
  );
}

function getColumnAlignment(
  column: string,
  columnAlignments: Record<string, TableColumnAlignment> | null | undefined,
): TableColumnAlignment {
  const alignment = columnAlignments?.[column];
  return alignment === 'center' || alignment === 'right' ? alignment : 'left';
}

function getHeaderJustifyClass(alignment: TableColumnAlignment): string {
  switch (alignment) {
    case 'center':
      return 'justify-center';
    case 'right':
      return 'justify-end';
    case 'left':
    default:
      return 'justify-start';
  }
}

function resolveSafeHref(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  const candidate = raw.startsWith('www.') ? `https://${raw}` : raw;
  const isRootRelative = candidate.startsWith('/');
  const hasAllowedPrefix = /^(https?:|mailto:|tel:)/i.test(candidate);
  if (!isRootRelative && !hasAllowedPrefix) {
    return null;
  }

  try {
    const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const url = new URL(candidate, baseOrigin);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
      return url.href;
    }
  } catch {
    return null;
  }

  return null;
}

// BUG-006 — interpolate a URL template's {column} tokens from a row. Token
// values are URL-encoded so ids with spaces/slashes produce valid URLs.
function interpolateUrlTemplate(template: string, row: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, token) => {
    const value = row?.[String(token).trim()];
    return value === null || value === undefined ? '' : encodeURIComponent(String(value));
  });
}

// BUG-006 — resolve a cell's href: a {token} URL template (preferred when set)
// or the value of a URL column. Returns null when neither yields a safe URL,
// so the cell falls back to plain text.
function resolveRuleHref(rule: TableHyperlinkRule, row: Record<string, unknown>): string | null {
  const template = rule.urlTemplate?.trim();
  if (template) {
    return resolveSafeHref(interpolateUrlTemplate(template, row));
  }
  const urlColumn = rule.urlColumn?.trim();
  return urlColumn ? resolveSafeHref(row?.[urlColumn]) : null;
}

function buildHyperlinkRuleMap(
  rules: TableHyperlinkRule[] | null | undefined,
): Record<string, TableHyperlinkRule> {
  const map: Record<string, TableHyperlinkRule> = {};
  for (const rule of rules ?? []) {
    const targetColumn = rule.targetColumn?.trim();
    const urlColumn = rule.urlColumn?.trim();
    const urlTemplate = rule.urlTemplate?.trim();
    // BUG-006 — a rule links via either a URL column OR a {token} template.
    // Skip rules that provide neither.
    if (!targetColumn || (!urlColumn && !urlTemplate) || map[targetColumn]) {
      continue;
    }
    map[targetColumn] = {
      ...rule,
      targetColumn,
      urlColumn,
      urlTemplate,
      openInNewTab: rule.openInNewTab !== false,
    };
  }
  return map;
}

export function TableVisualization({
  data,
  columns,
  maxRows = 200,
  className,
  sorts = [],
  onSortChange,
  conditionalFormatting = [],
  heatmapRules = [],
  summaryRows,
  showSummaryRow,
  summaryLabel = 'Total',
  summaryLabelColumn,
  onRowClick,
  enableDrilldown = false,
  columnWidths,
  onColumnWidthsChange,
  columnAlignments,
  hyperlinkRules,
  enableColumnResize = true,
  numberFormat = 'auto',
  decimalPlaces = 1,
  currencySymbol = '$',
  columnLabels,
}: TableVisualizationProps) {
  const rows = data ?? [];
  // Phase-15.24: `rows[0] ?? {}` guard. BE can return a row that
  // serialises to `null` when every column is null (rare but observed
  // on TABLE charts post Hướng A). `Object.keys(null)` throws TypeError
  // which surfaces as Next.js's generic "client-side exception" toast.
  const cols = columns ?? (rows.length > 0 ? Object.keys(rows[0] ?? {}) : []);
  const colsKey = useMemo(() => cols.join('\u0000'), [cols]);
  const sanitizedColumnWidths = useMemo(() => sanitizeColumnWidths(columnWidths), [columnWidths]);
  const hyperlinkRuleByColumn = useMemo(() => buildHyperlinkRuleMap(hyperlinkRules), [hyperlinkRules]);
  const hasExternalColumnWidthControl = onColumnWidthsChange !== undefined || columnWidths !== undefined;
  const [liveColumnWidths, setLiveColumnWidths] = useState<Record<string, number>>(sanitizedColumnWidths);
  const [activeResizeColumn, setActiveResizeColumn] = useState<string | null>(null);
  const headerCellRefs = useRef<Record<string, HTMLTableCellElement | null>>({});
  const liveColumnWidthsRef = useRef<Record<string, number>>(liveColumnWidths);
  const resizeStateRef = useRef<{ column: string; startX: number; startWidth: number } | null>(null);

  // BI-standard sortable grid (Power BI / Excel): clicking a header sorts the
  // grid instantly. When the parent supplies `onSortChange` the component is
  // CONTROLLED (parent owns sort state, e.g. to re-query). Otherwise it falls
  // back to UNCONTROLLED local sort so the Explore preview / any read-only
  // table still sorts on click instead of doing nothing.
  // null = user hasn't clicked a header yet → respect the parent's initial
  // `sorts` (a read-only consumer may pass a fixed display order). After the
  // first click in uncontrolled mode, localSorts takes over.
  const [localSorts, setLocalSorts] = useState<SortConfig[] | null>(null);
  const effectiveSorts = onSortChange ? sorts : (localSorts ?? sorts);

  // Apply the effective sort to the rows for display. Mixed-type safe: numbers
  // compare numerically, everything else by locale string; null/undefined sink
  // to the bottom regardless of direction (standard grid behaviour).
  const sortedRows = useMemo(() => {
    if (!effectiveSorts || effectiveSorts.length === 0) return rows;
    const ordered = [...effectiveSorts].sort((a, b) => a.index - b.index);
    const arr = [...rows];
    arr.sort((ra, rb) => {
      for (const s of ordered) {
        const va = ra?.[s.field];
        const vb = rb?.[s.field];
        const aNull = va === null || va === undefined || va === '';
        const bNull = vb === null || vb === undefined || vb === '';
        if (aNull && bNull) continue;
        if (aNull) return 1;          // nulls last, regardless of direction
        if (bNull) return -1;
        const na = parseNumericCellValue(va);
        const nb = parseNumericCellValue(vb);
        let cmp: number;
        if (na !== null && nb !== null) cmp = na - nb;
        else cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
        if (cmp !== 0) return s.direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
    return arr;
  }, [rows, effectiveSorts]);

  const displayRows = sortedRows.slice(0, maxRows);
  const numericColumns = useMemo(
    () => cols.filter((col) => rows.some((row) => parseNumericCellValue(row?.[col]) !== null)),
    [cols, rows],
  );

  useEffect(() => {
    liveColumnWidthsRef.current = liveColumnWidths;
  }, [liveColumnWidths]);

  useEffect(() => {
    setLiveColumnWidths((current) => {
      const next: Record<string, number> = {};

      cols.forEach((col) => {
        const explicitWidth = sanitizedColumnWidths[col];
        const fallbackWidth = current[col];
        const resolvedWidth = hasExternalColumnWidthControl
          ? explicitWidth
          : explicitWidth ?? fallbackWidth;
        if (typeof resolvedWidth === 'number' && resolvedWidth > 0) {
          next[col] = resolvedWidth;
        }
      });

      const currentKeys = Object.keys(current).filter((col) => cols.includes(col));
      const nextKeys = Object.keys(next);
      const isSameLength = currentKeys.length === nextKeys.length;
      const isSameValues = isSameLength && nextKeys.every((col) => current[col] === next[col]);

      return isSameValues ? current : next;
    });
  }, [cols, colsKey, hasExternalColumnWidthControl, sanitizedColumnWidths]);

  useLayoutEffect(() => {
    if (cols.length === 0) {
      return;
    }

    setLiveColumnWidths((current) => {
      const next = { ...current };
      let changed = false;

      cols.forEach((col) => {
        if (next[col]) {
          return;
        }

        const measuredWidth = Math.ceil(headerCellRefs.current[col]?.getBoundingClientRect().width ?? 0);
        if (measuredWidth > 0) {
          next[col] = Math.max(measuredWidth, MIN_COLUMN_WIDTH);
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [cols, colsKey, liveColumnWidths]);

  useEffect(() => {
    if (!activeResizeColumn) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const activeResize = resizeStateRef.current;
      if (!activeResize) {
        return;
      }

      const deltaX = event.clientX - activeResize.startX;
      const nextWidth = Math.max(Math.round(activeResize.startWidth + deltaX), MIN_COLUMN_WIDTH);

      setLiveColumnWidths((current) => {
        if (current[activeResize.column] === nextWidth) {
          return current;
        }

        return {
          ...current,
          [activeResize.column]: nextWidth,
        };
      });
    };

    const handleMouseUp = () => {
      const nextWidths = sanitizeColumnWidths(liveColumnWidthsRef.current);
      if (onColumnWidthsChange) {
        onColumnWidthsChange(nextWidths);
      }

      resizeStateRef.current = null;
      setActiveResizeColumn(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [activeResizeColumn, onColumnWidthsChange]);

  const resolvedSummaryLabelColumn = useMemo(() => {
    if (summaryLabelColumn && cols.includes(summaryLabelColumn)) {
      return summaryLabelColumn;
    }

    return cols.find((col) => !numericColumns.includes(col)) ?? '';
  }, [cols, numericColumns, summaryLabelColumn]);
  const heatmapStats = useMemo(
    () => buildTableHeatmapStats(rows, heatmapRules),
    [heatmapRules, rows],
  );
  const resolvedSummaryRows = useMemo<TableSummaryRowConfig[]>(() => {
    if (showSummaryRow === false) {
      return [];
    }

    if (summaryRows && summaryRows.length > 0) {
      return summaryRows;
    }

    if (showSummaryRow) {
      return [{
        label: summaryLabel,
        calculation: 'sum',
        labelColumn: summaryLabelColumn,
      }];
    }

    return [];
  }, [showSummaryRow, summaryRows, summaryLabel, summaryLabelColumn]);
  const summaryRowsData = useMemo(() => {
    if (resolvedSummaryRows.length === 0) {
      return [] as Record<string, any>[];
    }

    return resolvedSummaryRows.map((summaryRow) => {
      const totalRow: Record<string, any> = {};
      const labelColumn = resolveSummaryLabelColumn(
        summaryRow.labelColumn,
        cols,
        numericColumns,
        resolvedSummaryLabelColumn,
      );
      const targetColumns = summaryRow.columns && summaryRow.columns.length > 0
        ? summaryRow.columns.filter((column) => numericColumns.includes(column))
        : numericColumns;

      cols.forEach((col) => {
        if (col === labelColumn) {
          totalRow[col] = summaryRow.label || 'Total';
          return;
        }

        if (!targetColumns.includes(col)) {
          totalRow[col] = '';
          return;
        }

        totalRow[col] = calculateSummaryValue(rows, col, summaryRow.calculation ?? 'sum');
      });

      return totalRow;
    });
  }, [cols, numericColumns, resolvedSummaryLabelColumn, resolvedSummaryRows, rows]);

  if (cols.length === 0 || rows.length === 0) {
    return (
      <div className={clsx("p-8", className)}>
        <div className="text-center text-sm text-text-tertiary">
          No data to display.
        </div>
      </div>
    );
  }
  
  // Handle column header click for sorting. Cycles asc → desc → none (matches
  // Power BI / Excel grid). Controlled (onSortChange) or uncontrolled (local).
  const handleHeaderClick = (column: string) => {
    const base = effectiveSorts;
    const existingSort = base.find(s => s.field === column);
    let newSorts: SortConfig[];

    if (!existingSort) {
      // Add new sort (ascending) with highest priority (index 0)
      newSorts = [
        { field: column, direction: 'asc', index: 0 },
        ...base.map(s => ({ ...s, index: s.index + 1 }))
      ];
    } else if (existingSort.direction === 'asc') {
      // Change to descending
      newSorts = base.map(s =>
        s.field === column ? { ...s, direction: 'desc' as const } : s
      );
    } else {
      // Remove sort
      newSorts = base
        .filter(s => s.field !== column)
        .map((s, idx) => ({ ...s, index: idx }));
    }

    if (onSortChange) onSortChange(newSorts);
    else setLocalSorts(newSorts);
  };

  // Get sort indicator for a column
  const getSortIndicator = (column: string) => {
    const sort = effectiveSorts.find(s => s.field === column);
    if (!sort) {
      // Always show the affordance now that the grid is always sortable.
      return <ArrowUpDown className="h-3 w-3 text-text-quaternary" />;
    }
    
    const Icon = sort.direction === 'asc' ? ArrowUp : ArrowDown;
    const priority = effectiveSorts.length > 1 ? ` (${sort.index + 1})` : '';
    
    return (
      <span className="inline-flex items-center ml-1">
        <Icon className="h-3 w-3 text-brand" />
        {priority && <span className="text-[10px] text-brand">{priority}</span>}
      </span>
    );
  };

  const startColumnResize = (column: string, event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const currentWidth = liveColumnWidthsRef.current[column]
      ?? Math.ceil(headerCellRefs.current[column]?.getBoundingClientRect().width ?? 0)
      ?? MIN_COLUMN_WIDTH;

    resizeStateRef.current = {
      column,
      startX: event.clientX,
      startWidth: Math.max(currentWidth, MIN_COLUMN_WIDTH),
    };
    setActiveResizeColumn(column);
  };

  const allColumnWidthsResolved = cols.every((col) => typeof liveColumnWidths[col] === 'number' && liveColumnWidths[col] > 0);
  const tableWidth = allColumnWidthsResolved
    ? cols.reduce((total, col) => total + liveColumnWidths[col], 0)
    : undefined;

  return (
    <div className={clsx("h-full overflow-auto", className)}>
      <table
        className="border-separate border-spacing-0 text-sm min-w-full"
        style={{
          tableLayout: allColumnWidthsResolved ? 'fixed' : 'auto',
          width: tableWidth,
        }}
      >
          <colgroup>
            {cols.map((col) => (
              <col
                key={`col-${col}`}
                style={liveColumnWidths[col] ? { width: liveColumnWidths[col] } : undefined}
              />
            ))}
          </colgroup>
          <thead className="bg-surface-2 sticky top-0 z-10">
            <tr>
              {cols.map((col) => {
                const alignment = getColumnAlignment(col, columnAlignments);

                return (
                  <th
                    key={col}
                    ref={(element) => {
                      headerCellRefs.current[col] = element;
                    }}
                    className={clsx(
                      "group/table-header relative border-b-2 border-[rgb(var(--border-line))] px-4 py-3 font-semibold text-text-secondary",
                      "cursor-pointer hover:bg-surface-2 select-none",
                    )}
                    style={{ textAlign: alignment }}
                    onClick={() => handleHeaderClick(col)}
                  >
                    <div className={clsx("flex min-w-0 items-center gap-1.5", getHeaderJustifyClass(alignment))}>
                      {/* Phase-15.13: render the friendly label, not the raw
                          qualified SQL key. Title attribute keeps the raw
                          ref available on hover for engineering debug. */}
                      <span
                        className="truncate whitespace-nowrap"
                        title={col}
                      >
                        {lookupColumnLabel(col, columnLabels)}
                      </span>
                      {getSortIndicator(col)}
                    </div>

                    {enableColumnResize && (
                      <button
                        type="button"
                        aria-label={`Resize ${col} column`}
                        className="absolute right-0 top-0 h-full w-3 cursor-col-resize touch-none select-none"
                        onMouseDown={(event) => startColumnResize(col, event)}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span
                          className={clsx(
                            "absolute inset-y-2 right-1/2 w-px -translate-x-1/2 rounded-full transition-colors",
                            activeResizeColumn === col
                              ? "bg-brand"
                              : "bg-surface-3 opacity-0 group-hover/table-header:opacity-100",
                          )}
                        />
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr 
                key={i} 
                className={clsx(
                  "transition-colors",
                  i % 2 === 0 ? "bg-surface-1" : "bg-surface-2",
                  enableDrilldown && onRowClick && "cursor-pointer hover:bg-brand/15"
                )}
                onClick={() => enableDrilldown && onRowClick?.(row)}
              >
                {cols.map((col) => {
                  const cellValue = row[col];
                  const alignment = getColumnAlignment(col, columnAlignments);
                  const heatmapStyle = getHeatmapCellStyle(cellValue, col, heatmapRules, heatmapStats);
                  const conditionalStyle = getCellStyle(cellValue, col, conditionalFormatting, row);
                  const style = Object.keys(conditionalStyle).length > 0 ? conditionalStyle : heatmapStyle;
                  const hyperlinkRule = hyperlinkRuleByColumn[col];
                  const safeHref = hyperlinkRule ? resolveRuleHref(hyperlinkRule, row) : null;
                  const displayValue = formatCellValue(cellValue, { numberFormat, decimalPlaces, currencySymbol });
                  
                  return (
                    <td
                      key={col}
                      className="border-b border-[rgb(var(--border-line))] px-4 py-2.5 align-top"
                      style={{
                        ...style,
                        textAlign: alignment,
                      }}
                    >
                      <div className="break-words">
                        {safeHref ? (
                          <a
                            href={safeHref}
                            target={hyperlinkRule?.openInNewTab === false ? undefined : '_blank'}
                            rel={hyperlinkRule?.openInNewTab === false ? undefined : 'noopener noreferrer'}
                            className="font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:text-brand-hover hover:decoration-brand"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {displayValue || safeHref}
                          </a>
                        ) : (
                          displayValue
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {summaryRowsData.length > 0 && (
            <tfoot className="sticky bottom-0 z-20 shadow-[0_-10px_20px_rgba(15,23,42,0.08)]">
              {summaryRowsData.map((summaryRow, summaryIndex) => (
                <tr
                  key={`summary-row-${summaryIndex}`}
                  className={clsx(
                    "font-semibold text-text-primary",
                    summaryIndex % 2 === 0 ? "bg-surface-2" : "bg-surface-2",
                  )}
                >
                  {cols.map((col) => {
                    const alignment = getColumnAlignment(col, columnAlignments);

                    return (
                      <td
                        key={`summary-${summaryIndex}-${col}`}
                        className={clsx(
                          "border-b border-[rgb(var(--border-line))] px-4 py-2.5 align-top",
                          summaryIndex % 2 === 0 ? "bg-surface-2" : "bg-surface-2",
                          summaryIndex === 0 && "border-t-2 border-[rgb(var(--border-strong))]",
                        )}
                        style={{ textAlign: alignment }}
                      >
                        <div className="break-words">{formatCellValue(summaryRow[col], { numberFormat, decimalPlaces, currencySymbol })}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tfoot>
          )}
        </table>
      
      {rows.length > maxRows && (
        <div className="px-4 py-2 bg-surface-2 border-t border-[rgb(var(--border-line))] text-xs text-text-tertiary text-center">
          Showing {maxRows} of {rows.length} rows
          {summaryRowsData.length > 0 ? ` | Summary uses all ${rows.length} rows` : ''}
        </div>
      )}
    </div>
  );
}

function resolveSummaryLabelColumn(
  labelColumn: string | undefined,
  columns: string[],
  numericColumns: string[],
  fallbackLabelColumn: string,
): string {
  if (labelColumn && columns.includes(labelColumn)) {
    return labelColumn;
  }

  if (fallbackLabelColumn && columns.includes(fallbackLabelColumn)) {
    return fallbackLabelColumn;
  }

  return columns.find((column) => !numericColumns.includes(column)) ?? columns[0] ?? '';
}

function calculateSummaryValue(
  rows: Record<string, any>[],
  column: string,
  calculation: TableSummaryRowConfig['calculation'],
): number | string {
  const rawValues = rows
    .map((row) => row?.[column])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
  const numericValues = rawValues
    .map((value) => parseNumericCellValue(value))
    .filter((value): value is number => value !== null);

  switch (calculation) {
    case 'avg':
      return numericValues.length > 0
        ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
        : '';
    case 'count':
      return rawValues.length;
    case 'min':
      return numericValues.length > 0 ? Math.min(...numericValues) : '';
    case 'max':
      return numericValues.length > 0 ? Math.max(...numericValues) : '';
    case 'count_distinct':
      return new Set(rawValues.map((value) => {
        const numericValue = parseNumericCellValue(value);
        return numericValue ?? String(value);
      })).size;
    case 'sum':
    default:
      return numericValues.length > 0
        ? numericValues.reduce((sum, value) => sum + value, 0)
        : '';
  }
}

function formatNumericCellValue(
  value: number,
  options: {
    numberFormat?: NumberFormat;
    decimalPlaces?: number;
    currencySymbol?: string;
  },
): string {
  const format = options.numberFormat ?? 'auto';
  const decimalPlaces = options.decimalPlaces ?? 1;
  const currencySymbol = options.currencySymbol || '$';
  const abs = Math.abs(value);

  if (format === 'compact') {
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(decimalPlaces)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(decimalPlaces)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(decimalPlaces)}K`;
  }

  if (format === 'percent') {
    return `${(value * 100).toFixed(decimalPlaces)}%`;
  }

  if (format === 'currency') {
    return `${currencySymbol}${value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimalPlaces,
    })}`;
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: format === 'auto' ? undefined : decimalPlaces,
  });
}

function formatCellValue(
  value: any,
  options: {
    numberFormat?: NumberFormat;
    decimalPlaces?: number;
    currencySymbol?: string;
  } = {},
): string {
  // BI-standard (Power BI): a null/blank member renders as "(blank)" so a
  // missing dimension value (e.g. an unmapped snowflake join key) is visible
  // and distinguishable from an intentional empty string — not an invisible
  // empty cell that looks like a rendering glitch.
  if (value === null || value === undefined) {
    return '(blank)';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  const numericValue = parseNumericCellValue(value);
  const shouldApplyExplicitNumberFormat = options.numberFormat && options.numberFormat !== 'auto';

  if (typeof value === 'number') {
    return formatNumericCellValue(value, options);
  }

  if (shouldApplyExplicitNumberFormat && numericValue !== null) {
    return formatNumericCellValue(numericValue, options);
  }

  return String(value);
}
