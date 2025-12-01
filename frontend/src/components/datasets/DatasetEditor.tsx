/**
 * Dataset Editor Component
 * SQL editor with preview and save functionality
 */
'use client';

import { useState, useEffect } from 'react';
import { Play, Loader2, Save } from 'lucide-react';
import ResultTable from '@/components/common/ResultTable';
import { Dataset, DatasetCreate, DatasetUpdate } from '@/types/api';

interface DatasetEditorProps {
  mode: 'create' | 'edit';
  initialData?: Dataset;
  dataSources: Array<{ id: number; name: string; type: string }>;
  onSave: (data: DatasetCreate | DatasetUpdate) => void;
  onCancel: () => void;
  onPreview?: (dataSourceId: number, sqlQuery: string) => void;
  previewResult?: {
    columns: string[];
    data: Record<string, any>[];
    row_count: number;
  } | null;
  isPreviewLoading?: boolean;
  isSaving?: boolean;
  previewError?: string | null;
}

export default function DatasetEditor({
  mode,
  initialData,
  dataSources,
  onSave,
  onCancel,
  onPreview,
  previewResult,
  isPreviewLoading = false,
  isSaving = false,
  previewError = null,
}: DatasetEditorProps) {
  const [name, setName] = useState(initialData?.name || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [dataSourceId, setDataSourceId] = useState<number | null>(
    initialData?.data_source_id || null
  );
  const [sqlQuery, setSqlQuery] = useState(initialData?.sql_query || '');
  const [previewLimit, setPreviewLimit] = useState(100);

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setDescription(initialData.description || '');
      setDataSourceId(initialData.data_source_id);
      setSqlQuery(initialData.sql_query);
    }
  }, [initialData]);

  const handlePreview = () => {
    if (!dataSourceId || !sqlQuery.trim()) return;
    onPreview?.(dataSourceId, sqlQuery);
  };

  const handleSave = () => {
    if (!name.trim() || !dataSourceId || !sqlQuery.trim()) return;

    const payload = {
      name,
      description: description || undefined,
      data_source_id: dataSourceId,
      sql_query: sqlQuery,
    };

    onSave(payload);
  };

  const canPreview = dataSourceId && sqlQuery.trim() && onPreview;
  const canSave = name.trim() && dataSourceId && sqlQuery.trim();

  return (
    <div className="space-y-6">
      {/* Basic Info */}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="My Dataset"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Data Source <span className="text-red-500">*</span>
          </label>
          <select
            value={dataSourceId || ''}
            onChange={(e) => setDataSourceId(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={mode === 'edit'}
            required
          >
            <option value="">Select a data source...</option>
            {dataSources.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({ds.type})
              </option>
            ))}
          </select>
          {mode === 'edit' && (
            <p className="text-xs text-gray-500 mt-1">
              Data source cannot be changed after creation
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Optional description"
            rows={2}
          />
        </div>
      </div>

      {/* SQL Editor */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-700">
            SQL Query <span className="text-red-500">*</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600">Preview Limit:</label>
            <input
              type="number"
              value={previewLimit}
              onChange={(e) => setPreviewLimit(Number(e.target.value))}
              className="w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              min={1}
              max={1000}
            />
          </div>
        </div>
        <textarea
          value={sqlQuery}
          onChange={(e) => setSqlQuery(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
          placeholder="SELECT * FROM table_name WHERE condition"
          rows={8}
          required
        />
        <p className="text-xs text-gray-500 mt-1">
          Only SELECT queries are allowed for safety
        </p>
      </div>

      {/* Preview Button */}
      {onPreview && (
        <div>
          <button
            onClick={handlePreview}
            disabled={!canPreview || isPreviewLoading}
            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isPreviewLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Running Preview...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Run Preview
              </>
            )}
          </button>
        </div>
      )}

      {/* Preview Error */}
      {previewError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-800 font-medium mb-1">Preview Error</p>
          <p className="text-sm text-red-700">{previewError}</p>
        </div>
      )}

      {/* Preview Results */}
      {previewResult && (
        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Preview Results</h3>
          <ResultTable
            columns={previewResult.columns}
            data={previewResult.data}
            rowCount={previewResult.row_count}
          />
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3 pt-4 border-t">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
          disabled={isSaving}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || isSaving}
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          <Save className="w-4 h-4" />
          {mode === 'create' ? 'Create Dataset' : 'Update Dataset'}
        </button>
      </div>
    </div>
  );
}
