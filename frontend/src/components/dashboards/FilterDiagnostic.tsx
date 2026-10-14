'use client';

/**
 * The Builder's note on a chart that some report filters do not reach
 * (lib/filter-diagnostic). Compact in the tile header — "2 bộ lọc không áp dụng"
 * — and, when opened, which filter, why in product words, and the consequence.
 * Author chrome: never on /d, /embed or emb_, and hidden from exports.
 */
import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { FilterDiagnosticItem } from '@/lib/filter-diagnostic';
import { useI18n } from '@/providers/LanguageProvider';

export function FilterDiagnostic({ items }: { items: FilterDiagnosticItem[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (items.length === 0) return null;
  const count = items.length;
  const label = count === 1
    ? t('dashboards.filterDiagnostic.badgeOne', { count })
    : t('dashboards.filterDiagnostic.badgeMany', { count });
  const technical = items.map((i) => i.technical).filter(Boolean);
  return (
    <span ref={ref} className="relative min-w-0 shrink" data-export-hide="">
      <button
        type="button"
        data-testid="tile-filter-diagnostic"
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={t('dashboards.filterDiagnostic.title')}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100"
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('dashboards.filterDiagnostic.title')}
          data-testid="tile-filter-diagnostic-details"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-50 mt-1 w-[min(20rem,80vw)] cursor-default rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3 text-left text-[12px] font-normal normal-case leading-snug tracking-normal text-text-secondary shadow-linear-lg"
        >
          <p className="font-semibold text-text-primary">{t('dashboards.filterDiagnostic.title')}</p>
          <p className="mt-1">{t('dashboards.filterDiagnostic.consequence')}</p>
          <ul className="mt-2 space-y-1.5">
            {items.map((item) => (
              <li key={item.label} data-testid="tile-filter-diagnostic-item">
                <span className="font-medium text-text-primary">{item.label}</span>
                {' — '}
                {t(`dashboards.filterDiagnostic.reason.${item.kind}`)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-text-tertiary">{t('dashboards.filterDiagnostic.fix')}</p>
          {technical.length > 0 && (
            <details className="mt-2 text-[11px] text-text-tertiary">
              <summary className="cursor-pointer select-none">{t('dashboards.filterDiagnostic.technical')}</summary>
              <ul className="mt-1 space-y-0.5 break-words font-mono text-[10px]">
                {technical.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </span>
  );
}
