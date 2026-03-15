/**
 * Explore — list of saved charts.
 */
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, BarChart3, Clock, Layers, Search } from 'lucide-react';
import { useCharts, useDeleteChart } from '@/hooks/use-charts';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { PageListLayout } from '@/components/common/PageListLayout';
import { toast } from 'sonner';
import type { Chart } from '@/types/api';

const CHART_TYPE_LABELS: Record<string, string> = {
  BAR: 'Bar', LINE: 'Line', PIE: 'Pie', TIME_SERIES: 'Time Series',
  AREA: 'Area', STACKED_BAR: 'Stacked Bar', GROUPED_BAR: 'Grouped Bar',
  SCATTER: 'Scatter', KPI: 'KPI', TABLE: 'Table',
};

export default function ExplorePage() {
  const router = useRouter();
  const { data: charts, isLoading } = useCharts();
  const deleteChart = useDeleteChart();
  const [chartToDelete, setChartToDelete] = useState<Chart | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingChart, setIsDeletingChart] = useState(false);

  const handleDeleteChart = (chart: Chart) => {
    setChartToDelete(chart);
    setDeleteConstraints(null);
  };

  const confirmDeleteChart = async () => {
    if (!chartToDelete) return;
    setIsDeletingChart(true);
    try {
      await deleteChart.mutateAsync(chartToDelete.id);
      toast.success(`Đã xóa biểu đồ "${chartToDelete.name}"`);
      setChartToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        toast.error(`Không thể xóa: ${detail || error.message}`);
        setChartToDelete(null);
      }
    } finally {
      setIsDeletingChart(false);
    }
  };

  return (
    <>
    <PageListLayout
      title="Explore"
      description={`${charts?.length ?? 0} saved chart${charts?.length !== 1 ? 's' : ''}`}
      action={
        <button
          onClick={() => router.push('/explore/new')}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Chart
        </button>
      }
      isLoading={isLoading}
      loadingText="Loading charts…"
    >
      {({ viewMode, filterText }) => {
        const filtered = (charts ?? []).filter(c =>
          c.name.toLowerCase().includes(filterText.toLowerCase()) ||
          (CHART_TYPE_LABELS[c.chart_type] ?? c.chart_type).toLowerCase().includes(filterText.toLowerCase())
        );

        if (!charts || charts.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <BarChart3 className="w-14 h-14 text-gray-300 mb-4" />
              <h3 className="text-lg font-medium text-gray-700 mb-1">No saved charts yet</h3>
              <p className="text-sm text-gray-500 mb-4">Create your first chart from a workspace table</p>
              <button
                onClick={() => router.push('/explore/new')}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Chart
              </button>
            </div>
          );
        }

        if (filtered.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <Search className="w-8 h-8 text-gray-300 mb-2" />
              <p className="text-sm text-gray-500">No charts matching "<strong>{filterText}</strong>"</p>
            </div>
          );
        }

        if (viewMode === 'list') {
          return (
            <div className="flex flex-col divide-y divide-gray-100 border border-gray-200 rounded-lg bg-white overflow-hidden">
              {filtered.map(chart => {
                const config = chart.config as any;
                const typeLabel = CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type;
                const createdAt = new Date(chart.created_at).toLocaleDateString('vi-VN', {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                });
                return (
                  <div
                    key={chart.id}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 cursor-pointer group"
                    onClick={() => router.push('/explore/' + chart.id)}
                  >
                    <div className="w-8 h-8 rounded-md bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <BarChart3 className="w-4 h-4 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{chart.name}</p>
                      {chart.description ? (
                        <p className="text-xs text-gray-500 truncate">{chart.description}</p>
                      ) : config?.roleConfig?.dimension ? (
                        <p className="text-xs text-gray-500 truncate flex items-center gap-1">
                          <Layers className="w-3 h-3 flex-shrink-0" />
                          {config.roleConfig.dimension}
                        </p>
                      ) : null}
                    </div>
                    <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-medium flex-shrink-0">
                      {typeLabel}
                    </span>
                    <span className="text-xs text-gray-400 flex items-center gap-1 flex-shrink-0">
                      <Clock className="w-3 h-3" />
                      {createdAt}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteChart(chart); }}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 transition-all p-1 rounded flex-shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          );
        }

        // Grid view
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map(chart => {
              const config = chart.config as any;
              const typeLabel = CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type;
              const createdAt = new Date(chart.created_at).toLocaleDateString('vi-VN', {
                day: '2-digit', month: '2-digit', year: 'numeric',
              });
              return (
                <div
                  key={chart.id}
                  className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-3 hover:shadow-md transition-shadow cursor-pointer group"
                  onClick={() => router.push('/explore/' + chart.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <BarChart3 className="w-5 h-5 text-blue-600" />
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteChart(chart); }}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 transition-all p-1 rounded"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate text-sm">{chart.name}</h3>
                    {chart.description ? (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{chart.description}</p>
                    ) : config?.roleConfig?.dimension && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate flex items-center gap-1">
                        <Layers className="w-3 h-3 flex-shrink-0" />
                        {config.roleConfig.dimension}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-medium">
                      {typeLabel}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {createdAt}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      }}
    </PageListLayout>
    {chartToDelete && (
      <DeleteConstraintModal
        itemName={chartToDelete.name}
        itemTypeLabel="biểu đồ"
        constraints={deleteConstraints}
        isDeleting={isDeletingChart}
        onConfirm={confirmDeleteChart}
        onClose={() => { setChartToDelete(null); setDeleteConstraints(null); }}
      />
    )}
    </>
  );
}
