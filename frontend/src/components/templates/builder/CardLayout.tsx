'use client';

import React, { useMemo } from 'react';
import type { TemplateDefinition, TemplateColumn } from '@/types/template';
import type { TablePreviewResponse } from '@/hooks/use-datasets';
import { evaluateFormula, formatValue } from '@/hooks/use-template-data';

interface CardLayoutProps {
  definition: TemplateDefinition;
  previewData?: TablePreviewResponse;
  isLoading: boolean;
}

export function CardLayout({ definition, previewData, isLoading }: CardLayoutProps) {
  const { columns, cardConfig } = definition;
  const rows = previewData?.rows ?? [];
  const cardsPerRow = cardConfig?.cardsPerRow ?? 2;

  const titleCol = columns.find((c) => c.key === cardConfig?.titleColumn);
  const subtitleCols = (cardConfig?.subtitleColumns ?? [])
    .map((key) => columns.find((c) => c.key === key))
    .filter(Boolean) as TemplateColumn[];
  const deductionKeys = new Set(cardConfig?.deductionColumns ?? []);

  const skipKeys = new Set([
    cardConfig?.titleColumn,
    ...(cardConfig?.subtitleColumns ?? []),
  ].filter(Boolean) as string[]);
  const bodyColumns = columns.filter(
    (c) => c.visible !== false && !skipKeys.has(c.key),
  );

  function resolveCell(col: TemplateColumn, row: Record<string, any>): string {
    if (col.expression) {
      const val = row[col.key] != null ? row[col.key] : evaluateFormula(col.expression, row, columns);
      return formatValue(val, col.format, col.suffix);
    }
    const sourceCol = col.sourceColumn ?? col.key;
    return formatValue(row[sourceCol], col.format, col.suffix);
  }

  if (columns.length === 0) return null;

  return (
    <div>
      {/* Card header bar */}
      <div className="flex items-center justify-between border-b border-[rgb(var(--border-strong))] bg-surface-inverse px-4 py-3">
        <span className="text-xs font-mono text-text-quaternary">
          {cardsPerRow} cards / row · {rows.length} records
        </span>
      </div>

      {/* Cards grid */}
      <div
        className="gap-3 p-3"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cardsPerRow}, 1fr)`,
        }}
      >
        {isLoading && (
          <div className="col-span-full py-8 text-center text-xs text-text-tertiary">
            Loading data…
          </div>
        )}

        {!isLoading && rows.length === 0 && (
          <div className="col-span-full py-8 text-center text-xs italic text-text-quaternary">
            No data. Bind a dataset and configure card columns.
          </div>
        )}

        {rows.slice(0, 20).map((row, ri) => {
          const title = titleCol ? resolveCell(titleCol, row) : `Row ${ri + 1}`;
          const subtitle = subtitleCols.map((c) => resolveCell(c, row)).join(' · ');

          return (
            <div
              key={ri}
              className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] hover:shadow-md transition-all"
            >
              {/* Card header */}
              <div className="flex items-center justify-between bg-surface-inverse px-3 py-1.5">
                <strong className="text-xs text-white">{title}</strong>
                <span className="text-[10px] font-mono text-text-quaternary">{subtitle}</span>
              </div>

              {/* Card body */}
              <div className="px-3 py-2">
                {bodyColumns.map((col) => {
                  const val = resolveCell(col, row);
                  const isDeduction = deductionKeys.has(col.key);

                  return (
                    <div
                      key={col.id}
                      className="flex items-center justify-between border-b border-[rgb(var(--border-line))] py-1 last:border-b-0 text-xs"
                    >
                      <span className="text-text-secondary">{col.label}</span>
                      <span className={`font-mono ${isDeduction ? 'text-danger' : 'text-text-primary'}`}>
                        {isDeduction && !val.startsWith('-') ? `−${val}` : val}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Card total */}
              {cardConfig?.totalLabel && (
                <div className="flex items-center justify-between border-t border-brand/30 bg-brand/10 px-3 py-1.5 text-xs font-semibold">
                  <span className="text-brand">{cardConfig.totalLabel}</span>
                  <span className="font-mono text-brand">
                    {columns
                      .filter((c) => c.type === 'subtotal')
                      .map((c) => resolveCell(c, row))
                      .join(' + ')}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
