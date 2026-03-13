/**
 * Modal for adding an explore chart to a dashboard
 */
'use client';

import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useDashboards } from '@/hooks/use-dashboards';

interface AddToDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  lookConfig: {
    source: {
      kind: string;
      workspaceId: number | null;
      tableId: number | null;
    };
    dimensions: string[];
    measures: string[];
    filters: any[];
    chartType: string;
  };
  onAdd: (dashboardId: number, chartTitle: string) => void;
}

export function AddToDashboardModal({
  isOpen,
  onClose,
  lookConfig,
  onAdd,
}: AddToDashboardModalProps) {
  const [selectedDashboardId, setSelectedDashboardId] = useState<number | null>(null);
  const [chartTitle, setChartTitle] = useState('');
  const { data: dashboards, isLoading } = useDashboards();

  console.log('AddToDashboardModal render:', { isOpen, dashboards: dashboards?.length });

  if (!isOpen) return null;

  const handleAdd = () => {
    if (selectedDashboardId && chartTitle.trim()) {
      onAdd(selectedDashboardId, chartTitle);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Add to Dashboard</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Chart Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Chart Title
            </label>
            <input
              type="text"
              value={chartTitle}
              onChange={(e) => setChartTitle(e.target.value)}
              placeholder="Enter chart title..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Dashboard Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Dashboard
            </label>
            {isLoading ? (
              <div className="text-sm text-gray-500">Loading dashboards...</div>
            ) : dashboards && dashboards.length > 0 ? (
              <select
                value={selectedDashboardId || ''}
                onChange={(e) => setSelectedDashboardId(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select a dashboard...</option>
                {dashboards.map((dashboard) => (
                  <option key={dashboard.id} value={dashboard.id}>
                    {dashboard.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-sm text-gray-500">
                No dashboards available. Create a dashboard first.
              </div>
            )}
          </div>

          {/* Preview Info */}
          <div className="bg-gray-50 rounded p-3">
            <p className="text-xs font-medium text-gray-700 mb-1">Chart Configuration:</p>
            <div className="text-xs text-gray-600 space-y-1">
              <p>Type: <span className="font-medium">{lookConfig.chartType}</span></p>
              <p>Dimensions: <span className="font-medium">{lookConfig.dimensions.join(', ') || 'None'}</span></p>
              <p>Measures: <span className="font-medium">{lookConfig.measures.join(', ') || 'None'}</span></p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!selectedDashboardId || !chartTitle.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
