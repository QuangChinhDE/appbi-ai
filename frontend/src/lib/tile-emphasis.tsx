'use client';

/**
 * How loudly an element speaks relative to the rest of the report.
 *
 * An author marks the one figure the page is about as `lead`, and the context
 * around it as `quiet`; everything else is `normal`. Stored on the tile's
 * layout (`layout.emphasis`), so it is a draft edit like a move, and read the
 * same way by the builder, /d, /embed and the PDF. It scales the report's own
 * type roles — never a typed pixel size — so a theme change keeps the ratio.
 */
import React, { createContext, useContext } from 'react';

export type TileEmphasis = 'lead' | 'normal' | 'quiet';

export const TILE_EMPHASES: TileEmphasis[] = ['lead', 'normal', 'quiet'];

/** Multiplier on the KPI value and the tile title. */
export const EMPHASIS_SCALE: Record<TileEmphasis, number> = { lead: 1.45, normal: 1, quiet: 0.8 };

export function emphasisOf(layout: unknown): TileEmphasis {
  const v = (layout as { emphasis?: unknown } | null | undefined)?.emphasis;
  return v === 'lead' || v === 'quiet' ? v : 'normal';
}

const TileEmphasisContext = createContext<TileEmphasis>('normal');

export function TileEmphasisProvider({ value, children }: { value: TileEmphasis; children: React.ReactNode }) {
  return <TileEmphasisContext.Provider value={value}>{children}</TileEmphasisContext.Provider>;
}

export function useTileEmphasis(): TileEmphasis {
  return useContext(TileEmphasisContext);
}
