'use client';

import React, { useState } from 'react';
import { Database, Hash, Calendar, Check, AlertCircle, ChevronDown } from 'lucide-react';
import { Dataset, ColumnMetadata, DimensionConfig, MeasureConfig } from '@/types/api';

interface FieldListProps {
  dataset: Dataset | undefined;
  selectedDimensions: string[];
  selectedMeasures: string[];
  onToggleDimension: (field: string) => void;
  onToggleMeasure: (field: string, aggregation?: string) => void;
  dimensionConfigs?: DimensionConfig[];
  measureConfigs?: MeasureConfig[];
  onUpdateDimensionLabel?: (field: string, label: string) => void;
  onUpdateMeasureLabel?: (field: string, agg: string, label: string) => void;
  onUpdateMeasureAgg?: (field: string, agg: string) => void;
}

export function FieldList({
  dataset,
  selectedDimensions,
  selectedMeasures,
  onToggleDimension,
  onToggleMeasure,
  dimensionConfigs = [],
  measureConfigs = [],
  onUpdateDimensionLabel,
  onUpdateMeasureLabel,
  onUpdateMeasureAgg,
}: FieldListProps) {
  const [openMeasureMenu, setOpenMeasureMenu] = useState<string | null>(null);

  const aggregations = [
    { id: 'sum', label: 'Sum', prefix: 'SUM' },
    { id: 'avg', label: 'Average', prefix: 'AVG' },
    { id: 'count', label: 'Count', prefix: 'CT' },
    { id: 'count_distinct', label: 'Count Distinct', prefix: 'CTD' },
    { id: 'min', label: 'Min', prefix: 'MIN' },
    { id: 'max', label: 'Max', prefix: 'MAX' },
    { id: 'median', label: 'Median', prefix: 'MED' },
    { id: 'stddev', label: 'Standard Deviation', prefix: 'STD' },
    { id: 'variance', label: 'Variance', prefix: 'VAR' },
  ];

  // If dataset has no columns, show a helpful message
  if (!dataset?.columns || dataset.columns.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm ring-1 ring-gray-200 p-4">
        <div className="flex items-start space-x-3">
          <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-gray-900">No column metadata</p>
            <p className="text-xs text-gray-500 mt-1">
              This dataset has no column metadata yet. Go to{' '}
              <span className="font-semibold">Datasets → Edit "{dataset?.name}"</span> →{' '}
              <span className="font-semibold">Run Preview</span> to infer columns.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Numeric types that should be classified as measures
  const numericTypes = [
    'number', 'integer', 'float', 'double', 'numeric', 
    'FLOAT', 'INTEGER', 'NUMERIC', 'DOUBLE', 'BIGINT', 
    'int', 'INT', 'DECIMAL', 'decimal'
  ];

  // Classify columns as dimensions or measures based on type
  const dimensions = dataset.columns.filter(
    col => !numericTypes.includes(col.type)
  );
  
  const measures = dataset.columns.filter(
    col => numericTypes.includes(col.type)
  );

  return (
    <div className="bg-white rounded-lg shadow-sm ring-1 ring-gray-200">
      {/* Dimensions */}
      <div className="p-4 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center">
          <Database className="h-4 w-4 mr-2 text-gray-500" />
          Dimensions ({dimensions.length})
        </h3>
        <div className="space-y-1">
          {dimensions.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No dimension fields</p>
          ) : (
            dimensions.map(col => {
              const isSelected = selectedDimensions.includes(col.name);
              const dimConfig = dimensionConfigs.find(d => d.field === col.name);
              
              return (
                <div key={col.name} className="space-y-1">
                  <button
                    onClick={() => onToggleDimension(col.name)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between ${
                      isSelected
                        ? 'bg-blue-50 text-blue-700 font-medium'
                        : 'hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <span className="flex items-center flex-1">
                      <Calendar className="h-3.5 w-3.5 mr-2 text-gray-400" />
                      <span className="flex-1">{col.name}</span>
                      <span className="text-xs text-gray-400 ml-2">{col.type}</span>
                    </span>
                    {isSelected && (
                      <Check className="h-4 w-4 text-blue-600 ml-2" />
                    )}
                  </button>
                  
                  {isSelected && onUpdateDimensionLabel && (
                    <div className="pl-8 pr-3">
                      <input
                        type="text"
                        placeholder="Display name (optional)"
                        value={dimConfig?.label || ''}
                        onChange={(e) => onUpdateDimensionLabel(col.name, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      {dimConfig?.label && (
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          Field: {col.name}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Measures */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center">
          <Hash className="h-4 w-4 mr-2 text-gray-500" />
          Measures ({measures.length})
        </h3>
        <div className="space-y-1">
          {measures.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No numeric fields found</p>
          ) : (
            measures.map(col => {
              const selectedMeasure = selectedMeasures.find(m => m.startsWith(`${col.name}_`));
              const isSelected = !!selectedMeasure;
              const isMenuOpen = openMeasureMenu === col.name;
              
              // Extract aggregation from selected measure
              let currentAgg = '';
              let aggLabel = '';
              if (selectedMeasure) {
                const parts = selectedMeasure.split('_');
                currentAgg = parts[parts.length - 1];
                const agg = aggregations.find(a => a.id === currentAgg);
                aggLabel = agg?.prefix || '';
              }
              
              const measureConfig = measureConfigs?.find(mc => 
                mc.field === col.name && mc.agg === currentAgg
              );
              
              return (
                <div key={col.name} className="space-y-1">
                  <div className="relative">
                    <button
                      onClick={() => setOpenMeasureMenu(isMenuOpen ? null : col.name)}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between ${
                        isSelected
                          ? 'bg-green-50 text-green-700 font-medium'
                          : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      <span className="flex items-center flex-1 min-w-0">
                        <Hash className="h-3.5 w-3.5 mr-2 text-gray-400 flex-shrink-0" />
                        <span className="flex-1 truncate">{col.name}</span>
                        <span className="text-xs text-gray-400 ml-2 flex-shrink-0">{col.type}</span>
                      </span>
                      <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                        {isSelected && aggLabel && (
                          <span className="text-xs font-mono bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                            {aggLabel}
                          </span>
                        )}
                        {isSelected && (
                          <Check className="h-4 w-4 text-green-600" />
                        )}
                        <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${isMenuOpen ? 'rotate-180' : ''}`} />
                      </div>
                    </button>

                    {/* Aggregation Menu */}
                    {isMenuOpen && (
                      <div className="absolute left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-10 py-1">
                        {aggregations.map(agg => (
                          <button
                            key={agg.id}
                            onClick={() => {
                              onToggleMeasure(col.name, agg.id);
                              if (onUpdateMeasureAgg && isSelected) {
                                onUpdateMeasureAgg(col.name, agg.id);
                              }
                              setOpenMeasureMenu(null);
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center"
                          >
                            <span className="text-xs font-mono text-gray-400 mr-2 w-8">{agg.prefix}</span>
                            <span>{agg.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  {/* Label Input */}
                  {isSelected && onUpdateMeasureLabel && currentAgg && (
                    <div className="pl-8 pr-3">
                      <input
                        type="text"
                        placeholder="Display name (optional)"
                        value={measureConfig?.label || ''}
                        onChange={(e) => onUpdateMeasureLabel(col.name, currentAgg, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                      {measureConfig?.label && (
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          Field: {col.name} ({currentAgg.toUpperCase()})
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
