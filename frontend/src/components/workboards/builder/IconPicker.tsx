/**
 * IconPicker — pick a screen icon from the curated registry.
 *
 * Replaces the free-text input where users had to type Lucide names
 * like ``ClipboardEdit``. Renders as a button showing the current
 * icon; clicking opens a popover with grouped icons + a search filter.
 *
 * The whitelist comes from ScreenIconRegistry so the builder picker
 * and the runtime ``pickIcon`` resolver always agree.
 */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

import {
  GROUP_LABELS,
  SCREEN_ICONS,
  resolveScreenIcon,
  type ScreenIconEntry,
} from './ScreenIconRegistry';

interface Props {
  value?: string | null;
  onChange: (next: string) => void;
  /** Optional placeholder shown when no value is set. */
  placeholder?: string;
}

export default function IconPicker({
  value,
  onChange,
  placeholder = 'Pick an icon',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const ResolvedIcon = useMemo(() => resolveScreenIcon(value), [value]);
  const currentLabel = useMemo(
    () => SCREEN_ICONS.find((entry) => entry.id === value)?.label,
    [value],
  );

  // Group + filter the icon list for the popover.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? SCREEN_ICONS.filter(
          (entry) =>
            entry.id.toLowerCase().includes(q) ||
            entry.label.toLowerCase().includes(q),
        )
      : SCREEN_ICONS;
    const out: Record<ScreenIconEntry['group'], ScreenIconEntry[]> = {
      common: [],
      business: [],
      communication: [],
      misc: [],
    };
    for (const entry of filtered) out[entry.group].push(entry);
    return out;
  }, [query]);

  // Close on outside click + Esc. Refocus the search input when popover opens.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-caption text-text-primary transition-colors hover:border-[rgb(var(--border-strong))] focus:border-brand focus:outline-none"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-secondary">
          {ResolvedIcon ? (
            <ResolvedIcon className="h-3.5 w-3.5" />
          ) : (
            <span className="text-text-quaternary">?</span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-left">
          {currentLabel ? (
            <>
              <span className="text-text-primary">{currentLabel}</span>
              <span className="ml-1 text-text-tertiary">· {value}</span>
            </>
          ) : (
            <span className="text-text-quaternary">{placeholder}</span>
          )}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pick an icon"
          className="absolute left-0 top-full z-30 mt-1 w-[360px] overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-popover animate-slide-up"
        >
          {/* Search header */}
          <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search icons…"
              className="min-w-0 flex-1 bg-transparent text-caption text-text-primary placeholder:text-text-quaternary focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
                title="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Icon grid, grouped */}
          <div className="max-h-[320px] overflow-y-auto p-2">
            {(Object.keys(grouped) as ScreenIconEntry['group'][]).map((group) => {
              const items = grouped[group];
              if (items.length === 0) return null;
              return (
                <section key={group} className="mb-2 last:mb-0">
                  <h4 className="mb-1 px-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                    {GROUP_LABELS[group]}
                  </h4>
                  <div className="grid grid-cols-6 gap-1">
                    {items.map((entry) => {
                      const Icon = entry.component;
                      const isCurrent = entry.id === value;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => pick(entry.id)}
                          title={`${entry.label} · ${entry.id}`}
                          className={`flex h-10 items-center justify-center rounded-md border transition-colors ${
                            isCurrent
                              ? 'border-brand bg-brand/10 text-brand'
                              : 'border-transparent bg-surface-2 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:text-text-primary'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {/* Empty-state when search filters everything out */}
            {(Object.values(grouped) as ScreenIconEntry[][]).every(
              (arr) => arr.length === 0,
            ) && (
              <p className="px-2 py-6 text-center text-caption text-text-tertiary">
                No icons match &ldquo;{query}&rdquo;.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
