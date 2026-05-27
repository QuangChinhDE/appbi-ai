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
import { LayoutGrid, MoveHorizontal, MoveVertical, Image as ImageIcon, X, Settings2, Link2 } from 'lucide-react';
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
  hasPendingChanges,
  onApply,
  onReset,
  isApplying,
  lockSlots = false,
}: SlicerClusterProps) {
  const effectiveLayout: SlicerClusterLayout = { ...DEFAULT_LAYOUT, ...(layout || {}) };

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

  const handleDirectionChange = (direction: 'horizontal' | 'vertical' | 'grid') => {
    onLayoutChange?.({ ...effectiveLayout, direction });
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

  // Phase-G2 — ResizeObserver captures user's corner-drag (CSS
  // `resize` handle in editor mode) and persists into the layout.
  // Debounced to avoid spamming the draft endpoint on every pixel of
  // mousemove. Viewer mode renders fixed-size; only editor lets the
  // author drag.
  const containerRef = useRef<HTMLDivElement>(null);
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (lockSlots || !containerRef.current) return;
    const el = containerRef.current;
    const observer = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      const w = Math.round(cr.width);
      const h = Math.round(cr.height);
      // Skip the first observation (initial mount sets the baseline).
      if (lastSizeRef.current == null) {
        lastSizeRef.current = { w, h };
        return;
      }
      if (lastSizeRef.current.w === w && lastSizeRef.current.h === h) return;
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
  }, [lockSlots]);

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
    background: effectiveLayout.background ?? 'transparent',
    border:
      effectiveLayout.border === 'none'
        ? '1px solid transparent'
        : effectiveLayout.border === 'solid'
          ? '1px solid rgb(var(--border-line))'
          : '1px dashed rgba(var(--brand-rgb), 0.3)',
    borderRadius: 8,
    padding: 8,
    gap: effectiveLayout.gap ?? 8,
    // Phase-G2 — editor mode gets a browser-native resize handle on
    // the bottom-right corner (4-corner-drag would need a custom
    // gesture controller; bottom-right is the standard browser
    // affordance for resize:both). Viewer keeps fixed bounds.
    resize: lockSlots ? undefined : 'both',
    overflow: 'visible',
    minHeight: 80,
    minWidth: 220,
    // Phase-G3 — in 'left' mode the cluster is a narrow column;
    // default to 280px unless the author resized it explicitly.
    width: effectiveLayout.wPx
      ? `${effectiveLayout.wPx}px`
      : (effectiveLayout.position === 'left' ? '280px' : undefined),
    flex: effectiveLayout.position === 'left' ? '0 0 auto' : undefined,
    height: effectiveLayout.hPx ? `${effectiveLayout.hPx}px` : undefined,
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

  const innerLayout = (() => {
    switch (effectiveLayout.direction) {
      case 'vertical':
        return { display: 'flex', flexDirection: 'column' as const, gap: effectiveLayout.gap ?? 8 };
      case 'grid':
        return {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: effectiveLayout.gap ?? 8,
        };
      default:
        return { display: 'flex', flexDirection: 'row' as const, gap: effectiveLayout.gap ?? 8, flexWrap: 'wrap' as const };
    }
  })();

  return (
    <div
      ref={containerRef}
      className="slicer-cluster mb-3 bg-brand-soft/30"
      data-slicer-cluster-position={effectiveLayout.position}
      data-slicer-cluster-direction={effectiveLayout.direction}
      style={containerStyle}
    >
      {!lockSlots && (
        <div
          className="mb-2 flex items-center gap-2 px-1 text-tiny"
          style={isFree ? { cursor: 'move' } : undefined}
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={handleHeaderPointerUp}
        >
          {isFree && <span title="Kéo để di chuyển" className="text-text-quaternary">⠿</span>}
          <span className="font-emphasis text-brand">Slicer</span>
          <span className="text-text-tertiary">— viewer luôn thấy & chỉnh được</span>
          <span className="ml-auto inline-flex items-center gap-1" title="Vị trí cụm slicer">
            <button
              type="button"
              onClick={() => handlePositionChange('top')}
              className={`rounded px-1.5 py-1 text-tiny ${effectiveLayout.position === 'top' ? 'bg-brand text-text-inverse' : 'hover:bg-surface-2'}`}
              title="Top — phía trên charts"
            >
              Top
            </button>
            <button
              type="button"
              onClick={() => handlePositionChange('left')}
              className={`rounded px-1.5 py-1 text-tiny ${effectiveLayout.position === 'left' ? 'bg-brand text-text-inverse' : 'hover:bg-surface-2'}`}
              title="Left — cột dọc bên trái charts"
            >
              Left
            </button>
            <button
              type="button"
              onClick={() => handlePositionChange('free')}
              className={`rounded px-1.5 py-1 text-tiny ${effectiveLayout.position === 'free' ? 'bg-brand text-text-inverse' : 'hover:bg-surface-2'}`}
              title="Free — kéo thả tự do (overlay)"
            >
              Free
            </button>
          </span>
          <span className="inline-flex items-center gap-1" title="Layout direction">
            <button
              type="button"
              onClick={() => handleDirectionChange('horizontal')}
              className={`rounded p-1 ${effectiveLayout.direction === 'horizontal' ? 'bg-brand text-text-inverse' : 'hover:bg-surface-2'}`}
              title="Horizontal"
            >
              <MoveHorizontal className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleDirectionChange('vertical')}
              className={`rounded p-1 ${effectiveLayout.direction === 'vertical' ? 'bg-brand text-text-inverse' : 'hover:bg-surface-2'}`}
              title="Vertical"
            >
              <MoveVertical className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleDirectionChange('grid')}
              className={`rounded p-1 ${effectiveLayout.direction === 'grid' ? 'bg-brand text-text-inverse' : 'hover:bg-surface-2'}`}
              title="Grid"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </span>
          {(effectiveLayout.wPx || effectiveLayout.hPx) && (
            <button
              type="button"
              onClick={() => onLayoutChange?.({ ...effectiveLayout, wPx: undefined, hPx: undefined })}
              className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-text-tertiary hover:bg-surface-2"
              title="Reset cluster size to auto"
            >
              ⟲ Reset size
            </button>
          )}
          <label
            className="inline-flex cursor-pointer items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-text-secondary hover:bg-surface-2"
            title="Thêm ảnh (logo) vào cluster"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            <span>+ Image</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void handleAddImage(file);
                  e.target.value = '';
                }
              }}
            />
          </label>
        </div>
      )}

      {/* Children rendered with direction-aware layout. Slicers go
          through DashboardFilterBar (with embedded=true so it doesn't
          wrap itself in another card); images render as inline cells.
          When there are NO children, DashboardFilterBar still renders
          its empty-state + Add Filter button (assuming canEdit). */}
      <div style={innerLayout}>
        <div
          className="min-w-0"
          style={effectiveLayout.direction === 'vertical' ? { width: '100%' } : { flex: 1, minWidth: 220 }}
        >
          <DashboardFilterBar
            columns={columns}
            columnChartCount={columnChartCount}
            distinctValues={distinctValues}
            filters={slicerEntries}
            onFiltersChange={handleSlicersChange}
            hasPendingChanges={hasPendingChanges}
            onApply={onApply}
            onReset={onReset}
            isApplying={isApplying}
            initialExpanded
            embedded
            lockSlots={lockSlots}
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
