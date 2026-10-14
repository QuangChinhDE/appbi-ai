/**
 * Slicer controls on the grid — presentation, never semantics.
 *
 * A slicer (an entry in `slicers_config` or `pages_config[].slicers`) is the
 * FILTER: dataset, field, operator, value, scope. A slicer CONTROL is a grid
 * element (`widget_type: 'slicer'`) that says only which slicer it shows and how
 * it looks: `{slicerId, treatment}`. Moving, resizing or restyling a control
 * changes its tile and nothing else, so it cannot change which rows any chart
 * reads — that is structural, not a promise: nothing in this module returns a
 * modified slicer entry, and the backend normaliser drops every other key a
 * control's config might carry.
 *
 * One rule decides where a slicer's control appears on a page, for the builder,
 * the public link, the embed and the export alike:
 *   - visible on the page and placed here  → its grid control(s), and it is not
 *                                            repeated in the filter bar;
 *   - visible on the page, not placed here → the filter bar, exactly as before;
 *   - placed here but its scope hides it   → builder shows it dimmed with why;
 *                                            a viewer gets nothing;
 *   - placed here but the slicer is gone   → builder offers to remove the
 *     (deleted, or stripped by a link lock)  control; a viewer gets nothing.
 */

export const SLICER_CONTROL_WIDGET = 'slicer';

export type SlicerTreatment = 'auto' | 'dropdown' | 'list' | 'buttons' | 'compact';
export const SLICER_TREATMENTS: SlicerTreatment[] = ['auto', 'dropdown', 'list', 'buttons', 'compact'];

/** How a control is actually drawn once `auto` is decided. */
export type ResolvedTreatment = 'dropdown' | 'list' | 'buttons' | 'compact' | 'theme';

type TileLike = {
  id: number;
  widget_type?: string | null;
  widget_config?: Record<string, any> | null;
  layout?: Record<string, any> | null;
};
type SlicerLike = { id?: string | number | null; type?: string | null; interactionType?: string | null };

export function isSlicerControl(tile: TileLike | null | undefined): boolean {
  return String(tile?.widget_type ?? '') === SLICER_CONTROL_WIDGET;
}

/** The slicer a control shows, or null when the config names none. */
export function slicerIdOfControl(tile: TileLike | null | undefined): string | null {
  if (!isSlicerControl(tile)) return null;
  const raw = (tile?.widget_config ?? {}).slicerId;
  const id = raw == null ? '' : String(raw).trim();
  return id || null;
}

/**
 * How a control looks. The author's choice lives in the tile's LAYOUT
 * (`slicerTreatment`) so it travels the same path as a drag — local edit →
 * draft → publish, undoable, discarded with the draft. The config's treatment
 * is the one it was created with (an AI plan sets it there).
 */
export function treatmentOfControl(tile: TileLike | null | undefined): SlicerTreatment {
  const raw = String((tile?.layout ?? {}).slicerTreatment ?? (tile?.widget_config ?? {}).treatment ?? 'auto');
  return (SLICER_TREATMENTS as string[]).includes(raw) ? (raw as SlicerTreatment) : 'auto';
}

/** The only config a control is stored with. Anything else — a field, an
 *  operator, a value — is dropped: a control must never carry a predicate. */
export function normalizeSlicerControlConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  const cfg = config ?? {};
  const slicerId = cfg.slicerId == null ? '' : String(cfg.slicerId).trim().slice(0, 80);
  const treatment = (SLICER_TREATMENTS as string[]).includes(String(cfg.treatment)) ? String(cfg.treatment) : 'auto';
  return {
    slicerId,
    treatment,
    ...(cfg.origin === 'ai' || cfg.origin === 'author' ? { origin: cfg.origin } : {}),
  };
}

const idOf = (s: SlicerLike | null | undefined) => (s?.id == null ? '' : String(s.id));

/** Ids of the slicers that have a control among these tiles (one page). */
export function placedSlicerIds(tilesOnPage: ReadonlyArray<TileLike>): Set<string> {
  const out = new Set<string>();
  for (const tile of tilesOnPage) {
    const id = slicerIdOfControl(tile);
    if (id) out.add(id);
  }
  return out;
}

/**
 * Split the slicers a page shows into those the filter bar draws and those a
 * grid control draws. Every visible slicer lands in exactly one list, in its
 * original order — none is lost and none is drawn twice.
 */
export function partitionSlicerControls<S extends SlicerLike>(
  visibleSlicers: ReadonlyArray<S>,
  tilesOnPage: ReadonlyArray<TileLike>,
): { bar: S[]; placed: S[] } {
  const placedIds = placedSlicerIds(tilesOnPage);
  const bar: S[] = [];
  const placed: S[] = [];
  for (const slicer of visibleSlicers) {
    (placedIds.has(idOf(slicer)) ? placed : bar).push(slicer);
  }
  return { bar, placed };
}

/**
 * The filter bar reports its whole list on every change, and it no longer sees
 * the placed slicers. Merging them back before the change is stored is what
 * keeps a placed slicer from being deleted by an edit made in the bar.
 */
export function mergeBarChange<S extends SlicerLike>(fromBar: ReadonlyArray<S>, placed: ReadonlyArray<S>): S[] {
  const seen = new Set(fromBar.map(idOf));
  return [...fromBar, ...placed.filter((s) => !seen.has(idOf(s)))];
}

/** Replace one slicer by id (a control edited its value). Order is kept; an
 *  unknown id changes nothing. */
export function replaceSlicerById<S extends SlicerLike>(list: ReadonlyArray<S>, updated: S): S[] {
  const target = idOf(updated);
  return list.map((s) => (idOf(s) === target ? updated : s));
}

export type ControlResolution<S> =
  | { state: 'ok'; slicer: S }
  /** Its scope keeps a control off this page; it may still filter here. */
  | { state: 'hidden'; slicer: S; filtersHere: boolean }
  | { state: 'missing' };

/**
 * What a control on page P shows.
 *
 * `slicers` is every slicer the surface knows about. The builder passes all of
 * the report's slicers; the public link passes only the controls its seed
 * offers on this page (a link-locked or hidden field was already stripped by
 * the server), so on public anything else is `missing` and renders nothing.
 */
export function resolveSlicerControl<S extends SlicerLike>(
  slicerId: string | null,
  slicers: ReadonlyArray<S>,
  scope: { visibleHere: (s: S) => boolean; filtersHere: (s: S) => boolean },
): ControlResolution<S> {
  if (!slicerId) return { state: 'missing' };
  const slicer = slicers.find((s) => idOf(s) === slicerId);
  if (!slicer) return { state: 'missing' };
  if (!scope.visibleHere(slicer)) return { state: 'hidden', slicer, filtersHere: scope.filtersHere(slicer) };
  return { state: 'ok', slicer };
}

/** A categorical list can be shown as a list; a range or a free-text box cannot. */
export function isListable(slicer: SlicerLike | null | undefined): boolean {
  const kind = String(slicer?.interactionType ?? '');
  if (kind && kind !== 'dropdown' && kind !== 'fixed_list') return false;
  const type = String(slicer?.type ?? 'dropdown');
  return type === 'dropdown' || type === 'text';
}

/** The tile height from which `auto` shows the values as a list. */
export const AUTO_LIST_MIN_HEIGHT_PX = 150;

/**
 * Decide how a control is drawn. Presentation only: the result picks a
 * rendering of the same entry, never another operator or interaction.
 *   auto     → a list when the tile is tall enough and the slicer is a list;
 *              otherwise the theme's card rule (segmented when values fit).
 *   dropdown → always the compact card with a menu.
 *   buttons  → a segmented control (the card falls back to a menu when the
 *              values do not fit).
 *   list     → the values inline (a range falls back to the card).
 *   compact  → the card without its label row.
 */
export function resolveTreatment(
  treatment: SlicerTreatment,
  input: { slicer: SlicerLike | null | undefined; tileHeightPx: number },
): ResolvedTreatment {
  const listable = isListable(input.slicer);
  if (treatment === 'list') return listable ? 'list' : 'dropdown';
  if (treatment === 'dropdown' || treatment === 'compact') return treatment;
  if (treatment === 'buttons') return listable ? 'buttons' : 'dropdown';
  return listable && input.tileHeightPx >= AUTO_LIST_MIN_HEIGHT_PX ? 'list' : 'theme';
}

/** Where a new control goes: the first free row below the page's content, at
 *  the left edge. Never on top of another tile; whitespace is left alone. */
export function nextFreeSlot(
  tilesOnPage: ReadonlyArray<{ layout?: Record<string, any> | null }>,
  size: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const bottom = tilesOnPage.reduce((acc, tile) => {
    const l = tile.layout ?? {};
    return Math.max(acc, (Number(l.y) || 0) + (Number(l.h) || 0));
  }, 0);
  return { x: 0, y: bottom, w: size.w, h: size.h };
}

/** The default footprint of a control, in 36-column grid units: a card is a
 *  slim band (~80px), a list needs room for its values. */
export const SLICER_CONTROL_SIZE: Record<'card' | 'list', { w: number; h: number }> = {
  card: { w: 8, h: 3 },
  list: { w: 8, h: 9 },
};
