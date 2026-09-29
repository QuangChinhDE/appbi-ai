/**
 * Report structure: Report → Sections → Content.
 *
 * A section is a `section_header` element and the elements that belong to it.
 * Membership is STORED on the member (`layout.sectionId` = the header's tile
 * id), so moving or resizing one element never redefines another section, and
 * a section can be moved as a whole. A report saved before membership existed
 * (no `sectionId` anywhere) still reads the way it always did: a header opens
 * a section that runs down to the next header (the geometric rule the section
 * bands, the AI compiler and the PDF used). An explicit `sectionId` always
 * wins over that inference; `sectionId: null` says "belongs to no section".
 *
 * Pure: no React, no DOM. Consumers: the builder (stamping on drop, group
 * move, insertion, the structure outline), section bands, the phone reading
 * order and the PDF keep-together rule.
 */
import { resolveDrop, type GridBox } from '@/lib/grid-arrange';

export type StructKind = 'header' | 'section' | 'narrative' | 'content';

export interface StructTile {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: StructKind;
  /** Stored membership: a header id, `null` (explicitly none), or undefined (legacy: inferred). */
  sectionId?: number | null;
  locked?: boolean;
  /** Tiles a narrative states findings about. */
  cites?: number[];
}

export interface ResolvedSection {
  headerId: number;
  /** Member ids in reading order. */
  members: number[];
}

export interface Structure {
  sections: ResolvedSection[];
  /** tile id → header id of its section, or null (preamble / no section). */
  sectionOf: Map<number, number | null>;
}

const byReading = (a: { y: number; x: number }, b: { y: number; x: number }) => a.y - b.y || a.x - b.x;

/** Map dashboard tiles to structure tiles. `layoutOf` returns the layout the author sees. */
export function toStructTiles(
  tiles: Array<{ id: number; widget_type?: string | null; widget_config?: any; layout?: any }>,
  layoutOf: (id: number) => any = (id) => tiles.find((t) => t.id === id)?.layout,
): StructTile[] {
  return tiles.map((t) => {
    const l = layoutOf(t.id) ?? {};
    const wt = t.widget_type ?? 'chart';
    const kind: StructKind = wt === 'section_header' ? 'section' : wt === 'hero_strip' ? 'header' : wt === 'narrative' ? 'narrative' : 'content';
    const cites = kind === 'narrative'
      ? ((t.widget_config?.items ?? []) as { finding?: string }[])
        .map((i) => Number(String(i?.finding ?? '').split(':')[1]))
        .filter((n) => Number.isFinite(n))
      : undefined;
    const raw = l.sectionId;
    return {
      id: t.id,
      x: Number(l.x) || 0,
      y: Number(l.y) || 0,
      w: Number(l.w) || 1,
      h: Number(l.h) || 1,
      kind,
      sectionId: raw === null ? null : (Number.isFinite(Number(raw)) && raw !== undefined && raw !== '' ? Number(raw) : undefined),
      locked: Boolean(l.locked),
      ...(cites ? { cites } : {}),
    };
  });
}

/** The header whose section a point at row `y` falls in by position (the legacy rule). */
function headerAbove(headers: StructTile[], y: number): StructTile | undefined {
  let found: StructTile | undefined;
  for (const h of headers) if (h.y <= y) found = h;
  return found;
}

export function resolveStructure(tiles: StructTile[]): Structure {
  const headers = tiles.filter((t) => t.kind === 'section').sort(byReading);
  const headerIds = new Set(headers.map((h) => h.id));
  const sectionOf = new Map<number, number | null>();
  for (const t of tiles) {
    if (t.kind === 'section' || t.kind === 'header') { sectionOf.set(t.id, null); continue; }
    if (t.sectionId === null) { sectionOf.set(t.id, null); continue; }
    if (t.sectionId !== undefined && headerIds.has(t.sectionId)) { sectionOf.set(t.id, t.sectionId); continue; }
    // Legacy / dangling reference: by position.
    sectionOf.set(t.id, headerAbove(headers, t.y)?.id ?? null);
  }
  const sections = headers.map((h) => ({
    headerId: h.id,
    members: tiles.filter((t) => sectionOf.get(t.id) === h.id).sort(byReading).map((t) => t.id),
  }));
  return { sections, sectionOf };
}

/** Which section a tile landing at `y` joins: the header above it by position. */
export function sectionForPosition(tiles: StructTile[], y: number, excludeId?: number): number | null {
  const headers = tiles.filter((t) => t.kind === 'section' && t.id !== excludeId).sort(byReading);
  return headerAbove(headers, y)?.id ?? null;
}

/**
 * What a heading just placed at `headerId` introduces: every element below it,
 * down to the next heading, that belongs to no section (stated "none", never
 * stated, or pointing at a heading that is gone). An element already stated
 * into another section keeps it. Without this, a heading added above charts the
 * palette had placed in no section introduced nothing: no band, no phone
 * grouping, and an "empty section" in the outline.
 */
export function adoptableUnder(tiles: StructTile[], headerId: number): number[] {
  const header = tiles.find((t) => t.id === headerId);
  if (!header || header.kind !== 'section') return [];
  const headerIds = new Set(tiles.filter((t) => t.kind === 'section').map((t) => t.id));
  const next = tiles
    .filter((t) => t.kind === 'section' && t.id !== headerId && t.y >= header.y + header.h)
    .reduce<number>((m, t) => Math.min(m, t.y), Infinity);
  return tiles
    .filter((t) => (t.kind === 'content' || t.kind === 'narrative')
      && t.y >= header.y + header.h && t.y < next
      && (t.sectionId == null || !headerIds.has(t.sectionId)))
    .sort(byReading)
    .map((t) => t.id);
}

export type StructureIssue =
  | { kind: 'empty_section'; headerId: number }
  | { kind: 'member_above_heading'; headerId: number; tileId: number }
  | { kind: 'narrative_detached'; tileId: number; citedSection: number | null };

/** What a reader would find broken: a heading with nothing under it, content
 *  that belongs to a section but sits above its heading, and a narrative whose
 *  findings are about charts in another section. */
export function structureIssues(tiles: StructTile[], structure: Structure = resolveStructure(tiles)): StructureIssue[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const issues: StructureIssue[] = [];
  for (const s of structure.sections) {
    const header = byId.get(s.headerId)!;
    if (s.members.length === 0) issues.push({ kind: 'empty_section', headerId: s.headerId });
    for (const m of s.members) {
      const t = byId.get(m)!;
      if (t.y + t.h <= header.y) issues.push({ kind: 'member_above_heading', headerId: s.headerId, tileId: m });
    }
  }
  for (const t of tiles) {
    if (t.kind !== 'narrative' || !t.cites?.length) continue;
    const own = structure.sectionOf.get(t.id) ?? null;
    const cited = t.cites.map((c) => (byId.has(c) ? structure.sectionOf.get(c) ?? null : undefined)).filter((c) => c !== undefined);
    if (cited.length > 0 && cited.every((c) => c !== own)) {
      issues.push({ kind: 'narrative_detached', tileId: t.id, citedSection: cited[0] as number | null });
    }
  }
  return issues;
}

/** Reading order for a single column (phone, PDF flow): the preamble, then each
 *  section as its header followed by its members — a heading never ends up
 *  apart from what it introduces, whatever their coordinates. */
export function readingOrder(tiles: StructTile[], structure: Structure = resolveStructure(tiles)): number[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const inSection = new Set(structure.sections.flatMap((s) => [s.headerId, ...s.members]));
  const blocks: Array<{ y: number; x: number; ids: number[] }> = [];
  for (const t of tiles) if (!inSection.has(t.id)) blocks.push({ y: t.y, x: t.x, ids: [t.id] });
  for (const s of structure.sections) {
    const h = byId.get(s.headerId)!;
    blocks.push({ y: h.y, x: h.x, ids: [s.headerId, ...s.members] });
  }
  return blocks.sort(byReading).flatMap((b) => b.ids);
}

/**
 * Move a section as a whole: its header lands at `to`, and every member keeps
 * its place relative to the header. Room is made the way a single drop makes
 * it (resolveDrop over the section's bounding box). Locked members stay where
 * they are (the author pinned them). Returns every tile that changes, or null
 * when a locked tile outside the section would have to move.
 */
export function moveSection(
  tiles: StructTile[],
  headerId: number,
  to: { x: number; y: number },
  structure: Structure = resolveStructure(tiles),
): GridBox[] | null {
  const header = tiles.find((t) => t.id === headerId);
  const section = structure.sections.find((s) => s.headerId === headerId);
  if (!header || !section) return null;
  const moving = [header, ...section.members.map((m) => tiles.find((t) => t.id === m)!).filter((t) => !t.locked)];
  const movingIds = new Set(moving.map((t) => t.id));
  const dy = to.y - header.y;
  if (dy === 0 && to.x === header.x) return [];
  const top = Math.min(...moving.map((t) => t.y));
  const bottom = Math.max(...moving.map((t) => t.y + t.h));
  const GROUP = -424_242;
  const rest: GridBox[] = tiles.filter((t) => !movingIds.has(t.id)).map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, locked: t.locked }));
  const cols = Math.max(36, ...tiles.map((t) => t.x + t.w));
  const drop = resolveDrop([...rest, { id: GROUP, x: 0, y: top, w: cols, h: bottom - top }], GROUP,
    { x: 0, y: Math.max(0, top + dy), w: cols, h: bottom - top });
  if (drop.status !== 'ok') return null;
  const landed = drop.changed.find((b) => b.id === GROUP);
  const shift = (landed ? landed.y : top + dy) - top;
  const others = drop.changed.filter((b) => b.id !== GROUP);
  const dx = header.x === to.x ? 0 : to.x - header.x;
  const moved: GridBox[] = moving.map((t) => ({
    id: t.id,
    x: t.id === headerId ? Math.max(0, t.x + dx) : t.x,
    y: t.y + shift,
    w: t.w,
    h: t.h,
    locked: t.locked,
  }));
  return [...moved, ...others];
}

/**
 * Where an element inserted "after" the selection goes: directly under the
 * selected element (under a header: at the start of its section), across the
 * selection's columns, the rows below moving down to make room. It joins the
 * selection's section (a header: that section). Without a selection it goes to
 * the end of the page, in no section.
 */
export function insertionFor(
  tiles: StructTile[],
  selectedId: number | null | undefined,
  size: { w: number; h: number },
  cols = 36,
): { rect: { x: number; y: number; w: number; h: number }; changed: GridBox[]; sectionId: number | null } | null {
  const structure = resolveStructure(tiles);
  const boxes: GridBox[] = tiles.map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, locked: t.locked }));
  const bottom = tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);
  const sel = selectedId != null ? tiles.find((t) => t.id === selectedId) : undefined;
  const w = Math.min(size.w, cols);
  if (!sel) return { rect: { x: 0, y: bottom, w, h: size.h }, changed: [], sectionId: null };
  const sectionId = sel.kind === 'section' ? sel.id : structure.sectionOf.get(sel.id) ?? null;
  const NEW = -777_777;
  const x = Math.min(sel.x, cols - w);
  const drop = resolveDrop([...boxes, { id: NEW, x, y: bottom, w, h: size.h }], NEW, { x, y: sel.y + sel.h, w, h: size.h });
  if (drop.status !== 'ok') return null;
  const placed = drop.changed.find((b) => b.id === NEW) ?? { x, y: sel.y + sel.h, w, h: size.h };
  return { rect: { x: placed.x, y: placed.y, w, h: size.h }, changed: drop.changed.filter((b) => b.id !== NEW), sectionId };
}
