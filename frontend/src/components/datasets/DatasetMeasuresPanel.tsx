'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw, Sigma } from 'lucide-react';

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
  const [showTablePicker, setShowTablePicker] = useState(false);

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
      {/* Compact table switcher bar */}
      <div className="shrink-0 flex items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <Sigma className="h-4 w-4 flex-shrink-0 text-warning" />
        <span className="text-xs font-semibold text-text-primary">Business Measures</span>
        {views.length > 1 && (
          <>
            <span className="text-text-quaternary">·</span>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowTablePicker((v) => !v)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2"
              >
                {selectedView?.table_display_name || selectedView?.name || 'Select table'}
                <ChevronDown className="h-3 w-3" />
              </button>
              {showTablePicker && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowTablePicker(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg py-1 max-h-64 overflow-y-auto">
                    {views.map((view) => (
                      <button
                        key={view.id}
                        type="button"
                        onClick={() => { setSelectedViewId(view.id); setShowTablePicker(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-surface-2 ${view.id === selectedViewId ? 'text-brand font-medium' : 'text-text-primary'}`}
                      >
                        <span className="block truncate">{view.table_display_name || view.name}</span>
                        <span className="block truncate text-[11px] text-text-quaternary">{measureCount(view)} measures</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

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