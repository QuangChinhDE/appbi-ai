'use client';

/**
 * The one place an author adds something to the report.
 *
 * Every native element — the report header, sections, text, a sentence
 * computed from data, notes, images, charts, filter controls — in one palette,
 * each with a line saying what it is for, so a first-time author can see what
 * a report is made of. It says where the element will go: directly under the
 * selected element (and into its section), or at the end of the page.
 *
 * Buttons are named by their label alone (the description is linked with
 * aria-describedby), so "Section header" is one name wherever it is offered.
 */
import React, { useEffect, useRef } from 'react';
import {
  BarChart3, Filter, Heading1, Image as ImageIcon, LayoutTemplate, Lightbulb, Minus, StickyNote, Timer, ToggleLeft, Type,
} from 'lucide-react';
import { useI18n } from '@/providers/LanguageProvider';

export type AddElementKind =
  | 'hero_strip' | 'section_header' | 'text' | 'narrative' | 'callout' | 'image' | 'shape'
  | 'countdown' | 'parameter_switcher' | 'chart' | 'slicer';

interface Item { kind: AddElementKind; label: string; desc: string; icon: React.ComponentType<{ className?: string }> }

export function AddElementMenu({
  open, onClose, onPick, insertionLabel,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (kind: AddElementKind) => void;
  /** Where the element will go, as a sentence. */
  insertionLabel: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(id); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  if (!open) return null;

  const groups: Array<{ title: string; items: Item[] }> = [
    {
      title: t('dashboards.addElement.groupStructure'),
      items: [
        { kind: 'hero_strip', label: t('dashboards.detail.widgetHeroStrip'), desc: t('dashboards.addElement.descHeader'), icon: LayoutTemplate },
        { kind: 'section_header', label: t('dashboards.detail.widgetSectionHeader'), desc: t('dashboards.addElement.descSection'), icon: Heading1 },
      ],
    },
    {
      title: t('dashboards.addElement.groupData'),
      items: [
        { kind: 'chart', label: t('dashboards.addElement.chart'), desc: t('dashboards.addElement.descChart'), icon: BarChart3 },
        { kind: 'narrative', label: t('dashboards.addElement.insight'), desc: t('dashboards.addElement.descInsight'), icon: Lightbulb },
        { kind: 'slicer', label: t('dashboards.addSlicer.menu'), desc: t('dashboards.addElement.descSlicer'), icon: Filter },
      ],
    },
    {
      title: t('dashboards.addElement.groupContent'),
      items: [
        { kind: 'text', label: t('dashboards.detail.widgetText'), desc: t('dashboards.addElement.descText'), icon: Type },
        { kind: 'callout', label: t('dashboards.detail.widgetCallout'), desc: t('dashboards.addElement.descCallout'), icon: StickyNote },
        { kind: 'image', label: t('dashboards.detail.widgetImage'), desc: t('dashboards.addElement.descImage'), icon: ImageIcon },
        { kind: 'shape', label: t('dashboards.detail.widgetShape'), desc: t('dashboards.addElement.descShape'), icon: Minus },
      ],
    },
    {
      title: t('dashboards.addElement.groupMore'),
      items: [
        { kind: 'parameter_switcher', label: t('dashboards.detail.widgetParamSwitcher'), desc: t('dashboards.addElement.descParam'), icon: ToggleLeft },
        { kind: 'countdown', label: t('dashboards.detail.widgetCountdown'), desc: t('dashboards.addElement.descCountdown'), icon: Timer },
      ],
    },
  ];

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('dashboards.addElement.title')}
      data-testid="add-element-menu"
      className="absolute right-0 top-full z-50 mt-1.5 w-[380px] overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg"
    >
      <div className="border-b border-[rgb(var(--border-line))] px-3.5 py-2.5">
        <div className="text-[13px] font-semibold text-text-primary">{t('dashboards.addElement.title')}</div>
        <div className="mt-0.5 text-[11px] text-text-tertiary" data-testid="add-element-where">{insertionLabel}</div>
      </div>
      <div className="max-h-[70vh] overflow-y-auto py-1.5">
        {groups.map((g) => (
          <div key={g.title} className="px-1.5 pb-1">
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-quaternary">{g.title}</div>
            {g.items.map((it) => {
              const descId = `add-element-desc-${it.kind}`;
              const Icon = it.icon;
              return (
                <button
                  key={it.kind}
                  type="button"
                  aria-label={it.label}
                  aria-describedby={descId}
                  data-testid={`add-element-${it.kind}`}
                  onClick={() => { onPick(it.kind); onClose(); }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[rgba(0,0,0,0.04)]"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-[560] text-text-primary">{it.label}</span>
                    <span id={descId} className="block text-[11px] leading-snug text-text-tertiary">{it.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
