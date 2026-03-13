'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, Loader2 } from 'lucide-react';
import { Chart, ChartCreate, ChartUpdate } from '@/types/api';
import { useCharts, useCreateChart, useUpdateChart, useDeleteChart, useChartData } from '@/hooks/use-charts';
import { useDatasets } from '@/hooks/use-datasets';
import { ChartList } from '@/components/charts/ChartList';
import { ChartBuilder } from '@/components/charts/ChartBuilder';
import { ChartPreview } from '@/components/charts/ChartPreview';

type ViewMode = 'list' | 'create' | 'edit' | 'view';

export default function ChartsPage() {
  const [currentView, setCurrentView] = useState<ViewMode>('list');
  const [selectedChart, setSelectedChart] = useState<Chart | null>(null);
  const [deletingId, setDeletingId] = useState<number | undefined>();

  const { data: charts, isLoading: isLoadingCharts } = useCharts();
  const { data: datasets } = useDatasets();
  const { data: chartData, isLoading: isLoadingChartData } = useChartData(
    selectedChart?.id || 0
  );
  
  const createMutation = useCreateChart();
  const updateMutation = useUpdateChart();
  const deleteMutation = useDeleteChart();

  const handleCreate = async (data: ChartCreate | ChartUpdate) => {
    try {
      await createMutation.mutateAsync(data as ChartCreate);
      setCurrentView('list');
      setSelectedChart(null);
    } catch (error) {
      console.error('Failed to create chart:', error);
    }
  };

  const handleUpdate = async (data: ChartCreate | ChartUpdate) => {
    if (!selectedChart) return;
    
    try {
      await updateMutation.mutateAsync({ id: selectedChart.id, data: data as ChartUpdate });
      setCurrentView('list');
      setSelectedChart(null);
    } catch (error) {
      console.error('Failed to update chart:', error);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this chart?')) return;
    
    setDeletingId(id);
    try {
      await deleteMutation.mutateAsync(id);
    } catch (error) {
      console.error('Failed to delete chart:', error);
    } finally {
      setDeletingId(undefined);
    }
  };

  const handleView = (chart: Chart) => {
    setSelectedChart(chart);
    setCurrentView('view');
  };

  const handleEdit = (chart: Chart) => {
    setSelectedChart(chart);
    setCurrentView('edit');
  };

  const handleCancel = () => {
    setCurrentView('list');
    setSelectedChart(null);
  };

  const renderContent = () => {
    // Create view
    if (currentView === 'create') {
      return (
        <ChartBuilder
          onSave={handleCreate}
          onCancel={handleCancel}
          isSaving={createMutation.isPending}
        />
      );
    }

    // Edit view
    if (currentView === 'edit' && selectedChart) {
      return (
        <ChartBuilder
          initialData={selectedChart}
          onSave={handleUpdate}
          onCancel={handleCancel}
          isSaving={updateMutation.isPending}
        />
      );
    }

    // View chart
    if (currentView === 'view' && selectedChart) {
      return (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={handleCancel}
                className="text-gray-600 hover:text-gray-900"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <h2 className="text-2xl font-bold">{selectedChart.name}</h2>
                {selectedChart.description && (
                  <p className="text-gray-600 mt-1">{selectedChart.description}</p>
                )}
              </div>
            </div>
            <button
              onClick={() => handleEdit(selectedChart)}
              className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Edit Chart
            </button>
          </div>

          {/* Chart Info */}
          <div className="bg-white p-6 rounded-lg border border-gray-200">
            <dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <dt className="text-sm font-medium text-gray-500">Type</dt>
                <dd className="mt-1 text-sm text-gray-900 capitalize">
                  {selectedChart.chart_type.replace('_', ' ')}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Dataset</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {datasets?.find(ds => ds.id === selectedChart.dataset_id)?.name || 'Unknown'}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Created</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {new Date(selectedChart.created_at).toLocaleDateString()}
                </dd>
              </div>
            </dl>
          </div>

          {/* Chart Display */}
          <div className="bg-white p-6 rounded-lg border border-gray-200">
            {isLoadingChartData && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                <span className="ml-2">Loading chart data...</span>
              </div>
            )}

            {chartData && !isLoadingChartData && (
              <ChartPreview
                chartType={selectedChart.chart_type}
                data={chartData.data}
                config={selectedChart.config}
              />
            )}
          </div>
        </div>
      );
    }

    // List view (default)
    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Charts</h2>
          <button
            onClick={() => setCurrentView('create')}
            className="flex items-center px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
          >
            <Plus className="h-5 w-5 mr-2" />
            Create Chart
          </button>
        </div>

        {/* Loading State */}
        {isLoadingCharts && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <span className="ml-2">Loading charts...</span>
          </div>
        )}

        {/* Chart List */}
        {!isLoadingCharts && charts && datasets && (
          <ChartList
            charts={charts}
            datasets={datasets}
            onView={handleView}
            onEdit={handleEdit}
            onDelete={handleDelete}
            deletingId={deletingId}
          />
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        {/* Navigation */}
        {currentView === 'list' && (
          <div className="mb-6">
            <Link href="/" className="inline-flex items-center text-blue-600 hover:text-blue-700">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Home
            </Link>
          </div>
        )}

        {/* Main Content */}
        {renderContent()}
      </div>
    </div>
  );
}
