'use client';

/**
 * DatasetDictionaryPanel — dataset-wide dictionary catalog for the Model tab.
 *
 * This panel focuses on one job:
 * reviewing and editing table- and column-level dictionary coverage across the
 * entire dataset from a single modal workspace.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Search,
  Table2,
} from 'lucide-react';
import {
  useDatasetDictionary,
  useUpdateDatasetDictionary,
  type DatasetDictionary,
  type DatasetDictionaryColumnNote,
  type DatasetDictionaryTableNote,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { toast } from '@/lib/toast';
import {
  buildPayload,
  DataTypeBadge,
  emptyColumn,
  emptyTable,
  normalizeDictionary,
  tableColumnsMeta,
  TableNotesBar,
  tableLabel,
  trimList,
} from './dataset-catalog-shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  datasetId: number;
  datasetName: string;
  tables: DatasetTable[];
  canEdit: boolean;
}

const fmtTime = (value?: string | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : null;

const hasColumnDictionaryContent = (note?: DatasetDictionaryColumnNote | null) => Boolean(
  note && (
    note.business_name?.trim()
    || note.description?.trim()
    || (note.examples ?? []).length > 0
  ),
);

const cloneColumnNote = (note: DatasetDictionaryColumnNote): DatasetDictionaryColumnNote => ({
  ...note,
  examples: [...(note.examples ?? [])],
  quality: note.quality
    ? {
        ...note.quality,
        accepted_values: [...(note.quality.accepted_values ?? [])],
      }
    : undefined,
});

const cloneTableNote = (note: DatasetDictionaryTableNote): DatasetDictionaryTableNote => ({
  ...note,
  important_columns: [...(note.important_columns ?? [])],
  column_notes: (note.column_notes ?? []).map(cloneColumnNote),
});

// ─── DictionaryCatalog ────────────────────────────────────────────────────────

function DictionaryCatalog({
  draft,
  tables,
  canEdit,
  isSaving,
  onPatch,
}: {
  draft: DatasetDictionary;
  tables: DatasetTable[];
  canEdit: boolean;
  isSaving: boolean;
  onPatch: (updater: (current: DatasetDictionary) => DatasetDictionary) => void;
}) {
  const [search, setSearch] = useState('');

  const tableNoteById = useMemo(
    () => new Map(draft.table_notes.map((note) => [note.table_id, note])),
    [draft.table_notes],
  );

  const patchTableNote = useCallback((
    tableId: number,
    updater: (current: DatasetDictionaryTableNote) => DatasetDictionaryTableNote,
  ) => {
    onPatch((current) => {
      const existing = current.table_notes.find((note) => note.table_id === tableId);
      const nextNote = updater(existing ? cloneTableNote(existing) : emptyTable(tableId));
      const nextTableNotes = existing
        ? current.table_notes.map((note) => (note.table_id === tableId ? nextNote : note))
        : [...current.table_notes, nextNote];

      return {
        ...current,
        table_notes: nextTableNotes,
      };
    });
  }, [onPatch]);

  const patchColumnNote = useCallback((
    tableId: number,
    columnName: string,
    updater: (current: DatasetDictionaryColumnNote) => DatasetDictionaryColumnNote,
  ) => {
    patchTableNote(tableId, (tableNote) => {
      const existing = tableNote.column_notes.find((note) => note.column_name === columnName);
      const baseNote = existing
        ? cloneColumnNote(existing)
        : emptyColumn(columnName);

      const nextNote = updater({
        ...baseNote,
        column_name: baseNote.column_name || columnName,
        business_name: baseNote.business_name ?? '',
        description: baseNote.description ?? '',
        examples: [...(baseNote.examples ?? [])],
      });

      return {
        ...tableNote,
        column_notes: existing
          ? tableNote.column_notes.map((note) => (note.column_name === columnName ? nextNote : note))
          : [...tableNote.column_notes, nextNote],
      };
    });
  }, [patchTableNote]);

  const removeColumnNote = useCallback((tableId: number, columnName: string) => {
    patchTableNote(tableId, (tableNote) => ({
      ...tableNote,
      column_notes: tableNote.column_notes.filter((columnNote) => columnNote.column_name !== columnName),
    }));
  }, [patchTableNote]);

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();

    return tables
      .map((table) => {
        const tableName = tableLabel(table);
        const columns = tableColumnsMeta(table);
        const tableNote = tableNoteById.get(table.id)
          ? cloneTableNote(tableNoteById.get(table.id) as DatasetDictionaryTableNote)
          : emptyTable(table.id);
        const tableQueryHaystack = [
          tableName,
          tableNote.business_role ?? '',
          tableNote.grain ?? '',
          tableNote.join_hint ?? '',
          tableNote.owner_note ?? '',
          tableNote.freshness_expectation ?? '',
          tableNote.row_count_expectation ?? '',
          ...(tableNote.important_columns ?? []),
        ].join(' ').toLowerCase();
        const tableMatchesQuery = query ? tableQueryHaystack.includes(query) : true;

        const rows = columns
          .map(({ name, type }) => ({
            tableId: table.id,
            columnName: name,
            columnType: type,
            note: tableNote.column_notes.find((columnNote) => columnNote.column_name === name) ?? null,
          }))
          .filter((row) => {
            if (!query || tableMatchesQuery) return true;
            return [
              row.columnName,
              row.columnType ?? '',
              row.note?.business_name ?? '',
              row.note?.description ?? '',
              ...(row.note?.examples ?? []),
            ].join(' ').toLowerCase().includes(query);
          });

        const documentedColumns = columns.filter(({ name }) => {
          const note = tableNote.column_notes.find((columnNote) => columnNote.column_name === name);
          return hasColumnDictionaryContent(note);
        }).length;

        return {
          table,
          tableName,
          tableNote,
          rows,
          totalColumns: columns.length,
          documentedColumns,
          visible: !query || tableMatchesQuery || rows.length > 0,
        };
      })
      .filter((group) => group.visible);
  }, [search, tableNoteById, tables]);

  const totalColumns = useMemo(
    () => tables.reduce((count, table) => count + tableColumnsMeta(table).length, 0),
    [tables],
  );
  const documentedColumns = useMemo(
    () => tables.reduce((count, table) => {
      const tableNote = tableNoteById.get(table.id);
      return count + tableColumnsMeta(table).filter(({ name }) => {
        const note = tableNote?.column_notes.find((columnNote) => columnNote.column_name === name);
        return hasColumnDictionaryContent(note);
      }).length;
    }, 0),
    [tableNoteById, tables],
  );
  const visibleTableCount = grouped.length;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-5 py-2.5">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search table, column, business name, description…"
            className="w-full rounded-md border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <span className="text-[11px] text-gray-400 shrink-0">
          {documentedColumns} documented / {totalColumns} column{totalColumns !== 1 ? 's' : ''} · {visibleTableCount} table{visibleTableCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {tables.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-sm text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                <Table2 className="h-5 w-5 text-gray-400" />
              </div>
              <h3 className="text-base font-semibold text-gray-900">No dataset tables yet</h3>
              <p className="mt-2 text-sm text-gray-500">
                Add tables to this dataset before editing the shared dictionary catalog.
              </p>
            </div>
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-gray-400">
            No columns match &quot;{search}&quot;.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {grouped.map((group) => (
              <div key={group.table.id}>
                {/* Table header */}
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-5 py-2">
                  <Table2 className="h-3.5 w-3.5 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-700">{group.tableName}</span>
                  <span className="text-[10px] text-gray-400">{group.documentedColumns}/{group.totalColumns} documented</span>
                </div>
                <TableNotesBar
                  tableNote={group.tableNote}
                  canEdit={canEdit}
                  isSaving={isSaving}
                  onPatchNote={(updater) => patchTableNote(group.table.id, updater)}
                />
                {group.totalColumns === 0 ? (
                  <div className="px-5 py-6 text-sm text-gray-400">
                    Column metadata is not available for this table yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full table-fixed">
                      <thead className="border-b border-gray-50 bg-white">
                        <tr>
                          <th className="w-[220px] px-5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">Column</th>
                          <th className="w-[120px] px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">Type</th>
                          <th className="w-[220px] px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">Business Name</th>
                          <th className="px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">Description</th>
                          <th className="w-[220px] px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">Examples</th>
                          {canEdit && (
                            <th className="w-[88px] px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-gray-400">Action</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 bg-white">
                        {group.rows.map((row) => {
                          const isDocumented = hasColumnDictionaryContent(row.note);
                          const examplesValue = (row.note?.examples ?? []).join(', ');

                          return (
                            <tr key={`${row.tableId}-${row.columnName}`} className="align-top hover:bg-blue-50/20 transition-colors">
                              <td className="px-5 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs font-medium text-gray-900">{row.columnName}</span>
                                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${isDocumented ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                                    {isDocumented ? 'Documented' : 'Empty'}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-3">
                                <DataTypeBadge type={row.columnType} />
                              </td>
                              <td className="px-3 py-3">
                                {canEdit ? (
                                  <input
                                    value={row.note?.business_name ?? ''}
                                    onChange={(event) => patchColumnNote(row.tableId, row.columnName, (current) => ({
                                      ...current,
                                      business_name: event.target.value,
                                    }))}
                                    disabled={isSaving}
                                    placeholder="Friendly business label"
                                    className="w-full rounded-md border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                                  />
                                ) : row.note?.business_name ? (
                                  <span className="text-xs text-gray-700">{row.note.business_name}</span>
                                ) : (
                                  <span className="text-[11px] text-gray-300">—</span>
                                )}
                              </td>
                              <td className="px-3 py-3">
                                {canEdit ? (
                                  <textarea
                                    rows={2}
                                    value={row.note?.description ?? ''}
                                    onChange={(event) => patchColumnNote(row.tableId, row.columnName, (current) => ({
                                      ...current,
                                      description: event.target.value,
                                    }))}
                                    disabled={isSaving}
                                    placeholder="What does this column mean?"
                                    className="w-full resize-y rounded-md border border-gray-200 px-3 py-2 text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                                  />
                                ) : row.note?.description ? (
                                  <p className="text-[11px] leading-5 text-gray-600 whitespace-pre-wrap">{row.note.description}</p>
                                ) : (
                                  <span className="text-[11px] text-gray-300">—</span>
                                )}
                              </td>
                              <td className="px-3 py-3">
                                {canEdit ? (
                                  <input
                                    value={examplesValue}
                                    onChange={(event) => patchColumnNote(row.tableId, row.columnName, (current) => ({
                                      ...current,
                                      examples: trimList(event.target.value.split(',')),
                                    }))}
                                    disabled={isSaving}
                                    placeholder="Comma-separated examples"
                                    className="w-full rounded-md border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                                  />
                                ) : (row.note?.examples?.length ?? 0) > 0 ? (
                                  <div className="flex flex-wrap gap-1.5">
                                    {row.note!.examples.map((example) => (
                                      <span key={example} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                                        {example}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-[11px] text-gray-300">—</span>
                                )}
                              </td>
                              {canEdit && (
                                <td className="px-3 py-3 text-right">
                                  <button
                                    type="button"
                                    onClick={() => removeColumnNote(row.tableId, row.columnName)}
                                    disabled={isSaving || !row.note}
                                    className="rounded-md border border-gray-200 px-2.5 py-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    Clear
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function DatasetDictionaryPanel({ datasetId, datasetName, tables, canEdit }: Props) {
  const { data, isLoading, error } = useDatasetDictionary(datasetId);
  const update = useUpdateDatasetDictionary(datasetId);

  // Draft state
  const [draft, setDraft] = useState<DatasetDictionary>(() => normalizeDictionary(null));
  const [isDirty, setIsDirty] = useState(false);

  // Sync draft from server (only when not dirty)
  useEffect(() => {
    if (!isDirty) setDraft(normalizeDictionary(data?.dictionary));
  }, [data?.dictionary, isDirty]);

  // Patch helper
  const patch = (updater: (current: DatasetDictionary) => DatasetDictionary) => {
    setDraft((current) => updater(current));
    setIsDirty(true);
  };

  // Save
  const save = async () => {
    try {
      await update.mutateAsync(buildPayload(draft));
      setIsDirty(false);
      toast.success('Dictionary saved.');
    } catch {
      toast.error('Failed to save dictionary.');
    }
  };

  // Derived
  const updatedAt = fmtTime(data?.dictionary_updated_at);

  // ─── Loading / error ────────────────────────────────────────────────────────

  if (isLoading) return <div className="h-full animate-pulse bg-gray-50" />;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
            <BookOpen className="h-5 w-5 text-red-400" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">Could not load dictionary</h3>
          <p className="mt-2 text-sm text-gray-500">
            The dataset is available but the dictionary could not be loaded right now.
          </p>
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col bg-white">
      {/* ── Top bar ── */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-5 py-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">Dictionary Catalog</div>
          <div className="text-xs text-gray-500">
            Document table and column meaning directly from the dataset model workspace.
          </div>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">
          {updatedAt ? `Saved ${updatedAt}` : datasetName}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={save}
            disabled={!isDirty || update.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      <DictionaryCatalog
        draft={draft}
        tables={tables}
        canEdit={canEdit}
        isSaving={update.isPending}
        onPatch={patch}
      />

      {/* Status bar */}
      <div className="shrink-0 border-t border-gray-100 px-5 py-2 text-xs text-gray-400">
        {canEdit ? (isDirty ? 'Unsaved changes — click Save to persist.' : 'All changes saved.') : 'View only'}
      </div>
    </div>
  );
}
