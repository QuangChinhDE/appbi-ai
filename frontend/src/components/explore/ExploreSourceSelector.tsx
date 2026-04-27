/**
 * ExploreSourceSelector - Selects dataset and table for exploration
 */
'use client';

import React from 'react';
import { Database, Table as TableIcon } from 'lucide-react';
import { useDatasets, useDataset } from '@/hooks/use-datasets';
import { FieldGroup, Select } from '@/components/ui/Input';

interface ExploreSourceSelectorProps {
  selectedDatasetId: number | null;
  selectedTableId: number | null;
  onDatasetChange: (datasetId: number | null) => void;
  onTableChange: (tableId: number | null) => void;
  disabled?: boolean;
  variant?: 'stacked' | 'compact';
  /**
   * When true, the dataset dropdown is locked but the table dropdown stays
   * interactive. Useful in wizard flows that have already committed to a
   * dataset and only want the user to switch tables inside it.
   */
  lockDataset?: boolean;
}

export function ExploreSourceSelector({
  selectedDatasetId,
  selectedTableId,
  onDatasetChange,
  onTableChange,
  disabled,
  variant = 'stacked',
  lockDataset = false,
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

  if (variant === 'compact') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-[11rem] flex-1 sm:w-48 sm:flex-none">
          <Select
            size="sm"
            value={selectedDatasetId || ''}
            onChange={(e) => handleDatasetChange(e.target.value)}
            disabled={disabled || lockDataset || loadingDatasets}
          >
            <option value="">Select dataset...</option>
            {datasets.map((ws: any) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </Select>
        </div>

        {selectedDatasetId && (
          <div className="min-w-[12rem] flex-1 sm:w-56 sm:flex-none">
            <Select
              size="sm"
              value={selectedTableId || ''}
              onChange={(e) => handleTableChange(e.target.value)}
              disabled={disabled || !dataset?.tables?.length}
            >
              <option value="">Select table...</option>
              {dataset?.tables?.map((table: any) => (
                <option key={table.id} value={table.id}>
                  {table.display_name || table.source_table_name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FieldGroup
        label={(
          <span className="inline-flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5" />
            Dataset
          </span>
        )}
      >
        <Select
          size="sm"
          value={selectedDatasetId || ''}
          onChange={(e) => handleDatasetChange(e.target.value)}
          disabled={disabled || lockDataset || loadingDatasets}
        >
          <option value="">Select dataset...</option>
          {datasets.map((ws: any) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </Select>
      </FieldGroup>

      {selectedDatasetId && (
        <FieldGroup
          label={(
            <span className="inline-flex items-center gap-1.5">
              <TableIcon className="h-3.5 w-3.5" />
              Table
            </span>
          )}
          description={
            dataset && dataset.tables?.length === 0
              ? 'No tables in this dataset. Add tables first.'
              : undefined
          }
        >
          <Select
            size="sm"
            value={selectedTableId || ''}
            onChange={(e) => handleTableChange(e.target.value)}
            disabled={disabled || !dataset?.tables?.length}
          >
            <option value="">Select table...</option>
            {dataset?.tables?.map((table: any) => (
              <option key={table.id} value={table.id}>
                {table.display_name || table.source_table_name}
              </option>
            ))}
          </Select>
        </FieldGroup>
      )}
    </div>
  );
}
