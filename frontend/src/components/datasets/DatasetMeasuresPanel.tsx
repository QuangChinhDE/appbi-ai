'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Sigma } from 'lucide-react';

import { useDatasetModel, type DatasetModelView } from '@/hooks/use-dataset-model';
import type { DatasetTable } from '@/hooks/use-datasets';
import { ModelViewEditPanel } from './ModelViewEditPanel';

interface DatasetMeasuresPanelProps {
  datasetId: number;
  tables: DatasetTable[];
  canEdit: boolean;
  initialTableId?: number | null;
  focusViewId?: number | null;
  focusMeasureName?: string | null;
  triggerAddMeasure?: number;
}

function tableKindRank(table: DatasetTable | null | undefined): number {
  if (table?.source_kind === 'derived_table') return 0;
  if (table?.source_kind === 'sql_query') return 1;
  if (table?.source_kind === 'physical_table') return 2;
  if (table?.source_kind === 'generated_calendar') return 4;
  return 3;
}

function measureCount(view: DatasetModelView): number {
  return view.measures.filter((measure) => !measure.hidden).length;
}

export function DatasetMeasuresPanel({ datasetId, tables, canEdit, initialTableId, focusViewId, focusMeasureName, triggerAddMeasure }: DatasetMeasuresPanelProps) {
  const { data: model, isLoading, error, refetch } = useDatasetModel(datasetId);
  const [selectedViewId, setSelectedViewId] = useState<number | null>(null);

  const tableById = useMemo(() => {
    const map = new Map<number, DatasetTable>();
    for (const table of tables) map.set(table.id, table);
    return map;
  }, [tables]);

  const views = useMemo(() => {
    return (model?.views ?? [])
      .filter((view) => !view.hidden_in_canvas && view.view_role !== 'calendar_role')
      .slice()
      .sort((a, b) => {
        const tableA = a.dataset_table_id ? tableById.get(a.dataset_table_id) : null;
        const tableB = b.dataset_table_id ? tableById.get(b.dataset_table_id) : null;
        const rankDelta = tableKindRank(tableA) - tableKindRank(tableB);
        if (rankDelta !== 0) return rankDelta;
        return (a.table_display_name || a.name).localeCompare(b.table_display_name || b.name);
      });
  }, [model?.views, tableById]);

  useEffect(() => {
    if (views.length === 0) {
      setSelectedViewId(null);
      return;
    }
    setSelectedViewId((current) => {
      if (focusViewId && views.some((v) => v.id === focusViewId)) return focusViewId;
      if (current && views.some((view) => view.id === current)) return current;
      if (initialTableId) {
        const match = views.find((view) => view.dataset_table_id === initialTableId);
        if (match) return match.id;
      }
      return views[0].id;
    });
  }, [views, initialTableId, focusViewId]);

  const selectedView = useMemo<DatasetModelView | null>(
    () => views.find((view) => view.id === selectedViewId) ?? null,
    [selectedViewId, views],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-brand" />
        Loading measures...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-danger">
        <p className="text-sm font-medium">Failed to load measures</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 px-3 py-1.5 text-xs font-medium hover:bg-danger/10"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    );
  }

  if (!model?.model_id || views.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <Sigma className="mx-auto mb-3 h-8 w-8 text-text-quaternary" />
          <h3 className="text-sm font-semibold text-text-primary">No measures available</h3>
          <p className="mt-1 text-xs leading-5 text-text-tertiary">
            Generate the dataset model first, then define business measures from the Tables workspace.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Measures editor */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {selectedView ? (
          <ModelViewEditPanel
            datasetId={datasetId}
            view={selectedView}
            tables={tables}
            canEdit={canEdit}
            showDictionaryTab={false}
            contentMode="measures"
            titleKicker="Business measures"
            focusMeasureName={focusMeasureName}
            triggerAddMeasure={triggerAddMeasure}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-sm">
              <Sigma className="mx-auto mb-3 h-8 w-8 text-text-quaternary" />
              <h3 className="text-sm font-semibold text-text-primary">Select a base table</h3>
              <p className="mt-1 text-xs leading-5 text-text-tertiary">
                Measures are saved on the selected semantic base table.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}