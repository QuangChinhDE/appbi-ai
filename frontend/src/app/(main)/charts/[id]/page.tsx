'use client';

import React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Edit, Trash2, Loader2 } from 'lucide-react';
import { useChart, useChartData, useDeleteChart } from '@/hooks/use-charts';
import { useDatasets } from '@/hooks/use-datasets';
import { ChartPreview } from '@/components/charts/ChartPreview';

export default function ChartDetailPage() {
  const params = useParams();
  const router = useRouter();
  const chartId = Number(params.id);

  const { data: chart, isLoading: isLoadingChart } = useChart(chartId);
  const { data: chartData, isLoading: isLoadingChartData } = useChartData(chartId);
  const { data: datasets } = useDatasets();
  const deleteMutation = useDeleteChart();

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this chart?')) return;

    try {
      await deleteMutation.mutateAsync(chartId);
      router.push('/charts');
    } catch (error) {
      console.error('Failed to delete chart:', error);
      alert('Failed to delete chart. Please try again.');
    }
  };

  if (isLoadingChart) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <span className="ml-2">Loading chart...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!chart) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="container mx-auto px-4 py-8">
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <p className="text-gray-500">Chart not found</p>
            <Link
              href="/charts"
              className="inline-flex items-center text-blue-600 hover:text-blue-700 mt-4"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Charts
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const dataset = datasets?.find(ds => ds.id === chart.dataset_id);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        {/* Navigation */}
        <div className="mb-6">
          <Link href="/charts" className="inline-flex items-center text-blue-600 hover:text-blue-700">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Charts
          </Link>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">{chart.name}</h1>
            {chart.description && (
              <p className="text-gray-600 mt-2">{chart.description}</p>
            )}
          </div>
          <div className="flex space-x-3">
            <Link
              href={`/charts?edit=${chartId}`}
              className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              <Edit className="h-5 w-5 mr-2" />
              Edit
            </Link>
            <button
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="flex items-center px-4 py-2 border border-red-300 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-5 w-5 mr-2" />
              )}
              Delete
            </button>
          </div>
        </div>

        {/* Chart Info */}
        <div className="bg-white p-6 rounded-lg border border-gray-200 mb-6">
          <h2 className="text-lg font-semibold mb-4">Chart Information</h2>
          <dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Type</dt>
              <dd className="mt-1 text-sm text-gray-900 capitalize">
                {chart.chart_type.replace('_', ' ')}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Dataset</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {dataset ? (
                  <Link
                    href={`/datasets?view=${dataset.id}`}
                    className="text-blue-600 hover:text-blue-700"
                  >
                    {dataset.name}
                  </Link>
                ) : (
                  'Unknown'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Created</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {new Date(chart.created_at).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        </div>

        {/* Configuration Details */}
        <div className="bg-white p-6 rounded-lg border border-gray-200 mb-6">
          <h2 className="text-lg font-semibold mb-4">Configuration</h2>
          <div className="bg-gray-50 p-4 rounded-md">
            <pre className="text-sm text-gray-700 overflow-x-auto">
              {JSON.stringify(chart.config, null, 2)}
            </pre>
          </div>
        </div>

        {/* Chart Visualization */}
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <h2 className="text-lg font-semibold mb-4">Visualization</h2>
          
          {isLoadingChartData && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              <span className="ml-2">Loading chart data...</span>
            </div>
          )}

          {chartData && !isLoadingChartData && (
            <div>
              <ChartPreview
                chartType={chart.chart_type}
                data={chartData.data}
                config={chart.config}
              />
              
              {chartData.meta && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="flex items-center justify-between text-sm text-gray-600">
                    {chartData.meta.row_count !== undefined && (
                      <span>{chartData.meta.row_count} rows</span>
                    )}
                    {chartData.meta.execution_time_ms !== undefined && (
                      <span>Executed in {chartData.meta.execution_time_ms}ms</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
