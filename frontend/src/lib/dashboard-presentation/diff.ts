/**
 * What changed, in a sentence a person can check.
 *
 * The preview is the only place a user gets to disagree before a redesign
 * touches their report, so the summary has to be countable and honest: eight
 * moved, five resized, six restyled. A diff that said "layout improved" would
 * be worse than none, because it invites Apply without looking.
 */
import type { DashboardChart } from '@/types/api';
import { scaleGridLayoutForRender } from '@/lib/dashboard-pages';
import type { PresentationMutation, VisualId } from './types';

export interface PresentationDiff {
  moved: VisualId[];
  resized: VisualId[];
  restyled: VisualId[];
  unchanged: VisualId[];
  createdWidgetCount: number;
  themeKeys: string[];
  slicerKeys: string[];
  notes: string[];
}

function rectOf(tile: DashboardChart): { x: number; y: number; w: number; h: number } {
  const layout = (scaleGridLayoutForRender(tile.layout as any) ?? {}) as Record<string, any>;
  return {
    x: Number(layout.x) || 0,
    y: Number(layout.y) || 0,
    w: Number(layout.w) || 0,
    h: Number(layout.h) || 0,
  };
}

export function diffPresentation(
  tilesBefore: DashboardChart[],
  mutation: PresentationMutation,
): PresentationDiff {
  const moved: VisualId[] = [];
  const resized: VisualId[] = [];
  const restyled: VisualId[] = [];
  const unchanged: VisualId[] = [];

  for (const tile of tilesBefore) {
    const next = mutation.layoutOverrides[tile.id];
    if (!next) { unchanged.push(tile.id); continue; }
    const before = rectOf(tile);
    const positionChanged = Number(next.x) !== before.x || Number(next.y) !== before.y;
    const sizeChanged = Number(next.w) !== before.w || Number(next.h) !== before.h;
    // A tile can be both moved and resized; counting it in both is the honest
    // answer, and the summary says "moved 8 · resized 5", not "13 changes".
    if (positionChanged) moved.push(tile.id);
    if (sizeChanged) resized.push(tile.id);
    if ((next as any).styleConfigOverride) restyled.push(tile.id);
    if (!positionChanged && !sizeChanged && !(next as any).styleConfigOverride) unchanged.push(tile.id);
  }

  return {
    moved,
    resized,
    restyled,
    unchanged,
    createdWidgetCount: (mutation.createdWidgets ?? []).length,
    themeKeys: Object.keys(mutation.themePatch ?? {}),
    slicerKeys: Object.keys(mutation.slicerClusterPatch ?? {}),
    notes: mutation.notes ?? [],
  };
}

/** One-line summaries for the panel, in the order a reader cares about. */
export function summarizeDiff(diff: PresentationDiff): string[] {
  const lines: string[] = [];
  if (diff.moved.length) lines.push(`Moved ${diff.moved.length} visual${diff.moved.length === 1 ? '' : 's'}`);
  if (diff.resized.length) lines.push(`Resized ${diff.resized.length} visual${diff.resized.length === 1 ? '' : 's'}`);
  if (diff.restyled.length) lines.push(`Restyled ${diff.restyled.length} visual${diff.restyled.length === 1 ? '' : 's'}`);
  if (diff.createdWidgetCount) lines.push(`Added ${diff.createdWidgetCount} section element${diff.createdWidgetCount === 1 ? '' : 's'}`);
  if (diff.slicerKeys.length) lines.push('Repositioned the filters');
  if (diff.themeKeys.length) lines.push(`Theme: ${diff.themeKeys.length} setting${diff.themeKeys.length === 1 ? '' : 's'}`);
  if (lines.length === 0) lines.push('Nothing to change — the page already matches that description');
  return lines;
}

export function isEmptyDiff(diff: PresentationDiff): boolean {
  return diff.moved.length === 0
    && diff.resized.length === 0
    && diff.restyled.length === 0
    && diff.createdWidgetCount === 0
    && diff.themeKeys.length === 0
    && diff.slicerKeys.length === 0;
}
