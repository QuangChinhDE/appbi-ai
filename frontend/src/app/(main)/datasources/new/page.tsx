'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Settings, RefreshCw, Lock } from 'lucide-react';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import { useCreateDataSource } from '@/hooks/use-datasources';
import type { DataSourceCreate } from '@/types/api';

type Tab = 'connection' | 'sync';

export default function NewDataSourcePage() {
  const router = useRouter();
  const createMutation = useCreateDataSource();
  const [activeTab, setActiveTab] = useState<Tab>('connection');

  const handleCreate = async (data: DataSourceCreate, _meta: { configModified: boolean }) => {
    try {
      const created = await createMutation.mutateAsync(data);
      // Redirect to detail page with Tables tab active so user can explore immediately
      router.push(`/datasources/${created.id}?tab=sync`);
    } catch (error: any) {
      alert(`Failed to create data source: ${error.response?.data?.detail || error.message}`);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode; locked: boolean }[] = [
    {
      id: 'connection',
      label: 'Connection',
      icon: <Settings className="w-3.5 h-3.5" />,
      locked: false,
    },
    {
      id: 'sync',
      label: 'Sync settings',
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      locked: true,
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
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-gray-900">New Data Source</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Configure connection, explore tables and set up sync schedule.
          </p>
        </div>
      </div>

      {/* Tabs card — stretches to fill remaining viewport height */}
      <div className="flex-1 flex flex-col mx-8 mb-6 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden min-h-0">
        {/* Tab nav */}
        <div className="flex border-b border-gray-100 flex-shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => !tab.locked && setActiveTab(tab.id)}
                disabled={tab.locked}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                  tab.locked
                    ? 'border-transparent text-gray-300 cursor-not-allowed'
                    : activeTab === tab.id
                    ? 'border-blue-600 text-blue-700 bg-blue-50/40'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                {tab.icon}
                {tab.label}
                {tab.locked && <Lock className="w-3 h-3 ml-0.5 opacity-50" />}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden min-h-0">
            {activeTab === 'connection' && (
              <div className="h-full overflow-y-auto p-6">
                <DataSourceForm
                  onSubmit={handleCreate}
                  onCancel={() => router.push('/datasources')}
                  isLoading={createMutation.isPending}
                />
              </div>
            )}

            {/* Locked sync tab */}
            {activeTab === 'sync' && (
              <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
                <Lock className="w-8 h-8 text-gray-200" />
                <p className="text-sm font-medium">Save connection settings first</p>
                <p className="text-xs text-gray-400 max-w-xs text-center">
                  Complete and save the Connection tab to unlock Sync settings.
                </p>
                <button
                  onClick={() => setActiveTab('connection')}
                  className="mt-2 text-sm text-blue-600 hover:underline"
                >
                  Go to Connection
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
  );
}

