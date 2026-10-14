/**
 * Content proposals — changes to what a tile SAYS, which AI Design may suggest
 * and only a person may make.
 *
 * Presentation (style / structure / redesign) is applied on Apply because it
 * cannot change a number or its meaning. A proposal can: sorting a ranking
 * changes which item reads as "first", a new title changes what the reader
 * thinks the chart is about. So a proposal is never part of a design mutation;
 * it is listed with its before → after, applied only on Accept (as an ordinary
 * draft edit, published on Publish, one undo), and the decision is audited.
 *
 * Closed kinds:
 *  - sort_by_value  a category ranking whose rows are not in value order
 *                   (derived from the rows the tile is showing — a rule, not a
 *                   guess), sorted largest-first;
 *  - retitle        a clearer title the model proposed, in plain words (no
 *                   digits: a figure in a title is a figure no filter updates).
 */
import type { TileEvidence } from '@/lib/report-findings';
import { cleanModelText } from './blocks';

export type ProposalKind = 'sort_by_value' | 'retitle';

export interface ContentProposal {
  id: string;
  kind: ProposalKind;
  tileId: number;
  source: 'ai' | 'rule';
  /** What the reader sees now and after — for the before → after line. */
  before: string;
  after: string;
  /** The draft edit Accept makes on the tile's layout. */
  patch: { custom_title?: string; styleConfigOverride?: Record<string, unknown> };
  /** For the audit record. */
  auditBefore: unknown;
  auditAfter: unknown;
}

const RANKING_TYPES = new Set(['BAR', 'HORIZONTAL_BAR', 'COLUMN']);

export interface TileContext {
  tileId: number;
  title: string;
  currentSortRules?: unknown[] | null;
  currentStyleOverride?: Record<string, unknown>;
}

/** Rule-based proposals from the rows tiles are showing. */
export function deriveProposals(evidence: TileEvidence[], tiles: Map<number, TileContext>): ContentProposal[] {
  const out: ContentProposal[] = [];
  for (const e of evidence) {
    const tile = tiles.get(e.tileId);
    if (!tile || !RANKING_TYPES.has(e.chartType) || !e.dimensionField || e.timeField) continue;
    if (tile.currentSortRules && tile.currentSortRules.length > 0) continue; // the author chose an order
    const items = e.rows
      .map((r) => ({ label: String(r[e.dimensionField!] ?? ''), value: Number(r[e.measureField]) }))
      .filter((x) => x.label !== '' && Number.isFinite(x.value));
    if (items.length < 3) continue;
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const inOrder = items.every((x, i) => x.label === sorted[i].label);
    if (inOrder) continue;
    const rule = [{ field: e.measureField, direction: 'desc' }];
    out.push({
      id: `sort_by_value:${e.tileId}`,
      kind: 'sort_by_value',
      tileId: e.tileId,
      source: 'rule',
      before: items.slice(0, 4).map((x) => x.label).join(', '),
      after: sorted.slice(0, 4).map((x) => x.label).join(', '),
      patch: { styleConfigOverride: { ...(tile.currentStyleOverride ?? {}), chartSortRules: rule } },
      auditBefore: tile.currentSortRules ?? null,
      auditAfter: rule,
    });
  }
  return out;
}

/** Model-proposed retitles, coerced at the boundary. */
export function coerceModelProposals(raw: unknown, tiles: Map<number, TileContext>): ContentProposal[] {
  if (!Array.isArray(raw)) return [];
  const out: ContentProposal[] = [];
  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.kind !== 'retitle') continue;
    const tileId = Number(e.visual);
    const tile = tiles.get(tileId);
    if (!tile) continue;
    const { text } = cleanModelText(e.title, 80);
    if (!text || text === tile.title) continue;
    out.push({
      id: `retitle:${tileId}`,
      kind: 'retitle',
      tileId,
      source: 'ai',
      before: tile.title,
      after: text,
      patch: { custom_title: text },
      auditBefore: tile.title,
      auditAfter: text,
    });
  }
  return out;
}
