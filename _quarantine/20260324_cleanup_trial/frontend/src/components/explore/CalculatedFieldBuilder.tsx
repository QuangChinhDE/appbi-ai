/**
 * Calculated Field Builder Component
 * Allows users to create ad-hoc calculated fields
 */
'use client';

import React, { useState } from 'react';
import { Plus, X, Calculator } from 'lucide-react';

interface CalculatedField {
  name: string;
  sql: string;
  type: 'string' | 'number' | 'date' | 'datetime';
}

interface CalculatedFieldBuilderProps {
  availableFields: string[];
  calculatedFields: CalculatedField[];
  onCalculatedFieldsChange: (fields: CalculatedField[]) => void;
}

export function CalculatedFieldBuilder({ 
  availableFields, 
  calculatedFields, 
  onCalculatedFieldsChange 
}: CalculatedFieldBuilderProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newField, setNewField] = useState<CalculatedField>({
    name: '',
    sql: '',
    type: 'number'
  });

  const handleAdd = () => {
    if (newField.name && newField.sql) {
      onCalculatedFieldsChange([...calculatedFields, newField]);
      setNewField({ name: '', sql: '', type: 'number' });
      setIsAdding(false);
    }
  };

  const handleRemove = (index: number) => {
    onCalculatedFieldsChange(calculatedFields.filter((_, i) => i !== index));
  };

  const insertFieldReference = (field: string) => {
    setNewField({
      ...newField,
      sql: newField.sql + `\${${field}}`
    });
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Calculator className="w-4 h-4" />
          Calculated Fields
        </h3>
        {!isAdding && (
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded"
          >
            <Plus className="w-3 h-3" />
            New
          </button>
        )}
      </div>

      {/* Existing calculated fields */}
      <div className="space-y-2 mb-3">
        {calculatedFields.map((field, index) => (
          <div key={index} className="flex items-center gap-2 p-2 bg-purple-50 rounded border border-purple-200">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-purple-900">{field.name}</div>
              <div className="text-xs text-purple-700 truncate">{field.sql}</div>
            </div>
            <button
              onClick={() => handleRemove(index)}
              className="p-1 text-purple-400 hover:text-red-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Add new calculated field form */}
      {isAdding && (
        <div className="border border-blue-200 rounded-lg p-3 bg-blue-50">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Field Name
              </label>
              <input
                type="text"
                value={newField.name}
                onChange={(e) => setNewField({ ...newField, name: e.target.value })}
                placeholder="e.g., revenue_per_order"
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Expression
              </label>
              <textarea
                value={newField.sql}
                onChange={(e) => setNewField({ ...newField, sql: e.target.value })}
                placeholder="e.g., ${orders.total_revenue} / NULLIF(${orders.count}, 0)"
                rows={3}
                className="w-full px-2 py-1 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {availableFields.slice(0, 6).map((field) => (
                  <button
                    key={field}
                    onClick={() => insertFieldReference(field)}
                    className="px-2 py-0.5 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50"
                  >
                    {field}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Type
              </label>
              <select
                value={newField.type}
                onChange={(e) => setNewField({ ...newField, type: e.target.value as any })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="number">Number</option>
                <option value="string">String</option>
                <option value="date">Date</option>
                <option value="datetime">DateTime</option>
              </select>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleAdd}
                className="flex-1 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
              >
                Add Field
              </button>
              <button
                onClick={() => {
                  setIsAdding(false);
                  setNewField({ name: '', sql: '', type: 'number' });
                }}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {!isAdding && calculatedFields.length === 0 && (
        <p className="text-xs text-gray-500 italic">No calculated fields defined</p>
      )}
    </div>
  );
}
