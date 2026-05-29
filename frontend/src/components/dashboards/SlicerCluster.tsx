'use client';

/**
 * SlicerCluster — Phase-G of the filter rework.
 *
 * Wraps the existing `DashboardFilterBar` with:
 *   1. Free positioning + drag-resize (via react-grid-layout, single
 *      cell so author can place/size the whole cluster anywhere above
 *      the chart grid).
 *   2. Direction toggle: horizontal / vertical / grid.
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

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Image as ImageIcon, X, Settings2, Link2 } from 'lucide-react';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import {
  type BaseFilter,
  type ColumnInfo,
  type SlicerClusterLayout,
  type SlicerImageEntry,
  isSlicerImageEntry,
} from '@/lib/filters';

interface SlicerClusterProps {
  /** Full slicers_config — mix of slicer entries and image entries.
   *  This component splits them: real slicers go into DashboardFilterBar;
   *  image entries render as inline cells. */
  children: any[];
  onChildrenChange: (next: any[]) => void;
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
  }>;
  hasPendingChanges?: boolean;
  onApply?: () => void;
  onReset?: () => void;
  isApplying?: boolean;
  /** When true, hides editor affordances (add slicer / add image /
   *  direction toggle / drag handles). Set on public viewer. */
  lockSlots?: boolean;
}

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
  children,
  onChildrenChange,
  layout,
  onLayoutChange,
  columns,
  columnChartCount,
  distinctValues,
  distinctStatus,
  hasPendingChanges,
  onApply,
  onReset,
  isApplying,
  lockSlots = false,
}: SlicerClusterProps) {
  const rawLayout: SlicerClusterLayout = { ...DEFAULT_LAYOUT, ...(layout || {}) };
  // 'free' positioning was removed (cảnh báo: tránh ném slicer lung tung).
  // Any dashboard saved with position='free' falls back to 'top'.
  const effectiveLayout: SlicerClusterLayout =
    rawLayout.position === 'free' ? { ...rawLayout, position: 'top' } : rawLayout;

  // Split slicers_config into real slicer entries and image entries.
  // DashboardFilterBar consumes only the real slicers (BaseFilter[]);
  // images render as sibling cells inside the cluster.
  const { slicerEntries, imageEntries } = useMemo(() => {
    const slicers: BaseFilter[] = [];
    const images: SlicerImageEntry[] = [];
    for (const child of children || []) {
      if (isSlicerImageEntry(child)) {
        images.push(child);
      } else if (child && typeof child === 'object' && child.field) {
        slicers.push(child as BaseFilter);
      }
    }
    return { slicerEntries: slicers, imageEntries: images };
  }, [children]);

  // Phase-G — config menu (gear) state. Holds position toggle + Add
  // Image so the header stays uncluttered.
  const [configMenuOpen, setConfigMenuOpen] = useState(false);
  // Phase-13 — slicer cluster collapses by default; viewer / DA reveals
  // it via a small toggle button. Was always-expanded → noisy on first
  // page load for dashboards with many slicers. Default hidden matches
  // Looker / PBI's "filters drawer" pattern.
  const [isCollapsed, setIsCollapsed] = useState(true);
  const configMenuRef = useRef<HTMLDivElement>(null);
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

  const handlePositionChange = (position: 'top' | 'left' | 'free') => {
    // When moving to 'left', vertical direction is the natural default
    // (a left column of slicers); when moving back to 'top', horizontal.
    const nextDirection =
      position === 'left' ? 'vertical'
      : position === 'top' ? 'horizontal'
      : effectiveLayout.direction;
    onLayoutChange?.({ ...effectiveLayout, position, direction: nextDirection });
  };

  // Phase-G2 — ResizeObserver captures the author's corner-drag (CSS
  // `resize` handle in editor mode) and persists into the layout.
  //
  // Bug fix (feedback-loop "thu lại dần dần"): we MUST read
  // `borderBoxSize`, not `contentRect`. Tailwind sets
  // `box-sizing: border-box` globally, so the CSS `width` we write back
  // is a BORDER-box width — but `contentRect` reports the CONTENT box
  // (minus padding+border ≈ 18px). Feeding contentRect back into a
  // border-box `width` shrank the element by ~18px every observer tick,
  // creating an infinite shrink loop + the "ResizeObserver loop
  // completed with undelivered notifications" console error. Reading
  // borderBoxSize keeps wPx == the CSS width → stable, no drift.
  //
  // We also (a) defer the state write out of the observer callback via
  // setTimeout (avoids the loop-notification error) and (b) ignore
  // sub-threshold jitter (<3px) so a 1px reflow doesn't churn the draft.
  const containerRef = useRef<HTMLDivElement>(null);
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);
  const debounceRef = useRef<number | null>(null);
  // Only capture size in free mode (the only place an explicit
  // footprint is meaningful + the resize handle is shown).
  const captureSize = !lockSlots && effectiveLayout.position === 'free';
  useEffect(() => {
    // Reset baseline whenever capture toggles off so re-enabling
    // doesn't compare against a stale size.
    if (!captureSize) {
      lastSizeRef.current = null;
      return;
    }
    if (!containerRef.current) return;
    const el = containerRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Prefer borderBoxSize (matches the border-box CSS width we set).
      let w: number;
      let h: number;
      const bb = (entry as any).borderBoxSize;
      if (bb && bb.length) {
        const box = bb[0];
        w = Math.round(box.inlineSize);
        h = Math.round(box.blockSize);
      } else {
        // Fallback for older browsers: add back padding+border (18px).
        w = Math.round(entry.contentRect.width) + 18;
        h = Math.round(entry.contentRect.height) + 18;
      }
      // Skip the first observation (initial mount sets the baseline).
      if (lastSizeRef.current == null) {
        lastSizeRef.current = { w, h };
        return;
      }
      // Ignore sub-threshold jitter to avoid churning the draft on
      // 1px layout reflows.
      if (
        Math.abs(lastSizeRef.current.w - w) < 3 &&
        Math.abs(lastSizeRef.current.h - h) < 3
      ) {
        return;
      }
      lastSizeRef.current = { w, h };
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        onLayoutChange?.({ ...effectiveLayout, wPx: w, hPx: h });
      }, 300);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureSize]);

  // Phase-G3 — 'free' mode: cluster floats over the canvas as an
  // absolute overlay. The author drags the header to move it
  // (updates xPx/yPx). The parent must give the content area
  // `position: relative` so the overlay anchors correctly (the edit
  // page does this when position === 'free').
  const isFree = effectiveLayout.position === 'free';
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const handleHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (lockSlots || !isFree) return;
    // Only start drag from the header background, not from buttons.
    if ((e.target as HTMLElement).closest('button,select,label,input')) return;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: effectiveLayout.xPx ?? 0,
      origY: effectiveLayout.yPx ?? 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [lockSlots, isFree, effectiveLayout.xPx, effectiveLayout.yPx]);

  const handleHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    onLayoutChange?.({
      ...effectiveLayout,
      xPx: Math.max(0, dragState.current.origX + dx),
      yPx: Math.max(0, dragState.current.origY + dy),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveLayout]);

  const handleHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    dragState.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }, []);

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
    background: effectiveLayout.background
      ?? (lockSlots ? 'transparent' : 'rgb(var(--brand) / 0.05)'),
    border:
      effectiveLayout.border === 'none'
        ? '1px solid transparent'
        : effectiveLayout.border === 'solid'
          ? '1px solid rgb(var(--border-line))'
          : lockSlots
            ? '1px solid transparent'
            : '1.5px dashed rgb(var(--brand) / 0.55)',
    borderRadius: 8,
    padding: 8,
    gap: effectiveLayout.gap ?? 8,
    // Phase-G2 fix — the browser resize handle is enabled ONLY in
    // 'free' mode. In 'top' the cluster is full-width (auto) and in
    // 'left' it's a fixed-width column; forcing explicit wPx/hPx there
    // both broke responsive layout AND fed the ResizeObserver shrink
    // loop. Free mode is the only place an explicit footprint makes
    // sense (it floats), so resize + size-capture live only there.
    resize: (isFree && !lockSlots) ? 'both' : undefined,
    overflow: 'visible',
    minHeight: 80,
    minWidth: 220,
    // Width:
    //   free → explicit wPx (if set)
    //   left → fixed column (wPx override or 280px default)
    //   top  → auto (full-width, responsive — ignore wPx)
    width: isFree
      ? (effectiveLayout.wPx ? `${effectiveLayout.wPx}px` : undefined)
      : effectiveLayout.position === 'left'
        ? (effectiveLayout.wPx ? `${effectiveLayout.wPx}px` : '280px')
        : undefined,
    flex: effectiveLayout.position === 'left' ? '0 0 auto' : undefined,
    // Height: in 'left' the cluster fills the column to the bottom of
    // the report (parent flex uses items-stretch) so the frame runs the
    // full dashboard length. Free honors hPx; top auto-fits content.
    height: effectiveLayout.position === 'left'
      ? '100%'
      : (isFree && effectiveLayout.hPx ? `${effectiveLayout.hPx}px` : undefined),
    maxWidth: isFree ? undefined : '100%',
    // Phase-G3 — free overlay positioning.
    ...(isFree
      ? {
          position: 'absolute' as const,
          left: effectiveLayout.xPx ?? 0,
          top: effectiveLayout.yPx ?? 0,
          zIndex: effectiveLayout.z ?? 40,
          background: effectiveLayout.background && effectiveLayout.background !== 'transparent'
            ? effectiveLayout.background
            : 'rgb(var(--surface-1))',
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        }
      : {}),
  };

  // Layout direction is derived from position now (no separate toggle):
  //   left → column: the filter bar (cards stacked full-width via
  //          stackVertical) sits on top, images below.
  //   top  → row, wrapping: bar + images flow horizontally.
  const isLeft = effectiveLayout.position === 'left';
  const innerLayout: React.CSSProperties = isLeft
    ? { display: 'flex', flexDirection: 'column', gap: effectiveLayout.gap ?? 8 }
    : { display: 'flex', flexDirection: 'row', gap: effectiveLayout.gap ?? 8, flexWrap: 'wrap', alignItems: 'flex-start' };

  // Phase-G — cluster controls injected into DashboardFilterBar's single
  // header (badge + position toggle + Add Image), so the slicer zone has
  // ONE header row instead of two. Editor only (hidden when lockSlots).
  const clusterControls = lockSlots ? null : (
    <>
      <span
        className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-brand px-1.5 py-0.5 text-tiny font-emphasis uppercase tracking-wide text-text-inverse"
        title="Slicer zone for the viewer — do not place charts here"
      >
        ⛃ Slicer
      </span>
      {/* Config gear — holds the rarely-used setup controls (position +
          add image) so the header stays clean. */}
      <div ref={configMenuRef} className="relative flex-shrink-0">
        <button
          type="button"
          onClick={() => setConfigMenuOpen((v) => !v)}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-1 text-tiny transition-colors ${
            configMenuOpen
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
          }`}
          title="Customize slicer cluster (position, image)"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
        {configMenuOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2 shadow-xl">
            <div className="mb-1 px-1 text-tiny font-emphasis text-text-tertiary">Position</div>
            <div className="mb-2 flex gap-1">
              <button
                type="button"
                onClick={() => handlePositionChange('top')}
                className={`flex-1 rounded border px-2 py-1 text-tiny ${effectiveLayout.position === 'top' ? 'border-brand bg-brand text-text-inverse' : 'border-[rgb(var(--border-line))] hover:bg-surface-2'}`}
              >
                ▤ Top
              </button>
              <button
                type="button"
                onClick={() => handlePositionChange('left')}
                className={`flex-1 rounded border px-2 py-1 text-tiny ${effectiveLayout.position === 'left' ? 'border-brand bg-brand text-text-inverse' : 'border-[rgb(var(--border-line))] hover:bg-surface-2'}`}
              >
                ▥ Left
              </button>
            </div>
            {/* Phase-10 — Auto-distribute toggle. When ON, slicer cards
                ignore their manual widthPx and share the row equally via
                `flex-1`. When OFF, each card keeps the drag-set width.
                Toggling ON also CLEARS every existing widthPx so a later
                toggle OFF gives a clean baseline (no stale narrow widths). */}
            <div className="mb-2 mt-2 px-1 text-tiny font-emphasis text-text-tertiary">Layout</div>
            <button
              type="button"
              onClick={() => {
                const next = effectiveLayout.distribute === 'auto' ? 'manual' : 'auto';
                onLayoutChange?.({ ...effectiveLayout, distribute: next });
                if (next === 'auto') {
                  // Clear all per-card widthPx so a later switch back to
                  // 'manual' starts from a clean baseline.
                  const cleared = (children || []).map((c) =>
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
              title="Distribute each slicer evenly across the row (clears manual drag widths)"
            >
              <span aria-hidden>⇔</span>
              <span>
                {effectiveLayout.distribute === 'auto'
                  ? 'Auto-distribute (on)'
                  : 'Auto-distribute'}
              </span>
            </button>
            <label
              className="flex cursor-pointer items-center gap-1.5 rounded border border-[rgb(var(--border-line))] px-2 py-1.5 text-tiny text-text-secondary hover:bg-surface-2"
              title="Add an image (logo) to the slicer cluster"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              <span>Add image / logo</span>
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
          </div>
        )}
      </div>
    </>
  );

  // Phase-13 — count of slicers that currently carry a non-empty value
  // (so the toggle button can show a "3" badge like Linear / GitHub UI).
  const activeSlicerCount = useMemo(() => {
    let n = 0;
    for (const s of slicerEntries) {
      const v = (s as any)?.value;
      if (Array.isArray(v) ? v.length > 0 : (v != null && String(v).trim() !== '')) n += 1;
    }
    return n;
  }, [slicerEntries]);

  return (
    <div
      ref={containerRef}
      className="slicer-cluster mb-3"
      data-slicer-cluster-position={effectiveLayout.position}
      data-slicer-cluster-direction={effectiveLayout.direction}
      style={isCollapsed ? undefined : containerStyle}
    >
      {/* Phase-13 — collapsed-by-default toggle. The slicer bar used to
          always render expanded which crowded the dashboard on first
          load; PowerBI / Looker hide their filter pane by default. The
          toggle shows the field count + active filter count so the
          viewer can see at-a-glance whether filters are applied without
          opening it. */}
      {isCollapsed ? (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setIsCollapsed(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-tiny text-text-secondary shadow-linear-sm transition-colors hover:bg-surface-2"
            title={
              activeSlicerCount > 0
                ? `Show filters (${activeSlicerCount} active)`
                : 'Show filters'
            }
          >
            <span aria-hidden>⛃</span>
            <span>Filters</span>
            {slicerEntries.length > 0 && (
              <span
                className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                  activeSlicerCount > 0
                    ? 'bg-brand text-text-inverse'
                    : 'bg-surface-2 text-text-tertiary'
                }`}
              >
                {activeSlicerCount > 0 ? activeSlicerCount : slicerEntries.length}
              </span>
            )}
          </button>
        </div>
      ) : (
        // Children rendered with direction-aware layout. Slicers go
        // through DashboardFilterBar (collapsed-popover buttons); the
        // cluster controls (badge + position + Add Image) ride in that
        // bar's SINGLE header via headerExtras. Images render as inline
        // cells after the bar. Right-edge "X" collapses the cluster.
        <div className="relative" style={innerLayout}>
          <button
            type="button"
            onClick={() => setIsCollapsed(true)}
            title="Hide filters"
            className="absolute right-1 top-1 z-10 inline-flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div
            className="min-w-0"
            style={isLeft ? { width: '100%' } : { flex: 1, minWidth: 0 }}
          >
            <DashboardFilterBar
              columns={columns}
              columnChartCount={columnChartCount}
              distinctValues={distinctValues}
              distinctStatus={distinctStatus}
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
              stackVertical={isLeft}
              collapsedSlicers
              headerExtras={clusterControls}
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
      )}
    </div>
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
            title="Edit image settings"
          >
            <Settings2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="absolute -right-1 -top-1 rounded-full bg-surface-1 p-0.5 text-text-quaternary shadow ring-1 ring-[rgb(var(--border-line))] hover:text-danger"
            title="Remove image"
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
            <span className="text-tiny font-emphasis text-text-secondary">Image settings</span>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="rounded p-0.5 text-text-quaternary hover:bg-surface-2"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          <label className="block text-tiny text-text-tertiary">Alt text</label>
          <input
            type="text"
            value={img.alt ?? ''}
            onChange={(e) => onUpdate({ alt: e.target.value })}
            placeholder="Company logo"
            className="mb-2 w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
          />

          <label className="block text-tiny text-text-tertiary">
            <Link2 className="mr-1 inline h-3 w-3" />Click link (optional)
          </label>
          <input
            type="url"
            value={img.link ?? ''}
            onChange={(e) => onUpdate({ link: e.target.value || undefined })}
            placeholder="https://company.com"
            className="mb-2 w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
          />

          <label className="block text-tiny text-text-tertiary">Fit mode</label>
          <select
            value={img.fit ?? 'contain'}
            onChange={(e) => onUpdate({ fit: e.target.value as SlicerImageEntry['fit'] })}
            className="mb-2 w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="contain">Contain (fit inside box)</option>
            <option value="cover">Cover (fill box, may crop)</option>
            <option value="fill">Fill (stretch)</option>
          </select>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-tiny text-text-tertiary">Width (px)</label>
              <input
                type="number"
                value={img.widthPx ?? ''}
                onChange={(e) =>
                  onUpdate({
                    widthPx: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="auto"
                className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
            <div className="flex-1">
              <label className="block text-tiny text-text-tertiary">Height (px)</label>
              <input
                type="number"
                value={img.heightPx ?? ''}
                onChange={(e) =>
                  onUpdate({
                    heightPx: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="auto"
                className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-caption outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
          </div>

          <p className="mt-2 text-tiny text-text-quaternary">
            Để trống = tự động fit theo nội dung.
          </p>
        </div>
      )}
    </div>
  );
}

export default SlicerCluster;
