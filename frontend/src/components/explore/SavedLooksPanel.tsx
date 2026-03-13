'use client';

import React, { useState } from 'react';
import { Search, BarChart3, Loader2, Trash2, Eye } from 'lucide-react';
import { Chart, ChartType } from '@/types/api';
import { useCharts, useDeleteChart } from '@/hooks/use-charts';
import { useDatasets } from '@/hooks/use-datasets';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface SavedLooksPanelProps {
  onLoadLook: (chart: Chart) => void;
  currentLookId?: number | null;
}

export function SavedLooksPanel({ onLoadLook, currentLookId }: SavedLooksPanelProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; id: number | null }>({
    isOpen: false,
    id: null,
  });

  const { data: charts, isLoading: isLoadingCharts } = useCharts();
  const { data: datasets } = useDatasets();
  const deleteMutation = useDeleteChart();

  const getDatasetName = (datasetId: number) => {
    const dataset = datasets?.find((ds) => ds.id === datasetId);
    return dataset?.name || 'Unknown';
  };

  const getChartTypeLabel = (type: ChartType) => {
    switch (type) {
      case ChartType.BAR:
        return 'Bar';
      case ChartType.LINE:
        return 'Line';
      case ChartType.PIE:
        return 'Pie';
      case ChartType.TIME_SERIES:
        return 'Time Series';
      case ChartType.TABLE:
        return 'Table';
      case ChartType.AREA:
        return 'Area';
      case ChartType.STACKED_BAR:
        return 'Stacked Bar';
      case ChartType.GROUPED_BAR:
        return 'Grouped Bar';
      case ChartType.SCATTER:
        return 'Scatter';
      case ChartType.KPI:
        return 'KPI';
      default:
        return type;
    }
  };

  const getChartTypeColor = (type: ChartType) => {
    switch (type) {
      case ChartType.BAR:
        return 'bg-blue-100 text-blue-700';
      case ChartType.LINE:
        return 'bg-green-100 text-green-700';
      case ChartType.PIE:
        return 'bg-purple-100 text-purple-700';
      case ChartType.TIME_SERIES:
        return 'bg-orange-100 text-orange-700';
      case ChartType.TABLE:
        return 'bg-gray-100 text-gray-700';
      case ChartType.AREA:
        return 'bg-teal-100 text-teal-700';
      case ChartType.STACKED_BAR:
        return 'bg-indigo-100 text-indigo-700';
      case ChartType.GROUPED_BAR:
        return 'bg-cyan-100 text-cyan-700';
      case ChartType.SCATTER:
        return 'bg-pink-100 text-pink-700';
      case ChartType.KPI:
        return 'bg-amber-100 text-amber-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  const handleDelete = (id: number) => {
    setDeleteConfirm({ isOpen: true, id });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm.id) return;

    try {
      await deleteMutation.mutateAsync(deleteConfirm.id);
      setDeleteConfirm({ isOpen: false, id: null });
    } catch (error) {
      console.error('Failed to delete look:', error);
    }
  };

  // Filter charts based on search
  const filteredCharts = charts?.filter((chart) => {
    const matchesSearch = chart.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      chart.description?.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesSearch;
  }) || [];

  return (
    <>
      <div className="h-full flex flex-col bg-white border-l border-gray-200">
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Saved Looks</h2>
          
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search looks..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Count */}
          <p className="text-xs text-gray-500 mt-2">
            {filteredCharts.length} look{filteredCharts.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Loading State */}
        {isLoadingCharts && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          </div>
        )}

        {/* Empty State */}
        {!isLoadingCharts && filteredCharts.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <BarChart3 className="h-12 w-12 text-gray-300 mb-3" />
            <p className="text-sm text-gray-500">
              {searchTerm ? 'No looks match your search' : 'No saved looks yet'}
            </p>
            {!searchTerm && (
              <p className="text-xs text-gray-400 mt-1">
                Save your first look to see it here
              </p>
            )}
          </div>
        )}

        {/* Looks List */}
        {!isLoadingCharts && filteredCharts.length > 0 && (
          <div className="flex-1 overflow-y-auto">
            <div className="p-2 space-y-1">
              {filteredCharts.map((chart) => (
                <div
                  key={chart.id}
                  className={`group p-3 rounded-lg border transition-all cursor-pointer ${
                    currentLookId === chart.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <button
                      onClick={() => onLoadLook(chart)}
                      className="flex-1 text-left"
                    >
                      <div className="flex items-center space-x-2 mb-1">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {chart.name}
                        </span>
                        {currentLookId === chart.id && (
                          <Eye className="h-3.5 w-3.5 text-blue-600 flex-shrink-0" />
                        )}
                      </div>
                      
                      {chart.description && (
                        <p className="text-xs text-gray-500 line-clamp-2 mb-2">
                          {chart.description}
                        </p>
                      )}

                      <div className="flex items-center space-x-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getChartTypeColor(chart.chart_type)}`}>
                          {getChartTypeLabel(chart.chart_type)}
                        </span>
                        {chart.config?.palette && chart.config.palette !== 'default' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 uppercase">
                            {chart.config.palette}
                          </span>
                        )}
                        <span className="text-xs text-gray-500">
                          {getDatasetName(chart.dataset_id)}
                        </span>
                      </div>
                    </button>

                    {/* Delete Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(chart.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-600 transition-all ml-2"
                      title="Delete look"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null })}
        onConfirm={confirmDelete}
        title="Delete Look"
        description="Are you sure you want to delete this look? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
