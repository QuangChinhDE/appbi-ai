/**
 * Legacy SQL Datasets Management Page
 * Full UI for creating, editing, and executing saved SQL queries
 * NOTE: This is legacy - new workspaces at /dataset-workspaces
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, X, AlertCircle } from 'lucide-react';
import {
  useDatasets,
  useCreateDataset,
  useUpdateDataset,
  useDeleteDataset,
  useExecuteDataset,
} from '@/hooks/use-datasets';
import { useDataSources } from '@/hooks/use-datasources';
import { dataSourceApi } from '@/lib/api/datasources';
import DatasetList from '@/components/datasets/DatasetList';
import DatasetEditor from '@/components/datasets/DatasetEditor';
import ResultTable from '@/components/common/ResultTable';
import type { Dataset, DatasetCreate, DatasetUpdate } from '@/types/api';

type View = 'list' | 'create' | 'edit' | 'preview';

export default function DatasetsPage() {
  const [currentView, setCurrentView] = useState<View>('list');
  const [editingDataset, setEditingDataset] = useState<Dataset | null>(null);
  const [previewingDataset, setPreviewingDataset] = useState<Dataset | null>(null);
  const [previewResult, setPreviewResult] = useState<any>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Queries
  const { data: datasets = [], isLoading } = useDatasets();
  const { data: dataSources = [] } = useDataSources();
  const createMutation = useCreateDataset();
  const updateMutation = useUpdateDataset();
  const deleteMutation = useDeleteDataset();
  const executeMutation = useExecuteDataset();

  // Handlers
  const handleCreate = async (data: DatasetCreate | DatasetUpdate) => {
    try {
      await createMutation.mutateAsync(data as DatasetCreate);
      setCurrentView('list');
      setPreviewResult(null);
      setPreviewError(null);
    } catch (error: any) {
      alert(`Failed to create dataset: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleUpdate = async (data: DatasetCreate | DatasetUpdate) => {
    if (!editingDataset) return;
    try {
      await updateMutation.mutateAsync({
        id: editingDataset.id,
        data: data as DatasetUpdate,
      });
      setCurrentView('list');
      setEditingDataset(null);
      setPreviewResult(null);
      setPreviewError(null);
    } catch (error: any) {
      alert(`Failed to update dataset: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this dataset?')) return;
    try {
      await deleteMutation.mutateAsync(id);
    } catch (error: any) {
      alert(`Failed to delete dataset: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleEdit = (dataset: Dataset) => {
    setEditingDataset(dataset);
    setCurrentView('edit');
    setPreviewResult(null);
    setPreviewError(null);
  };

  const handleExecute = async (dataset: Dataset) => {
    setPreviewingDataset(dataset);
    setCurrentView('preview');
    setPreviewError(null);
    try {
      const result = await executeMutation.mutateAsync({ id: dataset.id, limit: 100 });
      setPreviewResult(result);
    } catch (error: any) {
      setPreviewError(error.response?.data?.detail || error.message);
    }
  };

  const handlePreview = async (dataSourceId: number, sqlQuery: string) => {
    setPreviewError(null);
    setPreviewResult(null);
    setIsPreviewLoading(true);
    try {
      const result = await dataSourceApi.executeQuery({
        data_source_id: dataSourceId,
        sql_query: sqlQuery,
        limit: 100,
      });
      setPreviewResult(result);
    } catch (error: any) {
      setPreviewError(error.response?.data?.detail || error.message);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const renderContent = () => {
    if (currentView === 'create') {
      return (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Create Dataset</h2>
            <button
              onClick={() => {
                setCurrentView('list');
                setPreviewResult(null);
                setPreviewError(null);
              }}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <DatasetEditor
            mode="create"
            dataSources={dataSources.map((ds) => ({ id: ds.id, name: ds.name, type: ds.type }))}
            onSave={handleCreate}
            onCancel={() => {
              setCurrentView('list');
              setPreviewResult(null);
              setPreviewError(null);
            }}
            onPreview={handlePreview}
            previewResult={previewResult}
            isPreviewLoading={isPreviewLoading}
            isSaving={createMutation.isPending}
            previewError={previewError}
          />
        </div>
      );
    }

    if (currentView === 'edit' && editingDataset) {
      return (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Edit Dataset</h2>
            <button
              onClick={() => {
                setCurrentView('list');
                setEditingDataset(null);
                setPreviewResult(null);
                setPreviewError(null);
              }}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <DatasetEditor
            mode="edit"
            initialData={editingDataset}
            dataSources={dataSources.map((ds) => ({ id: ds.id, name: ds.name, type: ds.type }))}
            onSave={handleUpdate}
            onCancel={() => {
              setCurrentView('list');
              setEditingDataset(null);
              setPreviewResult(null);
              setPreviewError(null);
            }}
            onPreview={handlePreview}
            previewResult={previewResult}
            isPreviewLoading={isPreviewLoading}
            isSaving={updateMutation.isPending}
            previewError={previewError}
          />
        </div>
      );
    }

    if (currentView === 'preview' && previewingDataset) {
      return (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold">{previewingDataset.name}</h2>
              <p className="text-gray-600 mt-1">{previewingDataset.description}</p>
            </div>
            <button
              onClick={() => {
                setCurrentView('list');
                setPreviewingDataset(null);
                setPreviewResult(null);
                setPreviewError(null);
              }}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          <div className="mb-4 p-3 bg-gray-50 rounded border border-gray-200">
            <p className="text-xs font-medium text-gray-500 uppercase mb-1">SQL Query</p>
            <pre className="text-sm text-gray-900 font-mono whitespace-pre-wrap">
              {previewingDataset.sql_query}
            </pre>
          </div>

          {previewError && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-md mb-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-800 font-medium">Execution Error</p>
                  <p className="text-sm text-red-700 mt-1">{previewError}</p>
                </div>
              </div>
            </div>
          )}

          {executeMutation.isPending && (
            <div className="text-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="text-gray-500 mt-2">Executing query...</p>
            </div>
          )}

          {previewResult && !executeMutation.isPending && (
            <ResultTable
              columns={previewResult.columns}
              data={previewResult.data}
              rowCount={previewResult.row_count}
            />
          )}
        </div>
      );
    }

    // Default: list view
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold">Datasets</h2>
              <p className="text-gray-600 mt-1">
                {datasets.length} dataset{datasets.length !== 1 ? 's' : ''} configured
              </p>
            </div>
            <button
              onClick={() => setCurrentView('create')}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              New Dataset
            </button>
          </div>

          {isLoading ? (
            <div className="text-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="text-gray-500 mt-2">Loading...</p>
            </div>
          ) : (
            <DatasetList
              datasets={datasets}
              dataSources={dataSources.map((ds) => ({ id: ds.id, name: ds.name }))}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onExecute={handleExecute}
              isDeleting={deleteMutation.isPending ? deleteMutation.variables : null}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <Link href="/" className="inline-flex items-center text-blue-600 hover:text-blue-700">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Home
          </Link>
        </div>

        {renderContent()}
      </div>
    </div>
  );
}
