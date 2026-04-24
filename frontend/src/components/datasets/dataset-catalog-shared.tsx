'use client';

/**
 * Shared helpers, constants, and UI primitives used by both
 * DatasetQualityPanel and DatasetDictionaryPanel.
 *
 * Do NOT import heavy hooks here — only pure logic + React UI components.
 */

import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  type DatasetDictionary,
  type DatasetDictionaryColumnNote,
  type DatasetDictionaryColumnQuality,
  type DatasetDictionaryQualityFormatHint,
  type DatasetDictionaryQualitySeverity,
  type DatasetDictionaryTableNote,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { AppModalShell } from '@/components/common/AppModalShell';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ColumnFilterMode = 'all' | 'documented' | 'quality';
export type ColumnModalTab = 'meaning' | 'quality';

export interface ColumnMeta { name: string; type?: string }

// ─── Constants ────────────────────────────────────────────────────────────────

export const FORMAT_HINTS: DatasetDictionaryQualityFormatHint[] = [
  'email', 'phone', 'url', 'date', 'datetime', 'currency', 'percent', 'custom',
];
export const QUALITY_SEVERITIES: DatasetDictionaryQualitySeverity[] = ['info', 'warning', 'error'];

export const EMPTY_DICTIONARY: DatasetDictionary = {
  overview: '', business_purpose: '', usage_guidelines: '', ai_context: '',
  default_filters: [], warnings: [], table_notes: [],
};

export const DATA_TYPE_DISPLAY: Record<string, { label: string; color: string }> = {
  string:    { label: 'text',     color: 'text-success bg-success/10 border-success/30' },
  varchar:   { label: 'text',     color: 'text-success bg-success/10 border-success/30' },
  text:      { label: 'text',     color: 'text-success bg-success/10 border-success/30' },
  int:       { label: 'int',      color: 'text-brand bg-brand/10 border-brand/30' },
  integer:   { label: 'int',      color: 'text-brand bg-brand/10 border-brand/30' },
  bigint:    { label: 'int',      color: 'text-brand bg-brand/10 border-brand/30' },
  float:     { label: 'float',    color: 'text-brand bg-brand/10 border-brand/30' },
  double:    { label: 'float',    color: 'text-brand bg-brand/10 border-brand/30' },
  decimal:   { label: 'decimal',  color: 'text-brand bg-brand/10 border-brand/30' },
  numeric:   { label: 'decimal',  color: 'text-brand bg-brand/10 border-brand/30' },
  boolean:   { label: 'bool',     color: 'text-warning bg-warning/10 border-warning/30' },
  bool:      { label: 'bool',     color: 'text-warning bg-warning/10 border-warning/30' },
  date:      { label: 'date',     color: 'text-sky-700 bg-sky-50 border-sky-200' },
  datetime:  { label: 'datetime', color: 'text-sky-700 bg-sky-50 border-sky-200' },
  timestamp: { label: 'datetime', color: 'text-sky-700 bg-sky-50 border-sky-200' },
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export const trimList = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);

export const tableLabel = (table?: DatasetTable | null) =>
  table?.display_name || table?.source_table_name || 'Untitled table';

export const tableColumnsMeta = (table?: DatasetTable | null): ColumnMeta[] => {
  const raw = (table as any)?.columns_cache;
  const cols: any[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.columns) ? raw.columns : []);
  return cols
    .map((v: any) => typeof v === 'string' ? { name: v } : { name: v?.name, type: v?.type })
    .filter((v) => Boolean(v.name));
};

export const emptyQuality = (): DatasetDictionaryColumnQuality => ({ accepted_values: [] });

export const emptyColumn = (column_name: string): DatasetDictionaryColumnNote => ({
  column_name, description: '', business_name: '', examples: [], quality: undefined,
});

export const emptyTable = (table_id: number): DatasetDictionaryTableNote => ({
  table_id, business_role: '', grain: '', join_hint: '', owner_note: '',
  freshness_expectation: '', row_count_expectation: '', important_columns: [], column_notes: [],
});

export const hasQuality = (quality?: DatasetDictionaryColumnQuality): boolean =>
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

export const qualityRuleCount = (quality?: DatasetDictionaryColumnQuality): number => {
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

export function normalizeDictionary(value?: DatasetDictionary | null): DatasetDictionary {
  const data = value ?? EMPTY_DICTIONARY;
  return {
    overview: data.overview ?? '',
    business_purpose: data.business_purpose ?? '',
    usage_guidelines: data.usage_guidelines ?? '',
    ai_context: data.ai_context ?? '',
    default_filters: [...(data.default_filters ?? [])],
    warnings: [...(data.warnings ?? [])],
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
        quality: note.quality ? {
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
        } : undefined,
      })),
    })),
  };
}

export function saveQuality(quality?: DatasetDictionaryColumnQuality): DatasetDictionaryColumnQuality | undefined {
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

export function buildPayload(draft: DatasetDictionary): DatasetDictionary {
  return {
    overview: draft.overview?.trim() || undefined,
    business_purpose: draft.business_purpose?.trim() || undefined,
    usage_guidelines: draft.usage_guidelines?.trim() || undefined,
    ai_context: draft.ai_context?.trim() || undefined,
    default_filters: trimList(draft.default_filters ?? []),
    warnings: trimList(draft.warnings ?? []),
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
      .filter((item) =>
        item.business_role || item.grain || item.join_hint || item.owner_note ||
        item.freshness_expectation || item.row_count_expectation ||
        (item.important_columns ?? []).length > 0 || (item.column_notes ?? []).length > 0,
      ),
  };
}

export function mergeColumnDescriptions(
  existing: DatasetDictionaryColumnNote[],
  aiDescs: Record<string, string>,
): DatasetDictionaryColumnNote[] {
  const merged = existing.map((note) => ({
    ...note,
    description: aiDescs[note.column_name] ?? note.description,
  }));
  const existingNames = new Set(existing.map((n) => n.column_name));
  for (const [colName, desc] of Object.entries(aiDescs)) {
    if (!existingNames.has(colName)) {
      merged.push({ column_name: colName, description: desc, examples: [] });
    }
  }
  return merged;
}

// ─── Shared UI components ─────────────────────────────────────────────────────

export function Badge({
  tone,
  children,
}: {
  tone: 'gray' | 'blue' | 'green' | 'amber' | 'red';
  children: React.ReactNode;
}) {
  const cls = {
    gray:  'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary',
    blue:  'border-brand/30 bg-brand/10 text-brand',
    green: 'border-success/30 bg-success/10 text-success',
    amber: 'border-warning/30 bg-warning/10 text-warning',
    red:   'border-danger/30 bg-danger/10 text-danger',
  };
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls[tone]}`}>
      {children}
    </span>
  );
}

export function DataTypeBadge({ type }: { type?: string }) {
  if (!type) return null;
  const key = type.toLowerCase().split('(')[0].trim();
  const meta = DATA_TYPE_DISPLAY[key];
  const label = meta?.label ?? type.toLowerCase();
  const color = meta?.color ?? 'text-text-secondary bg-surface-2 border-[rgb(var(--border-line))]';
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0 font-mono text-[10px] font-medium leading-5 ${color}`}>
      {label}
    </span>
  );
}

export function TokenEditor({
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
            className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-xs text-text-secondary"
          >
            {value}
            {!disabled && (
              <button type="button" onClick={() => onChange(values.filter((v) => v !== value))}>
                <X className="h-3 w-3 text-text-quaternary hover:text-danger" />
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
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder={placeholder}
            className="flex-1 rounded-md border border-[rgb(var(--border-strong))] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <button
            type="button"
            onClick={add}
            className="rounded-md border border-[rgb(var(--border-strong))] px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-2"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// ─── ColumnModal ──────────────────────────────────────────────────────────────

export function ColumnModal({
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
              className="mr-auto inline-flex items-center gap-1.5 rounded-md border border-danger/30 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove from catalog
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2"
          >
            Done
          </button>
        </>
      }
    >
      {/* Tab nav */}
      <div className="border-b border-[rgb(var(--border-line))] px-6 py-3">
        <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-1">
          {(['meaning', 'quality'] as ColumnModalTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                tab === t ? 'bg-surface-1 text-text-primary shadow-linear-sm' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {t}
              {t === 'quality' && hasQuality(note.quality) && (
                <span className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                  {qualityRuleCount(note.quality)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="space-y-5 p-6">
        {tab === 'meaning' ? (
          <>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">Business name</label>
              <input
                value={note.business_name ?? ''}
                onChange={(e) => onChange((cur) => ({ ...cur, business_name: e.target.value }))}
                disabled={!canEdit}
                placeholder="Optional friendly name for business users"
                className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2 disabled:text-text-tertiary"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">Description</label>
              <textarea
                rows={5}
                value={note.description ?? ''}
                onChange={(e) => onChange((cur) => ({ ...cur, description: e.target.value }))}
                disabled={!canEdit}
                placeholder="Explain what this column means, how it should be interpreted, and any caveats."
                className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2 disabled:text-text-tertiary"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">Examples</label>
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
              <label className="flex items-start gap-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 hover:border-[rgb(var(--border-strong))]">
                <input
                  type="checkbox"
                  checked={note.quality?.required === true}
                  onChange={(e) => onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), required: e.target.checked },
                  }))}
                  disabled={!canEdit}
                  className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
                />
                <div>
                  <div className="text-sm font-medium text-text-primary">Required</div>
                  <p className="mt-0.5 text-xs text-text-tertiary">Flag null or blank values as an issue.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 hover:border-[rgb(var(--border-strong))]">
                <input
                  type="checkbox"
                  checked={note.quality?.unique === true}
                  onChange={(e) => onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), unique: e.target.checked },
                  }))}
                  disabled={!canEdit}
                  className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
                />
                <div>
                  <div className="text-sm font-medium text-text-primary">Unique</div>
                  <p className="mt-0.5 text-xs text-text-tertiary">Expected to have no duplicates.</p>
                </div>
              </label>
            </div>

            {/* Range constraints */}
            <div className="grid gap-4 md:grid-cols-2">
              {[
                { key: 'min_value', label: 'Minimum value', placeholder: 'e.g. 0' },
                { key: 'max_value', label: 'Maximum value', placeholder: 'e.g. 100' },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{label}</label>
                  <input
                    value={(note.quality as any)?.[key] ?? ''}
                    onChange={(e) => onChange((cur) => ({
                      ...cur,
                      quality: { ...emptyQuality(), ...(cur.quality ?? {}), [key]: e.target.value },
                    }))}
                    disabled={!canEdit}
                    placeholder={placeholder}
                    className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                  />
                </div>
              ))}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">Null threshold %</label>
                <input
                  type="number" min={0} max={100} step={0.1}
                  value={note.quality?.null_threshold_percent ?? ''}
                  onChange={(e) => onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), null_threshold_percent: e.target.value === '' ? undefined : Number(e.target.value) },
                  }))}
                  disabled={!canEdit}
                  placeholder="e.g. 5"
                  className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">Distinct threshold</label>
                <input
                  type="number" min={0} step={1}
                  value={note.quality?.distinct_threshold ?? ''}
                  onChange={(e) => onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), distinct_threshold: e.target.value === '' ? undefined : Number(e.target.value) },
                  }))}
                  disabled={!canEdit}
                  placeholder="e.g. 50"
                  className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                />
              </div>
            </div>

            {/* Format + Severity */}
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">Format hint</label>
                <select
                  value={note.quality?.format_hint ?? ''}
                  onChange={(e) => onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), format_hint: (e.target.value || undefined) as DatasetDictionaryQualityFormatHint | undefined },
                  }))}
                  disabled={!canEdit}
                  className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                >
                  <option value="">None</option>
                  {FORMAT_HINTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">Severity</label>
                <select
                  value={note.quality?.severity ?? ''}
                  onChange={(e) => onChange((cur) => ({
                    ...cur,
                    quality: { ...emptyQuality(), ...(cur.quality ?? {}), severity: (e.target.value || undefined) as DatasetDictionaryQualitySeverity | undefined },
                  }))}
                  disabled={!canEdit}
                  className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                >
                  <option value="">None</option>
                  {QUALITY_SEVERITIES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>

            {/* Accepted values */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">Accepted values</label>
              <TokenEditor
                values={note.quality?.accepted_values ?? []}
                onChange={(values) => onChange((cur) => ({
                  ...cur,
                  quality: { ...emptyQuality(), ...(cur.quality ?? {}), accepted_values: values },
                }))}
                placeholder="Add an accepted value..."
                disabled={!canEdit}
              />
            </div>

            {/* Pattern */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">Pattern / regex</label>
              <input
                value={note.quality?.pattern ?? ''}
                onChange={(e) => onChange((cur) => ({
                  ...cur,
                  quality: { ...emptyQuality(), ...(cur.quality ?? {}), pattern: e.target.value },
                }))}
                disabled={!canEdit}
                placeholder="Optional regex or format pattern"
                className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
              />
            </div>

            {/* Quality notes */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">Quality notes</label>
              <textarea
                rows={3}
                value={note.quality?.notes ?? ''}
                onChange={(e) => onChange((cur) => ({
                  ...cur,
                  quality: { ...emptyQuality(), ...(cur.quality ?? {}), notes: e.target.value },
                }))}
                disabled={!canEdit}
                placeholder="Describe how this column should be monitored or what issue patterns matter."
                className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
              />
            </div>
          </>
        )}
      </div>
    </AppModalShell>
  );
}

// ─── TableNotesBar (pill-row summary + expandable form) ───────────────────────

export interface TableNotesBarProps {
  tableNote: DatasetDictionaryTableNote;
  canEdit: boolean;
  isSaving: boolean;
  isGeneratingAi?: boolean;
  onPatchNote: (updater: (note: DatasetDictionaryTableNote) => DatasetDictionaryTableNote) => void;
  onGenerateAi?: () => void;
  onRemove?: () => void;
}

export function TableNotesBar({
  tableNote,
  canEdit,
  isSaving,
  isGeneratingAi,
  onPatchNote,
  onGenerateAi,
  onRemove,
}: TableNotesBarProps) {
  const [expanded, setExpanded] = useState(false);

  const patchField = (field: keyof DatasetDictionaryTableNote, value: string) =>
    onPatchNote((note) => ({ ...note, [field]: value }));

  return (
    <div className="shrink-0 border-b border-[rgb(var(--border-line))] bg-surface-1">
      {/* Always-visible pill row */}
      <div className="flex flex-wrap items-center gap-2 px-5 py-2.5">
        {tableNote.business_role ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1 text-xs text-text-secondary">
            <span className="font-medium text-text-quaternary">Purpose</span>
            {tableNote.business_role}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[rgb(var(--border-line))] px-3 py-1 text-xs text-text-quaternary">
            No purpose set
          </span>
        )}
        {tableNote.grain && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1 text-xs text-text-secondary">
            <span className="font-medium text-text-quaternary">Grain</span>
            {tableNote.grain}
          </span>
        )}
        {tableNote.freshness_expectation && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs text-sky-700">
            <span className="font-medium text-sky-400">Freshness</span>
            {tableNote.freshness_expectation}
          </span>
        )}
        {tableNote.owner_note && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-3 py-1 text-xs text-warning">
            PIC
          </span>
        )}
        {tableNote.join_hint && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs text-brand">
            Source
          </span>
        )}
        <div className="flex-1" />
        {canEdit && onGenerateAi && (
          <button
            type="button"
            onClick={onGenerateAi}
            disabled={isGeneratingAi}
            className="inline-flex items-center gap-1.5 rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className={`h-3 w-3 ${isGeneratingAi ? 'animate-spin' : ''}`} />
            {isGeneratingAi ? 'Generating…' : 'AI'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
            expanded ? 'border-[rgb(var(--border-strong))] bg-surface-2 text-text-secondary' : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
          }`}
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          Edit notes
        </button>
        {canEdit && onRemove && (
          <button
            type="button"
            onClick={() => { onRemove(); setExpanded(false); }}
            className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1 text-xs font-medium text-danger hover:border-danger/30 hover:bg-danger/10"
            title="Remove this table from catalog"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Expandable form */}
      {expanded && (
        <div className="border-t border-[rgb(var(--border-line))] bg-surface-2/60 px-5 pb-4 pt-3">
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { field: 'business_role' as const, label: 'Table purpose', placeholder: 'e.g. Order-level fact table' },
              { field: 'grain' as const, label: 'Grain', placeholder: 'e.g. One row per order item' },
              { field: 'freshness_expectation' as const, label: 'Freshness expectation', placeholder: 'e.g. Daily by 8 AM' },
            ].map(({ field, label, placeholder }) => (
              <div key={field}>
                <label className="mb-1 block text-xs font-medium text-text-tertiary">{label}</label>
                <input
                  value={(tableNote as any)[field] ?? ''}
                  onChange={(e) => patchField(field, e.target.value)}
                  disabled={!canEdit || isSaving}
                  placeholder={placeholder}
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                />
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {[
              { field: 'owner_note' as const, label: 'PIC', placeholder: 'Who owns this table and who should be contacted?' },
              { field: 'join_hint' as const, label: 'Source', placeholder: 'Source system, upstream table, or lineage note.' },
            ].map(({ field, label, placeholder }) => (
              <div key={field}>
                <label className="mb-1 block text-xs font-medium text-text-tertiary">{label}</label>
                <textarea
                  rows={2}
                  value={(tableNote as any)[field] ?? ''}
                  onChange={(e) => patchField(field, e.target.value)}
                  disabled={!canEdit || isSaving}
                  placeholder={placeholder}
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-2"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ColumnGrid ───────────────────────────────────────────────────────────────

export interface ColumnGridProps {
  table: DatasetTable;
  tableNote: DatasetDictionaryTableNote;
  canEdit: boolean;
  isSaving: boolean;
  onPatchDictionary: (updater: (current: DatasetDictionary) => DatasetDictionary) => void;
  activeColumn: string | null;
  activeColumnDefaultTab: ColumnModalTab;
  setActiveColumn: (col: string | null) => void;
  setActiveColumnDefaultTab: (tab: ColumnModalTab) => void;
}

export function ColumnGrid({
  table,
  tableNote,
  canEdit,
  isSaving,
  onPatchDictionary,
  activeColumn,
  activeColumnDefaultTab,
  setActiveColumn,
  setActiveColumnDefaultTab,
}: ColumnGridProps) {
  const [columnSearch, setColumnSearch] = useState('');
  const [columnFilter, setColumnFilter] = useState<ColumnFilterMode>('all');

  const columnsMeta = React.useMemo(() => tableColumnsMeta(table), [table]);

  const visibleColumnsMeta = React.useMemo(
    () => columnsMeta.filter(({ name }) => {
      const note = tableNote.column_notes.find((item) => item.column_name === name);
      const documented = !!note;
      const quality = hasQuality(note?.quality);
      if (columnFilter === 'documented' && !documented) return false;
      if (columnFilter === 'quality' && !quality) return false;
      const q = columnSearch.trim().toLowerCase();
      if (!q) return true;
      return [name, note?.business_name ?? '', note?.description ?? '', ...(note?.examples ?? [])]
        .join(' ').toLowerCase().includes(q);
    }),
    [columnsMeta, tableNote.column_notes, columnFilter, columnSearch],
  );

  const openColumnModal = (column: string, defaultTab: ColumnModalTab = 'meaning') => {
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
    if (note || canEdit) {
      setActiveColumnDefaultTab(defaultTab);
      setActiveColumn(column);
    }
  };

  const activeNote = tableNote.column_notes.find((item) => item.column_name === activeColumn) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-5 py-3">
        <span className="text-sm font-semibold text-text-primary">
          Columns
          {columnsMeta.length > 0 && (
            <span className="ml-1.5 text-sm font-normal text-text-quaternary">({columnsMeta.length})</span>
          )}
        </span>
        <div className="relative min-w-0 flex-1 max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
          <input
            value={columnSearch}
            onChange={(e) => setColumnSearch(e.target.value)}
            placeholder="Search columns…"
            className="w-full rounded-md border border-[rgb(var(--border-line))] py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
          {(['all', 'documented', 'quality'] as ColumnFilterMode[]).map((value, i, arr) => (
            <button
              key={value}
              type="button"
              onClick={() => setColumnFilter(value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                i === 0 ? 'rounded-l-[5px]' : ''
              } ${i === arr.length - 1 ? 'rounded-r-[5px]' : ''} ${
                columnFilter === value ? 'bg-surface-inverse/80 text-white' : 'text-text-secondary hover:bg-surface-2'
              }`}
            >
              {value === 'quality' ? 'Has rules' : value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {columnsMeta.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-text-quaternary">
            Column metadata is not available for this table yet.
          </div>
        ) : visibleColumnsMeta.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-text-quaternary">
            No columns match this filter.
          </div>
        ) : (
          <table className="min-w-full">
            <thead className="sticky top-0 z-10 border-b border-[rgb(var(--border-line))] bg-surface-2">
              <tr>
                <th className="w-10 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-text-quaternary" />
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-text-tertiary">Column</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-text-tertiary">Description</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-text-tertiary">Quality rules</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
              {visibleColumnsMeta.map(({ name: column, type: colType }) => {
                const note = tableNote.column_notes.find((item) => item.column_name === column);
                const documented = !!note;
                const quality = hasQuality(note?.quality);
                const ruleCount = qualityRuleCount(note?.quality);
                const hasDesc = !!(note?.description?.trim());
                const hasBizName = !!(note?.business_name?.trim());

                return (
                  <tr key={column} className="group transition-colors hover:bg-brand/15/40">
                    {/* Checkbox */}
                    <td className="px-4 py-3">
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
                        className="h-4 w-4 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
                        title={documented ? 'Remove from catalog' : 'Add to catalog'}
                      />
                    </td>

                    {/* Column name + type + business name */}
                    <td className="px-4 py-3 min-w-[180px]">
                      <button type="button" onClick={() => openColumnModal(column, 'meaning')} className="text-left w-full">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium text-text-primary group-hover:text-brand truncate">{column}</span>
                          <DataTypeBadge type={colType} />
                        </div>
                        {hasBizName ? (
                          <div className="mt-0.5 text-xs text-text-tertiary truncate">{note!.business_name}</div>
                        ) : documented ? (
                          <div className="mt-0.5 text-xs text-text-quaternary italic">+ add business name</div>
                        ) : null}
                      </button>
                    </td>

                    {/* Description */}
                    <td className="px-4 py-3 max-w-[280px]">
                      {documented ? (
                        <button type="button" onClick={() => openColumnModal(column, 'meaning')} className="text-left w-full">
                          {hasDesc ? (
                            <p className="line-clamp-2 text-xs text-text-secondary leading-relaxed">{note!.description}</p>
                          ) : (
                            <span className="text-xs text-warning italic">No description yet</span>
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-text-quaternary">—</span>
                      )}
                    </td>

                    {/* Quality rules */}
                    <td className="px-4 py-3">
                      {quality ? (
                        <button type="button" onClick={() => openColumnModal(column, 'quality')} className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="blue">{ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}</Badge>
                          {note?.quality?.required === true && <Badge tone="red">Required</Badge>}
                          {note?.quality?.unique === true && <Badge tone="green">Unique</Badge>}
                          {note?.quality?.severity && (
                            <Badge tone={note.quality.severity === 'error' ? 'red' : note.quality.severity === 'warning' ? 'amber' : 'gray'}>
                              {note.quality.severity}
                            </Badge>
                          )}
                        </button>
                      ) : documented ? (
                        <button type="button" onClick={() => openColumnModal(column, 'quality')} className="text-xs text-text-quaternary hover:text-brand">
                          + Add rules
                        </button>
                      ) : (
                        <span className="text-xs text-text-quaternary">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Column modal */}
      <ColumnModal
        open={Boolean(activeColumn && activeNote)}
        tableName={tableLabel(table)}
        note={activeNote}
        canEdit={canEdit && !isSaving}
        defaultTab={activeColumnDefaultTab}
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
