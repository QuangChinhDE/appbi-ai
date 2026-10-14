'use client';

/**
 * The Arrange bar: appears while tiles are selected in the manual builder.
 * Arrange actions (two or more tiles) are grid operations (lib/grid-arrange);
 * Frame (one or more charts) sets how much container each chart wears — a card,
 * a subtle panel, or flush on the canvas — so a manual report is not a wall of
 * identical cards. Both go through the page's layout-override path: undoable,
 * saved to the draft, published with it. No coordinates are shown or typed.
 */
import React from 'react';
import {
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  StretchHorizontal,
  StretchVertical,
  X,
} from 'lucide-react';
import type { ArrangeOp } from '@/lib/grid-arrange';
import { useI18n } from '@/providers/LanguageProvider';

const ACTIONS: Array<{ op: ArrangeOp; icon: React.ComponentType<{ className?: string }>; label: string; min: number }> = [
  { op: 'alignLeft', icon: AlignStartVertical, label: 'dashboards.arrange.alignLeft', min: 2 },
  { op: 'alignRight', icon: AlignEndVertical, label: 'dashboards.arrange.alignRight', min: 2 },
  { op: 'alignTop', icon: AlignStartHorizontal, label: 'dashboards.arrange.alignTop', min: 2 },
  { op: 'alignBottom', icon: AlignEndHorizontal, label: 'dashboards.arrange.alignBottom', min: 2 },
  { op: 'matchWidth', icon: StretchHorizontal, label: 'dashboards.arrange.matchWidth', min: 2 },
  { op: 'matchHeight', icon: StretchVertical, label: 'dashboards.arrange.matchHeight', min: 2 },
  { op: 'distribute', icon: AlignHorizontalDistributeCenter, label: 'dashboards.arrange.distribute', min: 3 },
];

export type TileFrame = 'card' | 'subtle' | 'flush';
const FRAMES: TileFrame[] = ['card', 'subtle', 'flush'];

export function ArrangeBar({
  count,
  onArrange,
  onClear,
  onFrame,
  frame,
}: {
  count: number;
  onArrange: (op: ArrangeOp) => void;
  onClear: () => void;
  /** Set the frame of the selected charts. Absent: no chart is selected. */
  onFrame?: (frame: TileFrame) => void;
  /** The selection's common frame, when they share one. */
  frame?: TileFrame | null;
}) {
  const { t } = useI18n();
  if (count < 1 || (count < 2 && !onFrame)) return null;
  return (
    <div
      role="toolbar"
      aria-label={t('dashboards.arrange.title')}
      data-testid="arrange-bar"
      data-html2canvas-ignore
      className="sticky top-2 z-40 mb-2 flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-1 shadow-xl"
    >
      <span className="px-2 text-[11px] font-medium text-text-tertiary">{t('dashboards.arrange.selected', { count })}</span>
      {onFrame && (
        <span className="flex items-center gap-0.5 border-r border-[rgb(var(--border-line))] pr-1" role="group" aria-label={t('dashboards.arrange.frame.title')}>
          <span className="px-1 text-[11px] text-text-quaternary">{t('dashboards.arrange.frame.title')}</span>
          {FRAMES.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`arrange-frame-${f}`}
              aria-pressed={frame === f}
              onClick={() => onFrame(f)}
              title={t(`dashboards.arrange.frame.${f}Hint`)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                frame === f ? 'bg-brand/15 text-brand' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              {t(`dashboards.arrange.frame.${f}`)}
            </button>
          ))}
        </span>
      )}
      {count >= 2 && ACTIONS.map(({ op, icon: Icon, label, min }) => (
        <button
          key={op}
          type="button"
          data-testid={`arrange-${op}`}
          disabled={count < min}
          onClick={() => onArrange(op)}
          title={t(label)}
          aria-label={t(label)}
          className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-35"
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-[rgb(var(--border-line))]" />
      <button
        type="button"
        onClick={onClear}
        title={t('dashboards.arrange.clear')}
        aria-label={t('dashboards.arrange.clear')}
        className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
