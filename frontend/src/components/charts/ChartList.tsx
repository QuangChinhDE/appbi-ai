'use client';

import React from 'react';
import { Edit, Trash2, Eye, BarChart3, Loader2 } from 'lucide-react';
import { Chart, ChartType, Dataset } from '@/types/api';

interface ChartListProps {
  charts: Chart[];
  datasets: Dataset[];
  onView: (chart: Chart) => void;
  onEdit: (chart: Chart) => void;
  onDelete: (id: number) => void;
  deletingId?: number;
}

export function ChartList({
  charts,
  datasets,
  onView,
  onEdit,
  onDelete,
  deletingId,
}: ChartListProps) {
  const getDatasetName = (datasetId: number | null | undefined) => {
    if (!datasetId) return 'Workspace Table';
    const dataset = datasets.find((ds) => ds.id === datasetId);
    return dataset?.name || 'Unknown';
  };

  const getChartTypeLabel = (type: ChartType) => {
    switch (type) {
      case ChartType.BAR:
        return 'Bar Chart';
      case ChartType.LINE:
        return 'Line Chart';
      case ChartType.PIE:
        return 'Pie Chart';
      case ChartType.TIME_SERIES:
        return 'Time Series';
      default:
        return type;
    }
  };

  const getChartTypeColor = (type: ChartType) => {
    switch (type) {
      case ChartType.BAR:
        return 'bg-blue-100 text-blue-800';
      case ChartType.LINE:
        return 'bg-green-100 text-green-800';
      case ChartType.PIE:
        return 'bg-purple-100 text-purple-800';
      case ChartType.TIME_SERIES:
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (charts.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
        <BarChart3 className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">No charts yet</h3>
        <p className="text-gray-500">
          Create your first chart to visualize your dataset.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Dataset
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Created
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {charts.map((chart) => (
            <tr key={chart.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">
                  {chart.name}
                </div>
                {chart.description && (
                  <div className="text-sm text-gray-500">{chart.description}</div>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getChartTypeColor(
                    chart.chart_type
                  )}`}
                >
                  {getChartTypeLabel(chart.chart_type)}
                </span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {getDatasetName(chart.dataset_id)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(chart.created_at).toLocaleDateString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <div className="flex justify-end space-x-2">
                  <button
                    onClick={() => onView(chart)}
                    className="text-blue-600 hover:text-blue-900"
                    title="View chart"
                  >
                    <Eye className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => onEdit(chart)}
                    className="text-gray-600 hover:text-gray-900"
                    title="Edit chart"
                  >
                    <Edit className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => onDelete(chart.id)}
                    disabled={deletingId === chart.id}
                    className="text-red-600 hover:text-red-900 disabled:opacity-50"
                    title="Delete chart"
                  >
                    {deletingId === chart.id ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Trash2 className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
