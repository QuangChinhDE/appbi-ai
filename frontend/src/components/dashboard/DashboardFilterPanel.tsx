'use client';

import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { X, Plus, ChevronDown, ChevronUp } from 'lucide-react';
import type { DashboardFilter, FilterType } from '@/lib/filters';
import { getFilterTypeForColumn, getDistinctValues, getDefaultOperator } from '@/lib/filters';
import type { Dataset, ColumnMetadata } from '@/types/api';

type DashboardFilterPanelProps = {
  datasets: Dataset[]; // datasets from charts on this dashboard
  filters: DashboardFilter[];
  onChange: (filters: DashboardFilter[]) => void;
  latestDataSamples?: Record<number, Record<string, any>[]>; // datasetId -> rows[]
};

export function DashboardFilterPanel({
  datasets,
  filters,
  onChange,
  latestDataSamples = {},
}: DashboardFilterPanelProps) {
  const [showAddFilter, setShowAddFilter] = useState(false);
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null);
  const [selectedField, setSelectedField] = useState<string>('');
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedFilters, setExpandedFilters] = useState<Set<string>>(new Set());
  const [draggingFilterId, setDraggingFilterId] = useState<string | null>(null);
  const [filterWidths, setFilterWidths] = useState<Record<string, number>>({});
  const [resizingFilterId, setResizingFilterId] = useState<string | null>(null);

  const selectedDataset = datasets.find(d => d.id === selectedDatasetId);

  // Handle filter width resize
  React.useEffect(() => {
    if (!resizingFilterId) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = document.getElementById(`filter-${resizingFilterId}`);
      if (container) {
        const rect = container.getBoundingClientRect();
        const newWidth = Math.max(200, e.clientX - rect.left);
        setFilterWidths(prev => ({ ...prev, [resizingFilterId]: newWidth }));
      }
    };

    const handleMouseUp = () => {
      setResizingFilterId(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingFilterId]);

  const toggleFilterExpand = (filterId: string) => {
    setExpandedFilters(prev => {
      const newSet = new Set(prev);
      if (newSet.has(filterId)) {
        newSet.delete(filterId);
      } else {
        newSet.add(filterId);
      }
      return newSet;
    });
  };

  const handleDragStart = (e: React.DragEvent, filterId: string) => {
    setDraggingFilterId(filterId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetFilterId: string) => {
    e.preventDefault();
    if (!draggingFilterId || draggingFilterId === targetFilterId) return;

    const currentIndex = filters.findIndex(f => f.id === draggingFilterId);
    const targetIndex = filters.findIndex(f => f.id === targetFilterId);

    if (currentIndex === -1 || targetIndex === -1) return;

    const newFilters = [...filters];
    const [removed] = newFilters.splice(currentIndex, 1);
    newFilters.splice(targetIndex, 0, removed);

    onChange(newFilters);
    setDraggingFilterId(null);
  };

  const handleAddFilter = () => {
    if (!selectedDatasetId || !selectedField || !selectedDataset) return;

    const columns = selectedDataset.columns || [];
    const column = columns.find(c => c.name === selectedField);
    if (!column) return;

    const filterType = getFilterTypeForColumn(column.type);
    const operator = getDefaultOperator(filterType);
    
    let defaultValue: any;
    if (filterType === 'date') {
      defaultValue = ['', '']; // [start, end]
    } else if (filterType === 'dropdown') {
      defaultValue = []; // array of selected values
    } else {
      defaultValue = '';
    }

    const newFilter: DashboardFilter = {
      id: uuidv4(),
      datasetId: selectedDatasetId,
      field: selectedField,
      type: filterType,
      operator,
      value: defaultValue,
      label: `${selectedDataset.name}.${selectedField}`,
    };

    onChange([...filters, newFilter]);
    setShowAddFilter(false);
    setSelectedDatasetId(null);
    setSelectedField('');
  };

  const handleRemoveFilter = (filterId: string) => {
    onChange(filters.filter(f => f.id !== filterId));
  };

  const handleUpdateFilter = (filterId: string, updates: Partial<DashboardFilter>) => {
    onChange(filters.map(f => f.id === filterId ? { ...f, ...updates } : f));
  };

  const renderDateFilter = (filter: DashboardFilter) => {
    const [start, end] = filter.value ?? ['', ''];
    
    return (
      <div className="flex gap-2 items-center">
        <input
          type="date"
          value={start}
          onChange={(e) => handleUpdateFilter(filter.id, { value: [e.target.value, end] })}
          className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Start date"
        />
        <span className="text-gray-500">to</span>
        <input
          type="date"
          value={end}
          onChange={(e) => handleUpdateFilter(filter.id, { value: [start, e.target.value] })}
          className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="End date"
        />
      </div>
    );
  };

  const renderDropdownFilter = (filter: DashboardFilter) => {
    const dataSample = latestDataSamples[filter.datasetId] || [];
    const distinctValues = dataSample.length > 0 
      ? getDistinctValues(filter.field, dataSample)
      : [];
    
    const selected: string[] = filter.value ?? [];

    // If no data available, show text input instead
    if (distinctValues.length === 0) {
      return (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            value={selected.join(', ')}
            onChange={(e) => {
              const values = e.target.value.split(',').map(v => v.trim()).filter(v => v);
              handleUpdateFilter(filter.id, { value: values });
            }}
            placeholder="Enter values separated by commas"
            className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="text-xs text-gray-500">
            Separate multiple values with commas. Data will be fetched when charts load.
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-1">
        <div className="border border-gray-300 rounded max-h-[200px] overflow-y-auto">
          {distinctValues.map(val => (
            <label 
              key={val} 
              className="flex items-center gap-2 px-2 py-1 hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(val)}
                onChange={(e) => {
                  const newSelected = e.target.checked
                    ? [...selected, val]
                    : selected.filter(v => v !== val);
                  handleUpdateFilter(filter.id, { value: newSelected });
                }}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm">{val}</span>
            </label>
          ))}
        </div>
        <div className="text-xs text-gray-500">
          {selected.length > 0 ? `${selected.length} selected` : 'Click to select values'}
        </div>
      </div>
    );
  };

  const renderNumberFilter = (filter: DashboardFilter) => {
    return (
      <div className="flex gap-2 items-center">
        <select
          value={filter.operator}
          onChange={(e) => handleUpdateFilter(filter.id, { operator: e.target.value as any })}
          className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="eq">=</option>
          <option value="neq">≠</option>
          <option value="gt">&gt;</option>
          <option value="gte">≥</option>
          <option value="lt">&lt;</option>
          <option value="lte">≤</option>
        </select>
        <input
          type="number"
          value={filter.value ?? ''}
          onChange={(e) => handleUpdateFilter(filter.id, { value: e.target.value })}
          className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Value"
        />
      </div>
    );
  };

  const renderTextFilter = (filter: DashboardFilter) => {
    return (
      <div className="flex gap-2 items-center">
        <select
          value={filter.operator}
          onChange={(e) => handleUpdateFilter(filter.id, { operator: e.target.value as any })}
          className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="contains">Contains</option>
          <option value="eq">Equals</option>
          <option value="starts_with">Starts with</option>
          <option value="neq">Not equals</option>
        </select>
        <input
          type="text"
          value={filter.value ?? ''}
          onChange={(e) => handleUpdateFilter(filter.id, { value: e.target.value })}
          className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Value"
        />
      </div>
    );
  };

  const renderFilterValue = (filter: DashboardFilter) => {
    switch (filter.type) {
      case 'date':
        return renderDateFilter(filter);
      case 'dropdown':
        return renderDropdownFilter(filter);
      case 'number':
        return renderNumberFilter(filter);
      case 'text':
        return renderTextFilter(filter);
      default:
        return null;
    }
  };

  const getDatasetName = (datasetId: number) => {
    return datasets.find(d => d.id === datasetId)?.name || `Dataset ${datasetId}`;
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg mb-4">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-gray-900"
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span>Dashboard Filters {filters.length > 0 && `(${filters.length})`}</span>
          </button>
          {isExpanded && (
            <button
              onClick={() => setShowAddFilter(!showAddFilter)}
              className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
            >
              <Plus className="w-4 h-4" />
              Add Filter
            </button>
          )}
        </div>

        {isExpanded && (
          <div className="pr-2">
          {/* Existing Filters */}
          {filters.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-3">
          {filters.map(filter => {
            const isFilterExpanded = expandedFilters.has(filter.id);
            const filterWidth = filterWidths[filter.id] || 300; // default 300px
            return (
            <div 
              key={filter.id}
              id={`filter-${filter.id}`}
              draggable
              onDragStart={(e) => handleDragStart(e, filter.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, filter.id)}
              style={{ width: `${filterWidth}px` }}
              className={`bg-gray-50 rounded border border-gray-200 relative ${draggingFilterId === filter.id ? 'opacity-50' : ''}`}
            >
              <div className="p-2">
                <div className="flex items-center justify-between mb-2">
                  <button
                    onClick={() => toggleFilterExpand(filter.id)}
                    className="flex items-center gap-2 text-xs text-gray-700 hover:text-gray-900 flex-1 cursor-pointer"
                  >
                    {isFilterExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    <span>
                      {getDatasetName(filter.datasetId)} → {filter.field}
                      <span className="ml-1 px-1 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">
                        {filter.type}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => handleRemoveFilter(filter.id)}
                    className="text-gray-400 hover:text-red-600"
                    title="Remove filter"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {isFilterExpanded && (
                  <div className="mt-2">
                    {renderFilterValue(filter)}
                  </div>
                )}
              </div>
              {/* Resize handle */}
              <div
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setResizingFilterId(filter.id);
                }}
                className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-blue-400 bg-gray-300 flex items-center justify-center group"
                title="Drag to resize width"
              >
                <div className="h-8 w-0.5 bg-gray-500 rounded group-hover:bg-blue-600"></div>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Add Filter Form */}
      {showAddFilter && (
        <div className="p-3 bg-blue-50 rounded border border-blue-200">
          <div className="space-y-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Dataset
              </label>
              <select
                value={selectedDatasetId || ''}
                onChange={(e) => {
                  setSelectedDatasetId(e.target.value ? Number(e.target.value) : null);
                  setSelectedField('');
                }}
                className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Choose dataset...</option>
                {datasets.map(ds => (
                  <option key={ds.id} value={ds.id}>
                    {ds.name}
                  </option>
                ))}
              </select>
            </div>

            {selectedDataset && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Field
                </label>
                {(!selectedDataset.columns || selectedDataset.columns.length === 0) ? (
                  <div className="text-sm text-gray-500 italic p-2 bg-yellow-50 rounded border border-yellow-200">
                    No columns found. Dataset may need to be refreshed or queried first.
                  </div>
                ) : (
                  <select
                    value={selectedField}
                    onChange={(e) => setSelectedField(e.target.value)}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Choose field...</option>
                    {selectedDataset.columns.map(col => (
                      <option key={col.name} value={col.name}>
                        {col.name} ({col.type})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleAddFilter}
                disabled={!selectedDatasetId || !selectedField}
                className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Add
              </button>
              <button
                onClick={() => {
                  setShowAddFilter(false);
                  setSelectedDatasetId(null);
                  setSelectedField('');
                }}
                className="px-3 py-1 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {filters.length === 0 && !showAddFilter && (
        <div className="text-sm text-gray-500 text-center py-2">
          No filters applied. Click "Add Filter" to get started.
        </div>
      )}
          </div>
        )}
      </div>
    </div>
  );
}
