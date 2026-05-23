'use client';

// Phase-15.81 — PowerBI-style Filter Pane.
//
// Two new sidebars dock the dashboard editor:
//
//   ┌──────────┐┌──────────────────────────────┐┌───────────────────┐
//   │ FIELDS   ││  Dashboard canvas            ││ FILTERS           │
//   │ (drag    ││                              ││ ▼ this visual     │
//   │  source) ││  [chart] [chart] [chart]     ││ ▼ this page       │
//   │          ││                              ││ ▼ all pages       │
//   └──────────┘└──────────────────────────────┘└───────────────────┘
//
// Drag a field from FieldList → drop onto one of the 3 sections in
// FilterPane. Sections own filter scope:
//   - this visual → currentLayout.tileFilters on the focused tile
//   - this page   → pages_config.filters on the active page
//   - all pages   → existing dashboard.filters_config (Phase-15.78 path)
//
// FilterCardPBI renders each filter card. It's a thin wrapper around the
// Phase-15.78 internals (Pencil rename, single/multi toggle, range slider)
// so we don't re-invent the slicer UX — we just relocate it from a top
// popover to a persistent right pane and add the 3-scope grouping.
//
// Drag payload format: a small JSON blob stuffed into dataTransfer with
// MIME type `application/x-appbi-field` so we don't accidentally interpret
// generic drops from outside the dashboard.

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Filter as FilterIcon, ChevronDown, ChevronRight, Search, X, Pencil, Check, Hash, Calendar, Type, ToggleLeft, ToggleRight, AlertTriangle } from 'lucide-react';
import type {
  BaseFilter,
  ColumnInfo,
  FilterType,
  FilterOperator,
  DatePreset,
} from '@/lib/filters';
import {
  DATE_PRESET_LABELS,
  computeDatePresetRange,
  getColumnKey,
  getColumnDisplayLabel,
  isFilterValueActive,
  getFilterDisplayLabel,
} from '@/lib/filters';

export const APPBI_FIELD_MIME = 'application/x-appbi-field';

interface DragFieldPayload {
  columnKey: string;
  source: 'field-list' | 'chart-tile';
}

/** Helpers — serialise the column drag payload into dataTransfer. */
export function setDragField(e: React.DragEvent, payload: DragFieldPayload) {
  try {
    e.dataTransfer.setData(APPBI_FIELD_MIME, JSON.stringify(payload));
    // text/plain fallback so the browser shows a sensible drop preview
    e.dataTransfer.setData('text/plain', payload.columnKey);
    e.dataTransfer.effectAllowed = 'copy';
  } catch { /* dataTransfer may throw on some browsers */ }
}

export function readDragField(e: React.DragEvent): DragFieldPayload | null {
  try {
    const raw = e.dataTransfer.getData(APPBI_FIELD_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.columnKey === 'string' ? parsed as DragFieldPayload : null;
  } catch {
    return null;
  }
}

// ─── Field icon glyph by column type ────────────────────────────────────
function FieldIcon({ type }: { type: FilterType }) {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  if (type === 'date') return <Calendar className={`${cls} text-teal-500`} />;
  if (type === 'number') return <Hash className={`${cls} text-brand`} />;
  return <Type className={`${cls} text-sky-500`} />;
}

// ─── FIELD LIST sidebar (drag source) ───────────────────────────────────
//
// Columns are grouped by datasetId/view label so users with multi-dataset
// dashboards can find the right table fast. Search filters by column
// label or raw field name.
//
interface FieldListProps {
  columns: ColumnInfo[];
}
export function FieldList({ columns }: FieldListProps) {
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? columns.filter((c) => {
          const label = getColumnDisplayLabel(c).toLowerCase();
          return label.includes(q) || c.name.toLowerCase().includes(q);
        })
      : columns;
    const byGroup = new Map<string, ColumnInfo[]>();
    for (const col of matched) {
      const groupKey = col.datasetId != null
        ? `Dataset ${col.datasetId}`
        : (col.semanticField?.split('.')[0] ?? 'Columns');
      const arr = byGroup.get(groupKey) ?? [];
      arr.push(col);
      byGroup.set(groupKey, arr);
    }
    return Array.from(byGroup.entries()).map(([name, cols]) => ({ name, cols }));
  }, [columns, search]);

  return (
    <div className="flex h-full flex-col border-r border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Fields</span>
      </div>
      <div className="border-b border-[rgb(var(--border-line))] px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search fields..."
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 py-1 pl-7 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-text-quaternary">
            {search ? 'No fields match' : 'No fields available'}
          </p>
        )}
        {groups.map((group) => {
          const isCollapsed = collapsedGroups[group.name];
          return (
            <div key={group.name} className="mb-1">
              <button
                type="button"
                onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.name]: !isCollapsed }))}
                className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary hover:bg-surface-2"
              >
                {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                <span>{group.name}</span>
                <span className="ml-auto font-normal text-text-quaternary">{group.cols.length}</span>
              </button>
              {!isCollapsed && (
                <div className="space-y-0.5 px-1 pb-1">
                  {group.cols.map((col) => {
                    const key = getColumnKey(col);
                    return (
                      <div
                        key={key}
                        draggable
                        onDragStart={(e) => setDragField(e, { columnKey: key, source: 'field-list' })}
                        className="group flex cursor-grab items-center gap-2 rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-brand/10 hover:text-brand active:cursor-grabbing"
                        title={`Drag to add a filter on ${getColumnDisplayLabel(col)}`}
                      >
                        <FieldIcon type={col.type} />
                        <span className="truncate">{getColumnDisplayLabel(col)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── FILTER CARD (PBI-style) ────────────────────────────────────────────
//
// Renders a single BaseFilter. Each card has:
//   - Header: type pill, editable label (Pencil), mode toggle (text/dropdown
//     only — date/number have their own operator), Clear, Remove.
//   - Body: search + checklist (multi), radio list (single), preset+range
//     (date), or input pair + slider (number between).
//
interface FilterCardPBIProps {
  filter: BaseFilter;
  distinctValues?: string[];
  onChange: (next: BaseFilter) => void;
  onRemove: () => void;
}
export function FilterCardPBI({ filter, distinctValues = [], onChange, onRemove }: FilterCardPBIProps) {
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(filter.label ?? '');
  const [search, setSearch] = useState('');

  const isMultiSelect = filter.operator === 'in' || filter.operator === 'not_in';
  const supportsModeToggle = filter.type === 'dropdown' || filter.type === 'text';

  const updateValue = (value: any) => onChange({ ...filter, value });
  const updateOperator = (operator: FilterOperator) => {
    if (operator === 'between') return onChange({ ...filter, operator, value: ['', ''] });
    if (operator === 'in' || operator === 'not_in') return onChange({ ...filter, operator, value: [] });
    return onChange({ ...filter, operator, value: '' });
  };
  const updateLabel = (label: string) => {
    onChange({ ...filter, label: label.trim() || undefined });
  };
  const switchMode = (mode: 'multi' | 'single') => {
    if (mode === 'multi') {
      const cur = typeof filter.value === 'string' && filter.value !== '' ? [filter.value] : [];
      return onChange({ ...filter, operator: 'in', value: cur });
    }
    const first = Array.isArray(filter.value) && filter.value.length > 0 ? String(filter.value[0]) : '';
    return onChange({ ...filter, operator: 'eq', value: first });
  };

  const merged = distinctValues;
  const filteredValues = useMemo(() => {
    if (!search) return merged;
    const q = search.toLowerCase();
    return merged.filter((v) => v.toLowerCase().includes(q));
  }, [merged, search]);

  return (
    <div className="bi-fade-in rounded-md border border-[rgb(var(--border-line))] bg-surface-1 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5">
        <FieldIcon type={filter.type} />
        {isEditingLabel ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={() => { updateLabel(labelDraft); setIsEditingLabel(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { updateLabel(labelDraft); setIsEditingLabel(false); }
              if (e.key === 'Escape') { setLabelDraft(filter.label ?? ''); setIsEditingLabel(false); }
            }}
            className="min-w-0 flex-1 rounded border border-brand/40 bg-surface-1 px-1.5 py-0.5 text-xs font-semibold outline-none focus:ring-1 focus:ring-brand"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setLabelDraft(filter.label ?? ''); setIsEditingLabel(true); }}
            className="group/label flex min-w-0 flex-1 items-center gap-1 text-left"
            title="Click to rename"
          >
            <span className="truncate text-xs font-semibold text-text-primary">
              {getFilterDisplayLabel(filter)}
            </span>
            <Pencil className="h-3 w-3 flex-shrink-0 text-text-quaternary opacity-0 transition-opacity group-hover/label:opacity-100" />
          </button>
        )}
        {isFilterValueActive(filter) && (
          <button
            type="button"
            onClick={() => {
              if (filter.operator === 'in' || filter.operator === 'not_in') return updateValue([]);
              if (filter.operator === 'between') return updateValue(['', '']);
              return updateValue('');
            }}
            title="Clear value"
            className="rounded p-0.5 text-text-quaternary hover:bg-surface-1 hover:text-text-secondary"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          title="Remove filter"
          className="rounded p-0.5 text-text-quaternary hover:bg-danger/10 hover:text-danger"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="px-2 py-2 space-y-1.5">
        {/* Mode toggle (categorical only) */}
        {supportsModeToggle && (
          <div className="flex items-center gap-1 text-[10px] text-text-tertiary">
            <span>Mode:</span>
            <button
              type="button"
              onClick={() => switchMode(isMultiSelect ? 'single' : 'multi')}
              className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 py-0.5 transition-colors hover:bg-surface-1"
              title={isMultiSelect ? 'Click for single-select' : 'Click for multi-select'}
            >
              {isMultiSelect
                ? <><ToggleRight className="h-3 w-3 text-brand" /> Multi</>
                : <><ToggleLeft className="h-3 w-3 text-text-quaternary" /> Single</>}
            </button>
          </div>
        )}

        {/* Body by type */}
        {filter.type === 'date'
          ? <DateBody filter={filter} onUpdateValue={updateValue} onUpdateOperator={updateOperator} onUpdatePreset={(p) => {
              if (p === 'custom') return onChange({ ...filter, datePreset: 'custom' });
              onChange({ ...filter, datePreset: p, operator: 'between', value: computeDatePresetRange(p) });
            }} />
          : filter.type === 'number'
            ? <NumberBody filter={filter} onUpdateValue={updateValue} onUpdateOperator={updateOperator} />
            : (
              isMultiSelect
                ? <CategoricalChecklist values={merged} filtered={filteredValues} selected={Array.isArray(filter.value) ? filter.value : []} search={search} setSearch={setSearch} onToggle={(val) => {
                    const cur: string[] = Array.isArray(filter.value) ? filter.value : [];
                    updateValue(cur.includes(val) ? cur.filter((v) => v !== val) : [...cur, val]);
                  }} />
                : <CategoricalRadio values={merged} filtered={filteredValues} selected={typeof filter.value === 'string' ? filter.value : ''} search={search} setSearch={setSearch} onSelect={updateValue} />
            )
        }
      </div>
    </div>
  );
}

// ─── Date body ──────────────────────────────────────────────────────────
function DateBody({ filter, onUpdateValue, onUpdateOperator, onUpdatePreset }: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
  onUpdatePreset: (p: DatePreset) => void;
}) {
  const preset = filter.datePreset ?? 'custom';
  return (
    <div className="space-y-1.5">
      <select
        value={preset}
        onChange={(e) => onUpdatePreset(e.target.value as DatePreset)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
      >
        {(Object.entries(DATE_PRESET_LABELS) as [DatePreset, string][]).map(([k, l]) => (
          <option key={k} value={k}>{l}</option>
        ))}
      </select>
      {preset === 'custom' && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={Array.isArray(filter.value) ? filter.value[0] ?? '' : ''}
            onChange={(e) => onUpdateValue([e.target.value, Array.isArray(filter.value) ? filter.value[1] ?? '' : ''])}
            className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
          />
          <span className="text-text-quaternary">–</span>
          <input
            type="date"
            value={Array.isArray(filter.value) ? filter.value[1] ?? '' : ''}
            onChange={(e) => onUpdateValue([Array.isArray(filter.value) ? filter.value[0] ?? '' : '', e.target.value])}
            className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
      )}
    </div>
  );
}

// ─── Number body ────────────────────────────────────────────────────────
function NumberBody({ filter, onUpdateValue, onUpdateOperator }: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
}) {
  return (
    <div className="space-y-1.5">
      <select
        value={filter.operator}
        onChange={(e) => onUpdateOperator(e.target.value as FilterOperator)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
      >
        <option value="eq">= equals</option>
        <option value="neq">≠ not equals</option>
        <option value="gt">&gt; greater</option>
        <option value="gte">≥ at least</option>
        <option value="lt">&lt; less</option>
        <option value="lte">≤ at most</option>
        <option value="between">between</option>
      </select>
      {filter.operator === 'between' ? (
        <NumberRangeInputs filter={filter} onUpdate={onUpdateValue} />
      ) : (
        <input
          type="number"
          value={typeof filter.value === 'number' ? filter.value : filter.value ?? ''}
          onChange={(e) => onUpdateValue(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder="Value..."
          className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
      )}
    </div>
  );
}

function NumberRangeInputs({ filter, onUpdate }: { filter: BaseFilter; onUpdate: (v: any) => void }) {
  const [lo, hi] = Array.isArray(filter.value) ? [filter.value[0] ?? '', filter.value[1] ?? ''] : ['', ''];
  const loNum = lo !== '' && lo != null ? Number(lo) : NaN;
  const hiNum = hi !== '' && hi != null ? Number(hi) : NaN;
  const hasBoth = Number.isFinite(loNum) && Number.isFinite(hiNum);
  const span = hasBoth ? Math.max(Math.abs(hiNum - loNum), 1) : 100;
  const min = hasBoth ? Math.min(loNum, hiNum) - span : 0;
  const max = hasBoth ? Math.max(loNum, hiNum) + span : 100;
  const step = span > 100 ? Math.max(1, Math.round(span / 100)) : span > 10 ? 1 : 0.1;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={lo}
          onChange={(e) => onUpdate([e.target.value, hi])}
          placeholder="Min"
          className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
        <span className="text-text-quaternary text-xs">–</span>
        <input
          type="number"
          value={hi}
          onChange={(e) => onUpdate([lo, e.target.value])}
          placeholder="Max"
          className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(loNum) ? loNum : min}
        onChange={(e) => onUpdate([String(Number(e.target.value)), hi])}
        className="w-full accent-brand"
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(hiNum) ? hiNum : max}
        onChange={(e) => onUpdate([lo, String(Number(e.target.value))])}
        className="w-full accent-brand"
      />
    </div>
  );
}

// ─── Categorical: checklist (multi) and radio (single) ──────────────────
function CategoricalChecklist({ values, filtered, selected, search, setSearch, onToggle }: {
  values: string[];
  filtered: string[];
  selected: string[];
  search: string;
  setSearch: (s: string) => void;
  onToggle: (val: string) => void;
}) {
  return (
    <div className="space-y-1">
      {values.length > 6 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-quaternary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search values..."
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1 pl-6 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
          />
        </div>
      )}
      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {filtered.length === 0 ? (
          <p className="py-1 text-xs italic text-text-quaternary">
            {values.length === 0 ? 'Loading values...' : 'No match'}
          </p>
        ) : (
          filtered.map((val) => {
            const checked = selected.includes(val);
            return (
              <label
                key={val}
                className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-xs transition-colors ${
                  checked ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-surface-2'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(val)}
                  className="h-3.5 w-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-1 focus:ring-brand"
                />
                <span className="truncate flex-1">{val || '(empty)'}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

function CategoricalRadio({ values, filtered, selected, search, setSearch, onSelect }: {
  values: string[];
  filtered: string[];
  selected: string;
  search: string;
  setSearch: (s: string) => void;
  onSelect: (val: string) => void;
}) {
  return (
    <div className="space-y-1">
      {values.length > 6 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-quaternary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search values..."
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1 pl-6 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
          />
        </div>
      )}
      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {filtered.length === 0 ? (
          <p className="py-1 text-xs italic text-text-quaternary">
            {values.length === 0 ? 'Loading values...' : 'No match'}
          </p>
        ) : (
          filtered.map((val) => {
            const checked = selected === val;
            return (
              <label
                key={val}
                className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-xs transition-colors ${
                  checked ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-surface-2'
                }`}
              >
                <input
                  type="radio"
                  checked={checked}
                  onChange={() => onSelect(val)}
                  className="h-3.5 w-3.5 border-[rgb(var(--border-strong))] text-brand focus:ring-1 focus:ring-brand"
                />
                <span className="truncate flex-1">{val || '(empty)'}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── FILTER PANE sidebar (3 sections, drop targets) ─────────────────────
//
// Each section accepts drop events from FieldList (or chart-tile drags
// — Phase-15.81 only wires FieldList; chart-drag is a future hookup).
// Visual scope shows the focused tile's title; clicking a tile elsewhere
// in the canvas should focus it (parent owns focused-tile state).
//
type Scope = 'visual' | 'page' | 'all';

export interface FilterPaneProps {
  columns: ColumnInfo[];
  distinctValues: Record<string, string[]>;
  /** "Filters on this visual" — null when no tile is focused. */
  visualFilters: BaseFilter[];
  visualLabel: string | null;
  onChangeVisualFilters: (next: BaseFilter[]) => void;
  /** "Filters on this page" */
  pageFilters: BaseFilter[];
  pageLabel: string;
  onChangePageFilters: (next: BaseFilter[]) => void;
  /** "Filters on all pages" — the existing dashboard-wide slicer set. */
  allFilters: BaseFilter[];
  onChangeAllFilters: (next: BaseFilter[]) => void;
  /** Apply / reset for the all-pages set (matches existing
   *  draft/applied semantic). Visual + page filters auto-apply on edit
   *  because they live on the layout JSON and are auto-saved. */
  hasPendingChanges?: boolean;
  onApply?: () => void;
  onReset?: () => void;
  isApplying?: boolean;
}

export function FilterPane({
  columns,
  distinctValues,
  visualFilters,
  visualLabel,
  onChangeVisualFilters,
  pageFilters,
  pageLabel,
  onChangePageFilters,
  allFilters,
  onChangeAllFilters,
  hasPendingChanges = false,
  onApply,
  onReset,
  isApplying = false,
}: FilterPaneProps) {
  const [expanded, setExpanded] = useState<Record<Scope, boolean>>({ visual: true, page: true, all: true });

  const columnsByKey = useMemo(() => {
    const map = new Map<string, ColumnInfo>();
    columns.forEach((c) => map.set(getColumnKey(c), c));
    return map;
  }, [columns]);

  const sectionAddFilter = (scope: Scope, columnKey: string) => {
    const col = columnsByKey.get(columnKey);
    if (!col) return;
    const isMultiSelect = col.type === 'text' || col.type === 'dropdown';
    const datePreset = col.type === 'date' ? 'this_month' as DatePreset : undefined;
    const dateValue = datePreset ? computeDatePresetRange(datePreset) : ['', ''];
    const newFilter: BaseFilter = {
      id: `f-${scope}-${Date.now()}`,
      field: col.name,
      fieldKey: columnKey,
      semanticField: col.semanticField,
      datasetId: col.datasetId,
      linkedFields: col.defaultLinkedFields ? [...col.defaultLinkedFields] : undefined,
      type: col.type,
      operator: isMultiSelect ? 'in' : col.type === 'date' ? 'between' : 'gte',
      value: isMultiSelect ? [] : col.type === 'date' ? dateValue : '',
      label: getColumnDisplayLabel(col),
      datePreset,
    };
    const target = scope === 'visual' ? visualFilters : scope === 'page' ? pageFilters : allFilters;
    const setter = scope === 'visual' ? onChangeVisualFilters : scope === 'page' ? onChangePageFilters : onChangeAllFilters;
    // Don't add twice for the same column
    if (target.some((f) => (f.fieldKey ?? f.field) === columnKey)) return;
    setter([...target, newFilter]);
  };

  return (
    <div className="flex h-full flex-col border-l border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <FilterIcon className="h-3.5 w-3.5 text-text-tertiary" />
          <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Filters</span>
        </div>
        {hasPendingChanges && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
            <AlertTriangle className="h-2.5 w-2.5" /> Unapplied
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section
          scope="visual"
          title="Filters on this visual"
          subtitle={visualLabel ?? 'Click a chart to focus it'}
          expanded={expanded.visual}
          onToggle={() => setExpanded((p) => ({ ...p, visual: !p.visual }))}
          filters={visualFilters}
          onAddFilter={(key) => sectionAddFilter('visual', key)}
          onChange={onChangeVisualFilters}
          distinctValues={distinctValues}
          disabled={visualLabel == null}
        />
        <Section
          scope="page"
          title="Filters on this page"
          subtitle={pageLabel}
          expanded={expanded.page}
          onToggle={() => setExpanded((p) => ({ ...p, page: !p.page }))}
          filters={pageFilters}
          onAddFilter={(key) => sectionAddFilter('page', key)}
          onChange={onChangePageFilters}
          distinctValues={distinctValues}
        />
        <Section
          scope="all"
          title="Filters on all pages"
          subtitle="Apply to every chart in this dashboard"
          expanded={expanded.all}
          onToggle={() => setExpanded((p) => ({ ...p, all: !p.all }))}
          filters={allFilters}
          onAddFilter={(key) => sectionAddFilter('all', key)}
          onChange={onChangeAllFilters}
          distinctValues={distinctValues}
        />
      </div>

      {/* Apply bar — only relevant for the dashboard-wide (all-pages)
          draft/applied state machine. Visual/page filters auto-save. */}
      {onApply && (
        <div className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] px-3 py-2">
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              disabled={!hasPendingChanges}
              className="rounded border border-[rgb(var(--border-line))] px-2 py-1 text-xs text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={onApply}
            disabled={!hasPendingChanges || isApplying}
            className={`ml-auto inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:bg-brand/40 ${
              hasPendingChanges && !isApplying
                ? 'bg-brand hover:bg-brand-hover ring-2 ring-brand/30 ring-offset-1 shadow-md'
                : 'bg-brand hover:bg-brand-hover'
            }`}
          >
            <Check className="h-3 w-3" />
            {isApplying ? 'Applying...' : 'Apply (all pages)'}
          </button>
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  scope: Scope;
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  filters: BaseFilter[];
  onAddFilter: (columnKey: string) => void;
  onChange: (next: BaseFilter[]) => void;
  distinctValues: Record<string, string[]>;
  disabled?: boolean;
}
function Section({ scope, title, subtitle, expanded, onToggle, filters, onAddFilter, onChange, distinctValues, disabled }: SectionProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  return (
    <div className="border-b border-[rgb(var(--border-line))] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-3 py-2 text-left hover:bg-surface-2"
      >
        {expanded ? <ChevronDown className="h-3 w-3 text-text-quaternary" /> : <ChevronRight className="h-3 w-3 text-text-quaternary" />}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text-primary">{title}</p>
          <p className="truncate text-[10px] text-text-quaternary">{subtitle}</p>
        </div>
        {filters.length > 0 && (
          <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
            {filters.length}
          </span>
        )}
      </button>
      {expanded && (
        <div
          onDragEnter={(e) => {
            if (disabled) return;
            e.preventDefault();
            dragCounterRef.current += 1;
            setIsDragOver(true);
          }}
          onDragLeave={() => {
            dragCounterRef.current -= 1;
            if (dragCounterRef.current <= 0) {
              dragCounterRef.current = 0;
              setIsDragOver(false);
            }
          }}
          onDragOver={(e) => {
            if (disabled) return;
            const types = Array.from(e.dataTransfer.types || []);
            if (types.includes(APPBI_FIELD_MIME)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            dragCounterRef.current = 0;
            setIsDragOver(false);
            if (disabled) return;
            const payload = readDragField(e);
            if (!payload) return;
            e.preventDefault();
            onAddFilter(payload.columnKey);
          }}
          className={`min-h-[60px] space-y-2 px-2 py-2 transition-colors ${
            isDragOver ? 'bg-brand/10 ring-1 ring-inset ring-brand/40' : ''
          } ${disabled ? 'opacity-40' : ''}`}
        >
          {filters.length === 0 && (
            <div className="rounded border border-dashed border-[rgb(var(--border-line))] p-3 text-center">
              <p className="text-[11px] text-text-quaternary">
                {disabled ? 'Click a chart first to add per-visual filters' : 'Drag a field here to add a filter'}
              </p>
            </div>
          )}
          {filters.map((f) => (
            <FilterCardPBI
              key={f.id}
              filter={f}
              distinctValues={distinctValues[f.fieldKey ?? f.field] ?? []}
              onChange={(next) => onChange(filters.map((x) => x.id === next.id ? next : x))}
              onRemove={() => onChange(filters.filter((x) => x.id !== f.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
