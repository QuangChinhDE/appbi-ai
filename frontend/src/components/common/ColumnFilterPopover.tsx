'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X as XIcon, Search as SearchIcon } from 'lucide-react';
import {
  type TableColumnFilter,
  type TableFilterColumnType,
  type TableFilterOperator,
  isTableColumnFilterActive,
  operatorsForType,
  operatorValueCount,
} from '@/lib/tableColumnFilter';

/**
 * Excel / Power BI-style per-column filter popover: a typed CONDITION editor
 * (operator + up to two inputs) AND a multi-select CHECKLIST of the column's
 * distinct values. Rendered via a portal at the header control's position so an
 * `overflow-auto` table can't clip it. Applies LIVE — every change flows
 * straight to the parent's filter state. Shared by the Explore chart Table
 * (TableVisualization) and the Dataset table grid (DatasetTableGrid).
 */
export function ColumnFilterPopover({
  label,
  type,
  filter,
  distinctValues,
  anchorRect,
  onChange,
  onClear,
  onClose,
}: {
  label: string;
  type: TableFilterColumnType;
  filter: TableColumnFilter;
  distinctValues: string[];
  anchorRect: DOMRect;
  onChange: (next: TableColumnFilter) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  const operators = operatorsForType(type);
  const valueCount = operatorValueCount(filter.op);
  const inputType = type === 'number' ? 'number' : type === 'date' ? 'date' : 'text';

  // Close on outside-click or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const WIDTH = 288;
  // Clamp within the viewport; prefer left-aligned to the icon, flip up if the
  // popover would overflow the bottom edge.
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - WIDTH - 8));
  const openUp = anchorRect.bottom + 360 > window.innerHeight && anchorRect.top > 360;
  const top = openUp ? undefined : anchorRect.bottom + 6;
  const bottom = openUp ? window.innerHeight - anchorRect.top + 6 : undefined;

  const filtered = search.trim()
    ? distinctValues.filter((v) => v.toLowerCase().includes(search.trim().toLowerCase()))
    : distinctValues;
  const selectedSet = new Set(filter.selected);
  const toggleValue = (v: string) => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange({ ...filter, selected: Array.from(next) });
  };
  const allVisibleSelected = filtered.length > 0 && filtered.every((v) => selectedSet.has(v));
  const toggleAllVisible = () => {
    const next = new Set(selectedSet);
    if (allVisibleSelected) filtered.forEach((v) => next.delete(v));
    else filtered.forEach((v) => next.add(v));
    onChange({ ...filter, selected: Array.from(next) });
  };
  const displayValue = (v: string) => (v === '' ? '(empty)' : v);
  const active = isTableColumnFilterActive(filter);

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Filter ${label}`}
      className="fixed z-[1000] flex max-h-[70vh] flex-col rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-xl"
      style={{ left, top, bottom, width: WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary" title={label}>{label}</div>
          <div className="text-[11px] uppercase tracking-wide text-text-quaternary">{type} filter</div>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="rounded p-1 text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
          onClick={onClose}
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Condition */}
      <div className="space-y-2 border-b border-[rgb(var(--border-line))] px-3 py-2.5">
        <div className="text-[11px] font-medium text-text-tertiary">Condition</div>
        <select
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
          value={filter.op ?? ''}
          onChange={(e) =>
            onChange({ ...filter, op: (e.target.value || null) as TableFilterOperator | null })
          }
        >
          <option value="">No condition</option>
          {operators.map((op) => (
            <option key={op.value} value={op.value}>{op.label}</option>
          ))}
        </select>
        {valueCount >= 1 && (
          <div className="flex items-center gap-1.5">
            <input
              type={inputType}
              className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
              placeholder={valueCount === 2 ? 'From' : 'Value'}
              value={filter.value1}
              onChange={(e) => onChange({ ...filter, value1: e.target.value })}
            />
            {valueCount === 2 && (
              <>
                <span className="text-xs text-text-quaternary">–</span>
                <input
                  type={inputType}
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
                  placeholder="To"
                  value={filter.value2}
                  onChange={(e) => onChange({ ...filter, value2: e.target.value })}
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Multi-select checklist */}
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-tertiary">
            Values{filter.selected.length > 0 ? ` (${filter.selected.length})` : ''}
          </span>
          <button
            type="button"
            className="text-[11px] font-medium text-brand hover:underline"
            onClick={toggleAllVisible}
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div className="relative mb-1.5">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
          <input
            type="text"
            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 py-1.5 pl-7 pr-2 text-sm text-text-primary focus:border-brand focus:outline-none"
            placeholder="Search values…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[rgb(var(--border-line))]">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-text-quaternary">No matching values</div>
          ) : (
            filtered.map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 shrink-0 accent-[rgb(var(--brand))]"
                  checked={selectedSet.has(v)}
                  onChange={() => toggleValue(v)}
                />
                <span className={clsx('truncate', v === '' && 'italic text-text-quaternary')} title={displayValue(v)}>
                  {displayValue(v)}
                </span>
              </label>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[rgb(var(--border-line))] px-3 py-2">
        <button
          type="button"
          disabled={!active}
          className={clsx(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            active ? 'text-text-secondary hover:bg-surface-3 hover:text-text-primary' : 'cursor-not-allowed text-text-quaternary',
          )}
          onClick={onClear}
        >
          Clear filter
        </button>
        <button
          type="button"
          className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-hover"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
