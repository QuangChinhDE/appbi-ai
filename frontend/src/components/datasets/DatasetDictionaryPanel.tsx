'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
  ShieldCheck,
  Table2,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import {
  useDatasetDictionary,
  useUpdateDatasetDictionary,
  type DatasetDictionary,
  type DatasetDictionaryCategory,
  type DatasetDictionaryColumnNote,
  type DatasetDictionaryColumnQuality,
  type DatasetDictionaryQualityFormatHint,
  type DatasetDictionaryQualitySeverity,
  type DatasetDictionaryTableNote,
  type DatasetDictionaryTerm,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { AppModalShell } from '@/components/common/AppModalShell';
import { toast } from 'sonner';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  datasetId: number;
  datasetName: string;
  tables: DatasetTable[];
  canEdit: boolean;
}

type CatalogSection = 'tables' | 'glossary';
type ColumnFilterMode = 'all' | 'documented' | 'quality';
type ColumnModalTab = 'meaning' | 'quality';

// ─── Constants ────────────────────────────────────────────────────────────────

const FORMAT_HINTS: DatasetDictionaryQualityFormatHint[] = [
  'email', 'phone', 'url', 'date', 'datetime', 'currency', 'percent', 'custom',
];
const QUALITY_SEVERITIES: DatasetDictionaryQualitySeverity[] = ['info', 'warning', 'error'];
const EMPTY: DatasetDictionary = {
  overview: '', business_purpose: '', usage_guidelines: '', ai_context: '',
  default_filters: [], warnings: [], glossary: [], table_notes: [],
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const trimList = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);
const fmtTime = (value?: string | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : null;
const tableLabel = (table?: DatasetTable | null) =>
  table?.display_name || table?.source_table_name || 'Untitled table';
const tableColumns = (table?: DatasetTable | null): string[] => {
  const raw = (table as any)?.columns_cache;
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'string' ? v : v?.name)).filter(Boolean);
  const cols = Array.isArray(raw?.columns) ? raw.columns : [];
  return cols.map((v: any) => (typeof v === 'string' ? v : v?.name)).filter(Boolean);
};
const emptyQuality = (): DatasetDictionaryColumnQuality => ({ accepted_values: [] });
const emptyColumn = (column_name: string): DatasetDictionaryColumnNote => ({
  column_name, description: '', business_name: '', examples: [], quality: undefined,
});
const emptyTable = (table_id: number): DatasetDictionaryTableNote => ({
  table_id, business_role: '', grain: '', join_hint: '', owner_note: '',
  freshness_expectation: '', row_count_expectation: '', important_columns: [], column_notes: [],
});
const emptyTerm = (): DatasetDictionaryTerm => ({
  term: '', definition: '', category: 'other', synonyms: [], related_tables: [], related_columns: [], examples: [],
});

const hasQuality = (quality?: DatasetDictionaryColumnQuality): boolean =>
  !!quality && (
    typeof quality.required === 'boolean' ||
    typeof quality.unique === 'boolean' ||
    (quality.accepted_values ?? []).length > 0 ||
    `${quality.min_value ?? ''}`.trim() !== '' ||
    `${quality.max_value ?? ''}`.trim() !== '' ||
    (quality.pattern ?? '').trim() !== '' ||
    quality.format_hint !== undefined ||
    typeof quality.null_threshold_percent === 'number' ||
    typeof quality.distinct_threshold === 'number' ||
    quality.severity !== undefined ||
    (quality.notes ?? '').trim() !== ''
  );

const qualityRuleCount = (quality?: DatasetDictionaryColumnQuality): number => {
  if (!quality) return 0;
  let count = 0;
  if (typeof quality.required === 'boolean') count++;
  if (typeof quality.unique === 'boolean') count++;
  if ((quality.accepted_values ?? []).length > 0) count++;
  if (`${quality.min_value ?? ''}`.trim() !== '') count++;
  if (`${quality.max_value ?? ''}`.trim() !== '') count++;
  if ((quality.pattern ?? '').trim() !== '') count++;
  if (quality.format_hint) count++;
  if (typeof quality.null_threshold_percent === 'number') count++;
  if (typeof quality.distinct_threshold === 'number') count++;
  return count;
};

// ─── Normalization ────────────────────────────────────────────────────────────

function normalizeDictionary(value?: DatasetDictionary | null): DatasetDictionary {
  const data = value ?? EMPTY;
  return {
    overview: data.overview ?? '',
    business_purpose: data.business_purpose ?? '',
    usage_guidelines: data.usage_guidelines ?? '',
    ai_context: data.ai_context ?? '',
    default_filters: [...(data.default_filters ?? [])],
    warnings: [...(data.warnings ?? [])],
    glossary: [...(data.glossary ?? [])].map((item) => ({
      term: item.term ?? '',
      definition: item.definition ?? '',
      category: item.category ?? 'other',
      synonyms: [...(item.synonyms ?? [])],
      related_tables: [...(item.related_tables ?? [])],
      related_columns: [...(item.related_columns ?? [])],
      examples: [...(item.examples ?? [])],
    })),
    table_notes: [...(data.table_notes ?? [])].map((item) => ({
      table_id: item.table_id,
      business_role: item.business_role ?? '',
      grain: item.grain ?? '',
      join_hint: item.join_hint ?? '',
      owner_note: item.owner_note ?? '',
      freshness_expectation: item.freshness_expectation ?? '',
      row_count_expectation: item.row_count_expectation ?? '',
      important_columns: [...(item.important_columns ?? [])],
      column_notes: [...(item.column_notes ?? [])].map((note) => ({
        column_name: note.column_name ?? '',
        description: note.description ?? '',
        business_name: note.business_name ?? '',
        examples: [...(note.examples ?? [])],
        quality: note.quality
          ? {
              accepted_values: [...(note.quality.accepted_values ?? [])],
              required: note.quality.required,
              unique: note.quality.unique,
              min_value: note.quality.min_value ?? '',
              max_value: note.quality.max_value ?? '',
              pattern: note.quality.pattern ?? '',
              format_hint: note.quality.format_hint,
              null_threshold_percent: note.quality.null_threshold_percent,
              distinct_threshold: note.quality.distinct_threshold,
              severity: note.quality.severity,
              notes: note.quality.notes ?? '',
            }
          : undefined,
      })),
    })),
  };
}

function saveQuality(quality?: DatasetDictionaryColumnQuality): DatasetDictionaryColumnQuality | undefined {
  if (!quality) return undefined;
  const payload: DatasetDictionaryColumnQuality = { accepted_values: trimList(quality.accepted_values ?? []) };
  if (typeof quality.required === 'boolean') payload.required = quality.required;
  if (typeof quality.unique === 'boolean') payload.unique = quality.unique;
  if (`${quality.min_value ?? ''}`.trim())
    payload.min_value = typeof quality.min_value === 'number' ? quality.min_value : `${quality.min_value}`.trim();
  if (`${quality.max_value ?? ''}`.trim())
    payload.max_value = typeof quality.max_value === 'number' ? quality.max_value : `${quality.max_value}`.trim();
  if (quality.pattern?.trim()) payload.pattern = quality.pattern.trim();
  if (quality.format_hint) payload.format_hint = quality.format_hint;
  if (typeof quality.null_threshold_percent === 'number' && !Number.isNaN(quality.null_threshold_percent))
    payload.null_threshold_percent = quality.null_threshold_percent;
  if (typeof quality.distinct_threshold === 'number' && !Number.isNaN(quality.distinct_threshold))
    payload.distinct_threshold = quality.distinct_threshold;
  if (quality.severity) payload.severity = quality.severity;
  if (quality.notes?.trim()) payload.notes = quality.notes.trim();
  return hasQuality(payload) ? payload : undefined;
}

function buildPayload(draft: DatasetDictionary): DatasetDictionary {
  return {
    overview: draft.overview?.trim() || undefined,
    business_purpose: draft.business_purpose?.trim() || undefined,
    usage_guidelines: draft.usage_guidelines?.trim() || undefined,
    ai_context: draft.ai_context?.trim() || undefined,
    default_filters: trimList(draft.default_filters ?? []),
    warnings: trimList(draft.warnings ?? []),
    glossary: (draft.glossary ?? [])
      .map((item) => ({
        ...item,
        term: item.term.trim(),
        definition: item.definition.trim(),
        synonyms: trimList(item.synonyms),
        related_columns: trimList(item.related_columns),
        examples: trimList(item.examples),
      }))
      .filter((item) => item.term && item.definition),
    table_notes: (draft.table_notes ?? [])
      .map((item) => ({
        ...item,
        business_role: item.business_role?.trim() || undefined,
        grain: item.grain?.trim() || undefined,
        join_hint: item.join_hint?.trim() || undefined,
        owner_note: item.owner_note?.trim() || undefined,
        freshness_expectation: item.freshness_expectation?.trim() || undefined,
        row_count_expectation: item.row_count_expectation?.trim() || undefined,
        important_columns: trimList(item.important_columns ?? []),
        column_notes: (item.column_notes ?? [])
          .map((note) => ({
            column_name: note.column_name.trim(),
            description: note.description?.trim() || undefined,
            business_name: note.business_name?.trim() || undefined,
            examples: trimList(note.examples ?? []),
            quality: saveQuality(note.quality),
          }))
          .filter((note) => note.column_name && (note.description || note.business_name || note.examples.length > 0 || note.quality)),
      }))
      .filter(
        (item) =>
          item.business_role ||
          item.grain ||
          item.join_hint ||
          item.owner_note ||
          item.freshness_expectation ||
          item.row_count_expectation ||
          (item.important_columns ?? []).length > 0 ||
          (item.column_notes ?? []).length > 0,
      ),
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Badge({
  tone,
  children,
}: {
  tone: 'gray' | 'blue' | 'green' | 'amber' | 'red';
  children: React.ReactNode;
}) {
  const cls = {
    gray: 'border-gray-200 bg-gray-50 text-gray-600',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    red: 'border-red-200 bg-red-50 text-red-700',
  };
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls[tone]}`}>
      {children}
    </span>
  );
}

function TokenEditor({
  values,
  onChange,
  placeholder,
  disabled,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled: boolean;
}) {
  const [input, setInput] = useState('');
  const add = () => {
    const next = input.trim();
    if (!next || values.some((v) => v.toLowerCase() === next.toLowerCase())) return setInput('');
    onChange([...values, next]);
    setInput('');
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-700"
          >
            {value}
            {!disabled && (
              <button type="button" onClick={() => onChange(values.filter((v) => v !== value))}>
                <X className="h-3 w-3 text-gray-400 hover:text-red-500" />
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={placeholder}
            className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={add}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function ColumnModal({
  open,
  tableName,
  note,
  canEdit,
  defaultTab,
  onClose,
  onChange,
  onRemove,
}: {
  open: boolean;
  tableName: string;
  note: DatasetDictionaryColumnNote | null;
  canEdit: boolean;
  defaultTab: ColumnModalTab;
  onClose: () => void;
  onChange: (updater: (current: DatasetDictionaryColumnNote) => DatasetDictionaryColumnNote) => void;
  onRemove: () => void;
}) {
  const [tab, setTab] = useState<ColumnModalTab>(defaultTab);

  useEffect(() => {
    if (open) setTab(defaultTab);
  }, [open, note?.column_name, defaultTab]);

  if (!open || !note) return null;

  return (
    <AppModalShell
      onClose={onClose}
      title={note.column_name}
      description={`${tableName} · column`}
      icon={<ShieldCheck className="h-5 w-5" />}
      maxWidthClass="max-w-4xl"
      panelClassName="max-h-[88vh]"
      bodyClassName="p-0"
      footer={
        <>
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="mr-auto inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove from catalog
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
      {/* Tab nav */}
      <div className="border-b border-gray-200 px-6 py-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
          <button
            type="button"
            onClick={() => setTab('meaning')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'meaning' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Meaning
          </button>
          <button
            type="button"
            onClick={() => setTab('quality')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'quality' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Quality
            {hasQuality(note.quality) && (
              <span className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700">
                {qualityRuleCount(note.quality)}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="space-y-5 p-6">
        {tab === 'meaning' ? (
          <>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Business name</label>
              <input
                value={note.business_name ?? ''}
                onChange={(e) => onChange((cur) => ({ ...cur, business_name: e.target.value }))}
                disabled={!canEdit}
                placeholder="Optional friendly name for business users"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Description</label>
              <textarea
                rows={5}
                value={note.description ?? ''}
                onChange={(e) => onChange((cur) => ({ ...cur, description: e.target.value }))}
                disabled={!canEdit}
                placeholder="Explain what this column means, how it should be interpreted, and any caveats."
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Examples</label>
              <TokenEditor
                values={note.examples ?? []}
                onChange={(values) => onChange((cur) => ({ ...cur, examples: values }))}
                placeholder="Add a sample value..."
                disabled={!canEdit}
              />
            </div>
          </>
        ) : (
          <>
            {/* Boolean flags */}
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 hover:border-gray-300">
                <input
                  type="checkbox"
                  checked={note.quality?.required === true}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: { ...emptyQuality(), ...(cur.quality ?? {}), required: e.target.checked },
                    }))
                  }
                  disabled={!canEdit}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <div className="text-sm font-medium text-gray-900">Required</div>
                  <p className="mt-0.5 text-xs text-gray-500">Flag null or blank values as an issue.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 hover:border-gray-300">
                <input
                  type="checkbox"
                  checked={note.quality?.unique === true}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: { ...emptyQuality(), ...(cur.quality ?? {}), unique: e.target.checked },
                    }))
                  }
                  disabled={!canEdit}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <div className="text-sm font-medium text-gray-900">Unique</div>
                  <p className="mt-0.5 text-xs text-gray-500">Expected to have no duplicates.</p>
                </div>
              </label>
            </div>

            {/* Range constraints */}
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Minimum value</label>
                <input
                  value={note.quality?.min_value ?? ''}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: { ...emptyQuality(), ...(cur.quality ?? {}), min_value: e.target.value },
                    }))
                  }
                  disabled={!canEdit}
                  placeholder="e.g. 0"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Maximum value</label>
                <input
                  value={note.quality?.max_value ?? ''}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: { ...emptyQuality(), ...(cur.quality ?? {}), max_value: e.target.value },
                    }))
                  }
                  disabled={!canEdit}
                  placeholder="e.g. 100"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Null threshold %</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={note.quality?.null_threshold_percent ?? ''}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: {
                        ...emptyQuality(),
                        ...(cur.quality ?? {}),
                        null_threshold_percent: e.target.value === '' ? undefined : Number(e.target.value),
                      },
                    }))
                  }
                  disabled={!canEdit}
                  placeholder="e.g. 5"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Distinct threshold</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={note.quality?.distinct_threshold ?? ''}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: {
                        ...emptyQuality(),
                        ...(cur.quality ?? {}),
                        distinct_threshold: e.target.value === '' ? undefined : Number(e.target.value),
                      },
                    }))
                  }
                  disabled={!canEdit}
                  placeholder="e.g. 50"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                />
              </div>
            </div>

            {/* Format + Severity */}
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Format hint</label>
                <select
                  value={note.quality?.format_hint ?? ''}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: {
                        ...emptyQuality(),
                        ...(cur.quality ?? {}),
                        format_hint: (e.target.value || undefined) as DatasetDictionaryQualityFormatHint | undefined,
                      },
                    }))
                  }
                  disabled={!canEdit}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                >
                  <option value="">None</option>
                  {FORMAT_HINTS.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Severity</label>
                <select
                  value={note.quality?.severity ?? ''}
                  onChange={(e) =>
                    onChange((cur) => ({
                      ...cur,
                      quality: {
                        ...emptyQuality(),
                        ...(cur.quality ?? {}),
                        severity: (e.target.value || undefined) as DatasetDictionaryQualitySeverity | undefined,
                      },
                    }))
                  }
                  disabled={!canEdit}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                >
                  <option value="">None</option>
                  {QUALITY_SEVERITIES.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Accepted values */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Accepted values</label>
              <TokenEditor
                values={note.quality?.accepted_values ?? []}
                onChange={(values) =>
                  onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), accepted_values: values },
                  }))
                }
                placeholder="Add an accepted value..."
                disabled={!canEdit}
              />
            </div>

            {/* Pattern */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Pattern / regex</label>
              <input
                value={note.quality?.pattern ?? ''}
                onChange={(e) =>
                  onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), pattern: e.target.value },
                  }))
                }
                disabled={!canEdit}
                placeholder="Optional regex or format pattern"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Quality notes</label>
              <textarea
                rows={3}
                value={note.quality?.notes ?? ''}
                onChange={(e) =>
                  onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), notes: e.target.value },
                  }))
                }
                disabled={!canEdit}
                placeholder="Describe how this column should be monitored or what issue patterns matter."
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
              />
            </div>
          </>
        )}
      </div>
    </AppModalShell>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function DatasetDictionaryPanel({ datasetId, datasetName, tables, canEdit }: Props) {
  const { data, isLoading, error } = useDatasetDictionary(datasetId);
  const update = useUpdateDatasetDictionary(datasetId);

  // Section state
  const [section, setSection] = useState<CatalogSection>('tables');

  // Tables section state
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [tableToAdd, setTableToAdd] = useState<number | null>(null);
  const [metaExpanded, setMetaExpanded] = useState(false);

  // Column grid state
  const [columnSearch, setColumnSearch] = useState('');
  const [columnFilter, setColumnFilter] = useState<ColumnFilterMode>('all');
  const [activeColumn, setActiveColumn] = useState<string | null>(null);
  const [activeColumnDefaultTab, setActiveColumnDefaultTab] = useState<ColumnModalTab>('meaning');

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

  // Auto-select first documented table
  useEffect(() => {
    const ids = draft.table_notes.map((item) => item.table_id);
    if (ids.length === 0) return void setSelectedTableId(null);
    if (!selectedTableId || !ids.includes(selectedTableId)) setSelectedTableId(ids[0]);
  }, [draft.table_notes, selectedTableId]);

  // Auto-select first glossary term
  useEffect(() => {
    if (draft.glossary.length === 0) return void setSelectedGlossaryIndex(null);
    if (selectedGlossaryIndex === null || selectedGlossaryIndex >= draft.glossary.length)
      setSelectedGlossaryIndex(0);
  }, [draft.glossary, selectedGlossaryIndex]);

  // Patch helper (marks dirty)
  const patch = (updater: (current: DatasetDictionary) => DatasetDictionary) => {
    setDraft((current) => updater(current));
    setIsDirty(true);
  };

  // Save
  const save = async () => {
    try {
      await update.mutateAsync(buildPayload(draft));
      setIsDirty(false);
      toast.success('Catalog saved.');
    } catch {
      toast.error('Failed to save catalog.');
    }
  };

  // Open column modal helper
  const openColumnModal = (column: string, defaultTab: ColumnModalTab = 'meaning') => {
    const note = selectedTableNote?.column_notes.find((n) => n.column_name === column);
    if (!note && canEdit) {
      patch((current) => ({
        ...current,
        table_notes: current.table_notes.map((item) =>
          item.table_id === selectedTableId
            ? { ...item, column_notes: [...item.column_notes, emptyColumn(column)] }
            : item,
        ),
      }));
    }
    if (note || canEdit) {
      setActiveColumnDefaultTab(defaultTab);
      setActiveColumn(column);
    }
  };

  // Derived values
  const updatedAt = fmtTime(data?.dictionary_updated_at);
  const documentedIds = useMemo(
    () => new Set(draft.table_notes.map((item) => item.table_id)),
    [draft.table_notes],
  );
  const addableTables = useMemo(
    () => tables.filter((table) => !documentedIds.has(table.id)),
    [documentedIds, tables],
  );
  const documentedTables = useMemo(
    () => draft.table_notes.map((note) => ({ note, table: tables.find((t) => t.id === note.table_id) ?? null })),
    [draft.table_notes, tables],
  );
  const selectedTableNote = draft.table_notes.find((item) => item.table_id === selectedTableId) ?? null;
  const selectedTable = tables.find((item) => item.id === selectedTableId) ?? null;
  const selectedGlossary =
    selectedGlossaryIndex !== null ? draft.glossary[selectedGlossaryIndex] ?? null : null;

  const columns = useMemo(() => tableColumns(selectedTable), [selectedTable]);
  const activeNote = selectedTableNote?.column_notes.find((item) => item.column_name === activeColumn) ?? null;

  const visibleColumns = useMemo(
    () =>
      columns.filter((column) => {
        const note = selectedTableNote?.column_notes.find((item) => item.column_name === column);
        const documented = !!note;
        const quality = hasQuality(note?.quality);
        if (columnFilter === 'documented' && !documented) return false;
        if (columnFilter === 'quality' && !quality) return false;
        const q = columnSearch.trim().toLowerCase();
        if (!q) return true;
        return [column, note?.business_name ?? '', note?.description ?? '', ...(note?.examples ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(q);
      }),
    [columns, selectedTableNote, columnFilter, columnSearch],
  );

  const glossaryItems = useMemo(
    () =>
      draft.glossary
        .map((term, index) => ({ term, index }))
        .filter(({ term }) => {
          const q = glossarySearch.trim().toLowerCase();
          if (!q) return true;
          return [term.term, term.definition, ...(term.synonyms ?? []), ...(term.related_columns ?? [])]
            .join(' ')
            .toLowerCase()
            .includes(q);
        }),
    [draft.glossary, glossarySearch],
  );

  // ─── Loading / error states ────────────────────────────────────────────────

  if (isLoading) {
    return <div className="h-full animate-pulse bg-gray-50" />;
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
            <BookOpen className="h-5 w-5 text-red-400" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">Could not load catalog</h3>
          <p className="mt-2 text-sm text-gray-500">
            The dataset is available but the catalog payload could not be loaded right now.
          </p>
        </div>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col bg-white">
      {/* ── Top bar ── */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-5 py-3">
        {/* Section toggle */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
          <button
            type="button"
            onClick={() => setSection('tables')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              section === 'tables' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Table2 className="h-3.5 w-3.5" />
            Tables
            {documentedTables.length > 0 && (
              <span className="ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-gray-200 px-1 text-[10px] font-semibold text-gray-600">
                {documentedTables.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setSection('glossary')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              section === 'glossary' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Tags className="h-3.5 w-3.5" />
            Glossary
            {draft.glossary.length > 0 && (
              <span className="ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-gray-200 px-1 text-[10px] font-semibold text-gray-600">
                {draft.glossary.length}
              </span>
            )}
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Metadata */}
        <span className="text-xs text-gray-400">
          {updatedAt ? `Saved ${updatedAt}` : datasetName}
        </span>

        {/* Save */}
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

      {/* ── Tables section ── */}
      {section === 'tables' ? (
        <div className="flex min-h-0 flex-1 flex-col">

          {/* Table selector strip */}
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-gray-200 bg-gray-50 px-5 py-3">
            {documentedTables.length === 0 ? (
              <span className="text-sm text-gray-400">No tables in catalog yet.</span>
            ) : (
              documentedTables.map(({ note, table }) => (
                <button
                  key={note.table_id}
                  type="button"
                  onClick={() => { setSelectedTableId(note.table_id); setColumnSearch(''); setColumnFilter('all'); }}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    selectedTableId === note.table_id
                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-blue-200 hover:text-blue-600'
                  }`}
                >
                  <Table2 className="h-3.5 w-3.5 shrink-0" />
                  {tableLabel(table)}
                  {(note.column_notes ?? []).length > 0 && (
                    <span className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                      selectedTableId === note.table_id ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {(note.column_notes ?? []).length}
                    </span>
                  )}
                </button>
              ))
            )}

            {/* Add table */}
            {canEdit && addableTables.length > 0 && (
              <div className="ml-1 flex shrink-0 items-center gap-1.5">
                <select
                  value={tableToAdd ?? ''}
                  onChange={(e) => {
                    const val = e.target.value ? Number(e.target.value) : null;
                    setTableToAdd(val);
                    // Auto-add immediately on select
                    if (val) {
                      patch((current) => ({
                        ...current,
                        table_notes: [...current.table_notes, emptyTable(val)],
                      }));
                      setSelectedTableId(val);
                      setTableToAdd(null);
                    }
                  }}
                  className="rounded-full border border-dashed border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-500 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">+ Add table to catalog</option>
                  {addableTables.map((table) => (
                    <option key={table.id} value={table.id}>{tableLabel(table)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* No table selected / no documented tables empty state */}
          {!selectedTableNote || !selectedTable ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="max-w-sm text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                  <Table2 className="h-5 w-5 text-gray-400" />
                </div>
                <h3 className="text-base font-semibold text-gray-900">No tables documented yet</h3>
                <p className="mt-2 text-sm text-gray-500">
                  Add tables from the strip above to start documenting columns and configuring quality rules.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">

              {/* Table metadata (collapsible) */}
              <div className="shrink-0 border-b border-gray-200 bg-white">
                <div className="flex items-center px-5 py-3">
                  <button
                    type="button"
                    onClick={() => setMetaExpanded((v) => !v)}
                    className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
                  >
                    {metaExpanded ? (
                      <ChevronUp className="h-4 w-4 text-gray-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-400" />
                    )}
                    Table notes
                    {(selectedTableNote.business_role || selectedTableNote.grain || selectedTableNote.owner_note) && (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
                        configured
                      </span>
                    )}
                  </button>
                  <div className="flex-1" />
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        patch((current) => ({
                          ...current,
                          table_notes: current.table_notes.filter((item) => item.table_id !== selectedTable.id),
                        }));
                        setActiveColumn(null);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-200 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove from catalog
                    </button>
                  )}
                </div>

                {metaExpanded && (
                  <div className="border-t border-gray-100 px-5 pb-4 pt-3">
                    <div className="grid gap-4 md:grid-cols-3">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-gray-500 uppercase tracking-wide">
                          Table purpose
                        </label>
                        <input
                          value={selectedTableNote.business_role ?? ''}
                          onChange={(e) =>
                            patch((current) => ({
                              ...current,
                              table_notes: current.table_notes.map((item) =>
                                item.table_id === selectedTable.id
                                  ? { ...item, business_role: e.target.value }
                                  : item,
                              ),
                            }))
                          }
                          disabled={!canEdit || update.isPending}
                          placeholder="e.g. Order-level fact table"
                          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-gray-500 uppercase tracking-wide">
                          Grain
                        </label>
                        <input
                          value={selectedTableNote.grain ?? ''}
                          onChange={(e) =>
                            patch((current) => ({
                              ...current,
                              table_notes: current.table_notes.map((item) =>
                                item.table_id === selectedTable.id ? { ...item, grain: e.target.value } : item,
                              ),
                            }))
                          }
                          disabled={!canEdit || update.isPending}
                          placeholder="e.g. One row per order item"
                          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-gray-500 uppercase tracking-wide">
                          Freshness expectation
                        </label>
                        <input
                          value={selectedTableNote.freshness_expectation ?? ''}
                          onChange={(e) =>
                            patch((current) => ({
                              ...current,
                              table_notes: current.table_notes.map((item) =>
                                item.table_id === selectedTable.id
                                  ? { ...item, freshness_expectation: e.target.value }
                                  : item,
                              ),
                            }))
                          }
                          disabled={!canEdit || update.isPending}
                          placeholder="e.g. Daily by 8 AM"
                          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                        />
                      </div>
                    </div>
                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-gray-500 uppercase tracking-wide">
                          Table note
                        </label>
                        <textarea
                          rows={3}
                          value={selectedTableNote.owner_note ?? ''}
                          onChange={(e) =>
                            patch((current) => ({
                              ...current,
                              table_notes: current.table_notes.map((item) =>
                                item.table_id === selectedTable.id ? { ...item, owner_note: e.target.value } : item,
                              ),
                            }))
                          }
                          disabled={!canEdit || update.isPending}
                          placeholder="What is this table used for and when should it be trusted?"
                          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-gray-500 uppercase tracking-wide">
                          Join / usage note
                        </label>
                        <textarea
                          rows={3}
                          value={selectedTableNote.join_hint ?? ''}
                          onChange={(e) =>
                            patch((current) => ({
                              ...current,
                              table_notes: current.table_notes.map((item) =>
                                item.table_id === selectedTable.id ? { ...item, join_hint: e.target.value } : item,
                              ),
                            }))
                          }
                          disabled={!canEdit || update.isPending}
                          placeholder="Preferred joins, common filters, or caveats."
                          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Column grid */}
              <div className="flex min-h-0 flex-1 flex-col">
                {/* Grid toolbar */}
                <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-5 py-3">
                  <span className="text-sm font-semibold text-gray-900">
                    Columns
                    {columns.length > 0 && (
                      <span className="ml-1.5 text-sm font-normal text-gray-400">({columns.length})</span>
                    )}
                  </span>
                  <div className="relative min-w-0 flex-1 max-w-xs">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                    <input
                      value={columnSearch}
                      onChange={(e) => setColumnSearch(e.target.value)}
                      placeholder="Search columns…"
                      className="w-full rounded-md border border-gray-200 py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white">
                    {(
                      [
                        ['all', 'All'],
                        ['documented', 'Documented'],
                        ['quality', 'Has rules'],
                      ] as Array<[ColumnFilterMode, string]>
                    ).map(([value, label], i, arr) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setColumnFilter(value)}
                        className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                          i === 0 ? 'rounded-l-[5px]' : ''
                        } ${i === arr.length - 1 ? 'rounded-r-[5px]' : ''} ${
                          columnFilter === value
                            ? 'bg-gray-800 text-white'
                            : 'text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Grid body */}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {columns.length === 0 ? (
                    <div className="flex h-full items-center justify-center p-8 text-sm text-gray-400">
                      Column metadata is not available for this table yet.
                    </div>
                  ) : visibleColumns.length === 0 ? (
                    <div className="flex h-full items-center justify-center p-8 text-sm text-gray-400">
                      No columns match this filter.
                    </div>
                  ) : (
                    <table className="min-w-full">
                      <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
                        <tr>
                          <th className="w-12 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-400" />
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            Column
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            Description
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            Quality rules
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            Last saved
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white">
                        {visibleColumns.map((column) => {
                          const note = selectedTableNote.column_notes.find(
                            (item) => item.column_name === column,
                          );
                          const documented = !!note;
                          const described = !!(note?.description?.trim() || note?.business_name?.trim());
                          const quality = hasQuality(note?.quality);
                          const ruleCount = qualityRuleCount(note?.quality);

                          return (
                            <tr
                              key={column}
                              className="group transition-colors hover:bg-blue-50/40"
                            >
                              {/* Checkbox */}
                              <td className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={documented}
                                  disabled={!canEdit || update.isPending}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    patch((current) => ({
                                      ...current,
                                      table_notes: current.table_notes.map((item) =>
                                        item.table_id !== selectedTable.id
                                          ? item
                                          : {
                                              ...item,
                                              column_notes: checked
                                                ? item.column_notes.find((entry) => entry.column_name === column)
                                                  ? item.column_notes
                                                  : [...item.column_notes, emptyColumn(column)]
                                                : item.column_notes.filter(
                                                    (entry) => entry.column_name !== column,
                                                  ),
                                            },
                                      ),
                                    }));
                                    if (!checked && activeColumn === column) setActiveColumn(null);
                                  }}
                                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                  title={documented ? 'Remove from catalog' : 'Add to catalog'}
                                />
                              </td>

                              {/* Column name — click → open modal to Meaning tab */}
                              <td className="px-4 py-3">
                                <button
                                  type="button"
                                  onClick={() => openColumnModal(column, 'meaning')}
                                  className="text-left"
                                >
                                  <div className="font-mono text-sm font-medium text-gray-900 group-hover:text-blue-700">
                                    {column}
                                  </div>
                                  {note?.business_name && (
                                    <div className="mt-0.5 text-xs text-gray-500">{note.business_name}</div>
                                  )}
                                </button>
                              </td>

                              {/* Description status */}
                              <td className="px-4 py-3">
                                {documented ? (
                                  described ? (
                                    <div>
                                      <Badge tone="green">Documented</Badge>
                                      {note?.description && (
                                        <p className="mt-1 max-w-[240px] truncate text-xs text-gray-400">
                                          {note.description}
                                        </p>
                                      )}
                                    </div>
                                  ) : (
                                    <Badge tone="amber">No description</Badge>
                                  )
                                ) : (
                                  <span className="text-xs text-gray-300">—</span>
                                )}
                              </td>

                              {/* Quality rules — click → open modal to Quality tab */}
                              <td className="px-4 py-3">
                                {quality ? (
                                  <button
                                    type="button"
                                    onClick={() => openColumnModal(column, 'quality')}
                                    className="flex flex-wrap items-center gap-1.5"
                                  >
                                    <Badge tone="blue">
                                      {ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}
                                    </Badge>
                                    {note?.quality?.required === true && <Badge tone="red">Required</Badge>}
                                    {note?.quality?.unique === true && <Badge tone="green">Unique</Badge>}
                                    {note?.quality?.severity && (
                                      <Badge
                                        tone={
                                          note.quality.severity === 'error'
                                            ? 'red'
                                            : note.quality.severity === 'warning'
                                              ? 'amber'
                                              : 'gray'
                                        }
                                      >
                                        {note.quality.severity}
                                      </Badge>
                                    )}
                                  </button>
                                ) : documented ? (
                                  <button
                                    type="button"
                                    onClick={() => openColumnModal(column, 'quality')}
                                    className="text-xs text-gray-400 hover:text-blue-600"
                                  >
                                    + Add rules
                                  </button>
                                ) : (
                                  <span className="text-xs text-gray-300">—</span>
                                )}
                              </td>

                              {/* Last saved */}
                              <td className="px-4 py-3 text-xs text-gray-400">
                                {documented ? (updatedAt || 'Draft') : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ── Glossary section ── */
        <div className="flex min-h-0 flex-1">
          {/* Left panel */}
          <div className="flex w-72 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
            <div className="border-b border-gray-200 p-4">
              <div className="mb-1 text-sm font-semibold text-gray-900">Business Glossary</div>
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

          {/* Right panel */}
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
      )}

      {/* Status bar */}
      <div className="shrink-0 border-t border-gray-100 px-5 py-2 text-xs text-gray-400">
        {canEdit ? (isDirty ? 'Unsaved changes — click Save to persist.' : 'All changes saved.') : 'View only'}
      </div>

      {/* Column modal */}
      <ColumnModal
        open={Boolean(activeColumn && activeNote)}
        tableName={tableLabel(selectedTable)}
        note={activeNote}
        canEdit={canEdit && !update.isPending}
        defaultTab={activeColumnDefaultTab}
        onClose={() => setActiveColumn(null)}
        onChange={(updater) => {
          if (!selectedTable || !activeColumn) return;
          patch((current) => ({
            ...current,
            table_notes: current.table_notes.map((item) =>
              item.table_id !== selectedTable.id
                ? item
                : {
                    ...item,
                    column_notes: item.column_notes.map((entry) =>
                      entry.column_name === activeColumn ? updater(entry) : entry,
                    ),
                  },
            ),
          }));
        }}
        onRemove={() => {
          if (!selectedTable || !activeColumn) return;
          patch((current) => ({
            ...current,
            table_notes: current.table_notes.map((item) =>
              item.table_id !== selectedTable.id
                ? item
                : { ...item, column_notes: item.column_notes.filter((entry) => entry.column_name !== activeColumn) },
            ),
          }));
          setActiveColumn(null);
        }}
      />
    </div>
  );
}
