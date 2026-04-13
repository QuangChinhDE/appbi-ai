'use client';

/**
 * DatasetDictionaryPanel — Business Glossary editor for a dataset.
 *
 * After the rework (Session 3) this panel contains ONLY the Glossary section.
 * The Tables / column-quality section was moved to DatasetQualityPanel (Quality tab).
 *
 * Props interface is preserved for backward compatibility.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Plus,
  Search,
  Tags,
  Trash2,
} from 'lucide-react';
import {
  useDatasetDictionary,
  useUpdateDatasetDictionary,
  type DatasetDictionary,
  type DatasetDictionaryCategory,
  type DatasetDictionaryTerm,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { toast } from 'sonner';
import {
  buildPayload,
  normalizeDictionary,
  tableLabel,
  TokenEditor,
} from './dataset-catalog-shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  datasetId: number;
  datasetName: string;
  tables: DatasetTable[];
  canEdit: boolean;
}

const emptyTerm = (): DatasetDictionaryTerm => ({
  term: '', definition: '', category: 'other',
  synonyms: [], related_tables: [], related_columns: [], examples: [],
});

const fmtTime = (value?: string | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : null;

// ─── Main panel ───────────────────────────────────────────────────────────────

export function DatasetDictionaryPanel({ datasetId, datasetName, tables, canEdit }: Props) {
  const { data, isLoading, error } = useDatasetDictionary(datasetId);
  const update = useUpdateDatasetDictionary(datasetId);

  // Glossary state
  const [glossarySearch, setGlossarySearch] = useState('');
  const [selectedGlossaryIndex, setSelectedGlossaryIndex] = useState<number | null>(null);

  // Draft state
  const [draft, setDraft] = useState<DatasetDictionary>(() => normalizeDictionary(null));
  const [isDirty, setIsDirty] = useState(false);

  // Sync draft from server (only when not dirty)
  useEffect(() => {
    if (!isDirty) setDraft(normalizeDictionary(data?.dictionary));
  }, [data?.dictionary, isDirty]);

  // Auto-select first glossary term
  useEffect(() => {
    if (draft.glossary.length === 0) return void setSelectedGlossaryIndex(null);
    if (selectedGlossaryIndex === null || selectedGlossaryIndex >= draft.glossary.length)
      setSelectedGlossaryIndex(0);
  }, [draft.glossary, selectedGlossaryIndex]);

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
      toast.success('Glossary saved.');
    } catch {
      toast.error('Failed to save glossary.');
    }
  };

  // Derived
  const updatedAt = fmtTime(data?.dictionary_updated_at);
  const selectedGlossary = selectedGlossaryIndex !== null ? draft.glossary[selectedGlossaryIndex] ?? null : null;

  const glossaryItems = useMemo(
    () =>
      draft.glossary
        .map((term, index) => ({ term, index }))
        .filter(({ term }) => {
          const q = glossarySearch.trim().toLowerCase();
          if (!q) return true;
          return [term.term, term.definition, ...(term.synonyms ?? []), ...(term.related_columns ?? [])]
            .join(' ').toLowerCase().includes(q);
        }),
    [draft.glossary, glossarySearch],
  );

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
        <div className="inline-flex items-center gap-1.5">
          <Tags className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-semibold text-gray-900">Business Glossary</span>
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

      {/* ── Glossary section ── */}
      <div className="flex min-h-0 flex-1">

        {/* Left panel — term list */}
        <div className="flex w-72 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
          <div className="border-b border-gray-200 p-4">
            <div className="mb-1 text-sm font-semibold text-gray-900">Terms</div>
            <div className="text-xs text-gray-500">
              Define shared terms so everyone reads data the same way.
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  patch((current) => ({ ...current, glossary: [...current.glossary, emptyTerm()] }));
                  setSelectedGlossaryIndex(draft.glossary.length);
                }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Add term
              </button>
            )}
            {draft.glossary.length > 0 && (
              <div className="relative mt-3">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  value={glossarySearch}
                  onChange={(e) => setGlossarySearch(e.target.value)}
                  placeholder="Search terms…"
                  className="w-full rounded-md border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {glossaryItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-400">
                {draft.glossary.length === 0 ? 'No glossary terms yet.' : 'No terms match.'}
              </div>
            ) : (
              glossaryItems.map(({ term, index }) => (
                <button
                  key={`${term.term}-${index}`}
                  type="button"
                  onClick={() => setSelectedGlossaryIndex(index)}
                  className={`mb-1.5 w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selectedGlossaryIndex === index
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-transparent bg-white hover:border-gray-200'
                  }`}
                >
                  <div className="truncate text-sm font-medium text-gray-900">
                    {term.term || 'Untitled term'}
                  </div>
                  <div className="mt-0.5 text-[11px] uppercase tracking-wide text-gray-400">
                    {term.category}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right panel — term editor */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {!selectedGlossary ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-sm text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                  <Tags className="h-5 w-5 text-gray-400" />
                </div>
                <h3 className="text-base font-semibold text-gray-900">Pick a glossary term</h3>
                <p className="mt-2 text-sm text-gray-500">
                  Add the business terms that people repeatedly ask about or tend to misunderstand.
                </p>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl p-6">
              <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {selectedGlossary.term || 'New term'}
                  </h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Define this term clearly so the team uses data consistently.
                  </p>
                </div>
                {canEdit && selectedGlossaryIndex !== null && (
                  <button
                    type="button"
                    onClick={() =>
                      patch((current) => ({
                        ...current,
                        glossary: current.glossary.filter((_, i) => i !== selectedGlossaryIndex),
                      }))
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-200 hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove term
                  </button>
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_160px]">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">Term</label>
                  <input
                    value={selectedGlossary.term}
                    onChange={(e) =>
                      patch((current) => ({
                        ...current,
                        glossary: current.glossary.map((item, i) =>
                          i === selectedGlossaryIndex ? { ...item, term: e.target.value } : item,
                        ),
                      }))
                    }
                    disabled={!canEdit || update.isPending}
                    placeholder="e.g. Monthly Recurring Revenue"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">Category</label>
                  <select
                    value={selectedGlossary.category}
                    onChange={(e) =>
                      patch((current) => ({
                        ...current,
                        glossary: current.glossary.map((item, i) =>
                          i === selectedGlossaryIndex
                            ? { ...item, category: e.target.value as DatasetDictionaryCategory }
                            : item,
                        ),
                      }))
                    }
                    disabled={!canEdit || update.isPending}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                  >
                    <option value="metric">Metric</option>
                    <option value="dimension">Dimension</option>
                    <option value="entity">Entity</option>
                    <option value="rule">Rule</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="mt-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Definition</label>
                <textarea
                  rows={5}
                  value={selectedGlossary.definition}
                  onChange={(e) =>
                    patch((current) => ({
                      ...current,
                      glossary: current.glossary.map((item, i) =>
                        i === selectedGlossaryIndex ? { ...item, definition: e.target.value } : item,
                      ),
                    }))
                  }
                  disabled={!canEdit || update.isPending}
                  placeholder="Provide a clear, unambiguous definition of this term."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                />
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">Synonyms</label>
                  <TokenEditor
                    values={selectedGlossary.synonyms}
                    onChange={(values) =>
                      patch((current) => ({
                        ...current,
                        glossary: current.glossary.map((item, i) =>
                          i === selectedGlossaryIndex ? { ...item, synonyms: values } : item,
                        ),
                      }))
                    }
                    placeholder="Add a synonym…"
                    disabled={!canEdit || update.isPending}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">Related columns</label>
                  <TokenEditor
                    values={selectedGlossary.related_columns}
                    onChange={(values) =>
                      patch((current) => ({
                        ...current,
                        glossary: current.glossary.map((item, i) =>
                          i === selectedGlossaryIndex ? { ...item, related_columns: values } : item,
                        ),
                      }))
                    }
                    placeholder="Add a related column…"
                    disabled={!canEdit || update.isPending}
                  />
                </div>
              </div>

              <div className="mt-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Examples</label>
                <TokenEditor
                  values={selectedGlossary.examples}
                  onChange={(values) =>
                    patch((current) => ({
                      ...current,
                      glossary: current.glossary.map((item, i) =>
                        i === selectedGlossaryIndex ? { ...item, examples: values } : item,
                      ),
                    }))
                  }
                  placeholder="Add an example…"
                  disabled={!canEdit || update.isPending}
                />
              </div>

              <div className="mt-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Related tables</label>
                <div className="flex flex-wrap gap-2">
                  {tables.map((table) => {
                    const selected = selectedGlossary.related_tables.includes(table.id);
                    return (
                      <button
                        key={table.id}
                        type="button"
                        disabled={!canEdit || update.isPending}
                        onClick={() =>
                          patch((current) => ({
                            ...current,
                            glossary: current.glossary.map((item, i) =>
                              i !== selectedGlossaryIndex
                                ? item
                                : {
                                    ...item,
                                    related_tables: selected
                                      ? item.related_tables.filter((id) => id !== table.id)
                                      : [...item.related_tables, table.id],
                                  },
                            ),
                          }))
                        }
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors disabled:cursor-default ${
                          selected
                            ? 'border-blue-200 bg-blue-50 text-blue-700'
                            : 'border-gray-200 bg-white text-gray-600 hover:border-blue-200 hover:text-blue-600'
                        }`}
                      >
                        {tableLabel(table)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="shrink-0 border-t border-gray-100 px-5 py-2 text-xs text-gray-400">
        {canEdit ? (isDirty ? 'Unsaved changes — click Save to persist.' : 'All changes saved.') : 'View only'}
      </div>
    </div>
  );
}
