/**
 * ScreenSwitcherModal — quick screen switcher triggered from the
 * breadcrumb in Editor mode.
 *
 * Used to be "click ← All screens, then click the next card". The
 * round-trip via Canvas grew tedious for users hopping between 3-4
 * screens, so we lift the screens list into a Cmd-K style modal:
 * search filter, arrow-key navigation, current screen highlighted, an
 * escape hatch back to the Canvas at the bottom.
 *
 * Keyboard contract:
 *   Esc        → close
 *   ↑ / ↓      → move highlight
 *   Enter      → open highlighted screen
 *   PgUp/Home  → jump to first
 *   PgDn/End   → jump to last
 *
 * The search input is auto-focused. Typing filters the list by title
 * (case-insensitive substring) or screen kind name.
 */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardEdit,
  FileText,
  LayoutDashboard,
  LayoutGrid,
  Search,
  Table as TableIcon,
  X,
} from 'lucide-react';

import type { ScreenKind, ScreenSpec } from './types';

const KIND_ICON: Record<ScreenKind, React.ElementType> = {
  form: ClipboardEdit,
  table: TableIcon,
  doc: FileText,
  dashboard: LayoutDashboard,
};

const KIND_LABEL: Record<ScreenKind, string> = {
  form: 'Form',
  table: 'Table',
  doc: 'Document',
  dashboard: 'Dashboard',
};

type ScreenStatusKind = 'ok' | 'warn' | 'err';

function statusFor(s: ScreenSpec): ScreenStatusKind {
  if (s.kind === 'form' || s.kind === 'table' || s.kind === 'doc') {
    if (!s.table_id) return 'err';
  }
  if (s.kind === 'form' && (s.form?.fields?.length ?? 0) === 0) return 'warn';
  if (s.kind === 'table' && (s.table?.columns?.length ?? 0) === 0) return 'warn';
  if (s.kind === 'doc' && (s.doc?.blocks?.length ?? 0) === 0) return 'warn';
  if (s.kind === 'dashboard') {
    const hasManaged =
      typeof s.dashboard?.dashboard_id === 'number' && (s.dashboard.dashboard_id ?? 0) > 0;
    const hasManual = !!(s.dashboard?.share_token || '').trim();
    if (!hasManaged && !hasManual) return 'err';
  }
  return 'ok';
}

const STATUS_DOT: Record<ScreenStatusKind, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  err: 'bg-danger',
};

interface Props {
  screens: ScreenSpec[];
  currentScreenId: string | null;
  onPick: (screenId: string) => void;
  onAllScreens: () => void;
  onClose: () => void;
}

export default function ScreenSwitcherModal({
  screens,
  currentScreenId,
  onPick,
  onAllScreens,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter by lower-cased title OR kind name. We keep matching dead
  // simple — substring, no fuzzy — because mini-apps rarely have more
  // than ~15 screens. A fuzzy lib would be over-engineering.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return screens;
    return screens.filter(
      (s) =>
        (s.title || '').toLowerCase().includes(q) ||
        KIND_LABEL[s.kind].toLowerCase().includes(q),
    );
  }, [screens, query]);

  // Reset the highlight when the filter changes — otherwise the
  // selection ring lands on a row that no longer exists, which feels
  // broken.
  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  // Focus the search input on mount so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll the highlighted row into view when arrow keys move past the
  // visible region. ``block: 'nearest'`` avoids jumpiness when the row
  // is already in frame.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-row-idx="${highlightIdx}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx]);

  const pick = (id: string) => {
    onPick(id);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (filtered.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIdx((prev) => (prev + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIdx((prev) => (prev - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'PageUp') {
      event.preventDefault();
      setHighlightIdx(0);
      return;
    }
    if (event.key === 'End' || event.key === 'PageDown') {
      event.preventDefault();
      setHighlightIdx(filtered.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = filtered[highlightIdx];
      if (target) pick(target.id);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switch screen"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-40 flex items-start justify-center bg-overlay/84 px-4 pt-[12vh] backdrop-blur-[3px] animate-fade-in"
      onMouseDown={(event) => {
        // Clicking the backdrop (but not inside the dialog) closes.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg animate-slide-up">
        {/* Search header */}
        <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search screens by name or kind…"
            className="min-w-0 flex-1 bg-transparent text-caption text-text-primary placeholder:text-text-quaternary focus:outline-none"
          />
          <kbd className="hidden h-5 select-none items-center rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 text-tiny font-emphasis text-text-tertiary sm:inline-flex">
            Esc
          </kbd>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary sm:hidden"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Results list */}
        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto p-2"
          role="listbox"
          aria-activedescendant={
            filtered[highlightIdx] ? `screen-switcher-${filtered[highlightIdx].id}` : undefined
          }
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-10 text-center text-caption text-text-tertiary">
              No screens match &ldquo;{query}&rdquo;.
            </div>
          ) : (
            filtered.map((s, idx) => {
              const Icon = KIND_ICON[s.kind];
              const isCurrent = s.id === currentScreenId;
              const isHighlight = idx === highlightIdx;
              const status = statusFor(s);
              return (
                <button
                  type="button"
                  key={s.id}
                  id={`screen-switcher-${s.id}`}
                  role="option"
                  aria-selected={isHighlight}
                  data-row-idx={idx}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => pick(s.id)}
                  className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
                    isHighlight
                      ? 'bg-brand/10 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2'
                  } ${isCurrent ? 'ring-1 ring-inset ring-brand/40' : ''}`}
                >
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                      isHighlight ? 'bg-brand/15 text-brand' : 'bg-surface-2 text-text-secondary'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-caption font-emphasis text-text-primary">
                        {s.title || 'Untitled screen'}
                      </span>
                      <span className="inline-flex items-center rounded-sm bg-surface-2 px-1.5 py-0.5 text-tiny font-emphasis uppercase tracking-wider text-text-tertiary">
                        {KIND_LABEL[s.kind]}
                      </span>
                      {isCurrent ? (
                        <span className="text-tiny font-emphasis uppercase tracking-wider text-brand">
                          Current
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                    title={status === 'ok' ? 'Configured' : status === 'warn' ? 'Needs attention' : 'No data source'}
                  />
                </button>
              );
            })
          )}
        </div>

        {/* Footer: shortcut hints + escape hatch back to Canvas */}
        <div className="flex items-center justify-between gap-3 border-t border-[rgb(var(--border-line))] bg-surface-2/60 px-3 py-2 text-tiny text-text-tertiary">
          <div className="hidden items-center gap-3 sm:flex">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1 font-emphasis">↑</kbd>
              <kbd className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1 font-emphasis">↓</kbd>
              move
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1 font-emphasis">Enter</kbd>
              open
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              onAllScreens();
              onClose();
            }}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-tiny font-emphasis text-text-secondary hover:bg-surface-1 hover:text-text-primary"
          >
            <LayoutGrid className="h-3 w-3" />
            View all screens
          </button>
        </div>
      </div>
    </div>
  );
}
