'use client';

/**
 * The Arrange bar: appears while TWO OR MORE tiles are selected in the manual
 * builder — arranging is a relation between tiles, so one selected tile shows no
 * bar (its frame is set in the Inspector). Arrange actions are grid operations
 * (lib/grid-arrange); Frame sets how much container each selected chart wears —
 * a card, a subtle panel, or flush on the canvas. Both groups sit behind one
 * menu each, so the bar is "N selected · Arrange · Frame · ×" rather than a row
 * of eleven controls. Both go through the page's layout-override path: undoable,
 * saved to the draft, published with it. No coordinates are shown or typed.
 */
import React from 'react';
import {
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  Check,
  ChevronDown,
  LayoutTemplate,
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

/** A bar menu: one trigger, a role=menu list, closes on pick / Escape / outside click. */
function BarMenu({
  id,
  label,
  icon: Icon,
  children,
}: {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const close = React.useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    // Escape closes the menu only — it must not also clear the selection.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    rootRef.current?.querySelector<HTMLElement>('[role="menu"] button:not(:disabled)')?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open, close]);
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid={`arrange-${id}-open`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] font-[510] transition-colors ${
          open ? 'border-brand/40 bg-brand-container text-brand-on-container' : 'border-stroke-strong bg-surface-1 text-text-secondary hover:bg-surface-2 hover:text-text-primary'
        }`}
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="bi-fade-in absolute left-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-lg border border-stroke-strong bg-surface-1 py-1 shadow-popover"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)'));
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

const ITEM = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-[510] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40';

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
  if (count < 2) return null;
  return (
    <div
      role="toolbar"
      aria-label={t('dashboards.arrange.title')}
      data-testid="arrange-bar"
      data-html2canvas-ignore
      className="sticky top-2 z-40 mb-2 flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-stroke-strong bg-surface-1 p-1 shadow-xl"
    >
      <span className="px-2 text-[12px] font-medium text-text-primary">{t('dashboards.arrange.selected', { count })}</span>
      <BarMenu id="align" label={t('dashboards.arrange.title')} icon={AlignStartVertical}>
        {(close) => ACTIONS.map(({ op, icon: Icon, label, min }) => (
          <button
            key={op}
            type="button"
            role="menuitem"
            data-testid={`arrange-${op}`}
            disabled={count < min}
            title={count < min ? t('dashboards.arrange.needsThree') : undefined}
            onClick={() => { onArrange(op); close(); }}
            className={ITEM}
          >
            <Icon className="h-4 w-4 shrink-0 text-text-tertiary" />
            {t(label)}
          </button>
        ))}
      </BarMenu>
      {onFrame && (
        <BarMenu id="frame" label={t('dashboards.arrange.frame.title')} icon={LayoutTemplate}>
          {(close) => FRAMES.map((f) => (
            <button
              key={f}
              type="button"
              role="menuitemradio"
              aria-checked={frame === f}
              data-testid={`arrange-frame-${f}`}
              onClick={() => { onFrame(f); close(); }}
              className={ITEM}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={frame === f ? 'text-text-primary' : undefined}>{t(`dashboards.arrange.frame.${f}`)}</span>
                <span className="text-[11px] font-normal leading-snug text-text-tertiary">{t(`dashboards.arrange.frame.${f}Hint`)}</span>
              </span>
              {frame === f && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
            </button>
          ))}
        </BarMenu>
      )}
      <span className="mx-0.5 h-4 w-px bg-stroke-line" aria-hidden />
      <button
        type="button"
        data-testid="arrange-clear"
        onClick={onClear}
        title={t('dashboards.arrange.clear')}
        aria-label={t('dashboards.arrange.clear')}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
