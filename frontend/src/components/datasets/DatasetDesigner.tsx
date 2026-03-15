'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Play,
  Save,
  X,
  ChevronLeft,
  ChevronRight,
  Trash2,
  ChevronUp,
  ChevronDown,
  Eye,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Database,
} from 'lucide-react';
import { useDatasets } from '@/hooks/use-datasets';
import { useDataSources } from '@/hooks/use-datasources';
import apiClient from '@/lib/api-client';
import type { Dataset, DataSource, TransformationStep, ColumnMetadata } from '@/types/api';

interface DatasetDesignerProps {
  mode: 'create' | 'edit';
  datasetId?: number;
}

interface PreviewData {
  columns: ColumnMetadata[];
  rows: Record<string, any>[];
  total_rows: number;
}

const TRANSFORMATION_TYPES = [
  { value: 'select_columns', label: 'Select Columns' },
  { value: 'filter_rows', label: 'Filter Rows' },
  { value: 'add_column', label: 'Add Column' },
  { value: 'remove_column', label: 'Remove Column' },
  { value: 'rename_column', label: 'Rename Column' },
  { value: 'change_column_type', label: 'Change Column Type' },
  { value: 'sort', label: 'Sort' },
  { value: 'limit', label: 'Limit' },
  { value: 'distinct', label: 'Distinct' },
  { value: 'group_by', label: 'Group By' },
  { value: 'pivot', label: 'Pivot' },
  { value: 'unpivot', label: 'Unpivot' },
  { value: 'join_dataset', label: 'Join Dataset' },
  { value: 'union_dataset', label: 'Union Dataset' },
  { value: 'fill_null', label: 'Fill Null Values' },
  { value: 'find_replace', label: 'Find & Replace' },
  { value: 'split_column', label: 'Split Column' },
  { value: 'merge_columns', label: 'Merge Columns' },
  { value: 'extract_text', label: 'Extract Text (Regex)' },
  { value: 'custom_sql', label: 'Custom SQL' },
];

/** Returns the set of column names that are *introduced* by transformation steps (not original source columns). */
function getDerivedColumns(steps: TransformationStep[]): Set<string> {
  const derived = new Set<string>();
  for (const step of steps) {
    if (!step.enabled) continue;
    const p = step.params;
    switch (step.type as string) {
      case 'add_column':
      case 'duplicate_column':
      case 'merge_columns':
      case 'extract_text':
      case 'split_column':
        if (p.newField) derived.add(p.newField);
        (p.newFields as string[] | undefined)?.forEach((f) => derived.add(f));
        break;
      case 'rename_column':
        if (p.newField) derived.add(p.newField);
        else if (p.newName) derived.add(p.newName);
        break;
      case 'group_by':
        (p.aggregations as { as?: string }[] | undefined)?.forEach(
          (agg) => { if (agg.as) derived.add(agg.as); }
        );
        break;
    }
  }
  return derived;
}

export default function DatasetDesigner({ datasetId, mode }: DatasetDesignerProps) {
  const router = useRouter();
  
  // API hooks
  const { data: dataSources } = useDataSources();
  const { data: datasets } = useDatasets();
  const dataset = datasets?.find((d) => d.id === datasetId);

  // Layout state
  const [showSteps, setShowSteps] = useState(true);
  const [showPreview, setShowPreview] = useState(true);

  // Draft state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dataSourceId, setDataSourceId] = useState<number | null>(null);
  const [sqlQuery, setSqlQuery] = useState('');
  const [transformations, setTransformations] = useState<TransformationStep[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // Preview state
  const [previewMode, setPreviewMode] = useState<'base' | 'transformed'>('transformed');
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [previewColumns, setPreviewColumns] = useState<ColumnMetadata[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [lastPreviewTime, setLastPreviewTime] = useState<Date | null>(null);

  // Save state
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);

  // Refs for debouncing
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previewAbortControllerRef = useRef<AbortController | null>(null);

  // Initialize from dataset
  useEffect(() => {
    if (mode === 'edit' && dataset) {
      setName(dataset.name);
      setDescription(dataset.description || '');
      setDataSourceId(dataset.data_source_id);
      setSqlQuery(dataset.sql_query);
      setTransformations(dataset.transformations || []);
    }
  }, [mode, dataset]);

  // Track unsaved changes
  useEffect(() => {
    if (mode === 'edit' && dataset) {
      const hasChanges =
        name !== dataset.name ||
        description !== (dataset.description || '') ||
        sqlQuery !== dataset.sql_query ||
        JSON.stringify(transformations) !== JSON.stringify(dataset.transformations || []);
      setHasUnsavedChanges(hasChanges);
    } else if (mode === 'create') {
      setHasUnsavedChanges(name !== '' || sqlQuery !== '');
    }
  }, [name, description, sqlQuery, transformations, mode, dataset]);

  // Auto-preview with debounce
  const triggerPreview = useCallback(() => {
    if (!sqlQuery || !dataSourceId) return;

    // Clear existing timeout
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }

    // Cancel in-flight request
    if (previewAbortControllerRef.current) {
      previewAbortControllerRef.current.abort();
    }

    // Debounce: 800ms for SQL changes
    const debounceTime = 800;
    previewTimeoutRef.current = setTimeout(() => {
      runPreview();
    }, debounceTime);
  }, [sqlQuery, dataSourceId, transformations, previewMode]);

  // Run preview
  const runPreview = async (stopAtStepId?: string) => {
    if (!sqlQuery || !dataSourceId) return;

    const abortController = new AbortController();
    previewAbortControllerRef.current = abortController;

    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const response = await apiClient.post('/datasets/preview', {
        data_source_id: dataSourceId,
        sql_query: sqlQuery,
        transformations: previewMode === 'transformed' ? transformations : [],
        stop_at_step_id: stopAtStepId,
      }, {
        signal: abortController.signal,
      });

      const data = response.data;
      setPreviewData(data.rows || data.data || []);
      setPreviewColumns(data.columns || []);
      setLastPreviewTime(new Date());
      setPreviewError(null);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setPreviewError(error.message);
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  // Auto-trigger preview on changes
  useEffect(() => {
    if (mode === 'edit' || (mode === 'create' && sqlQuery)) {
      triggerPreview();
    }
  }, [sqlQuery, transformations, previewMode, triggerPreview, mode]);

  // Save dataset
  const handleSave = async () => {
    if (!name || !sqlQuery || !dataSourceId) {
      alert('Please fill in all required fields');
      return;
    }

    setSaveLoading(true);
    try {
      const payload = {
        name,
        description,
        data_source_id: dataSourceId,
        sql_query: sqlQuery,
        transformations,
      };

      if (mode === 'create') {
        await apiClient.post('/datasets/', payload);
      } else {
        await apiClient.put(`/datasets/${datasetId}`, payload);
      }

      setHasUnsavedChanges(false);
      router.push('/datasets');
    } catch (error: any) {
      alert(error.message);
    } finally {
      setSaveLoading(false);
    }
  };

  // Transformation management
  const handleAddStep = (type: string) => {
    const newStep: TransformationStep = {
      id: `step_${Date.now()}`,
      type: type as TransformationStep['type'],
      enabled: true,
      params: {},
    };
    setTransformations([...transformations, newStep]);
  };

  const handleDeleteStep = (stepId: string) => {
    setTransformations(transformations.filter((s) => s.id !== stepId));
    if (selectedStepId === stepId) setSelectedStepId(null);
  };

  const handleMoveStep = (stepId: string, direction: 'up' | 'down') => {
    const index = transformations.findIndex((s) => s.id === stepId);
    if (index === -1) return;
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === transformations.length - 1) return;

    const newTransformations = [...transformations];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    [newTransformations[index], newTransformations[targetIndex]] = [
      newTransformations[targetIndex],
      newTransformations[index],
    ];
    setTransformations(newTransformations);
  };

  const handleToggleStep = (stepId: string) => {
    setTransformations(
      transformations.map((s) =>
        s.id === stepId ? { ...s, enabled: !s.enabled } : s
      )
    );
  };

  const handleUpdateStepParams = (stepId: string, params: any) => {
    setTransformations(
      transformations.map((s) =>
        s.id === stepId ? { ...s, params } : s
      )
    );
  };

  // Calculate panel widths
  const stepsWidth = showSteps ? 'w-80' : 'w-12';
  const previewWidth = showPreview ? 'w-[480px]' : 'w-12';

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Top Bar */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="p-2 hover:bg-gray-100 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dataset Name"
              className="text-xl font-semibold border-none focus:outline-none focus:ring-2 focus:ring-blue-500 px-2 py-1 rounded w-full"
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              className="text-sm text-gray-600 border-none focus:outline-none focus:ring-2 focus:ring-blue-500 px-2 py-1 rounded w-full mt-1"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {hasUnsavedChanges && (
            <span className="text-sm text-gray-600">Unsaved changes</span>
          )}
          <button
            onClick={handleSave}
            disabled={saveLoading || !name || !sqlQuery || !dataSourceId}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saveLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Transformation Steps */}
        <div className={`${stepsWidth} transition-all duration-300 border-r bg-white flex flex-col`}>
          {showSteps ? (
            <>
              <div className="p-4 border-b flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2">
                  <Database className="w-4 h-4" />
                  Transformation Steps
                </h3>
                <button
                  onClick={() => setShowSteps(false)}
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {transformations.map((step, index) => (
                  <div
                    key={step.id}
                    className={`border rounded-lg p-3 ${
                      selectedStepId === step.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 bg-white'
                    } ${!step.enabled ? 'opacity-50' : ''}`}
                    onClick={() => setSelectedStepId(step.id)}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-gray-500">
                          #{index + 1}
                        </span>
                        <span className="font-medium text-sm">
                          {TRANSFORMATION_TYPES.find((t) => t.value === step.type)?.label || step.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleStep(step.id);
                          }}
                          className="p-1 hover:bg-gray-200 rounded"
                          title={step.enabled ? 'Disable' : 'Enable'}
                        >
                          <CheckCircle2 className={`w-4 h-4 ${step.enabled ? 'text-green-600' : 'text-gray-400'}`} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            runPreview(step.id);
                          }}
                          className="p-1 hover:bg-gray-200 rounded"
                          title="Preview at this step"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveStep(step.id, 'up');
                          }}
                          disabled={index === 0}
                          className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveStep(step.id, 'down');
                          }}
                          disabled={index === transformations.length - 1}
                          className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteStep(step.id);
                          }}
                          className="p-1 hover:bg-red-100 text-red-600 rounded"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {selectedStepId === step.id && (
                      <div className="mt-2 pt-2 border-t">
                        <textarea
                          value={JSON.stringify(step.params, null, 2)}
                          onChange={(e) => {
                            try {
                              const params = JSON.parse(e.target.value);
                              handleUpdateStepParams(step.id, params);
                            } catch {}
                          }}
                          className="w-full p-2 border rounded text-xs font-mono"
                          rows={4}
                          placeholder='{"param": "value"}'
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="p-4 border-t">
                <select
                  className="w-full p-2 border rounded"
                  onChange={(e) => {
                    if (e.target.value) {
                      handleAddStep(e.target.value);
                      e.target.value = '';
                    }
                  }}
                  defaultValue=""
                >
                  <option value="" disabled>
                    + Add Transformation
                  </option>
                  {TRANSFORMATION_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <button
              onClick={() => setShowSteps(true)}
              className="p-4 hover:bg-gray-50 flex items-center justify-center"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Middle Panel - SQL Editor */}
        <div className="flex-1 flex flex-col bg-white">
          <div className="p-4 border-b">
            <div className="flex items-center gap-4 mb-3">
              <label className="text-sm font-medium">Data Source:</label>
              <select
                value={dataSourceId || ''}
                onChange={(e) => setDataSourceId(Number(e.target.value))}
                className="flex-1 p-2 border rounded"
              >
                <option value="">Select a data source...</option>
                {dataSources?.map((ds) => (
                  <option key={ds.id} value={ds.id}>
                    {ds.name} ({ds.type})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex-1 p-4">
            <textarea
              value={sqlQuery}
              onChange={(e) => setSqlQuery(e.target.value)}
              placeholder="Enter your SQL query..."
              className="w-full h-full p-4 border rounded font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="p-4 border-t flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => runPreview()}
                disabled={previewLoading || !sqlQuery || !dataSourceId}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {previewLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Run Preview
              </button>

              <div className="flex items-center gap-2">
                <label className="text-sm">Preview:</label>
                <select
                  value={previewMode}
                  onChange={(e) => setPreviewMode(e.target.value as 'base' | 'transformed')}
                  className="p-2 border rounded text-sm"
                >
                  <option value="base">Base SQL Only</option>
                  <option value="transformed">With Transformations</option>
                </select>
              </div>
            </div>

            {lastPreviewTime && (
              <span className="text-xs text-gray-500">
                Last preview: {lastPreviewTime.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {/* Right Panel - Preview */}
        <div className={`${previewWidth} transition-all duration-300 border-l bg-white flex flex-col`}>
          {showPreview ? (
            <>
              <div className="p-4 border-b flex items-center justify-between">
                <h3 className="font-semibold">Preview</h3>
                <button
                  onClick={() => setShowPreview(false)}
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-auto">
                {previewLoading && (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                  </div>
                )}

                {previewError && (
                  <div className="p-4">
                    <div className="bg-red-50 border border-red-200 rounded p-3 flex items-start gap-2">
                      <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                      <div className="text-sm text-red-800">{previewError}</div>
                    </div>
                  </div>
                )}

                {!previewLoading && !previewError && previewData.length > 0 && (
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                      <span className="text-sm text-gray-600">
                        {previewData.length} rows × {previewColumns.length} columns
                      </span>
                      {previewMode === 'transformed' && getDerivedColumns(transformations).size > 0 && (
                        <span className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                          <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                          Cột được thêm bằng transformation
                        </span>
                      )}
                    </div>

                    <div className="border rounded overflow-hidden">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            {(() => {
                              const derived = previewMode === 'transformed'
                                ? getDerivedColumns(transformations)
                                : new Set<string>();
                              return previewColumns.map((col) => {
                                const isDerived = derived.has(col.name);
                                return (
                                  <th
                                    key={col.name}
                                    className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wider ${
                                      isDerived
                                        ? 'bg-amber-50 text-amber-700'
                                        : 'text-gray-700'
                                    }`}
                                    title={isDerived ? 'Cột được thêm bằng transformation' : undefined}
                                  >
                                    <div className="flex items-center gap-1">
                                      {isDerived && (
                                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                                      )}
                                      {col.name}
                                    </div>
                                    <div className={`normal-case font-normal ${
                                      isDerived ? 'text-amber-500' : 'text-gray-500'
                                    }`}>
                                      {col.type}
                                    </div>
                                  </th>
                                );
                              });
                            })()}
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {(() => {
                            const derived = previewMode === 'transformed'
                              ? getDerivedColumns(transformations)
                              : new Set<string>();
                            return previewData.slice(0, 50).map((row, i) => (
                              <tr key={i}>
                                {previewColumns.map((col) => {
                                  const isDerived = derived.has(col.name);
                                  return (
                                    <td
                                      key={col.name}
                                      className={`px-3 py-2 text-sm whitespace-nowrap ${
                                        isDerived ? 'bg-amber-50 text-amber-900' : 'text-gray-900'
                                      }`}
                                    >
                                      {row[col.name] === null ? (
                                        <span className="text-gray-400 italic">null</span>
                                      ) : (
                                        String(row[col.name])
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ));
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {!previewLoading && !previewError && previewData.length === 0 && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    No data to preview
                  </div>
                )}
              </div>
            </>
          ) : (
            <button
              onClick={() => setShowPreview(true)}
              className="p-4 hover:bg-gray-50 flex items-center justify-center"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
