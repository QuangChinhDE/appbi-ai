'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, Settings, RefreshCw, Pencil } from 'lucide-react';
import { useDataSource, useUpdateDataSource } from '@/hooks/use-datasources';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import SyncSettingsTab from '@/components/datasources/SyncSettingsTab';
import type { DataSourceCreate } from '@/types/api';
import { getResourcePermissions } from '@/hooks/use-resource-permission';

type Tab = 'connection' | 'sync';

const TYPE_LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  bigquery: 'BigQuery',
  google_sheets: 'Google Sheets',
  manual: 'Manual',
};

const TYPE_COLORS: Record<string, string> = {
  postgresql: 'bg-blue-100 text-blue-700',
  mysql: 'bg-orange-100 text-orange-700',
  bigquery: 'bg-green-100 text-green-700',
  google_sheets: 'bg-emerald-100 text-emerald-700',
  manual: 'bg-gray-100 text-gray-600',
};

export default function DataSourceDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const datasourceId = parseInt(id, 10);

  const { data: dataSource, isLoading } = useDataSource(datasourceId);
  const updateMutation = useUpdateDataSource();
  const resPerms = getResourcePermissions(dataSource?.user_permission);

  // Read initial tab from ?tab= query param (e.g. after redirect from /new)
  const initialTab = (searchParams.get('tab') as Tab) ?? 'connection';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  // Keep URL in sync with active tab so refreshing lands on the correct tab
  const switchTab = (tab: Tab) => {
    setActiveTab(tab);
    router.replace(`/datasources/${datasourceId}?tab=${tab}`, { scroll: false });
  };

  const handleUpdate = async (data: DataSourceCreate, meta: { configModified: boolean }) => {
    try {
      await updateMutation.mutateAsync({
        id: datasourceId,
        data: {
          name: data.name,
          description: data.description,
          ...(meta.configModified ? { config: data.config } : {}),
        },
      });
    } catch (error: any) {
      alert(`Failed to update: ${error.response?.data?.detail || error.message}`);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!dataSource) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 gap-4">
        <p className="text-gray-500">Data source not found.</p>
        <Link href="/datasources" className="text-blue-600 hover:underline">
          Back to Data Sources
        </Link>
      </div>
    );
  }

  const typeLabel = TYPE_LABELS[dataSource.type] ?? dataSource.type;
  const typeColor = TYPE_COLORS[dataSource.type] ?? 'bg-gray-100 text-gray-600';

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'connection',
      label: 'Connection',
      icon: <Settings className="w-3.5 h-3.5" />,
    },
    {
      id: 'sync',
      label: 'Sync settings',
      icon: <RefreshCw className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Breadcrumb + Header */}
      <div className="px-8 pt-6 flex-shrink-0">
        <div className="mb-3">
          <Link
            href="/datasources"
            className="inline-flex items-center text-sm text-blue-600 hover:text-blue-700"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Data Sources
          </Link>
        </div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{dataSource.name}</h1>
            <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${typeColor}`}>
              {typeLabel}
            </span>
            {dataSource.description && (
              <span className="text-sm text-gray-400">{dataSource.description}</span>
            )}
          </div>
          {resPerms.canEdit && (
          <Link
            href={`/datasources/${datasourceId}/edit`}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-md hover:bg-gray-50 text-gray-600 bg-white"
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </Link>
          )}
        </div>
      </div>

      {/* Tabs card — stretches to fill remaining viewport height */}
      <div className="flex-1 flex flex-col mx-8 mb-6 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden min-h-0">
        {/* Tab nav */}
        <div className="flex border-b border-gray-100 flex-shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-700 bg-blue-50/40'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-hidden min-h-0">
          {activeTab === 'connection' && (
            <div className="h-full overflow-y-auto p-6">
              <DataSourceForm
                initialData={dataSource}
                onSubmit={handleUpdate}
                onCancel={() => router.push('/datasources')}
                isLoading={updateMutation.isPending}
              />
            </div>
          )}

          {activeTab === 'sync' && (
            <div className="h-full overflow-y-auto p-6">
              <SyncSettingsTab datasourceId={datasourceId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
