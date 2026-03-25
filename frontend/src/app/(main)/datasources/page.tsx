/**
 * Data Sources Management Page — List + Query Runner
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Database, Edit, TestTube, Trash2, Clock, Search, Share2 } from 'lucide-react';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { ShareDialog } from '@/components/common/ShareDialog';
import { PageListLayout } from '@/components/common/PageListLayout';
import { toast } from 'sonner';
import { useCurrentUser } from '@/hooks/use-current-user';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import {
  useDataSources,
  useDeleteDataSource,
  useTestDataSource,
  useExecuteQuery,
} from '@/hooks/use-datasources';
import DataSourceList from '@/components/datasources/DataSourceList';
import QueryRunner from '@/components/datasources/QueryRunner';
import type { DataSource, QueryExecuteResponse } from '@/types/api';

const DS_TYPE_LABEL: Record<string, string> = {
  postgresql: 'PostgreSQL', mysql: 'MySQL', bigquery: 'BigQuery',
  google_sheets: 'Google Sheets', manual: 'Manual Table',
};
const DS_TYPE_COLOR: Record<string, string> = {
  postgresql: 'bg-blue-100 text-blue-800', mysql: 'bg-orange-100 text-orange-800',
  bigquery: 'bg-green-100 text-green-800', google_sheets: 'bg-emerald-100 text-emerald-800',
  manual: 'bg-purple-100 text-purple-800',
};

type View = 'list' | 'query';

export default function DataSourcesPage() {
  const router = useRouter();
  const [currentView, setCurrentView] = useState<View>('list');
  const [sourceToDelete, setSourceToDelete] = useState<DataSource | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingSource, setIsDeletingSource] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryExecuteResponse | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [shareSource, setShareSource] = useState<DataSource | null>(null);

  const { data: currentUser } = useCurrentUser();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'data_sources', 'full');
  const canShare = hasPermission(permData?.permissions, 'data_sources', 'full');

  const { data: dataSources = [], isLoading } = useDataSources();
  const deleteMutation = useDeleteDataSource();
  const testMutation = useTestDataSource();
  const executeMutation = useExecuteQuery();
  const distinctSourceTypes = new Set(dataSources.map((source) => source.type)).size;
  const googleSheetsSources = dataSources.filter((source) => source.type === 'google_sheets').length;
  const manualSources = dataSources.filter((source) => source.type === 'manual').length;

  const handleDelete = (id: number) => {
    const source = dataSources.find((s) => s.id === id);
    if (source) { setSourceToDelete(source); setDeleteConstraints(null); }
  };

  const confirmDeleteSource = async () => {
    if (!sourceToDelete) return;
    setIsDeletingSource(true);
    try {
      await deleteMutation.mutateAsync(sourceToDelete.id);
      setSourceToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        toast.error(`Không thể xóa: ${detail || error.message}`);
        setSourceToDelete(null);
      }
    } finally {
      setIsDeletingSource(false);
    }
  };

  const handleEdit = (dataSource: DataSource) => {
    router.push(`/datasources/${dataSource.id}/edit`);
  };

  const handleTest = async (dataSource: DataSource) => {
    try {
      const result = await testMutation.mutateAsync({
        type: dataSource.type,
        config: dataSource.config,
      });
      if (result.success) {
        toast.success(`Connection successful: ${result.message}`);
      } else {
        toast.error(`Connection failed: ${result.message}`);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.detail || error.message);
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

  // Query sub-view
  if (currentView === 'query') {
    return (
      <div className="p-8">
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => { setCurrentView('list'); setQueryResult(null); setQueryError(null); }}
            className="text-gray-500 hover:text-gray-700 flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            All Data Sources
          </button>
          <span className="text-gray-300">/</span>
          <h1 className="text-lg font-semibold text-gray-900">Query Runner</h1>
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

  // List view via standard template
  return (
    <>
      <PageListLayout
        title="Data Sources"
        description={`${dataSources.length} connection${dataSources.length !== 1 ? 's' : ''} configured`}
        overview={(
          <ModuleOverview
            icon={Database}
            title="Keep every data connection visible before it feeds workspaces and reports"
            description="Data Sources is the connection layer of the platform. Manage source configs, test access, and track which connectors are ready before syncing tables into Dataset Workspaces."
            badges={['Connections', 'Query runner', 'Sync inputs']}
            stats={[
              {
                label: 'Connections',
                value: dataSources.length,
                helper: 'Configured sources currently available to the platform',
              },
              {
                label: 'Source types',
                value: distinctSourceTypes,
                helper: 'Different connector categories now represented',
              },
              {
                label: 'Sheets / Manual',
                value: `${googleSheetsSources} / ${manualSources}`,
                helper: 'Quick read on spreadsheet and manual-entry sources',
              },
            ]}
          />
        )}
        action={canEdit ? (
          <button
            onClick={() => router.push('/datasources/new')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Data Source
          </button>
        ) : undefined}
        isLoading={isLoading}
        loadingText="Loading data sources…"
        searchPlaceholder="Search by name or type…"
        defaultView="list"
      >
        {({ viewMode, filterText }) => {
          const filtered = dataSources.filter(s =>
            s.name.toLowerCase().includes(filterText.toLowerCase()) ||
            (DS_TYPE_LABEL[s.type] ?? s.type).toLowerCase().includes(filterText.toLowerCase())
          );

          if (dataSources.length === 0) {
            return (
              <DataSourceList
                dataSources={[]}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onTest={handleTest}
              />
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Search className="w-8 h-8 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">No data sources matching "<strong>{filterText}</strong>"</p>
              </div>
            );
          }

          if (viewMode === 'list') {
            return (
              <DataSourceList
                dataSources={filtered}
                onEdit={canEdit ? handleEdit : undefined}
                onDelete={canEdit ? handleDelete : undefined}
                onTest={handleTest}
                onShare={canShare ? (ds) => setShareSource(ds) : undefined}
                isDeleting={deleteMutation.isPending ? deleteMutation.variables : null}
              />
            );
          }

          // Grid view
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map(ds => {
                const typeLabel = DS_TYPE_LABEL[ds.type] ?? ds.type;
                const typeColor = DS_TYPE_COLOR[ds.type] ?? 'bg-gray-100 text-gray-800';
                const createdAt = new Date(ds.created_at).toLocaleDateString('vi-VN', {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                });
                const itemPerms = getResourcePermissions(ds.user_permission);
                return (
                  <div key={ds.id} className="bg-white rounded-lg border border-gray-200 p-5 hover:shadow-md transition-all">
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                        <Database className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 text-sm truncate">{ds.name}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColor}`}>
                          {typeLabel}
                        </span>
                      </div>
                    </div>
                    {ds.description && (
                      <p className="text-xs text-gray-500 mb-3 line-clamp-2">{ds.description}</p>
                    )}
                    <div className="text-xs text-gray-400 mb-4 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {createdAt}
                    </div>
                    <div className="flex items-center gap-1 pt-3 border-t border-gray-100">
                      {itemPerms.canEdit && (
                      <button
                        onClick={() => handleEdit(ds)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      >
                        <Edit className="w-3.5 h-3.5" /> Edit
                      </button>
                      )}
                      <button
                        onClick={() => handleTest(ds)}
                        disabled={testMutation.isPending}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-600 hover:text-green-600 hover:bg-green-50 rounded transition-colors disabled:opacity-50"
                      >
                        <TestTube className="w-3.5 h-3.5" /> Test
                      </button>
                      {itemPerms.canShare && (
                        <button
                          onClick={() => setShareSource(ds)}
                          className="flex items-center justify-center p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors"
                          title="Share"
                        >
                          <Share2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {itemPerms.canDelete && (
                      <button
                        onClick={() => handleDelete(ds.id)}
                        className="flex items-center justify-center p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }}
      </PageListLayout>

      {sourceToDelete && (
        <DeleteConstraintModal
          itemName={sourceToDelete.name}
          itemTypeLabel="data source"
          constraints={deleteConstraints}
          isDeleting={isDeletingSource}
          onConfirm={confirmDeleteSource}
          onClose={() => { setSourceToDelete(null); setDeleteConstraints(null); }}
        />
      )}
      {shareSource && (
        <ShareDialog
          resourceType="datasource"
          resourceId={shareSource.id}
          resourceName={shareSource.name}
          onClose={() => setShareSource(null)}
        />
      )}
    </>
  );
}
