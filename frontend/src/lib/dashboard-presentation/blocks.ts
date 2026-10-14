/**
 * Presentation blocks at the plan boundary.
 *
 * A block is words and finding references. The rules that keep it safe are
 * enforced here, where a model's answer enters, and they are structural:
 *
 *  - a finding reference must name a kind the findings engine computes and a
 *    tile that is on this page — anything else is dropped, never guessed at;
 *  - text a MODEL wrote may not contain a digit. Every figure on a report comes
 *    from a finding over live rows; a number typed into a heading is a number
 *    that will be wrong the moment a filter changes. Such text is dropped (the
 *    block keeps its findings) and the drop is reported;
 *  - blocks exist only at the `redesign` layer.
 */
import { FINDING_KINDS } from '@/lib/report-findings';
import { BLOCK_VARIANTS, type BlockVariant, type PlanBlock, type VisualId } from './types';

const FINDING_KEY = /^([a-z_]+):(-?\d+)$/;
const MAX_BLOCKS = 12;
const MAX_FINDINGS_PER_BLOCK = 6;

export function parseFindingKey(key: string): { kind: string; tileId: number } | null {
  const m = FINDING_KEY.exec(String(key ?? '').trim());
  if (!m) return null;
  return { kind: m[1], tileId: Number(m[2]) };
}

/** Text a model supplied for a heading or eyebrow, or undefined when it cannot
 *  be shown (empty, or carrying a figure that is not bound to data). */
export function cleanModelText(value: unknown, limit: number): { text?: string; droppedFigure: boolean } {
  if (typeof value !== 'string') return { droppedFigure: false };
  const text = value.trim().slice(0, limit);
  if (!text) return { droppedFigure: false };
  if (/\d/.test(text)) return { droppedFigure: true };
  return { text, droppedFigure: false };
}

export interface CoercedBlocks {
  blocks: PlanBlock[];
  /** Model id ("b1", "headline", -1 …) → the block's negative id. */
  idMap: Map<string, VisualId>;
  notes: string[];
}

export function coercePlanBlocks(raw: unknown, knownTileIds: ReadonlySet<VisualId>): CoercedBlocks {
  const notes: string[] = [];
  const idMap = new Map<string, VisualId>();
  const blocks: PlanBlock[] = [];
  if (!Array.isArray(raw)) return { blocks, idMap, notes };
  let droppedFigures = 0;
  let droppedRefs = 0;
  for (const entry of raw.slice(0, MAX_BLOCKS)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const variant = BLOCK_VARIANTS.includes(e.variant as BlockVariant) ? (e.variant as BlockVariant) : 'summary';
    const findings: string[] = [];
    for (const ref of Array.isArray(e.findings) ? e.findings : []) {
      const parsed = parseFindingKey(String(ref));
      if (!parsed || !FINDING_KINDS.includes(parsed.kind as any) || !knownTileIds.has(parsed.tileId)) {
        droppedRefs += 1;
        continue;
      }
      // "Revenue is R$13.6M" only repeats a KPI tile on the same page; a
      // block says what the tiles do not (change, peak, leader, attainment).
      if (parsed.kind === 'kpi_value') continue;
      const key = `${parsed.kind}:${parsed.tileId}`;
      if (!findings.includes(key)) findings.push(key);
    }
    const title = cleanModelText(e.title, 140);
    const eyebrow = cleanModelText(e.eyebrow, 60);
    droppedFigures += (title.droppedFigure ? 1 : 0) + (eyebrow.droppedFigure ? 1 : 0);
    // A block with nothing to say is not created.
    if (findings.length === 0 && !title.text) continue;
    const id = -(blocks.length + 1);
    blocks.push({
      id,
      variant,
      ...(title.text ? { title: title.text } : {}),
      ...(eyebrow.text ? { eyebrow: eyebrow.text } : {}),
      findings: findings.slice(0, MAX_FINDINGS_PER_BLOCK),
    });
    const rawId = e.id != null ? String(e.id) : `b${blocks.length}`;
    idMap.set(rawId, id);
    idMap.set(String(id), id);
  }
  if (droppedFigures > 0) {
    notes.push('Kept numbers out of the headings: every figure on the report comes from live data, so typed figures were left out.');
  }
  if (droppedRefs > 0) {
    notes.push(`${droppedRefs} finding reference(s) did not match a chart on this page and were left out.`);
  }
  return { blocks, idMap, notes };
}

/** A section entry → a visual id: a number, or a block referenced by its id. */
export function resolveSectionRef(ref: unknown, idMap: Map<string, VisualId>): VisualId | null {
  if (typeof ref === 'number' && Number.isFinite(ref)) return idMap.get(String(ref)) ?? ref;
  const s = String(ref ?? '').trim();
  if (idMap.has(s)) return idMap.get(s)!;
  const n = Number(s);
  return Number.isFinite(n) && s !== '' ? n : null;
}

/** The widget a created block becomes: a heading is a section header. */
export function blockWidgetType(block: PlanBlock): 'narrative' | 'section_header' {
  return block.heading ? 'section_header' : 'narrative';
}

/** The widget config a created block is stored with. */
export function blockWidgetConfig(block: PlanBlock): Record<string, unknown> {
  if (block.heading) return { title: block.title ?? '', origin: 'ai' };
  return {
    variant: block.variant,
    ...(block.eyebrow ? { eyebrow: block.eyebrow } : {}),
    ...(block.title ? { title: block.title } : {}),
    items: block.findings.map((finding) => ({ finding })),
    // The existing per-widget "no card" switch — builder and public honour it.
    ...(block.frameless ? { transparentBackground: true } : {}),
    origin: 'ai',
  };
}
