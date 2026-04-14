'use client';

import React, { useState } from 'react';
import { Plus, Trash2, Filter, Database, ChevronRight, Loader2, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useDatasets, useDatasetTables } from '@/hooks/use-datasets';
import type { TemplateFilter } from '@/types/template';

const OPERATOR_LABELS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'Between',
  in: 'In',
  contains: 'Contains',
};

interface TemplateFilterEditorProps {
  filters: TemplateFilter[];
  onChange: (filters: TemplateFilter[]) => void;
  disabled?: boolean;
}

type AddStep = 'idle' | 'dataset' | 'table' | 'column' | 'configure';

export function TemplateFilterEditor({
  filters,
  onChange,
  disabled = false,
}: TemplateFilterEditorProps) {
  const [addStep, setAddStep] = useState<AddStep>('idle');
  const [draftDatasetId, setDraftDatasetId] = useState<number | null>(null);
  const [draftDatasetName, setDraftDatasetName] = useState('');
  const [draftTableId, setDraftTableId] = useState<number | null>(null);
  const [draftTableName, setDraftTableName] = useState('');
  const [draftColumn, setDraftColumn] = useState('');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftOperator, setDraftOperator] =
    useState<TemplateFilter['operator']>('eq');

  const { data: datasets, isLoading: loadingDatasets } = useDatasets();
  const { data: tables, isLoading: loadingTables } = useDatasetTables(
    addStep !== 'idle' ? draftDatasetId : null,
  );

  const selectedTable = tables?.find((t) => t.id === draftTableId);
  const columns: string[] = selectedTable?.columns_cache
    ? Array.isArray(selectedTable.columns_cache)
      ? selectedTable.columns_cache.map((c: any) => c.name ?? c)
      : Object.keys(selectedTable.columns_cache)
    : [];

  const resetDraft = () => {
    setAddStep('idle');
    setDraftDatasetId(null);
    setDraftDatasetName('');
    setDraftTableId(null);
    setDraftTableName('');
    setDraftColumn('');
    setDraftLabel('');
    setDraftOperator('eq');
  };

  const handleConfirm = () => {
    if (!draftDatasetId || !draftTableId || !draftColumn) return;
    const newFilter: TemplateFilter = {
      id: uuidv4(),
      label: draftLabel.trim() || `${draftTableName}.${draftColumn}`,
      datasetId: draftDatasetId,
      tableId: draftTableId,
      column: draftColumn,
      operator: draftOperator,
    };
    onChange([...filters, newFilter]);
    resetDraft();
  };

  const handleRemove = (id: string) => {
    onChange(filters.filter((f) => f.id !== id));
  };

  const handleUpdate = (id: string, patch: Partial<TemplateFilter>) => {
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          <Filter className="mr-1 inline h-3 w-3" />
          Filters
        </h3>
        {!disabled && addStep === 'idle' && (
          <button
            onClick={() => setAddStep('dataset')}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="Add filter"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Existing filters */}
      {filters.length === 0 && addStep === 'idle' && (
        <p className="text-xs text-gray-400">
          No filters defined. Add filters so users can narrow data when
          previewing.
        </p>
      )}

      {filters.map((f) => (
        <div
          key={f.id}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm space-y-1.5"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-700">{f.label}</span>
            {!disabled && (
              <button
                onClick={() => handleRemove(f.id)}
                className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Database className="h-3 w-3" />
            <span className="truncate">{f.column}</span>
            <select
              value={f.operator}
              onChange={(e) =>
                handleUpdate(f.id, {
                  operator: e.target.value as TemplateFilter['operator'],
                })
              }
              disabled={disabled}
              className="ml-auto rounded border border-gray-200 px-1.5 py-0.5 text-xs disabled:opacity-50"
            >
              {Object.entries(OPERATOR_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <input
            type="text"
            value={f.defaultValue ?? ''}
            onChange={(e) =>
              handleUpdate(f.id, {
                defaultValue: e.target.value || undefined,
              })
            }
            disabled={disabled}
            placeholder="Default value (optional)"
            className="w-full rounded border border-gray-200 px-2 py-1 text-xs disabled:opacity-50"
          />
        </div>
      ))}

      {/* Add filter wizard */}
      {addStep !== 'idle' && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-2 space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>
              {addStep === 'dataset' && 'Pick dataset'}
              {addStep === 'table' && draftDatasetName}
              {addStep === 'column' &&
                `${draftDatasetName} / ${draftTableName}`}
              {addStep === 'configure' &&
                `${draftTableName}.${draftColumn}`}
            </span>
            <button
              onClick={resetDraft}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {addStep === 'dataset' &&
              (loadingDatasets ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                </div>
              ) : (
                (datasets ?? []).map((ds) => (
                  <button
                    key={ds.id}
                    onClick={() => {
                      setDraftDatasetId(ds.id);
                      setDraftDatasetName(ds.name);
                      setAddStep('table');
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-blue-50"
                  >
                    <Database className="h-3 w-3 text-gray-400" />
                    <span className="truncate">{ds.name}</span>
                    <ChevronRight className="ml-auto h-3 w-3 text-gray-300" />
                  </button>
                ))
              ))}

            {addStep === 'table' &&
              (loadingTables ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                </div>
              ) : (
                (tables ?? []).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setDraftTableId(t.id);
                      setDraftTableName(t.display_name);
                      setAddStep('column');
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-blue-50"
                  >
                    <span className="truncate">{t.display_name}</span>
                    <ChevronRight className="ml-auto h-3 w-3 text-gray-300" />
                  </button>
                ))
              ))}

            {addStep === 'column' &&
              columns.map((col) => (
                <button
                  key={col}
                  onClick={() => {
                    setDraftColumn(col);
                    setDraftLabel(`${draftTableName}.${col}`);
                    setAddStep('configure');
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-blue-50"
                >
                  <span className="truncate font-mono">{col}</span>
                </button>
              ))}

            {addStep === 'configure' && (
              <div className="space-y-2 py-1">
                <label className="block">
                  <span className="text-[10px] text-gray-500 uppercase">
                    Label
                  </span>
                  <input
                    type="text"
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] text-gray-500 uppercase">
                    Operator
                  </span>
                  <select
                    value={draftOperator}
                    onChange={(e) =>
                      setDraftOperator(
                        e.target.value as TemplateFilter['operator'],
                      )
                    }
                    className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    {Object.entries(OPERATOR_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={handleConfirm}
                  className="w-full rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Add filter
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
