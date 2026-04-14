'use client';

import React from 'react';
import { Filter } from 'lucide-react';
import type { TemplateFilter } from '@/types/template';
import { useDatasetTables } from '@/hooks/use-datasets';

export interface FilterValues {
  [filterId: string]: any;
}

interface TemplateFilterBarProps {
  filters: TemplateFilter[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
}

// ── Column type inference ────────────────────────────────────────────

type ColType = 'date' | 'datetime' | 'number' | 'text';

function inferColType(filter: TemplateFilter, tables: any[] | undefined): ColType {
  const table = tables?.find((t: any) => t.id === filter.tableId);
  const cache = table?.columns_cache;
  if (!cache) return 'text';

  const colDef = Array.isArray(cache)
    ? cache.find((c: any) => (c.name ?? c) === filter.column)
    : cache[filter.column];

  const raw = (typeof colDef === 'object' ? colDef?.type : colDef) ?? '';
  const type = String(raw).toLowerCase();

  if (type.includes('datetime') || type.includes('timestamp')) return 'datetime';
  if (type.includes('date')) return 'date';
  if (['integer', 'float', 'numeric', 'number', 'bigint', 'decimal', 'double'].some((t) => type.includes(t))) return 'number';
  return 'text';
}

// ── Input rendering ──────────────────────────────────────────────────

const INPUT_CLASS =
  'rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

interface FilterInputProps {
  filter: TemplateFilter;
  value: any;
  tables: any[] | undefined;
  onChange: (v: any) => void;
}

function FilterInput({ filter, value, tables, onChange }: FilterInputProps) {
  const colType = inferColType(filter, tables);
  const op = filter.operator;
  const isBetween = op === 'between';

  if (isBetween) {
    const from = Array.isArray(value) ? (value[0] ?? '') : '';
    const to = Array.isArray(value) ? (value[1] ?? '') : '';
    const inputType =
      colType === 'datetime' ? 'datetime-local'
      : colType === 'date' ? 'date'
      : colType === 'number' ? 'number'
      : 'text';

    return (
      <div className="flex items-center gap-1.5">
        <input
          type={inputType}
          value={from}
          onChange={(e) => onChange([e.target.value, to])}
          placeholder="Từ"
          className={`${INPUT_CLASS} w-32`}
        />
        <span className="text-xs text-gray-400">—</span>
        <input
          type={inputType}
          value={to}
          onChange={(e) => onChange([from, e.target.value])}
          placeholder="Đến"
          className={`${INPUT_CLASS} w-32`}
        />
      </div>
    );
  }

  if (colType === 'date') {
    return (
      <input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={`${INPUT_CLASS} w-36`}
      />
    );
  }

  if (colType === 'datetime') {
    return (
      <input
        type="datetime-local"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={`${INPUT_CLASS} w-44`}
      />
    );
  }

  if (colType === 'number') {
    return (
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={filter.label}
        className={`${INPUT_CLASS} w-28`}
      />
    );
  }

  // Default text (also covers 'in'/'not_in' with comma hint)
  const isMultiValue = op === 'in' || op === 'not_in';
  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      placeholder={isMultiValue ? 'value1, value2, …' : (filter.defaultValue ?? `${filter.label}…`)}
      className={`${INPUT_CLASS} w-40`}
    />
  );
}

// ── Main component ───────────────────────────────────────────────────

export function TemplateFilterBar({ filters, values, onChange }: TemplateFilterBarProps) {
  // Load tables for the first unique dataset (covers the common single-dataset case)
  const firstDatasetId = filters[0]?.datasetId ?? null;
  const { data: tables } = useDatasetTables(firstDatasetId);

  if (!filters.length) return null;

  const handleChange = (filterId: string, val: any) => {
    onChange({ ...values, [filterId]: val });
  };

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-2 print:hidden">
      <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
        <Filter className="h-3.5 w-3.5" />
        Filters
      </span>
      {filters.map((f) => (
        <div key={f.id} className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-gray-600 shrink-0">{f.label}</span>
          <FilterInput
            filter={f}
            value={values[f.id]}
            tables={tables}
            onChange={(v) => handleChange(f.id, v)}
          />
        </div>
      ))}
    </div>
  );
}
