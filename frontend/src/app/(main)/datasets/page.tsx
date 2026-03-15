/**
 * Legacy SQL Datasets Management Page
 * Full UI for creating, editing, and executing saved SQL queries
 * NOTE: This is legacy - new workspaces at /dataset-workspaces
 */
'use client';

import { useState } from 'react';
import { Plus, X, AlertCircle, Loader2, FileText, Clock, Edit, Trash2, Play, Search } from 'lucide-react';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { PageListLayout } from '@/components/common/PageListLayout';
import { toast } from 'sonner';
import type { Dataset as DatasetType } from '@/types/api';
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
  const [datasetToDelete, setDatasetToDelete] = useState<DatasetType | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingDataset, setIsDeletingDataset] = useState(false);
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
      toast.error(`Failed to create dataset: ${error.response?.data?.detail || error.message}`);
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
      toast.error(`Failed to update dataset: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleDelete = (id: number) => {
    const dataset = datasets.find((d) => d.id === id);
    if (dataset) { setDatasetToDelete(dataset); setDeleteConstraints(null); }
  };

  const confirmDeleteDataset = async () => {
    if (!datasetToDelete) return;
    setIsDeletingDataset(true);
    try {
      await deleteMutation.mutateAsync(datasetToDelete.id);
      setDatasetToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        alert(`Failed to delete dataset: ${detail || error.message}`);
        setDatasetToDelete(null);
      }
    } finally {
      setIsDeletingDataset(false);
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

    // List view is handled directly in the page return
    return null;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-3" />
          <p className="text-gray-600">Loading datasets...</p>
        </div>
      </div>
    );
  }

  // Sub-views (create / edit / preview)
  if (currentView !== 'list') {
    return (
      <div className="p-8">
        {renderContent()}
        {datasetToDelete && (
          <DeleteConstraintModal
            itemName={datasetToDelete.name}
            itemTypeLabel="dataset"
            constraints={deleteConstraints}
            isDeleting={isDeletingDataset}
            onConfirm={confirmDeleteDataset}
            onClose={() => { setDatasetToDelete(null); setDeleteConstraints(null); }}
          />
        )}
      </div>
    );
  }

  // List view via standard template
  return (
    <>
      <PageListLayout
        title="Datasets"
        description={`${datasets.length} dataset${datasets.length !== 1 ? 's' : ''} configured`}
        action={
          <button
            onClick={() => setCurrentView('create')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Dataset
          </button>
        }
        searchPlaceholder="Search datasets…"
        defaultView="list"
      >
        {({ viewMode, filterText }) => {
          const filtered = datasets.filter(d =>
            d.name.toLowerCase().includes(filterText.toLowerCase())
          );
          const dataSourceMap = Object.fromEntries(dataSources.map(ds => [ds.id, ds.name]));

          if (datasets.length === 0) {
            return (
              <DatasetList
                datasets={[]}
                dataSources={dataSources.map((ds) => ({ id: ds.id, name: ds.name }))}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onExecute={handleExecute}
              />
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Search className="w-8 h-8 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">No datasets matching "<strong>{filterText}</strong>"</p>
              </div>
            );
          }

          if (viewMode === 'list') {
            return (
              <DatasetList
                datasets={filtered}
                dataSources={dataSources.map((ds) => ({ id: ds.id, name: ds.name }))}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onExecute={handleExecute}
                isDeleting={deleteMutation.isPending ? deleteMutation.variables : null}
              />
            );
          }

          // Grid view
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map(dataset => {
                const dsName = dataSourceMap[dataset.data_source_id] ?? `ID: ${dataset.data_source_id}`;
                const createdAt = new Date(dataset.created_at).toLocaleDateString('vi-VN', {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                });
                return (
                  <div key={dataset.id} className="bg-white rounded-lg border border-gray-200 p-5 hover:shadow-md transition-all">
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
                        <FileText className="w-5 h-5 text-indigo-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 text-sm truncate">{dataset.name}</h3>
                        <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full font-medium">
                          {dsName}
                        </span>
                      </div>
                    </div>
                    {dataset.description && (
                      <p className="text-xs text-gray-500 mb-3 line-clamp-2">{dataset.description}</p>
                    )}
                    <div className="text-xs text-gray-400 mb-4 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {createdAt}
                    </div>
                    <div className="flex items-center gap-1 pt-3 border-t border-gray-100">
                      <button
                        onClick={() => handleExecute(dataset)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-600 hover:text-green-600 hover:bg-green-50 rounded transition-colors"
                      >
                        <Play className="w-3.5 h-3.5" /> Run
                      </button>
                      <button
                        onClick={() => handleEdit(dataset)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      >
                        <Edit className="w-3.5 h-3.5" /> Edit
                      </button>
                      <button
                        onClick={() => handleDelete(dataset.id)}
                        className="flex items-center justify-center p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }}
      </PageListLayout>

      {datasetToDelete && (
        <DeleteConstraintModal
          itemName={datasetToDelete.name}
          itemTypeLabel="dataset"
          constraints={deleteConstraints}
          isDeleting={isDeletingDataset}
          onConfirm={confirmDeleteDataset}
          onClose={() => { setDatasetToDelete(null); setDeleteConstraints(null); }}
        />
      )}
    </>
  );
}
