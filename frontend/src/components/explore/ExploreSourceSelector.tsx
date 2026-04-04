/**
 * ExploreSourceSelector - Selects dataset and table for exploration
 */
'use client';

import React from 'react';
import { Database, Table as TableIcon, ChevronDown } from 'lucide-react';
import { useDatasets, useDataset } from '@/hooks/use-datasets';

interface ExploreSourceSelectorProps {
  selectedDatasetId: number | null;
  selectedTableId: number | null;
  onDatasetChange: (datasetId: number | null) => void;
  onTableChange: (tableId: number | null) => void;
}

export function ExploreSourceSelector({
  selectedDatasetId,
  selectedTableId,
  onDatasetChange,
  onTableChange,
}: ExploreSourceSelectorProps) {
  const { data: datasets = [], isLoading: loadingDatasets } = useDatasets();
  const { data: dataset } = useDataset(selectedDatasetId);

  const handleDatasetChange = (datasetId: string) => {
    const id = datasetId ? Number(datasetId) : null;
    onDatasetChange(id);
    onTableChange(null); // Reset table selection
  };

  const handleTableChange = (tableId: string) => {
    const id = tableId ? Number(tableId) : null;
    onTableChange(id);
  };

  return (
    <div className="space-y-4">
      {/* Dataset Selector */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-2 flex items-center gap-2">
          <Database className="w-3.5 h-3.5" />
          Dataset
        </label>
        <div className="relative">
          <select
            value={selectedDatasetId || ''}
            onChange={(e) => handleDatasetChange(e.target.value)}
            disabled={loadingDatasets}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white appearance-none pr-10"
          >
            <option value="">Select dataset...</option>
            {datasets.map((ws: any) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* Table Selector */}
      {selectedDatasetId && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2 flex items-center gap-2">
            <TableIcon className="w-3.5 h-3.5" />
            Table
          </label>
          <div className="relative">
            <select
              value={selectedTableId || ''}
              onChange={(e) => handleTableChange(e.target.value)}
              disabled={!dataset?.tables?.length}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white appearance-none pr-10"
            >
              <option value="">Select table...</option>
              {dataset?.tables?.map((table: any) => (
                <option key={table.id} value={table.id}>
                  {table.display_name || table.source_table_name}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          </div>
          {dataset && dataset.tables?.length === 0 && (
            <p className="text-xs text-gray-500 mt-1">
              No tables in this dataset. Add tables first.
            </p>
          )}
        </div>
      )}

    </div>
  );
}
