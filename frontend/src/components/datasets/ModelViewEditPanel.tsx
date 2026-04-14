'use client';

/**
 * ModelViewEditPanel — Side panel opened when clicking a table node in the ERD canvas.
 *
 * Integrated single-view layout (no internal tabs):
 *   Top       — TableNotesBar (pill summary + expandable metadata + AI generate)
 *   Middle    — Column dictionary grid (meaning-only: business name, description, examples)
 *               Quality rules are NOT shown here — they live in the Quality tab.
 *   Bottom    — Collapsible Dimensions & Measures section
 *   Footer    — Save dictionary + Save model buttons
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  Sigma,
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
  type DatasetDictionaryColumnNote,
  type DatasetDictionaryTableNote,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { usePreviewTableDescription, type TableDescriptionPreview } from '@/hooks/useDescription';
import { AiDescriptionDiffModal } from './AiDescriptionDiffModal';
import { AppModalShell } from '@/components/common/AppModalShell';
import { toast } from 'sonner';
import {
  buildPayload,
  DataTypeBadge,
  emptyColumn,
  emptyTable,
  mergeColumnDescriptions,
  normalizeDictionary,
  tableColumnsMeta,
  TableNotesBar,
  tableLabel,
  TokenEditor,
} from './dataset-catalog-shared';

// ─── Constants ────────────────────────────────────────────────────────────────

const DIM_TYPES = ['string', 'number', 'date', 'datetime', 'yesno'] as const;
const MEASURE_TYPES = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'] as const;

// ─── Column Meaning Modal (no quality — quality lives in Quality tab) ─────────

function ColumnMeaningModal({
  open,
  tableName,
  note,
  canEdit,
  onClose,
  onChange,
  onRemove,
}: {
  open: boolean;
  tableName: string;
  note: DatasetDictionaryColumnNote | null;
  canEdit: boolean;
  onClose: () => void;
  onChange: (updater: (cur: DatasetDictionaryColumnNote) => DatasetDictionaryColumnNote) => void;
  onRemove: () => void;
}) {
  if (!open || !note) return null;

  return (
    <AppModalShell
      onClose={onClose}
      title={note.column_name}
      description={`${tableName} · column dictionary`}
      icon={<Pencil className="h-5 w-5" />}
      maxWidthClass="max-w-2xl"
      panelClassName="max-h-[80vh]"
      footer={
        <>
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="mr-auto inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Done
          </button>
        </>
      }
    >
      <div className="space-y-5 p-6">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Business name</label>
          <input
            value={note.business_name ?? ''}
            onChange={(e) => onChange((cur) => ({ ...cur, business_name: e.target.value }))}
            disabled={!canEdit}
            placeholder="Friendly name for business users"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Description</label>
          <textarea
            rows={4}
            value={note.description ?? ''}
            onChange={(e) => onChange((cur) => ({ ...cur, description: e.target.value }))}
            disabled={!canEdit}
            placeholder="What does this column mean? How should it be interpreted?"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Examples</label>
          <TokenEditor
            values={note.examples ?? []}
            onChange={(values) => onChange((cur) => ({ ...cur, examples: values }))}
            placeholder="Add a sample value…"
            disabled={!canEdit}
          />
        </div>
      </div>
    </AppModalShell>
  );
}

// ─── DictionaryColumnGrid (meaning-only, no quality) ──────────────────────────

function DictionaryColumnGrid({
  table,
  tableNote,
  canEdit,
  isSaving,
  onPatchDictionary,
}: {
  table: DatasetTable;
  tableNote: DatasetDictionaryTableNote;
  canEdit: boolean;
  isSaving: boolean;
  onPatchDictionary: (updater: (current: DatasetDictionary) => DatasetDictionary) => void;
}) {
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'documented'>('all');
  const [activeColumn, setActiveColumn] = useState<string | null>(null);

  const columnsMeta = useMemo(() => tableColumnsMeta(table), [table]);

  const visible = useMemo(
    () => columnsMeta.filter(({ name }) => {
      const note = tableNote.column_notes.find((n) => n.column_name === name);
      if (filterMode === 'documented' && !note) return false;
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return [name, note?.business_name ?? '', note?.description ?? '', ...(note?.examples ?? [])]
        .join(' ').toLowerCase().includes(q);
    }),
    [columnsMeta, tableNote.column_notes, filterMode, search],
  );

  const openModal = (column: string) => {
    const note = tableNote.column_notes.find((n) => n.column_name === column);
    if (!note && canEdit) {
      onPatchDictionary((current) => ({
        ...current,
        table_notes: current.table_notes.map((item) =>
          item.table_id === tableNote.table_id
            ? { ...item, column_notes: [...item.column_notes, emptyColumn(column)] }
            : item,
        ),
      }));
    }
    if (note || canEdit) setActiveColumn(column);
  };

  const activeNote = tableNote.column_notes.find((n) => n.column_name === activeColumn) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-5 py-2.5">
        <span className="text-sm font-semibold text-gray-900">
          Columns
          {columnsMeta.length > 0 && (
            <span className="ml-1.5 text-sm font-normal text-gray-400">({columnsMeta.length})</span>
          )}
        </span>
        <div className="relative min-w-0 flex-1 max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search columns…"
            className="w-full rounded-md border border-gray-200 py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white">
          {(['all', 'documented'] as const).map((value, i, arr) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilterMode(value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                i === 0 ? 'rounded-l-[5px]' : ''
              } ${i === arr.length - 1 ? 'rounded-r-[5px]' : ''} ${
                filterMode === value ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {columnsMeta.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-gray-400">
            Column metadata is not available yet.
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-gray-400">
            No columns match this filter.
          </div>
        ) : (
          <table className="min-w-full">
            <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="w-10 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-400" />
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Column</th>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Description</th>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 w-24">Examples</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {visible.map(({ name: column, type: colType }) => {
                const note = tableNote.column_notes.find((n) => n.column_name === column);
                const documented = !!note;
                const hasDesc = !!(note?.description?.trim());
                const hasBizName = !!(note?.business_name?.trim());
                const exampleCount = (note?.examples ?? []).length;

                return (
                  <tr key={column} className="group transition-colors hover:bg-blue-50/40">
                    {/* Checkbox */}
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={documented}
                        disabled={!canEdit || isSaving}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          onPatchDictionary((current) => ({
                            ...current,
                            table_notes: current.table_notes.map((item) =>
                              item.table_id !== tableNote.table_id ? item : {
                                ...item,
                                column_notes: checked
                                  ? item.column_notes.find((entry) => entry.column_name === column)
                                    ? item.column_notes
                                    : [...item.column_notes, emptyColumn(column)]
                                  : item.column_notes.filter((entry) => entry.column_name !== column),
                              },
                            ),
                          }));
                          if (!checked && activeColumn === column) setActiveColumn(null);
                        }}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        title={documented ? 'Remove from catalog' : 'Add to catalog'}
                      />
                    </td>

                    {/* Column name + business name */}
                    <td className="px-4 py-2.5 min-w-[180px]">
                      <button type="button" onClick={() => openModal(column)} className="text-left w-full">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium text-gray-900 group-hover:text-blue-700 truncate">{column}</span>
                          <DataTypeBadge type={colType} />
                        </div>
                        {hasBizName ? (
                          <div className="mt-0.5 text-xs text-gray-500 truncate">{note!.business_name}</div>
                        ) : documented ? (
                          <div className="mt-0.5 text-xs text-gray-400 italic">+ business name</div>
                        ) : null}
                      </button>
                    </td>

                    {/* Description */}
                    <td className="px-4 py-2.5 max-w-[300px]">
                      {documented ? (
                        <button type="button" onClick={() => openModal(column)} className="text-left w-full">
                          {hasDesc ? (
                            <p className="line-clamp-2 text-xs text-gray-600 leading-relaxed">{note!.description}</p>
                          ) : (
                            <span className="text-xs text-amber-600 italic">No description</span>
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>

                    {/* Examples count */}
                    <td className="px-4 py-2.5">
                      {documented ? (
                        <button type="button" onClick={() => openModal(column)} className="text-xs text-gray-500">
                          {exampleCount > 0 ? `${exampleCount} example${exampleCount > 1 ? 's' : ''}` : (
                            <span className="text-gray-400">—</span>
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Column meaning modal */}
      <ColumnMeaningModal
        open={Boolean(activeColumn && activeNote)}
        tableName={tableLabel(table)}
        note={activeNote}
        canEdit={canEdit && !isSaving}
        onClose={() => setActiveColumn(null)}
        onChange={(updater) => {
          if (!activeColumn) return;
          onPatchDictionary((current) => ({
            ...current,
            table_notes: current.table_notes.map((item) =>
              item.table_id !== tableNote.table_id ? item : {
                ...item,
                column_notes: item.column_notes.map((entry) =>
                  entry.column_name === activeColumn ? updater(entry) : entry,
                ),
              },
            ),
          }));
        }}
        onRemove={() => {
          if (!activeColumn) return;
          onPatchDictionary((current) => ({
            ...current,
            table_notes: current.table_notes.map((item) =>
              item.table_id !== tableNote.table_id ? item : {
                ...item,
                column_notes: item.column_notes.filter((entry) => entry.column_name !== activeColumn),
              },
            ),
          }));
          setActiveColumn(null);
        }}
      />
    </div>
  );
}

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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
  const tableId = view.dataset_table_id;

  // ── Dictionary state ──
  const { data: rawDict } = useDatasetDictionary(datasetId);
  const updateDict = useUpdateDatasetDictionary(datasetId);

  const [dictDraft, setDictDraft] = useState<DatasetDictionary | null>(null);
  const [dictDirty, setDictDirty] = useState(false);

  // AI preview
  const previewAi = usePreviewTableDescription(datasetId, tableId ?? 0);
  const [aiDraftPayload, setAiDraftPayload] = useState<TableDescriptionPreview | null>(null);
  const [aiDiffOpen, setAiDiffOpen] = useState(false);

  const sourceTable = useMemo(
    () => tables.find((t) => t.id === tableId) ?? null,
    [tables, tableId],
  );

  const normalized = useMemo(() => normalizeDictionary(rawDict?.dictionary), [rawDict]);

  useEffect(() => {
    if (tableId == null) {
      setDictDraft(null);
      setDictDirty(false);
      return;
    }
    const next = { ...normalized };
    if (!next.table_notes.some((n) => n.table_id === tableId)) {
      next.table_notes = [...next.table_notes, emptyTable(tableId)];
    }
    setDictDraft(next);
    setDictDirty(false);
  }, [tableId, normalized]);

  const tableNote = useMemo(
    () => dictDraft?.table_notes.find((n) => n.table_id === tableId) ?? null,
    [dictDraft, tableId],
  );

  const patchDictionary = useCallback(
    (updater: (current: DatasetDictionary) => DatasetDictionary) => {
      setDictDraft((prev) => (prev ? updater(prev) : prev));
      setDictDirty(true);
    },
    [],
  );

  const patchTableNote = useCallback(
    (updater: (note: DatasetDictionaryTableNote) => DatasetDictionaryTableNote) => {
      if (!tableId) return;
      patchDictionary((current) => ({
        ...current,
        table_notes: current.table_notes.map((n) =>
          n.table_id === tableId ? updater(n) : n,
        ),
      }));
    },
    [tableId, patchDictionary],
  );

  const handleSaveDict = async () => {
    if (!dictDraft) return;
    try {
      await updateDict.mutateAsync(buildPayload(dictDraft));
      setDictDirty(false);
      toast.success('Dictionary saved');
    } catch {
      toast.error('Failed to save dictionary');
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
    if (!tableNote || !tableId) return;
    const mergedNotes = mergeColumnDescriptions(tableNote.column_notes ?? [], edited.column_descriptions);
    patchDictionary((current) => ({
      ...current,
      table_notes: current.table_notes.map((n) =>
        n.table_id === tableId
          ? { ...n, business_role: edited.description || n.business_role, column_notes: mergedNotes }
          : n,
      ),
    }));
    setAiDiffOpen(false);
    setAiDraftPayload(null);
    toast.success('AI description applied. Save to persist.');
  };

  // ── Model view state ──
  const [dimensions, setDimensions] = useState<DimensionDefinition[]>([]);
  const [measures, setMeasures] = useState<MeasureDefinition[]>([]);
  const [description, setDescription] = useState('');
  const [modelSectionOpen, setModelSectionOpen] = useState(false);
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
    setDimensions((prev) => [...prev, { name: `dim_${prev.length + 1}`, type: 'string', hidden: false }]);
  };
  const handleAddMeasure = () => {
    setMeasures((prev) => [...prev, { name: `measure_${prev.length + 1}`, type: 'sum', hidden: false }]);
  };

  const modelIsDirty =
    JSON.stringify(dimensions) !== JSON.stringify(view.dimensions) ||
    JSON.stringify(measures) !== JSON.stringify(view.measures) ||
    description !== (view.description || '');

  const handleSaveModel = async () => {
    try {
      await updateView.mutateAsync({ datasetId, viewId: view.id, data: { dimensions, measures, description } });
      toast.success('Model view saved');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Failed to save model view');
    }
  };

  const handleRequestClose = useCallback(() => {
    if (updateView.isPending) return;
    if ((modelIsDirty || dictDirty) && typeof window !== 'undefined') {
      if (!window.confirm('Discard unsaved changes?')) return;
    }
    onClose();
  }, [modelIsDirty, dictDirty, onClose, updateView.isPending]);

  const hasTable = tableId != null && dictDraft && tableNote;

  // ── Render ──

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white shadow-xl md:inset-y-0 md:left-auto md:right-0 md:w-[56rem] md:border-l">

      {/* Header */}
      <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
        <div>
          <p className="text-[11px] text-gray-400 uppercase tracking-wide">Model view</p>
          <h3 className="text-sm font-semibold text-gray-900">{view.table_display_name || view.name}</h3>
        </div>
        <button onClick={handleRequestClose} className="p-1 hover:bg-gray-100 rounded">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {hasTable ? (
          <>
            {/* TableNotesBar — metadata pills + AI generate + expandable form */}
            <TableNotesBar
              tableNote={tableNote}
              canEdit={canEdit}
              isSaving={updateDict.isPending}
              isGeneratingAi={previewAi.isPending}
              onPatchNote={patchTableNote}
              onGenerateAi={handleGenerateAi}
            />

            {/* Column dictionary grid — meaning only, no quality rules */}
            {sourceTable && (
              <DictionaryColumnGrid
                table={sourceTable}
                tableNote={tableNote}
                canEdit={canEdit}
                isSaving={updateDict.isPending}
                onPatchDictionary={patchDictionary}
              />
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 text-gray-400 px-4 text-center gap-2">
            <Type className="w-6 h-6 opacity-40" />
            <p className="text-xs">No source table linked to this view.</p>
          </div>
        )}

        {/* Collapsible Dimensions & Measures */}
        <div className="shrink-0 border-t border-gray-200 bg-white">
          <button
            type="button"
            onClick={() => setModelSectionOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-gray-50 transition-colors"
          >
            {modelSectionOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
              : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
            <Sigma className="w-3.5 h-3.5 text-orange-500" />
            <span className="text-xs font-medium text-gray-700 uppercase">Dimensions & Measures</span>
            <span className="text-[10px] text-gray-400">{dimensions.length}D · {measures.length}M</span>
            {modelIsDirty && <span className="ml-1 inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />}
          </button>

          {modelSectionOpen && (
            <div className="max-h-80 overflow-y-auto border-t border-gray-100">
              {/* View description */}
              <div className="px-5 py-2.5">
                <label className="text-[10px] text-gray-500 uppercase font-medium">View description</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={!canEdit}
                  className="mt-0.5 w-full text-xs px-2 py-1.5 border rounded disabled:bg-gray-50"
                  placeholder="Short description of this semantic view"
                />
              </div>

              {/* Dimensions */}
              <div className="px-5 py-2.5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-700 uppercase">Dimensions ({dimensions.length})</span>
                  {canEdit && (
                    <button onClick={handleAddDimension} className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Add
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {dimensions.map((dim, idx) => (
                    <DimensionRow key={`dim-${idx}-${dim.name}`} dim={dim} onChange={(u) => handleDimChange(idx, u)} onRemove={() => handleRemoveDim(idx)} />
                  ))}
                  {dimensions.length === 0 && <p className="text-xs text-gray-400 py-1 text-center">No dimensions yet</p>}
                </div>
              </div>

              {/* Measures */}
              <div className="px-5 py-2.5 border-t">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-700 uppercase">Measures ({measures.length})</span>
                  {canEdit && (
                    <button onClick={handleAddMeasure} className="text-xs text-orange-600 hover:text-orange-800 flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Add
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {measures.map((m, idx) => (
                    <MeasureRow key={`mea-${idx}-${m.name}`} measure={m} onChange={(u) => handleMeasureChange(idx, u)} onRemove={() => handleRemoveMeasure(idx)} />
                  ))}
                  {measures.length === 0 && <p className="text-xs text-gray-400 py-1 text-center">No measures yet</p>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      {canEdit && (
        <div className="px-5 py-2.5 border-t flex items-center gap-2 shrink-0 bg-white">
          <button onClick={handleRequestClose} className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50">
            Cancel
          </button>
          <div className="flex-1" />
          {hasTable && (
            <button
              onClick={handleSaveDict}
              disabled={!dictDirty || updateDict.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {updateDict.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save dictionary
            </button>
          )}
          <button
            onClick={handleSaveModel}
            disabled={!modelIsDirty || updateView.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-violet-600 rounded-md hover:bg-violet-700 disabled:opacity-50"
          >
            {updateView.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save model
          </button>
        </div>
      )}

      {/* AI diff modal */}
      {aiDiffOpen && aiDraftPayload && tableNote && (
        <AiDescriptionDiffModal
          tableName={tableLabel(sourceTable)}
          current={{
            description: tableNote.business_role ?? '',
            column_descriptions: Object.fromEntries(
              (tableNote.column_notes ?? []).map((c) => [c.column_name, c.description ?? '']),
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
