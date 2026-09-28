'use client';

/**
 * Add element → Slicer. Two ways to put a slicer on the page:
 *   - place a filter the report already has (it keeps its field, value and
 *     scope — only its control moves onto the grid), or
 *   - make a new filter on a field, with the same entry factory the filter
 *     bar's "Add slicer" uses (`createSlicerEntry`).
 * Where a control sits never decides what it filters; the picker says so.
 */
import React from 'react';
import { Calendar, Filter, Hash, List, Search, X } from 'lucide-react';
import type { BaseFilter, ColumnInfo } from '@/lib/filters';
import { getColumnDisplayLabel, getColumnGroupLabel, getFilterDisplayLabel } from '@/lib/filters';
import { useI18n } from '@/providers/LanguageProvider';

const TYPE_ICON = { date: Calendar, number: Hash, dropdown: List, text: List } as const;

/** Where the new control goes. `top` makes room by moving the page's content
 *  down (an explicit, undoable-by-Discard action — the grid never shoves tiles
 *  on its own); `end` takes the first free row under the content. */
export type SlicerPlacementTarget = 'top' | 'end';

export function AddSlicerModal({
  open,
  onClose,
  existing,
  columns,
  onPlaceExisting,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  /** Slicers shown on this page that have no control on its grid yet. */
  existing: BaseFilter[];
  /** Fields a new filter may use (a chart on the report can apply it). */
  columns: ColumnInfo[];
  onPlaceExisting: (slicer: BaseFilter, where: SlicerPlacementTarget) => void;
  onCreate: (column: ColumnInfo, where: SlicerPlacementTarget) => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const [search, setSearch] = React.useState('');
  const [where, setWhere] = React.useState<SlicerPlacementTarget>('top');
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!open) { setSearch(''); return; }
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(id); window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  if (!open) return null;

  const q = search.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const shownExisting = existing.filter((s) => matches(`${getFilterDisplayLabel(s)} ${s.field}`));
  const shownColumns = columns.filter((c) => matches(
    [getColumnDisplayLabel(c), getColumnGroupLabel(c), c.name, c.datasetName ?? ''].join(' '),
  ));

  return (
    <div className="fixed inset-0 z-[9998] flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('dashboards.addSlicer.title')}
        data-testid="add-slicer-modal"
        className="flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-4 py-3">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
            <Filter className="h-4 w-4 text-brand" />
            {t('dashboards.addSlicer.title')}
          </h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-text-tertiary hover:bg-surface-2" aria-label={t('dashboards.addSlicer.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-[rgb(var(--border-line))] px-4 py-2">
          <label className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2">
            <Search className="h-3.5 w-3.5 text-text-quaternary" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('dashboards.addSlicer.search')}
              className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              data-testid="add-slicer-search"
            />
          </label>
          <div className="mt-2 flex items-center gap-1 text-[11px]" role="radiogroup" aria-label={t('dashboards.addSlicer.where')}>
            <span className="mr-1 text-text-tertiary">{t('dashboards.addSlicer.where')}</span>
            {(['top', 'end'] as const).map((w) => (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={where === w}
                data-testid={`add-slicer-where-${w}`}
                onClick={() => setWhere(w)}
                className={`rounded-full border px-2 py-0.5 ${where === w ? 'border-brand bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'}`}
              >
                {t(`dashboards.addSlicer.where.${w}`)}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-text-quaternary">{t('dashboards.addSlicer.scopeNote')}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">
            {t('dashboards.addSlicer.existing')}
          </div>
          {shownExisting.length === 0 ? (
            <p className="px-4 py-1.5 text-[12px] text-text-quaternary">{t('dashboards.addSlicer.noExisting')}</p>
          ) : shownExisting.map((slicer) => {
            const Icon = TYPE_ICON[slicer.type as keyof typeof TYPE_ICON] ?? List;
            return (
              <button
                key={slicer.id}
                type="button"
                disabled={busy}
                data-testid={`add-slicer-existing-${slicer.id}`}
                onClick={() => onPlaceExisting(slicer, where)}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                <span className="min-w-0 flex-1 truncate">{getFilterDisplayLabel(slicer)}</span>
                <span className="shrink-0 text-[10px] text-text-quaternary">{t('dashboards.addSlicer.placedElsewhere')}</span>
              </button>
            );
          })}
          <div className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-text-quaternary">
            {t('dashboards.addSlicer.new')}
          </div>
          {shownColumns.length === 0 ? (
            <p className="px-4 py-1.5 text-[12px] text-text-quaternary">{t('dashboards.addSlicer.noFields')}</p>
          ) : shownColumns.map((column) => {
            const Icon = TYPE_ICON[column.type as keyof typeof TYPE_ICON] ?? List;
            const key = `${column.datasetId ?? ''}:${column.semanticField ?? column.name}`;
            return (
              <button
                key={key}
                type="button"
                disabled={busy}
                data-testid={`add-slicer-field-${column.semanticField ?? column.name}`}
                onClick={() => onCreate(column, where)}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                <span className="min-w-0 flex-1 truncate">{getColumnDisplayLabel(column)}</span>
                <span className="max-w-[40%] shrink-0 truncate text-[10px] text-text-quaternary">{getColumnGroupLabel(column)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
