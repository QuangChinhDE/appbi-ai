/**
 * BaseTablePicker — the Explore "base table" chip, now a DROPDOWN.
 *
 * The base (left) table is the FROM root of the chart's semantic join tree.
 * Previously this was a read-only chip and the base was auto-derived from the
 * first picked field (which ignores the data model). This makes the chip
 * changeable so a DA can anchor the chart to the right table, and marks the
 * model's CENTRAL FACT (the measure table reaching the most others via N:1) as
 * recommended. The recommendation is only a marker: it never changes the base.
 * Changing the base re-roots the JOIN tree; the caller keeps every binding the
 * new base still reaches and drops (with Undo) only the rest.
 *
 * The chip also says where the base came from (saved / chosen / derived from
 * the first field the user picked) and, when the chart's numbers are computed
 * on another table, which — so "base X" next to a refusal about Y is explained.
 */
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Database, Link2, Star } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';

export interface BaseTablePickerTable {
  id: number;
  display_name?: string;
  source_table_name?: string;
}

interface BaseTablePickerProps {
  tables: BaseTablePickerTable[];
  selectedTableId: number | null;
  recommendedTableId: number | null;
  onChange: (tableId: number) => void;
  /** Display label of the current base view (humanised). */
  baseLabel: string;
  /** How many other tables this chart ACTUALLY joins (drives the +N badge). */
  joinedCount: number;
  /** Pill tone classes (matches the previous chip's success/neutral tone). */
  tone: string;
  /** Whether the chart currently combines other tables (icon: Link2 vs Database). */
  hasJoined: boolean;
  /** Tooltip describing the current relationship state. */
  tip: string;
  /** Where the base came from (null = not decided yet). */
  originLabel?: string | null;
  /** "Numbers computed on: …" when measures come from tables other than the base. */
  measureNote?: string | null;
  /** Shown in the menu when the model's recommendation differs from the base. */
  recommendedNote?: string | null;
  disabled?: boolean;
}

function tableLabel(t: BaseTablePickerTable): string {
  return t.display_name || t.source_table_name || `#${t.id}`;
}

export function BaseTablePicker({
  tables,
  selectedTableId,
  recommendedTableId,
  onChange,
  baseLabel,
  joinedCount,
  tone,
  hasJoined,
  tip,
  originLabel,
  measureNote,
  recommendedNote,
  disabled,
}: BaseTablePickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const Icon = hasJoined ? Link2 : Database;
  // Choosable whenever there is a choice — including the very first one, made
  // before any field (a single-table dataset has nothing to choose).
  const canOpen = !disabled && (tables.length > 1 || (selectedTableId == null && tables.length > 0));

  return (
    <div ref={wrapRef} className="relative inline-flex items-center gap-1.5" data-testid="base-chip">
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen((v) => !v)}
        title={canOpen ? `${tip}
${t('explore.editor.baseChangeTitle')}` : tip}
        data-testid="base-chip-button"
        data-base-table-id={selectedTableId ?? ''}
        className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone} ${canOpen ? 'cursor-pointer hover:brightness-95' : 'cursor-default'}`}
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="max-w-[160px] truncate">{baseLabel}</span>
        {hasJoined && joinedCount > 0 && <span className="opacity-70">+{joinedCount}</span>}
        {canOpen && <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />}
      </button>
      {originLabel && (
        <span className="shrink-0 text-[10px] text-text-quaternary" data-testid="base-origin">{originLabel}</span>
      )}
      {measureNote && (
        <span className="max-w-[220px] truncate text-[10px] text-text-tertiary" title={measureNote} data-testid="base-measure-note">
          · {measureNote}
        </span>
      )}

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-1 shadow-lg"
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-quaternary">
            {t('explore.editor.baseMenuHeading')}
          </div>
          {recommendedNote && (
            <p className="px-2 pb-1 text-[10px] text-text-tertiary" data-testid="base-recommended-note">{recommendedNote}</p>
          )}
          {tables.map((tbl) => {
            const isCurrent = tbl.id === selectedTableId;
            const isRecommended = recommendedTableId != null && tbl.id === recommendedTableId;
            return (
              <button
                key={tbl.id}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                data-testid={`base-option-${tbl.id}`}
                onClick={() => {
                  setOpen(false);
                  if (tbl.id !== selectedTableId) onChange(tbl.id);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${isCurrent ? 'bg-surface-3 text-text-primary' : 'text-text-secondary hover:bg-surface-2'}`}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {isCurrent && <Check className="h-3.5 w-3.5 text-success" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{tableLabel(tbl)}</span>
                {isRecommended && (
                  <span
                    title={t('explore.editor.baseRecommendedHint')}
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
                  >
                    <Star className="h-2.5 w-2.5" />
                    {t('explore.editor.baseRecommended')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
