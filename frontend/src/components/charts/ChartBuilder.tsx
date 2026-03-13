'use client';

import React, { useState, useEffect } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ChartType, ChartCreate, ChartUpdate, ColumnMetadata } from '@/types/api';
import { useDatasets } from '@/hooks/use-datasets';
import { datasetApi } from '@/lib/api/datasets';
import { ChartPreview } from './ChartPreview';

interface ChartBuilderProps {
  initialData?: {
    id: number;
    name: string;
    description?: string;
    dataset_id?: number | null;
    chart_type: ChartType;
    config: Record<string, any>;
  };
  onSave: (data: ChartCreate | ChartUpdate) => void | Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}

export function ChartBuilder({ initialData, onSave, onCancel, isSaving }: ChartBuilderProps) {
  const isEditMode = !!initialData;
  
  // Form state
  const [name, setName] = useState(initialData?.name || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [datasetId, setDatasetId] = useState<number | ''>(initialData?.dataset_id ?? '');
  const [chartType, setChartType] = useState<ChartType>(initialData?.chart_type || ChartType.BAR);
  
  // Config state
  const [xField, setXField] = useState<string>(initialData?.config.xField || '');
  const [yFields, setYFields] = useState<string[]>(initialData?.config.yFields || []);
  const [labelField, setLabelField] = useState<string>(initialData?.config.labelField || '');
  const [valueField, setValueField] = useState<string>(initialData?.config.valueField || '');
  const [timeField, setTimeField] = useState<string>(initialData?.config.timeField || '');
  
  // Preview state
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [columns, setColumns] = useState<ColumnMetadata[]>([]);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLimit, setPreviewLimit] = useState(100);

  const { data: datasets } = useDatasets();

  // Load dataset preview when dataset is selected
  useEffect(() => {
    if (datasetId) {
      loadDatasetPreview();
    } else {
      setPreviewData([]);
      setColumns([]);
    }
  }, [datasetId]);

  const loadDatasetPreview = async () => {
    if (!datasetId) return;
    
    setIsLoadingPreview(true);
    setPreviewError(null);
    
    try {
      const limit = previewLimit > 0 ? previewLimit : 100;
      const result = await datasetApi.execute(Number(datasetId), limit);
      setPreviewData(result.data);
      
      // Extract columns from data
      if (result.data.length > 0) {
        const cols: ColumnMetadata[] = Object.keys(result.data[0]).map(key => ({
          name: key,
          type: typeof result.data[0][key],
        }));
        setColumns(cols);
      }
    } catch (error: any) {
      setPreviewError(error.response?.data?.detail || error.message);
      setPreviewData([]);
      setColumns([]);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!datasetId) return;

    const config: Record<string, any> = {};
    
    if (chartType === ChartType.BAR || chartType === ChartType.LINE) {
      config.xField = xField;
      config.yFields = yFields;
    } else if (chartType === ChartType.PIE) {
      config.labelField = labelField;
      config.valueField = valueField;
    } else if (chartType === ChartType.TIME_SERIES) {
      config.timeField = timeField;
      config.valueField = valueField;
    }

    const payload = {
      name,
      description: description || undefined,
      dataset_id: Number(datasetId),
      chart_type: chartType,
      config,
    };

    onSave(payload);
  };

  const getNumericColumns = () => {
    return columns.filter(col => col.type === 'number');
  };

  const getStringColumns = () => {
    return columns.filter(col => col.type === 'string');
  };

  const getDateColumns = () => {
    return columns.filter(col => 
      col.type === 'string' && (
        col.name.toLowerCase().includes('date') ||
        col.name.toLowerCase().includes('time')
      )
    );
  };

  const toggleYField = (field: string) => {
    if (yFields.includes(field)) {
      setYFields(yFields.filter(f => f !== field));
    } else {
      setYFields([...yFields, field]);
    }
  };

  const canShowPreview = () => {
    if (!previewData.length) return false;
    
    if (chartType === ChartType.BAR || chartType === ChartType.LINE) {
      return xField && yFields.length > 0;
    } else if (chartType === ChartType.PIE) {
      return labelField && valueField;
    } else if (chartType === ChartType.TIME_SERIES) {
      return timeField && valueField;
    }
    
    return false;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center space-x-4">
        <button
          onClick={onCancel}
          className="text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-2xl font-bold">
          {isEditMode ? 'Edit Chart' : 'Create Chart'}
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="bg-white p-6 rounded-lg border border-gray-200 space-y-4">
          <h3 className="text-lg font-semibold">Basic Information</h3>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Chart Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              rows={3}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Dataset *
            </label>
            <select
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : '')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              required
              disabled={isEditMode}
            >
              <option value="">Select a dataset</option>
              {datasets?.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.name}
                </option>
              ))}
            </select>
            {isEditMode && (
              <p className="text-xs text-gray-500 mt-1">
                Dataset cannot be changed in edit mode
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Preview Limit
            </label>
            <input
              type="number"
              value={previewLimit}
              onChange={(e) => setPreviewLimit(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              min={1}
              max={1000}
            />
            <p className="text-xs text-gray-500 mt-1">
              Number of rows to load for preview and charting (1-1000)
            </p>
          </div>
        </div>

        {/* Chart Type Selection */}
        <div className="bg-white p-6 rounded-lg border border-gray-200 space-y-4">
          <h3 className="text-lg font-semibold">Chart Type</h3>
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.values(ChartType).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setChartType(type)}
                className={`p-4 border-2 rounded-lg text-center transition-colors ${
                  chartType === type
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-medium capitalize">
                  {type.replace('_', ' ')}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Field Configuration */}
        {datasetId && (
          <div className="bg-white p-6 rounded-lg border border-gray-200 space-y-4">
            <h3 className="text-lg font-semibold">Field Configuration</h3>

            {isLoadingPreview && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
                <span className="ml-2">Loading dataset preview...</span>
              </div>
            )}

            {previewError && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-md">
                <p className="text-red-800">{previewError}</p>
              </div>
            )}

            {!isLoadingPreview && columns.length > 0 && (
              <>
                {/* Bar and Line charts */}
                {(chartType === ChartType.BAR || chartType === ChartType.LINE) && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        X-Axis Field *
                      </label>
                      <select
                        value={xField}
                        onChange={(e) => setXField(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        required
                      >
                        <option value="">Select field</option>
                        {columns.map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.name} ({col.type})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Y-Axis Fields * (select one or more)
                      </label>
                      <div className="space-y-2">
                        {getNumericColumns().map((col) => (
                          <label key={col.name} className="flex items-center space-x-2">
                            <input
                              type="checkbox"
                              checked={yFields.includes(col.name)}
                              onChange={() => toggleYField(col.name)}
                              className="rounded border-gray-300"
                            />
                            <span>{col.name}</span>
                          </label>
                        ))}
                      </div>
                      {getNumericColumns().length === 0 && (
                        <p className="text-sm text-gray-500">No numeric columns found</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Pie chart */}
                {chartType === ChartType.PIE && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Label Field *
                      </label>
                      <select
                        value={labelField}
                        onChange={(e) => setLabelField(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        required
                      >
                        <option value="">Select field</option>
                        {getStringColumns().map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Value Field *
                      </label>
                      <select
                        value={valueField}
                        onChange={(e) => setValueField(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        required
                      >
                        <option value="">Select field</option>
                        {getNumericColumns().map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {/* Time Series chart */}
                {chartType === ChartType.TIME_SERIES && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Time Field *
                      </label>
                      <select
                        value={timeField}
                        onChange={(e) => setTimeField(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        required
                      >
                        <option value="">Select field</option>
                        {getDateColumns().length > 0 ? (
                          getDateColumns().map((col) => (
                            <option key={col.name} value={col.name}>
                              {col.name}
                            </option>
                          ))
                        ) : (
                          columns.map((col) => (
                            <option key={col.name} value={col.name}>
                              {col.name} ({col.type})
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Value Field *
                      </label>
                      <select
                        value={valueField}
                        onChange={(e) => setValueField(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        required
                      >
                        <option value="">Select field</option>
                        {getNumericColumns().map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Chart Preview */}
        {canShowPreview() && (
          <div className="bg-white p-6 rounded-lg border border-gray-200 space-y-4">
            <h3 className="text-lg font-semibold">Preview</h3>
            <ChartPreview
              chartType={chartType}
              data={previewData}
              config={{
                xField,
                yFields,
                labelField,
                valueField,
                timeField,
              }}
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end space-x-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving || !datasetId}
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          >
            {isSaving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {isEditMode ? 'Update Chart' : 'Create Chart'}
          </button>
        </div>
      </form>
    </div>
  );
}
