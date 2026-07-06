'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useExportMode } from '@/lib/export-mode';
import {
  ArrowUp, ArrowDown, ArrowUpDown,
  Minus, Check, X as XIcon, AlertTriangle, Flag, Star, Circle,
  Filter as FilterIcon, Search as SearchIcon,
  type LucideIcon,
} from 'lucide-react';
import {
  type TableColumnFilter,
  type TableFilterColumnType,
  type TableFilterOperator,
  EMPTY_TABLE_COLUMN_FILTER,
  isTableColumnFilterActive,
  detectTableColumnType,
  rowMatchesAllTableFilters,
  distinctTableColumnValues,
  operatorsForType,
  operatorValueCount,
} from '@/lib/tableColumnFilter';
import type { NumberFormat, TableCellFormat } from '@/components/explore/ExploreChartConfig';
import type { TableColumnAlignment, TableHyperlinkRule } from '@/types/api';
import {
  SortConfig,
  ConditionalFormatRule,
  TableHeatmapRule,
  TableSummaryRowConfig,
} from '@/types/api';
import {
  buildTableHeatmapStats,
  buildConditionalStats,
  getCellStyle,
  getHeatmapCellStyle,
  parseNumericCellValue,
  isDateFormatKind,
  formatDateCellValue,
} from '@/lib/exploreAggregations';

// Icon keys usable in conditional-formatting "icon" mode (Feature #4).
const CF_ICONS: Record<string, LucideIcon> = {
  up: ArrowUp, down: ArrowDown, flat: Minus, check: Check,
  cross: XIcon, warning: AlertTriangle, flag: Flag, star: Star, dot: Circle,
};

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
  /**
   * Excel/Power BI-style per-column view filter. When true (default), each
   * header gets a filter control that narrows the ALREADY-fetched rows by
   * text/number/date condition + multi-select checklist; multiple columns
   * combine with AND. This is a pure client-side presentation filter — it
   * never re-queries or touches the semantic/dashboard filter system.
   */
  enableColumnFilters?: boolean;
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
  /**
   * Phase-16.x — per-column number format. {column-key → NumberFormat}, keyed
   * by the same qualified-or-bare field ref as the data columns. Lets a
   * percent measure render "30%" and a currency measure "$1,234" in their own
   * column while other columns keep the table-wide `numberFormat`. Built from
   * the semantic model's measure `format.kind` (buildSemanticFormatMap), so a
   * column declared as percent/currency at the dataset level formats itself.
   */
  columnFormats?: Record<string, TableCellFormat> | Map<string, TableCellFormat>;
  /** Cross-highlight (PBI-parity): when set, rows whose dimension key is NOT in
   *  this set are dimmed (the selection's matching rows stay full opacity).
   *  Pass together with `rowDimKey` so both sides compute the key identically. */
  highlightRowKeys?: Set<string> | null;
  rowDimKey?: (row: Record<string, any>) => string;
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
  enableColumnFilters = true,
  numberFormat = 'auto',
  decimalPlaces = 1,
  currencySymbol = '$',
  columnLabels,
  columnFormats,
  highlightRowKeys,
  rowDimKey,
}: TableVisualizationProps) {
  const rows = data ?? [];
  // Phase-16.x — per-column number format resolver. A column whose field is a
  // declared percent/currency/number measure formats by THAT format; others
  // fall back to the table-wide `numberFormat`. Accepts qualified ("view.field")
  // or bare ("field") keys (tries both).
  const getColumnFormat = (col: string): TableCellFormat => {
    if (columnFormats) {
      const get = (k: string) =>
        columnFormats instanceof Map ? columnFormats.get(k) : columnFormats[k];
      const bare = col.includes('.') ? col.split('.').slice(-1)[0] : col;
      const hit = get(col) ?? get(bare);
      if (hit) return hit;
    }
    return numberFormat;
  };
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

  // ── Per-column view filter (Excel / Power BI AutoFilter) ──────────────────
  // A pure client-side filter over the ALREADY-fetched rows: it narrows what
  // the table shows, never re-queries and never touches the semantic/dashboard
  // filter system. State is uncontrolled/local (ephemeral view state);
  // `openFilterCol` tracks which header popover is open.
  const [columnFilters, setColumnFilters] = useState<Record<string, TableColumnFilter>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null);
  // Numeric-column detection (a column with any numeric-parseable value) — kept
  // on the FULL rows so the type is stable as the user filters.
  const numericColumns = useMemo(
    () => cols.filter((col) => rows.some((row) => parseNumericCellValue(row?.[col]) !== null)),
    [cols, rows],
  );
  const columnFilterTypes = useMemo<Record<string, TableFilterColumnType>>(() => {
    const map: Record<string, TableFilterColumnType> = {};
    for (const col of cols) map[col] = detectTableColumnType(rows, col, numericColumns.includes(col));
    return map;
  }, [cols, rows, numericColumns]);
  const hasActiveColumnFilters = useMemo(
    () => enableColumnFilters && Object.values(columnFilters).some(isTableColumnFilterActive),
    [enableColumnFilters, columnFilters],
  );
  // rows → filteredRows (feeds sort, stats, summary, display). The full `rows`
  // stay available for the "filtered from N" count and the checklist options.
  const filteredRows = useMemo(() => {
    if (!hasActiveColumnFilters) return rows;
    return rows.filter((r) => rowMatchesAllTableFilters(r, columnFilters, columnFilterTypes));
  }, [rows, columnFilters, columnFilterTypes, hasActiveColumnFilters]);

  // Apply the effective sort to the (filtered) rows for display. Mixed-type
  // safe: numbers compare numerically, everything else by locale string;
  // null/undefined sink to the bottom regardless of direction.
  const sortedRows = useMemo(() => {
    if (!effectiveSorts || effectiveSorts.length === 0) return filteredRows;
    const ordered = [...effectiveSorts].sort((a, b) => a.index - b.index);
    const arr = [...filteredRows];
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
  }, [filteredRows, effectiveSorts]);

  // Phase-B22 — during PDF export, render EVERY row (drop the 200-cap) so the
  // exporter captures the full table.
  const exporting = useExportMode();
  const displayRows = exporting ? sortedRows : sortedRows.slice(0, maxRows);

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
  // Heatmap / conditional stats + summaries compute over the FILTERED rows so
  // the coloring and totals reflect exactly what the viewer sees (Excel parity).
  const heatmapStats = useMemo(
    () => buildTableHeatmapStats(filteredRows, heatmapRules),
    [heatmapRules, filteredRows],
  );
  // Column stats for conditional rules that scale to the column (percentile,
  // percentage, data bars). Built once per (rows, rules) — see getCellStyle.
  const conditionalStats = useMemo(
    () => buildConditionalStats(filteredRows, conditionalFormatting),
    [conditionalFormatting, filteredRows],
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

        totalRow[col] = calculateSummaryValue(filteredRows, col, summaryRow.calculation ?? 'sum');
      });

      return totalRow;
    });
  }, [cols, numericColumns, resolvedSummaryLabelColumn, resolvedSummaryRows, filteredRows]);

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

  // ── Column-filter handlers ────────────────────────────────────────────────
  const openColumnFilter = (column: string, anchor: HTMLElement) => {
    setFilterAnchorRect(anchor.getBoundingClientRect());
    setOpenFilterCol((current) => (current === column ? null : column));
  };
  const updateColumnFilter = (column: string, next: TableColumnFilter) => {
    setColumnFilters((prev) => ({ ...prev, [column]: next }));
  };
  const clearColumnFilter = (column: string) => {
    setColumnFilters((prev) => {
      const rest = { ...prev };
      delete rest[column];
      return rest;
    });
  };
  const clearAllColumnFilters = () => {
    setColumnFilters({});
    setOpenFilterCol(null);
  };

  const allColumnWidthsResolved = cols.every((col) => typeof liveColumnWidths[col] === 'number' && liveColumnWidths[col] > 0);
  const tableWidth = allColumnWidthsResolved
    ? cols.reduce((total, col) => total + liveColumnWidths[col], 0)
    : undefined;

  return (
    <div className={clsx(exporting ? "w-full" : "h-full overflow-auto", className)}>
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
                      {enableColumnFilters && (
                        <button
                          type="button"
                          aria-label={`Filter ${lookupColumnLabel(col, columnLabels)}`}
                          title="Filter column"
                          className={clsx(
                            "ml-0.5 shrink-0 rounded p-0.5 transition-colors",
                            isTableColumnFilterActive(columnFilters[col])
                              ? "text-brand"
                              : "text-text-quaternary opacity-0 group-hover/table-header:opacity-100 hover:text-text-secondary",
                            openFilterCol === col && "text-brand opacity-100",
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            openColumnFilter(col, event.currentTarget);
                          }}
                        >
                          <FilterIcon
                            className={clsx("h-3 w-3", isTableColumnFilterActive(columnFilters[col]) && "fill-current")}
                          />
                        </button>
                      )}
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
            {displayRows.map((row, i) => {
              const rowDimmed = !!(highlightRowKeys && rowDimKey && !highlightRowKeys.has(rowDimKey(row)));
              return (
              <tr
                key={i}
                className={clsx(
                  "transition-colors",
                  i % 2 === 0 ? "bg-surface-1" : "bg-surface-2",
                  enableDrilldown && onRowClick && "cursor-pointer hover:bg-brand/15"
                )}
                style={rowDimmed ? { opacity: 0.3 } : undefined}
                onClick={() => enableDrilldown && onRowClick?.(row)}
              >
                {cols.map((col) => {
                  const cellValue = row[col];
                  const alignment = getColumnAlignment(col, columnAlignments);
                  const heatmapStyle = getHeatmapCellStyle(cellValue, col, heatmapRules, heatmapStats);
                  const cf = getCellStyle(cellValue, col, conditionalFormatting, row, conditionalStats);
                  // Color/background: conditional rule wins; else heatmap fallback.
                  const colorStyle = (cf.color || cf.backgroundColor)
                    ? { color: cf.color, backgroundColor: cf.backgroundColor }
                    : heatmapStyle;
                  const dataBar = cf.dataBar;
                  const IconGlyph = cf.icon ? CF_ICONS[cf.icon.key] : undefined;
                  const hyperlinkRule = hyperlinkRuleByColumn[col];
                  const safeHref = hyperlinkRule ? resolveRuleHref(hyperlinkRule, row) : null;
                  const displayValue = formatCellValue(cellValue, { numberFormat: getColumnFormat(col), decimalPlaces, currencySymbol });

                  return (
                    <td
                      key={col}
                      className="border-b border-[rgb(var(--border-line))] px-4 py-2.5 align-top"
                      style={{
                        ...colorStyle,
                        textAlign: alignment,
                        position: dataBar ? 'relative' : undefined,
                      }}
                    >
                      {dataBar && (
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-y-1.5 left-2 right-2 flex items-center"
                        >
                          <div
                            style={{
                              width: `${Math.max(2, dataBar.ratio * 100)}%`,
                              height: '100%',
                              backgroundColor: dataBar.color,
                              opacity: 0.28,
                              borderRadius: 3,
                            }}
                          />
                        </div>
                      )}
                      <div className={clsx('relative break-words', IconGlyph && 'inline-flex items-center gap-1.5')}>
                        {IconGlyph && (
                          <IconGlyph
                            className="h-3.5 w-3.5 shrink-0"
                            style={cf.icon?.color ? { color: cf.icon.color } : undefined}
                            aria-hidden
                          />
                        )}
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
              );
            })}
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
                        <div className="break-words">{formatCellValue(summaryRow[col], { numberFormat: getColumnFormat(col), decimalPlaces, currencySymbol })}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tfoot>
          )}
        </table>

      {!exporting && (rows.length > maxRows || hasActiveColumnFilters) && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 bg-surface-2 border-t border-[rgb(var(--border-line))] text-xs text-text-tertiary text-center">
          <span>
            Showing {displayRows.length} of {filteredRows.length}
            {hasActiveColumnFilters ? ` (filtered from ${rows.length})` : ''} rows
            {summaryRowsData.length > 0 ? ` | Summary uses ${filteredRows.length} row${filteredRows.length === 1 ? '' : 's'}` : ''}
          </span>
          {hasActiveColumnFilters && (
            <button
              type="button"
              onClick={clearAllColumnFilters}
              className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-0.5 font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
            >
              <XIcon className="h-3 w-3" /> Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Column-filter popover — portal to <body> so the table's overflow clip
          never truncates it. */}
      {enableColumnFilters && openFilterCol && filterAnchorRect && (
        <ColumnFilterPopover
          key={openFilterCol}
          label={lookupColumnLabel(openFilterCol, columnLabels)}
          type={columnFilterTypes[openFilterCol] ?? 'text'}
          filter={columnFilters[openFilterCol] ?? EMPTY_TABLE_COLUMN_FILTER}
          distinctValues={distinctTableColumnValues(rows, openFilterCol)}
          anchorRect={filterAnchorRect}
          onChange={(next) => updateColumnFilter(openFilterCol, next)}
          onClear={() => clearColumnFilter(openFilterCol)}
          onClose={() => setOpenFilterCol(null)}
        />
      )}
    </div>
  );
}

/**
 * Column-filter popover: a condition editor (operator + up to two typed inputs)
 * AND a multi-select checklist of the column's distinct values. Rendered via a
 * portal at the header icon's position so the table's `overflow-auto` can't clip
 * it. Applies live — every change flows straight to the parent's `columnFilters`.
 */
function ColumnFilterPopover({
  label,
  type,
  filter,
  distinctValues,
  anchorRect,
  onChange,
  onClear,
  onClose,
}: {
  label: string;
  type: TableFilterColumnType;
  filter: TableColumnFilter;
  distinctValues: string[];
  anchorRect: DOMRect;
  onChange: (next: TableColumnFilter) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  const operators = operatorsForType(type);
  const valueCount = operatorValueCount(filter.op);
  const inputType = type === 'number' ? 'number' : type === 'date' ? 'date' : 'text';

  // Close on outside-click or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const WIDTH = 288;
  // Clamp within the viewport; prefer left-aligned to the icon, flip up if the
  // popover would overflow the bottom edge.
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - WIDTH - 8));
  const openUp = anchorRect.bottom + 360 > window.innerHeight && anchorRect.top > 360;
  const top = openUp ? undefined : anchorRect.bottom + 6;
  const bottom = openUp ? window.innerHeight - anchorRect.top + 6 : undefined;

  const filtered = search.trim()
    ? distinctValues.filter((v) => v.toLowerCase().includes(search.trim().toLowerCase()))
    : distinctValues;
  const selectedSet = new Set(filter.selected);
  const toggleValue = (v: string) => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange({ ...filter, selected: Array.from(next) });
  };
  const allVisibleSelected = filtered.length > 0 && filtered.every((v) => selectedSet.has(v));
  const toggleAllVisible = () => {
    const next = new Set(selectedSet);
    if (allVisibleSelected) filtered.forEach((v) => next.delete(v));
    else filtered.forEach((v) => next.add(v));
    onChange({ ...filter, selected: Array.from(next) });
  };
  const displayValue = (v: string) => (v === '' ? '(empty)' : v);
  const active = isTableColumnFilterActive(filter);

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Filter ${label}`}
      className="fixed z-[1000] flex max-h-[70vh] flex-col rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-xl"
      style={{ left, top, bottom, width: WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary" title={label}>{label}</div>
          <div className="text-[11px] uppercase tracking-wide text-text-quaternary">{type} filter</div>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="rounded p-1 text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
          onClick={onClose}
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Condition */}
      <div className="space-y-2 border-b border-[rgb(var(--border-line))] px-3 py-2.5">
        <div className="text-[11px] font-medium text-text-tertiary">Condition</div>
        <select
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
          value={filter.op ?? ''}
          onChange={(e) =>
            onChange({ ...filter, op: (e.target.value || null) as TableFilterOperator | null })
          }
        >
          <option value="">No condition</option>
          {operators.map((op) => (
            <option key={op.value} value={op.value}>{op.label}</option>
          ))}
        </select>
        {valueCount >= 1 && (
          <div className="flex items-center gap-1.5">
            <input
              type={inputType}
              className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
              placeholder={valueCount === 2 ? 'From' : 'Value'}
              value={filter.value1}
              onChange={(e) => onChange({ ...filter, value1: e.target.value })}
            />
            {valueCount === 2 && (
              <>
                <span className="text-xs text-text-quaternary">–</span>
                <input
                  type={inputType}
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
                  placeholder="To"
                  value={filter.value2}
                  onChange={(e) => onChange({ ...filter, value2: e.target.value })}
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Multi-select checklist */}
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-tertiary">
            Values{filter.selected.length > 0 ? ` (${filter.selected.length})` : ''}
          </span>
          <button
            type="button"
            className="text-[11px] font-medium text-brand hover:underline"
            onClick={toggleAllVisible}
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div className="relative mb-1.5">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
          <input
            type="text"
            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 py-1.5 pl-7 pr-2 text-sm text-text-primary focus:border-brand focus:outline-none"
            placeholder="Search values…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[rgb(var(--border-line))]">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-text-quaternary">No matching values</div>
          ) : (
            filtered.map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 shrink-0 accent-[rgb(var(--brand))]"
                  checked={selectedSet.has(v)}
                  onChange={() => toggleValue(v)}
                />
                <span className={clsx('truncate', v === '' && 'italic text-text-quaternary')} title={displayValue(v)}>
                  {displayValue(v)}
                </span>
              </label>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[rgb(var(--border-line))] px-3 py-2">
        <button
          type="button"
          disabled={!active}
          className={clsx(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            active ? 'text-text-secondary hover:bg-surface-3 hover:text-text-primary' : 'cursor-not-allowed text-text-quaternary',
          )}
          onClick={onClear}
        >
          Clear filter
        </button>
        <button
          type="button"
          className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-hover"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>,
    document.body,
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
    numberFormat?: TableCellFormat;
    decimalPlaces?: number;
    currencySymbol?: string;
  },
): string {
  // Only number formats reach here (formatCellValue intercepts date kinds); a
  // stray date kind harmlessly falls through to the default toLocaleString.
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
    numberFormat?: TableCellFormat;
    decimalPlaces?: number;
    currencySymbol?: string;
  } = {},
): string {
  // DA preference (2026-06): a missing value renders as an EMPTY cell rather
  // than the literal word "(blank)" — the word is visually noisy in a dense
  // table (DA report: a column of "(blank)" rows is hard to read). An empty
  // cell is the cleaner, expected look.
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  // A DATE column format wins first — so a date is ALWAYS rendered as a date,
  // never mangled by the numeric branch below (e.g. a YYYYMMDD int → "20,240,324"
  // or a numeric year → "2,024"). formatDateCellValue leaves non-dates as-is.
  if (isDateFormatKind(options.numberFormat)) {
    return formatDateCellValue(value, options.numberFormat);
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
