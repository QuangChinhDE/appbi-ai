/**
 * Add Filter Dialog Component
 * Modal for creating new dashboard filters
 */
'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { DashboardFilter } from './FilterPanel';

interface AddFilterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (filter: Omit<DashboardFilter, 'id'>) => void;
  availableFields?: string[];
}

const OPERATORS = [
  { value: 'eq', label: 'Equals', types: ['string', 'number', 'date'] },
  { value: 'ne', label: 'Not Equals', types: ['string', 'number', 'date'] },
  { value: 'in', label: 'In List', types: ['string', 'number'] },
  { value: 'not_in', label: 'Not In List', types: ['string', 'number'] },
  { value: 'contains', label: 'Contains', types: ['string'] },
  { value: 'starts_with', label: 'Starts With', types: ['string'] },
  { value: 'ends_with', label: 'Ends With', types: ['string'] },
  { value: 'gte', label: 'Greater Than or Equal', types: ['number', 'date'] },
  { value: 'lte', label: 'Less Than or Equal', types: ['number', 'date'] },
  { value: 'between', label: 'Between', types: ['number', 'date'] },
];

export function AddFilterDialog({ isOpen, onClose, onSave, availableFields = [] }: AddFilterDialogProps) {
  const [formData, setFormData] = useState<Omit<DashboardFilter, 'id'>>({
    name: '',
    field: '',
    type: 'string',
    operator: 'eq',
    value: ''
  });

  const handleSave = () => {
    if (!formData.name || !formData.field) {
      alert('Please fill in name and field');
      return;
    }

    onSave(formData);
    onClose();
    
    // Reset form
    setFormData({
      name: '',
      field: '',
      type: 'string',
      operator: 'eq',
      value: ''
    });
  };

  const handleFieldChange = (field: string) => {
    // Auto-detect type from field name
    let type: 'string' | 'number' | 'date' | 'datetime' = 'string';
    
    if (field.includes('date') || field.includes('time')) {
      type = 'date';
    } else if (field.includes('count') || field.includes('amount') || field.includes('price')) {
      type = 'number';
    }

    setFormData({ ...formData, field, type });
  };

  const availableOperators = OPERATORS.filter(op => 
    op.types.includes(formData.type)
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Dashboard Filter">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Filter Name
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g., Country Filter"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Field
          </label>
          {availableFields.length > 0 ? (
            <select
              value={formData.field}
              onChange={(e) => handleFieldChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select a field...</option>
              {availableFields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={formData.field}
              onChange={(e) => handleFieldChange(e.target.value)}
              placeholder="e.g., customers.country"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          <p className="text-xs text-gray-500 mt-1">
            Qualified field name (e.g., view.field)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Type
          </label>
          <select
            value={formData.type}
            onChange={(e) => setFormData({ 
              ...formData, 
              type: e.target.value as any,
              operator: 'eq' 
            })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="string">String</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="datetime">DateTime</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Operator
          </label>
          <select
            value={formData.operator}
            onChange={(e) => setFormData({ ...formData, operator: e.target.value as any })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {availableOperators.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Value
          </label>
          {formData.type === 'string' && (
            <input
              type="text"
              value={formData.value}
              onChange={(e) => setFormData({ ...formData, value: e.target.value })}
              placeholder="Enter value..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          {formData.type === 'number' && (
            <input
              type="number"
              value={formData.value}
              onChange={(e) => setFormData({ ...formData, value: parseFloat(e.target.value) })}
              placeholder="Enter number..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          {(formData.type === 'date' || formData.type === 'datetime') && (
            <input
              type="date"
              value={formData.value}
              onChange={(e) => setFormData({ ...formData, value: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>

        <div className="flex gap-3 pt-4">
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
          >
            Add Filter
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 font-medium"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
