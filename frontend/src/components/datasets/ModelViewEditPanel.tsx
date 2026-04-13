'use client';

/**
 * ModelViewEditPanel — Side panel opened when clicking a table node in the ERD canvas.
 *
 * Layout: fixed inset-y-0 right-0 w-[52rem] split into two columns:
 *   Left  (w-72, border-r) — DictionaryContextPane: table notes for the matched DatasetTable
 *   Right (flex-1)         — Dimensions + Measures editor (ported from DimensionMeasureEditor)
 *
 * Both panes share the same React Query cache via useDatasetDictionary(datasetId).
 * The model view is saved independently via useUpdateModelView.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
  Sigma,
  Sparkles,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import {
  useUpdateModelView,
  type DatasetModelView,
  type DimensionDefinition,
  type MeasureDefinition,
} from '@/hooks/use-dataset-model';
import {
  useDatasetDictionary,
  useUpdateDatasetDictionary,
  type DatasetDictionary,
  type DatasetDictionaryTableNote,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { usePreviewTableDescription, type TableDescriptionPreview } from '@/hooks/useDescription';
import { AiDescriptionDiffModal } from './AiDescriptionDiffModal';
import { toast } from 'sonner';
import {
  buildPayload,
  emptyTable,
  mergeColumnDescriptions,
  normalizeDictionary,
  tableLabel,
  TokenEditor,
} from './dataset-catalog-shared';

// ─── Constants ────────────────────────────────────────────────────────────────

const DIM_TYPES = ['string', 'number', 'date', 'datetime', 'yesno'] as const;
const MEASURE_TYPES = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'] as const;

// ─── DimensionRow ─────────────────────────────────────────────────────────────

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
        <span className="text-sm text-gray-800 truncate flex-1">{dim.label || dim.name}</span>
        <span className="text-[10px] text-gray-400 uppercase">{dim.type}</span>
        <button
          onClick={() => onChange({ ...dim, hidden: !dim.hidden })}
          className="p-0.5 hover:bg-gray-100 rounded"
          title={dim.hidden ? 'Show' : 'Hide'}
        >
          {dim.hidden
            ? <EyeOff className="w-3.5 h-3.5 text-gray-300" />
            : <Eye className="w-3.5 h-3.5 text-gray-500" />}
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
                {DIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
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

// ─── MeasureRow ───────────────────────────────────────────────────────────────

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
        <span className="text-sm text-gray-800 truncate flex-1">{measure.label || measure.name}</span>
        <span className="text-[10px] text-gray-400 uppercase">{measure.type}</span>
        <button
          onClick={() => onChange({ ...measure, hidden: !measure.hidden })}
          className="p-0.5 hover:bg-gray-100 rounded"
          title={measure.hidden ? 'Show' : 'Hide'}
        >
          {measure.hidden
            ? <EyeOff className="w-3.5 h-3.5 text-gray-300" />
            : <Eye className="w-3.5 h-3.5 text-gray-500" />}
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
                {MEASURE_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
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

// ─── DictionaryContextPane ────────────────────────────────────────────────────

interface DictionaryContextPaneProps {
  datasetId: number;
  tableId: number | null | undefined;
  tables: DatasetTable[];
  canEdit: boolean;
}

function DictionaryContextPane({ datasetId, tableId, tables, canEdit }: DictionaryContextPaneProps) {
  const { data: rawDict } = useDatasetDictionary(datasetId);
  const updateDict = useUpdateDatasetDictionary(datasetId);

  // Derived draft note for this table
  const [draft, setDraft] = useState<DatasetDictionaryTableNote | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // AI preview state
  const previewAi = usePreviewTableDescription(datasetId, tableId ?? 0);
  const [aiDraftPayload, setAiDraftPayload] = useState<TableDescriptionPreview | null>(null);
  const [aiDiffOpen, setAiDiffOpen] = useState(false);

  const sourceTable = useMemo(
    () => tables.find((t) => t.id === tableId) ?? null,
    [tables, tableId],
  );

  const normalized = useMemo(() => normalizeDictionary(rawDict?.dictionary), [rawDict]);

  // Sync draft when tableId or server data changes
  useEffect(() => {
    if (tableId == null) {
      setDraft(null);
      setIsDirty(false);
      return;
    }
    const existing = normalized.table_notes.find((n) => n.table_id === tableId);
    setDraft(existing ? { ...existing } : emptyTable(tableId));
    setIsDirty(false);
  }, [tableId, normalized]);

  const patch = useCallback(
    (updater: (note: DatasetDictionaryTableNote) => DatasetDictionaryTableNote) => {
      setDraft((prev) => {
        if (!prev) return prev;
        return updater(prev);
      });
      setIsDirty(true);
    },
    [],
  );

  const handleSave = async () => {
    if (!draft || !tableId) return;
    const next: DatasetDictionary = {
      ...normalized,
      table_notes: normalized.table_notes.some((n) => n.table_id === tableId)
        ? normalized.table_notes.map((n) => (n.table_id === tableId ? draft : n))
        : [...normalized.table_notes, draft],
    };
    try {
      await updateDict.mutateAsync(buildPayload(next));
      setIsDirty(false);
      toast.success('Table notes saved');
    } catch {
      toast.error('Failed to save table notes');
    }
  };

  const handleGenerateAi = async () => {
    if (!tableId) return;
    try {
      const result = await previewAi.mutateAsync();
      setAiDraftPayload(result);
      setAiDiffOpen(true);
    } catch {
      toast.error('AI generation failed');
    }
  };

  const handleApplyAi = (edited: TableDescriptionPreview) => {
    if (!draft || !tableId) return;
    const mergedNotes = mergeColumnDescriptions(draft.column_notes ?? [], edited.column_descriptions);
    const nextDraft: DatasetDictionaryTableNote = {
      ...draft,
      business_role: edited.description || draft.business_role,
      column_notes: mergedNotes,
    };
    setDraft(nextDraft);
    setIsDirty(true);
    setAiDiffOpen(false);
    setAiDraftPayload(null);
    toast.success('AI description applied. Save to persist.');
  };

  // ─ Render ─

  if (tableId == null) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 px-4 text-center gap-2">
        <Type className="w-6 h-6 opacity-40" />
        <p className="text-xs">No source table linked to this view.</p>
        <p className="text-[11px] text-gray-300">Set <code>dataset_table_id</code> on the model view to enable dictionary context.</p>
      </div>
    );
  }

  if (!draft) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Pane header */}
      <div className="px-4 py-2.5 border-b bg-gray-50 shrink-0">
        <p className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Source table</p>
        <p className="text-sm font-semibold text-gray-900 truncate">{tableLabel(sourceTable)}</p>
      </div>

      {/* Scrollable form */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">

        {/* Business Role */}
        <div>
          <label className="text-[10px] text-gray-500 uppercase font-medium">Business role</label>
          <textarea
            rows={2}
            value={draft.business_role ?? ''}
            onChange={(e) => patch((n) => ({ ...n, business_role: e.target.value }))}
            disabled={!canEdit}
            placeholder="What is this table's business purpose?"
            className="mt-0.5 w-full text-xs px-2 py-1.5 border rounded resize-none disabled:bg-gray-50"
          />
        </div>

        {/* Grain */}
        <div>
          <label className="text-[10px] text-gray-500 uppercase font-medium">Grain</label>
          <input
            value={draft.grain ?? ''}
            onChange={(e) => patch((n) => ({ ...n, grain: e.target.value }))}
            disabled={!canEdit}
            placeholder="One row = ?"
            className="mt-0.5 w-full text-xs px-2 py-1 border rounded disabled:bg-gray-50"
          />
        </div>

        {/* Freshness */}
        <div>
          <label className="text-[10px] text-gray-500 uppercase font-medium">Freshness expectation</label>
          <input
            value={draft.freshness_expectation ?? ''}
            onChange={(e) => patch((n) => ({ ...n, freshness_expectation: e.target.value }))}
            disabled={!canEdit}
            placeholder="e.g. Updated daily at 6am UTC"
            className="mt-0.5 w-full text-xs px-2 py-1 border rounded disabled:bg-gray-50"
          />
        </div>

        {/* Owner note */}
        <div>
          <label className="text-[10px] text-gray-500 uppercase font-medium">Owner note</label>
          <textarea
            rows={2}
            value={draft.owner_note ?? ''}
            onChange={(e) => patch((n) => ({ ...n, owner_note: e.target.value }))}
            disabled={!canEdit}
            placeholder="Contact, warnings, caveats…"
            className="mt-0.5 w-full text-xs px-2 py-1.5 border rounded resize-none disabled:bg-gray-50"
          />
        </div>

        {/* Join hint */}
        <div>
          <label className="text-[10px] text-gray-500 uppercase font-medium">Join hint</label>
          <input
            value={draft.join_hint ?? ''}
            onChange={(e) => patch((n) => ({ ...n, join_hint: e.target.value }))}
            disabled={!canEdit}
            placeholder="How to join this table"
            className="mt-0.5 w-full text-xs px-2 py-1 border rounded disabled:bg-gray-50"
          />
        </div>

        {/* Important columns */}
        <div>
          <label className="text-[10px] text-gray-500 uppercase font-medium">Important columns</label>
          <div className="mt-0.5">
            <TokenEditor
              values={draft.important_columns ?? []}
              onChange={(vals) => patch((n) => ({ ...n, important_columns: vals }))}
              placeholder="Add column name"
              disabled={!canEdit}
            />
          </div>
        </div>
      </div>

      {/* Pane footer */}
      {canEdit && (
        <div className="px-4 py-2.5 border-t shrink-0 flex items-center gap-2">
          <button
            onClick={handleGenerateAi}
            disabled={previewAi.isPending}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-violet-700 border border-violet-200 rounded hover:bg-violet-50 disabled:opacity-50"
          >
            {previewAi.isPending
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Sparkles className="w-3 h-3" />}
            AI generate
          </button>
          <div className="flex-1" />
          <button
            onClick={handleSave}
            disabled={!isDirty || updateDict.isPending}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {updateDict.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save notes
          </button>
        </div>
      )}

      {/* AI diff modal */}
      {aiDiffOpen && aiDraftPayload && draft && (
        <AiDescriptionDiffModal
          tableName={tableLabel(sourceTable)}
          current={{
            description: draft.business_role ?? '',
            column_descriptions: Object.fromEntries(
              (draft.column_notes ?? []).map((c) => [c.column_name, c.description ?? '']),
            ),
            common_questions: [],
          }}
          aiDraft={aiDraftPayload}
          onApply={handleApplyAi}
          onClose={() => { setAiDiffOpen(false); setAiDraftPayload(null); }}
        />
      )}
    </div>
  );
}

// ─── ModelViewEditPanel (main export) ────────────────────────────────────────

export interface ModelViewEditPanelProps {
  datasetId: number;
  view: DatasetModelView;
  tables: DatasetTable[];
  canEdit: boolean;
  onClose: () => void;
}

export function ModelViewEditPanel({
  datasetId,
  view,
  tables,
  canEdit,
  onClose,
}: ModelViewEditPanelProps) {
  // ── Model view state ──
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

  const modelIsDirty =
    JSON.stringify(dimensions) !== JSON.stringify(view.dimensions) ||
    JSON.stringify(measures) !== JSON.stringify(view.measures) ||
    description !== (view.description || '');

  const handleSaveModel = async () => {
    try {
      await updateView.mutateAsync({
        datasetId,
        viewId: view.id,
        data: { dimensions, measures, description },
      });
      toast.success('Model view saved');
      onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Failed to save model view');
    }
  };

  // ── Render ──

  return (
    <div className="fixed inset-y-0 right-0 w-[52rem] bg-white border-l shadow-xl z-50 flex flex-col">

      {/* ── Header ── */}
      <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
        <div>
          <p className="text-[11px] text-gray-400 uppercase tracking-wide">Model view</p>
          <h3 className="text-sm font-semibold text-gray-900">
            {view.table_display_name || view.name}
          </h3>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── Body: two-column layout ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left column — Dictionary context */}
        <div className="w-72 border-r flex flex-col overflow-hidden shrink-0">
          <DictionaryContextPane
            datasetId={datasetId}
            tableId={view.dataset_table_id}
            tables={tables}
            canEdit={canEdit}
          />
        </div>

        {/* Right column — Dimensions & Measures editor */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Description */}
          <div className="px-4 py-3 border-b shrink-0">
            <label className="text-[10px] text-gray-500 uppercase font-medium">View description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit}
              className="mt-0.5 w-full text-xs px-2 py-1.5 border rounded disabled:bg-gray-50"
              placeholder="Short description of this semantic view"
            />
          </div>

          {/* Scrollable dims + measures */}
          <div className="flex-1 overflow-y-auto">

            {/* Dimensions */}
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-700 uppercase">
                  Dimensions ({dimensions.length})
                </span>
                {canEdit && (
                  <button
                    onClick={handleAddDimension}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add
                  </button>
                )}
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
                {dimensions.length === 0 && (
                  <p className="text-xs text-gray-400 py-2 text-center">No dimensions yet</p>
                )}
              </div>
            </div>

            {/* Measures */}
            <div className="px-4 py-3 border-t">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-700 uppercase">
                  Measures ({measures.length})
                </span>
                {canEdit && (
                  <button
                    onClick={handleAddMeasure}
                    className="text-xs text-orange-600 hover:text-orange-800 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add
                  </button>
                )}
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
                {measures.length === 0 && (
                  <p className="text-xs text-gray-400 py-2 text-center">No measures yet</p>
                )}
              </div>
            </div>
          </div>

          {/* Footer — save model changes */}
          {canEdit && (
            <div className="px-4 py-3 border-t flex items-center justify-end gap-2 shrink-0">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveModel}
                disabled={!modelIsDirty || updateView.isPending}
                className="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {updateView.isPending
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Save className="w-3 h-3" />}
                Save model view
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
