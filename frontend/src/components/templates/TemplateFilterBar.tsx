'use client';

import React from 'react';
import { Filter } from 'lucide-react';
import type { TemplateFilter } from '@/types/template';

export interface FilterValues {
  [filterId: string]: any;
}

interface TemplateFilterBarProps {
  filters: TemplateFilter[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
}

export function TemplateFilterBar({
  filters,
  values,
  onChange,
}: TemplateFilterBarProps) {
  if (filters.length === 0) return null;

  const handleChange = (id: string, value: string) => {
    onChange({ ...values, [id]: value || undefined });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-gray-50 px-6 py-3 print:hidden">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
        <Filter className="h-3.5 w-3.5" />
        Filters
      </div>
      {filters.map((f) => (
        <label key={f.id} className="flex items-center gap-1.5">
          <span className="text-xs text-gray-600">{f.label}</span>
          {f.operator === 'between' ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                placeholder="From"
                value={Array.isArray(values[f.id]) ? values[f.id][0] ?? '' : ''}
                onChange={(e) => {
                  const cur = Array.isArray(values[f.id]) ? values[f.id] : ['', ''];
                  handleChange(f.id, '' as any);
                  onChange({ ...values, [f.id]: [e.target.value, cur[1]] });
                }}
                className="w-24 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-400">–</span>
              <input
                type="text"
                placeholder="To"
                value={Array.isArray(values[f.id]) ? values[f.id][1] ?? '' : ''}
                onChange={(e) => {
                  const cur = Array.isArray(values[f.id]) ? values[f.id] : ['', ''];
                  onChange({ ...values, [f.id]: [cur[0], e.target.value] });
                }}
                className="w-24 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          ) : (
            <input
              type="text"
              placeholder={`${f.label}…`}
              value={values[f.id] ?? f.defaultValue ?? ''}
              onChange={(e) => handleChange(f.id, e.target.value)}
              className="w-32 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )}
        </label>
      ))}
    </div>
  );
}
