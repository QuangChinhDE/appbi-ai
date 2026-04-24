'use client';

import React, { useMemo } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import type { TemplateDefinition, TemplateColumn } from '@/types/template';
import { evaluateFormula, formatValue } from '@/hooks/use-template-data';

interface TemplateEntryGridProps {
  definition: TemplateDefinition;
  rows: Record<string, any>[];
  canEdit: boolean;
  hasActiveFilters: boolean;
  hasMoreRows: boolean;
  isSaving: boolean;
  onRowsChange: (rows: Record<string, any>[]) => void;
  onSave: () => void;
}

function resolveEditableKey(column: TemplateColumn): string {
  return column.sourceColumn ?? column.key;
}

function renderReadonlyValue(
  column: TemplateColumn,
  row: Record<string, any>,
  columns: TemplateColumn[],
): string {
  if (column.expression) {
    return formatValue(evaluateFormula(column.expression, row, columns), column.format, column.suffix);
  }
  return formatValue(row[resolveEditableKey(column)], column.format, column.suffix);
}

export function TemplateEntryGrid({
  definition,
  rows,
  canEdit,
  hasActiveFilters,
  hasMoreRows,
  isSaving,
  onRowsChange,
  onSave,
}: TemplateEntryGridProps) {
  const visibleColumns = useMemo(
    () => definition.columns.filter((column) => column.visible !== false),
    [definition.columns],
  );

  const editableColumns = useMemo(
    () => visibleColumns.filter((column) => column.type !== 'formula' && column.type !== 'subtotal'),
    [visibleColumns],
  );

  const updateCell = (rowIndex: number, column: TemplateColumn, value: string) => {
    const key = resolveEditableKey(column);
    onRowsChange(
      rows.map((row, index) => index === rowIndex ? { ...row, [key]: value } : row),
    );
  };

  const addRow = () => {
    const nextRow: Record<string, any> = {};
    for (const column of editableColumns) {
      nextRow[resolveEditableKey(column)] = '';
    }
    onRowsChange([...rows, nextRow]);
  };

  const removeRow = (rowIndex: number) => {
    onRowsChange(rows.filter((_, index) => index !== rowIndex));
  };

  const saveBlocked = !canEdit || hasActiveFilters || hasMoreRows;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface-2">
      <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">Data Entry</p>
          <p className="text-xs text-text-quaternary">Manual datasource only. Save writes the current full snapshot back to the datasource.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={addRow}
            disabled={!canEdit || hasActiveFilters || hasMoreRows}
            className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            Add row
          </button>
          <button
            onClick={onSave}
            disabled={saveBlocked || isSaving}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? 'Saving...' : 'Save data'}
          </button>
        </div>
      </div>

      {(hasActiveFilters || hasMoreRows) && (
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
          {hasActiveFilters && 'Reset runtime filters before saving data. '}
          {hasMoreRows && 'Preview is truncated. Load the full manual snapshot before saving.'}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-line))] bg-white shadow-sm">
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="bg-surface-2">
                <th className="border-b border-[rgb(var(--border-line))] px-3 py-2 text-left text-[11px] font-semibold text-text-tertiary">#</th>
                {visibleColumns.map((column) => (
                  <th key={column.id} className="border-b border-[rgb(var(--border-line))] px-3 py-2 text-left text-[11px] font-semibold text-text-tertiary">
                    {column.label}
                  </th>
                ))}
                <th className="border-b border-[rgb(var(--border-line))] px-3 py-2 text-right text-[11px] font-semibold text-text-tertiary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length + 2} className="px-4 py-8 text-center text-sm text-text-quaternary">
                    No rows yet. Add the first row to start entering data.
                  </td>
                </tr>
              )}
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-[rgb(var(--border-line))] align-top">
                  <td className="px-3 py-2 text-xs font-mono text-text-quaternary">{rowIndex + 1}</td>
                  {visibleColumns.map((column) => {
                    const isEditable = column.type !== 'formula' && column.type !== 'subtotal';
                    return (
                      <td key={column.id} className="px-3 py-2 text-xs text-text-secondary">
                        {isEditable ? (
                          <input
                            value={String(row[resolveEditableKey(column)] ?? '')}
                            onChange={(e) => updateCell(rowIndex, column, e.target.value)}
                            disabled={!canEdit}
                            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1.5 text-xs text-text-secondary outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                          />
                        ) : (
                          <span className="font-mono text-text-primary">
                            {renderReadonlyValue(column, row, definition.columns)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => removeRow(rowIndex)}
                      disabled={!canEdit || isSaving}
                      className="inline-flex items-center gap-1 rounded-md border border-danger/30 bg-danger/5 px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}