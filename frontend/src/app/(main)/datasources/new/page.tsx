'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Settings } from 'lucide-react';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import { useCreateDataSource } from '@/hooks/use-datasources';
import type { DataSourceCreate } from '@/types/api';

type Tab = 'connection';

export default function NewDataSourcePage() {
  const router = useRouter();
  const createMutation = useCreateDataSource();
  const [activeTab, setActiveTab] = useState<Tab>('connection');

  const handleCreate = async (data: DataSourceCreate, _meta: { configModified: boolean }) => {
    try {
      const created = await createMutation.mutateAsync(data);
      router.push(`/datasources/${created.id}?tab=connection`);
    } catch (error: any) {
      alert(`Failed to create data source: ${error.response?.data?.detail || error.message}`);
    }
  };

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
            className="inline-flex items-center text-sm text-blue-600 hover:text-blue-700"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Data Sources
          </Link>
        </div>
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-gray-900">New Data Source</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Configure the connection and query source data live.
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
                onClick={() => setActiveTab(tab.id)}
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
                  onSubmit={handleCreate}
                  onCancel={() => router.push('/datasources')}
                  isLoading={createMutation.isPending}
                />
              </div>
            )}

          </div>
        </div>
      </div>
  );
}

