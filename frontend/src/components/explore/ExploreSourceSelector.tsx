/**
 * ExploreSourceSelector - Selects dataset and table for exploration.
 *
 * Phase-11: chọn Dataset là đủ — table được auto-pick (first table) khi user
 * chưa chọn. User vẫn override được nếu muốn anchor chart vào table khác.
 * Giảm friction so với flow cũ ép chọn 2 dropdown tuần tự.
 */
'use client';

import React, { useEffect } from 'react';
import { Database, Table as TableIcon } from 'lucide-react';
import { useDatasets, useDataset } from '@/hooks/use-datasets';
import { FieldGroup, Select } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';

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
  /**
   * Phase-15.10: hide the table dropdown entirely. Used when the host derives
   * the base table from picked fields (PowerBI-style flow) instead of asking
   * upfront. Dataset stays visible because user still needs to pick a model.
   */
  hideTable?: boolean;
}

export function ExploreSourceSelector({
  selectedDatasetId,
  selectedTableId,
  onDatasetChange,
  onTableChange,
  disabled,
  variant = 'stacked',
  lockDataset = false,
  hideTable = false,
}: ExploreSourceSelectorProps) {
  const { t } = useI18n();
  const { data: datasets = [], isLoading: loadingDatasets } = useDatasets();
  const { data: dataset } = useDataset(selectedDatasetId);

  const handleDatasetChange = (datasetId: string) => {
    const id = datasetId ? Number(datasetId) : null;
    onDatasetChange(id);
    onTableChange(null); // Reset; auto-pick effect below sẽ chọn lại
  };

  const handleTableChange = (tableId: string) => {
    const id = tableId ? Number(tableId) : null;
    onTableChange(id);
  };

  // Phase-11: auto-pick first table khi user mới chọn dataset (selectedTableId = null).
  // User vẫn override được bằng dropdown bên dưới.
  //
  // Phase-15.10: skip auto-pick when `hideTable` is true. Host derives base
  // from picked fields in that case — setting selectedTableId here would
  // anchor JOINs to an arbitrary first table before the user has any intent.
  useEffect(() => {
    if (hideTable) return;
    if (selectedDatasetId == null) return;
    if (selectedTableId != null) return;
    const firstTable = dataset?.tables?.[0];
    if (firstTable?.id) {
      onTableChange(firstTable.id);
    }
  }, [hideTable, selectedDatasetId, selectedTableId, dataset?.tables, onTableChange]);

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
            <option value="">{t('explore.source.selectDataset')}</option>
            {datasets.map((ws: any) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </Select>
        </div>

        {selectedDatasetId && !hideTable && (
          <div className="min-w-[12rem] flex-1 sm:w-56 sm:flex-none">
            <Select
              size="sm"
              value={selectedTableId || ''}
              onChange={(e) => handleTableChange(e.target.value)}
              disabled={disabled || !dataset?.tables?.length}
            >
              <option value="">{t('explore.source.selectTable')}</option>
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
            {t('explore.source.dataset')}
          </span>
        )}
      >
        <Select
          size="sm"
          value={selectedDatasetId || ''}
          onChange={(e) => handleDatasetChange(e.target.value)}
          disabled={disabled || lockDataset || loadingDatasets}
        >
          <option value="">{t('explore.source.selectDataset')}</option>
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
              {t('explore.source.table')}
            </span>
          )}
          description={
            dataset && dataset.tables?.length === 0
              ? t('explore.source.noTables')
              : undefined
          }
        >
          <Select
            size="sm"
            value={selectedTableId || ''}
            onChange={(e) => handleTableChange(e.target.value)}
            disabled={disabled || !dataset?.tables?.length}
          >
            <option value="">{t('explore.source.selectTable')}</option>
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
