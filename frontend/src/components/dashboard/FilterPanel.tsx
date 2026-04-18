/**
 * Dashboard Filter Panel Component
 * Looker-style collapsible filter panel for dashboards
 */
'use client';

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Plus, X, Edit2, Check } from 'lucide-react';

export interface DashboardFilter {
  id?: number;
  name: string;
  field: string;
  type: 'string' | 'number' | 'date' | 'datetime';
  operator: 'eq' | 'ne' | 'in' | 'not_in' | 'contains' | 'starts_with' | 'ends_with' | 'gte' | 'lte' | 'between';
  value: any;
}

interface FilterPanelProps {
  dashboardId: number;
  filters: DashboardFilter[];
  onFiltersChange: (filters: DashboardFilter[]) => void;
  onAddFilter: () => void;
  onEditFilter: (filter: DashboardFilter) => void;
  onDeleteFilter: (filterId: number) => void;
}

export function FilterPanel({
  dashboardId,
  filters,
  onFiltersChange,
  onAddFilter,
  onEditFilter,
  onDeleteFilter
}: FilterPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  const handleValueChange = (filter: DashboardFilter, newValue: any) => {
    onEditFilter({ ...filter, value: newValue });
  };

  const renderFilterValue = (filter: DashboardFilter) => {
    if (editingId === filter.id) {
      return (
        <div className="flex items-center gap-2">
          {filter.type === 'string' && (
            <input
              type="text"
              value={filter.value || ''}
              onChange={(e) => handleValueChange(filter, e.target.value)}
              className="flex-1 px-2 py-1 text-sm border border-[rgb(var(--border-strong))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="Enter value..."
            />
          )}
          {filter.type === 'number' && (
            <input
              type="number"
              value={filter.value || ''}
              onChange={(e) => handleValueChange(filter, parseFloat(e.target.value))}
              className="flex-1 px-2 py-1 text-sm border border-[rgb(var(--border-strong))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="Enter number..."
            />
          )}
          {filter.type === 'date' && (
            <input
              type="date"
              value={filter.value || ''}
              onChange={(e) => handleValueChange(filter, e.target.value)}
              className="flex-1 px-2 py-1 text-sm border border-[rgb(var(--border-strong))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
            />
          )}
          <button
            onClick={() => setEditingId(null)}
            className="p-1 text-success hover:bg-success/10 rounded"
          >
            <Check className="w-4 h-4" />
          </button>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-between flex-1">
        <span className="text-sm text-text-secondary">
          {Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value || 'Not set')}
        </span>
        <button
          onClick={() => setEditingId(filter.id || null)}
          className="p-1 text-text-quaternary hover:text-brand"
        >
          <Edit2 className="w-3 h-3" />
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full w-80 flex-col border-l border-[rgb(var(--border-line))] bg-surface-1">
      {/* Header */}
      <div 
        className="flex items-center justify-between p-4 border-b border-[rgb(var(--border-line))] cursor-pointer hover:bg-surface-2"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-text-tertiary" />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-tertiary" />
          )}
          <h3 className="text-sm font-semibold text-text-primary">
            Filters {filters.length > 0 && `(${filters.length})`}
          </h3>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAddFilter();
          }}
          className="p-1 text-brand hover:bg-brand/15 rounded"
          title="Add filter"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Filter List */}
      {isExpanded && (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {filters.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-text-tertiary mb-3">No filters applied</p>
              <button
                onClick={onAddFilter}
                className="px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand/15 rounded border border-brand/30"
              >
                Add First Filter
              </button>
            </div>
          ) : (
            filters.map((filter) => (
              <div
                key={filter.id}
                className="border border-[rgb(var(--border-line))] rounded-lg p-3 bg-surface-2 hover:bg-surface-2 transition-colors"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">
                      {filter.name}
                    </div>
                    <div className="text-xs text-text-tertiary truncate">
                      {filter.field}
                    </div>
                  </div>
                  <button
                    onClick={() => filter.id && onDeleteFilter(filter.id)}
                    className="p-1 text-text-quaternary hover:text-danger ml-2"
                    title="Delete filter"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary w-16">Operator:</span>
                    <select
                      value={filter.operator}
                      onChange={(e) => onEditFilter({ 
                        ...filter, 
                        operator: e.target.value as any 
                      })}
                      className="flex-1 px-2 py-1 text-xs border border-[rgb(var(--border-strong))] rounded focus:outline-none focus:ring-1 focus:ring-brand"
                    >
                      <option value="eq">Equals</option>
                      <option value="ne">Not Equals</option>
                      <option value="in">In List</option>
                      <option value="not_in">Not In List</option>
                      <option value="contains">Contains</option>
                      <option value="starts_with">Starts With</option>
                      <option value="ends_with">Ends With</option>
                      <option value="gte">Greater Than or Equal</option>
                      <option value="lte">Less Than or Equal</option>
                      <option value="between">Between</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary w-16">Value:</span>
                    {renderFilterValue(filter)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Reset All Button */}
      {isExpanded && filters.length > 0 && (
        <div className="p-4 border-t border-[rgb(var(--border-line))]">
          <button
            onClick={() => onFiltersChange([])}
            className="w-full px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 rounded border border-danger/30"
          >
            Clear All Filters
          </button>
        </div>
      )}
    </div>
  );
}
