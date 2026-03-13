'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import { useCreateDataSource } from '@/hooks/use-datasources';
import type { DataSourceCreate } from '@/types/api';

export default function NewDataSourcePage() {
  const router = useRouter();
  const createMutation = useCreateDataSource();

  const handleCreate = async (data: DataSourceCreate) => {
    try {
      await createMutation.mutateAsync(data);
      router.push('/datasources');
    } catch (error: any) {
      alert(`Failed to create data source: ${error.response?.data?.detail || error.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <Link href="/datasources" className="inline-flex items-center text-blue-600 hover:text-blue-700">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Data Sources
          </Link>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-2xl font-bold mb-6">Create Data Source</h2>
          <DataSourceForm
            onSubmit={handleCreate}
            onCancel={() => router.push('/datasources')}
            isLoading={createMutation.isPending}
          />
        </div>
      </div>
    </div>
  );
}
