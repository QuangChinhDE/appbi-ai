'use client';

import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
import DataSourceForm from '@/components/datasources/DataSourceForm';
import { useDataSource, useUpdateDataSource } from '@/hooks/use-datasources';
import type { DataSourceCreate } from '@/types/api';

export default function EditDataSourcePage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const datasourceId = parseInt(id, 10);

  const { data: dataSource, isLoading } = useDataSource(datasourceId);
  const updateMutation = useUpdateDataSource();

  const handleUpdate = async (data: DataSourceCreate, meta: { configModified: boolean }) => {
    try {
      await updateMutation.mutateAsync({
        id: datasourceId,
        data: {
          name: data.name,
          description: data.description,
          // Only resend config when the user actually re-imported data.
          // Skipping it for a rename avoids sending potentially large Manual Table payloads.
          ...(meta.configModified ? { config: data.config } : {}),
        },
      });
      router.push('/datasources');
    } catch (error: any) {
      alert(`Failed to update data source: ${error.response?.data?.detail || error.message}`);
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
          <h2 className="text-2xl font-bold mb-6">Edit Data Source</h2>
          <DataSourceForm
            initialData={dataSource}
            onSubmit={handleUpdate}
            onCancel={() => router.push('/datasources')}
            isLoading={updateMutation.isPending}
          />
        </div>
      </div>
    </div>
  );
}
