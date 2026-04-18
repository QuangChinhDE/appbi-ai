'use client';

import React, { useMemo } from 'react';
import type { TemplateDefinition, TemplateColumn } from '@/types/template';
import type { TablePreviewResponse } from '@/hooks/use-datasets';
import { formatValue } from '@/hooks/use-template-data';

interface CrossTabLayoutProps {
  definition: TemplateDefinition;
  previewData?: TablePreviewResponse;
  isLoading: boolean;
}

export function CrossTabLayout({ definition, previewData, isLoading }: CrossTabLayoutProps) {
  const { columns, crossTabConfig } = definition;
  const rows = previewData?.rows ?? [];

  const pivotCol = columns.find((c) => c.key === crossTabConfig?.pivotColumn);
  const valueCol = columns.find((c) => c.key === crossTabConfig?.valueColumn);
  const rowCols = (crossTabConfig?.rowColumns ?? [])
    .map((key) => columns.find((c) => c.key === key))
    .filter(Boolean) as TemplateColumn[];

  const { pivotValues, pivotRows, colTotals } = useMemo(() => {
    if (!pivotCol || !valueCol || rowCols.length === 0) {
      return { pivotValues: [] as string[], pivotRows: [] as any[], colTotals: {} as Record<string, number> };
    }

    const pivotSrc = pivotCol.sourceColumn ?? pivotCol.key;
    const valueSrc = valueCol.sourceColumn ?? valueCol.key;

    const pvSet = new Set<string>();
    for (const row of rows) {
      pvSet.add(String(row[pivotSrc] ?? ''));
    }
    const pvArr = Array.from(pvSet).sort();

    const rowKeyFn = (row: Record<string, any>) =>
      rowCols.map((c) => String(row[c.sourceColumn ?? c.key] ?? '')).join('||');

    const grouped = new Map<string, {
      rowData: Record<string, any>;
      values: Record<string, number>;
      total: number;
    }>();

    for (const row of rows) {
      const rk = rowKeyFn(row);
      if (!grouped.has(rk)) {
        grouped.set(rk, { rowData: row, values: {}, total: 0 });
      }
      const entry = grouped.get(rk)!;
      const pv = String(row[pivotSrc] ?? '');
      const val = typeof row[valueSrc] === 'number' ? row[valueSrc] : parseFloat(row[valueSrc]) || 0;
      entry.values[pv] = (entry.values[pv] ?? 0) + val;
      entry.total += val;
    }

    const cTotals: Record<string, number> = {};
    for (const entry of grouped.values()) {
      for (const pv of pvArr) {
        cTotals[pv] = (cTotals[pv] ?? 0) + (entry.values[pv] ?? 0);
      }
    }

    return { pivotValues: pvArr, pivotRows: Array.from(grouped.values()), colTotals: cTotals };
  }, [rows, pivotCol, valueCol, rowCols]);

  if (!pivotCol || !valueCol || rowCols.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-text-quaternary">
        Configure cross-tab: set row columns, pivot column, and value column in properties.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto p-3">
      {isLoading && (
        <div className="py-8 text-center text-xs text-text-tertiary">Loading data…</div>
      )}

      {!isLoading && (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {rowCols.map((col) => (
                <th
                  key={col.id}
                  className="border border-[rgb(var(--border-line))] bg-surface-inverse/80 px-2.5 py-1.5 text-left text-[10px] font-medium font-mono text-text-quaternary whitespace-nowrap"
                >
                  {col.label}
                </th>
              ))}
              {pivotValues.map((pv) => (
                <th
                  key={pv}
                  className="border border-[rgb(var(--border-line))] bg-surface-inverse px-2.5 py-1.5 text-center text-[10px] font-medium font-mono text-text-quaternary whitespace-nowrap"
                >
                  {pv}
                </th>
              ))}
              {crossTabConfig?.showRowTotal !== false && (
                <th className="border border-[rgb(var(--border-line))] bg-brand/10 px-2.5 py-1.5 text-center text-[10px] font-semibold font-mono text-brand whitespace-nowrap">
                  Total
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {pivotRows.map((entry, ri) => (
              <tr key={ri} className="hover:bg-surface-2 transition-colors">
                {rowCols.map((col) => (
                  <td
                    key={col.id}
                    className="border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1.5 text-left text-xs font-medium text-text-primary whitespace-nowrap"
                  >
                    {String(entry.rowData[col.sourceColumn ?? col.key] ?? '')}
                  </td>
                ))}
                {pivotValues.map((pv) => (
                  <td
                    key={pv}
                    className="border border-[rgb(var(--border-line))] px-2.5 py-1.5 text-right text-[10px] font-mono text-text-secondary whitespace-nowrap"
                  >
                    {entry.values[pv]
                      ? formatValue(entry.values[pv], valueCol.format, valueCol.suffix)
                      : '—'}
                  </td>
                ))}
                {crossTabConfig?.showRowTotal !== false && (
                  <td className="border border-[rgb(var(--border-line))] bg-brand/10 px-2.5 py-1.5 text-right text-[10px] font-mono font-semibold text-brand whitespace-nowrap">
                    {formatValue(entry.total, valueCol.format, valueCol.suffix)}
                  </td>
                )}
              </tr>
            ))}

            {/* Column totals row */}
            {crossTabConfig?.showColumnTotal !== false && pivotRows.length > 0 && (
              <tr>
                {rowCols.map((col, ci) => (
                  <td
                    key={col.id}
                    className="border border-[rgb(var(--border-line))] bg-brand/10 px-2.5 py-1.5 text-left text-xs font-semibold text-brand whitespace-nowrap"
                  >
                    {ci === 0 ? `TOTAL — ${pivotRows.length} rows` : ''}
                  </td>
                ))}
                {pivotValues.map((pv) => (
                  <td
                    key={pv}
                    className="border border-[rgb(var(--border-line))] bg-brand/10 px-2.5 py-1.5 text-right text-[10px] font-mono font-semibold text-brand whitespace-nowrap"
                  >
                    {formatValue(colTotals[pv] ?? 0, valueCol.format, valueCol.suffix)}
                  </td>
                ))}
                {crossTabConfig?.showRowTotal !== false && (
                  <td className="border border-[rgb(var(--border-line))] bg-brand/15 px-2.5 py-1.5 text-right text-[10px] font-mono font-semibold text-brand whitespace-nowrap">
                    {formatValue(
                      Object.values(colTotals).reduce((s, v) => s + v, 0),
                      valueCol.format,
                      valueCol.suffix,
                    )}
                  </td>
                )}
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
