/**
 * The closed loop: look at the rendered preview, repair what it broke.
 *
 * A plan is judged on paper by the validator; this judges the pixels. After the
 * preview paints, `render-audit` measures every tile, and this decides which
 * findings the preview is RESPONSIBLE for (a tile it touched) and what it may do
 * about them without leaving its permission layer:
 *
 *   - a surface/frame the preview applied that left the title unreadable is
 *     reverted to the tile's previous value — legal at every layer, because it
 *     only undoes the preview's own style change;
 *   - a tile the preview itself resized or moved that now renders below the
 *     readable size is grown once — only at structure/redesign, only for tiles
 *     the preview already moved, never a locked one;
 *   - anything else is reported, not touched.
 *
 * One pass, deterministic, no model call: bounded cost, no loop, and the repair
 * is re-validated by the caller through the same gate as the design itself, so
 * a repair cannot do what the design was not allowed to do. Failure leaves the
 * original preview untouched.
 *
 * A vision-model critic can slot in here later with the same contract — it
 * would return findings, and the repairs would still be these bounded ones.
 */
import type { DashboardChart } from '@/types/api';
import { rectsOf, lockedIdsOf } from './executor';
import { applyStructureOperations } from './structure';
import type { PresentationMutation, VisualId } from './types';
import { auditRenderedTiles } from './render-audit';
import type { RenderFinding } from './render-audit';

export interface CritiqueInput {
  root: ParentNode;
  mutation: PresentationMutation;
  /** The tiles the mutation is applied onto (before the preview). */
  tiles: DashboardChart[];
  /** The selection the preview was scoped to; unselected tiles stay fixed. */
  targets?: VisualId[];
}

export interface CritiqueResult {
  findings: RenderFinding[];
  notes: string[];
  /** A repaired mutation, or undefined when nothing was repairable. */
  repair?: PresentationMutation;
}

const MAX_REPAIRS = 3;
const SURFACE_KEYS = ['chartSurface', 'tileFrame'] as const;

export function critiquePreview(input: CritiqueInput): CritiqueResult {
  const audit = auditRenderedTiles(input.root);
  const touched = new Set(Object.keys(input.mutation.layoutOverrides).map(Number));
  const responsible = audit.findings.filter((f) => f.tileId != null && touched.has(f.tileId));
  if (responsible.length === 0) return { findings: audit.findings, notes: [] };

  const notes: string[] = [];
  const byId = new Map(input.tiles.map((t) => [t.id, t]));
  const layoutOverrides: Record<number, Record<string, any>> = {};
  for (const [id, layout] of Object.entries(input.mutation.layoutOverrides)) {
    layoutOverrides[Number(id)] = { ...(layout as Record<string, any>) };
  }
  let repairs = 0;

  // 1. Unreadable title on a surface the preview changed → restore the surface.
  for (const finding of responsible) {
    if (repairs >= MAX_REPAIRS) break;
    if (finding.code !== 'text.lowContrast' || finding.tileId == null) continue;
    const override = layoutOverrides[finding.tileId];
    const nextStyle = override?.styleConfigOverride as Record<string, unknown> | undefined;
    if (!nextStyle) continue;
    const previous = ((byId.get(finding.tileId)?.layout as any)?.styleConfigOverride ?? {}) as Record<string, unknown>;
    let changed = false;
    const restored = { ...nextStyle };
    for (const key of SURFACE_KEYS) {
      if (restored[key] !== previous[key]) {
        if (previous[key] === undefined) delete restored[key];
        else restored[key] = previous[key];
        changed = true;
      }
    }
    if (!changed) continue;
    override.styleConfigOverride = restored;
    repairs += 1;
    notes.push(`Kept visual ${finding.tileId}'s original surface — the new one made its title hard to read.`);
  }

  // 2. A tile the preview moved/resized now renders too small → grow it once.
  const mayMove = input.mutation.layer === 'structure' || input.mutation.layer === 'redesign';
  const locked = lockedIdsOf(input.tiles);
  const grow: VisualId[] = [];
  for (const finding of responsible) {
    if (!mayMove || finding.tileId == null) continue;
    if (finding.code !== 'tile.tooSmall' && finding.code !== 'content.overflow') continue;
    const override = layoutOverrides[finding.tileId];
    const geometryWritten = override && (override.w != null || override.h != null);
    if (!geometryWritten || locked.has(finding.tileId) || grow.includes(finding.tileId)) continue;
    if (repairs + grow.length >= MAX_REPAIRS) break;
    grow.push(finding.tileId);
  }
  if (grow.length > 0) {
    // Resize on the layout the preview produced, with locked tiles fixed.
    const rects = rectsOf(input.tiles);
    for (const [rawId, layout] of Object.entries(layoutOverrides)) {
      const id = Number(rawId);
      const r = rects.get(id);
      if (r && layout.x != null) rects.set(id, { x: layout.x, y: layout.y, w: layout.w, h: layout.h });
    }
    const fixed = new Set<VisualId>(locked);
    if (input.targets && input.targets.length > 0) {
      const targetSet = new Set(input.targets);
      for (const tile of input.tiles) if (!targetSet.has(tile.id)) fixed.add(tile.id);
    }
    const result = applyStructureOperations(rects, [{ op: 'resize', visuals: grow, size: 'larger' }], fixed);
    for (const [id, rect] of result.rects) {
      const before = rects.get(id);
      if (!before || (before.x === rect.x && before.y === rect.y && before.w === rect.w && before.h === rect.h)) continue;
      const pageId = layoutOverrides[id]?.pageId ?? (byId.get(id)?.layout as any)?.pageId;
      layoutOverrides[id] = { ...(layoutOverrides[id] ?? {}), x: rect.x, y: rect.y, w: rect.w, h: rect.h, gv: 2, ...(pageId ? { pageId } : {}) };
    }
    repairs += grow.length;
    notes.push(`Gave ${grow.length} visual(s) more room — they rendered too small to read.`);
  }

  for (const finding of responsible) {
    if (finding.code === 'title.clipped' && !mayMove) {
      notes.push(`Visual ${finding.tileId}'s title is cut off at its current size — widen it by hand, or ask to make it larger.`);
      break;
    }
  }

  if (repairs === 0) return { findings: audit.findings, notes };
  return {
    findings: audit.findings,
    notes,
    repair: { ...input.mutation, layoutOverrides: layoutOverrides as PresentationMutation['layoutOverrides'] },
  };
}
