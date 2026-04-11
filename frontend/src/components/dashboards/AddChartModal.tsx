'use client';

import React, { useState, useMemo } from 'react';
import { X, Plus } from 'lucide-react';
import { useCharts } from '@/hooks/use-charts';
import { ChartParameter, DashboardChartLayout } from '@/types/api';

interface AddChartModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (chartId: number, layout: DashboardChartLayout, parameters?: Record<string, any>) => void;
  existingChartIds: number[];
  isAdding: boolean;
  currentPageName?: string;
}

const NUMERIC_COLUMN_TYPES = new Set(['number', 'integer', 'float', 'double', 'decimal', 'numeric', 'bigint', 'int']);
const DATE_COLUMN_TYPES = new Set(['date', 'datetime', 'timestamp', 'time']);

function resolveParameterInputKind(param: ChartParameter): 'number' | 'date' | 'date_range' | 'text' {
  const mappingType = (param.column_mapping?.type ?? '').toLowerCase();
  if ((param.parameter_type ?? '').toLowerCase() === 'time_range') return 'date_range';
  if (NUMERIC_COLUMN_TYPES.has(mappingType) || (param.parameter_type ?? '').toLowerCase() === 'measure') return 'number';
  if (DATE_COLUMN_TYPES.has(mappingType)) return 'date';
  return 'text';
}

function coerceParameterValue(rawValue: string, param: ChartParameter) {
  const value = rawValue.trim();
  if (!value) return '';

  if (resolveParameterInputKind(param) === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }

  return value;
}

export function AddChartModal({
  isOpen,
  onClose,
  onAdd,
  existingChartIds,
  isAdding,
  currentPageName,
}: AddChartModalProps) {
  const [selectedChartId, setSelectedChartId] = useState<number | ''>('');
  const [width, setWidth] = useState(4);
  const [height, setHeight] = useState(4);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const { data: charts, isLoading } = useCharts();

  const selectedChart = useMemo(
    () => charts?.find(c => c.id === selectedChartId) ?? null,
    [charts, selectedChartId]
  );
  const chartParams = selectedChart?.parameters ?? [];

  const handleChartChange = (id: number | '') => {
    setSelectedChartId(id);
    setParamValues({});
  };

  const handleAdd = () => {
    if (!selectedChartId) return;

    const layout: DashboardChartLayout = {
      x: 0,
      y: 0,
      w: width,
      h: height,
    };

    const parameters: Record<string, any> = {};
    for (const p of chartParams) {
      const val = paramValues[p.parameter_name];
      if (val !== undefined && val !== '') parameters[p.parameter_name] = coerceParameterValue(val, p);
      else if (p.default_value) parameters[p.parameter_name] = coerceParameterValue(p.default_value, p);
    }

    onAdd(Number(selectedChartId), layout, Object.keys(parameters).length > 0 ? parameters : undefined);
  };

  const handleClose = () => {
    setSelectedChartId('');
    setWidth(4);
    setHeight(4);
    setParamValues({});
    onClose();
  };

  if (!isOpen) return null;

  const availableCharts = charts?.filter(
    (chart) => !existingChartIds?.includes(chart.id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold">Add Chart to Dashboard</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={isAdding}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Chart *
            </label>
            <select
              value={selectedChartId}
              onChange={(e) => handleChartChange(e.target.value ? Number(e.target.value) : '')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isLoading || isAdding}
            >
              <option value="">Choose a chart...</option>
              {availableCharts?.map((chart) => (
                <option key={chart.id} value={chart.id}>
                  {chart.name}
                </option>
              ))}
            </select>
            {availableCharts?.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">
                All charts are already added to this page.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Width (columns)
              </label>
              <input
                type="number"
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                min={2}
                max={12}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isAdding}
              />
              <p className="text-xs text-gray-500 mt-1">2-12 columns</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Height (rows)
              </label>
              <input
                type="number"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                min={2}
                max={10}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isAdding}
              />
              <p className="text-xs text-gray-500 mt-1">2-10 rows</p>
            </div>
          </div>

          {chartParams.length > 0 && (
            <div className="border border-purple-200 rounded-lg overflow-hidden">
              <div className="bg-purple-50 px-4 py-2 border-b border-purple-100">
                <p className="text-xs font-medium text-purple-700">Parameter Values for this Instance</p>
                <p className="text-xs text-purple-500 mt-0.5">Leave blank to use defaults.</p>
              </div>
              <div className="p-4 space-y-3">
                {chartParams.map((p) => {
                  const inputKind = resolveParameterInputKind(p);
                  const inputType = inputKind === 'number'
                    ? 'number'
                    : inputKind === 'date'
                      ? 'date'
                      : 'text';
                  const placeholder = p.default_value
                    ?? (inputKind === 'date_range' ? 'YYYY-MM-DD..YYYY-MM-DD' : 'optional');

                  return (
                    <div key={p.parameter_name}>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        {p.parameter_name}
                        <span className="ml-1 text-gray-400 font-normal">({p.parameter_type})</span>
                        {p.description && <span className="ml-1 text-gray-400 font-normal">- {p.description}</span>}
                      </label>
                      <input
                        type={inputType}
                        value={paramValues[p.parameter_name] ?? ''}
                        onChange={e => setParamValues(prev => ({ ...prev, [p.parameter_name]: e.target.value }))}
                        placeholder={placeholder}
                        inputMode={inputKind === 'number' ? 'decimal' : undefined}
                        className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-400"
                        disabled={isAdding}
                      />
                      {inputKind === 'date_range' && (
                        <p className="mt-1 text-[11px] text-gray-500">
                          Use `start..end` or `start,end`.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
            <p className="text-sm text-blue-800">
              The chart will be placed at the top{currentPageName ? ` of ${currentPageName}` : ''}. You can drag and resize it after adding.
            </p>
          </div>
        </div>

        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200">
          <button
            onClick={handleClose}
            className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
            disabled={isAdding}
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!selectedChartId || isAdding}
            className="flex items-center px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="h-4 w-4 mr-2" />
            {isAdding ? 'Adding...' : 'Add Chart'}
          </button>
        </div>
      </div>
    </div>
  );
}
