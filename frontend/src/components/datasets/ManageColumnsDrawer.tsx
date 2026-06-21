/**
 * ManageColumnsDrawer - Hide/Show columns, and delete computed (js_formula) columns
 */
'use client';

import React, { useState, useEffect } from 'react';
import { X, Loader2, Trash2, Cpu } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import type { DatasetTable, Transformation } from '@/hooks/use-datasets';

interface ManageColumnsDrawerProps {
  table: DatasetTable;
  allColumns: string[];
  /** Names of columns produced by js_formula transformations — these can be deleted */
  computedColumns?: string[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (transformations: Transformation[]) => Promise<void>;
}

export function ManageColumnsDrawer({
  table,
  allColumns,
  computedColumns = [],
  isOpen,
  onClose,
  onSave,
}: ManageColumnsDrawerProps) {
  const { t } = useI18n();
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [deletedComputed, setDeletedComputed] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  // fullSourceColumns is the COMPLETE source column list (including hidden ones).
  // It is derived from all_columns stored in the select_columns transform params,
  // or falls back to the allColumns prop on first open (before any hiding).
  const [fullSourceColumns, setFullSourceColumns] = useState<string[]>([]);

  const computedSet = new Set(computedColumns);

  // Initialize selected columns
  useEffect(() => {
    if (!isOpen) return;
    setDeletedComputed(new Set()); // reset deletions on open

    // Find select_columns transformation
    const selectTransform = table.transformations?.find(
      (t) => t.type === 'select_columns' && t.enabled
    );

    // Reconstruct the FULL source column list:
    // prefer the persisted all_columns (saved on last Apply), else use the allColumns prop.
    const persistedAll = selectTransform?.params?.all_columns as string[] | undefined;
    const fullList = (persistedAll ?? allColumns).filter((c) => !computedSet.has(c));
    setFullSourceColumns(fullList);

    if (selectTransform && selectTransform.params.columns) {
      setSelectedColumns(
        new Set(
          (selectTransform.params.columns as string[]).filter((c) => !computedSet.has(c))
        )
      );
    } else {
      // No filter saved yet — all source columns are visible
      setSelectedColumns(new Set(fullList));
    }
  }, [isOpen, table.transformations, allColumns]);

  const handleToggle = (column: string) => {
    const newSelected = new Set(selectedColumns);
    if (newSelected.has(column)) {
      newSelected.delete(column);
    } else {
      newSelected.add(column);
    }
    setSelectedColumns(newSelected);
  };

  const handleSelectAll = () => {
    setSelectedColumns(new Set(fullSourceColumns.filter((c) => !deletedComputed.has(c))));
  };

  const handleDeselectAll = () => {
    setSelectedColumns(new Set());
  };

  const handleDeleteComputed = (column: string) => {
    setDeletedComputed((prev) => new Set([...prev, column]));
    // Also remove from visible selection
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      next.delete(column);
      return next;
    });
  };

  const handleUndoDelete = (column: string) => {
    setDeletedComputed((prev) => {
      const next = new Set(prev);
      next.delete(column);
      return next;
    });
    setSelectedColumns((prev) => new Set([...prev, column]));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const existingTransforms = table.transformations || [];

      // Remove deleted computed steps (js_formula or add_column) and old select_columns
      const filteredTransforms = existingTransforms.filter((t) => {
        if (t.type === 'select_columns') return false;
        if (
          (t.type === 'js_formula' || t.type === 'add_column') &&
          t.params?.newField &&
          deletedComputed.has(t.params.newField as string)
        ) return false;
        return true;
      });

      // Build columns list: only source columns (computed ones are added client-side by js_formula)
      const visibleColumns = Array.from(selectedColumns).filter(
        (c) => !deletedComputed.has(c) && !computedSet.has(c)
      );

      const newTransform: Transformation = {
        type: 'select_columns',
        enabled: true,
        // Persist all_columns so the drawer can restore hidden cols on next open
        params: { columns: visibleColumns, all_columns: fullSourceColumns },
      };

      const updatedTransforms = [newTransform, ...filteredTransforms];

      await onSave(updatedTransforms);
      onClose();
    } catch (error) {
      console.error('Failed to save column selection:', error);
      toast.error(t('datasets.manageColumns.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-overlay/84 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-50 flex w-96 flex-col border-l border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] bg-surface-1 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{t('datasets.manageColumns.title')}</h2>
            <p className="text-sm text-text-tertiary mt-1">
              {t('datasets.manageColumns.selectedCount', { selected: selectedColumns.size, total: fullSourceColumns.length })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-quaternary hover:text-text-secondary transition-colors"
            disabled={isSaving}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick actions */}
        <div className="flex gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-6 py-3">
          <button
            onClick={handleSelectAll}
            className="text-sm text-brand hover:text-brand"
            disabled={isSaving}
          >
            {t('datasets.manageColumns.selectAll')}
          </button>
          <span className="text-text-quaternary">|</span>
          <button
            onClick={handleDeselectAll}
            className="text-sm text-brand hover:text-brand"
            disabled={isSaving}
          >
            {t('datasets.manageColumns.deselectAll')}
          </button>
        </div>
        {deletedComputed.size > 0 && (
          <div className="border-b border-danger/20 bg-danger/10 px-6 py-2 text-xs text-danger">
            ⚠️ {t('datasets.manageColumns.pendingDeleteWarning', { count: deletedComputed.size })}
          </div>
        )}

        {/* Column list */}
        <div className="flex-1 overflow-y-auto bg-surface-0 px-6 py-4">
          <div className="space-y-2">
            {/* Render ALL source columns (including hidden ones) so users can toggle them */}
            {fullSourceColumns.map((column) => {
              const isPendingDelete = deletedComputed.has(column);
              return (
                // Source column — hide/show only
                <label
                  key={column}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-transparent bg-surface-1 p-2 transition-colors hover:border-[rgb(var(--border-line))] hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={selectedColumns.has(column)}
                    onChange={() => handleToggle(column)}
                    disabled={isSaving || isPendingDelete}
                    className="w-4 h-4 text-brand border-[rgb(var(--border-strong))] rounded focus:ring-brand"
                  />
                  <span className="text-sm text-text-primary font-mono">{column}</span>
                </label>
              );
            })}
            {/* Computed columns (js_formula) - always appended, can be deleted */}
            {computedColumns.map((column) => {
              const isPendingDelete = deletedComputed.has(column);
              return (
                <div
                  key={column}
                  className={`flex items-center gap-3 rounded-lg p-2 ${
                    isPendingDelete ? 'border border-danger/20 bg-danger/10 opacity-60' : 'border border-brand/20 bg-brand/10'
                  }`}
                >
                  <Cpu className="w-4 h-4 text-brand shrink-0" />
                  <span className={`text-sm font-mono flex-1 ${
                    isPendingDelete ? 'line-through text-text-quaternary' : 'text-brand'
                  }`}>
                    {column}
                  </span>
                  <span className="text-[10px] text-brand font-medium shrink-0">{t('datasets.manageColumns.formulaBadge')}</span>
                  {isPendingDelete ? (
                    <button
                      onClick={() => handleUndoDelete(column)}
                      disabled={isSaving}
                      className="text-xs text-text-tertiary hover:text-text-primary underline shrink-0"
                      title={t('datasets.manageColumns.undoDeleteTitle')}
                    >
                      {t('datasets.manageColumns.undo')}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleDeleteComputed(column)}
                      disabled={isSaving}
                      className="p-1 text-danger hover:text-danger hover:bg-danger/10 rounded transition-colors shrink-0"
                      title={t('datasets.manageColumns.deleteFormulaTitle')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-[rgb(var(--border-line))] bg-surface-2 px-6 py-4">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || selectedColumns.size === 0}
            className="px-4 py-2 bg-brand text-white text-sm rounded-md hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('datasets.manageColumns.apply')}
          </button>
        </div>
      </div>
    </>
  );
}
