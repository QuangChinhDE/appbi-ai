/**
 * AddColumnModal - Add computed/formula columns
 */
'use client';

import React, { useState } from 'react';
import { X, Loader2, AlertCircle, Info } from 'lucide-react';
import type { WorkspaceTable, Transformation } from '@/hooks/use-dataset-workspaces';

interface AddColumnModalProps {
  table: WorkspaceTable;
  isOpen: boolean;
  onClose: () => void;
  onSave: (transformations: Transformation[]) => Promise<void>;
}

export function AddColumnModal({ table, isOpen, onClose, onSave }: AddColumnModalProps) {
  const [columnName, setColumnName] = useState('');
  const [formula, setFormula] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const validateFormula = (expr: string): string | null => {
    const trimmed = expr.trim();
    
    if (!trimmed) {
      return 'Formula cannot be empty';
    }
    
    // Check for dangerous keywords
    const dangerous = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'UNION', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE'];
    const upperExpr = trimmed.toUpperCase();
    for (const keyword of dangerous) {
      const pattern = new RegExp(`\\b${keyword}\\b`);
      if (pattern.test(upperExpr)) {
        return `Dangerous keyword not allowed: ${keyword}`;
      }
    }
    
    // Check for semicolons
    if (trimmed.includes(';')) {
      return 'Semicolons not allowed';
    }
    
    // Check parentheses matching
    if ((trimmed.match(/\(/g) || []).length !== (trimmed.match(/\)/g) || []).length) {
      return 'Unmatched parentheses';
    }
    
    return null;
  };

  const handleFormulaChange = (value: string) => {
    setFormula(value);
    if (validationError) {
      setValidationError(null);
    }
  };

  const handleSave = async () => {
    // Validate
    if (!columnName.trim()) {
      setValidationError('Column name is required');
      return;
    }
    
    const error = validateFormula(formula);
    if (error) {
      setValidationError(error);
      return;
    }

    setIsSaving(true);
    try {
      // Get existing transformations
      const existingTransforms = table.transformations || [];

      // Add new add_column transformation
      const newTransform: Transformation = {
        id: crypto.randomUUID(),
        type: 'add_column',
        enabled: true,
        params: {
          newField: columnName.trim(),
          expression: formula.trim(),
        },
      };

      const updatedTransforms = [...existingTransforms, newTransform];

      await onSave(updatedTransforms);
      
      // Reset form
      setColumnName('');
      setFormula('');
      setValidationError(null);
      onClose();
    } catch (error) {
      console.error('Failed to add column:', error);
      setValidationError('Failed to add column. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    setColumnName('');
    setFormula('');
    setValidationError(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Add Column</h2>
            <p className="text-sm text-gray-500 mt-1">
              Create a computed column using a formula
            </p>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={isSaving}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Column name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Column Name *
            </label>
            <input
              type="text"
              value={columnName}
              onChange={(e) => setColumnName(e.target.value)}
              placeholder="e.g., TOTAL_VALUE"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isSaving}
            />
          </div>

          {/* Formula */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Formula *
            </label>
            <textarea
              value={formula}
              onChange={(e) => handleFormulaChange(e.target.value)}
              placeholder={`Examples:\n  SO_KG * DON_GIA\n  IF(SO_KG > 1, SO_KG * DON_GIA, DON_GIA)\n  ROUND(SO_KG * DON_GIA, 2)`}
              className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 font-mono text-sm h-32 resize-y ${
                validationError
                  ? 'border-red-300 focus:ring-red-500'
                  : 'border-gray-300 focus:ring-blue-500'
              }`}
              disabled={isSaving}
            />
            
            {validationError && (
              <div className="mt-2 flex items-start gap-2 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{validationError}</span>
              </div>
            )}
          </div>

          {/* Help text */}
          <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-2">Supported operations:</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>Math: <code>+</code>, <code>-</code>, <code>*</code>, <code>/</code></li>
                  <li>Functions: <code>IF(condition, true_val, false_val)</code>, <code>ROUND(x, n)</code>, <code>COALESCE(a, b)</code></li>
                  <li>Comparisons: <code>=</code>, <code>!=</code>, <code>&gt;</code>, <code>&gt;=</code>, <code>&lt;</code>, <code>&lt;=</code></li>
                  <li>Field references: Use column names directly</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50">
          <button
            onClick={handleClose}
            disabled={isSaving}
            className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !columnName.trim() || !formula.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            Add Column
          </button>
        </div>
      </div>
    </div>
  );
}
