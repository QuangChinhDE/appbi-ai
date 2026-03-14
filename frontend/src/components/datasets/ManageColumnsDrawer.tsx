/**
 * ManageColumnsDrawer - Hide/Show columns, and delete computed (js_formula) columns
 */
'use client';

import React, { useState, useEffect } from 'react';
import { X, Loader2, Trash2, Cpu } from 'lucide-react';
import type { WorkspaceTable, Transformation } from '@/hooks/use-dataset-workspaces';

interface ManageColumnsDrawerProps {
  table: WorkspaceTable;
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
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-30 z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-96 bg-white shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Manage Columns</h2>
            <p className="text-sm text-gray-500 mt-1">
              {selectedColumns.size} of {fullSourceColumns.length} columns selected
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={isSaving}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick actions */}
        <div className="px-6 py-3 border-b bg-gray-50 flex gap-2">
          <button
            onClick={handleSelectAll}
            className="text-sm text-blue-600 hover:text-blue-700"
            disabled={isSaving}
          >
            Select All
          </button>
          <span className="text-gray-300">|</span>
          <button
            onClick={handleDeselectAll}
            className="text-sm text-blue-600 hover:text-blue-700"
            disabled={isSaving}
          >
            Deselect All
          </button>
        </div>
        {deletedComputed.size > 0 && (
          <div className="px-6 py-2 bg-red-50 border-b text-xs text-red-700">
            ⚠️ {deletedComputed.size} cột công thức sẽ bị xóa khi lưu
          </div>
        )}

        {/* Column list */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            {/* Render ALL source columns (including hidden ones) so users can toggle them */}
            {fullSourceColumns.map((column) => {
              const isPendingDelete = deletedComputed.has(column);
              return (
                // Source column — hide/show only
                <label
                  key={column}
                  className="flex items-center gap-3 p-2 rounded hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedColumns.has(column)}
                    onChange={() => handleToggle(column)}
                    disabled={isSaving || isPendingDelete}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-900 font-mono">{column}</span>
                </label>
              );
            })}
            {/* Computed columns (js_formula) - always appended, can be deleted */}
            {computedColumns.map((column) => {
              const isPendingDelete = deletedComputed.has(column);
              return (
                <div
                  key={column}
                  className={`flex items-center gap-3 p-2 rounded ${
                    isPendingDelete ? 'bg-red-50 opacity-60' : 'bg-purple-50'
                  }`}
                >
                  <Cpu className="w-4 h-4 text-purple-400 shrink-0" />
                  <span className={`text-sm font-mono flex-1 ${
                    isPendingDelete ? 'line-through text-gray-400' : 'text-purple-900'
                  }`}>
                    {column}
                  </span>
                  <span className="text-[10px] text-purple-400 font-medium shrink-0">công thức</span>
                  {isPendingDelete ? (
                    <button
                      onClick={() => handleUndoDelete(column)}
                      disabled={isSaving}
                      className="text-xs text-gray-500 hover:text-gray-800 underline shrink-0"
                      title="Hoàn tác xóa"
                    >
                      Hoàn tác
                    </button>
                  ) : (
                    <button
                      onClick={() => handleDeleteComputed(column)}
                      disabled={isSaving}
                      className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors shrink-0"
                      title="Xóa cột công thức"
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
        <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || selectedColumns.size === 0}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            Apply
          </button>
        </div>
      </div>
    </>
  );
}
