/**
 * Data Sources Management Page
 * Full UI for CRUD operations, connection testing, and ad-hoc queries
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, X, AlertCircle, CheckCircle } from 'lucide-react';
import {
  useDataSources,
  useCreateDataSource,
  useUpdateDataSource,
  useDeleteDataSource,
  useTestDataSource,
  useExecuteQuery,
} from '@/hooks/use-datasources';
import DataSourceList from '@/components/datasources/DataSourceList';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import QueryRunner from '@/components/datasources/QueryRunner';
import type { DataSource, DataSourceCreate, QueryExecuteResponse } from '@/types/api';

type View = 'list' | 'create' | 'edit' | 'query';

export default function DataSourcesPage() {
  const [currentView, setCurrentView] = useState<View>('list');
  const [editingDataSource, setEditingDataSource] = useState<DataSource | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [queryResult, setQueryResult] = useState<QueryExecuteResponse | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  // Queries
  const { data: dataSources = [], isLoading } = useDataSources();
  const createMutation = useCreateDataSource();
  const updateMutation = useUpdateDataSource();
  const deleteMutation = useDeleteDataSource();
  const testMutation = useTestDataSource();
  const executeMutation = useExecuteQuery();

  // Handlers
  const handleCreate = async (data: DataSourceCreate) => {
    try {
      await createMutation.mutateAsync(data);
      setCurrentView('list');
    } catch (error: any) {
      alert(`Failed to create data source: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleUpdate = async (data: DataSourceCreate) => {
    if (!editingDataSource) return;
    try {
      await updateMutation.mutateAsync({
        id: editingDataSource.id,
        data: {
          name: data.name,
          description: data.description,
          config: data.config,
        },
      });
      setCurrentView('list');
      setEditingDataSource(null);
    } catch (error: any) {
      alert(`Failed to update data source: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this data source?')) return;
    try {
      await deleteMutation.mutateAsync(id);
    } catch (error: any) {
      alert(`Failed to delete data source: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleEdit = (dataSource: DataSource) => {
    setEditingDataSource(dataSource);
    setCurrentView('edit');
  };

  const handleTest = async (dataSource: DataSource) => {
    setTestResult(null);
    try {
      const result = await testMutation.mutateAsync({
        type: dataSource.type,
        config: dataSource.config,
      });
      setTestResult(result);
      setTimeout(() => setTestResult(null), 5000);
    } catch (error: any) {
      setTestResult({
        success: false,
        message: error.response?.data?.detail || error.message,
      });
      setTimeout(() => setTestResult(null), 5000);
    }
  };

  const handleExecuteQuery = async (params: {
    data_source_id: number;
    sql_query: string;
    limit: number;
    timeout_seconds: number;
  }) => {
    setQueryError(null);
    setQueryResult(null);
    try {
      const result = await executeMutation.mutateAsync(params);
      setQueryResult(result);
    } catch (error: any) {
      setQueryError(error.response?.data?.detail || error.message);
    }
  };

  const renderContent = () => {
    if (currentView === 'create') {
      return (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Create Data Source</h2>
            <button
              onClick={() => setCurrentView('list')}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <DataSourceForm
            onSubmit={handleCreate}
            onCancel={() => setCurrentView('list')}
            isLoading={createMutation.isPending}
          />
        </div>
      );
    }

    if (currentView === 'edit' && editingDataSource) {
      return (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Edit Data Source</h2>
            <button
              onClick={() => {
                setCurrentView('list');
                setEditingDataSource(null);
              }}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <DataSourceForm
            initialData={editingDataSource}
            onSubmit={handleUpdate}
            onCancel={() => {
              setCurrentView('list');
              setEditingDataSource(null);
            }}
            isLoading={updateMutation.isPending}
          />
        </div>
      );
    }

    if (currentView === 'query') {
      return (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Query Runner</h2>
            <button
              onClick={() => {
                setCurrentView('list');
                setQueryResult(null);
                setQueryError(null);
              }}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <QueryRunner
            dataSources={dataSources}
            onExecute={handleExecuteQuery}
            result={queryResult}
            isExecuting={executeMutation.isPending}
            error={queryError}
          />
        </div>
      );
    }

    // Default: list view
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold">Data Sources</h2>
              <p className="text-gray-600 mt-1">
                {dataSources.length} connection{dataSources.length !== 1 ? 's' : ''} configured
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setCurrentView('query')}
                className="px-4 py-2 border border-blue-600 text-blue-600 rounded-md hover:bg-blue-50 transition-colors"
                disabled={dataSources.length === 0}
              >
                Run Query
              </button>
              <button
                onClick={() => setCurrentView('create')}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                New Data Source
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="text-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="text-gray-500 mt-2">Loading...</p>
            </div>
          ) : (
            <DataSourceList
              dataSources={dataSources}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onTest={handleTest}
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

        {/* Test Result Toast */}
        {testResult && (
          <div
            className={`mb-6 p-4 rounded-lg border ${
              testResult.success
                ? 'bg-green-50 border-green-200'
                : 'bg-red-50 border-red-200'
            }`}
          >
            <div className="flex items-start gap-3">
              {testResult.success ? (
                <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              )}
              <div>
                <p
                  className={`font-medium ${
                    testResult.success ? 'text-green-800' : 'text-red-800'
                  }`}
                >
                  {testResult.success ? 'Connection Successful' : 'Connection Failed'}
                </p>
                <p
                  className={`text-sm mt-1 ${
                    testResult.success ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {testResult.message}
                </p>
              </div>
            </div>
          </div>
        )}

        {renderContent()}
      </div>
    </div>
  );
}
