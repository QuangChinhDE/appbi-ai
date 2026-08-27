'use client';

/**
 * SlicerCluster — Phase-G of the filter rework.
 *
 * Wraps the existing `DashboardFilterBar` with:
 *   1. Dashboard-level docking: top, bottom, side rails, drawer, or hidden.
 *   2. A layout direction derived from the selected dock.
 *   3. Image child support (logos etc.) — entries with `type='image'`
 *      live inside the same `slicers_config` array as real slicers.
 *      The BE filter pipeline already knows to skip these
 *      (see chart_contracts.normalize_filter_conditions Phase-G fix).
 *
 * Dropdown popovers from the inner slicer cards rely on React Portal +
 * `position: fixed` (the existing DashboardFilterBar dropdowns already
 * do this) so the dropdown escapes the cluster's overflow:hidden
 * bounds when select lists are tall.
 *
 * Children are constrained inside the cluster: there is no drag-out
 * affordance on individual slicers — the entire cluster is the
 * positioning unit, not each slicer.
 */

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { Image as ImageIcon, X, Settings2, Link2, Filter, Plus } from 'lucide-react';
import { useI18n } from '@/providers/LanguageProvider';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { useDashboardChartTheme } from '@/components/dashboards/DashboardThemeProvider';
import {
  DOCK_POSITIONS,
  type BaseFilter,
  type ColumnInfo,
  type DockPosition,
  type SlicerClusterLayout,
  type SlicerImageEntry,
  isSlicerImageEntry,
} from '@/lib/filters';

interface SlicerClusterProps {
  /** Full slicers_config — mix of slicer entries and image entries.
   *  This component splits them: real slicers go into DashboardFilterBar;
   *  image entries render as inline cells.
   *
   *  Named `items`, not `children`: it is a DATA list, and calling it children
   *  shadows React's own prop, so a reader (and JSX) would expect it to be the
   *  rendered subtree. */
  items: Array<BaseFilter | SlicerImageEntry>;
  onChildrenChange: (next: Array<BaseFilter | SlicerImageEntry>) => void;
  layout?: SlicerClusterLayout | null;
  onLayoutChange?: (next: SlicerClusterLayout) => void;
  columns: ColumnInfo[];
  columnChartCount: Map<string, number>;
  distinctValues: Record<string, string[]>;
  /** Phase-7.6 — per-column distinct query status (see DashboardFilterBar). */
  distinctStatus?: Record<string, {
    isLoading: boolean;
    isError: boolean;
    hasFilterContext: boolean;
    total?: number;
    hasMore?: boolean;
  }>;
  /** Server-side value search over the cached full distinct set (type-to-search
   * for high-cardinality slicers). Forwarded to DashboardFilterBar. */
  fetchServerDistinct?: (column: ColumnInfo, search: string) => Promise<string[]>;
  hasPendingChanges?: boolean;
  onApply?: () => void;
  onReset?: () => void;
  isApplying?: boolean;
  /** When true, hides editor affordances such as add slicer/image and dock controls. */
  lockSlots?: boolean;
  /** Per-slicer scope config (⚙): build only. */
  showScopeToggle?: boolean;
  /** Build only — open the "Bản đồ filter" overview. When provided, a small
   *  map button is surfaced in the cluster header (right where the DA manages
   *  slicers) so the at-a-glance overview is discoverable without digging into
   *  the More menu. Omitted on the public viewer → button never renders. */
  onOpenFilterMap?: () => void;
  /** Page list for the per-page scope matrix (id + name). */
  dashboardPages?: { id: string; name: string }[];
  /** Active page id (to label "trang này" + default custom seed). */
  activePageId?: string;
  /** Change a slicer's scope (this page / all pages / custom matrix). */
  onUpdateSlicerScope?: (
    slicerKey: string,
    scope: 'all' | 'page' | 'custom',
    pageScope?: Record<string, { filter: boolean; visible: boolean }>,
  ) => void;
}

/** Tiny position glyphs — the picker reads faster as shapes than as words. */
const DOCK_GLYPH: Record<DockPosition, string> = {
  top: '▤', bottom: '▤', left: '▥', right: '▥', drawer: '▸', hidden: '∅',
};

const DEFAULT_LAYOUT: SlicerClusterLayout = {
  position: 'top',
  direction: 'horizontal',
  gap: 8,
  background: 'transparent',
  border: 'dashed',
  distribute: 'manual',
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function SlicerCluster({
  items,
  onChildrenChange,
  layout,
  onLayoutChange,
  columns,
  columnChartCount,
  distinctValues,
  distinctStatus,
  fetchServerDistinct,
  hasPendingChanges,
  onApply,
  onReset,
  isApplying,
  lockSlots = false,
  showScopeToggle = false,
  dashboardPages,
  activePageId,
  onUpdateSlicerScope,
  onOpenFilterMap,
}: SlicerClusterProps) {
  const { t } = useI18n();
  const rawLayout: SlicerClusterLayout = { ...DEFAULT_LAYOUT, ...(layout || {}) };
  // 'free' positioning was removed (tránh ném slicer lung tung).
  // Any dashboard saved with position='free' falls back to 'top'.
  const baseLayout: SlicerClusterLayout =
    rawLayout.position === 'free' ? { ...rawLayout, position: 'top' } : rawLayout;
  // Composition comes from the theme unless the author has placed the cluster
  // themselves. A look is a layout decision as much as a colour one: "Executive
  // brief" wants a side rail, "SaaS console" wants a compact top bar, and until
  // the theme could say so every preset produced the same row of boxes. An
  // explicit `layout.position` is an author decision and always wins.
  const dashTheme = useDashboardChartTheme();
  const dock = (layout?.position ?? dashTheme.tokens?.filterDock ?? 'top') as DockPosition;
  // A collapsed dock is a per-viewer convenience, not a saved property: the
  // author picks WHERE the filters live, each reader decides whether the panel
  // is currently open.
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** left/right are vertical rails; top/bottom are horizontal bands. */
  const isRail = dock === 'left' || dock === 'right';
  const isVertical = isRail || dock === 'drawer';
  // One object downstream, so sizing / direction / data-attributes all agree
  // with the dock the theme supplied.
  const effectiveLayout: SlicerClusterLayout = {
    ...baseLayout,
    position: dock,
    // Direction is IMPLIED by the dock for a rail or a drawer — a 280px column
    // laying its slicers out in a row is not a thing anyone chose. Only the
    // horizontal docks take a stored direction, where 'horizontal' vs 'grid' is
    // a real decision.
    //
    // Reading a stored value here was the same trap as `position`: DEFAULT_LAYOUT
    // writes `direction: 'horizontal'` into every draft save, so the saved value
    // is indistinguishable from a choice and silently contradicted the dock.
    direction: isVertical
      ? 'vertical'
      : (layout?.direction ?? 'horizontal'),
  };

  // Split slicers_config into real slicer entries and image entries.
  // DashboardFilterBar consumes only the real slicers (BaseFilter[]);
  // images render as sibling cells inside the cluster.
  const { slicerEntries, imageEntries } = useMemo(() => {
    const slicers: BaseFilter[] = [];
    const images: SlicerImageEntry[] = [];
    for (const child of items || []) {
      if (isSlicerImageEntry(child)) {
        images.push(child);
      } else if (child && typeof child === 'object' && child.field) {
        slicers.push(child as BaseFilter);
      }
    }
    return { slicerEntries: slicers, imageEntries: images };
  }, [items]);

  // Phase-G — config menu (gear) state. Holds position toggle + Add
  // Image so the header stays uncluttered.
  const [configMenuOpen, setConfigMenuOpen] = useState(false);
  // Filters are a primary dashboard interaction, so the slicer area now stays
  // expanded in both builder and public views. Individual slicer popovers still
  // handle their own open/close state inside DashboardFilterBar.
  const configMenuRef = useRef<HTMLDivElement>(null);
  // The gear anchors the "Add slicer" picker (moved out of the filter bar), and
  // `openAddSlicerRef` holds the opener DashboardFilterBar hands back.
  const gearBtnRef = useRef<HTMLButtonElement>(null);
  const openAddSlicerRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!configMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (configMenuRef.current && !configMenuRef.current.contains(e.target as Node)) {
        setConfigMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [configMenuOpen]);

  const handleSlicersChange = (nextSlicers: BaseFilter[]) => {
    // Merge: keep image children in their current order, replace the
    // slicer entries with the new set. Images live at the END so they
    // don't shift when slicers are reordered; ordering of images is
    // preserved via the imageEntries snapshot.
    onChildrenChange([...nextSlicers, ...imageEntries]);
  };

  const handleAddImage = async (file: File) => {
    try {
      const src = await readFileAsDataUrl(file);
      const newImage: SlicerImageEntry = {
        id: `img-${Date.now()}`,
        type: 'image',
        src,
        alt: file.name,
        fit: 'contain',
      };
      onChildrenChange([...slicerEntries, ...imageEntries, newImage]);
    } catch (err) {
      console.error('Failed to read image file:', err);
    }
  };

  const handleRemoveImage = (id: string) => {
    onChildrenChange([
      ...slicerEntries,
      ...imageEntries.filter((img) => img.id !== id),
    ]);
  };

  const handleUpdateImage = (id: string, patch: Partial<SlicerImageEntry>) => {
    onChildrenChange([
      ...slicerEntries,
      ...imageEntries.map((img) =>
        img.id === id ? { ...img, ...patch } : img,
      ),
    ]);
  };

  const handlePositionChange = (position: DockPosition) => {
    // A side rail reads as a column, a band reads as a row, and a drawer is a
    // tall panel — so the inner direction follows the dock rather than making
    // the author set it twice.
    const nextDirection: SlicerClusterLayout['direction'] =
      position === 'left' || position === 'right' || position === 'drawer' ? 'vertical'
      : position === 'top' || position === 'bottom' ? 'horizontal'
      : effectiveLayout.direction;
    onLayoutChange?.({ ...effectiveLayout, position, direction: nextDirection });
  };

  const containerStyle: React.CSSProperties = {
    // Phase-G — the cluster is ALWAYS a clearly demarcated box so users
    // know this zone is dedicated to slicers (not a generic container).
    //   editor → prominent brand dashed border + brand-soft tint
    //   public → subtle solid border that just groups the slicers
    // An explicit author override (border='none'/'solid') still wins.
    // NOTE: the brand color var is `--brand` (space-separated RGB);
    // use the project's `rgb(var(--brand) / a)` syntax. The earlier
    // `rgba(var(--brand-rgb), a)` referenced a non-existent variable so
    // the border/bg silently dropped — that's why the box had no
    // visible frame.
    // Public (lockSlots): no container chrome — the Tableau-style cards
    // provide their own borders, so the cluster sits transparently like
    // a clean filter bar (Looker/Metabase). Editor: a dashed brand frame
    // + faint tint so the author knows this zone is for slicers.
    // The frame now follows the report's card language instead of its own.
    //
    // It used to hard-code `borderRadius: 8` and its own border/background
    // vocabulary, so on a themed report the filter zone sat there as an 8px
    // square box beside 20px glass tiles — measurably out of step with every
    // other surface (`clusterMatchesCardTreatment: false`). Reading the same
    // `--dashboard-card-*` variables the tiles read makes the filter area part
    // of the report rather than a component parked on top of it.
    // A left/right RAIL becomes a real filter PANEL — a card with the report's
    // own surface, border and shadow — instead of controls floating in an empty
    // column. That empty left margin was the thing that read as "not a real
    // product": a SaaS report puts its filters in a panel, so the rail now does
    // too, using the same `--dashboard-card-*` tokens the tiles use so it matches
    // whatever theme is applied. A TOP band stays transparent — a filter bar
    // wants to be a clean strip, not a boxed card.
    background: effectiveLayout.background
      ?? (isRail ? 'var(--dashboard-card-bg, rgb(var(--surface-1)))' : 'transparent'),
    border:
      effectiveLayout.border === 'none'
        ? '1px solid transparent'
        : (effectiveLayout.border === 'solid' || isRail)
          ? '1px solid var(--dashboard-card-border-color, rgb(var(--border-line)))'
          : '1px solid transparent',
    // The panel earns a soft shadow like every other card; a top band gets none.
    boxShadow: (isRail && effectiveLayout.border !== 'none' && !effectiveLayout.background)
      ? 'var(--dashboard-card-shadow, 0 1px 3px rgba(16,24,40,0.06))'
      : undefined,
    // The dashed "this zone is for slicers" affordance is an EDITING cue, so it
    // is drawn as an outline: outlines sit outside the box model, so turning the
    // cue on and off no longer shifts the slicers by a pixel, and nothing about
    // it is persisted into the saved layout.
    outline: !lockSlots && effectiveLayout.border !== 'none' && effectiveLayout.border !== 'solid'
      ? '1px dashed color-mix(in srgb, var(--dashboard-accent, rgb(var(--brand))) 22%, transparent)'
      : undefined,
    outlineOffset: !lockSlots ? 4 : undefined,
    borderRadius: 'var(--dashboard-card-radius, 8px)',
    // Public viewer: the cards carry their own borders and the cluster is
    // transparent, so the 8px frame padding is pure dead whitespace above the
    // charts. Drop it to a hair on the public link to pull the grid up.
    padding: isRail ? 14 : (lockSlots ? 2 : 8),
    gap: effectiveLayout.gap ?? 8,
    overflow: 'visible',
    // Height follows content. 80px unconditionally meant a top band was 138px
    // tall to hold one 26px row of controls -- measured on a report with no
    // slicers at all, which pushed the first chart 216px down the page for
    // nothing. A rail still needs a drop target while authoring; a band does
    // not, and the public viewer never does.
    minHeight: lockSlots ? undefined : (isRail ? 80 : 44),
    // Public left rail: the parent wrapper already sizes the column (280px),
    // so the cluster must fill it (auto width) — a hard 280px here would
    // overflow the padded wrapper. minWidth 0 lets the cards shrink to fit.
    // A rail sized to its content rather than to a constant. 280px fixed gave a
    // single dropdown a column with 185px of nothing in it, on every report,
    // forever -- and `min-width: 220` meant it could not shrink even when the
    // author wanted it to. The bounds keep a control from being cramped and
    // keep the rail from eating the report.
    minWidth: (isRail && lockSlots) ? 0 : (isRail ? 200 : 220),
    maxWidth: isRail && !lockSlots ? 320 : '100%',
    // Rails can use an authored width; horizontal docks remain responsive.
    width: isRail
      ? (lockSlots ? undefined : (effectiveLayout.wPx ? `${effectiveLayout.wPx}px` : 'fit-content'))
      : undefined,
    flex: (isRail && !lockSlots) ? '0 0 auto' : undefined,
    // Height: in 'left' the BUILDER cluster fills the column to the bottom of
    // the report (dashed frame runs full length). On the PUBLIC link the rail
    // is a sticky panel, so it must be its NATURAL height (auto) — forcing
    // 100% there makes it span the whole scroll area and breaks `sticky`.
    height: isRail
      ? (lockSlots ? undefined : '100%')
      : undefined,
  };

  // Layout direction is derived from position now (no separate toggle):
  //   left → column: the filter bar (cards stacked full-width via
  //          stackVertical) sits on top, images below.
  //   top  → row, wrapping: bar + images flow horizontally.
  const innerLayout: React.CSSProperties = isVertical
    ? { display: 'flex', flexDirection: 'column', gap: effectiveLayout.gap ?? 8 }
    : { display: 'flex', flexDirection: 'row', gap: effectiveLayout.gap ?? 8, flexWrap: 'wrap', alignItems: 'flex-start' };

  // Phase-G — cluster controls injected into DashboardFilterBar's single
  // header (badge + position toggle + Add Image), so the slicer zone has
  // ONE header row instead of two. Editor only (hidden when lockSlots).
  const clusterControls = lockSlots ? null : (
    <>
      {/* ONE gear holds every edit control — position, layout, add image and the
          filter map — so the filter zone shows filters, not a toolbar. The DA
          only reaches for setup occasionally; laying those buttons out full-time
          was the clutter that made the panel "khó coi". */}
      <div ref={configMenuRef} className="relative flex-shrink-0">
        <button
          ref={gearBtnRef}
          type="button"
          onClick={() => setConfigMenuOpen((v) => !v)}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-1 text-tiny transition-colors ${
            configMenuOpen
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
          }`}
          title={t('dashboards.slicerCluster.customizeTooltip')}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
        {configMenuOpen && (
          <div className={`absolute top-full z-[60] mt-1 w-56 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2 shadow-xl ${
            // A LEFT/TOP rail sits against the left nav; opening the menu to the
            // right (left-0) keeps it in the report area instead of sliding under
            // the sidebar, which sits in a higher stacking context this popover
            // can never rise above. A right rail opens the other way.
            dock === 'right' ? 'right-0' : 'left-0'
          }`}>
            {/* Add slicer — the primary action, first in the menu. Opens the
                picker that DashboardFilterBar still owns (via openAddSlicerRef). */}
            <button
              type="button"
              onClick={() => { openAddSlicerRef.current?.(); setConfigMenuOpen(false); }}
              className="mb-2 flex w-full items-center gap-1.5 rounded-md bg-brand px-2 py-1.5 text-tiny font-medium text-white shadow-sm transition-colors hover:bg-brand-hover"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('dashboards.filterBar.addSlicer')}</span>
            </button>
            <div className="mb-1 px-1 text-tiny font-emphasis text-text-tertiary">{t('dashboards.slicerCluster.position')}</div>
            {/* Six docks, rendered from DOCK_POSITIONS so adding one is a
                single-line change in lib/filters and never a UI edit. The
                CLUSTER moves as a unit — there is deliberately no affordance
                for placing an individual slicer. */}
            <div className="mb-2 grid grid-cols-3 gap-1">
              {DOCK_POSITIONS.map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => handlePositionChange(pos)}
                  title={t(`dashboards.slicerCluster.dock_${pos}`)}
                  className={`rounded border px-2 py-1 text-tiny ${dock === pos ? 'border-brand bg-brand text-text-inverse' : 'border-[rgb(var(--border-line))] hover:bg-surface-2'}`}
                >
                  {DOCK_GLYPH[pos]} {t(`dashboards.slicerCluster.dock_${pos}`)}
                </button>
              ))}
            </div>
            {/* Phase-10 — Auto-distribute toggle. When ON, slicer cards
                ignore their manual widthPx and share the row equally via
                `flex-1`. When OFF, each card keeps the drag-set width.
                Toggling ON also CLEARS every existing widthPx so a later
                toggle OFF gives a clean baseline (no stale narrow widths). */}
            <div className="mb-2 mt-2 px-1 text-tiny font-emphasis text-text-tertiary">{t('dashboards.slicerCluster.layout')}</div>
            <button
              type="button"
              onClick={() => {
                const next = effectiveLayout.distribute === 'auto' ? 'manual' : 'auto';
                onLayoutChange?.({ ...effectiveLayout, distribute: next });
                if (next === 'auto') {
                  // Clear all per-card widthPx so a later switch back to
                  // 'manual' starts from a clean baseline.
                  const cleared = (items || []).map((c) =>
                    c && typeof c === 'object' && 'widthPx' in c
                      ? { ...c, widthPx: undefined }
                      : c,
                  );
                  onChildrenChange(cleared);
                }
              }}
              className={`mb-2 flex w-full items-center gap-1.5 rounded border px-2 py-1.5 text-tiny ${
                effectiveLayout.distribute === 'auto'
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
              }`}
              title={t('dashboards.slicerCluster.autoDistributeTooltip')}
            >
              <span aria-hidden>⇔</span>
              <span>
                {effectiveLayout.distribute === 'auto'
                  ? t('dashboards.slicerCluster.autoDistributeOn')
                  : t('dashboards.slicerCluster.autoDistribute')}
              </span>
            </button>
            <label
              className="flex cursor-pointer items-center gap-1.5 rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-tiny text-text-secondary hover:bg-surface-2"
              title={t('dashboards.slicerCluster.addImageTooltip')}
            >
              <ImageIcon className="h-3.5 w-3.5" />
              <span>{t('dashboards.slicerCluster.addImage')}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void handleAddImage(file);
                    e.target.value = '';
                    setConfigMenuOpen(false);
                  }
                }}
              />
            </label>
            {/* Filter map lives here too, so the panel header stays a single
                gear instead of a row of buttons cluttering the filter zone. */}
            {onOpenFilterMap && (
              <button
                type="button"
                onClick={() => { onOpenFilterMap(); setConfigMenuOpen(false); }}
                className="mt-2 flex w-full items-center gap-1.5 rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-tiny text-text-secondary hover:bg-surface-2"
                title={t('dashboards.slicerCluster.filterMapTooltip')}
              >
                <Filter className="h-3.5 w-3.5" />
                <span>{t('dashboards.slicerCluster.filterMap')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );

  // 'hidden' — the report carries no filter UI at all. The filter VALUES are
  // unaffected: they live in the dashboard's own state and still reach every
  // query, which is the point for a public link or an embed that ships with a
  // locked filter set. The author keeps the picker (the cluster still renders
  // its config menu in the builder) so the dock can be brought back.
  if (dock === 'hidden' && lockSlots) return null;

  // 'drawer' — collapsed to a launcher; the panel slides over the report.
  // Whether it is currently open is per-viewer state, never saved: the author
  // chooses WHERE the filters live, each reader chooses when to look at them.
  const drawerLauncher = dock === 'drawer' ? (
    <button
      type="button"
      onClick={() => setDrawerOpen((v) => !v)}
      aria-expanded={drawerOpen}
      className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1.5 text-tiny font-medium text-text-secondary transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-brand"
    >
      <Filter className="h-3.5 w-3.5" />
      {t('dashboards.slicerCluster.dock_drawer')}
    </button>
  ) : null;

  return (
    <>
    {drawerLauncher}
    <div
      className={`slicer-cluster ${lockSlots ? 'mb-0.5' : 'mb-3'} ${
        dock === 'drawer' && !drawerOpen ? 'hidden' : ''
      } ${dock === 'drawer' ? 'lg:absolute lg:right-0 lg:top-10 lg:z-40 lg:w-[320px] lg:shadow-lg' : ''} ${
        // Below the breakpoint a 280px rail leaves nothing for the charts, so
        // every dock becomes a full-width band on small screens.
        isRail ? 'max-lg:!w-full' : ''
      }`}
      data-slicer-cluster-position={effectiveLayout.position}
      data-slicer-cluster-direction={effectiveLayout.direction}
      style={containerStyle}
    >
      <div className="relative" style={innerLayout}>
        {/* No header here: DashboardFilterBar already renders a "Filters" title,
            and adding a second read as a duplicate on the public link. The rail
            card background (above) is what turns the column into a panel. */}
        <div
          className="min-w-0"
          style={isVertical ? { width: '100%' } : { flex: 1, minWidth: 0 }}
        >
          <DashboardFilterBar
            columns={columns}
            columnChartCount={columnChartCount}
            distinctValues={distinctValues}
            distinctStatus={distinctStatus}
            fetchServerDistinct={fetchServerDistinct}
            distributeChildren={effectiveLayout.distribute === 'auto'}
            filters={slicerEntries}
            onFiltersChange={handleSlicersChange}
            hasPendingChanges={hasPendingChanges}
            onApply={onApply}
            onReset={onReset}
            isApplying={isApplying}
            initialExpanded
            embedded
            lockSlots={lockSlots}
            showScopeToggle={showScopeToggle}
            dashboardPages={dashboardPages}
            activePageId={activePageId}
            onUpdateSlicerScope={onUpdateSlicerScope}
            stackVertical={isVertical}
            collapsedSlicers
            verticalPopoverPlacement={dock === 'left' ? 'right' : 'left'}
            headerExtras={clusterControls}
            // Move "Add slicer" out of the filter bar and into the gear: hide
            // its button, anchor the picker to the gear, and let the gear's menu
            // item open it. Builder only (the gear does not exist on a locked
            // public/embed view, where adding a slicer is not offered anyway).
            {...(!lockSlots ? {
              externalAddAnchorRef: gearBtnRef,
              onRegisterAddSlicer: (open: () => void) => { openAddSlicerRef.current = open; },
            } : {})}
          />
        </div>
        {imageEntries.map((img) => (
          <ImageCell
            key={img.id}
            img={img}
            editable={!lockSlots}
            onUpdate={(patch) => handleUpdateImage(img.id, patch)}
            onRemove={() => handleRemoveImage(img.id)}
          />
        ))}
      </div>
    </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ImageCell — single image entry with a settings popover for alt /
// link / fit / sizing. Viewer mode (editable=false) collapses to a
// pure visual cell.
// ──────────────────────────────────────────────────────────────────────

interface ImageCellProps {
  img: SlicerImageEntry;
  editable: boolean;
  onUpdate: (patch: Partial<SlicerImageEntry>) => void;
  onRemove: () => void;
}

function ImageCell({ img, editable, onUpdate, onRemove }: ImageCellProps) {
  const { t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);

  const renderedImg = (
    <img
      src={img.src}
      alt={img.alt || ''}
      style={{
        objectFit: img.fit ?? 'contain',
        maxWidth: '100%',
        maxHeight: img.heightPx ? `${img.heightPx}px` : 80,
        display: 'block',
      }}
    />
  );

  return (
    <div
      className="relative inline-flex items-center justify-center rounded border border-[rgb(var(--border-line))] bg-surface-1 p-2"
      style={{
        width: img.widthPx ? `${img.widthPx}px` : undefined,
        height: img.heightPx ? `${img.heightPx}px` : undefined,
      }}
    >
      {img.link ? (
        <a href={img.link} target="_blank" rel="noopener noreferrer">
          {renderedImg}
        </a>
      ) : (
        renderedImg
      )}

      {editable && (
        <>
          <button
            type="button"
            onClick={() => setIsEditing((v) => !v)}
            className="absolute -left-1 -top-1 rounded-full bg-surface-1 p-0.5 text-text-quaternary shadow ring-1 ring-[rgb(var(--border-line))] hover:text-brand"
            title={t('dashboards.slicerCluster.editImageTooltip')}
          >
            <Settings2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="absolute -right-1 -top-1 rounded-full bg-surface-1 p-0.5 text-text-quaternary shadow ring-1 ring-[rgb(var(--border-line))] hover:text-danger"
            title={t('dashboards.slicerCluster.removeImageTooltip')}
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}

      {isEditing && editable && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3 shadow-lg"
          style={{ position: 'absolute' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-tiny font-emphasis text-text-secondary">{t('dashboards.slicerCluster.imageSettings')}</span>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="rounded p-0.5 text-text-quaternary hover:bg-surface-2"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          <label className="block text-tiny text-text-tertiary">{t('dashboards.slicerCluster.altText')}</label>
          <input
            type="text"
            value={img.alt ?? ''}
            onChange={(e) => onUpdate({ alt: e.target.value })}
            placeholder={t('dashboards.slicerCluster.altTextPlaceholder')}
            className="mb-2 w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
          />

          <label className="block text-tiny text-text-tertiary">
            <Link2 className="mr-1 inline h-3 w-3" />{t('dashboards.slicerCluster.clickLink')}
          </label>
          <input
            type="url"
            value={img.link ?? ''}
            onChange={(e) => onUpdate({ link: e.target.value || undefined })}
            placeholder="https://company.com"
            className="mb-2 w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
          />

          <label className="block text-tiny text-text-tertiary">{t('dashboards.slicerCluster.fitMode')}</label>
          <select
            value={img.fit ?? 'contain'}
            onChange={(e) => onUpdate({ fit: e.target.value as SlicerImageEntry['fit'] })}
            className="mb-2 w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="contain">{t('dashboards.slicerCluster.fitContain')}</option>
            <option value="cover">{t('dashboards.slicerCluster.fitCover')}</option>
            <option value="fill">{t('dashboards.slicerCluster.fitFill')}</option>
          </select>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-tiny text-text-tertiary">{t('dashboards.slicerCluster.widthPx')}</label>
              <input
                type="number"
                value={img.widthPx ?? ''}
                onChange={(e) =>
                  onUpdate({
                    widthPx: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder={t('dashboards.slicerCluster.autoPlaceholder')}
                className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
            <div className="flex-1">
              <label className="block text-tiny text-text-tertiary">{t('dashboards.slicerCluster.heightPx')}</label>
              <input
                type="number"
                value={img.heightPx ?? ''}
                onChange={(e) =>
                  onUpdate({
                    heightPx: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder={t('dashboards.slicerCluster.autoPlaceholder')}
                className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
          </div>

          <p className="mt-2 text-tiny text-text-quaternary">
            {t('dashboards.slicerCluster.emptyAutoFitHint')}
          </p>
        </div>
      )}
    </div>
  );
}

export default SlicerCluster;
