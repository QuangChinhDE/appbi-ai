/**
 * DimensionMeasureEditor — Side panel for editing a semantic view's dimensions/measures.
 * Allows toggling visibility, changing types, editing labels and SQL.
 */
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  Sigma,
  Eye,
  EyeOff,
  Save,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  useUpdateModelView,
  type DatasetModelView,
  type DimensionDefinition,
  type MeasureDefinition,
} from '@/hooks/use-dataset-model';
import { toast } from 'sonner';

const DIM_TYPES = ['string', 'number', 'date', 'datetime', 'yesno'] as const;
const MEASURE_TYPES = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'] as const;

// ===== Dimension Row =====

function DimensionRow({
  dim,
  onChange,
  onRemove,
}: {
  dim: DimensionDefinition;
  onChange: (updated: DimensionDefinition) => void;
  onRemove: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border rounded-md bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-gray-400 hover:text-gray-600"
        >
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <Type className="w-3.5 h-3.5 text-blue-500 shrink-0" />
        <span className="text-sm text-gray-800 truncate flex-1">
          {dim.label || dim.name}
        </span>
        <span className="text-[10px] text-gray-400 uppercase">{dim.type}</span>
        <button
          onClick={() => onChange({ ...dim, hidden: !dim.hidden })}
          className="p-0.5 hover:bg-gray-100 rounded"
          title={dim.hidden ? 'Show' : 'Hide'}
        >
          {dim.hidden ? <EyeOff className="w-3.5 h-3.5 text-gray-300" /> : <Eye className="w-3.5 h-3.5 text-gray-500" />}
        </button>
        <button onClick={onRemove} className="p-0.5 hover:bg-red-50 rounded text-gray-300 hover:text-red-500">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-gray-500 uppercase">Name</label>
              <input
                value={dim.name}
                onChange={(e) => onChange({ ...dim, name: e.target.value })}
                className="w-full text-xs px-2 py-1 border rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase">Type</label>
              <select
                value={dim.type}
                onChange={(e) => onChange({ ...dim, type: e.target.value as any })}
                className="w-full text-xs px-2 py-1 border rounded bg-white"
              >
                {DIM_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase">Label</label>
            <input
              value={dim.label || ''}
              onChange={(e) => onChange({ ...dim, label: e.target.value || undefined })}
              className="w-full text-xs px-2 py-1 border rounded"
              placeholder="Display label"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase">SQL</label>
            <input
              value={dim.sql || ''}
              onChange={(e) => onChange({ ...dim, sql: e.target.value || undefined })}
              className="w-full text-xs px-2 py-1 border rounded font-mono"
              placeholder="Column name or SQL expression"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Measure Row =====

function MeasureRow({
  measure,
  onChange,
  onRemove,
}: {
  measure: MeasureDefinition;
  onChange: (updated: MeasureDefinition) => void;
  onRemove: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border rounded-md bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-gray-400 hover:text-gray-600"
        >
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <Sigma className="w-3.5 h-3.5 text-orange-500 shrink-0" />
        <span className="text-sm text-gray-800 truncate flex-1">
          {measure.label || measure.name}
        </span>
        <span className="text-[10px] text-gray-400 uppercase">{measure.type}</span>
        <button
          onClick={() => onChange({ ...measure, hidden: !measure.hidden })}
          className="p-0.5 hover:bg-gray-100 rounded"
          title={measure.hidden ? 'Show' : 'Hide'}
        >
          {measure.hidden ? <EyeOff className="w-3.5 h-3.5 text-gray-300" /> : <Eye className="w-3.5 h-3.5 text-gray-500" />}
        </button>
        <button onClick={onRemove} className="p-0.5 hover:bg-red-50 rounded text-gray-300 hover:text-red-500">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-gray-500 uppercase">Name</label>
              <input
                value={measure.name}
                onChange={(e) => onChange({ ...measure, name: e.target.value })}
                className="w-full text-xs px-2 py-1 border rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase">Aggregation</label>
              <select
                value={measure.type}
                onChange={(e) => onChange({ ...measure, type: e.target.value as any })}
                className="w-full text-xs px-2 py-1 border rounded bg-white"
              >
                {MEASURE_TYPES.map((t) => (
                  <option key={t} value={t}>{t.toUpperCase()}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase">Label</label>
            <input
              value={measure.label || ''}
              onChange={(e) => onChange({ ...measure, label: e.target.value || undefined })}
              className="w-full text-xs px-2 py-1 border rounded"
              placeholder="Display label"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase">SQL</label>
            <input
              value={measure.sql || ''}
              onChange={(e) => onChange({ ...measure, sql: e.target.value || undefined })}
              className="w-full text-xs px-2 py-1 border rounded font-mono"
              placeholder="Column or expression"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Main Editor Panel =====

interface DimensionMeasureEditorProps {
  datasetId: number;
  view: DatasetModelView;
  onClose: () => void;
}

export function DimensionMeasureEditor({ datasetId, view, onClose }: DimensionMeasureEditorProps) {
  const [dimensions, setDimensions] = useState<DimensionDefinition[]>([]);
  const [measures, setMeasures] = useState<MeasureDefinition[]>([]);
  const [description, setDescription] = useState('');
  const updateView = useUpdateModelView();

  useEffect(() => {
    setDimensions(view.dimensions.map((d) => ({ ...d })));
    setMeasures(view.measures.map((m) => ({ ...m })));
    setDescription(view.description || '');
  }, [view]);

  const handleDimChange = useCallback((idx: number, updated: DimensionDefinition) => {
    setDimensions((prev) => prev.map((d, i) => (i === idx ? updated : d)));
  }, []);

  const handleMeasureChange = useCallback((idx: number, updated: MeasureDefinition) => {
    setMeasures((prev) => prev.map((m, i) => (i === idx ? updated : m)));
  }, []);

  const handleRemoveDim = useCallback((idx: number) => {
    setDimensions((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleRemoveMeasure = useCallback((idx: number) => {
    setMeasures((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleAddDimension = () => {
    setDimensions((prev) => [
      ...prev,
      { name: `new_dimension_${prev.length + 1}`, type: 'string', hidden: false },
    ]);
  };

  const handleAddMeasure = () => {
    setMeasures((prev) => [
      ...prev,
      { name: `new_measure_${prev.length + 1}`, type: 'sum', hidden: false },
    ]);
  };

  const handleSave = async () => {
    try {
      await updateView.mutateAsync({
        datasetId,
        viewId: view.id,
        data: { dimensions, measures, description },
      });
      toast.success('View updated');
      onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Failed to update view');
    }
  };

  const isDirty =
    JSON.stringify(dimensions) !== JSON.stringify(view.dimensions) ||
    JSON.stringify(measures) !== JSON.stringify(view.measures) ||
    description !== (view.description || '');

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-white border-l shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            {view.table_display_name || view.name}
          </h3>
          <p className="text-xs text-gray-500">Edit dimensions & measures</p>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Description */}
      <div className="px-4 py-3 border-b shrink-0">
        <label className="text-[10px] text-gray-500 uppercase block mb-1">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-xs px-2 py-1.5 border rounded"
          placeholder="View description"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Dimensions */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-700 uppercase">
              Dimensions ({dimensions.length})
            </span>
            <button
              onClick={handleAddDimension}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          <div className="space-y-1.5">
            {dimensions.map((dim, idx) => (
              <DimensionRow
                key={`dim-${idx}-${dim.name}`}
                dim={dim}
                onChange={(u) => handleDimChange(idx, u)}
                onRemove={() => handleRemoveDim(idx)}
              />
            ))}
          </div>
        </div>

        {/* Measures */}
        <div className="px-4 py-3 border-t">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-700 uppercase">
              Measures ({measures.length})
            </span>
            <button
              onClick={handleAddMeasure}
              className="text-xs text-orange-600 hover:text-orange-800 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          <div className="space-y-1.5">
            {measures.map((m, idx) => (
              <MeasureRow
                key={`mea-${idx}-${m.name}`}
                measure={m}
                onChange={(u) => handleMeasureChange(idx, u)}
                onRemove={() => handleRemoveMeasure(idx)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t flex items-center justify-end gap-2 shrink-0">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!isDirty || updateView.isPending}
          className="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
        >
          {updateView.isPending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Save className="w-3 h-3" />
          )}
          Save Changes
        </button>
      </div>
    </div>
  );
}
