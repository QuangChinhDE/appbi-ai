'use client';

import { useCallback, useEffect, useState, startTransition } from 'react';
import Link from 'next/link';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { Loader2, Settings, Pencil } from 'lucide-react';
import { useDataSource, useUpdateDataSource } from '@/hooks/use-datasources';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import type { DataSourceCreate } from '@/types/api';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { SourceHealthBadge } from '@/components/datasources/SourceHealth';
import { toast } from '@/lib/toast';
import { DetailHeader } from '@/components/common/DetailHeader';
import { useI18n } from '@/providers/LanguageProvider';

type Tab = 'connection';

function isValidTab(tab: string | null): tab is Tab {
  return tab === 'connection';
}

const TYPE_LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  bigquery: 'BigQuery',
  google_sheets: 'Google Sheets',
  google_docs: 'Google Docs',
  manual: 'Manual',
};

const TYPE_COLORS: Record<string, string> = {
  postgresql: 'bg-brand/15 text-brand',
  mysql: 'bg-warning/15 text-warning',
  bigquery: 'bg-success/15 text-success',
  google_sheets: 'bg-success/15 text-success',
  google_docs: 'bg-info/15 text-info',
  manual: 'bg-surface-2 text-text-secondary',
};

export default function DataSourceDetailPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const datasourceId = parseInt(id, 10);

  const { data: dataSource, isLoading } = useDataSource(datasourceId);
  const updateMutation = useUpdateDataSource();
  const resPerms = getResourcePermissions(dataSource?.user_permission, dataSource?.access_capabilities);

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
          config_version: dataSource?.config_version,
          ...(meta.configModified ? { config: data.config } : {}),
        },
      });
      toast.success('Data source updated', {
        description: data.name,
      });
    } catch (error: any) {
      toast.error(`Failed to update: ${typeof error.response?.data?.detail === 'string' ? error.response.data.detail : error.response?.data?.detail?.message || error.message}`);
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
        <p className="text-text-tertiary">{t('datasources.detail.notFound')}</p>
        <Link href="/datasources" className="text-brand hover:underline">
          {t('datasources.detail.backToList')}
        </Link>
      </div>
    );
  }

  const typeLabel = TYPE_LABELS[dataSource.type] ?? dataSource.type;
  const typeColor = TYPE_COLORS[dataSource.type] ?? 'bg-surface-2 text-text-secondary';
  const createdAt = new Date(dataSource.created_at).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'connection',
      label: t('datasources.detail.connection'),
      icon: <Settings className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        testId="datasource-header"
        back={{ label: t('datasources.detail.back'), onClick: () => router.push('/datasources') }}
        title={<h1 className="truncate text-sm font-medium" title={dataSource.name}>{dataSource.name}</h1>}
        status={<SourceHealthBadge source={dataSource} />}
        meta={
          <span className="inline-flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${typeColor}`}>{typeLabel}</span>
            <span>{t('datasources.detail.created', { date: createdAt })}</span>
            {dataSource.owner_email && (
              <>
                <span>{t('datasources.detail.createdBy')}</span>
                <OwnerBadge email={dataSource.owner_email} />
              </>
            )}
          </span>
        }
        actions={
          resPerms.canEdit ? (
            <Link
              href={`/datasources/${datasourceId}/edit`}
              data-testid="datasource-edit"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-xs text-text-secondary hover:bg-surface-2"
            >
              <Pencil className="w-3.5 h-3.5" />
              {t('datasources.detail.edit')}
            </Link>
          ) : null
        }
      />
      {dataSource.description && (
        <p className="shrink-0 truncate px-4 pt-3 text-sm text-text-tertiary sm:px-8" title={dataSource.description}>
          {dataSource.description}
        </p>
      )}

      {/* Tabs card — stretches to fill remaining viewport height */}
      <div className="mx-3 mb-4 mt-3 flex min-h-0 flex-1 sm:mx-8 sm:mb-6 flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        {/* Tab nav */}
        {tabs.length > 1 && (
        <div role="tablist" className="flex border-b border-[rgb(var(--border-line))] flex-shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
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
        )}

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
