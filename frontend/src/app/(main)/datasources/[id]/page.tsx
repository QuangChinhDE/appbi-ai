'use client';

import { useCallback, useEffect, useState, startTransition } from 'react';
import Link from 'next/link';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, Settings, Pencil } from 'lucide-react';
import { useDataSource, useUpdateDataSource } from '@/hooks/use-datasources';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import type { DataSourceCreate } from '@/types/api';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { toast } from '@/lib/toast';

type Tab = 'connection';

function isValidTab(tab: string | null): tab is Tab {
  return tab === 'connection';
}

const TYPE_LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  bigquery: 'BigQuery',
  google_sheets: 'Google Sheets',
  manual: 'Manual',
};

const TYPE_COLORS: Record<string, string> = {
  postgresql: 'bg-brand/15 text-brand',
  mysql: 'bg-warning/15 text-warning',
  bigquery: 'bg-success/15 text-success',
  google_sheets: 'bg-success/15 text-success',
  manual: 'bg-surface-2 text-text-secondary',
};

export default function DataSourceDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const datasourceId = parseInt(id, 10);

  const { data: dataSource, isLoading } = useDataSource(datasourceId);
  const updateMutation = useUpdateDataSource();
  const resPerms = getResourcePermissions(dataSource?.user_permission);

  // Read initial tab from ?tab= query param — fallback to 'connection' for unknown values
  const paramTab = searchParams.get('tab') as Tab;
  const initialTab: Tab = isValidTab(paramTab) ? paramTab : 'connection';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    const nextTab: Tab = isValidTab(paramTab) ? paramTab : 'connection';
    if (nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
  }, [activeTab, paramTab]);

  const syncTabInUrl = useCallback((tab: Tab) => {
    if (typeof window === 'undefined') return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('tab', tab);
    window.history.replaceState(window.history.state, '', nextUrl.toString());
  }, []);

  // Keep URL in sync with active tab so refreshing lands on the correct tab
  const switchTab = (tab: Tab) => {
    if (tab === activeTab) return;
    startTransition(() => setActiveTab(tab));
    syncTabInUrl(tab);
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
      toast.success('Data source updated', {
        description: data.name,
      });
    } catch (error: any) {
      toast.error(`Failed to update: ${error.response?.data?.detail || error.message}`);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface-2">
        <Loader2 className="w-8 h-8 animate-spin text-brand" />
      </div>
    );
  }

  if (!dataSource) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-surface-2 gap-4">
        <p className="text-text-tertiary">Data source not found.</p>
        <Link href="/datasources" className="text-brand hover:underline">
          Back to Data Sources
        </Link>
      </div>
    );
  }

  const typeLabel = TYPE_LABELS[dataSource.type] ?? dataSource.type;
  const typeColor = TYPE_COLORS[dataSource.type] ?? 'bg-surface-2 text-text-secondary';
  const createdAt = new Date(dataSource.created_at).toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'connection',
      label: 'Connection',
      icon: <Settings className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Breadcrumb + Header */}
      <div className="px-8 pt-6 flex-shrink-0">
        <div className="mb-3">
          <Link
            href="/datasources"
            className="inline-flex items-center text-sm text-brand hover:text-brand"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Data Sources
          </Link>
        </div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-text-primary">{dataSource.name}</h1>
              <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${typeColor}`}>
                {typeLabel}
              </span>
              {dataSource.description && (
                <span className="text-sm text-text-quaternary">{dataSource.description}</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text-tertiary">
              <span>Created {createdAt}</span>
              {dataSource.owner_email && (
                <>
                  <span className="text-text-quaternary">•</span>
                  <span>Created by</span>
                  <OwnerBadge email={dataSource.owner_email} />
                </>
              )}
            </div>
          </div>
          {resPerms.canEdit && (
          <Link
            href={`/datasources/${datasourceId}/edit`}
            className="flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2"
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </Link>
          )}
        </div>
      </div>

      {/* Tabs card — stretches to fill remaining viewport height */}
      <div className="mx-8 mb-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        {/* Tab nav */}
        <div className="flex border-b border-[rgb(var(--border-line))] flex-shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-brand text-brand bg-brand/10/40'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2'
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
                readOnly={!resPerms.canEdit}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
