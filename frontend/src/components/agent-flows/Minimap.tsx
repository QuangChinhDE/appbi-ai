'use client';

/**
 * A schematic of the whole flow, and where you are in it.
 *
 * Drawn from the MEASURED cards rather than from the tree, so the picture is the
 * same shape as the canvas — a minimap derived from the model instead would drift
 * the moment a branch changed the layout, and a map that disagrees with the
 * territory is worse than no map.
 *
 * Clicking scrolls. That is the whole interaction: on a flow tall enough to need a
 * minimap, "where is the answer step" is the only question being asked.
 */
import React from 'react';

import { cn } from '@/lib/utils';

export interface MiniRect {
  key: string;
  /** Fractions of the stage, so the minimap does not care about zoom. */
  x: number; y: number; w: number; h: number;
  kind: 'node' | 'rule' | 'box' | 'system';
  selected?: boolean;
}

export function Minimap({
  rects, viewport, onJump,
}: {
  rects: MiniRect[];
  /** Visible slice of the stage, as fractions. */
  viewport: { top: number; height: number };
  onJump: (fraction: number) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  if (!rects.length) return null;

  const jump = (clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onJump(Math.max(0, Math.min(1, (clientY - r.top) / r.height)));
  };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => { e.preventDefault(); jump(e.clientY); }}
      onPointerMove={(e) => { if (e.buttons === 1) jump(e.clientY); }}
      title="Bấm để nhảy tới vị trí"
      className="absolute bottom-16 left-4 z-30 h-[150px] w-[104px] cursor-pointer overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1/95 p-1.5 shadow-linear-sm backdrop-blur"
    >
      <div className="relative h-full w-full">
        {rects.map((r) => (
          <span
            key={r.key}
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${Math.max(r.w * 100, 6)}%`,
              height: `${Math.max(r.h * 100, 1.5)}%`,
            }}
            className={cn(
              'absolute rounded-[1px]',
              r.selected ? 'bg-brand'
                : r.kind === 'rule' ? 'bg-[rgb(var(--border-strong))]'
                : r.kind === 'box' ? 'border border-brand/40 bg-transparent'
                : r.kind === 'system' ? 'bg-surface-3'
                : 'bg-text-quaternary/50',
            )}
          />
        ))}
        <span
          style={{ top: `${viewport.top * 100}%`, height: `${viewport.height * 100}%` }}
          className="pointer-events-none absolute inset-x-0 rounded-sm border border-brand/60 bg-brand/10"
        />
      </div>
    </div>
  );
}
