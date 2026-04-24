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
  note?.description?.trim(),
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
              row.note?.description ?? '',
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
      <div className="flex shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] px-5 py-2.5">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search table, column, description…"
            className="w-full rounded-md border border-[rgb(var(--border-line))] py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <span className="text-[11px] text-text-quaternary shrink-0">
          {documentedColumns} documented / {totalColumns} column{totalColumns !== 1 ? 's' : ''} · {visibleTableCount} table{visibleTableCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {tables.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-sm text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2">
                <Table2 className="h-5 w-5 text-text-quaternary" />
              </div>
              <h3 className="text-base font-semibold text-text-primary">No dataset tables yet</h3>
              <p className="mt-2 text-sm text-text-tertiary">
                Add tables to this dataset before editing the shared dictionary catalog.
              </p>
            </div>
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-text-quaternary">
            No columns match &quot;{search}&quot;.
          </div>
        ) : (
          <div className="divide-y divide-[rgb(var(--border-line))]">
            {grouped.map((group) => (
              <div key={group.table.id}>
                {/* Table header */}
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-5 py-2">
                  <Table2 className="h-3.5 w-3.5 text-text-quaternary" />
                  <span className="text-xs font-semibold text-text-secondary">{group.tableName}</span>
                  <span className="text-[10px] text-text-quaternary">{group.documentedColumns}/{group.totalColumns} documented</span>
                </div>
                <TableNotesBar
                  tableNote={group.tableNote}
                  canEdit={canEdit}
                  isSaving={isSaving}
                  onPatchNote={(updater) => patchTableNote(group.table.id, updater)}
                />
                {group.totalColumns === 0 ? (
                  <div className="px-5 py-6 text-sm text-text-quaternary">
                    Column metadata is not available for this table yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full table-fixed">
                      <thead className="border-b border-[rgb(var(--border-line))] bg-surface-1">
                        <tr>
                          <th className="w-[220px] px-5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">Column</th>
                          <th className="w-[120px] px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">Type</th>
                          <th className="px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">Description</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                        {group.rows.map((row) => {
                          const isDocumented = hasColumnDictionaryContent(row.note);

                          return (
                            <tr key={`${row.tableId}-${row.columnName}`} className="align-top hover:bg-brand/15/20 transition-colors">
                              <td className="px-5 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs font-medium text-text-primary">{row.columnName}</span>
                                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${isDocumented ? 'bg-success/10 text-success' : 'bg-surface-2 text-text-tertiary'}`}>
                                    {isDocumented ? 'Documented' : 'Empty'}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-3">
                                <DataTypeBadge type={row.columnType} />
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
                                    className="w-full resize-y rounded-md border border-[rgb(var(--border-line))] px-3 py-2 text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                                  />
                                ) : row.note?.description ? (
                                  <p className="text-[11px] leading-5 text-text-secondary whitespace-pre-wrap">{row.note.description}</p>
                                ) : (
                                  <span className="text-[11px] text-text-quaternary">—</span>
                                )}
                              </td>
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
  const visibleTables = useMemo(
    () => tables.filter((table) => table.source_kind !== 'generated_calendar'),
    [tables],
  );
  const draftStorageKey = `appbi:dataset-dictionary-draft:${datasetId}`;
  const serverDictionary = useMemo(() => normalizeDictionary(data?.dictionary), [data?.dictionary]);

  // Draft state
  const [draft, setDraft] = useState<DatasetDictionary>(() => normalizeDictionary(null));
  const [isDirty, setIsDirty] = useState(false);
  const [didAttemptRestore, setDidAttemptRestore] = useState(false);
  const [restoredLocalDraft, setRestoredLocalDraft] = useState(false);

  useEffect(() => {
    if (isLoading || didAttemptRestore) return;
    const samePayload = (left: DatasetDictionary, right: DatasetDictionary) => (
      JSON.stringify(buildPayload(left)) === JSON.stringify(buildPayload(right))
    );

    if (typeof window === 'undefined') {
      setDraft(serverDictionary);
      setDidAttemptRestore(true);
      return;
    }

    try {
      const raw = window.localStorage.getItem(draftStorageKey);
      if (!raw) {
        setDraft(serverDictionary);
      } else {
        const restored = normalizeDictionary(JSON.parse(raw));
        if (samePayload(restored, serverDictionary)) {
          window.localStorage.removeItem(draftStorageKey);
          setDraft(serverDictionary);
        } else {
          setDraft(restored);
          setIsDirty(true);
          setRestoredLocalDraft(true);
        }
      }
    } catch {
      setDraft(serverDictionary);
    } finally {
      setDidAttemptRestore(true);
    }
  }, [didAttemptRestore, draftStorageKey, isLoading, serverDictionary]);

  // Sync draft from server (only when not dirty)
  useEffect(() => {
    if (!didAttemptRestore) return;
    if (!isDirty) setDraft(serverDictionary);
  }, [didAttemptRestore, isDirty, serverDictionary]);

  useEffect(() => {
    if (!didAttemptRestore || !canEdit || typeof window === 'undefined') return;
    try {
      if (!isDirty) {
        window.localStorage.removeItem(draftStorageKey);
        return;
      }
      window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
    } catch {
      // Ignore storage quota / browser privacy failures.
    }
  }, [canEdit, didAttemptRestore, draft, draftStorageKey, isDirty]);

  // Patch helper
  const patch = (updater: (current: DatasetDictionary) => DatasetDictionary) => {
    setDraft((current) => updater(current));
    setIsDirty(true);
  };

  const discardDraft = () => {
    setDraft(serverDictionary);
    setIsDirty(false);
    setRestoredLocalDraft(false);
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(draftStorageKey);
    } catch {
      // Ignore storage failures when discarding local drafts.
    }
    toast.success('Local draft discarded.');
  };

  // Save
  const save = async () => {
    try {
      await update.mutateAsync(buildPayload(draft));
      setIsDirty(false);
      setRestoredLocalDraft(false);
      toast.success('Dictionary saved.');
    } catch {
      toast.error('Failed to save dictionary.');
    }
  };

  // Derived
  const updatedAt = fmtTime(data?.dictionary_updated_at);

  // ─── Loading / error ────────────────────────────────────────────────────────

  if (isLoading) return <div className="h-full animate-pulse bg-surface-2" />;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
            <BookOpen className="h-5 w-5 text-danger" />
          </div>
          <h3 className="text-base font-semibold text-text-primary">Could not load dictionary</h3>
          <p className="mt-2 text-sm text-text-tertiary">
            The dataset is available but the dictionary could not be loaded right now.
          </p>
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col bg-surface-1">
      {/* ── Top bar ── */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] px-5 py-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">Dictionary Catalog</div>
          <div className="text-xs text-text-tertiary">
            Document table and column meaning directly from the dataset model workspace.
          </div>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-text-quaternary">
          {updatedAt ? `Saved ${updatedAt}` : datasetName}
        </span>
        {canEdit && isDirty && (
          <button
            type="button"
            onClick={discardDraft}
            disabled={update.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Discard draft
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={save}
            disabled={!isDirty || update.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      <DictionaryCatalog
        draft={draft}
        tables={visibleTables}
        canEdit={canEdit}
        isSaving={update.isPending}
        onPatch={patch}
      />

      {/* Status bar */}
      <div className="shrink-0 border-t border-[rgb(var(--border-line))] px-5 py-2 text-xs text-text-quaternary">
        {canEdit
          ? (isDirty
            ? (restoredLocalDraft
              ? 'Local browser draft restored — click Save to persist or Discard draft to revert.'
              : 'Unsaved changes are stored in this browser until you save or discard them.')
            : 'All changes saved.')
          : 'View only'}
      </div>
    </div>
  );
}
