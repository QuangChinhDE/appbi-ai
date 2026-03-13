/**
 * ManageColumnsDrawer - Hide/Show columns
 */
'use client';

import React, { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { WorkspaceTable, Transformation } from '@/hooks/use-dataset-workspaces';

interface ManageColumnsDrawerProps {
  table: WorkspaceTable;
  allColumns: string[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (transformations: Transformation[]) => Promise<void>;
}

export function ManageColumnsDrawer({
  table,
  allColumns,
  isOpen,
  onClose,
  onSave,
}: ManageColumnsDrawerProps) {
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);

  // Initialize selected columns
  useEffect(() => {
    if (!isOpen) return;

    // Find select_columns transformation
    const selectTransform = table.transformations?.find(
      (t) => t.type === 'select_columns' && t.enabled
    );

    if (selectTransform && selectTransform.params.columns) {
      setSelectedColumns(new Set(selectTransform.params.columns));
    } else {
      // Default: all columns selected
      setSelectedColumns(new Set(allColumns));
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
    setSelectedColumns(new Set(allColumns));
  };

  const handleDeselectAll = () => {
    setSelectedColumns(new Set());
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Get existing transformations
      const existingTransforms = table.transformations || [];
      
      // Remove old select_columns transformation
      const filteredTransforms = existingTransforms.filter(
        (t) => t.type !== 'select_columns'
      );

      // Add new select_columns transformation
      const newTransform: Transformation = {
        type: 'select_columns',
        enabled: true,
        params: {
          columns: Array.from(selectedColumns),
        },
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
              {selectedColumns.size} of {allColumns.length} columns selected
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

        {/* Column list */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            {allColumns.map((column) => (
              <label
                key={column}
                className="flex items-center gap-3 p-2 rounded hover:bg-gray-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedColumns.has(column)}
                  onChange={() => handleToggle(column)}
                  disabled={isSaving}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-900 font-mono">{column}</span>
              </label>
            ))}
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
